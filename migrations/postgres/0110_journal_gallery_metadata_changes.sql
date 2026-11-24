-- Preserve applied migration history. Diagnostics never change gallery membership.
alter table library.local_relation_projection_state add column last_publication_xid xid8;
-- Existing rows retain unknown provenance. Only later inserts identify their
-- transaction; conflict updates must preserve the first writer's evidence.
alter table library.local_relation_dirty_albums add column first_change_xid xid8;
alter table library.local_relation_dirty_albums alter column first_change_xid set default pg_current_xact_id();
create or replace function library.gallery_source_dependency(source_table text, source_row jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select case source_table
    when 'local_albums' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'artist_id',
      source_row -> 'album_key',
      source_row -> 'title',
      source_row -> 'release_year',
      source_row #> '{metadata,root_provenance}',
      source_row #> '{metadata,album_artist}',
      source_row #> '{metadata,artists}',
      source_row #> '{metadata,is_compilation}',
      source_row #> '{metadata,relation_evidence_kind}')
    when 'local_artists' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'artist_key',
      source_row -> 'name',
      source_row -> 'sort_name')
    when 'local_album_featured_artists' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'album_id',
      source_row -> 'artist_id',
      source_row -> 'featured_kind',
      source_row #> '{metadata,relation_evidence_kind}')
    when 'local_tracks' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'album_id',
      source_row -> 'artist_id')
    when 'local_track_files' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'track_id',
      source_row -> 'library_root_id',
      source_row -> 'private_path',
      source_row -> 'relative_path',
      source_row -> 'scan_cache_stale',
      source_row #> '{metadata,scan_cache,file_entry,exception_type}')
    when 'exception_overrides' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'track_id',
      source_row -> 'track_key',
      (source_row -> 'override_payload') ? 'exception_type',
      source_row #> '{override_payload,exception_type}')
    when 'library_roots' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'library_id',
      source_row -> 'root_path',
      source_row -> 'root_kind',
      source_row -> 'is_active')
    when 'libraries' then jsonb_build_array(
      source_row -> 'id',
      source_row -> 'owner_account_id',
      source_row -> 'name',
      source_row -> 'library_kind',
      jsonb_build_array(
        source_row #> '{metadata,scan_cache,relation_projection,status}',
        source_row #> '{metadata,scan_cache,relation_projection,builder_version}',
        source_row #> '{metadata,scan_cache,relation_projection,source_fingerprint}',
        source_row #> '{metadata,scan_cache,relation_projection,built_from_fingerprint}'),
      source_row #> '{metadata,scan_cache,relations_last_built}',
      source_row #> '{metadata,scan_cache,relation_views,alias_to_canonical}',
      source_row #> '{metadata,scan_cache,relation_views,canonical_to_aliases}',
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,family_to_artists}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,folder_related}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,artists}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,artists_sidebar}'),
      jsonb_typeof(source_row #> '{metadata,scan_cache,relation_views,sidebar_families}'))
    else source_row
  end;
$$;
revoke all on function library.gallery_source_dependency(text, jsonb) from public;

-- Album zero already represents source changes with no album membership.
-- Record that evidence for ownerless artists/roots and metadata-only changes,
-- rather than leaving a hole in the generation journal.
create function library.capture_gallery_metadata_changes()
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
    and new.metadata #> '{scan_cache,relation_views,alias_to_canonical}' = coalesce((
      select jsonb_object_agg(entry_key,payload) from library.local_relation_projection_entries
      where library_id=new.id and section='alias_to_canonical'),'{}'::jsonb)
    and new.metadata #> '{scan_cache,relation_views,canonical_to_aliases}' = coalesce((
      select jsonb_object_agg(entry_key,payload) from library.local_relation_projection_entries
      where library_id=new.id and section='canonical_to_aliases'),'{}'::jsonb)
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
revoke all on function library.capture_gallery_metadata_changes() from public;
create trigger libraries_relation_dirty after update on library.libraries
  for each row execute function library.capture_gallery_metadata_changes();
create trigger local_artists_empty_relation_dirty after insert or update or delete on library.local_artists
  for each row execute function library.capture_gallery_metadata_changes();
create trigger library_roots_empty_relation_dirty after insert or update or delete on library.library_roots
  for each row execute function library.capture_gallery_metadata_changes();

