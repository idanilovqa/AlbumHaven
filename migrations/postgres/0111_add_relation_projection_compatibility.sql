-- Keep the legacy v11 contract separate from current normalized relations.
-- Preparation is explicit and verified; this migration performs no backfill.
create table library.local_relation_compatibility_entries (
    like library.local_relation_projection_entries including all,
    foreign key (library_id) references library.libraries(id) on delete cascade
);

create table library.local_relation_compatibility_state (
    library_id bigint primary key references library.libraries(id) on delete cascade,
    legacy_semantics text not null check (legacy_semantics = 'legacy-v11-broad-aliases'),
    current_semantics text not null check (current_semantics = 'current-v11-explicit-collaboration'),
    source_fingerprint text not null,
    relations_last_built double precision not null check (relations_last_built > 0 and relations_last_built < 'Infinity'::double precision),
    last_publication_xid xid8 not null,
    pending_scan_receipt jsonb,
    pending_scan_xid xid8,
    check ((pending_scan_receipt is null) = (pending_scan_xid is null)),
    initialized_at timestamptz not null default now()
);

create function library.local_relation_compatibility_views(selected_library_id bigint)
returns jsonb language sql stable parallel safe
set search_path = pg_catalog as $$
  select jsonb_build_object(
    'artists', coalesce((select jsonb_agg(payload order by sort_key collate "C", entry_key collate "C")
      from library.local_relation_compatibility_entries where library_id=selected_library_id and section='artists'), '[]'::jsonb),
    'artists_sidebar', coalesce((select jsonb_agg(payload order by sort_key collate "C", entry_key collate "C")
      from library.local_relation_compatibility_entries where library_id=selected_library_id and section='artists_sidebar'), '[]'::jsonb),
    'sidebar_families', coalesce((select jsonb_agg(payload order by sort_key collate "C", entry_key collate "C")
      from library.local_relation_compatibility_entries where library_id=selected_library_id and section='sidebar_families'), '[]'::jsonb),
    'alias_to_canonical', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_compatibility_entries where library_id=selected_library_id and section='alias_to_canonical'), '{}'::jsonb),
    'canonical_to_aliases', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_compatibility_entries where library_id=selected_library_id and section='canonical_to_aliases'), '{}'::jsonb),
    'family_to_artists', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_compatibility_entries where library_id=selected_library_id and section='family_to_artists'), '{}'::jsonb),
    'folder_related', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_compatibility_entries where library_id=selected_library_id and section='folder_related'), '{}'::jsonb)
  );
$$;

revoke all on function library.local_relation_compatibility_views(bigint) from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname='album_haven_app') then
        grant select, insert, update, delete on library.local_relation_compatibility_entries,
            library.local_relation_compatibility_state to album_haven_app;
        grant execute on function library.local_relation_compatibility_views(bigint) to album_haven_app;
    end if;
    if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
        grant select on library.local_relation_compatibility_entries,
            library.local_relation_compatibility_state to album_haven_readonly;
        grant execute on function library.local_relation_compatibility_views(bigint) to album_haven_readonly;
    end if;
    if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
        grant all privileges on library.local_relation_compatibility_entries,
            library.local_relation_compatibility_state to album_haven_migrator;
        grant execute on function library.local_relation_compatibility_views(bigint) to album_haven_migrator;
    end if;
end;
$$;

-- Current mappings are isolated from legacy writers. Per-row provenance is retained,
-- while the read view exposes the atomically verified publication metadata.
create table library.local_artist_search_projection_current_entries (
    like library.local_artist_search_projection including all,
    foreign key (library_id) references library.libraries(id) on delete cascade
);
create view library.local_artist_search_projection_current as
select entries.library_id, entries.normalized_artist_key, entries.canonical_artist_name,
       state.builder_version, compatibility.source_fingerprint, compatibility.relations_last_built
from library.local_artist_search_projection_current_entries entries
join library.local_relation_projection_state state using(library_id)
join library.local_relation_compatibility_state compatibility using(library_id)
where compatibility.current_semantics='current-v11-explicit-collaboration'
  and compatibility.legacy_semantics='legacy-v11-broad-aliases'
  and compatibility.source_fingerprint=state.source_fingerprint
  and compatibility.last_publication_xid=state.last_publication_xid
  and entries.builder_version=state.builder_version;

create or replace function library.replace_local_artist_search_projection_current(
  projection_rows jsonb,
  projection_builder_version text,
  projection_source_fingerprint text,
  projection_relations_last_built double precision
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  replacement_row_count integer := 0;
begin
  if jsonb_typeof(projection_rows) is distinct from 'array' then
    raise exception 'projection_rows must be a JSON array';
  end if;
  if jsonb_array_length(projection_rows) > 100000 then
    raise exception 'projection_rows exceeds the bounded row limit';
  end if;
  if pg_column_size(projection_rows) > 67108864 then
    raise exception 'projection_rows exceeds the bounded byte limit';
  end if;
  if btrim(coalesce(projection_builder_version, '')) = ''
     or btrim(coalesce(projection_source_fingerprint, '')) = ''
     or projection_relations_last_built is null then
    raise exception 'projection publication metadata is required';
  end if;
  if octet_length(projection_builder_version) > 128 then
    raise exception 'projection builder version exceeds the bounded byte limit';
  end if;
  if projection_source_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'projection source fingerprint must be a lowercase SHA-256 digest';
  end if;
  if projection_relations_last_built in (
    'NaN'::double precision,
    'Infinity'::double precision,
    '-Infinity'::double precision
  ) then
    raise exception 'projection relations timestamp must be finite';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(projection_rows) as rows(
      normalized_artist_key text,
      canonical_artist_name text
    )
    where btrim(coalesce(rows.normalized_artist_key, '')) = ''
       or btrim(coalesce(rows.canonical_artist_name, '')) = ''
       or octet_length(rows.normalized_artist_key) > 1024
       or octet_length(rows.canonical_artist_name) > 4096
  ) then
    raise exception 'projection rows contain invalid or oversized artist values';
  end if;
  if exists (
    select rows.normalized_artist_key
    from jsonb_to_recordset(projection_rows) as rows(
      normalized_artist_key text,
      canonical_artist_name text
    )
    group by rows.normalized_artist_key
    having count(*) > 1
  ) then
    raise exception 'projection rows contain duplicate normalized keys';
  end if;

  delete from library.local_artist_search_projection_current_entries
  using app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
    and library.local_artist_search_projection_current_entries.library_id = library.libraries.id;

  insert into library.local_artist_search_projection_current_entries (
    library_id,
    normalized_artist_key,
    canonical_artist_name,
    builder_version,
    source_fingerprint,
    relations_last_built
  )
  select
    library.libraries.id,
    rows.normalized_artist_key,
    rows.canonical_artist_name,
    projection_builder_version,
    projection_source_fingerprint,
    projection_relations_last_built
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  join jsonb_to_recordset(projection_rows) as rows(
    normalized_artist_key text,
    canonical_artist_name text
  ) on true
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner';

  get diagnostics replacement_row_count = row_count;
  return replacement_row_count;
end;
$$;

create or replace function library.patch_local_artist_search_projection_current(
  affected_normalized_keys text[],
  projection_rows jsonb,
  projection_builder_version text,
  projection_source_fingerprint text,
  projection_relations_last_built double precision
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  selected_library_id bigint;
  deleted_row_count integer := 0;
  upserted_row_count integer := 0;
begin
  if affected_normalized_keys is null
     or cardinality(affected_normalized_keys) = 0
     or cardinality(affected_normalized_keys) > 256 then
    raise exception 'affected_normalized_keys must contain 1 to 256 values';
  end if;
  if exists (
    select 1
    from unnest(affected_normalized_keys) as affected(normalized_artist_key)
    where btrim(coalesce(affected.normalized_artist_key, '')) = ''
       or octet_length(affected.normalized_artist_key) > 1024
  ) then
    raise exception 'affected_normalized_keys contains an invalid value';
  end if;
  if jsonb_typeof(projection_rows) is distinct from 'array'
     or jsonb_array_length(projection_rows) > 256
     or pg_column_size(projection_rows) > 1048576 then
    raise exception 'projection_rows exceeds the bounded patch contract';
  end if;
  if projection_source_fingerprint is null then
    raise exception 'projection_source_fingerprint is required';
  end if;
  if btrim(coalesce(projection_builder_version, '')) = ''
     or octet_length(projection_builder_version) > 128
     or projection_source_fingerprint !~ '^[0-9a-f]{64}$'
     or projection_relations_last_built is null
     or projection_relations_last_built in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     ) then
    raise exception 'projection patch metadata is invalid';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(projection_rows) as rows(
      normalized_artist_key text,
      canonical_artist_name text
    )
    where btrim(coalesce(rows.normalized_artist_key, '')) = ''
       or btrim(coalesce(rows.canonical_artist_name, '')) = ''
       or octet_length(rows.normalized_artist_key) > 1024
       or octet_length(rows.canonical_artist_name) > 4096
       or not (rows.normalized_artist_key = any(affected_normalized_keys))
  ) then
    raise exception 'projection_rows contains an invalid or unaffected value';
  end if;
  if exists (
    select rows.normalized_artist_key
    from jsonb_to_recordset(projection_rows) as rows(
      normalized_artist_key text,
      canonical_artist_name text
    )
    group by rows.normalized_artist_key
    having count(*) > 1
  ) then
    raise exception 'projection_rows contains duplicate normalized keys';
  end if;

  select libraries.id
  into strict selected_library_id
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner';

  delete from library.local_artist_search_projection_current_entries
  where library_id = selected_library_id
    and normalized_artist_key = any(affected_normalized_keys)
    and not exists (
      select 1 from jsonb_to_recordset(projection_rows) as replacement(normalized_artist_key text)
      where replacement.normalized_artist_key = library.local_artist_search_projection_current_entries.normalized_artist_key
    );
  get diagnostics deleted_row_count = row_count;

  insert into library.local_artist_search_projection_current_entries (
    library_id,
    normalized_artist_key,
    canonical_artist_name,
    builder_version,
    source_fingerprint,
    relations_last_built
  )
  select
    selected_library_id,
    rows.normalized_artist_key,
    rows.canonical_artist_name,
    projection_builder_version,
    projection_source_fingerprint,
    projection_relations_last_built
  from jsonb_to_recordset(projection_rows) as rows(
    normalized_artist_key text,
    canonical_artist_name text
  )
  on conflict (library_id, normalized_artist_key) do update
  set canonical_artist_name = excluded.canonical_artist_name,
      builder_version = excluded.builder_version,
      source_fingerprint = excluded.source_fingerprint,
      relations_last_built = excluded.relations_last_built
  where library.local_artist_search_projection_current_entries.canonical_artist_name
          is distinct from excluded.canonical_artist_name
     or library.local_artist_search_projection_current_entries.builder_version
          is distinct from excluded.builder_version;
  get diagnostics upserted_row_count = row_count;

  return deleted_row_count + upserted_row_count;
end;
$$;

revoke all on function library.replace_local_artist_search_projection_current(jsonb,text,text,double precision),
    library.patch_local_artist_search_projection_current(text[],jsonb,text,text,double precision) from public;
do $$
begin
    if exists(select 1 from pg_roles where rolname='album_haven_app') then
        grant select on library.local_artist_search_projection_current to album_haven_app;
        grant execute on function library.replace_local_artist_search_projection_current(jsonb,text,text,double precision),
            library.patch_local_artist_search_projection_current(text[],jsonb,text,text,double precision) to album_haven_app;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
        grant select on library.local_artist_search_projection_current to album_haven_readonly;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
        grant all privileges on library.local_artist_search_projection_current_entries to album_haven_migrator;
        grant select on library.local_artist_search_projection_current to album_haven_migrator;
        grant execute on function library.replace_local_artist_search_projection_current(jsonb,text,text,double precision),
            library.patch_local_artist_search_projection_current(text[],jsonb,text,text,double precision) to album_haven_migrator;
    end if;
end;
$$;

-- Current readers retain the last proven current contract during legacy replay.
create or replace function library.local_relation_views(selected_library_id bigint, normalized_only boolean default false)
returns jsonb language sql stable parallel safe
set search_path=pg_catalog as $$
  select case when normalized_only or exists(
    select 1 from library.local_relation_projection_state state
    join library.local_relation_compatibility_state compatibility using(library_id)
    where state.library_id=selected_library_id
      and compatibility.current_semantics='current-v11-explicit-collaboration'
      and compatibility.legacy_semantics='legacy-v11-broad-aliases'
      and compatibility.source_fingerprint=state.source_fingerprint
      and compatibility.last_publication_xid=state.last_publication_xid
  ) then jsonb_build_object(
    'artists', coalesce((select jsonb_agg(payload order by sort_key collate "C", entry_key collate "C")
      from library.local_relation_projection_entries where library_id=selected_library_id and section='artists'), '[]'::jsonb),
    'artists_sidebar', coalesce((select jsonb_agg(payload order by sort_key collate "C", entry_key collate "C")
      from library.local_relation_projection_entries where library_id=selected_library_id and section='artists_sidebar'), '[]'::jsonb),
    'sidebar_families', coalesce((select jsonb_agg(payload order by sort_key collate "C", entry_key collate "C")
      from library.local_relation_projection_entries where library_id=selected_library_id and section='sidebar_families'), '[]'::jsonb),
    'alias_to_canonical', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_projection_entries where library_id=selected_library_id and section='alias_to_canonical'), '{}'::jsonb),
    'canonical_to_aliases', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_projection_entries where library_id=selected_library_id and section='canonical_to_aliases'), '{}'::jsonb),
    'family_to_artists', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_projection_entries where library_id=selected_library_id and section='family_to_artists'), '{}'::jsonb),
    'folder_related', coalesce((select jsonb_object_agg(entry_key,payload)
      from library.local_relation_projection_entries where library_id=selected_library_id and section='folder_related'), '{}'::jsonb)
  )
  when exists(select 1 from library.local_relation_projection_state where library_id=selected_library_id) then null
  else (select metadata #> '{scan_cache,relation_views}' from library.libraries where id=selected_library_id) end;
$$;

-- Old readers treat unknown provenance as manual, so automatic current links
-- require physical isolation. Manual links remain in their existing owner.
create table library.local_artist_family_links_current (
    like library.local_artist_family_links including all,
    foreign key (library_id) references library.libraries(id) on delete cascade,
    foreign key (artist_id) references library.local_artists(id) on delete cascade,
    foreign key (related_artist_id) references library.local_artists(id) on delete cascade
);
do $$
begin
    if exists(select 1 from pg_roles where rolname='album_haven_app') then
        grant select, insert, update, delete on library.local_artist_family_links_current to album_haven_app;
        grant usage, select on sequence library.local_artist_family_links_current_id_seq to album_haven_app;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
        grant select on library.local_artist_family_links_current to album_haven_readonly;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
        grant select, insert, update, delete on library.local_artist_family_links_current to album_haven_migrator;
        grant usage, select on sequence library.local_artist_family_links_current_id_seq to album_haven_migrator;
    end if;
end;
$$;

create or replace function library.capture_gallery_metadata_changes()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare selected record; source_id bigint; selected_library bigint; names text[];
begin
  if tg_table_name in ('local_artists','library_roots') then
    if tg_op='UPDATE' and library.gallery_source_dependency(tg_table_name,to_jsonb(old))
      is not distinct from library.gallery_source_dependency(tg_table_name,to_jsonb(new)) then return null; end if;
    source_id:=case when tg_op='DELETE' then old.id else new.id end;
    selected_library:=case when tg_op='DELETE' then old.library_id else new.library_id end;
    if tg_table_name='local_artists' then
      if exists(select 1 from library.local_albums where artist_id=source_id)
        or exists(select 1 from library.local_tracks where artist_id=source_id)
        or exists(select 1 from library.local_album_featured_artists where artist_id=source_id) then return null; end if;
    else
      if exists(select 1 from library.local_track_files where library_root_id=source_id) then return null; end if;
    end if;
    perform library.mark_relation_album_dirty(selected_library,0);
    return null;
  end if;
  if library.gallery_source_dependency('libraries',to_jsonb(old))
    is not distinct from library.gallery_source_dependency('libraries',to_jsonb(new)) then return null; end if;
  -- A dual publisher writes its exact legacy contract after publishing both
  -- normalized and compatibility state in this transaction. Do not journal
  -- that proven bridge write as a new unknown legacy publication. Existing
  -- journal rows remain untouched and retain their original provenance.
  if (old.owner_account_id,old.name,old.library_kind) is not distinct from
       (new.owner_account_id,new.name,new.library_kind)
    and old.metadata #> '{scan_cache,relations_last_built}' is not distinct from new.metadata #> '{scan_cache,relations_last_built}'
    and new.metadata #>> '{scan_cache,relation_projection,status}' = 'ready'
    and exists (
      select 1 from library.local_relation_projection_state state
      join library.local_relation_compatibility_state compatibility on compatibility.library_id=state.library_id
      where state.library_id=new.id
        and state.last_publication_xid=pg_current_xact_id()
        and compatibility.last_publication_xid=state.last_publication_xid
        and state.builder_version=new.metadata #>> '{scan_cache,relation_projection,builder_version}'
        and state.source_fingerprint=new.metadata #>> '{scan_cache,relation_projection,source_fingerprint}'
        and state.source_fingerprint=new.metadata #>> '{scan_cache,relation_projection,built_from_fingerprint}'
        and compatibility.source_fingerprint=state.source_fingerprint
        and compatibility.legacy_semantics='legacy-v11-broad-aliases'
        and compatibility.current_semantics='current-v11-explicit-collaboration'
        and compatibility.pending_scan_receipt is null
        and compatibility.pending_scan_xid is null
        and to_jsonb(compatibility.relations_last_built)=new.metadata #> '{scan_cache,relations_last_built}'
    )
    and new.metadata #> '{scan_cache,relation_views}' = library.local_relation_compatibility_views(new.id)
    then return null;
  end if;

  -- Exempt only the exact normalized contract published by this transaction.
  -- Legacy writers do not set this marker. Xid8 remains safe across xid wrap,
  -- and records top-level ownership even when publication uses a savepoint.
  if (old.owner_account_id,old.name,old.library_kind) is not distinct from
      (new.owner_account_id,new.name,new.library_kind)
    and old.metadata #> '{scan_cache,relations_last_built}' is not distinct from new.metadata #> '{scan_cache,relations_last_built}'
    and new.metadata #>> '{scan_cache,relation_projection,status}'='ready'
    and jsonb_typeof(new.metadata #> '{scan_cache,relation_views,family_to_artists}')='object'
    and jsonb_typeof(new.metadata #> '{scan_cache,relation_views,folder_related}')='object'
    and jsonb_typeof(new.metadata #> '{scan_cache,relation_views,artists}')='array'
    and jsonb_typeof(new.metadata #> '{scan_cache,relation_views,artists_sidebar}')='array'
    and jsonb_typeof(new.metadata #> '{scan_cache,relation_views,sidebar_families}')='array'
    and exists(select 1 from library.local_relation_projection_state state
      where state.library_id=new.id and state.last_publication_xid=pg_current_xact_id()
        and state.builder_version=new.metadata #>> '{scan_cache,relation_projection,builder_version}'
        and state.source_fingerprint=new.metadata #>> '{scan_cache,relation_projection,source_fingerprint}'
        and state.source_fingerprint=new.metadata #>> '{scan_cache,relation_projection,built_from_fingerprint}')
    and new.metadata #> '{scan_cache,relation_views}' = library.local_relation_views(new.id,true)
    then return null;
  end if;
  perform library.mark_relation_album_dirty(new.id,0);
  -- Non-normalized alias/readiness publications must be checked as a complete
  -- legacy contract by background replay. They are never an empty foreground
  -- change merely because this transaction also edited one album.
  if old.metadata #> '{scan_cache,relations_last_built}' is distinct from new.metadata #> '{scan_cache,relations_last_built}'
    or old.metadata #> '{scan_cache,relation_views,alias_to_canonical}' is distinct from new.metadata #> '{scan_cache,relation_views,alias_to_canonical}'
    or old.metadata #> '{scan_cache,relation_views,canonical_to_aliases}' is distinct from new.metadata #> '{scan_cache,relation_views,canonical_to_aliases}' then
    perform library.mark_relation_album_dirty(new.id,-1);
  end if;
  if (old.owner_account_id,old.name,old.library_kind,
       old.metadata #> '{scan_cache,relation_projection,builder_version}')
    is distinct from (new.owner_account_id,new.name,new.library_kind,
       new.metadata #> '{scan_cache,relation_projection,builder_version}')
    or jsonb_typeof(new.metadata #> '{scan_cache,relation_views,alias_to_canonical}') is distinct from 'object'
    or jsonb_typeof(new.metadata #> '{scan_cache,relation_views,canonical_to_aliases}') is distinct from 'object'
    or jsonb_typeof(new.metadata #> '{scan_cache,relation_views,family_to_artists}') is distinct from 'object'
    or jsonb_typeof(new.metadata #> '{scan_cache,relation_views,folder_related}') is distinct from 'object'
    or jsonb_typeof(new.metadata #> '{scan_cache,relation_views,artists}') is distinct from 'array'
    or jsonb_typeof(new.metadata #> '{scan_cache,relation_views,artists_sidebar}') is distinct from 'array'
    or jsonb_typeof(new.metadata #> '{scan_cache,relation_views,sidebar_families}') is distinct from 'array' then
    perform library.mark_relation_album_dirty(new.id,-1);
    return null;
  end if;
  -- An unrelated fingerprint cannot be justified by some dirty album rows.
  -- An explicit full initializer owns that unproven source contract.
  if not exists(select 1 from library.local_relation_projection_state state
        where state.library_id=new.id
          and state.source_fingerprint=new.metadata #>> '{scan_cache,relation_projection,source_fingerprint}'
          and state.source_fingerprint=new.metadata #>> '{scan_cache,relation_projection,built_from_fingerprint}')
    or (not exists(select 1 from library.local_relation_dirty_albums where library_id=new.id and album_id>0)
      and new.metadata #>> '{scan_cache,relation_projection,status}' is distinct from 'ready') then
    perform library.mark_relation_album_dirty(new.id,-1);
  end if;
  select array_agg(distinct name) into names from (
    select coalesce(before.key,after.key) as name
    from jsonb_each(case when jsonb_typeof(old.metadata #> '{scan_cache,relation_views,alias_to_canonical}')='object' then old.metadata #> '{scan_cache,relation_views,alias_to_canonical}' else '{}'::jsonb end) before
    full join jsonb_each(new.metadata #> '{scan_cache,relation_views,alias_to_canonical}') after using(key)
    where before.value is distinct from after.value
    union
    select jsonb_array_elements_text(value) from (
      select before.value from jsonb_each(case when jsonb_typeof(old.metadata #> '{scan_cache,relation_views,canonical_to_aliases}')='object' then old.metadata #> '{scan_cache,relation_views,canonical_to_aliases}' else '{}'::jsonb end) before
      full join jsonb_each(new.metadata #> '{scan_cache,relation_views,canonical_to_aliases}') after using(key)
      where before.value is distinct from after.value and jsonb_typeof(before.value)='array'
      union all
      select after.value from jsonb_each(case when jsonb_typeof(old.metadata #> '{scan_cache,relation_views,canonical_to_aliases}')='object' then old.metadata #> '{scan_cache,relation_views,canonical_to_aliases}' else '{}'::jsonb end) before
      full join jsonb_each(new.metadata #> '{scan_cache,relation_views,canonical_to_aliases}') after using(key)
      where before.value is distinct from after.value and jsonb_typeof(after.value)='array'
    ) changed_arrays
  ) changed_names;
  for selected in
    select albums.id as album_id from library.local_artists artists join library.local_albums albums on albums.artist_id=artists.id
      where artists.library_id=new.id and artists.name=any(names)
    union select tracks.album_id from library.local_artists artists join library.local_tracks tracks on tracks.artist_id=artists.id
      where artists.library_id=new.id and artists.name=any(names)
    union select featured.album_id from library.local_artists artists join library.local_album_featured_artists featured on featured.artist_id=artists.id
      where artists.library_id=new.id and artists.name=any(names)
  loop perform library.mark_relation_album_dirty(new.id,selected.album_id); end loop;
  return null;
end $$;
