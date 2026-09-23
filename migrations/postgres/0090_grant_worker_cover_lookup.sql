create or replace function ops.accept_cover_lookup(
  requested_task_key text,
  requested_library_id bigint,
  requested_album_key text,
  requested_account_id bigint,
  requested_origin_type text,
  requested_origin_key text,
  requested_deployment_mode text,
  requested_client_surface text,
  requested_candidate_generation uuid,
  requested_resource_revision bigint,
  requested_at timestamptz,
  requested_task_payload jsonb
)
returns table (task_id bigint, job_id bigint, row_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog, ops, app, library
as $$
declare
  resolved_album_id bigint;
  resolved_root_id bigint;
  resolved_origin_id bigint;
  accepted_task_id bigint;
  accepted_job_id bigint;
  accepted_revision bigint;
begin
  select album.id, min(root.id)
    into resolved_album_id, resolved_root_id
    from library.local_albums as album
    join library.local_tracks as track
      on track.album_id = album.id and track.library_id = album.library_id
    join library.local_track_files as file on file.track_id = track.id
    join library.library_roots as root
      on root.id = file.library_root_id
     and root.library_id = album.library_id
     and root.is_active is true
   where album.library_id = requested_library_id
     and album.album_key = requested_album_key
   group by album.id
  having count(distinct root.id) = 1;
  if resolved_album_id is null or resolved_root_id is null then
    raise exception 'cover lookup album/root scope is missing or ambiguous';
  end if;

  select origin.id into resolved_origin_id
    from app.request_origins as origin
   where origin.origin_type = requested_origin_type
     and origin.origin_key = requested_origin_key
     and origin.client_surface_class = requested_client_surface
     and origin.account_id = requested_account_id
   order by origin.id desc limit 1;
  if resolved_origin_id is null then
    raise exception 'cover lookup request origin is unavailable';
  end if;

  insert into ops.cover_lookup_tasks (
    library_id, task_key, status, requested_at, album_key,
    provider_payload, metadata, local_album_id, library_root_id,
    initiating_account_id, request_origin_id, capability_key,
    deployment_mode, client_surface, candidate_generation,
    resource_revision, row_revision
  ) values (
    requested_library_id, requested_task_key, 'pending', requested_at,
    requested_album_key, requested_task_payload,
    jsonb_build_object(
      'source_family', 'durable_cover_lookup',
      'source', 'durable_cover_lookup',
      'source_key', requested_task_key,
      'source_payload', jsonb_build_object('id', requested_task_key)
    ),
    resolved_album_id, resolved_root_id, requested_account_id,
    resolved_origin_id, 'library.covers.lookup', requested_deployment_mode,
    requested_client_surface, requested_candidate_generation,
    requested_resource_revision, 0
  )
  on conflict (library_id, (metadata->>'source_family'), task_key)
    where library_id is not null and metadata ? 'source_family'
  do update set task_key = ops.cover_lookup_tasks.task_key
    where ops.cover_lookup_tasks.local_album_id = excluded.local_album_id
      and ops.cover_lookup_tasks.library_root_id = excluded.library_root_id
      and ops.cover_lookup_tasks.initiating_account_id = excluded.initiating_account_id
      and ops.cover_lookup_tasks.candidate_generation = excluded.candidate_generation
      and ops.cover_lookup_tasks.resource_revision = excluded.resource_revision
  returning id, ops.cover_lookup_tasks.row_revision
    into accepted_task_id, accepted_revision;
  if accepted_task_id is null then
    raise exception 'cover lookup identity conflicts with current resource scope';
  end if;

  insert into ops.jobs (
    kind, subject_kind, subject_ref, parameters, account_id, library_id,
    capability_key, request_origin_id, deployment_mode, client_surface,
    idempotency_key, priority, scheduled_at, max_attempts,
    recovery_policy, resource_revision
  ) values (
    'cover_lookup', 'cover_lookup_task', requested_task_key,
    jsonb_build_object('task_id', accepted_task_id), requested_account_id,
    requested_library_id, 'library.covers.lookup', resolved_origin_id,
    requested_deployment_mode, requested_client_surface,
    'cover-lookup:' || requested_library_id::text || ':' || requested_task_key,
    0, requested_at, 2, 'retry_safe', requested_resource_revision
  )
  on conflict do nothing
  returning id into accepted_job_id;
  if accepted_job_id is null then
    select job.id into accepted_job_id
      from ops.jobs as job
     where job.kind = 'cover_lookup'
       and job.idempotency_key =
         'cover-lookup:' || requested_library_id::text || ':' || requested_task_key
       and job.subject_kind = 'cover_lookup_task'
       and job.subject_ref = requested_task_key
       and job.library_id = requested_library_id
       and job.account_id = requested_account_id
       and job.resource_revision = requested_resource_revision;
  end if;
  if accepted_job_id is null then
    raise exception 'cover lookup job identity conflicts with accepted task';
  end if;

  update ops.cover_lookup_tasks as task
     set job_id = coalesce(task.job_id, accepted_job_id),
         row_revision = task.row_revision + case when task.job_id is null then 1 else 0 end
   where task.id = accepted_task_id
     and (task.job_id is null or task.job_id = accepted_job_id)
  returning task.row_revision into accepted_revision;
  if not found then
    raise exception 'cover lookup job link conflicts with accepted task';
  end if;
  return query select accepted_task_id, accepted_job_id, accepted_revision;
end;
$$;

create or replace function ops.validate_claimed_cover_lookup(
  requested_task_key text,
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
set search_path = pg_catalog, ops, library
as $$
  select exists (
    select 1
      from ops.jobs as job
      join ops.cover_lookup_tasks as task
        on task.job_id = job.id
       and task.id = requested_task_id
       and task.task_key = requested_task_key
       and task.library_id = requested_library_id
      join library.libraries as library_record
        on library_record.id = task.library_id
      join library.local_albums as album
        on album.id = task.local_album_id
       and album.library_id = task.library_id
       and album.album_key = task.album_key
      join library.library_roots as root
        on root.id = task.library_root_id
       and root.library_id = task.library_id
       and root.is_active is true
     where job.id = requested_job_id
       and job.kind = 'cover_lookup'
       and job.subject_kind = 'cover_lookup_task'
       and job.subject_ref = requested_task_key
       and job.account_id = task.initiating_account_id
       and job.library_id = task.library_id
       and job.capability_key = task.capability_key
       and job.request_origin_id = task.request_origin_id
       and job.deployment_mode = task.deployment_mode
       and job.client_surface = task.client_surface
       and job.resource_revision = task.resource_revision
       and coalesce(
             nullif(library_record.metadata ->> 'inventory_mutation_revision', '')::bigint,
             0
           ) = task.resource_revision
       and job.state = 'running'
       and job.attempt_count = requested_attempt
       and job.lease_owner = requested_worker_id
       and job.lease_token = requested_lease_token
       and job.lease_expires_at > observed_at
       and job.cancel_requested_at is null
       and task.status in ('pending', 'running')
       and task.cancel_requested_at is null
       and exists (
         select 1
           from library.local_tracks as track
           join library.local_track_files as file on file.track_id = track.id
          where track.album_id = album.id
            and track.library_id = task.library_id
            and file.library_root_id = root.id
       )
       and not exists (
         select 1
           from library.local_tracks as track
           join library.local_track_files as file on file.track_id = track.id
          where track.album_id = album.id
            and track.library_id = task.library_id
            and file.library_root_id is distinct from root.id
       )
  );
$$;

create or replace function ops.load_claimed_cover_lookup(
  requested_task_key text,
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz
)
returns table (
  task_key text,
  task_id bigint,
  row_revision bigint,
  status text,
  cancel_requested boolean,
  album_payload jsonb,
  track_paths text[],
  manual_urls text[],
  task_payload jsonb
)
language sql
security definer
set search_path = pg_catalog, ops, library
as $$
  select
    task.task_key,
    task.id,
    task.row_revision,
    task.status,
    task.cancel_requested_at is not null,
    jsonb_build_object(
      'id', album.id,
      'key', album.album_key,
      'album_artist', coalesce(artist.name, ''),
      'name', album.title,
      'album', album.title,
      'year', album.release_year,
      'edition', coalesce(album.metadata ->> 'edition', '')
    ),
    array_agg(file.private_path order by file.private_path),
    coalesce(
      array(
        select jsonb_array_elements_text(
          case
            when jsonb_typeof(task.provider_payload -> 'manual_urls') = 'array'
              then task.provider_payload -> 'manual_urls'
            else '[]'::jsonb
          end
        )
      ),
      array[]::text[]
    ),
    task.provider_payload
      #- '{album_payload}'
      #- '{track_paths}'
      #- '{source_payload,album_payload}'
      #- '{source_payload,track_paths}'
    from ops.cover_lookup_tasks as task
    join library.local_albums as album on album.id = task.local_album_id
    left join library.local_artists as artist on artist.id = album.artist_id
    join library.local_tracks as track
      on track.album_id = album.id and track.library_id = task.library_id
    join library.local_track_files as file
      on file.track_id = track.id and file.library_root_id = task.library_root_id
   where ops.validate_claimed_cover_lookup(
     requested_task_key, requested_task_id, requested_library_id,
     requested_job_id, requested_attempt, requested_worker_id,
     requested_lease_token, observed_at
   )
     and task.id = requested_task_id
     and task.library_id = requested_library_id
   group by task.id, album.id, artist.id;
$$;

create or replace function ops.claimed_cover_lookup_cancel_requested(
  requested_task_key text,
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
        or task.cancel_requested_at is not null
        or job.lease_expires_at <= observed_at
        or job.state <> 'running'
        or job.attempt_count <> requested_attempt
        or job.lease_owner is distinct from requested_worker_id
        or job.lease_token is distinct from requested_lease_token
      from ops.jobs as job
      join ops.cover_lookup_tasks as task on task.job_id = job.id
     where job.id = requested_job_id
       and task.id = requested_task_id
       and task.library_id = requested_library_id
       and task.task_key = requested_task_key
  ), true);
$$;

create or replace function ops.load_claimed_cover_lookup_cancellation(
  requested_task_key text,
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz
)
returns table (cancel_requested boolean, row_revision bigint)
language sql
security definer
set search_path = pg_catalog, ops
as $$
  select
    job.cancel_requested_at is not null or task.cancel_requested_at is not null,
    task.row_revision
    from ops.jobs as job
    join ops.cover_lookup_tasks as task on task.job_id = job.id
   where job.id = requested_job_id
     and task.id = requested_task_id
     and task.library_id = requested_library_id
     and task.task_key = requested_task_key
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > observed_at;
$$;

create or replace function ops.publish_claimed_cover_lookup(
  requested_task_key text,
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_row_revision bigint,
  next_task_payload jsonb
)
returns table (
  row_revision bigint,
  status text,
  cancel_requested boolean,
  task_payload jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, ops, library
as $$
declare
  next_status text;
  sanitized_payload jsonb;
begin
  next_status := coalesce(nullif(next_task_payload ->> 'status', ''), 'running');
  if next_status not in ('pending', 'running', 'completed', 'failed', 'canceled') then
    return;
  end if;
  sanitized_payload := next_task_payload
    #- '{album_payload}'
    #- '{track_paths}'
    #- '{source_payload,album_payload}'
    #- '{source_payload,track_paths}';

  return query
  update ops.cover_lookup_tasks as task
     set provider_payload = sanitized_payload,
         status = next_status,
         completed_at = case
           when next_status in ('completed', 'failed', 'canceled')
             then coalesce(task.completed_at, observed_at)
           else null
         end,
         row_revision = task.row_revision + 1
   where task.id = requested_task_id
     and task.task_key = requested_task_key
     and task.library_id = requested_library_id
     and task.row_revision = expected_row_revision
     and task.status in ('pending', 'running')
     and ops.validate_claimed_cover_lookup(
       requested_task_key, requested_task_id, requested_library_id,
       requested_job_id, requested_attempt, requested_worker_id,
       requested_lease_token, observed_at
     )
  returning task.row_revision, task.status,
            task.cancel_requested_at is not null, task.provider_payload;
end;
$$;

create or replace function ops.request_cover_lookup_cancellation(
  requested_task_key text,
  requested_library_id bigint,
  actor_account_id bigint,
  observed_at timestamptz
)
returns table (task_payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
declare
  selected_task ops.cover_lookup_tasks%rowtype;
  resulting_job_state text;
begin
  select * into selected_task
    from ops.cover_lookup_tasks
   where task_key = requested_task_key
     and library_id = requested_library_id
     and initiating_account_id = actor_account_id
   for update;
  if selected_task.id is null or selected_task.job_id is null then
    return;
  end if;

  perform * from ops.request_job_cancellation(
    selected_task.job_id, actor_account_id, observed_at
  );
  select state into resulting_job_state from ops.jobs where id = selected_task.job_id;

  return query
  update ops.cover_lookup_tasks as task
     set cancel_requested_at = coalesce(task.cancel_requested_at, observed_at),
         cancel_requested_by_account_id = coalesce(
           task.cancel_requested_by_account_id, actor_account_id
         ),
         status = case
           when resulting_job_state = 'canceled' then 'canceled'
           else task.status
         end,
         completed_at = case
           when resulting_job_state = 'canceled'
             then coalesce(task.completed_at, observed_at)
           else task.completed_at
         end,
         provider_payload = task.provider_payload || case
           when resulting_job_state = 'canceled' then jsonb_build_object(
             'cancel_requested', true,
             'status', 'canceled',
             'progress', 100,
             'progress_label', 'Canceled',
             'finished_at', observed_at,
             'message', 'Cover art lookup canceled before it started.'
           )
           else jsonb_build_object(
             'cancel_requested', true,
             'progress_label', 'Canceling...',
             'message', 'Cancel requested. Finishing the current step...'
           )
         end,
         row_revision = task.row_revision + 1
   where task.id = selected_task.id
     and task.status in ('pending', 'running')
  returning task.provider_payload;
end;
$$;

create or replace function ops.finalize_claimed_cover_lookup_canceled(
  requested_task_key text,
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_row_revision bigint
)
returns table (
  row_revision bigint,
  status text,
  cancel_requested boolean,
  task_payload jsonb
)
language sql
security definer
set search_path = pg_catalog, ops
as $$
  update ops.cover_lookup_tasks as task
     set status = 'canceled',
         completed_at = coalesce(task.completed_at, observed_at),
         provider_payload = task.provider_payload || jsonb_build_object(
           'cancel_requested', true,
           'status', 'canceled',
           'progress', 100,
           'progress_label', 'Canceled',
           'finished_at', observed_at,
           'message', 'Cover art lookup canceled.'
         ),
         row_revision = task.row_revision + 1
    from ops.jobs as job
   where task.id = requested_task_id
     and task.task_key = requested_task_key
     and task.library_id = requested_library_id
     and task.job_id = requested_job_id
     and task.row_revision = expected_row_revision
     and task.status in ('pending', 'running')
     and job.id = requested_job_id
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > observed_at
     and (job.cancel_requested_at is not null or task.cancel_requested_at is not null)
  returning task.row_revision, task.status, true, task.provider_payload;
$$;

revoke all on function ops.validate_claimed_cover_lookup(text, bigint, bigint, bigint, integer, text, text, timestamptz) from public;
revoke all on function ops.accept_cover_lookup(text, bigint, text, bigint, text, text, text, text, uuid, bigint, timestamptz, jsonb) from public;
revoke all on function ops.load_claimed_cover_lookup(text, bigint, bigint, bigint, integer, text, text, timestamptz) from public;
revoke all on function ops.claimed_cover_lookup_cancel_requested(text, bigint, bigint, bigint, integer, text, text, timestamptz) from public;
revoke all on function ops.load_claimed_cover_lookup_cancellation(text, bigint, bigint, bigint, integer, text, text, timestamptz) from public;
revoke all on function ops.publish_claimed_cover_lookup(text, bigint, bigint, bigint, integer, text, text, timestamptz, bigint, jsonb) from public;
revoke all on function ops.request_cover_lookup_cancellation(text, bigint, bigint, timestamptz) from public;
revoke all on function ops.finalize_claimed_cover_lookup_canceled(text, bigint, bigint, bigint, integer, text, text, timestamptz, bigint) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function ops.validate_claimed_cover_lookup(text, bigint, bigint, bigint, integer, text, text, timestamptz) to album_haven_worker;
    grant execute on function ops.load_claimed_cover_lookup(text, bigint, bigint, bigint, integer, text, text, timestamptz) to album_haven_worker;
    grant execute on function ops.claimed_cover_lookup_cancel_requested(text, bigint, bigint, bigint, integer, text, text, timestamptz) to album_haven_worker;
    grant execute on function ops.load_claimed_cover_lookup_cancellation(text, bigint, bigint, bigint, integer, text, text, timestamptz) to album_haven_worker;
    grant execute on function ops.publish_claimed_cover_lookup(text, bigint, bigint, bigint, integer, text, text, timestamptz, bigint, jsonb) to album_haven_worker;
    grant execute on function ops.finalize_claimed_cover_lookup_canceled(text, bigint, bigint, bigint, integer, text, text, timestamptz, bigint) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function ops.accept_cover_lookup(text, bigint, text, bigint, text, text, text, text, uuid, bigint, timestamptz, jsonb) to album_haven_app;
    grant execute on function ops.request_cover_lookup_cancellation(text, bigint, bigint, timestamptz) to album_haven_app;
  end if;
end $$;

create or replace function ops.apply_claimed_cover_candidate_snapshot(
  requested_album_id bigint,
  requested_candidate_generation uuid,
  requested_operation text,
  requested_search_kind text,
  requested_search_started_at timestamptz,
  requested_candidates jsonb,
  requested_best_candidate_id text,
  requested_automatic_improvement boolean,
  requested_candidate_id text,
  observed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, library
as $$
declare
  affected integer := 0;
begin
  if requested_operation = 'publish' then
    if requested_search_kind not in ('automatic', 'manual')
       or requested_search_started_at is null
       or jsonb_typeof(requested_candidates) <> 'array'
       or jsonb_array_length(requested_candidates) = 0 then
      return false;
    end if;
    insert into library.local_album_cover_candidate_snapshots (
      album_id, search_generation, search_kind, status, revision,
      candidates, best_candidate_id, automatic_improvement_revision,
      seen_automatic_improvement_revision, started_at, updated_at, finished_at
    ) values (
      requested_album_id, requested_candidate_generation, requested_search_kind,
      'running', 1, requested_candidates, requested_best_candidate_id,
      case when requested_automatic_improvement then 1 else 0 end,
      0, requested_search_started_at, observed_at, null
    )
    on conflict (album_id) do update set
      search_generation = excluded.search_generation,
      search_kind = excluded.search_kind,
      status = 'running',
      revision = case
        when library.local_album_cover_candidate_snapshots.candidates
               is distinct from excluded.candidates
          or library.local_album_cover_candidate_snapshots.best_candidate_id
               is distinct from excluded.best_candidate_id
          then library.local_album_cover_candidate_snapshots.revision + 1
        else library.local_album_cover_candidate_snapshots.revision
      end,
      candidates = excluded.candidates,
      best_candidate_id = excluded.best_candidate_id,
      automatic_improvement_revision =
        library.local_album_cover_candidate_snapshots.automatic_improvement_revision
        + case
            when requested_automatic_improvement
             and (
               library.local_album_cover_candidate_snapshots.candidates
                 is distinct from excluded.candidates
               or library.local_album_cover_candidate_snapshots.best_candidate_id
                 is distinct from excluded.best_candidate_id
             ) then 1
            else 0
          end,
      started_at = case
        when library.local_album_cover_candidate_snapshots.search_generation
             = excluded.search_generation
          then library.local_album_cover_candidate_snapshots.started_at
        else excluded.started_at
      end,
      updated_at = observed_at,
      finished_at = null
    where (
      library.local_album_cover_candidate_snapshots.search_generation
        = excluded.search_generation
      and library.local_album_cover_candidate_snapshots.status = 'running'
    ) or (
      excluded.started_at > library.local_album_cover_candidate_snapshots.started_at
      and (
        library.local_album_cover_candidate_snapshots.status in ('completed', 'failed')
        or (
          library.local_album_cover_candidate_snapshots.status = 'running'
          and excluded.search_kind = 'manual'
          and library.local_album_cover_candidate_snapshots.search_kind = 'automatic'
        )
      )
    );
  elsif requested_operation in ('finish_completed', 'finish_failed') then
    update library.local_album_cover_candidate_snapshots as snapshot
       set status = case
             when requested_operation = 'finish_completed' then 'completed'
             else 'failed'
           end,
           updated_at = observed_at,
           finished_at = observed_at
     where snapshot.album_id = requested_album_id
       and snapshot.search_generation = requested_candidate_generation
       and snapshot.status = 'running';
  elsif requested_operation = 'mark_improvement' then
    update library.local_album_cover_candidate_snapshots as snapshot
       set automatic_improvement_revision = snapshot.automatic_improvement_revision + 1,
           automatic_improvement_candidate_id = requested_candidate_id,
           updated_at = observed_at
     where snapshot.album_id = requested_album_id
       and snapshot.search_generation = requested_candidate_generation
       and snapshot.search_kind = 'automatic'
       and nullif(requested_candidate_id, '') is not null
       and snapshot.automatic_improvement_candidate_id
             is distinct from requested_candidate_id
       and exists (
         select 1 from jsonb_array_elements(snapshot.candidates) as candidate
          where candidate ->> 'id' = requested_candidate_id
       );
  else
    return false;
  end if;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function ops.mutate_claimed_cover_lookup_candidate_snapshot(
  requested_task_key text,
  requested_task_id bigint,
  requested_library_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  requested_album_id bigint,
  requested_candidate_generation uuid,
  requested_operation text,
  requested_search_kind text,
  requested_search_started_at timestamptz,
  requested_candidates jsonb,
  requested_best_candidate_id text,
  requested_automatic_improvement boolean,
  requested_candidate_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
begin
  if not exists (
    select 1
      from ops.cover_lookup_tasks as task
      join ops.jobs as job on job.id = task.job_id
     where task.id = requested_task_id
       and task.task_key = requested_task_key
       and task.library_id = requested_library_id
       and task.local_album_id = requested_album_id
       and task.candidate_generation = requested_candidate_generation
       and task.status = 'running'
       and task.cancel_requested_at is null
       and job.id = requested_job_id
       and job.kind = 'cover_lookup'
       and job.state = 'running'
       and job.attempt_count = requested_attempt
       and job.lease_owner = requested_worker_id
       and job.lease_token = requested_lease_token
       and job.lease_expires_at > observed_at
       and job.cancel_requested_at is null
  ) then
    return false;
  end if;
  return ops.apply_claimed_cover_candidate_snapshot(
    requested_album_id, requested_candidate_generation, requested_operation,
    requested_search_kind, requested_search_started_at, requested_candidates,
    requested_best_candidate_id, requested_automatic_improvement,
    requested_candidate_id, observed_at
  );
end;
$$;

create or replace function ops.persist_cover_candidate_authority(
  requested_task_key text,
  requested_library_id bigint,
  requested_album_key text,
  requested_account_id bigint,
  requested_origin_type text,
  requested_origin_key text,
  requested_deployment_mode text,
  requested_client_surface text,
  requested_candidate_generation uuid,
  requested_resource_revision bigint,
  recorded_at timestamptz,
  requested_task_payload jsonb,
  requested_candidates jsonb,
  requested_best_candidate_id text
)
returns table (task_id bigint, row_revision bigint, candidate_generation uuid)
language plpgsql
security definer
set search_path = pg_catalog, ops, app, library
as $$
declare
  resolved_album_id bigint;
  resolved_root_id bigint;
  resolved_origin_id bigint;
  selected_task ops.cover_lookup_tasks%rowtype;
begin
  if jsonb_typeof(requested_candidates) <> 'array'
     or jsonb_array_length(requested_candidates) = 0
     or requested_task_payload -> 'possible_matches' is distinct from requested_candidates then
    return;
  end if;
  select album.id, min(root.id)
    into resolved_album_id, resolved_root_id
    from library.local_albums as album
    join library.local_tracks as track
      on track.album_id = album.id and track.library_id = album.library_id
    join library.local_track_files as file on file.track_id = track.id
    join library.library_roots as root
      on root.id = file.library_root_id
     and root.library_id = album.library_id
     and root.is_active is true
   where album.library_id = requested_library_id
     and album.album_key = requested_album_key
   group by album.id
  having count(distinct root.id) = 1;
  if resolved_album_id is null or resolved_root_id is null then
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
  if not ops.apply_claimed_cover_candidate_snapshot(
    resolved_album_id, requested_candidate_generation, 'publish', 'manual',
    recorded_at, requested_candidates, requested_best_candidate_id, false,
    null, recorded_at
  ) then
    return;
  end if;
  if not ops.apply_claimed_cover_candidate_snapshot(
    resolved_album_id, requested_candidate_generation, 'finish_completed',
    'manual', null, '[]'::jsonb, null, false, null, recorded_at
  ) then
    return;
  end if;
  insert into ops.cover_lookup_tasks (
    library_id, task_key, status, requested_at, completed_at, album_key,
    provider_payload, metadata, local_album_id, library_root_id,
    initiating_account_id, request_origin_id, capability_key,
    deployment_mode, client_surface, candidate_generation,
    resource_revision, row_revision, job_id
  ) values (
    requested_library_id, requested_task_key, 'completed', recorded_at,
    recorded_at, requested_album_key, requested_task_payload,
    jsonb_build_object(
      'source_family', 'durable_cover_lookup',
      'source', 'durable_cover_candidate_authority',
      'source_key', requested_task_key,
      'source_payload', jsonb_build_object('id', requested_task_key)
    ),
    resolved_album_id, resolved_root_id, requested_account_id,
    resolved_origin_id, 'library.covers.lookup', requested_deployment_mode,
    requested_client_surface, requested_candidate_generation,
    requested_resource_revision, 0, null
  )
  on conflict (library_id, (metadata ->> 'source_family'), task_key)
    where library_id is not null and metadata ? 'source_family'
  do update set
    status = 'completed',
    completed_at = recorded_at,
    provider_payload = excluded.provider_payload,
    request_origin_id = excluded.request_origin_id,
    deployment_mode = excluded.deployment_mode,
    client_surface = excluded.client_surface,
    candidate_generation = excluded.candidate_generation,
    resource_revision = excluded.resource_revision,
    row_revision = ops.cover_lookup_tasks.row_revision + 1,
    job_id = null
  where ops.cover_lookup_tasks.local_album_id = excluded.local_album_id
    and ops.cover_lookup_tasks.library_root_id = excluded.library_root_id
    and ops.cover_lookup_tasks.initiating_account_id = excluded.initiating_account_id
    and ops.cover_lookup_tasks.status not in ('pending', 'running')
  returning * into selected_task;
  if selected_task.id is null then
    return;
  end if;
  return query select selected_task.id, selected_task.row_revision,
                      selected_task.candidate_generation;
end;
$$;

revoke all on function ops.apply_claimed_cover_candidate_snapshot(bigint, uuid, text, text, timestamptz, jsonb, text, boolean, text, timestamptz) from public;
revoke all on function ops.mutate_claimed_cover_lookup_candidate_snapshot(text, bigint, bigint, bigint, integer, text, text, timestamptz, bigint, uuid, text, text, timestamptz, jsonb, text, boolean, text) from public;
revoke all on function ops.persist_cover_candidate_authority(text, bigint, text, bigint, text, text, text, text, uuid, bigint, timestamptz, jsonb, jsonb, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function ops.mutate_claimed_cover_lookup_candidate_snapshot(text, bigint, bigint, bigint, integer, text, text, timestamptz, bigint, uuid, text, text, timestamptz, jsonb, text, boolean, text) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function ops.persist_cover_candidate_authority(text, bigint, text, bigint, text, text, text, text, uuid, bigint, timestamptz, jsonb, jsonb, text) to album_haven_app;
  end if;
end $$;
