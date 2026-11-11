create table if not exists library.cue_programs (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  library_root_id bigint not null references library.library_roots(id) on delete cascade,
  source_kind text not null,
  source_identity text not null,
  source_bytes bytea not null,
  revision_sha256 text not null,
  is_valid boolean not null default false,
  is_active boolean not null default false,
  problems jsonb not null default '[]'::jsonb,
  last_valid_program_id bigint references library.cue_programs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cue_programs_source_kind_check check (
    source_kind in ('external', 'embedded')
  ),
  constraint cue_programs_revision_sha256_check check (
    revision_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint cue_programs_problems_check check (
    jsonb_typeof(problems) = 'array'
  ),
  constraint cue_programs_active_valid_check check (
    not is_active or is_valid
  )
);

create index if not exists cue_programs_library_root_id_idx
  on library.cue_programs (library_root_id);

create index if not exists cue_programs_last_valid_program_id_idx
  on library.cue_programs (last_valid_program_id);

create unique index if not exists cue_programs_revision_idx
  on library.cue_programs (
    library_id, library_root_id, source_kind, source_identity, revision_sha256
  );

create unique index if not exists cue_programs_active_source_idx
  on library.cue_programs (library_id, library_root_id, source_kind, source_identity)
  where is_active is true;

create table if not exists library.cue_media_sources (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  library_root_id bigint not null references library.library_roots(id) on delete cascade,
  private_path text not null,
  decoded_duration_frames bigint,
  sample_rate integer,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint cue_media_sources_duration_check check (
    decoded_duration_frames is null or decoded_duration_frames >= 0
  ),
  constraint cue_media_sources_sample_rate_check check (
    sample_rate is null or sample_rate > 0
  ),
  constraint cue_media_sources_metadata_check check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists cue_media_sources_library_root_id_idx
  on library.cue_media_sources (library_root_id);

create unique index if not exists cue_media_sources_library_path_idx
  on library.cue_media_sources (library_id, private_path);

create table if not exists library.cue_track_segments (
  track_id bigint primary key references library.local_tracks(id) on delete cascade,
  program_id bigint not null references library.cue_programs(id) on delete cascade,
  media_source_id bigint not null references library.cue_media_sources(id) on delete restrict,
  program_ordinal integer not null,
  start_frame bigint not null,
  end_frame bigint not null,
  pregap_frames bigint not null default 0,
  postgap_frames bigint not null default 0,
  internal_indexes jsonb not null default '[]'::jsonb,
  source_revision_sha256 text not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cue_track_segments_ordinal_check check (program_ordinal >= 0),
  constraint cue_track_segments_frame_order_check check (
    start_frame >= 0 and end_frame > start_frame
  ),
  constraint cue_track_segments_gap_check check (
    pregap_frames >= 0 and postgap_frames >= 0
  ),
  constraint cue_track_segments_internal_indexes_check check (
    jsonb_typeof(internal_indexes) = 'array'
  ),
  constraint cue_track_segments_revision_check check (
    source_revision_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint cue_track_segments_provenance_check check (
    jsonb_typeof(provenance) = 'object'
  )
);

create index if not exists cue_track_segments_program_id_idx
  on library.cue_track_segments (program_id);

create index if not exists cue_track_segments_media_source_id_idx
  on library.cue_track_segments (media_source_id);

create table if not exists library.cue_corrections (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  track_id bigint not null references library.local_tracks(id) on delete cascade,
  account_id bigint not null references app.accounts(id) on delete cascade,
  base_program_id bigint not null references library.cue_programs(id) on delete restrict,
  correction_kind text not null,
  payload jsonb not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  restored_at timestamptz,
  constraint cue_corrections_kind_check check (btrim(correction_kind) <> ''),
  constraint cue_corrections_payload_check check (
    jsonb_typeof(payload) = 'object'
  ),
  constraint cue_corrections_status_check check (
    status in ('active', 'restored')
  ),
  constraint cue_corrections_restored_at_check check (
    (status = 'active' and restored_at is null)
    or (status = 'restored' and restored_at is not null)
  )
);

create index if not exists cue_corrections_library_id_idx
  on library.cue_corrections (library_id);

create index if not exists cue_corrections_track_id_idx
  on library.cue_corrections (track_id);

create index if not exists cue_corrections_account_id_idx
  on library.cue_corrections (account_id);

create index if not exists cue_corrections_base_program_id_idx
  on library.cue_corrections (base_program_id);

create unique index if not exists cue_corrections_active_kind_idx
  on library.cue_corrections (library_id, track_id, account_id, correction_kind)
  where status = 'active';

revoke all on table
  library.cue_programs,
  library.cue_media_sources,
  library.cue_track_segments,
  library.cue_corrections
from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table
      library.cue_programs,
      library.cue_media_sources,
      library.cue_track_segments,
      library.cue_corrections
    from album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table
      library.cue_programs,
      library.cue_media_sources,
      library.cue_track_segments,
      library.cue_corrections
    from album_haven_app;
    grant select, insert, update on table library.cue_programs to album_haven_app;
    grant select, insert, update on table library.cue_media_sources to album_haven_app;
    grant select, insert, update, delete on table library.cue_track_segments to album_haven_app;
    grant select, insert, update on table library.cue_corrections to album_haven_app;
    grant usage, select on sequence
      library.cue_programs_id_seq,
      library.cue_media_sources_id_seq,
      library.cue_corrections_id_seq
    to album_haven_app;
  end if;
end;
$$;
