create table if not exists ops.virtual_release_snapshots (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  virtual_release_ref text not null,
  title text not null,
  artist_credit jsonb not null default '[]'::jsonb,
  release_kind text,
  release_date text,
  release_date_precision text not null default 'unknown',
  source_attributions jsonb not null default '[]'::jsonb,
  source_provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_enriched_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists virtual_release_snapshots_library_id_idx
  on ops.virtual_release_snapshots (library_id);

create index if not exists virtual_release_snapshots_expiry_idx
  on ops.virtual_release_snapshots (library_id, expires_at)
  where not metadata ? 'purged_at';

create unique index if not exists virtual_release_snapshots_library_ref_idx
  on ops.virtual_release_snapshots (library_id, virtual_release_ref);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table ops.virtual_release_snapshots to album_haven_readonly';
    execute 'grant select on sequence ops.virtual_release_snapshots_id_seq to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table ops.virtual_release_snapshots to album_haven_app';
    execute 'grant usage, select on sequence ops.virtual_release_snapshots_id_seq to album_haven_app';
  end if;
end $$;
