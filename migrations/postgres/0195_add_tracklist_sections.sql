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

-- A " / " album whose Discogs check found Discogs unavailable (timeout, 5xx, rate limit) is
-- asked again hourly for a day, then daily, and not after a week (owner 2026-11-16). A
-- definitive answer clears all three. Attempts count every unavailable answer.
alter table library.local_album_musicbrainz_releases
  add column if not exists discogs_section_attempts integer not null default 0
    check (discogs_section_attempts >= 0),
  add column if not exists discogs_section_first_failed_at timestamptz,
  add column if not exists discogs_section_retry_at timestamptz;

alter table library.local_album_musicbrainz_releases
  drop constraint if exists local_album_musicbrainz_releases_discogs_section_retry_check,
  add constraint local_album_musicbrainz_releases_discogs_section_retry_check check (
    (discogs_section_attempts = 0) = (discogs_section_first_failed_at is null)
    and (discogs_section_retry_at is null or discogs_section_attempts > 0));

create index if not exists local_album_musicbrainz_releases_section_retry_idx
  on library.local_album_musicbrainz_releases (discogs_section_retry_at)
  where discogs_section_retry_at is not null;

-- The main album is as many discs as the release group's smallest version (owner 2026-11-16).
alter table library.local_album_musicbrainz_releases
  drop constraint if exists local_album_musicbrainz_releases_main_disc_source_check,
  add constraint local_album_musicbrainz_releases_main_disc_source_check check (
    main_disc_source is null
    or main_disc_source in ('single_disc', 'fewest_discs', 'original_release', 'medium_titles'));
