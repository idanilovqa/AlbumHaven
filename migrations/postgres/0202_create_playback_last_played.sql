-- The last song a claim played and the place it was last heard at, once no client can take that claim up any
-- more (its page left and its handoff expired, or its holder's promise to fall silent lapsed). Play here
-- continues it; any start and sign-out remove it. One row per account and library, kept by key.
create table if not exists app.playback_last_played (
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  track jsonb not null check (jsonb_typeof(track) = 'object'),
  position_ms bigint check (position_ms >= 0),
  duration_ms bigint check (duration_ms >= 1),
  updated_at timestamptz not null,
  primary key (account_id, library_id),
  check ((position_ms is null) = (duration_ms is null))
);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on app.playback_last_played to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on app.playback_last_played to album_haven_migrator;
  end if;
end $$;
