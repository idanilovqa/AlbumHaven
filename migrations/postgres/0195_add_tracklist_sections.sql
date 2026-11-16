-- depends on: 0191_create_discogs_fallback_identity.sql
-- MusicBrainz Delivery 2, S8: tracklist sub-sections ("Where Dead Angels Lie" for tracks 9-13
-- of one disc), derived from the matched release: MusicBrainz medium titles, or Discogs
-- tracklist headings. Additive only and display data: nothing here writes media tags, and a
-- CD's own name is never a sub-section.
-- [{"disc_number", "track_number", "section"}] for each local track under a heading.
alter table library.local_album_musicbrainz_releases
  add column if not exists track_sections jsonb not null default '[]'::jsonb
    check (jsonb_typeof(track_sections) = 'array');

alter table library.local_album_discogs_releases
  add column if not exists track_sections jsonb not null default '[]'::jsonb
    check (jsonb_typeof(track_sections) = 'array');
