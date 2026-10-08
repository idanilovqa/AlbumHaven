begin read only;
select coalesce(jsonb_agg(jsonb_build_object(
  'artist', artist.name,
  'key', album.album_key,
  'fixtureKey', album.metadata->>'fixture_album_key'
) order by artist.name, album.album_key), '[]'::jsonb)
from library.local_albums album
join library.local_artists artist on artist.library_id=album.library_id and artist.id=album.artist_id
join library.libraries library on library.id=album.library_id
where library.metadata->>'profile'='synthetic-large-library'
  and artist.name in (
    select jsonb_array_elements_text(convert_from(decode(:'artists_b64', 'base64'), 'UTF8')::jsonb)
  );
rollback;
