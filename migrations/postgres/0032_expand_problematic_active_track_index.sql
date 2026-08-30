drop index if exists library.local_track_files_active_track_id_idx;

create index local_track_files_active_track_id_idx
  on library.local_track_files (track_id)
  include (
    private_path,
    scan_file_entry_is_object,
    scan_file_album,
    scan_file_album_artist,
    scan_file_artist,
    scan_file_title,
    scan_file_year,
    scan_file_track_number,
    scan_file_text_mojibake_candidate,
    scan_file_metadata_problem_candidate
  )
  where scan_cache_stale is false;
