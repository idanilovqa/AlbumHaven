create index if not exists local_tracks_problem_candidate_idx
  on library.local_tracks (id)
  include (
    library_id,
    album_id,
    disc_number,
    track_number,
    scan_title_problem_candidate
  );
