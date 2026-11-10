-- Internal inventory publication only. The authenticated caller must confirm
-- exact physical generations, verify completed media deletion and preserve
-- media reservations until commit. No broad file-table DELETE grant is added.
create or replace function library.retire_confirmed_duplicate_copy_files(
  expected_library_id bigint, selected_generations jsonb, survivor_generations jsonb
) returns setof bigint
language plpgsql
security definer
set search_path = pg_catalog, library
as $$
begin
  if jsonb_typeof(selected_generations) is distinct from 'array'
     or jsonb_typeof(survivor_generations) is distinct from 'array' then
    return;
  end if;
  if jsonb_array_length(selected_generations) = 0
     or jsonb_array_length(survivor_generations) = 0 then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  return query
  with expected as materialized (
    select source.selected, generation.*
    from (values (true, selected_generations), (false, survivor_generations))
      as source(selected, generations)
    cross join lateral jsonb_to_recordset(source.generations) generation(
      id bigint, track_id bigint, library_root_id bigint, file_size_bytes bigint,
      modified_at timestamptz, last_seen_at timestamptz)
  ), matched as materialized (
    select files.id, expected.selected,
           lower(regexp_replace(btrim(coalesce(nullif(albums.metadata ->> 'album_artist', ''), artists.name, '')),
                                '[[:space:]]+', ' ', 'g')) as release_artist,
           lower(regexp_replace(btrim(albums.title), '[[:space:]]+', ' ', 'g')) as release_title
    from expected
    join library.local_track_files files
      on files.id = expected.id and files.track_id = expected.track_id
     and files.library_root_id = expected.library_root_id
     and files.file_size_bytes = expected.file_size_bytes
     and files.modified_at = expected.modified_at and files.last_seen_at = expected.last_seen_at
     and files.scan_cache_stale is false
     and files.metadata #>> '{scan_cache,source}' = 'runtime_scan_cache'
    join library.local_tracks tracks on tracks.id = files.track_id and tracks.library_id = expected_library_id
    join library.local_albums albums on albums.id = tracks.album_id and albums.library_id = expected_library_id
    join library.library_roots roots on roots.id = files.library_root_id
      and roots.library_id = expected_library_id and roots.is_active
    join library.libraries libraries on libraries.id = expected_library_id
      and libraries.name = 'Local Library' and libraries.library_kind = 'local'
    join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
      and owners.owner_key = 'local-bootstrap-owner'
    left join library.local_artists artists on artists.id = albums.artist_id and artists.library_id = expected_library_id
    order by files.id
    for update of files, tracks, albums, roots
  ), validated as (
    select count(*) = jsonb_array_length(selected_generations) + jsonb_array_length(survivor_generations)
       and count(distinct id) = count(*)
       and count(distinct (release_artist, release_title)) = 1
       and bool_and(release_artist <> '' and release_title <> '') as ready
    from matched
  )
  delete from library.local_track_files files
  using matched, validated
  where validated.ready and matched.selected and files.id = matched.id
  returning files.id;
end;
$$;

revoke all on function library.retire_confirmed_duplicate_copy_files(bigint, jsonb, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.retire_confirmed_duplicate_copy_files(bigint, jsonb, jsonb) to album_haven_app;
  end if;
end;
$$;
