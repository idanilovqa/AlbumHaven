-- Preserve the shared 0122 function signature for older callers; extend new calls atomically.

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
  explicit_selection boolean,
  local_cover_width integer,
  local_cover_height integer,
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
  if current_inventory_revision is distinct from expected_inventory_revision then
    return query select false, current_cover_mutation_revision,
      'inventory_revision_conflict'::text, null::bigint, null::bigint;
    return;
  end if;
  if current_cover_mutation_revision is distinct from expected_cover_mutation_revision then
    return query select false, current_cover_mutation_revision,
      'revision_conflict'::text, null::bigint, null::bigint;
    return;
  end if;

  if explicit_selection is null then
    raise exception 'explicit selection decision is required' using errcode = '22023';
  end if;
  if explicit_selection and (selected_origin is distinct from 'user' or clear_selection) then
    raise exception 'explicit selection requires a user replacement' using errcode = '22023';
  end if;
  if (local_cover_width is null) <> (local_cover_height is null)
     or local_cover_width <= 0 or local_cover_height <= 0 then
    raise exception 'local cover dimensions must be positive and paired' using errcode = '22023';
  end if;
  if local_cover_width is not null and (clear_selection or remote_cover is not null) then
    raise exception 'local cover dimensions require a local replacement' using errcode = '22023';
  end if;

  if clear_selection is null then
    raise exception 'clear selection decision is required';
  end if;
  if clear_selection then
    if selected_cover_path is not null
       or promoted_cover_revision is not null
       or selected_origin is not null
       or remote_cover is not null then
      raise exception 'clear selection cannot carry replacement cover state';
    end if;
  elsif selected_origin is null
     or selected_origin not in ('user', 'automatic') then
    raise exception 'replacement selection requires revision and valid origin';
  elsif promoted_cover_revision is null
     and (remote_cover is null or requested_job_id is not null) then
    raise exception 'local or claimed replacement requires revision';
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
     and checkpoint.artifact_sha256 = commit_cover_selection.artifact_sha256
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
       and checkpoint.artifact_sha256 = commit_cover_selection.artifact_sha256
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
      'cover_selection_provenance', 'local_cover_width', 'local_cover_height',
      'remote_cover_url', 'remote_cover_thumbnail_url',
      'remote_cover_source', 'remote_cover_source_label',
      'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
    ]::text[]
  ) || case
    when clear_selection then '{}'::jsonb
    when remote_cover is not null then jsonb_strip_nulls(
      remote_cover || jsonb_build_object(
        'cover_revision', promoted_cover_revision,
        'cover_selection_origin', selected_origin,
        'cover_selection_provenance', case when explicit_selection then 'explicit' end
      )
    )
    else jsonb_strip_nulls(jsonb_build_object(
      'cover_path', selected_cover_path,
      'local_cover_width', local_cover_width,
      'local_cover_height', local_cover_height,
      'cover_revision', promoted_cover_revision,
      'cover_selection_origin', selected_origin,
      'cover_selection_provenance', case when explicit_selection then 'explicit' end
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
    coalesce(file.metadata, '{}'::jsonb) || jsonb_build_object(
      'scan_cache', coalesce(file.metadata -> 'scan_cache', '{}'::jsonb)
    ),
    '{scan_cache,file_entry}',
    (
      coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
      - array[
        'cover_path', 'cover_revision', 'cover_selection_origin',
        'cover_selection_provenance', 'local_cover_width', 'local_cover_height',
        'remote_cover_url', 'remote_cover_thumbnail_url',
        'remote_cover_source', 'remote_cover_source_label',
        'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
      ]::text[]
    ) || case
      when clear_selection then '{}'::jsonb
      when remote_cover is not null then jsonb_strip_nulls(
        remote_cover || jsonb_build_object(
          'cover_revision', promoted_cover_revision,
          'cover_selection_origin', selected_origin,
          'cover_selection_provenance', case when explicit_selection then 'explicit' end
        )
      )
      else jsonb_strip_nulls(jsonb_build_object(
        'cover_path', selected_cover_path,
        'local_cover_width', local_cover_width,
        'local_cover_height', local_cover_height,
        'cover_revision', promoted_cover_revision,
        'cover_selection_origin', selected_origin,
        'cover_selection_provenance', case when explicit_selection then 'explicit' end
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
              'cover_path', 'cover_revision', 'cover_selection_origin',
              'cover_selection_provenance', 'local_cover_width', 'local_cover_height',
              'remote_cover_url', 'remote_cover_thumbnail_url',
              'remote_cover_source', 'remote_cover_source_label',
              'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
            ]::text[]
          ) || case
            when clear_selection then '{}'::jsonb
            when remote_cover is not null then jsonb_strip_nulls(
              remote_cover || jsonb_build_object(
                'cover_revision', promoted_cover_revision,
                'cover_selection_origin', selected_origin,
                'cover_selection_provenance', case when explicit_selection then 'explicit' end
              )
            )
            else jsonb_strip_nulls(jsonb_build_object(
              'cover_path', selected_cover_path,
              'local_cover_width', local_cover_width,
              'local_cover_height', local_cover_height,
              'cover_revision', promoted_cover_revision,
              'cover_selection_origin', selected_origin,
              'cover_selection_provenance', case when explicit_selection then 'explicit' end
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
      and checkpoint.artifact_sha256 = commit_cover_selection.artifact_sha256
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

revoke all on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,integer,integer,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) from public;

do $privileges$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,integer,integer,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,integer,integer,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_worker;
  end if;
end;
$privileges$;

-- The assertion and write must share the publication lock and transaction.
create or replace function library.assert_cover_mutation_baseline(
  expected_library_id bigint, expected_album_id bigint, requested_track_paths text[],
  expected_inventory_revision bigint, expected_cover_mutation_revision bigint
) returns void language plpgsql security definer
set search_path = pg_catalog, library, app
as $$
declare
  current_inventory_revision bigint;
  current_cover_revision bigint;
  input_count integer;
  resolved_count integer;
begin
  if expected_library_id is null or expected_library_id <= 0
     or expected_album_id is null or expected_album_id <= 0
     or expected_inventory_revision is null or expected_inventory_revision < 0
     or expected_cover_mutation_revision is null or expected_cover_mutation_revision < 0 then
    raise exception 'cover mutation requires complete baseline' using errcode = '40001';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(nullif(owned.metadata ->> 'inventory_mutation_revision', '')::bigint, 0)
    into current_inventory_revision
    from library.libraries owned
   where owned.id = expected_library_id
   for update of owned;
  if not found or current_inventory_revision is distinct from expected_inventory_revision then
    raise exception 'cover mutation inventory conflict' using errcode = '40001';
  end if;
  insert into library.cover_mutation_state(library_id) values(expected_library_id)
    on conflict(library_id) do nothing;
  select state.cover_mutation_revision into current_cover_revision
    from library.cover_mutation_state state where state.library_id = expected_library_id
    for update;
  if current_cover_revision is distinct from expected_cover_mutation_revision then
    raise exception 'cover mutation revision conflict' using errcode = '40001';
  end if;
  perform 1 from library.local_albums album
    where album.id = expected_album_id and album.library_id = expected_library_id for update;
  if not found then
    raise exception 'cover mutation album conflict' using errcode = '40001';
  end if;
  with inputs as (
    select distinct nullif(btrim(path), '') as path from unnest(requested_track_paths) path
  ), resolved as (
    select file.id from inputs
      join library.local_track_files file on file.private_path = inputs.path
      join library.local_tracks track on track.id = file.track_id
      join library.library_roots root on root.id = file.library_root_id
     where track.library_id = expected_library_id and track.album_id = expected_album_id
       and root.library_id = expected_library_id and root.is_active
  )
  select (select count(*) from inputs), (select count(*) from resolved)
    into input_count, resolved_count;
  if input_count = 0 or input_count <> resolved_count then
    raise exception 'cover mutation track identity conflict' using errcode = '40001';
  end if;
end;
$$;
revoke all on function library.assert_cover_mutation_baseline(bigint,bigint,text[],bigint,bigint) from public;

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
  reject_if_explicit_selection boolean,
  selected_local_cover_width integer,
  selected_local_cover_height integer,
  expected_origin text,
  expected_revision text,
  expected_library_id bigint,
  expected_album_id bigint,
  expected_inventory_revision bigint,
  expected_cover_mutation_revision bigint
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
language plpgsql security definer
set search_path = pg_catalog, ops, library
as $$
declare
  current_metadata jsonb;
  path_count integer;
  file_count integer;
  user_blocked boolean;
  state_blocked boolean;
  lease_expires_at timestamptz;
  outcome record;
begin
  if expected_library_id is distinct from requested_library_id then
    raise exception 'cover mutation library conflict' using errcode = '40001';
  end if;
  perform library.assert_cover_mutation_baseline(
    expected_library_id, expected_album_id, requested_track_paths,
    expected_inventory_revision, expected_cover_mutation_revision);
  select job.lease_expires_at into lease_expires_at
    from ops.cover_bulk_refreshes refresh
    join ops.jobs job on job.id = refresh.job_id
   where refresh.id = requested_task_id and refresh.library_id = requested_library_id
     and refresh.status = 'running' and refresh.cancel_requested_at is null
     and job.id = requested_job_id and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id and job.lease_token = requested_lease_token
     and job.lease_expires_at > clock_timestamp() and job.cancel_requested_at is null
   for update of refresh, job;
  if not found then
    return query select cardinality(requested_track_paths), 0, 0, 0, 0, 0, false, false;
    return;
  end if;
  if reject_if_user_controlled is null or reject_if_explicit_selection is null then
    raise exception 'cover mutation guards required' using errcode = '22023';
  end if;
  select coalesce(album.metadata, '{}'::jsonb) into current_metadata
    from library.local_albums album
   where album.id = expected_album_id and album.library_id = expected_library_id;
  select count(distinct path)::integer into path_count
    from unnest(requested_track_paths) path;
  select count(*)::integer into file_count
    from library.local_track_files file
    join library.local_tracks track on track.id = file.track_id
   where track.album_id = expected_album_id and track.library_id = expected_library_id;
  user_blocked := (
    reject_if_user_controlled and coalesce(current_metadata ->> 'cover_selection_origin', '') = 'user'
  ) or (
    reject_if_explicit_selection and coalesce(current_metadata ->> 'cover_selection_provenance', '') = 'explicit'
  );
  state_blocked := expected_origin is not null and (
    coalesce(current_metadata ->> 'cover_selection_origin', '') is distinct from expected_origin
    or coalesce(current_metadata ->> 'cover_revision', '') is distinct from expected_revision
  );
  if user_blocked or state_blocked then
    return query select path_count, path_count, 1, file_count, 0, 0,
      (reject_if_user_controlled or reject_if_explicit_selection),
      expected_origin is not null;
    return;
  end if;
  if lease_expires_at <= clock_timestamp() then
    return query select path_count, 0, 0, 0, 0, 0, false, false;
    return;
  end if;
  select * into outcome from library.commit_cover_selection(
    expected_library_id, expected_album_id, requested_track_paths,
    expected_inventory_revision, expected_cover_mutation_revision,
    nullif(current_metadata ->> 'cover_revision', ''),
    selected_cover_path, selected_cover_revision, selected_origin,
    coalesce(selected_origin = 'user' and expected_origin = 'user'
      and current_metadata ->> 'cover_selection_provenance' = 'explicit', false),
    selected_local_cover_width, selected_local_cover_height, false, null::jsonb,
    null::text, null::bigint, null::integer, null::text, null::text,
    null::bigint, null::bigint, observed_at);
  if not outcome.committed then
    raise exception 'cover mutation baseline changed' using errcode = '40001';
  end if;
  if outcome.cover_mutation_revision is distinct from expected_cover_mutation_revision then
    update library.libraries owned
       set metadata = coalesce(owned.metadata, '{}'::jsonb) ||
         jsonb_build_object('cover_mutation_revision', outcome.cover_mutation_revision),
           updated_at = observed_at
     where owned.id = expected_library_id;
  end if;
  return query select path_count, path_count, 1, file_count, 1, file_count, false, false;
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
  linked_remote boolean,
  local_cover_width integer,
  local_cover_height integer
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops, library
as $$
declare
  selected_checkpoint ops.cover_remote_save_checkpoints%rowtype;
  selected_job ops.jobs%rowtype;
  selected_candidate jsonb;
  updated_album_count integer;
  updated_file_count integer;
  authority_revision bigint;
  current_cover_path text;
  current_album_metadata jsonb;
  desired_cover_path text;
  desired_album_metadata jsonb;
  cover_authority_changed boolean;
  file_authority_changed boolean;
begin
  if (local_cover_width is null) <> (local_cover_height is null)
     or local_cover_width <= 0 or local_cover_height <= 0
     or (linked_remote and local_cover_width is not null) then
    raise exception 'local cover dimensions require a local replacement' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));

  select job.* into selected_job
    from ops.jobs as job
   where job.id = requested_job_id
     and job.kind = 'cover_remote_save'
     and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id
     and job.lease_token = requested_lease_token
     and job.lease_expires_at > clock_timestamp()
     and job.cancel_requested_at is null
   for update;
  if not found then return null; end if;

  select checkpoint_row.*
    into selected_checkpoint
    from ops.cover_remote_save_checkpoints as checkpoint_row
   where checkpoint_row.id = requested_checkpoint_id
     and checkpoint_row.job_id = requested_job_id
     and checkpoint_row.row_revision = expected_checkpoint_revision
     and checkpoint_row.checkpoint = 'artifact_written'
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

  insert into library.cover_mutation_state (library_id)
  values (selected_checkpoint.library_id)
  on conflict (library_id) do nothing;
  select state.cover_mutation_revision
    into authority_revision
    from library.cover_mutation_state as state
   where state.library_id = selected_checkpoint.library_id
   for update;

  select album.cover_path, coalesce(album.metadata, '{}'::jsonb)
    into current_cover_path, current_album_metadata
    from library.local_albums as album
   where album.id = selected_checkpoint.local_album_id
     and album.library_id = selected_checkpoint.library_id
   for update;
  if not found then return null; end if;
  perform file.id
    from library.local_track_files as file
    join library.local_tracks as track on track.id = file.track_id
   where track.library_id = selected_checkpoint.library_id
     and track.album_id = selected_checkpoint.local_album_id
   order by file.id
   for update of file;
  if selected_job.lease_expires_at <= clock_timestamp() then return null; end if;

  desired_cover_path := case when linked_remote then null else selected_cover_path end;
  desired_album_metadata := (
    current_album_metadata
    - array[
               'cover_path', 'cover_revision', 'cover_selection_provenance', 'local_cover_width', 'local_cover_height',
      'remote_cover_url', 'remote_cover_thumbnail_url',
      'remote_cover_source', 'remote_cover_source_label',
      'remote_cover_album_url', 'remote_cover_width',
      'remote_cover_height'
    ]::text[]
  ) || case when linked_remote then jsonb_strip_nulls(jsonb_build_object(
    'cover_path', null,
    'cover_revision', null,
    'cover_selection_origin', 'user',
      'cover_selection_provenance', 'explicit',
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
  )) else jsonb_build_object(
    'cover_path', selected_cover_path,
    'cover_revision', selected_cover_revision,
    'cover_selection_origin', 'user',
      'cover_selection_provenance', 'explicit'
  ) || jsonb_strip_nulls(jsonb_build_object(
    'local_cover_width', local_cover_width,
    'local_cover_height', local_cover_height
  )) end;
  cover_authority_changed :=
    current_cover_path is distinct from desired_cover_path
    or current_album_metadata is distinct from desired_album_metadata;

  update library.local_albums as album
     set cover_path = desired_cover_path,
         metadata = desired_album_metadata
   where album.id = selected_checkpoint.local_album_id
     and album.library_id = selected_checkpoint.library_id;
  get diagnostics updated_album_count = row_count;

  with desired_files as materialized (
    select file.id, file.metadata as prior_metadata,
      jsonb_set(
       coalesce(file.metadata, '{}'::jsonb),
       '{scan_cache}',
       coalesce(file.metadata -> 'scan_cache', '{}'::jsonb)
         || jsonb_build_object(
           'file_entry',
           (
             coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
             - array[
               'cover_path', 'cover_revision', 'cover_selection_provenance', 'local_cover_width', 'local_cover_height',
               'remote_cover_url', 'remote_cover_thumbnail_url',
               'remote_cover_source', 'remote_cover_source_label',
               'remote_cover_album_url', 'remote_cover_width',
               'remote_cover_height'
             ]::text[]
           ) || case when linked_remote then jsonb_strip_nulls(jsonb_build_object(
             'cover_path', null,
             'cover_revision', null,
             'cover_selection_origin', 'user',
             'cover_selection_provenance', 'explicit',
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
           )) else jsonb_build_object(
             'cover_path', selected_cover_path,
             'cover_revision', selected_cover_revision,
             'cover_selection_origin', 'user',
             'cover_selection_provenance', 'explicit'
           ) || jsonb_strip_nulls(jsonb_build_object(
             'local_cover_width', local_cover_width,
             'local_cover_height', local_cover_height
           )) end
         ),
       true
     ) as desired_metadata
      from library.local_track_files file
      join library.local_tracks track on track.id = file.track_id
     where track.library_id = selected_checkpoint.library_id
       and track.album_id = selected_checkpoint.local_album_id
  ), updated_files as (
    update library.local_track_files file
       set metadata = desired.desired_metadata
      from desired_files desired
     where file.id = desired.id
       and desired.prior_metadata is distinct from desired.desired_metadata
     returning file.id
  )
  select (select count(*)::integer from desired_files),
         exists(select 1 from updated_files)
    into updated_file_count, file_authority_changed;
  cover_authority_changed := cover_authority_changed or file_authority_changed;
  if updated_album_count <> 1 or updated_file_count < 1 then
    raise exception 'remote cover selection scope changed';
  end if;

  if cover_authority_changed then
    update library.cover_mutation_state as state
       set cover_mutation_revision = state.cover_mutation_revision + 1,
           updated_at = observed_at
     where state.library_id = selected_checkpoint.library_id
    returning state.cover_mutation_revision into authority_revision;
  end if;

  update library.libraries as library_record
     set metadata = coalesce(library_record.metadata, '{}'::jsonb)
       || jsonb_build_object(
         'cover_mutation_revision',
         authority_revision
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
language sql security definer
set search_path = pg_catalog, ops, library
as $$
  select ops.persist_claimed_remote_cover_selection(
    requested_checkpoint_id, requested_job_id, requested_attempt, requested_worker_id,
    requested_lease_token, observed_at, expected_checkpoint_revision,
    selected_cover_path, selected_cover_revision, linked_remote, null::integer, null::integer);
$$;

revoke all on function ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamptz,text[],text,text,text,boolean,boolean,integer,integer,text,text,bigint,bigint,bigint,bigint) from public;
revoke all on function ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamptz,bigint,text,text,boolean,integer,integer) from public;
do $privileges$
begin
  if exists(select 1 from pg_roles where rolname='album_haven_worker') then
    revoke execute on function ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamptz,text[],text,text,text,boolean,boolean,integer,integer,text,text) from album_haven_worker;
    grant execute on function ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamptz,text[],text,text,text,boolean,boolean,integer,integer,text,text,bigint,bigint,bigint,bigint) to album_haven_worker;
    grant execute on function ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamptz,bigint,text,text,boolean,integer,integer) to album_haven_worker;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant execute on function library.assert_cover_mutation_baseline(bigint,bigint,text[],bigint,bigint) to album_haven_app;
  end if;
end;
$privileges$;

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
  linked_remote boolean,
  local_cover_width integer,
  local_cover_height integer,
  expected_library_id bigint,
  expected_album_id bigint,
  expected_inventory_revision bigint,
  expected_cover_mutation_revision bigint,
  requested_track_paths text[]
)
returns bigint language plpgsql security definer
set search_path = pg_catalog, ops, library
as $$
begin
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  perform 1 from ops.cover_remote_save_checkpoints checkpoint
    join ops.jobs job on job.id = checkpoint.job_id
    join ops.cover_lookup_tasks task on task.id = checkpoint.task_id
   where checkpoint.id = requested_checkpoint_id
     and checkpoint.job_id = requested_job_id
     and checkpoint.library_id = expected_library_id
     and checkpoint.local_album_id = expected_album_id
     and task.library_id = expected_library_id
     and task.local_album_id = expected_album_id
     and checkpoint.row_revision = expected_checkpoint_revision
     and checkpoint.checkpoint = 'artifact_written'
     and job.kind = 'cover_remote_save' and job.state = 'running'
     and job.attempt_count = requested_attempt
     and job.lease_owner = requested_worker_id and job.lease_token = requested_lease_token
     and job.lease_expires_at > clock_timestamp()
     and job.cancel_requested_at is null and task.cancel_requested_at is null;
  if not found then
    return null;
  end if;
  begin
    perform library.assert_cover_mutation_baseline(
      expected_library_id, expected_album_id, requested_track_paths,
      expected_inventory_revision, expected_cover_mutation_revision);
  exception when serialization_failure then
    return null;
  end;
  return ops.persist_claimed_remote_cover_selection(
    requested_checkpoint_id, requested_job_id, requested_attempt,
    requested_worker_id, requested_lease_token, observed_at,
    expected_checkpoint_revision, selected_cover_path, selected_cover_revision,
    linked_remote, local_cover_width, local_cover_height);
end;
$$;
revoke all on function ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamptz,bigint,text,text,boolean,integer,integer,bigint,bigint,bigint,bigint,text[]) from public;
do $remote_privileges$
begin
  if exists(select 1 from pg_roles where rolname='album_haven_worker') then
    revoke execute on function ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamptz,bigint,text,text,boolean) from album_haven_worker;
    revoke execute on function ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamptz,bigint,text,text,boolean,integer,integer) from album_haven_worker;
    grant execute on function ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamptz,bigint,text,text,boolean,integer,integer,bigint,bigint,bigint,bigint,text[]) to album_haven_worker;
  end if;
end;
$remote_privileges$;

-- Preserve warnings observed after the repair whose legacy summary is cleared.
create or replace function library.try_complete_watcher_repairs(
  p_repair_ids bigint[], p_now timestamptz
)
returns bigint[]
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_completed bigint[] := '{}';
  v_repair_id bigint;
  v_repair_state varchar(16);
  v_root record;
  v_blocking record;
  v_successor_id bigint;
  v_accepted_sequence bigint;
  v_dirty_generation bigint;
begin
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
          join library.watcher_repairs as repair
            on repair.id = repair_root.repair_id
           and repair.library_id = repair_root.library_id
           and repair.state = 'complete'
          join lateral pg_catalog.jsonb_each(coalesce(
            local_library.metadata -> 'library_watch_health', '{}'::jsonb
          )) as health_entry
            on health_entry.key = root.metadata ->> 'root_id'
          where repair_root.repair_id = any(v_completed)
            and repair_root.library_id = local_library.id
            and case
              when pg_catalog.jsonb_typeof(health_entry.value -> 'detected_at') = 'string'
                and pg_catalog.pg_input_is_valid(
                  nullif(health_entry.value ->> 'detected_at', ''),
                  'timestamp with time zone'
                )
              then pg_catalog.isfinite(
                     (health_entry.value ->> 'detected_at')::timestamptz
                   )
                   and (health_entry.value ->> 'detected_at')::timestamptz
                     <= repair.started_at
              else false
            end
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


-- Require the fenced worker signatures without restoring legacy EXECUTE grants.
create or replace function ops.validate_durable_worker_startup(
  p_registered_kinds text[]
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  expected_kinds constant text[] := array[
    'auth_invitation_delivery',
    'auth_password_reset_delivery',
    'auth_welcome_delivery',
    'cover_bulk_refresh',
    'cover_lookup',
    'cover_remote_save',
    'full_scan',
    'lastfm_scrobble_retry',
    'post_scan_cover_refresh',
    'targeted_reconciliation'
  ];
  required_functions constant text[] := array[
    'app.load_claimed_job_authorization_context(bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_targeted_reconciliation_scope(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_targeted_reconciliation_preparation(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_targeted_reconciliation_intent_v2(bigint,character varying,character varying)',
    'library.fence_targeted_reconciliation_publication(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,character varying,character varying,jsonb,jsonb,timestamp with time zone)',
    'library.retire_claimed_targeted_reconciliation_vacated_albums(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_full_scan_intent_v2(bigint,character varying,character varying)',
    'library.load_claimed_full_scan_scope(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.checkpoint_claimed_full_scan_v2(bigint,bigint,integer,character varying,character varying,character varying,bigint,bigint,text,timestamp with time zone,double precision,double precision,double precision,bigint,bigint)',
    'library.publish_claimed_full_scan(bigint,bigint,integer,character varying,character varying,bigint,jsonb,text[],timestamp with time zone)',
    'library.validate_claimed_post_scan_cover_refresh(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.publish_claimed_full_scan_preview(bigint,bigint,integer,character varying,character varying,jsonb,text[],bigint,timestamp with time zone)',
    'library.load_claimed_full_scan_cache(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.validate_claimed_cover_lookup(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.load_claimed_cover_lookup(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.claimed_cover_lookup_cancel_requested(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.load_claimed_cover_lookup_cancellation(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.publish_claimed_cover_lookup(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,jsonb)',
    'ops.finalize_claimed_cover_lookup_canceled(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint)',
    'ops.begin_claimed_cover_refresh(bigint,bigint,integer,text,text,timestamp with time zone,text,bigint,text)',
    'ops.cover_refresh_cancel_requested(bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.checkpoint_claimed_cover_refresh(bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,integer,integer,integer,text)',
    'ops.finish_claimed_cover_refresh(bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,text,integer,integer)',
    'ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text[],text,text,text,boolean,boolean,integer,integer,text,text,bigint,bigint,bigint,bigint)',
    'ops.load_claimed_cover_remote_save(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
            'ops.checkpoint_claimed_cover_remote_save(bigint,bigint,integer,text,text,timestamp with time zone,bigint,text,uuid,text,text,text)',
    'ops.publish_claimed_cover_remote_save(bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,bigint,text,boolean)',
    'ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamp with time zone,bigint,text,text,boolean,integer,integer,bigint,bigint,bigint,bigint,text[])',
    'ops.validate_claimed_lastfm_retry(bigint,bigint,bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone,bigint,integer)',
    'ops.load_claimed_lastfm_session_secret(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.begin_claimed_lastfm_attempt(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.cancel_claimed_lastfm_before_send(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone,character varying)',
    'ops.finish_claimed_lastfm_attempt(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone,bigint,character varying,character varying,jsonb)',
    'ops.reconcile_due_lastfm_jobs(timestamp with time zone,integer)',
    'ops.validate_claimed_auth_mail(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint,integer)',
    'ops.load_claimed_auth_mail_context(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.issue_claimed_auth_mail_token_hash(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint,bytea,timestamp with time zone,text)',
    'ops.begin_claimed_auth_mail_send(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint)',
    'ops.cancel_claimed_auth_mail_before_send(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,character varying)',
    'ops.finish_claimed_auth_mail(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint,character varying,character varying)',
    'ops.reconcile_auth_mail_jobs(timestamp with time zone,integer)'
  ];
begin
  if p_registered_kinds is distinct from expected_kinds then
    return false;
  end if;

  if exists (
    select 1
    from unnest(required_functions) as required(signature)
    where to_regprocedure(required.signature) is null
       or not has_function_privilege(session_user, required.signature, 'EXECUTE')
  ) then
    return false;
  end if;

  if not has_table_privilege(session_user, 'ops.jobs', 'SELECT')
     or not has_table_privilege(session_user, 'ops.job_transitions', 'SELECT')
     or not has_table_privilege(session_user, 'ops.job_transitions', 'INSERT')
     or not has_table_privilege(session_user, 'ops.worker_instances', 'SELECT')
     or not has_table_privilege(session_user, 'ops.worker_instances', 'INSERT')
     or not has_table_privilege(session_user, 'ops.worker_instances', 'UPDATE')
     or not has_sequence_privilege(
       session_user, 'ops.job_transitions_id_seq', 'USAGE'
     )
     or exists (
       select 1
       from unnest(array[
         'state', 'scheduled_at', 'attempt_count', 'lease_owner', 'lease_token',
         'lease_expires_at', 'heartbeat_at', 'started_at', 'completed_at',
         'outcome_code', 'updated_at'
       ]) as required(column_name)
       where not has_column_privilege(
         session_user, 'ops.jobs', required.column_name, 'UPDATE'
       )
     ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

