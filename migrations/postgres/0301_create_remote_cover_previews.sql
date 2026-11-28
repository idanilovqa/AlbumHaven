-- Additive: the card-sized preview of each Cover Look Up remote candidate image, one row per normalized
-- image URL, read and written per key. A restarted app serves a candidate card from this row instead of
-- downloading the image from its provider again. Rows are derived provider data and hold no user choice.
-- Rollback leaves the table unused.
create table if not exists library.remote_cover_previews (
  cache_key text primary key,
  payload bytea not null,
  mime_type text,
  updated_at timestamptz not null default now(),
  constraint remote_cover_previews_key_check check (btrim(cache_key) <> ''),
  constraint remote_cover_previews_payload_check check (octet_length(payload) > 0)
);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.remote_cover_previews to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.remote_cover_previews to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.remote_cover_previews to album_haven_migrator;
  end if;
end $$;
