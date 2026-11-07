-- Append-only history for album identities changed by scans, watcher publication,
-- and structural metadata edits. Rollback: drop the triggers/functions/table;
-- album, track, task, and media rows are unchanged.
create table library.local_album_identity_transitions (
  library_id bigint not null references library.libraries(id) on delete cascade,
  predecessor_album_id bigint not null,
  predecessor_album_key text not null,
  successor_album_id bigint not null,
  successor_album_key text not null,
  created_at timestamptz not null default now(),
  unique (library_id, predecessor_album_id, predecessor_album_key, successor_album_id, successor_album_key)
);

create index local_album_identity_transitions_predecessor_idx
on library.local_album_identity_transitions (
  library_id,
  predecessor_album_id,
  predecessor_album_key
);

create index local_album_identity_transitions_successor_idx
on library.local_album_identity_transitions (
  library_id,
  successor_album_id,
  successor_album_key
);

create or replace function library.record_local_track_album_identity_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  predecessor_key text;
  successor_key text;
  successor_library_id bigint;
begin
  if old.album_id is null or new.album_id is null or old.album_id = new.album_id then
    return new;
  end if;

  select album.library_id, album.album_key
    into successor_library_id, successor_key
  from library.local_albums as album
  where album.id = new.album_id;

  select album.album_key
    into predecessor_key
  from library.local_albums as album
  where album.id = old.album_id;

  if old.library_id <> new.library_id
     or successor_library_id is distinct from new.library_id then
    raise exception 'album identity transition cannot cross libraries';
  end if;

  if predecessor_key is null or successor_key is null then
    raise exception 'album identity transition requires existing album identities';
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

create trigger local_tracks_album_identity_transition
after update of album_id on library.local_tracks
for each row
when (old.album_id is distinct from new.album_id)
execute function library.record_local_track_album_identity_transition();

create or replace function library.record_local_album_key_identity_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.library_id <> new.library_id then
    raise exception 'album identity transition cannot cross libraries';
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

create trigger local_albums_album_key_identity_transition
after update of album_key on library.local_albums
for each row
when (old.album_key is distinct from new.album_key)
execute function library.record_local_album_key_identity_transition();

grant select on library.local_album_identity_transitions to album_haven_app;

