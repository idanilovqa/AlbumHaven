-- Additive cover-consistency authority for mixed-version Phase 8 rollout.

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
     or resolved_tracks <> cardinality(requested_track_paths)
     or exists (
       select 1
       from library.local_tracks as tracks
       join library.local_track_files as files on files.track_id = tracks.id
       join jsonb_to_recordset(requested_input_rows) as incoming(
         private_path text, file_entry jsonb
       ) on incoming.private_path = files.private_path
       where tracks.library_id = requested_library_id
         and files.scan_cache_stale is false
         and (
           (nullif(btrim(files.metadata #>> '{scan_cache,file_entry,album}'), '') is not null
            and nullif(btrim(files.metadata #>> '{scan_cache,file_entry,exception_type}'), '') is null)
           or lower(btrim(coalesce((
             coalesce(files.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
               || incoming.file_entry
           ) ->> 'album', ''))) <> lower(btrim(projected_album ->> 'title'))
           or nullif(btrim((
             coalesce(files.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
               || incoming.file_entry
           ) ->> 'exception_type'), '') is not null
         )
     ) then
    raise exception 'Album restoration must resolve eligible selected tracks'
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


create or replace function library.persist_blank_album_tag_edit_noncover(
  requested_library_id bigint,
  requested_track_paths text[],
  expected_inventory_revision bigint,
  requested_input_rows jsonb,
  retain_album_membership boolean,
  observed_at timestamptz
)
returns table (input_path_count bigint, resolved_path_count bigint, source_album_count bigint, source_album_track_file_count bigint, source_album_id bigint, destination_album_id bigint, track_rows_updated bigint, track_file_rows_updated bigint, inventory_mutation_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog, library, app, pg_temp
as $function$
declare current_revision bigint;
begin
  if retain_album_membership is null then
    raise exception 'blank Album edit requires an explicit membership decision'
      using errcode = '22023';
  end if;
  if requested_library_id is null or expected_inventory_revision is null
     or observed_at is null
     or coalesce(cardinality(requested_track_paths), 0) = 0
     or jsonb_typeof(requested_input_rows) is distinct from 'array' then
    raise exception 'noncover tag edit requires identity, paths and revision'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(requested_input_rows) as entry(value)
    where jsonb_typeof(entry.value) is distinct from 'object'
       or entry.value - array['private_path','file_entry'] <> '{}'::jsonb
       or jsonb_typeof(entry.value -> 'file_entry') is distinct from 'object'
       or (entry.value -> 'file_entry') - array['album', 'exception_type', 'mtime', 'size'] <> '{}'::jsonb
       or nullif(entry.value ->> 'private_path', '') is null
       or not ((entry.value ->> 'private_path') = any(requested_track_paths))
  ) or jsonb_array_length(requested_input_rows) <> cardinality(requested_track_paths)
    or (select count(distinct path) from unnest(requested_track_paths) as path)
       <> cardinality(requested_track_paths)
    or (select count(distinct entry.value ->> 'private_path')
        from jsonb_array_elements(requested_input_rows) as entry(value))
       <> cardinality(requested_track_paths) then
    raise exception 'noncover tag edit fields or path scope are invalid'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0)
  into current_revision from library.libraries
  where id = requested_library_id for update;
  if not found or current_revision <> expected_inventory_revision then
    raise exception 'noncover tag edit inventory revision conflict'
      using errcode = '40001';
  end if;
  return query
with bootstrap_context as (
          select requested_library_id as library_id
        ),
        input_rows as materialized (
          select *
          from jsonb_to_recordset(requested_input_rows::jsonb) as input_row (
            private_path text,
            file_entry jsonb
          )
        ),
        selected_track_files as materialized (
          select
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
            library.local_track_files.id as track_file_id,
            input_rows.file_entry
          from bootstrap_context
          join input_rows on true
          join library.local_track_files
            on library.local_track_files.private_path = input_rows.private_path
           and library.local_track_files.scan_cache_stale is false
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = bootstrap_context.library_id
        ),
        selection_scope as materialized (
          select
            (select count(*) from unnest(requested_track_paths::text[])) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.source_album_id) as source_album_count,
            min(selected_track_files.source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id
          from bootstrap_context
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = (select selection_scope.source_album_id from selection_scope)
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
        ),
        updated_tracks as (
          update library.local_tracks
          set album_id = case
                when retain_album_membership::boolean
                then selected_track_files.source_album_id
                else null
              end,
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || jsonb_build_object('album', selected_track_files.file_entry -> 'album'),
              last_seen_at = now()
          from selected_track_files
          where library.local_tracks.id = selected_track_files.track_id
            and (select selection_scope.source_album_count from selection_scope) <= 1
            and (select selection_scope.resolved_path_count from selection_scope) =
                (select selection_scope.input_path_count from selection_scope)
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'source', 'runtime_scan_cache'::text,
                       'stale', false,
                       'file_entry',
                       coalesce(
                         library.local_track_files.metadata #> '{scan_cache,file_entry}',
                         '{}'::jsonb
                       ) || selected_track_files.file_entry
                     ),
                true
              ),
              last_seen_at = now()
          from selected_track_files
          where library.local_track_files.id = selected_track_files.track_file_id
            and (select count(*) from updated_tracks) =
                (select selection_scope.input_path_count from selection_scope)
          returning library.local_track_files.id
        ),
        updated_library as (
          update library.libraries
          set metadata = jsonb_set(
                coalesce(library.libraries.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'inventory_mutation_revision',
                       coalesce(
                         nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
                         0
                       ) + 1
                     ),
                '{scan_cache}',
                coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'relation_projection',
                       coalesce(
                         library.libraries.metadata #> '{scan_cache,relation_projection}',
                         '{}'::jsonb
                       ) || jsonb_build_object(
                         'status', 'stale',
                         'rebuild_reason', 'structural_tag_edit'
                       )
                     ),
                true
              ),
              updated_at = now()
          from bootstrap_context
          where library.libraries.id = bootstrap_context.library_id
            and (select count(*) from updated_tracks) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select selection_scope.input_path_count from selection_scope)
          returning coalesce(
            nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select selection_scope.input_path_count from selection_scope) as input_path_count,
          (select selection_scope.resolved_path_count from selection_scope) as resolved_path_count,
          (select selection_scope.source_album_count from selection_scope) as source_album_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          (select selection_scope.source_album_id from selection_scope) as source_album_id,
          (select selection_scope.source_album_id from selection_scope) as destination_album_id,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce((select updated_library.inventory_mutation_revision from updated_library), 0)
            as inventory_mutation_revision;
end;
$function$;
revoke all on function library.persist_blank_album_tag_edit_noncover(bigint,text[],bigint,jsonb,boolean,timestamptz) from public;
do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.persist_blank_album_tag_edit_noncover(bigint,text[],bigint,jsonb,boolean,timestamptz) to album_haven_app;
  end if;
end;
$permissions$;

create or replace function library.persist_inventory_tag_edit_noncover(
  requested_library_id bigint,
  requested_track_paths text[],
  expected_inventory_revision bigint,
  requested_input_rows jsonb,
  observed_at timestamptz
)
returns table (input_path_count bigint, resolved_path_count bigint, source_album_track_file_count bigint, track_rows_updated bigint, track_file_rows_updated bigint, inventory_mutation_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog, library, app, pg_temp
as $function$
declare current_revision bigint;
begin
  if requested_library_id is null or expected_inventory_revision is null
     or observed_at is null
     or coalesce(cardinality(requested_track_paths), 0) = 0
     or jsonb_typeof(requested_input_rows) is distinct from 'array' then
    raise exception 'noncover tag edit requires identity, paths and revision'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(requested_input_rows) as entry(value)
    where jsonb_typeof(entry.value) is distinct from 'object'
       or entry.value - array['private_path','file_entry'] <> '{}'::jsonb
       or jsonb_typeof(entry.value -> 'file_entry') is distinct from 'object'
       or (entry.value -> 'file_entry') - array['title', 'genre', 'track_number', 'disc_number', 'mtime', 'size'] <> '{}'::jsonb
       or nullif(entry.value ->> 'private_path', '') is null
       or not ((entry.value ->> 'private_path') = any(requested_track_paths))
  ) or jsonb_array_length(requested_input_rows) <> cardinality(requested_track_paths)
    or (select count(distinct path) from unnest(requested_track_paths) as path)
       <> cardinality(requested_track_paths)
    or (select count(distinct entry.value ->> 'private_path')
        from jsonb_array_elements(requested_input_rows) as entry(value))
       <> cardinality(requested_track_paths) then
    raise exception 'noncover tag edit fields or path scope are invalid'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0)
  into current_revision from library.libraries
  where id = requested_library_id for update;
  if not found or current_revision <> expected_inventory_revision then
    raise exception 'noncover tag edit inventory revision conflict'
      using errcode = '40001';
  end if;
  return query
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
        selected_track_files as materialized (
          select
            library.local_tracks.id as track_id,
            library.local_track_files.id as track_file_id,
            library.local_tracks.album_id,
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
              as resolved_track_file_count,
            count(*) as source_album_track_file_count
          from selected_track_files
        ),
        updated_tracks as (
          update library.local_tracks
          set title = case
                when selected_track_files.file_entry ? 'title'
                then selected_track_files.file_entry ->> 'title'
                else library.local_tracks.title
              end,
              track_number = case
                when selected_track_files.file_entry ? 'track_number'
                then nullif(selected_track_files.file_entry ->> 'track_number', '')::integer
                else library.local_tracks.track_number
              end,
              disc_number = case
                when selected_track_files.file_entry ? 'disc_number'
                then nullif(selected_track_files.file_entry ->> 'disc_number', '')::integer
                else library.local_tracks.disc_number
              end,
              metadata = coalesce(library.local_tracks.metadata, '{}'::jsonb)
                || selected_track_files.file_entry,
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_tracks.id = selected_track_files.track_id
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count = selection_scope.resolved_track_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
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
                    library.local_track_files.metadata #> '{scan_cache,file_entry}',
                    '{}'::jsonb
                  ) || selected_track_files.file_entry
                ),
                true
              ),
              last_seen_at = now()
          from selected_track_files
          cross join selection_scope
          where library.local_track_files.id = selected_track_files.track_file_id
            and library.local_track_files.scan_cache_stale is false
            and selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.input_path_count = selection_scope.resolved_track_count
            and selection_scope.input_path_count =
                selection_scope.resolved_track_file_count
          returning library.local_track_files.id
        ),
        updated_library as (
          update library.libraries
          set metadata = coalesce(library.libraries.metadata, '{}'::jsonb)
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
              updated_at = now()
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
          (select selection_scope.source_album_track_file_count from selection_scope)
            as source_album_track_file_count,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          coalesce(
            (select updated_library.inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision;
end;
$function$;
revoke all on function library.persist_inventory_tag_edit_noncover(bigint,text[],bigint,jsonb,timestamptz) from public;
do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.persist_inventory_tag_edit_noncover(bigint,text[],bigint,jsonb,timestamptz) to album_haven_app;
  end if;
end;
$permissions$;


-- Noncover identity repair retains the canonical committed cover exactly.
create or replace function library.reconcile_semantic_album_noncover(
  target_library_id bigint,
  target_release_key text,
  target_album_id bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, library, app, ops, pg_temp
as $$
declare
  canonical record;
  cover_keys constant text[] := array['cover_validation_path', 'cover_validation_mtime_ns', 'cover_validation_size', 'cover_path', 'cover_revision', 'cover_selection_origin', 'local_cover_width', 'local_cover_height', 'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source', 'remote_cover_source_label', 'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'];
begin
  perform pg_advisory_xact_lock(
    hashtext('album-haven:local-inventory-publication')
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'album_haven:semantic-local-album-reconciliation:'
        || target_library_id::text,
      0
    )
  );

  for canonical in
    select
      min(albums.id) as album_id,
      (array_agg(albums.album_key order by albums.id))[1] as album_key,
      albums.artist_id,
      lower(btrim(albums.title)) as normalized_title,
      albums.release_year,
      lower(btrim(coalesce(albums.metadata ->> 'edition', '')))
        as normalized_edition
    from library.local_albums as albums
    join library.local_artists as artists
      on artists.id = albums.artist_id
     and artists.library_id = albums.library_id
    where albums.library_id = target_library_id
      and (target_album_id is null or exists (
        select 1 from library.local_albums as target
        where target.id = target_album_id
          and target.library_id = albums.library_id
          and target.artist_id = albums.artist_id
          and lower(btrim(target.title)) = lower(btrim(albums.title))
          and target.release_year is not distinct from albums.release_year
          and lower(btrim(coalesce(target.metadata ->> 'edition', ''))) =
              lower(btrim(coalesce(albums.metadata ->> 'edition', '')))
      ))
      and target_release_key = concat_ws(
            '::',
            lower(
              btrim(
                coalesce(
                  nullif(btrim(albums.metadata ->> 'album_artist'), ''),
                  artists.name,
                  ''
                )
              )
            ),
            lower(btrim(albums.title)),
            nullif(
              lower(btrim(coalesce(albums.metadata ->> 'edition', ''))),
              ''
            )
          )
    group by
      albums.artist_id,
      lower(btrim(albums.title)),
      albums.release_year,
      lower(btrim(coalesce(albums.metadata ->> 'edition', '')))
    having count(*) > 1
  loop
    perform albums.id
    from library.local_albums as albums
    where albums.library_id = target_library_id
      and albums.artist_id = canonical.artist_id
      and lower(btrim(albums.title)) = canonical.normalized_title
      and albums.release_year is not distinct from canonical.release_year
      and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
          canonical.normalized_edition
    order by albums.id
    for update;

    with semantic_album_members as (
      select albums.id as album_id
      from library.local_albums as albums
      where albums.library_id = target_library_id
        and albums.artist_id = canonical.artist_id
        and lower(btrim(albums.title)) = canonical.normalized_title
        and albums.release_year is not distinct from canonical.release_year
        and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
            canonical.normalized_edition
    ),
    metadata_candidates as (
      select
        members.album_id,
        metadata_entry.key,
        metadata_entry.value,
        case
          when metadata_entry.value = 'null'::jsonb then false
          when jsonb_typeof(metadata_entry.value) = 'string'
            then nullif(btrim(metadata_entry.value #>> '{}'), '') is not null
          when jsonb_typeof(metadata_entry.value) = 'array'
            then metadata_entry.value <> '[]'::jsonb
          when jsonb_typeof(metadata_entry.value) = 'object'
            then metadata_entry.value <> '{}'::jsonb
          else true
        end as value_is_meaningful
      from semantic_album_members as members
      join library.local_albums as albums on albums.id = members.album_id
      cross join lateral jsonb_each(
        coalesce(albums.metadata, '{}'::jsonb) - cover_keys
      ) as metadata_entry
    ),
    metadata_values as (
      select
        metadata_candidates.key,
        metadata_candidates.value,
        row_number() over (
          partition by metadata_candidates.key
          order by
            (
              metadata_candidates.album_id = canonical.album_id
              and metadata_candidates.value_is_meaningful
            ) desc,
            metadata_candidates.value_is_meaningful desc,
            (
              metadata_candidates.album_id = canonical.album_id
            ) desc,
            metadata_candidates.album_id
        ) as preference
      from metadata_candidates
    ),
    merged_metadata as (
      select jsonb_object_agg(key, value) as metadata
      from metadata_values
      where preference = 1
    ),
    merged_projection as (
      select
        min(albums.first_seen_at) as first_seen_at,
        max(albums.last_seen_at) as last_seen_at,
        (
          array_agg(
            members.album_id
            order by
              (albums.mbid is not null) desc,
              (albums.mbid_assertion_state <> 'unreviewed') desc,
              albums.evidence_confidence desc nulls last,
              (members.album_id = canonical.album_id) desc,
              (albums.evidence_source is not null) desc,
              members.album_id
          )
        )[1] as best_evidence_album_id
      from semantic_album_members as members
      join library.local_albums as albums on albums.id = members.album_id
    )
    update library.local_albums as survivor
    set
      first_seen_at = merged_projection.first_seen_at,
      last_seen_at = merged_projection.last_seen_at,
      mbid = best_evidence.mbid,
      mbid_assertion_state = best_evidence.mbid_assertion_state,
      evidence_source = best_evidence.evidence_source,
      evidence_confidence = best_evidence.evidence_confidence,
      mbid_assertion_migration_run_id =
        best_evidence.mbid_assertion_migration_run_id,
      mbid_assertion_scan_run_ref =
        best_evidence.mbid_assertion_scan_run_ref,
      metadata = coalesce(merged_metadata.metadata, '{}'::jsonb)
        || coalesce((
          select jsonb_object_agg(entry.key, entry.value)
          from jsonb_each(coalesce(survivor.metadata, '{}'::jsonb)) as entry
          where entry.key = any(cover_keys)
        ), '{}'::jsonb)
    from merged_projection
    cross join merged_metadata
    join library.local_albums as best_evidence
      on best_evidence.id = merged_projection.best_evidence_album_id
    where survivor.id = canonical.album_id;

    drop table if exists pg_temp.semantic_album_candidates;
    create temporary table semantic_album_candidates (
      redundant_album_id bigint primary key,
      canonical_album_id bigint not null,
      library_id bigint not null,
      redundant_album_key text not null,
      canonical_album_key text not null
    ) on commit drop;

    insert into semantic_album_candidates (
      redundant_album_id,
      canonical_album_id,
      library_id,
      redundant_album_key,
      canonical_album_key
    )
    select
      albums.id,
      canonical.album_id,
      albums.library_id,
      albums.album_key,
      canonical.album_key
    from library.local_albums as albums
    where albums.library_id = target_library_id
      and albums.artist_id = canonical.artist_id
      and lower(btrim(albums.title)) = canonical.normalized_title
      and albums.release_year is not distinct from canonical.release_year
      and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
          canonical.normalized_edition
      and albums.id <> canonical.album_id;

    insert into app.album_ratings (
      account_id,
      library_id,
      album_key,
      rating,
      provenance,
      created_at,
      updated_at,
      metadata
    )
    select distinct on (
      app.album_ratings.account_id,
      semantic_album_candidates.library_id,
      semantic_album_candidates.canonical_album_key
    )
      app.album_ratings.account_id,
      semantic_album_candidates.library_id,
      semantic_album_candidates.canonical_album_key,
      app.album_ratings.rating,
      app.album_ratings.provenance,
      app.album_ratings.created_at,
      app.album_ratings.updated_at,
      app.album_ratings.metadata
    from semantic_album_candidates
    join app.album_ratings
      on app.album_ratings.library_id = semantic_album_candidates.library_id
     and app.album_ratings.album_key =
         semantic_album_candidates.redundant_album_key
    order by
      app.album_ratings.account_id,
      semantic_album_candidates.library_id,
      semantic_album_candidates.canonical_album_key,
      (app.album_ratings.rating is not null) desc,
      app.album_ratings.updated_at desc,
      semantic_album_candidates.redundant_album_id
    on conflict (account_id, library_id, album_key) do update
    set
      rating = coalesce(app.album_ratings.rating, excluded.rating),
      provenance = case
        when app.album_ratings.rating is null and excluded.rating is not null
          then excluded.provenance
        else app.album_ratings.provenance
      end,
      created_at = least(app.album_ratings.created_at, excluded.created_at),
      updated_at = greatest(app.album_ratings.updated_at, excluded.updated_at),
      metadata = excluded.metadata || app.album_ratings.metadata;

    delete from app.album_ratings
    using semantic_album_candidates
    where app.album_ratings.library_id = semantic_album_candidates.library_id
      and app.album_ratings.album_key =
          semantic_album_candidates.redundant_album_key;

    insert into library.local_album_featured_artists (
      library_id,
      album_id,
      artist_id,
      featured_kind,
      first_seen_at,
      last_seen_at,
      metadata
    )
    select distinct on (
      library.local_album_featured_artists.library_id,
      semantic_album_candidates.canonical_album_id,
      library.local_album_featured_artists.artist_id,
      library.local_album_featured_artists.featured_kind
    )
      library.local_album_featured_artists.library_id,
      semantic_album_candidates.canonical_album_id,
      library.local_album_featured_artists.artist_id,
      library.local_album_featured_artists.featured_kind,
      library.local_album_featured_artists.first_seen_at,
      library.local_album_featured_artists.last_seen_at,
      library.local_album_featured_artists.metadata
    from semantic_album_candidates
    join library.local_album_featured_artists
      on library.local_album_featured_artists.album_id =
         semantic_album_candidates.redundant_album_id
    order by
      library.local_album_featured_artists.library_id,
      semantic_album_candidates.canonical_album_id,
      library.local_album_featured_artists.artist_id,
      library.local_album_featured_artists.featured_kind,
      library.local_album_featured_artists.last_seen_at desc,
      semantic_album_candidates.redundant_album_id
    on conflict (library_id, album_id, artist_id, featured_kind) do update
    set
      first_seen_at = least(
        library.local_album_featured_artists.first_seen_at,
        excluded.first_seen_at
      ),
      last_seen_at = greatest(
        library.local_album_featured_artists.last_seen_at,
        excluded.last_seen_at
      ),
      metadata = excluded.metadata
        || library.local_album_featured_artists.metadata;

    delete from library.local_album_featured_artists
    using semantic_album_candidates
    where library.local_album_featured_artists.album_id =
          semantic_album_candidates.redundant_album_id;

    update library.local_mbid_assertions
    set
      album_id = semantic_album_candidates.canonical_album_id,
      target_key = case
        when library.local_mbid_assertions.target_kind = 'album'
          then semantic_album_candidates.canonical_album_key
        else library.local_mbid_assertions.target_key
      end
    from semantic_album_candidates
    where library.local_mbid_assertions.album_id =
          semantic_album_candidates.redundant_album_id;

    insert into library.ignored_versions (
      library_id,
      version_key,
      created_at,
      metadata
    )
    select distinct on (
      library.ignored_versions.library_id,
      semantic_album_candidates.canonical_album_key
    )
      library.ignored_versions.library_id,
      semantic_album_candidates.canonical_album_key,
      library.ignored_versions.created_at,
      library.ignored_versions.metadata
    from semantic_album_candidates
    join library.ignored_versions
      on library.ignored_versions.library_id =
         semantic_album_candidates.library_id
     and library.ignored_versions.version_key =
         semantic_album_candidates.redundant_album_key
    order by
      library.ignored_versions.library_id,
      semantic_album_candidates.canonical_album_key,
      library.ignored_versions.created_at
    on conflict (library_id, version_key) do update
    set
      created_at = least(
        library.ignored_versions.created_at,
        excluded.created_at
      ),
      metadata = excluded.metadata || library.ignored_versions.metadata;

    delete from library.ignored_versions
    using semantic_album_candidates
    where library.ignored_versions.library_id =
          semantic_album_candidates.library_id
      and library.ignored_versions.version_key =
          semantic_album_candidates.redundant_album_key;

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
        library.manual_versions.library_id,
        coalesce(
          child_candidate.canonical_album_key,
          library.manual_versions.child_key
        ) as child_key,
        coalesce(
          parent_candidate.canonical_album_key,
          library.manual_versions.parent_key
        ) as parent_key,
        library.manual_versions.child_key as original_child_key,
        library.manual_versions.created_at,
        library.manual_versions.updated_at,
        library.manual_versions.metadata
      from library.manual_versions
      left join semantic_album_candidates as child_candidate
        on child_candidate.library_id = library.manual_versions.library_id
       and child_candidate.redundant_album_key =
           library.manual_versions.child_key
      left join semantic_album_candidates as parent_candidate
        on parent_candidate.library_id = library.manual_versions.library_id
       and parent_candidate.redundant_album_key =
           library.manual_versions.parent_key
      where child_candidate.redundant_album_id is not null
         or parent_candidate.redundant_album_id is not null
    ) as mapped_version
    where mapped_version.child_key <> mapped_version.parent_key
    order by
      mapped_version.library_id,
      mapped_version.child_key,
      (mapped_version.original_child_key = mapped_version.child_key) desc,
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
    using semantic_album_candidates
    where library.manual_versions.library_id =
          semantic_album_candidates.library_id
      and (
        library.manual_versions.child_key =
          semantic_album_candidates.redundant_album_key
        or library.manual_versions.parent_key =
          semantic_album_candidates.redundant_album_key
      );

    update ops.cover_lookup_tasks
    set album_key = semantic_album_candidates.canonical_album_key
    from semantic_album_candidates
    where ops.cover_lookup_tasks.library_id =
          semantic_album_candidates.library_id
      and ops.cover_lookup_tasks.album_key =
          semantic_album_candidates.redundant_album_key;

    update library.local_tracks
    set album_id = semantic_album_candidates.canonical_album_id
    from semantic_album_candidates
    where library.local_tracks.album_id =
          semantic_album_candidates.redundant_album_id;

    delete from library.local_albums
    using semantic_album_candidates
    where library.local_albums.id =
          semantic_album_candidates.redundant_album_id;

    drop table if exists pg_temp.semantic_album_candidates;
  end loop;
end;
$$;


create or replace function library.reconcile_removed_separate_release(
  target_library_id bigint, target_release_key text
)
returns void language sql
set search_path = pg_catalog, library
as $function$
  select library.reconcile_semantic_album_noncover(
    target_library_id, target_release_key, null
  );
$function$;

alter function library.sync_separate_release_discriminators()
  security definer;
alter function library.sync_separate_release_discriminators()
  set search_path = pg_catalog, library, app, ops, pg_temp;
alter function library.refresh_artist_album_semantic_discriminators()
  security definer;
alter function library.refresh_artist_album_semantic_discriminators()
  set search_path = pg_catalog, library, app, ops, pg_temp;

drop function if exists library.reconcile_targeted_album_noncover(bigint,bigint,bigint,boolean);
create or replace function library.reconcile_targeted_album_noncover(
  requested_library_id bigint,
  requested_album_id bigint,
  expected_inventory_revision bigint,
  allow_separate_release_merge boolean
)
returns table (canonical_album_id bigint, canonical_album_key text)
language plpgsql
security definer
set search_path = pg_catalog, library, app, ops, pg_temp
as $function$
declare
  current_revision bigint;
  requested_release_key text;
  target_album library.local_albums%rowtype;
begin
  if requested_library_id is null or requested_album_id is null
     or expected_inventory_revision is null
     or allow_separate_release_merge is null then
    raise exception 'targeted reconciliation requires identity and revision'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(
    nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0
  ) into current_revision
  from library.libraries where id = requested_library_id for update;
  if not found or current_revision <> expected_inventory_revision then
    raise exception 'targeted reconciliation inventory revision conflict'
      using errcode = '40001';
  end if;
  select concat_ws(
    '::',
    lower(btrim(coalesce(
      nullif(btrim(albums.metadata ->> 'album_artist'), ''), artists.name, ''
    ))),
    lower(btrim(albums.title)),
    nullif(lower(btrim(coalesce(albums.metadata ->> 'edition', ''))), '')
  ) into requested_release_key
  from library.local_albums as albums
  join library.local_artists as artists
    on artists.id = albums.artist_id and artists.library_id = albums.library_id
  where albums.id = requested_album_id
    and albums.library_id = requested_library_id
    and nullif(btrim(albums.title), '') is not null;
  if not found then
    raise exception 'targeted reconciliation album identity conflict'
      using errcode = '22023';
  end if;
  select albums.* into target_album
  from library.local_albums as albums
  where albums.id = requested_album_id and albums.library_id = requested_library_id;
  if allow_separate_release_merge or not exists (
    select 1 from library.separate_releases as separate
    where separate.library_id = requested_library_id
      and separate.release_key = requested_release_key
  ) then
    perform library.reconcile_semantic_album_noncover(
      requested_library_id, requested_release_key, requested_album_id
    );
    return query
    select albums.id, albums.album_key
    from library.local_albums as albums
    join library.local_artists as artists
      on artists.id = albums.artist_id and artists.library_id = albums.library_id
    where albums.library_id = requested_library_id
      and albums.artist_id = target_album.artist_id
      and lower(btrim(albums.title)) = lower(btrim(target_album.title))
      and albums.release_year is not distinct from target_album.release_year
      and lower(btrim(coalesce(albums.metadata ->> 'edition', ''))) =
          lower(btrim(coalesce(target_album.metadata ->> 'edition', '')))
      and concat_ws(
        '::', lower(btrim(coalesce(
          nullif(btrim(albums.metadata ->> 'album_artist'), ''), artists.name, ''
        ))), lower(btrim(albums.title)),
        nullif(lower(btrim(coalesce(albums.metadata ->> 'edition', ''))), '')
      ) = requested_release_key
    order by albums.id limit 1;
  else
    return query select target_album.id, target_album.album_key;
  end if;
end;
$function$;

revoke all on function library.reconcile_semantic_album_noncover(bigint,text,bigint) from public;
revoke all on function library.reconcile_removed_separate_release(bigint,text) from public;
revoke all on function library.sync_separate_release_discriminators() from public;
revoke all on function library.refresh_artist_album_semantic_discriminators() from public;
revoke all on function library.reconcile_targeted_album_noncover(bigint,bigint,bigint,boolean) from public;
do $permissions$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on function library.reconcile_semantic_album_noncover(bigint,text,bigint) from album_haven_app;
    revoke all on function library.reconcile_removed_separate_release(bigint,text) from album_haven_app;
    grant execute on function library.reconcile_targeted_album_noncover(bigint,bigint,bigint,boolean) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on function library.reconcile_semantic_album_noncover(bigint,text,bigint) from album_haven_worker;
    revoke all on function library.reconcile_removed_separate_release(bigint,text) from album_haven_worker;
  end if;
end;
$permissions$;


create table if not exists library.cover_mutation_state (
  library_id bigint
    references library.libraries(id) on delete cascade,
  cover_mutation_revision bigint not null default 0
    check (cover_mutation_revision >= 0),
  updated_at timestamptz not null default now(),
  primary key (library_id)
);

insert into library.cover_mutation_state (library_id, cover_mutation_revision)
select id,
       greatest(
         0,
         coalesce(
           nullif(metadata ->> 'cover_mutation_revision', '')::bigint,
           0
         )
       )
from library.libraries
on conflict (library_id) do nothing;

create or replace function library.read_cover_mutation_revision(
  requested_library_id bigint
)
returns bigint
language sql
security definer
set search_path = pg_catalog, library
stable
as $function$
  select coalesce(
    (
      select state.cover_mutation_revision
      from library.cover_mutation_state as state
      where state.library_id = requested_library_id
    ),
    0
  );
$function$;

create or replace function library.commit_cover_selection(
  requested_library_id bigint,
  requested_album_id bigint,
  requested_track_paths text[],
  expected_inventory_revision bigint,
  expected_cover_mutation_revision bigint,
  expected_selected_cover_revision text,
  selected_cover_path text,
  promoted_cover_revision text,
  selected_origin text,
  clear_selection boolean,
  remote_cover jsonb,
  artifact_sha256 text,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  requested_task_id bigint,
  requested_checkpoint_revision bigint,
  observed_at timestamptz
)
returns table (
  committed boolean,
  cover_mutation_revision bigint,
  reason_code text,
  finalization_checkpoint_id bigint,
  finalization_checkpoint_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog, library, ops
as $function$
declare
  current_inventory_revision bigint;
  current_cover_mutation_revision bigint;
  resolved_path_count integer;
  resolved_album_count integer;
  resolved_album_id bigint;
  current_selected_revision text;
  desired_album_metadata jsonb;
  changed_album_count integer;
  changed_file_count integer;
  committed_checkpoint_id bigint;
  committed_checkpoint_revision bigint;
begin
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));

  if observed_at is null then
    raise exception 'cover mutation observation time is required'
      using errcode = '22023';
  end if;

  insert into library.cover_mutation_state (library_id)
  values (requested_library_id)
  on conflict (library_id) do nothing;

  select
    coalesce(
      nullif(library_row.metadata ->> 'inventory_mutation_revision', '')::bigint,
      0
    ),
    state.cover_mutation_revision
  into current_inventory_revision, current_cover_mutation_revision
  from library.libraries as library_row
  join library.cover_mutation_state as state
    on state.library_id = library_row.id
  where library_row.id = requested_library_id
  for update of library_row, state;

  if not found then
    return query select false, null::bigint, 'identity_conflict'::text,
      null::bigint, null::bigint;
    return;
  end if;
  if current_inventory_revision is distinct from expected_inventory_revision then
    return query select false, current_cover_mutation_revision,
      'inventory_revision_conflict'::text, null::bigint, null::bigint;
    return;
  end if;
  if current_cover_mutation_revision is distinct from expected_cover_mutation_revision then
    return query select false, current_cover_mutation_revision,
      'revision_conflict'::text, null::bigint, null::bigint;
    return;
  end if;

  if clear_selection is null then
    raise exception 'clear selection decision is required';
  end if;
  if clear_selection then
    if selected_cover_path is not null
       or promoted_cover_revision is not null
       or selected_origin is not null
       or remote_cover is not null then
      raise exception 'clear selection cannot carry replacement cover state';
    end if;
  elsif promoted_cover_revision is null
     or selected_origin is null
     or selected_origin not in ('user', 'automatic') then
    raise exception 'replacement selection requires revision and valid origin';
  elsif remote_cover is null and nullif(btrim(selected_cover_path), '') is null then
    raise exception 'local replacement requires selected cover path';
  elsif remote_cover is not null and selected_cover_path is not null then
    raise exception 'remote replacement cannot carry local cover path';
  end if;

  if remote_cover is not null and (
    jsonb_typeof(remote_cover) <> 'object'
    or remote_cover - array[
      'remote_cover_url', 'remote_cover_thumbnail_url',
      'remote_cover_source', 'remote_cover_source_label',
      'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
    ]::text[] <> '{}'::jsonb
  ) then
    raise exception 'remote cover contains unsupported keys';
  end if;

  if (requested_job_id is null) <> (requested_attempt is null)
     or (requested_job_id is null) <> (requested_worker_id is null)
     or (requested_job_id is null) <> (requested_lease_token is null)
     or (requested_job_id is null) <> (requested_task_id is null)
     or (requested_job_id is null) <> (requested_checkpoint_revision is null) then
    raise exception 'durable cover fence must be all null or all present';
  end if;
  if requested_job_id is not null
     and (artifact_sha256 is null or artifact_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'durable cover fence requires artifact SHA-256';
  end if;

  if requested_job_id is not null then
    perform 1
    from ops.jobs as job
    join ops.cover_remote_save_checkpoints as checkpoint
      on checkpoint.job_id = job.id
     and checkpoint.task_id = requested_task_id
     and checkpoint.row_revision = requested_checkpoint_revision
     and checkpoint.checkpoint = 'artifact_written'
     and checkpoint.artifact_sha256 = commit_cover_selection.artifact_sha256
    join ops.cover_lookup_tasks as task
      on task.id = checkpoint.task_id
     and task.library_id = requested_library_id
     and task.local_album_id = requested_album_id
    where job.id = requested_job_id
      and job.attempt_count = requested_attempt
      and job.lease_owner = requested_worker_id
      and job.lease_token = requested_lease_token
    for update of job, checkpoint, task;
    if not found then
      return query select false, current_cover_mutation_revision,
        'lease_lost'::text, null::bigint, null::bigint;
      return;
    end if;

    if exists (
      select 1
      from ops.jobs as job
      join ops.cover_remote_save_checkpoints as checkpoint
        on checkpoint.job_id = job.id
       and checkpoint.task_id = requested_task_id
       and checkpoint.row_revision = requested_checkpoint_revision
      join ops.cover_lookup_tasks as task on task.id = checkpoint.task_id
      where job.id = requested_job_id
        and (job.cancel_requested_at is not null
          or task.cancel_requested_at is not null)
    ) then
      return query select false, current_cover_mutation_revision,
        'canceled'::text, null::bigint, null::bigint;
      return;
    end if;

    if not exists (
      select 1
      from ops.jobs as job
      join ops.cover_remote_save_checkpoints as checkpoint
        on checkpoint.job_id = job.id
       and checkpoint.task_id = requested_task_id
       and checkpoint.row_revision = requested_checkpoint_revision
       and checkpoint.checkpoint = 'artifact_written'
       and checkpoint.artifact_sha256 = commit_cover_selection.artifact_sha256
      join ops.cover_lookup_tasks as task on task.id = checkpoint.task_id
      where job.id = requested_job_id
        and job.state = 'running'
        and job.attempt_count = requested_attempt
        and job.lease_owner = requested_worker_id
        and job.lease_token = requested_lease_token
        and job.lease_expires_at > clock_timestamp()
        and job.cancel_requested_at is null
        and task.status = 'running'
        and task.cancel_requested_at is null
    ) then
      return query select false, current_cover_mutation_revision,
        'lease_lost'::text, null::bigint, null::bigint;
      return;
    end if;
  end if;

  with input_paths as materialized (
    select distinct nullif(btrim(path_value), '') as private_path
    from unnest(requested_track_paths) as path_value
    where nullif(btrim(path_value), '') is not null
  ), resolved as materialized (
    select file.id as file_id, track.album_id
    from input_paths
    join library.local_track_files as file
      on file.private_path = input_paths.private_path
    join library.local_tracks as track
      on track.id = file.track_id
     and track.library_id = requested_library_id
    join library.library_roots as root
      on root.id = file.library_root_id
     and root.library_id = requested_library_id
     and root.is_active is true
  )
  select count(*), count(distinct album_id), min(album_id)
  into resolved_path_count, resolved_album_count, resolved_album_id
  from resolved;

  if coalesce(cardinality(requested_track_paths), 0) = 0
     or resolved_path_count <> (
       select count(distinct nullif(btrim(path_value), ''))
       from unnest(requested_track_paths) as path_value
       where nullif(btrim(path_value), '') is not null
     )
     or resolved_album_count <> 1
     or resolved_album_id <> requested_album_id then
    return query select false, current_cover_mutation_revision,
      'identity_conflict'::text, null::bigint, null::bigint;
    return;
  end if;

  select nullif(album.metadata ->> 'cover_revision', '')
  into current_selected_revision
  from library.local_albums as album
  where album.id = requested_album_id
    and album.library_id = requested_library_id
  for update;

  if not found
     or current_selected_revision is distinct from expected_selected_cover_revision then
    return query select false, current_cover_mutation_revision,
      'selection_conflict'::text, null::bigint, null::bigint;
    return;
  end if;

  select (
    coalesce(album.metadata, '{}'::jsonb)
    - array[
      'cover_path', 'cover_revision', 'cover_selection_origin',
      'remote_cover_url', 'remote_cover_thumbnail_url',
      'remote_cover_source', 'remote_cover_source_label',
      'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
    ]::text[]
  ) || case
    when clear_selection then '{}'::jsonb
    when remote_cover is not null then jsonb_strip_nulls(
      remote_cover || jsonb_build_object(
        'cover_revision', promoted_cover_revision,
        'cover_selection_origin', selected_origin
      )
    )
    else jsonb_strip_nulls(jsonb_build_object(
      'cover_path', selected_cover_path,
      'cover_revision', promoted_cover_revision,
      'cover_selection_origin', selected_origin
    ))
  end
  into desired_album_metadata
  from library.local_albums as album
  where album.id = requested_album_id;

  update library.local_albums as album
  set cover_path = case
        when clear_selection or remote_cover is not null then null
        else selected_cover_path
      end,
      metadata = desired_album_metadata
  where album.id = requested_album_id
    and (album.cover_path, coalesce(album.metadata, '{}'::jsonb))
        is distinct from (
          case
            when clear_selection or remote_cover is not null then null
            else selected_cover_path
          end,
          desired_album_metadata
        );
  get diagnostics changed_album_count = row_count;

  update library.local_track_files as file
  set metadata = jsonb_set(
    coalesce(file.metadata, '{}'::jsonb) || jsonb_build_object(
      'scan_cache', coalesce(file.metadata -> 'scan_cache', '{}'::jsonb)
    ),
    '{scan_cache,file_entry}',
    (
      coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
      - array[
        'cover_path', 'cover_revision', 'cover_selection_origin',
        'remote_cover_url', 'remote_cover_thumbnail_url',
        'remote_cover_source', 'remote_cover_source_label',
        'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
      ]::text[]
    ) || case
      when clear_selection then '{}'::jsonb
      when remote_cover is not null then jsonb_strip_nulls(
        remote_cover || jsonb_build_object(
          'cover_revision', promoted_cover_revision,
          'cover_selection_origin', selected_origin
        )
      )
      else jsonb_strip_nulls(jsonb_build_object(
        'cover_path', selected_cover_path,
        'cover_revision', promoted_cover_revision,
        'cover_selection_origin', selected_origin
      ))
    end,
    true
  )
  from library.local_tracks as track
  where track.id = file.track_id
    and track.library_id = requested_library_id
    and track.album_id = requested_album_id
    and coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
        is distinct from (
          (
            coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
            - array[
              'cover_path', 'cover_revision', 'cover_selection_origin',
              'remote_cover_url', 'remote_cover_thumbnail_url',
              'remote_cover_source', 'remote_cover_source_label',
              'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
            ]::text[]
          ) || case
            when clear_selection then '{}'::jsonb
            when remote_cover is not null then jsonb_strip_nulls(
              remote_cover || jsonb_build_object(
                'cover_revision', promoted_cover_revision,
                'cover_selection_origin', selected_origin
              )
            )
            else jsonb_strip_nulls(jsonb_build_object(
              'cover_path', selected_cover_path,
              'cover_revision', promoted_cover_revision,
              'cover_selection_origin', selected_origin
            ))
          end
        );
  get diagnostics changed_file_count = row_count;

  if changed_album_count > 0 or changed_file_count > 0 then
    update library.cover_mutation_state as state
    set cover_mutation_revision = state.cover_mutation_revision + 1,
        updated_at = observed_at
    where state.library_id = requested_library_id
    returning state.cover_mutation_revision
    into current_cover_mutation_revision;
  end if;

  if requested_job_id is not null then
    update ops.cover_remote_save_checkpoints as checkpoint
    set checkpoint = 'authority_committed',
        cover_revision = promoted_cover_revision,
        authority_cover_mutation_revision = current_cover_mutation_revision,
        row_revision = checkpoint.row_revision + 1,
        updated_at = observed_at
    where checkpoint.job_id = requested_job_id
      and checkpoint.task_id = requested_task_id
      and checkpoint.row_revision = requested_checkpoint_revision
      and checkpoint.checkpoint = 'artifact_written'
      and checkpoint.artifact_sha256 = commit_cover_selection.artifact_sha256
    returning checkpoint.id, checkpoint.row_revision
    into committed_checkpoint_id, committed_checkpoint_revision;
    if committed_checkpoint_revision is null then
      raise exception 'cover finalization checkpoint changed before commit';
    end if;
  end if;

  return query select true, current_cover_mutation_revision,
    case
      when changed_album_count = 0 and changed_file_count = 0 then 'no_change'
      else 'committed'
    end,
    committed_checkpoint_id,
    committed_checkpoint_revision;
end;
$function$;

create or replace function library.recover_cover_mutation(
  requested_library_id bigint,
  requested_album_id bigint,
  expected_inventory_revision bigint,
  expected_cover_mutation_revision bigint,
  expected_selected_cover_revision text,
  promoted_cover_revision text,
  artifact_sha256 text,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  requested_task_id bigint,
  requested_checkpoint_revision bigint,
  observed_at timestamptz
)
returns table (
  recovery_action text,
  cover_mutation_revision bigint,
  selected_cover_revision text,
  finalization_checkpoint_id bigint,
  finalization_checkpoint_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog, library, ops
as $function$
declare
  current_inventory_revision bigint;
  current_cover_mutation_revision bigint;
  current_selected_cover_revision text;
  current_checkpoint_id bigint;
  current_checkpoint_revision bigint;
  current_checkpoint text;
  checkpoint_cover_revision text;
  checkpoint_authority_revision bigint;
begin
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  if artifact_sha256 is null or artifact_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'recovery requires artifact SHA-256';
  end if;

  select
    coalesce(nullif(library_row.metadata ->> 'inventory_mutation_revision', '')::bigint, 0),
    state.cover_mutation_revision,
    nullif(album.metadata ->> 'cover_revision', '')
  into current_inventory_revision,
       current_cover_mutation_revision,
       current_selected_cover_revision
  from library.libraries as library_row
  join library.cover_mutation_state as state on state.library_id = library_row.id
  join library.local_albums as album
    on album.library_id = library_row.id
   and album.id = requested_album_id
  where library_row.id = requested_library_id
  for update of library_row, state, album;
  if not found then
    return query select 'ambiguous'::text, null::bigint, null::text,
      null::bigint, null::bigint;
    return;
  end if;

  select checkpoint.id,
         checkpoint.row_revision,
         checkpoint.checkpoint,
         checkpoint.cover_revision,
         checkpoint.authority_cover_mutation_revision
  into current_checkpoint_id,
       current_checkpoint_revision,
       current_checkpoint,
       checkpoint_cover_revision,
       checkpoint_authority_revision
  from ops.jobs as job
  join ops.cover_remote_save_checkpoints as checkpoint
    on checkpoint.job_id = job.id
   and checkpoint.task_id = requested_task_id
   and checkpoint.artifact_sha256 = recover_cover_mutation.artifact_sha256
  join ops.cover_lookup_tasks as task
    on task.id = checkpoint.task_id
   and task.library_id = requested_library_id
   and task.local_album_id = requested_album_id
  where job.id = requested_job_id
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and checkpoint.row_revision >= requested_checkpoint_revision
  order by checkpoint.row_revision desc
  limit 1
  for update of job, checkpoint, task;

  if found
     and current_checkpoint in (
       'authority_committed', 'runtime_published', 'publication_completed'
     )
     and checkpoint_cover_revision = promoted_cover_revision
     and checkpoint_authority_revision is not null then
    return query select 'committed'::text,
      checkpoint_authority_revision,
      checkpoint_cover_revision,
      current_checkpoint_id,
      current_checkpoint_revision;
    return;
  end if;

  if found
     and current_inventory_revision = expected_inventory_revision
     and current_cover_mutation_revision = expected_cover_mutation_revision
     and current_selected_cover_revision is not distinct from expected_selected_cover_revision
     and current_checkpoint = 'artifact_written' then
    return query select 'compensate'::text,
      current_cover_mutation_revision,
      current_selected_cover_revision,
      current_checkpoint_id,
      current_checkpoint_revision;
    return;
  end if;

  return query select 'ambiguous'::text,
    current_cover_mutation_revision,
    current_selected_cover_revision,
    current_checkpoint_id,
    current_checkpoint_revision;
end;
$function$;

create or replace function library.resolve_cover_mutation_identity(
  requested_library_id bigint,
  requested_track_paths text[]
)
returns table (library_id bigint, local_album_id bigint)
language sql
stable
security definer
set search_path = pg_catalog, library
as $function$
  with input_paths as materialized (
    select distinct nullif(btrim(path_value), '') as private_path
    from unnest(requested_track_paths) as path_value
    where nullif(btrim(path_value), '') is not null
  ), resolved as materialized (
    select file.id as file_id, track.album_id
    from input_paths
    join library.local_track_files as file
      on file.private_path = input_paths.private_path
    join library.local_tracks as track
      on track.id = file.track_id
     and track.library_id = requested_library_id
    join library.library_roots as root
      on root.id = file.library_root_id
     and root.library_id = requested_library_id
     and root.is_active is true
    join library.local_albums as album
      on album.id = track.album_id
     and album.library_id = requested_library_id
  ), summary as (
    select
      (select count(*) from input_paths) as input_count,
      count(*) as resolved_count,
      count(distinct resolved.album_id) as album_count,
      min(resolved.album_id) as album_id
    from resolved
  )
  select requested_library_id, summary.album_id
  from summary
  where summary.input_count > 0
    and summary.resolved_count = summary.input_count
    and summary.album_count = 1;
$function$;

alter table library.full_scan_intents
  add column if not exists captured_cover_mutation_revision bigint
  check (
    captured_cover_mutation_revision is null
    or captured_cover_mutation_revision >= 0
  );

alter table library.targeted_reconciliation_intents
  add column if not exists captured_cover_mutation_revision bigint
  check (
    captured_cover_mutation_revision is null
    or captured_cover_mutation_revision >= 0
  );

update library.full_scan_intents as intent
set captured_cover_mutation_revision = state.cover_mutation_revision
from library.cover_mutation_state as state
where state.library_id = intent.library_id
  and intent.state in ('accepted', 'running', 'retry_wait')
  and intent.captured_cover_mutation_revision is null;

update library.targeted_reconciliation_intents as intent
set captured_cover_mutation_revision = state.cover_mutation_revision
from library.cover_mutation_state as state
where state.library_id = intent.library_id
  and intent.state in ('accepted', 'running', 'retry_wait')
  and intent.captured_cover_mutation_revision is null;

-- Mixed-version writers cannot know the new column. Populate it at the table
-- boundary in the inserting transaction, so every direct and nested creator is
-- covered without widening its public signature during the drain window.
create or replace function library.capture_scan_intent_cover_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, library
as $function$
begin
  if new.captured_cover_mutation_revision is null then
    insert into library.cover_mutation_state (library_id)
    values (new.library_id)
    on conflict (library_id) do nothing;

    select state.cover_mutation_revision
    into new.captured_cover_mutation_revision
    from library.cover_mutation_state as state
    where state.library_id = new.library_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists full_scan_intents_capture_cover_revision
  on library.full_scan_intents;
create trigger full_scan_intents_capture_cover_revision
before insert on library.full_scan_intents
for each row execute function library.capture_scan_intent_cover_revision();

drop trigger if exists targeted_reconciliation_intents_capture_cover_revision
  on library.targeted_reconciliation_intents;
create trigger targeted_reconciliation_intents_capture_cover_revision
before insert on library.targeted_reconciliation_intents
for each row execute function library.capture_scan_intent_cover_revision();








drop function if exists library.load_claimed_full_scan_intent_v3(
  bigint, character varying, character varying
);
create or replace function library.load_claimed_full_scan_intent_v3(
  p_job_id bigint,
  p_worker_id varchar,
  p_lease_token varchar
)
returns table (
  intent_id bigint,
  library_id bigint,
  initiating_account_id bigint,
  mode varchar,
  force boolean,
  logical_root_ids text[],
  inventory_mutation_revision bigint,
  committed_inventory_revision bigint,
  watcher_repair_id bigint,
  captured_cover_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_intent_id bigint;
  v_library_id bigint;
  v_attempt integer;
  v_repair_id bigint;
  v_repair_scanning boolean;
  v_captured_revision bigint;
begin
  select job.library_id
  into v_library_id
  from ops.jobs as job
  where job.id = p_job_id
    and job.kind = 'full_scan';
  if v_library_id is null then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:watcher:' || v_library_id::text, 0
    )
  );

  select intent.id, intent.library_id, job.attempt_count,
         intent.watcher_repair_id
  into v_intent_id, v_library_id, v_attempt, v_repair_id
  from ops.jobs as job
  join library.full_scan_intents as intent on intent.job_id = job.id
  where job.id = p_job_id
    and job.kind = 'full_scan'
    and job.subject_kind = 'full_scan_intent'
    and job.subject_ref = intent.id::text
    and job.library_id = intent.library_id
    and job.state = 'running'
    and intent.state = 'running'
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of job, intent;
  if v_intent_id is null then
    return;
  end if;

  if v_repair_id is not null then
    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = v_library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;

    select repair.state = 'scanning'
    into v_repair_scanning
    from library.watcher_repairs as repair
    where repair.id = v_repair_id
      and repair.library_id = v_library_id;

    if coalesce(v_repair_scanning, false) then
      perform 1
      from library.watcher_lanes as lane
      join library.full_scan_intent_roots as intent_root
        on intent_root.intent_id = v_intent_id
       and intent_root.root_id = lane.root_id
      where lane.library_id = v_library_id
      order by lane.library_id, lane.root_id
      for update of lane;

      perform 1
      from ops.jobs as job
      join library.full_scan_intents as intent on intent.job_id = job.id
      join library.watcher_repairs as repair
        on repair.id = intent.watcher_repair_id
       and repair.library_id = intent.library_id
       and repair.state = 'scanning'
      where job.id = p_job_id
        and intent.id = v_intent_id
        and job.kind = 'full_scan'
        and job.subject_kind = 'full_scan_intent'
        and job.subject_ref = intent.id::text
        and job.library_id = intent.library_id
        and job.state = 'running'
        and intent.state = 'running'
        and job.attempt_count = v_attempt
        and job.lease_owner = p_worker_id
        and job.lease_token = p_lease_token
        and job.lease_expires_at > pg_catalog.clock_timestamp();
      if not found then
        return;
      end if;

      if exists (
        select 1
        from library.full_scan_intent_roots as intent_root
        join library.watcher_lanes as lane
          on lane.library_id = v_library_id
         and lane.root_id = intent_root.root_id
        where intent_root.intent_id = v_intent_id
          and (lane.running_generation_id is not null
               or lane.running_job_id is not null)
      ) then
        return;
      end if;
    end if;
  end if;

  select coalesce(nullif(
           library_record.metadata ->> 'inventory_mutation_revision', ''
         )::bigint, 0)
  into v_captured_revision
  from library.libraries as library_record
  where library_record.id = v_library_id;

  update library.full_scan_intents as intent
  set execution_attempt = v_attempt,
      captured_inventory_revision = v_captured_revision,
      progress_current = case
        when intent.execution_attempt is distinct from v_attempt
        then 0 else intent.progress_current end,
      progress_total = case
        when intent.execution_attempt is distinct from v_attempt
        then 0 else intent.progress_total end,
      progress_phase = case
        when intent.execution_attempt is distinct from v_attempt
        then 'preparing' else intent.progress_phase end,
      current_path = case
        when intent.execution_attempt is distinct from v_attempt
        then null else intent.current_path end,
      updated_at = greatest(intent.updated_at, pg_catalog.now())
  where intent.id = v_intent_id
    and intent.committed_inventory_revision is null
    and (
      intent.execution_attempt is distinct from v_attempt
      or intent.captured_inventory_revision is null
    );

  return query
  select intent.id,
         intent.library_id,
         intent.initiating_account_id,
         intent.mode,
         intent.force,
         pg_catalog.array_agg(
           root_record.metadata ->> 'root_id' order by intent_root.ordinal
         ),
         intent.captured_inventory_revision,
         intent.committed_inventory_revision,
         intent.watcher_repair_id,
    intent.captured_cover_mutation_revision
  from library.full_scan_intents as intent
  join library.full_scan_intent_roots as intent_root
    on intent_root.intent_id = intent.id
  join library.library_roots as root_record
    on root_record.id = intent_root.root_id
  where intent.id = v_intent_id
    and (
      intent.execution_attempt = v_attempt
      or intent.committed_inventory_revision is not null
    )
    and intent.captured_inventory_revision is not null
    and intent.captured_cover_mutation_revision is not null
  group by intent.id;
end;
$$;

drop function if exists library.load_claimed_targeted_reconciliation_intent_v2(
  bigint, character varying, character varying
);
create or replace function library.load_claimed_targeted_reconciliation_intent_v2(
  p_job_id bigint,
  p_worker_id varchar,
  p_lease_token varchar
)
returns table (
  intent_id bigint,
  library_id bigint,
  logical_root_id text,
  active_paths text[],
  deleted_paths text[],
  deleted_subtrees text[],
  preserved_subtrees text[],
  moves jsonb,
  exception_overrides jsonb,
  watcher_generation_kind varchar,
  captured_cover_mutation_revision bigint
)
language sql
security definer
set search_path = pg_catalog
as $$
  with legacy as materialized (
    select *
    from library.load_claimed_targeted_reconciliation_intent_legacy_0107(
      p_job_id, p_worker_id, p_lease_token
    )
  ), claimed as materialized (
    select intent.id, intent.library_id, intent.primary_root_id,
           intent.watcher_generation_kind,
           intent.captured_cover_mutation_revision
    from ops.jobs as job
    join library.targeted_reconciliation_intents as intent
      on intent.job_id = job.id
    where job.id = p_job_id
      and job.kind = 'targeted_reconciliation'
      and job.state = 'running'
      and job.lease_owner = p_worker_id
      and job.lease_token = p_lease_token
      and job.lease_expires_at > pg_catalog.clock_timestamp()
      and intent.captured_cover_mutation_revision is not null
  )
  select legacy.intent_id, legacy.library_id,
         case when claimed.watcher_generation_kind is null
           then legacy.logical_root_id
           else primary_root.metadata ->> 'root_id'
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.active_paths
           when claimed.watcher_generation_kind = 'root_catch_up' then coalesce((
             select pg_catalog.array_agg(root.root_path order by participant.root_id)
             from library.watcher_generation_participants as participant
             join library.library_roots as root
               on root.library_id = participant.library_id
              and root.id = participant.root_id
              and root.is_active is true
             where participant.generation_id = claimed.id
           ), array[]::text[])
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'active'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.deleted_paths
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'deleted'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.deleted_subtrees
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'deleted_subtree'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.preserved_subtrees
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'preserved_subtree'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.moves
           else coalesce((
             select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'source_path', source_root.root_path
                 || case library.local_path_style(source_root.root_path)
                      when 'windows' then E'\\' else '/' end
                 || move.source_relative_path,
               'destination_path', destination_root.root_path
                 || case library.local_path_style(destination_root.root_path)
                      when 'windows' then E'\\' else '/' end
                 || move.destination_relative_path,
               'source_root_ref', source_root.metadata ->> 'root_id',
               'destination_root_ref', destination_root.metadata ->> 'root_id',
               'is_directory', move.is_directory
             ) order by move.ordinal)
             from library.targeted_reconciliation_intent_moves as move
             join library.library_roots as source_root
               on source_root.library_id = move.library_id
              and source_root.id = move.source_root_id
              and source_root.is_active is true
             join library.library_roots as destination_root
               on destination_root.library_id = move.library_id
              and destination_root.id = move.destination_root_id
              and destination_root.is_active is true
             where move.intent_id = claimed.id
               and move.source_relative_path is not null
               and move.destination_relative_path is not null
           ), '[]'::jsonb)
         end,
         legacy.exception_overrides,
         claimed.watcher_generation_kind,
    claimed.captured_cover_mutation_revision
  from legacy
  join claimed on claimed.id = legacy.intent_id
  join library.library_roots as primary_root
    on primary_root.library_id = claimed.library_id
   and primary_root.id = claimed.primary_root_id;
$$;

alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_checkpoint_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_checkpoint_check check (checkpoint in (
    'accepted', 'download_started', 'artifact_written', 'selection_committed',
    'promotion_completed', 'authority_committed', 'runtime_published',
    'publication_completed', 'rolled_back', 'ambiguous'
  ));

alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_terminal_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_terminal_check check (
    (
      checkpoint in ('publication_completed', 'rolled_back', 'ambiguous')
      and completed_at is not null
    ) or (
      checkpoint not in ('publication_completed', 'rolled_back', 'ambiguous')
      and completed_at is null
    )
  );

alter table ops.cover_remote_save_checkpoints
  add column if not exists artifact_sha256 varchar(64);
alter table ops.cover_remote_save_checkpoints
  add column if not exists authority_cover_mutation_revision bigint;
alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_authority_revision_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_authority_revision_check check (
    authority_cover_mutation_revision is null
    or authority_cover_mutation_revision >= 0
  );
alter table ops.cover_remote_save_checkpoints
  drop constraint if exists cover_remote_save_artifact_sha256_check;
alter table ops.cover_remote_save_checkpoints
  add constraint cover_remote_save_artifact_sha256_check check (
    artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$'
  );

alter table ops.jobs drop constraint if exists jobs_kind_attempts_check;
alter table ops.jobs add constraint jobs_kind_attempts_check check (
  (kind = 'full_scan' and max_attempts = 2) or
  (kind = 'targeted_reconciliation' and max_attempts = 3) or
  (kind = 'post_scan_cover_refresh' and max_attempts = 2) or
  (kind = 'cover_lookup' and max_attempts = 2) or
  (kind = 'cover_bulk_refresh' and max_attempts = 2) or
  (kind = 'cover_remote_save' and max_attempts >= 1) or
  (kind = 'lastfm_scrobble_retry' and max_attempts = 1) or
  (kind = 'auth_welcome_delivery' and max_attempts = 3) or
  (kind = 'auth_invitation_delivery' and max_attempts = 1) or
  (kind = 'auth_password_reset_delivery' and max_attempts = 1)
);

create or replace function ops.checkpoint_claimed_cover_remote_save(
  requested_checkpoint_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_row_revision bigint,
  next_checkpoint text,
  next_artifact_key uuid,
  next_artifact_sha256 text,
  next_cover_revision text,
  next_reason_code text
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  checkpoint_row ops.cover_remote_save_checkpoints%rowtype;
  next_revision bigint;
begin
  if next_artifact_sha256 is not null
     and next_artifact_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid artifact SHA-256' using errcode = '22023';
  end if;

  select checkpoint.* into checkpoint_row
  from ops.cover_remote_save_checkpoints as checkpoint
  join ops.jobs as job on job.id = checkpoint.job_id
  where checkpoint.id = requested_checkpoint_id
    and checkpoint.job_id = requested_job_id
    and checkpoint.row_revision = expected_row_revision
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of checkpoint, job;
  if not found then
    return null;
  end if;

  if next_checkpoint in ('authority_committed', 'runtime_published', 'publication_completed')
     and coalesce(next_artifact_sha256, checkpoint_row.artifact_sha256) is null
     and not (
       next_checkpoint = 'publication_completed'
       and checkpoint_row.checkpoint in ('promotion_completed', 'publication_completed')
     ) then
    return null;
  end if;
  if checkpoint_row.checkpoint = next_checkpoint then
    return checkpoint_row.row_revision;
  end if;
  if (checkpoint_row.checkpoint, next_checkpoint) not in (
    ('accepted', 'download_started'),
    ('accepted', 'artifact_written'),
    ('download_started', 'artifact_written'),
    ('artifact_written', 'selection_committed'),
    ('selection_committed', 'promotion_completed'),
    ('promotion_completed', 'publication_completed'),
    ('artifact_written', 'authority_committed'),
    ('authority_committed', 'runtime_published'),
    ('runtime_published', 'publication_completed')
  ) then
    return null;
  end if;

  update ops.cover_remote_save_checkpoints as checkpoint
  set checkpoint = next_checkpoint,
      artifact_key = coalesce(next_artifact_key, checkpoint.artifact_key),
      artifact_sha256 = coalesce(next_artifact_sha256, checkpoint.artifact_sha256),
      cover_revision = coalesce(next_cover_revision, checkpoint.cover_revision),
      reason_code = left(nullif(next_reason_code, ''), 128),
      row_revision = checkpoint.row_revision + 1,
      updated_at = observed_at,
      completed_at = case
        when next_checkpoint = 'publication_completed' then observed_at
        else null
      end
  where checkpoint.id = requested_checkpoint_id
    and checkpoint.row_revision = expected_row_revision
  returning checkpoint.row_revision into next_revision;
  return next_revision;
end;
$function$;

create or replace function library.apply_scanned_cover_observations(
  requested_library_id bigint,
  captured_cover_mutation_revision bigint,
  observed_covers jsonb,
  observed_at timestamptz
)
returns table (
  cover_publication_stale boolean,
  cover_mutation_revision bigint,
  changed_album_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, library
as $function$
declare
  current_revision bigint;
  changed_count integer;
  changed_file_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));

  insert into library.cover_mutation_state (library_id)
  values (requested_library_id)
  on conflict (library_id) do nothing;

  select state.cover_mutation_revision
  into current_revision
  from library.cover_mutation_state as state
  where state.library_id = requested_library_id
  for update;

  if current_revision is distinct from captured_cover_mutation_revision then
    return query select true, current_revision, 0;
    return;
  end if;

  if jsonb_typeof(coalesce(observed_covers, '[]'::jsonb)) <> 'array' then
    raise exception 'observed covers must be a JSON array';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    where item.album_id is null
       or coalesce(cardinality(item.track_paths), 0) = 0
       or jsonb_typeof(coalesce(item.cover_state, '{}'::jsonb)) <> 'object'
       or (
         coalesce(item.cover_state, '{}'::jsonb) ? 'cover_path'
         and nullif(item.cover_state ->> 'cover_path', '')
             is distinct from nullif(item.cover_path, '')
       )
       or coalesce(item.cover_state, '{}'::jsonb) - array[
         'cover_path', 'cover_revision', 'cover_selection_origin',
         'remote_cover_url', 'remote_cover_thumbnail_url',
         'remote_cover_source', 'remote_cover_source_label',
         'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
       ]::text[] <> '{}'::jsonb
  ) then
    raise exception 'observed cover contains an invalid shape or unsupported key';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    group by item.album_id
    having count(*) <> 1
  ) or exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    cross join lateral unnest(item.track_paths) as path_value
    group by path_value
    having count(*) <> 1
  ) then
    raise exception 'observed cover identities must be unique';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint, cover_path text, cover_state jsonb, track_paths text[]
    )
    cross join lateral unnest(item.track_paths) as path_value
    where nullif(btrim(path_value), '') is null
       or (
         select count(*)
         from library.local_track_files as file
         join library.local_tracks as track on track.id = file.track_id
         join library.library_roots as root on root.id = file.library_root_id
         where file.private_path = path_value
           and track.library_id = requested_library_id
           and track.album_id = item.album_id
           and root.library_id = requested_library_id
           and root.is_active is true
       ) <> 1
  ) then
    raise exception 'observed cover identity does not belong to requested library and album';
  end if;

  with observations as materialized (
    select
      item.album_id,
      item.cover_path,
      coalesce(item.cover_state, '{}'::jsonb) as cover_state,
      item.track_paths
    from jsonb_to_recordset(coalesce(observed_covers, '[]'::jsonb)) as item(
      album_id bigint,
      cover_path text,
      cover_state jsonb,
      track_paths text[]
    )
  ), desired as materialized (
    select
      observation.album_id,
      observation.cover_path,
      observation.track_paths,
      (
        coalesce(album.metadata, '{}'::jsonb)
        - array[
          'cover_path', 'cover_revision', 'cover_selection_origin',
          'remote_cover_url', 'remote_cover_thumbnail_url',
          'remote_cover_source', 'remote_cover_source_label',
          'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
        ]::text[]
      )
      || (observation.cover_state - 'cover_path')
      || jsonb_strip_nulls(jsonb_build_object(
        'cover_path', observation.cover_path
      )) as album_metadata
    from observations as observation
    join library.local_albums as album
      on album.id = observation.album_id
     and album.library_id = requested_library_id
  ), changed_albums as (
    update library.local_albums as album
    set cover_path = desired.cover_path,
        metadata = desired.album_metadata
    from desired
    where album.id = desired.album_id
      and (album.cover_path, coalesce(album.metadata, '{}'::jsonb))
          is distinct from (desired.cover_path, desired.album_metadata)
    returning album.id
  ), changed_files as (
    update library.local_track_files as file
    set metadata = jsonb_set(
      coalesce(file.metadata, '{}'::jsonb) || jsonb_build_object(
        'scan_cache', coalesce(file.metadata -> 'scan_cache', '{}'::jsonb)
      ),
      '{scan_cache,file_entry}',
      (
        coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
        - array[
          'cover_path', 'cover_revision', 'cover_selection_origin',
          'remote_cover_url', 'remote_cover_thumbnail_url',
          'remote_cover_source', 'remote_cover_source_label',
          'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
        ]::text[]
      ) || jsonb_strip_nulls(coalesce((
        select jsonb_object_agg(entry.key, entry.value)
        from jsonb_each(desired.album_metadata) as entry(key, value)
        where entry.key = any(array[
          'cover_path', 'cover_revision', 'cover_selection_origin',
          'remote_cover_url', 'remote_cover_thumbnail_url',
          'remote_cover_source', 'remote_cover_source_label',
          'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
        ]::text[])
      ), '{}'::jsonb)),
      true
    )
    from desired
    join library.local_tracks as track
      on track.library_id = requested_library_id
     and track.album_id = desired.album_id
    join library.library_roots as root
      on root.library_id = requested_library_id
     and root.is_active is true
    where file.track_id = track.id
      and file.library_root_id = root.id
      and file.private_path = any(desired.track_paths)
      and coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
          is distinct from (
            (
              coalesce(file.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
              - array[
                'cover_path', 'cover_revision', 'cover_selection_origin',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
              ]::text[]
            ) || jsonb_strip_nulls(coalesce((
              select jsonb_object_agg(entry.key, entry.value)
              from jsonb_each(desired.album_metadata) as entry(key, value)
              where entry.key = any(array[
                'cover_path', 'cover_revision', 'cover_selection_origin',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
              ]::text[])
            ), '{}'::jsonb))
          )
    returning file.id
  )
  select
    (select count(*)::integer from changed_albums),
    (select count(*)::integer from changed_files)
  into changed_count, changed_file_count;

  if changed_count > 0 or changed_file_count > 0 then
    update library.cover_mutation_state as state
    set cover_mutation_revision = state.cover_mutation_revision + 1,
        updated_at = observed_at
    where state.library_id = requested_library_id
    returning state.cover_mutation_revision into current_revision;
  end if;

  return query select false, current_revision, changed_count;
end;
$function$;

create or replace function library.persist_authorized_structural_tag_edit_noncover(
  bigint,
  text[],
  bigint,
  jsonb,
  jsonb,
  text[],
  timestamptz
)
returns table (
  input_path_count bigint,
  resolved_path_count bigint,
  source_album_track_file_count bigint,
  source_album_count bigint,
  destination_conflict_count bigint,
  destination_album_count bigint,
  album_rows_updated bigint,
  track_rows_updated bigint,
  track_file_rows_updated bigint,
  destination_album_id bigint,
  source_album_id bigint,
  source_library_id bigint,
  source_album_key text,
  destination_album_key text,
  separate_release_key text,
  inserted_destination_album boolean,
  inventory_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog, library, app
as $function$
declare
  requested_library_id alias for $1;
  requested_track_paths alias for $2;
  expected_inventory_revision alias for $3;
  input_rows alias for $4;
  destination_state alias for $5;
  changed_field_names alias for $6;
  observed_at alias for $7;
  current_inventory_revision bigint;
  updated_albums bigint;
  mutation_result record;
  forbidden_cover_fields constant text[] := array[
    'cover_path', 'cover_revision', 'cover_selection_origin',
    'local_cover_width', 'local_cover_height', 'cover_validation_path',
    'cover_validation_mtime_ns', 'cover_validation_size',
    'remote_cover_url', 'remote_cover_thumbnail_url',
    'remote_cover_source', 'remote_cover_source_label',
    'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height'
  ];
  allowed_file_entry_keys constant text[] := array[
    'album', 'year', 'release_date', 'exception_type', 'mtime', 'size'
  ];
  allowed_artist_metadata_keys constant text[] := array[
    'album_artist', 'artists', 'is_compilation', 'featured_artists'
  ];
  allowed_destination_keys constant text[] := array[
    'destination_album_key', 'destination_artist_key',
    'destination_artist_name', 'destination_artist_metadata',
    'destination_album_title', 'destination_release_year',
    'destination_release_date', 'destination_edition',
    'destination_separate_release_key', 'destination_is_explicit_separate',
    'updates_release_year', 'source'
  ];
begin
  if requested_library_id is null
     or expected_inventory_revision is null
     or observed_at is null
     or coalesce(cardinality(requested_track_paths), 0) = 0
     or jsonb_typeof(input_rows) is distinct from 'array'
     or jsonb_typeof(destination_state) is distinct from 'object'
     or destination_state - allowed_destination_keys <> '{}'::jsonb then
    raise exception 'structural tag edit input is invalid' using errcode = '22023';
  end if;
  if coalesce(cardinality(changed_field_names), 0) = 0
     or not (changed_field_names <@ array['album','year','exception_type']::text[])
     or array_position(changed_field_names, null) is not null
     or changed_field_names && forbidden_cover_fields
     or jsonb_typeof(destination_state -> 'destination_artist_metadata')
        is distinct from 'object'
     or (destination_state -> 'destination_artist_metadata')
        - allowed_artist_metadata_keys <> '{}'::jsonb
     or exists (
       select 1 from jsonb_array_elements(input_rows) as item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or item.value - array['private_path','file_entry'] <> '{}'::jsonb
          or jsonb_typeof(item.value -> 'private_path') is distinct from 'string'
          or nullif(btrim(item.value ->> 'private_path'), '') is null
          or jsonb_typeof(item.value -> 'file_entry') is distinct from 'object'
          or (item.value -> 'file_entry') - allowed_file_entry_keys <> '{}'::jsonb
          or not ((item.value ->> 'private_path') = any(requested_track_paths))
     ) then
    raise exception 'structural tag edit requires closed noncover metadata objects' using errcode = '22023';
  end if;
  if jsonb_array_length(input_rows) <> cardinality(requested_track_paths)
     or (select count(distinct path) from unnest(requested_track_paths) as path)
        <> cardinality(requested_track_paths)
     or (select count(distinct item.value ->> 'private_path')
         from jsonb_array_elements(input_rows) as item(value))
        <> cardinality(requested_track_paths) then
    raise exception 'structural tag edit requires each requested path exactly once' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));
  select coalesce(
    nullif(library_row.metadata ->> 'inventory_mutation_revision', '')::bigint,
    0
  )
  into current_inventory_revision
  from library.libraries as library_row
  where library_row.id = requested_library_id
  for update;
  if not found or current_inventory_revision <> expected_inventory_revision then
    raise exception 'structural tag edit inventory revision conflict'
      using errcode = '40001';
  end if;

  if coalesce((destination_state ->> 'updates_release_year')::boolean, false) then
with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from library.libraries
          where library.libraries.id = requested_library_id
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(requested_track_paths::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(input_rows::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
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
          where coalesce(
            (
              library.local_track_files.metadata
                #>> '{scan_cache,stale}'
            )::boolean,
            false
          ) is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.source_album_id) as source_album_count,
            min(selected_track_files.source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id as track_file_id
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = selection_scope.source_album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and coalesce(
                 (
                   library.local_track_files.metadata
                     #>> '{scan_cache,stale}'
                 )::boolean,
                 false
               ) is false
        ),
        source_album_identity as materialized (
          select
            library.local_albums.id,
            library.local_albums.artist_id,
            library.local_albums.release_year
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.id = selection_scope.source_album_id
        ),
        locked_album_scope as materialized (
          select
            library.local_albums.id,
            library.local_albums.library_id,
            library.local_albums.album_key,
            library.local_albums.artist_id,
            library.local_albums.title,
            library.local_albums.release_year,
            library.local_albums.cover_path,
            library.local_albums.metadata
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join source_album_identity on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and (
                 library.local_albums.id = selection_scope.source_album_id
                 or library.local_albums.album_key = (destination_state ->> 'destination_album_key')
                 or (
                      library.local_albums.artist_id is not distinct from
                        source_album_identity.artist_id
                      and lower(btrim(library.local_albums.title)) =
                        lower(btrim((destination_state ->> 'destination_album_title')))
                      and library.local_albums.release_year is not distinct from
                        case
                          when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                          then nullif(destination_state ->> 'destination_release_year', '')::integer
                          else source_album_identity.release_year
                        end
                      and lower(
                            btrim(
                              coalesce(
                                library.local_albums.metadata ->> 'edition',
                                ''
                              )
                            )
                          ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                    )
               )
          order by library.local_albums.id
          for update of local_albums
        ),
        existing_destination_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.album_key
          from locked_album_scope
          join selection_scope on true
          where locked_album_scope.id <> selection_scope.source_album_id
            and not (
                  coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                  and (select selection_scope.input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
            and (
                  locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
                  or (
                       locked_album_scope.artist_id is not distinct from
                         (select artist_id from source_album_identity)
                       and lower(btrim(locked_album_scope.title)) =
                         lower(btrim((destination_state ->> 'destination_album_title')))
                       and locked_album_scope.release_year is not distinct from
                         case
                           when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                           then nullif(destination_state ->> 'destination_release_year', '')::integer
                           else (
                             select release_year
                             from source_album_identity
                           )
                         end
                       and lower(
                             btrim(
                               coalesce(
                                 locked_album_scope.metadata ->> 'edition',
                                 ''
                               )
                             )
                           ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                     )
                )
          order by
            case
              when locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
              then 0
              else 1
            end,
            locked_album_scope.id
          limit 1
        ),
        validated_source_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.library_id,
            locked_album_scope.album_key,
            locked_album_scope.artist_id,
            locked_album_scope.release_year,
            locked_album_scope.cover_path,
            (
              coalesce(locked_album_scope.metadata, '{}'::jsonb)
              - array[
                'cover_path', 'cover_revision', 'cover_selection_origin',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width',
                'remote_cover_height'
              ]::text[]
            ) as metadata,
            exists (
              select 1
              from source_album_track_files
              join library.local_track_files
                on library.local_track_files.id =
                   source_album_track_files.track_file_id
              where locked_album_scope.release_year is not null
                and library.local_track_files.metadata
                      #>> '{scan_cache,file_entry,year}' ~ '^[+-]?[0-9]+$'
                and (
                      library.local_track_files.metadata
                        #>> '{scan_cache,file_entry,year}'
                    )::bigint <> locked_album_scope.release_year
            ) as has_display_year_override
          from selection_scope
          join locked_album_scope
            on locked_album_scope.id = selection_scope.source_album_id
          where selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.source_album_count = 1
            and selection_scope.input_path_count <= (
                  select count(*) from source_album_track_files
                )
        ),
        marked_partial_source_album as (
          update library.local_albums
          set metadata = jsonb_set(
                coalesce(library.local_albums.metadata, '{}'::jsonb),
                '{release_date}',
                to_jsonb(coalesce(
                  nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                  validated_source_album.release_year::text
                )),
                true
              )
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and validated_source_album.has_display_year_override
            and (select selection_scope.input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
          returning library.local_albums.id
        ),
        normalized_existing_destination_album as (
          update library.local_albums
          set release_year = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                 and nullif(btrim(library.local_albums.metadata ->> 'release_date'), '') is null
                then validated_source_album.release_year
                else library.local_albums.release_year
              end,
              metadata = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                then jsonb_set(
                       coalesce(library.local_albums.metadata, '{}'::jsonb),
                       '{release_date}',
                       to_jsonb(coalesce(
                         nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                         nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                         validated_source_album.release_year::text
                       )),
                       true
                     )
                else library.local_albums.metadata
              end,
              last_seen_at = observed_at
          from validated_source_album
          join existing_destination_album on true
          where library.local_albums.id = existing_destination_album.id
          returning library.local_albums.id, library.local_albums.album_key
        ),
        updated_album_ratings as (
          update app.album_ratings
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                 and (select selection_scope.input_path_count from selection_scope) = (
                       select count(*) from source_album_track_files
                     )
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              updated_at = observed_at
          from validated_source_album
          where app.album_ratings.library_id = validated_source_album.library_id
            and app.album_ratings.album_key = validated_source_album.album_key
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning app.album_ratings.id
        ),
        renamed_source_album as (
          update library.local_albums
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              title = (destination_state ->> 'destination_album_title'),
              release_year = case
                when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                then nullif(destination_state ->> 'destination_release_year', '')::integer
                else library.local_albums.release_year
              end
        
              , metadata = case
                  when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb((destination_state ->> 'destination_release_date')::text),
                         true
                       )
                  when validated_source_album.has_display_year_override
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb(coalesce(
                           nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                           validated_source_album.release_year::text
                         )),
                         true
                       )
                  else library.local_albums.metadata
                end
        ,
              last_seen_at = observed_at
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        inserted_destination_artist as (
          insert into library.local_artists (
            library_id, artist_key, name, sort_name, metadata
          )
          select validated_source_album.library_id,
                 (destination_state ->> 'destination_artist_key'), (destination_state ->> 'destination_artist_name'),
                 lower((destination_state ->> 'destination_artist_name')),
                 jsonb_build_object('source', (destination_state ->> 'source')::text)
          from validated_source_album
          where (select selection_scope.input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          on conflict (library_id, artist_key) do update
            set last_seen_at = observed_at
          returning library.local_artists.id
        ),
        inserted_destination_album as (
          insert into library.local_albums (
            library_id,
            artist_id,
            album_key,
            title,
            release_year,
            metadata
          )
          select
            validated_source_album.library_id,
            (select id from inserted_destination_artist),
            (destination_state ->> 'destination_album_key'),
            (destination_state ->> 'destination_album_title'),
            case
              when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
              then nullif(destination_state ->> 'destination_release_year', '')::integer
              else validated_source_album.release_year
            end,
        (
            validated_source_album.metadata
              || jsonb_build_object(
                   'release_date',
                   (destination_state ->> 'destination_release_date')::text
                 )
        ) || coalesce(destination_state -> 'destination_artist_metadata', '{}'::jsonb)::jsonb
          from validated_source_album
          where (select selection_scope.input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        destination_album as materialized (
          select
            normalized_existing_destination_album.id,
            normalized_existing_destination_album.album_key
          from normalized_existing_destination_album
          where exists (select 1 from validated_source_album)
          union all
          select
            renamed_source_album.id,
            renamed_source_album.album_key
          from renamed_source_album
          union all
          select
            inserted_destination_album.id,
            inserted_destination_album.album_key
          from inserted_destination_album
        ),
        inserted_separate_release as (
          insert into library.separate_releases (
            library_id,
            release_key,
            metadata
          )
          select
            bootstrap_context.library_id,
            (destination_state ->> 'destination_separate_release_key')::text,
            jsonb_build_object('source', (destination_state ->> 'source')::text)
          from bootstrap_context
          where coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
            and exists (select 1 from destination_album)
          on conflict (library_id, release_key) do nothing
          returning library.separate_releases.release_key
        ),
        copied_album_ratings as (
          insert into app.album_ratings (
            account_id,
            library_id,
            album_key,
            rating,
            provenance,
            metadata
          )
          select
            app.album_ratings.account_id,
            app.album_ratings.library_id,
            destination_album.album_key,
            app.album_ratings.rating,
            app.album_ratings.provenance,
            app.album_ratings.metadata
          from app.album_ratings
          join validated_source_album
            on validated_source_album.library_id = app.album_ratings.library_id
           and validated_source_album.album_key = app.album_ratings.album_key
          cross join destination_album
          where exists (select 1 from inserted_destination_album)
             or (
                  exists (select 1 from existing_destination_album)
                  and (select selection_scope.input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
          on conflict (account_id, library_id, album_key) do nothing
          returning app.album_ratings.id
        ),
        copied_featured_artists as (
          insert into library.local_album_featured_artists (
            library_id,
            album_id,
            artist_id,
            featured_kind,
            metadata
          )
          select
            library.local_album_featured_artists.library_id,
            destination_album.id,
            library.local_album_featured_artists.artist_id,
            library.local_album_featured_artists.featured_kind,
            library.local_album_featured_artists.metadata
          from library.local_album_featured_artists
          join validated_source_album
            on validated_source_album.id =
               library.local_album_featured_artists.album_id
          cross join destination_album
          where not exists (select 1 from inserted_destination_album)
             or library.local_album_featured_artists.metadata ->> 'source'
                  is distinct from (destination_state ->> 'source')
          on conflict (library_id, album_id, artist_id, featured_kind) do nothing
          returning library.local_album_featured_artists.id
        ),
        updated_album_mbid_assertions as (
          update library.local_mbid_assertions
          set album_id = destination_album.id,
              target_key = case
                when library.local_mbid_assertions.target_kind = 'album'
                then destination_album.album_key
                else library.local_mbid_assertions.target_key
              end
          from validated_source_album
          cross join destination_album
          where library.local_mbid_assertions.album_id = validated_source_album.id
            and exists (select 1 from existing_destination_album)
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
          returning library.local_mbid_assertions.id
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
          where library.local_tracks.id = selected_track_files.track_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'source', (destination_state ->> 'source')::text,
                       'stale', false,
                       'file_entry',
                       coalesce(
                         library.local_track_files.metadata #> '{scan_cache,file_entry}',
                         '{}'::jsonb
                       ) || selected_track_files.file_entry
                     ),
                true
              ),
              last_seen_at = observed_at
          from selected_track_files
          where library.local_track_files.id = selected_track_files.track_file_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_track_files.id
        ),
        vacated_source_album as materialized (
          select validated_source_album.id
          from validated_source_album
          where exists (select 1 from existing_destination_album)
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and (select count(*) from updated_tracks) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select selection_scope.input_path_count from selection_scope)
        ),
        deleted_destination_separate_release as (
          delete from library.separate_releases
          using bootstrap_context, vacated_source_album
          where library.separate_releases.library_id =
                bootstrap_context.library_id
            and library.separate_releases.release_key =
                (destination_state ->> 'destination_separate_release_key')
            and not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
          returning library.separate_releases.release_key
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
                coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'relation_projection',
                       coalesce(
                         library.libraries.metadata #> '{scan_cache,relation_projection}',
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
            and (select count(*) from updated_track_files) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from updated_tracks) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from destination_album) = 1
            and (select count(*) from deleted_destination_separate_release) >= 0
            and (
                  not exists (select 1 from existing_destination_album)
                  or (select selection_scope.input_path_count from selection_scope) < (
                       select count(*) from source_album_track_files
                     )
                  or (select count(*) from vacated_source_album) = 1
                )
          returning coalesce(
            nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select selection_scope.input_path_count from selection_scope) as input_path_count,
          (select selection_scope.resolved_path_count from selection_scope) as resolved_path_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          (select selection_scope.source_album_count from selection_scope) as source_album_count,
          0::bigint as destination_conflict_count,
          (select count(*) from destination_album) as destination_album_count,
          (select count(*) from destination_album) as album_rows_updated,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          (select id from destination_album) as destination_album_id,
          (select id from validated_source_album) as source_album_id,
          (select library_id from validated_source_album) as source_library_id,
          (select album_key from validated_source_album) as source_album_key,
          (select album_key from destination_album) as destination_album_key,
          case
            when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
             and exists (select 1 from destination_album)
            then (destination_state ->> 'destination_separate_release_key')::text
            else null
          end as separate_release_key,
          exists (select 1 from inserted_destination_album) as inserted_destination_album,
          coalesce(
            (select updated_library.inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision
        into mutation_result;
  else
with bootstrap_context as materialized (
          select library.libraries.id as library_id
          from library.libraries
          where library.libraries.id = requested_library_id
        ),
        input_track_paths as materialized (
          select distinct input_path as private_path
          from unnest(requested_track_paths::text[]) as input_path
        ),
        input_rows as materialized (
          select incoming.private_path, incoming.file_entry
          from jsonb_to_recordset(input_rows::jsonb)
            as incoming(private_path text, file_entry jsonb)
        ),
        selected_track_files as materialized (
          select
            library.local_track_files.id as track_file_id,
            library.local_tracks.id as track_id,
            library.local_tracks.album_id as source_album_id,
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
          where coalesce(
            (
              library.local_track_files.metadata
                #>> '{scan_cache,stale}'
            )::boolean,
            false
          ) is false
          order by library.local_tracks.id, library.local_track_files.id
          for update of local_tracks, local_track_files
        ),
        selection_scope as materialized (
          select
            (select count(*) from input_track_paths) as input_path_count,
            count(*) as resolved_path_count,
            count(distinct selected_track_files.source_album_id) as source_album_count,
            min(selected_track_files.source_album_id) as source_album_id
          from selected_track_files
        ),
        source_album_track_files as materialized (
          select library.local_track_files.id as track_file_id
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = selection_scope.source_album_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and coalesce(
                 (
                   library.local_track_files.metadata
                     #>> '{scan_cache,stale}'
                 )::boolean,
                 false
               ) is false
        ),
        source_album_identity as materialized (
          select
            library.local_albums.id,
            library.local_albums.artist_id,
            library.local_albums.release_year
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.id = selection_scope.source_album_id
        ),
        locked_album_scope as materialized (
          select
            library.local_albums.id,
            library.local_albums.library_id,
            library.local_albums.album_key,
            library.local_albums.artist_id,
            library.local_albums.title,
            library.local_albums.release_year,
            library.local_albums.cover_path,
            library.local_albums.metadata
          from bootstrap_context
          join selection_scope
            on selection_scope.input_path_count = selection_scope.resolved_path_count
           and selection_scope.source_album_count = 1
          join source_album_identity on true
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and (
                 library.local_albums.id = selection_scope.source_album_id
                 or library.local_albums.album_key = (destination_state ->> 'destination_album_key')
                 or (
                      library.local_albums.artist_id is not distinct from
                        source_album_identity.artist_id
                      and lower(btrim(library.local_albums.title)) =
                        lower(btrim((destination_state ->> 'destination_album_title')))
                      and library.local_albums.release_year is not distinct from
                        case
                          when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                          then nullif(destination_state ->> 'destination_release_year', '')::integer
                          else source_album_identity.release_year
                        end
                      and lower(
                            btrim(
                              coalesce(
                                library.local_albums.metadata ->> 'edition',
                                ''
                              )
                            )
                          ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                    )
               )
          order by library.local_albums.id
          for update of local_albums
        ),
        existing_destination_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.album_key
          from locked_album_scope
          join selection_scope on true
          where locked_album_scope.id <> selection_scope.source_album_id
            and not (
                  coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                  and (select selection_scope.input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
            and (
                  locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
                  or (
                       locked_album_scope.artist_id is not distinct from
                         (select artist_id from source_album_identity)
                       and lower(btrim(locked_album_scope.title)) =
                         lower(btrim((destination_state ->> 'destination_album_title')))
                       and locked_album_scope.release_year is not distinct from
                         case
                           when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                           then nullif(destination_state ->> 'destination_release_year', '')::integer
                           else (
                             select release_year
                             from source_album_identity
                           )
                         end
                       and lower(
                             btrim(
                               coalesce(
                                 locked_album_scope.metadata ->> 'edition',
                                 ''
                               )
                             )
                           ) = lower(btrim(coalesce(destination_state ->> 'destination_edition', '')))
                     )
                )
          order by
            case
              when locked_album_scope.album_key = (destination_state ->> 'destination_album_key')
              then 0
              else 1
            end,
            locked_album_scope.id
          limit 1
        ),
        validated_source_album as materialized (
          select
            locked_album_scope.id,
            locked_album_scope.library_id,
            locked_album_scope.album_key,
            locked_album_scope.artist_id,
            locked_album_scope.release_year,
            locked_album_scope.cover_path,
            (
              coalesce(locked_album_scope.metadata, '{}'::jsonb)
              - array[
                'cover_path', 'cover_revision', 'cover_selection_origin',
                'remote_cover_url', 'remote_cover_thumbnail_url',
                'remote_cover_source', 'remote_cover_source_label',
                'remote_cover_album_url', 'remote_cover_width',
                'remote_cover_height'
              ]::text[]
            ) as metadata,
            exists (
              select 1
              from source_album_track_files
              join library.local_track_files
                on library.local_track_files.id =
                   source_album_track_files.track_file_id
              where locked_album_scope.release_year is not null
                and library.local_track_files.metadata
                      #>> '{scan_cache,file_entry,year}' ~ '^[+-]?[0-9]+$'
                and (
                      library.local_track_files.metadata
                        #>> '{scan_cache,file_entry,year}'
                    )::bigint <> locked_album_scope.release_year
            ) as has_display_year_override
          from selection_scope
          join locked_album_scope
            on locked_album_scope.id = selection_scope.source_album_id
          where selection_scope.input_path_count = selection_scope.resolved_path_count
            and selection_scope.source_album_count = 1
            and selection_scope.input_path_count <= (
                  select count(*) from source_album_track_files
                )
        ),
        marked_partial_source_album as (
          update library.local_albums
          set metadata = jsonb_set(
                coalesce(library.local_albums.metadata, '{}'::jsonb),
                '{release_date}',
                to_jsonb(coalesce(
                  nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                  validated_source_album.release_year::text
                )),
                true
              )
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and validated_source_album.has_display_year_override
            and (select selection_scope.input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
          returning library.local_albums.id
        ),
        normalized_existing_destination_album as (
          update library.local_albums
          set release_year = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                 and nullif(btrim(library.local_albums.metadata ->> 'release_date'), '') is null
                then validated_source_album.release_year
                else library.local_albums.release_year
              end,
              metadata = case
                when not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                 and validated_source_album.has_display_year_override
                then jsonb_set(
                       coalesce(library.local_albums.metadata, '{}'::jsonb),
                       '{release_date}',
                       to_jsonb(coalesce(
                         nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                         nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                         validated_source_album.release_year::text
                       )),
                       true
                     )
                else library.local_albums.metadata
              end,
              last_seen_at = observed_at
          from validated_source_album
          join existing_destination_album on true
          where library.local_albums.id = existing_destination_album.id
          returning library.local_albums.id, library.local_albums.album_key
        ),
        updated_album_ratings as (
          update app.album_ratings
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                 and (select selection_scope.input_path_count from selection_scope) = (
                       select count(*) from source_album_track_files
                     )
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              updated_at = observed_at
          from validated_source_album
          where app.album_ratings.library_id = validated_source_album.library_id
            and app.album_ratings.album_key = validated_source_album.album_key
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning app.album_ratings.id
        ),
        renamed_source_album as (
          update library.local_albums
          set album_key = case
                when coalesce((destination_state ->> 'destination_is_explicit_separate')::boolean, false)::boolean
                then validated_source_album.album_key
                else (destination_state ->> 'destination_album_key')
              end,
              title = (destination_state ->> 'destination_album_title'),
              release_year = case
                when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                then nullif(destination_state ->> 'destination_release_year', '')::integer
                else library.local_albums.release_year
              end
        
              , metadata = case
                  when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb((destination_state ->> 'destination_release_date')::text),
                         true
                       )
                  when validated_source_album.has_display_year_override
                  then jsonb_set(
                         coalesce(library.local_albums.metadata, '{}'::jsonb),
                         '{release_date}',
                         to_jsonb(coalesce(
                           nullif(btrim(library.local_albums.metadata ->> 'release_date'), ''),
                           validated_source_album.release_year::text
                         )),
                         true
                       )
                  else library.local_albums.metadata
                end
    ,
              last_seen_at = observed_at
          from validated_source_album
          where library.local_albums.id = validated_source_album.id
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        inserted_destination_artist as (
          insert into library.local_artists (
            library_id, artist_key, name, sort_name, metadata
          )
          select validated_source_album.library_id,
                 (destination_state ->> 'destination_artist_key'), (destination_state ->> 'destination_artist_name'),
                 lower((destination_state ->> 'destination_artist_name')),
                 jsonb_build_object('source', (destination_state ->> 'source')::text)
          from validated_source_album
          where (select selection_scope.input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          on conflict (library_id, artist_key) do update
            set last_seen_at = observed_at
          returning library.local_artists.id
        ),
        inserted_destination_album as (
          insert into library.local_albums (
            library_id,
            artist_id,
            album_key,
            title,
            release_year,
            metadata
          )
          select
            validated_source_album.library_id,
            (select id from inserted_destination_artist),
            (destination_state ->> 'destination_album_key'),
            (destination_state ->> 'destination_album_title'),
            case
              when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
              then nullif(destination_state ->> 'destination_release_year', '')::integer
              else validated_source_album.release_year
            end,
        (
            case
              when validated_source_album.has_display_year_override
              then jsonb_set(
                     validated_source_album.metadata,
                     '{release_date}',
                     to_jsonb(coalesce(
                       nullif(btrim(validated_source_album.metadata ->> 'release_date'), ''),
                       validated_source_album.release_year::text
                     )),
                     true
                   )
              else validated_source_album.metadata
            end
    ) || coalesce(destination_state -> 'destination_artist_metadata', '{}'::jsonb)::jsonb
          from validated_source_album
          where (select selection_scope.input_path_count from selection_scope) < (
                  select count(*) from source_album_track_files
                )
            and not exists (select 1 from existing_destination_album)
          returning library.local_albums.id, library.local_albums.album_key
        ),
        destination_album as materialized (
          select
            normalized_existing_destination_album.id,
            normalized_existing_destination_album.album_key
          from normalized_existing_destination_album
          where exists (select 1 from validated_source_album)
          union all
          select
            renamed_source_album.id,
            renamed_source_album.album_key
          from renamed_source_album
          union all
          select
            inserted_destination_album.id,
            inserted_destination_album.album_key
          from inserted_destination_album
        ),
        inserted_separate_release as (
          insert into library.separate_releases (
            library_id,
            release_key,
            metadata
          )
          select
            bootstrap_context.library_id,
            (destination_state ->> 'destination_separate_release_key')::text,
            jsonb_build_object('source', (destination_state ->> 'source')::text)
          from bootstrap_context
          where coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
            and exists (select 1 from destination_album)
          on conflict (library_id, release_key) do nothing
          returning library.separate_releases.release_key
        ),
        copied_album_ratings as (
          insert into app.album_ratings (
            account_id,
            library_id,
            album_key,
            rating,
            provenance,
            metadata
          )
          select
            app.album_ratings.account_id,
            app.album_ratings.library_id,
            destination_album.album_key,
            app.album_ratings.rating,
            app.album_ratings.provenance,
            app.album_ratings.metadata
          from app.album_ratings
          join validated_source_album
            on validated_source_album.library_id = app.album_ratings.library_id
           and validated_source_album.album_key = app.album_ratings.album_key
          cross join destination_album
          where exists (select 1 from inserted_destination_album)
             or (
                  exists (select 1 from existing_destination_album)
                  and (select selection_scope.input_path_count from selection_scope) = (
                        select count(*) from source_album_track_files
                      )
                )
          on conflict (account_id, library_id, album_key) do nothing
          returning app.album_ratings.id
        ),
        copied_featured_artists as (
          insert into library.local_album_featured_artists (
            library_id,
            album_id,
            artist_id,
            featured_kind,
            metadata
          )
          select
            library.local_album_featured_artists.library_id,
            destination_album.id,
            library.local_album_featured_artists.artist_id,
            library.local_album_featured_artists.featured_kind,
            library.local_album_featured_artists.metadata
          from library.local_album_featured_artists
          join validated_source_album
            on validated_source_album.id =
               library.local_album_featured_artists.album_id
          cross join destination_album
          where not exists (select 1 from inserted_destination_album)
             or library.local_album_featured_artists.metadata ->> 'source'
                  is distinct from (destination_state ->> 'source')
          on conflict (library_id, album_id, artist_id, featured_kind) do nothing
          returning library.local_album_featured_artists.id
        ),
        updated_album_mbid_assertions as (
          update library.local_mbid_assertions
          set album_id = destination_album.id,
              target_key = case
                when library.local_mbid_assertions.target_kind = 'album'
                then destination_album.album_key
                else library.local_mbid_assertions.target_key
              end
          from validated_source_album
          cross join destination_album
          where library.local_mbid_assertions.album_id = validated_source_album.id
            and exists (select 1 from existing_destination_album)
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
          returning library.local_mbid_assertions.id
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
          where library.local_tracks.id = selected_track_files.track_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_tracks.id
        ),
        updated_track_files as (
          update library.local_track_files
          set metadata = jsonb_set(
                coalesce(library.local_track_files.metadata, '{}'::jsonb),
                '{scan_cache}',
                coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'source', (destination_state ->> 'source')::text,
                       'stale', false,
                       'file_entry',
                       coalesce(
                         library.local_track_files.metadata #> '{scan_cache,file_entry}',
                         '{}'::jsonb
                       ) || selected_track_files.file_entry
                     ),
                true
              ),
              last_seen_at = observed_at
          from selected_track_files
          where library.local_track_files.id = selected_track_files.track_file_id
            and exists (select 1 from validated_source_album)
            and exists (select 1 from destination_album)
          returning library.local_track_files.id
        ),
        vacated_source_album as materialized (
          select validated_source_album.id
          from validated_source_album
          where exists (select 1 from existing_destination_album)
            and (select selection_scope.input_path_count from selection_scope) = (
                  select count(*) from source_album_track_files
                )
            and (select count(*) from updated_tracks) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from updated_track_files) =
                (select selection_scope.input_path_count from selection_scope)
        ),
        deleted_destination_separate_release as (
          delete from library.separate_releases
          using bootstrap_context, vacated_source_album
          where library.separate_releases.library_id =
                bootstrap_context.library_id
            and library.separate_releases.release_key =
                (destination_state ->> 'destination_separate_release_key')
            and not coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
          returning library.separate_releases.release_key
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
                coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'relation_projection',
                       coalesce(
                         library.libraries.metadata #> '{scan_cache,relation_projection}',
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
            and (select count(*) from updated_track_files) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from updated_tracks) =
                (select selection_scope.input_path_count from selection_scope)
            and (select count(*) from destination_album) = 1
            and (select count(*) from deleted_destination_separate_release) >= 0
            and (
                  not exists (select 1 from existing_destination_album)
                  or (select selection_scope.input_path_count from selection_scope) < (
                       select count(*) from source_album_track_files
                     )
                  or (select count(*) from vacated_source_album) = 1
                )
          returning coalesce(
            nullif(library.libraries.metadata ->> 'inventory_mutation_revision', '')::bigint,
            0
          ) as inventory_mutation_revision
        )
        select
          (select selection_scope.input_path_count from selection_scope) as input_path_count,
          (select selection_scope.resolved_path_count from selection_scope) as resolved_path_count,
          (select count(*) from source_album_track_files) as source_album_track_file_count,
          (select selection_scope.source_album_count from selection_scope) as source_album_count,
          0::bigint as destination_conflict_count,
          (select count(*) from destination_album) as destination_album_count,
          (select count(*) from destination_album) as album_rows_updated,
          (select count(*) from updated_tracks) as track_rows_updated,
          (select count(*) from updated_track_files) as track_file_rows_updated,
          (select id from destination_album) as destination_album_id,
          (select id from validated_source_album) as source_album_id,
          (select library_id from validated_source_album) as source_library_id,
          (select album_key from validated_source_album) as source_album_key,
          (select album_key from destination_album) as destination_album_key,
          case
            when coalesce((destination_state ->> 'updates_release_year')::boolean, false)::boolean
             and exists (select 1 from destination_album)
            then (destination_state ->> 'destination_separate_release_key')::text
            else null
          end as separate_release_key,
          exists (select 1 from inserted_destination_album) as inserted_destination_album,
          coalesce(
            (select updated_library.inventory_mutation_revision from updated_library),
            0
          ) as inventory_mutation_revision
        into mutation_result;
  end if;
  if mutation_result.input_path_count <> cardinality(requested_track_paths)
     or mutation_result.resolved_path_count <> cardinality(requested_track_paths)
     or mutation_result.source_album_count <> 1
     or mutation_result.source_album_track_file_count < cardinality(requested_track_paths)
     or mutation_result.destination_conflict_count <> 0
     or mutation_result.destination_album_count <> 1
     or mutation_result.album_rows_updated <> 1
     or mutation_result.track_rows_updated <> cardinality(requested_track_paths)
     or mutation_result.track_file_rows_updated <> cardinality(requested_track_paths)
     or mutation_result.destination_album_id is null
     or mutation_result.inventory_mutation_revision <= current_inventory_revision then
    raise exception 'structural tag edit did not update the complete selected inventory'
      using errcode = '40001';
  end if;
  return query select
    mutation_result.input_path_count,
    mutation_result.resolved_path_count,
    mutation_result.source_album_track_file_count,
    mutation_result.source_album_count,
    mutation_result.destination_conflict_count,
    mutation_result.destination_album_count,
    mutation_result.album_rows_updated,
    mutation_result.track_rows_updated,
    mutation_result.track_file_rows_updated,
    mutation_result.destination_album_id,
    mutation_result.source_album_id,
    mutation_result.source_library_id,
    mutation_result.source_album_key,
    mutation_result.destination_album_key,
    mutation_result.separate_release_key,
    mutation_result.inserted_destination_album,
    mutation_result.inventory_mutation_revision;
end;
$function$;

create or replace function ops.load_claimed_cover_finalization(
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz
)
returns table (
  checkpoint_id bigint,
  checkpoint text,
  checkpoint_revision bigint,
  library_id bigint,
  local_album_id bigint,
  task_id bigint,
  cover_mutation_revision bigint,
  selected_cover_revision text
)
language sql
security definer
set search_path = pg_catalog, ops
as $function$
  select checkpoint_row.id,
         checkpoint_row.checkpoint::text,
         checkpoint_row.row_revision,
         task.library_id,
         task.local_album_id,
         task.id,
         checkpoint_row.authority_cover_mutation_revision,
         checkpoint_row.cover_revision
  from ops.jobs as job
  join ops.cover_remote_save_checkpoints as checkpoint_row
    on checkpoint_row.job_id = job.id
  join ops.cover_lookup_tasks as task on task.id = checkpoint_row.task_id
  where job.id = requested_job_id
    and job.kind = 'cover_remote_save'
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > clock_timestamp()
    and checkpoint_row.checkpoint in (
      'authority_committed', 'runtime_published', 'publication_completed'
    )
    and checkpoint_row.authority_cover_mutation_revision is not null
    and checkpoint_row.cover_revision is not null;
$function$;

create or replace function ops.advance_claimed_cover_finalization(
  requested_checkpoint_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  expected_checkpoint_revision bigint,
  next_checkpoint text,
  observed_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  current_checkpoint text;
  current_revision bigint;
begin
  if next_checkpoint not in ('runtime_published', 'publication_completed') then
    raise exception 'invalid cover finalization checkpoint' using errcode = '22023';
  end if;

  select checkpoint_row.checkpoint, checkpoint_row.row_revision
  into current_checkpoint, current_revision
  from ops.jobs as job
  join ops.cover_remote_save_checkpoints as checkpoint_row
    on checkpoint_row.job_id = job.id
  where checkpoint_row.id = requested_checkpoint_id
    and job.id = requested_job_id
    and job.kind = 'cover_remote_save'
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > clock_timestamp()
  for update of job, checkpoint_row;
  if not found then return null; end if;

  if current_checkpoint = next_checkpoint
     and current_revision in (
       expected_checkpoint_revision,
       expected_checkpoint_revision + 1
     ) then
    return current_revision;
  end if;
  if current_revision <> expected_checkpoint_revision
     or (current_checkpoint, next_checkpoint) not in (
       ('authority_committed', 'runtime_published'),
       ('runtime_published', 'publication_completed')
     ) then
    return null;
  end if;

  update ops.cover_remote_save_checkpoints as checkpoint_row
  set checkpoint = next_checkpoint,
      row_revision = checkpoint_row.row_revision + 1,
      updated_at = observed_at,
      completed_at = case
        when next_checkpoint = 'publication_completed' then observed_at
        else null
      end
  where checkpoint_row.id = requested_checkpoint_id
    and checkpoint_row.row_revision = expected_checkpoint_revision
  returning checkpoint_row.row_revision into current_revision;
  return current_revision;
end;
$function$;

create or replace function ops.retry_claimed_cover_finalization(
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  retry_at timestamptz,
  reason_code text,
  observed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  moved_job ops.jobs%rowtype;
begin
  update ops.jobs as job
  set state = 'retry_wait',
      scheduled_at = retry_at,
      max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      heartbeat_at = null,
      outcome_code = reason_code,
      updated_at = observed_at
  from ops.cover_remote_save_checkpoints as checkpoint_row
  where job.id = requested_job_id
    and checkpoint_row.job_id = job.id
    and checkpoint_row.checkpoint in ('authority_committed', 'runtime_published')
    and job.kind = 'cover_remote_save'
    and job.state = 'running'
    and job.attempt_count = requested_attempt
    and job.lease_owner = requested_worker_id
    and job.lease_token = requested_lease_token
    and job.lease_expires_at > clock_timestamp()
  returning job.* into moved_job;

  if not found then return false; end if;
  insert into ops.job_transitions (
    job_id, prior_state, next_state, attempt_count, reason_code,
    retry_decision, next_due_at, worker_instance_id, transitioned_at
  ) values (
    moved_job.id, 'running', 'retry_wait', moved_job.attempt_count,
    reason_code, 'scheduled', retry_at, requested_worker_id, observed_at
  );
  return true;
end;
$function$;

create or replace function ops.requeue_expired_cover_finalization(
  observed_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  moved_count bigint;
begin
  with candidates as materialized (
    select job.id
    from ops.jobs as job
    join ops.cover_remote_save_checkpoints as checkpoint_row
      on checkpoint_row.job_id = job.id
    where job.kind = 'cover_remote_save'
      and job.state = 'running'
      and job.lease_expires_at <= clock_timestamp()
      and checkpoint_row.checkpoint in (
        'authority_committed', 'runtime_published', 'publication_completed'
      )
    order by job.id
    for update of job skip locked
  ), moved as (
    update ops.jobs as job
    set state = 'retry_wait',
        scheduled_at = transaction_timestamp(),
        max_attempts = greatest(job.max_attempts, job.attempt_count + 1),
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        heartbeat_at = null,
        outcome_code = 'cover_finalization_lease_expired',
        updated_at = transaction_timestamp()
    from candidates
    where job.id = candidates.id
    returning job.id, job.attempt_count
  )
  insert into ops.job_transitions (
    job_id, prior_state, next_state, attempt_count, reason_code,
    retry_decision, next_due_at, transitioned_at
  )
  select id, 'running', 'retry_wait', attempt_count,
         'cover_finalization_lease_expired', 'scheduled',
         transaction_timestamp(), transaction_timestamp()
  from moved;

  get diagnostics moved_count = row_count;
  return moved_count;
end;
$function$;

create or replace function ops.reconcile_stale_job_leases(
  observed_at timestamptz,
  requested_limit integer
)
returns table (
  retried_count bigint,
  failed_count bigint,
  ambiguous_count bigint,
  canceled_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, ops
as $function$
declare
  retried bigint := 0;
  failed bigint := 0;
  ambiguous bigint := 0;
  canceled bigint := 0;
begin
  if requested_limit is null or requested_limit not between 1 and 1000 then
    raise exception 'stale lease reconciliation limit is invalid'
      using errcode = '22023';
  end if;

  with stale as materialized (
    select
      job.id,
      job.attempt_count,
      job.max_attempts,
      job.recovery_policy,
      job.cancel_requested_at,
      job.recovery_policy = 'retry_safe'
        and job.attempt_count < job.max_attempts as can_retry
    from ops.jobs as job
    where job.state = 'running'
      and job.lease_expires_at <= clock_timestamp()
      and not exists (
        select 1
        from ops.cover_remote_save_checkpoints as checkpoint_row
        where checkpoint_row.job_id = job.id
          and checkpoint_row.checkpoint in (
            'authority_committed', 'runtime_published', 'publication_completed'
          )
      )
    order by job.lease_expires_at, job.id
    limit requested_limit
    for update of job skip locked
  ), classified as materialized (
    select *, case
      when cancel_requested_at is not null
           and recovery_policy = 'retry_safe' then 'canceled'
      when recovery_policy = 'ambiguous_on_stale_lease' then 'ambiguous'
      when can_retry then 'retry_wait'
      when recovery_policy = 'retry_safe' then 'failed'
      else 'ambiguous'
    end as next_state
    from stale
  ), moved as (
    update ops.jobs as job
    set state = classified.next_state,
        scheduled_at = case
          when classified.next_state = 'retry_wait' then transaction_timestamp()
          else job.scheduled_at
        end,
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        heartbeat_at = null,
        outcome_code = case classified.next_state
          when 'retry_wait' then 'stale_lease_retry'
          when 'canceled' then 'stale_lease_canceled'
          when 'ambiguous' then 'stale_lease_ambiguous'
          else 'attempts_exhausted'
        end,
        completed_at = case
          when classified.next_state = 'retry_wait' then null
          else transaction_timestamp()
        end,
        updated_at = transaction_timestamp()
    from classified
    where job.id = classified.id
    returning job.id, job.attempt_count, classified.next_state,
              job.outcome_code, job.scheduled_at, classified.recovery_policy
  ), transitions as (
    insert into ops.job_transitions (
      job_id, prior_state, next_state, attempt_count, reason_code,
      retry_decision, next_due_at, transitioned_at
    )
    select id, 'running', next_state, attempt_count, outcome_code,
           case when next_state = 'retry_wait' then 'scheduled'
                when next_state = 'failed' and recovery_policy = 'retry_safe'
                  then 'exhausted'
                else 'none' end,
           case when next_state = 'retry_wait' then scheduled_at else null end,
           transaction_timestamp()
    from moved
    returning next_state
  )
  select
    count(*) filter (where next_state = 'retry_wait'),
    count(*) filter (where next_state = 'failed'),
    count(*) filter (where next_state = 'ambiguous'),
    count(*) filter (where next_state = 'canceled')
  into retried, failed, ambiguous, canceled
  from transitions;

  return query select retried, failed, ambiguous, canceled;
end;
$function$;

revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from public;
revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from album_haven_app;
revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from album_haven_worker;
revoke insert, update, delete on table
  library.local_albums, library.local_track_files
from album_haven_readonly;

-- Persist publication results so replay never samples a later global cover revision.
-- Historical publications keep their original false/0 response through null defaults.
alter table library.full_scan_intents
  add column if not exists committed_cover_mutation_revision bigint
    check (committed_cover_mutation_revision >= 0),
  add column if not exists committed_cover_publication_stale boolean;

alter table library.targeted_reconciliation_intents
  add column if not exists committed_cover_mutation_revision bigint
    check (committed_cover_mutation_revision >= 0),
  add column if not exists committed_cover_publication_stale boolean;

create or replace function library.publish_claimed_full_scan_inventory_0106(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_expected_inventory_revision bigint,
  p_inventory jsonb,
  p_observed_root_ids text[],
  p_now timestamptz
)
returns table (publication_won boolean, inventory_mutation_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  claimed_library_id bigint;
  claimed_account_id bigint;
  claimed_capability_key varchar;
  claimed_request_origin_id bigint;
  claimed_deployment_mode varchar;
  claimed_client_surface varchar;
  committed_revision bigint;
  claimed_scan_mode varchar;
  recovery_cutoff timestamptz;
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null or
     p_worker_id is null or p_lease_token is null or p_now is null or
     p_expected_inventory_revision is null or p_expected_inventory_revision < 0 or
     jsonb_typeof(p_inventory) <> 'object' or p_observed_root_ids is null or
     cardinality(p_observed_root_ids) < 1 then
    raise exception 'full scan publication input is invalid';
  end if;

  select intent.library_id, job.account_id, job.capability_key,
         job.request_origin_id, job.deployment_mode, job.client_surface, intent.mode
    into claimed_library_id, claimed_account_id, claimed_capability_key,
         claimed_request_origin_id, claimed_deployment_mode,
         claimed_client_surface, claimed_scan_mode
    from ops.jobs as job
    join library.full_scan_intents as intent
      on intent.id = p_intent_id and intent.job_id = job.id
     and intent.library_id = job.library_id and intent.state = 'running'
     and intent.execution_attempt = p_attempt
     and intent.captured_inventory_revision = p_expected_inventory_revision
   where job.id = p_job_id and job.kind = 'full_scan'
     and job.subject_kind = 'full_scan_intent'
     and job.subject_ref = p_intent_id::text and job.state = 'running'
     and job.attempt_count = p_attempt and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token and job.lease_expires_at > p_now
     and job.cancel_requested_at is null
   for update of job, intent;
  if claimed_library_id is null then
    return query select false, null::bigint;
    return;
  end if;

  if claimed_capability_key <> 'library.refresh'
     or claimed_deployment_mode not in (
       'local_development', 'self_hosted', 'self_hosted_private_web'
     )
     or claimed_client_surface <> 'private_web' then
    return query select false, null::bigint;
    return;
  end if;

  perform 1 from app.accounts as account
   where account.id = claimed_account_id
     and account.is_active is true and account.disabled_at is null
   for share;
  if not found then
    return query select false, null::bigint;
    return;
  end if;

  perform 1 from library.library_memberships as membership
   where membership.library_id = claimed_library_id
     and membership.account_id = claimed_account_id
   for update;
  if not found then
    return query select false, null::bigint;
    return;
  end if;

  perform 1 from app.bootstrap_owners as owner_record
   where owner_record.account_id = claimed_account_id
     and owner_record.owner_key = 'local-bootstrap-owner'
   for update;
  if not found then
    perform 1 from app.capabilities as capability
     where capability.account_id = claimed_account_id
       and capability.capability_key = claimed_capability_key
       and capability.revoked_at is null
       and (
         (capability.scope_kind = 'global' and capability.scope_id is null)
         or (
           capability.scope_kind = 'library'
           and capability.scope_id = claimed_library_id
         )
       )
     for update;
    if not found then
      return query select false, null::bigint;
      return;
    end if;
  end if;

  perform 1 from app.request_origins as origin
   where origin.id = claimed_request_origin_id
     and origin.account_id = claimed_account_id
     and origin.client_surface_class = claimed_client_surface
     and nullif(btrim(origin.origin_type), '') is not null
   for update;
  if not found then
    return query select false, null::bigint;
    return;
  end if;

  perform current_root.id
    from library.full_scan_intent_roots as intent_root
    join library.library_roots as accepted_root on accepted_root.id = intent_root.root_id
    join library.library_roots as current_root
      on current_root.library_id = claimed_library_id
     and current_root.metadata ->> 'root_id' = accepted_root.metadata ->> 'root_id'
   where intent_root.intent_id = p_intent_id
   for update of current_root;

  if exists (
    with accepted as (
      select root.metadata ->> 'root_id' as root_id
        from library.full_scan_intent_roots as intent_root
        join library.library_roots as root on root.id = intent_root.root_id
       where intent_root.intent_id = p_intent_id
    )
    select 1 from accepted
     where accepted.root_id is null
        or not (accepted.root_id = any(p_observed_root_ids))
        or not exists (
          select 1 from library.library_roots as current_root
           where current_root.library_id = claimed_library_id
             and current_root.metadata ->> 'root_id' = accepted.root_id
             and current_root.is_active is true
        )
  ) or cardinality(p_observed_root_ids) <> (
    select count(*) from library.full_scan_intent_roots
     where intent_id = p_intent_id
  ) then
    return query select false, null::bigint;
    return;
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
        as input(private_path text)
     where nullif(btrim(input.private_path), '') is null
        or not exists (
          select 1 from library.library_roots as root
           where root.library_id = claimed_library_id and root.is_active is true
             and root.metadata ->> 'root_id' = any(p_observed_root_ids)
             and starts_with(
               library.local_path_key(input.private_path),
               library.local_path_key(root.root_path) || case
                 library.local_path_style(root.root_path)
                 when 'windows' then E'\\'
                 else '/'
               end
             )
        )
  ) then
    raise exception 'full scan publication file scope is invalid';
  end if;

  if exists (
    with artists as (
      select input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'artists', '[]'::jsonb))
          as input(artist_key text)
    ), albums as (
      select input.album_key, input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
          as input(album_key text, artist_key text)
    ), tracks as (
      select input.track_key, input.album_key, input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
          as input(track_key text, album_key text, artist_key text)
    ), files as (
      select input.track_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
          as input(track_key text)
    )
    select 1 from albums
     where nullif(btrim(albums.album_key), '') is null
        or (albums.artist_key is not null and not exists (
          select 1 from artists where artists.artist_key = albums.artist_key
        ))
    union all
    select 1 from tracks
     where nullif(btrim(tracks.track_key), '') is null
        or not exists (select 1 from files where files.track_key = tracks.track_key)
        or (tracks.album_key is not null and not exists (
          select 1 from albums where albums.album_key = tracks.album_key
        ))
        or (tracks.artist_key is not null and not exists (
          select 1 from artists where artists.artist_key = tracks.artist_key
        ))
  ) then
    raise exception 'full scan publication hierarchy is invalid';
  end if;

  select intent.committed_inventory_revision into committed_revision
  from library.full_scan_intents as intent where intent.id = p_intent_id;
  if committed_revision is not null then
    return query select false, committed_revision;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('album-haven:local-inventory-publication')
  );
  select coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0)
    into committed_revision
    from library.libraries where id = claimed_library_id for update;
  if not exists (
    select 1
      from ops.jobs as job
     where job.id = p_job_id
       and job.kind = 'full_scan'
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > clock_timestamp()
       and job.cancel_requested_at is null
  ) then
    return query select false, committed_revision;
    return;
  end if;
  if committed_revision <> p_expected_inventory_revision then
    return query select false, committed_revision;
    return;
  end if;

  insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)
  select claimed_library_id, input.artist_key, input.name, input.sort_name, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'artists', '[]'::jsonb))
      as input(artist_key text, name text, sort_name text, metadata jsonb)
  on conflict (library_id, artist_key) do update set
    name = excluded.name, sort_name = excluded.sort_name, last_seen_at = now(),
    metadata = library.local_artists.metadata || excluded.metadata;

  insert into library.local_albums
    (library_id, artist_id, album_key, title, release_year, metadata)
  select claimed_library_id, artist.id, input.album_key, input.title,
         input.release_year, coalesce(input.metadata, '{}'::jsonb) - array['cover_path', 'cover_revision', 'cover_selection_origin', 'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source', 'remote_cover_source_label', 'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height']::text[]
    from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
      as input(artist_key text, album_key text, title text, release_year integer,
               cover_path text, metadata jsonb)
    left join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, album_key) do update set
    artist_id = excluded.artist_id, title = excluded.title,
    release_year = case
      when nullif(library.local_albums.metadata ->> 'release_date', '') is not null
      then library.local_albums.release_year else excluded.release_year end,
    last_seen_at = now(),
    metadata = library.local_albums.metadata || excluded.metadata;

  delete from library.local_album_featured_artists as featured
   using library.local_albums as album
   where featured.album_id = album.id and album.library_id = claimed_library_id
     and featured.metadata ->> 'source' = 'runtime_scan_cache';
  insert into library.local_album_featured_artists
    (library_id, album_id, artist_id, featured_kind, metadata)
  select claimed_library_id, album.id, artist.id, input.featured_kind, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'featured_artists', '[]'::jsonb))
      as input(album_key text, artist_key text, featured_kind text, metadata jsonb)
    join library.local_albums as album
      on album.library_id = claimed_library_id and album.album_key = input.album_key
    join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, album_id, artist_id, featured_kind) do update set
    last_seen_at = now(), metadata = excluded.metadata;

  insert into library.local_tracks
    (library_id, album_id, artist_id, track_key, title, disc_number,
     track_number, duration_seconds, metadata)
  select claimed_library_id, album.id, artist.id, input.track_key, input.title,
         input.disc_number, input.track_number, input.duration_seconds, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
      as input(album_key text, artist_key text, track_key text, title text,
               disc_number integer, track_number integer,
               duration_seconds integer, metadata jsonb)
    left join library.local_albums as album
      on album.library_id = claimed_library_id and album.album_key = input.album_key
    left join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, track_key) do update set
    album_id = excluded.album_id, artist_id = excluded.artist_id,
    title = excluded.title, disc_number = excluded.disc_number,
    track_number = excluded.track_number, duration_seconds = excluded.duration_seconds,
    last_seen_at = now(), metadata = library.local_tracks.metadata || excluded.metadata;

  insert into library.local_track_files
    (track_id, library_root_id, private_path, relative_path,
     file_size_bytes, modified_at, metadata)
  select track.id,
         library.require_local_track_file_root_id(
           claimed_library_id, input.private_path, input.metadata
         ),
         input.private_path, input.relative_path, input.file_size_bytes,
         to_timestamp(input.modified_at_epoch),
         case when input.metadata #> '{scan_cache,file_entry}' is not null
           then jsonb_set(input.metadata, '{scan_cache,file_entry}',
             (input.metadata #> '{scan_cache,file_entry}') - array['cover_path', 'cover_revision', 'cover_selection_origin', 'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source', 'remote_cover_source_label', 'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height']::text[])
           else input.metadata end
    from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
      as input(track_key text, private_path text, relative_path text,
               file_size_bytes bigint, modified_at_epoch double precision,
               metadata jsonb)
    join library.local_tracks as track
      on track.library_id = claimed_library_id and track.track_key = input.track_key
  on conflict (private_path) do update set
    track_id = excluded.track_id, library_root_id = excluded.library_root_id,
    relative_path = excluded.relative_path, file_size_bytes = excluded.file_size_bytes,
    modified_at = excluded.modified_at, last_seen_at = now(),
    metadata = jsonb_set(
          coalesce(library.local_track_files.metadata, '{}'::jsonb) || excluded.metadata,
          '{scan_cache}',
          (coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
            || coalesce(excluded.metadata -> 'scan_cache', '{}'::jsonb))
          || jsonb_build_object('file_entry',
            coalesce(excluded.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
            || coalesce((
              select jsonb_object_agg(entry.key, entry.value)
              from jsonb_each(coalesce(
                library.local_track_files.metadata #> '{scan_cache,file_entry}', '{}'::jsonb
              )) as entry(key, value)
              where entry.key = any(array['cover_path', 'cover_revision', 'cover_selection_origin', 'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source', 'remote_cover_source_label', 'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height']::text[])
            ), '{}'::jsonb))
        ) #- '{scan_cache,stale_marked_at}';

  update library.local_track_files as file
     set metadata = jsonb_set(
       coalesce(file.metadata, '{}'::jsonb), '{scan_cache}',
       coalesce(file.metadata -> 'scan_cache', '{}'::jsonb) ||
         jsonb_build_object('source', 'runtime_scan_cache', 'stale', true,
                            'stale_marked_at', now()::text), true
     ), last_seen_at = now()
    from library.library_roots as root, library.local_tracks as track
   where file.library_root_id = root.id and file.track_id = track.id
     and root.library_id = claimed_library_id and track.library_id = claimed_library_id
     and root.metadata ->> 'root_id' = any(p_observed_root_ids)
     and file.metadata #>> '{scan_cache,source}' = 'runtime_scan_cache'
     and not exists (
       select 1
         from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
           as submitted(private_path text)
        where library.local_path_key(submitted.private_path)
              = library.local_path_key(file.private_path)
     );

  committed_revision := p_expected_inventory_revision + 1;
  if claimed_scan_mode = 'manual_full_rescan'
     and nullif(p_inventory ->> 'scan_started_at', '') is not null then
    recovery_cutoff := (p_inventory ->> 'scan_started_at')::timestamptz;
    if recovery_cutoff > p_now then
      raise exception 'full scan recovery cutoff is invalid';
    end if;
  end if;
  update library.libraries as library_record
     set metadata = coalesce(library_record.metadata, '{}'::jsonb) ||
       jsonb_build_object(
         'inventory_mutation_revision', committed_revision,
         'scan_cache', coalesce(library_record.metadata -> 'scan_cache', '{}'::jsonb) ||
           jsonb_build_object(
             'relation_projection',
             coalesce(library_record.metadata #> '{scan_cache,relation_projection}', '{}'::jsonb)
               || jsonb_build_object('status', 'stale')
           )
       ) || case when recovery_cutoff is not null then jsonb_build_object(
         'library_watch_health', coalesce((
           select jsonb_object_agg(health_entry.key, health_entry.value)
             from jsonb_each(coalesce(
               library_record.metadata -> 'library_watch_health', '{}'::jsonb
             )) as health_entry
            where not (
              health_entry.key = any(p_observed_root_ids)
              and nullif(health_entry.value ->> 'detected_at', '') is not null
              and (health_entry.value ->> 'detected_at')::timestamptz <= recovery_cutoff
            )
         ), '{}'::jsonb),
         'manual_scan_recovery', jsonb_build_object(
           'inventory_mutation_revision', committed_revision,
           'scan_started_at', recovery_cutoff,
           'observed_root_ids', to_jsonb(p_observed_root_ids)
         )
       ) else '{}'::jsonb end, updated_at = now()
   where library_record.id = claimed_library_id;
  update library.full_scan_intents as intent
     set committed_inventory_revision = committed_revision,
         progress_phase = 'publishing', current_path = null,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id and intent.job_id = p_job_id
     and intent.execution_attempt = p_attempt
     and intent.committed_inventory_revision is null;
  if not found then
    raise exception 'full scan publication fence was lost';
  end if;

  insert into ops.jobs (
    kind, subject_kind, subject_ref, parameters, account_id, library_id,
    capability_key, request_origin_id, deployment_mode, client_surface,
    scope_version, resource_revision, idempotency_key, priority, scheduled_at,
    max_attempts, recovery_policy
  ) values (
    'post_scan_cover_refresh',
    'inventory_revision',
    'revision-' || committed_revision::text,
    jsonb_build_object('inventory_revision', committed_revision),
    null,
    claimed_library_id,
    null,
    null,
    claimed_deployment_mode,
    claimed_client_surface,
    null,
    committed_revision,
    'post-scan-cover-refresh:' || claimed_library_id::text || ':' || committed_revision::text,
    0,
    p_now,
    2,
    'retry_safe'
  )
  on conflict do nothing;

  perform 1
    from ops.jobs as follow_up
   where follow_up.kind = 'post_scan_cover_refresh'
     and follow_up.subject_kind = 'inventory_revision'
     and follow_up.subject_ref = 'revision-' || committed_revision::text
     and follow_up.parameters = jsonb_build_object(
       'inventory_revision', committed_revision
     )
     and follow_up.account_id is null
     and follow_up.library_id = claimed_library_id
     and follow_up.capability_key is null
     and follow_up.request_origin_id is null
     and follow_up.deployment_mode = claimed_deployment_mode
     and follow_up.client_surface = claimed_client_surface
     and follow_up.scope_version is null
     and follow_up.resource_revision = committed_revision
     and follow_up.idempotency_key =
       'post-scan-cover-refresh:' || claimed_library_id::text || ':' || committed_revision::text
     and follow_up.priority = 0
     and follow_up.max_attempts = 2
     and follow_up.recovery_policy = 'retry_safe';
  if not found then
    raise exception 'post-scan cover follow-up identity conflict';
  end if;

  return query select true, committed_revision;
end;
$$;

create or replace function library.publish_claimed_targeted_reconciliation_inventory_0106(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_inventory jsonb,
  p_stale_scopes jsonb,
  p_now timestamptz
)
returns table (
  publication_won boolean,
  inventory_mutation_revision bigint,
  affected_album_keys text[]
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  claimed_library_id bigint;
  committed_revision bigint;
  affected_keys text[] := array[]::text[];
  marked_attempt integer;
  authorized_primary_root_id text;
  authorized_active_paths text[];
  authorized_deleted_paths text[];
  authorized_deleted_subtrees text[];
  authorized_preserved_subtrees text[];
  authorized_moves jsonb;
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null or
     p_worker_id is null or p_lease_token is null or p_now is null or
     jsonb_typeof(p_inventory) <> 'object' or
     jsonb_typeof(p_stale_scopes) <> 'array' then
    raise exception 'targeted publication input is invalid';
  end if;
  if jsonb_array_length(coalesce(p_inventory -> 'artists', '[]'::jsonb)) > 4096 or
     jsonb_array_length(coalesce(p_inventory -> 'albums', '[]'::jsonb)) > 4096 or
     jsonb_array_length(coalesce(p_inventory -> 'featured_artists', '[]'::jsonb)) > 16384 or
     jsonb_array_length(coalesce(p_inventory -> 'tracks', '[]'::jsonb)) > 16384 or
     jsonb_array_length(coalesce(p_inventory -> 'track_files', '[]'::jsonb)) > 16384 or
     jsonb_array_length(p_stale_scopes) > 32 then
    raise exception 'targeted publication input is too large';
  end if;

  select job.library_id
    into claimed_library_id
    from ops.jobs as job
    join library.targeted_reconciliation_intents as intent
      on intent.id = p_intent_id
     and intent.job_id = job.id
     and intent.library_id = job.library_id
     and intent.state = 'running'
   where job.id = p_job_id
     and job.kind = 'targeted_reconciliation'
     and job.subject_kind = 'targeted_reconciliation_intent'
     and job.subject_ref = p_intent_id::text
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now
   for update of job;
  if claimed_library_id is null then
    return query select false, null::bigint, array[]::text[];
    return;
  end if;

  if not exists (
    select 1
      from app.bootstrap_owners as owner_record
      join library.libraries as library_record
        on library_record.owner_account_id = owner_record.account_id
     where owner_record.owner_key = 'local-bootstrap-owner'
       and library_record.id = claimed_library_id
       and library_record.name = 'Local Library'
       and library_record.library_kind = 'local'
  ) then
    return query select false, null::bigint, array[]::text[];
    return;
  end if;

  if exists (
    with accepted_root_refs as (
      select accepted.metadata ->> 'root_id' as logical_root_id
        from library.targeted_reconciliation_intents as intent
        join library.library_roots as accepted on accepted.id = intent.primary_root_id
       where intent.id = p_intent_id
      union
      select accepted.metadata ->> 'root_id'
        from library.targeted_reconciliation_intent_moves as move
        join library.library_roots as accepted on accepted.id = move.source_root_id
       where move.intent_id = p_intent_id
      union
      select accepted.metadata ->> 'root_id'
        from library.targeted_reconciliation_intent_moves as move
        join library.library_roots as accepted on accepted.id = move.destination_root_id
       where move.intent_id = p_intent_id
    )
    select 1
      from accepted_root_refs
      left join library.library_roots as current_root
        on current_root.library_id = claimed_library_id
       and current_root.metadata ->> 'root_id' = accepted_root_refs.logical_root_id
       and current_root.is_active is true
      join library.libraries as library_record on library_record.id = claimed_library_id
     where current_root.id is null
        or coalesce(library_record.metadata -> 'library_watch_health', '{}'::jsonb)
             ? accepted_root_refs.logical_root_id
  ) then
    return query select false, null::bigint, array[]::text[];
    return;
  end if;

  select loaded.logical_root_id, loaded.active_paths, loaded.deleted_paths,
         loaded.deleted_subtrees, loaded.preserved_subtrees, loaded.moves
    into authorized_primary_root_id, authorized_active_paths,
         authorized_deleted_paths, authorized_deleted_subtrees,
         authorized_preserved_subtrees, authorized_moves
    from library.load_claimed_targeted_reconciliation_intent_v2(
      p_job_id, p_worker_id, p_lease_token
    ) as loaded;
  if not found then
    return query select false, null::bigint, array[]::text[];
    return;
  end if;

  if exists (
    with allowed_active as (
      select authorized_primary_root_id as root_id, path, false as is_subtree
        from unnest(coalesce(authorized_active_paths, array[]::text[])) as item(path)
      union all
      select authorized_primary_root_id, path, true
        from unnest(
          coalesce(authorized_preserved_subtrees, array[]::text[])
        ) as item(path)
      union all
      select move ->> 'destination_root_ref', move ->> 'destination_path',
             coalesce((move ->> 'is_directory')::boolean, false)
        from jsonb_array_elements(coalesce(authorized_moves, '[]'::jsonb)) as item(move)
    ), submitted_files as (
      select input.private_path
        from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
          as input(private_path text)
    )
    select 1
      from submitted_files
     where nullif(btrim(submitted_files.private_path), '') is null
        or not exists (
          select 1 from allowed_active
           where (
             not allowed_active.is_subtree
             and regexp_replace(
                   case library.local_path_style(submitted_files.private_path)
                     when 'windows' then lower(replace(submitted_files.private_path, E'\\', '/'))
                     else replace(submitted_files.private_path, E'\\', '/')
                   end,
                   '/[^/]*$', ''
                 ) = regexp_replace(
                   case library.local_path_style(allowed_active.path)
                     when 'windows' then lower(replace(allowed_active.path, E'\\', '/'))
                     else replace(allowed_active.path, E'\\', '/')
                   end,
                   '/[^/]*$', ''
                 )
           ) or (
             allowed_active.is_subtree
             and (
               library.local_path_key(submitted_files.private_path)
                 = library.local_path_key(allowed_active.path)
               or left(
                    library.local_path_key(submitted_files.private_path),
                    char_length(library.local_path_key(allowed_active.path)) + 1
                  ) = library.local_path_key(allowed_active.path)
                      || case library.local_path_style(allowed_active.path)
                           when 'windows' then E'\\' else '/' end
             )
           )
        )
  ) then
    raise exception 'targeted publication file scope is invalid';
  end if;

  if exists (
    with allowed_stale as (
      select authorized_primary_root_id as root_id, 'path'::text as stale_kind, path
        from unnest(coalesce(authorized_deleted_paths, array[]::text[])) as item(path)
      union all
      select authorized_primary_root_id, 'subtree', path
        from unnest(coalesce(authorized_deleted_subtrees, array[]::text[])) as item(path)
      union all
      select move ->> 'source_root_ref',
             case when coalesce((move ->> 'is_directory')::boolean, false)
                  then 'subtree' else 'path' end,
             move ->> 'source_path'
        from jsonb_array_elements(coalesce(authorized_moves, '[]'::jsonb)) as item(move)
      union all
      select root.metadata ->> 'root_id',
             case authorized.path_kind
               when 'deleted_subtree' then 'subtree' else 'path' end,
             root.root_path
               || case library.local_path_style(root.root_path)
                    when 'windows' then E'\\' else '/' end
               || authorized.relative_path
        from library.targeted_reconciliation_intent_paths as authorized
        join library.targeted_reconciliation_intents as intent
          on intent.id = authorized.intent_id
         and intent.watcher_generation_kind is not null
        join library.library_roots as root
          on root.library_id = authorized.library_id
         and root.id = authorized.root_id
         and root.is_active is true
       where authorized.intent_id = p_intent_id
         and authorized.path_kind in ('deleted', 'deleted_subtree')
      union all
      select root.metadata ->> 'root_id', 'subtree', root.root_path
        from library.targeted_reconciliation_intents as intent
        join library.watcher_generation_participants as participant
          on participant.generation_id = intent.id
         and participant.library_id = intent.library_id
        join library.library_roots as root
          on root.library_id = participant.library_id
         and root.id = participant.root_id
         and root.is_active is true
       where intent.id = p_intent_id
         and intent.watcher_generation_kind = 'root_catch_up'
    ), submitted_stale as (
      select scope.root_id, 'path'::text as stale_kind, path.value as path
        from jsonb_to_recordset(p_stale_scopes)
          as scope(root_id text, paths jsonb, subtrees jsonb)
        cross join lateral jsonb_array_elements_text(
          coalesce(scope.paths, '[]'::jsonb)
        ) as path(value)
      union all
      select scope.root_id, 'subtree', subtree.value
        from jsonb_to_recordset(p_stale_scopes)
          as scope(root_id text, paths jsonb, subtrees jsonb)
        cross join lateral jsonb_array_elements_text(
          coalesce(scope.subtrees, '[]'::jsonb)
        ) as subtree(value)
    )
    select 1
      from submitted_stale
     where not exists (
       select 1 from allowed_stale
        where allowed_stale.root_id = submitted_stale.root_id
          and allowed_stale.stale_kind = submitted_stale.stale_kind
          and library.local_path_key(allowed_stale.path)
                = library.local_path_key(submitted_stale.path)
     )
  ) then
    raise exception 'targeted publication stale scope is invalid';
  end if;

  if exists (
    with artists as (
      select input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'artists', '[]'::jsonb))
          as input(artist_key text)
    ), albums as (
      select input.album_key, input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
          as input(album_key text, artist_key text)
    ), tracks as (
      select input.track_key, input.album_key, input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
          as input(track_key text, album_key text, artist_key text)
    ), files as (
      select input.track_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
          as input(track_key text)
    ), featured as (
      select input.album_key, input.artist_key
        from jsonb_to_recordset(coalesce(p_inventory -> 'featured_artists', '[]'::jsonb))
          as input(album_key text, artist_key text)
    )
    select 1 from artists
     where nullif(btrim(artists.artist_key), '') is null
        or not exists (
          select 1 from albums where albums.artist_key = artists.artist_key
          union all
          select 1 from tracks where tracks.artist_key = artists.artist_key
          union all
          select 1 from featured where featured.artist_key = artists.artist_key
        )
    union all
    select 1 from albums
     where nullif(btrim(albums.album_key), '') is null
        or not exists (select 1 from artists where artists.artist_key = albums.artist_key)
        or not exists (select 1 from tracks where tracks.album_key = albums.album_key)
    union all
    select 1 from tracks
     where nullif(btrim(tracks.track_key), '') is null
        or not exists (select 1 from files where files.track_key = tracks.track_key)
        or (tracks.album_key is not null and not exists (
              select 1 from albums where albums.album_key = tracks.album_key
            ))
        or (tracks.artist_key is not null and not exists (
              select 1 from artists where artists.artist_key = tracks.artist_key
            ))
    union all
    select 1 from files
     where nullif(btrim(files.track_key), '') is null
        or not exists (select 1 from tracks where tracks.track_key = files.track_key)
    union all
    select 1 from featured
     where not exists (select 1 from albums where albums.album_key = featured.album_key)
        or not exists (select 1 from artists where artists.artist_key = featured.artist_key)
  ) then
    raise exception 'targeted publication hierarchy is invalid';
  end if;

  select intent.publication_attempt,
         intent.committed_inventory_revision,
         intent.affected_album_keys
    into marked_attempt, committed_revision, affected_keys
    from library.targeted_reconciliation_intents as intent
   where intent.id = p_intent_id
   for update;
  if marked_attempt is not null then
    return query select false, committed_revision, affected_keys;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('album-haven:local-inventory-publication')
  );

  if not exists (
    select 1
      from ops.jobs as job
     where job.id = p_job_id
       and job.kind = 'targeted_reconciliation'
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > clock_timestamp()
  ) then
    return query select false, null::bigint, array[]::text[];
    return;
  end if;

  create temporary table targeted_album_key_map (
    input_album_key text primary key,
    target_album_key text not null
  ) on commit drop;

  insert into pg_temp.targeted_album_key_map (
    input_album_key, target_album_key
  )
  select input.album_key,
         coalesce((
           select existing.album_key
             from library.local_albums as existing
             left join library.local_artists as existing_artist
               on existing_artist.id = existing.artist_id
              and existing_artist.library_id = existing.library_id
            where existing.library_id = claimed_library_id
              and (
                existing.album_key = input.album_key
                or (
                  existing_artist.artist_key = input.artist_key
                  and lower(btrim(existing.title)) = lower(btrim(input.title))
                  and existing.release_year is not distinct from input.release_year
                  and lower(btrim(coalesce(existing.metadata ->> 'edition', '')))
                        = lower(btrim(coalesce(input.metadata ->> 'edition', '')))
                  and not exists (
                    select 1
                      from library.separate_releases as separated
                     where separated.library_id = claimed_library_id
                       and separated.release_key = concat_ws(
                             '::',
                             lower(btrim(coalesce(
                               nullif(btrim(existing.metadata ->> 'album_artist'), ''),
                               existing_artist.name,
                               ''
                             ))),
                             lower(btrim(existing.title)),
                             nullif(lower(btrim(coalesce(
                               existing.metadata ->> 'edition', ''
                             ))), '')
                           )
                  )
                )
              )
            order by (existing.album_key = input.album_key) desc, existing.id
            limit 1
         ), input.album_key)
    from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
      as input(artist_key text, album_key text, title text, release_year integer,
               metadata jsonb);

  update library.targeted_reconciliation_intents as intent
     set publication_attempt = p_attempt,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id
     and intent.job_id = p_job_id
     and intent.state = 'running'
     and intent.publication_attempt is null;
  if not found then
    return query select false, null::bigint, array[]::text[];
    return;
  end if;

  insert into library.local_artists (
    library_id, artist_key, name, sort_name, metadata
  )
  select claimed_library_id, input.artist_key, input.name,
         input.sort_name, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'artists', '[]'::jsonb))
      as input(artist_key text, name text, sort_name text, metadata jsonb)
  on conflict (library_id, artist_key) do update
    set name = excluded.name,
        sort_name = excluded.sort_name,
        last_seen_at = now(),
        metadata = library.local_artists.metadata || excluded.metadata;

  insert into library.local_albums (
    library_id, artist_id, album_key, title, release_year, metadata
  )
  select claimed_library_id, artist.id, album_map.target_album_key, input.title,
         input.release_year, coalesce(input.metadata, '{}'::jsonb) - array['cover_path', 'cover_revision', 'cover_selection_origin', 'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source', 'remote_cover_source_label', 'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height']::text[]
    from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
      as input(artist_key text, album_key text, title text, release_year integer,
               cover_path text, metadata jsonb)
    join pg_temp.targeted_album_key_map as album_map
      on album_map.input_album_key = input.album_key
    left join library.local_artists as artist
      on artist.library_id = claimed_library_id
     and artist.artist_key = input.artist_key
  on conflict (library_id, album_key) do update
    set artist_id = excluded.artist_id,
        title = excluded.title,
        release_year = case
          when nullif(library.local_albums.metadata ->> 'release_date', '') is not null
          then library.local_albums.release_year else excluded.release_year end,
        last_seen_at = now(),
        metadata = library.local_albums.metadata || excluded.metadata;

  insert into library.local_album_featured_artists (
    library_id, album_id, artist_id, featured_kind, metadata
  )
  select claimed_library_id, album.id, artist.id,
         input.featured_kind, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'featured_artists', '[]'::jsonb))
      as input(album_key text, artist_key text, featured_kind text, metadata jsonb)
    join pg_temp.targeted_album_key_map as album_map
      on album_map.input_album_key = input.album_key
    join library.local_albums as album
      on album.library_id = claimed_library_id
     and album.album_key = album_map.target_album_key
    join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, album_id, artist_id, featured_kind) do update
    set last_seen_at = now(),
        metadata = library.local_album_featured_artists.metadata
                   || (excluded.metadata - 'source');

  insert into library.local_tracks (
    library_id, album_id, artist_id, track_key, title, disc_number,
    track_number, duration_seconds, metadata
  )
  select claimed_library_id, album.id, artist.id, input.track_key,
         input.title, input.disc_number, input.track_number,
         input.duration_seconds, input.metadata
    from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
      as input(album_key text, artist_key text, track_key text, title text,
               disc_number integer, track_number integer,
               duration_seconds integer, metadata jsonb)
    left join pg_temp.targeted_album_key_map as album_map
      on album_map.input_album_key = input.album_key
    left join library.local_albums as album
      on album.library_id = claimed_library_id
     and album.album_key = album_map.target_album_key
    left join library.local_artists as artist
      on artist.library_id = claimed_library_id and artist.artist_key = input.artist_key
  on conflict (library_id, track_key) do update
    set album_id = excluded.album_id,
        artist_id = excluded.artist_id,
        title = excluded.title,
        disc_number = excluded.disc_number,
        track_number = excluded.track_number,
        duration_seconds = excluded.duration_seconds,
        last_seen_at = now(),
        metadata = library.local_tracks.metadata || excluded.metadata;

  insert into library.local_track_files (
    track_id, library_root_id, private_path, relative_path,
    file_size_bytes, modified_at, metadata
  )
  select track.id,
         library.require_local_track_file_root_id(
           claimed_library_id, input.private_path, '{}'::jsonb
         ),
         input.private_path, input.relative_path, input.file_size_bytes,
         to_timestamp(input.modified_at_epoch),
         case when input.metadata #> '{scan_cache,file_entry}' is not null
           then jsonb_set(input.metadata, '{scan_cache,file_entry}',
             (input.metadata #> '{scan_cache,file_entry}') - array['cover_path', 'cover_revision', 'cover_selection_origin', 'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source', 'remote_cover_source_label', 'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height']::text[])
           else input.metadata end
    from jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
      as input(track_key text, private_path text, relative_path text,
               file_size_bytes bigint, modified_at_epoch double precision,
               metadata jsonb)
    join library.local_tracks as track
      on track.library_id = claimed_library_id and track.track_key = input.track_key
  on conflict (private_path) do update
    set track_id = excluded.track_id,
        library_root_id = excluded.library_root_id,
        relative_path = excluded.relative_path,
        file_size_bytes = excluded.file_size_bytes,
        modified_at = excluded.modified_at,
        last_seen_at = now(),
        metadata = jsonb_set(
          coalesce(library.local_track_files.metadata, '{}'::jsonb) || excluded.metadata,
          '{scan_cache}',
          (coalesce(library.local_track_files.metadata -> 'scan_cache', '{}'::jsonb)
            || coalesce(excluded.metadata -> 'scan_cache', '{}'::jsonb))
          || jsonb_build_object('file_entry',
            coalesce(excluded.metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
            || coalesce((
              select jsonb_object_agg(entry.key, entry.value)
              from jsonb_each(coalesce(
                library.local_track_files.metadata #> '{scan_cache,file_entry}', '{}'::jsonb
              )) as entry(key, value)
              where entry.key = any(array['cover_path', 'cover_revision', 'cover_selection_origin', 'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source', 'remote_cover_source_label', 'remote_cover_album_url', 'remote_cover_width', 'remote_cover_height']::text[])
            ), '{}'::jsonb))
        ) #- '{scan_cache,stale_marked_at}';

  select coalesce(array_agg(distinct key order by key), array[]::text[])
    into affected_keys
    from (
      select album_map.target_album_key as key
        from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
          as input(album_key text)
        join pg_temp.targeted_album_key_map as album_map
          on album_map.input_album_key = input.album_key
       where nullif(input.album_key, '') is not null
      union
      select album.album_key
        from jsonb_to_recordset(p_stale_scopes)
          as stale(root_id text, paths jsonb, subtrees jsonb)
        join library.library_roots as root
          on root.library_id = claimed_library_id
         and root.metadata ->> 'root_id' = stale.root_id
         and root.is_active is true
        join library.local_track_files as file on file.library_root_id = root.id
        join library.local_tracks as track on track.id = file.track_id
        join library.local_albums as album on album.id = track.album_id
       where file.scan_cache_stale is false
         and (
           file.private_path in (
             select jsonb_array_elements_text(coalesce(stale.paths, '[]'::jsonb))
           )
           or exists (
             select 1
               from jsonb_array_elements_text(coalesce(stale.subtrees, '[]'::jsonb))
                    as subtree(path)
              where starts_with(
                replace(file.private_path, E'\\', '/'),
                rtrim(replace(subtree.path, E'\\', '/'), '/') || '/'
              )
           )
         )
    ) as affected(key);

  update library.local_track_files as file
     set metadata = jsonb_set(
           coalesce(file.metadata, '{}'::jsonb),
           '{scan_cache}',
           coalesce(file.metadata -> 'scan_cache', '{}'::jsonb)
             || jsonb_build_object(
                  'source', 'runtime_scan_cache', 'stale', true,
                  'stale_marked_at', coalesce(
                    file.metadata #>> '{scan_cache,stale_marked_at}', now()::text
                  )
                ),
           true
         ),
         last_seen_at = now()
    from library.local_tracks as track,
         library.library_roots as root,
         jsonb_to_recordset(p_stale_scopes)
           as stale(root_id text, paths jsonb, subtrees jsonb)
   where file.track_id = track.id
     and track.library_id = claimed_library_id
     and root.id = file.library_root_id
     and root.library_id = claimed_library_id
     and root.metadata ->> 'root_id' = stale.root_id
     and root.is_active is true
     and file.metadata #>> '{scan_cache,source}' = 'runtime_scan_cache'
     and file.scan_cache_stale is false
     and (
       file.private_path in (
         select jsonb_array_elements_text(coalesce(stale.paths, '[]'::jsonb))
       )
       or exists (
         select 1
           from jsonb_array_elements_text(coalesce(stale.subtrees, '[]'::jsonb))
                as subtree(path)
          where starts_with(
            replace(file.private_path, E'\\', '/'),
            rtrim(replace(subtree.path, E'\\', '/'), '/') || '/'
          )
       )
     );

  update library.libraries as library_record
     set metadata = coalesce(library_record.metadata, '{}'::jsonb)
           || jsonb_build_object(
                'inventory_mutation_revision',
                coalesce(nullif(
                  library_record.metadata ->> 'inventory_mutation_revision', ''
                )::bigint, 0) + 1,
                'scan_cache',
                coalesce(library_record.metadata -> 'scan_cache', '{}'::jsonb)
                  || jsonb_build_object(
                       'relation_projection',
                       coalesce(
                         library_record.metadata
                           #> '{scan_cache,relation_projection}',
                         '{}'::jsonb
                       ) || jsonb_build_object('status', 'stale')
                     )
              ),
         updated_at = now()
   where library_record.id = claimed_library_id
  returning coalesce(nullif(
    library_record.metadata ->> 'inventory_mutation_revision', ''
  )::bigint, 0) into committed_revision;

  update library.targeted_reconciliation_intents as intent
     set committed_inventory_revision = committed_revision,
         affected_album_keys = affected_keys,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id and intent.publication_attempt = p_attempt;

  return query select true, committed_revision, affected_keys;
end;
$$;

create or replace function library.publish_claimed_full_scan(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_expected_inventory_revision bigint,
  p_inventory jsonb,
  p_observed_root_ids text[],
  p_now timestamptz
)
returns table (
  publication_won boolean,
  inventory_mutation_revision bigint,
  cover_publication_stale boolean,
  cover_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_publication record;
  v_repair_id bigint;
  v_library_id bigint;
  v_captured_cover_revision bigint;
  v_cover_publication_stale boolean := false;
  v_cover_mutation_revision bigint := 0;
  v_observed_covers jsonb;
begin
  select job.library_id
  into v_library_id
  from ops.jobs as job
  where job.id = p_job_id
    and job.kind = 'full_scan'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of job;
  if not found then
    return query select false, null::bigint, false, 0::bigint;
    return;
  end if;

  select intent.watcher_repair_id, intent.captured_cover_mutation_revision,
         coalesce(intent.committed_cover_publication_stale, false),
         coalesce(intent.committed_cover_mutation_revision, 0)
  into v_repair_id, v_captured_cover_revision,
       v_cover_publication_stale, v_cover_mutation_revision
  from library.full_scan_intents as intent
  where intent.id = p_intent_id
    and intent.job_id = p_job_id
    and intent.library_id = v_library_id
    and intent.state = 'running'
  for update of intent;
  if not found then
    return query select false, null::bigint, false, 0::bigint;
    return;
  end if;

  if v_repair_id is not null then
    perform 1
    from library.watcher_repairs as repair
    where repair.id = v_repair_id
      and repair.library_id = v_library_id
    order by repair.id
    for update;
    if not found then
      raise exception 'full scan watcher repair fence changed'
        using errcode = '40001';
    end if;

    perform 1
    from library.watcher_lanes as lane
    join (
      select repair_root.library_id, repair_root.root_id
      from library.watcher_repair_roots as repair_root
      where repair_root.repair_id = v_repair_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_repair_roots as repair_root
      join library.watcher_barrier_participants as touched
        on touched.library_id = repair_root.library_id
       and touched.root_id = repair_root.root_id
      join library.watcher_barriers as barrier
        on barrier.id = touched.barrier_id
       and barrier.completed_at is null
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = touched.barrier_id
      where repair_root.repair_id = v_repair_id
    ) as locked
      on locked.library_id = lane.library_id
     and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;
  end if;
  select * into v_publication
  from library.publish_claimed_full_scan_inventory_0106(
    p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token,
    p_expected_inventory_revision, p_inventory, p_observed_root_ids, p_now
  );
  if coalesce(v_publication.publication_won, false) then
    if v_captured_cover_revision is null then
      raise exception 'scan publication requires a captured cover revision';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'album_id', album.id,
      'cover_path', submitted_album.cover_path,
      'cover_state', jsonb_strip_nulls(jsonb_build_object(
        'cover_revision', submitted_album.metadata -> 'cover_revision',
        'cover_selection_origin', submitted_album.metadata -> 'cover_selection_origin',
        'remote_cover_url', submitted_album.metadata -> 'remote_cover_url',
        'remote_cover_thumbnail_url', submitted_album.metadata -> 'remote_cover_thumbnail_url',
        'remote_cover_source', submitted_album.metadata -> 'remote_cover_source',
        'remote_cover_source_label', submitted_album.metadata -> 'remote_cover_source_label',
        'remote_cover_album_url', submitted_album.metadata -> 'remote_cover_album_url',
        'remote_cover_width', submitted_album.metadata -> 'remote_cover_width',
        'remote_cover_height', submitted_album.metadata -> 'remote_cover_height'
      )),
      'track_paths', coalesce(paths.private_paths, array[]::text[])
    ) order by album.id), '[]'::jsonb)
    into v_observed_covers
    from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
      as submitted_album(
        artist_key text, album_key text, title text, release_year integer,
        cover_path text, metadata jsonb
      )
    join library.local_albums as album
      on album.library_id = v_library_id and album.album_key = submitted_album.album_key
    left join lateral (
      select array_agg(file_input.private_path order by file_input.private_path) as private_paths
      from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
        as track_input(album_key text, track_key text)
      join jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
        as file_input(track_key text, private_path text)
        on file_input.track_key = track_input.track_key
      where track_input.album_key = submitted_album.album_key
    ) as paths on true;

    select result.cover_publication_stale, result.cover_mutation_revision
    into v_cover_publication_stale, v_cover_mutation_revision
    from library.apply_scanned_cover_observations(
      v_library_id, v_captured_cover_revision, v_observed_covers, p_now
    ) as result;
    update library.full_scan_intents as intent
    set committed_cover_mutation_revision = v_cover_mutation_revision,
        committed_cover_publication_stale = v_cover_publication_stale
    where intent.id = p_intent_id;
  end if;
  if coalesce(v_publication.publication_won, false)
     and v_repair_id is not null then
    perform library.complete_watcher_repair_internal(
      v_repair_id,
      p_job_id,
      p_attempt,
      p_worker_id,
      p_lease_token,
      v_publication.inventory_mutation_revision,
      p_now,
      false
    );
    perform 1
    from library.watcher_repairs as repair
    where repair.id = v_repair_id
      and repair.inventory_revision = v_publication.inventory_mutation_revision
      and repair.state in ('catch_up', 'complete');
    if not found then
      raise exception 'watcher repair publication fence changed'
        using errcode = '40001';
    end if;
  end if;
  return query select
    coalesce(v_publication.publication_won, false),
    v_publication.inventory_mutation_revision,
    v_cover_publication_stale,
    v_cover_mutation_revision;
end;
$$;

create or replace function library.publish_claimed_targeted_reconciliation(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_inventory jsonb,
  p_stale_scopes jsonb,
  p_now timestamptz
)
returns table (
  publication_won boolean,
  inventory_mutation_revision bigint,
  affected_album_keys text[],
  cover_publication_stale boolean,
  cover_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_publication record;
  v_is_watcher boolean;
  v_stored_attempt integer;
  v_stored_revision bigint;
  v_stored_keys text[];
  v_retry_authorized boolean;
  v_library_id bigint;
  v_captured_cover_revision bigint;
  v_cover_publication_stale boolean := false;
  v_cover_mutation_revision bigint := 0;
  v_observed_covers jsonb;
begin
  select intent.library_id, intent.watcher_generation_kind is not null
  into v_library_id, v_is_watcher
  from library.targeted_reconciliation_intents as intent
  join ops.jobs as job on job.id = intent.job_id
  where intent.id = p_intent_id
    and job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp();
  if coalesce(v_is_watcher, false) then
    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = v_library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;
    perform 1
    from library.watcher_lanes as lane
    join (
      select participant.library_id, participant.root_id
      from library.watcher_generation_participants as participant
      where participant.generation_id = p_intent_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as owned_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = owned_barrier.barrier_id
      where owned_barrier.generation_id = p_intent_id
    ) as locked
      on locked.library_id = lane.library_id and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;
  end if;
  select intent.publication_attempt, intent.committed_inventory_revision,
         intent.affected_album_keys, intent.watcher_generation_kind is not null,
         job.id is not null, intent.captured_cover_mutation_revision,
         coalesce(intent.committed_cover_publication_stale, false),
         coalesce(intent.committed_cover_mutation_revision, 0)
  into v_stored_attempt, v_stored_revision, v_stored_keys, v_is_watcher,
       v_retry_authorized, v_captured_cover_revision,
       v_cover_publication_stale, v_cover_mutation_revision
  from library.targeted_reconciliation_intents as intent
  left join ops.jobs as job
    on job.id = p_job_id
   and job.id = intent.job_id
   and job.kind = 'targeted_reconciliation'
   and job.state = 'running'
   and job.attempt_count = p_attempt
   and job.lease_owner = p_worker_id
   and job.lease_token = p_lease_token
   and job.lease_expires_at > pg_catalog.clock_timestamp()
  where intent.id = p_intent_id
  for update of intent;
  select * into v_publication
  from library.publish_claimed_targeted_reconciliation_inventory_0106(
    p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token,
    p_inventory, p_stale_scopes, p_now
  );
  if v_stored_attempt is not null then
    return query select
      coalesce(v_is_watcher, false)
        and coalesce(v_retry_authorized, false)
        and v_stored_attempt = p_attempt,
      v_stored_revision,
      coalesce(v_stored_keys, array[]::text[]),
      v_cover_publication_stale,
      v_cover_mutation_revision;
    return;
  end if;
  if coalesce(v_publication.publication_won, false) then
    if v_captured_cover_revision is null then
      raise exception 'scan publication requires a captured cover revision';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'album_id', album.id,
      'cover_path', submitted_album.cover_path,
      'cover_state', jsonb_strip_nulls(jsonb_build_object(
        'cover_revision', submitted_album.metadata -> 'cover_revision',
        'cover_selection_origin', submitted_album.metadata -> 'cover_selection_origin',
        'remote_cover_url', submitted_album.metadata -> 'remote_cover_url',
        'remote_cover_thumbnail_url', submitted_album.metadata -> 'remote_cover_thumbnail_url',
        'remote_cover_source', submitted_album.metadata -> 'remote_cover_source',
        'remote_cover_source_label', submitted_album.metadata -> 'remote_cover_source_label',
        'remote_cover_album_url', submitted_album.metadata -> 'remote_cover_album_url',
        'remote_cover_width', submitted_album.metadata -> 'remote_cover_width',
        'remote_cover_height', submitted_album.metadata -> 'remote_cover_height'
      )),
      'track_paths', coalesce(paths.private_paths, array[]::text[])
    ) order by album.id), '[]'::jsonb)
    into v_observed_covers
    from jsonb_to_recordset(coalesce(p_inventory -> 'albums', '[]'::jsonb))
      as submitted_album(
        artist_key text, album_key text, title text, release_year integer,
        cover_path text, metadata jsonb
      )
    join pg_temp.targeted_album_key_map as album_map
      on album_map.input_album_key = submitted_album.album_key
    join library.local_albums as album
      on album.library_id = v_library_id and album.album_key = album_map.target_album_key
    left join lateral (
      select array_agg(file_input.private_path order by file_input.private_path) as private_paths
      from jsonb_to_recordset(coalesce(p_inventory -> 'tracks', '[]'::jsonb))
        as track_input(album_key text, track_key text)
      join jsonb_to_recordset(coalesce(p_inventory -> 'track_files', '[]'::jsonb))
        as file_input(track_key text, private_path text)
        on file_input.track_key = track_input.track_key
      where track_input.album_key = submitted_album.album_key
    ) as paths on true;

    select result.cover_publication_stale, result.cover_mutation_revision
    into v_cover_publication_stale, v_cover_mutation_revision
    from library.apply_scanned_cover_observations(
      v_library_id, v_captured_cover_revision, v_observed_covers, p_now
    ) as result;
    update library.targeted_reconciliation_intents as intent
    set committed_cover_mutation_revision = v_cover_mutation_revision,
        committed_cover_publication_stale = v_cover_publication_stale
    where intent.id = p_intent_id;
    perform library.retire_claimed_targeted_reconciliation_vacated_albums(
      p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token, p_now
    );
    if coalesce(v_is_watcher, false) and not library.complete_watcher_generation(
      p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token, p_now
    ) then
      raise exception 'watcher publication completion fence failed'
        using errcode = '40001';
    end if;
    if coalesce(v_is_watcher, false) then
      perform 1
      from library.targeted_reconciliation_intents as completed
      join library.watcher_generation_participants as participant
        on participant.generation_id = completed.id
      join library.watcher_lanes as lane
        on lane.library_id = participant.library_id
       and lane.root_id = participant.root_id
      where completed.id = p_intent_id
        and completed.watcher_completed_at is not null
        and lane.running_generation_id is null
        and lane.running_job_id is null;
    end if;
  end if;
  return query select
    coalesce(v_publication.publication_won, false),
    v_publication.inventory_mutation_revision,
    coalesce(v_publication.affected_album_keys, array[]::text[]),
    v_cover_publication_stale,
    v_cover_mutation_revision;
end;
$$;

create or replace function ops.validate_durable_worker_startup(
  p_registered_kinds text[]
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  required_functions constant text[] := array[
    'library.full_scan_job_claim_ready(bigint)',
    'library.load_claimed_full_scan_intent_v3(bigint,character varying,character varying)',
    'library.reconcile_due_watcher_generations(timestamp with time zone,integer)',
    'library.dispatch_ready_watcher_generations(timestamp with time zone,integer)',
    'library.load_claimed_watcher_generation(bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_watcher_private_scope(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.fail_claimed_watcher_generation(bigint,bigint,integer,character varying,character varying,character varying,timestamp with time zone)',
    'library.complete_watcher_repair(bigint,bigint,integer,character varying,character varying,bigint,timestamp with time zone)',
    'library.load_watcher_metrics(bigint,timestamp with time zone)',
    'ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamp with time zone)',
    'ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamp with time zone)',
    'ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamp with time zone,text,timestamp with time zone)',
    'ops.requeue_expired_cover_finalization(timestamp with time zone)',
    'ops.reconcile_stale_job_leases(timestamp with time zone,integer)'
  ];
  required record;
begin
  if not ops.validate_durable_worker_startup_baseline_0105(p_registered_kinds) then
    return false;
  end if;
  for required in select pg_catalog.unnest(required_functions) as signature
  loop
    if pg_catalog.to_regprocedure(required.signature) is null
       or not pg_catalog.has_function_privilege(
         session_user, required.signature, 'EXECUTE'
       ) then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function library.publish_claimed_full_scan_inventory_0106(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from public;
revoke all on function library.publish_claimed_targeted_reconciliation_inventory_0106(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from public;
revoke all on function library.apply_scanned_cover_observations(bigint,bigint,jsonb,timestamptz) from public;
revoke all on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from public;
revoke all on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from public;
revoke all on function ops.validate_durable_worker_startup(text[]) from public;

do $scan_privileges$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on function library.publish_claimed_full_scan_inventory_0106(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from album_haven_app;
    revoke all on function library.publish_claimed_targeted_reconciliation_inventory_0106(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from album_haven_app;
    revoke all on function library.apply_scanned_cover_observations(bigint,bigint,jsonb,timestamptz) from album_haven_app;
    revoke all on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from album_haven_app;
    revoke all on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from album_haven_app;
    revoke all on function ops.validate_durable_worker_startup(text[]) from album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on function library.publish_claimed_full_scan_inventory_0106(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from album_haven_worker;
    revoke all on function library.publish_claimed_targeted_reconciliation_inventory_0106(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from album_haven_worker;
    revoke all on function library.apply_scanned_cover_observations(bigint,bigint,jsonb,timestamptz) from album_haven_worker;
    revoke all on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from album_haven_worker;
    revoke all on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from album_haven_worker;
    revoke all on function ops.validate_durable_worker_startup(text[]) from album_haven_worker;
    grant execute on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) to album_haven_worker;
    grant execute on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) to album_haven_worker;
    grant execute on function ops.validate_durable_worker_startup(text[]) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function library.publish_claimed_full_scan_inventory_0106(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from album_haven_readonly;
    revoke all on function library.publish_claimed_targeted_reconciliation_inventory_0106(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from album_haven_readonly;
    revoke all on function library.apply_scanned_cover_observations(bigint,bigint,jsonb,timestamptz) from album_haven_readonly;
    revoke all on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from album_haven_readonly;
    revoke all on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from album_haven_readonly;
    revoke all on function ops.validate_durable_worker_startup(text[]) from album_haven_readonly;
  end if;
end;
$scan_privileges$;

revoke all on table library.cover_mutation_state from public;
revoke all on function library.read_cover_mutation_revision(bigint) from public;
revoke all on function library.resolve_cover_mutation_identity(bigint,text[]) from public;
revoke all on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) from public;
revoke all on function library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,text,bigint,integer,text,text,bigint,bigint,timestamptz) from public;
revoke all on function library.apply_scanned_cover_observations(bigint,bigint,jsonb,timestamptz) from public;
revoke all on function library.persist_authorized_structural_tag_edit_noncover(bigint,text[],bigint,jsonb,jsonb,text[],timestamptz) from public;
revoke all on function library.capture_scan_intent_cover_revision() from public;
revoke all on function library.load_claimed_full_scan_intent_v3(bigint,character varying,character varying) from public;
revoke all on function library.load_claimed_targeted_reconciliation_intent_v2(bigint,character varying,character varying) from public;
revoke all on function ops.checkpoint_claimed_cover_remote_save(bigint,bigint,integer,text,text,timestamptz,bigint,text,uuid,text,text,text) from public;
revoke all on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) from public;
revoke all on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) from public;
revoke all on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) from public;
revoke all on function ops.requeue_expired_cover_finalization(timestamptz) from public;
revoke all on function ops.reconcile_stale_job_leases(timestamptz,integer) from public;
revoke all on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) from public;
revoke all on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) from public;

do $privileges$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table library.cover_mutation_state from album_haven_app;
    revoke all on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) from album_haven_app;
    revoke all on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) from album_haven_app;
    revoke all on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) from album_haven_app;
    revoke all on function ops.requeue_expired_cover_finalization(timestamptz) from album_haven_app;
    revoke all on function ops.reconcile_stale_job_leases(timestamptz,integer) from album_haven_app;
    grant execute on function library.read_cover_mutation_revision(bigint) to album_haven_app;
    grant execute on function library.resolve_cover_mutation_identity(bigint,text[]) to album_haven_app;
    grant execute on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_app;
    grant execute on function library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_app;
    grant execute on function library.persist_authorized_structural_tag_edit_noncover(bigint,text[],bigint,jsonb,jsonb,text[],timestamptz) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on table library.cover_mutation_state from album_haven_worker;
    grant execute on function library.read_cover_mutation_revision(bigint) to album_haven_worker;
    grant execute on function library.resolve_cover_mutation_identity(bigint,text[]) to album_haven_worker;
    grant execute on function library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,text,text,text,text,boolean,jsonb,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_worker;
    grant execute on function library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,text,bigint,integer,text,text,bigint,bigint,timestamptz) to album_haven_worker;
    grant execute on function library.load_claimed_full_scan_intent_v3(bigint,character varying,character varying) to album_haven_worker;
    grant execute on function library.load_claimed_targeted_reconciliation_intent_v2(bigint,character varying,character varying) to album_haven_worker;
    grant execute on function ops.checkpoint_claimed_cover_remote_save(bigint,bigint,integer,text,text,timestamptz,bigint,text,uuid,text,text,text) to album_haven_worker;
    grant execute on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) to album_haven_worker;
    grant execute on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) to album_haven_worker;
    grant execute on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) to album_haven_worker;
    grant execute on function ops.requeue_expired_cover_finalization(timestamptz) to album_haven_worker;
    grant execute on function ops.reconcile_stale_job_leases(timestamptz,integer) to album_haven_worker;
    grant execute on function library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz) to album_haven_worker;
    grant execute on function library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,varchar,varchar,jsonb,jsonb,timestamptz) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table library.cover_mutation_state from album_haven_readonly;
    revoke all on function ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz) from album_haven_readonly;
    revoke all on function ops.advance_claimed_cover_finalization(bigint,bigint,integer,text,text,bigint,text,timestamptz) from album_haven_readonly;
    revoke all on function ops.retry_claimed_cover_finalization(bigint,integer,text,text,timestamptz,text,timestamptz) from album_haven_readonly;
    revoke all on function ops.requeue_expired_cover_finalization(timestamptz) from album_haven_readonly;
    revoke all on function ops.reconcile_stale_job_leases(timestamptz,integer) from album_haven_readonly;
    grant execute on function library.read_cover_mutation_revision(bigint) to album_haven_readonly;
  end if;
end;
$privileges$;

-- Legacy overload retained only so an old claimed worker can drain. It cannot
-- enter a post-commit checkpoint because the typed overload requires a digest.
create or replace function ops.checkpoint_claimed_cover_remote_save(
  requested_checkpoint_id bigint,
  requested_job_id bigint,
  requested_attempt integer,
  requested_worker_id text,
  requested_lease_token text,
  observed_at timestamptz,
  expected_row_revision bigint,
  next_checkpoint text,
  next_artifact_key uuid,
  next_cover_revision text,
  next_reason_code text
)
returns bigint
language sql
security definer
set search_path = pg_catalog, ops
as $function$
  select ops.checkpoint_claimed_cover_remote_save(
    requested_checkpoint_id,
    requested_job_id,
    requested_attempt,
    requested_worker_id,
    requested_lease_token,
    observed_at,
    expected_row_revision,
    next_checkpoint,
    next_artifact_key,
    null,
    next_cover_revision,
    next_reason_code
  );
$function$;
