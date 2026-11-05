-- Explicit user-chosen extra artboxes for an album. Slot 0 remains the album's
-- existing cover (library.local_albums); this table holds only slot 1, the one
-- additional artbox currently allowed. Rows are written only by an in-app
-- selection, never inferred from folder images or existing covers.
-- Rollback: drop the table; album, track, cover, and media rows are unchanged.
create table if not exists library.local_album_additional_artworks (
  album_id bigint not null references library.local_albums(id) on delete cascade,
  slot smallint not null,
  source_kind text not null,
  cover_path text,
  remote_url text,
  selected_by_account_id bigint,
  selected_at timestamptz not null default now(),
  primary key (album_id, slot),
  constraint local_album_additional_artworks_slot_check check (slot = 1),
  constraint local_album_additional_artworks_source_kind_check check (
    source_kind in ('local', 'remote')
  ),
  constraint local_album_additional_artworks_source_check check (
    (source_kind = 'local' and nullif(btrim(cover_path), '') is not null and remote_url is null)
    or (source_kind = 'remote' and nullif(btrim(remote_url), '') is not null and cover_path is null)
  )
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table
      library.local_album_additional_artworks
    to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table
      library.local_album_additional_artworks
    to album_haven_migrator;
  end if;
end $$;
