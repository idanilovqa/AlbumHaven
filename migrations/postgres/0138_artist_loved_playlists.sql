-- Always-dynamic own-user Loved/Obsessed recipes over ordinary Playlists.
-- This adds storage only; route/command admission belongs to the complete slice.
alter table app.playlists
  add constraint playlists_recipe_owner_scope_key
  unique (ref, library_id, owner_account_id);

create table app.playlist_artist_loved_recipes (
  playlist_ref uuid primary key,
  library_id bigint not null,
  owner_account_id bigint not null,
  recipe_version smallint not null check (recipe_version = 1),
  -- Retain numeric provenance after inventory deletion. Never rebind by name.
  root_artist_id bigint not null check (root_artist_id > 0),
  scope_mode text not null check (scope_mode in ('artist', 'family')),
  playback_order text not null default 'regular'
    check (playback_order in ('regular', 'shuffle', 'unplayed_first')),
  last_evaluated_at timestamptz not null check (isfinite(last_evaluated_at)),
  root_state text not null default 'present'
    check (root_state in ('present', 'root_missing')),
  retired_at timestamptz check (retired_at is null or isfinite(retired_at)),
  constraint playlist_artist_loved_parent_owner_fk
    foreign key (playlist_ref, library_id, owner_account_id)
    references app.playlists (ref, library_id, owner_account_id) on delete cascade
);

-- A soft-deleted recipe remains provenance but releases its active identity.
-- The Playlist mutation owner retires it in the same transaction as its parent.
create unique index playlist_artist_loved_active_identity_idx
  on app.playlist_artist_loved_recipes
    (owner_account_id, library_id, root_artist_id, scope_mode)
  where retired_at is null;
create index playlist_artist_loved_library_idx
  on app.playlist_artist_loved_recipes (library_id, playlist_ref);

alter table app.playlist_creation_sources
  drop constraint playlist_creation_source_protocol_kind;
alter table app.playlist_creation_sources
  add constraint playlist_creation_source_protocol_kind check (
    (source_kind='library' and protocol in ('library_selection_v1',
      'complete_inventory_selection_v1','library_mix_selection_v1',
      'artist_popular_selection_v1','artist_loved_selection_v1'))
    or (source_kind='activity' and protocol in (
      'complete_activity_selection_v1','missing_activity_selection_v1'))
    or (source_kind='playlist' and protocol='missing_playlist_selection_v1')
  );
alter table app.playlist_items drop constraint playlist_items_source_protocol_kind;
alter table app.playlist_items add constraint playlist_items_source_protocol_kind check (
  source_protocol is null
  or (source_kind='library' and source_protocol in ('library_selection_v1',
    'complete_inventory_selection_v1','library_mix_selection_v1',
    'artist_popular_selection_v1','artist_loved_selection_v1'))
  or (source_kind='activity' and source_protocol in (
    'complete_activity_selection_v1','missing_activity_selection_v1'))
  or (source_kind='playlist' and source_protocol in (
    'missing_playlist_selection_v1','playlist_copy_v1'))
);

revoke all on app.playlist_artist_loved_recipes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_artist_loved_recipes from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlist_artist_loved_recipes from album_haven_app;
    grant select, insert on app.playlist_artist_loved_recipes to album_haven_app;
    -- Runtime may refresh/retire a recipe, not rewrite its retained identity.
    grant update (playback_order, last_evaluated_at, root_state, retired_at)
      on app.playlist_artist_loved_recipes to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_artist_loved_recipes to album_haven_migrator;
  end if;
end $$;
