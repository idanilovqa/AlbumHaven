-- Auto-removal of an untouched loose track (no album) whose files were all truly
-- deleted: the loose-track half of the owner's 2026-11-08 missing-albums rule.
-- The app role cannot delete tracks itself, so this definer function does it for
-- one track and re-checks every safety condition under row locks; it trusts no
-- caller. A file still present, a file only unreachable (dropped drive or share)
-- or an unhealthy root keeps the track. Whether the user ever touched the track
-- is checked by the caller, exactly as for missing albums.
create or replace function library.remove_deleted_loose_track(target_track_id bigint)
returns table (
  removed_track_count bigint,
  inventory_mutation_revision bigint
)
language sql
volatile
security definer
set search_path = pg_catalog
as $function$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('album-haven:local-inventory-publication')
  );

  with bootstrap_context as (
    select library.libraries.id as library_id
    from app.bootstrap_owners
    join library.libraries
      on library.libraries.owner_account_id = app.bootstrap_owners.account_id
     and library.libraries.name = 'Local Library'
     and library.libraries.library_kind = 'local'
    where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
    limit 1
  ),
  locked_track as materialized (
    select library.local_tracks.id, library.local_tracks.library_id
    from library.local_tracks
    join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
    where library.local_tracks.id = target_track_id
      and library.local_tracks.album_id is null
    for update of local_tracks
  ),
  locked_files as materialized (
    select
      library.local_track_files.id,
      library.local_track_files.scan_cache_stale,
      library.local_track_files.metadata #>> '{scan_cache,missing_reason}' as missing_reason,
      coalesce(library.libraries.metadata -> 'library_watch_health', '{}'::jsonb)
        ? coalesce(
            nullif(library.library_roots.metadata ->> 'root_id', ''),
            library.local_track_files.metadata ->> 'library_root_id'
          ) as root_unhealthy
    from library.local_track_files
    join locked_track on locked_track.id = library.local_track_files.track_id
    join library.libraries on library.libraries.id = locked_track.library_id
    left join library.library_roots
      on library.library_roots.id = library.local_track_files.library_root_id
    for update of local_track_files
  ),
  track_state as (
    select
      exists(select 1 from locked_track)
        and exists(select 1 from locked_files)
        and not exists(
          select 1 from locked_files
          where locked_files.scan_cache_stale is not true
             or locked_files.missing_reason is distinct from 'deleted'
             or locked_files.root_unhealthy
        ) as removable
  ),
  deleted_files as (
    delete from library.local_track_files
    using locked_track, track_state
    where library.local_track_files.track_id = locked_track.id
      and track_state.removable
    returning library.local_track_files.track_id
  ),
  deleted_track as (
    delete from library.local_tracks
    using locked_track, track_state
    where library.local_tracks.id = locked_track.id
      and track_state.removable
    returning library.local_tracks.id
  ),
  revised_library as (
    update library.libraries
    set metadata = pg_catalog.jsonb_set(
      library.libraries.metadata,
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
      and exists(select 1 from deleted_track)
    returning coalesce(
      nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
      0
    ) as inventory_mutation_revision
  )
  select
    (select count(*) from deleted_track) as removed_track_count,
    coalesce(
      (select revised_library.inventory_mutation_revision from revised_library limit 1),
      (
        select coalesce(
          nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
          0
        )
        from library.libraries
        join bootstrap_context on bootstrap_context.library_id = library.libraries.id
      ),
      0
    ) as inventory_mutation_revision;
$function$;

revoke all on function library.remove_deleted_loose_track(bigint) from public;

do $grant$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'album_haven_app') then
    execute 'grant execute on function library.remove_deleted_loose_track(bigint) to album_haven_app';
  end if;
end
$grant$;
