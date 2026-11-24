-- depends on: 0195_add_tracklist_sections.sql
-- MusicBrainz Delivery 2: track order against the matched edition (owner 2026-11-16).
-- Additive only. release_mbid already names the edition (the release whose track order best
-- matches the local files); these columns say how the local tracks pair with it. Display and
-- correction data only: nothing here writes media tags or reorders files.
alter table library.local_album_musicbrainz_releases
  -- order_exact: every track at its own position; reordered: paired by content elsewhere;
  -- ambiguous: a pairing could not be made with certainty and is not trusted.
  add column if not exists match_quality text
    check (match_quality is null or match_quality in ('order_exact', 'reordered', 'ambiguous')),
  -- reordered only: [{"disc_number", "track_number", "release_disc", "release_position"}].
  add column if not exists track_pairing jsonb not null default '[]'::jsonb
    check (jsonb_typeof(track_pairing) = 'array'),
  -- "Track order differs from the closest MusicBrainz edition".
  add column if not exists track_order_differs boolean not null default false;

alter table library.local_album_musicbrainz_releases
  drop constraint if exists local_album_musicbrainz_releases_track_order_check,
  add constraint local_album_musicbrainz_releases_track_order_check check (
    (match_quality is null or state = 'release')
    and (match_quality = 'reordered' or track_pairing = '[]'::jsonb)
    and track_order_differs = coalesce(match_quality in ('reordered', 'ambiguous'), false));
