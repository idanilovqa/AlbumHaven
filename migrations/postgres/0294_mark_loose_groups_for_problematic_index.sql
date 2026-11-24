-- 0294_mark_loose_groups_for_problematic_index.sql
-- depends on: 0266_mark_problematic_albums_named_by_rule_keys.sql
-- Problematic Files re-checks a changed loose group, never every loose track.

create table if not exists library.problematic_loose_groups (
  library_id bigint not null references library.libraries(id) on delete cascade,
  item_key text not null,
  root_id bigint not null,
  folder text not null,
  marked_xid xid8,
  primary key (library_id, item_key)
);
create index if not exists problematic_loose_groups_marked_idx
  on library.problematic_loose_groups (library_id, item_key) where marked_xid is not null;

-- Null for an album's item. A drain writes it with a loose item; no save does.
alter table library.problematic_index_items add column if not exists root_id bigint;
create index if not exists problematic_index_items_root_order_idx
  on library.problematic_index_items (library_id, root_id, sort_name, sort_artist, sort_year, sort_key);

create index if not exists local_track_files_loose_group_idx
  on library.local_track_files (library_root_id, scan_physical_parent)
  where scan_cache_stale is false
    and nullif(metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null;

-- An index of the same name may precede this transactional ledger entry.
-- Never accept an invalid or different same-name index as a completed build.
do $check$
declare
  previous_search_path text := current_setting('search_path');
  expected record;
begin
  perform set_config('search_path', 'pg_catalog', true);
  for expected in
    select * from (values
      ('library.local_track_files_loose_group_idx',
       'CREATE INDEX local_track_files_loose_group_idx ON library.local_track_files USING btree (library_root_id, scan_physical_parent) WHERE ((scan_cache_stale IS FALSE) AND (NULLIF((metadata #>> ''{scan_cache,file_entry,local_album_membership_problem}''::text[]), ''''::text) IS NOT NULL))'),
      ('library.problematic_index_items_root_order_idx',
       'CREATE INDEX problematic_index_items_root_order_idx ON library.problematic_index_items USING btree (library_id, root_id, sort_name, sort_artist, sort_year, sort_key)'),
      ('library.problematic_loose_groups_marked_idx',
       'CREATE INDEX problematic_loose_groups_marked_idx ON library.problematic_loose_groups USING btree (library_id, item_key) WHERE (marked_xid IS NOT NULL)')
    ) as indexes(index_name, definition)
  loop
    if not exists (
      select 1 from pg_index
      where indexrelid = to_regclass(expected.index_name)
        and indisvalid and indisready and indislive
        and regexp_replace(pg_get_indexdef(indexrelid), '\s+', ' ', 'g') = expected.definition
    ) then
      raise exception 'Unexpected or invalid loose group index definition: %', expected.index_name;
    end if;
  end loop;
  perform set_config('search_path', previous_search_path, true);
end
$check$;

create or replace function library.problematic_loose_group_key(selected_root_id bigint, selected_folder text)
returns text language sql stable strict set search_path = pg_catalog as $$
  select 'loose-source::' || substr(encode(sha256(convert_to(
    selected_root_id::text || chr(1) || selected_folder, 'UTF8')), 'hex'), 1, 24);
$$;

create or replace function library.mark_problematic_loose_group(selected_root_id bigint, selected_folder text)
returns void language sql security definer set search_path = pg_catalog as $$
  insert into library.problematic_loose_groups (library_id, item_key, root_id, folder, marked_xid)
  select roots.library_id, library.problematic_loose_group_key(roots.id, selected_folder),
    roots.id, selected_folder, pg_current_xact_id()
  from library.library_roots roots
  where roots.id = selected_root_id and selected_folder is not null
  on conflict (library_id, item_key) do update set marked_xid = excluded.marked_xid
    where library.problematic_loose_groups.marked_xid is distinct from excluded.marked_xid;
$$;

create or replace function library.mark_problematic_album_dirty(selected_library_id bigint, selected_album_id bigint)
returns void language sql security definer set search_path = pg_catalog as $$
  insert into library.problematic_index_dirty_albums (library_id, album_id)
  select selected_library_id, selected_album_id
  where selected_library_id is not null and selected_album_id > 0
  on conflict (library_id, album_id) do update set marked_xid = excluded.marked_xid
    where library.problematic_index_dirty_albums.marked_xid is distinct from excluded.marked_xid;
$$;

create or replace function library.capture_loose_file_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if tg_op <> 'INSERT' then
    if old.scan_cache_stale is false and nullif(old.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null then
      perform library.mark_problematic_loose_group(old.library_root_id, old.scan_physical_parent);
    end if;
  end if;
  if tg_op <> 'DELETE' then
    if new.scan_cache_stale is false and nullif(new.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null then
      perform library.mark_problematic_loose_group(new.library_root_id, new.scan_physical_parent);
    end if;
  end if;
  return null;
end $$;

create or replace function library.capture_loose_track_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare selected record;
begin
  for selected in
    select distinct files.library_root_id, files.scan_physical_parent
    from library.local_track_files files
    where files.track_id = new.id and files.scan_cache_stale is false
      and nullif(files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
    order by 1, 2
  loop perform library.mark_problematic_loose_group(selected.library_root_id, selected.scan_physical_parent); end loop;
  return null;
end $$;

create or replace function library.capture_loose_artist_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare selected record;
begin
  for selected in
    select distinct files.library_root_id, files.scan_physical_parent
    from library.local_tracks tracks
    join library.local_track_files files on files.track_id = tracks.id and files.scan_cache_stale is false
    where tracks.artist_id = new.id and tracks.album_id is null
      and nullif(files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
    order by 1, 2
  loop perform library.mark_problematic_loose_group(selected.library_root_id, selected.scan_physical_parent); end loop;
  return null;
end $$;

create or replace function library.capture_loose_rule_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare selected record;
begin
  for selected in
    with rules as (
      select old.library_id as library_id, old.repair_key as repair_key where tg_op <> 'INSERT'
      union
      select new.library_id, new.repair_key where tg_op <> 'DELETE'
    )
    select groups.root_id, groups.folder
    from rules
    join library.problematic_loose_groups groups
      on groups.library_id = rules.library_id
     and groups.item_key = case when strpos(rules.repair_key, '::problem-album::') > 0
       then split_part(rules.repair_key, '::problem-album::', 1) else rules.repair_key end
    union
    select files.library_root_id, files.scan_physical_parent
    from rules
    join library.local_track_files files on files.private_path = split_part(rules.repair_key, '::', 1)
    join library.local_tracks tracks on tracks.id = files.track_id and tracks.library_id = rules.library_id
    where tracks.album_id is null and files.scan_cache_stale is false
      and nullif(files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
    order by 1, 2
  loop perform library.mark_problematic_loose_group(selected.root_id, selected.folder); end loop;
  return null;
end $$;

create or replace function library.capture_loose_override_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare selected record;
begin
  for selected in
    with edited as (
      select old.library_id as library_id, old.track_id as track_id, old.track_key as track_key where tg_op <> 'INSERT'
      union
      select new.library_id, new.track_id, new.track_key where tg_op <> 'DELETE'
    ), edited_files as (
      select files.* from edited
      join library.local_track_files files on files.private_path = edited.track_key
      union all
      select files.* from edited
      join library.local_track_files files on files.track_id = edited.track_id
    )
    select distinct edited_files.library_root_id, edited_files.scan_physical_parent
    from edited_files
    join library.local_tracks tracks on tracks.id = edited_files.track_id and tracks.album_id is null
    where edited_files.scan_cache_stale is false
      and nullif(edited_files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
    order by 1, 2
  loop perform library.mark_problematic_loose_group(selected.library_root_id, selected.scan_physical_parent); end loop;
  return null;
end $$;

drop trigger if exists local_track_files_loose_group_inserted on library.local_track_files;
create trigger local_track_files_loose_group_inserted after insert on library.local_track_files
  for each row
  when (new.scan_cache_stale is false and nullif(new.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null)
  execute function library.capture_loose_file_changes();
drop trigger if exists local_track_files_loose_group_updated on library.local_track_files;
create trigger local_track_files_loose_group_updated after update on library.local_track_files
  for each row
  when (
    ((old.scan_cache_stale is false and nullif(old.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null)
      or (new.scan_cache_stale is false and nullif(new.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null))
    and (old.track_id, old.library_root_id, old.private_path, old.relative_path, old.file_size_bytes,
         old.scan_cache_stale, old.metadata #> '{scan_cache,file_entry}', old.metadata -> 'library_root_category')
      is distinct from (new.track_id, new.library_root_id, new.private_path, new.relative_path, new.file_size_bytes,
         new.scan_cache_stale, new.metadata #> '{scan_cache,file_entry}', new.metadata -> 'library_root_category'))
  execute function library.capture_loose_file_changes();
drop trigger if exists local_track_files_loose_group_deleted on library.local_track_files;
create trigger local_track_files_loose_group_deleted after delete on library.local_track_files
  for each row
  when (old.scan_cache_stale is false and nullif(old.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null)
  execute function library.capture_loose_file_changes();
drop trigger if exists local_tracks_loose_group_dirty on library.local_tracks;
create trigger local_tracks_loose_group_dirty after update on library.local_tracks
  for each row
  when ((old.album_id is null or new.album_id is null)
    and (old.album_id, old.artist_id, old.title, old.disc_number, old.track_number, old.duration_seconds,
         old.metadata -> 'artist', old.metadata -> 'album', old.metadata -> 'album_artist', old.metadata -> 'year')
      is distinct from
        (new.album_id, new.artist_id, new.title, new.disc_number, new.track_number, new.duration_seconds,
         new.metadata -> 'artist', new.metadata -> 'album', new.metadata -> 'album_artist', new.metadata -> 'year'))
  execute function library.capture_loose_track_changes();
drop trigger if exists local_artists_loose_group_dirty on library.local_artists;
create trigger local_artists_loose_group_dirty after update on library.local_artists
  for each row
  when ((old.name, old.sort_name) is distinct from (new.name, new.sort_name))
  execute function library.capture_loose_artist_changes();
drop trigger if exists ignored_repairs_loose_group_dirty on library.ignored_repairs;
create trigger ignored_repairs_loose_group_dirty after insert or update or delete on library.ignored_repairs
  for each row execute function library.capture_loose_rule_changes();
drop trigger if exists exception_overrides_loose_group_dirty on library.exception_overrides;
create trigger exception_overrides_loose_group_dirty after insert or update or delete on library.exception_overrides
  for each row execute function library.capture_loose_override_changes();

-- The key-to-folder rows of the groups that exist now. An active root's are clean: the filled index holds
-- their items. An inactive root's have none yet (activity is now applied on read): build those once.
insert into library.problematic_loose_groups (library_id, item_key, root_id, folder, marked_xid)
select distinct roots.library_id,
  library.problematic_loose_group_key(roots.id, files.scan_physical_parent), roots.id, files.scan_physical_parent,
  case when not roots.is_active then pg_current_xact_id() end
from library.local_track_files files
join library.library_roots roots on roots.id = files.library_root_id
where files.scan_cache_stale is false
  and nullif(files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
on conflict (library_id, item_key) do nothing;

-- The loose items that exist now get their root, so reads can apply its activity.
update library.problematic_index_items items
set root_id = groups.root_id
from library.problematic_loose_groups groups
where groups.library_id = items.library_id and groups.item_key = items.item_key
  and items.album_id is null and items.root_id is distinct from groups.root_id;

-- A loose item of no current group has no root to check on a read. It is derived, so it goes.
delete from library.problematic_index_items items
where items.album_id is null and items.root_id is null and starts_with(items.item_key, 'loose-source::');

revoke all on library.problematic_loose_groups from public;
revoke all on function library.problematic_loose_group_key(bigint, text) from public;
revoke all on function library.mark_problematic_loose_group(bigint, text) from public;
revoke all on function library.capture_loose_file_changes() from public;
revoke all on function library.capture_loose_track_changes() from public;
revoke all on function library.capture_loose_artist_changes() from public;
revoke all on function library.capture_loose_rule_changes() from public;
revoke all on function library.capture_loose_override_changes() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, update on library.problematic_loose_groups to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.problematic_loose_groups to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.problematic_loose_groups to album_haven_migrator;
    grant execute on function library.problematic_loose_group_key(bigint, text) to album_haven_migrator;
  end if;
end $$;
