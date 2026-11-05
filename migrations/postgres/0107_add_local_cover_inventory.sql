create table library.local_cover_inventories (
  library_id bigint not null references library.libraries(id) on delete cascade,
  root_path text not null,
  candidates jsonb not null default '[]'::jsonb,
  revision bigint not null default 1,
  indexed_revision bigint not null default 0,
  updated_at timestamptz,
  retry_after timestamptz,
  foreground_requested boolean not null default false,
  error text,
  primary key (library_id, root_path),
  constraint local_cover_inventory_candidates_array check (jsonb_typeof(candidates) = 'array'),
  constraint local_cover_inventory_revision check (revision > 0 and indexed_revision >= 0)
);

create table library.local_cover_inventory_contexts (
  library_id bigint not null references library.libraries(id) on delete cascade,
  context_key text not null,
  track_paths jsonb not null,
  revision bigint not null default 1,
  root_path text,
  retry_after timestamptz,
  foreground_requested boolean not null default false,
  error text,
  primary key (library_id, context_key),
  foreign key (library_id, root_path) references library.local_cover_inventories(library_id, root_path),
  constraint local_cover_context_paths_array check (jsonb_typeof(track_paths) = 'array')
);

create index local_cover_inventory_pending_idx
  on library.local_cover_inventories (library_id, retry_after, root_path)
  where indexed_revision < revision;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on library.local_cover_inventories to album_haven_app;
    grant select, insert, update on library.local_cover_inventory_contexts to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on library.local_cover_inventories to album_haven_migrator;
    grant select, insert, update, delete on library.local_cover_inventory_contexts to album_haven_migrator;
  end if;
end $$;
