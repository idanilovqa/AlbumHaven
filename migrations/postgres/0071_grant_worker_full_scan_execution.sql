alter table library.full_scan_intents
  add column if not exists execution_attempt integer,
  add column if not exists captured_inventory_revision bigint,
  add column if not exists progress_phase varchar(32) not null default 'accepted',
  add column if not exists current_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'library.full_scan_intents'::regclass
       and conname = 'full_scan_intents_execution_attempt_check'
  ) then
    alter table library.full_scan_intents
      add constraint full_scan_intents_execution_attempt_check check (
        execution_attempt is null or execution_attempt > 0
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'library.full_scan_intents'::regclass
       and conname = 'full_scan_intents_captured_revision_check'
  ) then
    alter table library.full_scan_intents
      add constraint full_scan_intents_captured_revision_check check (
        captured_inventory_revision is null or captured_inventory_revision >= 0
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'library.full_scan_intents'::regclass
       and conname = 'full_scan_intents_progress_phase_check'
  ) then
    alter table library.full_scan_intents
      add constraint full_scan_intents_progress_phase_check check (
        progress_phase in (
          'accepted', 'preparing', 'discovering', 'indexing',
          'finalizing', 'publishing'
        )
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'library.full_scan_intents'::regclass
       and conname = 'full_scan_intents_current_path_check'
  ) then
    alter table library.full_scan_intents
      add constraint full_scan_intents_current_path_check check (
        current_path is null or (
          length(current_path) between 1 and 4096
          and current_path !~ '[[:cntrl:]]'
        )
      );
  end if;
end $$;

create or replace function library.load_claimed_full_scan_intent_v2(
  p_job_id bigint,
  p_worker_id varchar,
  p_lease_token varchar
)
returns table (
  intent_id bigint,
  library_id bigint,
  initiating_account_id bigint,
  mode varchar,
  force boolean,
  logical_root_ids text[],
  inventory_mutation_revision bigint,
  committed_inventory_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  claimed_intent_id bigint;
  claimed_library_id bigint;
  claimed_attempt integer;
  captured_revision bigint;
begin
  select intent.id, intent.library_id, job.attempt_count,
         coalesce(nullif(
           library_record.metadata ->> 'inventory_mutation_revision', ''
         )::bigint, 0)
    into claimed_intent_id, claimed_library_id, claimed_attempt,
         captured_revision
    from ops.jobs as job
    join library.full_scan_intents as intent on intent.job_id = job.id
    join library.libraries as library_record on library_record.id = intent.library_id
   where job.id = p_job_id
     and job.kind = 'full_scan'
     and job.subject_kind = 'full_scan_intent'
     and job.subject_ref = intent.id::text
     and job.library_id = intent.library_id
     and job.state = 'running'
     and intent.state = 'running'
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > now()
   for update of job, intent;
  if claimed_intent_id is null then
    return;
  end if;

  update library.full_scan_intents as intent
     set execution_attempt = claimed_attempt,
         captured_inventory_revision = captured_revision,
         progress_current = case
           when intent.execution_attempt is distinct from claimed_attempt
           then 0 else intent.progress_current end,
         progress_total = case
           when intent.execution_attempt is distinct from claimed_attempt
           then 0 else intent.progress_total end,
         progress_phase = case
           when intent.execution_attempt is distinct from claimed_attempt
           then 'preparing' else intent.progress_phase end,
         current_path = case
           when intent.execution_attempt is distinct from claimed_attempt
           then null else intent.current_path end,
         updated_at = greatest(intent.updated_at, now())
   where intent.id = claimed_intent_id
     and intent.committed_inventory_revision is null
     and (
       intent.execution_attempt is distinct from claimed_attempt
       or intent.captured_inventory_revision is null
     );

  return query
  select intent.id,
         intent.library_id,
         intent.initiating_account_id,
         intent.mode,
         intent.force,
         array_agg(
           root_record.metadata ->> 'root_id' order by intent_root.ordinal
         ),
         intent.captured_inventory_revision,
         intent.committed_inventory_revision
    from library.full_scan_intents as intent
    join library.full_scan_intent_roots as intent_root
      on intent_root.intent_id = intent.id
    join library.library_roots as root_record
      on root_record.id = intent_root.root_id
   where intent.id = claimed_intent_id
     and (
       intent.execution_attempt = claimed_attempt
       or intent.committed_inventory_revision is not null
     )
     and intent.captured_inventory_revision is not null
   group by intent.id;
end;
$$;

create or replace function library.load_claimed_full_scan_scope(
  p_intent_id bigint,
  p_library_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  logical_root_id text,
  root_path text,
  root_kind text,
  library_id bigint,
  is_active boolean,
  inventory_mutation_revision bigint,
  scope_complete boolean,
  exception_overrides jsonb,
  separate_release_keys text[]
)
language sql
security definer
set search_path = pg_catalog
as $$
  with claimed_intent as (
    select intent.id, intent.library_id, intent.captured_inventory_revision
      from library.full_scan_intents as intent
      join ops.jobs as job on job.id = intent.job_id
     where intent.id = p_intent_id
       and intent.library_id = p_library_id
       and intent.job_id = p_job_id
       and intent.state = 'running'
       and intent.execution_attempt = p_attempt
       and intent.captured_inventory_revision is not null
       and job.kind = 'full_scan'
       and job.subject_kind = 'full_scan_intent'
       and job.subject_ref = p_intent_id::text
       and job.library_id = p_library_id
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now
  ), accepted_roots as (
    select claimed_intent.id as intent_id,
           claimed_intent.library_id,
           claimed_intent.captured_inventory_revision,
           accepted.metadata ->> 'root_id' as logical_root_id,
           intent_root.ordinal
      from claimed_intent
      join library.full_scan_intent_roots as intent_root
        on intent_root.intent_id = claimed_intent.id
      join library.library_roots as accepted on accepted.id = intent_root.root_id
  )
  select current_root.metadata ->> 'root_id',
         current_root.root_path,
         current_root.root_kind,
         current_root.library_id,
         current_root.is_active,
         accepted_roots.captured_inventory_revision,
         count(*) over () = (select count(*) from accepted_roots),
         coalesce((
           select jsonb_object_agg(
                    exception.track_key,
                    coalesce(exception.override_payload ->> 'exception_type', '')
                  )
             from library.exception_overrides as exception
            where exception.library_id = accepted_roots.library_id
         ), '{}'::jsonb),
         coalesce((
           select array_agg(release.release_key order by release.release_key)
             from library.separate_releases as release
            where release.library_id = accepted_roots.library_id
         ), array[]::text[])
    from accepted_roots
    join library.library_roots as current_root
      on current_root.library_id = accepted_roots.library_id
     and current_root.metadata ->> 'root_id' = accepted_roots.logical_root_id
     and current_root.is_active is true
   where nullif(btrim(current_root.metadata ->> 'root_id'), '') is not null
   order by accepted_roots.ordinal;
$$;

create or replace function library.checkpoint_claimed_full_scan(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_phase varchar,
  p_progress_current bigint,
  p_progress_total bigint,
  p_current_path text,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null or
     p_worker_id is null or p_lease_token is null or p_now is null or
     p_phase not in (
       'preparing', 'discovering', 'indexing', 'finalizing', 'publishing'
     ) or
     p_progress_current is null or p_progress_total is null or
     p_progress_current < 0 or p_progress_total < p_progress_current or
     (p_current_path is not null and (
       length(p_current_path) not between 1 and 4096 or
       p_current_path ~ '[[:cntrl:]]'
     )) then
    return false;
  end if;

  perform 1
    from ops.jobs as job
   where job.id = p_job_id
     and job.kind = 'full_scan'
     and job.subject_kind = 'full_scan_intent'
     and job.subject_ref = p_intent_id::text
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now
   for update;
  if not found then
    return false;
  end if;

  update library.full_scan_intents as intent
     set progress_current = p_progress_current,
         progress_total = p_progress_total,
         progress_phase = p_phase,
         current_path = p_current_path,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id
     and intent.job_id = p_job_id
     and intent.state = 'running'
     and intent.execution_attempt = p_attempt
     and intent.committed_inventory_revision is null
     and intent.progress_current <= p_progress_current
     and intent.progress_total <= p_progress_total;
  return found;
end;
$$;

create or replace function library.fence_full_scan_publication(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_expected_inventory_revision bigint,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  claimed_library_id bigint;
  current_revision bigint;
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null or
     p_worker_id is null or p_lease_token is null or p_now is null or
     p_expected_inventory_revision is null or
     p_expected_inventory_revision < 0 then
    return false;
  end if;

  select intent.library_id
    into claimed_library_id
    from ops.jobs as job
    join library.full_scan_intents as intent
      on intent.id = p_intent_id
     and intent.job_id = job.id
     and intent.library_id = job.library_id
     and intent.state = 'running'
     and intent.execution_attempt = p_attempt
     and intent.captured_inventory_revision = p_expected_inventory_revision
     and intent.committed_inventory_revision is null
   where job.id = p_job_id
     and job.kind = 'full_scan'
     and job.subject_kind = 'full_scan_intent'
     and job.subject_ref = p_intent_id::text
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now
   for update of job, intent;
  if claimed_library_id is null then
    return false;
  end if;

  select coalesce(nullif(
           library_record.metadata ->> 'inventory_mutation_revision', ''
         )::bigint, 0)
    into current_revision
    from library.libraries as library_record
   where library_record.id = claimed_library_id
   for update;
  if current_revision <> p_expected_inventory_revision then
    return false;
  end if;

  update library.libraries as library_record
     set metadata = coalesce(library_record.metadata, '{}'::jsonb)
           || jsonb_build_object(
                'inventory_mutation_revision',
                p_expected_inventory_revision + 1
              ),
         updated_at = greatest(library_record.updated_at, p_now)
   where library_record.id = claimed_library_id
     and coalesce(nullif(
           library_record.metadata ->> 'inventory_mutation_revision', ''
         )::bigint, 0) = p_expected_inventory_revision
  returning coalesce(nullif(
    library_record.metadata ->> 'inventory_mutation_revision', ''
  )::bigint, 0) into current_revision;
  if current_revision <> p_expected_inventory_revision + 1 then
    return false;
  end if;

  update library.full_scan_intents as intent
     set committed_inventory_revision = current_revision,
         progress_phase = 'publishing',
         current_path = null,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id
     and intent.job_id = p_job_id
     and intent.execution_attempt = p_attempt
     and intent.committed_inventory_revision is null;
  return found;
end;
$$;

create or replace function library.publish_claimed_full_scan(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_expected_inventory_revision bigint,
  p_inventory jsonb,
  p_observed_root_ids text[],
  p_now timestamptz
)
returns table (publication_won boolean, inventory_mutation_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  claimed_library_id bigint;
  claimed_account_id bigint;
  claimed_capability_key varchar;
  claimed_request_origin_id bigint;
  claimed_deployment_mode varchar;
  claimed_client_surface varchar;
  committed_revision bigint;
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null or
     p_worker_id is null or p_lease_token is null or p_now is null or
     p_expected_inventory_revision is null or p_expected_inventory_revision < 0 or
     jsonb_typeof(p_inventory) <> 'object' or p_observed_root_ids is null or
     cardinality(p_observed_root_ids) < 1 then
    raise exception 'full scan publication input is invalid';
  end if;

  select intent.library_id, job.account_id, job.capability_key,
         job.request_origin_id, job.deployment_mode, job.client_surface
    into claimed_library_id, claimed_account_id, claimed_capability_key,
         claimed_request_origin_id, claimed_deployment_mode,
         claimed_client_surface
    from ops.jobs as job
    join library.full_scan_intents as intent
      on intent.id = p_intent_id and intent.job_id = job.id
     and intent.library_id = job.library_id and intent.state = 'running'
     and intent.execution_attempt = p_attempt
     and intent.captured_inventory_revision = p_expected_inventory_revision
     and intent.committed_inventory_revision is null
   where job.id = p_job_id and job.kind = 'full_scan'
     and job.subject_kind = 'full_scan_intent'
     and job.subject_ref = p_intent_id::text and job.state = 'running'
     and job.attempt_count = p_attempt and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token and job.lease_expires_at > p_now
     and job.cancel_requested_at is null
   for update of job, intent;
  if claimed_library_id is null then
    return query select false, null::bigint;
    return;
  end if;

  if claimed_capability_key <> 'library.refresh'
     or claimed_deployment_mode not in (
       'local_development', 'self_hosted', 'self_hosted_private_web'
     )
     or claimed_client_surface <> 'private_web' then
    return query select false, null::bigint;
    return;
  end if;

  perform 1 from app.accounts as account
   where account.id = claimed_account_id
     and account.is_active is true and account.disabled_at is null
   for update;
  if not found then
    return query select false, null::bigint;
    return;
  end if;

  perform 1 from library.library_memberships as membership
   where membership.library_id = claimed_library_id
     and membership.account_id = claimed_account_id
   for update;
  if not found then
    return query select false, null::bigint;
    return;
  end if;

  perform 1 from app.bootstrap_owners as owner_record
   where owner_record.account_id = claimed_account_id
     and owner_record.owner_key = 'local-bootstrap-owner'
   for update;
  if not found then
    perform 1 from app.capabilities as capability
     where capability.account_id = claimed_account_id
       and capability.capability_key = claimed_capability_key
       and capability.revoked_at is null
       and (
         (capability.scope_kind = 'global' and capability.scope_id is null)
         or (
           capability.scope_kind = 'library'
           and capability.scope_id = claimed_library_id
         )
       )
     for update;
    if not found then
      return query select false, null::bigint;
      return;
    end if;
  end if;

  perform 1 from app.request_origins as origin
   where origin.id = claimed_request_origin_id
     and origin.account_id = claimed_account_id
     and origin.client_surface_class = claimed_client_surface
     and nullif(btrim(origin.origin_type), '') is not null
   for update;
  if not found then
    return query select false, null::bigint;
    return;
  end if;

  perform current_root.id
    from library.full_scan_intent_roots as intent_root
    join library.library_roots as accepted_root on accepted_root.id = intent_root.root_id
    join library.library_roots as current_root
      on current_root.library_id = claimed_library_id
     and current_root.metadata ->> 'root_id' = accepted_root.metadata ->> 'root_id'
   where intent_root.intent_id = p_intent_id
   for update of current_root;

  if exists (
    with accepted as (
      select root.metadata ->> 'root_id' as root_id
        from library.full_scan_intent_roots as intent_root
        join library.library_roots as root on root.id = intent_root.root_id
       where intent_root.intent_id = p_intent_id
    )
    select 1 from accepted
     where accepted.root_id is null
        or not (accepted.root_id = any(p_observed_root_ids))
        or not exists (
          select 1 from library.library_roots as current_root
           where current_root.library_id = claimed_library_id
             and current_root.metadata ->> 'root_id' = accepted.root_id
             and current_root.is_active is true
        )
  ) or cardinality(p_observed_root_ids) <> (
    select count(*) from library.full_scan_intent_roots
     where intent_id = p_intent_id
  ) then
    return query select false, null::bigint;
    return;
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
        as input(private_path text)
     where nullif(btrim(input.private_path), '') is null
        or not exists (
          select 1 from library.library_roots as root
           where root.library_id = claimed_library_id and root.is_active is true
             and root.metadata ->> 'root_id' = any(p_observed_root_ids)
             and starts_with(
               library.local_path_key(input.private_path),
               rtrim(library.local_path_key(root.root_path), '/') || '/'
             )
        )
  ) then
    raise exception 'full scan publication file scope is invalid';
  end if;

  if exists (
    with artists as (
      select input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'artists', '[]'::jsonb))
          as input(artist_key text)
    ), albums as (
      select input.album_key, input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
          as input(album_key text, artist_key text)
    ), tracks as (
      select input.track_key, input.album_key, input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
          as input(track_key text, album_key text, artist_key text)
    ), files as (
      select input.track_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
          as input(track_key text)
    )
    select 1 from albums
     where nullif(btrim(albums.album_key), '') is null
        or (albums.artist_key is not null and not exists (
          select 1 from artists where artists.artist_key = albums.artist_key
        ))
    union all
    select 1 from tracks
     where nullif(btrim(tracks.track_key), '') is null
        or not exists (select 1 from files where files.track_key = tracks.track_key)
        or (tracks.album_key is not null and not exists (
          select 1 from albums where albums.album_key = tracks.album_key
        ))
        or (tracks.artist_key is not null and not exists (
          select 1 from artists where artists.artist_key = tracks.artist_key
        ))
  ) then
    raise exception 'full scan publication hierarchy is invalid';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('album-haven:local-inventory-publication')
  );
  select coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0)
    into committed_revision
    from library.libraries where id = claimed_library_id for update;
  if committed_revision <> p_expected_inventory_revision then
    return query select false, committed_revision;
    return;
  end if;

  insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)
  select claimed_library_id, input.artist_key, input.name, input.sort_name, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'artists', '[]'::jsonb))
      as input(artist_key text, name text, sort_name text, metadata jsonb)
  on conflict (library_id, artist_key) do update set
    name = excluded.name, sort_name = excluded.sort_name, last_seen_at = now(),
    metadata = library.local_artists.metadata || excluded.metadata;

  insert into library.local_albums
    (library_id, artist_id, album_key, title, release_year, cover_path, metadata)
  select claimed_library_id, artist.id, input.album_key, input.title,
         input.release_year, input.cover_path, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
      as input(artist_key text, album_key text, title text, release_year integer,
               cover_path text, metadata jsonb)
    left join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, album_key) do update set
    artist_id = excluded.artist_id, title = excluded.title,
    release_year = case
      when nullif(library.local_albums.metadata ->> 'release_date', '') is not null
      then library.local_albums.release_year else excluded.release_year end,
    cover_path = case
      when library.local_albums.metadata ->> 'cover_selection_origin' = 'user'
      then library.local_albums.cover_path else excluded.cover_path end,
    last_seen_at = now(),
    metadata = library.local_albums.metadata || case
      when library.local_albums.metadata ->> 'cover_selection_origin' = 'user'
      then excluded.metadata - array['cover_revision', 'cover_selection_origin']
      else excluded.metadata end;

  delete from library.local_album_featured_artists as featured
   using library.local_albums as album
   where featured.album_id = album.id and album.library_id = claimed_library_id
     and featured.metadata ->> 'source' = 'scan_cache';
  insert into library.local_album_featured_artists
    (library_id, album_id, artist_id, featured_kind, metadata)
  select claimed_library_id, album.id, artist.id, input.featured_kind, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'featured_artists', '[]'::jsonb))
      as input(album_key text, artist_key text, featured_kind text, metadata jsonb)
    join library.local_albums as album
      on album.library_id = claimed_library_id and album.album_key = input.album_key
    join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, album_id, artist_id, featured_kind) do update set
    last_seen_at = now(), metadata = excluded.metadata;

  insert into library.local_tracks
    (library_id, album_id, artist_id, track_key, title, disc_number,
     track_number, duration_seconds, metadata)
  select claimed_library_id, album.id, artist.id, input.track_key, input.title,
         input.disc_number, input.track_number, input.duration_seconds, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
      as input(album_key text, artist_key text, track_key text, title text,
               disc_number integer, track_number integer,
               duration_seconds integer, metadata jsonb)
    left join library.local_albums as album
      on album.library_id = claimed_library_id and album.album_key = input.album_key
    left join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, track_key) do update set
    album_id = excluded.album_id, artist_id = excluded.artist_id,
    title = excluded.title, disc_number = excluded.disc_number,
    track_number = excluded.track_number, duration_seconds = excluded.duration_seconds,
    last_seen_at = now(), metadata = library.local_tracks.metadata || excluded.metadata;

  insert into library.local_track_files
    (track_id, library_root_id, private_path, relative_path,
     file_size_bytes, modified_at, metadata)
  select track.id,
         library.require_local_track_file_root_id(
           claimed_library_id, input.private_path, input.metadata
         ),
         input.private_path, input.relative_path, input.file_size_bytes,
         to_timestamp(input.modified_at_epoch), input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
      as input(track_key text, private_path text, relative_path text,
               file_size_bytes bigint, modified_at_epoch double precision,
               metadata jsonb)
    join library.local_tracks as track
      on track.library_id = claimed_library_id and track.track_key = input.track_key
  on conflict (private_path) do update set
    track_id = excluded.track_id, library_root_id = excluded.library_root_id,
    relative_path = excluded.relative_path, file_size_bytes = excluded.file_size_bytes,
    modified_at = excluded.modified_at, last_seen_at = now(),
    metadata = (library.local_track_files.metadata || excluded.metadata)
                 #- '{scan_cache,stale_marked_at}';

  update library.local_track_files as file
     set metadata = jsonb_set(
       coalesce(file.metadata, '{}'::jsonb), '{scan_cache}',
       coalesce(file.metadata -> 'scan_cache', '{}'::jsonb) ||
         jsonb_build_object('source', 'scan_cache', 'stale', true,
                            'stale_marked_at', now()::text), true
     ), last_seen_at = now()
    from library.library_roots as root, library.local_tracks as track
   where file.library_root_id = root.id and file.track_id = track.id
     and root.library_id = claimed_library_id and track.library_id = claimed_library_id
     and root.metadata ->> 'root_id' = any(p_observed_root_ids)
     and file.metadata #>> '{scan_cache,source}' = 'scan_cache'
     and not exists (
       select 1
         from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
           as submitted(private_path text)
        where library.local_path_key(submitted.private_path)
              = library.local_path_key(file.private_path)
     );

  committed_revision := p_expected_inventory_revision + 1;
  update library.libraries as library_record
     set metadata = coalesce(library_record.metadata, '{}'::jsonb) ||
       jsonb_build_object(
         'inventory_mutation_revision', committed_revision,
         'scan_cache', coalesce(library_record.metadata -> 'scan_cache', '{}'::jsonb) ||
           jsonb_build_object(
             'relation_projection',
             coalesce(library_record.metadata #> '{scan_cache,relation_projection}', '{}'::jsonb)
               || jsonb_build_object('status', 'stale')
           )
       ), updated_at = now()
   where library_record.id = claimed_library_id;
  update library.full_scan_intents as intent
     set committed_inventory_revision = committed_revision,
         progress_phase = 'publishing', current_path = null,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id and intent.job_id = p_job_id
     and intent.execution_attempt = p_attempt
     and intent.committed_inventory_revision is null;
  if not found then
    raise exception 'full scan publication fence was lost';
  end if;

  insert into ops.jobs (
    kind, subject_kind, subject_ref, parameters, account_id, library_id,
    capability_key, request_origin_id, deployment_mode, client_surface,
    scope_version, resource_revision, idempotency_key, priority, scheduled_at,
    max_attempts, recovery_policy
  ) values (
    'post_scan_cover_refresh',
    'inventory_revision',
    'revision-' || committed_revision::text,
    jsonb_build_object('inventory_revision', committed_revision),
    null,
    claimed_library_id,
    null,
    null,
    claimed_deployment_mode,
    claimed_client_surface,
    null,
    committed_revision,
    'post-scan-cover-refresh:' || claimed_library_id::text || ':' || committed_revision::text,
    0,
    p_now,
    2,
    'retry_safe'
  )
  on conflict do nothing;

  perform 1
    from ops.jobs as follow_up
   where follow_up.kind = 'post_scan_cover_refresh'
     and follow_up.subject_kind = 'inventory_revision'
     and follow_up.subject_ref = 'revision-' || committed_revision::text
     and follow_up.parameters = jsonb_build_object(
       'inventory_revision', committed_revision
     )
     and follow_up.account_id is null
     and follow_up.library_id = claimed_library_id
     and follow_up.capability_key is null
     and follow_up.request_origin_id is null
     and follow_up.deployment_mode = claimed_deployment_mode
     and follow_up.client_surface = claimed_client_surface
     and follow_up.scope_version is null
     and follow_up.resource_revision = committed_revision
     and follow_up.idempotency_key =
       'post-scan-cover-refresh:' || claimed_library_id::text || ':' || committed_revision::text
     and follow_up.priority = 0
     and follow_up.max_attempts = 2
     and follow_up.recovery_policy = 'retry_safe';
  if not found then
    raise exception 'post-scan cover follow-up identity conflict';
  end if;

  return query select true, committed_revision;
end;
$$;

create or replace function library.validate_claimed_post_scan_cover_refresh(
  p_library_id bigint,
  p_inventory_revision bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
      from ops.jobs as job
      join library.libraries as library_record on library_record.id = job.library_id
     where job.id = p_job_id
       and job.kind = 'post_scan_cover_refresh'
       and job.subject_kind = 'inventory_revision'
       and job.subject_ref = 'revision-' || p_inventory_revision::text
       and job.parameters = jsonb_build_object(
         'inventory_revision', p_inventory_revision
       )
       and job.account_id is null
       and job.capability_key is null
       and job.request_origin_id is null
       and job.library_id = p_library_id
       and job.resource_revision = p_inventory_revision
       and job.idempotency_key =
         'post-scan-cover-refresh:' || p_library_id::text || ':' || p_inventory_revision::text
       and job.max_attempts = 2
       and job.recovery_policy = 'retry_safe'
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now
       and job.cancel_requested_at is null
       and coalesce(
         nullif(library_record.metadata ->> 'inventory_mutation_revision', '')::bigint,
         0
       ) = p_inventory_revision
  );
$$;

create or replace function library.load_authorized_full_scan_status(p_library_id bigint)
returns table (
  state varchar,
  progress_current bigint,
  progress_total bigint,
  current_path text,
  phase varchar,
  mode varchar,
  outcome_code varchar,
  committed_inventory_revision bigint
)
language sql
security definer
set search_path = pg_catalog
as $$
  select intent.state,
         intent.progress_current,
         intent.progress_total,
         intent.current_path,
         intent.progress_phase,
         intent.mode,
         intent.outcome_code,
         intent.committed_inventory_revision
    from library.full_scan_intents as intent
   where intent.library_id = p_library_id
   order by (
     intent.state in ('accepted', 'running', 'retry_wait')
   ) desc, intent.accepted_at desc, intent.id desc
   limit 1;
$$;

create or replace function app.load_claimed_job_authorization_context(
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  account_id bigint,
  account_is_active boolean,
  is_bootstrap_owner boolean,
  library_exists boolean,
  membership_current boolean,
  library_relationships jsonb,
  capability_grants jsonb,
  request_origin_id bigint,
  request_origin_account_id bigint,
  request_origin_type varchar,
  request_origin_surface varchar
)
language sql
security definer
set search_path = pg_catalog
as $$
  select account.id,
         case when account.id is null then null
              else account.is_active and account.disabled_at is null end,
         coalesce(exists (
           select 1 from app.bootstrap_owners as owner_record
            where owner_record.account_id = account.id
              and owner_record.owner_key = 'local-bootstrap-owner'
         ), false),
         library_record.id is not null,
         coalesce(membership.account_id is not null, false),
         case when membership.account_id is null then '[]'::jsonb
              else jsonb_build_array(jsonb_build_object(
                'library_id', membership.library_id,
                'membership_role', membership.membership_role,
                'is_primary_owner', library_record.owner_account_id = account.id
              )) end,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'capability_key', capability.capability_key,
                    'scope_kind', capability.scope_kind,
                    'scope_id', capability.scope_id
                  ))
             from app.capabilities as capability
            where capability.account_id = account.id
              and capability.capability_key = job.capability_key
              and capability.revoked_at is null
         ), '[]'::jsonb),
         request_record.id,
         request_record.account_id,
         request_record.origin_type,
         request_record.client_surface_class
    from ops.jobs as job
    left join app.accounts as account on account.id = job.account_id
    left join library.libraries as library_record on library_record.id = job.library_id
    left join library.library_memberships as membership
      on membership.account_id = account.id
     and membership.library_id = library_record.id
    left join app.request_origins as request_record
      on request_record.id = job.request_origin_id
   where job.id = p_job_id
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now;
$$;

revoke all on function library.load_claimed_full_scan_intent_v2(bigint, varchar, varchar) from public;
revoke all on function library.load_claimed_full_scan_scope(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.checkpoint_claimed_full_scan(bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, text, timestamptz) from public;
revoke all on function library.fence_full_scan_publication(bigint, bigint, integer, varchar, varchar, bigint, timestamptz) from public;
revoke all on function library.publish_claimed_full_scan(bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz) from public;
revoke all on function library.validate_claimed_post_scan_cover_refresh(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.load_authorized_full_scan_status(bigint) from public;
revoke all on function app.load_claimed_job_authorization_context(bigint, integer, varchar, varchar, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke execute on function library.load_claimed_full_scan_intent(bigint, varchar, varchar) from album_haven_worker;
    revoke execute on function library.checkpoint_claimed_scan_intent(varchar, bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, bigint, timestamptz) from album_haven_worker;
    grant execute on function library.load_claimed_full_scan_intent_v2(bigint, varchar, varchar) to album_haven_worker;
    grant execute on function library.load_claimed_full_scan_scope(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) to album_haven_worker;
    grant execute on function library.checkpoint_claimed_full_scan(bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, text, timestamptz) to album_haven_worker;
    revoke execute on function library.fence_full_scan_publication(bigint, bigint, integer, varchar, varchar, bigint, timestamptz) from album_haven_worker;
    grant execute on function library.publish_claimed_full_scan(bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz) to album_haven_worker;
    grant execute on function library.validate_claimed_post_scan_cover_refresh(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) to album_haven_worker;
    grant execute on function app.load_claimed_job_authorization_context(bigint, integer, varchar, varchar, timestamptz) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.load_authorized_full_scan_status(bigint) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke execute on function library.load_claimed_full_scan_intent_v2(bigint, varchar, varchar) from album_haven_readonly;
    revoke execute on function library.load_claimed_full_scan_scope(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) from album_haven_readonly;
    revoke execute on function library.checkpoint_claimed_full_scan(bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, text, timestamptz) from album_haven_readonly;
    revoke execute on function library.fence_full_scan_publication(bigint, bigint, integer, varchar, varchar, bigint, timestamptz) from album_haven_readonly;
    revoke execute on function library.publish_claimed_full_scan(bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz) from album_haven_readonly;
    revoke execute on function library.validate_claimed_post_scan_cover_refresh(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) from album_haven_readonly;
    revoke execute on function library.load_authorized_full_scan_status(bigint) from album_haven_readonly;
    revoke execute on function app.load_claimed_job_authorization_context(bigint, integer, varchar, varchar, timestamptz) from album_haven_readonly;
  end if;
end $$;
