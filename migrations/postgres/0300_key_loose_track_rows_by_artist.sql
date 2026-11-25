-- 0300_key_loose_track_rows_by_artist.sql
-- A selected artist reads only its own stored Loose Tracks rows. Each row keeps the keys the artist
-- scope matches on: 'a:' plus each file's artist identity key and 'p:' plus each folder name of its
-- path (normalized as search text). The build and the mark drain write them; the store's builder
-- version change rebuilds every row once at the next start.

alter table library.non_album_track_rows
  add column if not exists scope_keys text[] not null default '{}';

create index if not exists non_album_track_rows_scope_keys
  on library.non_album_track_rows using gin (scope_keys);

-- The table's grants (0295) cover the new column.
