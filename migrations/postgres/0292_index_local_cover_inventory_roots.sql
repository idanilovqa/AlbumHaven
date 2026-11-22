-- depends on: 0125_add_local_cover_inventory.sql
-- A removed, moved or changed folder finds its album listings and their track
-- contexts by exact folder or by folder prefix. A prefix is a range only in
-- "C" order, which the primary key's collation does not give, and the contexts
-- had no index on their folder at all, so each such change read both tables.
--
-- Additive only: no inventory row or media is changed.
create index if not exists local_cover_inventories_root_path_c_idx
on library.local_cover_inventories (library_id, (root_path collate "C"));

create index if not exists local_cover_inventory_contexts_root_path_c_idx
on library.local_cover_inventory_contexts (library_id, (root_path collate "C"))
where root_path is not null;

-- An index of the same name may precede this transactional ledger entry.
-- Never accept an invalid or different same-name index as a completed build.
do $$
declare
    previous_search_path text := current_setting('search_path');
    expected record;
begin
    perform set_config('search_path', 'pg_catalog', true);
    for expected in
        select * from (values
            ('library.local_cover_inventories_root_path_c_idx',
             'CREATE INDEX local_cover_inventories_root_path_c_idx ON library.local_cover_inventories USING btree (library_id, root_path COLLATE "C")'),
            ('library.local_cover_inventory_contexts_root_path_c_idx',
             'CREATE INDEX local_cover_inventory_contexts_root_path_c_idx ON library.local_cover_inventory_contexts USING btree (library_id, root_path COLLATE "C") WHERE (root_path IS NOT NULL)')
        ) as indexes(index_name, definition)
    loop
        if not exists (
            select 1 from pg_index
            where indexrelid = to_regclass(expected.index_name)
              and indisvalid and indisready and indislive
              and regexp_replace(pg_get_indexdef(indexrelid), '\s+', ' ', 'g') = expected.definition
        ) then
            raise exception 'Unexpected or invalid local cover inventory index definition: %', expected.index_name;
        end if;
    end loop;
    perform set_config('search_path', previous_search_path, true);
end
$$;
