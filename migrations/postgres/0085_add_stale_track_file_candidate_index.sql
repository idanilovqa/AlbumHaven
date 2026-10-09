-- Missing-album discovery starts from stale candidates, usually an empty set.
create index if not exists local_track_files_stale_track_id_idx
  on library.local_track_files (track_id)
  where scan_cache_stale is true;
