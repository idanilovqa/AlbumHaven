-- MusicBrainz Delivery 2, S1: local album release identity, raw types and genres.
-- Additive only: code that does not know these tables ignores them. Each local album keeps
-- one row naming the MusicBrainz release group it matches and, when its tracks prove it, the
-- release; unresolved albums keep a diagnostic. Remote releases never become local albums,
-- and nothing here writes media tags.
create table if not exists integration.musicbrainz_release_groups (
  mbid uuid primary key,
  title text not null check (char_length(title) between 1 and 1024),
  -- Raw MusicBrainz values, stored as given ("Album", ["Live", "Compilation"]).
  primary_type text check (primary_type is null or char_length(primary_type) between 1 and 64),
  secondary_types text[] not null default '{}'::text[],
  first_release_date text check (first_release_date is null or first_release_date ~ '^\d{4}(-\d{2}(-\d{2})?)?$'),
  disambiguation text check (disambiguation is null or char_length(disambiguation) <= 1024),
  -- [{"name": "power metal", "count": 2}], most votes first.
  genres jsonb not null default '[]'::jsonb check (jsonb_typeof(genres) = 'array'),
  refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists integration.musicbrainz_releases (
  mbid uuid primary key,
  release_group_mbid uuid references integration.musicbrainz_release_groups(mbid) on delete set null,
  title text not null check (char_length(title) between 1 and 1024),
  release_date text check (release_date is null or release_date ~ '^\d{4}(-\d{2}(-\d{2})?)?$'),
  country text check (country is null or char_length(country) between 1 and 8),
  barcode text check (barcode is null or char_length(barcode) between 1 and 64),
  status text check (status is null or char_length(status) between 1 and 64),
  disambiguation text check (disambiguation is null or char_length(disambiguation) <= 1024),
  -- [{"name", "artist_mbid", "artist_name", "join_phrase"}] in credit order.
  artist_credit jsonb not null default '[]'::jsonb check (jsonb_typeof(artist_credit) = 'array'),
  -- [{"position", "title", "format", "track_count", "tracks": [{"position", "title", "length", "artist_credit"}]}]
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists musicbrainz_releases_release_group_idx
  on integration.musicbrainz_releases (release_group_mbid);

create table if not exists library.local_album_musicbrainz_releases (
  library_id bigint not null,
  album_key text not null,
  state text not null check (state in ('release', 'release_group', 'unresolved')),
  -- The MusicBrainz artist whose releases were compared (the album's own identity first).
  artist_mbid uuid references integration.musicbrainz_artists(mbid) on delete set null,
  release_group_mbid uuid references integration.musicbrainz_release_groups(mbid) on delete restrict,
  release_mbid uuid references integration.musicbrainz_releases(mbid) on delete restrict,
  -- The release group's original release, the main-album end's first evidence.
  original_release_mbid uuid references integration.musicbrainz_releases(mbid) on delete restrict,
  disc_position integer check (disc_position is null or disc_position > 0),
  diagnostic text check (
    diagnostic is null or diagnostic in ('no_title_match', 'tracks_differ', 'title_only', 'budget_exhausted')
  ),
  -- How many local discs, in order, are the main album; null keeps the local guess.
  main_disc_count integer check (main_disc_count is null or main_disc_count > 0),
  main_disc_source text check (
    main_disc_source is null or main_disc_source in ('single_disc', 'original_release', 'medium_titles')
  ),
  -- Display-only track artists for tracks whose tag lost its artist:
  -- [{"disc_number", "track_number", "artist", "artist_mbids"}].
  track_artists jsonb not null default '[]'::jsonb check (jsonb_typeof(track_artists) = 'array'),
  signals text[] not null default '{}'::text[],
  decision_source text not null default 'automatic' check (decision_source in ('automatic', 'manual')),
  matcher_version integer not null check (matcher_version >= 1),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (library_id, album_key),
  constraint local_album_musicbrainz_releases_album_fkey foreign key (library_id, album_key)
    references library.local_albums(library_id, album_key)
    on update cascade on delete cascade,
  check (
    (state = 'release' and release_group_mbid is not null and release_mbid is not null and diagnostic is null)
    or (state = 'release_group' and release_group_mbid is not null and release_mbid is null and diagnostic is null)
    or (state = 'unresolved' and release_group_mbid is null and release_mbid is null and diagnostic is not null)
  ),
  check ((main_disc_count is null) = (main_disc_source is null))
);

create index if not exists local_album_musicbrainz_releases_group_idx
  on library.local_album_musicbrainz_releases (release_group_mbid);
create index if not exists local_album_musicbrainz_releases_release_idx
  on library.local_album_musicbrainz_releases (release_mbid);

comment on table library.local_album_musicbrainz_releases is
  'The MusicBrainz release group and, when its tracks prove it, the release each local album is; display data only.';

revoke all on table
  integration.musicbrainz_release_groups,
  integration.musicbrainz_releases,
  library.local_album_musicbrainz_releases
from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table integration.musicbrainz_release_groups, integration.musicbrainz_releases,
      library.local_album_musicbrainz_releases to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table integration.musicbrainz_release_groups, integration.musicbrainz_releases
      to album_haven_app;
    -- A re-check replaces an album's automatic decision.
    grant select, insert, update, delete on table library.local_album_musicbrainz_releases to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table integration.musicbrainz_release_groups, integration.musicbrainz_releases,
      library.local_album_musicbrainz_releases to album_haven_migrator;
  end if;
end $$;
