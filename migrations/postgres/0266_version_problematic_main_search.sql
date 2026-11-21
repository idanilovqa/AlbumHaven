-- depends on: 0249_create_problematic_files_projection.sql
-- Expand only: preserve v1 rows/signatures and never relabel old snapshots.
-- Rollout drains old APIs/projectors before v2 publication; rollback stops v2,
-- verifies a retained or freshly rebuilt v1 snapshot, then restarts old code.
alter table ops.problematic_projection_headers
  drop constraint problematic_projection_headers_builder_version_check;
alter table ops.problematic_projection_headers
  add constraint problematic_projection_headers_builder_version_check
  check (builder_version in (1, 2));
alter table ops.problematic_projection_item_staging
  add column search_document_count bigint check (search_document_count > 0),
  add column search_document_digest text check (search_document_digest ~ '^[0-9a-f]{64}$');

-- Group completion visits only its items; the existing PK cannot locate a group.
-- Search facts reuse their existing (job, attempt, revision, item_key, ...) PK.
create index problematic_projection_item_staging_group_idx
  on ops.problematic_projection_item_staging
  (job_id, attempt, revision, group_kind, group_identity, item_key);

-- Missing version is the unchanged legacy contract; JSON strings/fractions are invalid.
create or replace function ops.problematic_projection_builder_version(p_parameters jsonb)
returns integer
language sql immutable security definer
set search_path = pg_catalog
as $$
  select case when
    pg_catalog.jsonb_typeof(p_parameters) = 'object'
    and p_parameters ->> 'projection_kind' = 'problematic_files'
    and (p_parameters - array['projection_kind', 'source_generation', 'rebuild_epoch', 'builder_version']) = '{}'::jsonb
    and pg_catalog.jsonb_typeof(p_parameters -> 'source_generation') = 'number'
    and pg_catalog.jsonb_typeof(p_parameters -> 'rebuild_epoch') = 'number'
    and (p_parameters ->> 'source_generation') ~ '^[1-9][0-9]{0,18}$'
    and (p_parameters ->> 'rebuild_epoch') ~ '^[1-9][0-9]{0,18}$'
    then case when (p_parameters ->> 'source_generation')::numeric <= 9223372036854775807
      and (p_parameters ->> 'rebuild_epoch')::numeric <= 9223372036854775807
      then case
        when not (p_parameters ? 'builder_version') then 1
        when pg_catalog.jsonb_typeof(p_parameters -> 'builder_version') = 'number'
          and p_parameters ->> 'builder_version' in ('1', '2')
          then (p_parameters ->> 'builder_version')::integer
        else null end
      else null end
    else null end;
$$;

create or replace function ops.enqueue_problematic_projection_rebuild(
  p_library_id bigint, p_requested_by text, p_builder_version integer
)
returns table(job_id bigint, rebuild_epoch bigint, created boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  state_row ops.problematic_projection_state%rowtype;
  existing_job ops.jobs%rowtype;
begin
  if p_builder_version is null or p_builder_version not in (1, 2) or
     p_library_id is null or p_library_id < 1 or
     nullif(pg_catalog.btrim(p_requested_by), '') is null or
     pg_catalog.octet_length(p_requested_by) > 128 then
    raise exception 'invalid projection rebuild request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from ops.resolve_problematic_projection_library() canonical
    where canonical.library_id = p_library_id
  ) then
    raise exception 'projection library is not canonical' using errcode = '22023';
  end if;
  insert into ops.problematic_projection_state(library_id)
  values (p_library_id) on conflict (library_id) do nothing;
  select * into state_row from ops.problematic_projection_state
  where library_id = p_library_id for update;
  if state_row.live_job_id is not null then
    select * into existing_job from ops.jobs where id = state_row.live_job_id;
    if found and existing_job.state in ('queued', 'running', 'retry_wait')
       and ops.problematic_projection_builder_version(existing_job.parameters) = p_builder_version
       and (existing_job.parameters ->> 'source_generation')::bigint = state_row.source_generation
       and (existing_job.parameters ->> 'rebuild_epoch')::bigint = state_row.rebuild_epoch
       and existing_job.idempotency_key = 'problematic-files-projection:' || p_library_id::text || ':' ||
         state_row.source_generation::text || ':' || state_row.rebuild_epoch::text ||
         (case when p_builder_version = 2 then ':v2' else '' end) then
      return query select existing_job.id, state_row.rebuild_epoch, false;
      return;
    end if;
  end if;
  state_row.rebuild_epoch := state_row.rebuild_epoch + 1;
  if state_row.source_generation = 0 then
    state_row.source_generation := 1;
    state_row.source_xid_fence := pg_catalog.pg_current_xact_id();
  end if;
  insert into ops.jobs(
    kind, subject_kind, subject_ref, parameters, library_id,
    deployment_mode, client_surface, idempotency_key, scheduled_at,
    max_attempts, recovery_policy, resource_revision
  ) values (
    'problematic_files_projection', 'problematic_files_projection',
    'library:' || p_library_id::text,
    pg_catalog.jsonb_build_object(
      'projection_kind', 'problematic_files',
      'source_generation', state_row.source_generation,
      'rebuild_epoch', state_row.rebuild_epoch
    ) || case when p_builder_version = 2
      then pg_catalog.jsonb_build_object('builder_version', 2) else '{}'::jsonb end,
    p_library_id, 'self_hosted', 'private_web',
    'problematic-files-projection:' || p_library_id::text || ':' ||
      state_row.source_generation::text || ':' || state_row.rebuild_epoch::text ||
      case when p_builder_version = 2 then ':v2' else '' end,
    pg_catalog.clock_timestamp(), 3, 'retry_safe', state_row.source_generation
  ) returning id into job_id;
  update ops.problematic_projection_state as projection_state set
    source_generation = state_row.source_generation,
    source_xid_fence = state_row.source_xid_fence,
    rebuild_epoch = state_row.rebuild_epoch,
    live_job_id = job_id,
    build_revision = null,
    requested_job_id = job_id,
    requested_attempt = 1,
    requested_revision = null,
    scan_kind = null, scan_identity = null,
    source_kind = null, source_identity = null,
    child_kind = null, child_identity = null,
    group_kind = null, group_identity = null,
    updated_at = pg_catalog.clock_timestamp()
  where projection_state.library_id = p_library_id;
  rebuild_epoch := state_row.rebuild_epoch;
  created := true;
  return next;
end;
$$;

create or replace function ops.enqueue_problematic_projection_rebuild(
  p_library_id bigint, p_requested_by text
)
returns table(job_id bigint, rebuild_epoch bigint, created boolean)
language sql security definer set search_path = pg_catalog
as $$
  select * from ops.enqueue_problematic_projection_rebuild(p_library_id, p_requested_by, 1);
$$;

create or replace function ops.prepare_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_observed_at timestamptz, p_builder_version integer
)
returns table(
  library_id bigint, source_generation bigint, rebuild_epoch bigint,
  revision uuid, group_kind text, group_identity text,
  source_kind text, source_identity text, child_kind text, child_identity text,
  committed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_job ops.jobs%rowtype;
  selected_state ops.problematic_projection_state%rowtype;
begin
  select * into selected_job from ops.jobs where id = p_job_id;
  if p_builder_version is null or p_builder_version not in (1, 2)
     or ops.problematic_projection_builder_version(selected_job.parameters) is distinct from p_builder_version
     or selected_job.idempotency_key is distinct from
       'problematic-files-projection:' || selected_job.library_id::text || ':' ||
       (selected_job.parameters ->> 'source_generation') || ':' ||
       (selected_job.parameters ->> 'rebuild_epoch') ||
       (case when p_builder_version = 2 then ':v2' else '' end) then
    return;
  end if;
  select * into selected_state from ops.problematic_projection_state
    where problematic_projection_state.library_id = selected_job.library_id for update;
  if not ops.problematic_projection_claim_valid(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_observed_at
  ) then return; end if;
    if selected_state.live_job_id is null and
       selected_state.committed_job_id = p_job_id and
       selected_state.committed_revision is not null and
       selected_state.source_generation =
           (selected_job.parameters ->> 'source_generation')::bigint and
       selected_state.rebuild_epoch =
           (selected_job.parameters ->> 'rebuild_epoch')::bigint then
        return query select
            selected_state.library_id,
            selected_state.source_generation,
            selected_state.rebuild_epoch,
            selected_state.committed_revision,
            selected_state.group_kind,
            selected_state.group_identity,
            selected_state.source_kind,
            selected_state.source_identity,
            selected_state.child_kind,
            selected_state.child_identity,
            true;
        return;
    end if;
    if selected_state.live_job_id is distinct from p_job_id or
     selected_state.source_generation <> (selected_job.parameters ->> 'source_generation')::bigint or
     selected_state.rebuild_epoch <> (selected_job.parameters ->> 'rebuild_epoch')::bigint then
    return;
  end if;
    if selected_state.build_revision is null then
    update ops.problematic_projection_state as projection_state set
      build_revision = pg_catalog.gen_random_uuid(),
      requested_job_id = p_job_id,
      requested_attempt = p_attempt,
      requested_revision = null,
      group_kind = null,
      group_identity = null,
      scan_kind = null,
      scan_identity = null,
      source_kind = null,
      source_identity = null,
      child_kind = null,
      child_identity = null,
      updated_at = p_observed_at
    where projection_state.library_id = selected_job.library_id
    returning projection_state.* into selected_state;
    elsif selected_state.requested_attempt is distinct from p_attempt then
        update ops.problematic_projection_source_staging as source_staging set
            attempt = p_attempt
        where source_staging.job_id = p_job_id
          and source_staging.attempt = selected_state.requested_attempt
          and source_staging.revision = selected_state.build_revision;
        update ops.problematic_projection_item_staging as item_staging set
            attempt = p_attempt
        where item_staging.job_id = p_job_id
          and item_staging.attempt = selected_state.requested_attempt
          and item_staging.revision = selected_state.build_revision;
        update ops.problematic_projection_group_accumulators as accumulator set
            attempt = p_attempt
        where accumulator.job_id = p_job_id
          and accumulator.attempt = selected_state.requested_attempt
          and accumulator.revision = selected_state.build_revision;
  end if;
  update ops.problematic_projection_state as projection_state set
    requested_job_id = p_job_id,
    requested_attempt = p_attempt,
    requested_revision = selected_state.build_revision,
    updated_at = p_observed_at
  where projection_state.library_id = selected_job.library_id
  returning projection_state.* into selected_state;
  return query select selected_state.library_id, selected_state.source_generation,
    selected_state.rebuild_epoch, selected_state.build_revision,
    selected_state.group_kind, selected_state.group_identity,
    selected_state.source_kind, selected_state.source_identity,
    selected_state.child_kind, selected_state.child_identity, false;
end;
$$;

create or replace function ops.prepare_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_observed_at timestamptz
)
returns table(
  library_id bigint, source_generation bigint, rebuild_epoch bigint,
  revision uuid, group_kind text, group_identity text,
  source_kind text, source_identity text, child_kind text, child_identity text,
  committed boolean
)
language sql security definer set search_path = pg_catalog
as $$
  select * from ops.prepare_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_observed_at, 1
  );
$$;

create or replace function ops.stage_claimed_problematic_projection_items(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_items jsonb, p_batch_index integer, p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_version integer;
begin
  select ops.problematic_projection_builder_version(job.parameters)
    into selected_version from ops.jobs job where job.id = p_job_id;
  if selected_version is null then
    raise exception 'invalid projection build contract' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid projection item batch' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where pg_catalog.jsonb_typeof(item -> 'item_key') is distinct from 'string'
      or nullif(item ->> 'item_key', '') is null
      or octet_length(item ->> 'item_key') > 256
      or pg_catalog.jsonb_typeof(item -> 'sort_title') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item -> 'sort_artist') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item -> 'sort_year') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item -> 'sort_album_key') is distinct from 'string'
      or octet_length(coalesce(item ->> 'sort_title', '')) > 512
      or octet_length(coalesce(item ->> 'sort_artist', '')) > 512
      or octet_length(coalesce(item ->> 'sort_year', '')) > 64
      or octet_length(coalesce(item ->> 'sort_album_key', '')) > 512
  ) then
    raise exception 'invalid projection item sort contract' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    raise exception 'stale projection claim' using errcode = '55000';
  end if;
  if selected_version = 2 and exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) item
    where pg_catalog.jsonb_typeof(item -> 'search_document_count') is distinct from 'number'
      or case when coalesce(item ->> 'search_document_count', '') ~ '^[1-9][0-9]{0,18}$'
        then (item ->> 'search_document_count')::numeric > 9223372036854775807 else true end
      or pg_catalog.jsonb_typeof(item -> 'search_document_digest') is distinct from 'string'
      or coalesce(item ->> 'search_document_digest', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'invalid projection search manifest' using errcode = '22023';
  end if;
  if selected_version = 2 and exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) item
    join ops.problematic_projection_item_staging staged
      on staged.job_id = p_job_id and staged.attempt = p_attempt
      and staged.revision = p_revision and staged.item_key = item ->> 'item_key'
    where staged.search_document_count is distinct from (item ->> 'search_document_count')::bigint
      or staged.search_document_digest is distinct from item ->> 'search_document_digest'
  ) then
    raise exception 'projection search manifest replay differs' using errcode = '22023';
  end if;
  insert into ops.problematic_projection_item_staging(
    job_id, attempt, revision, group_kind, group_identity, item_key,
    sort_title, sort_artist, sort_year, sort_album_key, search_text,
    reasons, summary, batch_index, created_at, search_document_count, search_document_digest
  ) select p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    item ->> 'item_key', item ->> 'sort_title', item ->> 'sort_artist',
    item ->> 'sort_year', item ->> 'sort_album_key', item ->> 'search_text',
    array(select jsonb_array_elements_text(item -> 'reasons')),
    item -> 'summary', p_batch_index, p_observed_at,
    case when selected_version = 2 then (item ->> 'search_document_count')::bigint end,
    case when selected_version = 2 then item ->> 'search_document_digest' end
  from jsonb_array_elements(p_items) item
  on conflict (job_id, attempt, revision, item_key) do update set
    sort_title = excluded.sort_title, sort_artist = excluded.sort_artist,
    sort_year = excluded.sort_year, sort_album_key = excluded.sort_album_key,
    search_text = excluded.search_text, reasons = excluded.reasons,
    summary = excluded.summary, batch_index = excluded.batch_index,
    search_document_count = excluded.search_document_count,
    search_document_digest = excluded.search_document_digest;
  return query select true;
end;
$$;

create or replace function ops.stage_claimed_problematic_projection_search_facts(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_entries jsonb, p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql security definer set search_path = pg_catalog
as $$
begin
  if p_entries is null or pg_catalog.jsonb_typeof(p_entries) <> 'array'
     or pg_catalog.jsonb_array_length(p_entries) not between 1 and 100 then
    raise exception 'invalid projection search fact batch' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    raise exception 'stale projection claim' using errcode = '55000';
  end if;
  if not exists (
    select 1 from ops.jobs job where job.id = p_job_id
      and ops.problematic_projection_builder_version(job.parameters) = 2
  ) then
    raise exception 'incompatible projection search contract' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    where pg_catalog.jsonb_typeof(entry) is distinct from 'object'
      or (entry - array['item_key', 'fact_kind', 'semantic_child_identity', 'normalized_text']) <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(entry -> 'item_key') is distinct from 'string'
      or nullif(entry ->> 'item_key', '') is null
      or pg_catalog.octet_length(entry ->> 'item_key') > 256
      or entry ->> 'fact_kind' is distinct from 'main_search'
      or pg_catalog.jsonb_typeof(entry -> 'semantic_child_identity') is distinct from 'string'
      or coalesce(entry ->> 'semantic_child_identity', '') !~ '^[0-9]{20}$'
      or pg_catalog.jsonb_typeof(entry -> 'normalized_text') is distinct from 'string'
      or nullif(entry ->> 'normalized_text', '') is null
      or pg_catalog.octet_length(entry ->> 'normalized_text') > 32768
  ) then
    raise exception 'invalid projection search fact' using errcode = '22023';
  end if;
  -- Lock the manifest row so concurrent retries cannot race the replay check.
  perform 1 from ops.problematic_projection_item_staging staged
  where staged.job_id = p_job_id and staged.attempt = p_attempt
    and staged.revision = p_revision and staged.group_kind = p_group_kind
    and staged.group_identity = p_group_identity
    and staged.item_key in (select entry ->> 'item_key'
      from pg_catalog.jsonb_array_elements(p_entries) entry)
  order by staged.item_key collate "C" for update;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    where not exists (
      select 1 from ops.problematic_projection_item_staging staged
      where staged.job_id = p_job_id and staged.attempt = p_attempt
        and staged.revision = p_revision and staged.group_kind = p_group_kind
        and staged.group_identity = p_group_identity
        and staged.item_key = entry ->> 'item_key'
        and (entry ->> 'semantic_child_identity')::numeric < staged.search_document_count
    )
  ) then
    raise exception 'projection search fact item is not staged for group'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    join ops.problematic_projection_search_fact_staging staged
      on staged.job_id = p_job_id and staged.attempt = p_attempt
      and staged.revision = p_revision and staged.item_key = entry ->> 'item_key'
      and staged.fact_kind = 'main_search'
      and staged.semantic_child_identity = entry ->> 'semantic_child_identity'
    where staged.normalized_text is distinct from entry ->> 'normalized_text'
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    group by entry ->> 'item_key', entry ->> 'semantic_child_identity'
    having count(distinct entry ->> 'normalized_text') > 1
  ) then
    raise exception 'projection search fact replay differs' using errcode = '22023';
  end if;
  insert into ops.problematic_projection_search_fact_staging(
    job_id, attempt, revision, item_key, fact_kind, semantic_child_identity, normalized_text
  ) select p_job_id, p_attempt, p_revision, entry ->> 'item_key', 'main_search',
    entry ->> 'semantic_child_identity', entry ->> 'normalized_text'
  from pg_catalog.jsonb_array_elements(p_entries) entry
  on conflict do nothing;
  return query select true;
end;
$$;

create or replace function ops.stage_claimed_problematic_projection_search_facts(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_after_projection_id text, p_after_fact_kind text,
  p_after_semantic_child_identity text, p_limit integer,
  p_observed_at timestamptz
)
returns table(
  after_projection_id text, after_fact_kind text,
  after_semantic_child_identity text, staged_count integer, complete boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_fact record;
  selected_version integer;
  last_projection_id text := coalesce(p_after_projection_id, '');
  last_fact_kind text := coalesce(p_after_fact_kind, '');
  last_semantic_child_identity text := coalesce(
    p_after_semantic_child_identity, ''
  );
  accepted_count integer := 0;
begin
  select ops.problematic_projection_builder_version(job.parameters)
    into selected_version from ops.jobs job where job.id = p_job_id;
  if selected_version is null then
    raise exception 'invalid projection build contract' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'invalid projection search fact limit' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    raise exception 'stale projection claim' using errcode = '55000';
  end if;
  for selected_fact in
    select fact.projection_id, fact.fact_kind, fact.semantic_child_identity,
      fact.fact_value ->> 'normalized_text' as normalized_text
    from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id
      and fact.attempt = p_attempt
      and fact.revision = p_revision
      and fact.group_kind = p_group_kind
      and fact.group_identity = p_group_identity
      and (selected_version = 1 or fact.fact_kind = 'private_path_locator')
      and fact.fact_kind in (
        'track_title_search', 'private_path_search', 'private_path_locator',
        'album_title_search', 'album_artist_search', 'album_key_search'
      )
      and (
        fact.projection_id collate "C", fact.fact_kind collate "C", fact.semantic_child_identity collate "C"
      ) > (
        coalesce(p_after_projection_id, ''),
        coalesce(p_after_fact_kind, ''),
        coalesce(p_after_semantic_child_identity, '')
      )
    order by fact.projection_id collate "C", fact.fact_kind collate "C",
      fact.semantic_child_identity collate "C"
    limit least(greatest(p_limit, 1), 100)
  loop
    if selected_fact.normalized_text is null
       or selected_fact.normalized_text = ''
      or pg_catalog.octet_length(selected_fact.normalized_text) >
          (case when selected_fact.fact_kind = 'private_path_locator'
               then 65536 else 32768 end) then
      raise exception 'invalid projection search fact' using errcode = '22023';
    end if;
    if exists (
      select 1
      from ops.problematic_projection_item_staging item_staging
      where item_staging.job_id = p_job_id
        and item_staging.attempt = p_attempt
        and item_staging.revision = p_revision
        and item_staging.group_kind = p_group_kind
        and item_staging.group_identity = p_group_identity
        and item_staging.item_key = selected_fact.projection_id
    ) then
      insert into ops.problematic_projection_search_fact_staging(
        job_id, attempt, revision, item_key, fact_kind,
        semantic_child_identity, normalized_text
      ) values (
        p_job_id, p_attempt, p_revision, selected_fact.projection_id,
        selected_fact.fact_kind, selected_fact.semantic_child_identity,
        selected_fact.normalized_text
      ) on conflict (
        job_id, attempt, revision, item_key, fact_kind, semantic_child_identity
      ) do update set normalized_text = excluded.normalized_text;
    end if;
    last_projection_id := selected_fact.projection_id;
    last_fact_kind := selected_fact.fact_kind;
    last_semantic_child_identity := selected_fact.semantic_child_identity;
    accepted_count := accepted_count + 1;
  end loop;
  return query select last_projection_id, last_fact_kind,
    last_semantic_child_identity, accepted_count,
    not exists (
      select 1
      from ops.problematic_projection_group_facts fact
      where fact.job_id = p_job_id
        and fact.attempt = p_attempt
        and fact.revision = p_revision
        and fact.group_kind = p_group_kind
        and fact.group_identity = p_group_identity
        and (selected_version = 1 or fact.fact_kind = 'private_path_locator')
        and fact.fact_kind in (
        'track_title_search', 'private_path_search', 'private_path_locator',
          'album_title_search', 'album_artist_search', 'album_key_search'
        )
        and (
        fact.projection_id collate "C", fact.fact_kind collate "C", fact.semantic_child_identity collate "C"
        ) > (last_projection_id, last_fact_kind, last_semantic_child_identity)
    );
end;
$$;

-- The manifest lives with staged items through group completion and publication.
-- Unique chunk identities plus exact range/count prove that a tail was not lost.
create or replace function ops.problematic_projection_search_complete(
  p_job_id bigint, p_attempt integer, p_revision uuid,
  p_group_kind text, p_group_identity text
)
returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select not exists (
    -- Separate branches retain exact group lookup under a generic query plan.
    select 1 from (
      select item.job_id, item.attempt, item.revision, item.item_key,
        item.search_document_count, item.search_document_digest, item.search_text
      from ops.problematic_projection_item_staging item
      where p_group_kind is not null
        and item.job_id = p_job_id and item.attempt = p_attempt
        and item.revision = p_revision and item.group_kind = p_group_kind
        and item.group_identity = p_group_identity
      union all
      select item.job_id, item.attempt, item.revision, item.item_key,
        item.search_document_count, item.search_document_digest, item.search_text
      from ops.problematic_projection_item_staging item
      where p_group_kind is null
        and item.job_id = p_job_id and item.attempt = p_attempt
        and item.revision = p_revision
    ) item
    left join lateral (
      select count(*) filter (where fact.fact_kind = 'main_search') as chunks,
        max(fact.normalized_text) filter (
          where fact.fact_kind = 'main_search'
            and fact.semantic_child_identity = '00000000000000000000'
        ) as prefix,
        min(fact.semantic_child_identity collate "C") filter (
          where fact.fact_kind = 'main_search'
        ) as first_chunk,
        max(fact.semantic_child_identity collate "C") filter (
          where fact.fact_kind = 'main_search'
        ) as last_chunk,
        bool_and(fact.semantic_child_identity ~ '^[0-9]{20}$') filter (
          where fact.fact_kind = 'main_search'
        ) as valid_ids,
        bool_and(fact.fact_kind in ('main_search', 'private_path_locator')) as valid_kinds
      from ops.problematic_projection_search_fact_staging fact
      where fact.job_id = item.job_id and fact.attempt = item.attempt
        and fact.revision = item.revision and fact.item_key = item.item_key
    ) document on true
    where item.search_document_count is null or item.search_document_digest is null
      or document.chunks <> item.search_document_count
      or document.prefix is distinct from item.search_text
      or document.first_chunk is distinct from '00000000000000000000'
      or document.last_chunk is distinct from pg_catalog.lpad((item.search_document_count - 1)::text, 20, '0')
      or document.valid_ids is distinct from true
      or document.valid_kinds is distinct from true
  ) and not exists (
    -- Whole-build kind validation runs only at publication, never per group.
    select 1 from ops.problematic_projection_search_fact_staging fact
    where p_group_kind is null
      and fact.job_id = p_job_id and fact.attempt = p_attempt
      and fact.revision = p_revision
      and fact.fact_kind not in ('main_search', 'private_path_locator')
  );
$$;

create or replace function ops.complete_claimed_problematic_projection_group(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_source_kind text, p_source_identity text, p_child_kind text,
  p_child_identity text, p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_version integer;
begin
  select ops.problematic_projection_builder_version(job.parameters)
    into selected_version from ops.jobs job where job.id = p_job_id;
  if selected_version is null then
    raise exception 'invalid projection build contract' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    raise exception 'stale projection claim' using errcode = '55000';
  end if;
  if exists (
    select 1
    from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id
      and fact.attempt = p_attempt
      and fact.revision = p_revision
      and fact.group_kind = p_group_kind
      and fact.group_identity = p_group_identity
      and (selected_version = 1 or fact.fact_kind in ('private_path_locator', 'main_search'))
      and fact.fact_kind in (
          'track_title_search', 'private_path_search', 'private_path_locator',
        'album_title_search', 'album_artist_search', 'album_key_search', 'main_search'
      )
      and exists (
        select 1
        from ops.problematic_projection_item_staging item_staging
        where item_staging.job_id = fact.job_id
          and item_staging.attempt = fact.attempt
          and item_staging.revision = fact.revision
          and item_staging.group_kind = fact.group_kind
          and item_staging.group_identity = fact.group_identity
          and item_staging.item_key = fact.projection_id
      )
      and not exists (
        select 1
        from ops.problematic_projection_search_fact_staging search_staging
        where search_staging.job_id = fact.job_id
          and search_staging.attempt = fact.attempt
          and search_staging.revision = fact.revision
          and search_staging.item_key = fact.projection_id
          and search_staging.fact_kind = fact.fact_kind
          and search_staging.semantic_child_identity = fact.semantic_child_identity
      )
  ) then
    raise exception 'projection search facts are not fully staged'
      using errcode = '55000';
  end if;
  if selected_version = 2 and not ops.problematic_projection_search_complete(
    p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity
  ) then
    raise exception 'projection main search document is incomplete' using errcode = '55000';
  end if;
  update ops.problematic_projection_state as projection_state set
    group_kind = null, group_identity = null,
    source_kind = p_source_kind, source_identity = p_source_identity,
    child_kind = null, child_identity = null,
    updated_at = p_observed_at
  where projection_state.library_id = p_library_id
    and projection_state.live_job_id = p_job_id
    and projection_state.source_generation = p_source_generation
    and projection_state.rebuild_epoch = p_rebuild_epoch
    and projection_state.build_revision = p_revision
    and projection_state.requested_job_id = p_job_id
    and projection_state.requested_attempt = p_attempt
    and projection_state.requested_revision = p_revision;
  if not found then
    raise exception 'stale projection claim' using errcode = '55000';
  end if;
  delete from ops.problematic_projection_source_staging as source_staging
  where source_staging.job_id = p_job_id
    and source_staging.attempt = p_attempt
    and source_staging.revision = p_revision
    and source_staging.group_kind = p_group_kind
    and source_staging.group_identity = p_group_identity;
  delete from ops.problematic_projection_group_accumulators as accumulator
  where accumulator.job_id = p_job_id
    and accumulator.attempt = p_attempt
    and accumulator.revision = p_revision
    and accumulator.group_kind = p_group_kind
    and accumulator.group_identity = p_group_identity;
  delete from ops.problematic_projection_group_facts as fact
  where fact.job_id = p_job_id
    and fact.attempt = p_attempt
    and fact.revision = p_revision
    and fact.group_kind = p_group_kind
    and fact.group_identity = p_group_identity;
  return query select true;
end;
$$;

create or replace function ops.publish_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_observed_at timestamptz
)
returns table(published boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  projected_total integer;
  selected_version integer;
  projected_facets jsonb;
  projected_reason_fact_count bigint;
  projected_reason_fingerprint bit(256);
  projected_search_fact_count bigint;
  projected_search_fingerprint bit(256);
  source_drained boolean;
  locked_state ops.problematic_projection_state%rowtype;
  database_now timestamptz;
begin
  select ops.problematic_projection_builder_version(job.parameters)
    into selected_version from ops.jobs job where job.id = p_job_id;
  if selected_version is null then return query select false; return; end if;
  select * into locked_state
  from ops.problematic_projection_state state
  where state.library_id = p_library_id
  for update;
  database_now := pg_catalog.clock_timestamp();
    if found
       and locked_state.library_id = p_library_id
       and locked_state.committed_job_id = p_job_id
       and locked_state.committed_revision = p_revision
       and locked_state.source_generation = p_source_generation
       and locked_state.rebuild_epoch = p_rebuild_epoch
       and ops.problematic_projection_claim_valid(
           p_job_id, p_attempt, p_worker_id, p_lease_token, p_observed_at
       ) then
    with replay_cleanup as (
      delete from ops.problematic_projection_headers as replay_header
      where replay_header.library_id = p_library_id
        and replay_header.revision <> locked_state.committed_revision
        and replay_header.revision <> coalesce((
        select predecessor.revision
        from ops.problematic_projection_headers predecessor
        where predecessor.library_id = p_library_id
          and predecessor.revision <> locked_state.committed_revision
        order by predecessor.source_generation desc,
          predecessor.rebuild_epoch desc, predecessor.revision desc
        limit 1
        ), locked_state.committed_revision)
      returning 1
    )
    select count(*) into projected_total from replay_cleanup;
    published := true;
    return next;
        return;
    end if;
  if not found or not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then return query select false; return; end if;
  select coalesce(
    bool_and(source_page.group_kind is null and source_page.page_complete),
    false
  ) into source_drained
  from ops.load_claimed_problematic_projection_source(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, 1, 1, p_observed_at
  ) source_page;
  if not (
    locked_state.group_kind is null
    and source_drained
    and not exists (
       select 1 from ops.problematic_projection_source_staging source_staging
       where source_staging.job_id = p_job_id
         and source_staging.attempt = p_attempt
         and source_staging.revision = p_revision
    )
    and not exists (
       select 1 from ops.problematic_projection_group_accumulators accumulator
       where accumulator.job_id = p_job_id
         and accumulator.attempt = p_attempt
         and accumulator.revision = p_revision
    )
    and not exists (
       select 1 from ops.problematic_projection_group_facts fact
       where fact.job_id = p_job_id
         and fact.attempt = p_attempt
         and fact.revision = p_revision
    )
  ) then
    return query select false;
    return;
  end if;
  if selected_version = 2 and not ops.problematic_projection_search_complete(
    p_job_id, p_attempt, p_revision, null, null
  ) then return query select false; return; end if;
  select count(*)::integer into projected_total
  from ops.problematic_projection_item_staging as item_staging
  where item_staging.job_id = p_job_id
    and item_staging.attempt = p_attempt
    and item_staging.revision = p_revision;
  if exists (
    select 1
    from ops.problematic_projection_reason_fact_staging reason_staging
    left join ops.problematic_projection_item_staging item_staging
      on item_staging.job_id = reason_staging.job_id
      and item_staging.attempt = reason_staging.attempt
      and item_staging.revision = reason_staging.revision
      and item_staging.item_key = reason_staging.item_key
    where reason_staging.job_id = p_job_id
      and reason_staging.attempt = p_attempt
      and reason_staging.revision = p_revision
      and item_staging.item_key is null
  ) or exists (
    select 1
    from ops.problematic_projection_item_staging item_staging
    where item_staging.job_id = p_job_id
      and item_staging.attempt = p_attempt
      and item_staging.revision = p_revision
      and not exists (
        select 1
        from ops.problematic_projection_reason_fact_staging reason_staging
        where reason_staging.job_id = item_staging.job_id
          and reason_staging.attempt = item_staging.attempt
          and reason_staging.revision = item_staging.revision
          and reason_staging.item_key = item_staging.item_key
      )
  ) then
    return query select false;
    return;
  end if;
  select coalesce(jsonb_object_agg(reason, reason_count), '{}'::jsonb)
    into projected_facets
  from (
    select category_reason reason, count(distinct item_key)::integer reason_count
    from ops.problematic_projection_reason_fact_staging
    where job_id = p_job_id and attempt = p_attempt
      and revision = p_revision
    group by category_reason
  ) facets;
  select count(*)::bigint,
    coalesce(
      bit_xor(
        (
          'x' || pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.octet_length(pg_catalog.convert_to(item_key, 'UTF8'))::text || ':' || item_key ||
          pg_catalog.octet_length(pg_catalog.convert_to(normalized_reason, 'UTF8'))::text || ':' || normalized_reason ||
          pg_catalog.octet_length(pg_catalog.convert_to(display_reason, 'UTF8'))::text || ':' || display_reason ||
          pg_catalog.octet_length(pg_catalog.convert_to(category_reason, 'UTF8'))::text || ':' || category_reason,
              'UTF8'
            )),
            'hex'
          )
        )::bit(256)
      ),
      0::bit(256)
    )
  into projected_reason_fact_count, projected_reason_fingerprint
  from ops.problematic_projection_reason_fact_staging
  where job_id = p_job_id and attempt = p_attempt and revision = p_revision;
  select count(*)::bigint,
    coalesce(
      bit_xor(
        (
          'x' || pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.octet_length(pg_catalog.convert_to(item_key, 'UTF8'))::text || ':' || item_key ||
          pg_catalog.octet_length(pg_catalog.convert_to(fact_kind, 'UTF8'))::text || ':' || fact_kind ||
          pg_catalog.octet_length(pg_catalog.convert_to(semantic_child_identity, 'UTF8'))::text || ':' || semantic_child_identity ||
          pg_catalog.octet_length(pg_catalog.convert_to(normalized_text, 'UTF8'))::text || ':' || normalized_text,
              'UTF8'
            )),
            'hex'
          )
        )::bit(256)
      ),
      0::bit(256)
    )
  into projected_search_fact_count, projected_search_fingerprint
  from ops.problematic_projection_search_fact_staging
  where job_id = p_job_id and attempt = p_attempt and revision = p_revision;
  insert into ops.problematic_projection_headers(
    library_id, revision, source_generation, rebuild_epoch, builder_version,
    total, item_count, reason_facets, reason_fact_count, reason_fingerprint,
    search_fact_count, search_fingerprint,
    verified, published_at
  ) values (
    p_library_id, p_revision, p_source_generation, p_rebuild_epoch, selected_version,
    projected_total, projected_total, projected_facets,
    projected_reason_fact_count, projected_reason_fingerprint,
    projected_search_fact_count, projected_search_fingerprint,
    true, p_observed_at
  );
  insert into ops.problematic_projection_items(
    library_id, revision, item_key, sort_title, sort_artist, sort_year,
    sort_album_key, search_text, reasons, summary
  ) select p_library_id, p_revision, item_key, sort_title, sort_artist,
    sort_year, sort_album_key, search_text, reasons, summary
  from ops.problematic_projection_item_staging
  where job_id = p_job_id and attempt = p_attempt and revision = p_revision;
  insert into ops.problematic_projection_reason_facts(
    library_id, revision, item_key, normalized_reason, display_reason,
    category_reason
  )
  select p_library_id, p_revision, item_key, normalized_reason, display_reason,
    category_reason
  from ops.problematic_projection_reason_fact_staging
  where job_id = p_job_id and attempt = p_attempt and revision = p_revision;
  insert into ops.problematic_projection_search_facts(
    library_id, revision, item_key, fact_kind,
    semantic_child_identity, normalized_text
  ) select p_library_id, p_revision, item_key, fact_kind,
    semantic_child_identity, normalized_text
  from ops.problematic_projection_search_fact_staging
  where job_id = p_job_id and attempt = p_attempt and revision = p_revision;
  update ops.problematic_projection_state as projection_state set
        committed_job_id = p_job_id,
        committed_revision = p_revision, committed_total = projected_total,
        reason_facets = projected_facets, verified = true, live_job_id = null,
    build_revision = null, requested_job_id = null, requested_attempt = null,
    requested_revision = null, recovery_reason_code = null,
    next_integrity_audit_at = database_now + interval '15 minutes',
    audit_revision = null, audit_after_fact_type = null,
    audit_after_item_key = null, audit_after_identity_one = null,
    audit_after_identity_two = null, audit_after_identity_three = null,
    audit_item_count = 0, audit_last_counted_item_key = null,
    audit_reason_fact_count = 0, audit_reason_fingerprint = 0::bit(256),
    audit_search_fact_count = 0, audit_search_fingerprint = 0::bit(256),
    updated_at = database_now
  where projection_state.library_id = p_library_id
    and projection_state.live_job_id = p_job_id
    and projection_state.source_generation = p_source_generation
    and projection_state.rebuild_epoch = p_rebuild_epoch;
  locked_state.committed_revision := p_revision;
  delete from ops.problematic_projection_search_fact_staging as search_staging
  where search_staging.job_id = p_job_id
    and search_staging.attempt = p_attempt
    and search_staging.revision = p_revision;
  delete from ops.problematic_projection_item_staging as item_staging
  where item_staging.job_id = p_job_id
    and item_staging.attempt = p_attempt
    and item_staging.revision = p_revision;
  delete from ops.problematic_projection_headers as old_header
  where old_header.library_id = p_library_id
    and old_header.revision <> locked_state.committed_revision
    and old_header.revision <> coalesce((
      select predecessor.revision
      from ops.problematic_projection_headers predecessor
      where predecessor.library_id = p_library_id
        and predecessor.revision <> locked_state.committed_revision
      order by predecessor.source_generation desc,
        predecessor.rebuild_epoch desc, predecessor.revision desc
      limit 1
    ), locked_state.committed_revision);
  return query select true;
end;
$$;

create or replace function ops.fail_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_reason_code text, p_observed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_state ops.problematic_projection_state%rowtype;
  replacement_job_id bigint;
  selected_parameters jsonb;
  selected_version integer;
  replacement_epoch bigint;
begin
  select job.parameters into selected_parameters from ops.jobs job where job.id = p_job_id;
  selected_version := ops.problematic_projection_builder_version(selected_parameters);
  if selected_version is null then return; end if;
  if ops.problematic_projection_claim_valid(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_observed_at
  ) then
    select projection_state.* into selected_state
    from ops.problematic_projection_state as projection_state
    where projection_state.live_job_id = p_job_id
      and projection_state.requested_job_id = p_job_id
      and (
        projection_state.build_revision is null or
        projection_state.requested_attempt = p_attempt
      )
      and (p_library_id is null or projection_state.library_id = p_library_id)
      and (
        p_source_generation is null or
        projection_state.source_generation = p_source_generation
      )
      and (
        p_rebuild_epoch is null or
        projection_state.rebuild_epoch = p_rebuild_epoch
      )
      and (
        p_revision is null or projection_state.build_revision = p_revision
      )
      and projection_state.requested_revision is not distinct from
        projection_state.build_revision
    for update;
    if not found then
      return;
    end if;
    update ops.problematic_projection_state as projection_state set
      rebuild_epoch = projection_state.rebuild_epoch + 1,
      live_job_id = null,
      build_revision = null, requested_job_id = null, requested_attempt = null,
      requested_revision = null,
      recovery_reason_code = left(nullif(p_reason_code, ''), 128),
      updated_at = p_observed_at
    where projection_state.library_id = selected_state.library_id
      and projection_state.live_job_id = p_job_id
      and projection_state.source_generation = selected_state.source_generation
      and projection_state.rebuild_epoch = selected_state.rebuild_epoch
      and projection_state.build_revision is not distinct from
        selected_state.build_revision
      and projection_state.requested_job_id = p_job_id
      and projection_state.requested_attempt = selected_state.requested_attempt
      and projection_state.requested_revision is not distinct from
        selected_state.requested_revision
    returning projection_state.rebuild_epoch into replacement_epoch;
    if found then
      insert into ops.jobs(
        kind, subject_kind, subject_ref, parameters, library_id,
        deployment_mode, client_surface, idempotency_key, scheduled_at,
        max_attempts, recovery_policy, resource_revision
      ) values (
        'problematic_files_projection', 'problematic_files_projection',
        'library:' || selected_state.library_id::text,
        pg_catalog.jsonb_build_object(
          'projection_kind', 'problematic_files',
          'source_generation', selected_state.source_generation,
          'rebuild_epoch', replacement_epoch
        ) || case when selected_parameters ? 'builder_version'
          then pg_catalog.jsonb_build_object('builder_version', selected_version) else '{}'::jsonb end,
        selected_state.library_id, 'self_hosted', 'private_web',
        'problematic-files-projection:' || selected_state.library_id::text || ':' ||
          selected_state.source_generation::text || ':' || replacement_epoch::text ||
          case when selected_version = 2 then ':v2' else '' end,
        p_observed_at, 3, 'retry_safe', selected_state.source_generation
      ) returning id into replacement_job_id;
      update ops.problematic_projection_state as projection_state set
        live_job_id = replacement_job_id,
        requested_job_id = replacement_job_id,
        updated_at = p_observed_at
      where projection_state.library_id = selected_state.library_id
        and projection_state.rebuild_epoch = replacement_epoch
        and projection_state.live_job_id is null;
    end if;
    delete from ops.problematic_projection_source_staging as source_staging
    where source_staging.job_id = p_job_id
      and source_staging.attempt = p_attempt
      and source_staging.revision = p_revision;
    delete from ops.problematic_projection_search_fact_staging as search_staging
    where search_staging.job_id = p_job_id
      and search_staging.attempt = p_attempt
      and search_staging.revision = p_revision;
    delete from ops.problematic_projection_item_staging as item_staging
    where item_staging.job_id = p_job_id
      and item_staging.attempt = p_attempt
      and item_staging.revision = p_revision;
    delete from ops.problematic_projection_group_accumulators as accumulator
    where accumulator.job_id = p_job_id
      and accumulator.attempt = p_attempt
      and accumulator.revision = p_revision;
  end if;
end;
$$;

create or replace function ops.reclaim_one_abandoned_problematic_projection(
  ignored_observed_at timestamptz
)
returns table(reclaimed boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_state ops.problematic_projection_state%rowtype;
  selected_job ops.jobs%rowtype;
  replacement_job_id bigint;
  selected_version integer;
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  select state.* into selected_state
  from ops.problematic_projection_state state
  join ops.jobs job on state.live_job_id = job.id
  where state.build_revision is not null
    and state.requested_job_id = job.id
    and state.requested_attempt = job.attempt_count
    and state.requested_revision = state.build_revision
    and (
      job.state in ('succeeded', 'failed', 'canceled', 'ambiguous')
      or (
        job.state = 'running'
        and job.lease_expires_at < database_now
      )
    )
  order by state.updated_at, state.library_id
  for update of state skip locked
  limit 1;
  if not found then
    return query select false;
    return;
  end if;

  select * into selected_job
  from ops.jobs job
  where job.id = selected_state.live_job_id
  for update;
  if not found
     or selected_state.requested_job_id <> selected_job.id
     or selected_state.requested_attempt <> selected_job.attempt_count
     or selected_state.requested_revision is distinct from selected_state.build_revision
     or not (
       selected_job.state in ('succeeded', 'failed', 'canceled', 'ambiguous')
       or (
         selected_job.state = 'running'
         and selected_job.lease_expires_at < database_now
       )
     ) then
    return query select false;
    return;
  end if;

  selected_version := ops.problematic_projection_builder_version(selected_job.parameters);
  if selected_version is null then return query select false; return; end if;
  delete from ops.problematic_projection_source_staging as source_staging
  where source_staging.job_id = selected_state.requested_job_id
    and source_staging.attempt = selected_state.requested_attempt
    and source_staging.revision = selected_state.requested_revision;
  delete from ops.problematic_projection_item_staging as item_staging
  where item_staging.job_id = selected_state.requested_job_id
    and item_staging.attempt = selected_state.requested_attempt
    and item_staging.revision = selected_state.requested_revision;
  delete from ops.problematic_projection_group_accumulators as accumulator
  where accumulator.job_id = selected_state.requested_job_id
    and accumulator.attempt = selected_state.requested_attempt
    and accumulator.revision = selected_state.requested_revision;
  delete from ops.problematic_projection_group_facts as fact
  where fact.job_id = selected_state.requested_job_id
    and fact.attempt = selected_state.requested_attempt
    and fact.revision = selected_state.requested_revision;
  insert into ops.jobs(
    kind, subject_kind, subject_ref, parameters, library_id,
    deployment_mode, client_surface, idempotency_key, scheduled_at,
    max_attempts, recovery_policy, resource_revision
  ) values (
    'problematic_files_projection', 'problematic_files_projection',
    'library:' || selected_state.library_id::text,
    pg_catalog.jsonb_build_object(
      'projection_kind', 'problematic_files',
      'source_generation', selected_state.source_generation,
      'rebuild_epoch', selected_state.rebuild_epoch + 1
    ) || case when selected_job.parameters ? 'builder_version'
      then pg_catalog.jsonb_build_object('builder_version', selected_version) else '{}'::jsonb end,
    selected_state.library_id, 'self_hosted', 'private_web',
    'problematic-files-projection:' || selected_state.library_id::text || ':' ||
      selected_state.source_generation::text || ':' ||
      (selected_state.rebuild_epoch + 1)::text ||
      case when selected_version = 2 then ':v2' else '' end,
    database_now, 3, 'retry_safe', selected_state.source_generation
  ) returning id into replacement_job_id;
  update ops.jobs as replacement_job
  set scheduled_at = database_now
  where replacement_job.id = replacement_job_id;
  update ops.problematic_projection_state as projection_state set
    rebuild_epoch = projection_state.rebuild_epoch + 1,
    live_job_id = replacement_job_id,
    build_revision = null,
    requested_job_id = replacement_job_id,
    requested_attempt = 1,
    requested_revision = null,
    recovery_reason_code = case
      when selected_job.state in ('succeeded', 'failed', 'canceled', 'ambiguous')
        then 'abandoned-terminal-' || selected_job.state
      else 'abandoned-expired-lease'
    end,
    group_kind = null,
    group_identity = null,
    scan_kind = null,
    scan_identity = null,
    source_kind = null,
    source_identity = null,
    child_kind = null,
    child_identity = null,
    updated_at = database_now
  where projection_state.library_id = selected_state.library_id
    and projection_state.live_job_id = selected_job.id
    and projection_state.build_revision = selected_state.build_revision
    and projection_state.requested_job_id = selected_state.requested_job_id
    and projection_state.requested_attempt = selected_state.requested_attempt
    and projection_state.requested_revision = selected_state.requested_revision;
  if not found then
    return query select false;
    return;
  end if;
  return query select true;
end;
$$;

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
    'problematic_files_projection',
    'targeted_reconciliation'
  ];
  baseline_kinds constant text[] := pg_catalog.array_remove(
    expected_kinds,
    'problematic_files_projection'
  );
  cover_finalization_functions constant text[] := array[
    'library.resolve_cover_mutation_identity(bigint,text[])',
    'library.read_cover_mutation_revision(bigint)',
    'library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,integer,integer,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamp with time zone)',
    'library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,text,bigint,integer,text,text,bigint,bigint,timestamp with time zone)',
    'library.load_cover_mutation_baseline(bigint,bigint)',
    'ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamp with time zone)',
    'ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamp with time zone)',
    'ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamp with time zone,text,timestamp with time zone)',
    'ops.requeue_expired_cover_finalization(timestamp with time zone)',
    'ops.reconcile_stale_job_leases(timestamp with time zone,integer)'
  ];
  required_functions constant text[] := array[
    'ops.problematic_projection_claim_valid(bigint,integer,text,text,timestamp with time zone)',
    'ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamp with time zone)',
    'ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamp with time zone,integer)',
    'ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamp with time zone)',
    'ops.validate_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamp with time zone)',
    'ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamp with time zone)',
    'ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamp with time zone)',
    'ops.load_claimed_problematic_projection_staged_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamp with time zone)',
    'ops.load_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamp with time zone)',
    'ops.advance_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,bigint,integer,bigint,timestamp with time zone)',
    'ops.checkpoint_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,jsonb,integer,bigint,timestamp with time zone)',
    'ops.load_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamp with time zone)',
    'ops.stage_claimed_problematic_projection_items(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,integer,timestamp with time zone)',
    'ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamp with time zone)',
    'ops.stage_claimed_problematic_projection_reason_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamp with time zone)',
    'ops.complete_claimed_problematic_projection_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,timestamp with time zone)',
    'ops.publish_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamp with time zone)',
    'ops.fail_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,timestamp with time zone)',
    'ops.cleanup_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamp with time zone)',
    'ops.reclaim_one_abandoned_problematic_projection(timestamp with time zone)',
    'ops.load_due_problematic_projection_integrity_audit(timestamp with time zone)',
    'ops.advance_problematic_projection_integrity_audit(bigint,uuid,uuid,text,text,text,text,text,integer,bigint,bit,bigint,bit,text,text,text,text,text,integer,text,bigint,bit,bigint,bit,timestamp with time zone)',
    'ops.load_problematic_projection_integrity_page(bigint,uuid,text,text,text,text,text,integer)',
    'ops.complete_problematic_projection_integrity_audit(bigint,uuid,uuid,integer,bigint,bit,bigint,bit,timestamp with time zone)'
  ];
begin
  if exists (
    select 1
    from pg_catalog.unnest(cover_finalization_functions) as required(signature)
    where pg_catalog.to_regprocedure(required.signature) is null
       or not pg_catalog.has_function_privilege(
         session_user, pg_catalog.to_regprocedure(required.signature), 'EXECUTE'
       )
  ) then
    return false;
  end if;
  if p_registered_kinds is not distinct from baseline_kinds then
    return ops.validate_durable_worker_startup_baseline_0125(p_registered_kinds);
  end if;
  if p_registered_kinds is distinct from expected_kinds then
    return false;
  end if;
  if p_registered_kinds is not distinct from expected_kinds then
    null;
  end if;
  if not ops.validate_durable_worker_startup_baseline_0125(
    array_remove(p_registered_kinds, 'problematic_files_projection')
  ) then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.unnest(required_functions) as required(signature)
    where pg_catalog.to_regprocedure(required.signature) is null
       or not pg_catalog.has_function_privilege(
         session_user, required.signature, 'EXECUTE'
       )
  ) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function ops.complete_problematic_projection_integrity_audit(
  p_library_id bigint, p_revision uuid, p_audit_claim_token uuid,
  p_item_count integer,
  p_reason_fact_count bigint, p_reason_fingerprint bit(256),
  p_search_fact_count bigint, p_search_fingerprint bit(256),
  ignored_observed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  expected_total integer;
  selected_version integer;
  expected_reason_fact_count bigint;
  expected_reason_fingerprint bit(256);
  expected_search_fact_count bigint;
  expected_search_fingerprint bit(256);
  claimed_state ops.problematic_projection_state%rowtype;
  database_now timestamptz;
begin
  select * into claimed_state
  from ops.problematic_projection_state state
  where state.library_id = p_library_id
  for update;
  database_now := pg_catalog.clock_timestamp();
  if not found or claimed_state.committed_revision is distinct from p_revision
     or claimed_state.audit_revision is distinct from p_revision
     or claimed_state.audit_claim_token is distinct from p_audit_claim_token
     or claimed_state.audit_claimed_at < database_now - interval '5 minutes'
     then return; end if;
  select header.total, header.reason_fact_count, header.reason_fingerprint,
    header.search_fact_count, header.search_fingerprint
  into expected_total, expected_reason_fact_count, expected_reason_fingerprint,
    expected_search_fact_count, expected_search_fingerprint
  from ops.problematic_projection_headers header
  where header.library_id = p_library_id and header.revision = p_revision;
  if not found or expected_total <> p_item_count
    or expected_reason_fact_count <> p_reason_fact_count
    or expected_reason_fingerprint <> p_reason_fingerprint
    or expected_search_fact_count <> p_search_fact_count
    or expected_search_fingerprint <> p_search_fingerprint then
    update ops.problematic_projection_state as projection_state set verified = false,
      audit_claim_token = null, audit_claimed_at = null,
      next_integrity_audit_at = database_now, updated_at = database_now
    where projection_state.library_id = p_library_id
      and projection_state.committed_revision = p_revision
      and projection_state.audit_claim_token = p_audit_claim_token;
    select ops.problematic_projection_builder_version(job.parameters)
      into selected_version from ops.jobs job where job.id = claimed_state.committed_job_id;
    if selected_version is null then
      select header.builder_version into selected_version
      from ops.problematic_projection_headers header
      where header.library_id = p_library_id and header.revision = p_revision;
    end if;
    if selected_version in (1, 2) then
      perform * from ops.enqueue_problematic_projection_rebuild(
        p_library_id, 'integrity-reconciler', selected_version
      );
    end if;
  else
    update ops.problematic_projection_state as projection_state set
      audit_revision = null, audit_after_fact_type = null,
      audit_after_item_key = null, audit_after_identity_one = null,
      audit_after_identity_two = null, audit_after_identity_three = null,
      audit_item_count = 0, audit_last_counted_item_key = null,
      audit_reason_fact_count = 0, audit_reason_fingerprint = 0::bit(256),
      audit_search_fact_count = 0, audit_search_fingerprint = 0::bit(256),
      audit_claim_token = null, audit_claimed_at = null,
      next_integrity_audit_at = database_now + interval '15 minutes',
      updated_at = database_now
    where projection_state.library_id = p_library_id
      and projection_state.committed_revision = p_revision
      and projection_state.audit_claim_token = p_audit_claim_token;
  end if;
end;
$$;

create or replace function ops.checkpoint_claimed_problematic_projection_group_facts(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_expected_after_stage_id bigint, p_entries jsonb,
  p_next_batch_index integer, p_row_count bigint, p_observed_at timestamptz
)
returns table(
  after_stage_id bigint, next_batch_index integer, row_count bigint,
  source_complete boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  last_stage_id bigint;
begin
  if pg_catalog.jsonb_typeof(p_entries) <> 'array'
     or pg_catalog.jsonb_array_length(p_entries) < 1
     or pg_catalog.jsonb_array_length(p_entries) > 100 then
    raise exception 'invalid projection group facts' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    return;
  end if;
  select max((entry ->> 'stage_id')::bigint)
  into last_stage_id
  from pg_catalog.jsonb_array_elements(p_entries) entry;
  if last_stage_id <= p_expected_after_stage_id then
    raise exception 'projection group fact order regressed' using errcode = '22023';
  end if;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity,
    stage_id, projection_id, fact_kind, semantic_child_identity,
    fact_value, created_at
  )
  -- Repeated semantic facts may share a batch; keep their earliest source row.
  -- Differing payloads retain separate rows and fail the unique-key statement.
  select p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    min(input.stage_id), input.projection_id, input.fact_kind,
    input.semantic_child_identity,
    input.payload || case when input.fact_kind = 'duplicate_root'
      then pg_catalog.jsonb_build_object('primary', pg_catalog.bool_or(input.is_primary))
      else '{}'::jsonb end,
    p_observed_at
  from (
    select (entry ->> 'stage_id')::bigint as stage_id,
      entry ->> 'projection_id' as projection_id,
      entry ->> 'fact_kind' as fact_kind,
      entry ->> 'semantic_child_identity' as semantic_child_identity,
      case when entry ->> 'fact_kind' = 'duplicate_root'
        then (entry -> 'fact_value') - 'primary' else entry -> 'fact_value' end as payload,
      case when entry ->> 'fact_kind' = 'duplicate_root'
        then coalesce((entry #>> '{fact_value,primary}')::boolean, false)
        else false end as is_primary
    from pg_catalog.jsonb_array_elements(p_entries) entry
  ) input
  group by input.projection_id, input.fact_kind, input.semantic_child_identity,
    input.payload
  on conflict (
    job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity
  ) do update set
    stage_id = least(
      ops.problematic_projection_group_facts.stage_id,
      excluded.stage_id
    ),
    fact_value = case
      when excluded.fact_kind = 'duplicate_root' then
        ops.problematic_projection_group_facts.fact_value ||
        pg_catalog.jsonb_build_object(
          'primary',
          coalesce(
            (ops.problematic_projection_group_facts.fact_value ->> 'primary')::boolean,
            false
          ) or coalesce(
            (excluded.fact_value ->> 'primary')::boolean,
            false
          )
        )
      else excluded.fact_value
    end,
    created_at = excluded.created_at;
  update ops.problematic_projection_group_accumulators as accumulator set
    after_stage_id = last_stage_id,
    next_batch_index = p_next_batch_index,
    row_count = p_row_count,
    updated_at = p_observed_at
  where accumulator.job_id = p_job_id
    and accumulator.attempt = p_attempt
    and accumulator.revision = p_revision
    and accumulator.group_kind = p_group_kind
    and accumulator.group_identity = p_group_identity
    and accumulator.after_stage_id = p_expected_after_stage_id;
  if not found then
    raise exception 'stale projection group checkpoint' using errcode = '55000';
  end if;
  return query select last_stage_id, p_next_batch_index, p_row_count,
    accumulator.source_complete
  from ops.problematic_projection_group_accumulators accumulator
  where accumulator.job_id = p_job_id
    and accumulator.attempt = p_attempt
    and accumulator.revision = p_revision
    and accumulator.group_kind = p_group_kind
    and accumulator.group_identity = p_group_identity;
end;
$$;

revoke all on function ops.enqueue_problematic_projection_rebuild(bigint,text,integer) from public;
revoke all on function ops.enqueue_problematic_projection_rebuild(bigint,text,integer) from album_haven_app;
revoke all on function ops.enqueue_problematic_projection_rebuild(bigint,text,integer) from album_haven_readonly;
revoke all on function ops.enqueue_problematic_projection_rebuild(bigint,text,integer) from album_haven_worker;
grant execute on function ops.enqueue_problematic_projection_rebuild(bigint,text,integer) to album_haven_app;

revoke all on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz,integer) from public;
revoke all on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz,integer) from album_haven_app;
revoke all on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz,integer) from album_haven_readonly;
revoke all on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz,integer) from album_haven_worker;
grant execute on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz,integer) to album_haven_worker;

revoke all on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) from public;
revoke all on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) from album_haven_app;
revoke all on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) from album_haven_readonly;
revoke all on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) from album_haven_worker;
grant execute on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) to album_haven_worker;

revoke all on function ops.problematic_projection_builder_version(jsonb) from public;
revoke all on function ops.problematic_projection_builder_version(jsonb) from album_haven_app;
revoke all on function ops.problematic_projection_builder_version(jsonb) from album_haven_readonly;
revoke all on function ops.problematic_projection_builder_version(jsonb) from album_haven_worker;

revoke all on function ops.problematic_projection_search_complete(bigint,integer,uuid,text,text) from public;
revoke all on function ops.problematic_projection_search_complete(bigint,integer,uuid,text,text) from album_haven_app;
revoke all on function ops.problematic_projection_search_complete(bigint,integer,uuid,text,text) from album_haven_readonly;
revoke all on function ops.problematic_projection_search_complete(bigint,integer,uuid,text,text) from album_haven_worker;
