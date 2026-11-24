-- 0295_keep_loose_track_rows.sql
-- depends on: 0294_mark_loose_groups_for_problematic_index.sql
-- Loose Tracks reads stored rows; triggers mark changed tracks and a drain rebuilds only those.

create table if not exists library.non_album_track_rows (
  library_id bigint not null references library.libraries(id) on delete cascade,
  track_id bigint not null,
  track jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (library_id, track_id),
  constraint non_album_track_rows_track_object check (jsonb_typeof(track) = 'object')
);

-- One mark per changed track. No foreign key on track_id: a deleted track's mark is how its row goes.
create table if not exists library.non_album_track_marks (
  library_id bigint not null references library.libraries(id) on delete cascade,
  track_id bigint not null,
  marked_xid xid8 not null,
  primary key (library_id, track_id)
);

create table if not exists library.non_album_track_store_state (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  builder_version integer not null,
  status text not null check (status in ('building', 'ready', 'failed')),
  error text,
  retry_after timestamptz,
  built_at timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function library.mark_loose_track(selected_library_id bigint, selected_track_id bigint)
returns void language sql security definer set search_path = pg_catalog as $$
  insert into library.non_album_track_marks (library_id, track_id, marked_xid)
  select selected_library_id, selected_track_id, pg_current_xact_id()
  where selected_library_id is not null and selected_track_id is not null
  on conflict (library_id, track_id) do update set marked_xid = excluded.marked_xid
    where library.non_album_track_marks.marked_xid is distinct from excluded.marked_xid;
$$;

-- The loader's qualifying predicate (_non_album_candidates_sql's library-wide candidate_scope and
-- _non_album_value_predicate_sql), moved here verbatim. Pure: every input is passed in.
create or replace function library.loose_track_qualifies(
  file_album text, track_album text, album_title text, file_metadata jsonb,
  override_exception_type text, override_payload jsonb
)
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  select (
      lower(btrim(coalesce(file_album, track_album, album_title, '')))
        in ('', 'unknown', 'unknown artist', 'unknown album', 'none', 'null')
      or lower(btrim(coalesce(file_album, track_album, album_title, '')))
        ~ '^[!\-\s\[\(]*non[\s\-_]*album(?:\y.*)?$'
    )
    or nullif(file_metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
    or override_exception_type is not null
    or (
      not coalesce(override_payload ? 'exception_type', false)
      and lower(btrim(coalesce(file_metadata #>> '{scan_cache,file_entry,exception_type}', '')))
        in ('interview', 'non-album rarity', 'non album rarity', 'custom collection')
    );
$$;

-- exception_overrides has no exception_type column (revision 5, phase 1's 42703): the loader derives it in its
-- ranked override CTE (_non_album_candidates_sql), and every 64 function derives it here exactly the same way.
create or replace function library.loose_override_exception_type(override_payload jsonb)
returns text language sql immutable parallel safe set search_path = pg_catalog as $$
  select coalesce(
    nullif(btrim(override_payload ->> 'exception_type'), ''),
    case when jsonb_typeof(override_payload) = 'string' then nullif(btrim(override_payload #>> '{}'), '') end
  );
$$;

-- Files. For each side: that side's track and album by primary key and its override (by track id, else by
-- the file's path, as the loader joins it). The track is marked when the predicate holds on either side, or
-- when the track is gone (its row must go).
create or replace function library.capture_loose_track_file_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare selected record;
begin
  for selected in
    with sides as (
      select old.track_id as track_id, old.library_root_id as library_root_id, old.private_path as private_path,
        old.scan_file_album as file_album, old.metadata as file_metadata where tg_op <> 'INSERT'
      union all
      select new.track_id, new.library_root_id, new.private_path, new.scan_file_album, new.metadata
        where tg_op <> 'DELETE'
    )
    select distinct coalesce(tracks.library_id, roots.library_id) as library_id, sides.track_id
    from sides
    left join library.library_roots roots on roots.id = sides.library_root_id
    left join library.local_tracks tracks on tracks.id = sides.track_id
    left join library.local_albums albums on albums.id = tracks.album_id
    where sides.track_id is not null
      and (tracks.id is null
        -- with no override, or with any of the track's overrides (no ranking: a superset is allowed)
        or library.loose_track_qualifies(sides.file_album, tracks.metadata ->> 'album', albums.title,
             sides.file_metadata, null, null)
        or exists (
          select 1 from library.exception_overrides overrides
          where overrides.library_id = tracks.library_id
            and (overrides.track_id = tracks.id or overrides.track_key = sides.private_path)
            and library.loose_track_qualifies(sides.file_album, tracks.metadata ->> 'album', albums.title,
                  sides.file_metadata, library.loose_override_exception_type(overrides.override_payload),
                  overrides.override_payload)))
    order by 2
  loop perform library.mark_loose_track(selected.library_id, selected.track_id); end loop;
  return null;
end $$;

drop trigger if exists local_track_files_loose_track_inserted on library.local_track_files;
create trigger local_track_files_loose_track_inserted after insert on library.local_track_files
  for each row when (new.track_id is not null)
  execute function library.capture_loose_track_file_changes();
drop trigger if exists local_track_files_loose_track_updated on library.local_track_files;
create trigger local_track_files_loose_track_updated after update on library.local_track_files
  for each row
  -- Only the file_entry keys the predicate and the row builder read (see "No-change scan" below), plus the
  -- row's own columns; cover, timing and size keys change without changing a loose row.
  when ((old.private_path, old.relative_path, old.scan_cache_stale, old.library_root_id, old.track_id,
         old.metadata #> '{scan_cache,file_entry,album}', old.metadata #> '{scan_cache,file_entry,album_artist}',
         old.metadata #> '{scan_cache,file_entry,artist}', old.metadata #> '{scan_cache,file_entry,artists}',
         old.metadata #> '{scan_cache,file_entry,title}', old.metadata #> '{scan_cache,file_entry,genre}',
         old.metadata #> '{scan_cache,file_entry,track_number}', old.metadata #> '{scan_cache,file_entry,disc_number}',
         old.metadata #> '{scan_cache,file_entry,disc_number_raw}', old.metadata #> '{scan_cache,file_entry,total_discs}',
         old.metadata #> '{scan_cache,file_entry,disc_subtitle}', old.metadata #> '{scan_cache,file_entry,year}',
         old.metadata #> '{scan_cache,file_entry,edition}', old.metadata #> '{scan_cache,file_entry,album_rating}',
         old.metadata #> '{scan_cache,file_entry,library_root_category}',
         old.metadata #> '{scan_cache,file_entry,library_category}',
         old.metadata #> '{scan_cache,file_entry,exception_type}',
         old.metadata #> '{scan_cache,file_entry,custom_collection_name}',
         old.metadata #> '{scan_cache,file_entry,local_album_membership_problem}')
    is distinct from
        (new.private_path, new.relative_path, new.scan_cache_stale, new.library_root_id, new.track_id,
         new.metadata #> '{scan_cache,file_entry,album}', new.metadata #> '{scan_cache,file_entry,album_artist}',
         new.metadata #> '{scan_cache,file_entry,artist}', new.metadata #> '{scan_cache,file_entry,artists}',
         new.metadata #> '{scan_cache,file_entry,title}', new.metadata #> '{scan_cache,file_entry,genre}',
         new.metadata #> '{scan_cache,file_entry,track_number}', new.metadata #> '{scan_cache,file_entry,disc_number}',
         new.metadata #> '{scan_cache,file_entry,disc_number_raw}', new.metadata #> '{scan_cache,file_entry,total_discs}',
         new.metadata #> '{scan_cache,file_entry,disc_subtitle}', new.metadata #> '{scan_cache,file_entry,year}',
         new.metadata #> '{scan_cache,file_entry,edition}', new.metadata #> '{scan_cache,file_entry,album_rating}',
         new.metadata #> '{scan_cache,file_entry,library_root_category}',
         new.metadata #> '{scan_cache,file_entry,library_category}',
         new.metadata #> '{scan_cache,file_entry,exception_type}',
         new.metadata #> '{scan_cache,file_entry,custom_collection_name}',
         new.metadata #> '{scan_cache,file_entry,local_album_membership_problem}'))
  execute function library.capture_loose_track_file_changes();
drop trigger if exists local_track_files_loose_track_deleted on library.local_track_files;
create trigger local_track_files_loose_track_deleted after delete on library.local_track_files
  for each row when (old.track_id is not null)
  execute function library.capture_loose_track_file_changes();

-- Tracks. Marked when the predicate holds for one of its files on the old or the new side.
create or replace function library.capture_loose_track_row_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if exists (
    select 1
    from library.local_track_files files
    left join library.local_albums old_album on old_album.id = old.album_id
    left join library.local_albums new_album on new_album.id = new.album_id
    -- no override (null row) or each of the track's overrides: the predicate holding for any of them marks
    left join lateral (
      select null::text as exception_type, null::jsonb as override_payload
      union all
      select library.loose_override_exception_type(overrides.override_payload), overrides.override_payload
      from library.exception_overrides overrides
      where overrides.library_id = new.library_id
        and (overrides.track_id = new.id or overrides.track_key = files.private_path)
    ) override on true
    where files.track_id = new.id and files.scan_cache_stale is false
      and (library.loose_track_qualifies(files.scan_file_album, old.metadata ->> 'album', old_album.title,
             files.metadata, override.exception_type, override.override_payload)
        or library.loose_track_qualifies(files.scan_file_album, new.metadata ->> 'album', new_album.title,
             files.metadata, override.exception_type, override.override_payload))
  ) then
    perform library.mark_loose_track(new.library_id, new.id);
  end if;
  return null;
end $$;

drop trigger if exists local_tracks_loose_track_dirty on library.local_tracks;
create trigger local_tracks_loose_track_dirty after update on library.local_tracks
  for each row
  -- Every track field the Loose Tracks loader and row builder read (to confirm against the loader's select
  -- list in the dry run; a field it reads that this list lacks is a missed mark, caught by rebuild equality).
  when ((old.album_id, old.artist_id, old.title, old.disc_number, old.track_number, old.duration_seconds,
         old.metadata -> 'artist', old.metadata -> 'artists', old.metadata -> 'album', old.metadata -> 'album_artist',
         old.metadata -> 'year', old.metadata -> 'genre', old.metadata -> 'disc_subtitle', old.metadata -> 'total_discs',
         old.metadata -> 'edition', old.metadata -> 'custom_collection_name')
    is distinct from
        (new.album_id, new.artist_id, new.title, new.disc_number, new.track_number, new.duration_seconds,
         new.metadata -> 'artist', new.metadata -> 'artists', new.metadata -> 'album', new.metadata -> 'album_artist',
         new.metadata -> 'year', new.metadata -> 'genre', new.metadata -> 'disc_subtitle', new.metadata -> 'total_discs',
         new.metadata -> 'edition', new.metadata -> 'custom_collection_name'))
  execute function library.capture_loose_track_row_changes();

-- Albums. A retitle changes the effective album of its tracks: all of them are marked (superset), through
-- local_tracks(album_id).
create or replace function library.capture_loose_album_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform library.mark_loose_track(tracks.library_id, tracks.id)
  from library.local_tracks tracks
  where tracks.album_id = new.id;
  return null;
end $$;

drop trigger if exists local_albums_loose_track_dirty on library.local_albums;
create trigger local_albums_loose_track_dirty after update on library.local_albums
  for each row when (old.title is distinct from new.title)
  execute function library.capture_loose_album_changes();

-- Artists. A rename re-marks only the artist's tracks whose effective album could qualify: no album, or the
-- predicate true for one of their files (with no override or any of them). Through local_tracks_artist_id_idx.
create or replace function library.capture_loose_track_artist_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform library.mark_loose_track(tracks.library_id, tracks.id)
  from library.local_tracks tracks
  left join library.local_albums albums on albums.id = tracks.album_id
  where tracks.artist_id = new.id
    and (tracks.album_id is null or exists (
      select 1
      from library.local_track_files files
      left join lateral (
        select null::text as exception_type, null::jsonb as override_payload
        union all
        select library.loose_override_exception_type(overrides.override_payload), overrides.override_payload
        from library.exception_overrides overrides
        where overrides.library_id = tracks.library_id
          and (overrides.track_id = tracks.id or overrides.track_key = files.private_path)
      ) override on true
      where files.track_id = tracks.id and files.scan_cache_stale is false
        and library.loose_track_qualifies(files.scan_file_album, tracks.metadata ->> 'album', albums.title,
              files.metadata, override.exception_type, override.override_payload)));
  return null;
end $$;

drop trigger if exists local_artists_loose_track_dirty on library.local_artists;
create trigger local_artists_loose_track_dirty after update on library.local_artists
  for each row when ((old.name, old.sort_name) is distinct from (new.name, new.sort_name))
  execute function library.capture_loose_track_artist_changes();

-- Overrides. Added, changed or removed, the override can make a track loose or not: its track is marked.
create or replace function library.capture_loose_track_override_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform library.mark_loose_track(edited.library_id, coalesce(edited.track_id, files.track_id))
  from (
    select old.library_id as library_id, old.track_id as track_id, old.track_key as track_key where tg_op <> 'INSERT'
    union
    select new.library_id, new.track_id, new.track_key where tg_op <> 'DELETE'
  ) edited
  left join library.local_track_files files on edited.track_id is null and files.private_path = edited.track_key;
  return null;
end $$;

drop trigger if exists exception_overrides_loose_track_dirty on library.exception_overrides;
create trigger exception_overrides_loose_track_dirty after insert or update or delete on library.exception_overrides
  for each row execute function library.capture_loose_track_override_changes();

revoke all on library.non_album_track_rows from public;
revoke all on library.non_album_track_marks from public;
revoke all on library.non_album_track_store_state from public;
revoke all on function library.mark_loose_track(bigint, bigint) from public;
revoke all on function library.capture_loose_track_file_changes() from public;
revoke all on function library.capture_loose_track_row_changes() from public;
revoke all on function library.capture_loose_album_changes() from public;
revoke all on function library.capture_loose_track_artist_changes() from public;
revoke all on function library.capture_loose_track_override_changes() from public;
-- The loader calls the predicate as the app (and read-only) role; it reads nothing.
grant execute on function library.loose_track_qualifies(text, text, text, jsonb, text, jsonb) to public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    -- The drain writes rows and state and clears marks; only the security-definer triggers insert marks.
    grant select, insert, update, delete on library.non_album_track_rows to album_haven_app;
    grant select, delete on library.non_album_track_marks to album_haven_app;
    grant select, insert, update on library.non_album_track_store_state to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.non_album_track_rows, library.non_album_track_marks,
      library.non_album_track_store_state to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.non_album_track_rows, library.non_album_track_marks,
      library.non_album_track_store_state to album_haven_migrator;
  end if;
end $$;
