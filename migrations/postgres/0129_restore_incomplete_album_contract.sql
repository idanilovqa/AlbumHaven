-- Preserve incomplete Album restoration as a nonmutating typed result.
-- The adapter owns the RuntimeError without aborting its caller's transaction.

create or replace function library.restore_detached_album_noncover(
  requested_library_id bigint,
  requested_track_paths text[],
  expected_inventory_revision bigint,
  requested_input_rows jsonb,
  destination_state jsonb,
  observed_at timestamptz
)
returns table (
  input_path_count bigint, resolved_path_count bigint,
  source_album_count bigint, source_album_track_file_count bigint,
  destination_album_count bigint, album_rows_updated bigint,
  track_rows_updated bigint, track_file_rows_updated bigint,
  inventory_mutation_revision bigint, destination_album_id bigint
)
language plpgsql security definer
set search_path = pg_catalog, library, app, ops, pg_temp
as $function$
declare
  current_revision bigint;
  resolved_count bigint;
  resolved_tracks bigint;
  ineligible_tracks boolean;
  projected_album jsonb;
  restore_result record;
  surviving_album_id bigint;
  noncover_metadata_keys constant text[] := array[
    'album_artist', 'artists', 'is_compilation', 'featured_artists',
    'edition', 'root_provenance', 'tag_album_rating', 'tag_album_rating_source'
  ];
begin
  if requested_library_id is null or expected_inventory_revision is null
     or observed_at is null
     or coalesce(cardinality(requested_track_paths), 0) = 0
     or jsonb_typeof(requested_input_rows) is distinct from 'array'
     or jsonb_typeof(destination_state) is distinct from 'object'
     or destination_state - array['album', 'artists', 'credits'] <> '{}'::jsonb
     or jsonb_typeof(destination_state -> 'album') is distinct from 'object'
     or jsonb_typeof(destination_state -> 'artists') is distinct from 'array'
     or jsonb_typeof(destination_state -> 'credits') is distinct from 'array' then
    raise exception 'Album restoration requires a closed destination, paths and revision'
      using errcode = '22023';
  end if;
  projected_album := destination_state -> 'album';
  if projected_album - array['album_key','artist_key','title','release_year','metadata'] <> '{}'::jsonb
     or jsonb_typeof(projected_album -> 'metadata') is distinct from 'object'
     or (projected_album -> 'metadata') - noncover_metadata_keys <> '{}'::jsonb
     or jsonb_typeof(projected_album -> 'album_key') is distinct from 'string'
     or jsonb_typeof(projected_album -> 'artist_key') is distinct from 'string'
     or jsonb_typeof(projected_album -> 'title') is distinct from 'string'
     or nullif(btrim(projected_album ->> 'album_key'), '') is null
     or nullif(btrim(projected_album ->> 'artist_key'), '') is null
     or nullif(btrim(projected_album ->> 'title'), '') is null
     or (projected_album ? 'release_year' and
         jsonb_typeof(projected_album -> 'release_year') not in ('number','null')) then
    raise exception 'Album restoration destination fields are invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(requested_input_rows) as entry(value)
    where jsonb_typeof(entry.value) is distinct from 'object'
       or entry.value - array['private_path','file_entry'] <> '{}'::jsonb
       or jsonb_typeof(entry.value -> 'private_path') is distinct from 'string'
       or jsonb_typeof(entry.value -> 'file_entry') is distinct from 'object'
       or (entry.value -> 'file_entry') - array['album','exception_type','mtime','size'] <> '{}'::jsonb
       or nullif(entry.value ->> 'private_path', '') is null
       or not ((entry.value ->> 'private_path') = any(requested_track_paths))
  ) or jsonb_array_length(requested_input_rows) <> cardinality(requested_track_paths)
    or (select count(distinct path) from unnest(requested_track_paths) as path)
       <> cardinality(requested_track_paths)
    or (select count(distinct entry.value ->> 'private_path')
        from jsonb_array_elements(requested_input_rows) as entry(value))
       <> cardinality(requested_track_paths) then
    raise exception 'Album restoration input fields or path scope are invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(destination_state -> 'artists') as artist(value)
    where jsonb_typeof(artist.value) is distinct from 'object'
       or artist.value - array['artist_key','name','sort_name'] <> '{}'::jsonb
       or jsonb_typeof(artist.value -> 'artist_key') is distinct from 'string'
       or jsonb_typeof(artist.value -> 'name') is distinct from 'string'
       or jsonb_typeof(artist.value -> 'sort_name') is distinct from 'string'
       or nullif(btrim(artist.value ->> 'artist_key'), '') is null
       or nullif(btrim(artist.value ->> 'name'), '') is null
  ) or (select count(distinct artist.value ->> 'artist_key')
        from jsonb_array_elements(destination_state -> 'artists') as artist(value))
       <> jsonb_array_length(destination_state -> 'artists')
    or not exists (
      select 1 from jsonb_array_elements(destination_state -> 'artists') as artist(value)
      where artist.value ->> 'artist_key' = projected_album ->> 'artist_key'
    )
    or exists (
      select 1 from jsonb_array_elements(destination_state -> 'credits') as credit(value)
      where jsonb_typeof(credit.value) is distinct from 'object'
         or credit.value - array['artist_key','featured_kind'] <> '{}'::jsonb
         or jsonb_typeof(credit.value -> 'artist_key') is distinct from 'string'
         or coalesce(credit.value ->> 'featured_kind', '') not in
            ('owner','featured_member','featured_track_artist')
         or not exists (
           select 1 from jsonb_array_elements(destination_state -> 'artists') as artist(value)
           where artist.value ->> 'artist_key' = credit.value ->> 'artist_key'
         )
    ) then
    raise exception 'Album restoration artist or credit scope is invalid'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0)
  into current_revision from library.libraries
  where id = requested_library_id for update;
  if not found or current_revision <> expected_inventory_revision then
    raise exception 'Album restoration inventory revision conflict'
      using errcode = '40001';
  end if;

  perform tracks.id
  from library.local_tracks as tracks
  join library.local_track_files as files on files.track_id = tracks.id
  where tracks.library_id = requested_library_id
    and files.private_path = any(requested_track_paths)
    and files.scan_cache_stale is false
  order by tracks.id, files.id
  for update of tracks, files;

  select count(*), count(distinct tracks.id) into resolved_count, resolved_tracks
  from library.local_tracks as tracks
  join library.local_track_files as files on files.track_id = tracks.id
  where tracks.library_id = requested_library_id
    and files.private_path = any(requested_track_paths)
    and files.scan_cache_stale is false;
  if resolved_count <> cardinality(requested_track_paths)
     or resolved_tracks <> cardinality(requested_track_paths) then
    return query select
      cardinality(requested_track_paths)::bigint, resolved_count,
      0::bigint, 0::bigint,
      0::bigint, 0::bigint,
      0::bigint, 0::bigint,
      current_revision, null::bigint;
    return;
  end if;

  select exists (
    select 1
    from library.local_tracks as tracks
    join library.local_track_files as files on files.track_id = tracks.id
    join jsonb_to_recordset(requested_input_rows) as incoming(
      private_path text, file_entry jsonb
    ) on incoming.private_path = files.private_path
    where tracks.library_id = requested_library_id
      and files.scan_cache_stale is false
      and (
      ((nullif(btrim(files.metadata #>> '{scan_cache,file_entry,album}'), '') is not null
        and nullif(btrim(files.metadata #>> '{scan_cache,file_entry,exception_type}'), '') is null)
       and not (
         incoming.file_entry ? 'exception_type'
         and nullif(btrim(incoming.file_entry ->> 'exception_type'), '') is null
         and (
           select coalesce(
             nullif(btrim(authoritative_override.override_payload ->> 'exception_type'), ''),
             case
               when jsonb_typeof(authoritative_override.override_payload) = 'string'
               then nullif(btrim(authoritative_override.override_payload #>> '{}'), '')
               else null
             end
           )
           from library.exception_overrides as authoritative_override
           where authoritative_override.library_id = requested_library_id
             and (
               authoritative_override.track_key = files.private_path
               or authoritative_override.track_id = tracks.id
             )
           order by case
             when authoritative_override.track_key = files.private_path then 0
             when authoritative_override.track_id = tracks.id then 1
             else 2
           end,
           authoritative_override.updated_at desc,
           authoritative_override.id desc
           limit 1
         ) is not null
       ))
        or lower(btrim(coalesce((
          coalesce(files.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
            || incoming.file_entry
        ) ->> 'album', ''))) <> lower(btrim(projected_album ->> 'title'))
        or nullif(btrim((
          coalesce(files.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
            || incoming.file_entry
        ) ->> 'exception_type'), '') is not null
      )
  ) into ineligible_tracks;
  if ineligible_tracks then
    raise exception 'Album restoration must resolve eligible selected tracks (resolved %, tracks %, expected %, ineligible %)',
      resolved_count, resolved_tracks, cardinality(requested_track_paths), ineligible_tracks
      using errcode = '22023';
  end if;

  insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)
  select requested_library_id, artist.artist_key, artist.name, artist.sort_name,
    jsonb_build_object('source', 'runtime_scan_cache')
  from jsonb_to_recordset(destination_state -> 'artists') as artist(
    artist_key text, name text, sort_name text
  )
  on conflict (library_id, artist_key) do update
  set name = excluded.name, sort_name = excluded.sort_name,
      last_seen_at = observed_at,
      metadata = library.local_artists.metadata || excluded.metadata;

drop table if exists pg_temp.semantic_album_key_adoptions;

        create temporary table semantic_album_key_adoptions (
          album_id bigint primary key,
          library_id bigint not null,
          previous_album_key text not null,
          canonical_album_key text not null,
          unique (library_id, canonical_album_key)
        ) on commit drop;

        with bootstrap_context as materialized (
          select requested_library_id as library_id
        ),
        incoming_albums as materialized (
          select
            incoming.artist_key,
            incoming.album_key,
            incoming.title,
            incoming.release_year,
            incoming.edition
          from jsonb_to_recordset(jsonb_build_array(projected_album || jsonb_build_object(
            'edition', projected_album #> '{metadata,edition}'
          ))::jsonb) as incoming(
            artist_key text,
            album_key text,
            title text,
            release_year integer,
            edition text
          )
          where nullif(btrim(incoming.album_key), '') is not null
            and nullif(btrim(incoming.title), '') is not null
        )
        insert into pg_temp.semantic_album_key_adoptions (
          album_id,
          library_id,
          previous_album_key,
          canonical_album_key
        )
        select
          albums.id,
          albums.library_id,
          albums.album_key,
          incoming_albums.album_key
        from bootstrap_context
        join library.local_artists as artists
          on artists.library_id = bootstrap_context.library_id
        join incoming_albums
          on incoming_albums.artist_key = artists.artist_key
        join library.local_albums as albums
          on albums.library_id = bootstrap_context.library_id
         and albums.artist_id = artists.id
         and lower(btrim(albums.title)) =
             lower(btrim(incoming_albums.title))
         and albums.release_year is not distinct from
             incoming_albums.release_year
         and lower(
               btrim(coalesce(albums.metadata ->> 'edition', ''))
             ) = lower(btrim(coalesce(incoming_albums.edition, '')))
         and albums.semantic_identity_discriminator = ''
         and albums.album_key <> incoming_albums.album_key
        where not exists (
          select 1
          from library.local_albums as canonical_key_owner
          where canonical_key_owner.library_id = albums.library_id
            and canonical_key_owner.album_key = incoming_albums.album_key
        )
        order by albums.id
        for update of albums;

        insert into library.ignored_versions (
          library_id,
          version_key,
          created_at,
          metadata
        )
        select
          ignored.library_id,
          adoptions.canonical_album_key,
          ignored.created_at,
          ignored.metadata
        from pg_temp.semantic_album_key_adoptions as adoptions
        join library.ignored_versions as ignored
          on ignored.library_id = adoptions.library_id
         and ignored.version_key = adoptions.previous_album_key
        on conflict (library_id, version_key) do update
        set
          created_at = least(
            library.ignored_versions.created_at,
            excluded.created_at
          ),
          metadata = excluded.metadata || library.ignored_versions.metadata;

        delete from library.ignored_versions
        using pg_temp.semantic_album_key_adoptions as adoptions
        where library.ignored_versions.library_id = adoptions.library_id
          and library.ignored_versions.version_key =
              adoptions.previous_album_key;

        insert into library.manual_versions (
          library_id,
          child_key,
          parent_key,
          created_at,
          updated_at,
          metadata
        )
        select distinct on (
          mapped_version.library_id,
          mapped_version.child_key
        )
          mapped_version.library_id,
          mapped_version.child_key,
          mapped_version.parent_key,
          mapped_version.created_at,
          mapped_version.updated_at,
          mapped_version.metadata
        from (
          select
            versions.library_id,
            coalesce(
              child_adoption.canonical_album_key,
              versions.child_key
            ) as child_key,
            coalesce(
              parent_adoption.canonical_album_key,
              versions.parent_key
            ) as parent_key,
            versions.child_key as original_child_key,
            versions.created_at,
            versions.updated_at,
            versions.metadata
          from library.manual_versions as versions
          left join pg_temp.semantic_album_key_adoptions as child_adoption
            on child_adoption.library_id = versions.library_id
           and child_adoption.previous_album_key = versions.child_key
          left join pg_temp.semantic_album_key_adoptions as parent_adoption
            on parent_adoption.library_id = versions.library_id
           and parent_adoption.previous_album_key = versions.parent_key
          where child_adoption.album_id is not null
             or parent_adoption.album_id is not null
        ) as mapped_version
        where mapped_version.child_key <> mapped_version.parent_key
        order by
          mapped_version.library_id,
          mapped_version.child_key,
          (
            mapped_version.original_child_key =
            mapped_version.child_key
          ) desc,
          mapped_version.updated_at desc
        on conflict (library_id, child_key) do update
        set
          parent_key = excluded.parent_key,
          created_at = least(
            library.manual_versions.created_at,
            excluded.created_at
          ),
          updated_at = greatest(
            library.manual_versions.updated_at,
            excluded.updated_at
          ),
          metadata = excluded.metadata || library.manual_versions.metadata;

        delete from library.manual_versions
        using pg_temp.semantic_album_key_adoptions as adoptions
        where library.manual_versions.library_id = adoptions.library_id
          and (
            library.manual_versions.child_key =
              adoptions.previous_album_key
            or library.manual_versions.parent_key =
              adoptions.previous_album_key
          );

        update library.local_mbid_assertions as assertions
        set target_key = adoptions.canonical_album_key
        from pg_temp.semantic_album_key_adoptions as adoptions
        where assertions.album_id = adoptions.album_id
          and assertions.target_kind = 'album';

        update ops.cover_lookup_tasks as tasks
        set album_key = adoptions.canonical_album_key
        from pg_temp.semantic_album_key_adoptions as adoptions
        where tasks.library_id = adoptions.library_id
          and tasks.album_key = adoptions.previous_album_key;

        with updated_album_ratings as (
          update app.album_ratings as ratings
          set
            album_key = adoptions.canonical_album_key,
            updated_at = observed_at
          from pg_temp.semantic_album_key_adoptions as adoptions
          where ratings.library_id = adoptions.library_id
            and ratings.album_key = adoptions.previous_album_key
          returning ratings.id
        )
        update library.local_albums as albums
        set album_key = adoptions.canonical_album_key
        from pg_temp.semantic_album_key_adoptions as adoptions
        where albums.id = adoptions.album_id;

        drop table if exists pg_temp.semantic_album_key_adoptions;

  insert into library.local_albums (
    library_id, artist_id, album_key, title, release_year, metadata
  )
  select requested_library_id, artists.id,
    projected_album ->> 'album_key', projected_album ->> 'title',
    (projected_album ->> 'release_year')::integer,
    (projected_album -> 'metadata') || jsonb_build_object('source', 'runtime_scan_cache')
  from library.local_artists as artists
  where artists.library_id = requested_library_id
    and artists.artist_key = projected_album ->> 'artist_key'
  on conflict (library_id, album_key) do update
  set artist_id = excluded.artist_id,
      title = excluded.title,
      release_year = case
        when nullif(library.local_albums.metadata ->> 'release_date', '') is not null
        then library.local_albums.release_year else excluded.release_year end,
      last_seen_at = observed_at,
      metadata = library.local_albums.metadata || excluded.metadata;

  insert into library.local_album_featured_artists (
    library_id, album_id, artist_id, featured_kind, metadata
  )
  select requested_library_id, albums.id, artists.id, credit.featured_kind,
    jsonb_build_object('source', 'runtime_scan_cache')
  from jsonb_to_recordset(destination_state -> 'credits') as credit(
    artist_key text, featured_kind text
  )
  join library.local_artists as artists
    on artists.library_id = requested_library_id and artists.artist_key = credit.artist_key
  join library.local_albums as albums
    on albums.library_id = requested_library_id
   and albums.album_key = projected_album ->> 'album_key'
  on conflict (library_id, album_id, artist_id, featured_kind) do update
  set last_seen_at = observed_at,
      metadata = library.local_album_featured_artists.metadata
        || (excluded.metadata - 'source');

with bootstrap_context as materialized (
          select requested_library_id as library_id
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(requested_track_paths::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(requested_input_rows::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        destination_album as materialized (
          select library.local_albums.id
          from bootstrap_context
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.album_key = (projected_album ->> 'album_key')
          order by library.local_albums.id
          limit 1
          for update of local_albums
        ),
        selected_track_files as materialized (
          select
            library.local_tracks.id as track_id,
            library.local_track_files.id as track_file_id,
            library.local_track_files.private_path,
            input_rows.file_entry
          from bootstrap_context
          join library.local_track_files on true
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
          join input_track_paths
            on input_track_paths.private_path = library.local_track_files.private_path
          join input_rows
            on input_rows.private_path = library.local_track_files.private_path
          where library.local_track_files.scan_cache_stale is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.track_id) as resolved_track_count,
            count(distinct selected_track_files.track_file_id)
              as resolved_track_file_count
          from selected_track_files
        ),
        updated_tracks as (
          update library.local_tracks
          set album_id = (select destination_album.id from destination_album),
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || case
                     when selected_track_files.file_entry ? 'album'
                     then jsonb_build_object(
                            'album',
                            selected_track_files.file_entry -> 'album'
                          )
                     else '{}'::jsonb
                   end,
              last_seen_at = observed_at
          from selected_track_files
          cross join selection_scope
          where library.local_tracks.id = selected_track_files.track_id
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count = selection_scope.resolved_track_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
            and (select count(*) from destination_album) = 1
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(
                  library.local_track_files.metadata -> 'scan_cache',
                  '{}'::jsonb
                ) || jsonb_build_object(
                  'source', 'runtime_scan_cache'::text,
                  'stale', false,
                  'file_entry',
                  coalesce(
                    library.local_track_files.metadata
                      #> '{scan_cache,file_entry}',
                    '{}'::jsonb
                  ) || selected_track_files.file_entry
                ),
                true
              ),
              last_seen_at = observed_at
          from selected_track_files
          cross join selection_scope
          where library.local_track_files.id = selected_track_files.track_file_id
           and library.local_track_files.scan_cache_stale is false
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count = selection_scope.resolved_track_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
            and (select count(*) from destination_album) = 1
          returning library.local_track_files.id
        ),
        updated_library as (
          update library.libraries
          set metadata = jsonb_set(
                coalesce(library.libraries.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'inventory_mutation_revision',
                       coalesce(
                         nullif(
                           library.libraries.metadata ->> 'inventory_mutation_revision',
                           ''
                         )::bigint,
                         0
                       ) + 1
                     ),
                '{scan_cache}',
                coalesce(
                  library.libraries.metadata -> 'scan_cache',
                  '{}'::jsonb
                ) || jsonb_build_object(
                  'relation_projection',
                  coalesce(
                    library.libraries.metadata
                      #> '{scan_cache,relation_projection}',
                    '{}'::jsonb
                  ) || jsonb_build_object(
                    'status', 'stale',
                    'rebuild_reason', 'structural_tag_edit'
                  )
                ),
                true
              ),
              updated_at = observed_at
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_tracks) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select selection_scope.input_path_count from selection_scope)
          returning coalesce(
            nullif(
              library.libraries.metadata ->> 'inventory_mutation_revision',
              ''
            )::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select selection_scope.input_path_count from selection_scope) as input_path_count,
          (select selection_scope.resolved_path_count from selection_scope) as resolved_path_count,
          0::bigint as source_album_count,
          0::bigint as source_album_track_file_count,
          (select count(*) from destination_album) as destination_album_count,
          (select count(*) from destination_album) as album_rows_updated,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce(
            (select updated_library.inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision,
          (select destination_album.id from destination_album) as destination_album_id
        into restore_result;

  if restore_result.input_path_count <> cardinality(requested_track_paths)
     or restore_result.resolved_path_count <> cardinality(requested_track_paths)
     or restore_result.destination_album_count <> 1
     or restore_result.track_rows_updated <> cardinality(requested_track_paths)
     or restore_result.track_file_rows_updated <> cardinality(requested_track_paths)
     or restore_result.inventory_mutation_revision < 1
     or restore_result.destination_album_id is null then
    raise exception 'Album restoration did not update the complete selected inventory'
      using errcode = '40001';
  end if;
  select canonical.canonical_album_id into surviving_album_id
  from library.reconcile_targeted_album_noncover(
    requested_library_id, restore_result.destination_album_id,
    restore_result.inventory_mutation_revision, false
  ) as canonical;
  if surviving_album_id is null then
    raise exception 'Album restoration has no surviving destination';
  end if;
  return query select
    restore_result.input_path_count, restore_result.resolved_path_count,
    restore_result.source_album_count, restore_result.source_album_track_file_count,
    restore_result.destination_album_count, restore_result.album_rows_updated,
    restore_result.track_rows_updated, restore_result.track_file_rows_updated,
    restore_result.inventory_mutation_revision, surviving_album_id;
end;
$function$;
revoke all on function library.restore_detached_album_noncover(bigint,text[],bigint,jsonb,jsonb,timestamptz) from public;
do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.restore_detached_album_noncover(bigint,text[],bigint,jsonb,jsonb,timestamptz) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on function library.restore_detached_album_noncover(bigint,text[],bigint,jsonb,jsonb,timestamptz) from album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function library.restore_detached_album_noncover(bigint,text[],bigint,jsonb,jsonb,timestamptz) from album_haven_readonly;
  end if;
end;
$permissions$;


