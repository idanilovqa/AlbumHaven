-- Goals belong to an account, independently of libraries and local inventory.
-- Application transactions lock account, live session, then aggregate/cycles.
-- listening_goals.py remains the sole owner of calendar and membership rules.

-- A verified provider identity resolves to the existing logical catalog UUID.
-- Never infer grouping from a title, artist, edition, path, or local album ID.
create table catalog.release_group_provider_identities (
  provider text not null check (provider = 'musicbrainz'),
  entity_kind text not null check (entity_kind = 'release-group'),
  external_id text collate "C" not null check (
    external_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and external_id <> '00000000-0000-0000-0000-000000000000'
  ),
  catalog_ref uuid not null references catalog.release_groups(ref) on delete restrict,
  primary key(provider, entity_kind, external_id)
);
create index release_group_provider_identities_catalog_idx
  on catalog.release_group_provider_identities(catalog_ref);

-- Evidence is an account-bound immutable fact snapshot, not a catalog admission.
-- The digest identifies the validated version; it is not a signature or grant.
-- Preserve original_session_id as audit provenance, following operation-receipt
-- conventions. Session expiration/deletion must not cascade retained evidence.
create table app.listening_goal_evidence (
  ref uuid primary key check (ref <> '00000000-0000-0000-0000-000000000000'::uuid),
  account_id bigint not null references app.accounts(id) on delete restrict,
  original_session_id bigint not null check (original_session_id > 0),
  provider text not null check (provider = 'musicbrainz'),
  entity_kind text not null check (entity_kind = 'release-group'),
  external_id text collate "C" not null check (
    external_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and external_id <> '00000000-0000-0000-0000-000000000000'
  ),
  evidence_version text collate "C" not null check (evidence_version ~ '^[0-9a-f]{64}$'),
  title text not null check (length(title) <= 1000 and length(btrim(title)) > 0),
  artist_display text not null check (length(artist_display) <= 1000 and length(btrim(artist_display)) > 0),
  first_release_date text check (
    first_release_date ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'
    and left(first_release_date, 4) <> '0000'
  ),
  primary_type text check (primary_type in ('Album', 'Single', 'EP', 'Broadcast', 'Other')),
  created_at timestamptz not null default now() check (isfinite(created_at)),
  expires_at timestamptz not null check (isfinite(expires_at)),
  revoked_at timestamptz check (isfinite(revoked_at)),
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at),
  unique(account_id, ref, evidence_version)
);

create table app.listening_goals (
  account_id bigint primary key references app.accounts(id) on delete restrict,
  ref uuid not null unique check (ref <> '00000000-0000-0000-0000-000000000000'::uuid),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now() check (isfinite(created_at)),
  updated_at timestamptz not null default now() check (isfinite(updated_at)),
  check (updated_at >= created_at),
  unique(account_id, ref)
);

-- Retain admission metadata even when evidence expires, a provider is offline,
-- or every local library disappears. No source-private path or inventory FK.
create table app.listening_goal_albums (
  account_id bigint not null,
  goal_ref uuid not null,
  catalog_ref uuid not null references catalog.release_groups(ref) on delete restrict,
  original_position bigint not null check (original_position > 0),
  title text not null check (length(title) <= 1000 and length(btrim(title)) > 0),
  artist_display text not null check (length(artist_display) <= 1000 and length(btrim(artist_display)) > 0),
  first_release_date text check (
    first_release_date ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'
    and left(first_release_date, 4) <> '0000'
  ),
  primary_type text check (primary_type in ('Album', 'Single', 'EP', 'Broadcast', 'Other')),
  evidence_ref uuid not null,
  evidence_version text collate "C" not null check (evidence_version ~ '^[0-9a-f]{64}$'),
  admitted_at timestamptz not null check (isfinite(admitted_at)),
  primary key(account_id, goal_ref, catalog_ref),
  foreign key(account_id, goal_ref)
    references app.listening_goals(account_id, ref) on delete restrict,
  foreign key(account_id, evidence_ref, evidence_version)
    references app.listening_goal_evidence(account_id, ref, evidence_version) on delete restrict,
  unique(account_id, goal_ref, original_position)
);
create index listening_goal_albums_catalog_idx on app.listening_goal_albums(catalog_ref);
create index listening_goal_albums_evidence_idx
  on app.listening_goal_albums(account_id, evidence_ref, evidence_version);

-- Explicit selected-period assignments survive Reset. Membership of larger
-- periods is represented separately by cycle_items, not duplicate assignments.
create table app.listening_goal_assignments (
  assignment_id uuid primary key check (assignment_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  account_id bigint not null,
  goal_ref uuid not null,
  catalog_ref uuid not null,
  period text not null check (period in ('week', 'month', 'six-months', 'year')),
  assigned_at timestamptz not null check (isfinite(assigned_at)),
  position bigint not null check (position > 0),
  foreign key(account_id, goal_ref, catalog_ref)
    references app.listening_goal_albums(account_id, goal_ref, catalog_ref) on delete restrict,
  unique(account_id, goal_ref, catalog_ref, period),
  unique(account_id, goal_ref, position)
);

-- position preserves domain history order even when consecutive resets have
-- identical server timestamps. Captured calendar dates are never recomputed here.
create table app.listening_goal_cycles (
  cycle_id uuid primary key check (cycle_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  account_id bigint not null,
  goal_ref uuid not null,
  period text not null check (period in ('week', 'month', 'six-months', 'year')),
  position bigint not null check (position > 0),
  started_at timestamptz not null check (isfinite(started_at)),
  start_date date not null check (isfinite(start_date)),
  due_date date not null check (isfinite(due_date)),
  timezone_name text not null check (length(timezone_name) between 1 and 255),
  closed_at timestamptz check (isfinite(closed_at)),
  foreign key(account_id, goal_ref)
    references app.listening_goals(account_id, ref) on delete restrict,
  check (due_date > start_date),
  check (closed_at is null or closed_at >= started_at),
  unique(account_id, goal_ref, cycle_id),
  unique(account_id, goal_ref, period, position)
);
create unique index listening_goal_cycles_current_idx
  on app.listening_goal_cycles(account_id, period) where closed_at is null;
create index listening_goal_cycles_history_idx
  on app.listening_goal_cycles(account_id, period, position desc, cycle_id desc)
  where closed_at is not null;

-- Composite keys reject cross-account, cross-aggregate and foreign-album links.
-- Completion is the aggregate owner's manual timestamp; this slice adds no
-- completion command, other viewer state, playback inference or telemetry rule.
create table app.listening_goal_cycle_items (
  account_id bigint not null,
  goal_ref uuid not null,
  cycle_id uuid not null,
  catalog_ref uuid not null,
  position bigint not null check (position > 0),
  manual_completed_at timestamptz check (isfinite(manual_completed_at)),
  primary key(account_id, goal_ref, cycle_id, catalog_ref),
  foreign key(account_id, goal_ref, cycle_id)
    references app.listening_goal_cycles(account_id, goal_ref, cycle_id) on delete restrict,
  foreign key(account_id, goal_ref, catalog_ref)
    references app.listening_goal_albums(account_id, goal_ref, catalog_ref) on delete restrict,
  unique(account_id, goal_ref, cycle_id, position)
);
create index listening_goal_cycle_items_album_idx
  on app.listening_goal_cycle_items(account_id, goal_ref, catalog_ref);

-- Same account/key and original session identify an acknowledgement. The stored
-- receipt may describe an old revision; it is never a current-state response.
-- Keep receipts independent of aggregate existence for an empty Reset no-op.
create table app.listening_goal_operations (
  account_id bigint not null references app.accounts(id) on delete restrict,
  request_key uuid not null check (request_key <> '00000000-0000-0000-0000-000000000000'::uuid),
  original_session_id bigint not null check (original_session_id > 0),
  action text not null check (action in ('add', 'reset')),
  command_digest text collate "C" not null check (command_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check (
    jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 16384
  ),
  committed_at timestamptz not null default now() check (isfinite(committed_at)),
  primary key(account_id, request_key)
);

-- Structural guards supplement application-only authorization. None elevate
-- privileges, choose an account, perform calendar arithmetic, or grant access.
create function app.guard_listening_goal_revision()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if NEW.account_id is distinct from OLD.account_id
      or NEW.ref is distinct from OLD.ref
      or NEW.created_at is distinct from OLD.created_at
      or NEW.revision <= OLD.revision
      or NEW.updated_at < OLD.updated_at then
    raise exception using errcode='23514', constraint='listening_goal_monotonic_revision',
      message='Goal identity and revision transition is invalid';
  end if;
  return NEW;
end $$;
create trigger listening_goal_revision_update before update on app.listening_goals
  for each row execute function app.guard_listening_goal_revision();

create function app.guard_listening_goal_evidence_revocation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (to_jsonb(NEW) - 'revoked_at') is distinct from (to_jsonb(OLD) - 'revoked_at')
      or OLD.revoked_at is not null or NEW.revoked_at is null then
    raise exception using errcode='23514', constraint='listening_goal_evidence_immutable',
      message='Goal evidence facts and revocation are immutable';
  end if;
  return NEW;
end $$;
create trigger listening_goal_evidence_update before update on app.listening_goal_evidence
  for each row execute function app.guard_listening_goal_evidence_revocation();

create function app.guard_listening_goal_cycle()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.closed_at is not null then
      raise exception using errcode='23514', constraint='listening_goal_cycle_open',
        message='A Goal cycle must be opened before it is archived';
    end if;
    return NEW;
  end if;
  if TG_OP = 'DELETE' then
    raise exception using errcode='23514', constraint='listening_goal_cycle_retained',
      message='Goal cycles are retained';
  end if;
  if OLD.closed_at is not null or NEW.closed_at is null
      or (to_jsonb(NEW) - 'closed_at') is distinct from (to_jsonb(OLD) - 'closed_at') then
    raise exception using errcode='23514', constraint='listening_goal_archive_immutable',
      message='A Goal cycle may only transition once from current to archived';
  end if;
  if exists (
    select 1 from app.listening_goal_cycle_items i
    where i.account_id=OLD.account_id and i.goal_ref=OLD.goal_ref and i.cycle_id=OLD.cycle_id
      and i.manual_completed_at > NEW.closed_at
  ) then
    raise exception using errcode='23514', constraint='listening_goal_completion_bounds',
      message='Goal completion falls outside its cycle';
  end if;
  return NEW;
end $$;
create trigger listening_goal_cycle_write before insert or update or delete on app.listening_goal_cycles
  for each row execute function app.guard_listening_goal_cycle();

create function app.guard_listening_goal_cycle_item()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare
  target_account bigint;
  target_goal uuid;
  target_cycle uuid;
  cycle_started timestamptz;
  cycle_closed timestamptz;
begin
  if TG_OP = 'UPDATE' and
      (to_jsonb(NEW) - 'manual_completed_at') is distinct from (to_jsonb(OLD) - 'manual_completed_at') then
    raise exception using errcode='23514', constraint='listening_goal_item_identity_immutable',
      message='Goal cycle item identity and order are immutable';
  end if;
  if TG_OP = 'DELETE' then
    target_account := OLD.account_id;
    target_goal := OLD.goal_ref;
    target_cycle := OLD.cycle_id;
  else
    target_account := NEW.account_id;
    target_goal := NEW.goal_ref;
    target_cycle := NEW.cycle_id;
  end if;
  -- Serialize insert/completion against cycle closure. The application already
  -- owns this account's account/session locks; never lock a different account.
  select started_at, closed_at into cycle_started, cycle_closed
    from app.listening_goal_cycles
    where account_id=target_account and goal_ref=target_goal and cycle_id=target_cycle
    for update;
  if not found or cycle_closed is not null then
    raise exception using errcode='23514', constraint='listening_goal_archive_items_immutable',
      message='Goal cycle membership requires a current owned cycle';
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  if NEW.manual_completed_at is not null and NEW.manual_completed_at < cycle_started then
    raise exception using errcode='23514', constraint='listening_goal_completion_bounds',
      message='Goal completion falls outside its cycle';
  end if;
  return NEW;
end $$;
create trigger listening_goal_cycle_item_write before insert or update or delete on app.listening_goal_cycle_items
  for each row execute function app.guard_listening_goal_cycle_item();

revoke all on catalog.release_group_provider_identities, app.listening_goal_evidence,
  app.listening_goals, app.listening_goal_albums, app.listening_goal_assignments,
  app.listening_goal_cycles, app.listening_goal_cycle_items, app.listening_goal_operations from public;
revoke all on function app.guard_listening_goal_revision(),
  app.guard_listening_goal_evidence_revocation(), app.guard_listening_goal_cycle(),
  app.guard_listening_goal_cycle_item() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on catalog.release_group_provider_identities, app.listening_goal_evidence,
      app.listening_goals, app.listening_goal_albums, app.listening_goal_assignments,
      app.listening_goal_cycles, app.listening_goal_cycle_items, app.listening_goal_operations from album_haven_readonly;
    revoke all on function app.guard_listening_goal_revision(),
      app.guard_listening_goal_evidence_revocation(), app.guard_listening_goal_cycle(),
      app.guard_listening_goal_cycle_item() from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on catalog.release_group_provider_identities, app.listening_goal_evidence,
      app.listening_goals, app.listening_goal_albums, app.listening_goal_assignments,
      app.listening_goal_cycles, app.listening_goal_cycle_items, app.listening_goal_operations from album_haven_app;
    revoke all on function app.guard_listening_goal_revision(),
      app.guard_listening_goal_evidence_revocation(), app.guard_listening_goal_cycle(),
      app.guard_listening_goal_cycle_item() from album_haven_app;
    grant select, insert on catalog.release_group_provider_identities, app.listening_goal_evidence,
      app.listening_goals, app.listening_goal_albums, app.listening_goal_assignments,
      app.listening_goal_cycles, app.listening_goal_cycle_items, app.listening_goal_operations to album_haven_app;
    grant update(revision, updated_at) on app.listening_goals to album_haven_app;
    grant update(revoked_at) on app.listening_goal_evidence to album_haven_app;
    grant update(closed_at) on app.listening_goal_cycles to album_haven_app;
    grant execute on function app.guard_listening_goal_revision(),
      app.guard_listening_goal_evidence_revocation(), app.guard_listening_goal_cycle(),
      app.guard_listening_goal_cycle_item() to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on catalog.release_group_provider_identities, app.listening_goal_evidence,
      app.listening_goals, app.listening_goal_albums, app.listening_goal_assignments,
      app.listening_goal_cycles, app.listening_goal_cycle_items, app.listening_goal_operations to album_haven_migrator;
    grant execute on function app.guard_listening_goal_revision(),
      app.guard_listening_goal_evidence_revocation(), app.guard_listening_goal_cycle(),
      app.guard_listening_goal_cycle_item() to album_haven_migrator;
  end if;
end $$;

-- Implementation obligations not replaced by DDL:
-- * Provider validation checks actual partial calendar dates, controls, UTF-8,
--   exact MusicBrainz identity, fixed official transport and explicit lifetime.
-- * Account/session/policy/CSRF authorization, revision checks, evidence expiry,
--   revocation and version gates run before new Add; a same-session exact replay
--   reads its original receipt before requiring fresh evidence.
-- * The mapping uniqueness race runs in a savepoint including candidate catalog
--   creation. Roll back a losing candidate before reading the winning mapping.
-- * Hydrate the unchanged pure domain and persist only returned deltas. Close
--   the selected old cycle before inserting its replacement current cycle and
--   copy retained item order into the new cycle with null manual completion.
-- * Weekly manual capacity, duplicate no-op, captured calendar arithmetic and
--   contiguous archive history are domain/service checks, not a second SQL model.
-- * History cursors bind account/session/period/current aggregate revision;
--   use unique per-period position keysets and invalidate after revision changes.
-- * Receipt output is bounded acknowledgement JSON, not aggregate persistence.
--   Check its UTF-8 JSONB text size against 16384 before insertion.
