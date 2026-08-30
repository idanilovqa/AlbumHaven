create table if not exists library.local_album_cover_candidate_snapshots (
  album_id bigint primary key references library.local_albums(id) on delete cascade,
  search_generation uuid not null,
  search_kind text not null,
  status text not null,
  revision bigint not null default 0,
  candidates jsonb not null default '[]'::jsonb,
  best_candidate_id text,
  automatic_improvement_revision bigint not null default 0,
  seen_automatic_improvement_revision bigint not null default 0,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint local_album_cover_candidate_snapshots_search_kind_check check (
    search_kind in ('automatic', 'manual')
  ),
  constraint local_album_cover_candidate_snapshots_status_check check (
    status in ('running', 'completed', 'failed')
  ),
  constraint local_album_cover_candidate_snapshots_revision_check check (
    revision >= 0
  ),
  constraint local_album_cover_candidate_snapshots_automatic_improvement_revision_check check (
    automatic_improvement_revision >= 0
  ),
  constraint local_album_cover_candidate_snapshots_seen_automatic_improvement_revision_check check (
    seen_automatic_improvement_revision >= 0
  ),
  constraint local_album_cover_candidate_snapshots_candidates_array_check check (
    jsonb_typeof(candidates) = 'array'
  )
);

update library.local_albums
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{cover_selection_origin}',
  '"user"'::jsonb,
  true
)
where (
  nullif(btrim(cover_path), '') is not null
  or nullif(btrim(metadata ->> 'remote_cover_url'), '') is not null
)
and (
  metadata ->> 'cover_selection_origin' is null
  or metadata ->> 'cover_selection_origin' not in ('user', 'automatic')
);

do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'album_haven_app'
  ) then
    grant select, insert, update on table
      library.local_album_cover_candidate_snapshots
    to album_haven_app;
  end if;

  if exists (
    select 1
    from pg_roles
    where rolname = 'album_haven_migrator'
  ) then
    grant select, insert, update on table
      library.local_album_cover_candidate_snapshots
    to album_haven_migrator;
  end if;
end $$;
