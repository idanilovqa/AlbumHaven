-- depends on: 0256_add_album_latin_titles.sql
-- MusicBrainz Delivery 2, S7 (owner 2026-11-22, "Album, artist, then MB"): ideographs read as
-- Japanese or Chinese only on the album's evidence. Each stored reading keeps the evidence it
-- was made from and is redone when that differs. Rows stored before have none, so the
-- background refresh redoes each once, by this rule and by "Hide if title has Latin" (2026-11-21).
-- Additive only: no title, tag, choice or MusicBrainz answer is touched.
alter table library.local_track_latin_titles
  add column if not exists reading_evidence text;

alter table library.local_album_latin_titles
  add column if not exists reading_evidence text;
