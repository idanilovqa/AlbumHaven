create table if not exists app.user_discovery_preferences (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  preference_scope text not null,
  preferences_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists user_discovery_preferences_account_id_idx
  on app.user_discovery_preferences (account_id);

create unique index if not exists user_discovery_preferences_account_scope_idx
  on app.user_discovery_preferences (account_id, preference_scope);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table app.user_discovery_preferences to album_haven_readonly';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table app.user_discovery_preferences to album_haven_app';
    execute 'grant usage, select on sequence app.user_discovery_preferences_id_seq to album_haven_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table app.user_discovery_preferences to album_haven_migrator';
    execute 'grant usage, select on sequence app.user_discovery_preferences_id_seq to album_haven_migrator';
  end if;
end $$;
