-- Repair saved loop runtime identities and relational links for already-migrated databases.
-- Loop audio and pitch-preview bytes remain filesystem-backed.

drop index if exists app.saved_loops_loop_key_idx;

create unique index if not exists saved_loops_loop_key_idx
  on app.saved_loops (account_id, library_id, loop_key)
  where account_id is not null
    and library_id is not null;

with parent_loop_matches as (
  select
    child_loop.id as child_loop_id,
    parent_loop.id as parent_loop_id,
    parent_loop.track_id as track_id
  from app.saved_loops as child_loop
  join app.saved_loops as parent_loop
    on parent_loop.account_id = child_loop.account_id
   and parent_loop.library_id = child_loop.library_id
   and parent_loop.loop_key = child_loop.metadata ->> 'parent_loop_key'
  where child_loop.metadata ? 'parent_loop_key'
    and child_loop.metadata ->> 'parent_loop_key' <> ''
), source_track_matches as (
  select
    loop_row.id as loop_id,
    library.local_track_files.track_id as track_id,
    row_number() over (
      partition by loop_row.id
      order by library.local_track_files.last_seen_at desc, library.local_track_files.id desc
    ) as match_rank
  from app.saved_loops as loop_row
  join library.local_track_files
    on library.local_track_files.private_path = loop_row.source_private_path
  join library.local_tracks
    on library.local_tracks.id = library.local_track_files.track_id
   and library.local_tracks.library_id = loop_row.library_id
), metadata_track_candidates as (
  select
    loop_row.id as loop_id,
    library.local_tracks.id as track_id
  from app.saved_loops as loop_row
  join library.local_tracks
    on library.local_tracks.library_id = loop_row.library_id
  join library.local_albums
    on library.local_albums.id = library.local_tracks.album_id
   and library.local_albums.library_id = loop_row.library_id
  left join library.local_artists
    on library.local_artists.id = coalesce(
      library.local_tracks.artist_id,
      library.local_albums.artist_id
    )
   and library.local_artists.library_id = loop_row.library_id
  where nullif(btrim(loop_row.metadata -> 'source_payload' ->> 'title'), '') is not null
    and nullif(btrim(loop_row.metadata -> 'source_payload' ->> 'album'), '') is not null
    and nullif(btrim(loop_row.metadata -> 'source_payload' ->> 'artist'), '') is not null
    and lower(btrim(library.local_tracks.title)) = lower(btrim(loop_row.metadata -> 'source_payload' ->> 'title'))
    and lower(btrim(library.local_albums.title)) = lower(btrim(loop_row.metadata -> 'source_payload' ->> 'album'))
    and lower(btrim(coalesce(library.local_artists.name, ''))) = lower(btrim(loop_row.metadata -> 'source_payload' ->> 'artist'))
), metadata_track_match_counts as (
  select
    metadata_track_candidates.loop_id,
    min(metadata_track_candidates.track_id) as track_id,
    count(*) as candidate_count
  from metadata_track_candidates
  group by metadata_track_candidates.loop_id
), metadata_track_match as (
  select
    metadata_track_match_counts.loop_id,
    metadata_track_match_counts.track_id
  from metadata_track_match_counts
  where metadata_track_match_counts.candidate_count = 1
), resolved as (
  select
    loop_row.id as loop_id,
    parent_loop_matches.parent_loop_id,
    coalesce(
      loop_row.track_id,
      parent_loop_matches.track_id,
      source_track_matches.track_id,
      metadata_track_match.track_id
    ) as track_id
  from app.saved_loops as loop_row
  left join parent_loop_matches
    on parent_loop_matches.child_loop_id = loop_row.id
  left join source_track_matches
    on source_track_matches.loop_id = loop_row.id
   and source_track_matches.match_rank = 1
  left join metadata_track_match
    on metadata_track_match.loop_id = loop_row.id
)
update app.saved_loops as loop_row
   set parent_loop_id = coalesce(resolved.parent_loop_id, loop_row.parent_loop_id),
       track_id = coalesce(loop_row.track_id, resolved.track_id),
       updated_at = now(),
       metadata = loop_row.metadata || jsonb_build_object(
         'repair_migration', '0018_repair_saved_loop_relations'
       )
  from resolved
 where resolved.loop_id = loop_row.id
   and (
     loop_row.parent_loop_id is distinct from coalesce(resolved.parent_loop_id, loop_row.parent_loop_id)
     or loop_row.track_id is distinct from coalesce(loop_row.track_id, resolved.track_id)
   );
