create or replace function library.confirm_missing_album_removal(target_album_key text)
returns table (
  album_found boolean,
  active_file_count bigint,
  stale_private_paths text[],
  root_private_paths text[],
  unresolved_root_count bigint,
  removed_album_key text,
  removed_album_count bigint,
  inventory_mutation_revision bigint
)
language sql
security definer
set search_path = pg_catalog
as $function$
  with inventory_lock as materialized (
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('album-haven:local-inventory-publication')
    )
  ),
  bootstrap_context as (
    select library.libraries.id as library_id
    from app.bootstrap_owners
    join library.libraries
      on library.libraries.owner_account_id = app.bootstrap_owners.account_id
     and library.libraries.name = 'Local Library'
     and library.libraries.library_kind = 'local'
    where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
    limit 1
  ),
  locked_album as materialized (
    select library.local_albums.id, library.local_albums.album_key
    from library.local_albums
    cross join inventory_lock
    join bootstrap_context
      on library.local_albums.library_id = bootstrap_context.library_id
    where library.local_albums.library_id = bootstrap_context.library_id
      and library.local_albums.album_key = target_album_key
    for update
  ),
  locked_files as materialized (
    select
      library.local_track_files.id,
      library.local_track_files.private_path,
      library.local_track_files.scan_cache_stale,
      library.library_roots.root_path
    from library.local_track_files
    join library.local_tracks
      on library.local_tracks.id = library.local_track_files.track_id
    join locked_album
      on locked_album.id = library.local_tracks.album_id
    left join library.library_roots
      on library.library_roots.id = library.local_track_files.library_root_id
    for update of local_track_files
  ),
  album_state as (
    select
      exists(select 1 from locked_album) as album_found,
      count(*) filter (
        where library.local_track_files.scan_cache_stale is false
      ) as active_file_count
    from locked_album
    left join library.local_tracks
      on library.local_tracks.album_id = locked_album.id
    left join library.local_track_files
      on library.local_track_files.track_id = library.local_tracks.id
    cross join lateral (
      select count(*) as locked_file_count from locked_files
    ) locked_files_guard
  ),
  deleted_files as (
    delete from library.local_track_files
    using library.local_tracks, locked_album, album_state
    where library.local_track_files.track_id = library.local_tracks.id
      and library.local_tracks.album_id = locked_album.id
      and album_state.active_file_count = 0
    returning library.local_track_files.track_id
  ),
  deleted_tracks as (
    delete from library.local_tracks
    using locked_album, album_state
    where library.local_tracks.album_id = locked_album.id
      and album_state.active_file_count = 0
    returning library.local_tracks.id
  ),
  deleted_album as (
    delete from library.local_albums
    using locked_album, album_state
    where library.local_albums.id = locked_album.id
      and album_state.active_file_count = 0
    returning library.local_albums.album_key
  ),
  revised_library as (
    update library.libraries
    set metadata = pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        library.libraries.metadata,
        '{scan_cache,relation_projection,ready}',
        'false'::jsonb,
        true
      ),
      '{inventory_mutation_revision}',
      pg_catalog.to_jsonb(
        coalesce(
          nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
          0
        ) + 1
      ),
      true
    )
    from bootstrap_context
    where library.libraries.id = bootstrap_context.library_id
      and exists(select 1 from deleted_album)
    returning coalesce(
      nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
      0
    ) as inventory_mutation_revision
  )
  select
    album_state.album_found,
    album_state.active_file_count,
    coalesce(
      (select array_agg(locked_files.private_path) from locked_files),
      array[]::text[]
    ) as stale_private_paths,
    coalesce(
      (
        select array_agg(distinct locked_files.root_path)
        filter (where locked_files.root_path is not null)
        from locked_files
      ),
      array[]::text[]
    ) as root_private_paths,
    (
      select count(*)
      from locked_files
      where locked_files.root_path is null
    ) as unresolved_root_count,
    (select deleted_album.album_key from deleted_album limit 1) as removed_album_key,
    (select count(*) from deleted_album) as removed_album_count,
    coalesce(
      (select revised_library.inventory_mutation_revision from revised_library limit 1),
      (
        select coalesce(
          nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
          0
        )
        from library.libraries
        join bootstrap_context
          on bootstrap_context.library_id = library.libraries.id
      ),
      0
    ) as inventory_mutation_revision
  from album_state;
$function$;

revoke all on function library.confirm_missing_album_removal(text) from public;

do $grant$
begin
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'album_haven_app'
  ) then
    execute 'grant execute on function library.confirm_missing_album_removal(text) to album_haven_app';
  end if;
end
$grant$;
