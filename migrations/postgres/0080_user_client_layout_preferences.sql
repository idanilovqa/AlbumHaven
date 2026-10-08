-- Presentation preferences follow an account, without coupling client categories.
create table if not exists app.user_client_layout_preferences (
  account_id bigint not null references app.accounts(id) on delete cascade,
  client_profile text not null check (client_profile in ('web_desktop', 'mobile', 'tv')),
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (account_id, client_profile)
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table app.user_client_layout_preferences to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table app.user_client_layout_preferences to album_haven_migrator;
  end if;
end $$;
