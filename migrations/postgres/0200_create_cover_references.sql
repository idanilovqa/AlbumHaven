-- Additive: opaque names for local cover images, so no file path leaves the server.
-- A reference names one image file of one library and never changes while the file keeps its path.
-- 'candidate' images (other art in an album folder) widen to 'cover' once they become a cover;
-- a kind never narrows. Rollback leaves the table unused.
create table if not exists library.cover_references (
  reference text primary key
    default rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '='),
  library_id bigint not null references library.libraries(id) on delete cascade,
  private_path text not null,
  kind text not null default 'cover',
  first_seen_at timestamptz not null default now(),
  constraint cover_references_reference_check check (reference ~ '^[A-Za-z0-9_-]{22}$'),
  constraint cover_references_kind_check check (kind in ('cover', 'candidate')),
  constraint cover_references_private_path_check check (btrim(private_path) <> '')
);

create unique index if not exists cover_references_library_path_idx
  on library.cover_references (library_id, private_path);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    -- Schema default privileges grant table-wide UPDATE; a reference may only widen its kind.
    revoke update, delete, truncate on library.cover_references from album_haven_app;
    grant select, insert, update (kind) on library.cover_references to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.cover_references to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.cover_references to album_haven_migrator;
  end if;
end $$;
