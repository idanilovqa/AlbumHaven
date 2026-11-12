-- Owner decision 2026-11-09: a person and the same-named band they are a member of on
-- MusicBrainz ("Alice Cooper", the singer and his 1969-74 group) are one local artist with
-- two MBIDs. The match keeps the person as its artist; this column names the associated
-- groups, whose albums keep their own MBID in library.local_album_artist_identities.
-- Additive and nullable: code that does not know the column ignores it.
alter table library.local_artist_musicbrainz_matches
  add column if not exists associated_artist_mbids uuid[];

comment on column library.local_artist_musicbrainz_matches.associated_artist_mbids is
  'Same-named MusicBrainz groups the matched person is a member of, shown under the one local artist.';
