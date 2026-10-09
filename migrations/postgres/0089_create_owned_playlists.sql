-- Owner-only Playlist persistence; no grants, presets or sharing policy change.
-- Draft receipt expiry never removes saved originals or operation-key tombstones.
create unique index if not exists local_tracks_library_id_id_idx
  on library.local_tracks(library_id, id);

create table if not exists app.playlists (
  ref uuid primary key,
  owner_account_id bigint not null references app.accounts(id),
  library_id bigint not null references library.libraries(id),
  title text not null check (length(btrim(title)) between 1 and 100),
  description text not null default '' check (length(description) <= 1000),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(ref, library_id)
);
create index if not exists playlists_owner_library_idx
  on app.playlists(owner_account_id, library_id, updated_at desc, ref);

create table if not exists app.playlist_items (
  ref uuid primary key,
  playlist_ref uuid not null,
  library_id bigint not null,
  position integer not null check (position > 0),
  original_local_track_id bigint check (original_local_track_id > 0),
  local_track_id bigint,
  title text,
  artist text,
  album_title text,
  original_album_id bigint,
  release_year integer,
  disc_number integer,
  track_number integer,
  duration_seconds numeric(12,3),
  source_ref uuid,
  source_entry_ref uuid,
  source_revision uuid,
  created_at timestamptz not null default now(),
  foreign key(playlist_ref, library_id) references app.playlists(ref, library_id) on delete cascade,
  foreign key(library_id, local_track_id) references library.local_tracks(library_id, id)
    on delete set null(local_track_id),
  constraint playlist_items_position_unique unique(playlist_ref, position) deferrable initially deferred,
  unique(playlist_ref, original_local_track_id)
);
create index if not exists playlist_items_current_track_idx
  on app.playlist_items(library_id, local_track_id) where local_track_id is not null;

create table if not exists app.playlist_creation_sources (
  ref uuid primary key,
  actor_account_id bigint not null references app.accounts(id) on delete cascade,
  session_id bigint not null references app.account_sessions(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  revision uuid not null,
  protocol text not null check (protocol = 'library_selection_v1'),
  inventory_upper_id bigint not null check (inventory_upper_id >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists playlist_creation_sources_scope_idx
  on app.playlist_creation_sources(actor_account_id, session_id, library_id);
create index if not exists playlist_creation_sources_expiry_idx
  on app.playlist_creation_sources(expires_at);

create table if not exists app.playlist_creation_entries (
  ref uuid primary key,
  source_ref uuid not null references app.playlist_creation_sources(ref) on delete cascade,
  selection_ref uuid not null,
  original_local_track_id bigint not null check (original_local_track_id > 0),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  title text,
  artist text,
  album_title text,
  original_album_id bigint,
  release_year integer,
  disc_number integer,
  track_number integer,
  duration_seconds numeric(12,3),
  availability text not null check (availability in ('local', 'unresolved')),
  created_at timestamptz not null default now(),
  unique(source_ref, original_local_track_id, evidence_digest)
);
create index if not exists playlist_creation_entries_selection_idx
  on app.playlist_creation_entries(source_ref, selection_ref);

create table if not exists app.playlist_operations (
  actor_account_id bigint not null references app.accounts(id),
  library_id bigint not null references library.libraries(id),
  request_key uuid not null,
  -- Retained after session expiry/removal so old keys cannot create again.
  original_session_id bigint not null check (original_session_id > 0),
  action text not null check (action in ('create', 'save', 'add', 'remove', 'reorder')),
  playlist_ref uuid not null,
  command_digest text not null check (command_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default now(),
  primary key(actor_account_id, library_id, request_key)
);
create index if not exists playlist_operations_target_idx
  on app.playlist_operations(playlist_ref);

-- Account-owned collections and draft/operation receipts are private data.
-- Do not inherit the general readonly-role defaults from the schema bootstrap.
revoke all on app.playlists, app.playlist_items, app.playlist_creation_sources,
  app.playlist_creation_entries, app.playlist_operations from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlists, app.playlist_items, app.playlist_creation_sources,
      app.playlist_creation_entries, app.playlist_operations from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlists, app.playlist_items, app.playlist_creation_sources,
      app.playlist_creation_entries, app.playlist_operations from album_haven_app;
    grant select, insert, update on app.playlists, app.playlist_operations to album_haven_app;
    grant select, insert, update, delete on app.playlist_items,
      app.playlist_creation_sources to album_haven_app;
    grant select, insert on app.playlist_creation_entries to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlists, app.playlist_items, app.playlist_creation_sources,
      app.playlist_creation_entries, app.playlist_operations to album_haven_migrator;
  end if;
end $$;
