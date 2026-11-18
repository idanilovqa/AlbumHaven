-- depends on: 0171_create_musicbrainz_artist_enrichment.sql
-- MusicBrainz Delivery 2, item 3 (owner 2026-11-17): "For those bands put a location identifier
-- that is available from MusicBrainz". Where MusicBrainz names no country for an artist but
-- gives an area (a city or region such as "Chico"), a same-name split label shows the area:
-- "Amarok (Chico)". Additive only; filled by the normal lookups and re-checks, never blanked by
-- a lookup that brings none.
alter table integration.musicbrainz_artists
  add column if not exists area_mbid uuid,
  add column if not exists area_name text check (area_name is null or char_length(area_name) between 1 and 256);

comment on column integration.musicbrainz_artists.area_name is
  'The area MusicBrainz gives the artist (a country, region or city), as named there; display only.';
