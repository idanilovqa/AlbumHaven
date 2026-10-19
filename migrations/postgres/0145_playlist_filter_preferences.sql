-- Playlist-only, account/library/resource-isolated applied filter retention.
-- Existing account preference actions and Playlist Browse govern service access.
create table app.user_playlist_filter_preferences (
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  playlist_ref uuid not null,
  filters jsonb,
  expires_at timestamptz,
  revision bigint not null check (revision > 0),
  primary key(account_id,library_id,playlist_ref),
  foreign key(playlist_ref,library_id) references app.playlists(ref,library_id) on delete cascade,
  check ((filters is null and expires_at is null) or
    (filters is not null and jsonb_typeof(filters)='object' and
     octet_length(filters::text) <= 4096 and expires_at is not null))
);
revoke all on app.user_playlist_filter_preferences from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.user_playlist_filter_preferences from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.user_playlist_filter_preferences from album_haven_app;
    grant select,insert,update on app.user_playlist_filter_preferences to album_haven_app;
  end if;
end $$;
