create index if not exists listen_history_own_window_idx
  on integration.listen_history(account_id, library_id, played_at, id);

-- Disposable, actor-owned Home read receipts. integration.listen_history stays
-- the only event authority; these projections expose no source-save API.
create table app.activity_source_revisions (
  library_id bigint not null references library.libraries(id) on delete cascade,
  account_id bigint not null check (account_id >= 0), -- zero is inventory scope
  revision bigint not null default 0 check (revision >= 0),
  primary key (library_id, account_id)
);

create table app.activity_snapshots (
  id bigint generated always as identity primary key,
  token_digest bytea not null unique check (octet_length(token_digest) = 32),
  row_secret bytea not null check (octet_length(row_secret) = 32),
  account_id bigint not null references app.accounts(id) on delete cascade,
  session_id bigint not null references app.account_sessions(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  kind text not null check (kind in ('tracks','albums','artists','listens')),
  period text not null check (period in ('week','month','six','year','all')),
  window_start timestamptz,
  window_end timestamptz not null,
  timezone text not null,
  period_label text not null,
  range_label text not null,
  ledger_revision bigint not null,
  inventory_revision bigint not null,
  authority_fingerprint text not null,
  qualification_version text not null check (qualification_version = 'meaningful-v1'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  ready boolean not null default false,
  total_rows bigint not null default 0 check (total_rows >= 0),
  total_listens bigint not null default 0 check (total_listens >= 0),
  coverage jsonb not null default '{}'::jsonb,
  check (window_start is null or window_start <= window_end),
  check (expires_at <= created_at + interval '1 hour')
);
create index activity_snapshots_actor_created_idx on app.activity_snapshots(account_id, created_at desc, id desc);
create index activity_snapshots_session_query_idx on app.activity_snapshots(account_id, session_id, library_id, kind, period, created_at desc, id desc);
create index activity_snapshots_owned_expiry_idx on app.activity_snapshots(account_id, expires_at, id);

create table app.activity_snapshot_rows (
  snapshot_id bigint not null references app.activity_snapshots(id) on delete cascade,
  row_key text not null,
  ordinal bigint,
  latest_at timestamptz not null,
  latest_event_id bigint not null,
  listen_count bigint not null check (listen_count > 0),
  source_labels text[] not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (snapshot_id, row_key),
  unique (snapshot_id, ordinal),
  check (ordinal is null or ordinal > 0)
);
create table app.activity_snapshot_events (
  snapshot_id bigint not null references app.activity_snapshots(id) on delete cascade,
  event_id bigint not null,
  row_key text not null,
  resources jsonb not null check (jsonb_typeof(resources) = 'array'),
  primary key (snapshot_id, event_id)
);

-- Lock access is a narrow definer operation; app cannot rewrite revision
-- evidence merely to obtain the UPDATE privilege required by FOR SHARE.
create function app.lock_home_activity_revisions(p_library bigint, p_account bigint)
returns table(account_id bigint, revision bigint)
language sql volatile security definer set search_path = pg_catalog as $$
  select r.account_id,r.revision from app.activity_source_revisions r
  where r.library_id=p_library and r.account_id in (0,p_account)
  order by r.account_id for share of r nowait;
$$;

-- An epoch is change evidence, not authority and not a copied listen store.
create function app.bump_home_activity_revision(p_library bigint, p_account bigint)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if p_library is null or p_account is null or not exists (
    select 1 from library.libraries where id = p_library
  ) then return; end if;
  insert into app.activity_source_revisions(library_id, account_id, revision)
  values (p_library, p_account, 1)
  on conflict (library_id, account_id) do update
  set revision = app.activity_source_revisions.revision + 1;
end $$;

-- The event membership was produced by the shared Python qualifier. Reusing
-- it avoids a second SQL definition of legacy float/rounding semantics.
create function app.home_activity_event_was_captured(p_library bigint, p_account bigint, p_event bigint)
returns boolean language plpgsql volatile security definer set search_path = pg_catalog as $$
begin
  if p_library is null or p_account is null then return false; end if;
  if current_setting('transaction_isolation') != 'read committed' then
    -- A higher-isolation writer may have started before a receipt committed.
    return true;
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('home-activity:' || p_account::text,0)) then
    -- A builder owns capture. Never skip a possible publication race.
    return true;
  end if;
  -- VOLATILE obtains a fresh query snapshot after successful acquisition.
  -- The transaction lock prevents another builder starting before this edit
  -- commits; an earlier completed builder is visible to this RC query.
  return exists(select 1 from app.activity_snapshot_events e
    join app.activity_snapshots s on s.id=e.snapshot_id
    where e.event_id=p_event and s.account_id=p_account and s.library_id=p_library
      and s.ready and s.expires_at>clock_timestamp());
end $$;

create index activity_snapshot_events_source_idx on app.activity_snapshot_events(event_id,snapshot_id);

create function app.home_activity_legacy_facts(metadata jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_array(
    metadata->'source_payload'->'title', metadata->'source_payload'->'artist',
    metadata->'source_payload'->'album', metadata->'source_payload'->'album_artist',
    metadata->'source_payload'->'path', metadata->'source_payload'->'track_ref',
    metadata->'source_payload'->'source_provenance',
    metadata->'source_payload'->'total_listened_seconds',
    metadata->'source_payload'->'max_contiguous_seconds'
  );
$$;

create function app.invalidate_home_activity_event()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if TG_OP = 'UPDATE' and
      row(OLD.account_id, OLD.library_id, OLD.track_id, OLD.track_key,
          OLD.played_at, OLD.source_family, OLD.measurement_version,
          OLD.finalized, OLD.measured_listened_seconds,
          app.home_activity_legacy_facts(OLD.metadata))
      is not distinct from
      row(NEW.account_id, NEW.library_id, NEW.track_id, NEW.track_key,
          NEW.played_at, NEW.source_family, NEW.measurement_version,
          NEW.finalized, NEW.measured_listened_seconds,
          app.home_activity_legacy_facts(NEW.metadata)) then
    return NEW;
  end if;
  if app.home_activity_event_was_captured(OLD.library_id, OLD.account_id, OLD.id) then
    perform app.bump_home_activity_revision(OLD.library_id, OLD.account_id);
  end if;
  -- A reassignment is new available evidence for its new scope. Every receipt
  -- that actually held its old identity is invalidated through the old scope.
  if TG_OP = 'UPDATE' then return NEW; end if;
  return OLD;
end $$;
create trigger home_activity_event_change after update or delete on integration.listen_history
for each row execute function app.invalidate_home_activity_event();

create function app.invalidate_home_activity_inventory()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare old_library bigint; new_library bigint;
begin
  if TG_OP != 'INSERT' then
    if TG_TABLE_NAME = 'local_track_files' then
      select library_id into old_library from library.local_tracks where id = OLD.track_id;
    else old_library := OLD.library_id; end if;
  end if;
  if TG_OP != 'DELETE' then
    if TG_TABLE_NAME = 'local_track_files' then
      select library_id into new_library from library.local_tracks where id = NEW.track_id;
    else new_library := NEW.library_id; end if;
  end if;
  if TG_OP = 'UPDATE' then
    if TG_TABLE_NAME = 'local_track_files' then
      if row(OLD.track_id, OLD.private_path, OLD.scan_cache_stale) is not distinct from
         row(NEW.track_id, NEW.private_path, NEW.scan_cache_stale) then return NEW; end if;
    elsif TG_TABLE_NAME = 'local_tracks' then
      if row(OLD.library_id, OLD.track_key, OLD.title, OLD.album_id, OLD.artist_id, OLD.duration_seconds) is not distinct from
         row(NEW.library_id, NEW.track_key, NEW.title, NEW.album_id, NEW.artist_id, NEW.duration_seconds) then return NEW; end if;
    elsif TG_TABLE_NAME = 'local_albums' then
      if row(OLD.library_id, OLD.album_key, OLD.title, OLD.artist_id) is not distinct from
         row(NEW.library_id, NEW.album_key, NEW.title, NEW.artist_id) then return NEW; end if;
    elsif TG_TABLE_NAME = 'local_artists' then
      if row(OLD.library_id, OLD.artist_key, OLD.name) is not distinct from
         row(NEW.library_id, NEW.artist_key, NEW.name) then return NEW; end if;
    end if;
  end if;
  perform app.bump_home_activity_revision(old_library, 0);
  if new_library is distinct from old_library then
    perform app.bump_home_activity_revision(new_library, 0);
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;
create trigger home_activity_track_change after insert or update or delete on library.local_tracks
for each row execute function app.invalidate_home_activity_inventory();
create trigger home_activity_album_change after insert or update or delete on library.local_albums
for each row execute function app.invalidate_home_activity_inventory();
create trigger home_activity_artist_change after insert or update or delete on library.local_artists
for each row execute function app.invalidate_home_activity_inventory();
create trigger home_activity_file_change after insert or update or delete on library.local_track_files
for each row execute function app.invalidate_home_activity_inventory();

revoke all on app.activity_source_revisions, app.activity_snapshots,
  app.activity_snapshot_rows, app.activity_snapshot_events from public;
revoke all on sequence app.activity_snapshots_id_seq from public;
revoke all on function app.lock_home_activity_revisions(bigint,bigint),
  app.bump_home_activity_revision(bigint,bigint),
  app.home_activity_event_was_captured(bigint,bigint,bigint),
  app.home_activity_legacy_facts(jsonb), app.invalidate_home_activity_event(),
  app.invalidate_home_activity_inventory() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on app.activity_source_revisions,app.activity_snapshots,
      app.activity_snapshot_rows,app.activity_snapshot_events from album_haven_app;
    revoke all on sequence app.activity_snapshots_id_seq from album_haven_app;
    revoke all on function app.lock_home_activity_revisions(bigint,bigint),
      app.bump_home_activity_revision(bigint,bigint),
      app.home_activity_event_was_captured(bigint,bigint,bigint),
      app.home_activity_legacy_facts(jsonb),app.invalidate_home_activity_event(),
      app.invalidate_home_activity_inventory() from album_haven_app;
    grant select on app.activity_source_revisions to album_haven_app;
    grant insert(library_id,account_id) on app.activity_source_revisions to album_haven_app;
    grant execute on function app.lock_home_activity_revisions(bigint,bigint) to album_haven_app;
    grant select, insert, update, delete on app.activity_snapshots,
      app.activity_snapshot_rows, app.activity_snapshot_events to album_haven_app;
    grant usage, select on sequence app.activity_snapshots_id_seq to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on app.activity_source_revisions,app.activity_snapshots,
      app.activity_snapshot_rows,app.activity_snapshot_events from album_haven_readonly;
    revoke all on sequence app.activity_snapshots_id_seq from album_haven_readonly;
    revoke all on function app.lock_home_activity_revisions(bigint,bigint),
      app.bump_home_activity_revision(bigint,bigint),
      app.home_activity_event_was_captured(bigint,bigint,bigint),
      app.home_activity_legacy_facts(jsonb),app.invalidate_home_activity_event(),
      app.invalidate_home_activity_inventory() from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all on app.activity_source_revisions, app.activity_snapshots,
      app.activity_snapshot_rows, app.activity_snapshot_events to album_haven_migrator;
    grant all on sequence app.activity_snapshots_id_seq to album_haven_migrator;
  end if;
end $$;
