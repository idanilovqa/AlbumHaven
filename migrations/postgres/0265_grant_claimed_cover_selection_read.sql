-- depends on: 0262_create_lastfm_reauthentication_continuations.sql
-- Read current cover authority through the worker's existing refresh claim.
-- Keep claim fences intact while carrying trusted roots in the private inventory.
create or replace function ops.begin_claimed_cover_refresh(
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  requested_mode text,
  requested_inventory_revision bigint,
  requested_task_key text
)
returns table (
  task_id bigint,
  task_key text,
  row_revision bigint,
  file_cache jsonb,
  separate_release_keys text[],
  progress_total integer,
  mode text,
  force_search boolean
)
language plpgsql
security definer
set search_path = pg_catalog, ops, library
as $$
#variable_conflict use_column
declare
  selected_job ops.jobs%rowtype;
  selected_refresh ops.cover_bulk_refreshes%rowtype;
begin
  select * into selected_job
    from ops.jobs as job
   where job.id = requested_job_id
     and job.library_id = requested_library_id
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > clock_timestamp()
     and job.cancel_requested_at is null
     and job.kind in ('cover_bulk_refresh', 'post_scan_cover_refresh')
   for update;
  if selected_job.id is null then
    return;
  end if;

  if selected_job.kind = 'post_scan_cover_refresh' then
    if requested_mode <> 'post_scan'
       or selected_job.subject_kind <> 'inventory_revision'
       or selected_job.subject_ref <> 'revision-' || requested_inventory_revision::text
       or selected_job.parameters <> jsonb_build_object(
         'inventory_revision', requested_inventory_revision
       )
       or selected_job.resource_revision is distinct from requested_inventory_revision
       or selected_job.account_id is not null
       or selected_job.capability_key is not null
       or not exists (
         select 1 from library.libraries as library_record
          where library_record.id = requested_library_id
            and coalesce(
              nullif(library_record.metadata ->> 'inventory_mutation_revision', '')::bigint,
              0
            ) = requested_inventory_revision
       ) then
      return;
    end if;
    insert into ops.cover_bulk_refreshes (
      task_key, library_id, capability_key, deployment_mode,
      client_surface, mode, force_search, status, resource_revision,
      job_id, requested_at
    ) values (
      'post-scan-' || requested_inventory_revision::text,
      requested_library_id, null, selected_job.deployment_mode,
      selected_job.client_surface, 'post_scan', false, 'running',
      requested_inventory_revision, requested_job_id, observed_at
    )
    on conflict (library_id, task_key) do update set
      status = case
        when ops.cover_bulk_refreshes.status in ('pending', 'running')
          then 'running'
        else ops.cover_bulk_refreshes.status
      end,
      job_id = case
        when ops.cover_bulk_refreshes.job_id is null
          then excluded.job_id
        else ops.cover_bulk_refreshes.job_id
      end,
      row_revision = ops.cover_bulk_refreshes.row_revision + case
        when ops.cover_bulk_refreshes.status = 'pending' then 1 else 0 end,
      updated_at = observed_at
    returning * into selected_refresh;
  else
    select * into selected_refresh
      from ops.cover_bulk_refreshes as refresh
     where refresh.job_id = requested_job_id
       and refresh.library_id = requested_library_id
       and refresh.status in ('pending', 'running')
       and refresh.capability_key = 'library.covers.fetch'
       and refresh.initiating_account_id = selected_job.account_id
       and refresh.resource_revision = selected_job.resource_revision
     for update;
    if selected_refresh.id is null then
      return;
    end if;
    update ops.cover_bulk_refreshes as refresh
       set status = 'running',
           row_revision = refresh.row_revision + case
             when refresh.status = 'pending' then 1 else 0 end,
           updated_at = observed_at
     where refresh.id = selected_refresh.id
    returning * into selected_refresh;
  end if;

  if selected_refresh.status not in ('pending', 'running')
     or selected_refresh.job_id <> requested_job_id then
    return;
  end if;

  return query
  select
    selected_refresh.id,
    selected_refresh.task_key::text,
    selected_refresh.row_revision,
    coalesce(
      jsonb_object_agg(
        file.private_path,
        coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
          || jsonb_build_object(
            'path', file.private_path,
            'library_root_path', root.root_path,
            'album_id', album.id,
            'album', album.title,
            'album_artist', coalesce(album.metadata ->> 'album_artist', artist.name, ''),
            'year', album.release_year,
            'edition', coalesce(album.metadata ->> 'edition', ''),
            'cover_path', album.cover_path,
            'cover_selection_origin', album.metadata ->> 'cover_selection_origin'
          )
      ) filter (where file.id is not null),
      '{}'::jsonb
    ),
    coalesce(
      array(
        select release.release_key
          from library.separate_releases as release
         where release.library_id = requested_library_id
         order by release.release_key
      ),
      array[]::text[]
    ),
    count(distinct album.id) filter (where file.id is not null)::integer,
    selected_refresh.mode::text,
    selected_refresh.force_search
    from library.libraries as library_record
    left join library.local_tracks as track
      on track.library_id = library_record.id
    left join library.local_track_files as file
      on file.track_id = track.id
    left join library.library_roots as root
      on root.id = file.library_root_id
     and root.library_id = library_record.id
     and root.is_active is true
    left join library.local_albums as album on album.id = track.album_id
    left join library.local_artists as artist on artist.id = album.artist_id
   where library_record.id = requested_library_id
     and (file.id is null or root.id is not null)
     and (
       file.id is null
       or coalesce((file.metadata #>> '{scan_cache,stale}')::boolean, false) is false
     )
   group by library_record.id;
end;
$$;

create function ops.load_claimed_cover_refresh_selections(
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  requested_album_ids bigint[])
returns table (
  album_id bigint, cover_path text, cover_selection_origin text,
  cover_selection_provenance text, cover_revision text, remote_cover_url text,
  remote_cover_width integer, remote_cover_height integer)
language sql
security definer
set search_path = pg_catalog
as $$
  select album.id, album.cover_path::text,
         album.metadata ->> 'cover_selection_origin',
         album.metadata ->> 'cover_selection_provenance',
         album.metadata ->> 'cover_revision',
         album.metadata ->> 'remote_cover_url',
         (album.metadata ->> 'remote_cover_width')::integer,
         (album.metadata ->> 'remote_cover_height')::integer
    from ops.cover_bulk_refreshes refresh
    join ops.jobs job on job.id = refresh.job_id
    join library.local_albums album on album.library_id = refresh.library_id
   where refresh.id = requested_task_id
     and refresh.library_id = requested_library_id
     and refresh.job_id = requested_job_id
     and refresh.status = 'running'
     and refresh.cancel_requested_at is null
     and job.library_id = requested_library_id
     and job.kind in ('cover_bulk_refresh', 'post_scan_cover_refresh')
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > clock_timestamp()
     and job.cancel_requested_at is null
     and observed_at is not null and isfinite(observed_at)
     and album.id = any(requested_album_ids)
     and exists (
       select 1 from library.local_tracks track
       join library.local_track_files file on file.track_id = track.id
       join library.library_roots root on root.id = file.library_root_id
        and root.library_id = album.library_id and root.is_active is true
       where track.album_id = album.id and track.library_id = album.library_id
         and file.scan_cache_stale is false
         and file.metadata #>> '{scan_cache,source}' = 'runtime_scan_cache'
     );
$$;

revoke all on function ops.load_claimed_cover_refresh_selections(bigint,bigint,bigint,integer,text,text,timestamptz,bigint[]) from public, album_haven_app, album_haven_readonly;
grant execute on function ops.load_claimed_cover_refresh_selections(bigint,bigint,bigint,integer,text,text,timestamptz,bigint[]) to album_haven_worker;

alter function ops.validate_durable_worker_startup(text[])
  rename to validate_durable_worker_startup_baseline_0265;

create function ops.validate_durable_worker_startup(p_registered_kinds text[])
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  reader regprocedure := to_regprocedure(
    'ops.load_claimed_cover_refresh_selections(bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint[])');
begin
  if reader is null or not has_function_privilege('album_haven_worker', reader, 'EXECUTE') then
    return false;
  end if;
  return ops.validate_durable_worker_startup_baseline_0265(p_registered_kinds);
end;
$$;

revoke all on function ops.validate_durable_worker_startup_baseline_0265(text[]) from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.validate_durable_worker_startup(text[]) from public, album_haven_app, album_haven_readonly;
grant execute on function ops.validate_durable_worker_startup(text[]) to album_haven_worker;
