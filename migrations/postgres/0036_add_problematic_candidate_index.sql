create index if not exists local_track_files_problem_candidate_idx
  on library.local_track_files (track_id)
  include (
    scan_file_entry_is_object,
    scan_file_album,
    scan_file_album_artist,
    scan_file_year,
    scan_file_text_mojibake_candidate,
    scan_file_metadata_problem_candidate
  )
  where scan_cache_stale is false;
