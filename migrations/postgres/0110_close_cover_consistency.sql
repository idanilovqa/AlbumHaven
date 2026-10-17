-- Additive cover-consistency authority for mixed-version Phase 8 rollout.

create table if not exists library.cover_mutation_state (
  library_id bigint
    references library.libraries(id) on delete cascade,
  cover_mutation_revision bigint not null default 0
    check (cover_mutation_revision >= 0),
  updated_at timestamptz not null default now(),
  primary key (library_id)
);

insert into library.cover_mutation_state (library_id, cover_mutation_revision)
select id,
       greatest(
         0,
         coalesce(
           nullif(metadata ->> 'cover_mutation_revision', '')::bigint,
           0
         )
       )
from library.libraries
on conflict (library_id) do nothing;

create or replace function library.read_cover_mutation_revision(
  requested_library_id bigint
)
returns bigint
language sql
security definer
set search_path = pg_catalog, library
stable
as $function$
  select coalesce(
    (
      select state.cover_mutation_revision
      from library.cover_mutation_state as state
      where state.library_id = requested_library_id
    ),
    0
  );
$function$;

create or replace function library.commit_cover_selection(
  requested_library_id bigint,
  requested_album_id bigint,
  requested_track_paths text[],
  expected_inventory_revision bigint,
  expected_cover_mutation_revision bigint,
  expected_selected_cover_revision text,
  selected_cover_path text,
  promoted_cover_revision text,
  selected_origin text,
  clear_selection boolean,
  remote_cover jsonb,
  artifact_sha256 text,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  requested_task_id bigint,
  requested_checkpoint_revision bigint,
  observed_at timestamptz
)
returns table (
  committed boolean,
  cover_mutation_revision bigint,
  reason_code text,
  finalization_checkpoint_id bigint,
  finalization_checkpoint_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog, library, ops
as $function$
declare
  current_inventory_revision bigint;
  current_cover_mutation_revision bigint;
  resolved_path_count integer;
  resolved_album_count integer;
  resolved_album_id bigint;
  current_selected_revision text;
  desired_album_metadata jsonb;
  changed_album_count integer;
  changed_file_count integer;
  committed_checkpoint_id bigint;
  committed_checkpoint_revision bigint;
begin
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));

  if observed_at is null then
    raise exception 'cover mutation observation time is required'
      using errcode = '22023';
  end if;

  insert into library.cover_mutation_state (library_id)
  values (requested_library_id)
  on conflict (library_id) do nothing;

  select
    coalesce(
      nullif(library_row.metadata ->> 'inventory_mutation_revision', '')::bigint,
      0
    ),
    state.cover_mutation_revision
  into current_inventory_revision, current_cover_mutation_revision
  from library.libraries as library_row
  join library.cover_mutation_state as state
    on state.library_id = library_row.id
  where library_row.id = requested_library_id
  for update of library_row, state;

  if not found then
    return query select false, null::bigint, 'identity_conflict'::text,
      null::bigint, null::bigint;
    return;
  end if;
  if current_inventory_revision <> expected_inventory_revision then
    return query select false, current_cover_mutation_revision,
      'inventory_revision_conflict'::text, null::bigint, null::bigint;
    return;
  end if;
  if current_cover_mutation_revision <> expected_cover_mutation_revision then
    return query select false, current_cover_mutation_revision,
      'revision_conflict'::text, null::bigint, null::bigint;
    return;
  end if;

  if clear_selection then
    if selected_cover_path is not null
       or promoted_cover_revision is not null
       or selected_origin is not null
       or remote_cover is not null then
      raise exception 'clear selection cannot carry replacement cover state';
    end if;
  elsif promoted_cover_revision is null
     or selected_origin not in ('user', 'automatic') then
    raise exception 'replacement selection requires revision and valid origin';
  elsif remote_cover is null and nullif(btrim(selected_cover_path), '') is null then
    raise exception 'local replacement requires selected cover path';
  elsif remote_cover is not null and selected_cover_path is not null then
    raise exception 'remote replacement cannot carry local cover path';
  end if;

  if remote_cover is not null and (
    jsonb_typeof(remote_cover) <> 'object'
    or remote_cover - array[
      'remote_cover_url', 'remote_cover_thumbnail_url',
      'remote_cover_source', 'remote_cover_source_label',
      'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
    ]::text[] <> '{}'::jsonb
  ) then
    raise exception 'remote cover contains unsupported keys';
  end if;

  if (requested_job_id is null) <> (requested_attempt is null)
     or (requested_job_id is null) <> (requested_worker_id is null)
     or (requested_job_id is null) <> (requested_lease_token is null)
     or (requested_job_id is null) <> (requested_task_id is null)
     or (requested_job_id is null) <> (requested_checkpoint_revision is null) then
    raise exception 'durable cover fence must be all null or all present';
  end if;
  if requested_job_id is not null
     and (artifact_sha256 is null or artifact_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'durable cover fence requires artifact SHA-256';
  end if;

  if requested_job_id is not null then
    perform 1
    from ops.jobs as job
    join ops.cover_remote_save_checkpoints as checkpoint
      on checkpoint.job_id = job.id
     and checkpoint.task_id = requested_task_id
     and checkpoint.row_revision = requested_checkpoint_revision
     and checkpoint.checkpoint = 'artifact_written'
     and checkpoint.artifact_sha256 = artifact_sha256
    join ops.cover_lookup_tasks as task
      on task.id = checkpoint.task_id
     and task.library_id = requested_library_id
     and task.local_album_id = requested_album_id
    where job.id = requested_job_id
      and job.attempt_count = requested_attempt
      and job.lease_owner = requested_worker_id
      and job.lease_token = requested_lease_token
    for update of job, checkpoint, task;
    if not found then
      return query select false, current_cover_mutation_revision,
        'lease_lost'::text, null::bigint, null::bigint;
      return;
    end if;

    if exists (
      select 1
      from ops.jobs as job
      join ops.cover_remote_save_checkpoints as checkpoint
        on checkpoint.job_id = job.id
       and checkpoint.task_id = requested_task_id
       and checkpoint.row_revision = requested_checkpoint_revision
      join ops.cover_lookup_tasks as task on task.id = checkpoint.task_id
      where job.id = requested_job_id
        and (job.cancel_requested_at is not null
          or task.cancel_requested_at is not null)
    ) then
      return query select false, current_cover_mutation_revision,
        'canceled'::text, null::bigint, null::bigint;
      return;
    end if;

    if not exists (
      select 1
      from ops.jobs as job
      join ops.cover_remote_save_checkpoints as checkpoint
        on checkpoint.job_id = job.id
       and checkpoint.task_id = requested_task_id
       and checkpoint.row_revision = requested_checkpoint_revision
       and checkpoint.checkpoint = 'artifact_written'
       and checkpoint.artifact_sha256 = artifact_sha256
      join ops.cover_lookup_tasks as task on task.id = checkpoint.task_id
      where job.id = requested_job_id
        and job.state = 'running'
        and job.attempt_count = requested_attempt
        and job.lease_owner = requested_worker_id
        and job.lease_token = requested_lease_token
        and job.lease_expires_at > clock_timestamp()
        and job.cancel_requested_at is null
        and task.status = 'running'
        and task.cancel_requested_at is null
    ) then
      return query select false, current_cover_mutation_revision,
        'lease_lost'::text, null::bigint, null::bigint;
      return;
    end if;
  end if;

  with input_paths as materialized (
    select distinct nullif(btrim(path_value), '') as private_path
    from unnest(requested_track_paths) as path_value
    where nullif(btrim(path_value), '') is not null
  ), resolved as materialized (
    select file.id as file_id, track.album_id
    from input_paths
    join library.local_track_files as file
      on file.private_path = input_paths.private_path
    join library.local_tracks as track
      on track.id = file.track_id
     and track.library_id = requested_library_id
    join library.library_roots as root
      on root.id = file.library_root_id
     and root.library_id = requested_library_id
     and root.is_active is true
  )
  select count(*), count(distinct album_id), min(album_id)
  into resolved_path_count, resolved_album_count, resolved_album_id
  from resolved;

  if coalesce(cardinality(requested_track_paths), 0) = 0
     or resolved_path_count <> (
       select count(distinct nullif(btrim(path_value), ''))
       from unnest(requested_track_paths) as path_value
       where nullif(btrim(path_value), '') is not null
     )
     or resolved_album_count <> 1
     or resolved_album_id <> requested_album_id then
    return query select false, current_cover_mutation_revision,
      'identity_conflict'::text, null::bigint, null::bigint;
    return;
  end if;

  select nullif(album.metadata ->> 'cover_revision', '')
  into current_selected_revision
  from library.local_albums as album
  where album.id = requested_album_id
    and album.library_id = requested_library_id
  for update;

  if not found
     or current_selected_revision is distinct from expected_selected_cover_revision then
    return query select false, current_cover_mutation_revision,
      'selection_conflict'::text, null::bigint, null::bigint;
    return;
  end if;

  select (
    coalesce(album.metadata, '{}'::jsonb)
    - array[
      'cover_path', 'cover_revision', 'cover_selection_origin',
      'remote_cover_url', 'remote_cover_thumbnail_url',
      'remote_cover_source', 'remote_cover_source_label',
      'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
    ]::text[]
  ) || case
    when clear_selection then '{}'::jsonb
    when remote_cover is not null then jsonb_strip_nulls(
      remote_cover || jsonb_build_object(
        'cover_revision', promoted_cover_revision,
        'cover_selection_origin', selected_origin
      )
    )
    else jsonb_strip_nulls(jsonb_build_object(
      'cover_path', selected_cover_path,
      'cover_revision', promoted_cover_revision,
      'cover_selection_origin', selected_origin
    ))
  end
  into desired_album_metadata
  from library.local_albums as album
  where album.id = requested_album_id;

  update library.local_albums as album
  set cover_path = case
        when clear_selection or remote_cover is not null then null
        else selected_cover_path
      end,
      metadata = desired_album_metadata
  where album.id = requested_album_id
    and (album.cover_path, coalesce(album.metadata, '{}'::jsonb))
        is distinct from (
          case
            when clear_selection or remote_cover is not null then null
            else selected_cover_path
          end,
          desired_album_metadata
        );
  get diagnostics changed_album_count = row_count;

  update library.local_track_files as file
  set metadata = jsonb_set(
    coalesce(file.metadata, '{}'::jsonb),
    '{scan_cache,file_entry}',
    (
      coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
      - array[
        'cover_path', 'cover_revision',
        'remote_cover_url', 'remote_cover_thumbnail_url',
        'remote_cover_source', 'remote_cover_source_label',
        'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
      ]::text[]
    ) || case
      when clear_selection then '{}'::jsonb
      when remote_cover is not null then jsonb_strip_nulls(
        remote_cover || jsonb_build_object(
          'cover_revision', promoted_cover_revision
        )
      )
      else jsonb_strip_nulls(jsonb_build_object(
        'cover_path', selected_cover_path,
        'cover_revision', promoted_cover_revision
      ))
    end,
    true
  )
  from library.local_tracks as track
  where track.id = file.track_id
    and track.library_id = requested_library_id
    and track.album_id = requested_album_id
    and coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
        is distinct from (
          (
            coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
            - array[
              'cover_path', 'cover_revision',
              'remote_cover_url', 'remote_cover_thumbnail_url',
              'remote_cover_source', 'remote_cover_source_label',
              'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
            ]::text[]
          ) || case
            when clear_selection then '{}'::jsonb
            when remote_cover is not null then jsonb_strip_nulls(
              remote_cover || jsonb_build_object(
                'cover_revision', promoted_cover_revision
              )
            )
            else jsonb_strip_nulls(jsonb_build_object(
              'cover_path', selected_cover_path,
              'cover_revision', promoted_cover_revision
            ))
          end
        );
  get diagnostics changed_file_count = row_count;

  if changed_album_count > 0 or changed_file_count > 0 then
    update library.cover_mutation_state as state
    set cover_mutation_revision = state.cover_mutation_revision + 1,
        updated_at = observed_at
    where state.library_id = requested_library_id
    returning state.cover_mutation_revision
    into current_cover_mutation_revision;
  end if;

  if requested_job_id is not null then
    update ops.cover_remote_save_checkpoints as checkpoint
    set checkpoint = 'authority_committed',
        cover_revision = promoted_cover_revision,
        authority_cover_mutation_revision = current_cover_mutation_revision,
        row_revision = checkpoint.row_revision + 1,
        updated_at = observed_at
    where checkpoint.job_id = requested_job_id
      and checkpoint.task_id = requested_task_id
      and checkpoint.row_revision = requested_checkpoint_revision
      and checkpoint.checkpoint = 'artifact_written'
      and checkpoint.artifact_sha256 = artifact_sha256
    returning checkpoint.id, checkpoint.row_revision
    into committed_checkpoint_id, committed_checkpoint_revision;
    if committed_checkpoint_revision is null then
      raise exception 'cover finalization checkpoint changed before commit';
    end if;
  end if;

  return query select true, current_cover_mutation_revision,
    case
      when changed_album_count = 0 and changed_file_count = 0 then 'no_change'
      else 'committed'
    end,
    committed_checkpoint_id,
    committed_checkpoint_revision;
end;
$function$;

create or replace function library.recover_cover_mutation(
  requested_library_id bigint,
  requested_album_id bigint,
  expected_inventory_revision bigint,
  expected_cover_mutation_revision bigint,
  expected_selected_cover_revision text,
  promoted_cover_revision text,
  artifact_sha256 text,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  requested_task_id bigint,
  requested_checkpoint_revision bigint,
  observed_at timestamptz
)
returns table (
  recovery_action text,
  cover_mutation_revision bigint,
  selected_cover_revision text,
  finalization_checkpoint_id bigint,
  finalization_checkpoint_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog, library, ops
as $function$
declare
  current_inventory_revision bigint;
  current_cover_mutation_revision bigint;
  current_selected_cover_revision text;
  current_checkpoint_id bigint;
  current_checkpoint_revision bigint;
  current_checkpoint text;
  checkpoint_cover_revision text;
  checkpoint_authority_revision bigint;
begin
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  if artifact_sha256 is null or artifact_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'recovery requires artifact SHA-256';
  end if;

  select
    coalesce(nullif(library_row.metadata ->> 'inventory_mutation_revision', '')::bigint, 0),
    state.cover_mutation_revision,
    nullif(album.metadata ->> 'cover_revision', '')
  into current_inventory_revision,
       current_cover_mutation_revision,
       current_selected_cover_revision
  from library.libraries as library_row
  join library.cover_mutation_state as state on state.library_id = library_row.id
  join library.local_albums as album
    on album.library_id = library_row.id
   and album.id = requested_album_id
  where library_row.id = requested_library_id
  for update of library_row, state, album;
  if not found then
    return query select 'ambiguous'::text, null::bigint, null::text,
      null::bigint, null::bigint;
    return;
  end if;

  select checkpoint.id,
         checkpoint.row_revision,
         checkpoint.checkpoint,
         checkpoint.cover_revision,
         checkpoint.authority_cover_mutation_revision
  into current_checkpoint_id,
       current_checkpoint_revision,
       current_checkpoint,
       checkpoint_cover_revision,
       checkpoint_authority_revision
  from ops.jobs as job
  join ops.cover_remote_save_checkpoints as checkpoint
    on checkpoint.job_id = job.id
   and checkpoint.task_id = requested_task_id
   and checkpoint.artifact_sha256 = artifact_sha256
  join ops.cover_lookup_tasks as task
    on task.id = checkpoint.task_id
   and task.library_id = requested_library_id
   and task.local_album_id = requested_album_id
  where job.id = requested_job_id
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and checkpoint.row_revision >= requested_checkpoint_revision
  order by checkpoint.row_revision desc
  limit 1
  for update of job, checkpoint, task;

  if found
     and current_checkpoint in (
       'authority_committed', 'runtime_published', 'publication_completed'
     )
     and checkpoint_cover_revision = promoted_cover_revision
     and checkpoint_authority_revision is not null then
    return query select 'committed'::text,
      checkpoint_authority_revision,
      checkpoint_cover_revision,
      current_checkpoint_id,
      current_checkpoint_revision;
    return;
  end if;

  if found
     and current_inventory_revision = expected_inventory_revision
     and current_cover_mutation_revision = expected_cover_mutation_revision
     and current_selected_cover_revision is not distinct from expected_selected_cover_revision
     and current_checkpoint = 'artifact_written' then
    return query select 'compensate'::text,
      current_cover_mutation_revision,
      current_selected_cover_revision,
      current_checkpoint_id,
      current_checkpoint_revision;
    return;
  end if;

  return query select 'ambiguous'::text,
    current_cover_mutation_revision,
    current_selected_cover_revision,
    current_checkpoint_id,
    current_checkpoint_revision;
end;
$function$;

create or replace function library.resolve_cover_mutation_identity(
  requested_library_id bigint,
  requested_track_paths text[]
)
returns table (library_id bigint, local_album_id bigint)
language sql
stable
security definer
set search_path = pg_catalog, library
as $function$
  with input_paths as materialized (
    select distinct nullif(btrim(path_value), '') as private_path
    from unnest(requested_track_paths) as path_value
    where nullif(btrim(path_value), '') is not null
  ), resolved as materialized (
    select file.id as file_id, track.album_id
    from input_paths
    join library.local_track_files as file
      on file.private_path = input_paths.private_path
    join library.local_tracks as track
      on track.id = file.track_id
     and track.library_id = requested_library_id
    join library.library_roots as root
      on root.id = file.library_root_id
     and root.library_id = requested_library_id
     and root.is_active is true
    join library.local_albums as album
      on album.id = track.album_id
     and album.library_id = requested_library_id
  ), summary as (
    select
      (select count(*) from input_paths) as input_count,
      count(*) as resolved_count,
      count(distinct resolved.album_id) as album_count,
      min(resolved.album_id) as album_id
    from resolved
  )
  select requested_library_id, summary.album_id
  from summary
  where summary.input_count > 0
    and summary.resolved_count = summary.input_count
    and summary.album_count = 1;
$function$;

alter table library.full_scan_intents
  add column if not exists captured_cover_mutation_revision bigint
  check (
    captured_cover_mutation_revision is null
    or captured_cover_mutation_revision >= 0
  );

alter table library.targeted_reconciliation_intents
  add column if not exists captured_cover_mutation_revision bigint
  check (
    captured_cover_mutation_revision is null
    or captured_cover_mutation_revision >= 0
  );

update library.full_scan_intents as intent
set captured_cover_mutation_revision = state.cover_mutation_revision
from library.cover_mutation_state as state
where state.library_id = intent.library_id
  and intent.state in ('accepted', 'running', 'retry_wait')
  and intent.captured_cover_mutation_revision is null;

update library.targeted_reconciliation_intents as intent
set captured_cover_mutation_revision = state.cover_mutation_revision
from library.cover_mutation_state as state
where state.library_id = intent.library_id
  and intent.state in ('accepted', 'running', 'retry_wait')
  and intent.captured_cover_mutation_revision is null;

-- Mixed-version writers cannot know the new column. Populate it at the table
-- boundary in the inserting transaction, so every direct and nested creator is
-- covered without widening its public signature during the drain window.
create or replace function library.capture_scan_intent_cover_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, library
as $function$
begin
  if new.captured_cover_mutation_revision is null then
    insert into library.cover_mutation_state (library_id)
    values (new.library_id)
    on conflict (library_id) do nothing;

    select state.cover_mutation_revision
    into new.captured_cover_mutation_revision
    from library.cover_mutation_state as state
    where state.library_id = new.library_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists full_scan_intents_capture_cover_revision
  on library.full_scan_intents;
create trigger full_scan_intents_capture_cover_revision
before insert on library.full_scan_intents
for each row execute function library.capture_scan_intent_cover_revision();

drop trigger if exists targeted_reconciliation_intents_capture_cover_revision
  on library.targeted_reconciliation_intents;
create trigger targeted_reconciliation_intents_capture_cover_revision
before insert on library.targeted_reconciliation_intents
for each row execute function library.capture_scan_intent_cover_revision();

-- Recreate every effective creator from its current live definition. The
-- trigger remains the mixed-version insertion boundary; the local snapshot
-- declaration makes that dependency explicit in each current creator.
create or replace function library.create_full_scan_intent(
  p_library_id bigint,
  p_initiating_account_id bigint,
  p_capability_key varchar,
  p_request_origin_ref varchar,
  p_deployment_mode varchar,
  p_client_surface varchar,
  p_mode varchar,
  p_force boolean,
  p_root_ids bigint[],
  p_accepted_at timestamptz
)
returns table (intent_id bigint, job_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_captured_cover_mutation_revision bigint;
  created_intent_id bigint;
  active_intent_id bigint;
  active_job_id bigint;
  accepted_request_origin_id bigint;
begin
  if p_library_id is null or p_initiating_account_id is null or
     p_capability_key <> 'library.refresh' or
     p_request_origin_ref is null or strpos(p_request_origin_ref, ':') < 2 or
     p_deployment_mode is null or p_client_surface is null or
     p_mode is null or p_force is null or p_accepted_at is null or
     coalesce(array_length(p_root_ids, 1), 0) < 1 or
     coalesce(array_length(p_root_ids, 1), 0) > 256 then
    raise exception 'full scan intent is invalid';
  end if;
  accepted_request_origin_id := app.ensure_job_request_origin(
    p_initiating_account_id, p_client_surface,
    split_part(p_request_origin_ref, ':', 1),
    substring(p_request_origin_ref from strpos(p_request_origin_ref, ':') + 1),
    p_accepted_at
  );
  if accepted_request_origin_id is null then
    raise exception 'full scan request origin is invalid';
  end if;
  if exists (
    select 1
      from unnest(p_root_ids) as requested(root_id)
      left join library.library_roots as root_record
        on root_record.id = requested.root_id
       and root_record.library_id = p_library_id
       and root_record.is_active is true
     where root_record.id is null
  ) then
    raise exception 'full scan root scope is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:full-scan:' || p_library_id::text, 0)
  );
  select intent.id, job.id
    into active_intent_id, active_job_id
    from library.full_scan_intents as intent
    join ops.jobs as job on job.id = intent.job_id
   where intent.library_id = p_library_id
     and job.kind = 'full_scan'
     and job.state in ('queued', 'running', 'retry_wait')
   order by job.id
   limit 1;
  if active_job_id is not null then
    return query select active_intent_id, active_job_id;
    return;
  end if;

  insert into library.full_scan_intents (
    library_id, initiating_account_id, capability_key, request_origin_id,
    deployment_mode, client_surface, mode, force, accepted_at
  ) values (
    p_library_id, p_initiating_account_id, p_capability_key,
    accepted_request_origin_id, p_deployment_mode, p_client_surface,
    p_mode, p_force, p_accepted_at
  ) returning id into created_intent_id;

  insert into library.full_scan_intent_roots (intent_id, root_id, ordinal)
  select created_intent_id, requested.root_id, requested.ordinality - 1
    from unnest(p_root_ids) with ordinality as requested(root_id, ordinality);

  return query select created_intent_id, null::bigint;
end;
$$;

create or replace function library.create_targeted_reconciliation_intent(
  p_library_id bigint,
  p_primary_root_id bigint,
  p_producer_request_key varchar,
  p_request_digest varchar,
  p_deployment_mode varchar,
  p_client_surface varchar,
  p_active_paths text[],
  p_deleted_paths text[],
  p_deleted_subtrees text[],
  p_preserved_subtrees text[],
  p_moves jsonb,
  p_accepted_at timestamptz
)
returns table (intent_id bigint, job_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_captured_cover_mutation_revision bigint;
  created_intent_id bigint;
  existing_intent_id bigint;
  existing_job_id bigint;
  existing_digest varchar(64);
begin
  if p_library_id is null or p_primary_root_id is null or p_accepted_at is null or
     p_producer_request_key is null or
     p_producer_request_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$' or
     p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$' or
     p_deployment_mode is null or p_client_surface is null or
     jsonb_typeof(coalesce(p_moves, '[]'::jsonb)) <> 'array' or
     coalesce(array_length(p_active_paths, 1), 0) > 4096 or
     coalesce(array_length(p_deleted_paths, 1), 0) > 4096 or
     coalesce(array_length(p_deleted_subtrees, 1), 0) > 4096 or
     coalesce(array_length(p_preserved_subtrees, 1), 0) > 4096 or
     jsonb_array_length(coalesce(p_moves, '[]'::jsonb)) > 4096 then
    raise exception 'targeted reconciliation intent is invalid';
  end if;
  if not exists (
    select 1 from library.library_roots
     where id = p_primary_root_id and library_id = p_library_id and is_active is true
  ) then
    raise exception 'targeted reconciliation root scope is invalid';
  end if;
  if exists (
    select 1
      from unnest(
        coalesce(p_preserved_subtrees, array[]::text[])
      ) as preserved(path)
     where preserved.path is null
        or not exists (
          select 1
            from library.library_roots as primary_root
           where primary_root.id = p_primary_root_id
             and primary_root.library_id = p_library_id
             and primary_root.is_active is true
             and (
               library.local_path_key(preserved.path)
                 = library.local_path_key(primary_root.root_path)
               or left(
                    library.local_path_key(preserved.path),
                    char_length(library.local_path_key(primary_root.root_path)) + 1
                  ) = library.local_path_key(primary_root.root_path)
                      || case library.local_path_style(primary_root.root_path)
                           when 'windows' then E'\\' else '/' end
             )
        )
  ) then
    raise exception 'targeted reconciliation preserved subtree scope is invalid';
  end if;

  if p_client_surface = 'library_watcher' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:targeted-reconciliation-payload:'
          || p_library_id::text || ':' || p_request_digest,
        0
      )
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:targeted-reconciliation:' || p_library_id::text || ':' || p_producer_request_key,
      0
    )
  );
  select intent.id, intent.job_id, intent.request_digest
    into existing_intent_id, existing_job_id, existing_digest
    from library.targeted_reconciliation_intents as intent
   where intent.library_id = p_library_id
     and intent.producer_request_key = p_producer_request_key;
  if existing_intent_id is not null then
    if existing_digest <> p_request_digest then
      raise exception 'targeted reconciliation request key payload mismatch';
    end if;
    return query select existing_intent_id, existing_job_id;
    return;
  end if;

  if p_client_surface = 'library_watcher' then
    select intent.id, intent.job_id
      into existing_intent_id, existing_job_id
      from library.targeted_reconciliation_intents as intent
      join ops.jobs as job on job.id = intent.job_id
     where intent.library_id = p_library_id
       and intent.request_digest = p_request_digest
       and intent.client_surface = 'library_watcher'
       and job.state in ('queued', 'retry_wait')
     order by intent.id
     limit 1;
    if existing_intent_id is not null then
      return query select existing_intent_id, existing_job_id;
      return;
    end if;
  end if;

  insert into library.targeted_reconciliation_intents (
    library_id, primary_root_id, producer_request_key, request_digest,
    deployment_mode, client_surface, accepted_at
  ) values (
    p_library_id, p_primary_root_id, p_producer_request_key, p_request_digest,
    p_deployment_mode, p_client_surface, p_accepted_at
  ) on conflict (library_id, producer_request_key) do nothing
  returning id into created_intent_id;

  if created_intent_id is null then
    select intent.id, intent.job_id, intent.request_digest
      into existing_intent_id, existing_job_id, existing_digest
      from library.targeted_reconciliation_intents as intent
     where intent.library_id = p_library_id
       and intent.producer_request_key = p_producer_request_key;
    if existing_digest <> p_request_digest then
      raise exception 'targeted reconciliation request key payload mismatch';
    end if;
    return query select existing_intent_id, existing_job_id;
    return;
  end if;

  insert into library.targeted_reconciliation_intent_paths (
    intent_id, path_kind, path, ordinal
  )
  select created_intent_id, source.path_kind, source.path, source.ordinality - 1
    from (
      select 'active'::varchar as path_kind, path, ordinality
        from unnest(coalesce(p_active_paths, array[]::text[])) with ordinality as item(path, ordinality)
      union all
      select 'deleted'::varchar, path, ordinality
        from unnest(coalesce(p_deleted_paths, array[]::text[])) with ordinality as item(path, ordinality)
      union all
      select 'deleted_subtree'::varchar, path, ordinality
        from unnest(coalesce(p_deleted_subtrees, array[]::text[])) with ordinality as item(path, ordinality)
      union all
      select 'preserved_subtree'::varchar, path, ordinality
        from unnest(coalesce(p_preserved_subtrees, array[]::text[])) with ordinality as item(path, ordinality)
    ) as source;

  insert into library.targeted_reconciliation_intent_moves (
    intent_id, source_path, destination_path, source_root_id,
    destination_root_id, is_directory, ordinal
  )
  select created_intent_id,
         item.value ->> 'source_path',
         item.value ->> 'destination_path',
         (item.value ->> 'source_root_id')::bigint,
         (item.value ->> 'destination_root_id')::bigint,
         coalesce((item.value ->> 'is_directory')::boolean, false),
         coalesce((item.value ->> 'ordinal')::integer, item.ordinality - 1)
    from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb))
         with ordinality as item(value, ordinality)
    join library.library_roots as source_root
      on source_root.id = (item.value ->> 'source_root_id')::bigint
     and source_root.library_id = p_library_id
     and source_root.is_active is true
    join library.library_roots as destination_root
      on destination_root.id = (item.value ->> 'destination_root_id')::bigint
     and destination_root.library_id = p_library_id
     and destination_root.is_active is true;

  if (select count(*) from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb))) <>
     (select count(*)
        from library.targeted_reconciliation_intent_moves as stored_move
       where stored_move.intent_id = created_intent_id) then
    raise exception 'targeted reconciliation move scope is invalid';
  end if;

  return query select created_intent_id, null::bigint;
end;
$$;

create or replace function library.mark_watcher_roots_dirty(
  p_library_id bigint,
  p_logical_root_ids text[],
  p_reason_code varchar,
  p_observed_at timestamptz
)
returns table (
  logical_root_id text,
  generation_id bigint,
  accepted_sequence_lower bigint,
  accepted_sequence_upper bigint,
  dirty_generation bigint,
  incident_id uuid,
  warning_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_captured_cover_mutation_revision bigint;
  v_root record;
  v_generation_id bigint;
  v_sequence bigint;
  v_dirty_generation bigint;
  v_incident_id uuid;
  v_warning_token uuid;
  v_digest varchar(64);
begin
  if p_library_id is null or p_observed_at is null
     or p_reason_code not in ('overflow', 'root_unavailable')
     or coalesce(pg_catalog.array_length(p_logical_root_ids, 1), 0)
          not between 1 and 256 then
    raise exception 'watcher dirty request is invalid' using errcode = '22023';
  end if;
  if not coalesce((
    select state.acceptance_enabled
    from library.watcher_runtime_state as state
    where state.singleton is true
  ), false) then
    raise exception 'watcher acceptance is disabled' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );
  for v_root in
    select root.id, root.metadata ->> 'root_id' as logical_id
    from library.library_roots as root
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = any(p_logical_root_ids)
    order by root.id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:watcher-root:' || p_library_id::text || ':' || v_root.id::text,
        0
      )
    );
    insert into library.watcher_lanes (library_id, root_id)
    values (p_library_id, v_root.id)
    on conflict (library_id, root_id) do nothing;
  end loop;

  if (
    select pg_catalog.count(distinct root.metadata ->> 'root_id')
    from library.library_roots as root
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = any(p_logical_root_ids)
  ) <> (
    select pg_catalog.count(distinct requested.logical_id)
    from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
  ) then
    raise exception 'watcher dirty root scope is invalid' using errcode = '22023';
  end if;

  perform 1
  from library.watcher_repairs as repair
  where repair.library_id = p_library_id
    and repair.state in ('scanning', 'catch_up')
  order by repair.id
  for update;

  for v_root in
    select root.id, root.metadata ->> 'root_id' as logical_id
    from library.library_roots as root
    join library.watcher_lanes as lane
      on lane.library_id = root.library_id and lane.root_id = root.id
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = any(p_logical_root_ids)
    order by lane.library_id, lane.root_id
    for update of lane
  loop
    update library.watcher_lanes as lane
    set accepted_sequence = lane.accepted_sequence + 1,
        dirty_generation = lane.dirty_generation + 1,
        catch_up_count = lane.catch_up_count + 1,
        disposition_code = 'dirty',
        next_eligible_at = p_observed_at,
        updated_at = p_observed_at
    where lane.library_id = p_library_id and lane.root_id = v_root.id
    returning lane.accepted_sequence, lane.dirty_generation,
              lane.successor_generation_id
      into v_sequence, v_dirty_generation, v_generation_id;

    if v_generation_id is null then
      v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        'watcher-dirty:' || p_library_id::text || ':' || v_root.id::text || ':'
          || v_sequence::text || ':' || v_dirty_generation::text,
        'UTF8'
      )), 'hex');
      insert into library.targeted_reconciliation_intents (
        library_id, primary_root_id, producer_request_key, request_digest,
        deployment_mode, client_surface, state, accepted_at, updated_at,
        watcher_generation_kind, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation
      ) values (
        p_library_id, v_root.id,
        'watcher-dirty:' || v_root.id::text || ':' || v_sequence::text,
        v_digest, 'self_hosted_private_web', 'library_watcher', 'accepted',
        p_observed_at, p_observed_at, 'root_catch_up', v_sequence, v_sequence,
        v_dirty_generation
      ) returning id into v_generation_id;
      update library.watcher_lanes as lane
      set successor_generation_id = v_generation_id
      where lane.library_id = p_library_id and lane.root_id = v_root.id;
    else
      update library.targeted_reconciliation_intents as intent
      set watcher_generation_kind = 'root_catch_up',
          accepted_sequence_upper = v_sequence,
          dirty_generation = v_dirty_generation,
          request_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'watcher-dirty:' || p_library_id::text || ':' || v_root.id::text || ':'
              || v_sequence::text || ':' || v_dirty_generation::text,
            'UTF8'
          )), 'hex'),
          updated_at = p_observed_at
      where intent.id = v_generation_id
        and intent.watcher_job_linked_at is null;
      delete from library.targeted_reconciliation_intent_paths
      where intent_id = v_generation_id;
      delete from library.targeted_reconciliation_intent_moves
      where intent_id = v_generation_id;
    end if;

    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    ) values (
      v_generation_id, p_library_id, v_root.id, v_sequence, v_sequence,
      v_dirty_generation, p_observed_at, p_observed_at
    ) on conflict on constraint watcher_generation_participants_pkey do update
      set accepted_sequence_upper = excluded.accepted_sequence_upper,
          dirty_generation = excluded.dirty_generation,
          updated_at = excluded.updated_at;

    insert into library.watcher_incidents (
      library_id, root_id, incident_family, reason_code, occurrence_count,
      accepted_sequence, dirty_generation, first_seen_at, last_seen_at
    ) values (
      p_library_id, v_root.id, 'watcher_recovery', p_reason_code, 1,
      v_sequence, v_dirty_generation, p_observed_at, p_observed_at
  ) on conflict (library_id, root_id, incident_family)
    where resolved_at is null
  do update set
    reason_code = excluded.reason_code,
    occurrence_count = library.watcher_incidents.occurrence_count + 1,
    accepted_sequence = greatest(
      library.watcher_incidents.accepted_sequence,
      excluded.accepted_sequence
    ),
    dirty_generation = greatest(
      library.watcher_incidents.dirty_generation,
      excluded.dirty_generation
    ),
    last_seen_at = excluded.last_seen_at
    returning library.watcher_incidents.incident_id,
              library.watcher_incidents.warning_token
      into v_incident_id, v_warning_token;

    logical_root_id := v_root.logical_id;
    generation_id := v_generation_id;
    accepted_sequence_lower := v_sequence;
    accepted_sequence_upper := v_sequence;
    dirty_generation := v_dirty_generation;
    incident_id := v_incident_id;
    warning_token := v_warning_token;
    return next;
  end loop;
end;
$$;

create or replace function library.accept_watcher_event(
  p_library_id bigint,
  p_primary_root_id bigint,
  p_event jsonb,
  p_accepted_at timestamptz
)
returns table (
  logical_root_id text,
  generation_id bigint,
  accepted_sequence_lower bigint,
  accepted_sequence_upper bigint,
  dirty_generation bigint,
  coalesced boolean,
  needs_dispatch boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_captured_cover_mutation_revision bigint;
  v_kind text := p_event ->> 'kind';
  v_source_logical_id text := p_event ->> 'source_root_id';
  v_destination_logical_id text := p_event ->> 'destination_root_id';
  v_source_relative text := p_event ->> 'source_path';
  v_destination_relative text := p_event ->> 'destination_path';
  v_is_directory boolean := coalesce((p_event ->> 'is_directory')::boolean, false);
  v_destination_root_id bigint;
  v_participant_root_ids bigint[];
  v_closure_root_ids bigint[];
  v_existing_generation_ids bigint[];
  v_generation_id bigint;
  v_loser_id bigint;
  v_root record;
  v_sequence bigint;
  v_dirty_generation bigint;
  v_was_coalesced boolean;
  v_path_kind varchar(32);
  v_ordinal integer;
  v_barrier_id bigint;
  v_digest varchar(64);
  v_scope_count bigint;
  v_scope_bytes bigint;
  v_generation_is_catch_up boolean := false;
begin
  if not coalesce((
    select state.acceptance_enabled
    from library.watcher_runtime_state as state
    where state.singleton is true
  ), false) then
    raise exception 'watcher acceptance is disabled' using errcode = '55000';
  end if;
  if p_library_id is null or p_primary_root_id is null or p_accepted_at is null
     or v_kind not in ('created', 'modified', 'deleted', 'moved')
     or nullif(btrim(v_source_logical_id), '') is null
     or nullif(btrim(v_source_relative), '') is null
     or pg_catalog.octet_length(p_event::text) > 262144 then
    raise exception 'watcher event is invalid' using errcode = '22023';
  end if;
  v_source_relative := library.canonical_watcher_relative_path(
    v_source_relative
  );

  perform 1
  from library.library_roots as root
  where root.id = p_primary_root_id
    and root.library_id = p_library_id
    and root.is_active is true
    and root.metadata ->> 'root_id' = v_source_logical_id;
  if not found then
    raise exception 'watcher source root is invalid' using errcode = '22023';
  end if;

  if v_kind = 'moved' then
    if nullif(btrim(v_destination_logical_id), '') is null
       or nullif(btrim(v_destination_relative), '') is null
       then
      raise exception 'watcher move destination is invalid' using errcode = '22023';
    end if;
    v_destination_relative := library.canonical_watcher_relative_path(
      v_destination_relative
    );
    select root.id into v_destination_root_id
    from library.library_roots as root
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = v_destination_logical_id;
    if v_destination_root_id is null then
      raise exception 'watcher destination root is invalid' using errcode = '22023';
    end if;
  end if;

  v_participant_root_ids := case
    when v_destination_root_id is null or v_destination_root_id = p_primary_root_id
      then array[p_primary_root_id]
    else array[
        least(p_primary_root_id, v_destination_root_id),
        greatest(p_primary_root_id, v_destination_root_id)
    ]
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );
  insert into library.watcher_lanes (library_id, root_id)
  select p_library_id, requested.root_id
  from pg_catalog.unnest(v_participant_root_ids) requested(root_id)
  on conflict (library_id, root_id) do nothing;

  perform 1
  from library.watcher_repairs as repair
  where repair.library_id = p_library_id
    and repair.state in ('scanning', 'catch_up')
  order by repair.id
  for update;

  with recursive successor_closure(root_id, generation_id) as (
    select lane.root_id, lane.successor_generation_id
    from library.watcher_lanes as lane
    where lane.library_id = p_library_id
      and lane.root_id = any(v_participant_root_ids)
    union
    select participant.root_id, participant_lane.successor_generation_id
    from successor_closure as current
    join library.watcher_generation_participants as participant
      on participant.generation_id = current.generation_id
    join library.watcher_lanes as participant_lane
      on participant_lane.library_id = p_library_id
     and participant_lane.root_id = participant.root_id
    where current.generation_id is not null
  ), locked_lanes as materialized (
    select lane.root_id, lane.successor_generation_id
    from library.watcher_lanes as lane
    where lane.library_id = p_library_id
      and lane.root_id in (select closure.root_id from successor_closure as closure)
    order by lane.library_id, lane.root_id
    for update of lane
  )
  select pg_catalog.array_agg(locked.root_id order by locked.root_id),
         pg_catalog.array_agg(distinct locked.successor_generation_id
                              order by locked.successor_generation_id)
           filter (where locked.successor_generation_id is not null)
  into v_closure_root_ids, v_existing_generation_ids
  from locked_lanes as locked;
  v_was_coalesced := coalesce(pg_catalog.array_length(v_existing_generation_ids, 1), 0) > 0;

  if not v_was_coalesced then
    v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      p_event::text || ':' || p_accepted_at::text, 'UTF8'
    )), 'hex');
    insert into library.targeted_reconciliation_intents (
      library_id, primary_root_id, producer_request_key, request_digest,
      deployment_mode, client_surface, state, accepted_at, updated_at,
      watcher_generation_kind, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation
    ) values (
      p_library_id, p_primary_root_id,
      'watcher-event:' || v_digest, v_digest,
      'self_hosted_private_web', 'library_watcher', 'accepted',
      p_accepted_at, p_accepted_at, 'exact', 1, 1, 0
    ) returning id into v_generation_id;
  else
    v_generation_id := v_existing_generation_ids[1];
  end if;

  if coalesce(pg_catalog.array_length(v_existing_generation_ids, 1), 0) > 1 then
    foreach v_loser_id in array v_existing_generation_ids[2:]
    loop
      select coalesce(pg_catalog.max(scope.ordinal), -1) + 1 into v_ordinal
      from library.targeted_reconciliation_intent_paths as scope
      where scope.intent_id = v_generation_id;
      insert into library.targeted_reconciliation_intent_paths (
        intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
      )
      select v_generation_id, scope.path_kind, scope.path,
             v_ordinal + pg_catalog.row_number() over (order by scope.path_kind, scope.ordinal) - 1,
             scope.library_id, scope.root_id, scope.relative_path
      from library.targeted_reconciliation_intent_paths as scope
      where scope.intent_id = v_loser_id
      on conflict do nothing;

      select coalesce(pg_catalog.max(move.ordinal), -1) + 1 into v_ordinal
      from library.targeted_reconciliation_intent_moves as move
      where move.intent_id = v_generation_id;
      insert into library.targeted_reconciliation_intent_moves (
        intent_id, source_path, destination_path, source_root_id,
        destination_root_id, is_directory, ordinal,
        accepted_source_root_path, accepted_destination_root_path,
        library_id, source_relative_path, destination_relative_path
      )
      select v_generation_id, move.source_path, move.destination_path,
             move.source_root_id, move.destination_root_id, move.is_directory,
             v_ordinal + pg_catalog.row_number() over (order by move.ordinal) - 1,
             move.accepted_source_root_path, move.accepted_destination_root_path,
             move.library_id, move.source_relative_path, move.destination_relative_path
      from library.targeted_reconciliation_intent_moves as move
      where move.intent_id = v_loser_id
      on conflict do nothing;

      insert into library.watcher_generation_participants (
        generation_id, library_id, root_id, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation, created_at, updated_at
      )
      select v_generation_id, participant.library_id, participant.root_id,
             participant.accepted_sequence_lower, participant.accepted_sequence_upper,
             participant.dirty_generation, participant.created_at, p_accepted_at
      from library.watcher_generation_participants as participant
      where participant.generation_id = v_loser_id
      on conflict on constraint watcher_generation_participants_pkey do update set
        accepted_sequence_lower = least(
          library.watcher_generation_participants.accepted_sequence_lower,
          excluded.accepted_sequence_lower
        ),
        accepted_sequence_upper = greatest(
          library.watcher_generation_participants.accepted_sequence_upper,
          excluded.accepted_sequence_upper
        ),
        dirty_generation = greatest(
          library.watcher_generation_participants.dirty_generation,
          excluded.dirty_generation
        ),
        updated_at = excluded.updated_at;
      update library.watcher_barrier_participants as barrier
      set generation_id = v_generation_id
      where barrier.generation_id = v_loser_id;
      insert into library.watcher_generation_repairs (
        generation_id, repair_id, library_id, created_at
      )
      select v_generation_id, link.repair_id, link.library_id, link.created_at
      from library.watcher_generation_repairs as link
      where link.generation_id = v_loser_id
      on conflict on constraint watcher_generation_repairs_pkey do nothing;
      delete from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = v_loser_id;
      if exists (
        select 1 from library.targeted_reconciliation_intents as loser
        where loser.id = v_loser_id
          and loser.watcher_generation_kind = 'root_catch_up'
      ) then
        v_generation_is_catch_up := true;
      end if;
      update library.watcher_lanes as lane
      set successor_generation_id = v_generation_id, updated_at = p_accepted_at
      where lane.library_id = p_library_id
        and lane.successor_generation_id = v_loser_id;
      delete from library.targeted_reconciliation_intents
      where id = v_loser_id and watcher_job_linked_at is null;
    end loop;
  end if;

  if v_generation_is_catch_up then
    update library.targeted_reconciliation_intents
    set watcher_generation_kind = 'root_catch_up', updated_at = p_accepted_at
    where id = v_generation_id;
  end if;
  select intent.watcher_generation_kind = 'root_catch_up'
  into v_generation_is_catch_up
  from library.targeted_reconciliation_intents as intent
  where intent.id = v_generation_id;

  for v_root in
    update library.watcher_lanes as lane
    set accepted_sequence = lane.accepted_sequence + 1,
        coalesced_event_count = lane.coalesced_event_count +
          case when v_was_coalesced then 1 else 0 end,
        successor_generation_id = v_generation_id,
        next_eligible_at = p_accepted_at,
        disposition_code = 'pending',
        updated_at = p_accepted_at
    where lane.library_id = p_library_id
      and lane.root_id = any(v_participant_root_ids)
    returning lane.root_id, lane.accepted_sequence, lane.dirty_generation
  loop
    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    ) values (
      v_generation_id, p_library_id, v_root.root_id,
      v_root.accepted_sequence, v_root.accepted_sequence,
      v_root.dirty_generation, p_accepted_at, p_accepted_at
    ) on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_upper = excluded.accepted_sequence_upper,
      dirty_generation = excluded.dirty_generation,
      updated_at = excluded.updated_at;
  end loop;

  if v_generation_is_catch_up then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id;
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = v_generation_id;
  elsif v_kind in ('created', 'modified') then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = p_primary_root_id
      and relative_path = v_source_relative
      and path_kind in ('deleted', 'deleted_subtree');
    insert into library.targeted_reconciliation_intent_paths (
      intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
    )
    select v_generation_id, 'preserved_subtree',
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || deleted.relative_path,
           coalesce((select pg_catalog.max(path.ordinal) + 1
                     from library.targeted_reconciliation_intent_paths path
                     where path.intent_id = v_generation_id), 0),
           p_library_id, p_primary_root_id, deleted.relative_path
    from library.targeted_reconciliation_intent_paths as deleted
    join library.library_roots as root on root.id = p_primary_root_id
    where deleted.intent_id = v_generation_id
      and deleted.root_id = p_primary_root_id
      and deleted.path_kind = 'deleted_subtree'
      and (v_source_relative = deleted.relative_path
           or pg_catalog.left(
                v_source_relative,
                pg_catalog.char_length(deleted.relative_path) + 1
              ) = deleted.relative_path || '/')
    on conflict do nothing;
  elsif v_kind = 'deleted' and v_is_directory then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = p_primary_root_id
      and (relative_path = v_source_relative
           or pg_catalog.left(
                relative_path,
                pg_catalog.char_length(v_source_relative) + 1
              ) = v_source_relative || '/');
  else
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = p_primary_root_id
      and relative_path = v_source_relative
      and path_kind = 'active';
  end if;

  select coalesce(pg_catalog.max(scope.ordinal), -1) + 1 into v_ordinal
  from library.targeted_reconciliation_intent_paths as scope
  where scope.intent_id = v_generation_id;
  v_path_kind := case
    when v_kind in ('created', 'modified') then 'active'
    when v_is_directory then 'deleted_subtree'
    else 'deleted'
  end;
  insert into library.targeted_reconciliation_intent_paths (
    intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
  )
  select v_generation_id, v_path_kind,
         root.root_path || case library.local_path_style(root.root_path)
           when 'windows' then E'\\' else '/' end || v_source_relative,
         v_ordinal, p_library_id, root.id, v_source_relative
  from library.library_roots as root
  where root.id = p_primary_root_id
    and not v_generation_is_catch_up
  on conflict do nothing;

  if v_kind = 'moved' and not v_generation_is_catch_up then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = v_destination_root_id
      and relative_path = v_destination_relative
      and path_kind in ('deleted', 'deleted_subtree');
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = v_generation_id
      and source_root_id = v_destination_root_id
      and source_relative_path = v_destination_relative;

    insert into library.targeted_reconciliation_intent_paths (
      intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
    )
    select v_generation_id, 'active',
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || v_destination_relative,
           v_ordinal + 1, p_library_id, root.id, v_destination_relative
    from library.library_roots as root
    where root.id = v_destination_root_id
    on conflict do nothing;

    select coalesce(pg_catalog.max(move.ordinal), -1) + 1 into v_ordinal
    from library.targeted_reconciliation_intent_moves as move
    where move.intent_id = v_generation_id;
    insert into library.targeted_reconciliation_intent_moves (
      intent_id, source_path, destination_path, source_root_id,
      destination_root_id, is_directory, ordinal,
      accepted_source_root_path, accepted_destination_root_path,
      library_id, source_relative_path, destination_relative_path
    )
    select v_generation_id,
           source_root.root_path || case library.local_path_style(source_root.root_path)
             when 'windows' then E'\\' else '/' end || v_source_relative,
           destination_root.root_path || case library.local_path_style(destination_root.root_path)
             when 'windows' then E'\\' else '/' end || v_destination_relative,
           source_root.id, destination_root.id, v_is_directory, v_ordinal,
           source_root.root_path, destination_root.root_path,
           p_library_id, v_source_relative, v_destination_relative
    from library.library_roots as source_root
    cross join library.library_roots as destination_root
    where source_root.id = p_primary_root_id
      and destination_root.id = v_destination_root_id;

    if v_destination_root_id <> p_primary_root_id then
      insert into library.watcher_barriers (library_id, created_at)
      values (p_library_id, p_accepted_at)
      returning id into v_barrier_id;
      insert into library.watcher_barrier_participants (
        barrier_id, generation_id, library_id, root_id, accepted_sequence
      )
      select v_barrier_id, v_generation_id, participant.library_id,
             participant.root_id, participant.accepted_sequence_upper
      from library.watcher_generation_participants as participant
      where participant.generation_id = v_generation_id
        and participant.root_id = any(v_participant_root_ids);
    end if;
  end if;

  for v_root in
    select participant.root_id
    from library.watcher_generation_participants as participant
    where participant.generation_id = v_generation_id
    order by participant.library_id, participant.root_id
  loop
    select
      (select pg_catalog.count(*)
       from library.targeted_reconciliation_intent_paths as scope
       where scope.intent_id = v_generation_id
         and scope.root_id = v_root.root_id)
      +
      (select pg_catalog.count(*)
       from library.targeted_reconciliation_intent_moves as move
       where move.intent_id = v_generation_id
         and (move.source_root_id = v_root.root_id
              or move.destination_root_id = v_root.root_id)),
      coalesce((select pg_catalog.sum(pg_catalog.octet_length(scope.relative_path))
                from library.targeted_reconciliation_intent_paths as scope
                where scope.intent_id = v_generation_id
                  and scope.root_id = v_root.root_id), 0)
      + coalesce((select pg_catalog.sum(
                    pg_catalog.octet_length(move.source_relative_path)
                    + pg_catalog.octet_length(move.destination_relative_path)
                  )
                  from library.targeted_reconciliation_intent_moves as move
                  where move.intent_id = v_generation_id
                    and (move.source_root_id = v_root.root_id
                         or move.destination_root_id = v_root.root_id)), 0)
    into v_scope_count, v_scope_bytes;
    if v_scope_count > 4096 or v_scope_bytes > 262144 then
      update library.watcher_lanes as lane
      set dirty_generation = lane.dirty_generation + 1,
          catch_up_count = lane.catch_up_count + 1,
          disposition_code = 'dirty',
          updated_at = p_accepted_at
      where lane.library_id = p_library_id
        and lane.root_id in (
          select participant.root_id
          from library.watcher_generation_participants as participant
          where participant.generation_id = v_generation_id
        );
      update library.watcher_generation_participants as participant
      set dirty_generation = lane.dirty_generation,
          updated_at = p_accepted_at
      from library.watcher_lanes as lane
      where participant.generation_id = v_generation_id
        and lane.library_id = participant.library_id
        and lane.root_id = participant.root_id;
      update library.targeted_reconciliation_intents
      set watcher_generation_kind = 'root_catch_up', updated_at = p_accepted_at
      where id = v_generation_id;
      delete from library.targeted_reconciliation_intent_paths
      where intent_id = v_generation_id;
      delete from library.targeted_reconciliation_intent_moves
      where intent_id = v_generation_id;
      exit;
    end if;
  end loop;

  update library.targeted_reconciliation_intents as intent
  set accepted_sequence_lower = participant.minimum_sequence,
      accepted_sequence_upper = participant.maximum_sequence,
      dirty_generation = participant.maximum_dirty_generation,
      request_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        v_generation_id::text || ':' || participant.maximum_sequence::text || ':'
          || p_event::text,
        'UTF8'
      )), 'hex'),
      updated_at = p_accepted_at
  from (
    select pg_catalog.min(generation_participant.accepted_sequence_lower)
             as minimum_sequence,
           pg_catalog.max(generation_participant.accepted_sequence_upper)
             as maximum_sequence,
           pg_catalog.max(generation_participant.dirty_generation)
             as maximum_dirty_generation
    from library.watcher_generation_participants generation_participant
    where generation_participant.generation_id = v_generation_id
  ) as participant
  where intent.id = v_generation_id;

  return query
  select root.metadata ->> 'root_id', participant.generation_id,
         participant.accepted_sequence_lower,
         participant.accepted_sequence_upper, participant.dirty_generation,
         v_was_coalesced, true
  from library.watcher_generation_participants as participant
  join library.library_roots as root on root.id = participant.root_id
  where participant.generation_id = v_generation_id
  order by participant.library_id, participant.root_id;
end;
$$;

create or replace function library.try_complete_watcher_repairs(
  p_repair_ids bigint[], p_now timestamptz
)
returns bigint[]
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_captured_cover_mutation_revision bigint;
  v_completed bigint[] := '{}';
  v_repair_id bigint;
  v_repair_state varchar(16);
  v_root record;
  v_blocking record;
  v_successor_id bigint;
  v_accepted_sequence bigint;
  v_dirty_generation bigint;
begin
  v_captured_cover_mutation_revision := null;
  foreach v_repair_id in array p_repair_ids loop
    select state into v_repair_state
    from library.watcher_repairs
    where id = v_repair_id;
    if v_repair_state is null
       or v_repair_state not in ('scanning', 'catch_up') then
      continue;
    end if;

    perform 1
    from library.watcher_lanes lane
    where (lane.library_id, lane.root_id) in (
      select repair_root.library_id, repair_root.root_id
      from library.watcher_repair_roots repair_root
      where repair_root.repair_id = v_repair_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants peer
      where peer.barrier_id in (
        select touched.barrier_id
        from library.watcher_barrier_participants touched
        join library.watcher_repair_roots repair_root
          on repair_root.library_id = touched.library_id
         and repair_root.root_id = touched.root_id
        where repair_root.repair_id = v_repair_id
      )
    )
    order by lane.library_id, lane.root_id
    for update of lane;

    update library.watcher_barriers barrier
    set completed_at = p_now
    where barrier.completed_at is null
      and exists (
        select 1
        from library.watcher_barrier_participants participant
        join library.watcher_repair_roots repair_root
          on repair_root.root_id = participant.root_id
         and repair_root.library_id = participant.library_id
        where participant.barrier_id = barrier.id
          and repair_root.repair_id = v_repair_id
      )
      and not exists (
        select 1
        from library.watcher_barrier_participants participant
        join library.watcher_lanes lane
          on lane.library_id = participant.library_id
         and lane.root_id = participant.root_id
        where participant.barrier_id = barrier.id
          and lane.applied_sequence < participant.accepted_sequence
      );

    if not exists (
      select 1
      from library.watcher_repair_roots repair_root
      join library.watcher_lanes lane
        on lane.library_id = repair_root.library_id
       and lane.root_id = repair_root.root_id
      where repair_root.repair_id = v_repair_id
        and (
          lane.accepted_sequence <> lane.applied_sequence
          or lane.dirty_generation <> lane.repaired_dirty_generation
          or lane.accepted_sequence > repair_root.captured_accepted_sequence
          or lane.dirty_generation > repair_root.captured_dirty_generation
          or lane.applied_sequence < repair_root.captured_accepted_sequence
          or lane.repaired_dirty_generation < repair_root.captured_dirty_generation
          or exists (
            select 1
            from library.watcher_barrier_participants barrier_participant
            join library.watcher_barriers barrier
              on barrier.id = barrier_participant.barrier_id
            where barrier_participant.root_id = repair_root.root_id
              and barrier_participant.accepted_sequence
                    <= repair_root.captured_accepted_sequence
              and barrier.completed_at is null
          )
        )
    ) then
      update library.watcher_repairs
      set state = 'complete', completed_at = p_now
      where id = v_repair_id and state in ('scanning', 'catch_up');

      update library.watcher_incidents incident
      set resolved_at = p_now
      from library.watcher_repair_roots repair_root
      where repair_root.repair_id = v_repair_id
        and incident.incident_id = repair_root.incident_id
        and incident.resolved_at is null;

      delete from library.watcher_generation_repairs
      where repair_id = v_repair_id;
      v_completed := array_append(v_completed, v_repair_id);
    else
      for v_blocking in
        select distinct peer_lane.library_id,
               peer_lane.root_id,
               peer_lane.applied_sequence,
               peer_lane.running_generation_id,
               peer_lane.successor_generation_id
        from library.watcher_repair_roots repair_root
        join library.watcher_barrier_participants touched
          on touched.library_id = repair_root.library_id
         and touched.root_id = repair_root.root_id
        join library.watcher_barriers barrier
          on barrier.id = touched.barrier_id and barrier.completed_at is null
        join library.watcher_barrier_participants peer
          on peer.barrier_id = touched.barrier_id
        join library.watcher_lanes peer_lane
          on peer_lane.library_id = peer.library_id
         and peer_lane.root_id = peer.root_id
        where repair_root.repair_id = v_repair_id
          and peer_lane.applied_sequence < peer.accepted_sequence
      loop
        v_successor_id := null;
        v_accepted_sequence := null;
        v_dirty_generation := null;
        if v_blocking.running_generation_id is null
           and v_blocking.successor_generation_id is null then
          update library.watcher_lanes as lane
          set accepted_sequence = lane.accepted_sequence + 1,
              dirty_generation = lane.dirty_generation + 1,
              catch_up_count = lane.catch_up_count + 1,
              disposition_code = 'dirty',
              next_eligible_at = p_now,
              updated_at = p_now
          where lane.library_id = v_blocking.library_id
            and lane.root_id = v_blocking.root_id
            and lane.running_generation_id is null
            and lane.successor_generation_id is null
          returning lane.accepted_sequence, lane.dirty_generation
            into v_accepted_sequence, v_dirty_generation;
          if not found then
            raise exception 'watcher repair barrier extension raced'
              using errcode = '40001';
          end if;

          insert into library.targeted_reconciliation_intents (
            library_id, primary_root_id, producer_request_key, request_digest,
            deployment_mode, client_surface, state, accepted_at, updated_at,
            watcher_generation_kind, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation
          ) values (
            v_blocking.library_id, v_blocking.root_id,
            'watcher-repair-extension:' || v_repair_id::text || ':'
              || v_blocking.root_id::text || ':' || v_accepted_sequence::text,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              'watcher-repair-extension:' || v_repair_id::text || ':'
                || v_blocking.root_id::text || ':' || v_accepted_sequence::text,
              'UTF8'
            )), 'hex'),
            'self_hosted_private_web', 'library_watcher', 'accepted', p_now, p_now,
            'root_catch_up', v_blocking.applied_sequence + 1,
            v_accepted_sequence, v_dirty_generation
          ) returning id into v_successor_id;

          update library.watcher_lanes as lane
          set successor_generation_id = v_successor_id
          where lane.library_id = v_blocking.library_id
            and lane.root_id = v_blocking.root_id
            and lane.running_generation_id is null
            and lane.successor_generation_id is null;
          if not found then
            raise exception 'watcher repair barrier successor raced'
              using errcode = '40001';
          end if;

          insert into library.watcher_generation_participants (
            generation_id, library_id, root_id, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation, created_at, updated_at
          ) values (
            v_successor_id, v_blocking.library_id, v_blocking.root_id,
            v_blocking.applied_sequence + 1, v_accepted_sequence,
            v_dirty_generation, p_now, p_now
          );
          v_blocking.successor_generation_id := v_successor_id;
        end if;

        insert into library.watcher_generation_repairs (
          generation_id, repair_id, library_id, created_at
        )
        select generation_id, v_repair_id, v_blocking.library_id, p_now
        from unnest(array[
          v_blocking.running_generation_id,
          v_blocking.successor_generation_id
        ]) as pending(generation_id)
        where generation_id is not null
        on conflict on constraint watcher_generation_repairs_pkey do nothing;
      end loop;

      for v_root in
        select repair_root.library_id, repair_root.root_id,
               lane.accepted_sequence, lane.applied_sequence,
               lane.dirty_generation, lane.running_generation_id,
               lane.successor_generation_id
        from library.watcher_repair_roots repair_root
        join library.watcher_lanes lane
          on lane.library_id = repair_root.library_id
         and lane.root_id = repair_root.root_id
        where repair_root.repair_id = v_repair_id
          and (
            lane.accepted_sequence <> lane.applied_sequence
            or lane.dirty_generation <> lane.repaired_dirty_generation
            or lane.accepted_sequence > repair_root.captured_accepted_sequence
            or lane.dirty_generation > repair_root.captured_dirty_generation
          )
      order by repair_root.library_id, repair_root.root_id
      loop
        v_accepted_sequence := null;
        v_dirty_generation := null;
        v_successor_id := null;
        if v_root.running_generation_id is null
           and v_root.successor_generation_id is null then
          update library.watcher_lanes as lane
          set accepted_sequence = lane.accepted_sequence + 1,
              dirty_generation = lane.dirty_generation + 1,
              catch_up_count = lane.catch_up_count + 1,
              disposition_code = 'dirty',
              next_eligible_at = p_now,
              updated_at = p_now
          where lane.library_id = v_root.library_id
            and lane.root_id = v_root.root_id
            and lane.running_generation_id is null
            and lane.successor_generation_id is null
          returning lane.accepted_sequence, lane.dirty_generation
            into v_accepted_sequence, v_dirty_generation;
          if not found then
            raise exception 'watcher repair extension raced' using errcode = '40001';
          end if;

          insert into library.targeted_reconciliation_intents (
            library_id, primary_root_id, producer_request_key, request_digest,
            deployment_mode, client_surface, state, accepted_at, updated_at,
            watcher_generation_kind, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation
          ) values (
            v_root.library_id, v_root.root_id,
            'watcher-repair-extension:' || v_repair_id::text || ':'
              || v_root.root_id::text || ':' || v_accepted_sequence::text,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              'watcher-repair-extension:' || v_repair_id::text || ':'
                || v_root.root_id::text || ':' || v_accepted_sequence::text,
              'UTF8'
            )), 'hex'),
            'self_hosted_private_web', 'library_watcher', 'accepted', p_now, p_now,
            'root_catch_up', v_root.applied_sequence + 1,
            v_accepted_sequence, v_dirty_generation
          ) returning id into v_successor_id;

          update library.watcher_lanes
          set successor_generation_id = v_successor_id,
              disposition_code = 'dirty', updated_at = p_now
          where library_id = v_root.library_id
            and root_id = v_root.root_id
            and running_generation_id is null
            and successor_generation_id is null;
          if not found then
            raise exception 'watcher repair successor raced' using errcode = '40001';
          end if;
        elsif v_root.successor_generation_id is not null then
          update library.targeted_reconciliation_intents
          set watcher_generation_kind = 'root_catch_up',
              accepted_sequence_lower = least(
                accepted_sequence_lower, v_root.applied_sequence + 1
              ),
              accepted_sequence_upper = greatest(
                accepted_sequence_upper, v_root.accepted_sequence
              ),
              dirty_generation = greatest(
                dirty_generation, v_root.dirty_generation
              )
          where id = v_root.successor_generation_id
            and watcher_job_linked_at is null
            and state = 'accepted'
          returning id into v_successor_id;
          if found then
            delete from library.targeted_reconciliation_intent_paths
            where intent_id = v_successor_id;
            delete from library.targeted_reconciliation_intent_moves
            where intent_id = v_successor_id;
          end if;
        end if;

        if v_successor_id is not null then
          insert into library.watcher_generation_participants (
            generation_id, library_id, root_id, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation, created_at, updated_at
          ) values (
            v_successor_id, v_root.library_id, v_root.root_id,
            v_root.applied_sequence + 1,
            coalesce(v_accepted_sequence, v_root.accepted_sequence),
            coalesce(v_dirty_generation, v_root.dirty_generation), p_now, p_now
          )
          on conflict on constraint watcher_generation_participants_pkey do update
          set accepted_sequence_lower = least(
                library.watcher_generation_participants.accepted_sequence_lower,
                excluded.accepted_sequence_lower
              ),
              accepted_sequence_upper = greatest(
                library.watcher_generation_participants.accepted_sequence_upper,
                excluded.accepted_sequence_upper
              ),
              dirty_generation = greatest(
                library.watcher_generation_participants.dirty_generation,
                excluded.dirty_generation
              ),
              updated_at = p_now;
        end if;

        insert into library.watcher_generation_repairs (
          generation_id, repair_id, library_id, created_at
        )
        select generation_id, v_repair_id, v_root.library_id, p_now
        from unnest(array[
          v_root.running_generation_id,
          v_root.successor_generation_id,
          v_successor_id
        ]) as pending(generation_id)
        where generation_id is not null
        on conflict on constraint watcher_generation_repairs_pkey do nothing;

        if not exists (
          select 1
          from library.watcher_generation_repairs as link
          where link.repair_id = v_repair_id
            and link.generation_id = any(array[
              v_root.running_generation_id,
              v_root.successor_generation_id,
              v_successor_id
            ])
        ) then
          raise exception 'watcher repair extension has no completion trigger'
            using errcode = '23514';
        end if;

        update library.watcher_repair_roots as repair_root
        set captured_accepted_sequence = lane.accepted_sequence,
            captured_dirty_generation = lane.dirty_generation
        from library.watcher_lanes as lane
        where repair_root.repair_id = v_repair_id
          and repair_root.root_id = v_root.root_id
          and lane.library_id = repair_root.library_id
          and lane.root_id = repair_root.root_id;
      end loop;

      update library.watcher_repairs
      set state = 'catch_up', completed_at = null
      where id = v_repair_id;
    end if;
  end loop;

  update library.libraries as local_library
  set metadata = pg_catalog.jsonb_set(
        coalesce(local_library.metadata, '{}'::jsonb),
        '{library_watch_health}',
        coalesce(
          local_library.metadata -> 'library_watch_health', '{}'::jsonb
        ) - coalesce((
          select pg_catalog.array_agg(
                   distinct root.metadata ->> 'root_id'
                   order by root.metadata ->> 'root_id'
                 )
          from library.watcher_repair_roots as repair_root
          join library.library_roots as root
            on root.library_id = repair_root.library_id
           and root.id = repair_root.root_id
          where repair_root.repair_id = any(v_completed)
            and repair_root.library_id = local_library.id
        ), array[]::text[]),
        true
      ),
      updated_at = greatest(local_library.updated_at, p_now)
  where exists (
    select 1
    from library.watcher_repair_roots as repair_root
    where repair_root.repair_id = any(v_completed)
      and repair_root.library_id = local_library.id
  );
  return v_completed;
end;
$$;

create or replace function library.fail_claimed_watcher_generation(
  p_generation_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_reason_code varchar,
  p_now timestamptz
)
returns table (failed boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_captured_cover_mutation_revision bigint;
  v_library_id bigint;
  v_primary_root_id bigint;
  v_successor_id bigint;
  v_digest varchar(64);
  v_participant record;
  v_count integer;
  v_expected integer;
  v_closure_root_ids bigint[];
  v_existing_successor_ids bigint[];
  v_loser_id bigint;
begin
  if p_reason_code not in (
    'root_unavailable', 'overflow', 'stable_write_unavailable',
    'reconciliation_failed', 'cross_root_uncertain'
  ) then
    raise exception 'watcher failure reason is invalid' using errcode = '22023';
  end if;
  select intent.library_id, intent.primary_root_id
  into v_library_id, v_primary_root_id
  from ops.jobs as job
  join library.targeted_reconciliation_intents as intent on intent.job_id = job.id
  where intent.id = p_generation_id
    and job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  ;
  if not found then
    return query select false;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:watcher:' || v_library_id::text, 0
    )
  );

  perform 1
  from library.watcher_repairs as repair
  where repair.library_id = v_library_id
    and repair.state in ('scanning', 'catch_up')
  order by repair.id
  for update;
  with recursive successor_closure(library_id, root_id, generation_id) as (
    select participant.library_id, participant.root_id,
           lane.successor_generation_id
    from library.watcher_generation_participants as participant
    join library.watcher_lanes as lane
      on lane.library_id = participant.library_id
     and lane.root_id = participant.root_id
    where participant.generation_id = p_generation_id
    union
    select participant.library_id, participant.root_id,
           participant_lane.successor_generation_id
    from successor_closure as current
    join library.watcher_generation_participants as participant
      on participant.generation_id = current.generation_id
    join library.watcher_lanes as participant_lane
      on participant_lane.library_id = participant.library_id
     and participant_lane.root_id = participant.root_id
    where current.generation_id is not null
  ), lock_roots as (
    select closure.library_id, closure.root_id
    from successor_closure as closure
    union
    select peer.library_id, peer.root_id
    from library.watcher_barrier_participants as owned_barrier
    join library.watcher_barrier_participants as peer
      on peer.barrier_id = owned_barrier.barrier_id
    where owned_barrier.generation_id = p_generation_id
  ), locked_lanes as materialized (
    select lane.library_id, lane.root_id, lane.successor_generation_id
    from library.watcher_lanes as lane
    join lock_roots as locked
      on locked.library_id = lane.library_id and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane
  )
  select pg_catalog.array_agg(locked.root_id order by locked.root_id),
         pg_catalog.array_agg(distinct locked.successor_generation_id
                              order by locked.successor_generation_id)
           filter (
             where locked.successor_generation_id is not null
               and exists (
                 select 1 from successor_closure as closure
                 where closure.library_id = locked.library_id
                   and closure.root_id = locked.root_id
               )
           )
  into v_closure_root_ids, v_existing_successor_ids
  from locked_lanes as locked;

  perform 1
  from ops.jobs as job
  join library.targeted_reconciliation_intents as intent
    on intent.job_id = job.id
  where intent.id = p_generation_id
    and job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of job, intent;
  if not found then
    return query select false;
    return;
  end if;

  select pg_catalog.count(*) into v_expected
  from library.watcher_generation_participants generation_participant
  where generation_participant.generation_id = p_generation_id;
  v_successor_id := v_existing_successor_ids[1];
  if v_successor_id is null then
    v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'watcher-failure:' || p_generation_id::text || ':' || p_attempt::text,
      'UTF8'
    )), 'hex');
    insert into library.targeted_reconciliation_intents (
      library_id, primary_root_id, producer_request_key, request_digest,
      deployment_mode, client_surface, state, accepted_at, updated_at,
      watcher_generation_kind, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation
    )
    select v_library_id, v_primary_root_id,
           'watcher-failure:' || p_generation_id::text || ':' || p_attempt::text,
           v_digest, 'self_hosted_private_web', 'library_watcher', 'accepted',
           p_now, p_now, 'root_catch_up',
           pg_catalog.min(lane.accepted_sequence),
           pg_catalog.max(lane.accepted_sequence),
           pg_catalog.max(lane.dirty_generation) + 1
    from library.watcher_lanes as lane
    join library.watcher_generation_participants as participant
      on participant.library_id = lane.library_id
     and participant.root_id = lane.root_id
    where participant.generation_id = p_generation_id
    returning id into v_successor_id;
  end if;

  foreach v_loser_id in array coalesce(v_existing_successor_ids[2:], array[]::bigint[])
  loop
    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    )
    select v_successor_id, participant.library_id, participant.root_id,
           participant.accepted_sequence_lower,
           participant.accepted_sequence_upper, participant.dirty_generation,
           participant.created_at, p_now
    from library.watcher_generation_participants as participant
    where participant.generation_id = v_loser_id
    on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_lower = least(
        library.watcher_generation_participants.accepted_sequence_lower,
        excluded.accepted_sequence_lower
      ),
      accepted_sequence_upper = greatest(
        library.watcher_generation_participants.accepted_sequence_upper,
        excluded.accepted_sequence_upper
      ),
      dirty_generation = greatest(
        library.watcher_generation_participants.dirty_generation,
        excluded.dirty_generation
      ),
      updated_at = excluded.updated_at;
    update library.watcher_barrier_participants as barrier_link
    set generation_id = v_successor_id
    where barrier_link.generation_id = v_loser_id;
    insert into library.watcher_generation_repairs (
      generation_id, repair_id, library_id, created_at
    )
    select v_successor_id, repair_link.repair_id, repair_link.library_id,
           repair_link.created_at
    from library.watcher_generation_repairs as repair_link
    where repair_link.generation_id = v_loser_id
    on conflict on constraint watcher_generation_repairs_pkey do nothing;
    delete from library.watcher_generation_repairs repair_link
    where repair_link.generation_id = v_loser_id;
    update library.watcher_lanes
    set successor_generation_id = v_successor_id, updated_at = p_now
    where successor_generation_id = v_loser_id;
    delete from library.targeted_reconciliation_intents
    where id = v_loser_id and watcher_job_linked_at is null;
  end loop;

  update library.targeted_reconciliation_intents
  set watcher_generation_kind = 'root_catch_up', updated_at = p_now
  where id = v_successor_id and watcher_job_linked_at is null;
  delete from library.targeted_reconciliation_intent_paths
  where intent_id = v_successor_id;
  delete from library.targeted_reconciliation_intent_moves
  where intent_id = v_successor_id;

  v_count := 0;
  for v_participant in
    update library.watcher_lanes as lane
    set dirty_generation = lane.dirty_generation + 1,
        successor_generation_id = v_successor_id,
        running_generation_id = null,
        running_job_id = null,
        disposition_code = 'dirty',
        next_eligible_at = p_now,
        updated_at = p_now
    from library.watcher_generation_participants as participant
    where participant.generation_id = p_generation_id
      and lane.library_id = participant.library_id
      and lane.root_id = participant.root_id
      and lane.running_generation_id = p_generation_id
      and lane.running_job_id = p_job_id
    returning lane.library_id, lane.root_id, lane.accepted_sequence,
              lane.dirty_generation
  loop
    v_count := v_count + 1;
    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    ) values (
      v_successor_id, v_participant.library_id, v_participant.root_id,
      v_participant.accepted_sequence, v_participant.accepted_sequence,
      v_participant.dirty_generation, p_now, p_now
    ) on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_lower = least(
        library.watcher_generation_participants.accepted_sequence_lower,
        excluded.accepted_sequence_lower
      ),
      accepted_sequence_upper = greatest(
        library.watcher_generation_participants.accepted_sequence_upper,
        excluded.accepted_sequence_upper
      ),
      dirty_generation = excluded.dirty_generation,
      updated_at = excluded.updated_at;
    insert into library.watcher_incidents (
      library_id, root_id, incident_family, reason_code, occurrence_count,
      accepted_sequence, dirty_generation, first_seen_at, last_seen_at
    ) values (
      v_participant.library_id, v_participant.root_id, 'watcher_recovery',
      p_reason_code, 1, v_participant.accepted_sequence,
      v_participant.dirty_generation, p_now, p_now
    ) on conflict (library_id, root_id, incident_family)
      where resolved_at is null
      do update set
        reason_code = case
          when excluded.reason_code = 'reconciliation_failed'
            and library.watcher_incidents.reason_code = 'root_unavailable'
          then library.watcher_incidents.reason_code
          else excluded.reason_code
        end,
        occurrence_count = library.watcher_incidents.occurrence_count + 1,
      accepted_sequence = greatest(
        library.watcher_incidents.accepted_sequence,
        excluded.accepted_sequence
      ),
      dirty_generation = greatest(
        library.watcher_incidents.dirty_generation,
        excluded.dirty_generation
      ),
        last_seen_at = excluded.last_seen_at;
  end loop;
  update library.watcher_barrier_participants as barrier_link
  set generation_id = v_successor_id
  where barrier_link.generation_id = p_generation_id;
  insert into library.watcher_generation_repairs (
    generation_id, repair_id, library_id, created_at
  )
  select v_successor_id, repair_link.repair_id, repair_link.library_id,
         repair_link.created_at
  from library.watcher_generation_repairs as repair_link
  where repair_link.generation_id = p_generation_id
  on conflict on constraint watcher_generation_repairs_pkey do nothing;
  delete from library.watcher_generation_repairs as repair_link
  where repair_link.generation_id = p_generation_id;
  return query select v_expected > 0 and v_count = v_expected;
end;
$$;

create or replace function library.reconcile_due_watcher_generations(
  p_now timestamptz,
  p_limit integer
)
returns table (generation_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_captured_cover_mutation_revision bigint;
  candidate record;
  participant record;
  v_successor_id bigint;
  v_digest varchar(64);
  v_closure_root_ids bigint[];
  v_existing_successor_ids bigint[];
  v_loser_id bigint;
  v_inactive_changed boolean;
  v_accepted_sequence bigint;
  v_dirty_generation bigint;
  v_reconciled integer := 0;
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 128 then
    raise exception 'watcher recovery request is invalid' using errcode = '22023';
  end if;

  for candidate in
    select intent.id as generation_id, intent.library_id
    from library.targeted_reconciliation_intents as intent
    where intent.watcher_generation_kind in ('exact', 'root_catch_up')
      and intent.watcher_job_linked_at is null
      and intent.state = 'accepted'
      and exists (
        select 1
        from library.watcher_generation_participants as owned
        join library.watcher_lanes as lane
          on lane.library_id = owned.library_id
         and lane.root_id = owned.root_id
        left join library.library_roots as active_root
          on active_root.library_id = owned.library_id
         and active_root.id = owned.root_id
         and active_root.is_active is true
        where owned.generation_id = intent.id
          and lane.successor_generation_id = intent.id
          and active_root.id is null
          and (
            intent.watcher_generation_kind = 'exact'
            or not exists (
              select 1
              from library.watcher_incidents as incident
              where incident.library_id = lane.library_id
                and incident.root_id = lane.root_id
                and incident.incident_family = 'watcher_recovery'
                and incident.reason_code = 'root_unavailable'
                and incident.resolved_at is null
                and incident.accepted_sequence >= lane.accepted_sequence
                and incident.dirty_generation >= lane.dirty_generation
            )
          )
      )
    order by intent.accepted_at, intent.id
    limit p_limit
  loop
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:watcher:' || candidate.library_id::text, 0
      )
    ) then
      continue;
    end if;

    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = candidate.library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;

    perform 1
    from library.watcher_lanes as lane
    join (
      select owned.library_id, owned.root_id
      from library.watcher_generation_participants as owned
      where owned.generation_id = candidate.generation_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as owned_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = owned_barrier.barrier_id
      where owned_barrier.generation_id = candidate.generation_id
    ) as locked
      on locked.library_id = lane.library_id
     and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;

    perform 1
    from library.targeted_reconciliation_intents as intent
    where intent.id = candidate.generation_id
      and intent.watcher_generation_kind in ('exact', 'root_catch_up')
      and intent.watcher_job_linked_at is null
      and intent.state = 'accepted'
      and exists (
        select 1
        from library.watcher_generation_participants as owned
        join library.watcher_lanes as lane
          on lane.library_id = owned.library_id
         and lane.root_id = owned.root_id
        left join library.library_roots as active_root
          on active_root.library_id = owned.library_id
         and active_root.id = owned.root_id
         and active_root.is_active is true
        where owned.generation_id = intent.id
          and lane.successor_generation_id = intent.id
          and active_root.id is null
          and (
            intent.watcher_generation_kind = 'exact'
            or not exists (
              select 1
              from library.watcher_incidents as incident
              where incident.library_id = lane.library_id
                and incident.root_id = lane.root_id
                and incident.incident_family = 'watcher_recovery'
                and incident.reason_code = 'root_unavailable'
                and incident.resolved_at is null
                and incident.accepted_sequence >= lane.accepted_sequence
                and incident.dirty_generation >= lane.dirty_generation
            )
          )
      )
    for update of intent;
    if not found then
      continue;
    end if;

    v_inactive_changed := false;
    for participant in
      select owned.library_id, owned.root_id
      from library.watcher_generation_participants as owned
      join library.watcher_lanes as lane
        on lane.library_id = owned.library_id
       and lane.root_id = owned.root_id
      join library.targeted_reconciliation_intents as intent
        on intent.id = owned.generation_id
      left join library.library_roots as active_root
        on active_root.library_id = owned.library_id
       and active_root.id = owned.root_id
       and active_root.is_active is true
      where owned.generation_id = candidate.generation_id
        and lane.successor_generation_id = candidate.generation_id
        and active_root.id is null
        and (
          intent.watcher_generation_kind = 'exact'
          or not exists (
            select 1
            from library.watcher_incidents as incident
            where incident.library_id = lane.library_id
              and incident.root_id = lane.root_id
              and incident.incident_family = 'watcher_recovery'
              and incident.reason_code = 'root_unavailable'
              and incident.resolved_at is null
              and incident.accepted_sequence >= lane.accepted_sequence
              and incident.dirty_generation >= lane.dirty_generation
          )
        )
      order by owned.library_id, owned.root_id
    loop
      update library.watcher_lanes as lane
      set dirty_generation = lane.dirty_generation + 1,
          catch_up_count = lane.catch_up_count + 1,
          disposition_code = 'dirty',
          next_eligible_at = p_now,
          updated_at = p_now
      where lane.library_id = participant.library_id
        and lane.root_id = participant.root_id
        and lane.successor_generation_id = candidate.generation_id
        returning lane.accepted_sequence, lane.dirty_generation
        into v_accepted_sequence, v_dirty_generation;
      if not found then
        raise exception 'inactive watcher successor lane raced'
          using errcode = '40001';
      end if;

      update library.watcher_generation_participants as owned
           set accepted_sequence_upper = v_accepted_sequence,
               dirty_generation = v_dirty_generation,
          updated_at = p_now
      where owned.generation_id = candidate.generation_id
        and owned.library_id = participant.library_id
        and owned.root_id = participant.root_id;

      insert into library.watcher_incidents (
        library_id, root_id, incident_family, reason_code, occurrence_count,
        accepted_sequence, dirty_generation, first_seen_at, last_seen_at
      ) values (
          participant.library_id, participant.root_id, 'watcher_recovery',
          'root_unavailable', 1, v_accepted_sequence,
          v_dirty_generation, p_now, p_now
      )
      on conflict (library_id, root_id, incident_family)
        where resolved_at is null
      do update set
        reason_code = excluded.reason_code,
        occurrence_count = library.watcher_incidents.occurrence_count + 1,
      accepted_sequence = greatest(
        library.watcher_incidents.accepted_sequence,
        excluded.accepted_sequence
      ),
      dirty_generation = greatest(
        library.watcher_incidents.dirty_generation,
        excluded.dirty_generation
      ),
        last_seen_at = excluded.last_seen_at;

      v_inactive_changed := true;
    end loop;

    if not v_inactive_changed then
      continue;
    end if;

    update library.targeted_reconciliation_intents as intent
    set watcher_generation_kind = 'root_catch_up',
        accepted_sequence_lower = participant_fences.accepted_sequence_lower,
        accepted_sequence_upper = participant_fences.accepted_sequence_upper,
        dirty_generation = participant_fences.dirty_generation,
        updated_at = p_now
    from (
      select pg_catalog.min(owned.accepted_sequence_lower) as accepted_sequence_lower,
             pg_catalog.max(owned.accepted_sequence_upper) as accepted_sequence_upper,
             pg_catalog.max(owned.dirty_generation) as dirty_generation
        from library.watcher_generation_participants as owned
       where owned.generation_id = candidate.generation_id
    ) as participant_fences
    where intent.id = candidate.generation_id;

    delete from library.targeted_reconciliation_intent_paths
    where intent_id = candidate.generation_id;
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = candidate.generation_id;

    v_reconciled := v_reconciled + 1;
    generation_id := candidate.generation_id;
    return next;
  end loop;

  if v_reconciled >= p_limit then
    return;
  end if;

  for candidate in
    select distinct lane.running_generation_id as generation_id,
           lane.running_job_id as job_id, lane.library_id,
           intent.primary_root_id, job.state, job.lease_expires_at
    from library.watcher_lanes as lane
    join library.targeted_reconciliation_intents as intent
      on intent.id = lane.running_generation_id
    left join ops.jobs as job on job.id = lane.running_job_id
    where lane.running_generation_id is not null
      and lane.running_job_id is not null
      and not (
        job.state in ('queued', 'retry_wait')
        or (job.state = 'running'
            and job.lease_expires_at > pg_catalog.clock_timestamp())
      )
      and (job.id is null
           or job.state in ('canceled', 'failed', 'ambiguous', 'succeeded'))
    order by lane.running_generation_id
    limit p_limit - v_reconciled
  loop
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:watcher:' || candidate.library_id::text, 0
      )
    ) then
      continue;
    end if;

    perform 1 from library.watcher_repairs as repair
    where repair.library_id = candidate.library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id for update;
    with recursive successor_closure(library_id, root_id, generation_id) as (
      select owned.library_id, owned.root_id, lane.successor_generation_id
      from library.watcher_generation_participants as owned
      join library.watcher_lanes as lane
        on lane.library_id = owned.library_id and lane.root_id = owned.root_id
      where owned.generation_id = candidate.generation_id
      union
      select owned.library_id, owned.root_id,
             owned_lane.successor_generation_id
      from successor_closure as current
      join library.watcher_generation_participants as owned
        on owned.generation_id = current.generation_id
      join library.watcher_lanes as owned_lane
        on owned_lane.library_id = owned.library_id
       and owned_lane.root_id = owned.root_id
      where current.generation_id is not null
    ), lock_roots as (
      select closure.library_id, closure.root_id
      from successor_closure as closure
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as owned_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = owned_barrier.barrier_id
      where owned_barrier.generation_id = candidate.generation_id
    ), locked_lanes as materialized (
      select lane.library_id, lane.root_id, lane.successor_generation_id
      from library.watcher_lanes as lane
      join lock_roots as locked
        on locked.library_id = lane.library_id and locked.root_id = lane.root_id
      order by lane.library_id, lane.root_id
      for update of lane
    )
    select pg_catalog.array_agg(locked.root_id order by locked.root_id),
           pg_catalog.array_agg(distinct locked.successor_generation_id
                                order by locked.successor_generation_id)
             filter (
               where locked.successor_generation_id is not null
                 and exists (
                   select 1 from successor_closure as closure
                   where closure.library_id = locked.library_id
                     and closure.root_id = locked.root_id
                 )
             )
    into v_closure_root_ids, v_existing_successor_ids
    from locked_lanes as locked;
    if exists (
      select 1 from ops.jobs as job
      where job.id = candidate.job_id
        and (job.state in ('queued', 'retry_wait')
             or job.state = 'running')
    ) then
      continue;
    end if;
    v_successor_id := v_existing_successor_ids[1];
    if v_successor_id is null then
      v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        'watcher-recovery:' || candidate.generation_id::text, 'UTF8'
      )), 'hex');
      insert into library.targeted_reconciliation_intents (
        library_id, primary_root_id, producer_request_key, request_digest,
        deployment_mode, client_surface, state, accepted_at, updated_at,
        watcher_generation_kind, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation
      )
      select candidate.library_id, candidate.primary_root_id,
             'watcher-recovery:' || candidate.generation_id::text,
             v_digest, 'self_hosted_private_web', 'library_watcher',
             'accepted', p_now, p_now, 'root_catch_up',
             pg_catalog.min(lane.accepted_sequence),
             pg_catalog.max(lane.accepted_sequence),
             pg_catalog.max(lane.dirty_generation) + 1
      from library.watcher_lanes as lane
      join library.watcher_generation_participants as owned
        on owned.library_id = lane.library_id and owned.root_id = lane.root_id
      where owned.generation_id = candidate.generation_id
      returning id into v_successor_id;
    end if;
    foreach v_loser_id in array coalesce(
      v_existing_successor_ids[2:], array[]::bigint[]
    )
    loop
      insert into library.watcher_generation_participants (
        generation_id, library_id, root_id, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation, created_at, updated_at
      )
      select v_successor_id, owned.library_id, owned.root_id,
             owned.accepted_sequence_lower, owned.accepted_sequence_upper,
             owned.dirty_generation, owned.created_at, p_now
      from library.watcher_generation_participants as owned
      where owned.generation_id = v_loser_id
    on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_lower = least(
          library.watcher_generation_participants.accepted_sequence_lower,
          excluded.accepted_sequence_lower
        ),
      accepted_sequence_upper = greatest(
          library.watcher_generation_participants.accepted_sequence_upper,
          excluded.accepted_sequence_upper
        ),
      dirty_generation = greatest(
          library.watcher_generation_participants.dirty_generation,
          excluded.dirty_generation
        ),
        updated_at = excluded.updated_at;
      update library.watcher_barrier_participants as barrier_link
      set generation_id = v_successor_id
      where barrier_link.generation_id = v_loser_id;
      insert into library.watcher_generation_repairs (
        generation_id, repair_id, library_id, created_at
      )
      select v_successor_id, repair_link.repair_id, repair_link.library_id,
             repair_link.created_at
      from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = v_loser_id
      on conflict on constraint watcher_generation_repairs_pkey do nothing;
      delete from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = v_loser_id;
      update library.watcher_lanes
      set successor_generation_id = v_successor_id, updated_at = p_now
      where successor_generation_id = v_loser_id;
      delete from library.targeted_reconciliation_intents
      where id = v_loser_id and watcher_job_linked_at is null;
    end loop;
    update library.targeted_reconciliation_intents
    set watcher_generation_kind = 'root_catch_up', updated_at = p_now
    where id = v_successor_id and watcher_job_linked_at is null;
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_successor_id;
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = v_successor_id;
    for participant in
      update library.watcher_lanes as lane
      set dirty_generation = lane.dirty_generation + 1,
          successor_generation_id = v_successor_id,
          running_generation_id = null, running_job_id = null,
        disposition_code = 'dirty',
        next_eligible_at = p_now + interval '1 microsecond',
          updated_at = p_now
      from library.watcher_generation_participants as owned
      where owned.generation_id = candidate.generation_id
        and lane.library_id = owned.library_id and lane.root_id = owned.root_id
        and lane.running_generation_id = candidate.generation_id
        and lane.running_job_id = candidate.job_id
      returning lane.library_id, lane.root_id, lane.accepted_sequence,
                lane.dirty_generation
    loop
      insert into library.watcher_generation_participants (
        generation_id, library_id, root_id, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation, created_at, updated_at
      ) values (
        v_successor_id, participant.library_id, participant.root_id,
        participant.accepted_sequence, participant.accepted_sequence,
        participant.dirty_generation, p_now, p_now
    ) on conflict on constraint watcher_generation_participants_pkey do update set
        accepted_sequence_upper = excluded.accepted_sequence_upper,
        dirty_generation = excluded.dirty_generation,
        updated_at = excluded.updated_at;
      insert into library.watcher_incidents (
        library_id, root_id, incident_family, reason_code, occurrence_count,
        accepted_sequence, dirty_generation, first_seen_at, last_seen_at
      ) values (
        participant.library_id, participant.root_id, 'watcher_recovery',
        'reconciliation_failed', 1, participant.accepted_sequence,
        participant.dirty_generation, p_now, p_now
      ) on conflict (library_id, root_id, incident_family)
        where resolved_at is null do update set
          reason_code = case
            when excluded.reason_code = 'reconciliation_failed'
              and library.watcher_incidents.reason_code = 'root_unavailable'
            then library.watcher_incidents.reason_code
            else excluded.reason_code
          end,
          occurrence_count = library.watcher_incidents.occurrence_count + 1,
      accepted_sequence = greatest(
        library.watcher_incidents.accepted_sequence,
        excluded.accepted_sequence
      ),
      dirty_generation = greatest(
        library.watcher_incidents.dirty_generation,
        excluded.dirty_generation
      ),
          last_seen_at = excluded.last_seen_at;
    end loop;
    update library.watcher_barrier_participants as barrier_link
    set generation_id = v_successor_id
    where barrier_link.generation_id = candidate.generation_id;
    insert into library.watcher_generation_repairs (
      generation_id, repair_id, library_id, created_at
    ) select v_successor_id, repair_link.repair_id, repair_link.library_id,
             repair_link.created_at
      from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = candidate.generation_id
    on conflict on constraint watcher_generation_repairs_pkey do nothing;
    delete from library.watcher_generation_repairs as repair_link
    where repair_link.generation_id = candidate.generation_id;
    generation_id := candidate.generation_id;
    return next;
  end loop;
end;
$$;

drop function if exists library.load_claimed_full_scan_intent_v3(
  bigint, character varying, character varying
);
create or replace function library.load_claimed_full_scan_intent_v3(
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
  committed_inventory_revision bigint,
  watcher_repair_id bigint,
  captured_cover_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_intent_id bigint;
  v_library_id bigint;
  v_attempt integer;
  v_repair_id bigint;
  v_repair_scanning boolean;
  v_captured_revision bigint;
begin
  select job.library_id
  into v_library_id
  from ops.jobs as job
  where job.id = p_job_id
    and job.kind = 'full_scan';
  if v_library_id is null then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:watcher:' || v_library_id::text, 0
    )
  );

  select intent.id, intent.library_id, job.attempt_count,
         intent.watcher_repair_id
  into v_intent_id, v_library_id, v_attempt, v_repair_id
  from ops.jobs as job
  join library.full_scan_intents as intent on intent.job_id = job.id
  where job.id = p_job_id
    and job.kind = 'full_scan'
    and job.subject_kind = 'full_scan_intent'
    and job.subject_ref = intent.id::text
    and job.library_id = intent.library_id
    and job.state = 'running'
    and intent.state = 'running'
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of job, intent;
  if v_intent_id is null then
    return;
  end if;

  if v_repair_id is not null then
    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = v_library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;

    select repair.state = 'scanning'
    into v_repair_scanning
    from library.watcher_repairs as repair
    where repair.id = v_repair_id
      and repair.library_id = v_library_id;

    if coalesce(v_repair_scanning, false) then
      perform 1
      from library.watcher_lanes as lane
      join library.full_scan_intent_roots as intent_root
        on intent_root.intent_id = v_intent_id
       and intent_root.root_id = lane.root_id
      where lane.library_id = v_library_id
      order by lane.library_id, lane.root_id
      for update of lane;

      perform 1
      from ops.jobs as job
      join library.full_scan_intents as intent on intent.job_id = job.id
      join library.watcher_repairs as repair
        on repair.id = intent.watcher_repair_id
       and repair.library_id = intent.library_id
       and repair.state = 'scanning'
      where job.id = p_job_id
        and intent.id = v_intent_id
        and job.kind = 'full_scan'
        and job.subject_kind = 'full_scan_intent'
        and job.subject_ref = intent.id::text
        and job.library_id = intent.library_id
        and job.state = 'running'
        and intent.state = 'running'
        and job.attempt_count = v_attempt
        and job.lease_owner = p_worker_id
        and job.lease_token = p_lease_token
        and job.lease_expires_at > pg_catalog.clock_timestamp();
      if not found then
        return;
      end if;

      if exists (
        select 1
        from library.full_scan_intent_roots as intent_root
        join library.watcher_lanes as lane
          on lane.library_id = v_library_id
         and lane.root_id = intent_root.root_id
        where intent_root.intent_id = v_intent_id
          and (lane.running_generation_id is not null
               or lane.running_job_id is not null)
      ) then
        return;
      end if;
    end if;
  end if;

  select coalesce(nullif(
           library_record.metadata ->> 'inventory_mutation_revision', ''
         )::bigint, 0)
  into v_captured_revision
  from library.libraries as library_record
  where library_record.id = v_library_id;

  update library.full_scan_intents as intent
  set execution_attempt = v_attempt,
      captured_inventory_revision = v_captured_revision,
      progress_current = case
        when intent.execution_attempt is distinct from v_attempt
        then 0 else intent.progress_current end,
      progress_total = case
        when intent.execution_attempt is distinct from v_attempt
        then 0 else intent.progress_total end,
      progress_phase = case
        when intent.execution_attempt is distinct from v_attempt
        then 'preparing' else intent.progress_phase end,
      current_path = case
        when intent.execution_attempt is distinct from v_attempt
        then null else intent.current_path end,
      updated_at = greatest(intent.updated_at, pg_catalog.now())
  where intent.id = v_intent_id
    and intent.committed_inventory_revision is null
    and (
      intent.execution_attempt is distinct from v_attempt
      or intent.captured_inventory_revision is null
    );

  return query
  select intent.id,
         intent.library_id,
         intent.initiating_account_id,
         intent.mode,
         intent.force,
         pg_catalog.array_agg(
           root_record.metadata ->> 'root_id' order by intent_root.ordinal
         ),
         intent.captured_inventory_revision,
         intent.committed_inventory_revision,
         intent.watcher_repair_id,
    intent.captured_cover_mutation_revision
  from library.full_scan_intents as intent
  join library.full_scan_intent_roots as intent_root
    on intent_root.intent_id = intent.id
  join library.library_roots as root_record
    on root_record.id = intent_root.root_id
  where intent.id = v_intent_id
    and (
      intent.execution_attempt = v_attempt
      or intent.committed_inventory_revision is not null
    )
    and intent.captured_inventory_revision is not null
    and intent.captured_cover_mutation_revision is not null
  group by intent.id;
end;
$$;

drop function if exists library.load_claimed_targeted_reconciliation_intent_v2(
  bigint, character varying, character varying
);
create or replace function library.load_claimed_targeted_reconciliation_intent_v2(
  p_job_id bigint,
  p_worker_id varchar,
  p_lease_token varchar
)
returns table (
  intent_id bigint,
  library_id bigint,
  logical_root_id text,
  active_paths text[],
  deleted_paths text[],
  deleted_subtrees text[],
  preserved_subtrees text[],
  moves jsonb,
  exception_overrides jsonb,
  watcher_generation_kind varchar,
  captured_cover_mutation_revision bigint
)
language sql
security definer
set search_path = pg_catalog
as $$
  with legacy as materialized (
    select *
    from library.load_claimed_targeted_reconciliation_intent_legacy_0107(
      p_job_id, p_worker_id, p_lease_token
    )
  ), claimed as materialized (
    select intent.id, intent.library_id, intent.primary_root_id,
           intent.watcher_generation_kind,
           intent.captured_cover_mutation_revision
    from ops.jobs as job
    join library.targeted_reconciliation_intents as intent
      on intent.job_id = job.id
    where job.id = p_job_id
      and job.kind = 'targeted_reconciliation'
      and job.state = 'running'
      and job.lease_owner = p_worker_id
      and job.lease_token = p_lease_token
      and job.lease_expires_at > pg_catalog.clock_timestamp()
      and intent.captured_cover_mutation_revision is not null
  )
  select legacy.intent_id, legacy.library_id,
         case when claimed.watcher_generation_kind is null
           then legacy.logical_root_id
           else primary_root.metadata ->> 'root_id'
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.active_paths
           when claimed.watcher_generation_kind = 'root_catch_up' then coalesce((
             select pg_catalog.array_agg(root.root_path order by participant.root_id)
             from library.watcher_generation_participants as participant
             join library.library_roots as root
               on root.library_id = participant.library_id
              and root.id = participant.root_id
              and root.is_active is true
             where participant.generation_id = claimed.id
           ), array[]::text[])
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'active'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.deleted_paths
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'deleted'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.deleted_subtrees
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'deleted_subtree'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.preserved_subtrees
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'preserved_subtree'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.moves
           else coalesce((
             select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'source_path', source_root.root_path
                 || case library.local_path_style(source_root.root_path)
                      when 'windows' then E'\\' else '/' end
                 || move.source_relative_path,
               'destination_path', destination_root.root_path
                 || case library.local_path_style(destination_root.root_path)
                      when 'windows' then E'\\' else '/' end
                 || move.destination_relative_path,
               'source_root_ref', source_root.metadata ->> 'root_id',
               'destination_root_ref', destination_root.metadata ->> 'root_id',
               'is_directory', move.is_directory
             ) order by move.ordinal)
             from library.targeted_reconciliation_intent_moves as move
             join library.library_roots as source_root
               on source_root.library_id = move.library_id
              and source_root.id = move.source_root_id
              and source_root.is_active is true
             join library.library_roots as destination_root
               on destination_root.library_id = move.library_id
              and destination_root.id = move.destination_root_id
              and destination_root.is_active is true
             where move.intent_id = claimed.id
               and move.source_relative_path is not null
               and move.destination_relative_path is not null
           ), '[]'::jsonb)
         end,
         legacy.exception_overrides,
         claimed.watcher_generation_kind,
    claimed.captured_cover_mutation_revision
  from legacy
  join claimed on claimed.id = legacy.intent_id
  join library.library_roots as primary_root
    on primary_root.library_id = claimed.library_id
   and primary_root.id = claimed.primary_root_id;
$$;

alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_checkpoint_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_checkpoint_check check (checkpoint in (
    'accepted', 'download_started', 'artifact_written', 'selection_committed',
    'promotion_completed', 'authority_committed', 'runtime_published',
    'publication_completed', 'rolled_back', 'ambiguous'
  ));

alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_terminal_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_terminal_check check (
    (
      checkpoint in ('publication_completed', 'rolled_back', 'ambiguous')
      and completed_at is not null
    ) or (
      checkpoint not in ('publication_completed', 'rolled_back', 'ambiguous')
      and completed_at is null
    )
  );

alter table ops.cover_remote_save_checkpoints
  add column if not exists artifact_sha256 varchar(64);
alter table ops.cover_remote_save_checkpoints
  add column if not exists authority_cover_mutation_revision bigint;
alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_authority_revision_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_authority_revision_check check (
    authority_cover_mutation_revision is null
    or authority_cover_mutation_revision >= 0
  );
alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_artifact_sha256_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_artifact_sha256_check check (
    artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$'
  );

alter table ops.jobs drop constraint if exists jobs_kind_attempts_check;
alter table ops.jobs add constraint jobs_kind_attempts_check check (
  (kind = 'full_scan' and max_attempts = 2) or
  (kind = 'targeted_reconciliation' and max_attempts = 3) or
  (kind = 'post_scan_cover_refresh' and max_attempts = 2) or
  (kind = 'cover_lookup' and max_attempts = 2) or
  (kind = 'cover_bulk_refresh' and max_attempts = 2) or
  (kind = 'cover_remote_save' and max_attempts >= 1) or
  (kind = 'lastfm_scrobble_retry' and max_attempts = 1) or
  (kind = 'auth_welcome_delivery' and max_attempts = 3) or
  (kind = 'auth_invitation_delivery' and max_attempts = 1) or
  (kind = 'auth_password_reset_delivery' and max_attempts = 1)
);

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
  next_artifact_sha256 text,
  next_cover_revision text,
  next_reason_code text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  checkpoint_row ops.cover_remote_save_checkpoints%rowtype;
  next_revision bigint;
begin
  if next_artifact_sha256 is not null
     and next_artifact_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid artifact SHA-256' using errcode = '22023';
  end if;

  select checkpoint.* into checkpoint_row
  from ops.cover_remote_save_checkpoints as checkpoint
  join ops.jobs as job on job.id = checkpoint.job_id
  where checkpoint.id = requested_checkpoint_id
    and checkpoint.job_id = requested_job_id
    and checkpoint.row_revision = expected_row_revision
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > observed_at
  for update of checkpoint, job;
  if not found then
    return null;
  end if;

  if checkpoint_row.checkpoint = next_checkpoint then
    return checkpoint_row.row_revision;
  end if;
  if next_checkpoint in ('authority_committed', 'runtime_published', 'publication_completed')
     and coalesce(next_artifact_sha256, checkpoint_row.artifact_sha256) is null then
    return null;
  end if;
  if (checkpoint_row.checkpoint, next_checkpoint) not in (
    ('accepted', 'download_started'),
    ('accepted', 'artifact_written'),
    ('download_started', 'artifact_written'),
    ('artifact_written', 'selection_committed'),
    ('selection_committed', 'promotion_completed'),
    ('promotion_completed', 'publication_completed'),
    ('artifact_written', 'authority_committed'),
    ('authority_committed', 'runtime_published'),
    ('runtime_published', 'publication_completed')
  ) then
    return null;
  end if;

  update ops.cover_remote_save_checkpoints as checkpoint
  set checkpoint = next_checkpoint,
      artifact_key = coalesce(next_artifact_key, checkpoint.artifact_key),
      artifact_sha256 = coalesce(next_artifact_sha256, checkpoint.artifact_sha256),
      cover_revision = coalesce(next_cover_revision, checkpoint.cover_revision),
      reason_code = left(nullif(next_reason_code, ''), 128),
      row_revision = checkpoint.row_revision + 1,
      updated_at = observed_at,
      completed_at = case
        when next_checkpoint = 'publication_completed' then observed_at
        else null
      end
  where checkpoint.id = requested_checkpoint_id
    and checkpoint.row_revision = expected_row_revision
  returning checkpoint.row_revision into next_revision;
  return next_revision;
end;
$function$;

create or replace function library.apply_scanned_cover_observations(
  requested_library_id bigint,
  captured_cover_mutation_revision bigint,
  observed_covers jsonb,
  observed_at timestamptz
)
returns table (
  cover_publication_stale boolean,
  cover_mutation_revision bigint,
  changed_album_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, library
as $function$
declare
  current_revision bigint;
  changed_count integer;
  changed_file_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));

  insert into library.cover_mutation_state (library_id)
  values (requested_library_id)
  on conflict (library_id) do nothing;

  select state.cover_mutation_revision
  into current_revision
  from library.cover_mutation_state as state
  where state.library_id = requested_library_id
  for update;

  if current_revision <> captured_cover_mutation_revision then
    return query select true, current_revision, 0;
    return;
  end if;

  if jsonb_typeof(coalesce(observed_covers, '[]'::jsonb)) <> 'array' then
    raise exception 'observed covers must be a JSON array';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    where item.album_id is null
       or coalesce(cardinality(item.track_paths), 0) = 0
       or jsonb_typeof(coalesce(item.cover_state, '{}'::jsonb)) <> 'object'
       or (
         coalesce(item.cover_state, '{}'::jsonb) ? 'cover_path'
         and nullif(item.cover_state ->> 'cover_path', '')
             is distinct from nullif(item.cover_path, '')
       )
       or coalesce(item.cover_state, '{}'::jsonb) - array[
         'cover_path', 'cover_revision', 'cover_selection_origin',
         'remote_cover_url', 'remote_cover_thumbnail_url',
         'remote_cover_source', 'remote_cover_source_label',
         'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
       ]::text[] <> '{}'::jsonb
  ) then
    raise exception 'observed cover contains an invalid shape or unsupported key';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    group by item.album_id
    having count(*) <> 1
  ) or exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    cross join lateral unnest(item.track_paths) as path_value
    group by path_value
    having count(*) <> 1
  ) then
    raise exception 'observed cover identities must be unique';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    cross join lateral unnest(item.track_paths) as path_value
    where nullif(btrim(path_value), '') is null
       or (
         select count(*)
         from library.local_track_files as file
         join library.local_tracks as track on track.id = file.track_id
         join library.library_roots as root on root.id = file.library_root_id
         where file.private_path = path_value
           and track.library_id = requested_library_id
           and track.album_id = item.album_id
           and root.library_id = requested_library_id
           and root.is_active is true
       ) <> 1
  ) then
    raise exception 'observed cover identity does not belong to requested library and album';
  end if;

  with observations as materialized (
    select
      item.album_id,
      item.cover_path,
      coalesce(item.cover_state, '{}'::jsonb) as cover_state,
      item.track_paths
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint,
      cover_path text,
      cover_state jsonb,
      track_paths text[]
    )
  ), desired as materialized (
    select
      observation.album_id,
      observation.cover_path,
      observation.track_paths,
      (
        coalesce(album.metadata, '{}'::jsonb)
        - array[
          'cover_path', 'cover_revision', 'cover_selection_origin',
          'remote_cover_url', 'remote_cover_thumbnail_url',
          'remote_cover_source', 'remote_cover_source_label',
          'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
        ]::text[]
      )
      || (observation.cover_state - 'cover_path')
      || jsonb_strip_nulls(jsonb_build_object(
        'cover_path', observation.cover_path
      )) as album_metadata
    from observations as observation
    join library.local_albums as album
      on album.id = observation.album_id
     and album.library_id = requested_library_id
  ), changed_albums as (
    update library.local_albums as album
    set cover_path = desired.cover_path,
        metadata = desired.album_metadata
    from desired
    where album.id = desired.album_id
      and (album.cover_path, coalesce(album.metadata, '{}'::jsonb))
          is distinct from (desired.cover_path, desired.album_metadata)
    returning album.id
  ), changed_files as (
    update library.local_track_files as file
    set metadata = jsonb_set(
      coalesce(file.metadata, '{}'::jsonb),
      '{scan_cache,file_entry}',
      (
        coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
        - array[
          'cover_path', 'cover_revision',
          'remote_cover_url', 'remote_cover_thumbnail_url',
          'remote_cover_source', 'remote_cover_source_label',
          'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
        ]::text[]
      ) || jsonb_strip_nulls(coalesce((
        select jsonb_object_agg(entry.key, entry.value)
        from jsonb_each(desired.album_metadata) as entry(key, value)
        where entry.key = any(array[
          'cover_path', 'cover_revision',
          'remote_cover_url', 'remote_cover_thumbnail_url',
          'remote_cover_source', 'remote_cover_source_label',
          'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
        ]::text[])
      ), '{}'::jsonb)),
      true
    )
    from desired
    join library.local_tracks as track
      on track.library_id = requested_library_id
     and track.album_id = desired.album_id
    join library.library_roots as root
      on root.library_id = requested_library_id
     and root.is_active is true
    where file.track_id = track.id
      and file.library_root_id = root.id
      and file.private_path = any(desired.track_paths)
      and coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
          is distinct from (
            (
              coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
              - array[
                'cover_path', 'cover_revision',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
              ]::text[]
            ) || jsonb_strip_nulls(coalesce((
              select jsonb_object_agg(entry.key, entry.value)
              from jsonb_each(desired.album_metadata) as entry(key, value)
              where entry.key = any(array[
                'cover_path', 'cover_revision',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
              ]::text[])
            ), '{}'::jsonb))
          )
    returning file.id
  )
  select
    (select count(*)::integer from changed_albums),
    (select count(*)::integer from changed_files)
  into changed_count, changed_file_count;

  if changed_count > 0 or changed_file_count > 0 then
    update library.cover_mutation_state as state
    set cover_mutation_revision = state.cover_mutation_revision + 1,
        updated_at = observed_at
    where state.library_id = requested_library_id
    returning state.cover_mutation_revision into current_revision;
  end if;

  return query select false, current_revision, changed_count;
end;
$function$;

create or replace function library.persist_authorized_structural_tag_edit_noncover(
  bigint,
  text[],
  bigint,
  jsonb,
  jsonb,
  text[],
  timestamptz
)
returns table (
  input_path_count bigint,
  resolved_path_count bigint,
  source_album_track_file_count bigint,
  source_album_count bigint,
  destination_conflict_count bigint,
  destination_album_count bigint,
  album_rows_updated bigint,
  track_rows_updated bigint,
  track_file_rows_updated bigint,
  destination_album_id bigint,
  source_album_id bigint,
  source_library_id bigint,
  source_album_key text,
  destination_album_key text,
  separate_release_key text,
  inserted_destination_album boolean,
  inventory_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog, library, app
as $function$
declare
  requested_library_id alias for $1;
  requested_track_paths alias for $2;
  expected_inventory_revision alias for $3;
  input_rows alias for $4;
  destination_state alias for $5;
  changed_field_names alias for $6;
  observed_at alias for $7;
  current_inventory_revision bigint;
  updated_albums bigint;
  forbidden_cover_fields constant text[] := array[
    'cover_path', 'cover_revision', 'cover_selection_origin',
    'remote_cover_url', 'remote_cover_thumbnail_url',
    'remote_cover_source', 'remote_cover_source_label',
    'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
  ];
  allowed_destination_keys constant text[] := array[
    'destination_album_key', 'destination_artist_key',
    'destination_artist_name', 'destination_artist_metadata',
    'destination_album_title', 'destination_release_year',
    'destination_release_date', 'destination_edition',
    'destination_separate_release_key', 'destination_is_explicit_separate',
    'updates_release_year', 'source'
  ];
begin
  if requested_library_id is null
     or expected_inventory_revision is null
     or observed_at is null
     or coalesce(cardinality(requested_track_paths), 0) = 0
     or jsonb_typeof(input_rows) <> 'array'
     or jsonb_typeof(destination_state) <> 'object'
     or destination_state - allowed_destination_keys <> '{}'::jsonb then
    raise exception 'structural tag edit input is invalid' using errcode = '22023';
  end if;
  if changed_field_names && forbidden_cover_fields
     or exists (
       select 1
       from jsonb_array_elements(input_rows) as item(value)
       where jsonb_typeof(item.value) <> 'object'
          or coalesce(item.value -> 'file_entry', '{}'::jsonb)
             ?| forbidden_cover_fields
     )
     or coalesce(destination_state -> 'destination_artist_metadata', '{}'::jsonb)
        ?| forbidden_cover_fields then
    raise exception 'structural tag edit cannot mutate cover fields'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(
    nullif(library_row.metadata ->> 'inventory_mutation_revision', '')::bigint,
    0
  )
  into current_inventory_revision
  from library.libraries as library_row
  where library_row.id = requested_library_id
  for update;
  if not found or current_inventory_revision <> expected_inventory_revision then
    raise exception 'structural tag edit inventory revision conflict'
      using errcode = '40001';
  end if;

  if coalesce((destination_state ->> 'updates_release_year')::boolean, false) then
    return query
with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from library.libraries
          where library.libraries.id = requested_library_id
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(requested_track_paths::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(input_rows::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
            input_rows.file_entry
          from bootstrap_context
          join library.local_track_files on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
          join input_rows
            on input_rows.private_path = library.local_track_files.private_path
          where coalesce(
            (
              library.local_track_files.metadata
                #>> '{scan_cache,stale}'
            )::boolean,
            false
          ) is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.source_album_id) as source_album_count,
            min(selected_track_files.source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id as track_file_id
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = selection_scope.source_album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and coalesce(
                 (
                   library.local_track_files.metadata
                     #>> '{scan_cache,stale}'
                 )::boolean,
                 false
               ) is false
        ),
        source_album_identity as materialized (
          select
            library.local_albums.id,
            library.local_albums.artist_id,
            library.local_albums.release_year
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.id = selection_scope.source_album_id
        ),
        locked_album_scope as materialized (
          select
            library.local_albums.id,
            library.local_albums.library_id,
            library.local_albums.album_key,
            library.local_albums.artist_id,
            library.local_albums.title,
            library.local_albums.release_year,
            library.local_albums.cover_path,
            library.local_albums.metadata
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join source_album_identity on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and (
                 library.local_albums.id = selection_scope.source_album_id
                 or library.local_albums.album_key = (destination_state ->> 'destination_album_key')
                 or (
                      library.local_albums.artist_id is not distinct from
                        source_album_identity.artist_id
                      and lower(btrim(library.local_albums.title)) =
                        lower(btrim((destination_state ->> 'destination_album_title')))
                      and library.local_albums.release_year is not distinct from
                        case
                          when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                          then nullif(destination_state ->> 'destination_release_year', '')::integer
                          else source_album_identity.release_year
                        end
                      and lower(
                            btrim(
                              coalesce(
                                library.local_albums.metadata ->> 'edition',
                                ''
                              )
                            )
                          ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                    )
               )
          order by library.local_albums.id
          for update of local_albums
        ),
        existing_destination_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.album_key
          from locked_album_scope
          join selection_scope on true
          where locked_album_scope.id <> selection_scope.source_album_id
            and not (
                  coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                  and (select input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
            and (
                  locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
                  or (
                       locked_album_scope.artist_id is not distinct from
                         (select artist_id from source_album_identity)
                       and lower(btrim(locked_album_scope.title)) =
                         lower(btrim((destination_state ->> 'destination_album_title')))
                       and locked_album_scope.release_year is not distinct from
                         case
                           when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                           then nullif(destination_state ->> 'destination_release_year', '')::integer
                           else (
                             select release_year
                             from source_album_identity
                           )
                         end
                       and lower(
                             btrim(
                               coalesce(
                                 locked_album_scope.metadata ->> 'edition',
                                 ''
                               )
                             )
                           ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                     )
                )
          order by
            case
              when locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
              then 0
              else 1
            end,
            locked_album_scope.id
          limit 1
        ),
        validated_source_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.library_id,
            locked_album_scope.album_key,
            locked_album_scope.artist_id,
            locked_album_scope.release_year,
            locked_album_scope.cover_path,
            (
              coalesce(locked_album_scope.metadata, '{}'::jsonb)
              - array[
                'cover_path', 'cover_revision', 'cover_selection_origin',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width',
                'remote_cover_height'
              ]::text[]
            ) as metadata,
            exists (
              select 1
              from source_album_track_files
              join library.local_track_files
                on library.local_track_files.id =
                   source_album_track_files.track_file_id
              where locked_album_scope.release_year is not null
                and library.local_track_files.metadata
                      #>> '{scan_cache,file_entry,year}' ~ '^[+-]?[0-9]+$'
                and (
                      library.local_track_files.metadata
                        #>> '{scan_cache,file_entry,year}'
                    )::bigint <> locked_album_scope.release_year
            ) as has_display_year_override
          from selection_scope
          join locked_album_scope
            on locked_album_scope.id = selection_scope.source_album_id
          where selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.source_album_count = 1
            and selection_scope.input_path_count <= (
                  select count(*) from source_album_track_files
                )
        ),
        marked_partial_source_album as (
          update library.local_albums
          set metadata = jsonb_set(
                coalesce(library.local_albums.metadata, '{}'::jsonb),
                '{release_date}',
                to_jsonb(coalesce(
                  nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                  validated_source_album.release_year::text
                )),
                true
              )
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and validated_source_album.has_display_year_override
            and (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
          returning library.local_albums.id
        ),
        normalized_existing_destination_album as (
          update library.local_albums
          set release_year = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                 and nullif(btrim(library.local_albums.metadata ->> 'release_date'), '') is null
                then validated_source_album.release_year
                else library.local_albums.release_year
              end,
              metadata = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                then jsonb_set(
                       coalesce(library.local_albums.metadata, '{}'::jsonb),
                       '{release_date}',
                       to_jsonb(coalesce(
                         nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                         nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                         validated_source_album.release_year::text
                       )),
                       true
                     )
                else library.local_albums.metadata
              end,
              last_seen_at = observed_at
          from validated_source_album
          join existing_destination_album on true
          where library.local_albums.id = existing_destination_album.id
          returning library.local_albums.id, library.local_albums.album_key
        ),
        updated_album_ratings as (
          update app.album_ratings
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                 and (select input_path_count from selection_scope) = (
                       select count(*) from source_album_track_files
                     )
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              updated_at = observed_at
          from validated_source_album
          where app.album_ratings.library_id = validated_source_album.library_id
            and app.album_ratings.album_key = validated_source_album.album_key
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning app.album_ratings.id
        ),
        renamed_source_album as (
          update library.local_albums
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              title = (destination_state ->> 'destination_album_title'),
              release_year = case
                when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                then nullif(destination_state ->> 'destination_release_year', '')::integer
                else library.local_albums.release_year
              end
        
              , metadata = case
                  when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb((destination_state ->> 'destination_release_date')::text),
                         true
                       )
                  when validated_source_album.has_display_year_override
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb(coalesce(
                           nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                           validated_source_album.release_year::text
                         )),
                         true
                       )
                  else library.local_albums.metadata
                end
        ,
              last_seen_at = observed_at
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        inserted_destination_artist as (
          insert into library.local_artists (
            library_id, artist_key, name, sort_name, metadata
          )
          select validated_source_album.library_id,
                 (destination_state ->> 'destination_artist_key'), (destination_state ->> 'destination_artist_name'),
                 lower((destination_state ->> 'destination_artist_name')),
                 jsonb_build_object('source', (destination_state ->> 'source')::text)
          from validated_source_album
          where (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          on conflict (library_id, artist_key) do update
            set last_seen_at = observed_at
          returning library.local_artists.id
        ),
        inserted_destination_album as (
          insert into library.local_albums (
            library_id,
            artist_id,
            album_key,
            title,
            release_year,
            metadata
          )
          select
            validated_source_album.library_id,
            (select id from inserted_destination_artist),
            (destination_state ->> 'destination_album_key'),
            (destination_state ->> 'destination_album_title'),
            case
              when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
              then nullif(destination_state ->> 'destination_release_year', '')::integer
              else validated_source_album.release_year
            end,
        (
            validated_source_album.metadata
              || jsonb_build_object(
                   'release_date',
                   (destination_state ->> 'destination_release_date')::text
                 )
        ) || coalesce(destination_state -> 'destination_artist_metadata', '{}'::jsonb)::jsonb
          from validated_source_album
          where (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        destination_album as materialized (
          select
            normalized_existing_destination_album.id,
            normalized_existing_destination_album.album_key
          from normalized_existing_destination_album
          where exists (select 1 from validated_source_album)
          union all
          select
            renamed_source_album.id,
            renamed_source_album.album_key
          from renamed_source_album
          union all
          select
            inserted_destination_album.id,
            inserted_destination_album.album_key
          from inserted_destination_album
        ),
        inserted_separate_release as (
          insert into library.separate_releases (
            library_id,
            release_key,
            metadata
          )
          select
            bootstrap_context.library_id,
            (destination_state ->> 'destination_separate_release_key')::text,
            jsonb_build_object('source', (destination_state ->> 'source')::text)
          from bootstrap_context
          where coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
            and exists (select 1 from destination_album)
          on conflict (library_id, release_key) do nothing
          returning library.separate_releases.release_key
        ),
        copied_album_ratings as (
          insert into app.album_ratings (
            account_id,
            library_id,
            album_key,
            rating,
            provenance,
            metadata
          )
          select
            app.album_ratings.account_id,
            app.album_ratings.library_id,
            destination_album.album_key,
            app.album_ratings.rating,
            app.album_ratings.provenance,
            app.album_ratings.metadata
          from app.album_ratings
          join validated_source_album
            on validated_source_album.library_id = app.album_ratings.library_id
           and validated_source_album.album_key = app.album_ratings.album_key
          cross join destination_album
          where exists (select 1 from inserted_destination_album)
             or (
                  exists (select 1 from existing_destination_album)
                  and (select input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
          on conflict (account_id, library_id, album_key) do nothing
          returning app.album_ratings.id
        ),
        copied_featured_artists as (
          insert into library.local_album_featured_artists (
            library_id,
            album_id,
            artist_id,
            featured_kind,
            metadata
          )
          select
            library.local_album_featured_artists.library_id,
            destination_album.id,
            library.local_album_featured_artists.artist_id,
            library.local_album_featured_artists.featured_kind,
            library.local_album_featured_artists.metadata
          from library.local_album_featured_artists
          join validated_source_album
            on validated_source_album.id =
               library.local_album_featured_artists.album_id
          cross join destination_album
          where not exists (select 1 from inserted_destination_album)
             or library.local_album_featured_artists.metadata ->> 'source'
                  is distinct from (destination_state ->> 'source')
          on conflict (library_id, album_id, artist_id, featured_kind) do nothing
          returning library.local_album_featured_artists.id
        ),
        updated_album_mbid_assertions as (
          update library.local_mbid_assertions
          set album_id = destination_album.id,
              target_key = case
                when library.local_mbid_assertions.target_kind = 'album'
                then destination_album.album_key
                else library.local_mbid_assertions.target_key
              end
          from validated_source_album
          cross join destination_album
          where library.local_mbid_assertions.album_id = validated_source_album.id
            and exists (select 1 from existing_destination_album)
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
          returning library.local_mbid_assertions.id
        ),
        updated_tracks as (
          update library.local_tracks
          set album_id = (select destination_album.id from destination_album),
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case
                     when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object(
                            'album',
                            selected_track_files.file_entry -> 'album'
                          )
                     else '{}'::jsonb
                   end,
              last_seen_at = observed_at
          from selected_track_files
          where library.local_tracks.id = selected_track_files.track_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'source', (destination_state ->> 'source')::text,
                       'stale', false,
                       'file_entry',
                       coalesce(
                         library.local_track_files.metadata #> '{scan_cache,file_entry}',
                         '{}'::jsonb
                       ) || selected_track_files.file_entry
                     ),
                true
              ),
              last_seen_at = observed_at
          from selected_track_files
          where library.local_track_files.id = selected_track_files.track_file_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_track_files.id
        ),
        vacated_source_album as materialized (
          select validated_source_album.id
          from validated_source_album
          where exists (select 1 from existing_destination_album)
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and (select count(*) from updated_tracks) =
                (select input_path_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
        ),
        deleted_destination_separate_release as (
          delete from library.separate_releases
          using bootstrap_context, vacated_source_album
          where library.separate_releases.library_id =
                bootstrap_context.library_id
            and library.separate_releases.release_key =
                (destination_state ->> 'destination_separate_release_key')
            and not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
          returning library.separate_releases.release_key
        ),
        updated_library as (
          update library.libraries
          set metadata = jsonb_set(
                coalesce(library.libraries.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'inventory_mutation_revision',
                       coalesce(
                         nullif(
                           library.libraries.metadata ->> 'inventory_mutation_revision',
                           ''
                         )::bigint,
                         0
                       ) + 1
                     ),
                '{scan_cache}',
                coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'relation_projection',
                       coalesce(
                         library.libraries.metadata #> '{scan_cache,relation_projection}',
                         '{}'::jsonb
                       ) || jsonb_build_object(
                         'status', 'stale',
                         'rebuild_reason', 'structural_tag_edit'
                       )
                     ),
                true
              ),
              updated_at = observed_at
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
            and (select count(*) from updated_tracks) =
                (select input_path_count from selection_scope)
            and (select count(*) from destination_album) = 1
            and (select count(*) from deleted_destination_separate_release) >= 0
            and (
                  not exists (select 1 from existing_destination_album)
                  or (select input_path_count from selection_scope) < (
                       select count(*) from source_album_track_files
                     )
                  or (select count(*) from vacated_source_album) = 1
                )
          returning coalesce(
            nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          0 as destination_conflict_count,
          (select count(*) from destination_album) as destination_album_count,
          (select id from destination_album) as destination_album_id,
          (select id from validated_source_album) as source_album_id,
          (select library_id from validated_source_album) as source_library_id,
          (select album_key from validated_source_album) as source_album_key,
          (select album_key from destination_album) as destination_album_key,
          exists (select 1 from inserted_destination_album) as inserted_destination_album,
          (select count(*) from destination_album) as album_rows_updated,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce(
            (select inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision,
          case
            when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
             and exists (select 1 from destination_album)
            then (destination_state ->> 'destination_separate_release_key')::text
            else null
          end as separate_release_key;;
  else
    return query
with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from library.libraries
          where library.libraries.id = requested_library_id
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(requested_track_paths::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(input_rows::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
            input_rows.file_entry
          from bootstrap_context
          join library.local_track_files on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
          join input_rows
            on input_rows.private_path = library.local_track_files.private_path
          where coalesce(
            (
              library.local_track_files.metadata
                #>> '{scan_cache,stale}'
            )::boolean,
            false
          ) is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.source_album_id) as source_album_count,
            min(selected_track_files.source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id as track_file_id
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = selection_scope.source_album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and coalesce(
                 (
                   library.local_track_files.metadata
                     #>> '{scan_cache,stale}'
                 )::boolean,
                 false
               ) is false
        ),
        source_album_identity as materialized (
          select
            library.local_albums.id,
            library.local_albums.artist_id,
            library.local_albums.release_year
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.id = selection_scope.source_album_id
        ),
        locked_album_scope as materialized (
          select
            library.local_albums.id,
            library.local_albums.library_id,
            library.local_albums.album_key,
            library.local_albums.artist_id,
            library.local_albums.title,
            library.local_albums.release_year,
            library.local_albums.cover_path,
            library.local_albums.metadata
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join source_album_identity on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and (
                 library.local_albums.id = selection_scope.source_album_id
                 or library.local_albums.album_key = (destination_state ->> 'destination_album_key')
                 or (
                      library.local_albums.artist_id is not distinct from
                        source_album_identity.artist_id
                      and lower(btrim(library.local_albums.title)) =
                        lower(btrim((destination_state ->> 'destination_album_title')))
                      and library.local_albums.release_year is not distinct from
                        case
                          when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                          then nullif(destination_state ->> 'destination_release_year', '')::integer
                          else source_album_identity.release_year
                        end
                      and lower(
                            btrim(
                              coalesce(
                                library.local_albums.metadata ->> 'edition',
                                ''
                              )
                            )
                          ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                    )
               )
          order by library.local_albums.id
          for update of local_albums
        ),
        existing_destination_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.album_key
          from locked_album_scope
          join selection_scope on true
          where locked_album_scope.id <> selection_scope.source_album_id
            and not (
                  coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                  and (select input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
            and (
                  locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
                  or (
                       locked_album_scope.artist_id is not distinct from
                         (select artist_id from source_album_identity)
                       and lower(btrim(locked_album_scope.title)) =
                         lower(btrim((destination_state ->> 'destination_album_title')))
                       and locked_album_scope.release_year is not distinct from
                         case
                           when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                           then nullif(destination_state ->> 'destination_release_year', '')::integer
                           else (
                             select release_year
                             from source_album_identity
                           )
                         end
                       and lower(
                             btrim(
                               coalesce(
                                 locked_album_scope.metadata ->> 'edition',
                                 ''
                               )
                             )
                           ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                     )
                )
          order by
            case
              when locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
              then 0
              else 1
            end,
            locked_album_scope.id
          limit 1
        ),
        validated_source_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.library_id,
            locked_album_scope.album_key,
            locked_album_scope.artist_id,
            locked_album_scope.release_year,
            locked_album_scope.cover_path,
            (
              coalesce(locked_album_scope.metadata, '{}'::jsonb)
              - array[
                'cover_path', 'cover_revision', 'cover_selection_origin',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width',
                'remote_cover_height'
              ]::text[]
            ) as metadata,
            exists (
              select 1
              from source_album_track_files
              join library.local_track_files
                on library.local_track_files.id =
                   source_album_track_files.track_file_id
              where locked_album_scope.release_year is not null
                and library.local_track_files.metadata
                      #>> '{scan_cache,file_entry,year}' ~ '^[+-]?[0-9]+$'
                and (
                      library.local_track_files.metadata
                        #>> '{scan_cache,file_entry,year}'
                    )::bigint <> locked_album_scope.release_year
            ) as has_display_year_override
          from selection_scope
          join locked_album_scope
            on locked_album_scope.id = selection_scope.source_album_id
          where selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.source_album_count = 1
            and selection_scope.input_path_count <= (
                  select count(*) from source_album_track_files
                )
        ),
        marked_partial_source_album as (
          update library.local_albums
          set metadata = jsonb_set(
                coalesce(library.local_albums.metadata, '{}'::jsonb),
                '{release_date}',
                to_jsonb(coalesce(
                  nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                  validated_source_album.release_year::text
                )),
                true
              )
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and validated_source_album.has_display_year_override
            and (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
          returning library.local_albums.id
        ),
        normalized_existing_destination_album as (
          update library.local_albums
          set release_year = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                 and nullif(btrim(library.local_albums.metadata ->> 'release_date'), '') is null
                then validated_source_album.release_year
                else library.local_albums.release_year
              end,
              metadata = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                then jsonb_set(
                       coalesce(library.local_albums.metadata, '{}'::jsonb),
                       '{release_date}',
                       to_jsonb(coalesce(
                         nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                         nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                         validated_source_album.release_year::text
                       )),
                       true
                     )
                else library.local_albums.metadata
              end,
              last_seen_at = observed_at
          from validated_source_album
          join existing_destination_album on true
          where library.local_albums.id = existing_destination_album.id
          returning library.local_albums.id, library.local_albums.album_key
        ),
        updated_album_ratings as (
          update app.album_ratings
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                 and (select input_path_count from selection_scope) = (
                       select count(*) from source_album_track_files
                     )
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              updated_at = observed_at
          from validated_source_album
          where app.album_ratings.library_id = validated_source_album.library_id
            and app.album_ratings.album_key = validated_source_album.album_key
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning app.album_ratings.id
        ),
        renamed_source_album as (
          update library.local_albums
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              title = (destination_state ->> 'destination_album_title'),
              release_year = case
                when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                then nullif(destination_state ->> 'destination_release_year', '')::integer
                else library.local_albums.release_year
              end
        
              , metadata = case
                  when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb((destination_state ->> 'destination_release_date')::text),
                         true
                       )
                  when validated_source_album.has_display_year_override
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb(coalesce(
                           nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                           validated_source_album.release_year::text
                         )),
                         true
                       )
                  else library.local_albums.metadata
                end
    ,
              last_seen_at = observed_at
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        inserted_destination_artist as (
          insert into library.local_artists (
            library_id, artist_key, name, sort_name, metadata
          )
          select validated_source_album.library_id,
                 (destination_state ->> 'destination_artist_key'), (destination_state ->> 'destination_artist_name'),
                 lower((destination_state ->> 'destination_artist_name')),
                 jsonb_build_object('source', (destination_state ->> 'source')::text)
          from validated_source_album
          where (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          on conflict (library_id, artist_key) do update
            set last_seen_at = observed_at
          returning library.local_artists.id
        ),
        inserted_destination_album as (
          insert into library.local_albums (
            library_id,
            artist_id,
            album_key,
            title,
            release_year,
            metadata
          )
          select
            validated_source_album.library_id,
            (select id from inserted_destination_artist),
            (destination_state ->> 'destination_album_key'),
            (destination_state ->> 'destination_album_title'),
            case
              when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
              then nullif(destination_state ->> 'destination_release_year', '')::integer
              else validated_source_album.release_year
            end,
        (
            case
              when validated_source_album.has_display_year_override
              then jsonb_set(
                     validated_source_album.metadata,
                     '{release_date}',
                     to_jsonb(coalesce(
                       nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                       validated_source_album.release_year::text
                     )),
                     true
                   )
              else validated_source_album.metadata
            end
    ) || coalesce(destination_state -> 'destination_artist_metadata', '{}'::jsonb)::jsonb
          from validated_source_album
          where (select input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        destination_album as materialized (
          select
            normalized_existing_destination_album.id,
            normalized_existing_destination_album.album_key
          from normalized_existing_destination_album
          where exists (select 1 from validated_source_album)
          union all
          select
            renamed_source_album.id,
            renamed_source_album.album_key
          from renamed_source_album
          union all
          select
            inserted_destination_album.id,
            inserted_destination_album.album_key
          from inserted_destination_album
        ),
        inserted_separate_release as (
          insert into library.separate_releases (
            library_id,
            release_key,
            metadata
          )
          select
            bootstrap_context.library_id,
            (destination_state ->> 'destination_separate_release_key')::text,
            jsonb_build_object('source', (destination_state ->> 'source')::text)
          from bootstrap_context
          where coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
            and exists (select 1 from destination_album)
          on conflict (library_id, release_key) do nothing
          returning library.separate_releases.release_key
        ),
        copied_album_ratings as (
          insert into app.album_ratings (
            account_id,
            library_id,
            album_key,
            rating,
            provenance,
            metadata
          )
          select
            app.album_ratings.account_id,
            app.album_ratings.library_id,
            destination_album.album_key,
            app.album_ratings.rating,
            app.album_ratings.provenance,
            app.album_ratings.metadata
          from app.album_ratings
          join validated_source_album
            on validated_source_album.library_id = app.album_ratings.library_id
           and validated_source_album.album_key = app.album_ratings.album_key
          cross join destination_album
          where exists (select 1 from inserted_destination_album)
             or (
                  exists (select 1 from existing_destination_album)
                  and (select input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
          on conflict (account_id, library_id, album_key) do nothing
          returning app.album_ratings.id
        ),
        copied_featured_artists as (
          insert into library.local_album_featured_artists (
            library_id,
            album_id,
            artist_id,
            featured_kind,
            metadata
          )
          select
            library.local_album_featured_artists.library_id,
            destination_album.id,
            library.local_album_featured_artists.artist_id,
            library.local_album_featured_artists.featured_kind,
            library.local_album_featured_artists.metadata
          from library.local_album_featured_artists
          join validated_source_album
            on validated_source_album.id =
               library.local_album_featured_artists.album_id
          cross join destination_album
          where not exists (select 1 from inserted_destination_album)
             or library.local_album_featured_artists.metadata ->> 'source'
                  is distinct from (destination_state ->> 'source')
          on conflict (library_id, album_id, artist_id, featured_kind) do nothing
          returning library.local_album_featured_artists.id
        ),
        updated_album_mbid_assertions as (
          update library.local_mbid_assertions
          set album_id = destination_album.id,
              target_key = case
                when library.local_mbid_assertions.target_kind = 'album'
                then destination_album.album_key
                else library.local_mbid_assertions.target_key
              end
          from validated_source_album
          cross join destination_album
          where library.local_mbid_assertions.album_id = validated_source_album.id
            and exists (select 1 from existing_destination_album)
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
          returning library.local_mbid_assertions.id
        ),
        updated_tracks as (
          update library.local_tracks
          set album_id = (select destination_album.id from destination_album),
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case
                     when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object(
                            'album',
                            selected_track_files.file_entry -> 'album'
                          )
                     else '{}'::jsonb
                   end,
              last_seen_at = observed_at
          from selected_track_files
          where library.local_tracks.id = selected_track_files.track_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'source', (destination_state ->> 'source')::text,
                       'stale', false,
                       'file_entry',
                       coalesce(
                         library.local_track_files.metadata #> '{scan_cache,file_entry}',
                         '{}'::jsonb
                       ) || selected_track_files.file_entry
                     ),
                true
              ),
              last_seen_at = observed_at
          from selected_track_files
          where library.local_track_files.id = selected_track_files.track_file_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_track_files.id
        ),
        vacated_source_album as materialized (
          select validated_source_album.id
          from validated_source_album
          where exists (select 1 from existing_destination_album)
            and (select input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and (select count(*) from updated_tracks) =
                (select input_path_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
        ),
        deleted_destination_separate_release as (
          delete from library.separate_releases
          using bootstrap_context, vacated_source_album
          where library.separate_releases.library_id =
                bootstrap_context.library_id
            and library.separate_releases.release_key =
                (destination_state ->> 'destination_separate_release_key')
            and not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
          returning library.separate_releases.release_key
        ),
        updated_library as (
          update library.libraries
          set metadata = jsonb_set(
                coalesce(library.libraries.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'inventory_mutation_revision',
                       coalesce(
                         nullif(
                           library.libraries.metadata ->> 'inventory_mutation_revision',
                           ''
                         )::bigint,
                         0
                       ) + 1
                     ),
                '{scan_cache}',
                coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'relation_projection',
                       coalesce(
                         library.libraries.metadata #> '{scan_cache,relation_projection}',
                         '{}'::jsonb
                       ) || jsonb_build_object(
                         'status', 'stale',
                         'rebuild_reason', 'structural_tag_edit'
                       )
                     ),
                true
              ),
              updated_at = observed_at
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_track_files) =
                (select input_path_count from selection_scope)
            and (select count(*) from updated_tracks) =
                (select input_path_count from selection_scope)
            and (select count(*) from destination_album) = 1
            and (select count(*) from deleted_destination_separate_release) >= 0
            and (
                  not exists (select 1 from existing_destination_album)
                  or (select input_path_count from selection_scope) < (
                       select count(*) from source_album_track_files
                     )
                  or (select count(*) from vacated_source_album) = 1
                )
          returning coalesce(
            nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select input_path_count from selection_scope) as input_path_count,
          (select resolved_path_count from selection_scope) as resolved_path_count,
          (select source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          0 as destination_conflict_count,
          (select count(*) from destination_album) as destination_album_count,
          (select id from destination_album) as destination_album_id,
          (select id from validated_source_album) as source_album_id,
          (select library_id from validated_source_album) as source_library_id,
          (select album_key from validated_source_album) as source_album_key,
          (select album_key from destination_album) as destination_album_key,
          exists (select 1 from inserted_destination_album) as inserted_destination_album,
          (select count(*) from destination_album) as album_rows_updated,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce(
            (select inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision,
          case
            when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
             and exists (select 1 from destination_album)
            then (destination_state ->> 'destination_separate_release_key')::text
            else null
          end as separate_release_key;;
  end if;
end;
$function$;

create or replace function ops.load_claimed_cover_finalization(
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz
)
returns table (
  checkpoint_id bigint,
  checkpoint text,
  checkpoint_revision bigint,
  library_id bigint,
  local_album_id bigint,
  task_id bigint,
  cover_mutation_revision bigint,
  selected_cover_revision text
)
language sql
security definer
set search_path = pg_catalog, ops
as $function$
  select checkpoint_row.id,
         checkpoint_row.checkpoint::text,
         checkpoint_row.row_revision,
         task.library_id,
         task.local_album_id,
         task.id,
         checkpoint_row.authority_cover_mutation_revision,
         checkpoint_row.cover_revision
  from ops.jobs as job
  join ops.cover_remote_save_checkpoints as checkpoint_row
    on checkpoint_row.job_id = job.id
  join ops.cover_lookup_tasks as task on task.id = checkpoint_row.task_id
  where job.id = requested_job_id
    and job.kind = 'cover_remote_save'
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > clock_timestamp()
    and checkpoint_row.checkpoint in (
      'authority_committed', 'runtime_published', 'publication_completed'
    )
    and checkpoint_row.authority_cover_mutation_revision is not null
    and checkpoint_row.cover_revision is not null;
$function$;

create or replace function ops.advance_claimed_cover_finalization(
  requested_checkpoint_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  expected_checkpoint_revision bigint,
  next_checkpoint text,
  observed_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  current_checkpoint text;
  current_revision bigint;
begin
  if next_checkpoint not in ('runtime_published', 'publication_completed') then
    raise exception 'invalid cover finalization checkpoint' using errcode = '22023';
  end if;

  select checkpoint_row.checkpoint, checkpoint_row.row_revision
  into current_checkpoint, current_revision
  from ops.jobs as job
  join ops.cover_remote_save_checkpoints as checkpoint_row
    on checkpoint_row.job_id = job.id
  where checkpoint_row.id = requested_checkpoint_id
    and job.id = requested_job_id
    and job.kind = 'cover_remote_save'
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > clock_timestamp()
  for update of job, checkpoint_row;
  if not found then return null; end if;

  if current_checkpoint = next_checkpoint
     and current_revision in (
       expected_checkpoint_revision,
       expected_checkpoint_revision + 1
     ) then
    return current_revision;
  end if;
  if current_revision <> expected_checkpoint_revision
     or (current_checkpoint, next_checkpoint) not in (
       ('authority_committed', 'runtime_published'),
       ('runtime_published', 'publication_completed')
     ) then
    return null;
  end if;

  update ops.cover_remote_save_checkpoints as checkpoint_row
  set checkpoint = next_checkpoint,
      row_revision = checkpoint_row.row_revision + 1,
      updated_at = observed_at,
      completed_at = case
        when next_checkpoint = 'publication_completed' then observed_at
        else null
      end
  where checkpoint_row.id = requested_checkpoint_id
    and checkpoint_row.row_revision = expected_checkpoint_revision
  returning checkpoint_row.row_revision into current_revision;
  return current_revision;
end;
$function$;

create or replace function ops.retry_claimed_cover_finalization(
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  retry_at timestamptz,
  reason_code text,
  observed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  moved_job ops.jobs%rowtype;
begin
  update ops.jobs as job
  set state = 'retry_wait',
      scheduled_at = retry_at,
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      heartbeat_at = null,
      outcome_code = reason_code,
      updated_at = observed_at
  from ops.cover_remote_save_checkpoints as checkpoint_row
  where job.id = requested_job_id
    and checkpoint_row.job_id = job.id
    and checkpoint_row.checkpoint in ('authority_committed', 'runtime_published')
    and job.kind = 'cover_remote_save'
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > clock_timestamp()
  returning job.* into moved_job;

  if not found then return false; end if;
  insert into ops.job_transitions (
    job_id, prior_state, next_state, attempt_count, reason_code,
    retry_decision, next_due_at, worker_instance_id, transitioned_at
  ) values (
    moved_job.id, 'running', 'retry_wait', moved_job.attempt_count,
    reason_code, 'scheduled', retry_at, requested_worker_id, observed_at
  );
  return true;
end;
$function$;

create or replace function ops.requeue_expired_cover_finalization(
  observed_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  moved_count bigint;
begin
  with candidates as materialized (
    select job.id
    from ops.jobs as job
    join ops.cover_remote_save_checkpoints as checkpoint_row
      on checkpoint_row.job_id = job.id
    where job.kind = 'cover_remote_save'
      and job.state = 'running'
      and job.lease_expires_at <= clock_timestamp()
      and checkpoint_row.checkpoint in (
        'authority_committed', 'runtime_published', 'publication_completed'
      )
    order by job.id
    for update of job skip locked
  ), moved as (
    update ops.jobs as job
    set state = 'retry_wait',
        scheduled_at = transaction_timestamp(),
        max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        heartbeat_at = null,
        outcome_code = 'cover_finalization_lease_expired',
        updated_at = transaction_timestamp()
    from candidates
    where job.id = candidates.id
    returning job.id, job.attempt_count
  )
  insert into ops.job_transitions (
    job_id, prior_state, next_state, attempt_count, reason_code,
    retry_decision, next_due_at, transitioned_at
  )
  select id, 'running', 'retry_wait', attempt_count,
         'cover_finalization_lease_expired', 'scheduled',
         transaction_timestamp(), transaction_timestamp()
  from moved;

  get diagnostics moved_count = row_count;
  return moved_count;
end;
$function$;

create or replace function ops.reconcile_stale_job_leases(
  observed_at timestamptz,
  requested_limit integer
)
returns table (
  retried_count bigint,
  failed_count bigint,
  ambiguous_count bigint,
  canceled_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  retried bigint := 0;
  failed bigint := 0;
  ambiguous bigint := 0;
  canceled bigint := 0;
begin
  if requested_limit is null or requested_limit not between 1 and 1000 then
    raise exception 'stale lease reconciliation limit is invalid'
      using errcode = '22023';
  end if;

  with stale as materialized (
    select
      job.id,
      job.attempt_count,
      job.max_attempts,
      job.recovery_policy,
      job.cancel_requested_at,
      job.recovery_policy = 'retry_safe'
        and job.attempt_count < job.max_attempts as can_retry
    from ops.jobs as job
    where job.state = 'running'
      and job.lease_expires_at <= clock_timestamp()
      and not exists (
        select 1
        from ops.cover_remote_save_checkpoints as checkpoint_row
        where checkpoint_row.job_id = job.id
          and checkpoint_row.checkpoint in (
            'authority_committed', 'runtime_published', 'publication_completed'
          )
      )
    order by job.lease_expires_at, job.id
    limit requested_limit
    for update of job skip locked
  ), classified as materialized (
    select *, case
      when cancel_requested_at is not null then 'canceled'
      when can_retry then 'retry_wait'
      when recovery_policy = 'hold_ambiguous' then 'ambiguous'
      else 'failed'
    end as next_state
    from stale
  ), moved as (
    update ops.jobs as job
    set state = classified.next_state,
        scheduled_at = case
          when classified.next_state = 'retry_wait' then transaction_timestamp()
          else job.scheduled_at
        end,
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        heartbeat_at = null,
        outcome_code = case classified.next_state
          when 'retry_wait' then 'stale_lease_retry'
          when 'canceled' then 'stale_lease_canceled'
          when 'ambiguous' then 'stale_lease_ambiguous'
          else 'stale_lease_failed'
        end,
        completed_at = case
          when classified.next_state = 'retry_wait' then null
          else transaction_timestamp()
        end,
        updated_at = transaction_timestamp()
    from classified
    where job.id = classified.id
    returning job.id, job.attempt_count, classified.next_state,
              job.outcome_code, job.scheduled_at
  ), transitions as (
    insert into ops.job_transitions (
      job_id, prior_state, next_state, attempt_count, reason_code,
      retry_decision, next_due_at, transitioned_at
    )
    select id, 'running', next_state, attempt_count, outcome_code,
           case when next_state = 'retry_wait' then 'scheduled' else 'terminal' end,
           case when next_state = 'retry_wait' then scheduled_at else null end,
           transaction_timestamp()
    from moved
    returning next_state
  )
  select
    count(*) filter (where next_state = 'retry_wait'),
    count(*) filter (where next_state = 'failed'),
    count(*) filter (where next_state = 'ambiguous'),
    count(*) filter (where next_state = 'canceled')
  into retried, failed, ambiguous, canceled
  from transitions;

  return query select retried, failed, ambiguous, canceled;
end;
$function$;

revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from public;
revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from album_haven_app;
revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from album_haven_worker;
revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from album_haven_readonly;

revoke all on table library.cover_mutation_state from public;
revoke all on function library.read_cover_mutation_revision(bigint) from public;
revoke all on function library.resolve_cover_mutation_identity(bigint,text[]) from public;
revoke all on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) from public;
revoke all on function library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,text,bigint,integer,text,text,bigint,bigint,timestamptz) from public;
revoke all on function library.apply_scanned_cover_observations(bigint,bigint,jsonb,timestamptz) from public;
revoke all on function library.persist_authorized_structural_tag_edit_noncover(bigint,text[],bigint,jsonb,jsonb,text[],timestamptz) from public;
revoke all on function library.capture_scan_intent_cover_revision() from public;
revoke all on function library.load_claimed_full_scan_intent_v3(bigint,character varying,character varying) from public;
revoke all on function library.load_claimed_targeted_reconciliation_intent_v2(bigint,character varying,character varying) from public;
revoke all on function ops.checkpoint_claimed_cover_remote_save(bigint,bigint,integer,text,text,timestamptz,bigint,text,uuid,text,text,text) from public;
revoke all on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) from public;
revoke all on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) from public;
revoke all on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) from public;
revoke all on function ops.requeue_expired_cover_finalization(timestamptz) from public;
revoke all on function ops.reconcile_stale_job_leases(timestamptz,integer) from public;
revoke all on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from public;
revoke all on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from public;

do $privileges$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table library.cover_mutation_state from album_haven_app;
    revoke all on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) from album_haven_app;
    revoke all on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) from album_haven_app;
    revoke all on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) from album_haven_app;
    revoke all on function ops.requeue_expired_cover_finalization(timestamptz) from album_haven_app;
    revoke all on function ops.reconcile_stale_job_leases(timestamptz,integer) from album_haven_app;
    grant execute on function library.read_cover_mutation_revision(bigint) to album_haven_app;
    grant execute on function library.resolve_cover_mutation_identity(bigint,text[]) to album_haven_app;
    grant execute on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_app;
    grant execute on function library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_app;
    grant execute on function library.persist_authorized_structural_tag_edit_noncover(bigint,text[],bigint,jsonb,jsonb,text[],timestamptz) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on table library.cover_mutation_state from album_haven_worker;
    grant execute on function library.read_cover_mutation_revision(bigint) to album_haven_worker;
    grant execute on function library.resolve_cover_mutation_identity(bigint,text[]) to album_haven_worker;
    grant execute on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_worker;
    grant execute on function library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_worker;
    grant execute on function library.load_claimed_full_scan_intent_v3(bigint,character varying,character varying) to album_haven_worker;
    grant execute on function library.load_claimed_targeted_reconciliation_intent_v2(bigint,character varying,character varying) to album_haven_worker;
    grant execute on function ops.checkpoint_claimed_cover_remote_save(bigint,bigint,integer,text,text,timestamptz,bigint,text,uuid,text,text,text) to album_haven_worker;
    grant execute on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) to album_haven_worker;
    grant execute on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) to album_haven_worker;
    grant execute on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) to album_haven_worker;
    grant execute on function ops.requeue_expired_cover_finalization(timestamptz) to album_haven_worker;
    grant execute on function ops.reconcile_stale_job_leases(timestamptz,integer) to album_haven_worker;
    grant execute on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) to album_haven_worker;
    grant execute on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table library.cover_mutation_state from album_haven_readonly;
    revoke all on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) from album_haven_readonly;
    revoke all on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) from album_haven_readonly;
    revoke all on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) from album_haven_readonly;
    revoke all on function ops.requeue_expired_cover_finalization(timestamptz) from album_haven_readonly;
    revoke all on function ops.reconcile_stale_job_leases(timestamptz,integer) from album_haven_readonly;
    grant execute on function library.read_cover_mutation_revision(bigint) to album_haven_readonly;
  end if;
end;
$privileges$;

-- Legacy overload retained only so an old claimed worker can drain. It cannot
-- enter a post-commit checkpoint because the typed overload requires a digest.
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
as $function$
  select ops.checkpoint_claimed_cover_remote_save(
    requested_checkpoint_id,
    requested_job_id,
    requested_attempt,
    requested_worker_id,
    requested_lease_token,
    observed_at,
    expected_row_revision,
    next_checkpoint,
    next_artifact_key,
    null,
    next_cover_revision,
    next_reason_code
  );
$function$;
