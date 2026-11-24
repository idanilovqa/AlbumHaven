-- depends on: 0171_create_musicbrainz_artist_enrichment.sql
-- MusicBrainz Delivery 2, S5: the owner's manual MusicBrainz lookups. Additive only.
--
-- A request names one local artist, or one local album (with the artist it belongs to). It
-- runs through the existing enrichment job queue (ops.metadata_enrichment_jobs): an artist
-- lookup is a musicbrainz_artist_enrichment job, an album lookup re-resolves its artist's
-- albums (musicbrainz_album_releases). "Queue" requests wait together and start as one batch
-- when the oldest is an hour old or when the owner runs Library -> MusicBrainz sync;
-- "Search" requests start at once in a batch of their own. Each batch is one notification
-- card; its requests keep what they found (an MBID) or why not (a Problematic Files label).
-- Nothing here writes media tags.
create table if not exists ops.musicbrainz_lookup_batches (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz,
  -- The owner deleted the notification card; its requests stay as history.
  dismissed_at timestamptz,
  unique (library_id, id)
);

create table if not exists ops.musicbrainz_lookup_requests (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  target_kind text not null check (target_kind in ('artist', 'album')),
  local_artist_id bigint not null,
  album_key text,
  mode text not null check (mode in ('queue', 'search')),
  state text not null check (state in ('queued', 'running', 'finished')),
  requested_by_account_id bigint references app.accounts(id) on delete set null,
  requested_at timestamptz not null,
  batch_id bigint,
  job_id bigint references ops.metadata_enrichment_jobs(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  outcome text check (outcome in ('matched', 'not_matched')),
  result_mbid uuid,
  problem_label text check (problem_label is null or char_length(problem_label) between 1 and 256),
  foreign key (library_id, local_artist_id) references library.local_artists(library_id, id) on delete cascade,
  foreign key (library_id, album_key) references library.local_albums(library_id, album_key) on delete cascade,
  foreign key (library_id, batch_id) references ops.musicbrainz_lookup_batches(library_id, id) on delete cascade,
  check ((target_kind = 'artist') = (album_key is null)),
  check ((state = 'queued') = (batch_id is null)),
  check ((state = 'finished') = (outcome is not null)),
  check (outcome is distinct from 'matched' or problem_label is null)
);

-- One waiting or running lookup per artist or album.
create unique index if not exists musicbrainz_lookup_requests_active_idx
  on ops.musicbrainz_lookup_requests (library_id, target_kind, local_artist_id, coalesce(album_key, ''))
  where state in ('queued', 'running');
create index if not exists musicbrainz_lookup_requests_queued_idx
  on ops.musicbrainz_lookup_requests (library_id, requested_at) where state = 'queued';
create index if not exists musicbrainz_lookup_requests_running_idx
  on ops.musicbrainz_lookup_requests (job_id) where state = 'running';
create index if not exists musicbrainz_lookup_requests_batch_idx
  on ops.musicbrainz_lookup_requests (batch_id);
create index if not exists musicbrainz_lookup_batches_open_idx
  on ops.musicbrainz_lookup_batches (library_id, started_at desc) where dismissed_at is null;

revoke all on table ops.musicbrainz_lookup_batches, ops.musicbrainz_lookup_requests from public;
revoke all on sequence ops.musicbrainz_lookup_batches_id_seq, ops.musicbrainz_lookup_requests_id_seq from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table ops.musicbrainz_lookup_batches, ops.musicbrainz_lookup_requests to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table ops.musicbrainz_lookup_batches, ops.musicbrainz_lookup_requests
      to album_haven_app;
    grant usage, select on sequence ops.musicbrainz_lookup_batches_id_seq, ops.musicbrainz_lookup_requests_id_seq
      to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table ops.musicbrainz_lookup_batches, ops.musicbrainz_lookup_requests
      to album_haven_migrator;
    grant usage, select on sequence ops.musicbrainz_lookup_batches_id_seq, ops.musicbrainz_lookup_requests_id_seq
      to album_haven_migrator;
  end if;
end $$;
