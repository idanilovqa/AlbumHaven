create or replace function ops.accept_cover_bulk_refresh(
  requested_task_key text,
  requested_library_id bigint,
  requested_account_id bigint,
  requested_origin_type text,
  requested_origin_key text,
  requested_deployment_mode text,
  requested_client_surface text,
  requested_mode text,
  requested_force_search boolean,
  requested_resource_revision bigint,
  requested_at timestamptz
)
returns table (
  task_id bigint,
  job_id bigint,
  row_revision bigint,
  already_running boolean
)
language plpgsql
security definer
set search_path = pg_catalog, ops, app, library
as $$
declare
  resolved_origin_id bigint;
  accepted_task ops.cover_bulk_refreshes%rowtype;
  accepted_job_id bigint;
begin
  if requested_mode not in ('manual', 'background')
     or not exists (
       select 1
         from app.accounts as account
         join library.libraries as library_record
           on library_record.id = requested_library_id
        where account.id = requested_account_id
          and account.is_active is true
          and coalesce(
            nullif(library_record.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) = requested_resource_revision
          and (
            library_record.owner_account_id = requested_account_id
            or exists (
              select 1 from library.library_memberships as membership
               where membership.library_id = requested_library_id
                 and membership.account_id = requested_account_id
            )
          )
     ) then
    return;
  end if;
  select origin.id into resolved_origin_id
    from app.request_origins as origin
   where origin.account_id = requested_account_id
     and origin.origin_type = requested_origin_type
     and origin.origin_key = requested_origin_key
     and origin.client_surface_class = requested_client_surface
   order by origin.id desc limit 1;
  if resolved_origin_id is null then
    return;
  end if;

  select * into accepted_task
    from ops.cover_bulk_refreshes as refresh
   where refresh.library_id = requested_library_id
     and refresh.status in ('pending', 'running')
   order by refresh.id desc limit 1
   for update;
  if accepted_task.id is not null then
    return query select accepted_task.id, accepted_task.job_id,
                        accepted_task.row_revision, true;
    return;
  end if;

  insert into ops.cover_bulk_refreshes (
    task_key, library_id, initiating_account_id, request_origin_id,
    capability_key, deployment_mode, client_surface, mode, force_search,
    status, resource_revision, requested_at
  ) values (
    requested_task_key, requested_library_id, requested_account_id,
    resolved_origin_id, 'library.covers.fetch', requested_deployment_mode,
    requested_client_surface, requested_mode, requested_force_search,
    'pending', requested_resource_revision, requested_at
  ) returning * into accepted_task;

  insert into ops.jobs (
    kind, subject_kind, subject_ref, parameters, account_id, library_id,
    capability_key, request_origin_id, deployment_mode, client_surface,
    idempotency_key, scheduled_at, max_attempts, recovery_policy,
    resource_revision
  ) values (
    'cover_bulk_refresh', 'cover_bulk_refresh', requested_task_key,
    jsonb_build_object(
      'task_id', accepted_task.id,
      'mode', requested_mode,
      'force_search', requested_force_search
    ),
    requested_account_id, requested_library_id, 'library.covers.fetch',
    resolved_origin_id, requested_deployment_mode, requested_client_surface,
    'cover-bulk-refresh:' || requested_library_id::text || ':' || requested_task_key,
    requested_at, 2, 'retry_safe', requested_resource_revision
  ) returning id into accepted_job_id;

  update ops.cover_bulk_refreshes as refresh
     set job_id = accepted_job_id, row_revision = refresh.row_revision + 1
   where refresh.id = accepted_task.id
  returning refresh.row_revision into accepted_task.row_revision;
  return query select accepted_task.id, accepted_job_id,
                      accepted_task.row_revision, false;
end;
$$;

create or replace function ops.request_cover_bulk_refresh_cancellation(
  requested_library_id bigint,
  requested_account_id bigint,
  observed_at timestamptz
)
returns table (canceled boolean, covers_in_progress boolean)
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
declare
  selected_refresh ops.cover_bulk_refreshes%rowtype;
  resulting_state text;
begin
  select * into selected_refresh
    from ops.cover_bulk_refreshes as refresh
   where refresh.library_id = requested_library_id
     and refresh.initiating_account_id = requested_account_id
     and refresh.status in ('pending', 'running')
   order by refresh.id desc limit 1
   for update;
  if selected_refresh.id is null or selected_refresh.job_id is null then
    return query select false, false;
    return;
  end if;
  perform * from ops.request_job_cancellation(
    selected_refresh.job_id, requested_account_id, observed_at
  );
  select state into resulting_state from ops.jobs where id = selected_refresh.job_id;
  update ops.cover_bulk_refreshes as refresh
     set cancel_requested_at = coalesce(refresh.cancel_requested_at, observed_at),
         cancel_requested_by_account_id = coalesce(
           refresh.cancel_requested_by_account_id, requested_account_id
         ),
         status = case when resulting_state = 'canceled' then 'canceled' else refresh.status end,
         completed_at = case
           when resulting_state = 'canceled' then coalesce(refresh.completed_at, observed_at)
           else refresh.completed_at end,
         safe_display_label = case when resulting_state = 'canceled' then '' else refresh.safe_display_label end,
         row_revision = refresh.row_revision + 1,
         updated_at = observed_at
   where refresh.id = selected_refresh.id;
  return query select true, resulting_state <> 'canceled';
end;
$$;

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
     and job.lease_expires_at > observed_at
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

create or replace function ops.cover_refresh_cancel_requested(
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz
)
returns boolean
language sql
security definer
set search_path = pg_catalog, ops
as $$
  select coalesce((
    select job.cancel_requested_at is not null
        or refresh.cancel_requested_at is not null
        or job.state <> 'running'
        or job.attempt_count <> requested_attempt
        or job.lease_owner is distinct from requested_worker_id
        or job.lease_token is distinct from requested_lease_token
        or job.lease_expires_at <= observed_at
      from ops.jobs as job
      join ops.cover_bulk_refreshes as refresh on refresh.job_id = job.id
     where job.id = requested_job_id
       and refresh.id = requested_task_id
       and refresh.library_id = requested_library_id
  ), true);
$$;

create or replace function ops.checkpoint_claimed_cover_refresh(
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_row_revision bigint,
  next_progress_current integer,
  next_progress_total integer,
  next_downloaded_count integer,
  next_safe_display_label text
)
returns bigint
language sql
security definer
set search_path = pg_catalog, ops
as $$
  update ops.cover_bulk_refreshes as refresh
     set progress_current = next_progress_current,
         progress_total = next_progress_total,
         downloaded_count = next_downloaded_count,
         safe_display_label = left(coalesce(next_safe_display_label, ''), 256),
         row_revision = refresh.row_revision + 1,
         updated_at = observed_at
    from ops.jobs as job
   where refresh.id = requested_task_id
     and refresh.library_id = requested_library_id
     and refresh.job_id = requested_job_id
     and refresh.row_revision = expected_row_revision
     and refresh.status = 'running'
     and next_progress_current >= refresh.progress_current
     and next_progress_total >= next_progress_current
     and next_downloaded_count >= refresh.downloaded_count
     and job.id = requested_job_id
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > observed_at
     and job.cancel_requested_at is null
     and refresh.cancel_requested_at is null
  returning refresh.row_revision;
$$;

create or replace function ops.finish_claimed_cover_refresh(
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_row_revision bigint,
  next_status text,
  final_processed_count integer,
  final_downloaded_count integer
)
returns boolean
language sql
security definer
set search_path = pg_catalog, ops
as $$
  with finished as (
    update ops.cover_bulk_refreshes as refresh
       set status = next_status,
           progress_current = greatest(refresh.progress_current, final_processed_count),
           progress_total = greatest(refresh.progress_total, final_processed_count),
           downloaded_count = greatest(refresh.downloaded_count, final_downloaded_count),
           safe_display_label = '',
           completed_at = observed_at,
           row_revision = refresh.row_revision + 1,
           updated_at = observed_at
      from ops.jobs as job
     where refresh.id = requested_task_id
       and refresh.library_id = requested_library_id
       and refresh.job_id = requested_job_id
       and refresh.row_revision = expected_row_revision
       and refresh.status = 'running'
       and next_status in ('completed', 'failed', 'canceled')
       and job.id = requested_job_id
       and job.state = 'running'
       and job.attempt_count = requested_attempt
       and job.lease_owner = requested_worker_id
       and job.lease_token = requested_lease_token
       and job.lease_expires_at > observed_at
    returning refresh.id
  )
  select exists (select 1 from finished);
$$;

create or replace function ops.persist_claimed_automatic_cover_selection(
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  requested_track_paths text[],
  selected_cover_path text,
  selected_cover_revision text,
  selected_origin text,
  reject_if_user_controlled boolean,
  expected_origin text,
  expected_revision text
)
returns table (
  input_path_count integer,
  resolved_path_count integer,
  selected_album_count integer,
  album_track_file_count integer,
  album_rows_updated integer,
  track_file_rows_updated integer,
  blocked_by_user_selection boolean,
  blocked_by_expected_cover_state boolean
)
language sql
security definer
set search_path = pg_catalog, ops, library
as $$
  with valid_claim as materialized (
    select refresh.id
      from ops.cover_bulk_refreshes as refresh
      join ops.jobs as job on job.id = refresh.job_id
     where refresh.id = requested_task_id
       and refresh.library_id = requested_library_id
       and refresh.status = 'running'
       and refresh.cancel_requested_at is null
       and job.id = requested_job_id
       and job.state = 'running'
       and job.attempt_count = requested_attempt
       and job.lease_owner = requested_worker_id
       and job.lease_token = requested_lease_token
       and job.lease_expires_at > observed_at
       and job.cancel_requested_at is null
  ),
  input_track_paths as materialized (
    select distinct input_path as private_path
      from unnest(requested_track_paths) as input_path
     where nullif(input_path, '') is not null
  ),
  selected_track_files as materialized (
    select file.id as track_file_id, track.album_id
      from valid_claim
      join library.local_tracks as track
        on track.library_id = requested_library_id
      join library.local_track_files as file on file.track_id = track.id
      join library.library_roots as root
        on root.id = file.library_root_id
       and root.library_id = requested_library_id
       and root.is_active is true
      join input_track_paths as input
        on input.private_path = file.private_path
  ),
  selection_scope as materialized (
    select
      (select count(*) from input_track_paths)::integer as input_path_count,
      count(*)::integer as resolved_path_count,
      count(distinct selected_track_files.album_id)::integer as selected_album_count,
      min(selected_track_files.album_id) as album_id
      from selected_track_files
  ),
  target_album as materialized (
    select album.id
      from selection_scope
      join library.local_albums as album
        on album.id = selection_scope.album_id
       and album.library_id = requested_library_id
     where selection_scope.input_path_count > 0
       and selection_scope.input_path_count = selection_scope.resolved_path_count
       and selection_scope.selected_album_count = 1
  ),
  album_track_files as materialized (
    select file.id as track_file_id
      from target_album
      join library.local_tracks as track
        on track.library_id = requested_library_id
       and track.album_id = target_album.id
      join library.local_track_files as file on file.track_id = track.id
  ),
  updated_albums as (
    update library.local_albums as album
       set cover_path = selected_cover_path,
           metadata = (
             coalesce(album.metadata, '{}'::jsonb)
             - array[
               'remote_cover_url', 'remote_cover_thumbnail_url',
               'remote_cover_source', 'remote_cover_source_label',
               'remote_cover_album_url', 'remote_cover_width',
               'remote_cover_height'
             ]::text[]
           ) || jsonb_build_object(
             'cover_path', selected_cover_path,
             'cover_revision', selected_cover_revision,
             'cover_selection_origin', selected_origin
           )
      from target_album
     where album.id = target_album.id
       and selected_origin in ('automatic', 'user')
       and (
         not reject_if_user_controlled
         or coalesce(album.metadata ->> 'cover_selection_origin', '') <> 'user'
       )
       and (
         expected_origin is null
         or (
           coalesce(album.metadata ->> 'cover_selection_origin', '') = expected_origin
           and coalesce(album.metadata ->> 'cover_revision', '') = expected_revision
         )
       )
    returning album.id
  ),
  updated_track_files as (
    update library.local_track_files as file
       set metadata = jsonb_set(
         coalesce(file.metadata, '{}'::jsonb),
         '{scan_cache}',
         coalesce(file.metadata -> 'scan_cache', '{}'::jsonb)
           || jsonb_build_object(
             'file_entry',
             (
               coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
               - array[
                 'remote_cover_url', 'remote_cover_thumbnail_url',
                 'remote_cover_source', 'remote_cover_source_label',
                 'remote_cover_album_url', 'remote_cover_width',
                 'remote_cover_height'
               ]::text[]
             ) || jsonb_build_object(
               'cover_path', selected_cover_path,
               'cover_revision', selected_cover_revision
             )
           ),
         true
       )
      from album_track_files
     where file.id = album_track_files.track_file_id
       and exists (select 1 from updated_albums)
    returning file.id
  ),
  updated_library as (
    update library.libraries as library_record
       set metadata = coalesce(library_record.metadata, '{}'::jsonb)
         || jsonb_build_object(
           'cover_mutation_revision',
           coalesce(
             nullif(library_record.metadata ->> 'cover_mutation_revision', '')::bigint,
             0
           ) + 1
         ),
         updated_at = observed_at
     where library_record.id = requested_library_id
       and exists (select 1 from updated_albums)
    returning library_record.id
  )
  select
    selection_scope.input_path_count,
    selection_scope.resolved_path_count,
    selection_scope.selected_album_count,
    (select count(*) from album_track_files)::integer,
    (select count(*) from updated_albums)::integer,
    (select count(*) from updated_track_files)::integer,
    reject_if_user_controlled
      and exists (select 1 from target_album)
      and not exists (select 1 from updated_albums),
    expected_origin is not null
      and exists (select 1 from target_album)
      and not exists (select 1 from updated_albums)
    from selection_scope;
$$;

create or replace function ops.load_authorized_cover_refresh_status(
  requested_library_id bigint
)
returns table (
  covers_in_progress boolean,
  covers_processed integer,
  covers_total integer,
  covers_downloaded integer,
  covers_current_folder text
)
language sql
security definer
set search_path = pg_catalog, ops
as $$
  select
    refresh.status in ('pending', 'running'),
    refresh.progress_current,
    refresh.progress_total,
    refresh.downloaded_count,
    refresh.safe_display_label::text
    from ops.cover_bulk_refreshes as refresh
   where refresh.library_id = requested_library_id
   order by (refresh.status in ('pending', 'running')) desc,
            refresh.requested_at desc, refresh.id desc
   limit 1;
$$;

revoke all on function ops.begin_claimed_cover_refresh(bigint, bigint, integer, text, text, timestamptz, text, bigint, text) from public;
revoke all on function ops.accept_cover_bulk_refresh(text, bigint, bigint, text, text, text, text, text, boolean, bigint, timestamptz) from public;
revoke all on function ops.request_cover_bulk_refresh_cancellation(bigint, bigint, timestamptz) from public;
revoke all on function ops.cover_refresh_cancel_requested(bigint, bigint, bigint, integer, text, text, timestamptz) from public;
revoke all on function ops.checkpoint_claimed_cover_refresh(bigint, bigint, bigint, integer, text, text, timestamptz, bigint, integer, integer, integer, text) from public;
revoke all on function ops.finish_claimed_cover_refresh(bigint, bigint, bigint, integer, text, text, timestamptz, bigint, text, integer, integer) from public;
revoke all on function ops.persist_claimed_automatic_cover_selection(bigint, bigint, bigint, integer, text, text, timestamptz, text[], text, text, text, boolean, text, text) from public;
revoke all on function ops.load_authorized_cover_refresh_status(bigint) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function ops.begin_claimed_cover_refresh(bigint, bigint, integer, text, text, timestamptz, text, bigint, text) to album_haven_worker;
    grant execute on function ops.cover_refresh_cancel_requested(bigint, bigint, bigint, integer, text, text, timestamptz) to album_haven_worker;
    grant execute on function ops.checkpoint_claimed_cover_refresh(bigint, bigint, bigint, integer, text, text, timestamptz, bigint, integer, integer, integer, text) to album_haven_worker;
    grant execute on function ops.finish_claimed_cover_refresh(bigint, bigint, bigint, integer, text, text, timestamptz, bigint, text, integer, integer) to album_haven_worker;
    grant execute on function ops.persist_claimed_automatic_cover_selection(bigint, bigint, bigint, integer, text, text, timestamptz, text[], text, text, text, boolean, text, text) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function ops.accept_cover_bulk_refresh(text, bigint, bigint, text, text, text, text, text, boolean, bigint, timestamptz) to album_haven_app;
    grant execute on function ops.request_cover_bulk_refresh_cancellation(bigint, bigint, timestamptz) to album_haven_app;
    grant execute on function ops.load_authorized_cover_refresh_status(bigint) to album_haven_app;
  end if;
end $$;
