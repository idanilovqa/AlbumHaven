-- depends on: 0118_fold_accents_in_duplicate_identity.sql
-- A save decides which album folds into its twin as a stray copy
-- (scoped_relation_projection._refresh_stray_duplicate_ownership). It finds the
-- albums sharing a folded title, and the copies linked to an edited album; without
-- these indexes both lookups evaluated every album in the library. The expressions
-- match that query exactly.
--
-- Additive only. This ordinary build allows reads and blocks writes to
-- library.local_albums until it commits. A large database may prebuild the same
-- index names concurrently, in autocommit, before applying this migration.
--
-- library.duplicate_identity_text is declared immutable, like its use in 0093's
-- index, but its values follow the server's ICU and Unicode versions and the
-- function's definition. Reindex both after changing any of those, as 0118 did.
create index if not exists local_albums_title_identity_idx
  on library.local_albums (library_id, (library.duplicate_identity_text(title)));

create index if not exists local_albums_stray_owner_idx
  on library.local_albums (library_id, (metadata #>> '{stray_duplicate_of,album_id}'))
  where metadata #>> '{stray_duplicate_of,album_id}' is not null;
