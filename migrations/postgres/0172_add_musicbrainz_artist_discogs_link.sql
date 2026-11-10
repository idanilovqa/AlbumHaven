-- Discogs artist identity taken from the MusicBrainz artist's url-rels.
-- Only the numeric Discogs artist ID is kept; the public URL is derived from it.
-- Null when MusicBrainz lists no Discogs artist, or several different ones.
alter table integration.musicbrainz_artists
  add column if not exists discogs_artist_id bigint
  check (discogs_artist_id is null or discogs_artist_id between 1 and 999999999999);

comment on column integration.musicbrainz_artists.discogs_artist_id is
  'Discogs artist ID from MusicBrainz url-rels; null when MusicBrainz lists none or several.';
