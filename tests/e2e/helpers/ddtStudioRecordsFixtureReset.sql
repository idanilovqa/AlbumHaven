\set ON_ERROR_STOP on

with
fixture_rows as materialized (
  select *
  from jsonb_to_recordset(
    convert_from(decode(:'fixture_b64', 'base64'), 'UTF8')::jsonb
  ) as fixture(
    filename text,
    private_path text,
    track_number integer,
    year integer,
    release_date text,
    file_size_bytes bigint,
    modified_at_epoch double precision
  )
),
target_album as materialized (
  select
    library.local_albums.id,
    library.local_albums.library_id
  from library.local_albums
  where library.local_albums.title = 'Студийные записи'
  order by
    (
      library.local_albums.album_key = lower('Юрий Шевчук / ДДТ'::text)
        || '::'
        || lower('Студийные записи'::text)
    ) desc,
    (
      select count(*)
      from library.local_tracks as candidate_tracks
      join fixture_rows
        on candidate_tracks.title =
          'Студийная запись ' || fixture_rows.track_number::text
      where candidate_tracks.album_id = library.local_albums.id
    ) desc,
    (library.local_albums.release_year = 1999) desc,
    library.local_albums.id
  limit 1
),
selected_rows as materialized (
  select
    fixture_rows.*,
    library.local_track_files.id as track_file_id,
    library.local_tracks.id as track_id
  from fixture_rows
  join library.local_tracks
    on library.local_tracks.title =
      'Студийная запись ' || fixture_rows.track_number::text
  join library.local_track_files
    on library.local_track_files.track_id = library.local_tracks.id
),
updated_album as (
  update library.local_albums
  set
    album_key = lower('Юрий Шевчук / ДДТ'::text)
      || '::'
      || lower('Студийные записи'::text),
    release_year = 1999,
    metadata = jsonb_set(
      coalesce(library.local_albums.metadata, '{}'::jsonb),
      '{release_date}',
      to_jsonb('1999-01-01'::text),
      true
    ),
    last_seen_at = now()
  from target_album
  where library.local_albums.id = target_album.id
  returning library.local_albums.id
),
updated_tracks as (
  update library.local_tracks
  set
    album_id = target_album.id,
    track_number = selected_rows.track_number,
    disc_number = 1,
    metadata = (
      coalesce(library.local_tracks.metadata, '{}'::jsonb)
      - array['year', 'release_date']::text[]
    )
      || jsonb_build_object(
        'album', 'Студийные записи',
        'track_number', selected_rows.track_number,
        'disc_number', 1
      ),
    last_seen_at = now()
  from selected_rows
  cross join target_album
  where library.local_tracks.id = selected_rows.track_id
  returning library.local_tracks.id
),
updated_track_files as (
  update library.local_track_files
  set
    private_path = selected_rows.private_path,
    file_size_bytes = selected_rows.file_size_bytes,
    modified_at = to_timestamp(selected_rows.modified_at_epoch),
    metadata = jsonb_set(
      coalesce(library.local_track_files.metadata, '{}'::jsonb),
      '{scan_cache}',
      coalesce(
        library.local_track_files.metadata -> 'scan_cache',
        '{}'::jsonb
      ) || jsonb_build_object(
        'stale', false,
        'file_entry',
        coalesce(
          library.local_track_files.metadata #> '{scan_cache,file_entry}',
          '{}'::jsonb
        ) || jsonb_build_object(
          'album', 'Студийные записи',
          'track_number', selected_rows.track_number,
          'disc_number', 1,
          'disc_number_raw', '1',
          'year', selected_rows.year,
          'release_date', selected_rows.release_date,
          'mtime', selected_rows.modified_at_epoch,
          'size', selected_rows.file_size_bytes
        )
      ),
      true
    ),
    last_seen_at = now()
  from selected_rows
  where library.local_track_files.id = selected_rows.track_file_id
  returning library.local_track_files.id
),
deleted_separate_releases as (
  delete from library.separate_releases
  using target_album
  where library.separate_releases.library_id = target_album.library_id
    and (
      library.separate_releases.release_key like
        '%::' || lower('Студийные записи'::text)
      or library.separate_releases.release_key like
        '%::' || lower('Студийные записи'::text) || '::%'
    )
  returning library.separate_releases.release_key
),
deleted_orphan_albums as (
  delete from library.local_albums
  using target_album
  where library.local_albums.library_id = target_album.library_id
    and library.local_albums.id <> target_album.id
    and library.local_albums.title in (
      'Студийные записи',
      'Студийные записи merge candidate'
    )
    and not exists (
      select 1
      from library.local_tracks
      join library.local_track_files
        on library.local_track_files.track_id = library.local_tracks.id
      where library.local_tracks.album_id = library.local_albums.id
    )
  returning library.local_albums.id
),
updated_library as (
  update library.libraries
  set
    metadata = jsonb_set(
      coalesce(library.libraries.metadata, '{}'::jsonb)
        #- '{scan_cache,relation_projection}',
      '{inventory_mutation_revision}',
      to_jsonb(
        coalesce(
          nullif(
            library.libraries.metadata ->> 'inventory_mutation_revision',
            ''
          )::bigint,
          0
        ) + 1
      ),
      true
    ),
    updated_at = now()
  from target_album
  where library.libraries.id = target_album.library_id
  returning library.libraries.id
)
select json_build_object(
  'fixture_input_rows', (select count(*) from fixture_rows),
  'matched_file_rows', (select count(*) from selected_rows),
  'album_rows', (select count(*) from updated_album),
  'track_rows', (select count(*) from updated_tracks),
  'track_file_rows', (select count(*) from updated_track_files),
  'album_edition_rows', (
    select count(*)
    from library.local_albums
    join target_album on target_album.id = library.local_albums.id
    where nullif(btrim(library.local_albums.metadata ->> 'edition'), '') is not null
  ),
  'file_edition_rows', (
    select count(*)
    from library.local_track_files
    join selected_rows
      on selected_rows.track_file_id = library.local_track_files.id
    where nullif(
      btrim(
        library.local_track_files.metadata
          #>> '{scan_cache,file_entry,edition}'
      ),
      ''
    ) is not null
  ),
  'separate_release_rows', (select count(*) from deleted_separate_releases),
  'orphan_album_rows', (select count(*) from deleted_orphan_albums)
)::text;
