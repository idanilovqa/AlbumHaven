-- An automatic cover write must know every album whose user chose the file it would replace, as its main
-- cover or second artbox. Without these indexes that check reads every album under the publication lock.
-- Additive only: no album, track, artwork or media row is written.
--
-- Restore caveat: these expressions call library.local_path_key. When the library schema's owner is not the
-- tables' owner, a plain pg_restore builds the indexes before it restores the schema grants, so all three fail
-- with "permission denied for schema library". Restore in steps instead, as the superuser:
--   1. pg_restore --section=pre-data
--   2. grant usage on schema library to <each owner of its tables>
--   3. pg_restore --section=data --section=post-data
-- and then confirm the three indexes exist and are valid. A plain restore also loses the indexes of 0088 and 0187.
create index if not exists local_albums_user_cover_path_idx
on library.local_albums (library_id, library.local_path_key(cover_path))
where metadata ->> 'cover_selection_origin' = 'user';

create index if not exists local_albums_user_cover_source_idx
on library.local_albums (library_id, library.local_path_key(metadata ->> 'selected_local_cover_source_path'))
where metadata ->> 'cover_selection_origin' = 'user';

create index if not exists local_album_additional_artworks_local_path_idx
on library.local_album_additional_artworks (library.local_path_key(cover_path))
where source_kind = 'local';

-- A prebuilt index may precede this transactional ledger entry.
-- Never accept an invalid or different same-name index as a completed build.
do $$
declare
    previous_search_path text := current_setting('search_path');
    expected record;
begin
    perform set_config('search_path', 'pg_catalog', true);
    for expected in
        select * from (values
            ('local_albums_user_cover_path_idx',
             'CREATE INDEX local_albums_user_cover_path_idx ON library.local_albums USING btree (library_id, library.local_path_key(cover_path)) WHERE ((metadata ->> ''cover_selection_origin''::text) = ''user''::text)'),
            ('local_albums_user_cover_source_idx',
             'CREATE INDEX local_albums_user_cover_source_idx ON library.local_albums USING btree (library_id, library.local_path_key((metadata ->> ''selected_local_cover_source_path''::text))) WHERE ((metadata ->> ''cover_selection_origin''::text) = ''user''::text)'),
            ('local_album_additional_artworks_local_path_idx',
             'CREATE INDEX local_album_additional_artworks_local_path_idx ON library.local_album_additional_artworks USING btree (library.local_path_key(cover_path)) WHERE (source_kind = ''local''::text)')
        ) as wanted(index_name, definition)
    loop
        if not exists (
            select 1 from pg_index
            where indexrelid = to_regclass('library.' || expected.index_name)
              and indisvalid and indisready and indislive
              and regexp_replace(pg_get_indexdef(indexrelid), '\s+', ' ', 'g') = expected.definition
        ) then
            raise exception 'Unexpected or invalid user cover choice index: %', expected.index_name;
        end if;
    end loop;
    perform set_config('search_path', previous_search_path, true);
end
$$;
