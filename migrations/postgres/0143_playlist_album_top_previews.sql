-- Captured conversion evidence is not an Album Top or a membership baseline.
create table app.playlist_album_top_previews (
  ref uuid primary key,
  actor_account_id bigint not null references app.accounts(id),
  original_session_id bigint not null check(original_session_id > 0),
  library_id bigint not null references library.libraries(id),
  context_ref text not null check(context_ref ~ '^[0-9a-f]{64}$'),
  playlist_ref uuid not null,
  playlist_revision bigint not null check(playlist_revision > 0),
  source_track_ids bigint[] not null check(cardinality(source_track_ids) <= 5000),
  snapshot jsonb not null check(jsonb_typeof(snapshot) = 'object'
    and octet_length(snapshot::text) <= 2097152),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  discarded_at timestamptz,
  saved_top_ref uuid,
  check(expires_at > created_at and expires_at <= created_at + interval '60 minutes'),
  foreign key(playlist_ref,library_id) references app.playlists(ref,library_id),
  foreign key(saved_top_ref,library_id) references app.album_lists(ref,library_id)
);
create index playlist_album_top_preview_owner on app.playlist_album_top_previews
  (actor_account_id,library_id,expires_at,ref);
create function app.guard_playlist_album_top_preview() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP = 'UPDATE' and (to_jsonb(NEW)-'discarded_at') = (to_jsonb(OLD)-'discarded_at')
    and OLD.discarded_at is null and NEW.discarded_at is not null and OLD.saved_top_ref is null then return NEW; end if;
  if TG_OP = 'UPDATE' and (to_jsonb(NEW)-'saved_top_ref') = (to_jsonb(OLD)-'saved_top_ref')
    and OLD.saved_top_ref is null and NEW.saved_top_ref is not null and OLD.discarded_at is null then return NEW; end if;
  if TG_OP = 'DELETE' and ((OLD.expires_at <= clock_timestamp() and OLD.saved_top_ref is null)
    or current_user = (select pg_get_userbyid(relowner) from pg_class where oid=TG_RELID)) then return OLD; end if;
  raise exception using errcode='55000',message='Playlist Top preview is immutable';
end $$;
create trigger playlist_album_top_preview_immutable before update or delete
  on app.playlist_album_top_previews for each row execute function app.guard_playlist_album_top_preview();
revoke all on app.playlist_album_top_previews from public;
revoke all on function app.guard_playlist_album_top_preview() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_album_top_previews from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.playlist_album_top_previews from album_haven_app;
    grant select,insert,delete on app.playlist_album_top_previews to album_haven_app;
    grant update(discarded_at,saved_top_ref) on app.playlist_album_top_previews to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_album_top_previews to album_haven_migrator;
  end if;
end $$;
