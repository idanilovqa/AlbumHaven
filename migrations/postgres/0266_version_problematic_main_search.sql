-- depends on: 0249_create_problematic_files_projection.sql
-- Expand only: preserve v1 rows/signatures and never relabel old snapshots.
-- Rollout drains old APIs/projectors before v2 publication; rollback stops v2,
-- verifies a retained or freshly rebuilt v1 snapshot, then restarts old code.
alter table ops.problematic_projection_headers
  drop constraint problematic_projection_headers_builder_version_check;
alter table ops.problematic_projection_headers
  add constraint problematic_projection_headers_builder_version_check
  check (builder_version in (1, 2, 3));
alter table ops.problematic_projection_state
  add column topology_completed_group_count bigint check (topology_completed_group_count >= 0),
  add column topology_completed_group_fingerprint bit(256),
  add constraint problematic_projection_state_topology_pair_check check (
    (topology_completed_group_count is null) = (topology_completed_group_fingerprint is null)
  );
alter table ops.problematic_projection_headers
  add column topology_completed_group_count bigint check (topology_completed_group_count >= 0),
  add column topology_completed_group_fingerprint bit(256),
  add constraint problematic_projection_headers_topology_pair_check check (
    (topology_completed_group_count is null) = (topology_completed_group_fingerprint is null)
  );
alter table ops.problematic_projection_item_staging
  add column search_document_count bigint check (search_document_count > 0),
  add column search_document_digest text check (search_document_digest ~ '^[0-9a-f]{64}$');

-- Group completion visits only its items; the existing PK cannot locate a group.
-- Search facts reuse their existing (job, attempt, revision, item_key, ...) PK.
create index problematic_projection_item_staging_group_idx
  on ops.problematic_projection_item_staging
  (job_id, attempt, revision, group_kind, group_identity, item_key);
create index problematic_projection_topology_stage_idx
  on ops.problematic_projection_group_facts
  (job_id, attempt, revision, group_kind, group_identity, fact_kind, stage_id);
create unique index problematic_projection_topology_partition_file_idx
  on ops.problematic_projection_group_facts
  (job_id, attempt, revision, group_kind, group_identity, semantic_child_identity)
  where fact_kind = 'topology_parent_partition';
create index problematic_projection_topology_control_cursor_idx
  on ops.problematic_projection_group_facts
  (job_id, attempt, revision, group_kind, group_identity, fact_kind, semantic_child_identity collate "C")
  where projection_id = 'topology';
create index problematic_projection_topology_folder_lookup_idx
  on ops.problematic_projection_group_facts
  (job_id, attempt, revision, semantic_child_identity, group_identity)
  where group_kind = 'topology_address' and projection_id = 'topology'
    and fact_kind = 'topology_folder_status';

-- Preserve the historical identity helper/index contract. Normalize input
-- before delegating so corrected candidates follow the canonical NFC order.
create or replace function library.problematic_duplicate_identity_text(value text)
returns text language sql immutable parallel safe strict set search_path = pg_catalog
as $$
  select library.duplicate_identity_text(normalize(value, NFC));
$$;
revoke all on function library.problematic_duplicate_identity_text(text) from public;
do $privileges$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant execute on function library.problematic_duplicate_identity_text(text) to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant execute on function library.problematic_duplicate_identity_text(text) to album_haven_migrator;
  end if;
end;
$privileges$;

-- Hashes select candidates only; lookups retain full identity witnesses. Keep
-- tuples bounded without storing raw identities or private paths in the index.
create index local_track_files_problematic_nfc_identity_page_idx
  on library.local_track_files (
    pg_catalog.md5(library.problematic_duplicate_identity_text(scan_file_album_artist)),
    pg_catalog.md5(library.problematic_duplicate_identity_text(scan_file_album)),
    library.duplicate_identity_year(scan_file_year), library_root_id, id
  ) include (track_id) where scan_cache_stale is false;

create or replace function library.problematic_immediate_folder_parent(path_value text)
returns text language sql immutable parallel safe strict set search_path = pg_catalog
as $$
  with literal as (
    select pg_catalog.regexp_replace(
    case when library.local_path_style(path_value) = 'windows'
      then pg_catalog.replace(library.local_path_key(path_value), pg_catalog.chr(92), '/')
      else library.local_path_key(path_value) end, '/[^/]*$', '') as folder
  )
  select case when
    pg_catalog.octet_length(pg_catalog.regexp_replace(folder, '^.*/', '')) >
      pg_catalog.char_length(pg_catalog.regexp_replace(folder, '^.*/', ''))
    or pg_catalog.btrim(pg_catalog.regexp_replace(folder, '^.*/', ''),
      pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11) || pg_catalog.chr(12) || pg_catalog.chr(13) ||
      pg_catalog.chr(28) || pg_catalog.chr(29) || pg_catalog.chr(30) || pg_catalog.chr(31) || ' ') ~ '^[0-9]+$'
    then pg_catalog.regexp_replace(folder, '/[^/]*$', '') else null end from literal;
$$;
create index local_track_files_problematic_address_page_idx
  on library.local_track_files
  (pg_catalog.md5(library.problematic_physical_album_container(private_path)), library_root_id, id)
  include (track_id) where scan_cache_stale is false;
create index local_track_files_problematic_parent_page_idx
  on library.local_track_files
  (pg_catalog.md5(library.problematic_immediate_folder_parent(private_path)), library_root_id, id)
  include (track_id) where scan_cache_stale is false;

create or replace function ops.require_claimed_problematic_topology(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_observed_at timestamptz
)
returns void language plpgsql security definer set search_path = pg_catalog
as $$
declare
  selected_state ops.problematic_projection_state%rowtype;
begin
  if not ops.problematic_projection_claim_valid(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_observed_at
  ) then raise exception 'stale projection claim' using errcode = '55000'; end if;
  select state.* into selected_state from ops.problematic_projection_state state
  join ops.jobs job on job.id = p_job_id and job.library_id = state.library_id
    and ops.problematic_projection_builder_version(job.parameters) = 3
  where state.library_id = p_library_id and state.live_job_id = p_job_id
    and state.source_generation = p_source_generation and state.rebuild_epoch = p_rebuild_epoch
    and state.build_revision = p_revision and state.requested_job_id = p_job_id
    and state.requested_attempt = p_attempt and state.requested_revision = p_revision;
  if not found then raise exception 'stale projection claim' using errcode = '55000'; end if;
  if selected_state.topology_completed_group_count is null or selected_state.topology_completed_group_fingerprint is null then
    raise exception 'problematic_projection_topology_unknown' using errcode = '55000'; end if;
end;
$$;

create or replace function ops.problematic_projection_source_offer_key(p_child_kind text, p_child_identity text)
returns text language sql immutable strict set search_path = pg_catalog
as $$
  select case p_child_kind
    when 'file' then '0:' || pg_catalog.lpad(p_child_identity, 20, '0')
    when 'featured_artist' then '1:' || p_child_identity
    when 'ignored_repair' then '2:' || p_child_identity
    when 'topology_source_end' then '3:' || p_child_identity
    else null end;
$$;

create or replace function ops.problematic_projection_source_digest_value(p_value jsonb)
returns jsonb language plpgsql immutable strict set search_path = pg_catalog
as $$
declare
  normalized_value jsonb;
begin
  -- JSON clients discard numeric scale. Hash equal JSON numbers identically.
  case pg_catalog.jsonb_typeof(p_value)
    when 'number' then
      return pg_catalog.to_jsonb(pg_catalog.trim_scale((p_value #>> '{}')::numeric));
    when 'object' then
      select coalesce(pg_catalog.jsonb_object_agg(entry.key,
        ops.problematic_projection_source_digest_value(entry.value)), '{}'::jsonb)
        into normalized_value from pg_catalog.jsonb_each(p_value) entry;
    when 'array' then
      select coalesce(pg_catalog.jsonb_agg(ops.problematic_projection_source_digest_value(entry.value)
        order by entry.ordinality), '[]'::jsonb)
        into normalized_value from pg_catalog.jsonb_array_elements(p_value) with ordinality entry;
    else
      return p_value;
  end case;
  return normalized_value;
end;
$$;

create or replace function ops.register_problematic_topology_node(
  p_job_id bigint, p_attempt integer, p_library_id bigint,
  p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_owner_kind text, p_owner_identity text, p_node_kind text,
  p_definition jsonb, p_observed_at timestamptz
)
returns text language plpgsql security definer set search_path = pg_catalog
as $$
declare
  node_identity text;
  definition jsonb;
  reference_kind text;
begin
  reference_kind := coalesce(p_definition ->> 'reference_kind', 'topology_reference');
  if p_node_kind not in ('topology_identity', 'topology_numeric_bucket', 'topology_address')
    or pg_catalog.jsonb_typeof(p_definition -> 'key') is distinct from 'array'
    or reference_kind not in ('topology_reference', 'topology_physical_reference')
    or (reference_kind = 'topology_physical_reference' and
      (p_node_kind <> 'topology_address' or p_owner_kind not in ('album', 'loose_source'))) then
    raise exception 'invalid topology node definition' using errcode = '22023';
  end if;
  node_identity := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_definition -> 'key')::text, 'UTF8')), 'hex');
  definition := (p_definition - 'reference_kind') || pg_catalog.jsonb_build_object(
    'library_id', p_library_id, 'job_id', p_job_id, 'revision', p_revision,
    'source_generation', p_source_generation, 'rebuild_epoch', p_rebuild_epoch, 'builder_version', 3
  );
  insert into ops.problematic_projection_group_accumulators(
    job_id, attempt, revision, group_kind, group_identity, updated_at
  ) values (p_job_id, p_attempt, p_revision, p_node_kind, node_identity, p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity) do nothing;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, p_node_kind, node_identity, 0,
    'topology', 'topology_definition', 'definition', definition, p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity) do nothing;
  if not exists (
    select 1 from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_node_kind and fact.group_identity = node_identity
      and fact.projection_id = 'topology' and fact.fact_kind = 'topology_definition'
      and fact.semantic_child_identity = 'definition' and fact.fact_value = definition
  ) then raise exception 'topology node key collision' using errcode = '55000'; end if;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, p_owner_kind, p_owner_identity, 0,
    'topology', reference_kind, p_node_kind || ':' || node_identity,
    pg_catalog.jsonb_build_object('node_kind', p_node_kind, 'node_identity', node_identity), p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity) do nothing;
  return node_identity;
end;
$$;

create or replace function ops.problematic_projection_topology_proof_matches(
  p_job_id bigint, p_attempt integer, p_revision uuid
)
returns boolean language sql security definer set search_path = pg_catalog
as $$
  select exists (
    select 1 from ops.problematic_projection_state state
    cross join lateral (
      select count(*) as certificate_count,
        coalesce(bit_xor(('x' || pg_catalog.encode(pg_catalog.sha256(
          pg_catalog.convert_to(certificate.payload::text, 'UTF8')), 'hex'))::bit(256)), 0::bit(256))
          as certificate_fingerprint
      from ops.problematic_projection_source_staging certificate
      where certificate.job_id = p_job_id and certificate.attempt = p_attempt
        and certificate.revision = p_revision
        and certificate.source_kind = 'topology_certificate'
    ) proof
    where state.live_job_id = p_job_id and state.build_revision = p_revision
      and state.requested_attempt = p_attempt
      and state.topology_completed_group_count = proof.certificate_count
      and state.topology_completed_group_fingerprint = proof.certificate_fingerprint
  );
$$;

create or replace function ops.register_problematic_topology_parent_input(
  p_job_id bigint, p_attempt integer, p_library_id bigint,
  p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_parent text, p_lookup_address text, p_observed_at timestamptz
)
returns text language plpgsql security definer set search_path = pg_catalog
as $$
declare
  input_identity text;
  definition jsonb;
begin
  input_identity := 'input:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array('parent', p_parent)::text, 'UTF8')), 'hex');
  definition := pg_catalog.jsonb_build_object(
    'key', pg_catalog.jsonb_build_array('parent', p_parent), 'subordinate_input', true,
    'lookup_address', p_lookup_address, 'library_id', p_library_id, 'job_id', p_job_id,
    'revision', p_revision, 'source_generation', p_source_generation,
    'rebuild_epoch', p_rebuild_epoch, 'builder_version', 3
  );
  insert into ops.problematic_projection_group_accumulators(
    job_id, attempt, revision, group_kind, group_identity, updated_at
  ) values (p_job_id, p_attempt, p_revision, 'topology_numeric_bucket', input_identity, p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity) do nothing;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, 'topology_numeric_bucket', input_identity, 0,
    'topology', 'topology_definition', 'definition', definition, p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity) do nothing;
  if not exists (
    select 1 from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = 'topology_numeric_bucket' and fact.group_identity = input_identity
      and fact.fact_kind = 'topology_definition' and fact.semantic_child_identity = 'definition'
      and fact.fact_value = definition
  ) then raise exception 'topology parent key collision' using errcode = '55000'; end if;
  return input_identity;
end;
$$;

create or replace function ops.register_problematic_topology_own_rank(
  p_job_id bigint, p_attempt integer, p_library_id bigint,
  p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_file_id bigint, p_original_album_key text, p_observed_at timestamptz
)
returns text language plpgsql security definer set search_path = pg_catalog
as $$
declare
  selected_album_id bigint;
  rank_identity text;
  definition jsonb;
begin
  select track.album_id into selected_album_id
  from library.local_track_files file
  join library.local_tracks track on track.id = file.track_id and track.library_id = p_library_id
  left join library.local_albums album on album.id = track.album_id and album.library_id = p_library_id
  where file.id = p_file_id and coalesce(album.album_key, 'loose-source::' || file.id::text) = p_original_album_key;
  if not found then raise exception 'topology rank source key differs' using errcode = '55000'; end if;
  rank_identity := 'rank:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array('rank', p_original_album_key)::text, 'UTF8')), 'hex');
  definition := pg_catalog.jsonb_build_object(
    'key', pg_catalog.jsonb_build_array('rank', p_original_album_key), 'subordinate_own_rank', true,
    'album_id', selected_album_id, 'owner_file_id', case when selected_album_id is null then p_file_id else null end,
    'library_id', p_library_id, 'job_id', p_job_id, 'revision', p_revision,
    'source_generation', p_source_generation, 'rebuild_epoch', p_rebuild_epoch, 'builder_version', 3
  );
  insert into ops.problematic_projection_group_accumulators(
    job_id, attempt, revision, group_kind, group_identity, updated_at
  ) values (p_job_id, p_attempt, p_revision, 'topology_address', rank_identity, p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity) do nothing;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, 'topology_address', rank_identity, 0,
    'topology', 'topology_definition', 'definition', definition, p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity) do nothing;
  if not exists (
    select 1 from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = 'topology_address' and fact.group_identity = rank_identity
      and fact.projection_id = 'topology' and fact.fact_kind = 'topology_definition'
      and fact.semantic_child_identity = 'definition' and fact.fact_value = definition
  ) then raise exception 'topology rank key collision' using errcode = '55000'; end if;
  return rank_identity;
end;
$$;

create or replace function ops.register_claimed_problematic_topology_nodes(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_group_kind text, p_group_identity text, p_after_seed_stage_id bigint,
  p_limit integer, p_observed_at timestamptz
)
returns table(after_seed_stage_id bigint, complete boolean)
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  seed record;
  progress bigint := 0;
  input_identity text;
  lookup_address text;
  canonical_address text;
  ignored_identity text;
  default_address text;
  parent_address text;
  bucket_identity text;
  own_seed record;
  own_progress text := '';
  rank_identity text;
  selected_address text;
  selected_result jsonb;
  terminal boolean;
  needed_folder jsonb;
  folder_identity text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100
    or p_after_seed_stage_id is null or p_after_seed_stage_id < 0
    or p_group_kind not in ('album', 'missing_album', 'loose_source', 'topology_identity', 'topology_address') then
    raise exception 'invalid topology registration scope' using errcode = '22023';
  end if;
  perform ops.require_claimed_problematic_topology(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  );
  if not exists (select 1 from ops.problematic_projection_state state
    where state.library_id = p_library_id and state.topology_completed_group_count is not null
      and state.topology_completed_group_fingerprint is not null) then
    raise exception 'problematic_projection_topology_unknown' using errcode = '55000';
  end if;
  perform 1 from ops.problematic_projection_group_accumulators owner
  where owner.job_id = p_job_id and owner.attempt = p_attempt and owner.revision = p_revision
    and owner.group_kind = p_group_kind and owner.group_identity = p_group_identity for update;
  if not found then raise exception 'missing topology registration owner' using errcode = '55000'; end if;
  select coalesce((fact.fact_value ->> 'after_stage_id')::bigint, 0) into progress
  from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
    and fact.projection_id = 'topology' and fact.fact_kind = 'topology_registration_progress'
    and fact.semantic_child_identity = 'registration';
  progress := coalesce(progress, 0);
  select coalesce(fact.fact_value ->> 'own_after', '') into own_progress
  from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
    and fact.projection_id = 'topology' and fact.fact_kind = 'topology_registration_progress'
    and fact.semantic_child_identity = 'registration';
  own_progress := coalesce(own_progress, '');
  if progress <> p_after_seed_stage_id then
    if p_after_seed_stage_id = 0 then
      return query select progress, exists (
        select 1 from ops.problematic_projection_group_facts fact
        where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
          and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
          and fact.projection_id = 'topology' and fact.fact_kind = 'topology_discovery_end'
      );
      return;
    end if;
    raise exception 'topology registration cursor differs' using errcode = '55000';
  end if;
  for seed in
    select fact.stage_id, fact.fact_value from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
      and fact.fact_kind = 'topology_seed' and fact.stage_id > progress
    order by fact.stage_id limit p_limit
  loop
    progress := seed.stage_id;
    if p_group_kind = 'missing_album' then continue; end if;
    if p_group_kind in ('album', 'loose_source') then
      select pg_catalog.jsonb_build_object(
        'root_id', file.library_root_id, 'physical_parent', file.scan_physical_parent
      ), library.problematic_physical_album_container(file.private_path)
        into needed_folder, lookup_address
      from ops.problematic_projection_source_staging source
      join library.local_track_files file on file.id = (source.payload ->> 'file_id')::numeric::bigint
      join library.library_roots root on root.id = file.library_root_id
        and root.library_id = p_library_id and root.is_active
      where source.stage_id = seed.stage_id and source.job_id = p_job_id
        and source.attempt = p_attempt and source.revision = p_revision
        and source.group_kind = p_group_kind and source.group_identity = p_group_identity
        and source.child_kind = 'file' and file.scan_cache_stale is false;
      if found and nullif(pg_catalog.btrim(seed.fact_value ->> 'path'), '') is not null then
        if pg_catalog.jsonb_typeof(seed.fact_value -> 'physical_container') is distinct from 'string'
          or nullif(seed.fact_value ->> 'physical_container', '') is null then
          raise exception 'topology physical container hint is missing' using errcode = '55000';
        end if;
        folder_identity := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.jsonb_build_array(needed_folder -> 'root_id', needed_folder -> 'physical_parent')::text,
          'UTF8')), 'hex');
        insert into ops.problematic_projection_group_facts(
          job_id, attempt, revision, group_kind, group_identity, stage_id,
          projection_id, fact_kind, semantic_child_identity, fact_value, created_at
        ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, seed.stage_id,
          'topology', 'topology_folder_reference', folder_identity, needed_folder, p_observed_at)
        on conflict (job_id, attempt, revision, group_kind, group_identity,
          projection_id, fact_kind, semantic_child_identity) do nothing;
        if not exists (
          select 1 from ops.problematic_projection_group_facts needed
          where needed.job_id = p_job_id and needed.attempt = p_attempt and needed.revision = p_revision
            and needed.group_kind = p_group_kind and needed.group_identity = p_group_identity
            and needed.projection_id = 'topology' and needed.fact_kind = 'topology_folder_reference'
            and needed.semantic_child_identity = folder_identity and needed.fact_value = needed_folder
        ) then raise exception 'topology folder reference hash collision' using errcode = '55000'; end if;
        perform ops.register_problematic_topology_node(
          p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
          p_group_kind, p_group_identity, 'topology_address', pg_catalog.jsonb_build_object(
            'key', pg_catalog.jsonb_build_array('address', seed.fact_value ->> 'physical_container'),
            'lookup_address', lookup_address, 'reference_kind', 'topology_physical_reference'), p_observed_at);
      end if;
    end if;
    if coalesce((seed.fact_value ->> 'excluded')::boolean, false) then continue; end if;
    default_address := null;
    parent_address := null;
    bucket_identity := null;
    if p_group_kind = 'topology_address' then
      rank_identity := ops.register_problematic_topology_own_rank(
        p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
        (seed.fact_value ->> 'file_id')::bigint,
        seed.fact_value ->> 'original_album_key', p_observed_at);
      insert into ops.problematic_projection_group_facts(
        job_id, attempt, revision, group_kind, group_identity, stage_id,
        projection_id, fact_kind, semantic_child_identity, fact_value, created_at
      ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
        'topology', 'topology_rank_reference', rank_identity,
        pg_catalog.jsonb_build_object('node_kind', 'topology_address', 'node_identity', rank_identity,
          'original_album_key', seed.fact_value -> 'original_album_key'), p_observed_at)
      on conflict (job_id, attempt, revision, group_kind, group_identity,
        projection_id, fact_kind, semantic_child_identity) do nothing;
    end if;
    if p_group_kind <> 'topology_address' then
      select library.problematic_physical_album_container(file.private_path) into lookup_address
      from library.local_track_files file where file.id = (seed.fact_value ->> 'file_id')::bigint;
      canonical_address := seed.fact_value ->> 'default_container';
      default_address := ops.register_problematic_topology_node(
        p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
        p_group_kind, p_group_identity, 'topology_address', pg_catalog.jsonb_build_object(
          'key', pg_catalog.jsonb_build_array('address', canonical_address),
          'lookup_address', lookup_address), p_observed_at);
    end if;
    if pg_catalog.jsonb_typeof(seed.fact_value -> 'numeric_bucket') = 'array' then
      select library.problematic_immediate_folder_parent(file.private_path) into lookup_address
      from library.local_track_files file where file.id = (seed.fact_value ->> 'file_id')::bigint;
      canonical_address := seed.fact_value #>> '{numeric_bucket,1}';
      input_identity := ops.register_problematic_topology_parent_input(
        p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
        canonical_address, lookup_address, p_observed_at);
      bucket_identity := ops.register_problematic_topology_node(
        p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
        p_group_kind, p_group_identity, 'topology_numeric_bucket', pg_catalog.jsonb_build_object(
          'key', pg_catalog.jsonb_build_array('bucket') || (seed.fact_value -> 'numeric_bucket'),
          'input_owner', input_identity), p_observed_at);
      if p_group_kind <> 'topology_address' then
        parent_address := ops.register_problematic_topology_node(
          p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
          p_group_kind, p_group_identity, 'topology_address', pg_catalog.jsonb_build_object(
            'key', pg_catalog.jsonb_build_array('address', canonical_address),
            'lookup_address', lookup_address), p_observed_at);
      end if;
    end if;
    if p_group_kind in ('album', 'missing_album', 'loose_source') then
      insert into ops.problematic_projection_group_facts(
        job_id, attempt, revision, group_kind, group_identity, stage_id,
        projection_id, fact_kind, semantic_child_identity, fact_value, created_at
      ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, seed.stage_id,
        'topology', 'topology_own_address_seed', pg_catalog.lpad(seed.stage_id::text, 20, '0'),
        pg_catalog.jsonb_build_object('file_id', seed.fact_value -> 'file_id',
          'default_address', default_address, 'parent_address', parent_address, 'bucket_node', bucket_identity),
        p_observed_at)
      on conflict (job_id, attempt, revision, group_kind, group_identity,
        projection_id, fact_kind, semantic_child_identity) do nothing;
    end if;
  end loop;
  terminal := not exists (
    select 1 from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
      and fact.fact_kind = 'topology_seed' and fact.stage_id > progress
  );
  if terminal and not exists (
    select 1 from ops.problematic_projection_group_facts closed
    where closed.job_id = p_job_id and closed.attempt = p_attempt and closed.revision = p_revision
      and closed.group_kind = p_group_kind and closed.group_identity = p_group_identity
      and closed.projection_id = 'topology' and closed.fact_kind = 'topology_seed_source_closed'
  ) then
    terminal := exists (
    select 1 from ops.problematic_projection_group_accumulators owner
    where owner.job_id = p_job_id and owner.attempt = p_attempt and owner.revision = p_revision
      and owner.group_kind = p_group_kind and owner.group_identity = p_group_identity and owner.source_complete
  ) and exists (
    select 1 from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
      and fact.fact_kind = 'topology_source_end'
  ) and not exists (
    select 1 from ops.problematic_projection_source_staging source
    where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
      and source.group_kind = p_group_kind and source.group_identity = p_group_identity
      and source.payload ? 'file_id' and not exists (
        select 1 from ops.problematic_projection_group_facts fact
        where fact.job_id = source.job_id and fact.attempt = source.attempt and fact.revision = source.revision
          and fact.group_kind = source.group_kind and fact.group_identity = source.group_identity
          and fact.stage_id = source.stage_id and fact.fact_kind = 'topology_seed'
      )
    );
    if terminal then
      insert into ops.problematic_projection_group_facts(
        job_id, attempt, revision, group_kind, group_identity, stage_id,
        projection_id, fact_kind, semantic_child_identity, fact_value, created_at
      ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
        'topology', 'topology_seed_source_closed', 'source',
        pg_catalog.jsonb_build_object('after_stage_id', progress), p_observed_at)
      on conflict (job_id, attempt, revision, group_kind, group_identity,
        projection_id, fact_kind, semantic_child_identity) do nothing;
    end if;
  end if;
  if terminal and p_group_kind in ('album', 'missing_album', 'loose_source') then
    for own_seed in
      select fact.semantic_child_identity, fact.fact_value
      from ops.problematic_projection_group_facts fact
      where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
        and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
        and fact.projection_id = 'topology' and fact.fact_kind = 'topology_own_address_seed'
        and fact.semantic_child_identity > own_progress
      order by fact.semantic_child_identity limit p_limit
    loop
      selected_address := own_seed.fact_value ->> 'default_address';
      if own_seed.fact_value ->> 'bucket_node' is not null then
        select result.fact_value into selected_result
        from ops.problematic_projection_group_facts result
        join ops.problematic_projection_source_staging certificate
          on certificate.job_id = result.job_id and certificate.attempt = result.attempt
          and certificate.revision = result.revision and certificate.group_kind = result.group_kind
          and certificate.group_identity = result.group_identity and certificate.source_kind = 'topology_certificate'
        where result.job_id = p_job_id and result.attempt = p_attempt and result.revision = p_revision
          and result.group_kind = 'topology_numeric_bucket'
          and result.group_identity = own_seed.fact_value ->> 'bucket_node'
          and result.projection_id = 'topology' and result.fact_kind = 'topology_numeric_bucket_result'
          and result.semantic_child_identity = 'result';
        if not found then terminal := false; exit; end if;
        if (selected_result ->> 'collapse')::boolean then
          selected_address := own_seed.fact_value ->> 'parent_address';
        end if;
      end if;
      select result.fact_value into selected_result
      from ops.problematic_projection_group_facts result
      join ops.problematic_projection_source_staging certificate
        on certificate.job_id = result.job_id and certificate.attempt = result.attempt
        and certificate.revision = result.revision and certificate.group_kind = result.group_kind
        and certificate.group_identity = result.group_identity and certificate.source_kind = 'topology_certificate'
      where result.job_id = p_job_id and result.attempt = p_attempt and result.revision = p_revision
        and result.group_kind = 'topology_address' and result.group_identity = selected_address
        and result.projection_id = 'topology' and result.fact_kind = 'topology_address_result'
        and result.semantic_child_identity = 'result';
      if not found then terminal := false; exit; end if;
      insert into ops.problematic_projection_group_facts(
        job_id, attempt, revision, group_kind, group_identity, stage_id,
        projection_id, fact_kind, semantic_child_identity, fact_value, created_at
      ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
        'topology', 'topology_owned_address', selected_address,
        pg_catalog.jsonb_build_object('node_identity', selected_address), p_observed_at)
      on conflict (job_id, attempt, revision, group_kind, group_identity,
        projection_id, fact_kind, semantic_child_identity) do nothing;
      if selected_result ->> 'status' = 'CLEAN' then
        ignored_identity := ops.register_problematic_topology_node(
          p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
          p_group_kind, p_group_identity, 'topology_identity', pg_catalog.jsonb_build_object(
            'key', pg_catalog.jsonb_build_array('identity') || (selected_result -> 'identity')), p_observed_at);
      end if;
      own_progress := own_seed.semantic_child_identity;
    end loop;
    if exists (
      select 1 from ops.problematic_projection_group_facts fact
      where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
        and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
        and fact.projection_id = 'topology' and fact.fact_kind = 'topology_own_address_seed'
        and fact.semantic_child_identity > own_progress
    ) then terminal := false; end if;
  end if;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
    'topology', 'topology_registration_progress', 'registration',
    pg_catalog.jsonb_build_object('after_stage_id', progress, 'own_after', own_progress), p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity) do update set fact_value = excluded.fact_value;
  if terminal then
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
      'topology', 'topology_discovery_end', 'discovery',
      pg_catalog.jsonb_build_object('after_stage_id', progress), p_observed_at)
    on conflict (job_id, attempt, revision, group_kind, group_identity,
      projection_id, fact_kind, semantic_child_identity) do nothing;
  end if;
  return query select progress, terminal;
end;
$$;

create or replace function ops.problematic_projection_topology_complete(
  p_job_id bigint, p_attempt integer, p_revision uuid,
  p_group_kind text, p_group_identity text
)
returns boolean language sql security definer set search_path = pg_catalog
as $$
  select exists (
    select 1 from ops.problematic_projection_state state
    join ops.problematic_projection_group_accumulators owner
      on owner.job_id = state.live_job_id and owner.attempt = state.requested_attempt
      and owner.revision = state.build_revision
    where owner.job_id = p_job_id and owner.attempt = p_attempt
      and owner.revision = p_revision and owner.group_kind = p_group_kind
      and owner.group_identity = p_group_identity and owner.source_complete
      and state.topology_completed_group_count is not null
      and state.topology_completed_group_fingerprint is not null
      and (p_group_kind not in ('album', 'loose_source') or not exists (
        select 1 from ops.problematic_projection_source_staging source
        where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
          and source.source_kind = p_group_kind and source.source_identity = p_group_identity
          and source.group_kind = p_group_kind and source.group_identity = p_group_identity
          and source.child_kind = 'file'
          and source.payload -> 'file_scan_cache_stale' = 'false'::jsonb
          and nullif(pg_catalog.btrim(source.payload ->> 'file_private_path'), '') is not null
          and pg_catalog.jsonb_typeof(source.payload -> 'file_library_root_id') = 'number'
          and pg_catalog.jsonb_typeof(source.payload -> 'file_physical_parent') = 'string'
          and not exists (
            select 1 from ops.problematic_projection_group_facts needed
            where needed.job_id = source.job_id and needed.attempt = source.attempt and needed.revision = source.revision
              and needed.group_kind = source.group_kind and needed.group_identity = source.group_identity
              and needed.projection_id = 'topology' and needed.fact_kind = 'topology_folder_reference'
              and needed.semantic_child_identity = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                pg_catalog.jsonb_build_array((source.payload ->> 'file_library_root_id')::numeric::bigint,
                  source.payload -> 'file_physical_parent')::text, 'UTF8')), 'hex')
              and needed.fact_value -> 'root_id' = source.payload -> 'file_library_root_id'
              and needed.fact_value -> 'physical_parent' = source.payload -> 'file_physical_parent'
          )
      ))
      and exists (
        select 1 from ops.problematic_projection_group_facts source_terminal
        where source_terminal.job_id = owner.job_id and source_terminal.attempt = owner.attempt
          and source_terminal.revision = owner.revision and source_terminal.group_kind = owner.group_kind
          and source_terminal.group_identity = owner.group_identity
          and source_terminal.fact_kind = 'topology_source_end'
      )
      and exists (
        select 1 from ops.problematic_projection_group_facts terminal
        where terminal.job_id = owner.job_id and terminal.attempt = owner.attempt
          and terminal.revision = owner.revision and terminal.group_kind = owner.group_kind
          and terminal.group_identity = owner.group_identity
          and terminal.fact_kind = 'topology_discovery_end'
      )
      and (exists (
        select 1 from ops.problematic_projection_group_facts ready
        where ready.job_id = owner.job_id and ready.attempt = owner.attempt and ready.revision = owner.revision
          and ready.group_kind = owner.group_kind and ready.group_identity = owner.group_identity
          and ready.projection_id = 'topology' and ready.fact_kind = 'topology_ready'
      ) or (not exists (
        select 1 from ops.problematic_projection_group_facts reference
        where reference.job_id = owner.job_id and reference.attempt = owner.attempt
          and reference.revision = owner.revision and reference.group_kind = owner.group_kind
          and reference.group_identity = owner.group_identity and reference.fact_kind = 'topology_rank_reference'
          and not exists (
            select 1 from ops.problematic_projection_group_facts terminal
            where terminal.job_id = reference.job_id and terminal.attempt = reference.attempt
              and terminal.revision = reference.revision and terminal.group_kind = 'topology_address'
              and terminal.group_identity = reference.fact_value ->> 'node_identity'
              and terminal.projection_id = 'topology' and terminal.fact_kind = 'topology_own_rank_end'
              and terminal.fact_value #> '{key,1}' = reference.fact_value -> 'original_album_key'
          )
      )
      and not exists (
        select 1 from ops.problematic_projection_group_facts reference
        where reference.job_id = owner.job_id and reference.attempt = owner.attempt
          and reference.revision = owner.revision and reference.group_kind = owner.group_kind
          and reference.group_identity = owner.group_identity
          and reference.fact_kind in ('topology_reference', 'topology_physical_reference')
          and not exists (
            select 1 from ops.problematic_projection_source_staging certificate
            where certificate.job_id = reference.job_id and certificate.attempt = reference.attempt
              and certificate.revision = reference.revision
              and certificate.source_kind = 'topology_certificate'
              and certificate.group_kind = reference.fact_value ->> 'node_kind'
              and certificate.group_identity = reference.fact_value ->> 'node_identity'
          )
      )))
  );
$$;

create or replace function ops.problematic_projection_topology_owner_cached(
  p_job_id bigint, p_attempt integer, p_revision uuid, p_group_kind text, p_group_identity text
)
returns boolean language sql security definer set search_path = pg_catalog
as $$
  select exists (
    select 1 from ops.problematic_projection_source_staging certificate
    where certificate.job_id = p_job_id and certificate.attempt = p_attempt and certificate.revision = p_revision
      and certificate.source_kind = 'topology_certificate'
      and certificate.group_kind = p_group_kind and certificate.group_identity = p_group_identity
  ) or exists (
    select 1 from ops.problematic_projection_group_facts definition
    join ops.problematic_projection_group_facts terminal
      on terminal.job_id = definition.job_id and terminal.attempt = definition.attempt
      and terminal.revision = definition.revision and terminal.group_kind = definition.group_kind
      and terminal.group_identity = definition.group_identity and terminal.projection_id = 'topology'
    where definition.job_id = p_job_id and definition.attempt = p_attempt and definition.revision = p_revision
      and definition.group_kind = p_group_kind and definition.group_identity = p_group_identity
      and definition.projection_id = 'topology' and definition.fact_kind = 'topology_definition'
      and definition.semantic_child_identity = 'definition'
      and ((p_group_kind = 'topology_numeric_bucket' and definition.fact_value ->> 'subordinate_input' = 'true'
        and terminal.fact_kind = 'topology_parent_partition_end')
        or (p_group_kind = 'topology_address' and definition.fact_value ->> 'subordinate_own_rank' = 'true'
          and terminal.fact_kind = 'topology_own_rank_end'))
  );
$$;

create or replace function ops.problematic_projection_topology_file_payload(
  p_library_id bigint, p_file_id bigint
)
returns jsonb language sql stable security definer set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'file_id', file.id, 'album_id', album.id, 'album_key', coalesce(album.album_key,
      case when nullif(file.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
        then 'loose-source::' || file.id::text else '' end),
    'file_private_path', file.private_path,
    'file_physical_parent', file.scan_physical_parent,
    'file_entry', case when file.scan_file_entry_is_object then pg_catalog.jsonb_build_object(
      'album', file.scan_file_album, 'album_artist', file.scan_file_album_artist,
      'artist', file.scan_file_artist, 'title', file.scan_file_title, 'year', file.metadata #> '{scan_cache,file_entry,year}',
      'track_number', file.metadata #> '{scan_cache,file_entry,track_number}',
      'disc_number', file.metadata #> '{scan_cache,file_entry,disc_number}',
      'edition', file.metadata #> '{scan_cache,file_entry,edition}',
      'release_date', file.metadata #> '{scan_cache,file_entry,release_date}',
      'cover_path', file.metadata #> '{scan_cache,file_entry,cover_path}',
      'exception_type', file.metadata #> '{scan_cache,file_entry,exception_type}'
    ) else file.metadata #> '{scan_cache,file_entry}' end,
    'track_id', track.id,
    'disc_number', track.disc_number, 'track_number', track.track_number,
    'duration_seconds', track.duration_seconds, 'file_size', file.file_size_bytes,
    'file_library_root_id', file.library_root_id, 'file_library_root_category', root.root_kind,
    'local_album_membership_problem', file.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
    'exception_override_present', coalesce(exception_override.override_payload ? 'exception_type', false),
    'exception_type', case when exception_override.override_payload ? 'exception_type'
      then exception_override.override_payload ->> 'exception_type'
      else file.metadata #>> '{scan_cache,file_entry,exception_type}' end
  )
  from library.local_track_files file
  join library.local_tracks track on track.id = file.track_id and track.library_id = p_library_id
  left join library.local_albums album on album.id = track.album_id and album.library_id = p_library_id
  join library.library_roots root on root.id = file.library_root_id
    and root.library_id = p_library_id and root.is_active
  left join lateral (
    select override_row.override_payload from library.exception_overrides override_row
    where override_row.library_id = p_library_id
      and (override_row.track_key = file.private_path or override_row.track_id = track.id)
    order by case when override_row.track_key = file.private_path then 0 else 1 end,
      override_row.id limit 1
  ) exception_override on true
  where file.id = p_file_id and file.scan_cache_stale is false;
$$;

create or replace function ops.load_claimed_problematic_topology_node(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_node_kind text, p_node_identity text, p_limit integer, p_observed_at timestamptz
)
returns table(definition jsonb, expected_cursor jsonb, rows jsonb, complete boolean, sealed boolean)
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  selected_definition jsonb;
  progress jsonb;
  relation text;
  result_rows jsonb;
  after_root bigint;
  after_file bigint;
  after_partition text;
  after_track bigint;
  candidate record;
  candidate_value jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_node_kind is null or p_node_kind not in (
    'topology_identity', 'topology_numeric_bucket', 'topology_address'
  ) then raise exception 'invalid topology node page' using errcode = '22023'; end if;
  perform ops.require_claimed_problematic_topology(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  );
  if not exists (select 1 from ops.problematic_projection_state state
    where state.library_id = p_library_id and state.topology_completed_group_count is not null
      and state.topology_completed_group_fingerprint is not null) then
    raise exception 'problematic_projection_topology_unknown' using errcode = '55000';
  end if;
  select fact.fact_value into selected_definition
  from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
    and fact.projection_id = 'topology' and fact.fact_kind = 'topology_definition'
    and fact.semantic_child_identity = 'definition';
  if not found then raise exception 'missing topology node definition' using errcode = '55000'; end if;
  if selected_definition ->> 'library_id' <> p_library_id::text
    or selected_definition ->> 'source_generation' <> p_source_generation::text
    or selected_definition ->> 'rebuild_epoch' <> p_rebuild_epoch::text
    or selected_definition ->> 'revision' <> p_revision::text then
    raise exception 'topology node scope differs' using errcode = '55000';
  end if;
  if exists (
    select 1 from ops.problematic_projection_source_staging certificate
    where certificate.job_id = p_job_id and certificate.attempt = p_attempt and certificate.revision = p_revision
      and certificate.source_kind = 'topology_certificate'
      and certificate.group_kind = p_node_kind and certificate.group_identity = p_node_identity
  ) or exists (
    select 1 from ops.problematic_projection_group_facts terminal
    where terminal.job_id = p_job_id and terminal.attempt = p_attempt and terminal.revision = p_revision
      and terminal.group_kind = p_node_kind and terminal.group_identity = p_node_identity
      and terminal.fact_kind in ('topology_parent_partition_end', 'topology_own_rank_end')
  ) then
    return query select selected_definition, '{}'::jsonb, '[]'::jsonb, true, true;
    return;
  end if;
  select fact.fact_value into progress from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
    and fact.projection_id = 'topology' and fact.fact_kind = 'topology_source_progress'
    and fact.semantic_child_identity = 'source';
  relation := coalesce(progress ->> 'relation', case when selected_definition ->> 'subordinate_own_rank' = 'true' then 'own_rank'
    when p_node_kind = 'topology_identity' then 'identity'
    when p_node_kind = 'topology_address' then 'default'
    when selected_definition ->> 'subordinate_input' = 'true' then 'parent' else 'bucket' end);
  progress := coalesce(progress, pg_catalog.jsonb_build_object(
    'relation', relation, 'root_id', 0, 'file_id', 0, 'track_id', 0, 'container', '', 'partition', ''
  ));
  if relation = 'done' then
    return query select selected_definition, progress, '[]'::jsonb, true, false;
    return;
  end if;
  after_root := (progress ->> 'root_id')::bigint;
  after_file := (progress ->> 'file_id')::bigint;
  after_partition := progress ->> 'partition';
  after_track := coalesce((progress ->> 'track_id')::bigint, 0);
  result_rows := '[]'::jsonb;
  if relation = 'bucket' then
    if not exists (
      select 1 from ops.problematic_projection_group_facts terminal
      where terminal.job_id = p_job_id and terminal.attempt = p_attempt and terminal.revision = p_revision
        and terminal.group_kind = 'topology_numeric_bucket'
        and terminal.group_identity = selected_definition ->> 'input_owner'
        and terminal.fact_kind = 'topology_parent_partition_end'
    ) then
      return query select selected_definition,
        pg_catalog.jsonb_build_object('relation', 'dependency', 'input_owner', selected_definition ->> 'input_owner'),
        '[]'::jsonb, false, false;
      return;
    end if;
    for candidate in
      select fact.semantic_child_identity, fact.fact_value
      from ops.problematic_projection_group_facts fact
      where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
        and fact.group_kind = 'topology_numeric_bucket'
        and fact.group_identity = selected_definition ->> 'input_owner'
        and fact.projection_id = p_node_identity and fact.fact_kind = 'topology_parent_partition'
        and fact.semantic_child_identity > after_partition
      order by fact.semantic_child_identity limit p_limit
    loop
      candidate_value := candidate.fact_value;
      if pg_catalog.octet_length((result_rows || pg_catalog.jsonb_build_array(candidate_value))::text) > 65536 then
        if result_rows = '[]'::jsonb then raise exception 'topology candidate exceeds page byte limit' using errcode = '22023'; end if;
        exit;
      end if;
      result_rows := result_rows || pg_catalog.jsonb_build_array(candidate_value);
    end loop;
  else
    for candidate in select page.* from (
      (select file.id, file.library_root_id, file.track_id, file.private_path,
        library.problematic_physical_album_container(file.private_path) as container
      from library.local_track_files file
      join library.library_roots root on root.id = file.library_root_id
        and root.library_id = p_library_id and root.is_active
      join library.local_tracks track on track.id = file.track_id and track.library_id = p_library_id
      where relation = 'identity' and file.scan_cache_stale is false
        and pg_catalog.md5(library.problematic_duplicate_identity_text(file.scan_file_album_artist)) =
          pg_catalog.md5(library.problematic_duplicate_identity_text(selected_definition #>> '{key,1}'))
        and pg_catalog.md5(library.problematic_duplicate_identity_text(file.scan_file_album)) =
          pg_catalog.md5(library.problematic_duplicate_identity_text(selected_definition #>> '{key,2}'))
        and library.problematic_duplicate_identity_text(file.scan_file_album_artist) =
          library.problematic_duplicate_identity_text(selected_definition #>> '{key,1}')
        and library.problematic_duplicate_identity_text(file.scan_file_album) =
          library.problematic_duplicate_identity_text(selected_definition #>> '{key,2}')
        and library.duplicate_identity_year(file.scan_file_year) = (selected_definition #>> '{key,3}')::integer
        and (file.library_root_id, file.id) > (after_root, after_file)
      order by file.library_root_id, file.id
      limit p_limit)
      union all
      (select file.id, file.library_root_id, file.track_id, file.private_path, ''::text as container
      from library.local_track_files file
      join library.library_roots root on root.id = file.library_root_id
        and root.library_id = p_library_id and root.is_active
      join library.local_tracks track on track.id = file.track_id and track.library_id = p_library_id
      where relation = 'default' and file.scan_cache_stale is false
        and pg_catalog.md5(library.problematic_physical_album_container(file.private_path)) =
          pg_catalog.md5(selected_definition ->> 'lookup_address')
        and library.problematic_physical_album_container(file.private_path) = selected_definition ->> 'lookup_address'
        and (file.library_root_id, file.id) > (after_root, after_file)
      order by file.library_root_id, file.id limit p_limit)
      union all
      (select file.id, file.library_root_id, file.track_id, file.private_path, ''::text as container
      from library.local_track_files file
      join library.library_roots root on root.id = file.library_root_id
        and root.library_id = p_library_id and root.is_active
      join library.local_tracks track on track.id = file.track_id and track.library_id = p_library_id
      where relation in ('numeric_parent', 'parent') and file.scan_cache_stale is false
        and pg_catalog.md5(library.problematic_immediate_folder_parent(file.private_path)) =
          pg_catalog.md5(selected_definition ->> 'lookup_address')
        and library.problematic_immediate_folder_parent(file.private_path) = selected_definition ->> 'lookup_address'
        and (file.library_root_id, file.id) > (after_root, after_file)
      order by file.library_root_id, file.id limit p_limit)
      union all
      (select file.id, file.library_root_id, file.track_id, file.private_path, ''::text as container
      from library.local_tracks track
      join library.local_track_files file on file.track_id = track.id
      join library.library_roots root on root.id = file.library_root_id
        and root.library_id = p_library_id and root.is_active
      where relation = 'own_rank' and track.library_id = p_library_id
        and track.album_id = (selected_definition ->> 'album_id')::bigint
        and track.id >= after_track and (track.id, file.id) > (after_track, after_file)
        and file.scan_cache_stale is false
      order by track.id, file.id limit p_limit)
      union all
      (select file.id, file.library_root_id, file.track_id, file.private_path, ''::text as container
      from library.local_track_files file
      join library.local_tracks track on track.id = file.track_id and track.library_id = p_library_id
      join library.library_roots root on root.id = file.library_root_id
        and root.library_id = p_library_id and root.is_active
      where relation = 'own_rank' and selected_definition ->> 'album_id' is null
        and file.id = (selected_definition ->> 'owner_file_id')::bigint
        and file.scan_cache_stale is false and (track.id, file.id) > (after_track, after_file)
      order by track.id, file.id limit p_limit)
    ) page order by case when relation = 'own_rank' then page.track_id else page.library_root_id end,
      case when relation = 'identity' then '' else page.container end, page.id
    loop
      candidate_value := pg_catalog.jsonb_build_object('file_id', candidate.id,
        'root_id', candidate.library_root_id, 'track_id', candidate.track_id, 'path', candidate.private_path);
      if pg_catalog.octet_length((result_rows || pg_catalog.jsonb_build_array(candidate_value))::text) > 65536 then
        if result_rows = '[]'::jsonb then raise exception 'topology candidate exceeds page byte limit' using errcode = '22023'; end if;
        exit;
      end if;
      result_rows := result_rows || pg_catalog.jsonb_build_array(candidate_value);
    end loop;
  end if;
  return query select selected_definition, progress, result_rows,
    pg_catalog.jsonb_array_length(result_rows) = 0, false;
end;
$$;

create or replace function ops.load_claimed_problematic_topology_descriptors(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_group_kind text, p_group_identity text, p_after_reference_key text,
  p_limit integer, p_observed_at timestamptz
)
returns table(reference_key text, fact_kind text, fact_value jsonb)
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  phase text;
  cursor_phase text;
  cursor_key text;
  emitted integer := 0;
  fetched integer;
  owner_complete boolean;
  checked_complete boolean := false;
  owner_album_key text;
  needed_folder record;
  folder_version record;
  folder_value jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_after_reference_key is null then
    raise exception 'invalid topology descriptor limit' using errcode = '22023'; end if;
  perform ops.require_claimed_problematic_topology(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  );
  owner_complete := false;
  if p_group_kind in ('album', 'missing_album') then
    select album.album_key into owner_album_key from library.local_albums album
    where album.library_id = p_library_id and album.id = p_group_identity::bigint;
  elsif p_group_kind = 'loose_source' then owner_album_key := 'loose-source::' || p_group_identity;
  end if;
  cursor_phase := split_part(p_after_reference_key, ':', 1);
  foreach phase in array array['0p', '0r', '0s', '1s', '2m', '2n', '2r', '3a', '4c', '5z']
  loop
    if phase collate "C" < cursor_phase collate "C" then continue; end if;
    cursor_key := case when phase = cursor_phase then substring(p_after_reference_key from 4) else '' end;
    if phase in ('2m', '3a', '4c', '5z') and owner_album_key is not null and not checked_complete then
      checked_complete := true;
      owner_complete := ops.problematic_projection_topology_complete(
        p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity);
      if owner_complete then
        insert into ops.problematic_projection_group_facts(
          job_id, attempt, revision, group_kind, group_identity, stage_id,
          projection_id, fact_kind, semantic_child_identity, fact_value, created_at
        ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
          'topology', 'topology_ready', 'ready', '{}'::jsonb, p_observed_at)
        on conflict do nothing;
      end if;
    end if;
    if phase in ('0p', '0r', '0s') then
      return query select phase || ':' || fact.semantic_child_identity, fact.fact_kind, fact.fact_value
      from ops.problematic_projection_group_facts fact
      where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
        and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
        and fact.projection_id = 'topology'
        and fact.fact_kind = case when phase = '0p' then 'topology_physical_reference'
          when phase = '0r' then 'topology_reference' else 'topology_rank_reference' end
        and fact.semantic_child_identity collate "C" > cursor_key collate "C"
      order by fact.semantic_child_identity collate "C" limit p_limit - emitted;
    elsif phase = '1s' then
      return query select phase || ':' || fact.fact_kind, fact.fact_kind, fact.fact_value
      from ops.problematic_projection_group_facts fact
      where p_group_kind in ('topology_numeric_bucket', 'topology_address')
        and fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
        and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
        and fact.projection_id = 'topology' and fact.semantic_child_identity = 'result'
        and fact.fact_kind in ('topology_numeric_bucket_result', 'topology_own_rank_result', 'topology_address_result')
        and fact.fact_kind collate "C" > cursor_key collate "C"
      order by fact.fact_kind collate "C" limit p_limit - emitted;
    elsif phase = '2n' then
      return query select phase || ':' || result.group_identity, 'topology_numeric_descriptor'::text, result.fact_value
      from ops.problematic_projection_group_facts reference
      join ops.problematic_projection_group_facts result
        on result.job_id = reference.job_id and result.attempt = reference.attempt and result.revision = reference.revision
        and result.group_kind = 'topology_numeric_bucket' and result.group_identity = reference.fact_value ->> 'node_identity'
        and result.projection_id = 'topology' and result.fact_kind = 'topology_numeric_bucket_result'
        and result.semantic_child_identity = 'result'
      where reference.job_id = p_job_id and reference.attempt = p_attempt and reference.revision = p_revision
        and reference.group_kind = p_group_kind and reference.group_identity = p_group_identity
        and reference.projection_id = 'topology' and reference.fact_kind = 'topology_reference'
        and reference.fact_value ->> 'node_kind' = 'topology_numeric_bucket'
        and reference.semantic_child_identity collate "C" > ('topology_numeric_bucket:' || cursor_key) collate "C"
        and ops.problematic_projection_topology_owner_cached(p_job_id, p_attempt, p_revision,
          result.group_kind, result.group_identity)
      order by reference.semantic_child_identity collate "C" limit p_limit - emitted;
    elsif phase = '2r' then
      return query select phase || ':' || result.group_identity, 'topology_rank_descriptor'::text, result.fact_value
      from ops.problematic_projection_group_facts reference
      join ops.problematic_projection_group_facts result
        on result.job_id = reference.job_id and result.attempt = reference.attempt and result.revision = reference.revision
        and result.group_kind = 'topology_address' and result.group_identity = reference.fact_value ->> 'node_identity'
        and result.projection_id = 'topology' and result.fact_kind = 'topology_own_rank_end'
        and result.semantic_child_identity = 'rank'
      where reference.job_id = p_job_id and reference.attempt = p_attempt and reference.revision = p_revision
        and reference.group_kind = p_group_kind and reference.group_identity = p_group_identity
        and reference.projection_id = 'topology' and reference.fact_kind = 'topology_rank_reference'
        and reference.semantic_child_identity collate "C" > cursor_key collate "C"
      order by reference.semantic_child_identity collate "C" limit p_limit - emitted;
    elsif phase = '2m' then
      for needed_folder in
        select needed.semantic_child_identity, needed.fact_value
        from ops.problematic_projection_group_facts needed
        where owner_complete and owner_album_key is not null
          and needed.job_id = p_job_id and needed.attempt = p_attempt and needed.revision = p_revision
          and needed.group_kind = p_group_kind and needed.group_identity = p_group_identity
          and needed.projection_id = 'topology' and needed.fact_kind = 'topology_folder_reference'
          and needed.semantic_child_identity collate "C" > cursor_key collate "C"
        order by needed.semantic_child_identity collate "C" limit p_limit - emitted
      loop
        folder_value := null;
        for folder_version in
          select distinct folder.fact_value
          from ops.problematic_projection_group_facts folder
          where folder.job_id = p_job_id and folder.attempt = p_attempt and folder.revision = p_revision
            and folder.group_kind = 'topology_address' and folder.projection_id = 'topology'
            and folder.fact_kind = 'topology_folder_status'
            and folder.semantic_child_identity = needed_folder.semantic_child_identity
            and folder.fact_value -> 'root_id' = needed_folder.fact_value -> 'root_id'
            and folder.fact_value -> 'physical_parent' = needed_folder.fact_value -> 'physical_parent'
            and exists (
              select 1 from ops.problematic_projection_group_facts reference
              where reference.job_id = folder.job_id and reference.attempt = folder.attempt and reference.revision = folder.revision
                and reference.group_kind = p_group_kind and reference.group_identity = p_group_identity
                and reference.projection_id = 'topology' and reference.fact_kind = 'topology_physical_reference'
                and reference.semantic_child_identity = 'topology_address:' || folder.group_identity
                and reference.fact_value ->> 'node_kind' = 'topology_address'
                and reference.fact_value ->> 'node_identity' = folder.group_identity
            )
          limit 2
        loop
          if folder_value is not null then
            raise exception 'topology physical folder descriptors disagree' using errcode = '55000';
          end if;
          folder_value := folder_version.fact_value;
        end loop;
        if folder_value is null then
          raise exception 'topology physical folder descriptor is missing' using errcode = '55000';
        end if;
        return query select phase || ':' || needed_folder.semantic_child_identity,
          'topology_folder_descriptor'::text, folder_value;
        emitted := emitted + 1;
        if emitted >= p_limit then return; end if;
      end loop;
      continue;
    elsif phase = '3a' then
      return query select phase || ':' || result.group_identity, 'topology_address_descriptor'::text,
        result.fact_value || pg_catalog.jsonb_build_object('linked', exists (
          select 1 from ops.problematic_projection_group_facts identity_result
          where identity_result.job_id = p_job_id and identity_result.attempt = p_attempt and identity_result.revision = p_revision
            and identity_result.group_kind = 'topology_identity'
            and identity_result.group_identity = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              (pg_catalog.jsonb_build_array('identity') || (result.fact_value -> 'identity'))::text, 'UTF8')), 'hex')
            and identity_result.projection_id = 'topology' and identity_result.fact_kind = 'topology_identity_result'
            and identity_result.semantic_child_identity = 'result'
            and (identity_result.fact_value ->> 'clean_container_count')::bigint > 1
            and ops.problematic_projection_topology_owner_cached(p_job_id, p_attempt, p_revision,
              identity_result.group_kind, identity_result.group_identity)
        ))
      from ops.problematic_projection_group_facts reference
      join ops.problematic_projection_group_facts result
        on result.job_id = reference.job_id and result.attempt = reference.attempt and result.revision = reference.revision
        and result.group_kind = 'topology_address' and result.group_identity = reference.fact_value ->> 'node_identity'
        and result.projection_id = 'topology' and result.fact_kind = 'topology_address_result'
        and result.semantic_child_identity = 'result'
      where owner_complete and owner_album_key is not null
        and reference.job_id = p_job_id and reference.attempt = p_attempt and reference.revision = p_revision
        and reference.group_kind = p_group_kind and reference.group_identity = p_group_identity
        and reference.projection_id = 'topology' and reference.fact_kind = 'topology_reference'
        and reference.fact_value ->> 'node_kind' = 'topology_address'
        and reference.semantic_child_identity collate "C" > ('topology_address:' || cursor_key) collate "C"
      order by reference.semantic_child_identity collate "C" limit p_limit - emitted;
    elsif phase = '4c' then
      return query select phase || ':' || identity_result.group_identity || ':' || address.group_identity || ':' || member.semantic_child_identity,
        'topology_companion_descriptor'::text,
        pg_catalog.jsonb_build_object('original_album_key', owner_album_key,
          'identity', address.fact_value -> 'identity', 'file_id', member.fact_value -> 'file_id',
          'path', member.fact_value -> 'path', 'root_id', member.fact_value -> 'root_id',
          'category', member.fact_value -> 'category')
      from ops.problematic_projection_group_facts identity_reference
      join ops.problematic_projection_group_facts identity_result
        on identity_result.job_id = identity_reference.job_id and identity_result.attempt = identity_reference.attempt
        and identity_result.revision = identity_reference.revision and identity_result.group_kind = 'topology_identity'
        and identity_result.group_identity = identity_reference.fact_value ->> 'node_identity'
        and identity_result.projection_id = 'topology' and identity_result.fact_kind = 'topology_identity_result'
        and identity_result.semantic_child_identity = 'result'
      join ops.problematic_projection_group_facts address_reference
        on address_reference.job_id = identity_result.job_id and address_reference.attempt = identity_result.attempt
        and address_reference.revision = identity_result.revision and address_reference.group_kind = identity_result.group_kind
        and address_reference.group_identity = identity_result.group_identity and address_reference.projection_id = 'topology'
        and address_reference.fact_kind = 'topology_reference'
        and address_reference.fact_value ->> 'node_kind' = 'topology_address'
      join ops.problematic_projection_group_facts address
        on address.job_id = address_reference.job_id and address.attempt = address_reference.attempt
        and address.revision = address_reference.revision and address.group_kind = 'topology_address'
        and address.group_identity = address_reference.fact_value ->> 'node_identity'
        and address.projection_id = 'topology' and address.fact_kind = 'topology_address_result'
        and address.semantic_child_identity = 'result'
        and address.fact_value -> 'identity' = identity_result.fact_value -> 'identity'
        and address.fact_value ->> 'status' = 'CLEAN'
      join ops.problematic_projection_group_facts member
        on member.job_id = address.job_id and member.attempt = address.attempt and member.revision = address.revision
        and member.group_kind = address.group_kind and member.group_identity = address.group_identity
        and member.projection_id = 'topology' and member.fact_kind = 'topology_address_member'
      where owner_complete and owner_album_key is not null
        and identity_reference.job_id = p_job_id and identity_reference.attempt = p_attempt and identity_reference.revision = p_revision
        and identity_reference.group_kind = p_group_kind and identity_reference.group_identity = p_group_identity
        and identity_reference.projection_id = 'topology' and identity_reference.fact_kind = 'topology_reference'
        and identity_reference.fact_value ->> 'node_kind' = 'topology_identity'
        and (identity_result.fact_value ->> 'clean_container_count')::bigint > 1
        and identity_reference.semantic_child_identity collate "C" >=
          ('topology_identity:' || split_part(cursor_key, ':', 1)) collate "C"
        and address_reference.semantic_child_identity collate "C" >= case
          when identity_result.group_identity = split_part(cursor_key, ':', 1)
            then ('topology_address:' || split_part(cursor_key, ':', 2)) collate "C" else '' collate "C" end
        and member.semantic_child_identity collate "C" > case
          when identity_result.group_identity = split_part(cursor_key, ':', 1)
            and address.group_identity = split_part(cursor_key, ':', 2)
            then split_part(cursor_key, ':', 3) collate "C" else '' collate "C" end
        and not exists (
          select 1 from ops.problematic_projection_group_facts owned
          where owned.job_id = p_job_id and owned.attempt = p_attempt and owned.revision = p_revision
            and owned.group_kind = p_group_kind and owned.group_identity = p_group_identity
            and owned.projection_id = 'topology' and owned.fact_kind = 'topology_owned_address'
            and owned.semantic_child_identity = address.group_identity
        )
      order by identity_reference.semantic_child_identity collate "C",
        address_reference.semantic_child_identity collate "C", member.semantic_child_identity collate "C"
      limit p_limit - emitted;
    else
      return query select '5z:complete'::text, 'topology_descriptor_end'::text,
        pg_catalog.jsonb_build_object('complete', true, 'original_album_key', owner_album_key)
      where owner_complete and owner_album_key is not null and cursor_key collate "C" < 'complete' collate "C";
    end if;
    get diagnostics fetched = row_count;
    emitted := emitted + fetched;
    if emitted = p_limit then return; end if;
  end loop;
end;
$$;

create or replace function ops.seal_problematic_projection_topology_owner(
  p_job_id bigint, p_attempt integer, p_library_id bigint,
  p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_group_kind text, p_group_identity text, p_observed_at timestamptz
)
returns void language plpgsql security definer set search_path = pg_catalog
as $$
declare
  certificate jsonb;
  inserted_count integer;
begin
  select pg_catalog.jsonb_build_object(
    'library_id', p_library_id, 'job_id', p_job_id, 'revision', p_revision,
    'source_generation', p_source_generation, 'rebuild_epoch', p_rebuild_epoch,
    'builder_version', 3, 'group_kind', p_group_kind, 'group_identity', p_group_identity,
    'fact_count', count(*), 'fact_fingerprint',
    coalesce(bit_xor(('x' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(fact.projection_id, fact.fact_kind,
        fact.semantic_child_identity, fact.fact_value)::text, 'UTF8')), 'hex'))::bit(256)), 0::bit(256))::text
  ) into certificate
  from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity;
  insert into ops.problematic_projection_source_staging(
    job_id, attempt, revision, group_kind, group_identity,
    source_kind, source_identity, child_kind, child_identity, payload, created_at
  ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    'topology_certificate', p_group_kind, 'certificate', p_group_identity, certificate, p_observed_at)
  on conflict (job_id, attempt, revision, source_kind, source_identity, child_kind, child_identity)
    do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 1 then
    update ops.problematic_projection_state state set
      topology_completed_group_count = state.topology_completed_group_count + 1,
      topology_completed_group_fingerprint = state.topology_completed_group_fingerprint #
        ('x' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(certificate::text, 'UTF8')), 'hex'))::bit(256)
    where state.library_id = p_library_id and state.live_job_id = p_job_id
      and state.build_revision = p_revision and state.requested_attempt = p_attempt
      and state.source_generation = p_source_generation and state.rebuild_epoch = p_rebuild_epoch
      and state.topology_completed_group_count is not null
      and state.topology_completed_group_fingerprint is not null;
    if not found then
      raise exception 'problematic_projection_topology_unknown' using errcode = '55000';
    end if;
  elsif not exists (
    select 1 from ops.problematic_projection_source_staging existing
    where existing.job_id = p_job_id and existing.attempt = p_attempt and existing.revision = p_revision
      and existing.source_kind = 'topology_certificate' and existing.source_identity = p_group_kind
      and existing.child_kind = 'certificate' and existing.child_identity = p_group_identity
      and existing.payload = certificate
  ) then
    raise exception 'projection topology certificate replay differs' using errcode = '55000';
  end if;
end;
$$;

create or replace function ops.stage_claimed_problematic_topology_node(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_node_kind text, p_node_identity text, p_expected_cursor jsonb,
  p_rows jsonb, p_complete boolean, p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  expected record;
  page_key text;
  page_receipt jsonb;
  relation text;
  next_relation text;
  next_progress jsonb;
  source_count bigint;
  source_fingerprint bit(256);
  input record;
  input_payload jsonb;
  file_identity text;
  input_stage_id bigint;
  last_row jsonb;
  candidate_count bigint;
  candidate_fingerprint bit(256);
  disposition jsonb;
  authoritative_rows jsonb;
  retained boolean;
begin
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_rows) > 100 or p_complete is null
    or pg_catalog.jsonb_typeof(p_expected_cursor) is distinct from 'object' then
    raise exception 'invalid topology source page' using errcode = '22023';
  end if;
  perform 1 from ops.problematic_projection_group_accumulators owner
  where owner.job_id = p_job_id and owner.attempt = p_attempt and owner.revision = p_revision
    and owner.group_kind = p_node_kind and owner.group_identity = p_node_identity for update;
  select * into expected from ops.load_claimed_problematic_topology_node(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_node_kind, p_node_identity,
    greatest(1, pg_catalog.jsonb_array_length(p_rows)), p_observed_at
  );
  page_key := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_expected_cursor::text, 'UTF8')), 'hex');
  page_receipt := pg_catalog.jsonb_build_object('cursor', p_expected_cursor,
    'count', pg_catalog.jsonb_array_length(p_rows), 'complete', p_complete,
    'fingerprint', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_rows::text, 'UTF8')), 'hex'));
  relation := p_expected_cursor ->> 'relation';
  if relation in ('numeric_parent', 'parent') and exists (
    select 1 from pg_catalog.jsonb_array_elements(p_rows) entry
    where pg_catalog.jsonb_typeof(entry -> 'retain') is distinct from 'boolean'
  ) then raise exception 'numeric topology candidate requires retain disposition' using errcode = '22023'; end if;
  select coalesce(pg_catalog.jsonb_agg(case when relation in ('numeric_parent', 'parent')
    then value - 'retain' else value end order by ordinality), '[]'::jsonb)
    into authoritative_rows from pg_catalog.jsonb_array_elements(p_rows) with ordinality;
  if exists (
    select 1 from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
      and fact.projection_id = 'topology' and fact.fact_kind = 'topology_source_page'
      and fact.semantic_child_identity = page_key and fact.fact_value = page_receipt
  ) then return query select true; return; end if;
  if not found or expected.sealed or expected.expected_cursor ->> 'relation' in ('dependency', 'done')
    or expected.expected_cursor is distinct from p_expected_cursor
    or expected.rows is distinct from authoritative_rows or expected.complete is distinct from p_complete then
    raise exception 'topology page differs from authoritative cursor' using errcode = '55000';
  end if;
  relation := p_expected_cursor ->> 'relation';
  source_count := coalesce((p_expected_cursor ->> 'count')::bigint, 0);
  source_fingerprint := coalesce((p_expected_cursor ->> 'fingerprint')::bit(256), 0::bit(256));
  candidate_count := coalesce((p_expected_cursor ->> 'candidate_count')::bigint, 0);
  candidate_fingerprint := coalesce((p_expected_cursor ->> 'candidate_fingerprint')::bit(256), 0::bit(256));
  for input in select value from pg_catalog.jsonb_array_elements(p_rows)
  loop
    file_identity := pg_catalog.lpad(input.value ->> 'file_id', 20, '0');
    retained := case when relation in ('numeric_parent', 'parent') then (input.value ->> 'retain')::boolean else true end;
    disposition := pg_catalog.jsonb_build_object('relation', relation, 'file_id', input.value -> 'file_id',
      'retain', retained, 'candidate_digest', pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to((input.value - 'retain')::text, 'UTF8')), 'hex'));
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
      'topology', 'topology_candidate_disposition', relation || ':' || file_identity, disposition, p_observed_at);
    candidate_count := candidate_count + 1;
    candidate_fingerprint := candidate_fingerprint # ('x' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(disposition::text, 'UTF8')), 'hex'))::bit(256);
    last_row := input.value;
    if not retained then continue; end if;
    input_payload := case when relation = 'bucket' then input.value
      else ops.problematic_projection_topology_file_payload(p_library_id, (input.value ->> 'file_id')::bigint) end;
    if pg_catalog.octet_length(input_payload::text) > 65536 then
      raise exception 'topology input exceeds payload byte limit' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(input_payload) is distinct from 'object' or file_identity is null then
      raise exception 'invalid topology input row' using errcode = '55000';
    end if;
    insert into ops.problematic_projection_source_staging(
      job_id, attempt, revision, group_kind, group_identity, source_kind,
      source_identity, child_kind, child_identity, payload, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity,
      'topology_input', p_node_kind || ':' || p_node_identity, relation, file_identity, input_payload, p_observed_at)
    on conflict (job_id, attempt, revision, source_kind, source_identity, child_kind, child_identity) do nothing;
    select source.stage_id into input_stage_id from ops.problematic_projection_source_staging source
    where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
      and source.source_kind = 'topology_input' and source.source_identity = p_node_kind || ':' || p_node_identity
      and source.child_kind = relation and source.child_identity = file_identity and source.payload = input_payload;
    if not found then raise exception 'topology input replay differs' using errcode = '55000'; end if;
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, input_stage_id,
      'topology', 'topology_input', relation || ':' || file_identity, input_payload, p_observed_at)
    on conflict (job_id, attempt, revision, group_kind, group_identity,
      projection_id, fact_kind, semantic_child_identity) do nothing;
    source_count := source_count + 1;
    source_fingerprint := source_fingerprint # ('x' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(pg_catalog.jsonb_build_array(relation, file_identity, input_payload)::text, 'UTF8')), 'hex'))::bit(256);
    last_row := input.value;
  end loop;
  if p_complete then
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
      'topology', 'topology_source_end', relation, pg_catalog.jsonb_build_object(
        'relation', relation, 'source_count', source_count, 'source_fingerprint', source_fingerprint::text,
        'candidate_count', candidate_count, 'candidate_fingerprint', candidate_fingerprint::text
      ), p_observed_at)
    on conflict (job_id, attempt, revision, group_kind, group_identity,
      projection_id, fact_kind, semantic_child_identity) do nothing;
    next_relation := case when p_node_kind = 'topology_address' and relation = 'default'
      then 'numeric_parent' else 'done' end;
    next_progress := pg_catalog.jsonb_build_object('relation', next_relation,
      'root_id', 0, 'file_id', 0, 'track_id', 0, 'container', '', 'partition', '', 'count', 0,
      'fingerprint', (0::bit(256))::text, 'candidate_count', 0, 'candidate_fingerprint', (0::bit(256))::text);
  else
    next_progress := p_expected_cursor || pg_catalog.jsonb_build_object(
      'root_id', coalesce((last_row ->> 'root_id')::bigint, 0),
      'file_id', (last_row ->> 'file_id')::bigint,
      'track_id', coalesce((last_row ->> 'track_id')::bigint, 0),
      'container', coalesce(last_row ->> 'container', ''),
      'partition', pg_catalog.lpad(last_row ->> 'file_id', 20, '0'),
      'count', source_count, 'fingerprint', source_fingerprint::text,
      'candidate_count', candidate_count, 'candidate_fingerprint', candidate_fingerprint::text);
  end if;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
    'topology', 'topology_source_progress', 'source', next_progress, p_observed_at)
  on conflict (job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity) do update set fact_value = excluded.fact_value;
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
    'topology', 'topology_source_page', page_key, page_receipt, p_observed_at);
  update ops.problematic_projection_group_accumulators owner set
    source_complete = next_progress ->> 'relation' = 'done', updated_at = p_observed_at
  where owner.job_id = p_job_id and owner.attempt = p_attempt and owner.revision = p_revision
    and owner.group_kind = p_node_kind and owner.group_identity = p_node_identity;
  return query select true;
end;
$$;

create or replace function ops.complete_claimed_problematic_topology_node(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint, p_revision uuid,
  p_node_kind text, p_node_identity text, p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  page record;
  required_relations text[];
  terminal_count bigint;
  terminal_source_count bigint;
  terminal_source_fingerprint bit(256);
  actual_source_count bigint;
  actual_source_fingerprint bit(256);
  derived_count bigint;
  result_kind text;
  result_value jsonb;
  expected_candidate_count bigint;
  expected_candidate_fingerprint bit(256);
  actual_candidate_count bigint;
  actual_candidate_fingerprint bit(256);
begin
  perform 1 from ops.problematic_projection_group_accumulators owner
  where owner.job_id = p_job_id and owner.attempt = p_attempt and owner.revision = p_revision
    and owner.group_kind = p_node_kind and owner.group_identity = p_node_identity for update;
  select * into page from ops.load_claimed_problematic_topology_node(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_node_kind, p_node_identity, 1, p_observed_at
  );
  if page.sealed then return query select true; return; end if;
  if not page.complete or page.expected_cursor ->> 'relation' is distinct from 'done' then
    raise exception 'topology source is incomplete' using errcode = '55000';
  end if;
  required_relations := case when page.definition ->> 'subordinate_own_rank' = 'true' then array['own_rank']
    when p_node_kind = 'topology_address' then array['default', 'numeric_parent']
    when p_node_kind = 'topology_identity' then array['identity']
    when page.definition ->> 'subordinate_input' = 'true' then array['parent'] else array['bucket'] end;
  select count(*), coalesce(sum((fact.fact_value ->> 'source_count')::bigint), 0),
    coalesce(bit_xor((fact.fact_value ->> 'source_fingerprint')::bit(256)), 0::bit(256))
    into terminal_count, terminal_source_count, terminal_source_fingerprint
  from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
    and fact.projection_id = 'topology' and fact.fact_kind = 'topology_source_end'
    and fact.semantic_child_identity = any(required_relations);
  select count(*), coalesce(bit_xor(('x' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_array(source.child_kind,
      source.child_identity, source.payload)::text, 'UTF8')), 'hex'))::bit(256)), 0::bit(256))
    into actual_source_count, actual_source_fingerprint
  from ops.problematic_projection_source_staging source
  where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
    and source.group_kind = p_node_kind and source.group_identity = p_node_identity
    and source.source_kind = 'topology_input';
  if terminal_count <> cardinality(required_relations) or terminal_source_count <> actual_source_count
    or terminal_source_fingerprint <> actual_source_fingerprint then
    raise exception 'topology source terminals differ from staged inputs' using errcode = '55000';
  end if;
  select sum((fact.fact_value ->> 'candidate_count')::bigint),
    bit_xor((fact.fact_value ->> 'candidate_fingerprint')::bit(256))
    into expected_candidate_count, expected_candidate_fingerprint
  from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
    and fact.projection_id = 'topology' and fact.fact_kind = 'topology_source_end'
    and fact.semantic_child_identity = any(required_relations);
  select count(*), coalesce(bit_xor(('x' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(fact.fact_value::text, 'UTF8')), 'hex'))::bit(256)), 0::bit(256))
    into actual_candidate_count, actual_candidate_fingerprint
  from ops.problematic_projection_group_facts fact
  where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
    and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
    and fact.projection_id = 'topology' and fact.fact_kind = 'topology_candidate_disposition';
  if expected_candidate_count is distinct from actual_candidate_count
    or expected_candidate_fingerprint is distinct from actual_candidate_fingerprint then
    raise exception 'topology candidate terminals differ from dispositions' using errcode = '55000';
  end if;
  if page.definition ->> 'subordinate_own_rank' = 'true' then
    select fact.fact_value into result_value from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
      and fact.projection_id = 'topology' and fact.fact_kind = 'topology_own_rank_result'
      and fact.semantic_child_identity = 'result';
    if not found or not (result_value ? 'rank') or result_value -> 'key' is distinct from page.definition -> 'key'
      or (result_value ->> 'input_count')::bigint is distinct from actual_source_count
      or (result_value -> 'rank' <> 'null'::jsonb and (
        pg_catalog.jsonb_typeof(result_value -> 'rank') is distinct from 'array'
        or pg_catalog.jsonb_array_length(result_value -> 'rank') <> 3
        or result_value #>> '{rank,2}' is distinct from page.definition #>> '{key,1}'
      )) then raise exception 'topology own rank is incomplete' using errcode = '55000'; end if;
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
      'topology', 'topology_own_rank_end', 'rank', result_value || pg_catalog.jsonb_build_object(
        'source_count', actual_source_count, 'source_fingerprint', actual_source_fingerprint::text
      ), p_observed_at);
    return query select true;
    return;
  end if;
  if page.definition ->> 'subordinate_input' = 'true' then
    select count(*) into derived_count from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
      and fact.fact_kind = 'topology_parent_partition';
    if derived_count <> actual_source_count or exists (
      select 1 from ops.problematic_projection_source_staging source
      where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
        and source.group_kind = p_node_kind and source.group_identity = p_node_identity
        and source.source_kind = 'topology_input' and not exists (
          select 1 from ops.problematic_projection_group_facts disposition
          where disposition.job_id = source.job_id and disposition.attempt = source.attempt
            and disposition.revision = source.revision and disposition.group_kind = source.group_kind
            and disposition.group_identity = source.group_identity and disposition.stage_id = source.stage_id
            and disposition.fact_kind = 'topology_parent_partition'
            and disposition.semantic_child_identity = source.child_identity
        )
    ) then raise exception 'topology parent partition is incomplete' using errcode = '55000'; end if;
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
      'topology', 'topology_parent_partition_end', 'partition', pg_catalog.jsonb_build_object(
        'source_count', actual_source_count, 'source_fingerprint', actual_source_fingerprint::text
      ), p_observed_at);
    return query select true;
    return;
  end if;
  if p_node_kind = 'topology_identity' then
    select pg_catalog.jsonb_build_object('identity', (page.definition -> 'key') - 0,
      'clean_container_count', count(*), 'input_count', actual_source_count) into result_value
    from ops.problematic_projection_group_facts reference
    join ops.problematic_projection_group_facts address
      on address.job_id = reference.job_id and address.attempt = reference.attempt
      and address.revision = reference.revision and address.group_kind = 'topology_address'
      and address.group_identity = reference.fact_value ->> 'node_identity'
      and address.projection_id = 'topology' and address.fact_kind = 'topology_address_result'
      and address.semantic_child_identity = 'result'
    where reference.job_id = p_job_id and reference.attempt = p_attempt and reference.revision = p_revision
      and reference.group_kind = p_node_kind and reference.group_identity = p_node_identity
      and reference.fact_kind = 'topology_reference' and reference.fact_value ->> 'node_kind' = 'topology_address'
      and address.fact_value ->> 'status' = 'CLEAN'
      and address.fact_value -> 'identity' = (page.definition -> 'key') - 0;
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
      'topology', 'topology_identity_result', 'result', result_value, p_observed_at)
    on conflict (job_id, attempt, revision, group_kind, group_identity,
      projection_id, fact_kind, semantic_child_identity) do nothing;
  else
    result_kind := case when p_node_kind = 'topology_address' then 'topology_address_result'
      else 'topology_numeric_bucket_result' end;
    select fact.fact_value into result_value from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
      and fact.projection_id = 'topology' and fact.fact_kind = result_kind and fact.semantic_child_identity = 'result';
    if not found or (result_value ->> 'input_count')::bigint is distinct from actual_source_count
      or result_value -> 'key' is distinct from page.definition -> 'key' then
      raise exception 'topology derived result is incomplete' using errcode = '55000';
    end if;
    if p_node_kind = 'topology_address' then
      select count(*), coalesce(bit_xor(('x' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_array((member.fact_value ->> 'file_id')::bigint,
          member.fact_value ->> 'path')::text, 'UTF8')), 'hex'))::bit(256)), 0::bit(256))
        into derived_count, actual_source_fingerprint
      from ops.problematic_projection_group_facts member
      where member.job_id = p_job_id and member.attempt = p_attempt and member.revision = p_revision
        and member.group_kind = p_node_kind and member.group_identity = p_node_identity
        and member.projection_id = 'topology' and member.fact_kind = 'topology_address_member';
      if (result_value ->> 'member_count')::bigint is distinct from derived_count
        or (result_value ->> 'member_fingerprint')::bit(256) is distinct from actual_source_fingerprint
        or pg_catalog.jsonb_typeof(result_value -> 'status') is distinct from 'string'
        or result_value ->> 'status' not in ('CLEAN', 'MIXED', 'EMPTY') then
        raise exception 'topology address member stream is incomplete' using errcode = '55000';
      end if;
      if exists (
        with folders as (
          select (source.payload ->> 'file_library_root_id')::bigint as root_id,
            coalesce(source.payload ->> 'file_physical_parent', '') as physical_parent,
            count(*) as input_count, count(distinct (source.payload ->> 'album_id')::bigint) > 1 as mixed
          from ops.problematic_projection_source_staging source
          where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
            and source.group_kind = p_node_kind and source.group_identity = p_node_identity
            and source.source_kind = 'topology_input'
          group by (source.payload ->> 'file_library_root_id')::bigint,
            coalesce(source.payload ->> 'file_physical_parent', '')
        ), expected_folders as (
          select folder.*, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_build_array(folder.root_id, folder.physical_parent)::text, 'UTF8')), 'hex') as identity
          from folders folder
        ), actual_folders as (
          select fact.semantic_child_identity, fact.fact_value
          from ops.problematic_projection_group_facts fact
          where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
            and fact.group_kind = p_node_kind and fact.group_identity = p_node_identity
            and fact.projection_id = 'topology' and fact.fact_kind = 'topology_folder_status'
        )
        select 1 from expected_folders expected_folder full join actual_folders actual_folder
          on actual_folder.semantic_child_identity = expected_folder.identity
        where expected_folder.identity is null or actual_folder.semantic_child_identity is null
          or actual_folder.fact_value -> 'root_id' is distinct from pg_catalog.to_jsonb(expected_folder.root_id)
          or actual_folder.fact_value -> 'physical_parent' is distinct from pg_catalog.to_jsonb(expected_folder.physical_parent)
          or actual_folder.fact_value -> 'input_count' is distinct from pg_catalog.to_jsonb(expected_folder.input_count)
          or actual_folder.fact_value -> 'mixed' is distinct from pg_catalog.to_jsonb(expected_folder.mixed)
      ) then raise exception 'topology physical folder stream is incomplete' using errcode = '55000'; end if;
    elsif result_value -> 'complete' is distinct from 'true'::jsonb then
      raise exception 'topology numeric decision is incomplete' using errcode = '55000';
    end if;
    if p_node_kind = 'topology_numeric_bucket' and not exists (
      select 1 from ops.problematic_projection_group_facts terminal
      where terminal.job_id = p_job_id and terminal.attempt = p_attempt and terminal.revision = p_revision
        and terminal.group_kind = 'topology_numeric_bucket'
        and terminal.group_identity = page.definition ->> 'input_owner'
        and terminal.fact_kind = 'topology_parent_partition_end'
    ) then raise exception 'topology parent partition is not sealed' using errcode = '55000'; end if;
  end if;
  if p_node_kind = 'topology_numeric_bucket' then
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity, 0,
      'topology', 'topology_discovery_end', 'discovery', '{}'::jsonb, p_observed_at)
    on conflict (job_id, attempt, revision, group_kind, group_identity,
      projection_id, fact_kind, semantic_child_identity) do nothing;
  end if;
  if not ops.problematic_projection_topology_complete(
    p_job_id, p_attempt, p_revision, p_node_kind, p_node_identity
  ) then raise exception 'topology dependencies are incomplete' using errcode = '55000'; end if;
  perform ops.seal_problematic_projection_topology_owner(
    p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch, p_revision,
    p_node_kind, p_node_identity, p_observed_at
  );
  return query select true;
end;
$$;

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
          and p_parameters ->> 'builder_version' in ('1', '3')
          then (p_parameters ->> 'builder_version')::integer
        else null end
      else null end
    else null end;
$$;

do $legacy_source_contract$
declare
  definition text;
  original_clause text := $fragment$begin
  if p_limit$fragment$;
  replacement_clause text := $fragment$begin
  if not exists (
    select 1 from ops.jobs job where job.id = p_job_id
      and ops.problematic_projection_builder_version(job.parameters) = 1
  ) then raise exception 'invalid legacy projection source contract' using errcode = '22023'; end if;
  if p_limit$fragment$;
begin
  select pg_catalog.pg_get_functiondef(
    'ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamptz)'::regprocedure
  ) into definition;
  definition := pg_catalog.replace(definition, E'\r\n', E'\n');
  if pg_catalog.strpos(definition, replacement_clause) > 0 then return; end if;
  if pg_catalog.strpos(definition, original_clause) = 0 then
    raise exception '0249 projection source owner changed';
  end if;
  execute pg_catalog.replace(definition, original_clause, replacement_clause);
end;
$legacy_source_contract$;

create or replace function ops.validate_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_observed_at timestamptz
)
returns table(valid boolean)
language sql security definer set search_path = pg_catalog
as $$
  select ops.problematic_projection_claim_valid(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_observed_at
  ) and exists (
    select 1 from ops.problematic_projection_state state
    join ops.jobs job on job.id = p_job_id and job.library_id = state.library_id
    where state.library_id = p_library_id and state.live_job_id = p_job_id
      and state.source_generation = p_source_generation and state.rebuild_epoch = p_rebuild_epoch
      and state.build_revision = p_revision and state.requested_job_id = p_job_id
      and state.requested_attempt = p_attempt and state.requested_revision = p_revision
      and (ops.problematic_projection_builder_version(job.parameters) = 1 or (
        ops.problematic_projection_builder_version(job.parameters) = 3
        and state.topology_completed_group_count is not null
        and state.topology_completed_group_fingerprint is not null
      ))
  );
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
  if p_builder_version is null or p_builder_version not in (1, 3) or
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
         (case when p_builder_version = 3 then ':v3' else '' end) then
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
    ) || case when p_builder_version = 3
      then pg_catalog.jsonb_build_object('builder_version', 3) else '{}'::jsonb end,
    p_library_id, 'self_hosted', 'private_web',
    'problematic-files-projection:' || p_library_id::text || ':' ||
      state_row.source_generation::text || ':' || state_row.rebuild_epoch::text ||
      case when p_builder_version = 3 then ':v3' else '' end,
    pg_catalog.clock_timestamp(), 3, 'retry_safe', state_row.source_generation
  ) returning id into job_id;
  update ops.problematic_projection_state as projection_state set
    source_generation = state_row.source_generation,
    source_xid_fence = state_row.source_xid_fence,
    rebuild_epoch = state_row.rebuild_epoch,
    live_job_id = job_id,
    build_revision = null,
    topology_completed_group_count = null,
    topology_completed_group_fingerprint = null,
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
  if p_builder_version is null or p_builder_version not in (1, 3)
     or ops.problematic_projection_builder_version(selected_job.parameters) is distinct from p_builder_version
     or selected_job.idempotency_key is distinct from
       'problematic-files-projection:' || selected_job.library_id::text || ':' ||
       (selected_job.parameters ->> 'source_generation') || ':' ||
       (selected_job.parameters ->> 'rebuild_epoch') ||
       (case when p_builder_version = 3 then ':v3' else '' end) then
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
        if p_builder_version = 3 and not exists (
          select 1 from ops.problematic_projection_headers header
          where header.library_id = selected_state.library_id
            and header.revision = selected_state.committed_revision
            and header.builder_version = 3
            and header.topology_completed_group_count is not null
            and header.topology_completed_group_fingerprint is not null
        ) then
          raise exception 'problematic_projection_topology_unknown' using errcode = '55000';
        end if;
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
    if p_builder_version = 3 and selected_state.build_revision is not null and (
      selected_state.topology_completed_group_count is null or
      selected_state.topology_completed_group_fingerprint is null
    ) then
      raise exception 'problematic_projection_topology_unknown' using errcode = '55000';
    end if;
    if p_builder_version = 3 and selected_state.build_revision is not null and
      not ops.problematic_projection_topology_proof_matches(
        p_job_id, selected_state.requested_attempt, selected_state.build_revision
      ) then
      raise exception 'projection topology certificates are inconsistent' using errcode = '55000';
    end if;
    if selected_state.build_revision is null then
    if p_builder_version = 3 and (
      selected_state.group_kind is not null or selected_state.scan_kind is not null or
      selected_state.source_kind is not null or selected_state.child_kind is not null or
      exists (select 1 from ops.problematic_projection_source_staging where job_id = p_job_id) or
      exists (select 1 from ops.problematic_projection_item_staging where job_id = p_job_id) or
      exists (select 1 from ops.problematic_projection_group_accumulators where job_id = p_job_id) or
      exists (select 1 from ops.problematic_projection_group_facts where job_id = p_job_id)
    ) then
      raise exception 'problematic_projection_topology_unknown' using errcode = '55000';
    end if;
    update ops.problematic_projection_state as projection_state set
      build_revision = pg_catalog.gen_random_uuid(),
      topology_completed_group_count = case when p_builder_version = 3 then 0 else null end,
      topology_completed_group_fingerprint = case when p_builder_version = 3 then 0::bit(256) else null end,
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
  if selected_version = 3 and (p_group_kind not in ('album', 'missing_album', 'loose_source')
    or not ops.problematic_projection_topology_complete(
      p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity
    )) then raise exception 'projection topology is incomplete' using errcode = '55000'; end if;
  if selected_version = 3 and exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) item
    where pg_catalog.jsonb_typeof(item -> 'search_document_count') is distinct from 'number'
      or case when coalesce(item ->> 'search_document_count', '') ~ '^[1-9][0-9]{0,18}$'
        then (item ->> 'search_document_count')::numeric > 9223372036854775807 else true end
      or pg_catalog.jsonb_typeof(item -> 'search_document_digest') is distinct from 'string'
      or coalesce(item ->> 'search_document_digest', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'invalid projection search manifest' using errcode = '22023';
  end if;
  if selected_version = 3 and exists (
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
    case when selected_version = 3 then (item ->> 'search_document_count')::bigint end,
    case when selected_version = 3 then item ->> 'search_document_digest' end
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
      and ops.problematic_projection_builder_version(job.parameters) = 3
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
  if selected_version = 3 and not ops.problematic_projection_search_complete(
    p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity
  ) then
    raise exception 'projection main search document is incomplete' using errcode = '55000';
  end if;
  if selected_version = 3 then
    if not ops.problematic_projection_topology_complete(
      p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity
    ) then
      raise exception 'projection topology is incomplete' using errcode = '55000';
    end if;
    if not exists (
      select 1 from ops.problematic_projection_group_facts terminal
      cross join lateral (
        select count(*) as source_count,
          coalesce(bit_xor(('x' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_build_array(source.source_kind, source.source_identity,
              source.child_kind, source.child_identity, source.payload)::text, 'UTF8')), 'hex'))::bit(256)), 0::bit(256))
            as source_fingerprint
        from ops.problematic_projection_source_staging source
        where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
          and source.group_kind = p_group_kind and source.group_identity = p_group_identity
          and source.source_kind <> 'topology_certificate'
      ) actual
      where terminal.job_id = p_job_id and terminal.attempt = p_attempt and terminal.revision = p_revision
        and terminal.group_kind = p_group_kind and terminal.group_identity = p_group_identity
        and terminal.projection_id = 'topology' and terminal.fact_kind = 'topology_source_end'
        and terminal.semantic_child_identity = 'source'
        and (terminal.fact_value ->> 'source_count')::bigint = actual.source_count
        and (terminal.fact_value ->> 'source_fingerprint')::bit(256) = actual.source_fingerprint
    ) then raise exception 'projection source terminal differs from staged input' using errcode = '55000'; end if;
    perform ops.seal_problematic_projection_topology_owner(
      p_job_id, p_attempt, p_library_id, p_source_generation, p_rebuild_epoch,
      p_revision, p_group_kind, p_group_identity, p_observed_at
    );
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
    and source_staging.group_identity = p_group_identity
    and source_staging.source_kind <> 'topology_certificate';
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
  cache_complete boolean;
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
    if selected_version = 3 and not exists (
      select 1 from ops.problematic_projection_headers header
      where header.library_id = p_library_id and header.revision = p_revision
        and header.builder_version = 3 and header.topology_completed_group_count is not null
        and header.topology_completed_group_fingerprint is not null
    ) then return query select false; return; end if;
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
  if selected_version = 3 and not ops.problematic_projection_topology_proof_matches(
    p_job_id, p_attempt, p_revision
  ) then return query select false; return; end if;
  select coalesce(
    bool_and(source_page.group_kind is null and source_page.page_complete),
    false
  ) into source_drained
  from ops.load_claimed_problematic_projection_source(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, 1, 1, p_observed_at, selected_version
  ) source_page;
  with cached_owners as materialized (
    select accumulator.group_kind, accumulator.group_identity
    from ops.problematic_projection_group_accumulators accumulator
    where selected_version = 3 and accumulator.job_id = p_job_id
      and accumulator.attempt = p_attempt and accumulator.revision = p_revision
      and accumulator.group_kind in ('topology_identity', 'topology_numeric_bucket', 'topology_address')
      and ops.problematic_projection_topology_owner_cached(
        accumulator.job_id, accumulator.attempt, accumulator.revision,
        accumulator.group_kind, accumulator.group_identity)
  )
  select not exists (
       select 1 from ops.problematic_projection_source_staging source_staging
       where source_staging.job_id = p_job_id
         and source_staging.attempt = p_attempt
         and source_staging.revision = p_revision
         and (selected_version = 1 or (source_staging.source_kind <> 'topology_certificate'
           and not exists (select 1 from cached_owners cached
             where cached.group_kind = source_staging.group_kind
               and cached.group_identity = source_staging.group_identity)))
    )
    and not exists (
       select 1 from ops.problematic_projection_group_accumulators accumulator
       where accumulator.job_id = p_job_id
         and accumulator.attempt = p_attempt
         and accumulator.revision = p_revision
         and (selected_version = 1 or not exists (select 1 from cached_owners cached
           where cached.group_kind = accumulator.group_kind and cached.group_identity = accumulator.group_identity))
    )
    and not exists (
       select 1 from ops.problematic_projection_group_facts fact
       where fact.job_id = p_job_id
         and fact.attempt = p_attempt
         and fact.revision = p_revision
         and (selected_version = 1 or not exists (select 1 from cached_owners cached
           where cached.group_kind = fact.group_kind and cached.group_identity = fact.group_identity))
    )
    into cache_complete;
  if not (locked_state.group_kind is null and source_drained and cache_complete) then
    return query select false;
    return;
  end if;
  if selected_version = 3 and not ops.problematic_projection_search_complete(
    p_job_id, p_attempt, p_revision, null, null
  ) then return query select false; return; end if;
  if selected_version = 3 and exists (
    select 1 from ops.problematic_projection_item_staging item
    where item.job_id = p_job_id and item.attempt = p_attempt and item.revision = p_revision
      and not exists (
        select 1 from ops.problematic_projection_source_staging certificate
        where certificate.job_id = item.job_id and certificate.attempt = item.attempt
          and certificate.revision = item.revision and certificate.source_kind = 'topology_certificate'
          and certificate.group_kind = item.group_kind and certificate.group_identity = item.group_identity
      )
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
    topology_completed_group_count, topology_completed_group_fingerprint,
    verified, published_at
  ) values (
    p_library_id, p_revision, p_source_generation, p_rebuild_epoch, selected_version,
    projected_total, projected_total, projected_facets,
    projected_reason_fact_count, projected_reason_fingerprint,
    projected_search_fact_count, projected_search_fingerprint,
    case when selected_version = 3 then locked_state.topology_completed_group_count else null end,
    case when selected_version = 3 then locked_state.topology_completed_group_fingerprint else null end,
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
  delete from ops.problematic_projection_source_staging source_staging
  where source_staging.job_id = p_job_id and source_staging.attempt = p_attempt
    and source_staging.revision = p_revision;
  delete from ops.problematic_projection_group_accumulators accumulator
  where accumulator.job_id = p_job_id and accumulator.attempt = p_attempt
    and accumulator.revision = p_revision;
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
    if selected_version = 3 and p_reason_code = 'problematic_projection_topology_unknown' then
      select state.* into selected_state
      from ops.problematic_projection_state state
      join ops.jobs job on job.id = p_job_id and job.library_id = state.library_id
      join ops.problematic_projection_headers header
        on header.library_id = state.library_id and header.revision = state.committed_revision
      where state.live_job_id is null and state.committed_job_id = p_job_id
        and state.source_generation = (job.parameters ->> 'source_generation')::bigint
        and state.rebuild_epoch = (job.parameters ->> 'rebuild_epoch')::bigint
        and header.builder_version = 3
        and (header.topology_completed_group_count is null or header.topology_completed_group_fingerprint is null)
      for update of state;
      if found then
        perform ops.enqueue_problematic_projection_rebuild(
          selected_state.library_id, 'topology-recovery:' || p_job_id::text, 3
        );
        return;
      end if;
    end if;
    select projection_state.* into selected_state
    from ops.problematic_projection_state as projection_state
    where projection_state.live_job_id = p_job_id
      and projection_state.requested_job_id = p_job_id
      and (
        projection_state.build_revision is null or
        projection_state.requested_attempt = p_attempt or
        (selected_version = 3 and p_reason_code = 'problematic_projection_topology_unknown'
          and projection_state.requested_attempt < p_attempt)
      )
      and (selected_version <> 3 or p_reason_code <> 'problematic_projection_topology_unknown' or (
        projection_state.source_generation = (selected_parameters ->> 'source_generation')::bigint
        and projection_state.rebuild_epoch = (selected_parameters ->> 'rebuild_epoch')::bigint
      ))
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
      topology_completed_group_count = null,
      topology_completed_group_fingerprint = null,
      group_kind = null, group_identity = null,
      scan_kind = null, scan_identity = null,
      source_kind = null, source_identity = null,
      child_kind = null, child_identity = null,
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
          case when selected_version = 3 then ':v3' else '' end,
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
      and (source_staging.attempt = p_attempt or (selected_version = 3
        and p_reason_code = 'problematic_projection_topology_unknown' and source_staging.attempt = selected_state.requested_attempt))
      and (source_staging.revision = p_revision or (selected_version = 3 and p_revision is null
        and (selected_state.build_revision is null or source_staging.revision = selected_state.build_revision)));
    delete from ops.problematic_projection_search_fact_staging as search_staging
    where search_staging.job_id = p_job_id
      and (search_staging.attempt = p_attempt or (selected_version = 3
        and p_reason_code = 'problematic_projection_topology_unknown' and search_staging.attempt = selected_state.requested_attempt))
      and (search_staging.revision = p_revision or (selected_version = 3 and p_revision is null
        and (selected_state.build_revision is null or search_staging.revision = selected_state.build_revision)));
    delete from ops.problematic_projection_item_staging as item_staging
    where item_staging.job_id = p_job_id
      and (item_staging.attempt = p_attempt or (selected_version = 3
        and p_reason_code = 'problematic_projection_topology_unknown' and item_staging.attempt = selected_state.requested_attempt))
      and (item_staging.revision = p_revision or (selected_version = 3 and p_revision is null
        and (selected_state.build_revision is null or item_staging.revision = selected_state.build_revision)));
    delete from ops.problematic_projection_group_accumulators as accumulator
    where accumulator.job_id = p_job_id
      and (accumulator.attempt = p_attempt or (selected_version = 3
        and p_reason_code = 'problematic_projection_topology_unknown' and accumulator.attempt = selected_state.requested_attempt))
      and (accumulator.revision = p_revision or (selected_version = 3 and p_revision is null
        and (selected_state.build_revision is null or accumulator.revision = selected_state.build_revision)));
  end if;
end;
$$;

create or replace function ops.cleanup_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_observed_at timestamptz
)
returns table(deleted_count integer)
language plpgsql security definer set search_path = pg_catalog
as $$
begin
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then return; end if;
  delete from ops.problematic_projection_source_staging source
  where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision;
  get diagnostics deleted_count = row_count;
  delete from ops.problematic_projection_search_fact_staging search
  where search.job_id = p_job_id and search.attempt = p_attempt and search.revision = p_revision;
  delete from ops.problematic_projection_item_staging item
  where item.job_id = p_job_id and item.attempt = p_attempt and item.revision = p_revision;
  delete from ops.problematic_projection_group_accumulators owner
  where owner.job_id = p_job_id and owner.attempt = p_attempt and owner.revision = p_revision;
  if exists (select 1 from ops.jobs job where job.id = p_job_id
    and ops.problematic_projection_builder_version(job.parameters) = 3) then
    update ops.problematic_projection_state state set
      topology_completed_group_count = null, topology_completed_group_fingerprint = null,
      updated_at = p_observed_at
    where state.library_id = p_library_id and state.live_job_id = p_job_id
      and state.build_revision = p_revision and state.requested_attempt = p_attempt
      and state.source_generation = p_source_generation and state.rebuild_epoch = p_rebuild_epoch;
  end if;
  return next;
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
    and ops.problematic_projection_builder_version(job.parameters) is not null
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
      case when selected_version = 3 then ':v3' else '' end,
    database_now, 3, 'retry_safe', selected_state.source_generation
  ) returning id into replacement_job_id;
  update ops.jobs as replacement_job
  set scheduled_at = database_now
  where replacement_job.id = replacement_job_id;
  update ops.problematic_projection_state as projection_state set
    rebuild_epoch = projection_state.rebuild_epoch + 1,
    live_job_id = replacement_job_id,
    build_revision = null,
    topology_completed_group_count = null,
    topology_completed_group_fingerprint = null,
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
    'ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamp with time zone,integer)',
    'ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamp with time zone)',
    'ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamp with time zone,integer)',
    'ops.register_claimed_problematic_topology_nodes(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamp with time zone)',
    'ops.load_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,integer,timestamp with time zone)',
    'ops.stage_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,jsonb,boolean,timestamp with time zone)',
    'ops.complete_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamp with time zone)',
    'ops.load_claimed_problematic_topology_descriptors(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,integer,timestamp with time zone)',
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
  if pg_catalog.to_regprocedure('library.problematic_duplicate_identity_text(text)') is null then
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
    if selected_version in (1, 2, 3) then
      perform * from ops.enqueue_problematic_projection_rebuild(
        p_library_id, 'integrity-reconciler', case when selected_version = 2 then 3 else selected_version end
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
  derived_node_batch boolean;
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
  if exists (
    select 1 from ops.problematic_projection_group_facts ready
    where ready.job_id = p_job_id and ready.attempt = p_attempt and ready.revision = p_revision
      and ready.group_kind = p_group_kind and ready.group_identity = p_group_identity
      and ready.projection_id = 'topology' and ready.fact_kind = 'topology_ready'
  ) then raise exception 'sealed topology source facts are immutable' using errcode = '55000'; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    where (entry ->> 'fact_kind') like 'topology_%'
      and (entry ->> 'fact_kind') not in (
        'topology_seed', 'topology_parent_partition',
        'topology_numeric_bucket_result', 'topology_address_result',
        'topology_address_member', 'topology_folder_status', 'topology_own_rank_result'
      )
  ) then raise exception 'reserved topology fact' using errcode = '22023'; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    where entry ->> 'fact_kind' = 'topology_seed' and not exists (
      select 1 from ops.problematic_projection_source_staging source
      where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
        and source.group_kind = p_group_kind and source.group_identity = p_group_identity
        and source.stage_id = (entry ->> 'stage_id')::bigint
        and source.child_kind in ('file', 'identity', 'default', 'numeric_parent')
        and source.payload -> 'file_id' = entry #> '{fact_value,file_id}'
        and coalesce(source.payload ->> 'album_key', '') = entry #>> '{fact_value,original_album_key}'
        and pg_catalog.btrim(coalesce(source.payload ->> 'file_private_path', '')) = entry #>> '{fact_value,path}'
    )
  ) then raise exception 'topology seed lacks its authoritative file' using errcode = '55000'; end if;
  if p_group_kind like 'topology_%' then
    if p_group_kind not in ('topology_identity', 'topology_numeric_bucket', 'topology_address')
      or exists (select 1 from ops.problematic_projection_source_staging certificate
        where certificate.job_id = p_job_id and certificate.attempt = p_attempt and certificate.revision = p_revision
          and certificate.group_kind = p_group_kind and certificate.group_identity = p_group_identity
          and certificate.source_kind = 'topology_certificate')
      or exists (select 1 from ops.problematic_projection_group_facts terminal
        where terminal.job_id = p_job_id and terminal.attempt = p_attempt and terminal.revision = p_revision
          and terminal.group_kind = p_group_kind and terminal.group_identity = p_group_identity
          and terminal.fact_kind in ('topology_parent_partition_end', 'topology_own_rank_end'))
      or exists (select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
        where (entry ->> 'fact_kind') not in ('topology_seed', 'topology_parent_partition',
          'topology_numeric_bucket_result', 'topology_address_result', 'topology_address_member', 'topology_folder_status', 'topology_own_rank_result'))
    then raise exception 'sealed or invalid topology derivation owner' using errcode = '55000'; end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
      where (entry ->> 'fact_kind' = 'topology_parent_partition' and
          (p_group_kind <> 'topology_numeric_bucket' or p_group_identity not like 'input:%'))
        or (entry ->> 'fact_kind' = 'topology_numeric_bucket_result' and
          (p_group_kind <> 'topology_numeric_bucket' or p_group_identity like 'input:%'))
        or (entry ->> 'fact_kind' in ('topology_address_result', 'topology_address_member', 'topology_folder_status') and
          (p_group_kind <> 'topology_address' or p_group_identity like 'rank:%'))
        or (entry ->> 'fact_kind' = 'topology_own_rank_result' and
          (p_group_kind <> 'topology_address' or p_group_identity not like 'rank:%'))
    ) then raise exception 'topology derivation kind differs from owner' using errcode = '22023'; end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
      where entry ->> 'fact_kind' in ('topology_parent_partition', 'topology_address_member')
        and (entry ->> 'semantic_child_identity' is distinct from
          pg_catalog.lpad(entry #>> '{fact_value,file_id}', 20, '0') or not exists (
          select 1 from ops.problematic_projection_source_staging source
          where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
            and source.group_kind = p_group_kind and source.group_identity = p_group_identity
            and source.source_kind = 'topology_input' and source.stage_id = (entry ->> 'stage_id')::bigint
            and source.stage_id = (entry #>> '{fact_value,source_stage_id}')::bigint
            and source.payload -> 'file_id' = entry #> '{fact_value,file_id}'
        ))
    ) then raise exception 'topology disposition lacks authoritative input' using errcode = '55000'; end if;
  elsif exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    where (entry ->> 'fact_kind') like 'topology_%' and entry ->> 'fact_kind' <> 'topology_seed'
  ) then raise exception 'reserved topology derivation owner' using errcode = '22023'; end if;
  derived_node_batch := p_group_kind like 'topology_%' and not exists (
    select 1 from pg_catalog.jsonb_array_elements(p_entries) entry
    where entry ->> 'fact_kind' not in ('topology_address_result', 'topology_address_member', 'topology_folder_status',
      'topology_numeric_bucket_result', 'topology_own_rank_result')
  );
  if last_stage_id <= p_expected_after_stage_id and not derived_node_batch then
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
    after_stage_id = greatest(last_stage_id, p_expected_after_stage_id),
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
  return query select greatest(last_stage_id, p_expected_after_stage_id), p_next_batch_index, p_row_count,
    accumulator.source_complete
  from ops.problematic_projection_group_accumulators accumulator
  where accumulator.job_id = p_job_id
    and accumulator.attempt = p_attempt
    and accumulator.revision = p_revision
    and accumulator.group_kind = p_group_kind
    and accumulator.group_identity = p_group_identity;
end;
$$;

create or replace function ops.load_claimed_problematic_projection_source(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_limit integer, p_child_limit integer,
  p_observed_at timestamptz, p_builder_version integer
)
returns table(
  group_kind text, group_identity text, source_kind text, source_identity text,
  child_kind text, child_identity text, rows jsonb, group_complete boolean,
  page_complete boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_builder_version is null or p_builder_version not in (1, 3) or not exists (
    select 1 from ops.jobs job where job.id = p_job_id
      and ops.problematic_projection_builder_version(job.parameters) = p_builder_version
  ) then raise exception 'invalid projection source contract' using errcode = '22023'; end if;
  if p_builder_version = 1 then
    return query select * from ops.load_claimed_problematic_projection_source(
      p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
      p_source_generation, p_rebuild_epoch, p_revision, p_limit, p_child_limit,
      p_observed_at
    );
    return;
  end if;
  if p_builder_version is distinct from 3 or not exists (
    select 1 from ops.jobs job where job.id = p_job_id
      and ops.problematic_projection_builder_version(job.parameters) = 3
  ) then raise exception 'invalid projection source contract' using errcode = '22023'; end if;
  if not exists (
    select 1 from ops.problematic_projection_state state where state.library_id = p_library_id
      and state.live_job_id = p_job_id and state.build_revision = p_revision
      and state.requested_attempt = p_attempt
      and state.topology_completed_group_count is not null
      and state.topology_completed_group_fingerprint is not null
  ) then raise exception 'problematic_projection_topology_unknown' using errcode = '55000'; end if;
  if p_limit is null or p_child_limit is null
    or p_limit < 1 or p_limit > 100 or p_child_limit < 1 or p_child_limit > 100 then
    raise exception 'invalid projection source page limit' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then return; end if;
  -- Source extraction remains keyset-bounded. Each file is an independently
  -- resumable child inside its album group; whole-album semantics are restored
  -- from staging before projection.
  return query
  with state as (
    select * from ops.problematic_projection_state
    where library_id = p_library_id
  ), raw_album_scan as materialized (
    select album.id, album.library_id
    from library.local_albums album
    cross join state
    where album.library_id = p_library_id
      and (
        state.scan_kind is distinct from 'album' or
        album.id > coalesce(nullif(state.scan_identity, ''), '0')::bigint
      )
    order by album.id
    limit least(p_limit, 100)
  ), active_album_groups as materialized (
    select 'album'::text as group_kind, album.id as group_identity
    from raw_album_scan album
    cross join state
    where album.library_id = p_library_id
      and exists (
        select 1
        from ops.problematic_projection_source_rows source
        where source.library_id = p_library_id
          and source.group_kind = 'album'
          and source.group_identity = album.id::text
      )
      and album.id > case when coalesce(state.group_kind, state.source_kind, '') in ('album', 'missing_album')
        then coalesce(state.group_identity, state.source_identity, '0')::bigint else 0 end
      and exists (
        select 1
        from library.local_tracks active_track
        join library.local_track_files active_file
          on active_file.track_id = active_track.id
        join library.library_roots active_root on active_root.id = active_file.library_root_id
          and active_root.library_id = p_library_id and active_root.is_active
        where active_track.album_id = album.id
          and active_file.scan_cache_stale is false
      )
    order by album.id
    limit 2
  ), loose_groups as materialized (
    select 'loose_source'::text as group_kind, file.id as group_identity
    from library.local_tracks track
    join library.local_track_files file on file.track_id = track.id
    join library.library_roots root on root.id = file.library_root_id
      and root.library_id = p_library_id and root.is_active
    cross join state
    where track.library_id = p_library_id
      and exists (
        select 1
        from ops.problematic_projection_source_rows source
        where source.library_id = p_library_id
          and source.group_kind = 'loose_source'
          and source.group_identity = file.id::text
      )
      and not exists (select 1 from raw_album_scan)
      and track.album_id is null
      and file.scan_cache_stale is false
      and nullif(
        file.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
        ''
      ) is not null
      and ('loose_source'::text, file.id) > (
        coalesce(state.group_kind, state.source_kind, ''),
        coalesce(state.group_identity, state.source_identity, '0')::bigint
      )
    order by file.id
    limit 2
  ), missing_album_groups as materialized (
    select 'missing_album'::text as group_kind, album.id as group_identity
    from raw_album_scan album
    cross join state
    where album.library_id = p_library_id
      and exists (
        select 1
        from ops.problematic_projection_source_rows source
        where source.library_id = p_library_id
          and source.group_kind = 'missing_album'
          and source.group_identity = album.id::text
      )
      and album.id > case when coalesce(state.group_kind, state.source_kind, '') in ('album', 'missing_album')
        then coalesce(state.group_identity, state.source_identity, '0')::bigint else 0 end
      and exists (
        select 1
        from library.local_tracks any_track
        join library.local_track_files any_file
          on any_file.track_id = any_track.id
        where any_track.album_id = album.id
      )
      and not exists (
        select 1
        from library.local_tracks active_track
        join library.local_track_files active_file
          on active_file.track_id = active_track.id
        where active_track.album_id = album.id
          and active_file.scan_cache_stale is false
      )
    order by album.id
    limit 2
  ), candidate_groups as materialized (
    select * from active_album_groups
    union all
    select * from loose_groups
    union all
    select * from missing_album_groups
  ), raw_album_scan_progress as materialized (
    update ops.problematic_projection_state as projection_state set
      scan_kind = 'album',
      scan_identity = (select max(scanned.id)::text from raw_album_scan scanned),
      group_kind = null,
      group_identity = null,
      source_kind = null,
      source_identity = null,
      child_kind = null,
      child_identity = null,
      updated_at = p_observed_at
    where projection_state.library_id = p_library_id
      and projection_state.live_job_id = p_job_id
      and projection_state.source_generation = p_source_generation
      and projection_state.rebuild_epoch = p_rebuild_epoch
      and projection_state.build_revision = p_revision
      and projection_state.requested_job_id = p_job_id
      and projection_state.requested_attempt = p_attempt
      and projection_state.requested_revision = p_revision
      and exists (select 1 from raw_album_scan)
      and not exists (select 1 from active_album_groups)
      and not exists (select 1 from missing_album_groups)
    returning projection_state.library_id
  ), bounded_groups as materialized (
    select candidate.group_kind, candidate.group_identity
    from candidate_groups candidate
    order by candidate.group_identity, candidate.group_kind
    limit 2
  ), active_group as materialized (
    select selected.group_kind, selected.group_identity
    from (
      select state.group_kind, state.group_identity::bigint as group_identity
      from state
      where state.group_kind is not null
      union all
      select bounded.group_kind, bounded.group_identity
      from bounded_groups bounded
      cross join state
      where state.group_kind is null
    ) selected
    order by selected.group_identity, selected.group_kind
    limit 1
  ), selected_album_state as materialized (
    select album.id as album_id,
      active_probe.has_active_file,
      not active_probe.has_active_file as all_files_stale,
      missing_probe.missing_since
    from active_group
    join library.local_albums album
      on album.id = active_group.group_identity
      and active_group.group_kind in ('album', 'missing_album')
    cross join lateral (
      select exists (
        select 1
        from library.local_tracks active_track
        join library.local_track_files active_file
          on active_file.track_id = active_track.id
        join library.library_roots active_root on active_root.id = active_file.library_root_id
          and active_root.library_id = p_library_id and active_root.is_active
        where active_track.album_id = album.id
          and active_file.scan_cache_stale is false
      ) as has_active_file
    ) active_probe
    left join lateral (
      select min(stale_file.metadata #>> '{scan_cache,stale_marked_at}')
        as missing_since
      from library.local_tracks stale_track
      join library.local_track_files stale_file
        on stale_file.track_id = stale_track.id
      where stale_track.album_id = album.id
        and stale_file.scan_cache_stale is true
    ) missing_probe on true
    where album.library_id = p_library_id
  ), ordinary_candidates as materialized (
    select unbounded.*
    from (
    select
      case when status.has_active_file then 'album' else 'missing_album' end
        as group_kind,
      album.id as group_identity,
      case when status.has_active_file then 'album' else 'missing_album' end
        as source_kind,
      album.id as source_identity,
      'file'::text as child_kind,
      file.id::text as child_identity,
      album.id as album_id, track.id as track_id,
      file.id as owner_file_id, null::bigint as companion_file_id
    from library.local_albums album
      join selected_album_state status on status.album_id = album.id
    cross join state
    join active_group
      on active_group.group_kind = case
        when status.has_active_file then 'album' else 'missing_album' end
      and active_group.group_identity = album.id
    join library.local_tracks track on track.album_id = album.id
    join library.local_track_files file on file.track_id = track.id
    left join library.library_roots source_root on source_root.id = file.library_root_id
      and source_root.library_id = p_library_id
    where album.library_id = p_library_id
      and (
        (status.has_active_file and file.scan_cache_stale is false and source_root.is_active)
        or (status.all_files_stale and file.scan_cache_stale is true)
      )
      and (
        state.child_kind is null or
        (state.child_kind = 'file' and
          file.id > coalesce(nullif(case when state.child_kind = 'file'
            then state.child_identity end, ''), '0')::bigint)
      )
    union all
    select 'loose_source'::text as group_kind,
      file.id as group_identity,
      'loose_source'::text as source_kind,
      file.id as source_identity,
      'file'::text as child_kind,
      file.id::text as child_identity,
      null::bigint as album_id, track.id as track_id,
      file.id as owner_file_id, null::bigint as companion_file_id
    from library.local_tracks track
    join library.local_track_files file on file.track_id = track.id
    join library.library_roots root on root.id = file.library_root_id
      and root.library_id = p_library_id and root.is_active
    cross join state
    join active_group
      on active_group.group_kind = 'loose_source'
      and active_group.group_identity = file.id
    where track.library_id = p_library_id
      and track.album_id is null
      and file.scan_cache_stale is false
      and nullif(
        file.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
        ''
      ) is not null
      and (
        state.child_kind is null or
        (state.child_kind = 'file' and
          file.id > coalesce(nullif(case when state.child_kind = 'file'
            then state.child_identity end, ''), '0')::bigint)
      )
    ) unbounded
    order by unbounded.child_identity::bigint
    limit least(p_limit, p_child_limit, 100)
  ), ordinary_keys as materialized (
    select ordinary.*
    from ordinary_candidates ordinary
    order by ordinary.child_identity::bigint
    limit least(p_limit, p_child_limit, 100)
  ), row_projections as materialized (
    select distinct fact.projection_id, fact.fact_value
    from ops.problematic_projection_group_facts fact
    join active_group
      on active_group.group_kind = fact.group_kind
      and active_group.group_identity::text = fact.group_identity
    where fact.job_id = p_job_id
      and fact.attempt = p_attempt
      and fact.revision = p_revision
      and fact.fact_kind = 'row'
  ), featured_artist_candidates as materialized (
    select distinct active_group.group_kind, active_group.group_identity,
      active_group.group_kind as source_kind,
      active_group.group_identity as source_identity,
      'featured_artist'::text as child_kind,
      row_projection.projection_id || ':' ||
        lpad(album_featured.id::text, 20, '0') as child_identity,
      active_group.group_identity as album_id,
      row_projection.projection_id,
      featured_artist.name as fact_value
    from active_group
    join row_projections row_projection on true
    join library.local_album_featured_artists album_featured
      on album_featured.album_id = active_group.group_identity
    join library.local_artists featured_artist
      on featured_artist.id = album_featured.artist_id
    cross join state
    where not exists (select 1 from ordinary_keys)
      and active_group.group_kind in ('album', 'missing_album')
      and (
        state.child_kind is null or
        state.child_kind = 'file' or
        (
          state.child_kind = 'featured_artist' and
          row_projection.projection_id || ':' ||
            lpad(album_featured.id::text, 20, '0') > state.child_identity
        )
      )
    order by row_projection.projection_id || ':' || lpad(album_featured.id::text, 20, '0')
    limit least(p_limit, p_child_limit, 100)
  ), ignored_repair_candidates as materialized (
    select distinct active_group.group_kind, active_group.group_identity,
      active_group.group_kind as source_kind,
      active_group.group_identity as source_identity,
      'ignored_repair'::text as child_kind,
      row_projection.projection_id || ':' ||
        pg_catalog.lpad(ignored_repair.id::text, 20, '0')
        as child_identity,
      active_group.group_identity as album_id,
      row_projection.projection_id,
      repair_identity.ignored_repair_hash as fact_value
    from active_group
    join row_projections row_projection on true
    join library.ignored_repairs ignored_repair
      on ignored_repair.library_id = p_library_id
      and (
        split_part(ignored_repair.repair_key, '::', 1) =
          row_projection.fact_value ->> 'file_private_path' or
        (
          ignored_repair.repair_key ~ '::problem-album::[^:]+$' and
          ignored_repair.metadata ->> 'album_key' =
            row_projection.fact_value ->> 'album_key'
        )
      )
    cross join lateral (
      select pg_catalog.rtrim(
        pg_catalog.translate(
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                'ignored_repair:' ||
                pg_catalog.octet_length(
                  pg_catalog.convert_to(ignored_repair.repair_key, 'UTF8')
                )::text || ':' || ignored_repair.repair_key,
                'UTF8'
              )
            ),
            'base64'
          ),
          '+/',
          '-_'
        ),
        '='
      ) as ignored_repair_hash
    ) repair_identity
    cross join state
    where not exists (select 1 from ordinary_keys)
      and not exists (select 1 from featured_artist_candidates)
      and active_group.group_kind in ('album', 'missing_album')
      and (
        state.child_kind is null or
        state.child_kind in ('file', 'featured_artist') or
        (
          state.child_kind = 'ignored_repair' and
          row_projection.projection_id || ':' ||
            pg_catalog.lpad(ignored_repair.id::text, 20, '0') >
            state.child_identity
        )
      )
    order by row_projection.projection_id || ':' || pg_catalog.lpad(ignored_repair.id::text, 20, '0')
    limit least(p_limit, p_child_limit, 100)
  ), source_keys as materialized (
    select ordinary.* from ordinary_keys ordinary
    ), source_rows as materialized (
    select source_keys.group_kind, source_keys.group_identity,
      source_keys.source_kind, source_keys.source_identity,
      source_keys.child_kind, source_keys.child_identity,
      album.id as album_id, file.id as file_id,
      pg_catalog.jsonb_build_object(
        'album_id', album.id, 'album_key', album.album_key,
        'projection_owner_album_id', album.id,
        'album_title', album.title, 'album_release_year', album.release_year,
        'album_cover_path', album.cover_path,
        'album_artist', album.metadata ->> 'album_artist',
        'album_artists', coalesce(album.metadata -> 'artists', '[]'::jsonb),
        'album_is_compilation', album.metadata -> 'is_compilation',
        'album_cover_revision', album.metadata ->> 'cover_revision',
        'album_cover_selection_origin', album.metadata ->> 'cover_selection_origin',
        'album_local_cover_width', album.metadata -> 'local_cover_width',
        'album_local_cover_height', album.metadata -> 'local_cover_height',
        'album_remote_cover_url', album.metadata ->> 'remote_cover_url',
        'album_remote_cover_thumbnail_url',
          album.metadata ->> 'remote_cover_thumbnail_url',
        'album_remote_cover_source', album.metadata ->> 'remote_cover_source',
        'album_remote_cover_source_label',
          album.metadata ->> 'remote_cover_source_label',
        'album_remote_cover_album_url', album.metadata ->> 'remote_cover_album_url',
        'album_remote_cover_width', album.metadata -> 'remote_cover_width',
        'album_remote_cover_height', album.metadata -> 'remote_cover_height',
        'album_release_date', album.metadata ->> 'release_date',
        'album_edition', album.metadata ->> 'edition',
        'album_rating', album.metadata -> 'album_rating',
        'album_root_provenance', album.metadata -> 'root_provenance'
      ) || pg_catalog.jsonb_build_object(
        'artist_name', coalesce(artist.name, ''),
        'album_featured_artist_names', '[]'::jsonb,
        'inventory_status', case when source_keys.source_kind = 'missing_album'
          then 'missing' else null end,
        'missing_since', case when source_keys.source_kind = 'missing_album'
          then status.missing_since else null end,
        'duplicate_candidate', duplicate_inputs.duplicate_candidate,
        'spotify_cover_quota_exceeded', quota_inputs.quota_exceeded,
        'separate_release', separate_release_input.is_member,
        'source_child_kind', source_keys.child_kind,
        'source_child_identity', source_keys.child_identity,
        'file_physical_parent', file.scan_physical_parent,
        'file_id', file.id,
        'track_key', track.track_key, 'track_title', track.title,
        'disc_number', track.disc_number, 'track_number', track.track_number,
        'duration_seconds', track.duration_seconds,
        'file_private_path', file.private_path,
        'file_size', file.file_size_bytes,
        'file_scan_cache_stale', file.scan_cache_stale,
        'file_text_mojibake_candidate', file.scan_file_text_mojibake_candidate,
        'file_stale_marked_at', file.metadata #>> '{scan_cache,stale_marked_at}',
        'file_library_root_id', file.library_root_id,
        'file_library_root_category', root.root_kind,
        'duplicate_lookup_owner_file_id', file.id,
        'duplicate_lookup_owner_track_id', track.id,
        'duplicate_lookup_album_artist_identity',
          library.problematic_duplicate_identity_text(file.scan_file_album_artist),
        'duplicate_lookup_album_identity',
          library.problematic_duplicate_identity_text(file.scan_file_album),
        'duplicate_lookup_year_identity',
          library.duplicate_identity_year(file.scan_file_year),
        'duplicate_lookup_physical_album_container',
          library.problematic_physical_album_container(file.private_path),
        'companion_file_id', companion_file.id,
        'companion_private_path', companion_file.private_path,
        'companion_library_root_id', companion_file.library_root_id,
        'companion_root_category', companion_root.root_kind
      ) || pg_catalog.jsonb_build_object(
        'file_entry', case when file.scan_file_entry_is_object then
          pg_catalog.jsonb_build_object('exception_type', file.metadata #> '{scan_cache,file_entry,exception_type}')
          else file.metadata #> '{scan_cache,file_entry}' end,
        'file_entry_is_object',
          pg_catalog.jsonb_typeof(file.metadata #> '{scan_cache,file_entry}') = 'object',
        'file_album', file.metadata #>> '{scan_cache,file_entry,album}',
        'file_album_artist',
          file.metadata #>> '{scan_cache,file_entry,album_artist}',
        'file_artist', file.metadata #>> '{scan_cache,file_entry,artist}',
        'file_title', file.metadata #>> '{scan_cache,file_entry,title}',
        'file_year', file.metadata #> '{scan_cache,file_entry,year}',
        'file_genre', file.metadata #>> '{scan_cache,file_entry,genre}',
        'file_track_number',
          file.metadata #> '{scan_cache,file_entry,track_number}',
        'file_disc_number', file.metadata #> '{scan_cache,file_entry,disc_number}',
        'file_disc_number_raw',
          file.metadata #> '{scan_cache,file_entry,disc_number_raw}',
        'file_total_discs', file.metadata #> '{scan_cache,file_entry,total_discs}',
        'file_disc_subtitle', file.metadata #>> '{scan_cache,file_entry,disc_subtitle}',
        'file_duration_seconds',
          file.metadata #> '{scan_cache,file_entry,duration_seconds}',
        'file_cover_path', file.metadata #>> '{scan_cache,file_entry,cover_path}',
        'file_cover_revision',
          file.metadata #>> '{scan_cache,file_entry,cover_revision}',
        'file_edition', file.metadata #>> '{scan_cache,file_entry,edition}',
        'file_album_rating',
          file.metadata #> '{scan_cache,file_entry,album_rating}',
        'local_album_membership_problem',
          file.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
        'exception_override_present', coalesce(exception_override.override_payload ? 'exception_type', false),
        'exception_type', case when exception_override.override_payload ? 'exception_type'
          then exception_override.override_payload ->> 'exception_type'
          else file.metadata #>> '{scan_cache,file_entry,exception_type}' end
      ) as payload
    from source_keys
    join library.local_albums album on album.id = source_keys.album_id
      join selected_album_state status on status.album_id = album.id
    join library.local_tracks track on track.id = source_keys.track_id
    join library.local_track_files file on file.id = source_keys.owner_file_id
    left join library.local_track_files companion_file
      on companion_file.id = source_keys.companion_file_id
    left join library.local_artists artist on artist.id = album.artist_id
    left join library.library_roots root on root.id = file.library_root_id
    left join library.library_roots companion_root
      on companion_root.id = companion_file.library_root_id
    left join lateral (
      select override_row.override_payload
      from library.exception_overrides override_row
      where override_row.library_id = p_library_id
        and (override_row.track_key = file.private_path or override_row.track_id = track.id)
      order by case when override_row.track_key = file.private_path then 0 else 1 end,
        override_row.id
      limit 1
    ) exception_override on true
    left join lateral (
      select exists (
        select 1
        from library.separate_releases separate_release
        where separate_release.library_id = album.library_id
          and (
            separate_release.release_key = album.album_key
            or separate_release.release_key = library.problematic_release_identity(
              coalesce(album.metadata ->> 'album_artist', artist.name, ''),
              album.title,
              album.metadata ->> 'edition'
            )
          )
        order by separate_release.release_key
        limit least(p_limit, p_child_limit, 100)
      ) as is_member
    ) separate_release_input on true
    left join lateral (
      select exists (
        select 1
        from library.local_track_files candidate_file
        join library.local_tracks candidate_track
          on candidate_track.id = candidate_file.track_id
        join library.local_albums companion_album
          on companion_album.id = candidate_track.album_id
        where candidate_file.scan_cache_stale is false
          and candidate_file.library_root_id = file.library_root_id
          and candidate_track.library_id = album.library_id
          and companion_album.id <> album.id
          and pg_catalog.md5(library.problematic_physical_album_container(candidate_file.private_path)) =
            pg_catalog.md5(library.problematic_physical_album_container(file.private_path))
          and library.problematic_physical_album_container(
            candidate_file.private_path
          ) = library.problematic_physical_album_container(file.private_path)
          and library.problematic_duplicate_identity_text(candidate_file.scan_file_album_artist)
            = library.problematic_duplicate_identity_text(file.scan_file_album_artist)
          and library.problematic_duplicate_identity_text(candidate_file.scan_file_album)
            = library.problematic_duplicate_identity_text(file.scan_file_album)
          and library.duplicate_identity_year(candidate_file.scan_file_year)
            = library.duplicate_identity_year(file.scan_file_year)
      ) as duplicate_candidate
    ) duplicate_inputs on true
    left join lateral (
      select exists (
        select 1 from ops.cover_lookup_tasks cover_task
        where cover_task.library_id = album.library_id
          and (cover_task.local_album_id = album.id
            or cover_task.task_key = album.id::text || ':search_spotify')
          and cover_task.metadata ->> 'source_family'
            = 'automatic_cover_provider_outcomes_v1'
          and cover_task.metadata ->> 'provider' = 'search_spotify'
          and cover_task.metadata ->> 'category' = 'rate_limit_quota'
          and cover_task.status = 'failed'
      ) as quota_exceeded
    ) quota_inputs on true
    where source_keys.group_kind <> 'loose_source'
    union all
    select source_keys.group_kind, source_keys.group_identity,
      source_keys.source_kind, source_keys.source_identity,
      source_keys.child_kind, source_keys.child_identity,
      null::bigint as album_id, file.id as file_id,
      pg_catalog.jsonb_build_object(
        'album_id', null,
        'album_key', 'loose-source::' || file.id::text,
        'projection_owner_album_id', null,
        'album_title', coalesce(
          nullif(file.metadata #>> '{scan_cache,file_entry,album}', ''),
          'Loose files'
        ),
        'album_release_year', file.scan_file_year,
        'album_cover_path', null,
        'album_metadata', '{}'::jsonb,
        'artist_name', coalesce(
          nullif(file.metadata #>> '{scan_cache,file_entry,album_artist}', ''),
          nullif(file.metadata #>> '{scan_cache,file_entry,artist}', ''),
          ''
        ),
        'album_featured_artist_names', array[]::text[],
        'inventory_status', null,
        'missing_since', null,
        'duplicate_candidate', false,
        'spotify_cover_quota_exceeded', false,
        'separate_release', false,
        'source_child_kind', source_keys.child_kind,
        'source_child_identity', source_keys.child_identity,
        'file_physical_parent', file.scan_physical_parent,
        'local_album_membership_problem',
          file.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
        'file_id', file.id,
        'track_key', track.track_key,
        'track_title', track.title,
        'disc_number', track.disc_number,
        'track_number', track.track_number,
        'duration_seconds', track.duration_seconds,
        'file_private_path', file.private_path,
        'file_size', file.file_size_bytes,
        'file_scan_cache_stale', file.scan_cache_stale,
        'file_text_mojibake_candidate', file.scan_file_text_mojibake_candidate,
        'file_stale_marked_at',
          file.metadata #>> '{scan_cache,stale_marked_at}',
        'file_library_root_id', file.library_root_id,
        'file_library_root_category', root.root_kind,
        'companion_file_id', null,
        'companion_private_path', null,
        'companion_library_root_id', null,
        'companion_root_category', null
      ) || pg_catalog.jsonb_build_object(
        'file_entry', case when file.scan_file_entry_is_object then
          pg_catalog.jsonb_build_object('exception_type', file.metadata #> '{scan_cache,file_entry,exception_type}')
          else file.metadata #> '{scan_cache,file_entry}' end,
        'file_entry_is_object',
          pg_catalog.jsonb_typeof(file.metadata #> '{scan_cache,file_entry}') = 'object',
        'file_album', file.metadata #>> '{scan_cache,file_entry,album}',
        'file_album_artist',
          file.metadata #>> '{scan_cache,file_entry,album_artist}',
        'file_artist', file.metadata #>> '{scan_cache,file_entry,artist}',
        'file_title', file.metadata #>> '{scan_cache,file_entry,title}',
        'file_year', file.metadata #> '{scan_cache,file_entry,year}',
        'file_genre', file.metadata #>> '{scan_cache,file_entry,genre}',
        'file_track_number',
          file.metadata #> '{scan_cache,file_entry,track_number}',
        'file_disc_number', file.metadata #> '{scan_cache,file_entry,disc_number}',
        'file_disc_number_raw',
          file.metadata #> '{scan_cache,file_entry,disc_number_raw}',
        'file_total_discs', file.metadata #> '{scan_cache,file_entry,total_discs}',
        'file_disc_subtitle', file.metadata #>> '{scan_cache,file_entry,disc_subtitle}',
        'file_duration_seconds',
          file.metadata #> '{scan_cache,file_entry,duration_seconds}',
        'file_cover_path', file.metadata #>> '{scan_cache,file_entry,cover_path}',
        'file_cover_revision',
          file.metadata #>> '{scan_cache,file_entry,cover_revision}',
        'file_edition', file.metadata #>> '{scan_cache,file_entry,edition}',
        'file_album_rating',
          file.metadata #> '{scan_cache,file_entry,album_rating}',
        'exception_override_present', coalesce(exception_override.override_payload ? 'exception_type', false),
        'exception_type', case when exception_override.override_payload ? 'exception_type'
          then exception_override.override_payload ->> 'exception_type'
          else file.metadata #>> '{scan_cache,file_entry,exception_type}' end
      ) as payload
    from source_keys
    join library.local_tracks track on track.id = source_keys.track_id
    join library.local_track_files file on file.id = source_keys.owner_file_id
    join library.library_roots root on root.id = file.library_root_id
    left join lateral (
      select override_row.override_payload from library.exception_overrides override_row
      where override_row.library_id = p_library_id
        and (override_row.track_key = file.private_path or override_row.track_id = track.id)
      order by case when override_row.track_key = file.private_path then 0 else 1 end,
        override_row.id limit 1
    ) exception_override on true
    where source_keys.group_kind = 'loose_source'
    union all
    select featured.group_kind, featured.group_identity,
      featured.source_kind, featured.source_identity,
      featured.child_kind, featured.child_identity,
      featured.album_id, null::bigint as file_id,
      pg_catalog.jsonb_build_object(
        'projection_id', featured.projection_id,
        'source_child_kind', featured.child_kind,
        'featured_artist_name', featured.fact_value
      ) as payload
    from featured_artist_candidates featured
    union all
    select ignored.group_kind, ignored.group_identity,
      ignored.source_kind, ignored.source_identity,
      ignored.child_kind, ignored.child_identity,
      ignored.album_id, null::bigint as file_id,
      pg_catalog.jsonb_build_object(
        'projection_id', ignored.projection_id,
        'source_child_kind', ignored.child_kind,
        'ignored_repair_hash', ignored.fact_value
      ) as payload
    from ignored_repair_candidates ignored
  ), page_rows(
    group_kind, group_identity, source_kind, source_identity, child_kind,
    child_identity, rows, group_complete, page_complete
  ) as materialized (
  select source.group_kind, source.group_identity::text, source.source_kind,
    source.source_identity::text, source.child_kind, source.child_identity,
    pg_catalog.jsonb_build_array(source.payload), false, false
  from source_rows source
  union all
  select active.group_kind, active.group_identity::text, active.group_kind,
    active.group_identity::text, 'topology_source_end'::text,
    active.group_identity::text, '[]'::jsonb, true, false
  from active_group active
  where not exists (select 1 from source_rows)
  union all
  select null::text, null::text, null::text, null::text, null::text, null::text,
    '[]'::jsonb, false, not exists (select 1 from raw_album_scan)
  where not exists (select 1 from active_group)
  ), offer_owners as (
    insert into ops.problematic_projection_group_accumulators as accumulator(
      job_id, attempt, revision, group_kind, group_identity, updated_at
    ) select distinct p_job_id, p_attempt, p_revision, page.group_kind, page.group_identity, p_observed_at
    from page_rows page where page.group_kind is not null
    on conflict on constraint problematic_projection_group_accumulators_pkey do nothing
    returning accumulator.group_kind, accumulator.group_identity
  ), offers as (
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) select p_job_id, p_attempt, p_revision, page.group_kind, page.group_identity, 0,
      'topology', 'topology_source_offer',
      ops.problematic_projection_source_offer_key(page.child_kind, page.child_identity),
      pg_catalog.jsonb_build_object('source_kind', page.source_kind, 'source_identity', page.source_identity,
        'child_kind', page.child_kind, 'child_identity', page.child_identity,
        'count', pg_catalog.jsonb_array_length(page.rows), 'complete', page.group_complete,
        'fingerprint', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          ops.problematic_projection_source_digest_value(page.rows)::text, 'UTF8')), 'hex')),
      p_observed_at
    from page_rows page
    where page.group_kind is not null and (select count(*) from offer_owners) >= 0
    on conflict do nothing
    returning 1
  )
  select page.group_kind, page.group_identity, page.source_kind, page.source_identity,
    page.child_kind, page.child_identity, page.rows, page.group_complete, page.page_complete
  from page_rows page
  order by page.group_identity::bigint, page.group_kind collate "C",
    ops.problematic_projection_source_offer_key(page.child_kind, page.child_identity) collate "C";
end;
$$;

create or replace function ops.stage_problematic_projection_source_rows(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_source_kind text, p_source_identity text, p_child_kind text,
  p_child_identity text, p_rows jsonb, p_complete boolean,
  p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if jsonb_typeof(p_rows) <> 'array' or cardinality(array(select jsonb_array_elements(p_rows))) > 100 then
    raise exception 'invalid projection source rows' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    raise exception 'stale projection claim' using errcode = '55000';
  end if;
  insert into ops.problematic_projection_source_staging(
    job_id, attempt, revision, group_kind, group_identity,
    source_kind, source_identity, child_kind, child_identity, payload, created_at
  ) select p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    p_source_kind, p_source_identity, p_child_kind,
    p_child_identity, value, p_observed_at
  from jsonb_array_elements(p_rows) value
  on conflict (job_id, attempt, revision, source_kind, source_identity, child_kind, child_identity)
  do update set payload = excluded.payload, created_at = excluded.created_at;
  insert into ops.problematic_projection_group_accumulators(
    job_id, attempt, revision, group_kind, group_identity,
    source_complete, updated_at
  ) values (
    p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    p_complete, p_observed_at
  ) on conflict (job_id, attempt, revision, group_kind, group_identity)
  do update set
    source_complete = ops.problematic_projection_group_accumulators.source_complete
      or excluded.source_complete,
    updated_at = excluded.updated_at;
  update ops.problematic_projection_state as projection_state set
    group_kind = p_group_kind,
    group_identity = p_group_identity,
    source_kind = p_source_kind,
    source_identity = p_source_identity,
    child_kind = p_child_kind,
    child_identity = p_child_identity,
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
  return query select true;
end;
$$;

create or replace function ops.stage_claimed_problematic_projection_source(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_source_kind text, p_source_identity text, p_child_kind text,
  p_child_identity text, p_rows jsonb, p_complete boolean,
  p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql security definer set search_path = pg_catalog
as $$
begin
  if p_source_kind = 'topology_certificate' or p_group_kind like 'topology_%' or
    not exists (select 1 from ops.jobs job where job.id = p_job_id
      and ops.problematic_projection_builder_version(job.parameters) = 1) then
    raise exception 'versioned projection source staging required' using errcode = '22023';
  end if;
  return query select * from ops.stage_problematic_projection_source_rows(p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id, p_source_generation, p_rebuild_epoch, p_revision, p_group_kind, p_group_identity, p_source_kind, p_source_identity, p_child_kind, p_child_identity, p_rows, p_complete, p_observed_at);
end;
$$;

create or replace function ops.stage_claimed_problematic_projection_source(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_source_kind text, p_source_identity text, p_child_kind text,
  p_child_identity text, p_rows jsonb, p_complete boolean,
  p_observed_at timestamptz, p_builder_version integer
)
returns table(accepted boolean)
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  expected record;
  source_count bigint;
  source_fingerprint bit(256);
  receipt jsonb;
begin
  if p_builder_version is null or p_builder_version not in (1, 3) or not exists (
    select 1 from ops.jobs job where job.id = p_job_id
      and ops.problematic_projection_builder_version(job.parameters) = p_builder_version
  ) then raise exception 'invalid projection source stage contract' using errcode = '22023'; end if;
  if p_builder_version = 1 then
    return query select * from ops.stage_claimed_problematic_projection_source(p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id, p_source_generation, p_rebuild_epoch, p_revision, p_group_kind, p_group_identity, p_source_kind, p_source_identity, p_child_kind, p_child_identity, p_rows, p_complete, p_observed_at);
    return;
  end if;
  if p_builder_version is distinct from 3 or p_source_kind = 'topology_certificate'
    or p_group_kind like 'topology_%' or p_complete is null
    or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'invalid projection source stage contract' using errcode = '22023';
  end if;
  perform ops.require_claimed_problematic_topology(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  );
  receipt := pg_catalog.jsonb_build_object('source_kind', p_source_kind, 'source_identity', p_source_identity,
    'child_kind', p_child_kind, 'child_identity', p_child_identity,
    'count', pg_catalog.jsonb_array_length(p_rows), 'complete', p_complete,
    'fingerprint', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      ops.problematic_projection_source_digest_value(p_rows)::text, 'UTF8')), 'hex'));
  if exists (
    select 1 from ops.problematic_projection_group_facts fact
    where fact.job_id = p_job_id and fact.attempt = p_attempt and fact.revision = p_revision
      and fact.group_kind = p_group_kind and fact.group_identity = p_group_identity
      and fact.projection_id = 'topology' and fact.fact_kind = 'topology_source_page'
      and fact.semantic_child_identity = ops.problematic_projection_source_offer_key(p_child_kind, p_child_identity)
      and fact.fact_value = receipt
  ) then return query select true; return; end if;
  select offer.group_kind, offer.group_identity, offer.fact_value into expected
  from ops.problematic_projection_state state
  join ops.problematic_projection_group_facts offer
    on offer.job_id = p_job_id and offer.attempt = p_attempt and offer.revision = p_revision
    and offer.projection_id = 'topology' and offer.fact_kind = 'topology_source_offer'
  where state.library_id = p_library_id
    and (state.group_kind is null or (offer.group_kind = state.group_kind and offer.group_identity = state.group_identity))
    and not exists (
      select 1 from ops.problematic_projection_group_facts acknowledged
      where acknowledged.job_id = offer.job_id and acknowledged.attempt = offer.attempt
        and acknowledged.revision = offer.revision and acknowledged.group_kind = offer.group_kind
        and acknowledged.group_identity = offer.group_identity and acknowledged.projection_id = 'topology'
        and acknowledged.fact_kind = 'topology_source_page'
        and acknowledged.semantic_child_identity = offer.semantic_child_identity
    )
  order by offer.group_identity::bigint, offer.group_kind collate "C", offer.semantic_child_identity collate "C"
  limit 1 for update of offer;
  if not found or expected.group_kind is distinct from p_group_kind
    or expected.group_identity is distinct from p_group_identity
    or expected.fact_value is distinct from receipt then
    raise exception 'projection source page differs from authoritative cursor' using errcode = '55000';
  end if;
  perform ops.stage_problematic_projection_source_rows(p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id, p_source_generation, p_rebuild_epoch, p_revision, p_group_kind, p_group_identity, p_source_kind, p_source_identity, p_child_kind, p_child_identity, p_rows, p_complete, p_observed_at);
  insert into ops.problematic_projection_group_facts(
    job_id, attempt, revision, group_kind, group_identity, stage_id,
    projection_id, fact_kind, semantic_child_identity, fact_value, created_at
  ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
    'topology', 'topology_source_page', ops.problematic_projection_source_offer_key(p_child_kind, p_child_identity), receipt, p_observed_at);
  if p_complete then
    select count(*), coalesce(bit_xor(('x' || pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(pg_catalog.jsonb_build_array(source.source_kind,
        source.source_identity, source.child_kind, source.child_identity, source.payload)::text,
        'UTF8')), 'hex'))::bit(256)), 0::bit(256))
      into source_count, source_fingerprint
    from ops.problematic_projection_source_staging source
    where source.job_id = p_job_id and source.attempt = p_attempt and source.revision = p_revision
      and source.group_kind = p_group_kind and source.group_identity = p_group_identity
      and source.source_kind <> 'topology_certificate';
    if source_count <> (
      select coalesce(sum((offer.fact_value ->> 'count')::bigint), 0)
      from ops.problematic_projection_group_facts offer
      where offer.job_id = p_job_id and offer.attempt = p_attempt and offer.revision = p_revision
        and offer.group_kind = p_group_kind and offer.group_identity = p_group_identity
        and offer.projection_id = 'topology' and offer.fact_kind = 'topology_source_offer'
    ) then raise exception 'projection source offer count differs' using errcode = '55000'; end if;
    insert into ops.problematic_projection_group_facts(
      job_id, attempt, revision, group_kind, group_identity, stage_id,
      projection_id, fact_kind, semantic_child_identity, fact_value, created_at
    ) values (p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity, 0,
      'topology', 'topology_source_end', 'source',
      pg_catalog.jsonb_build_object('source_kind', p_source_kind, 'source_identity', p_source_identity,
        'child_kind', p_child_kind, 'child_identity', p_child_identity,
        'source_count', source_count, 'source_fingerprint', source_fingerprint::text), p_observed_at)
    on conflict (job_id, attempt, revision, group_kind, group_identity,
      projection_id, fact_kind, semantic_child_identity) do nothing;
  end if;
  return query select true;
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

revoke all on function ops.problematic_projection_topology_proof_matches(bigint,integer,uuid)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.require_claimed_problematic_topology(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.problematic_projection_source_offer_key(text,text)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.problematic_projection_source_digest_value(jsonb)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.register_problematic_topology_node(bigint,integer,bigint,bigint,bigint,uuid,text,text,text,jsonb,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.register_problematic_topology_parent_input(bigint,integer,bigint,bigint,bigint,uuid,text,text,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.register_problematic_topology_own_rank(bigint,integer,bigint,bigint,bigint,uuid,bigint,text,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.problematic_projection_topology_owner_cached(bigint,integer,uuid,text,text)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.load_claimed_problematic_topology_descriptors(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,integer,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
grant execute on function ops.load_claimed_problematic_topology_descriptors(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,integer,timestamptz)
  to album_haven_worker;
revoke all on function ops.register_claimed_problematic_topology_nodes(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
grant execute on function ops.register_claimed_problematic_topology_nodes(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamptz)
  to album_haven_worker;
revoke all on function library.problematic_immediate_folder_parent(text)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.problematic_projection_topology_file_payload(bigint,bigint)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.load_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,integer,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
grant execute on function ops.load_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,integer,timestamptz)
  to album_haven_worker;
revoke all on function ops.stage_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,jsonb,boolean,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
grant execute on function ops.stage_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,jsonb,boolean,timestamptz)
  to album_haven_worker;
revoke all on function ops.complete_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
grant execute on function ops.complete_claimed_problematic_topology_node(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamptz)
  to album_haven_worker;
revoke all on function ops.problematic_projection_topology_complete(bigint,integer,uuid,text,text)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.seal_problematic_projection_topology_owner(bigint,integer,bigint,bigint,bigint,uuid,text,text,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.stage_problematic_projection_source_rows(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamptz)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamptz,integer)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
grant execute on function ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamptz,integer)
  to album_haven_worker;
revoke all on function ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamptz,integer)
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
grant execute on function ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamptz,integer)
  to album_haven_worker;
