\set ON_ERROR_STOP on

begin;

with
fixture_context as materialized (
  select convert_from(
    decode(:'fixture_root_b64', 'base64'),
    'UTF8'
  ) as root_path
),
bootstrap_context as materialized (
  select library.libraries.id as library_id
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  limit 1
),
fixture_root as (
  insert into library.library_roots (
    library_id,
    root_path,
    root_kind,
    is_active,
    metadata
  )
  select
    bootstrap_context.library_id,
    fixture_context.root_path,
    'main_library',
    true,
    jsonb_build_object(
      'source', 'e2e_fixture',
      'root_id', 'edit-tags-writable-root',
      'category', 'main_library',
      'category_key', 'main_library_roots',
      'layout_mode', 'artist'
    )
  from bootstrap_context
  cross join fixture_context
  on conflict (library_id, root_path) do update
  set
    root_kind = excluded.root_kind,
    is_active = true,
    updated_at = now(),
    metadata = library.library_roots.metadata || excluded.metadata
  returning library.library_roots.id
)
update library.library_root_settings
set
  root_categories = coalesce(
    library.library_root_settings.root_categories,
    '{}'::jsonb
  ) || jsonb_build_object(
    fixture_context.root_path,
    jsonb_build_object(
      'root_id', 'edit-tags-writable-root',
      'category', 'main_library',
      'category_key', 'main_library_roots'
    )
  ),
  settings_payload = jsonb_set(
    library.library_root_settings.settings_payload,
    '{main_library_roots}',
    case
      when exists (
        select 1
        from jsonb_array_elements(
          coalesce(
            library.library_root_settings.settings_payload
              -> 'main_library_roots',
            '[]'::jsonb
          )
        ) as configured_root
        where configured_root ->> 'path' = fixture_context.root_path
      )
      then library.library_root_settings.settings_payload
        -> 'main_library_roots'
      else coalesce(
        library.library_root_settings.settings_payload
          -> 'main_library_roots',
        '[]'::jsonb
      ) || jsonb_build_array(
        jsonb_build_object(
          'id', 'edit-tags-writable-root',
          'path', fixture_context.root_path,
          'layout_mode', 'artist'
        )
      )
    end,
    true
  ),
  updated_at = now()
from bootstrap_context
cross join fixture_context
cross join fixture_root
where library.library_root_settings.library_id = bootstrap_context.library_id;

-- Album identity transition triggers query both album rows from the statement
-- snapshot. Seed the optional typo identity in an earlier statement so it is
-- visible before any track moves to it.
with
fixture_rows as materialized (
  select *
  from jsonb_to_recordset(
    convert_from(decode(:'fixture_b64', 'base64'), 'UTF8')::jsonb
  ) as fixture(
    filename text,
    private_path text,
    artist text,
    album_artist text,
    album text,
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
seeded_typo_artist as (
  insert into library.local_artists (
    library_id,
    artist_key,
    name,
    sort_name,
    metadata
  )
  select
    target_album.library_id,
    lower('Ovderhead'::text),
    'Ovderhead',
    lower('Ovderhead'::text),
    jsonb_build_object('source', 'runtime_scan_cache')
  from target_album
  where exists (
    select 1
    from fixture_rows
    where fixture_rows.album = 'Telepathic Minds'
  )
  on conflict (library_id, artist_key) do update
  set
    name = excluded.name,
    sort_name = excluded.sort_name,
    last_seen_at = now()
  returning library.local_artists.id, library.local_artists.library_id
),
seeded_typo_album as (
  insert into library.local_albums (
    library_id,
    artist_id,
    album_key,
    title,
    release_year,
    metadata
  )
  select
    target_album.library_id,
    seeded_typo_artist.id,
    lower('Ovderhead'::text) || '::' || lower('Telepathic Minds'::text),
    'Telepathic Minds',
    1999,
    jsonb_build_object(
      'source', 'runtime_scan_cache',
      'album_artist', 'Ovderhead',
      'artists', jsonb_build_array('Ovderhead'),
      'release_date', '1999-01-01',
      'is_compilation', false,
      'featured_artists', '[]'::jsonb
    )
  from target_album
  join seeded_typo_artist
    on seeded_typo_artist.library_id = target_album.library_id
  on conflict (library_id, album_key) do update
  set
    artist_id = excluded.artist_id,
    title = excluded.title,
    release_year = excluded.release_year,
    metadata = coalesce(library.local_albums.metadata, '{}'::jsonb)
      || excluded.metadata,
    last_seen_at = now()
  returning library.local_albums.id, library.local_albums.library_id
)
select
  (select count(*) from seeded_typo_album) as album_rows
\gset seeded_typo_

with
fixture_rows as materialized (
  select *
  from jsonb_to_recordset(
    convert_from(decode(:'fixture_b64', 'base64'), 'UTF8')::jsonb
  ) as fixture(
    filename text,
    private_path text,
    artist text,
    album_artist text,
    album text,
    track_number integer,
    year integer,
    release_date text,
    file_size_bytes bigint,
    modified_at_epoch double precision
  )
),
bootstrap_context as materialized (
  select library.libraries.id as library_id
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  limit 1
),
duplicate_track_files as materialized (
  select duplicate_file.id, duplicate_file.track_id
  from fixture_rows
  cross join bootstrap_context
  join library.local_track_files as retained_file
    on retained_file.private_path = fixture_rows.private_path
  join library.local_tracks as retained_track
    on retained_track.id = retained_file.track_id
   and retained_track.library_id = bootstrap_context.library_id
   and retained_track.title =
      'Студийная запись ' || fixture_rows.track_number::text
  join library.local_track_files as duplicate_file
    on duplicate_file.id <> retained_file.id
   and right(
     replace(duplicate_file.private_path, chr(92), '/'),
     length(fixture_rows.filename) + 1
   ) = '/' || fixture_rows.filename
  join library.local_tracks as duplicate_track
    on duplicate_track.id = duplicate_file.track_id
   and duplicate_track.library_id = bootstrap_context.library_id
   and duplicate_track.title = retained_track.title
)
delete from library.local_track_files
using duplicate_track_files
where library.local_track_files.id = duplicate_track_files.id;

with
fixture_rows as materialized (
  select *
  from jsonb_to_recordset(
    convert_from(decode(:'fixture_b64', 'base64'), 'UTF8')::jsonb
  ) as fixture(
    filename text,
    private_path text,
    artist text,
    album_artist text,
    album text,
    track_number integer,
    year integer,
    release_date text,
    file_size_bytes bigint,
    modified_at_epoch double precision
  )
),
bootstrap_context as materialized (
  select library.libraries.id as library_id
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  limit 1
)
delete from library.local_tracks
using fixture_rows, bootstrap_context
where library.local_tracks.library_id = bootstrap_context.library_id
  and library.local_tracks.title =
    'Студийная запись ' || fixture_rows.track_number::text
  and not exists (
    select 1
    from library.local_track_files
    where library.local_track_files.track_id = library.local_tracks.id
  );

with
fixture_rows as materialized (
  select *
  from jsonb_to_recordset(
    convert_from(decode(:'fixture_b64', 'base64'), 'UTF8')::jsonb
  ) as fixture(
    filename text,
    private_path text,
    artist text,
    album_artist text,
    album text,
    track_number integer,
    year integer,
    release_date text,
    file_size_bytes bigint,
    modified_at_epoch double precision
  )
),
fixture_context as materialized (
  select convert_from(
    decode(:'fixture_root_b64', 'base64'),
    'UTF8'
  ) as root_path
),
fixture_root as materialized (
  select library.library_roots.id
  from library.library_roots
  cross join fixture_context
  where library.library_roots.root_path = fixture_context.root_path
    and library.library_roots.is_active
  limit 1
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
restored_typo_artist as materialized (
  select
    library.local_artists.id,
    library.local_artists.library_id
  from library.local_artists
  join target_album
    on target_album.library_id = library.local_artists.library_id
  where library.local_artists.artist_key = lower('Ovderhead'::text)
    and exists (
      select 1
      from fixture_rows
      where fixture_rows.album = 'Telepathic Minds'
    )
),
restored_typo_album as materialized (
  select
    library.local_albums.id,
    library.local_albums.library_id
  from library.local_albums
  join target_album
    on target_album.library_id = library.local_albums.library_id
  join restored_typo_artist
    on restored_typo_artist.id = library.local_albums.artist_id
  where library.local_albums.album_key =
    lower('Ovderhead'::text) || '::' || lower('Telepathic Minds'::text)
),
upserted_typo_membership as (
  insert into library.local_album_featured_artists (
    library_id,
    album_id,
    artist_id,
    featured_kind,
    metadata
  )
  select
    restored_typo_album.library_id,
    restored_typo_album.id,
    restored_typo_artist.id,
    'owner',
    jsonb_build_object('source', 'runtime_scan_cache')
  from restored_typo_album
  join restored_typo_artist
    on restored_typo_artist.library_id = restored_typo_album.library_id
  on conflict (library_id, album_id, artist_id, featured_kind) do update
  set last_seen_at = now()
  returning library.local_album_featured_artists.id
),
selected_rows as materialized (
  select
    fixture_rows.*,
    library.local_track_files.id as track_file_id,
    library.local_tracks.id as track_id
  from fixture_rows
  cross join target_album
  join library.local_track_files
    on right(
      replace(library.local_track_files.private_path, chr(92), '/'),
      length(fixture_rows.filename) + 1
    ) = '/' || fixture_rows.filename
  join library.local_tracks
    on library.local_tracks.id = library.local_track_files.track_id
   and library.local_tracks.library_id = target_album.library_id
   and library.local_tracks.title =
      'Студийная запись ' || fixture_rows.track_number::text
  join library.local_albums as current_album
    on current_album.id = library.local_tracks.album_id
   and current_album.library_id = target_album.library_id
   and (
     current_album.id = target_album.id
     or (
       current_album.title = 'Telepathic Minds'
       and (
         current_album.album_key = lower('Overhead'::text)
           || '::'
           || lower('Telepathic Minds'::text)
         or exists (
           select 1
           from library.local_artists as current_artist
           where current_artist.id = current_album.artist_id
             and current_artist.name in ('Ovderhead', 'Overhead')
         )
       )
     )
   )
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
    track_key = selected_rows.private_path,
    album_id = case
      when selected_rows.album = 'Telepathic Minds'
      then (select restored_typo_album.id from restored_typo_album)
      else target_album.id
    end,
    track_number = selected_rows.track_number,
    disc_number = 1,
    metadata = (
      coalesce(library.local_tracks.metadata, '{}'::jsonb)
      - array['year', 'release_date']::text[]
    )
      || jsonb_build_object(
        'album', selected_rows.album,
        'album_artist', selected_rows.album_artist,
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
    library_root_id = fixture_root.id,
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
          'key', selected_rows.private_path,
          'track_ref', selected_rows.private_path,
          'path', selected_rows.private_path,
          'artist', selected_rows.artist,
          'album_artist', selected_rows.album_artist,
          'album', selected_rows.album,
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
  cross join fixture_root
  where library.local_track_files.id = selected_rows.track_file_id
  returning
    library.local_track_files.id,
    library.local_track_files.library_root_id
),
updated_library as (
  update library.libraries
  set
    metadata = jsonb_set(
      jsonb_set(
        coalesce(library.libraries.metadata, '{}'::jsonb),
        '{scan_cache}',
        coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
          - 'relation_projection'
          - 'relation_views'
          - 'relations_last_built',
        true
      ),
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
  'typo_album_rows', (select count(*) from restored_typo_album),
  'typo_membership_rows', (select count(*) from upserted_typo_membership),
  'track_rows', (select count(*) from updated_tracks),
  'track_file_rows', (select count(*) from updated_track_files),
  'fixture_root_rows', (select count(*) from fixture_root),
  'track_file_root_rows', (
    select count(*)
    from updated_track_files
    cross join fixture_root
    where updated_track_files.library_root_id = fixture_root.id
  ),
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
  )
)::text as reset_json
\gset reset_

-- Track transitions are complete and both identities were visible to every
-- trigger invocation. Orphan cleanup now runs in later statements so it cannot
-- remove a predecessor or destination while a track is moving.
with
fixture_rows as materialized (
  select *
  from jsonb_to_recordset(
    convert_from(decode(:'fixture_b64', 'base64'), 'UTF8')::jsonb
  ) as fixture(
    filename text,
    private_path text,
    artist text,
    album_artist text,
    album text,
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
  where library.local_albums.album_key = lower('Юрий Шевчук / ДДТ'::text)
      || '::'
      || lower('Студийные записи'::text)
    and library.local_albums.title = 'Студийные записи'
  order by library.local_albums.id
  limit 1
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
    and (
      library.local_albums.title in (
        'Студийные записи',
        'Студийные записи merge candidate'
      )
      or (
        library.local_albums.title = 'Telepathic Minds'
        and not exists (
          select 1 from fixture_rows
          where fixture_rows.album = 'Telepathic Minds'
        )
        and (
          library.local_albums.album_key = lower('Overhead'::text)
            || '::'
            || lower('Telepathic Minds'::text)
          or exists (
            select 1
            from library.local_artists
            where library.local_artists.id = library.local_albums.artist_id
              and library.local_artists.name in ('Ovderhead', 'Overhead')
          )
        )
      )
    )
    and not exists (
      select 1
      from library.local_tracks
      where library.local_tracks.album_id = library.local_albums.id
    )
  returning library.local_albums.id
)
select
  (select count(*) from deleted_separate_releases) as separate_release_rows,
  (select count(*) from deleted_orphan_albums) as orphan_album_rows
\gset cleanup_

with
target_library as materialized (
  select library.local_albums.library_id
  from library.local_albums
  where library.local_albums.album_key = lower('Юрий Шевчук / ДДТ'::text)
      || '::'
      || lower('Студийные записи'::text)
    and library.local_albums.title = 'Студийные записи'
  order by library.local_albums.id
  limit 1
),
deleted_orphan_artists as (
  delete from library.local_artists
  using target_library
  where library.local_artists.library_id = target_library.library_id
    and library.local_artists.name in ('Ovderhead', 'Overhead')
    and not exists (
      select 1
      from library.local_albums
      where library.local_albums.artist_id = library.local_artists.id
    )
  returning library.local_artists.id
)
select (
  (:'reset_reset_json')::jsonb
  || jsonb_build_object(
    'separate_release_rows', :'cleanup_separate_release_rows'::integer,
    'orphan_album_rows', :'cleanup_orphan_album_rows'::integer,
    'orphan_artist_rows', (select count(*) from deleted_orphan_artists)
  )
)::text;

commit;
