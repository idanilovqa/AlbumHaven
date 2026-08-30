select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'album_id', identity_rows.id,
      'album_key', identity_rows.album_key,
      'track_count', identity_rows.track_count
    )
    order by identity_rows.id
  ),
  '[]'::jsonb
)
from (
  select
    library.local_albums.id,
    library.local_albums.album_key,
    count(library.local_tracks.id)::integer as track_count
  from library.local_artists
  join library.local_albums
    on library.local_albums.library_id = library.local_artists.library_id
   and library.local_albums.artist_id = library.local_artists.id
  left join library.local_tracks
    on library.local_tracks.library_id = library.local_albums.library_id
   and library.local_tracks.album_id = library.local_albums.id
  where library.local_artists.name =
        convert_from(decode(:'artist_b64', 'base64'), 'UTF8')
    and library.local_albums.title =
        convert_from(decode(:'album_b64', 'base64'), 'UTF8')
    and library.local_albums.release_year = :'year'::integer
    and btrim(
          coalesce(
            library.local_albums.metadata ->> 'edition',
            ''
          )
        ) = btrim(convert_from(decode(:'edition_b64', 'base64'), 'UTF8'))
  group by
    library.local_albums.id,
    library.local_albums.album_key
) as identity_rows;
