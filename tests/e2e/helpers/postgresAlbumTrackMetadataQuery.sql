select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'path', library.local_track_files.private_path,
      'title', library.local_tracks.title,
      'track_number', library.local_tracks.track_number,
      'disc_number', library.local_tracks.disc_number,
      'album', library.local_albums.title,
      'release_year', library.local_albums.release_year
      ,'scan_cache_stale', library.local_track_files.scan_cache_stale
      ,'library_root_id', library.local_track_files.library_root_id
      ,'scan_cache_source', library.local_track_files.metadata #>> '{scan_cache,source}'
    )
    order by library.local_track_files.private_path
  ),
  '[]'::jsonb
)
from library.local_albums
left join library.local_artists
  on library.local_albums.library_id = library.local_artists.library_id
 and library.local_albums.artist_id = library.local_artists.id
join library.local_tracks
  on library.local_tracks.library_id = library.local_albums.library_id
 and library.local_tracks.album_id = library.local_albums.id
join library.local_track_files
  on library.local_track_files.track_id = library.local_tracks.id
where case when library.local_albums.artist_id is null
    then nullif(library.local_albums.metadata ->> 'album_artist', '')
    else library.local_artists.name
  end =
      convert_from(decode(:'artist_b64', 'base64'), 'UTF8')
  and library.local_albums.title =
      convert_from(decode(:'album_b64', 'base64'), 'UTF8');
