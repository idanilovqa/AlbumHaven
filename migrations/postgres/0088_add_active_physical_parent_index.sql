-- Additive lookup support; does not rewrite catalog rows or media.
create index if not exists local_track_files_active_physical_parent_idx
on library.local_track_files (
    library_root_id,
    (regexp_replace(case when library.local_path_style(private_path) = 'windows'
      then replace(library.local_path_key(private_path), chr(92), '/')
      else library.local_path_key(private_path) end, '/[^/]*$', ''))
)
where scan_cache_stale is false;

-- A concurrently prebuilt index may precede this transactional ledger entry.
-- Never accept an invalid or different same-name index as a completed build.
do $$
declare
    previous_search_path text := current_setting('search_path');
    expected_definition text := 'CREATE INDEX local_track_files_active_physical_parent_idx ON library.local_track_files USING btree (library_root_id, regexp_replace( CASE WHEN (library.local_path_style(private_path) = ''windows''::text) THEN replace(library.local_path_key(private_path), chr(92), ''/''::text) ELSE library.local_path_key(private_path) END, ''/[^/]*$''::text, ''''::text)) WHERE (scan_cache_stale IS FALSE)';
begin
    perform set_config('search_path', 'pg_catalog', true);
    if not exists (
        select 1 from pg_index
        where indexrelid = 'library.local_track_files_active_physical_parent_idx'::regclass
          and indisvalid and indisready and indislive
          and regexp_replace(pg_get_indexdef(indexrelid), '\s+', ' ', 'g') = expected_definition
    ) then
        raise exception 'Unexpected or invalid physical-parent index definition';
    end if;
    perform set_config('search_path', previous_search_path, true);
end
$$;
