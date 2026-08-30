create table if not exists app.virtual_artist_snapshots (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  virtual_artist_ref text not null,
  candidate_ref text not null,
  provider text not null,
  provider_artist_id text not null,
  display_name text not null,
  sort_name text not null,
  disambiguation_text text,
  default_release_scope text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists virtual_artist_snapshots_account_id_idx
  on app.virtual_artist_snapshots (account_id);

create unique index if not exists virtual_artist_snapshots_account_ref_idx
  on app.virtual_artist_snapshots (account_id, virtual_artist_ref);

create index if not exists virtual_artist_snapshots_account_expires_idx
  on app.virtual_artist_snapshots (account_id, expires_at);

create table if not exists app.virtual_artist_recent_lookups (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  actor_key text not null,
  virtual_artist_ref text not null,
  active_release_scope text not null,
  recorded_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists virtual_artist_recent_lookups_account_id_idx
  on app.virtual_artist_recent_lookups (account_id);

create unique index if not exists virtual_artist_recent_lookups_actor_ref_idx
  on app.virtual_artist_recent_lookups (account_id, actor_key, virtual_artist_ref);

create index if not exists virtual_artist_recent_lookups_actor_recorded_idx
  on app.virtual_artist_recent_lookups (account_id, actor_key, recorded_at desc);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table app.virtual_artist_snapshots, app.virtual_artist_recent_lookups to album_haven_readonly';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table app.virtual_artist_snapshots, app.virtual_artist_recent_lookups to album_haven_app';
    execute 'grant usage, select on sequence app.virtual_artist_snapshots_id_seq, app.virtual_artist_recent_lookups_id_seq to album_haven_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table app.virtual_artist_snapshots, app.virtual_artist_recent_lookups to album_haven_migrator';
    execute 'grant usage, select on sequence app.virtual_artist_snapshots_id_seq, app.virtual_artist_recent_lookups_id_seq to album_haven_migrator';
  end if;
end $$;
