-- The album-evidence matcher (owner review 2) re-checks every automatic artist
-- decision made by the earlier matcher. Rows record the matcher version that
-- decided them; the startup backfill re-queues non-manual rows from an older
-- version. Existing rows are version 1; nothing else about them changes here.
--
-- credit_name keeps the local name an artist was matched under when MusicBrainz
-- lists it only as a release credit ("3 Crows" on Chris Buck), so the Gallery
-- panel and Problematic Files can say "credited as 3 Crows".
alter table library.local_artist_musicbrainz_matches
  add column if not exists matcher_version smallint not null default 1
    check (matcher_version >= 1),
  add column if not exists credit_name text
    check (credit_name is null or char_length(credit_name) between 1 and 512);

comment on column library.local_artist_musicbrainz_matches.matcher_version is
  'Version of the automatic matcher that last decided this row; older non-manual rows are re-checked.';
comment on column library.local_artist_musicbrainz_matches.credit_name is
  'Local name the artist was matched under through a MusicBrainz release credit; null for name matches.';
