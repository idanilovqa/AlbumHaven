-- Creation intent survives inventory/relationship changes and Artist deletion.
-- There is deliberately no cascading/rebinding foreign key to local_artists.
-- Current-library identity and Browse are validated by the existing service
-- transaction; this descriptor never grants access or regenerates members.
alter table app.album_lists
  add column listen_through_artist_id bigint,
  add column listen_through_scope_mode text,
  add constraint album_lists_listen_through_scope_check check (
    (listen_through_artist_id is null and listen_through_scope_mode is null)
    or (listen_through_artist_id is not null and listen_through_artist_id > 0
        and listen_through_scope_mode is not null
        and listen_through_scope_mode in ('artist', 'family'))
  );

-- Existing app.album_lists role grants are unchanged. No provider lookup,
-- membership rewrite, progress update or backfill occurs in this migration.
