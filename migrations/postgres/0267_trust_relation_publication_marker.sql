-- 0267 (owner go, 2026-11-21; freeze-guard backlog case 29): a save that changes artist relations no
-- longer rebuilds the whole library's legacy relation views twice. The publisher patches only the
-- compatibility entries it changed (library.patch_relation_compatibility_views) and records the md5 of
-- the views it wrote as a transaction-local setting. With this transaction's publication marker, the
-- libraries trigger accepts a stored copy matching that md5 instead of comparing it with a full
-- library.local_relation_compatibility_views rebuild; any other write keeps the full comparison.

-- Returns the stored legacy views with the touched compatibility entries brought up to date, or null
-- when the stored copy does not match the entries closely enough to patch (the caller then copies the
-- full views). touched is a JSON array of {"section", "entry_key"} objects.
create or replace function library.patch_relation_compatibility_views(
  selected_library_id bigint, stored_views jsonb, touched jsonb
) returns jsonb language plpgsql volatile set search_path = pg_catalog as $$
declare
  views jsonb := stored_views;
  section_name text;
  member text;
  touched_keys text[];
  entry record;
  map_payload jsonb;
  elements jsonb;
  low integer;
  high integer;
  middle integer;
  middle_key text;
  middle_sort text;
begin
  if jsonb_typeof(views) is distinct from 'object' then return null; end if;
  foreach section_name in array array['alias_to_canonical','canonical_to_aliases','family_to_artists','folder_related'] loop
    if jsonb_typeof(views -> section_name) is distinct from 'object' then return null; end if;
    for entry in select distinct touched_entry.entry_key
        from jsonb_to_recordset(touched) touched_entry(section text, entry_key text)
        where touched_entry.section = section_name loop
      select compatibility.payload into map_payload from library.local_relation_compatibility_entries compatibility
        where compatibility.library_id = selected_library_id and compatibility.section = section_name
          and compatibility.entry_key = entry.entry_key;
      if found then
        views := jsonb_set(views, array[section_name, entry.entry_key], map_payload, true);
      else
        views := views #- array[section_name, entry.entry_key];
      end if;
    end loop;
  end loop;
  foreach section_name in array array['artists','artists_sidebar','sidebar_families'] loop
    if jsonb_typeof(views -> section_name) is distinct from 'array' then return null; end if;
    member := case section_name when 'artists_sidebar' then 'artist' when 'sidebar_families' then 'family' end;
    select array_agg(distinct touched_entry.entry_key) into touched_keys
      from jsonb_to_recordset(touched) touched_entry(section text, entry_key text)
      where touched_entry.section = section_name;
    if touched_keys is null then continue; end if;
    elements := coalesce((select jsonb_agg(element order by position)
      from jsonb_array_elements(views -> section_name) with ordinality stored(element, position)
      where not (case when member is null then element #>> '{}' else element ->> member end) = any(touched_keys)), '[]'::jsonb);
    -- Untouched entries keep their stored order; each current touched entry goes in at its sorted place.
    for entry in select compatibility.entry_key, compatibility.sort_key, compatibility.payload
        from library.local_relation_compatibility_entries compatibility
        where compatibility.library_id = selected_library_id and compatibility.section = section_name
          and compatibility.entry_key = any(touched_keys)
        order by compatibility.sort_key collate "C", compatibility.entry_key collate "C" loop
      low := 0;
      high := jsonb_array_length(elements);
      while low < high loop
        middle := (low + high) / 2;
        middle_key := case when member is null then elements -> middle #>> '{}' else elements -> middle ->> member end;
        select compatibility.sort_key into middle_sort from library.local_relation_compatibility_entries compatibility
          where compatibility.library_id = selected_library_id and compatibility.section = section_name
            and compatibility.entry_key = middle_key;
        if not found then return null; end if;
        if middle_sort collate "C" < entry.sort_key collate "C"
            or (middle_sort = entry.sort_key and middle_key collate "C" < entry.entry_key collate "C") then
          low := middle + 1;
        else
          high := middle;
        end if;
      end loop;
      elements := jsonb_insert(elements, array[low::text], entry.payload);
    end loop;
    views := jsonb_set(views, array[section_name], elements);
  end loop;
  perform set_config('album_haven.relation_views_publication', md5(views::text), true);
  return views;
end $$;

revoke all on function library.patch_relation_compatibility_views(bigint, jsonb, jsonb) from public;
do $$
begin
    if exists(select 1 from pg_roles where rolname='album_haven_app') then
        grant execute on function library.patch_relation_compatibility_views(bigint, jsonb, jsonb) to album_haven_app;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
        grant execute on function library.patch_relation_compatibility_views(bigint, jsonb, jsonb) to album_haven_migrator;
    end if;
end;
$$;

-- 0111's trigger body; only the dual-publisher exemption changes (marked below).
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
    -- 0267: a copy this transaction's publisher patched from the same compatibility entries is
    -- proven by its md5; anything else is still compared with the full compatibility views.
    and case when md5((new.metadata #> '{scan_cache,relation_views}')::text)
          = coalesce(current_setting('album_haven.relation_views_publication', true), '')
        then true
        else new.metadata #> '{scan_cache,relation_views}' = library.local_relation_compatibility_views(new.id) end
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
