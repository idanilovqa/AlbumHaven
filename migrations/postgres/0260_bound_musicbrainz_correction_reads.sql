-- depends on: 0258_invalidate_gallery_on_split_labels.sql
-- MusicBrainz Delivery 2, S4: data corrections follow the albums that changed and the Edits Queue
-- reads stored totals, so no save, page or decision reads the whole library. Additive only.
--
-- 1. A change to anything a comparison reads appends a mark for its album; the background refresh
--    compares only marked albums. Marks have no unique key and no foreign key, so recording one
--    never waits for a running refresh.
-- 2. Each album's Edits Queue groups are stored, indexed for keyset pages. Their totals are kept
--    as appended deltas (compacted by the writers of groups), so deleting an album never waits on
--    a totals row.

create table if not exists library.musicbrainz_correction_refresh_marks (
  id bigint generated always as identity primary key,
  album_id bigint not null
);

create table if not exists library.local_album_musicbrainz_correction_groups (
  library_id bigint not null,
  album_key text not null,
  section text not null check (section in ('applied', 'review')),
  grouping text not null,
  -- The start of the lower-case album title, short enough for the page index.
  sort_title text not null check (char_length(sort_title) <= 256),
  row_count integer not null check (row_count > 0),
  primary key (library_id, album_key, section, grouping),
  foreign key (library_id, album_key)
    references library.local_album_musicbrainz_corrections(library_id, album_key)
    on update cascade on delete cascade
);

create index if not exists local_album_musicbrainz_correction_groups_page_idx
  on library.local_album_musicbrainz_correction_groups (library_id, section, grouping, sort_title, album_key);

create table if not exists library.musicbrainz_correction_group_counts (
  id bigint generated always as identity primary key,
  library_id bigint not null,
  section text not null,
  grouping text not null,
  album_count bigint not null,
  row_count bigint not null
);

create index if not exists musicbrainz_correction_group_counts_section_idx
  on library.musicbrainz_correction_group_counts (library_id, section, grouping);

-- Security definer: every writer of tags, matches and albums records marks and deltas through
-- these, without grants of its own on the bookkeeping tables.
create or replace function library.mark_musicbrainz_correction_album()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if TG_TABLE_NAME = 'local_tracks' then
    if TG_OP = 'UPDATE' then
      insert into library.musicbrainz_correction_refresh_marks (album_id)
      select albums.id from library.local_albums albums
      where albums.id in (old.album_id, new.album_id)
        and exists (select 1 from library.local_album_musicbrainz_releases decision
                    where decision.library_id = albums.library_id and decision.album_key = albums.album_key);
    else
      insert into library.musicbrainz_correction_refresh_marks (album_id)
      select albums.id from library.local_albums albums
      where albums.id in (select changed.album_id from correction_changed_rows changed)
        and exists (select 1 from library.local_album_musicbrainz_releases decision
                    where decision.library_id = albums.library_id and decision.album_key = albums.album_key);
    end if;
  elsif TG_TABLE_NAME = 'local_albums' then
    insert into library.musicbrainz_correction_refresh_marks (album_id)
    select new.id
    where exists (select 1 from library.local_album_musicbrainz_releases decision
                  where decision.library_id = new.library_id and decision.album_key = new.album_key);
  elsif TG_TABLE_NAME = 'local_artists' then
    insert into library.musicbrainz_correction_refresh_marks (album_id)
    select albums.id from library.local_albums albums
    where albums.id in (
        select credited.id from library.local_albums credited where credited.artist_id = new.id
        union
        select tracks.album_id from library.local_tracks tracks where tracks.artist_id = new.id)
      and exists (select 1 from library.local_album_musicbrainz_releases decision
                  where decision.library_id = albums.library_id and decision.album_key = albums.album_key);
  elsif TG_TABLE_NAME = 'musicbrainz_releases' then
    insert into library.musicbrainz_correction_refresh_marks (album_id)
    select albums.id
    from library.local_album_musicbrainz_releases decision
    join library.local_albums albums
      on albums.library_id = decision.library_id and albums.album_key = decision.album_key
    where decision.release_mbid = new.mbid;
  elsif TG_OP = 'DELETE' then  -- local_album_musicbrainz_releases: the album lost its match
    insert into library.musicbrainz_correction_refresh_marks (album_id)
    select albums.id from library.local_albums albums
    where albums.library_id = old.library_id and albums.album_key = old.album_key;
  else
    insert into library.musicbrainz_correction_refresh_marks (album_id)
    select albums.id from library.local_albums albums
    where albums.library_id = new.library_id and albums.album_key = new.album_key;
  end if;
  return null;
end;
$$;
revoke all on function library.mark_musicbrainz_correction_album() from public;

-- Updates mark only when a compared value changes, so writing the corrected display values or a
-- scan's unchanged upserts costs no function call.
drop trigger if exists musicbrainz_correction_track_update on library.local_tracks;
create trigger musicbrainz_correction_track_update
  after update of title, artist_id, album_id, disc_number, track_number on library.local_tracks
  for each row when ((old.title, old.artist_id, old.album_id, old.disc_number, old.track_number)
    is distinct from (new.title, new.artist_id, new.album_id, new.disc_number, new.track_number))
  execute function library.mark_musicbrainz_correction_album();
drop trigger if exists musicbrainz_correction_track_insert on library.local_tracks;
create trigger musicbrainz_correction_track_insert
  after insert on library.local_tracks
  referencing new table as correction_changed_rows
  for each statement execute function library.mark_musicbrainz_correction_album();
drop trigger if exists musicbrainz_correction_track_delete on library.local_tracks;
create trigger musicbrainz_correction_track_delete
  after delete on library.local_tracks
  referencing old table as correction_changed_rows
  for each statement execute function library.mark_musicbrainz_correction_album();

drop trigger if exists musicbrainz_correction_album_update on library.local_albums;
create trigger musicbrainz_correction_album_update
  after update of title, artist_id on library.local_albums
  for each row when ((old.title, old.artist_id) is distinct from (new.title, new.artist_id))
  execute function library.mark_musicbrainz_correction_album();

drop trigger if exists musicbrainz_correction_artist_update on library.local_artists;
create trigger musicbrainz_correction_artist_update
  after update of name on library.local_artists
  for each row when (old.name is distinct from new.name)
  execute function library.mark_musicbrainz_correction_album();

drop trigger if exists musicbrainz_correction_decision_change on library.local_album_musicbrainz_releases;
create trigger musicbrainz_correction_decision_change
  after insert or delete on library.local_album_musicbrainz_releases
  for each row execute function library.mark_musicbrainz_correction_album();
drop trigger if exists musicbrainz_correction_decision_update on library.local_album_musicbrainz_releases;
create trigger musicbrainz_correction_decision_update
  after update of state, release_mbid, disc_position, match_quality, track_pairing
  on library.local_album_musicbrainz_releases
  for each row when ((old.state, old.release_mbid, old.disc_position, old.match_quality, old.track_pairing)
    is distinct from (new.state, new.release_mbid, new.disc_position, new.match_quality, new.track_pairing))
  execute function library.mark_musicbrainz_correction_album();

drop trigger if exists musicbrainz_correction_release_update on integration.musicbrainz_releases;
create trigger musicbrainz_correction_release_update
  after update of title, artist_credit, media, refreshed_at on integration.musicbrainz_releases
  for each row when ((old.title, old.artist_credit, old.media, old.refreshed_at)
    is distinct from (new.title, new.artist_credit, new.media, new.refreshed_at))
  execute function library.mark_musicbrainz_correction_album();

-- The stored groups of what is stored today, once: the same rule as
-- musicbrainz_corrections_postgres._LISTED_SQL.
insert into library.local_album_musicbrainz_correction_groups
  (library_id, album_key, section, grouping, sort_title, row_count)
select listed.library_id, listed.album_key, listed.section, listed.grouping,
       left(lower(coalesce(albums.title, '')), 256), count(*)
from (
  select correction.library_id, correction.album_key,
         case when decision.decision is null and correction.mode = 'review' then 'review' else 'applied' end as section,
         case when decision.decision is null and correction.mode = 'review' and stored.review_whole
              then 'whole_album' else correction.kind end as grouping
  from library.local_album_musicbrainz_correction_rows correction
  join library.local_album_musicbrainz_corrections stored
    on stored.library_id = correction.library_id and stored.album_key = correction.album_key
  left join library.local_album_musicbrainz_correction_decisions decision
    on decision.library_id = correction.library_id and decision.album_key = correction.album_key
   and decision.field = correction.field and decision.disc_number = correction.disc_number
   and decision.track_number = correction.track_number
   and decision.current_value = correction.current_value and decision.proposed_value = correction.proposed_value
  where decision.decision is null or decision.decision = 'approved'
     or (decision.decision = 'undone' and correction.mode = 'auto')
) listed
join library.local_albums albums on albums.library_id = listed.library_id and albums.album_key = listed.album_key
group by listed.library_id, listed.album_key, listed.section, listed.grouping, albums.title
on conflict (library_id, album_key, section, grouping) do nothing;

delete from library.musicbrainz_correction_group_counts;
insert into library.musicbrainz_correction_group_counts (library_id, section, grouping, album_count, row_count)
select library_id, section, grouping, count(*), sum(row_count)
from library.local_album_musicbrainz_correction_groups
group by library_id, section, grouping;

-- An album 0198 left to recompute is still recomputed once.
insert into library.musicbrainz_correction_refresh_marks (album_id)
select albums.id
from library.local_album_musicbrainz_corrections stored
join library.local_albums albums on albums.library_id = stored.library_id and albums.album_key = stored.album_key
where stored.signature = 'recompute';

create or replace function library.count_musicbrainz_correction_group()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if TG_OP in ('UPDATE', 'DELETE') then
    insert into library.musicbrainz_correction_group_counts (library_id, section, grouping, album_count, row_count)
    values (old.library_id, old.section, old.grouping, -1, -old.row_count);
  end if;
  if TG_OP in ('INSERT', 'UPDATE') then
    insert into library.musicbrainz_correction_group_counts (library_id, section, grouping, album_count, row_count)
    values (new.library_id, new.section, new.grouping, 1, new.row_count);
  end if;
  return null;
end;
$$;
revoke all on function library.count_musicbrainz_correction_group() from public;

drop trigger if exists musicbrainz_correction_group_change on library.local_album_musicbrainz_correction_groups;
create trigger musicbrainz_correction_group_change
  after insert or delete on library.local_album_musicbrainz_correction_groups
  for each row execute function library.count_musicbrainz_correction_group();
drop trigger if exists musicbrainz_correction_group_recount on library.local_album_musicbrainz_correction_groups;
create trigger musicbrainz_correction_group_recount
  after update of row_count on library.local_album_musicbrainz_correction_groups
  for each row when (old.row_count <> new.row_count)
  execute function library.count_musicbrainz_correction_group();

revoke all on table library.musicbrainz_correction_refresh_marks,
  library.local_album_musicbrainz_correction_groups, library.musicbrainz_correction_group_counts from public;
revoke all on sequence library.musicbrainz_correction_refresh_marks_id_seq,
  library.musicbrainz_correction_group_counts_id_seq from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table library.musicbrainz_correction_refresh_marks,
      library.local_album_musicbrainz_correction_groups, library.musicbrainz_correction_group_counts
      to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, delete on table library.musicbrainz_correction_refresh_marks to album_haven_app;
    grant select, insert, update, delete on table library.local_album_musicbrainz_correction_groups to album_haven_app;
    grant select, insert, delete on table library.musicbrainz_correction_group_counts to album_haven_app;
    grant usage, select on sequence library.musicbrainz_correction_group_counts_id_seq to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update, delete on table library.musicbrainz_correction_refresh_marks,
      library.local_album_musicbrainz_correction_groups, library.musicbrainz_correction_group_counts
      to album_haven_migrator;
    grant usage, select on sequence library.musicbrainz_correction_refresh_marks_id_seq,
      library.musicbrainz_correction_group_counts_id_seq to album_haven_migrator;
  end if;
end $$;
