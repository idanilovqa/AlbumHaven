-- MusicBrainz Delivery 2, S3: Discogs fallback for artists and albums MusicBrainz lacks.
-- Additive only. Discogs IDs are stored as Discogs-derived; MusicBrainz stays authoritative,
-- and the MusicBrainz artists Discogs leads to are only hints for the artist matcher.
-- Contribution flags ("MBID: Remote info update needed") collect what MusicBrainz lacks;
-- the owner can also set one by hand. Nothing here writes media tags.
create table if not exists integration.discogs_artists (
  id bigint primary key check (id > 0),
  name text not null check (char_length(name) between 1 and 512),
  real_name text check (real_name is null or char_length(real_name) between 1 and 512),
  name_variations text[] not null default '{}'::text[],
  -- [{"id", "name"}]
  aliases jsonb not null default '[]'::jsonb check (jsonb_typeof(aliases) = 'array'),
  refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists integration.discogs_releases (
  id bigint primary key check (id > 0),
  master_id bigint check (master_id is null or master_id > 0),
  title text not null check (char_length(title) between 1 and 1024),
  release_year text check (release_year is null or release_year ~ '^\d{4}$'),
  barcodes text[] not null default '{}'::text[],
  -- [{"position", "title", "length"}]
  tracks jsonb not null default '[]'::jsonb check (jsonb_typeof(tracks) = 'array'),
  refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists library.local_artist_discogs_identities (
  library_id bigint not null,
  local_artist_id bigint not null,
  state text not null check (state in ('found', 'not_found')),
  discogs_artist_id bigint references integration.discogs_artists(id) on delete restrict,
  -- [{"artist_mbid", "via": "barcode" | "name", ...}]: candidates the artist matcher still proves.
  musicbrainz_hints jsonb not null default '[]'::jsonb check (jsonb_typeof(musicbrainz_hints) = 'array'),
  evidence_summary text check (evidence_summary is null or char_length(evidence_summary) <= 1024),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (library_id, local_artist_id),
  foreign key (library_id, local_artist_id) references library.local_artists(library_id, id) on delete cascade,
  check ((state = 'found') = (discogs_artist_id is not null))
);

create table if not exists library.local_album_discogs_releases (
  library_id bigint not null,
  album_key text not null,
  discogs_release_id bigint not null references integration.discogs_releases(id) on delete restrict,
  discogs_master_id bigint check (discogs_master_id is null or discogs_master_id > 0),
  signals text[] not null default '{}'::text[],
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (library_id, album_key),
  constraint local_album_discogs_releases_album_fkey foreign key (library_id, album_key)
    references library.local_albums(library_id, album_key) on update cascade on delete cascade
);

create table if not exists library.musicbrainz_contribution_flags (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  target_kind text not null check (target_kind in ('artist', 'album')),
  local_artist_id bigint,
  album_key text,
  source text not null check (source in ('automatic', 'manual')),
  reason text not null check (reason in ('missing_from_musicbrainz', 'owner_marked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (library_id, local_artist_id) references library.local_artists(library_id, id) on delete cascade,
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key)
    on update cascade on delete cascade,
  check ((target_kind = 'artist' and local_artist_id is not null and album_key is null)
         or (target_kind = 'album' and album_key is not null and local_artist_id is null))
);

create unique index if not exists musicbrainz_contribution_flags_artist_idx
  on library.musicbrainz_contribution_flags (library_id, local_artist_id, source) where target_kind = 'artist';
create unique index if not exists musicbrainz_contribution_flags_album_idx
  on library.musicbrainz_contribution_flags (library_id, album_key, source) where target_kind = 'album';

revoke all on table integration.discogs_artists, integration.discogs_releases,
  library.local_artist_discogs_identities, library.local_album_discogs_releases,
  library.musicbrainz_contribution_flags from public;
revoke all on sequence library.musicbrainz_contribution_flags_id_seq from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table integration.discogs_artists, integration.discogs_releases,
      library.local_artist_discogs_identities, library.local_album_discogs_releases,
      library.musicbrainz_contribution_flags to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table integration.discogs_artists, integration.discogs_releases
      to album_haven_app;
    -- A re-check replaces an artist's automatic Discogs outcome and its albums.
    grant select, insert, update, delete on table library.local_artist_discogs_identities,
      library.local_album_discogs_releases, library.musicbrainz_contribution_flags to album_haven_app;
    grant usage, select on sequence library.musicbrainz_contribution_flags_id_seq to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table integration.discogs_artists, integration.discogs_releases,
      library.local_artist_discogs_identities, library.local_album_discogs_releases,
      library.musicbrainz_contribution_flags to album_haven_migrator;
    grant usage, select on sequence library.musicbrainz_contribution_flags_id_seq to album_haven_migrator;
  end if;
end $$;
