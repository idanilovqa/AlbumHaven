create index if not exists local_track_files_active_scanned_exception_candidate_idx
  on library.local_track_files (track_id)
  where scan_cache_stale is false
    and lower(btrim(coalesce(metadata #>> '{scan_cache,file_entry,exception_type}', '')))
      in ('interview', 'non album rarity', 'non-album rarity');
