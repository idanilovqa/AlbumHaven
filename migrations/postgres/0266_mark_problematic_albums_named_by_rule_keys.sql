-- 0188's journal marked a Rules exclusion's album only through metadata.album_key, so
-- reverting a legacy album-level rule (`<album key>::problem-album::<reason>`, no metadata)
-- left the album hidden in Problematic Files. A rule now also marks the album its key
-- names (with or without a `::year::NNNN` suffix), and a loose-track group's rule marks
-- the loose groups (album 0). Only this function changes; its triggers stay.

create or replace function library.capture_problematic_input_changes()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare selected record;
begin
  if tg_table_name = 'ignored_repairs' then
    for selected in
      with rule_keys as (
        select old.library_id as library_id, old.repair_key as repair_key, old.metadata ->> 'album_key' as album_key
        where tg_op <> 'INSERT'
        union all
        select new.library_id, new.repair_key, new.metadata ->> 'album_key'
        where tg_op <> 'DELETE'
      ), identities as (
        select library_id, repair_key, album_key,
          case when strpos(repair_key, '::problem-album::') > 0
               then split_part(repair_key, '::problem-album::', 1) end as album_identity
        from rule_keys
      )
      select albums.library_id, albums.id from identities
      join library.local_albums albums on albums.library_id = identities.library_id
       and albums.album_key in (
         identities.album_key, identities.album_identity,
         regexp_replace(identities.album_identity, '::year::[0-9]{4}$', ''))
      union
      select identities.library_id, 0 from identities
      where starts_with(coalesce(identities.album_identity, identities.repair_key), 'loose-source::')
      union
      select tracks.library_id, coalesce(tracks.album_id, 0) from identities
      join library.local_track_files files on files.private_path = split_part(identities.repair_key, '::', 1)
      join library.local_tracks tracks on tracks.id = files.track_id and tracks.library_id = identities.library_id
    loop perform library.mark_problematic_album_dirty(selected.library_id, selected.id); end loop;
  elsif tg_table_name = 'separate_releases' then
    for selected in select albums.library_id, albums.id from library.local_albums albums
      where (tg_op <> 'INSERT' and albums.library_id = old.library_id
             and (albums.album_key = old.release_key or starts_with(albums.album_key, old.release_key || '::')))
         or (tg_op <> 'DELETE' and albums.library_id = new.library_id
             and (albums.album_key = new.release_key or starts_with(albums.album_key, new.release_key || '::')))
    loop perform library.mark_problematic_album_dirty(selected.library_id, selected.id); end loop;
  elsif tg_table_name = 'album_ratings' then
    if tg_op = 'UPDATE' and (old.library_id, old.album_key, old.rating, old.account_id)
      is not distinct from (new.library_id, new.album_key, new.rating, new.account_id) then return null; end if;
    for selected in select albums.library_id, albums.id from library.local_albums albums
      where (tg_op <> 'INSERT' and albums.library_id = old.library_id and albums.album_key = old.album_key)
         or (tg_op <> 'DELETE' and albums.library_id = new.library_id and albums.album_key = new.album_key)
    loop perform library.mark_problematic_album_dirty(selected.library_id, selected.id); end loop;
  else
    if tg_op = 'UPDATE' and (old.library_id, old.task_key, old.status, old.metadata)
      is not distinct from (new.library_id, new.task_key, new.status, new.metadata) then return null; end if;
    for selected in select albums.library_id, albums.id from library.local_albums albums
      where (tg_op <> 'INSERT' and old.task_key ~ '^[0-9]+:search_spotify$'
             and albums.library_id = old.library_id and albums.id = split_part(old.task_key, ':', 1)::bigint)
         or (tg_op <> 'DELETE' and new.task_key ~ '^[0-9]+:search_spotify$'
             and albums.library_id = new.library_id and albums.id = split_part(new.task_key, ':', 1)::bigint)
    loop perform library.mark_problematic_album_dirty(selected.library_id, selected.id); end loop;
  end if;
  return null;
end $$;
