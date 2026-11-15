-- Additive ownership; rollback leaves this table unused, preserving listen data.
create table if not exists app.playback_claims (
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  client_id uuid not null,
  client_surface text not null check (client_surface in ('private_web', 'mobile')),
  token_digest bytea not null check (octet_length(token_digest) = 32),
  expires_at timestamptz not null,
  track jsonb not null check (jsonb_typeof(track) = 'object'),
  primary key (account_id, library_id)
);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on app.playback_claims to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on app.playback_claims to album_haven_migrator;
  end if;
end $$;
