-- Additive artist-only MusicBrainz enrichment storage. Existing local identity
-- columns and assertion history remain readable during rollout and rollback.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'local_artists_library_id_id_unique'
      and conrelid = 'library.local_artists'::regclass
  ) then
    alter table library.local_artists
      add constraint local_artists_library_id_id_unique unique (library_id, id);
  end if;
end $$;

create table if not exists integration.musicbrainz_artists (
  mbid uuid primary key,
  canonical_name text not null check (char_length(canonical_name) between 1 and 512),
  sort_name text check (sort_name is null or char_length(sort_name) between 1 and 512),
  preferred_native_name text check (
    preferred_native_name is null
    or char_length(preferred_native_name) between 1 and 512
  ),
  disambiguation text check (
    disambiguation is null or char_length(disambiguation) <= 1024
  ),
  artist_kind text check (artist_kind is null or char_length(artist_kind) between 1 and 64),
  life_span_begin date,
  life_span_end date,
  life_span_ended boolean,
  refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (life_span_end is null or life_span_begin is null or life_span_end >= life_span_begin)
);

create table if not exists integration.musicbrainz_artist_aliases (
  artist_mbid uuid not null references integration.musicbrainz_artists(mbid) on delete cascade,
  alias_name text not null check (char_length(alias_name) between 1 and 512),
  alias_normalized text not null check (char_length(alias_normalized) between 1 and 512),
  sort_name text check (sort_name is null or char_length(sort_name) between 1 and 512),
  locale text check (locale is null or char_length(locale) between 1 and 32),
  alias_kind text check (alias_kind is null or char_length(alias_kind) between 1 and 64),
  is_primary_for_locale boolean not null default false,
  provenance text not null check (char_length(provenance) between 1 and 64),
  observed_at timestamptz not null,
  primary key (artist_mbid, alias_normalized)
);

create table if not exists integration.musicbrainz_artist_countries (
  artist_mbid uuid not null references integration.musicbrainz_artists(mbid) on delete cascade,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  country_name text check (country_name is null or char_length(country_name) between 1 and 128),
  provenance text not null check (char_length(provenance) between 1 and 64),
  observed_at timestamptz not null,
  primary key (artist_mbid, country_code)
);

create table if not exists integration.musicbrainz_artist_tags (
  artist_mbid uuid not null references integration.musicbrainz_artists(mbid) on delete cascade,
  tag_name text not null check (char_length(tag_name) between 1 and 256),
  tag_normalized text not null check (char_length(tag_normalized) between 1 and 256),
  vote_count integer not null,
  is_genre boolean not null,
  provenance text not null check (char_length(provenance) between 1 and 64),
  observed_at timestamptz not null default now()
);

create unique index if not exists musicbrainz_artist_tags_identity_idx on integration.musicbrainz_artist_tags (artist_mbid, tag_normalized);

create table if not exists library.local_artist_musicbrainz_matches (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  local_artist_id bigint not null,
  artist_mbid uuid references integration.musicbrainz_artists(mbid) on delete restrict,
  state text not null check (
    state in ('pending', 'matched', 'ambiguous', 'not_found', 'conflict', 'manual_review')
  ),
  decision_source text not null check (decision_source in ('automatic', 'manual')),
  confidence numeric(6, 5) not null default 0 check (confidence between 0 and 1),
  evidence_summary text not null check (char_length(evidence_summary) between 1 and 2048),
  selected_at timestamptz,
  decided_by_account_id bigint references app.accounts(id) on delete set null,
  last_verified_at timestamptz,
  provider_classification text check (
    provider_classification is null
    or char_length(provider_classification) between 1 and 64
  ),
  provider_observed_at timestamptz,
  provider_response_hash text check (
    provider_response_hash is null or provider_response_hash ~ '^[0-9a-f]{64}$'
  ),
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (library_id, id),
  foreign key (library_id, local_artist_id) references library.local_artists(library_id, id) on delete cascade,
  check (state <> 'matched' or artist_mbid is not null),
  check (artist_mbid is null or state in ('matched', 'conflict', 'manual_review')),
  check (
    (decision_source = 'automatic' and decided_by_account_id is null)
    or decision_source = 'manual'
  )
);

create unique index if not exists local_artist_musicbrainz_matches_current_idx on library.local_artist_musicbrainz_matches (library_id, local_artist_id);

create table if not exists library.local_artist_musicbrainz_candidates (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  local_artist_id bigint not null,
  artist_mbid uuid not null references integration.musicbrainz_artists(mbid) on delete cascade,
  candidate_score numeric(6, 5) not null check (candidate_score between 0 and 1),
  evidence_summary text not null check (char_length(evidence_summary) between 1 and 2048),
  rejection_reason text check (
    rejection_reason is null or char_length(rejection_reason) between 1 and 512
  ),
  observed_at timestamptz not null,
  provider_classification text check (
    provider_classification is null
    or char_length(provider_classification) between 1 and 64
  ),
  provider_observed_at timestamptz,
  provider_response_hash text check (
    provider_response_hash is null or provider_response_hash ~ '^[0-9a-f]{64}$'
  ),
  unique (library_id, id),
  unique (library_id, local_artist_id, artist_mbid),
  foreign key (library_id, local_artist_id) references library.local_artists(library_id, id) on delete cascade
);

create index if not exists local_artist_musicbrainz_candidates_review_idx
  on library.local_artist_musicbrainz_candidates
  (library_id, local_artist_id, candidate_score desc, artist_mbid);

create table if not exists ops.metadata_enrichment_jobs (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  local_artist_id bigint not null,
  target_kind text not null default 'artist' check (target_kind = 'artist'),
  job_kind text not null check (char_length(job_kind) between 1 and 64),
  reason text not null check (char_length(reason) between 1 and 128),
  state text not null check (
    state in ('queued', 'leased', 'retry_wait', 'succeeded', 'needs_review', 'exhausted')
  ),
  priority integer not null default 0,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text check (lease_owner is null or char_length(lease_owner) between 1 and 128),
  lease_expires_at timestamptz,
  provider_classification text check (
    provider_classification is null
    or char_length(provider_classification) between 1 and 64
  ),
  provider_observed_at timestamptz,
  provider_response_hash text check (
    provider_response_hash is null or provider_response_hash ~ '^[0-9a-f]{64}$'
  ),
  last_error text check (last_error is null or char_length(last_error) <= 1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (library_id, id),
  foreign key (library_id, local_artist_id) references library.local_artists(library_id, id) on delete cascade,
  check (
    (state = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'leased' and lease_owner is null and lease_expires_at is null)
  )
);

create unique index if not exists metadata_enrichment_jobs_active_idx on ops.metadata_enrichment_jobs (library_id, local_artist_id, job_kind) where state in ('queued', 'leased', 'retry_wait');
create index if not exists metadata_enrichment_jobs_due_idx on ops.metadata_enrichment_jobs (next_attempt_at, priority, id) where state in ('queued', 'retry_wait');
create index if not exists metadata_enrichment_jobs_expired_lease_idx
  on ops.metadata_enrichment_jobs (lease_expires_at, id)
  where state = 'leased';

create table if not exists library.metadata_enrichment_problems (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  local_artist_id bigint not null,
  target_kind text not null default 'artist' check (target_kind = 'artist'),
  reason_code text not null check (
    reason_code in (
      'musicbrainz_artist_not_found',
      'musicbrainz_artist_ambiguous',
      'musicbrainz_artist_metadata_conflict',
      'musicbrainz_mirror_replication_pending',
      'musicbrainz_provider_retry_exhausted',
      'musicbrainz_manual_review_required',
      'musicbrainz_matched_entity_unavailable'
    )
  ),
  lifecycle_state text not null check (lifecycle_state in ('active', 'resolved')),
  safe_display_context text not null check (
    char_length(safe_display_context) between 1 and 2048
  ),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  related_job_id bigint,
  observed_at timestamptz not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  resolved_at timestamptz,
  resolution_source text check (
    resolution_source is null or char_length(resolution_source) between 1 and 64
  ),
  unique (library_id, id),
  foreign key (library_id, local_artist_id) references library.local_artists(library_id, id) on delete cascade,
  foreign key (library_id, related_job_id) references ops.metadata_enrichment_jobs(library_id, id) on delete restrict,
  check (
    (lifecycle_state = 'active' and resolved_at is null and resolution_source is null)
    or (lifecycle_state = 'resolved' and resolved_at is not null and resolution_source is not null)
  )
);

create unique index if not exists metadata_enrichment_problems_active_idx on library.metadata_enrichment_problems (library_id, local_artist_id, reason_code) where lifecycle_state = 'active';
create index if not exists metadata_enrichment_problems_history_idx
  on library.metadata_enrichment_problems
  (library_id, local_artist_id, last_observed_at desc, id desc);

revoke all on table
  integration.musicbrainz_artists,
  integration.musicbrainz_artist_aliases,
  integration.musicbrainz_artist_countries,
  integration.musicbrainz_artist_tags,
  library.local_artist_musicbrainz_matches,
  library.local_artist_musicbrainz_candidates,
  ops.metadata_enrichment_jobs,
  library.metadata_enrichment_problems
from public;

revoke all on sequence
  library.local_artist_musicbrainz_matches_id_seq,
  library.local_artist_musicbrainz_candidates_id_seq,
  ops.metadata_enrichment_jobs_id_seq,
  library.metadata_enrichment_problems_id_seq
from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table integration.musicbrainz_artists to album_haven_readonly;
    grant select on table integration.musicbrainz_artist_aliases to album_haven_readonly;
    grant select on table integration.musicbrainz_artist_countries to album_haven_readonly;
    grant select on table integration.musicbrainz_artist_tags to album_haven_readonly;
    grant select on table library.local_artist_musicbrainz_matches to album_haven_readonly;
    grant select on table library.local_artist_musicbrainz_candidates to album_haven_readonly;
    grant select on table ops.metadata_enrichment_jobs to album_haven_readonly;
    grant select on table library.metadata_enrichment_problems to album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table integration.musicbrainz_artists to album_haven_app;
    grant select, insert, update on table integration.musicbrainz_artist_aliases to album_haven_app;
    grant select, insert, update on table integration.musicbrainz_artist_countries to album_haven_app;
    grant select, insert, update on table integration.musicbrainz_artist_tags to album_haven_app;
    grant select, insert, update on table library.local_artist_musicbrainz_matches to album_haven_app;
    grant select, insert, update on table library.local_artist_musicbrainz_candidates to album_haven_app;
    grant select, insert, update on table ops.metadata_enrichment_jobs to album_haven_app;
    grant select, insert, update on table library.metadata_enrichment_problems to album_haven_app;
    grant delete on table integration.musicbrainz_artist_aliases to album_haven_app;
    grant delete on table integration.musicbrainz_artist_countries to album_haven_app;
    grant delete on table integration.musicbrainz_artist_tags to album_haven_app;
    grant delete on table library.local_artist_musicbrainz_candidates to album_haven_app;
    grant usage, select on sequence
      library.local_artist_musicbrainz_matches_id_seq,
      library.local_artist_musicbrainz_candidates_id_seq,
      ops.metadata_enrichment_jobs_id_seq,
      library.metadata_enrichment_problems_id_seq
    to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table integration.musicbrainz_artists to album_haven_migrator;
    grant select, insert, update on table integration.musicbrainz_artist_aliases to album_haven_migrator;
    grant select, insert, update on table integration.musicbrainz_artist_countries to album_haven_migrator;
    grant select, insert, update on table integration.musicbrainz_artist_tags to album_haven_migrator;
    grant select, insert, update on table library.local_artist_musicbrainz_matches to album_haven_migrator;
    grant select, insert, update on table library.local_artist_musicbrainz_candidates to album_haven_migrator;
    grant select, insert, update on table ops.metadata_enrichment_jobs to album_haven_migrator;
    grant select, insert, update on table library.metadata_enrichment_problems to album_haven_migrator;
    grant usage, select on sequence
      library.local_artist_musicbrainz_matches_id_seq,
      library.local_artist_musicbrainz_candidates_id_seq,
      ops.metadata_enrichment_jobs_id_seq,
      library.metadata_enrichment_problems_id_seq
    to album_haven_migrator;
  end if;
end $$;

create or replace view integration.musicbrainz_artist_display_genres as
with eligible as (
  select tags.artist_mbid, tags.tag_name, tags.tag_normalized, tags.vote_count
  from integration.musicbrainz_artist_tags tags
  where tags.is_genre is true
    and (
      tags.vote_count > 0
      or (
        tags.vote_count = 0
        and not exists (
          select 1
          from integration.musicbrainz_artist_tags positive
          where positive.artist_mbid = tags.artist_mbid
            and positive.is_genre is true
            and positive.vote_count > 0
        )
      )
    )
), ranked as (
  select
    artist_mbid,
    tag_name,
    tag_normalized,
    vote_count,
    row_number() over (
      partition by artist_mbid
      order by vote_count desc, tag_normalized asc
    ) as display_rank
  from eligible
)
select artist_mbid, tag_name, tag_normalized, vote_count, display_rank
from ranked
where display_rank <= 3;

revoke all on table integration.musicbrainz_artist_display_genres from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table integration.musicbrainz_artist_display_genres
    from album_haven_readonly;
    grant select on table integration.musicbrainz_artist_display_genres
    to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table integration.musicbrainz_artist_display_genres
    from album_haven_app;
    grant select on table integration.musicbrainz_artist_display_genres
    to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select on table integration.musicbrainz_artist_display_genres
    to album_haven_migrator;
  end if;
end $$;
