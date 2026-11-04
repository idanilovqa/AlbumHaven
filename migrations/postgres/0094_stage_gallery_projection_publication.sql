-- Stage expensive gallery rows before the short source-generation lock.

alter table library.gallery_projection_occurrences
  add column if not exists revision text;

update library.gallery_projection_occurrences as occurrence
set revision = snapshot.revision
from library.gallery_projection_snapshots as snapshot
where occurrence.library_id = snapshot.library_id
  and occurrence.scope_key = snapshot.scope_key
  and occurrence.revision is null;

alter table library.gallery_projection_occurrences
  alter column revision set not null,
  add column if not exists staged_at timestamptz not null default now();

alter table library.gallery_projection_occurrences
  drop constraint if exists gallery_projection_occurrences_library_id_scope_key_fkey,
  drop constraint if exists gallery_projection_occurrences_pkey;

alter table library.gallery_projection_occurrences
  add constraint gallery_projection_occurrences_revision_check
    check (revision ~ '^[0-9a-f]{64}$'),
  add constraint gallery_projection_occurrences_pkey
    primary key (library_id, scope_key, revision, ordinal),
  add constraint gallery_projection_occurrences_library_id_fkey
    foreign key (library_id) references library.gallery_projection_state(library_id)
    on delete cascade;

drop index if exists library.gallery_projection_occurrences_artist_name_ordinal_idx;
drop index if exists library.gallery_projection_occurrences_artist_id_ordinal_idx;

create index gallery_projection_occurrences_artist_name_ordinal_idx
  on library.gallery_projection_occurrences
  (library_id, scope_key, revision, (payload ->> 'artist_name'), ordinal);

create index gallery_projection_occurrences_artist_id_ordinal_idx
  on library.gallery_projection_occurrences
  (library_id, scope_key, revision, (payload ->> 'artist_id'), ordinal);

create or replace function library.replace_gallery_projection(
  target_library_id bigint, target_scope_key text, expected_generation bigint,
  projection_builder_version text, content_revision text, projection_sidebar jsonb,
  projection_album_count bigint, projection_occurrences jsonb
) returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  current_generation bigint;
  source_mutation_xid xid8;
begin
  if target_library_id is null or expected_generation is null or expected_generation < 0
     or target_scope_key is null or target_scope_key !~ '^[0-9a-f]{64}$'
     or content_revision is null or content_revision !~ '^[0-9a-f]{64}$'
     or btrim(coalesce(projection_builder_version,'')) = '' or octet_length(projection_builder_version) > 128
     or projection_album_count is null or projection_album_count < 0
     or jsonb_typeof(projection_sidebar) is distinct from 'array'
     or jsonb_typeof(projection_occurrences) is distinct from 'array' then
    raise exception 'Invalid gallery projection publication';
  end if;
  if jsonb_array_length(projection_sidebar) > 100000
     or jsonb_array_length(projection_occurrences) > 2000000
     or pg_column_size(projection_sidebar) + pg_column_size(projection_occurrences) > 268435456 then
    raise exception 'Gallery projection exceeds publication bounds';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_occurrences) item
      where jsonb_typeof(item) <> 'object') then
    raise exception 'Gallery occurrences must be objects';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_occurrences) item,
      lateral jsonb_object_keys(item) field
      where field not in ('artist_id','artist_name','artist_sort_name','album_id','album_key','album_title','album_release_year','featured_kind','missing_album_key')) then
    raise exception 'Gallery occurrences contain unsupported fields';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_sidebar) item
      where jsonb_typeof(item) <> 'object') then
    raise exception 'Gallery sidebar entries must be objects';
  end if;
  if exists (select 1 from jsonb_array_elements(projection_sidebar) item,
      lateral jsonb_object_keys(item) field
      where field not in ('artist','artist_display','count')) then
    raise exception 'Gallery sidebar contains unsupported fields';
  end if;
  if not exists (select 1 from library.libraries l join app.bootstrap_owners b
      on b.account_id = l.owner_account_id
      where b.owner_key = 'local-bootstrap-owner' and l.id = target_library_id
        and l.name = 'Local Library' and l.library_kind = 'local') then
    raise exception 'Gallery projection library is outside the bootstrap scope';
  end if;

  delete from library.gallery_projection_occurrences occurrence
  where occurrence.library_id = target_library_id
    and occurrence.scope_key = target_scope_key
    and occurrence.staged_at < clock_timestamp() - interval '5 minutes'
    and not exists (
      select 1
      from library.gallery_projection_snapshots snapshot
      where snapshot.library_id = occurrence.library_id
        and snapshot.scope_key = occurrence.scope_key
        and snapshot.revision = occurrence.revision
    );

  insert into library.gallery_projection_occurrences(
    library_id, scope_key, revision, ordinal, payload, staged_at)
  select target_library_id, target_scope_key, content_revision,
    ordinality - 1, value, now()
  from jsonb_array_elements(projection_occurrences) with ordinality
  on conflict (library_id, scope_key, revision, ordinal) do update
  set payload = excluded.payload,
      staged_at = excluded.staged_at;

  select generation, last_invalidation_xid into current_generation, source_mutation_xid
  from library.gallery_projection_state
  where library_id = target_library_id for update;
  if current_generation is distinct from expected_generation
     or source_mutation_xid = pg_current_xact_id() then
    return false;
  end if;

  insert into library.gallery_projection_snapshots(
    library_id, scope_key, source_generation, builder_version, revision, sidebar,
    album_count, occurrence_count)
  values(target_library_id, target_scope_key, expected_generation,
    projection_builder_version, content_revision, projection_sidebar,
    projection_album_count, jsonb_array_length(projection_occurrences))
  on conflict (library_id, scope_key) do update
  set source_generation = excluded.source_generation,
      builder_version = excluded.builder_version,
      revision = excluded.revision,
      sidebar = excluded.sidebar,
      album_count = excluded.album_count,
      occurrence_count = excluded.occurrence_count;
  return true;
end;
$$;
