-- Same-server visibility and explicit editor eligibility, independent of playback.
-- Ownership stays immutable in app.playlists; deletion retains recoverable data.
alter table app.playlists
  add column visibility text not null default 'private'
    check (visibility in ('private', 'server_shared')),
  add column deleted_at timestamptz;

create index playlists_live_library_idx
  on app.playlists(library_id, updated_at desc, ref) where deleted_at is null;

create table app.playlist_access_grants (
  ref uuid primary key,
  playlist_ref uuid not null,
  library_id bigint not null,
  account_id bigint not null,
  role text not null check (role = 'editor'),
  created_at timestamptz not null default now(),
  foreign key(playlist_ref, library_id) references app.playlists(ref, library_id) on delete cascade,
  foreign key(library_id, account_id)
    references library.library_memberships(library_id, account_id) on delete cascade,
  unique(playlist_ref, account_id)
);
create index playlist_access_grants_member_idx
  on app.playlist_access_grants(library_id, account_id, playlist_ref);

alter table app.playlist_operations drop constraint playlist_operations_action_check;
alter table app.playlist_operations add constraint playlist_operations_action_check
  check (action in ('create', 'save', 'add', 'remove', 'reorder',
                   'visibility', 'grant_editor', 'revoke_editor', 'delete'));

-- Access-grant records remain private to the authenticated application.
revoke all on app.playlist_access_grants from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_access_grants from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlist_access_grants from album_haven_app;
    grant select, insert, delete on app.playlist_access_grants to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_access_grants to album_haven_migrator;
  end if;
end $$;


-- Opaque continuation receipts prevent hidden inventory order facts entering
-- browser keyset tokens. The authenticated source header owns their expiry.
create table app.playlist_source_cursors (
  ref uuid primary key,
  source_ref uuid not null references app.playlist_creation_sources(ref) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096),
  created_at timestamptz not null default now()
);
create index playlist_source_cursors_source_idx on app.playlist_source_cursors(source_ref);
revoke all on app.playlist_source_cursors from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_source_cursors from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlist_source_cursors from album_haven_app;
    grant select, insert on app.playlist_source_cursors to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_source_cursors to album_haven_migrator;
  end if;
end $$;
