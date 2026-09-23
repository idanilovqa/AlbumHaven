create or replace function library.retire_vacated_structural_album(
  p_library_id bigint,
  p_source_album_id bigint,
  p_destination_album_id bigint,
  p_source_album_key text,
  p_destination_album_key text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  locked_count integer;
  deleted_count integer;
begin
  if p_library_id is null or p_source_album_id is null
     or p_destination_album_id is null
     or p_source_album_id = p_destination_album_id
     or nullif(btrim(p_source_album_key), '') is null
     or nullif(btrim(p_destination_album_key), '') is null then
    raise exception 'invalid structural album retirement identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:structural-album-retirement:' || p_library_id::text,
      0
    )
  );

  perform library.local_albums.id
  from library.local_albums
  where library.local_albums.library_id = p_library_id
    and library.local_albums.id in (
      p_source_album_id, p_destination_album_id
    )
  order by library.local_albums.id
  for update;

  select count(*) into locked_count
  from library.local_albums
  where library.local_albums.library_id = p_library_id
    and (
      (library.local_albums.id = p_source_album_id
       and library.local_albums.album_key = p_source_album_key)
      or
      (library.local_albums.id = p_destination_album_id
       and library.local_albums.album_key = p_destination_album_key)
    );
  if locked_count <> 2 then
    raise exception 'structural album retirement identity changed';
  end if;

  if exists (
    select 1 from library.local_tracks
    where library.local_tracks.library_id = p_library_id
      and library.local_tracks.album_id = p_source_album_id
  ) then
    return 'preserved_track_tombstone';
  end if;
  if exists (
    select 1 from ops.cover_remote_save_checkpoints
    where ops.cover_remote_save_checkpoints.library_id = p_library_id
      and ops.cover_remote_save_checkpoints.local_album_id = p_source_album_id
      and ops.cover_remote_save_checkpoints.checkpoint not in ('publication_completed', 'rolled_back', 'ambiguous')
  ) then
    return 'preserved_cover_checkpoint';
  end if;

  insert into app.album_ratings (
    account_id, library_id, album_key, rating, provenance,
    created_at, updated_at, metadata
  )
  select account_id, library_id, p_destination_album_key, rating, provenance,
         created_at, updated_at, metadata
  from app.album_ratings
  where library_id = p_library_id and album_key = p_source_album_key
  on conflict (account_id, library_id, album_key) do update
  set rating = coalesce(app.album_ratings.rating, excluded.rating),
      provenance = case
        when app.album_ratings.rating is null and excluded.rating is not null
        then excluded.provenance else app.album_ratings.provenance end,
      created_at = least(app.album_ratings.created_at, excluded.created_at),
      updated_at = greatest(app.album_ratings.updated_at, excluded.updated_at),
      metadata = excluded.metadata || app.album_ratings.metadata;

  delete from app.album_ratings
  where library_id = p_library_id and album_key = p_source_album_key;

  insert into library.local_album_featured_artists (
    library_id, album_id, artist_id, featured_kind,
    first_seen_at, last_seen_at, metadata
  )
  select library_id, p_destination_album_id, artist_id, featured_kind,
         first_seen_at, last_seen_at, metadata
  from library.local_album_featured_artists
  where library_id = p_library_id and album_id = p_source_album_id
  on conflict (library_id, album_id, artist_id, featured_kind) do update
  set first_seen_at = least(
        library.local_album_featured_artists.first_seen_at,
        excluded.first_seen_at
      ),
      last_seen_at = greatest(
        library.local_album_featured_artists.last_seen_at,
        excluded.last_seen_at
      ),
      metadata = excluded.metadata || library.local_album_featured_artists.metadata;

  delete from library.local_album_featured_artists
  where library_id = p_library_id and album_id = p_source_album_id;

  update library.local_mbid_assertions
  set album_id = p_destination_album_id,
      target_key = case when target_kind = 'album'
                        then p_destination_album_key else target_key end
  where library_id = p_library_id and album_id = p_source_album_id;

  insert into library.ignored_versions (
    library_id, version_key, created_at, metadata
  )
  select library_id, p_destination_album_key, created_at, metadata
  from library.ignored_versions
  where library_id = p_library_id and version_key = p_source_album_key
  on conflict (library_id, version_key) do update
  set created_at = least(library.ignored_versions.created_at, excluded.created_at),
      metadata = excluded.metadata || library.ignored_versions.metadata;

  delete from library.ignored_versions
  where library_id = p_library_id and version_key = p_source_album_key;

  insert into library.manual_versions (
    library_id, child_key, parent_key, created_at, updated_at, metadata
  )
  select distinct on (mapped.library_id, mapped.child_key)
    mapped.library_id, mapped.child_key, mapped.parent_key,
    mapped.created_at, mapped.updated_at, mapped.metadata
  from (
    select library_id,
      case when child_key = p_source_album_key
           then p_destination_album_key else child_key end as child_key,
      case when parent_key = p_source_album_key
           then p_destination_album_key else parent_key end as parent_key,
      child_key as original_child_key, created_at, updated_at, metadata
    from library.manual_versions
    where library_id = p_library_id
      and (child_key = p_source_album_key or parent_key = p_source_album_key)
  ) as mapped
  where mapped.child_key <> mapped.parent_key
  order by mapped.library_id, mapped.child_key,
           (mapped.original_child_key = mapped.child_key) desc,
           mapped.updated_at desc
  on conflict (library_id, child_key) do update
  set parent_key = excluded.parent_key,
      created_at = least(library.manual_versions.created_at, excluded.created_at),
      updated_at = greatest(library.manual_versions.updated_at, excluded.updated_at),
      metadata = excluded.metadata || library.manual_versions.metadata;

  delete from library.manual_versions
  where library_id = p_library_id
    and (child_key = p_source_album_key or parent_key = p_source_album_key);

  update ops.cover_lookup_tasks
  set local_album_id = p_destination_album_id,
      album_key = p_destination_album_key
  where library_id = p_library_id and local_album_id = p_source_album_id;

  update ops.cover_remote_save_checkpoints
  set local_album_id = p_destination_album_id
  where library_id = p_library_id
    and local_album_id = p_source_album_id
    and ops.cover_remote_save_checkpoints.checkpoint in ('publication_completed', 'rolled_back', 'ambiguous');

  delete from library.local_album_cover_candidate_snapshots
  where album_id = p_source_album_id
    and exists (
      select 1 from library.local_album_cover_candidate_snapshots
      where album_id = p_destination_album_id
    );
  update library.local_album_cover_candidate_snapshots
  set album_id = p_destination_album_id
  where album_id = p_source_album_id;

  delete from library.local_albums
  where library_id = p_library_id and id = p_source_album_id;
  get diagnostics deleted_count = row_count;
  if deleted_count <> 1 then
    raise exception 'structural album retirement did not converge';
  end if;
  return 'retired';
end;
$$;

create or replace function library.retire_vacated_structural_album_siblings(
  p_library_id bigint,
  p_destination_album_id bigint
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  destination library.local_albums%rowtype;
  candidate_row record;
  disposition text;
  retired_count integer := 0;
begin
  if p_library_id is null or p_destination_album_id is null then
    raise exception 'invalid structural album sibling retirement identity';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:structural-album-retirement:' || p_library_id::text,
      0
    )
  );

  select destination_row.* into destination
  from library.local_albums as destination_row
  where destination_row.library_id = p_library_id
    and destination_row.id = p_destination_album_id;

  if not found
     or destination.artist_id is null
     or nullif(btrim(destination.title), '') is null then
    raise exception 'structural album sibling destination is invalid';
  end if;

  -- The library advisory lock serializes discovery; row locks are acquired in
  -- candidate ID order before any dependent rows are moved.
  for candidate_row in
    select candidate_album.id, candidate_album.album_key
    from library.local_albums as candidate_album
    where candidate_album.library_id = destination.library_id
      and candidate_album.id <> destination.id
      and candidate_album.artist_id = destination.artist_id
      and lower(btrim(candidate_album.title)) = lower(btrim(destination.title))
      and candidate_album.release_year is not distinct from destination.release_year
      and lower(btrim(coalesce(candidate_album.metadata ->> 'edition', ''))) =
          lower(btrim(coalesce(destination.metadata ->> 'edition', '')))
      and not exists (
        select 1 from library.local_tracks
        where library.local_tracks.library_id = candidate_album.library_id
          and library.local_tracks.album_id = candidate_album.id
      )
    order by candidate_album.id
    for update of candidate_album
  loop
    disposition := library.retire_vacated_structural_album(
      p_library_id,
      candidate_row.id,
      destination.id,
      candidate_row.album_key,
      destination.album_key
    );
    if disposition = 'retired' then
      retired_count := retired_count + 1;
    elsif disposition not in (
      'preserved_track_tombstone',
      'preserved_cover_checkpoint'
    ) then
      raise exception 'structural album sibling retirement did not converge';
    end if;
  end loop;

  return retired_count;
end;
$$;

create or replace function library.retire_claimed_targeted_reconciliation_vacated_albums(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  claimed_library_id bigint;
  claimed_album_keys text[];
  destination_row record;
  retired_count integer := 0;
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null
     or p_worker_id is null or p_lease_token is null or p_now is null then
    raise exception 'targeted album retirement claim is invalid';
  end if;

  select job.library_id, intent.affected_album_keys
    into claimed_library_id, claimed_album_keys
  from ops.jobs as job
  join library.targeted_reconciliation_intents as intent
    on intent.id = p_intent_id
   and intent.job_id = job.id
   and intent.library_id = job.library_id
  where job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > p_now
    and intent.state = 'running'
    and intent.publication_attempt = p_attempt
    and intent.committed_inventory_revision is not null
  for update of job, intent;

  if not found or claimed_library_id is null then
    raise exception 'targeted album retirement lease is not current';
  end if;
  if cardinality(coalesce(claimed_album_keys, array[]::text[])) > 4096 then
    raise exception 'targeted album retirement scope is too large';
  end if;

  for destination_row in
    select album.id
    from unnest(coalesce(claimed_album_keys, array[]::text[])) as affected(album_key)
    join library.local_albums as album
      on album.library_id = claimed_library_id
     and album.album_key = affected.album_key
    order by album.id
  loop
    retired_count := retired_count
      + library.retire_vacated_structural_album_siblings(
          claimed_library_id,
          destination_row.id
        );
  end loop;

  return retired_count;
end;
$$;

revoke all on function library.retire_vacated_structural_album(
  bigint, bigint, bigint, text, text
) from public;

revoke all on function library.retire_vacated_structural_album_siblings(
  bigint, bigint
) from public;

revoke all on function library.retire_claimed_targeted_reconciliation_vacated_albums(
  bigint, bigint, integer, varchar, varchar, timestamptz
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.retire_vacated_structural_album(
      bigint, bigint, bigint, text, text
    ) to album_haven_app;
    grant execute on function library.retire_vacated_structural_album_siblings(
      bigint, bigint
    ) to album_haven_app;
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function library.retire_claimed_targeted_reconciliation_vacated_albums(
      bigint, bigint, integer, varchar, varchar, timestamptz
    ) to album_haven_worker;
  end if;
end
$$;
