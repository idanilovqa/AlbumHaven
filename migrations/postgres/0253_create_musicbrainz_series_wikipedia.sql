-- depends on: 0193_create_musicbrainz_series.sql
-- MusicBrainz Delivery 2, S6: a series' general information comes only from Wikipedia (owner
-- 2026-11-17: "Unless there's a Wikipedia link from which there could be shown a general info
-- about this series/list, nothing should be shown"). The link is found from the series'
-- MusicBrainz URL relationships (a Wikipedia link, else Wikidata's English article, else
-- another Wikipedia article); the article's introduction is fetched in the background, never
-- by a page load. A series with no link has no row here and shows no information. Additive only.
alter table integration.musicbrainz_series
  add column if not exists wikipedia_checked_at timestamptz,
  add column if not exists wikipedia_failure_count integer not null default 0
    check (wikipedia_failure_count >= 0),
  add column if not exists wikipedia_next_attempt_at timestamptz;

comment on column integration.musicbrainz_series.wikipedia_checked_at is
  'When the Wikipedia link and introduction were last looked up successfully (found or none); refreshed after 90 days.';
comment on column integration.musicbrainz_series.wikipedia_failure_count is
  'Consecutive failed Wikipedia lookups; the wait before the next one doubles from a day.';
comment on column integration.musicbrainz_series.wikipedia_next_attempt_at is
  'When a failed Wikipedia lookup may be tried again; null when nothing failed.';

create table if not exists integration.musicbrainz_series_wikipedia (
  series_mbid uuid primary key references integration.musicbrainz_series(mbid) on delete cascade,
  -- The Wikipedia language ("en", "de", "zh-min-nan", "simple").
  language text not null check (char_length(language) between 2 and 32
    and language ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 1 and 512),
  url text not null check (char_length(url) <= 2048 and url ~ '^https://[a-z0-9-]+\.wikipedia\.org/wiki/.'),
  -- The article's introduction as plain text, capped.
  extract text not null check (char_length(extract) between 1 and 2000),
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table integration.musicbrainz_series_wikipedia is
  'The Wikipedia article a MusicBrainz series links to and its plain-text introduction; display data only.';

create index if not exists musicbrainz_series_wikipedia_due_idx
  on integration.musicbrainz_series (wikipedia_checked_at nulls first, wikipedia_next_attempt_at);

revoke all on table integration.musicbrainz_series_wikipedia from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table integration.musicbrainz_series_wikipedia to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    -- A series whose link is gone loses its row.
    grant select, insert, update, delete on table integration.musicbrainz_series_wikipedia to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table integration.musicbrainz_series_wikipedia to album_haven_migrator;
  end if;
end $$;
