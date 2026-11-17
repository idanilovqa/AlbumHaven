-- depends on: 0193_create_musicbrainz_series.sql
-- MusicBrainz Delivery 2, S6: a series is sized at most once per 30 days. The size is the
-- number of release groups and releases MusicBrainz lists in it, counted only up to the
-- Featured In cutoff (50), and only for a series its type and name leave undecided. A
-- failed count rests a day before it is tried again. Additive only.
alter table integration.musicbrainz_series
  add column if not exists size_checked_at timestamptz,
  add column if not exists size_failed_at timestamptz;

-- Sizes already stored were counted then; they are reused until 30 days after that.
update integration.musicbrainz_series
set size_checked_at = updated_at
where member_count is not null and size_checked_at is null;

comment on column integration.musicbrainz_series.size_checked_at is
  'When member_count was last counted from MusicBrainz (up to the Featured In cutoff of 50); reused for 30 days.';
comment on column integration.musicbrainz_series.size_failed_at is
  'When the last count failed; the series is not counted again for a day.';
