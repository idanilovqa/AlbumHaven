alter table app.user_appearance_preferences
  add column if not exists client_profile text not null default 'desktop',
  add column if not exists compact_player_style text not null default 'docked';

do $$
declare current_primary_key text;
begin
  select conname into current_primary_key from pg_constraint
  where conrelid = 'app.user_appearance_preferences'::regclass and contype = 'p';
  if current_primary_key is not null and current_primary_key <> 'user_appearance_preferences_pkey_v2' then
    execute format('alter table app.user_appearance_preferences drop constraint %I', current_primary_key);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'app.user_appearance_preferences'::regclass and conname = 'user_appearance_preferences_pkey_v2') then
    alter table app.user_appearance_preferences add constraint user_appearance_preferences_pkey_v2 primary key (account_id, client_profile);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'app.user_appearance_preferences'::regclass and conname = 'user_appearance_preferences_client_profile_check') then
    alter table app.user_appearance_preferences add constraint user_appearance_preferences_client_profile_check check (client_profile in ('desktop', 'mobile', 'tv', 'apple'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'app.user_appearance_preferences'::regclass and conname = 'user_appearance_preferences_compact_player_style_check') then
    alter table app.user_appearance_preferences add constraint user_appearance_preferences_compact_player_style_check check (compact_player_style in ('docked', 'floating'));
  end if;
end $$;
