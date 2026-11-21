-- depends on: 0200_create_cover_references.sql
-- Names every stored local cover once, so the first pages after deploy need no inserts.
-- It only reads cover paths: no album, track or cover-selection row (origin, provenance,
-- selected_*, remote_*) is written, and being named is not evidence of a manual choice.
-- Idempotent; covers stored later are named on first use by the application.
insert into library.cover_references (library_id, private_path, kind)
select distinct library_id, cover_path, 'cover'
from (
  select a.library_id, a.cover_path
  from library.local_albums a
  where nullif(btrim(a.cover_path), '') is not null
  union
  select t.library_id, t.metadata ->> 'cover_path'
  from library.local_tracks t
  where nullif(btrim(t.metadata ->> 'cover_path'), '') is not null
  union
  select t.library_id, f.metadata ->> 'cover_path'
  from library.local_track_files f
  join library.local_tracks t on t.id = f.track_id
  where nullif(btrim(f.metadata ->> 'cover_path'), '') is not null
) as stored (library_id, cover_path)
on conflict (library_id, private_path) do update
  set kind = 'cover'
  where library.cover_references.kind = 'candidate';
