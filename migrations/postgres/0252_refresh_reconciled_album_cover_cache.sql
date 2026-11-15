-- depends on: 0243_close_cover_consistency.sql
-- Refresh derived file cover state after identity reconciliation without changing
-- the surviving album's selected cover or its ownership metadata.

create or replace function library.reconcile_targeted_album_noncover(
  requested_library_id bigint,
  requested_album_id bigint,
  expected_inventory_revision bigint,
  allow_separate_release_merge boolean
)
returns table (canonical_album_id bigint, canonical_album_key text)
language plpgsql
security definer
set search_path = pg_catalog, library, app, ops, pg_temp
as $function$
declare
  current_revision bigint;
  requested_release_key text;
  target_album library.local_albums%rowtype;
  surviving_album_id bigint;
  changed_file_count bigint;
begin
  if requested_library_id is null or requested_album_id is null
     or expected_inventory_revision is null
     or allow_separate_release_merge is null then
    raise exception 'targeted reconciliation requires identity and revision'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(
    nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0
  ) into current_revision
  from library.libraries where id = requested_library_id for update;
  if not found or current_revision <> expected_inventory_revision then
    raise exception 'targeted reconciliation inventory revision conflict'
      using errcode = '40001';
  end if;
  select concat_ws(
    '::',
    lower(btrim(coalesce(
      nullif(btrim(albums.metadata ->> 'album_artist'), ''), artists.name, ''
    ))),
    lower(btrim(albums.title)),
    nullif(lower(btrim(coalesce(albums.metadata ->> 'edition', ''))), '')
  ) into requested_release_key
  from library.local_albums as albums
  join library.local_artists as artists
    on artists.id = albums.artist_id and artists.library_id = albums.library_id
  where albums.id = requested_album_id
    and albums.library_id = requested_library_id
    and nullif(btrim(albums.title), '') is not null;
  if not found then
    raise exception 'targeted reconciliation album identity conflict'
      using errcode = '22023';
  end if;
  select albums.* into target_album
  from library.local_albums as albums
  where albums.id = requested_album_id and albums.library_id = requested_library_id;
  if allow_separate_release_merge or not exists (
    select 1 from library.separate_releases as separate
    where separate.library_id = requested_library_id
      and separate.release_key = requested_release_key
  ) then
    perform library.reconcile_semantic_album_noncover(
      requested_library_id, requested_release_key, requested_album_id
    );
    select albums.id into surviving_album_id
    from library.local_albums as albums
    join library.local_artists as artists
      on artists.id = albums.artist_id and artists.library_id = albums.library_id
    where albums.library_id = requested_library_id
      and albums.artist_id = target_album.artist_id
      and lower(btrim(albums.title)) = lower(btrim(target_album.title))
      and albums.release_year is not distinct from target_album.release_year
      and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
          lower(btrim(coalesce(target_album.metadata ->> 'edition', '')))
      and concat_ws(
        '::', lower(btrim(coalesce(
          nullif(btrim(albums.metadata ->> 'album_artist'), ''), artists.name, ''
        ))), lower(btrim(albums.title)),
        nullif(lower(btrim(coalesce(albums.metadata ->> 'edition', ''))), '')
      ) = requested_release_key
    order by albums.id limit 1;
  else
    surviving_album_id := target_album.id;
  end if;

  with desired_file_cache as (
    select files.id,
      jsonb_set(files.metadata, '{scan_cache,file_entry}',
        (files.metadata #> '{scan_cache,file_entry}') || jsonb_build_object(
          'album_id', album.id,
          'cover_path', album.cover_path,
          'cover_revision', album.metadata -> 'cover_revision',
          'cover_selection_origin', album.metadata -> 'cover_selection_origin',
          'cover_selection_provenance', album.metadata -> 'cover_selection_provenance',
          'local_cover_width', album.metadata -> 'local_cover_width',
          'local_cover_height', album.metadata -> 'local_cover_height',
          'remote_cover_url', album.metadata -> 'remote_cover_url',
          'remote_cover_thumbnail_url', album.metadata -> 'remote_cover_thumbnail_url',
          'remote_cover_source', album.metadata -> 'remote_cover_source',
          'remote_cover_source_label', album.metadata -> 'remote_cover_source_label',
          'remote_cover_album_url', album.metadata -> 'remote_cover_album_url',
          'remote_cover_width', album.metadata -> 'remote_cover_width',
          'remote_cover_height', album.metadata -> 'remote_cover_height'
        ), true) as metadata
    from library.local_albums as album
    join library.local_tracks as tracks
      on tracks.album_id = album.id and tracks.library_id = album.library_id
    join library.local_track_files as files on files.track_id = tracks.id
    join library.library_roots as roots
      on roots.id = files.library_root_id and roots.library_id = tracks.library_id
     and roots.is_active is true
    where album.library_id = requested_library_id
      and album.id = surviving_album_id
      and files.scan_cache_stale is false
      and files.scan_file_entry_is_object is true
      and coalesce(files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') = ''
      and coalesce(files.metadata #>> '{scan_cache,file_entry,exception_type}', '') = ''
  )
  update library.local_track_files as files
  set metadata = desired.metadata
  from desired_file_cache as desired
  where files.id = desired.id
    and files.metadata is distinct from desired.metadata;
  get diagnostics changed_file_count = row_count;

  if changed_file_count > 0 then
    insert into library.cover_mutation_state (
      library_id, cover_mutation_revision, updated_at
    ) values (requested_library_id, 1, statement_timestamp())
    on conflict (library_id) do update
    set cover_mutation_revision = library.cover_mutation_state.cover_mutation_revision + 1,
        updated_at = excluded.updated_at;
  end if;

  return query
  select albums.id, albums.album_key
  from library.local_albums as albums
  where albums.library_id = requested_library_id
    and albums.id = surviving_album_id;
end;
$function$;
