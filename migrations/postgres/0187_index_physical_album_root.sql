-- A watcher pass reads the membership context of the albums it publishes:
-- every file under the same physical album root (the album folder, or the
-- parent of a disc folder). Without an index that read evaluated the root
-- expression on every track file and held the album's save reservation for
-- the whole library read (44 s on a real library). Expression and predicate
-- match album_local_membership.physical_album_root_sql exactly.
--
-- Additive only. A large database may prebuild the same index with
-- CREATE INDEX CONCURRENTLY in autocommit before applying this migration.
create index if not exists local_track_files_active_physical_album_root_idx
on library.local_track_files ((case when regexp_replace(regexp_replace(case when library.local_path_style(private_path) = 'windows' then replace(library.local_path_key(private_path), chr(92), '/') else library.local_path_key(private_path) end, '/[^/]*$', ''), '^.*/', '') ~* '(^|[^[:alnum:]])(cd|disc|disk)[[:space:]]*[-_.]?[[:space:]]*[0-9]{1,2}([^[:alnum:]]|$)' then regexp_replace(regexp_replace(case when library.local_path_style(private_path) = 'windows' then replace(library.local_path_key(private_path), chr(92), '/') else library.local_path_key(private_path) end, '/[^/]*$', ''), '/[^/]*$', '') else regexp_replace(case when library.local_path_style(private_path) = 'windows' then replace(library.local_path_key(private_path), chr(92), '/') else library.local_path_key(private_path) end, '/[^/]*$', '') end))
where scan_cache_stale is false;
