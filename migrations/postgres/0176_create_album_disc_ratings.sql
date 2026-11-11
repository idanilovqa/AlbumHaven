-- App-owned per-user rating for one disc of a logical album. Like
-- app.album_ratings, an existing row is authority even when rating is null.
-- disc_key is the disc tag's first part, trimmed, whitespace-collapsed and
-- lowercased ("2", "bonus disc"); bonus discs are usually tagged with words
-- and carry no numeric disc number.
-- Disc rows follow album-key adoption through ON UPDATE CASCADE, so the
-- scan and tag-edit paths that re-key a local album need no separate update.
create table if not exists app.album_disc_ratings (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_key text not null,
  disc_key text not null,
  rating smallint,
  provenance text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint album_disc_ratings_disc_key_check check (
    disc_key <> '' and disc_key = lower(btrim(disc_key))
  ),
  constraint album_disc_ratings_rating_range_check check (
    rating is null or rating between 1 and 10
  ),
  constraint album_disc_ratings_local_album_fkey foreign key (library_id, album_key)
    references library.local_albums(library_id, album_key)
    on update cascade on delete cascade
);

create unique index if not exists album_disc_ratings_account_library_album_disc_idx
  on app.album_disc_ratings (account_id, library_id, album_key, disc_key);

create index if not exists album_disc_ratings_library_album_key_idx
  on app.album_disc_ratings (library_id, album_key);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table app.album_disc_ratings to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table app.album_disc_ratings to album_haven_app';
    execute 'grant usage, select on sequence app.album_disc_ratings_id_seq to album_haven_app';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table app.album_disc_ratings to album_haven_migrator';
    execute 'grant usage, select on sequence app.album_disc_ratings_id_seq to album_haven_migrator';
  end if;
end $$;
