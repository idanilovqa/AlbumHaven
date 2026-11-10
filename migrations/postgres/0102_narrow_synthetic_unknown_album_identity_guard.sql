-- Preserve valid VA and known-artist loose-track identities. Only the synthetic
-- Unknown Artist / Unknown Album catch-all is forbidden as a lineage successor.

create or replace function library.record_local_track_album_identity_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  predecessor_key text;
  successor_key text;
  successor_title text;
  successor_artist text;
  successor_library_id bigint;
begin
  if old.album_id is null or new.album_id is null or old.album_id = new.album_id then
    return new;
  end if;

  select album.library_id, album.album_key, album.title, coalesce(artist.name, '')
    into successor_library_id, successor_key, successor_title, successor_artist
  from library.local_albums as album
  left join library.local_artists as artist on artist.id = album.artist_id
  where album.id = new.album_id;

  select album.album_key
    into predecessor_key
  from library.local_albums as album
  where album.id = old.album_id;

  if old.library_id <> new.library_id or successor_library_id is distinct from new.library_id then
    raise exception 'album identity transition cannot cross libraries';
  end if;

  if predecessor_key is null or successor_key is null then
    raise exception 'album identity transition requires existing album identities';
  end if;

  if lower(btrim(coalesce(successor_title, ''))) in (
       '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
     )
     and lower(btrim(coalesce(successor_artist, ''))) in (
       '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
     ) then
    return new;
  end if;

  insert into library.local_album_identity_transitions (
    library_id,
    predecessor_album_id,
    predecessor_album_key,
    successor_album_id,
    successor_album_key
  ) values (
    new.library_id,
    old.album_id,
    predecessor_key,
    new.album_id,
    successor_key
  )
  on conflict do nothing;

  return new;
end;
$$;

create or replace function library.record_local_album_key_identity_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  successor_artist text;
begin
  if old.library_id <> new.library_id then
    raise exception 'album identity transition cannot cross libraries';
  end if;

  select coalesce(artist.name, '')
    into successor_artist
  from library.local_artists as artist
  where artist.id = new.artist_id;

  if lower(btrim(coalesce(new.title, ''))) in (
       '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
     )
     and lower(btrim(coalesce(successor_artist, ''))) in (
       '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
     ) then
    return new;
  end if;

  insert into library.local_album_identity_transitions (
    library_id,
    predecessor_album_id,
    predecessor_album_key,
    successor_album_id,
    successor_album_key
  ) values (
    new.library_id,
    old.id,
    old.album_key,
    new.id,
    new.album_key
  )
  on conflict do nothing;

  return new;
end;
$$;
