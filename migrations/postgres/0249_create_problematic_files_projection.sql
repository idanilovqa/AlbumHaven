-- depends on: 0001_create_current_stack_schemas.sql
-- depends on: 0019_create_local_album_featured_artists.sql
-- depends on: 0021_add_problematic_file_generated_projection.sql
-- depends on: 0023_link_local_track_files_to_library_roots.sql
-- depends on: 0093_add_duplicate_identity_lookup_index.sql
-- depends on: 0220_create_durable_job_foundation.sql
-- depends on: 0229_create_durable_cover_job_state.sql
-- depends on: 0246_preserve_cover_selection_metadata.sql
-- Durable, bounded Problematic Files projection. Additive and mixed-version safe.

create extension if not exists pg_trgm;

-- Migration 0021's generated candidate column cast any digit-only scan tag to
-- numeric. A malformed tag with enough digits overflows before the application
-- can classify it. Replace only that generated expression and preserve its
-- public column/index contract. Text normalization proves positive year and
-- bounded 1..99 track-number ranges without numeric conversion.
drop index if exists library.local_track_files_active_track_id_idx;
drop index if exists library.local_track_files_problem_candidate_v5_idx;

alter table library.local_track_files
  drop column if exists scan_file_metadata_problem_candidate;

alter table library.local_track_files
  add column scan_file_metadata_problem_candidate boolean
    generated always as (
      lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,album}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,album_artist}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,artist}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,title}', '')))
        in ('unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or case
        when metadata #> '{scan_cache,file_entry}' ? 'year' then
          nullif(btrim(coalesce(metadata #>> '{scan_cache,file_entry,year}', '')), '') is null
          or btrim(metadata #>> '{scan_cache,file_entry,year}') !~ '^[+-]?[0-9]+$'
          or btrim(metadata #>> '{scan_cache,file_entry,year}') ~ '^-[0-9]+$'
          or regexp_replace(
               ltrim(btrim(metadata #>> '{scan_cache,file_entry,year}'), '+'),
               '^0+', ''
             ) = ''
        else false
      end
      or case
        when metadata #> '{scan_cache,file_entry}' ? 'track_number' then
          nullif(btrim(coalesce(metadata #>> '{scan_cache,file_entry,track_number}', '')), '') is null
          or btrim(metadata #>> '{scan_cache,file_entry,track_number}') !~ '^\+?[0-9]+$'
          or coalesce(
               nullif(
                 regexp_replace(
                   ltrim(btrim(metadata #>> '{scan_cache,file_entry,track_number}'), '+'),
                   '^0+', ''
                 ),
                 ''
               ),
               '0'
             ) !~ '^[1-9][0-9]?$'
        else false
      end
    ) stored;

create index local_track_files_active_track_id_idx
  on library.local_track_files (track_id)
  include (
    private_path,
    scan_file_entry_is_object,
    scan_file_album,
    scan_file_album_artist,
    scan_file_artist,
    scan_file_title,
    scan_file_year,
    scan_file_track_number,
    scan_file_text_mojibake_candidate,
    scan_file_metadata_problem_candidate
  )
  where scan_cache_stale is false;

create index local_track_files_problem_candidate_v5_idx
  on library.local_track_files (track_id)
  include (
    scan_file_entry_is_object,
    scan_file_album,
    scan_file_album_artist,
    scan_file_year,
    scan_file_text_mojibake_candidate,
    scan_file_metadata_problem_candidate
  )
  where scan_cache_stale is false;

create or replace function library.problematic_release_identity(
  album_artist text, album_title text, edition text
)
returns text
language sql
immutable
parallel safe
as $$
  select pg_catalog.lower(pg_catalog.btrim(coalesce(album_artist, ''))) ||
    '::' || pg_catalog.lower(pg_catalog.btrim(coalesce(album_title, ''))) ||
    case
      when nullif(pg_catalog.btrim(coalesce(edition, '')), '') is null then ''
      else '::' || pg_catalog.lower(pg_catalog.btrim(edition))
    end;
$$;

create or replace function library.problematic_physical_album_container(
  path_value text
)
returns text
language sql
immutable
parallel safe
strict
set search_path = pg_catalog
as $$
with normalized as (
  select pg_catalog.regexp_replace(
    case
      when library.local_path_style(path_value) = 'windows'
        then pg_catalog.replace(library.local_path_key(path_value), pg_catalog.chr(92), '/')
      else library.local_path_key(path_value)
    end,
    '/[^/]*$', ''
  ) as parent_path
)
select case
  when pg_catalog.regexp_replace(parent_path, '^.*/', '') ~*
    '(?<![A-Za-z0-9])(cd|disc|disk)[[:space:]]*[-_.]?[[:space:]]*[0-9]{1,2}(?![A-Za-z0-9])'
    then pg_catalog.regexp_replace(parent_path, '/[^/]*$', '')
  else parent_path
end
from normalized;
$$;

revoke all on function library.problematic_physical_album_container(text)
  from public;
do $privileges$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant execute on function library.problematic_physical_album_container(text)
      to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant execute on function library.problematic_physical_album_container(text)
      to album_haven_migrator;
  end if;
end;
$privileges$;

create index if not exists local_albums_problematic_release_identity_idx
  on library.local_albums (
    library_id,
    library.problematic_release_identity(
      metadata ->> 'album_artist', title, metadata ->> 'edition'
    )
  ) include (album_key)
  where nullif(pg_catalog.btrim(metadata ->> 'album_artist'), '') is not null;

alter table ops.jobs drop constraint if exists jobs_kind_check;
alter table ops.jobs add constraint jobs_kind_check check (kind in (
  'full_scan', 'targeted_reconciliation', 'post_scan_cover_refresh',
  'cover_lookup', 'cover_bulk_refresh', 'cover_remote_save',
  'lastfm_scrobble_retry', 'auth_welcome_delivery',
  'auth_invitation_delivery', 'auth_password_reset_delivery',
  'problematic_files_projection'
));

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
  (kind = 'auth_password_reset_delivery' and max_attempts = 1) or
  (kind = 'problematic_files_projection' and max_attempts = 3)
);

alter table ops.jobs drop constraint if exists jobs_kind_recovery_check;
alter table ops.jobs add constraint jobs_kind_recovery_check check (
  (kind in (
    'full_scan', 'targeted_reconciliation', 'post_scan_cover_refresh',
    'cover_lookup', 'cover_bulk_refresh', 'auth_welcome_delivery',
    'problematic_files_projection'
  ) and recovery_policy = 'retry_safe') or
  (kind in (
    'cover_remote_save', 'lastfm_scrobble_retry',
    'auth_invitation_delivery', 'auth_password_reset_delivery'
  ) and recovery_policy = 'ambiguous_on_stale_lease')
);

create table if not exists ops.problematic_projection_state (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  source_generation bigint not null default 0 check (source_generation >= 0),
  source_xid_fence xid8,
  rebuild_epoch bigint not null default 0 check (rebuild_epoch >= 0),
  live_job_id bigint references ops.jobs(id) on delete set null,
  build_revision uuid,
  requested_job_id bigint references ops.jobs(id) on delete set null,
  requested_attempt integer check (requested_attempt is null or requested_attempt > 0),
  requested_revision uuid,
  recovery_reason_code text check (
    recovery_reason_code is null or
    octet_length(recovery_reason_code) between 1 and 128
  ),
  scan_kind text,
  scan_identity text,
  source_kind text,
  source_identity text,
  child_kind text,
  child_identity text,
  group_kind text,
  group_identity text,
    committed_job_id bigint references ops.jobs(id) on delete set null,
  committed_revision uuid,
  committed_total integer not null default 0 check (committed_total >= 0),
  reason_facets jsonb not null default '{}'::jsonb check (jsonb_typeof(reason_facets) = 'object'),
  verified boolean not null default false,
  audit_revision uuid,
  audit_after_fact_type text,
  audit_after_item_key text,
  audit_after_identity_one text,
  audit_after_identity_two text,
  audit_after_identity_three text,
  audit_item_count integer not null default 0 check (audit_item_count >= 0),
  audit_last_counted_item_key text,
  audit_reason_fact_count bigint not null default 0 check (audit_reason_fact_count >= 0),
  audit_reason_fingerprint bit(256) not null default (0::bit(256)),
  audit_search_fact_count bigint not null default 0 check (audit_search_fact_count >= 0),
  audit_search_fingerprint bit(256) not null default (0::bit(256)),
  audit_claim_token uuid,
  audit_claimed_at timestamptz,
  next_integrity_audit_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.problematic_projection_headers (
  library_id bigint not null references library.libraries(id) on delete cascade,
  revision uuid not null,
  source_generation bigint not null check (source_generation >= 0),
  rebuild_epoch bigint not null check (rebuild_epoch >= 0),
  builder_version integer not null default 1 check (builder_version = 1),
  total integer not null check (total >= 0),
  item_count integer not null check (item_count >= 0 and item_count = total),
  reason_facets jsonb not null check (jsonb_typeof(reason_facets) = 'object'),
  reason_fact_count bigint not null check (reason_fact_count >= 0),
  reason_fingerprint bit(256) not null,
  search_fact_count bigint not null check (search_fact_count >= 0),
  search_fingerprint bit(256) not null,
  verified boolean not null default true,
  published_at timestamptz not null,
  primary key (library_id, revision)
);

alter table ops.problematic_projection_state
  drop constraint if exists problematic_projection_state_committed_header_fk;
alter table ops.problematic_projection_state
  add constraint problematic_projection_state_committed_header_fk
  foreign key (library_id, committed_revision)
  references ops.problematic_projection_headers(library_id, revision)
  deferrable initially deferred;

create table if not exists ops.problematic_projection_items (
  library_id bigint not null,
  revision uuid not null,
  item_key text not null check (item_key <> '' and octet_length(item_key) <= 256),
  sort_title text not null collate "C" check (octet_length(sort_title) <= 512),
  sort_artist text not null collate "C" check (octet_length(sort_artist) <= 512),
  sort_year text not null collate "C" check (octet_length(sort_year) <= 64),
  sort_album_key text not null collate "C" check (octet_length(sort_album_key) <= 512),
  search_text text not null check (octet_length(search_text) <= 32768),
  reasons text[] not null default '{}'::text[] check (cardinality(reasons) <= 64),
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 65536),
  primary key (library_id, revision, item_key),
  foreign key (library_id, revision)
    references ops.problematic_projection_headers(library_id, revision)
    on delete cascade
);

create table if not exists ops.problematic_projection_search_facts (
  library_id bigint not null,
  revision uuid not null,
  item_key text not null,
  fact_kind text not null,
  semantic_child_identity text not null check (
    semantic_child_identity <> '' and octet_length(semantic_child_identity) <= 4096
  ),
  normalized_text text not null check (
    normalized_text <> '' and (
      (fact_kind = 'private_path_locator'
       and octet_length(normalized_text) <= 65536)
      or (fact_kind <> 'private_path_locator'
          and octet_length(normalized_text) <= 32768)
    )
  ),
  primary key (library_id, revision, item_key, fact_kind, semantic_child_identity),
  foreign key (library_id, revision, item_key)
    references ops.problematic_projection_items(library_id, revision, item_key)
    on update cascade on delete cascade
);

create table if not exists ops.problematic_projection_reason_facts (
  library_id bigint not null,
  revision uuid not null,
  item_key text not null,
  normalized_reason text not null check (
    normalized_reason <> '' and octet_length(normalized_reason) <= 4096
  ),
  display_reason text not null check (
    display_reason <> '' and octet_length(display_reason) <= 4096
  ),
  category_reason text not null check (
    category_reason <> '' and octet_length(category_reason) <= 4096
  ),
  primary key (
    library_id, revision, item_key, normalized_reason, display_reason,
    category_reason
  ),
  foreign key (library_id, revision, item_key)
    references ops.problematic_projection_items(library_id, revision, item_key)
    on update cascade on delete cascade
);

create table if not exists ops.problematic_projection_source_staging (
  stage_id bigint generated always as identity primary key,
  job_id bigint not null references ops.jobs(id) on delete cascade,
  attempt integer not null check (attempt > 0),
  revision uuid not null,
  group_kind text not null,
  group_identity text not null,
  source_kind text not null,
  source_identity text not null,
  child_kind text not null,
  child_identity text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  created_at timestamptz not null,
  unique (job_id, attempt, revision, source_kind, source_identity, child_kind, child_identity)
);

create table if not exists ops.problematic_projection_item_staging (
  job_id bigint not null references ops.jobs(id) on delete cascade,
  attempt integer not null check (attempt > 0),
  revision uuid not null,
  group_kind text not null,
  group_identity text not null,
  item_key text not null check (item_key <> '' and octet_length(item_key) <= 256),
  sort_title text not null collate "C" check (octet_length(sort_title) <= 512),
  sort_artist text not null collate "C" check (octet_length(sort_artist) <= 512),
  sort_year text not null collate "C" check (octet_length(sort_year) <= 64),
  sort_album_key text not null collate "C" check (octet_length(sort_album_key) <= 512),
  search_text text not null,
  reasons text[] not null,
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 65536),
  batch_index integer not null check (batch_index >= 0),
  created_at timestamptz not null,
  primary key (job_id, attempt, revision, item_key)
);

create table if not exists ops.problematic_projection_reason_fact_staging (
  job_id bigint not null,
  attempt integer not null check (attempt > 0),
  revision uuid not null,
  item_key text not null,
  normalized_reason text not null check (
    normalized_reason <> '' and octet_length(normalized_reason) <= 4096
  ),
  display_reason text not null check (
    display_reason <> '' and octet_length(display_reason) <= 4096
  ),
  category_reason text not null check (
    category_reason <> '' and octet_length(category_reason) <= 4096
  ),
  primary key (
    job_id, attempt, revision, item_key, normalized_reason, display_reason,
    category_reason
  ),
  foreign key (job_id, attempt, revision, item_key)
    references ops.problematic_projection_item_staging(
      job_id, attempt, revision, item_key
    ) on update cascade on delete cascade
);

-- Projection progress is scalar. Source rows and derived facts stay in their
-- own bounded relational rows so a retry never serializes a growing array.
create table if not exists ops.problematic_projection_group_accumulators (
  job_id bigint not null references ops.jobs(id) on delete cascade,
  attempt integer not null check (attempt > 0),
  revision uuid not null,
  group_kind text not null,
  group_identity text not null,
  after_stage_id bigint not null default 0 check (after_stage_id >= 0),
  next_batch_index integer not null default 0 check (next_batch_index >= 0),
  row_count bigint not null default 0 check (row_count >= 0),
  source_complete boolean not null default false,
  updated_at timestamptz not null,
  primary key (job_id, attempt, revision, group_kind, group_identity)
);

create table if not exists ops.problematic_projection_group_facts (
  job_id bigint not null,
  attempt integer not null,
  revision uuid not null,
  group_kind text not null,
  group_identity text not null,
  stage_id bigint not null,
  projection_id text not null check (
    projection_id <> '' and octet_length(projection_id) <= 4096
  ),
  fact_kind text not null,
  semantic_child_identity text not null check (
    semantic_child_identity <> '' and octet_length(semantic_child_identity) <= 4096
  ),
    fact_value jsonb not null check (
        jsonb_typeof(fact_value) = 'object'
        and octet_length(fact_value::text) <= 65536
    ),
  created_at timestamptz not null,
  unique (
    job_id, attempt, revision, group_kind, group_identity,
    projection_id, fact_kind, semantic_child_identity
  ),
  foreign key (job_id, attempt, revision, group_kind, group_identity)
    references ops.problematic_projection_group_accumulators(
      job_id, attempt, revision, group_kind, group_identity
    ) on update cascade on delete cascade
);

create table if not exists ops.problematic_projection_search_fact_staging (
  job_id bigint not null,
  attempt integer not null,
  revision uuid not null,
  item_key text not null,
  fact_kind text not null,
  semantic_child_identity text not null check (
    semantic_child_identity <> '' and octet_length(semantic_child_identity) <= 4096
  ),
  normalized_text text not null check (
    normalized_text <> '' and (
      (fact_kind = 'private_path_locator'
       and octet_length(normalized_text) <= 65536)
      or (fact_kind <> 'private_path_locator'
          and octet_length(normalized_text) <= 32768)
    )
  ),
  primary key (
    job_id, attempt, revision, item_key, fact_kind, semantic_child_identity
  ),
  foreign key (job_id, attempt, revision, item_key)
    references ops.problematic_projection_item_staging(
      job_id, attempt, revision, item_key
    ) on update cascade on delete cascade
);

create index if not exists problematic_projection_items_album_sort_idx
  on ops.problematic_projection_items
  (library_id, revision, sort_title, sort_artist, sort_year, sort_album_key, item_key);
create index if not exists problematic_projection_items_reasons_idx
  on ops.problematic_projection_items using gin (reasons);
create index if not exists problematic_projection_items_search_idx
  on ops.problematic_projection_items using gin (search_text library.gin_trgm_ops);
create index if not exists problematic_projection_search_facts_text_idx
  on ops.problematic_projection_search_facts using gin
  (normalized_text library.gin_trgm_ops)
  where fact_kind <> 'private_path_locator';
create index if not exists problematic_projection_reason_facts_filter_idx
  on ops.problematic_projection_reason_facts
  (library_id, revision, normalized_reason, item_key);
create index if not exists problematic_projection_reason_facts_integrity_idx
  on ops.problematic_projection_reason_facts
  (library_id, revision, item_key collate "C", normalized_reason collate "C",
   display_reason collate "C", category_reason collate "C");
create index if not exists problematic_projection_search_facts_integrity_idx
  on ops.problematic_projection_search_facts
  (library_id, revision, item_key collate "C", fact_kind collate "C",
   semantic_child_identity collate "C");
create index if not exists problematic_projection_source_group_idx
  on ops.problematic_projection_source_staging
  (job_id, attempt, revision, group_kind, group_identity, stage_id);
create index if not exists problematic_projection_group_fact_kind_idx
  on ops.problematic_projection_group_facts
  (job_id, attempt, revision, group_kind, group_identity,
   fact_kind, semantic_child_identity);
create index if not exists problematic_projection_group_fact_cursor_idx
  on ops.problematic_projection_group_facts
  (job_id, attempt, revision, group_kind, group_identity,
   projection_id collate "C", fact_kind collate "C", semantic_child_identity collate "C");
create index if not exists local_tracks_problematic_album_page_idx
  on library.local_tracks (album_id, id);
create index if not exists local_track_files_problematic_track_page_idx
  on library.local_track_files (track_id, id);
create index if not exists local_track_files_problematic_companion_idx
  on library.local_track_files (
    library_root_id,
    library.duplicate_identity_text(scan_file_album_artist),
    library.duplicate_identity_text(scan_file_album),
    library.duplicate_identity_year(scan_file_year),
    library.problematic_physical_album_container(private_path),
    id
  ) include (track_id, private_path)
  where scan_cache_stale is false;
create index if not exists local_track_files_problematic_container_members_idx
  on library.local_track_files (
    pg_catalog.md5(library.problematic_physical_album_container(private_path))
  ) include (track_id, library_root_id)
  where scan_cache_stale is false;
create index if not exists problematic_projection_due_audit_idx
  on ops.problematic_projection_state (next_integrity_audit_at, library_id)
  where committed_revision is not null;

create or replace view ops.problematic_projection_source_rows as
select track.library_id,
  case
    when track.album_id is null then 'loose_source'::text
    when exists (
      select 1
      from library.local_tracks active_track
      join library.local_track_files active_file
        on active_file.track_id = active_track.id
      where active_track.album_id = track.album_id
        and active_file.scan_cache_stale is false
    ) then 'album'::text
    else 'missing_album'::text
  end as group_kind,
  case when track.album_id is null then file.id::text else track.album_id::text end
    as group_identity,
  case
    when track.album_id is null then 'loose_source'::text
    when exists (
      select 1
      from library.local_tracks active_track
      join library.local_track_files active_file
        on active_file.track_id = active_track.id
      where active_track.album_id = track.album_id
        and active_file.scan_cache_stale is false
    ) then 'album'::text
    else 'missing_album'::text
  end as source_kind,
  case when track.album_id is null then file.id::text else track.album_id::text end
    as source_identity,
  'file'::text as child_kind,
  file.id::text as child_identity
from library.local_tracks track
join library.local_track_files file on file.track_id = track.id
where (
    track.album_id is not null
    and (
      file.scan_cache_stale is false
      or not exists (
        select 1
        from library.local_tracks active_track
        join library.local_track_files active_file
          on active_file.track_id = active_track.id
        where active_track.album_id = track.album_id
          and active_file.scan_cache_stale is false
      )
    )
  ) or (
    track.album_id is null
    and file.scan_cache_stale is false
    and nullif(
      file.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
      ''
    ) is not null
  );

create or replace function ops.resolve_problematic_projection_library()
returns table(library_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  resolved_count integer;
begin
  select count(*), min(local_library.id)
    into resolved_count, library_id
  from library.libraries local_library
  join app.bootstrap_owners owner
    on owner.account_id = local_library.owner_account_id
  where owner.owner_key = 'local-bootstrap-owner'
    and local_library.library_kind = 'local';
  if resolved_count <> 1 then
    raise exception 'canonical local library unavailable' using errcode = '55000';
  end if;
  return next;
end;
$$;

create or replace function ops.enqueue_problematic_projection_rebuild(
  p_library_id bigint, p_requested_by text
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
  if p_library_id is null or p_library_id < 1 or
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
       and (existing_job.parameters ->> 'source_generation')::bigint = state_row.source_generation then
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
    ), p_library_id, 'self_hosted', 'private_web',
    'problematic-files-projection:' || p_library_id::text || ':' ||
      state_row.source_generation::text || ':' || state_row.rebuild_epoch::text,
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

create or replace function ops.invalidate_problematic_projection_library(
  p_library_id bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  current_fence xid8 := pg_catalog.pg_current_xact_id();
begin
  if p_library_id is null then return; end if;
  insert into ops.problematic_projection_state(
    library_id, source_generation, source_xid_fence, updated_at
  ) values (
    p_library_id, 1, current_fence, pg_catalog.clock_timestamp()
  ) on conflict (library_id) do update set
    source_generation = case
      when ops.problematic_projection_state.source_xid_fence is distinct from current_fence
      then ops.problematic_projection_state.source_generation + 1
      else ops.problematic_projection_state.source_generation
    end,
    source_xid_fence = current_fence,
    verified = false,
    updated_at = pg_catalog.clock_timestamp()
  where ops.problematic_projection_state.source_xid_fence is distinct from current_fence
     or ops.problematic_projection_state.verified;
end;
$$;

create or replace function ops.invalidate_problematic_projection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  canonical_library_id bigint;
  has_changed_rows boolean;
begin
  select resolved.library_id into canonical_library_id
  from ops.resolve_problematic_projection_library() resolved;
  if tg_nargs > 0 and tg_argv[0] = 'require_rows' then
    execute 'select exists (select 1 from changed_rows)' into has_changed_rows;
    if not has_changed_rows then return null; end if;
  end if;
  perform ops.invalidate_problematic_projection_library(canonical_library_id);
  return null;
exception
  when sqlstate '55000' then
    if tg_op = 'INSERT'
      and (tg_table_schema, tg_table_name) in (
        ('app', 'bootstrap_owners'), ('library', 'libraries')
      ) and not exists (
      select 1
      from library.libraries local_library
      join app.bootstrap_owners owner
        on owner.account_id = local_library.owner_account_id
      where owner.owner_key = 'local-bootstrap-owner'
        and local_library.library_kind = 'local'
    ) then return null; end if;
    raise;
end;
$$;

create or replace function ops.invalidate_problematic_projection_metadata_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  canonical_library_id bigint;
  consumed_changed boolean := false;
begin
  select resolved.library_id into canonical_library_id
  from ops.resolve_problematic_projection_library() resolved;
  if tg_argv[0] = 'album' then
    execute $query$
      select exists (
        select 1
        from old_rows as old_row
        join new_rows as new_row using (id)
        where (
          old_row.library_id is not distinct from $1
          or new_row.library_id is not distinct from $1
        ) and row(
          old_row.metadata ->> 'album_artist', old_row.metadata -> 'artists',
          old_row.metadata -> 'is_compilation',
          old_row.metadata ->> 'cover_revision',
          old_row.metadata ->> 'cover_selection_origin',
          old_row.metadata -> 'local_cover_width',
          old_row.metadata -> 'local_cover_height',
          old_row.metadata ->> 'remote_cover_url',
          old_row.metadata ->> 'remote_cover_thumbnail_url',
          old_row.metadata ->> 'remote_cover_source',
          old_row.metadata ->> 'remote_cover_source_label',
          old_row.metadata ->> 'remote_cover_album_url',
          old_row.metadata -> 'remote_cover_width',
          old_row.metadata -> 'remote_cover_height',
          old_row.metadata ->> 'release_date', old_row.metadata ->> 'edition',
          old_row.metadata -> 'album_rating', old_row.metadata -> 'root_provenance'
        ) is distinct from row(
          new_row.metadata ->> 'album_artist', new_row.metadata -> 'artists',
          new_row.metadata -> 'is_compilation',
          new_row.metadata ->> 'cover_revision',
          new_row.metadata ->> 'cover_selection_origin',
          new_row.metadata -> 'local_cover_width',
          new_row.metadata -> 'local_cover_height',
          new_row.metadata ->> 'remote_cover_url',
          new_row.metadata ->> 'remote_cover_thumbnail_url',
          new_row.metadata ->> 'remote_cover_source',
          new_row.metadata ->> 'remote_cover_source_label',
          new_row.metadata ->> 'remote_cover_album_url',
          new_row.metadata -> 'remote_cover_width',
          new_row.metadata -> 'remote_cover_height',
          new_row.metadata ->> 'release_date', new_row.metadata ->> 'edition',
          new_row.metadata -> 'album_rating', new_row.metadata -> 'root_provenance'
        )
      )
    $query$ into consumed_changed using canonical_library_id;
  elsif tg_argv[0] = 'file' then
    execute $query$
      select exists (
        select 1
        from old_rows as old_row
        join new_rows as new_row using (id)
        left join library.local_tracks old_track on old_track.id = old_row.track_id
        left join library.local_tracks new_track on new_track.id = new_row.track_id
        where (
          old_track.library_id is not distinct from $1
          or new_track.library_id is not distinct from $1
        ) and row(
          old_row.scan_cache_stale,
          pg_catalog.jsonb_typeof(old_row.metadata #> '{scan_cache,file_entry}') = 'object',
          old_row.metadata #>> '{scan_cache,file_entry,album}',
          old_row.metadata #>> '{scan_cache,file_entry,album_artist}',
          old_row.metadata #>> '{scan_cache,file_entry,artist}',
          old_row.metadata #>> '{scan_cache,file_entry,title}',
          old_row.metadata #> '{scan_cache,file_entry,year}',
          old_row.metadata #>> '{scan_cache,file_entry,genre}',
          old_row.metadata #> '{scan_cache,file_entry,track_number}',
          old_row.metadata #> '{scan_cache,file_entry,disc_number}',
          old_row.metadata #> '{scan_cache,file_entry,disc_number_raw}',
          old_row.metadata #> '{scan_cache,file_entry,duration_seconds}',
          old_row.metadata #>> '{scan_cache,file_entry,cover_path}',
          old_row.metadata #>> '{scan_cache,file_entry,cover_revision}',
          old_row.metadata #>> '{scan_cache,file_entry,edition}',
          old_row.metadata #> '{scan_cache,file_entry,album_rating}',
          old_row.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
          old_row.metadata #>> '{scan_cache,file_entry,exception_type}',
          old_row.metadata #>> '{scan_cache,stale_marked_at}'
        ) is distinct from row(
          new_row.scan_cache_stale,
          pg_catalog.jsonb_typeof(new_row.metadata #> '{scan_cache,file_entry}') = 'object',
          new_row.metadata #>> '{scan_cache,file_entry,album}',
          new_row.metadata #>> '{scan_cache,file_entry,album_artist}',
          new_row.metadata #>> '{scan_cache,file_entry,artist}',
          new_row.metadata #>> '{scan_cache,file_entry,title}',
          new_row.metadata #> '{scan_cache,file_entry,year}',
          new_row.metadata #>> '{scan_cache,file_entry,genre}',
          new_row.metadata #> '{scan_cache,file_entry,track_number}',
          new_row.metadata #> '{scan_cache,file_entry,disc_number}',
          new_row.metadata #> '{scan_cache,file_entry,disc_number_raw}',
          new_row.metadata #> '{scan_cache,file_entry,duration_seconds}',
          new_row.metadata #>> '{scan_cache,file_entry,cover_path}',
          new_row.metadata #>> '{scan_cache,file_entry,cover_revision}',
          new_row.metadata #>> '{scan_cache,file_entry,edition}',
          new_row.metadata #> '{scan_cache,file_entry,album_rating}',
          new_row.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}',
          new_row.metadata #>> '{scan_cache,file_entry,exception_type}',
          new_row.metadata #>> '{scan_cache,stale_marked_at}'
        )
      )
    $query$ into consumed_changed using canonical_library_id;
  elsif tg_argv[0] = 'exception_override' then
    execute $query$
      select exists (
        select 1
        from old_rows as old_row
        join new_rows as new_row using (id)
        where (
          old_row.library_id is not distinct from $1
          or new_row.library_id is not distinct from $1
        ) and old_row.override_payload ->> 'exception_type'
          is distinct from new_row.override_payload ->> 'exception_type'
      )
    $query$ into consumed_changed using canonical_library_id;
  else
    raise exception 'invalid projection metadata invalidation mode'
      using errcode = '22023';
  end if;
  if consumed_changed then
    perform ops.invalidate_problematic_projection_library(canonical_library_id);
  end if;
  return null;
end;
$$;

create or replace function ops.invalidate_problematic_projection_ownership_move()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  canonical_library_id bigint;
begin
  select resolved.library_id into canonical_library_id
  from ops.resolve_problematic_projection_library() resolved;
  if exists (
    select 1
    from old_rows as old_row
    join new_rows as new_row using (id)
    where old_row.library_id is distinct from new_row.library_id
      and (
        old_row.library_id is not distinct from canonical_library_id
        or new_row.library_id is not distinct from canonical_library_id
      )
  ) then
    perform ops.invalidate_problematic_projection_library(canonical_library_id);
  end if;
  return null;
end;
$$;

drop trigger if exists invalidate_problematic_projection on app.bootstrap_owners;
create trigger invalidate_problematic_projection
after insert or delete on app.bootstrap_owners
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on app.bootstrap_owners;
drop trigger if exists invalidate_problematic_projection_metadata_update on app.bootstrap_owners;
create trigger invalidate_problematic_projection_metadata_update
after update of account_id, owner_key on app.bootstrap_owners
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection on library.libraries;
create trigger invalidate_problematic_projection
after insert or delete on library.libraries
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.libraries;
drop trigger if exists invalidate_problematic_projection_metadata_update on library.libraries;
create trigger invalidate_problematic_projection_metadata_update
after update of owner_account_id, library_kind, name on library.libraries
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection on library.library_roots;
create trigger invalidate_problematic_projection
after insert or delete on library.library_roots
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.library_roots;
create trigger invalidate_problematic_projection_update
after update of root_kind, is_active on library.library_roots
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection on library.local_albums;
create trigger invalidate_problematic_projection
after insert or delete on library.local_albums
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.local_albums;
create trigger invalidate_problematic_projection_update
after update of artist_id, album_key, title, release_year, cover_path
on library.local_albums
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_metadata_update
on library.local_albums;
create trigger invalidate_problematic_projection_metadata_update
after update on library.local_albums
referencing old table as old_rows new table as new_rows
for each statement execute function
ops.invalidate_problematic_projection_metadata_update('album');
drop trigger if exists invalidate_problematic_projection on library.local_artists;
create trigger invalidate_problematic_projection
after insert or delete on library.local_artists
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.local_artists;
create trigger invalidate_problematic_projection_update
after update of name on library.local_artists
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection on library.local_tracks;
create trigger invalidate_problematic_projection
after insert or delete on library.local_tracks
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.local_tracks;
create trigger invalidate_problematic_projection_update
after update of album_id, track_key, title, disc_number, track_number, duration_seconds
on library.local_tracks
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection on library.local_track_files;
create trigger invalidate_problematic_projection
after insert or delete on library.local_track_files
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.local_track_files;
create trigger invalidate_problematic_projection_update
after update of track_id, private_path, file_size_bytes, library_root_id
on library.local_track_files
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_metadata_update
on library.local_track_files;
create trigger invalidate_problematic_projection_metadata_update
after update on library.local_track_files
referencing old table as old_rows new table as new_rows
for each statement execute function
ops.invalidate_problematic_projection_metadata_update('file');
drop trigger if exists invalidate_problematic_projection on library.local_album_featured_artists;
drop trigger if exists invalidate_problematic_projection_insert on library.local_album_featured_artists;
create trigger invalidate_problematic_projection_insert
after insert on library.local_album_featured_artists
referencing new table as changed_rows
for each statement execute function ops.invalidate_problematic_projection('require_rows');
drop trigger if exists invalidate_problematic_projection_delete on library.local_album_featured_artists;
create trigger invalidate_problematic_projection_delete
after delete on library.local_album_featured_artists
referencing old table as changed_rows
for each statement execute function ops.invalidate_problematic_projection('require_rows');
drop trigger if exists invalidate_problematic_projection_update on library.local_album_featured_artists;
create trigger invalidate_problematic_projection_update
after update of album_id, artist_id on library.local_album_featured_artists
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection on library.separate_releases;
create trigger invalidate_problematic_projection
after insert or delete on library.separate_releases
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.separate_releases;
create trigger invalidate_problematic_projection_update
after update of release_key on library.separate_releases
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection on library.exception_overrides;
create trigger invalidate_problematic_projection
after insert or delete on library.exception_overrides
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.exception_overrides;
create trigger invalidate_problematic_projection_update
after update of track_id, track_key on library.exception_overrides
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_metadata_update
on library.exception_overrides;
create trigger invalidate_problematic_projection_metadata_update
after update on library.exception_overrides
referencing old table as old_rows new table as new_rows
for each statement execute function
ops.invalidate_problematic_projection_metadata_update('exception_override');
drop trigger if exists invalidate_problematic_projection on library.ignored_repairs;
create trigger invalidate_problematic_projection
after insert or delete on library.ignored_repairs
for each statement execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_update on library.ignored_repairs;
create trigger invalidate_problematic_projection_update
after update of repair_key on library.ignored_repairs
for each statement execute function ops.invalidate_problematic_projection();

drop trigger if exists invalidate_problematic_projection_ownership_update
on library.library_roots;
create trigger invalidate_problematic_projection_ownership_update
after update on library.library_roots
referencing old table as old_rows new table as new_rows
for each statement
execute function ops.invalidate_problematic_projection_ownership_move();
drop trigger if exists invalidate_problematic_projection_ownership_update
on library.local_albums;
create trigger invalidate_problematic_projection_ownership_update
after update on library.local_albums
referencing old table as old_rows new table as new_rows
for each statement
execute function ops.invalidate_problematic_projection_ownership_move();
drop trigger if exists invalidate_problematic_projection_ownership_update
on library.local_artists;
create trigger invalidate_problematic_projection_ownership_update
after update on library.local_artists
referencing old table as old_rows new table as new_rows
for each statement
execute function ops.invalidate_problematic_projection_ownership_move();
drop trigger if exists invalidate_problematic_projection_ownership_update
on library.local_tracks;
create trigger invalidate_problematic_projection_ownership_update
after update on library.local_tracks
referencing old table as old_rows new table as new_rows
for each statement
execute function ops.invalidate_problematic_projection_ownership_move();
drop trigger if exists invalidate_problematic_projection_ownership_update
on library.separate_releases;
create trigger invalidate_problematic_projection_ownership_update
after update on library.separate_releases
referencing old table as old_rows new table as new_rows
for each statement
execute function ops.invalidate_problematic_projection_ownership_move();
drop trigger if exists invalidate_problematic_projection_ownership_update
on library.exception_overrides;
create trigger invalidate_problematic_projection_ownership_update
after update on library.exception_overrides
referencing old table as old_rows new table as new_rows
for each statement
execute function ops.invalidate_problematic_projection_ownership_move();
drop trigger if exists invalidate_problematic_projection_ownership_update
on library.ignored_repairs;
create trigger invalidate_problematic_projection_ownership_update
after update on library.ignored_repairs
referencing old table as old_rows new table as new_rows
for each statement
execute function ops.invalidate_problematic_projection_ownership_move();

create index if not exists cover_lookup_tasks_problematic_quota_idx
  on ops.cover_lookup_tasks (library_id, local_album_id, task_key)
  where status = 'failed'
    and metadata ->> 'source_family' = 'automatic_cover_provider_outcomes_v1'
    and metadata ->> 'provider' = 'search_spotify'
    and metadata ->> 'category' = 'rate_limit_quota';

drop trigger if exists invalidate_problematic_projection_quota on ops.cover_lookup_tasks;
create trigger invalidate_problematic_projection_quota
after insert
on ops.cover_lookup_tasks
for each row
when (
  new.status = 'failed'
    and new.metadata ->> 'source_family' = 'automatic_cover_provider_outcomes_v1'
    and new.metadata ->> 'provider' = 'search_spotify'
    and new.metadata ->> 'category' = 'rate_limit_quota'
)
execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_quota_delete on ops.cover_lookup_tasks;
create trigger invalidate_problematic_projection_quota_delete
after delete on ops.cover_lookup_tasks
for each row
when (
  old.status = 'failed'
    and old.metadata ->> 'source_family' = 'automatic_cover_provider_outcomes_v1'
    and old.metadata ->> 'provider' = 'search_spotify'
    and old.metadata ->> 'category' = 'rate_limit_quota'
)
execute function ops.invalidate_problematic_projection();
drop trigger if exists invalidate_problematic_projection_quota_update on ops.cover_lookup_tasks;
create trigger invalidate_problematic_projection_quota_update
after update of library_id, local_album_id, task_key, status, metadata
on ops.cover_lookup_tasks
for each row
when (
  ((old.status = 'failed'
    and old.metadata ->> 'source_family' = 'automatic_cover_provider_outcomes_v1'
    and old.metadata ->> 'provider' = 'search_spotify'
    and old.metadata ->> 'category' = 'rate_limit_quota')
  or
  (new.status = 'failed'
    and new.metadata ->> 'source_family' = 'automatic_cover_provider_outcomes_v1'
    and new.metadata ->> 'provider' = 'search_spotify'
    and new.metadata ->> 'category' = 'rate_limit_quota') )
  and row(
    old.library_id,
    old.local_album_id,
    old.task_key,
    old.status,
    old.metadata ->> 'source_family',
    old.metadata ->> 'provider',
    old.metadata ->> 'category'
  ) is distinct from row(
    new.library_id,
    new.local_album_id,
    new.task_key,
    new.status,
    new.metadata ->> 'source_family',
    new.metadata ->> 'provider',
    new.metadata ->> 'category'
  )
)
execute function ops.invalidate_problematic_projection();

revoke all on function ops.validate_durable_worker_startup(text[]) from public;

do $$
begin
  if pg_catalog.to_regprocedure(
    'ops.validate_durable_worker_startup_baseline_0125(text[])'
  ) is null then
    alter function ops.validate_durable_worker_startup(text[])
      rename to validate_durable_worker_startup_baseline_0125;
  end if;
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

revoke all on function ops.validate_durable_worker_startup_baseline_0125(text[]) from public;
revoke all on function ops.validate_durable_worker_startup_baseline_0125(text[]) from album_haven_app;
revoke all on function ops.validate_durable_worker_startup_baseline_0125(text[]) from album_haven_readonly;
revoke all on function ops.validate_durable_worker_startup_baseline_0125(text[]) from album_haven_worker;
revoke all on function ops.validate_durable_worker_startup(text[]) from public;
revoke all on function ops.validate_durable_worker_startup(text[]) from album_haven_app;
revoke all on function ops.validate_durable_worker_startup(text[]) from album_haven_readonly;
grant execute on function ops.validate_durable_worker_startup(text[]) to album_haven_worker;

create or replace function ops.problematic_projection_worker_ready(
  p_expected_fingerprint text
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from ops.worker_instances
    where compatible_schema_version = 1
      and registered_handler_fingerprint = p_expected_fingerprint
      and lifecycle_state = 'running'
      and drain_state = 'none'
      and last_heartbeat_at >= pg_catalog.clock_timestamp() - interval '90 seconds'
  );
$$;

create or replace function ops.problematic_projection_claim_valid(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_observed_at timestamptz
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1 from ops.jobs job
    where job.id = p_job_id
      and job.kind = 'problematic_files_projection'
      and job.state = 'running'
      and job.attempt_count = p_attempt
      and job.lease_owner = p_worker_id
      and job.lease_token = p_lease_token
      and job.lease_expires_at >= pg_catalog.clock_timestamp()
  );
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
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_job ops.jobs%rowtype;
  selected_state ops.problematic_projection_state%rowtype;
begin
  select * into selected_job from ops.jobs where id = p_job_id;
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

create or replace function ops.validate_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_observed_at timestamptz
)
returns table(valid boolean)
language sql
security definer
set search_path = pg_catalog
as $$
  select ops.problematic_projection_claim_valid(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_observed_at
  ) and exists (
    select 1 from ops.problematic_projection_state state
    where state.library_id = p_library_id
      and state.live_job_id = p_job_id
      and state.source_generation = p_source_generation
      and state.rebuild_epoch = p_rebuild_epoch
      and state.build_revision = p_revision
      and state.requested_job_id = p_job_id
      and state.requested_attempt = p_attempt
      and state.requested_revision = p_revision
  );
$$;

create or replace function ops.load_claimed_problematic_projection_source(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_limit integer, p_child_limit integer,
  p_observed_at timestamptz
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
  if p_limit < 1 or p_limit > 100 or p_child_limit < 1 or p_child_limit > 100 then
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
      and ('album'::text, album.id) > (
        coalesce(state.group_kind, state.source_kind, ''),
        coalesce(state.group_identity, state.source_identity, '0')::bigint
      )
      and exists (
        select 1
        from library.local_tracks active_track
        join library.local_track_files active_file
          on active_file.track_id = active_track.id
        where active_track.album_id = album.id
          and active_file.scan_cache_stale is false
      )
    order by album.id
    limit 2
  ), loose_groups as materialized (
    select 'loose_source'::text as group_kind, file.id as group_identity
    from library.local_tracks track
    join library.local_track_files file on file.track_id = track.id
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
      and ('missing_album'::text, album.id) > (
        coalesce(state.group_kind, state.source_kind, ''),
        coalesce(state.group_identity, state.source_identity, '0')::bigint
      )
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
    order by candidate.group_kind, candidate.group_identity
    limit 2
  ), active_group as materialized (
    select state.group_kind, state.group_identity::bigint as group_identity
    from state
    where state.group_kind is not null
    union all
    select bounded.group_kind, bounded.group_identity
    from bounded_groups bounded
    cross join state
    where state.group_kind is null
    order by group_kind, group_identity
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
    where album.library_id = p_library_id
      and (
        (status.has_active_file and file.scan_cache_stale is false)
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
    order by child_identity
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
    order by child_identity
    limit least(p_limit, p_child_limit, 100)
  ), duplicate_lookups as materialized (
    select distinct on (fact.semantic_child_identity)
      fact.semantic_child_identity, fact.fact_value
    from ops.problematic_projection_group_facts fact
    join active_group
      on active_group.group_kind = fact.group_kind
      and active_group.group_identity::text = fact.group_identity
      and active_group.group_kind = 'album'
    cross join state
    where not exists (select 1 from ordinary_keys)
      and not exists (select 1 from featured_artist_candidates)
      and not exists (select 1 from ignored_repair_candidates)
      and fact.job_id = p_job_id
      and fact.attempt = p_attempt
      and fact.revision = p_revision
      and fact.fact_kind = 'duplicate_lookup'
      and (
        state.child_kind not in ('duplicate_lookup', 'duplicate_companion') or
        (state.child_kind = 'duplicate_lookup' and
          fact.semantic_child_identity > state.child_identity) or
        (state.child_kind = 'duplicate_companion' and
          fact.semantic_child_identity >= split_part(state.child_identity, ':', 1))
      )
    order by fact.semantic_child_identity, fact.projection_id
    limit least(p_limit, p_child_limit, 100)
  ), lookup_keys as materialized (
    select lookup.*
    from duplicate_lookups lookup
    order by lookup.semantic_child_identity
    limit least(p_limit, p_child_limit, 100)
  ), companion_candidates as materialized (
    select active_group.group_kind,
      active_group.group_identity,
      active_group.group_kind as source_kind,
      active_group.group_identity as source_identity,
      'duplicate_companion'::text as child_kind,
      lookup.semantic_child_identity || ':' ||
        lpad(candidate_file.id::text, 20, '0') as child_identity,
      active_group.group_identity as album_id,
      (lookup.fact_value ->> 'owner_track_id')::bigint as track_id,
      (lookup.fact_value ->> 'owner_file_id')::bigint as owner_file_id,
      candidate_file.id as companion_file_id
    from lookup_keys lookup
    cross join active_group
    cross join state
      join library.library_roots candidate_root
        on candidate_root.library_id = p_library_id
       and candidate_root.is_active is true
    join library.local_track_files candidate_file
      on candidate_file.library_root_id = candidate_root.id
      and candidate_file.scan_cache_stale is false
      and library.duplicate_identity_text(candidate_file.scan_file_album_artist)
        = lookup.fact_value ->> 'album_artist_identity'
      and library.duplicate_identity_text(candidate_file.scan_file_album)
        = lookup.fact_value ->> 'album_identity'
      and library.duplicate_identity_year(candidate_file.scan_file_year)
        = (lookup.fact_value ->> 'year_identity')::integer
       and library.problematic_physical_album_container(candidate_file.private_path)
           <> lookup.fact_value ->> 'physical_album_container'
    join library.local_tracks candidate_track
      on candidate_track.id = candidate_file.track_id
      and candidate_track.library_id = p_library_id
    join library.local_albums companion_album
      on companion_album.id = candidate_track.album_id
      and companion_album.id <> active_group.group_identity
      where not exists (
        select 1
        from library.local_track_files container_member
        join library.local_tracks container_track
          on container_track.id = container_member.track_id
         and container_track.library_id = p_library_id
        join library.library_roots container_root
          on container_root.id = container_member.library_root_id
         and container_root.library_id = p_library_id
         and container_root.is_active is true
        where container_member.scan_cache_stale is false
          and pg_catalog.md5(library.problematic_physical_album_container(
                container_member.private_path
              )) in (
                pg_catalog.md5(lookup.fact_value ->> 'physical_album_container'),
                pg_catalog.md5(library.problematic_physical_album_container(
                  candidate_file.private_path
                ))
              )
          and library.problematic_physical_album_container(
                container_member.private_path
              ) in (
                lookup.fact_value ->> 'physical_album_container',
                library.problematic_physical_album_container(candidate_file.private_path)
              )
          and (
            library.duplicate_identity_text(
              container_member.scan_file_album_artist
            ) is distinct from lookup.fact_value ->> 'album_artist_identity'
            or library.duplicate_identity_text(container_member.scan_file_album)
               is distinct from lookup.fact_value ->> 'album_identity'
            or library.duplicate_identity_year(container_member.scan_file_year)
               is distinct from
                  (lookup.fact_value ->> 'year_identity')::integer
          )
      )
        and (
          state.child_kind is distinct from 'duplicate_companion' or
      (
        lookup.semantic_child_identity,
        candidate_file.id
      ) > (
        split_part(state.child_identity, ':', 1),
        (case when state.child_kind = 'duplicate_companion'
          then split_part(state.child_identity, ':', 2) else '0' end)::bigint
      )
        )
      order by lookup.semantic_child_identity, candidate_file.id
    limit least(p_limit, p_child_limit, 100)
  ), source_keys as materialized (
    select ordinary.*
    from ordinary_keys ordinary
    union all
    select companion.group_kind, companion.group_identity,
      companion.source_kind, companion.source_identity,
      companion.child_kind, companion.child_identity,
      companion.album_id, companion.track_id,
      companion.owner_file_id, companion.companion_file_id
    from companion_candidates companion
    where not exists (select 1 from ordinary_keys)
    order by child_kind, child_identity
    limit least(p_limit, p_child_limit, 100)
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
          library.duplicate_identity_text(file.scan_file_album_artist),
        'duplicate_lookup_album_identity',
          library.duplicate_identity_text(file.scan_file_album),
        'duplicate_lookup_year_identity',
          library.duplicate_identity_year(file.scan_file_year),
        'duplicate_lookup_physical_album_container',
          library.problematic_physical_album_container(file.private_path),
        'companion_file_id', companion_file.id,
        'companion_private_path', companion_file.private_path,
        'companion_library_root_id', companion_file.library_root_id,
        'companion_root_category', companion_root.root_kind
      ) || pg_catalog.jsonb_build_object(
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
        'exception_override_present', exception_override.override_payload is not null,
        'exception_type', coalesce(
          exception_override.override_payload ->> 'exception_type',
          file.metadata #>> '{scan_cache,file_entry,exception_type}'
        )
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
          and library.problematic_physical_album_container(
            candidate_file.private_path
          ) = library.problematic_physical_album_container(file.private_path)
          and library.duplicate_identity_text(candidate_file.scan_file_album_artist)
            = library.duplicate_identity_text(file.scan_file_album_artist)
          and library.duplicate_identity_text(candidate_file.scan_file_album)
            = library.duplicate_identity_text(file.scan_file_album)
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
        'exception_override_present', false,
        'exception_type',
          file.metadata #>> '{scan_cache,file_entry,exception_type}'
      ) as payload
    from source_keys
    join library.local_tracks track on track.id = source_keys.track_id
    join library.local_track_files file on file.id = source_keys.owner_file_id
    join library.library_roots root on root.id = file.library_root_id
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
  )
  select result.group_kind, result.group_identity, result.source_kind,
    result.source_identity, result.child_kind, result.child_identity,
    result.rows, result.group_complete,
    -- A bounded nonempty page cannot prove that no later source group exists.
    -- Confirm exhaustion with the next empty read after completing this group.
    result.page_complete and result.group_kind is null
  from (
    select source.group_kind, source.group_identity::text,
      source.source_kind, source.source_identity::text,
      source.child_kind, source.child_identity::text,
      pg_catalog.jsonb_build_array(source.payload) as rows,
      case
        when source.group_kind in ('album', 'missing_album')
          and source.child_kind in ('file', 'featured_artist', 'ignored_repair')
          then false
        else not exists (
          select 1 from ordinary_candidates later
          where later.child_identity::bigint >
            (case when source.child_kind = 'file'
              then source.child_identity else '0' end)::bigint
        ) and not exists (
          select 1
          from library.local_track_files later_file
          join library.local_tracks later_track
            on later_track.id = later_file.track_id
          join selected_album_state later_status
            on later_status.album_id = later_track.album_id
          where source.group_kind in ('album', 'missing_album')
            and later_track.album_id = source.album_id
            and later_file.id > (case when source.child_kind = 'file'
              then source.child_identity else '0' end)::bigint
            and (
              (later_status.has_active_file and later_file.scan_cache_stale is false) or
              (later_status.all_files_stale and later_file.scan_cache_stale is true)
            )
        ) and not exists (
          select 1
          from library.local_track_files later_companion_file
          join library.library_roots later_companion_root
            on later_companion_root.id = later_companion_file.library_root_id
           and later_companion_root.library_id = p_library_id
           and later_companion_root.is_active is true
          join library.local_tracks later_companion_track
            on later_companion_track.id = later_companion_file.track_id
           and later_companion_track.library_id = p_library_id
          join library.local_albums later_companion_album
            on later_companion_album.id = later_companion_track.album_id
           and later_companion_album.id <> source.album_id
          join ops.problematic_projection_group_facts later_lookup on true
          where later_companion_file.scan_cache_stale is false
            and library.duplicate_identity_text(
                  later_companion_file.scan_file_album_artist
                ) = later_lookup.fact_value ->> 'album_artist_identity'
            and library.duplicate_identity_text(
                  later_companion_file.scan_file_album
                ) = later_lookup.fact_value ->> 'album_identity'
            and library.duplicate_identity_year(
                  later_companion_file.scan_file_year
                ) = (later_lookup.fact_value ->> 'year_identity')::integer
            and library.problematic_physical_album_container(
                  later_companion_file.private_path
                ) <> later_lookup.fact_value ->> 'physical_album_container'
            and later_lookup.job_id = p_job_id
            and later_lookup.attempt = p_attempt
            and later_lookup.revision = p_revision
            and later_lookup.group_kind = source.group_kind
            and later_lookup.group_identity = source.group_identity::text
            and later_lookup.fact_kind = 'duplicate_lookup'
            and not exists (
              select 1
              from library.local_track_files later_container_member
              join library.local_tracks later_container_track
                on later_container_track.id = later_container_member.track_id
               and later_container_track.library_id = p_library_id
              join library.library_roots later_container_root
                on later_container_root.id = later_container_member.library_root_id
               and later_container_root.library_id = p_library_id
               and later_container_root.is_active is true
              where later_container_member.scan_cache_stale is false
                and pg_catalog.md5(library.problematic_physical_album_container(
                      later_container_member.private_path
                    )) in (
                      pg_catalog.md5(later_lookup.fact_value ->> 'physical_album_container'),
                      pg_catalog.md5(library.problematic_physical_album_container(
                        later_companion_file.private_path
                      ))
                    )
                and library.problematic_physical_album_container(
                      later_container_member.private_path
                    ) in (
                      later_lookup.fact_value ->> 'physical_album_container',
                      library.problematic_physical_album_container(later_companion_file.private_path)
                    )
                and (
                  library.duplicate_identity_text(
                    later_container_member.scan_file_album_artist
                  ) is distinct from
                    later_lookup.fact_value ->> 'album_artist_identity'
                  or library.duplicate_identity_text(
                    later_container_member.scan_file_album
                  ) is distinct from
                    later_lookup.fact_value ->> 'album_identity'
                  or library.duplicate_identity_year(
                    later_container_member.scan_file_year
                  ) is distinct from
                    (later_lookup.fact_value ->> 'year_identity')::integer
                )
            )
            and (
              source.child_kind is distinct from 'duplicate_companion' or
              (
                later_lookup.semantic_child_identity,
                later_companion_file.id
              ) > (
                pg_catalog.split_part(source.child_identity, ':', 1),
                (case when source.child_kind = 'duplicate_companion'
                  then pg_catalog.split_part(source.child_identity, ':', 2)
                  else '0' end)::bigint
              )
            )
        )
      end as group_complete,
      case
        when source.group_kind in ('album', 'missing_album')
          and source.child_kind in ('file', 'featured_artist', 'ignored_repair')
          then false
        else not exists (
          select 1 from ordinary_candidates later
          where later.child_identity::bigint >
            (case when source.child_kind = 'file'
              then source.child_identity else '0' end)::bigint
        ) and not exists (
          select 1
          from library.local_track_files later_file
          join library.local_tracks later_track
            on later_track.id = later_file.track_id
          join selected_album_state later_status
            on later_status.album_id = later_track.album_id
          where source.group_kind in ('album', 'missing_album')
            and later_track.album_id = source.album_id
            and later_file.id > (case when source.child_kind = 'file'
              then source.child_identity else '0' end)::bigint
            and (
              (later_status.has_active_file and later_file.scan_cache_stale is false) or
              (later_status.all_files_stale and later_file.scan_cache_stale is true)
            )
        ) and not exists (
          select 1
          from library.local_track_files later_companion_file
          join library.library_roots later_companion_root
            on later_companion_root.id = later_companion_file.library_root_id
           and later_companion_root.library_id = p_library_id
           and later_companion_root.is_active is true
          join library.local_tracks later_companion_track
            on later_companion_track.id = later_companion_file.track_id
           and later_companion_track.library_id = p_library_id
          join library.local_albums later_companion_album
            on later_companion_album.id = later_companion_track.album_id
           and later_companion_album.id <> source.album_id
          join ops.problematic_projection_group_facts later_lookup on true
          where later_companion_file.scan_cache_stale is false
            and library.duplicate_identity_text(
                  later_companion_file.scan_file_album_artist
                ) = later_lookup.fact_value ->> 'album_artist_identity'
            and library.duplicate_identity_text(
                  later_companion_file.scan_file_album
                ) = later_lookup.fact_value ->> 'album_identity'
            and library.duplicate_identity_year(
                  later_companion_file.scan_file_year
                ) = (later_lookup.fact_value ->> 'year_identity')::integer
            and library.problematic_physical_album_container(
                  later_companion_file.private_path
                ) <> later_lookup.fact_value ->> 'physical_album_container'
            and later_lookup.job_id = p_job_id
            and later_lookup.attempt = p_attempt
            and later_lookup.revision = p_revision
            and later_lookup.group_kind = source.group_kind
            and later_lookup.group_identity = source.group_identity::text
            and later_lookup.fact_kind = 'duplicate_lookup'
            and not exists (
              select 1
              from library.local_track_files later_container_member
              join library.local_tracks later_container_track
                on later_container_track.id = later_container_member.track_id
               and later_container_track.library_id = p_library_id
              join library.library_roots later_container_root
                on later_container_root.id = later_container_member.library_root_id
               and later_container_root.library_id = p_library_id
               and later_container_root.is_active is true
              where later_container_member.scan_cache_stale is false
                and pg_catalog.md5(library.problematic_physical_album_container(
                      later_container_member.private_path
                    )) in (
                      pg_catalog.md5(later_lookup.fact_value ->> 'physical_album_container'),
                      pg_catalog.md5(library.problematic_physical_album_container(
                        later_companion_file.private_path
                      ))
                    )
                and library.problematic_physical_album_container(
                      later_container_member.private_path
                    ) in (
                      later_lookup.fact_value ->> 'physical_album_container',
                      library.problematic_physical_album_container(later_companion_file.private_path)
                    )
                and (
                  library.duplicate_identity_text(
                    later_container_member.scan_file_album_artist
                  ) is distinct from
                    later_lookup.fact_value ->> 'album_artist_identity'
                  or library.duplicate_identity_text(
                    later_container_member.scan_file_album
                  ) is distinct from
                    later_lookup.fact_value ->> 'album_identity'
                  or library.duplicate_identity_year(
                    later_container_member.scan_file_year
                  ) is distinct from
                    (later_lookup.fact_value ->> 'year_identity')::integer
                )
            )
            and (
              source.child_kind is distinct from 'duplicate_companion' or
              (
                later_lookup.semantic_child_identity,
                later_companion_file.id
              ) > (
                pg_catalog.split_part(source.child_identity, ':', 1),
                (case when source.child_kind = 'duplicate_companion'
                  then pg_catalog.split_part(source.child_identity, ':', 2)
                  else '0' end)::bigint
              )
            )
        ) and not exists (
          select 1 from bounded_groups later_group
          where (later_group.group_kind, later_group.group_identity) >
            (source.group_kind, source.group_identity)
        )
      end as page_complete
    from source_rows source
    union all
    select active.group_kind, active.group_identity::text,
      active.group_kind, active.group_identity::text,
      'duplicate_lookup'::text,
      (select max(lookup.semantic_child_identity) from lookup_keys lookup),
      '[]'::jsonb,
      not exists (
        select 1
        from ops.problematic_projection_group_facts later_lookup
        where later_lookup.job_id = p_job_id
          and later_lookup.attempt = p_attempt
          and later_lookup.revision = p_revision
          and later_lookup.group_kind = active.group_kind
          and later_lookup.group_identity = active.group_identity::text
          and later_lookup.fact_kind = 'duplicate_lookup'
          and later_lookup.semantic_child_identity >
            (select max(lookup.semantic_child_identity) from lookup_keys lookup)
      ),
      not exists (
        select 1
        from ops.problematic_projection_group_facts later_lookup
        where later_lookup.job_id = p_job_id
          and later_lookup.attempt = p_attempt
          and later_lookup.revision = p_revision
          and later_lookup.group_kind = active.group_kind
          and later_lookup.group_identity = active.group_identity::text
          and later_lookup.fact_kind = 'duplicate_lookup'
          and later_lookup.semantic_child_identity >
            (select max(lookup.semantic_child_identity) from lookup_keys lookup)
      ) and not exists (
        select 1 from bounded_groups later_group
        where (later_group.group_kind, later_group.group_identity) >
          (active.group_kind, active.group_identity)
      )
    from active_group active
    where not exists (select 1 from source_rows)
      and exists (select 1 from lookup_keys)
    union all
    select active.group_kind, active.group_identity::text,
      active.group_kind, active.group_identity::text,
      state.child_kind, state.child_identity,
        '[]'::jsonb,
        not exists (
          select 1
          from ops.problematic_projection_group_facts pending_fact
          where active.group_kind = 'album'
            and pending_fact.job_id = p_job_id
            and pending_fact.attempt = p_attempt
            and pending_fact.revision = p_revision
            and pending_fact.group_kind = active.group_kind
            and pending_fact.group_identity = active.group_identity::text
            and pending_fact.fact_kind = 'duplicate_lookup'
            and pending_fact.semantic_child_identity >
                pg_catalog.split_part(state.child_identity, ':', 1)
        ),
      not exists (
          select 1
          from ops.problematic_projection_group_facts pending_fact
          where active.group_kind = 'album'
            and pending_fact.job_id = p_job_id
            and pending_fact.attempt = p_attempt
            and pending_fact.revision = p_revision
            and pending_fact.group_kind = active.group_kind
            and pending_fact.group_identity = active.group_identity::text
            and pending_fact.fact_kind = 'duplicate_lookup'
            and pending_fact.semantic_child_identity >
                pg_catalog.split_part(state.child_identity, ':', 1)
        ) and not exists (
        select 1 from bounded_groups later_group
        where (later_group.group_kind, later_group.group_identity) >
          (active.group_kind, active.group_identity)
      )
    from active_group active
    cross join state
    where state.child_kind is not null
      and not exists (select 1 from source_rows)
      and not exists (select 1 from ordinary_candidates)
      and not exists (select 1 from companion_candidates)
      and not exists (select 1 from lookup_keys)
    union all
    select null::text, null::text, null::text, null::text, null::text,
      null::text, '[]'::jsonb, false,
      not exists (select 1 from raw_album_scan)
    where not exists (select 1 from active_group)
  ) result
  order by result.source_kind nulls last, result.source_identity nulls last,
    case result.child_kind
      when 'file' then 0
      when 'featured_artist' then 1
      when 'ignored_repair' then 2
      when 'duplicate_lookup' then 3
      when 'duplicate_companion' then 4
      else 5
    end,
    case
      when result.child_kind = 'file'
        then lpad(result.child_identity, 20, '0')
      else result.child_identity
    end nulls last;
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

create or replace function ops.load_claimed_problematic_projection_staged_group(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_after_stage_id bigint, p_limit integer, p_observed_at timestamptz
)
returns table(stage_id bigint, payload jsonb)
language sql
security definer
set search_path = pg_catalog
as $$
  select staged.stage_id, staged.payload
  from ops.problematic_projection_source_staging staged
    where exists (
        select 1
        from ops.validate_claimed_problematic_projection(
            p_job_id, p_attempt, p_worker_id, p_lease_token,
            p_library_id, p_source_generation, p_rebuild_epoch,
            p_revision, p_observed_at
        ) checked
        where checked.valid
    )
    and staged.job_id = p_job_id and staged.attempt = p_attempt
    and staged.revision = p_revision and staged.group_kind = p_group_kind
    and staged.group_identity = p_group_identity
    and staged.stage_id > coalesce(p_after_stage_id, 0)
  order by staged.stage_id limit least(greatest(p_limit, 1), 100);
$$;

create or replace function ops.load_claimed_problematic_projection_group_accumulator(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_observed_at timestamptz
)
returns table(
  after_stage_id bigint, next_batch_index integer, row_count bigint,
  source_complete boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then return; end if;
  insert into ops.problematic_projection_group_accumulators(
    job_id, attempt, revision, group_kind, group_identity, updated_at
  ) values (
    p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    p_observed_at
  ) on conflict (job_id, attempt, revision, group_kind, group_identity)
  do nothing;
  return query
  select accumulator.after_stage_id, accumulator.next_batch_index,
    accumulator.row_count, accumulator.source_complete
  from ops.problematic_projection_group_accumulators accumulator
  where accumulator.job_id = p_job_id and accumulator.attempt = p_attempt
    and accumulator.revision = p_revision
    and accumulator.group_kind = p_group_kind
    and accumulator.group_identity = p_group_identity;
end;
$$;

create or replace function ops.advance_claimed_problematic_projection_group_accumulator(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_expected_after_stage_id bigint, p_after_stage_id bigint,
  p_next_batch_index integer, p_row_count bigint, p_observed_at timestamptz
)
returns table(advanced boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_expected_after_stage_id < 0 or p_after_stage_id < p_expected_after_stage_id
     or p_next_batch_index < 0 or p_row_count < 0 then
    raise exception 'invalid projection accumulator' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    return query select false;
    return;
  end if;
  update ops.problematic_projection_group_accumulators as accumulator set
    after_stage_id = p_after_stage_id,
    next_batch_index = p_next_batch_index,
    row_count = p_row_count,
    updated_at = p_observed_at
  where accumulator.job_id = p_job_id and accumulator.attempt = p_attempt
    and accumulator.revision = p_revision
    and accumulator.group_kind = p_group_kind
    and accumulator.group_identity = p_group_identity
    and accumulator.after_stage_id = p_expected_after_stage_id;
  return query select found;
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
  select p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    (entry ->> 'stage_id')::bigint, entry ->> 'projection_id',
    entry ->> 'fact_kind', entry ->> 'semantic_child_identity',
    entry -> 'fact_value', p_observed_at
  from pg_catalog.jsonb_array_elements(p_entries) entry
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

create or replace function ops.load_claimed_problematic_projection_group_facts(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_after_projection_id text, p_after_fact_kind text,
  p_after_semantic_child_identity text, p_limit integer,
  p_observed_at timestamptz
)
returns table(
  stage_id bigint, projection_id text, fact_kind text,
  semantic_child_identity text, fact_value jsonb
)
language sql
security definer
set search_path = pg_catalog
as $$
  select fact.stage_id, fact.projection_id, fact.fact_kind,
    fact.semantic_child_identity, fact.fact_value
  from ops.problematic_projection_group_facts fact
    where exists (
        select 1
        from ops.validate_claimed_problematic_projection(
            p_job_id, p_attempt, p_worker_id, p_lease_token,
            p_library_id, p_source_generation, p_rebuild_epoch,
            p_revision, p_observed_at
        ) checked
        where checked.valid
    )
    and fact.job_id = p_job_id and fact.attempt = p_attempt
    and fact.revision = p_revision and fact.group_kind = p_group_kind
    and fact.group_identity = p_group_identity
    and (
      fact.projection_id collate "C", fact.fact_kind collate "C", fact.semantic_child_identity collate "C"
    ) > (
      coalesce(p_after_projection_id, ''),
      coalesce(p_after_fact_kind, ''),
      coalesce(p_after_semantic_child_identity, '')
    )
  order by fact.projection_id collate "C", fact.fact_kind collate "C", fact.semantic_child_identity collate "C"
  limit least(greatest(p_limit, 1), 100);
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
begin
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
  insert into ops.problematic_projection_item_staging(
    job_id, attempt, revision, group_kind, group_identity, item_key,
    sort_title, sort_artist, sort_year, sort_album_key, search_text,
    reasons, summary, batch_index, created_at
  ) select p_job_id, p_attempt, p_revision, p_group_kind, p_group_identity,
    item ->> 'item_key', item ->> 'sort_title', item ->> 'sort_artist',
    item ->> 'sort_year', item ->> 'sort_album_key', item ->> 'search_text',
    array(select jsonb_array_elements_text(item -> 'reasons')),
    item -> 'summary', p_batch_index, p_observed_at
  from jsonb_array_elements(p_items) item
  on conflict (job_id, attempt, revision, item_key) do update set
    sort_title = excluded.sort_title, sort_artist = excluded.sort_artist,
    sort_year = excluded.sort_year, sort_album_key = excluded.sort_album_key,
    search_text = excluded.search_text, reasons = excluded.reasons,
    summary = excluded.summary, batch_index = excluded.batch_index;
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
  last_projection_id text := coalesce(p_after_projection_id, '');
  last_fact_kind text := coalesce(p_after_fact_kind, '');
  last_semantic_child_identity text := coalesce(
    p_after_semantic_child_identity, ''
  );
  accepted_count integer := 0;
begin
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

create or replace function ops.stage_claimed_problematic_projection_reason_facts(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_group_kind text, p_group_identity text,
  p_facts jsonb, p_observed_at timestamptz
)
returns table(accepted boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_facts is null
     or jsonb_typeof(p_facts) <> 'array'
     or jsonb_array_length(p_facts) not between 1 and 100 then
    raise exception 'invalid projection reason fact batch' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then
    raise exception 'stale projection claim' using errcode = '55000';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_facts) fact
    where jsonb_typeof(fact) <> 'object'
       or jsonb_typeof(fact -> 'item_key') <> 'string'
       or jsonb_typeof(fact -> 'normalized_reason') <> 'string'
       or jsonb_typeof(fact -> 'display_reason') <> 'string'
      or jsonb_typeof(fact -> 'category_reason') <> 'string'
       or nullif(fact ->> 'item_key', '') is null
       or nullif(fact ->> 'normalized_reason', '') is null
       or nullif(fact ->> 'display_reason', '') is null
      or nullif(fact ->> 'category_reason', '') is null
       or octet_length(fact ->> 'item_key') > 4096
       or octet_length(fact ->> 'normalized_reason') > 4096
       or octet_length(fact ->> 'display_reason') > 4096
      or octet_length(fact ->> 'category_reason') > 4096
  ) then
    raise exception 'invalid projection reason fact' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_facts) fact
    where not exists (
      select 1
      from ops.problematic_projection_item_staging item_staging
      where item_staging.job_id = p_job_id
        and item_staging.attempt = p_attempt
        and item_staging.revision = p_revision
        and item_staging.group_kind = p_group_kind
        and item_staging.group_identity = p_group_identity
        and item_staging.item_key = fact ->> 'item_key'
    )
  ) then
    raise exception 'projection reason fact item is not staged for group'
      using errcode = '55000';
  end if;
  insert into ops.problematic_projection_reason_fact_staging(
    job_id, attempt, revision, item_key, normalized_reason, display_reason,
    category_reason
  )
  select p_job_id, p_attempt, p_revision,
    fact ->> 'item_key', fact ->> 'normalized_reason',
    fact ->> 'display_reason', fact ->> 'category_reason'
  from jsonb_array_elements(p_facts) fact
  on conflict do nothing;
  return query select true;
end;
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
begin
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
      and fact.fact_kind in (
          'track_title_search', 'private_path_search', 'private_path_locator',
        'album_title_search', 'album_artist_search', 'album_key_search'
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
  projected_facets jsonb;
  projected_reason_fact_count bigint;
  projected_reason_fingerprint bit(256);
  projected_search_fact_count bigint;
  projected_search_fingerprint bit(256);
  source_drained boolean;
  locked_state ops.problematic_projection_state%rowtype;
  database_now timestamptz;
begin
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
    p_library_id, p_revision, p_source_generation, p_rebuild_epoch, 1,
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
  replacement_epoch bigint;
begin
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
        ), selected_state.library_id, 'self_hosted', 'private_web',
        'problematic-files-projection:' || selected_state.library_id::text || ':' ||
          selected_state.source_generation::text || ':' || replacement_epoch::text,
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

create or replace function ops.cleanup_claimed_problematic_projection(
  p_job_id bigint, p_attempt integer, p_worker_id text, p_lease_token text,
  p_library_id bigint, p_source_generation bigint, p_rebuild_epoch bigint,
  p_revision uuid, p_observed_at timestamptz
)
returns table(deleted_count integer)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not exists (select 1 from ops.validate_claimed_problematic_projection(
    p_job_id, p_attempt, p_worker_id, p_lease_token, p_library_id,
    p_source_generation, p_rebuild_epoch, p_revision, p_observed_at
  ) checked where checked.valid) then return; end if;
  delete from ops.problematic_projection_source_staging as source_staging
  where source_staging.job_id = p_job_id
    and source_staging.attempt = p_attempt
    and source_staging.revision = p_revision;
  get diagnostics deleted_count = row_count;
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
    ), selected_state.library_id, 'self_hosted', 'private_web',
    'problematic-files-projection:' || selected_state.library_id::text || ':' ||
      selected_state.source_generation::text || ':' ||
      (selected_state.rebuild_epoch + 1)::text,
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

create or replace function ops.load_due_problematic_projection_integrity_audit(
  ignored_observed_at timestamptz
)
returns table(
  library_id bigint, revision uuid, audit_revision uuid,
  after_fact_type text, after_item_key text,
  after_identity_one text, after_identity_two text, after_identity_three text,
  item_count integer, last_counted_item_key text,
  reason_fact_count bigint, reason_fingerprint bit(256),
  search_fact_count bigint, search_fingerprint bit(256),
  audit_claim_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_state ops.problematic_projection_state%rowtype;
  claim_token uuid := pg_catalog.gen_random_uuid();
  database_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into selected_state
  from ops.problematic_projection_state state
  where state.committed_revision is not null and state.verified
    and state.next_integrity_audit_at <= database_now
    and (
      state.audit_claim_token is null or
      state.audit_claimed_at < database_now - interval '5 minutes'
    )
  order by state.next_integrity_audit_at, state.library_id
  for update skip locked
  limit 1;
  if not found then return; end if;
  if selected_state.audit_revision is distinct from selected_state.committed_revision then
    selected_state.audit_revision := selected_state.committed_revision;
    selected_state.audit_after_fact_type := null;
    selected_state.audit_after_item_key := null;
    selected_state.audit_after_identity_one := null;
    selected_state.audit_after_identity_two := null;
    selected_state.audit_after_identity_three := null;
    selected_state.audit_item_count := 0;
    selected_state.audit_last_counted_item_key := null;
    selected_state.audit_reason_fact_count := 0;
    selected_state.audit_reason_fingerprint := 0::bit(256);
    selected_state.audit_search_fact_count := 0;
    selected_state.audit_search_fingerprint := 0::bit(256);
  end if;
  update ops.problematic_projection_state as projection_state set
    audit_revision = selected_state.audit_revision,
    audit_after_fact_type = selected_state.audit_after_fact_type,
    audit_after_item_key = selected_state.audit_after_item_key,
    audit_after_identity_one = selected_state.audit_after_identity_one,
    audit_after_identity_two = selected_state.audit_after_identity_two,
    audit_after_identity_three = selected_state.audit_after_identity_three,
    audit_item_count = selected_state.audit_item_count,
    audit_last_counted_item_key = selected_state.audit_last_counted_item_key,
    audit_reason_fact_count = selected_state.audit_reason_fact_count,
    audit_reason_fingerprint = selected_state.audit_reason_fingerprint,
    audit_search_fact_count = selected_state.audit_search_fact_count,
    audit_search_fingerprint = selected_state.audit_search_fingerprint,
    audit_claim_token = claim_token,
    audit_claimed_at = database_now,
    updated_at = database_now
  where projection_state.library_id = selected_state.library_id;
  return query select selected_state.library_id, selected_state.committed_revision,
    selected_state.audit_revision, selected_state.audit_after_fact_type,
    selected_state.audit_after_item_key, selected_state.audit_after_identity_one,
    selected_state.audit_after_identity_two, selected_state.audit_after_identity_three,
    selected_state.audit_item_count, selected_state.audit_last_counted_item_key,
    selected_state.audit_reason_fact_count, selected_state.audit_reason_fingerprint,
    selected_state.audit_search_fact_count, selected_state.audit_search_fingerprint,
    claim_token;
end;
$$;

create or replace function ops.advance_problematic_projection_integrity_audit(
  p_library_id bigint, p_revision uuid, p_audit_claim_token uuid,
  p_expected_after_fact_type text, p_expected_after_item_key text,
  p_expected_after_identity_one text, p_expected_after_identity_two text,
  p_expected_after_identity_three text,
  p_expected_item_count integer,
  p_expected_reason_fact_count bigint, p_expected_reason_fingerprint bit(256),
  p_expected_search_fact_count bigint, p_expected_search_fingerprint bit(256),
  p_after_fact_type text, p_after_item_key text,
  p_after_identity_one text, p_after_identity_two text,
  p_after_identity_three text, p_item_count integer,
  p_last_counted_item_key text, p_reason_fact_count bigint,
  p_reason_fingerprint bit(256),
  p_search_fact_count bigint, p_search_fingerprint bit(256),
  ignored_observed_at timestamptz
)
returns table(advanced boolean)
language sql
security definer
set search_path = pg_catalog
as $$
  update ops.problematic_projection_state as projection_state set
    audit_revision = p_revision, audit_after_fact_type = p_after_fact_type,
    audit_after_item_key = p_after_item_key,
    audit_after_identity_one = p_after_identity_one,
    audit_after_identity_two = p_after_identity_two,
    audit_after_identity_three = p_after_identity_three,
    audit_item_count = p_item_count,
    audit_last_counted_item_key = p_last_counted_item_key,
    audit_reason_fact_count = p_reason_fact_count,
    audit_reason_fingerprint = p_reason_fingerprint,
    audit_search_fact_count = p_search_fact_count,
    audit_search_fingerprint = p_search_fingerprint,
    audit_claim_token = null, audit_claimed_at = null,
    next_integrity_audit_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  where projection_state.library_id = p_library_id
    and projection_state.committed_revision = p_revision
    and projection_state.audit_revision = p_revision
    and projection_state.audit_claim_token = p_audit_claim_token
    and projection_state.audit_claimed_at >=
      pg_catalog.clock_timestamp() - interval '5 minutes'
    and projection_state.audit_after_fact_type is not distinct from p_expected_after_fact_type
    and projection_state.audit_after_item_key is not distinct from p_expected_after_item_key
    and projection_state.audit_after_identity_one is not distinct from p_expected_after_identity_one
    and projection_state.audit_after_identity_two is not distinct from p_expected_after_identity_two
    and projection_state.audit_after_identity_three is not distinct from p_expected_after_identity_three
    and projection_state.audit_item_count = p_expected_item_count
    and projection_state.audit_reason_fact_count = p_expected_reason_fact_count
    and projection_state.audit_reason_fingerprint = p_expected_reason_fingerprint
    and projection_state.audit_search_fact_count = p_expected_search_fact_count
    and projection_state.audit_search_fingerprint = p_expected_search_fingerprint
  returning true;
$$;

create or replace function ops.load_problematic_projection_integrity_page(
  p_library_id bigint, p_revision uuid, p_after_fact_type text,
  p_after_item_key text, p_after_identity_one text,
  p_after_identity_two text, p_after_identity_three text, p_limit integer
)
returns table(
  fact_type text, item_key text,
  normalized_reason text, display_reason text, category_reason text,
  fact_kind text, semantic_child_identity text, normalized_text text
)
language sql
security definer
set search_path = pg_catalog
as $$
  with reason_facts as (
    select 'reason'::text as fact_type, reason_fact.item_key,
      reason_fact.normalized_reason, reason_fact.display_reason,
      reason_fact.category_reason,
      null::text as fact_kind, null::text as semantic_child_identity,
      null::text as normalized_text,
      reason_fact.normalized_reason as identity_one,
      reason_fact.display_reason as identity_two,
      reason_fact.category_reason as identity_three
    from ops.problematic_projection_reason_facts reason_fact
    where reason_fact.library_id = p_library_id
      and reason_fact.revision = p_revision
      and (
        'reason'::text collate "C" > coalesce(p_after_fact_type, '') collate "C"
        or (
          'reason'::text collate "C" = coalesce(p_after_fact_type, '') collate "C"
          and (
            reason_fact.item_key collate "C",
            reason_fact.normalized_reason collate "C",
            reason_fact.display_reason collate "C",
            reason_fact.category_reason collate "C"
          ) > (
            coalesce(p_after_item_key, '') collate "C",
            coalesce(p_after_identity_one, '') collate "C",
            coalesce(p_after_identity_two, '') collate "C",
            coalesce(p_after_identity_three, '') collate "C"
          )
        )
      )
    order by reason_fact.item_key collate "C",
      reason_fact.normalized_reason collate "C",
      reason_fact.display_reason collate "C",
      reason_fact.category_reason collate "C"
    limit least(greatest(p_limit, 1), 100)
  ), search_facts as (
    select 'search'::text as fact_type, search_fact.item_key,
      null::text as normalized_reason, null::text as display_reason,
      null::text as category_reason,
      search_fact.fact_kind, search_fact.semantic_child_identity,
      search_fact.normalized_text, search_fact.fact_kind as identity_one,
      search_fact.semantic_child_identity as identity_two,
      ''::text as identity_three
    from ops.problematic_projection_search_facts search_fact
    where search_fact.library_id = p_library_id
      and search_fact.revision = p_revision
      and (
        'search'::text collate "C" > coalesce(p_after_fact_type, '') collate "C"
        or (
          'search'::text collate "C" = coalesce(p_after_fact_type, '') collate "C"
          and (
            search_fact.item_key collate "C",
            search_fact.fact_kind collate "C",
            search_fact.semantic_child_identity collate "C",
            ''::text collate "C"
          ) > (
            coalesce(p_after_item_key, '') collate "C",
            coalesce(p_after_identity_one, '') collate "C",
            coalesce(p_after_identity_two, '') collate "C",
            coalesce(p_after_identity_three, '') collate "C"
          )
        )
      )
    order by search_fact.item_key collate "C",
      search_fact.fact_kind collate "C",
      search_fact.semantic_child_identity collate "C"
    limit least(greatest(p_limit, 1), 100)
  ), integrity_facts as (
    select * from reason_facts
    union all
    select * from search_facts
  )
  select fact.fact_type, fact.item_key, fact.normalized_reason,
    fact.display_reason, fact.category_reason, fact.fact_kind,
    fact.semantic_child_identity,
    fact.normalized_text
  from integrity_facts fact
  order by fact.fact_type collate "C", fact.item_key collate "C",
    fact.identity_one collate "C", fact.identity_two collate "C",
    fact.identity_three collate "C"
  limit least(greatest(p_limit, 1), 100);
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
    perform * from ops.enqueue_problematic_projection_rebuild(
      p_library_id, 'integrity-reconciler'
    );
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

revoke all on table ops.problematic_projection_state from public;
revoke all on table ops.problematic_projection_state from album_haven_app;
revoke all on table ops.problematic_projection_state from album_haven_worker;
revoke all on table ops.problematic_projection_state from album_haven_readonly;
revoke all on table ops.problematic_projection_headers from public;
revoke all on table ops.problematic_projection_headers from album_haven_app;
revoke all on table ops.problematic_projection_headers from album_haven_worker;
revoke all on table ops.problematic_projection_headers from album_haven_readonly;
revoke all on table ops.problematic_projection_items from public;
revoke all on table ops.problematic_projection_items from album_haven_app;
revoke all on table ops.problematic_projection_items from album_haven_worker;
revoke all on table ops.problematic_projection_items from album_haven_readonly;
revoke all on table ops.problematic_projection_source_staging from public;
revoke all on table ops.problematic_projection_source_staging from album_haven_app;
revoke all on table ops.problematic_projection_source_staging from album_haven_worker;
revoke all on table ops.problematic_projection_source_staging from album_haven_readonly;
revoke all on table ops.problematic_projection_item_staging from public;
revoke all on table ops.problematic_projection_item_staging from album_haven_app;
revoke all on table ops.problematic_projection_item_staging from album_haven_worker;
revoke all on table ops.problematic_projection_item_staging from album_haven_readonly;
revoke all on table ops.problematic_projection_reason_fact_staging from public;
revoke all on table ops.problematic_projection_reason_fact_staging from album_haven_app;
revoke all on table ops.problematic_projection_reason_fact_staging from album_haven_worker;
revoke all on table ops.problematic_projection_reason_fact_staging from album_haven_readonly;
revoke all on table ops.problematic_projection_group_accumulators from public;
revoke all on table ops.problematic_projection_group_accumulators from album_haven_app;
revoke all on table ops.problematic_projection_group_accumulators from album_haven_worker;
revoke all on table ops.problematic_projection_group_accumulators from album_haven_readonly;
revoke all on table ops.problematic_projection_group_facts from public;
revoke all on table ops.problematic_projection_group_facts from album_haven_app;
revoke all on table ops.problematic_projection_group_facts from album_haven_worker;
revoke all on table ops.problematic_projection_group_facts from album_haven_readonly;
revoke all on table ops.problematic_projection_search_facts from public;
revoke all on table ops.problematic_projection_search_facts from album_haven_app;
revoke all on table ops.problematic_projection_search_facts from album_haven_worker;
revoke all on table ops.problematic_projection_search_facts from album_haven_readonly;
revoke all on table ops.problematic_projection_reason_facts from public;
revoke all on table ops.problematic_projection_reason_facts from album_haven_app;
revoke all on table ops.problematic_projection_reason_facts from album_haven_worker;
revoke all on table ops.problematic_projection_reason_facts from album_haven_readonly;
revoke all on table ops.problematic_projection_search_fact_staging from public;
revoke all on table ops.problematic_projection_search_fact_staging from album_haven_app;
revoke all on table ops.problematic_projection_search_fact_staging from album_haven_worker;
revoke all on table ops.problematic_projection_search_fact_staging from album_haven_readonly;
revoke all on table ops.problematic_projection_source_rows from public;
revoke all on table ops.problematic_projection_source_rows from album_haven_app;
revoke all on table ops.problematic_projection_source_rows from album_haven_worker;
revoke all on table ops.problematic_projection_source_rows from album_haven_readonly;
grant select on table ops.problematic_projection_state to album_haven_app;
grant select on table ops.problematic_projection_headers to album_haven_app;
grant select on table ops.problematic_projection_items to album_haven_app;
grant select on table ops.problematic_projection_search_facts to album_haven_app;
grant select on table ops.problematic_projection_reason_facts to album_haven_app;
grant select on table ops.problematic_projection_state to album_haven_readonly;
grant select on table ops.problematic_projection_headers to album_haven_readonly;
grant select on table ops.problematic_projection_items to album_haven_readonly;
grant select on table ops.problematic_projection_search_facts to album_haven_readonly;
grant select on table ops.problematic_projection_reason_facts to album_haven_readonly;

revoke all on function ops.resolve_problematic_projection_library() from public;
revoke all on function ops.resolve_problematic_projection_library() from album_haven_worker;
revoke all on function ops.resolve_problematic_projection_library() from album_haven_readonly;
grant execute on function ops.resolve_problematic_projection_library() to album_haven_app;
revoke all on function ops.enqueue_problematic_projection_rebuild(bigint,text) from public;
revoke all on function ops.enqueue_problematic_projection_rebuild(bigint,text) from album_haven_worker;
revoke all on function ops.enqueue_problematic_projection_rebuild(bigint,text) from album_haven_readonly;
grant execute on function ops.enqueue_problematic_projection_rebuild(bigint,text) to album_haven_app;
revoke all on function ops.invalidate_problematic_projection() from public;
revoke all on function ops.invalidate_problematic_projection() from album_haven_app;
revoke all on function ops.invalidate_problematic_projection() from album_haven_readonly;
revoke all on function ops.invalidate_problematic_projection() from album_haven_worker;
revoke all on function ops.invalidate_problematic_projection_metadata_update() from public;
revoke all on function ops.invalidate_problematic_projection_metadata_update() from album_haven_app;
revoke all on function ops.invalidate_problematic_projection_metadata_update() from album_haven_readonly;
revoke all on function ops.invalidate_problematic_projection_metadata_update() from album_haven_worker;
revoke all on function ops.invalidate_problematic_projection_library(bigint) from public;
revoke all on function ops.invalidate_problematic_projection_library(bigint) from album_haven_app;
revoke all on function ops.invalidate_problematic_projection_library(bigint) from album_haven_readonly;
revoke all on function ops.invalidate_problematic_projection_library(bigint) from album_haven_worker;
revoke all on function ops.invalidate_problematic_projection_ownership_move() from public;
revoke all on function ops.invalidate_problematic_projection_ownership_move() from album_haven_app;
revoke all on function ops.invalidate_problematic_projection_ownership_move() from album_haven_readonly;
revoke all on function ops.invalidate_problematic_projection_ownership_move() from album_haven_worker;

revoke all on function ops.problematic_projection_worker_ready(text) from public;
revoke all on function ops.problematic_projection_worker_ready(text) from album_haven_app;
revoke all on function ops.problematic_projection_worker_ready(text) from album_haven_readonly;
revoke all on function ops.problematic_projection_worker_ready(text) from album_haven_worker;
grant execute on function ops.problematic_projection_worker_ready(text) to album_haven_migrator;

revoke all on function ops.problematic_projection_claim_valid(bigint,integer,text,text,timestamptz) from public;
revoke all on function ops.problematic_projection_claim_valid(bigint,integer,text,text,timestamptz) from album_haven_app;
revoke all on function ops.problematic_projection_claim_valid(bigint,integer,text,text,timestamptz) from album_haven_readonly;
grant execute on function ops.problematic_projection_claim_valid(bigint,integer,text,text,timestamptz) to album_haven_worker;

revoke all on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz) from public;
revoke all on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz) from album_haven_app;
revoke all on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz) from album_haven_readonly;
grant execute on function ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz) to album_haven_worker;
revoke all on function ops.validate_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from public;
revoke all on function ops.validate_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from album_haven_app;
revoke all on function ops.validate_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from album_haven_readonly;
grant execute on function ops.validate_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) to album_haven_worker;
revoke all on function ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamptz) from public;
revoke all on function ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamptz) from album_haven_app;
revoke all on function ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamptz) from album_haven_readonly;
grant execute on function ops.load_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,integer,integer,timestamptz) to album_haven_worker;
revoke all on function ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamptz) from public;
revoke all on function ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamptz) from album_haven_app;
revoke all on function ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamptz) from album_haven_readonly;
grant execute on function ops.stage_claimed_problematic_projection_source(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,jsonb,boolean,timestamptz) to album_haven_worker;
revoke all on function ops.load_claimed_problematic_projection_staged_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamptz) from public;
revoke all on function ops.load_claimed_problematic_projection_staged_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamptz) from album_haven_app;
revoke all on function ops.load_claimed_problematic_projection_staged_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamptz) from album_haven_readonly;
grant execute on function ops.load_claimed_problematic_projection_staged_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,integer,timestamptz) to album_haven_worker;
revoke all on function ops.stage_claimed_problematic_projection_items(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,integer,timestamptz) from public;
revoke all on function ops.stage_claimed_problematic_projection_items(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,integer,timestamptz) from album_haven_app;
revoke all on function ops.stage_claimed_problematic_projection_items(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,integer,timestamptz) from album_haven_readonly;
grant execute on function ops.stage_claimed_problematic_projection_items(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,integer,timestamptz) to album_haven_worker;
revoke all on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) from public;
revoke all on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) from album_haven_app;
revoke all on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) from album_haven_readonly;
grant execute on function ops.stage_claimed_problematic_projection_search_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) to album_haven_worker;
revoke all on function ops.stage_claimed_problematic_projection_reason_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) from public;
revoke all on function ops.stage_claimed_problematic_projection_reason_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) from album_haven_app;
revoke all on function ops.stage_claimed_problematic_projection_reason_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) from album_haven_readonly;
grant execute on function ops.stage_claimed_problematic_projection_reason_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,jsonb,timestamptz) to album_haven_worker;
revoke all on function ops.complete_claimed_problematic_projection_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,timestamptz) from public;
revoke all on function ops.complete_claimed_problematic_projection_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,timestamptz) from album_haven_app;
revoke all on function ops.complete_claimed_problematic_projection_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,timestamptz) from album_haven_readonly;
grant execute on function ops.complete_claimed_problematic_projection_group(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,text,timestamptz) to album_haven_worker;
revoke all on function ops.publish_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from public;
revoke all on function ops.publish_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from album_haven_app;
revoke all on function ops.publish_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from album_haven_readonly;
grant execute on function ops.publish_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) to album_haven_worker;
revoke all on function ops.fail_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,timestamptz) from public;
revoke all on function ops.fail_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,timestamptz) from album_haven_app;
revoke all on function ops.fail_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,timestamptz) from album_haven_readonly;
grant execute on function ops.fail_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,timestamptz) to album_haven_worker;
revoke all on function ops.cleanup_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from public;
revoke all on function ops.cleanup_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from album_haven_app;
revoke all on function ops.cleanup_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) from album_haven_readonly;
grant execute on function ops.cleanup_claimed_problematic_projection(bigint,integer,text,text,bigint,bigint,bigint,uuid,timestamptz) to album_haven_worker;
revoke all on function ops.reclaim_one_abandoned_problematic_projection(timestamptz) from public;
revoke all on function ops.reclaim_one_abandoned_problematic_projection(timestamptz) from album_haven_app;
revoke all on function ops.reclaim_one_abandoned_problematic_projection(timestamptz) from album_haven_readonly;
grant execute on function ops.reclaim_one_abandoned_problematic_projection(timestamptz) to album_haven_worker;

revoke all on function ops.load_due_problematic_projection_integrity_audit(timestamptz) from public;
revoke all on function ops.load_due_problematic_projection_integrity_audit(timestamptz) from album_haven_app;
revoke all on function ops.load_due_problematic_projection_integrity_audit(timestamptz) from album_haven_readonly;
grant execute on function ops.load_due_problematic_projection_integrity_audit(timestamptz) to album_haven_worker;
revoke all on function ops.advance_problematic_projection_integrity_audit(bigint,uuid,uuid,text,text,text,text,text,integer,bigint,bit,bigint,bit,text,text,text,text,text,integer,text,bigint,bit,bigint,bit,timestamptz) from public;
revoke all on function ops.advance_problematic_projection_integrity_audit(bigint,uuid,uuid,text,text,text,text,text,integer,bigint,bit,bigint,bit,text,text,text,text,text,integer,text,bigint,bit,bigint,bit,timestamptz) from album_haven_app;
revoke all on function ops.advance_problematic_projection_integrity_audit(bigint,uuid,uuid,text,text,text,text,text,integer,bigint,bit,bigint,bit,text,text,text,text,text,integer,text,bigint,bit,bigint,bit,timestamptz) from album_haven_readonly;
grant execute on function ops.advance_problematic_projection_integrity_audit(bigint,uuid,uuid,text,text,text,text,text,integer,bigint,bit,bigint,bit,text,text,text,text,text,integer,text,bigint,bit,bigint,bit,timestamptz) to album_haven_worker;
revoke all on function ops.load_problematic_projection_integrity_page(bigint,uuid,text,text,text,text,text,integer) from public;
revoke all on function ops.load_problematic_projection_integrity_page(bigint,uuid,text,text,text,text,text,integer) from album_haven_app;
revoke all on function ops.load_problematic_projection_integrity_page(bigint,uuid,text,text,text,text,text,integer) from album_haven_readonly;
grant execute on function ops.load_problematic_projection_integrity_page(bigint,uuid,text,text,text,text,text,integer) to album_haven_worker;
revoke all on function ops.complete_problematic_projection_integrity_audit(bigint,uuid,uuid,integer,bigint,bit,bigint,bit,timestamptz) from public;
revoke all on function ops.complete_problematic_projection_integrity_audit(bigint,uuid,uuid,integer,bigint,bit,bigint,bit,timestamptz) from album_haven_app;
revoke all on function ops.complete_problematic_projection_integrity_audit(bigint,uuid,uuid,integer,bigint,bit,bigint,bit,timestamptz) from album_haven_readonly;
grant execute on function ops.complete_problematic_projection_integrity_audit(bigint,uuid,uuid,integer,bigint,bit,bigint,bit,timestamptz) to album_haven_worker;

revoke all on function ops.load_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamptz) from public;
revoke all on function ops.load_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamptz) from album_haven_app;
revoke all on function ops.load_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamptz) from album_haven_readonly;
grant execute on function ops.load_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,timestamptz) to album_haven_worker;
revoke all on function ops.advance_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,bigint,integer,bigint,timestamptz) from public;
revoke all on function ops.advance_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,bigint,integer,bigint,timestamptz) from album_haven_app;
revoke all on function ops.advance_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,bigint,integer,bigint,timestamptz) from album_haven_readonly;
grant execute on function ops.advance_claimed_problematic_projection_group_accumulator(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,bigint,integer,bigint,timestamptz) to album_haven_worker;

revoke all on function ops.checkpoint_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,jsonb,integer,bigint,timestamptz) from public;
revoke all on function ops.checkpoint_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,jsonb,integer,bigint,timestamptz) from album_haven_app;
revoke all on function ops.checkpoint_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,jsonb,integer,bigint,timestamptz) from album_haven_readonly;
grant execute on function ops.checkpoint_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,bigint,jsonb,integer,bigint,timestamptz) to album_haven_worker;
revoke all on function ops.load_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) from public;
revoke all on function ops.load_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) from album_haven_app;
revoke all on function ops.load_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) from album_haven_readonly;
grant execute on function ops.load_claimed_problematic_projection_group_facts(bigint,integer,text,text,bigint,bigint,bigint,uuid,text,text,text,text,text,integer,timestamptz) to album_haven_worker;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table
      ops.problematic_projection_state,
      ops.problematic_projection_headers,
      ops.problematic_projection_items,
      ops.problematic_projection_source_staging,
      ops.problematic_projection_item_staging,
      ops.problematic_projection_reason_fact_staging,
      ops.problematic_projection_group_accumulators,
      ops.problematic_projection_group_facts,
      ops.problematic_projection_search_facts,
      ops.problematic_projection_reason_facts,
      ops.problematic_projection_search_fact_staging
    to album_haven_migrator;
    grant select on table ops.problematic_projection_source_rows
      to album_haven_migrator;
    grant usage, select on sequence
      ops.problematic_projection_source_staging_stage_id_seq
    to album_haven_migrator;
  end if;
end;
$$;
