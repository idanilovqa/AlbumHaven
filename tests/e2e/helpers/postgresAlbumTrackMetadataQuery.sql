select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'path', library.local_track_files.private_path,
      'title', library.local_tracks.title,
      'track_number', library.local_tracks.track_number,
      'disc_number', library.local_tracks.disc_number,
      'album', library.local_albums.title,
      'release_year', library.local_albums.release_year
    )
    order by library.local_track_files.private_path
  ),
  '[]'::jsonb
)
from library.local_artists
join library.local_albums
  on library.local_albums.library_id = library.local_artists.library_id
 and library.local_albums.artist_id = library.local_artists.id
join library.local_tracks
  on library.local_tracks.library_id = library.local_albums.library_id
 and library.local_tracks.album_id = library.local_albums.id
join library.local_track_files
  on library.local_track_files.track_id = library.local_tracks.id
where library.local_artists.name =
      convert_from(decode(:'artist_b64', 'base64'), 'UTF8')
  and library.local_albums.title =
      convert_from(decode(:'album_b64', 'base64'), 'UTF8');
