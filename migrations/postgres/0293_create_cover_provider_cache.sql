-- Additive: cover provider answers (cover searches, MusicBrainz release lists, Cover Art Archive results)
-- as one row per normalized query, read and written per key. Replaces the whole-file cover_search_cache.json.
-- The primary key is the lookup index. Rows are derived provider data and hold no user choice.
-- Rollback leaves the tables unused.
create table if not exists library.cover_provider_cache_entries (
  cache_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  constraint cover_provider_cache_entries_key_check check (btrim(cache_key) <> ''),
  constraint cover_provider_cache_entries_payload_check check (jsonb_typeof(payload) = 'object')
);

-- The one-time import of an existing cover_search_cache.json: one row once it has finished.
create table if not exists library.cover_provider_cache_imports (
  source text primary key,
  entry_count integer not null,
  imported_at timestamptz not null default now(),
  constraint cover_provider_cache_imports_source_check check (source in ('cover_search_cache_json'))
);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.cover_provider_cache_entries to album_haven_app;
    grant select, insert on library.cover_provider_cache_imports to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.cover_provider_cache_entries, library.cover_provider_cache_imports
      to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.cover_provider_cache_entries, library.cover_provider_cache_imports
      to album_haven_migrator;
  end if;
end $$;
