-- 0302_key_problematic_items_by_track_path.sql
-- depends on: 0188_create_problematic_files_index.sql, 0295_keep_loose_track_rows.sql
-- Additive. Loose Tracks marks a track with the Problematic Files "!" only when an indexed item lists the
-- track's path, read per path through this index (never the whole list). The Loose Tracks store build keeps
-- its progress on its state row, so the page can say how far the one-time build has come. Rollback leaves
-- the index and the columns unused.

create index if not exists problematic_index_items_track_paths_idx
  on library.problematic_index_items using gin ((item -> 'track_paths'));

alter table library.non_album_track_store_state
  add column if not exists progress_done bigint,
  add column if not exists progress_total bigint;

-- The tables' grants (0188, 0295) cover the new index and columns.
