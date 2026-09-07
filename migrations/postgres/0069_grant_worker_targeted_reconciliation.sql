alter table library.targeted_reconciliation_intents
  add column if not exists publication_attempt integer,
  add column if not exists committed_inventory_revision bigint,
  add column if not exists affected_album_keys text[] not null default array[]::text[],
  add column if not exists accepted_primary_root_path text;

alter table library.targeted_reconciliation_intent_moves
  add column if not exists accepted_source_root_path text,
  add column if not exists accepted_destination_root_path text;

update library.targeted_reconciliation_intents as intent
   set accepted_primary_root_path = root.root_path
  from library.library_roots as root
 where root.id = intent.primary_root_id
   and intent.accepted_primary_root_path is null;

update library.targeted_reconciliation_intent_moves as move
   set accepted_source_root_path = source_root.root_path,
       accepted_destination_root_path = destination_root.root_path
  from library.library_roots as source_root,
       library.library_roots as destination_root
 where source_root.id = move.source_root_id
   and destination_root.id = move.destination_root_id
   and (move.accepted_source_root_path is null
        or move.accepted_destination_root_path is null);

alter table library.targeted_reconciliation_intents
  alter column accepted_primary_root_path set not null;
alter table library.targeted_reconciliation_intent_moves
  alter column accepted_source_root_path set not null,
  alter column accepted_destination_root_path set not null;

create or replace function library.capture_targeted_intent_root_path()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  select root.root_path into new.accepted_primary_root_path
    from library.library_roots as root
   where root.id = new.primary_root_id
     and root.library_id = new.library_id
     and root.is_active is true;
  if new.accepted_primary_root_path is null then
    raise exception 'targeted reconciliation primary root is invalid';
  end if;
  return new;
end;
$$;

drop trigger if exists targeted_intents_capture_root_path
  on library.targeted_reconciliation_intents;
create trigger targeted_intents_capture_root_path
before insert or update of primary_root_id
on library.targeted_reconciliation_intents
for each row execute function library.capture_targeted_intent_root_path();

create or replace function library.capture_targeted_move_root_paths()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  select source_root.root_path, destination_root.root_path
    into new.accepted_source_root_path, new.accepted_destination_root_path
    from library.library_roots as source_root,
         library.library_roots as destination_root
   where source_root.id = new.source_root_id
     and source_root.library_id = (
       select intent.library_id
         from library.targeted_reconciliation_intents as intent
        where intent.id = new.intent_id
     )
     and source_root.is_active is true
     and destination_root.id = new.destination_root_id
     and destination_root.library_id = source_root.library_id
     and destination_root.is_active is true;
  if new.accepted_source_root_path is null
     or new.accepted_destination_root_path is null then
    raise exception 'targeted reconciliation move roots are invalid';
  end if;
  return new;
end;
$$;

drop trigger if exists targeted_moves_capture_root_paths
  on library.targeted_reconciliation_intent_moves;
create trigger targeted_moves_capture_root_paths
before insert or update of source_root_id, destination_root_id
on library.targeted_reconciliation_intent_moves
for each row execute function library.capture_targeted_move_root_paths();

create or replace function library.load_claimed_targeted_reconciliation_scope(
  p_intent_id bigint,
  p_library_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  logical_root_id text,
  root_path text,
  root_kind text,
  library_id bigint,
  is_active boolean,
  root_healthy boolean,
  scope_complete boolean
)
language sql
security definer
set search_path = pg_catalog
as $$
  with claimed_intent as (
    select intent.id, intent.library_id, intent.primary_root_id,
           intent.accepted_primary_root_path
      from library.targeted_reconciliation_intents as intent
      join ops.jobs as job on job.id = intent.job_id
     where intent.id = p_intent_id
       and intent.library_id = p_library_id
       and intent.job_id = p_job_id
       and intent.state = 'running'
       and job.id = p_job_id
       and job.kind = 'targeted_reconciliation'
       and job.subject_kind = 'targeted_reconciliation_intent'
       and job.subject_ref = p_intent_id::text
       and job.library_id = p_library_id
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now
  ), scoped_root_refs as (
    select claimed_intent.id as intent_id, claimed_intent.library_id,
           accepted_root.metadata ->> 'root_id' as logical_root_id
      from claimed_intent
      join library.library_roots as accepted_root
        on accepted_root.id = claimed_intent.primary_root_id
    union
    select claimed_intent.id, claimed_intent.library_id,
           accepted_root.metadata ->> 'root_id'
      from claimed_intent
      join library.targeted_reconciliation_intent_moves as move
        on move.intent_id = claimed_intent.id
      join library.library_roots as accepted_root
        on accepted_root.id = move.source_root_id
    union
    select claimed_intent.id, claimed_intent.library_id,
           accepted_root.metadata ->> 'root_id'
      from claimed_intent
      join library.targeted_reconciliation_intent_moves as move
        on move.intent_id = claimed_intent.id
      join library.library_roots as accepted_root
        on accepted_root.id = move.destination_root_id
  )
  select root.metadata ->> 'root_id' as logical_root_id,
         root.root_path,
         root.root_kind,
         root.library_id,
         root.is_active,
         not coalesce(library_record.metadata -> 'library_watch_health', '{}'::jsonb)
               ? (root.metadata ->> 'root_id') as root_healthy,
         count(*) over () = (
           select count(*) from scoped_root_refs
         ) as scope_complete
    from scoped_root_refs
    join library.library_roots as root
      on root.library_id = scoped_root_refs.library_id
     and root.metadata ->> 'root_id' = scoped_root_refs.logical_root_id
     and root.is_active is true
    join library.libraries as library_record
      on library_record.id = scoped_root_refs.library_id
   where nullif(btrim(root.metadata ->> 'root_id'), '') is not null
   order by root.id;
$$;

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
  moves jsonb,
  exception_overrides jsonb
)
language sql
security definer
set search_path = pg_catalog
as $$
  with claimed as (
    select intent.id, intent.library_id, intent.primary_root_id,
           intent.accepted_primary_root_path
      from ops.jobs as job
      join library.targeted_reconciliation_intents as intent
        on intent.job_id = job.id
     where job.id = p_job_id
       and job.kind = 'targeted_reconciliation'
       and job.state = 'running'
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > now()
  ), primary_roots as (
    select claimed.id as intent_id, claimed.library_id,
           claimed.accepted_primary_root_path as accepted_path,
           accepted.metadata ->> 'root_id' as logical_root_id,
           current.root_path as current_path
      from claimed
      join library.library_roots as accepted
        on accepted.id = claimed.primary_root_id
      join library.library_roots as current
        on current.library_id = claimed.library_id
       and current.metadata ->> 'root_id' = accepted.metadata ->> 'root_id'
       and current.is_active is true
  )
  select claimed.id,
         claimed.library_id,
         primary_roots.logical_root_id,
         coalesce(array_agg(
           case when library.local_path_key(path.path) = library.local_path_key(primary_roots.accepted_path)
                  or left(
                    library.local_path_key(path.path),
                    char_length(library.local_path_key(primary_roots.accepted_path)) + 1
                  ) = library.local_path_key(primary_roots.accepted_path) || case library.local_path_style(primary_roots.accepted_path) when 'windows' then E'\\' else '/' end
                then primary_roots.current_path || substring(path.path from char_length(primary_roots.accepted_path) + 1)
                else path.path end
           order by path.ordinal
         ) filter (where path.path_kind = 'active'), array[]::text[]),
         coalesce(array_agg(
           case when library.local_path_key(path.path) = library.local_path_key(primary_roots.accepted_path)
                  or left(
                    library.local_path_key(path.path),
                    char_length(library.local_path_key(primary_roots.accepted_path)) + 1
                  ) = library.local_path_key(primary_roots.accepted_path) || case library.local_path_style(primary_roots.accepted_path) when 'windows' then E'\\' else '/' end
                then primary_roots.current_path || substring(path.path from char_length(primary_roots.accepted_path) + 1)
                else path.path end
           order by path.ordinal
         ) filter (where path.path_kind = 'deleted'), array[]::text[]),
         coalesce(array_agg(
           case when library.local_path_key(path.path) = library.local_path_key(primary_roots.accepted_path)
                  or left(
                    library.local_path_key(path.path),
                    char_length(library.local_path_key(primary_roots.accepted_path)) + 1
                  ) = library.local_path_key(primary_roots.accepted_path) || case library.local_path_style(primary_roots.accepted_path) when 'windows' then E'\\' else '/' end
                then primary_roots.current_path || substring(path.path from char_length(primary_roots.accepted_path) + 1)
                else path.path end
           order by path.ordinal
         ) filter (where path.path_kind = 'deleted_subtree'), array[]::text[]),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'source_path', case
               when library.local_path_key(move.source_path) = library.local_path_key(move.accepted_source_root_path)
                 or left(library.local_path_key(move.source_path), char_length(library.local_path_key(move.accepted_source_root_path)) + 1) = library.local_path_key(move.accepted_source_root_path) || case library.local_path_style(move.accepted_source_root_path) when 'windows' then E'\\' else '/' end
               then current_source.root_path || substring(move.source_path from char_length(move.accepted_source_root_path) + 1)
               else move.source_path end,
             'destination_path', case
               when library.local_path_key(move.destination_path) = library.local_path_key(move.accepted_destination_root_path)
                 or left(library.local_path_key(move.destination_path), char_length(library.local_path_key(move.accepted_destination_root_path)) + 1) = library.local_path_key(move.accepted_destination_root_path) || case library.local_path_style(move.accepted_destination_root_path) when 'windows' then E'\\' else '/' end
               then current_destination.root_path || substring(move.destination_path from char_length(move.accepted_destination_root_path) + 1)
               else move.destination_path end,
             'source_root_ref', accepted_source.metadata ->> 'root_id',
             'destination_root_ref', accepted_destination.metadata ->> 'root_id',
             'is_directory', move.is_directory
           ) order by move.ordinal)
             from library.targeted_reconciliation_intent_moves as move
             join library.library_roots as accepted_source
               on accepted_source.id = move.source_root_id
             join library.library_roots as accepted_destination
               on accepted_destination.id = move.destination_root_id
             join library.library_roots as current_source
               on current_source.library_id = claimed.library_id
              and current_source.metadata ->> 'root_id' = accepted_source.metadata ->> 'root_id'
              and current_source.is_active is true
             join library.library_roots as current_destination
               on current_destination.library_id = claimed.library_id
              and current_destination.metadata ->> 'root_id' = accepted_destination.metadata ->> 'root_id'
              and current_destination.is_active is true
            where move.intent_id = claimed.id
         ), '[]'::jsonb),
         coalesce((
           select jsonb_object_agg(
                    case
                      when library.local_path_key(exception.track_key) = library.local_path_key(authorized.accepted_root_path)
                        or left(library.local_path_key(exception.track_key), char_length(library.local_path_key(authorized.accepted_root_path)) + 1) = library.local_path_key(authorized.accepted_root_path) || case library.local_path_style(authorized.accepted_root_path) when 'windows' then E'\\' else '/' end
                      then authorized.current_root_path || substring(exception.track_key from char_length(authorized.accepted_root_path) + 1)
                      else exception.track_key
                    end,
                    case
                      when exception.override_payload ? 'exception_type'
                      then coalesce(exception.override_payload ->> 'exception_type', '')
                      when jsonb_typeof(exception.override_payload) = 'string'
                      then coalesce(exception.override_payload #>> '{}', '')
                      else ''
                    end
                  )
             from library.exception_overrides as exception
             join lateral (
               select scoped.accepted_root_path, scoped.current_root_path
                 from (
                   select primary_roots.accepted_path as accepted_root_path,
                          primary_roots.current_path as current_root_path,
                          event_path.path as accepted_event_path
                     from library.targeted_reconciliation_intent_paths as event_path
                    where event_path.intent_id = claimed.id
                      and event_path.path_kind = 'active'
                   union all
                   select event_move.accepted_destination_root_path,
                          current_destination.root_path,
                          event_move.destination_path
                     from library.targeted_reconciliation_intent_moves as event_move
                     join library.library_roots as accepted_destination
                       on accepted_destination.id = event_move.destination_root_id
                     join library.library_roots as current_destination
                       on current_destination.library_id = claimed.library_id
                      and current_destination.metadata ->> 'root_id'
                            = accepted_destination.metadata ->> 'root_id'
                      and current_destination.is_active is true
                    where event_move.intent_id = claimed.id
                 ) as scoped
                where regexp_replace(
                        case library.local_path_style(exception.track_key)
                          when 'windows' then lower(replace(exception.track_key, E'\\', '/'))
                          else replace(exception.track_key, E'\\', '/')
                        end,
                        '/[^/]*$', ''
                      ) = regexp_replace(
                        case library.local_path_style(scoped.accepted_event_path)
                          when 'windows' then lower(replace(scoped.accepted_event_path, E'\\', '/'))
                          else replace(scoped.accepted_event_path, E'\\', '/')
                        end,
                        '/[^/]*$', ''
                      )
                order by scoped.accepted_root_path, scoped.current_root_path
                limit 1
             ) as authorized on true
            where exception.library_id = claimed.library_id
              and nullif(btrim(exception.track_key), '') is not null
         ), '{}'::jsonb)
    from claimed
    join primary_roots on primary_roots.intent_id = claimed.id
    left join library.targeted_reconciliation_intent_paths as path
      on path.intent_id = claimed.id
   group by claimed.id, claimed.library_id, primary_roots.logical_root_id,
            primary_roots.accepted_path, primary_roots.current_path;
$$;

create or replace function library.fence_targeted_reconciliation_publication(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  publication_won boolean := false;
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null or
     p_worker_id is null or p_lease_token is null or p_now is null then
    return false;
  end if;

  perform 1
    from ops.jobs as job
   where job.id = p_job_id
     and job.kind = 'targeted_reconciliation'
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now
   for update;
  if not found then
    return false;
  end if;

  update library.targeted_reconciliation_intents as intent
     set publication_attempt = p_attempt,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id
     and intent.job_id = p_job_id
     and intent.state = 'running'
     and intent.publication_attempt is null;
  publication_won := found;
  return publication_won;
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
         loaded.deleted_subtrees, loaded.moves
    into authorized_primary_root_id, authorized_active_paths,
         authorized_deleted_paths, authorized_deleted_subtrees,
         authorized_moves
    from library.load_claimed_targeted_reconciliation_intent_v2(
      p_job_id, p_worker_id, p_lease_token
    ) as loaded;
  if not found then
    return query select false, null::bigint, array[]::text[];
    return;
  end if;

  if exists (
    with allowed_active as (
      select authorized_primary_root_id as root_id, path
        from unnest(coalesce(authorized_active_paths, array[]::text[])) as item(path)
      union all
      select move ->> 'destination_root_ref', move ->> 'destination_path'
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
           where regexp_replace(
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
    library_id, artist_id, album_key, title, release_year, cover_path, metadata
  )
  select claimed_library_id, artist.id, album_map.target_album_key, input.title,
         input.release_year, input.cover_path, input.metadata
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
        cover_path = case
          when library.local_albums.metadata ->> 'cover_selection_origin' = 'user'
          then library.local_albums.cover_path else excluded.cover_path end,
        last_seen_at = now(),
        metadata = library.local_albums.metadata || case
          when library.local_albums.metadata ->> 'cover_selection_origin' = 'user'
          then excluded.metadata - array['cover_revision', 'cover_selection_origin']
          else excluded.metadata end;

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
         to_timestamp(input.modified_at_epoch), input.metadata
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
        metadata = (library.local_track_files.metadata || excluded.metadata)
                     #- '{scan_cache,stale_marked_at}';

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
                  'source', 'scan_cache', 'stale', true,
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
     and file.metadata #>> '{scan_cache,source}' = 'scan_cache'
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

revoke all on function library.load_claimed_targeted_reconciliation_scope(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.load_claimed_targeted_reconciliation_intent_v2(bigint, varchar, varchar) from public;
revoke all on function library.fence_targeted_reconciliation_publication(bigint, bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.publish_claimed_targeted_reconciliation(bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke select (id, is_active, disabled_at)
      on table app.accounts from album_haven_worker;
    revoke select (account_id, owner_key)
      on table app.bootstrap_owners from album_haven_worker;
    revoke select (id, owner_account_id)
      on table library.libraries from album_haven_worker;
    revoke select (library_id, account_id, membership_role)
      on table library.library_memberships from album_haven_worker;
    revoke select (account_id, capability_key, scope_kind, scope_id, revoked_at)
      on table app.capabilities from album_haven_worker;
    revoke select (id, account_id, client_surface_class, origin_type)
      on table app.request_origins from album_haven_worker;
    grant execute on function library.load_claimed_targeted_reconciliation_scope(bigint, bigint, bigint, integer, varchar, varchar, timestamptz) to album_haven_worker;
    grant execute on function library.load_claimed_targeted_reconciliation_intent_v2(bigint, varchar, varchar) to album_haven_worker;
    grant execute on function library.fence_targeted_reconciliation_publication(bigint, bigint, integer, varchar, varchar, timestamptz) to album_haven_worker;
    grant execute on function library.publish_claimed_targeted_reconciliation(bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz) to album_haven_worker;
  end if;
end $$;
