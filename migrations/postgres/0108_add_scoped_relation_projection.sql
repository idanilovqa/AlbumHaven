create table library.local_relation_album_facts (
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_id bigint not null,
  album_key text not null,
  source_rows jsonb not null check (jsonb_typeof(source_rows) = 'array'),
  connection_keys text[] not null,
  low_value_keys text[] not null,
  low_value_artists jsonb not null check (jsonb_typeof(low_value_artists) = 'array'),
  primary key (library_id, album_id)
);
create index local_relation_album_key_idx on library.local_relation_album_facts (library_id, album_key);
create index local_relation_connections_idx on library.local_relation_album_facts using gin (connection_keys);
create index local_relation_low_value_idx on library.local_relation_album_facts using gin (low_value_keys);

create table library.local_relation_projection_entries (
  library_id bigint not null references library.libraries(id) on delete cascade,
  section text not null check (section in (
    'artists', 'artists_sidebar', 'alias_to_canonical', 'canonical_to_aliases',
    'family_to_artists', 'folder_related', 'sidebar_families'
  )),
  entry_key text not null,
  payload jsonb not null,
  sort_key text not null,
  artist_names text[] not null,
  connection_keys text[] not null,
  low_value_keys text[] not null,
  primary key (library_id, section, entry_key)
);
create index local_relation_entry_artists_idx on library.local_relation_projection_entries using gin (artist_names);
create index local_relation_entry_connections_idx on library.local_relation_projection_entries using gin (connection_keys);
create index local_relation_entry_low_values_idx on library.local_relation_projection_entries using gin (low_value_keys);

create table library.local_relation_projection_state (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  builder_version text not null,
  source_fingerprint text not null,
  initialized_at timestamptz not null default now()
);

create table library.local_relation_dirty_albums (
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_id bigint not null,
  album_keys text[] not null default '{}',
  first_inventory_revision bigint not null,
  first_gallery_generation bigint,
  primary key(library_id,album_id)
);

create function library.mark_relation_album_dirty(selected_library_id bigint, selected_album_id bigint, previous_key text default null)
returns void language sql security definer set search_path=pg_catalog as $$
  insert into library.local_relation_dirty_albums
    (library_id,album_id,album_keys,first_inventory_revision,first_gallery_generation)
  -- Zero explicitly journals detached-track changes; it never represents an album.
  select libraries.id,coalesce(selected_album_id,0),
    array(select distinct key from unnest(array[previous_key,albums.album_key]) key where key is not null),
    coalesce(nullif(libraries.metadata->>'inventory_mutation_revision','')::bigint,0),
    state.generation - case when state.last_invalidation_xid=pg_current_xact_id() then 1 else 0 end
  from library.libraries
  left join library.local_albums albums on albums.library_id=libraries.id and albums.id=selected_album_id
  left join library.gallery_projection_state state on state.library_id=libraries.id
  where libraries.id=selected_library_id
  on conflict(library_id,album_id) do update set
    album_keys=array(select distinct key from unnest(library.local_relation_dirty_albums.album_keys || excluded.album_keys) key),
    first_inventory_revision=least(library.local_relation_dirty_albums.first_inventory_revision,excluded.first_inventory_revision),
    first_gallery_generation=least(library.local_relation_dirty_albums.first_gallery_generation,excluded.first_gallery_generation);
$$;

create function library.capture_relation_album_changes()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare selected record;
begin
  if tg_table_name='local_albums' then
    if tg_op='UPDATE' and (old.artist_id,old.album_key,old.title,old.release_year,old.cover_path,old.metadata)
      is not distinct from (new.artist_id,new.album_key,new.title,new.release_year,new.cover_path,new.metadata) then return null; end if;
    if tg_op<>'INSERT' then perform library.mark_relation_album_dirty(old.library_id,old.id,old.album_key); end if;
    if tg_op<>'DELETE' then perform library.mark_relation_album_dirty(new.library_id,new.id,new.album_key); end if;
  elsif tg_table_name='local_tracks' then
    if tg_op='UPDATE' and (old.album_id,old.artist_id,old.title,old.disc_number,old.track_number,old.duration_seconds,old.metadata)
      is not distinct from (new.album_id,new.artist_id,new.title,new.disc_number,new.track_number,new.duration_seconds,new.metadata) then return null; end if;
    if tg_op<>'INSERT' then perform library.mark_relation_album_dirty(old.library_id,old.album_id); end if;
    if tg_op<>'DELETE' then perform library.mark_relation_album_dirty(new.library_id,new.album_id); end if;
  elsif tg_table_name='local_track_files' then
    if tg_op='UPDATE' and (old.track_id,old.library_root_id,old.private_path,old.relative_path,old.scan_cache_stale,old.metadata)
      is not distinct from (new.track_id,new.library_root_id,new.private_path,new.relative_path,new.scan_cache_stale,new.metadata) then return null; end if;
    for selected in select library_id,album_id from library.local_tracks
      where id=any(case when tg_op='INSERT' then array[new.track_id] when tg_op='DELETE' then array[old.track_id] else array[old.track_id,new.track_id] end)
    loop perform library.mark_relation_album_dirty(selected.library_id,selected.album_id); end loop;
  elsif tg_table_name='local_album_featured_artists' then
    if tg_op='UPDATE' and (old.album_id,old.artist_id,old.featured_kind,old.metadata->'relation_evidence_kind')
      is not distinct from (new.album_id,new.artist_id,new.featured_kind,new.metadata->'relation_evidence_kind') then return null; end if;
    if tg_op<>'INSERT' then perform library.mark_relation_album_dirty(old.library_id,old.album_id); end if;
    if tg_op<>'DELETE' then perform library.mark_relation_album_dirty(new.library_id,new.album_id); end if;
  elsif tg_table_name='exception_overrides' then
    if tg_op='UPDATE' and library.gallery_source_dependency(tg_table_name,to_jsonb(old))
      is not distinct from library.gallery_source_dependency(tg_table_name,to_jsonb(new)) then return null; end if;
    for selected in select tracks.library_id,tracks.album_id from library.local_tracks tracks
      where (tg_op<>'INSERT' and tracks.library_id=old.library_id
        and (tracks.id=old.track_id or tracks.track_key=old.track_key))
        or (tg_op<>'DELETE' and tracks.library_id=new.library_id
        and (tracks.id=new.track_id or tracks.track_key=new.track_key))
    loop perform library.mark_relation_album_dirty(selected.library_id,selected.album_id); end loop;
  elsif tg_table_name='local_artists' then
    if tg_op='UPDATE' and (old.name,old.artist_key,old.sort_name) is not distinct from (new.name,new.artist_key,new.sort_name) then return null; end if;
    for selected in select library_id,id as album_id from library.local_albums
      where artist_id=case when tg_op='DELETE' then old.id else new.id end
      union select library_id,album_id from library.local_tracks where artist_id=case when tg_op='DELETE' then old.id else new.id end
      union select library_id,album_id from library.local_album_featured_artists where artist_id=case when tg_op='DELETE' then old.id else new.id end
    loop perform library.mark_relation_album_dirty(selected.library_id,selected.album_id); end loop;
  elsif tg_table_name='library_roots' then
    if tg_op='UPDATE' and (old.root_kind,old.root_path,old.is_active) is not distinct from (new.root_kind,new.root_path,new.is_active) then return null; end if;
    for selected in select distinct tracks.library_id,tracks.album_id from library.local_tracks tracks
      join library.local_track_files files on files.track_id=tracks.id
      where files.library_root_id=case when tg_op='DELETE' then old.id else new.id end
    loop perform library.mark_relation_album_dirty(selected.library_id,selected.album_id); end loop;
  end if;
  return null;
end $$;

create trigger local_albums_relation_dirty after insert or update or delete on library.local_albums
  for each row execute function library.capture_relation_album_changes();
create trigger local_tracks_relation_dirty after insert or update or delete on library.local_tracks
  for each row execute function library.capture_relation_album_changes();
create trigger local_files_relation_dirty after insert or update or delete on library.local_track_files
  for each row execute function library.capture_relation_album_changes();
create trigger local_featured_relation_dirty after insert or update or delete on library.local_album_featured_artists
  for each row execute function library.capture_relation_album_changes();
create trigger exception_overrides_relation_dirty after insert or update or delete on library.exception_overrides
  for each row execute function library.capture_relation_album_changes();
create trigger local_artists_relation_dirty after update or delete on library.local_artists
  for each row execute function library.capture_relation_album_changes();
create trigger library_roots_relation_dirty after update or delete on library.library_roots
  for each row execute function library.capture_relation_album_changes();

-- Full-view readers share one compatibility boundary while writers patch rows.
create function library.local_relation_views(selected_library_id bigint, normalized_only boolean default false)
returns jsonb language sql stable parallel safe
set search_path = pg_catalog
as $$
  select case when normalized_only or (exists (
    select 1 from library.local_relation_projection_state state join library.libraries libraries on libraries.id=state.library_id
    where state.library_id = selected_library_id
      and state.builder_version=libraries.metadata #>> '{scan_cache,relation_projection,builder_version}'
      and state.source_fingerprint=libraries.metadata #>> '{scan_cache,relation_projection,source_fingerprint}'
  ) and not exists(select 1 from library.local_relation_dirty_albums where library_id=selected_library_id)) then jsonb_build_object(
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
  ) else (select metadata #> '{scan_cache,relation_views}' from library.libraries where id=selected_library_id) end;
$$;

revoke all on function library.local_relation_views(bigint,boolean), library.mark_relation_album_dirty(bigint,bigint,text), library.capture_relation_album_changes() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    grant select, insert, update, delete on library.local_relation_album_facts,
      library.local_relation_projection_entries, library.local_relation_projection_state, library.local_relation_dirty_albums to album_haven_app;
    grant execute on function library.local_relation_views(bigint,boolean) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    grant select on library.local_relation_album_facts,
      library.local_relation_projection_entries, library.local_relation_projection_state, library.local_relation_dirty_albums to album_haven_readonly;
    grant execute on function library.local_relation_views(bigint,boolean) to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all privileges on library.local_relation_album_facts,
      library.local_relation_projection_entries, library.local_relation_projection_state, library.local_relation_dirty_albums to album_haven_migrator;
    grant execute on function library.local_relation_views(bigint,boolean) to album_haven_migrator;
  end if;
end $$;
