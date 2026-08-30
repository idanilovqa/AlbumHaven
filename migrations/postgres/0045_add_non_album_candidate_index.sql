create index if not exists local_track_files_active_non_album_candidate_idx
  on library.local_track_files (track_id)
  where scan_cache_stale is false
    and (
      lower(btrim(coalesce(scan_file_album, ''))) in (
        '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
      )
      or lower(btrim(coalesce(scan_file_album, '')))
        ~ '^[!\-\s\[\(]*non[\s\-_]*album(?:\y.*)?$'
    );
