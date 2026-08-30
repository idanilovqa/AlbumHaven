create index if not exists local_track_files_problem_candidate_v5_idx
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

create index if not exists local_track_files_required_text_missing_candidate_idx
  on library.local_track_files (track_id)
  where scan_cache_stale is false
    and scan_file_entry_is_object is true
    and (
      coalesce(scan_file_album, '') !~ '[^[:space:]]'
      or coalesce(scan_file_album_artist, '') !~ '[^[:space:]]'
      or coalesce(scan_file_artist, '') !~ '[^[:space:]]'
      or coalesce(scan_file_title, '') !~ '[^[:space:]]'
    );

drop index if exists library.local_track_files_problem_candidate_idx;
drop index if exists library.local_track_files_problem_candidate_v2_idx;
drop index if exists library.local_track_files_problem_candidate_v3_idx;
drop index if exists library.local_track_files_problem_candidate_v4_idx;

alter table library.local_track_files
  drop column if exists scan_file_required_text_missing_candidate;
