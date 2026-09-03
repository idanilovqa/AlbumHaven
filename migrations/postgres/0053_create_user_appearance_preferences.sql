create table if not exists app.user_appearance_preferences (
  account_id bigint primary key references app.accounts(id) on delete cascade,
  main_surface_color text check (main_surface_color ~ '^#[0-9A-F]{6}$'),
  panel_background_color text check (panel_background_color ~ '^#[0-9A-F]{6}$'),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table app.user_appearance_preferences to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table app.user_appearance_preferences to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table app.user_appearance_preferences to album_haven_migrator;
  end if;
end $$;
