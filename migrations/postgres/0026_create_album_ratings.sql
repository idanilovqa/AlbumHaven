create table if not exists app.album_ratings (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  album_key text not null,
  rating smallint,
  provenance text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint album_ratings_rating_range_check check (
    rating is null or rating between 1 and 10
  ),
  constraint album_ratings_local_album_fkey foreign key (library_id, album_key)
    references library.local_albums(library_id, album_key) on delete cascade
);

create unique index if not exists album_ratings_account_library_album_key_idx
  on app.album_ratings (account_id, library_id, album_key);

create index if not exists album_ratings_library_album_key_idx
  on app.album_ratings (library_id, album_key);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table app.album_ratings to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table app.album_ratings to album_haven_app';
    execute 'grant usage, select on sequence app.album_ratings_id_seq to album_haven_app';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    execute 'grant select, insert, update on table app.album_ratings to album_haven_migrator';
    execute 'grant usage, select on sequence app.album_ratings_id_seq to album_haven_migrator';
  end if;
end $$;
