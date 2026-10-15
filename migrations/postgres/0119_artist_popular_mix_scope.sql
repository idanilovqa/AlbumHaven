alter table app.playlist_library_mixes
  drop constraint playlist_library_mixes_recipe_version_check,
  drop constraint playlist_library_mixes_source_check;
alter table app.playlist_library_mixes
  add column artist_categories text[],
  add column artist_album_types text[],
  add constraint playlist_library_mix_artist_filters check (
    (source='whole_library' and artist_categories is null and artist_album_types is null)
    or (source='artist_selection' and artist_categories is not null and artist_album_types is not null
      and artist_categories <@ array['main_library','new_arrivals','hoard']::text[]
      and artist_album_types <@ array['studio','ep','live','demo','compilation','single']::text[]
      and array_position(artist_categories,null) is null and array_position(artist_album_types,null) is null)),
  add constraint playlist_library_mixes_typed_source check (
    (recipe_version=1 and source='whole_library')
    or (recipe_version=2 and source='artist_selection')),
  add constraint playlist_library_mixes_scope_parent unique(playlist_ref,library_id,source);

create table app.playlist_library_mix_artists (
  playlist_ref uuid not null,
  library_id bigint not null,
  source text not null check(source='artist_selection'),
  original_artist_id bigint not null check(original_artist_id>0),
  membership_basis text not null check(membership_basis in ('primary_credit','family_credit')),
  primary key(playlist_ref,original_artist_id),
  foreign key(playlist_ref,library_id,source)
    references app.playlist_library_mixes(playlist_ref,library_id,source) on delete cascade
);
create table app.playlist_library_mix_albums (
  playlist_ref uuid not null,
  library_id bigint not null,
  source text not null check(source='artist_selection'),
  original_album_id bigint not null check(original_album_id>0),
  source_position integer not null check(source_position>=0),
  primary key(playlist_ref,original_album_id),
  unique(playlist_ref,source_position),
  foreign key(playlist_ref,library_id,source)
    references app.playlist_library_mixes(playlist_ref,library_id,source) on delete cascade
);

-- Original inventory IDs are provenance. Live inventory deletion must not
-- erase scope, prevent maintenance, or rebind a recipe to a same-name Artist.
create function app.check_playlist_library_mix_artist_scope() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare candidate uuid; references_to_check uuid[];
begin
  if TG_OP='INSERT' then references_to_check:=array[NEW.playlist_ref];
  elsif TG_OP='DELETE' then references_to_check:=array[OLD.playlist_ref];
  else references_to_check:=array[OLD.playlist_ref,NEW.playlist_ref]; end if;
  foreach candidate in array references_to_check loop
    if exists(select 1 from app.playlist_library_mixes m
       where m.playlist_ref=candidate and m.source='artist_selection'
       and not exists(select 1 from app.playlist_library_mix_artists a
         where a.playlist_ref=m.playlist_ref and a.library_id=m.library_id)) then
      raise check_violation using message='Artist recipe requires retained Artist scope';
    end if;
  end loop;
  return null;
end $$;
create constraint trigger playlist_library_mix_scope_parent
after insert or update or delete on app.playlist_library_mixes
deferrable initially deferred for each row
execute function app.check_playlist_library_mix_artist_scope();
create constraint trigger playlist_library_mix_scope_child
after insert or update or delete on app.playlist_library_mix_artists
deferrable initially deferred for each row
execute function app.check_playlist_library_mix_artist_scope();

alter table app.playlist_creation_sources drop constraint playlist_creation_source_protocol_kind;
alter table app.playlist_creation_sources add constraint playlist_creation_source_protocol_kind check (
  (source_kind='library' and protocol in ('library_selection_v1',
    'complete_inventory_selection_v1','library_mix_selection_v1','artist_popular_selection_v1'))
  or (source_kind='activity' and protocol in ('complete_activity_selection_v1','missing_activity_selection_v1'))
  or (source_kind='playlist' and protocol='missing_playlist_selection_v1')
);
alter table app.playlist_items drop constraint playlist_items_source_protocol_kind;
alter table app.playlist_items add constraint playlist_items_source_protocol_kind check (
  source_protocol is null
  or (source_kind='library' and source_protocol in ('library_selection_v1',
    'complete_inventory_selection_v1','library_mix_selection_v1','artist_popular_selection_v1'))
  or (source_kind='activity' and source_protocol in ('complete_activity_selection_v1','missing_activity_selection_v1'))
  or (source_kind='playlist' and source_protocol in ('missing_playlist_selection_v1','playlist_copy_v1'))
);

revoke all on app.playlist_library_mix_artists,app.playlist_library_mix_albums from public;
revoke all on function app.check_playlist_library_mix_artist_scope() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_library_mix_artists,app.playlist_library_mix_albums from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlist_library_mix_artists,app.playlist_library_mix_albums from album_haven_app;
    grant select,insert on app.playlist_library_mix_artists,app.playlist_library_mix_albums to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_library_mix_artists,app.playlist_library_mix_albums to album_haven_migrator;
    grant all on function app.check_playlist_library_mix_artist_scope() to album_haven_migrator;
  end if;
end $$;
