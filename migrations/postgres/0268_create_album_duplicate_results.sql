-- depends on: 0188_create_problematic_files_index.sql
-- Gallery and search cards read each album's duplicate result from this table
-- instead of computing it per request (FTC-TAGS-015: a cold 41-album search spent
-- about 1 s finding duplicates). It is derived output only, never user intent.
--
-- The Problematic Files index evaluation (music_app/services/problematic_index.py)
-- writes it: the albums the 0188 journal marks, plus every album that shares a
-- duplicate identity with them before or after the change, so a pair a save forms
-- or breaks rewrites both albums' rows together. linked_album_ids names the other
-- albums a result was computed from (source tracks, stray-copy links): a change to
-- any of them rewrites the row. A row exists only where the result
-- changes a card (the album has duplicates or spans several years); a missing row
-- means no duplicate. album_duplicate_results_state records the result version a
-- one-time backfill over every album filled; a different version backfills only
-- this table, never the Problematic Files items.

create table if not exists library.album_duplicate_results (
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_id bigint not null,
  album_key text not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  linked_album_ids bigint[] not null default '{}',
  primary key (library_id, album_id)
);
create index if not exists album_duplicate_results_album_key_idx
  on library.album_duplicate_results (library_id, album_key);
create index if not exists album_duplicate_results_linked_albums_idx
  on library.album_duplicate_results using gin (linked_album_ids);

create table if not exists library.album_duplicate_results_state (
  library_id bigint primary key references library.libraries(id) on delete cascade,
  version text not null,
  status text not null check (status in ('building', 'ready')),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.album_duplicate_results, library.album_duplicate_results_state to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.album_duplicate_results, library.album_duplicate_results_state to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.album_duplicate_results, library.album_duplicate_results_state to album_haven_migrator;
  end if;
end $$;
