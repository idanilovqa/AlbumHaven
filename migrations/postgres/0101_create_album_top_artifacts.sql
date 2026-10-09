-- Album Tops and their public presentation share one artifact identity.
-- Catalog identity is separate from local inventory and never derived from paths.
create schema if not exists catalog;
revoke all on schema catalog from public;
create unique index if not exists local_albums_library_id_id_idx
  on library.local_albums(library_id, id);

create table catalog.release_groups (
  ref uuid primary key,
  title text not null check (length(btrim(title)) between 1 and 1000),
  artist_display text not null check (length(btrim(artist_display)) between 1 and 1000),
  release_year integer check (release_year between 1 and 9999),
  created_at timestamptz not null default now()
);

-- Admission is evidence for a stable record, not an assertion that similarly
-- named albums or editions in another library are equivalent.
create table library.catalog_album_links (
  library_id bigint not null references library.libraries(id) on delete cascade,
  local_album_id bigint primary key,
  catalog_ref uuid not null references catalog.release_groups(ref),
  admitted_at timestamptz not null default now(),
  foreign key(library_id, local_album_id)
    references library.local_albums(library_id, id) on delete cascade,
  unique(library_id, catalog_ref)
);
create index catalog_album_links_catalog_idx on library.catalog_album_links(catalog_ref);

create table app.album_lists (
  ref uuid primary key,
  id bigint generated always as identity unique,
  owner_account_id bigint not null references app.accounts(id),
  library_id bigint not null references library.libraries(id),
  title text not null check (length(btrim(title)) between 1 and 100),
  description text not null default '' check (length(description) <= 1000),
  visibility text not null default 'private' check (visibility = 'private'),
  revision bigint not null default 1 check (revision > 0),
  next_original_position bigint not null default 1 check (next_original_position > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(ref, library_id)
);
create index album_lists_owner_library_idx
  on app.album_lists(owner_account_id, library_id, id)
  where deleted_at is null;

create table app.album_list_items (
  ref uuid primary key,
  top_ref uuid not null,
  library_id bigint not null,
  catalog_ref uuid not null references catalog.release_groups(ref),
  original_position bigint not null check (original_position > 0),
  curator_position integer not null check (curator_position > 0),
  created_at timestamptz not null default now(),
  foreign key(top_ref, library_id) references app.album_lists(ref, library_id) on delete cascade,
  unique(top_ref, catalog_ref),
  unique(top_ref, original_position),
  constraint album_list_items_curator_position_unique
    unique(top_ref, curator_position) deferrable initially deferred
);
create index album_list_items_catalog_idx on app.album_list_items(catalog_ref);

create table app.album_list_operations (
  actor_account_id bigint not null references app.accounts(id),
  library_id bigint not null references library.libraries(id),
  request_key uuid not null,
  original_session_id bigint not null check (original_session_id > 0),
  action text not null check (action in ('create','save','add','remove','reorder','delete')),
  top_ref uuid not null,
  command_digest text not null check (command_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default now(),
  primary key(actor_account_id, library_id, request_key)
);
create index album_list_operations_target_idx on app.album_list_operations(top_ref);

revoke all on catalog.release_groups, library.catalog_album_links,
  app.album_lists, app.album_list_items, app.album_list_operations from public;
revoke all on sequence app.album_lists_id_seq from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on catalog.release_groups, library.catalog_album_links,
      app.album_lists, app.album_list_items, app.album_list_operations from album_haven_readonly;
    revoke all on sequence app.album_lists_id_seq from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on catalog.release_groups, library.catalog_album_links,
      app.album_lists, app.album_list_items, app.album_list_operations from album_haven_app;
    revoke all on sequence app.album_lists_id_seq from album_haven_app;
    grant usage on schema catalog to album_haven_app;
    grant select, insert on catalog.release_groups, library.catalog_album_links,
      app.album_list_operations to album_haven_app;
    grant select, insert, update on app.album_lists to album_haven_app;
    grant usage, select on sequence app.album_lists_id_seq to album_haven_app;
    grant select, insert, update, delete on app.album_list_items to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant usage on schema catalog to album_haven_migrator;
    grant usage, select on sequence app.album_lists_id_seq to album_haven_migrator;
    grant all on catalog.release_groups, library.catalog_album_links,
      app.album_lists, app.album_list_items, app.album_list_operations to album_haven_migrator;
  end if;
end $$;
