create table if not exists app.discovery_lookup_snapshots (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  lookup_ref text not null,
  created_at timestamptz not null default now(),
  status text not null,
  request_payload jsonb not null default '{}'::jsonb,
  results_payload jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists discovery_lookup_snapshots_account_id_idx
  on app.discovery_lookup_snapshots (account_id);

create unique index if not exists discovery_lookup_snapshots_account_ref_idx
  on app.discovery_lookup_snapshots (account_id, lookup_ref);

create index if not exists discovery_lookup_snapshots_account_created_idx
  on app.discovery_lookup_snapshots (account_id, created_at desc);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table app.discovery_lookup_snapshots to album_haven_readonly';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table app.discovery_lookup_snapshots to album_haven_app';
    execute 'grant usage, select on sequence app.discovery_lookup_snapshots_id_seq to album_haven_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table app.discovery_lookup_snapshots to album_haven_migrator';
    execute 'grant usage, select on sequence app.discovery_lookup_snapshots_id_seq to album_haven_migrator';
  end if;
end $$;
