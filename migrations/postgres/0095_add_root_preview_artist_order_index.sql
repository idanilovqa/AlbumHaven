-- Let the bounded root preview stop after the first eligible artists.
create index if not exists local_artists_library_root_preview_order_idx
  on library.local_artists (
    library_id,
    lower(coalesce(nullif(sort_name, ''), name)),
    coalesce(nullif(sort_name, ''), name),
    lower(name),
    name
  ) include (id);
