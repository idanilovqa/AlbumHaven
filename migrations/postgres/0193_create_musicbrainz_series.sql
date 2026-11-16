-- depends on: 0190_create_musicbrainz_release_identity.sql
-- MusicBrainz Delivery 2, S6: the MusicBrainz series a matched release or release group is
-- part of ("Colossus Projects", a release group series), with its number when MusicBrainz
-- gives one. Additive only and MusicBrainz-derived: nothing here writes media tags.
--
-- Owner decision 2026-11-15: real album series show as "Series"; lists, awards, ceremonies
-- and collections ("1001 Albums You Must Hear Before You Die") show as "Featured In".
create table if not exists integration.musicbrainz_series (
  mbid uuid primary key,
  name text not null check (char_length(name) between 1 and 1024),
  -- Raw MusicBrainz type ("Release group series", "Release series").
  series_type text check (series_type is null or char_length(series_type) between 1 and 64),
  disambiguation text check (disambiguation is null or char_length(disambiguation) <= 1024),
  -- How many release groups and releases MusicBrainz lists in the series; null until sized.
  member_count integer check (member_count is null or member_count >= 0),
  -- The owner's rules, in order: an award, ceremony, event or tour type; about 50 members
  -- or more (lists cluster at exactly 50: "Top 50 Albums of 2022"; the largest real series
  -- on the owner's library has 41); a list-like or chart-like name. Everything else is a
  -- real series.
  computed_kind text not null generated always as (
    case
      when coalesce(series_type, '') ~* '(award|ceremony|event|tour)' then 'featured_in'
      when member_count >= 50 then 'featured_in'
      -- List-like names (owner 2026-11-15): lists, rankings, charts, certifications and
      -- colour-vinyl pressings. "Best" alone or "Best of <year>", never "Best of Bowie";
      -- "Gold" only as a certification or a vinyl colour.
      when name ~* '(1001|\mgreatest\M|\mbest\M(?!\s+of\s)|\mbest\s+of\s+[0-9]{4}\M|\messential|\maward|hall of fame|\mbillboard\M|\mcharts?\M|\mrewind\M|\myear[-‐ ]end\M|\mof the year\M|\mreaders[''’]?\s+poll\M|\mcritics?\M|\malb(um|ums|en)\s+des\s+jahres\M|\malbums?\s+de\s+l[''’]\s*ann(é|e)e\M|\mtop\s+([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\M|\m([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\s+(best|worst|favou?rites?|loudest)\M|\mhonou?rable\s+mentions?\M|\mdisques\s+(d[''’]\s*|de\s+)(or|platine|diamant)\M|\mcertifications?\M|\mcertified\s+((double|triple|quadruple)\s+)?(gold|platinum|diamond)\M|\m(gold|platinum|diamond)\s+(albums|records|discs|certified|certifications?)\M|\m(gold|silver|clear|pink|red|blue|black|white|green|yellow|orange|purple|splatter|marbled|grey|gray|transparent|translucent|opaque|colou?red)(\s+[a-z]+)?\s+vinyl\M)' then 'featured_in'
      else 'series'
    end
  ) stored,
  -- The owner's choice always wins over the computed kind; "hidden" shows the series nowhere.
  owner_kind text check (owner_kind is null or owner_kind in ('series', 'featured_in', 'hidden')),
  refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Each lookup of a release group or release replaces its links: MusicBrainz's answer is
-- the whole list.
create table if not exists integration.musicbrainz_release_group_series (
  release_group_mbid uuid not null references integration.musicbrainz_release_groups(mbid) on delete cascade,
  series_mbid uuid not null references integration.musicbrainz_series(mbid) on delete cascade,
  -- The "number" attribute as MusicBrainz writes it ("18", "Vol. 3"); null when not given.
  ordering_number text check (ordering_number is null or char_length(ordering_number) between 1 and 64),
  ordering_key integer,
  primary key (release_group_mbid, series_mbid)
);

create table if not exists integration.musicbrainz_release_series (
  release_mbid uuid not null references integration.musicbrainz_releases(mbid) on delete cascade,
  series_mbid uuid not null references integration.musicbrainz_series(mbid) on delete cascade,
  ordering_number text check (ordering_number is null or char_length(ordering_number) between 1 and 64),
  ordering_key integer,
  primary key (release_mbid, series_mbid)
);

create index if not exists musicbrainz_release_group_series_series_idx
  on integration.musicbrainz_release_group_series (series_mbid);
create index if not exists musicbrainz_release_series_series_idx
  on integration.musicbrainz_release_series (series_mbid);

-- The series each decided local album belongs to: its release group's, and its certain
-- release's, with its kind ("series" or "featured_in"); hidden series are left out. A series
-- named at both levels appears once, with the release group's number.
create or replace view library.local_album_musicbrainz_series as
select decisions.library_id, decisions.album_key, series.mbid as series_mbid, series.name as series_name,
       series.series_type, coalesce(series.owner_kind, series.computed_kind) as series_kind,
       part.ordering_number, part.ordering_key
from library.local_album_musicbrainz_releases decisions
cross join lateral (
  select distinct on (parts.series_mbid) parts.series_mbid, parts.ordering_number, parts.ordering_key
  from (
    select 1 as level, links.series_mbid, links.ordering_number, links.ordering_key
    from integration.musicbrainz_release_group_series links
    where links.release_group_mbid = decisions.release_group_mbid
    union all
    select 2, links.series_mbid, links.ordering_number, links.ordering_key
    from integration.musicbrainz_release_series links
    where links.release_mbid = decisions.release_mbid
  ) parts
  order by parts.series_mbid, parts.level
) part
join integration.musicbrainz_series series
  on series.mbid = part.series_mbid and coalesce(series.owner_kind, series.computed_kind) <> 'hidden'
where decisions.state <> 'unresolved';

comment on view library.local_album_musicbrainz_series is
  'The MusicBrainz series each decided local album is part of; display and search data only.';

revoke all on table
  integration.musicbrainz_series,
  integration.musicbrainz_release_group_series,
  integration.musicbrainz_release_series,
  library.local_album_musicbrainz_series
from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table integration.musicbrainz_series, integration.musicbrainz_release_group_series,
      integration.musicbrainz_release_series, library.local_album_musicbrainz_series to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table integration.musicbrainz_series to album_haven_app;
    -- A lookup replaces the links it answers for.
    grant select, insert, update, delete on table integration.musicbrainz_release_group_series,
      integration.musicbrainz_release_series to album_haven_app;
    grant select on table library.local_album_musicbrainz_series to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table integration.musicbrainz_series, integration.musicbrainz_release_group_series,
      integration.musicbrainz_release_series to album_haven_migrator;
    grant select on table library.local_album_musicbrainz_series to album_haven_migrator;
  end if;
end $$;
