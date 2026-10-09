-- Account-owned Regular/Shuffle memory. Repeat modes never enter durable state.
create table app.user_playlist_playback_preferences (
  account_id bigint primary key references app.accounts(id) on delete cascade,
  remember_order_mode boolean not null default true,
  last_order_mode text not null default 'regular' check (last_order_mode in ('regular','shuffle')),
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default now()
);
create table app.playlist_preference_operations (
  account_id bigint not null references app.accounts(id) on delete cascade,
  request_key uuid not null,
  original_session_id bigint not null check (original_session_id > 0),
  command_digest text not null check (command_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt)='object'),
  created_at timestamptz not null default now(),
  primary key(account_id,request_key)
);
revoke all on app.user_playlist_playback_preferences, app.playlist_preference_operations from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.user_playlist_playback_preferences, app.playlist_preference_operations from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.user_playlist_playback_preferences, app.playlist_preference_operations from album_haven_app;
    grant select,insert,update on app.user_playlist_playback_preferences to album_haven_app;
    grant select,insert on app.playlist_preference_operations to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.user_playlist_playback_preferences, app.playlist_preference_operations to album_haven_migrator;
  end if;
end $$;


-- Saved header choice is metadata. Playlist item positions remain authored order.
alter table app.playlists add column default_sort jsonb
  check (default_sort is null or (
    jsonb_typeof(default_sort)='object' and default_sort ?& array['key','direction']
    and jsonb_typeof(default_sort->'key')='string' and jsonb_typeof(default_sort->'direction')='string'
    and default_sort-'key'-'direction'='{}'::jsonb
    and default_sort->>'key' in ('love_tier','play_count','popularity_count','duration')
    and default_sort->>'direction' in ('asc','desc')
  ));
alter table app.playlist_operations drop constraint playlist_operations_action_check;
alter table app.playlist_operations add constraint playlist_operations_action_check
  check (action in ('create','save','add','remove','reorder',
    'visibility','grant_editor','revoke_editor','delete','default_sort'));
