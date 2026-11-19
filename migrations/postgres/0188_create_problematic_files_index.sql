-- Problematic Files reads from a persisted per-album index instead of a
-- whole-library candidate pass (22-55 s on a 160k-file library after every
-- restart). It is derived output only: rows are rebuilt from library data and
-- never read back as user intent.
--
-- 1. problematic_index_items: one row per listed item (album, loose-track group
--    or missing album) with its sort keys and search text, so the first page,
--    later pages and search are keyset reads.
-- 2. problematic_index_dirty_albums: albums whose items may have changed since
--    they were evaluated. The existing relation journal function marks them for
--    every album, track, file, artist, root and exception-override change, so a
--    save gains no new trigger on those tables. Album 0 marks detached tracks.
--    A mark is cleared only by the evaluator that read it (marked_xid).
-- 3. problematic_index_state: the builder version an index was filled by; the
--    application backfills when it is missing or different.

create table if not exists library.problematic_index_state (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  builder_version text not null,
  status text not null check (status in ('building', 'ready')),
  updated_at timestamptz not null default now()
);

create table if not exists library.problematic_index_items (
  library_id bigint not null references library.libraries(id) on delete cascade,
  item_key text not null,
  album_id bigint,
  sort_name text collate "C" not null,
  sort_artist text collate "C" not null,
  sort_year text collate "C" not null,
  sort_key text collate "C" not null,
  search_text text not null,
  duplicate_identities text[] not null default '{}',
  item jsonb not null check (jsonb_typeof(item) = 'object'),
  primary key (library_id, item_key)
);
create index if not exists problematic_index_items_order_idx
  on library.problematic_index_items (library_id, sort_name, sort_artist, sort_year, sort_key);
create index if not exists problematic_index_items_album_idx
  on library.problematic_index_items (library_id, album_id);
create index if not exists problematic_index_items_identity_idx
  on library.problematic_index_items using gin (duplicate_identities);

create table if not exists library.problematic_index_dirty_albums (
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_id bigint not null,
  marked_xid xid8 not null default pg_current_xact_id(),
  primary key (library_id, album_id)
);

create or replace function library.mark_problematic_album_dirty(selected_library_id bigint, selected_album_id bigint)
returns void language sql security definer set search_path = pg_catalog as $$
  insert into library.problematic_index_dirty_albums (library_id, album_id)
  select selected_library_id, coalesce(selected_album_id, 0)
  where selected_library_id is not null
  on conflict (library_id, album_id) do update set marked_xid = excluded.marked_xid
    where library.problematic_index_dirty_albums.marked_xid is distinct from excluded.marked_xid;
$$;

-- 0186's body with the Problematic Files mark first (before its early return).
create or replace function library.mark_relation_album_dirty(
  selected_library_id bigint, selected_album_id bigint, previous_key text default null
) returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform library.mark_problematic_album_dirty(selected_library_id, selected_album_id);
  update library.local_relation_dirty_albums dirty
    set album_keys=array(select distinct key from unnest(dirty.album_keys || array[previous_key,
      (select albums.album_key from library.local_albums albums
        where albums.library_id=selected_library_id and albums.id=selected_album_id)]) key
      where key is not null)
    where dirty.library_id=selected_library_id and dirty.album_id=coalesce(selected_album_id,0)
      and dirty.first_gallery_generation is not null;
  if found then return; end if;
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
end $$;

-- Two more inputs of the list: the app rating compared with the file rating tag,
-- and the Spotify cover-quota outcome of an album.
create or replace function library.capture_problematic_input_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare selected record;
begin
  if tg_table_name = 'album_ratings' then
    if tg_op = 'UPDATE' and (old.library_id, old.album_key, old.rating, old.account_id)
      is not distinct from (new.library_id, new.album_key, new.rating, new.account_id) then return null; end if;
    for selected in select albums.library_id, albums.id from library.local_albums albums
      where (tg_op <> 'INSERT' and albums.library_id = old.library_id and albums.album_key = old.album_key)
         or (tg_op <> 'DELETE' and albums.library_id = new.library_id and albums.album_key = new.album_key)
    loop perform library.mark_problematic_album_dirty(selected.library_id, selected.id); end loop;
  else
    if tg_op = 'UPDATE' and (old.library_id, old.task_key, old.status, old.metadata)
      is not distinct from (new.library_id, new.task_key, new.status, new.metadata) then return null; end if;
    for selected in select albums.library_id, albums.id from library.local_albums albums
      where (tg_op <> 'INSERT' and old.task_key ~ '^[0-9]+:search_spotify$'
             and albums.library_id = old.library_id and albums.id = split_part(old.task_key, ':', 1)::bigint)
         or (tg_op <> 'DELETE' and new.task_key ~ '^[0-9]+:search_spotify$'
             and albums.library_id = new.library_id and albums.id = split_part(new.task_key, ':', 1)::bigint)
    loop perform library.mark_problematic_album_dirty(selected.library_id, selected.id); end loop;
  end if;
  return null;
end $$;

drop trigger if exists album_ratings_problematic_dirty on app.album_ratings;
create trigger album_ratings_problematic_dirty after insert or update or delete on app.album_ratings
  for each row execute function library.capture_problematic_input_changes();
drop trigger if exists cover_lookup_tasks_problematic_dirty on ops.cover_lookup_tasks;
create trigger cover_lookup_tasks_problematic_dirty after insert or update or delete on ops.cover_lookup_tasks
  for each row execute function library.capture_problematic_input_changes();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.problematic_index_state, library.problematic_index_items,
      library.problematic_index_dirty_albums to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.problematic_index_state, library.problematic_index_items,
      library.problematic_index_dirty_albums to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.problematic_index_state, library.problematic_index_items,
      library.problematic_index_dirty_albums to album_haven_migrator;
  end if;
end $$;
