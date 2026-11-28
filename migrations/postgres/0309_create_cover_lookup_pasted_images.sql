-- Additive: images a user pasted into an album's Cover Look Up (PASTED IMAGES), kept between opens. Only the
-- pasting account sees its rows; read and written per key (account, album, content hash). At most 10 rows per
-- account and album and 32 MB per image (enforced by the application). A row is removed when its card is
-- deleted, when it is saved as the album cover, when the album leaves the library (cascade), or after 7 days
-- unused (expired rows are found through the last_used_at index, never by a table sweep).
-- Rollback: drop the table; no other rows refer to it.
create table if not exists library.cover_lookup_pasted_images (
  account_id bigint not null references app.accounts(id) on delete cascade,
  album_id bigint not null references library.local_albums(id) on delete cascade,
  content_sha256 text not null,
  mime_type text not null,
  filename text not null default '',
  width integer,
  height integer,
  image bytea not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  primary key (account_id, album_id, content_sha256),
  constraint cover_lookup_pasted_images_hash_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint cover_lookup_pasted_images_mime_check check (mime_type like 'image/%'),
  constraint cover_lookup_pasted_images_size_check check (
    octet_length(image) > 0 and octet_length(image) <= 33554432
  )
);

create index if not exists cover_lookup_pasted_images_album_order_idx
  on library.cover_lookup_pasted_images (account_id, album_id, created_at);

create index if not exists cover_lookup_pasted_images_last_used_idx
  on library.cover_lookup_pasted_images (last_used_at);

create index if not exists cover_lookup_pasted_images_album_idx
  on library.cover_lookup_pasted_images (album_id);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.cover_lookup_pasted_images to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.cover_lookup_pasted_images to album_haven_migrator;
  end if;
end $$;
