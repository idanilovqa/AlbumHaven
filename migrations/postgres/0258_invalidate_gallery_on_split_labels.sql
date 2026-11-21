-- depends on: 0257_add_musicbrainz_artist_area.sql
-- MusicBrainz Delivery 2, same-name splits (owner 2026-11-21, "Fix first, then test"): the root
-- gallery projection files a split name's proven albums under labelled entries ("Amarok
-- (Poland)"). The labels come from the album identities of per_album artists and from the
-- MusicBrainz artist's disambiguation, area, type and country, none of which invalidated the
-- projection, so the tree kept plain names until an unrelated inventory change.
--
-- One statement trigger per source table marks the gallery projection out of date when, and
-- only when, an input of a split label changes: an identity of a per_album artist's album is
-- added, removed or names another artist; a MusicBrainz artist such an identity names changes
-- its disambiguation, area or type, or gains or loses a country; an artist enters or leaves the
-- per_album state. A re-check that changes none of these changes nothing. Like 0086, the bump
-- is coalesced to one per transaction. Additive only; no stored value is read or written
-- beyond library.gallery_projection_state.

create or replace function library.invalidate_gallery_projection_split_labels()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  changed_sql text;
  affected_ids bigint[];
  affected_id bigint;
  mutation_xid xid8 := pg_current_xact_id();
begin
  if TG_TABLE_NAME = 'local_artist_musicbrainz_matches' then
    changed_sql := case TG_OP
      when 'UPDATE' then 'select n.library_id from gallery_old_rows o join gallery_new_rows n using (id)
                          where (o.state = ''per_album'') is distinct from (n.state = ''per_album'')'
      when 'INSERT' then 'select library_id from gallery_new_rows where state = ''per_album'''
      else 'select library_id from gallery_old_rows where state = ''per_album''' end;
    execute 'select array_agg(distinct library_id) from (' || changed_sql || ') changed' into affected_ids;
  elsif TG_TABLE_NAME = 'local_album_artist_identities' then
    changed_sql := case TG_OP
      when 'UPDATE' then 'select n.library_id, n.album_key from gallery_old_rows o join gallery_new_rows n
                          on n.library_id = o.library_id and n.album_key = o.album_key
                          where o.artist_mbid is distinct from n.artist_mbid'
      when 'INSERT' then 'select library_id, album_key from gallery_new_rows'
      else 'select library_id, album_key from gallery_old_rows' end;
    -- Only a per_album artist's albums carry a label.
    execute 'select array_agg(distinct changed.library_id) from (' || changed_sql || ') changed
      join library.local_albums albums on albums.library_id = changed.library_id and albums.album_key = changed.album_key
      join library.local_artist_musicbrainz_matches matches
        on matches.library_id = albums.library_id and matches.local_artist_id = albums.artist_id
       and matches.state = ''per_album''' into affected_ids;
  else
    if TG_TABLE_NAME = 'musicbrainz_artists' then
      changed_sql := case TG_OP
        when 'UPDATE' then 'select n.mbid from gallery_old_rows o join gallery_new_rows n using (mbid)
                            where (o.disambiguation, o.area_name, o.artist_kind)
                                  is distinct from (n.disambiguation, n.area_name, n.artist_kind)'
        else 'select null::uuid as mbid where false' end;
    else  -- musicbrainz_artist_countries
      changed_sql := case TG_OP
        when 'UPDATE' then 'select n.artist_mbid as mbid from gallery_old_rows o join gallery_new_rows n
                            using (artist_mbid, country_code)
                            where o.country_name is distinct from n.country_name'
        when 'INSERT' then 'select artist_mbid as mbid from gallery_new_rows'
        else 'select artist_mbid as mbid from gallery_old_rows' end;
    end if;
    -- The libraries whose per_album albums name one of these artists.
    execute 'select array_agg(distinct identities.library_id) from (' || changed_sql || ') changed
      join library.local_album_artist_identities identities on identities.artist_mbid = changed.mbid
      join library.local_albums albums on albums.library_id = identities.library_id and albums.album_key = identities.album_key
      join library.local_artist_musicbrainz_matches matches
        on matches.library_id = albums.library_id and matches.local_artist_id = albums.artist_id
       and matches.state = ''per_album''' into affected_ids;
  end if;
  foreach affected_id in array coalesce(affected_ids, array[]::bigint[]) loop
    insert into library.gallery_projection_state(library_id, generation, last_invalidation_xid)
      select id, 1, mutation_xid from library.libraries where id = affected_id
    on conflict (library_id) do update
      set generation = library.gallery_projection_state.generation + 1,
          last_invalidation_xid = excluded.last_invalidation_xid
      where library.gallery_projection_state.last_invalidation_xid
        is distinct from excluded.last_invalidation_xid;
  end loop;
  return null;
end;
$$;
revoke all on function library.invalidate_gallery_projection_split_labels() from public;

drop trigger if exists gallery_split_label_insert on library.local_artist_musicbrainz_matches;
create trigger gallery_split_label_insert after insert on library.local_artist_musicbrainz_matches
  referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();
drop trigger if exists gallery_split_label_update on library.local_artist_musicbrainz_matches;
create trigger gallery_split_label_update after update on library.local_artist_musicbrainz_matches
  referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();
drop trigger if exists gallery_split_label_delete on library.local_artist_musicbrainz_matches;
create trigger gallery_split_label_delete after delete on library.local_artist_musicbrainz_matches
  referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();

drop trigger if exists gallery_split_label_insert on library.local_album_artist_identities;
create trigger gallery_split_label_insert after insert on library.local_album_artist_identities
  referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();
drop trigger if exists gallery_split_label_update on library.local_album_artist_identities;
create trigger gallery_split_label_update after update on library.local_album_artist_identities
  referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();
drop trigger if exists gallery_split_label_delete on library.local_album_artist_identities;
create trigger gallery_split_label_delete after delete on library.local_album_artist_identities
  referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();

drop trigger if exists gallery_split_label_update on integration.musicbrainz_artists;
create trigger gallery_split_label_update after update on integration.musicbrainz_artists
  referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();

drop trigger if exists gallery_split_label_insert on integration.musicbrainz_artist_countries;
create trigger gallery_split_label_insert after insert on integration.musicbrainz_artist_countries
  referencing new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();
drop trigger if exists gallery_split_label_update on integration.musicbrainz_artist_countries;
create trigger gallery_split_label_update after update on integration.musicbrainz_artist_countries
  referencing old table as gallery_old_rows new table as gallery_new_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();
drop trigger if exists gallery_split_label_delete on integration.musicbrainz_artist_countries;
create trigger gallery_split_label_delete after delete on integration.musicbrainz_artist_countries
  referencing old table as gallery_old_rows
  for each statement execute function library.invalidate_gallery_projection_split_labels();
