-- The Custom Collections navigation tree finds file-stored collection names without
-- reading every file's metadata (catalog query in library_browse_postgres.py).
create index if not exists local_track_files_active_custom_collection_name_idx
  on library.local_track_files (id)
  where scan_cache_stale is false
    and coalesce(metadata #>> '{scan_cache,file_entry,custom_collection_name}', '') <> '';
