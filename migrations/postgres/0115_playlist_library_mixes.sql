-- Library Mix recipes belong to ordinary owned Playlists. They grant no access.
create table app.playlist_library_mixes (
  playlist_ref uuid primary key,
  library_id bigint not null,
  recipe_version integer not null check (recipe_version = 1),
  source text not null check (source = 'whole_library'),
  provider text not null check (provider = 'lastfm'),
  metric text not null check (metric = 'overall_scrobbles'),
  selection_basis text not null check (selection_basis in ('per_artist', 'per_album')),
  songs_per_group integer not null check (songs_per_group between 1 and 5000),
  auto_update boolean not null,
  playback_order text not null default 'regular'
    check (playback_order in ('regular', 'shuffle', 'unplayed_first')),
  last_evaluated_at timestamptz not null check (isfinite(last_evaluated_at)),
  coverage jsonb not null check (jsonb_typeof(coverage) = 'object'),
  foreign key(playlist_ref, library_id)
    references app.playlists(ref, library_id) on delete cascade
);
create index playlist_library_mixes_library_idx
  on app.playlist_library_mixes(library_id, playlist_ref);

alter table app.playlist_creation_sources
  drop constraint playlist_creation_source_protocol_kind;
alter table app.playlist_creation_sources
  add constraint playlist_creation_source_protocol_kind check (
    (source_kind='library' and protocol in (
      'library_selection_v1', 'complete_inventory_selection_v1', 'library_mix_selection_v1'))
    or (source_kind='activity' and protocol in (
      'complete_activity_selection_v1', 'missing_activity_selection_v1'))
    or (source_kind='playlist' and protocol='missing_playlist_selection_v1')
  );
alter table app.playlist_items drop constraint playlist_items_source_protocol_kind;
alter table app.playlist_items add constraint playlist_items_source_protocol_kind check (
  source_protocol is null
  or (source_kind='library' and source_protocol in (
    'library_selection_v1', 'complete_inventory_selection_v1', 'library_mix_selection_v1'))
  or (source_kind='activity' and source_protocol in (
    'complete_activity_selection_v1', 'missing_activity_selection_v1'))
  or (source_kind='playlist' and source_protocol in (
    'missing_playlist_selection_v1', 'playlist_copy_v1'))
);

revoke all on app.playlist_library_mixes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_library_mixes from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlist_library_mixes from album_haven_app;
    grant select, insert, update on app.playlist_library_mixes to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_library_mixes to album_haven_migrator;
  end if;
end $$;
