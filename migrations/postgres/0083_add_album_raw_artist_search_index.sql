-- Keep raw album-artist array matching on the indexed search path.
-- This migration must run outside an explicit transaction because PostgreSQL
-- does not allow CREATE INDEX CONCURRENTLY inside a transaction block.

create index concurrently if not exists local_albums_normalized_raw_artists_trgm_idx
on library.local_albums
using gin (
  (lower(btrim(coalesce(metadata ->> 'artists', '')))) library.gin_trgm_ops
);
