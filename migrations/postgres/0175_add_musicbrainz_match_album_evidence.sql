-- Matcher version 3 keeps the local albums behind a match that a later "Data
-- Correction Needed" list can propose fixing without matching again: every album
-- of an artist matched under another credited name, and every album that matched
-- one disc of a multi-disc release (a box-set disc or bonus EP tagged as its own
-- album). Each element names the local album, the MusicBrainz release group,
-- release and disc it agreed with, and the signals that agreed. Other matches and
-- existing rows keep null until their next re-check.
alter table library.local_artist_musicbrainz_matches
  add column if not exists album_evidence jsonb
    check (
      album_evidence is null
      or (jsonb_typeof(album_evidence) = 'array'
          and jsonb_array_length(album_evidence) between 1 and 64)
    );

comment on column library.local_artist_musicbrainz_matches.album_evidence is
  'Albums behind a credited-name or disc match: local album, release group, release, disc and agreeing signals.';
