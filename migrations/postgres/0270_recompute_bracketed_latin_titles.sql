-- depends on: 0256_add_album_latin_titles.sql
-- MusicBrainz Delivery 2, S7 (owner 2026-11-21, GIANIZM: "Hide if title has Latin"). A title that
-- already gives its Latin reading shows no romanized form. Such a title has brackets, and the
-- stored forms (0255, 0256) were made before that rule: this drops the stored form of bracketed
-- titles once. They are derived rows; the background refresh makes them again, by the new rule,
-- from the unchanged titles. No title, tag, choice or MusicBrainz answer is touched.
delete from library.local_track_latin_titles
where latin is not null and source_title ~ '[(（［【]|\[';

delete from library.local_album_latin_titles
where latin is not null and source_title ~ '[(（［【]|\[';
