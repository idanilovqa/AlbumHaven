-- Confirmed local versions may share one canonical album identity.
-- Keep one catalog link per local album and the same-library inventory FK.
-- Identity resolution and Top membership uniqueness remain unchanged.
alter table library.catalog_album_links
  drop constraint if exists catalog_album_links_library_id_catalog_ref_key;
