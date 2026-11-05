-- A full inventory publication rebuilds every relation fact and clears the
-- whole dirty journal before it commits (finish_full_relation_publication).
-- Journaling each of its rows first is pure cost: one trigger call, several
-- index lookups and a journal upsert per row, which made a 160k-file repair
-- publication hold the inventory lock for hours. Only that publisher sets this
-- transaction-local marker, after taking the inventory advisory lock; every
-- other writer, including legacy ones, journals exactly as before.
drop trigger if exists local_albums_relation_dirty on library.local_albums;
create trigger local_albums_relation_dirty after insert or update or delete on library.local_albums
  for each row when (current_setting('album_haven.full_inventory_publication', true) is distinct from 'on')
  execute function library.capture_relation_album_changes();

drop trigger if exists local_tracks_relation_dirty on library.local_tracks;
create trigger local_tracks_relation_dirty after insert or update or delete on library.local_tracks
  for each row when (current_setting('album_haven.full_inventory_publication', true) is distinct from 'on')
  execute function library.capture_relation_album_changes();

drop trigger if exists local_files_relation_dirty on library.local_track_files;
create trigger local_files_relation_dirty after insert or update or delete on library.local_track_files
  for each row when (current_setting('album_haven.full_inventory_publication', true) is distinct from 'on')
  execute function library.capture_relation_album_changes();

drop trigger if exists local_featured_relation_dirty on library.local_album_featured_artists;
create trigger local_featured_relation_dirty after insert or update or delete on library.local_album_featured_artists
  for each row when (current_setting('album_haven.full_inventory_publication', true) is distinct from 'on')
  execute function library.capture_relation_album_changes();

drop trigger if exists local_artists_relation_dirty on library.local_artists;
create trigger local_artists_relation_dirty after update or delete on library.local_artists
  for each row when (current_setting('album_haven.full_inventory_publication', true) is distinct from 'on')
  execute function library.capture_relation_album_changes();

drop trigger if exists local_artists_empty_relation_dirty on library.local_artists;
create trigger local_artists_empty_relation_dirty after insert or update or delete on library.local_artists
  for each row when (current_setting('album_haven.full_inventory_publication', true) is distinct from 'on')
  execute function library.capture_gallery_metadata_changes();
