create table if not exists ops.cover_remote_save_checkpoints (
  id bigint generated always as identity primary key,
  task_id bigint not null references ops.cover_lookup_tasks(id) on delete restrict,
  job_id bigint not null references ops.jobs(id) on delete restrict,
  library_id bigint not null references library.libraries(id) on delete restrict,
  local_album_id bigint not null references library.local_albums(id) on delete restrict,
  library_root_id bigint not null references library.library_roots(id) on delete restrict,
  candidate_generation uuid not null,
  candidate_id varchar(256) not null,
  checkpoint varchar(32) not null default 'accepted',
  artifact_key uuid,
  cover_revision varchar(256),
  resource_revision bigint not null,
  row_revision bigint not null default 0,
  reason_code varchar(128),
  accepted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint cover_remote_save_checkpoint_check check (checkpoint in (
    'accepted', 'download_started', 'artifact_written',
    'selection_committed', 'promotion_completed', 'publication_completed',
    'rolled_back', 'ambiguous'
  )),
  constraint cover_remote_save_revision_check check (
    resource_revision >= 0 and row_revision >= 0
  ),
  constraint cover_remote_save_terminal_check check (
    (checkpoint in ('publication_completed', 'rolled_back', 'ambiguous')
      and completed_at is not null)
    or
    (checkpoint not in ('publication_completed', 'rolled_back', 'ambiguous')
      and completed_at is null)
  )
);

create unique index if not exists cover_remote_save_checkpoints_job_idx
  on ops.cover_remote_save_checkpoints (job_id);
create unique index if not exists cover_remote_save_checkpoints_identity_idx
  on ops.cover_remote_save_checkpoints (
    task_id, candidate_generation, candidate_id, resource_revision
  );
create index if not exists cover_remote_save_checkpoints_active_idx
  on ops.cover_remote_save_checkpoints (library_id, checkpoint, updated_at)
  where checkpoint not in ('publication_completed', 'rolled_back', 'ambiguous');

create or replace function ops.accept_cover_remote_save(
  requested_task_key text,
  requested_library_id bigint,
  requested_account_id bigint,
  requested_origin_type text,
  requested_origin_key text,
  requested_deployment_mode text,
  requested_client_surface text,
  requested_candidate_generation uuid,
  requested_candidate_id text,
  requested_resource_revision bigint,
  requested_at timestamptz
)
returns table (task_id bigint, job_id bigint, row_revision bigint, checkpoint_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog, ops, app, library
as $$
declare
  selected_task ops.cover_lookup_tasks%rowtype;
  selected_candidate jsonb;
  resolved_origin_id bigint;
  accepted_job_id bigint;
  accepted_checkpoint_revision bigint;
begin
  select * into selected_task
    from ops.cover_lookup_tasks as task
   where task.library_id = requested_library_id
     and task.task_key = requested_task_key
     and task.local_album_id is not null
     and task.library_root_id is not null
     and task.candidate_generation = requested_candidate_generation
     and task.resource_revision = requested_resource_revision
     and task.initiating_account_id = requested_account_id
     and task.status in ('completed', 'running')
   for update;
  if selected_task.id is null then
    return;
  end if;
  select candidate into selected_candidate
    from jsonb_array_elements(
      case when jsonb_typeof(selected_task.provider_payload -> 'possible_matches') = 'array'
        then selected_task.provider_payload -> 'possible_matches' else '[]'::jsonb end
    ) as candidate
   where candidate ->> 'id' = requested_candidate_id
     and coalesce(candidate ->> 'art_kind', 'cover') = 'cover'
   limit 1;
  if selected_candidate is null then
    return;
  end if;
  if not exists (
    select 1
      from library.local_albums as album
      join library.local_tracks as track
        on track.album_id = album.id and track.library_id = album.library_id
      join library.local_track_files as file on file.track_id = track.id
      join library.library_roots as root
        on root.id = file.library_root_id
       and root.id = selected_task.library_root_id
       and root.library_id = requested_library_id
       and root.is_active is true
     where album.id = selected_task.local_album_id
       and album.library_id = requested_library_id
    having count(*) > 0
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

  insert into ops.jobs (
    kind, subject_kind, subject_ref, parameters, account_id, library_id,
    capability_key, request_origin_id, deployment_mode, client_surface,
    idempotency_key, scheduled_at, max_attempts, recovery_policy,
    resource_revision
  ) values (
    'cover_remote_save', 'cover_lookup_task', requested_task_key,
    jsonb_build_object(
      'task_id', selected_task.id,
      'candidate_generation', requested_candidate_generation::text,
      'candidate_id', requested_candidate_id
    ),
    requested_account_id, requested_library_id, 'library.covers.write',
    resolved_origin_id, requested_deployment_mode, requested_client_surface,
    'cover-remote-save:' || requested_library_id::text || ':' ||
      requested_task_key || ':' || requested_candidate_generation::text || ':' ||
      requested_candidate_id,
    requested_at, 1, 'ambiguous_on_stale_lease', requested_resource_revision
  ) on conflict do nothing returning id into accepted_job_id;
  if accepted_job_id is null then
    select job.id into accepted_job_id
      from ops.jobs as job
     where job.kind = 'cover_remote_save'
       and job.idempotency_key =
         'cover-remote-save:' || requested_library_id::text || ':' ||
         requested_task_key || ':' || requested_candidate_generation::text || ':' ||
         requested_candidate_id;
  end if;
  if accepted_job_id is null then
    return;
  end if;

  insert into ops.cover_remote_save_checkpoints (
    task_id, job_id, library_id, local_album_id, library_root_id,
    candidate_generation, candidate_id, checkpoint, resource_revision,
    accepted_at, updated_at
  ) values (
    selected_task.id, accepted_job_id, requested_library_id,
    selected_task.local_album_id, selected_task.library_root_id,
    requested_candidate_generation, requested_candidate_id, 'accepted',
    requested_resource_revision, requested_at, requested_at
  ) on conflict do nothing
  returning ops.cover_remote_save_checkpoints.row_revision
    into accepted_checkpoint_revision;
  if accepted_checkpoint_revision is null then
    select checkpoint_row.row_revision into accepted_checkpoint_revision
      from ops.cover_remote_save_checkpoints as checkpoint_row
     where checkpoint_row.task_id = selected_task.id
       and checkpoint_row.job_id = accepted_job_id
       and checkpoint_row.candidate_generation = requested_candidate_generation
       and checkpoint_row.candidate_id = requested_candidate_id
       and checkpoint_row.resource_revision = requested_resource_revision;
  end if;
  if accepted_checkpoint_revision is null then
    raise exception 'remote cover checkpoint identity conflicts with accepted job';
  end if;

  update ops.cover_lookup_tasks as task
     set status = 'running',
         completed_at = null,
         job_id = accepted_job_id,
         capability_key = 'library.covers.write',
         request_origin_id = resolved_origin_id,
         deployment_mode = requested_deployment_mode,
         client_surface = requested_client_surface,
         provider_payload = task.provider_payload || jsonb_build_object(
           'selected_candidate_id', requested_candidate_id,
           'status', 'running',
           'progress', 92,
           'progress_label', 'Saving selected cover art...',
           'message', 'Saving selected cover art...',
           'job_contract', jsonb_build_object(
             'job_kind', 'save_remote_selection',
             'recovery_policy', 'ambiguous'
           )
         ),
         metadata = task.metadata || jsonb_build_object(
           'notification_action_taken', false
         ),
         row_revision = task.row_revision + 1
   where task.id = selected_task.id
     and (task.job_id = selected_task.job_id or task.job_id = accepted_job_id)
  returning task.row_revision into selected_task.row_revision;
  if not found then
    raise exception 'remote cover save task changed during acceptance';
  end if;
  return query select selected_task.id, accepted_job_id,
                      selected_task.row_revision, accepted_checkpoint_revision;
end;
$$;

create or replace function ops.load_claimed_cover_remote_save(
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
  checkpoint_id bigint, checkpoint text, checkpoint_revision bigint,
  task_revision bigint, candidate_generation uuid, candidate_id text,
  selected_candidate jsonb, library_root_path text, track_paths text[]
)
language sql
security definer
set search_path = pg_catalog, ops, library
as $$
  select checkpoint_row.id,
         checkpoint_row.checkpoint::text,
         checkpoint_row.row_revision,
         task.row_revision,
         checkpoint_row.candidate_generation,
         checkpoint_row.candidate_id::text,
         candidate.value,
         root.root_path::text,
         array_agg(file.private_path order by file.id)
    from ops.jobs as job
    join ops.cover_remote_save_checkpoints as checkpoint_row
      on checkpoint_row.job_id = job.id
    join ops.cover_lookup_tasks as task
      on task.id = checkpoint_row.task_id
     and task.id = requested_task_id
     and task.task_key = requested_task_key
     and task.library_id = requested_library_id
     and task.job_id = job.id
     and task.status = 'running'
    join library.local_albums as album
      on album.id = checkpoint_row.local_album_id
     and album.library_id = requested_library_id
    join library.libraries as library_record
      on library_record.id = requested_library_id
     and coalesce(
       nullif(library_record.metadata ->> 'inventory_mutation_revision', '')::bigint,
       0
     ) = checkpoint_row.resource_revision
    join library.local_tracks as track
      on track.album_id = album.id and track.library_id = album.library_id
    join library.local_track_files as file on file.track_id = track.id
    join library.library_roots as root
      on root.id = file.library_root_id
     and root.id = checkpoint_row.library_root_id
     and root.library_id = requested_library_id
     and root.is_active is true
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(task.provider_payload -> 'possible_matches') = 'array'
        then task.provider_payload -> 'possible_matches' else '[]'::jsonb end
    ) as candidate(value)
   where job.id = requested_job_id
     and job.kind = 'cover_remote_save'
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > observed_at
     and job.cancel_requested_at is null
     and candidate.value ->> 'id' = checkpoint_row.candidate_id
     and checkpoint_row.checkpoint not in ('publication_completed', 'rolled_back', 'ambiguous')
   group by checkpoint_row.id, task.row_revision, candidate.value, root.root_path;
$$;

create or replace function ops.checkpoint_claimed_cover_remote_save(
  requested_checkpoint_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_row_revision bigint,
  next_checkpoint text,
  next_artifact_key uuid,
  next_cover_revision text,
  next_reason_code text
)
returns bigint
language sql
security definer
set search_path = pg_catalog, ops
as $$
  update ops.cover_remote_save_checkpoints as checkpoint_row
     set checkpoint = next_checkpoint,
         artifact_key = coalesce(next_artifact_key, checkpoint_row.artifact_key),
         cover_revision = coalesce(next_cover_revision, checkpoint_row.cover_revision),
         reason_code = left(nullif(next_reason_code, ''), 128),
         row_revision = checkpoint_row.row_revision + 1,
         updated_at = observed_at,
         completed_at = case
           when next_checkpoint in ('publication_completed', 'rolled_back', 'ambiguous')
             then observed_at else null end
    from ops.jobs as job
   where checkpoint_row.id = requested_checkpoint_id
     and checkpoint_row.job_id = requested_job_id
     and checkpoint_row.row_revision = expected_row_revision
     and next_checkpoint in (
       'accepted', 'download_started', 'artifact_written',
       'selection_committed', 'promotion_completed', 'publication_completed',
       'rolled_back', 'ambiguous'
     )
     and (
       next_checkpoint in ('rolled_back', 'ambiguous')
       or array_position(
         array[
           'accepted', 'download_started', 'artifact_written',
           'selection_committed', 'promotion_completed', 'publication_completed'
         ]::text[], next_checkpoint
       ) > array_position(
         array[
           'accepted', 'download_started', 'artifact_written',
           'selection_committed', 'promotion_completed', 'publication_completed'
         ]::text[], checkpoint_row.checkpoint::text
       )
     )
     and job.id = requested_job_id
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > observed_at
  returning checkpoint_row.row_revision;
$$;

create or replace function ops.publish_claimed_cover_remote_save(
  requested_checkpoint_id bigint,
  requested_task_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_checkpoint_revision bigint,
  expected_task_revision bigint,
  selected_cover_path text,
  linked_remote boolean
)
returns table (checkpoint_revision bigint, task_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
begin
  update ops.cover_lookup_tasks as task
     set status = 'completed',
         completed_at = observed_at,
         selected_cover_private_path = case when linked_remote then null else selected_cover_path end,
         provider_payload = task.provider_payload || jsonb_build_object(
           'result_kind', 'cover-updated',
           'progress', 100,
           'progress_label', 'Completed'
         ),
         metadata = task.metadata || jsonb_build_object(
           'notification_action_taken', true,
           'notification_completed_at', observed_at
         ),
         row_revision = task.row_revision + 1
    from ops.jobs as job
   where task.id = requested_task_id
     and task.job_id = requested_job_id
     and task.row_revision = expected_task_revision
     and task.status = 'running'
     and job.id = requested_job_id
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > observed_at
  returning task.row_revision into task_revision;
  if task_revision is null then return; end if;
  update ops.cover_remote_save_checkpoints as checkpoint_row
     set checkpoint = 'publication_completed', completed_at = observed_at,
         updated_at = observed_at, row_revision = checkpoint_row.row_revision + 1
   where checkpoint_row.id = requested_checkpoint_id
     and checkpoint_row.job_id = requested_job_id
     and checkpoint_row.row_revision = expected_checkpoint_revision
     and checkpoint_row.checkpoint = 'promotion_completed'
  returning checkpoint_row.row_revision into checkpoint_revision;
  if checkpoint_revision is null then
    raise exception 'remote cover publication checkpoint changed';
  end if;
  return next;
end;
$$;

create or replace function ops.persist_claimed_remote_cover_selection(
  requested_checkpoint_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_checkpoint_revision bigint,
  selected_cover_path text,
  selected_cover_revision text,
  linked_remote boolean
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops, library
as $$
declare
  selected_checkpoint ops.cover_remote_save_checkpoints%rowtype;
  selected_candidate jsonb;
  updated_album_count integer;
  updated_file_count integer;
begin
  select checkpoint_row.*
    into selected_checkpoint
    from ops.cover_remote_save_checkpoints as checkpoint_row
    join ops.jobs as job on job.id = checkpoint_row.job_id
   where checkpoint_row.id = requested_checkpoint_id
     and checkpoint_row.job_id = requested_job_id
     and checkpoint_row.row_revision = expected_checkpoint_revision
     and checkpoint_row.checkpoint = 'artifact_written'
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > observed_at
     and job.cancel_requested_at is null
   for update of checkpoint_row;
  if selected_checkpoint.id is null then return null; end if;
  select candidate.value into selected_candidate
    from ops.cover_lookup_tasks as task
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(task.provider_payload -> 'possible_matches') = 'array'
        then task.provider_payload -> 'possible_matches' else '[]'::jsonb end
    ) as candidate(value)
   where task.id = selected_checkpoint.task_id
     and candidate.value ->> 'id' = selected_checkpoint.candidate_id
   limit 1;
  if selected_candidate is null then return null; end if;
  if linked_remote and nullif(selected_candidate ->> 'url', '') is null then
    return null;
  end if;
  if not linked_remote and (
    nullif(selected_cover_path, '') is null
    or nullif(selected_cover_revision, '') is null
  ) then
    return null;
  end if;

  update library.local_albums as album
     set cover_path = case when linked_remote then null else selected_cover_path end,
         metadata = (
           coalesce(album.metadata, '{}'::jsonb)
           - array[
             'remote_cover_url', 'remote_cover_thumbnail_url',
             'remote_cover_source', 'remote_cover_source_label',
             'remote_cover_album_url', 'remote_cover_width',
             'remote_cover_height'
           ]::text[]
         ) || case when linked_remote then jsonb_build_object(
           'cover_path', null,
           'cover_revision', null,
           'cover_selection_origin', 'user',
           'remote_cover_url', selected_candidate ->> 'url',
           'remote_cover_thumbnail_url', coalesce(
             nullif(selected_candidate ->> 'thumbnail_url', ''),
             selected_candidate ->> 'url'
           ),
           'remote_cover_source', selected_candidate ->> 'source',
           'remote_cover_source_label', selected_candidate ->> 'source_label',
           'remote_cover_album_url', selected_candidate ->> 'album_url',
           'remote_cover_width', nullif(selected_candidate ->> 'width', '')::integer,
           'remote_cover_height', nullif(selected_candidate ->> 'height', '')::integer
         ) else jsonb_build_object(
           'cover_path', selected_cover_path,
           'cover_revision', selected_cover_revision,
           'cover_selection_origin', 'user'
         ) end
   where album.id = selected_checkpoint.local_album_id
     and album.library_id = selected_checkpoint.library_id;
  get diagnostics updated_album_count = row_count;

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
           ) || case when linked_remote then jsonb_build_object(
             'cover_path', null,
             'cover_revision', null,
             'remote_cover_url', selected_candidate ->> 'url',
             'remote_cover_thumbnail_url', coalesce(
               nullif(selected_candidate ->> 'thumbnail_url', ''),
               selected_candidate ->> 'url'
             ),
             'remote_cover_source', selected_candidate ->> 'source',
             'remote_cover_source_label', selected_candidate ->> 'source_label',
             'remote_cover_album_url', selected_candidate ->> 'album_url',
             'remote_cover_width', nullif(selected_candidate ->> 'width', '')::integer,
             'remote_cover_height', nullif(selected_candidate ->> 'height', '')::integer
           ) else jsonb_build_object(
             'cover_path', selected_cover_path,
             'cover_revision', selected_cover_revision
           ) end
         ),
       true
     )
    from library.local_tracks as track
   where track.id = file.track_id
     and track.library_id = selected_checkpoint.library_id
     and track.album_id = selected_checkpoint.local_album_id;
  get diagnostics updated_file_count = row_count;
  if updated_album_count <> 1 or updated_file_count < 1 then
    raise exception 'remote cover selection scope changed';
  end if;

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
   where library_record.id = selected_checkpoint.library_id;
  update ops.cover_remote_save_checkpoints as checkpoint_row
     set checkpoint = 'selection_committed',
         cover_revision = case when linked_remote then null else selected_cover_revision end,
         row_revision = checkpoint_row.row_revision + 1,
         updated_at = observed_at
   where checkpoint_row.id = selected_checkpoint.id
  returning checkpoint_row.row_revision into expected_checkpoint_revision;
  return expected_checkpoint_revision;
end;
$$;

revoke all on table ops.cover_remote_save_checkpoints from public;
revoke all on sequence ops.cover_remote_save_checkpoints_id_seq from public;
revoke all on function ops.accept_cover_remote_save(text, bigint, bigint, text, text, text, text, uuid, text, bigint, timestamptz) from public;
revoke all on function ops.load_claimed_cover_remote_save(text, bigint, bigint, bigint, integer, text, text, timestamptz) from public;
revoke all on function ops.checkpoint_claimed_cover_remote_save(bigint, bigint, integer, text, text, timestamptz, bigint, text, uuid, text, text) from public;
revoke all on function ops.publish_claimed_cover_remote_save(bigint, bigint, bigint, integer, text, text, timestamptz, bigint, bigint, text, boolean) from public;
revoke all on function ops.persist_claimed_remote_cover_selection(bigint, bigint, integer, text, text, timestamptz, bigint, text, text, boolean) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function ops.accept_cover_remote_save(text, bigint, bigint, text, text, text, text, uuid, text, bigint, timestamptz) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function ops.load_claimed_cover_remote_save(text, bigint, bigint, bigint, integer, text, text, timestamptz) to album_haven_worker;
    grant execute on function ops.checkpoint_claimed_cover_remote_save(bigint, bigint, integer, text, text, timestamptz, bigint, text, uuid, text, text) to album_haven_worker;
    grant execute on function ops.publish_claimed_cover_remote_save(bigint, bigint, bigint, integer, text, text, timestamptz, bigint, bigint, text, boolean) to album_haven_worker;
    grant execute on function ops.persist_claimed_remote_cover_selection(bigint, bigint, integer, text, text, timestamptz, bigint, text, text, boolean) to album_haven_worker;
  end if;
end $$;
