-- Keep public scan status authoritative across durable publication handoffs.

alter table library.full_scan_intents
  add column if not exists progress_elapsed_seconds double precision not null default 0,
  add column if not exists progress_estimated_remaining_seconds double precision not null default 0,
  add column if not exists progress_files_per_second double precision not null default 0,
  add column if not exists progress_album_folders_processed bigint not null default 0,
  add column if not exists progress_album_folders_total bigint not null default 0,
  add column if not exists preview_file_cache jsonb,
  add column if not exists preview_separate_release_keys text[],
  add column if not exists preview_album_total bigint,
  add column if not exists preview_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'library.full_scan_intents'::regclass
       and conname = 'full_scan_intents_progress_metrics_valid'
  ) then
    alter table library.full_scan_intents
      add constraint full_scan_intents_progress_metrics_valid check (
        progress_elapsed_seconds >= 0 and progress_elapsed_seconds <> 'NaN'::float8 and
        progress_estimated_remaining_seconds >= 0 and
        progress_estimated_remaining_seconds <> 'NaN'::float8 and
        progress_files_per_second >= 0 and
        progress_files_per_second <> 'NaN'::float8 and
        progress_album_folders_processed >= 0 and
        progress_album_folders_total >= progress_album_folders_processed
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'library.full_scan_intents'::regclass
       and conname = 'full_scan_intents_preview_shape_valid'
  ) then
    alter table library.full_scan_intents
      add constraint full_scan_intents_preview_shape_valid check (
        (preview_file_cache is null or jsonb_typeof(preview_file_cache) = 'object')
        and (preview_album_total is null or preview_album_total >= 0)
      );
  end if;
end $$;

create or replace function library.checkpoint_claimed_full_scan_v2(
  p_intent_id bigint, p_job_id bigint, p_attempt integer,
  p_worker_id varchar, p_lease_token varchar, p_phase varchar,
  p_progress_current bigint, p_progress_total bigint, p_current_path text,
  p_now timestamptz, p_elapsed_seconds double precision,
  p_estimated_remaining_seconds double precision, p_files_per_second double precision,
  p_album_folders_processed bigint, p_album_folders_total bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_elapsed_seconds < 0 or p_elapsed_seconds = 'NaN'::float8 or
     p_estimated_remaining_seconds < 0 or
     p_estimated_remaining_seconds = 'NaN'::float8 or
     p_files_per_second < 0 or p_files_per_second = 'NaN'::float8 or
     p_album_folders_processed < 0 or
     p_album_folders_total < p_album_folders_processed then
    return false;
  end if;
  if not library.checkpoint_claimed_full_scan(
    p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token, p_phase,
    p_progress_current, p_progress_total, p_current_path, p_now
  ) then
    return false;
  end if;
  update library.full_scan_intents
     set progress_elapsed_seconds = greatest(progress_elapsed_seconds, p_elapsed_seconds),
         progress_estimated_remaining_seconds = p_estimated_remaining_seconds,
         progress_files_per_second = p_files_per_second,
         progress_album_folders_processed = greatest(
           progress_album_folders_processed, p_album_folders_processed
         ),
         progress_album_folders_total = greatest(
           progress_album_folders_total, p_album_folders_total
         )
   where id = p_intent_id and job_id = p_job_id
     and execution_attempt = p_attempt and state = 'running';
  return found;
end;
$$;

create or replace function library.publish_claimed_full_scan_preview(
  p_intent_id bigint, p_job_id bigint, p_attempt integer,
  p_worker_id varchar, p_lease_token varchar,
  p_file_cache jsonb, p_separate_release_keys text[], p_album_total bigint,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_intent_id is null or p_job_id is null or p_attempt is null or
     p_worker_id is null or p_lease_token is null or p_now is null or
     p_file_cache is null or jsonb_typeof(p_file_cache) <> 'object' or
     p_separate_release_keys is null or p_album_total is null or
     p_album_total < 0 then
    return false;
  end if;

  perform 1
    from ops.jobs as job
   where job.id = p_job_id
     and job.kind = 'full_scan'
     and job.subject_kind = 'full_scan_intent'
     and job.subject_ref = p_intent_id::text
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now
   for update;
  if not found then
    return false;
  end if;

  update library.full_scan_intents as intent
     set preview_file_cache = p_file_cache,
         preview_separate_release_keys = p_separate_release_keys,
         preview_album_total = p_album_total,
         preview_updated_at = p_now,
         updated_at = greatest(intent.updated_at, p_now)
   where intent.id = p_intent_id
     and intent.job_id = p_job_id
     and intent.state = 'running'
     and intent.execution_attempt = p_attempt
     and intent.committed_inventory_revision is null
     and (intent.preview_updated_at is null or intent.preview_updated_at <= p_now);
  return found;
end;
$$;

create or replace function library.load_claimed_full_scan_cache(
  p_intent_id bigint, p_job_id bigint, p_attempt integer,
  p_worker_id varchar, p_lease_token varchar, p_now timestamptz
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  with claimed as (
    select intent.library_id
      from ops.jobs as job
      join library.full_scan_intents as intent
        on intent.id = p_intent_id
       and intent.job_id = job.id
       and intent.library_id = job.library_id
       and intent.state = 'running'
       and intent.execution_attempt = p_attempt
       and intent.committed_inventory_revision is null
     where job.id = p_job_id
       and job.kind = 'full_scan'
       and job.subject_kind = 'full_scan_intent'
       and job.subject_ref = p_intent_id::text
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now
  )
  select case when exists (select 1 from claimed) then coalesce((
    select jsonb_object_agg(
             file.private_path,
             file.metadata #> '{scan_cache,file_entry}'
             order by file.private_path
           )
      from claimed
      join library.local_tracks as track
        on track.library_id = claimed.library_id
      join library.local_track_files as file
        on file.track_id = track.id
       and file.metadata #>> '{scan_cache,source}' = 'runtime_scan_cache'
       and coalesce(
             (file.metadata #>> '{scan_cache,stale}')::boolean, false
           ) is false
      join library.library_roots as root
        on root.id = file.library_root_id
       and root.library_id = claimed.library_id
       and root.is_active is true
     where jsonb_typeof(file.metadata #> '{scan_cache,file_entry}') = 'object'
  ), '{}'::jsonb) else null end;
$$;

create or replace function library.load_authorized_full_scan_preview(
  p_library_id bigint
)
returns table (
  file_cache jsonb,
  separate_release_keys text[],
  updated_at timestamptz
)
language sql
security definer
set search_path = pg_catalog
as $$
  select intent.preview_file_cache,
         intent.preview_separate_release_keys,
         intent.preview_updated_at
    from library.full_scan_intents as intent
   where intent.library_id = p_library_id
     and intent.state in ('accepted', 'running', 'retry_wait')
     and intent.committed_inventory_revision is null
     and intent.preview_file_cache is not null
   order by intent.accepted_at desc, intent.id desc
   limit 1;
$$;

create or replace function library.clear_terminal_full_scan_preview()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.committed_inventory_revision is not null or
     new.state in ('succeeded', 'failed', 'canceled', 'ambiguous') then
    new.preview_file_cache := null;
    new.preview_separate_release_keys := null;
    new.preview_album_total := null;
    new.preview_updated_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists full_scan_intents_clear_terminal_preview
  on library.full_scan_intents;
create trigger full_scan_intents_clear_terminal_preview
before update on library.full_scan_intents
for each row execute function library.clear_terminal_full_scan_preview();

create or replace function library.load_authorized_full_scan_metrics(p_library_id bigint)
returns table (
  elapsed_seconds double precision,
  estimated_remaining_seconds double precision,
  files_per_second double precision,
  album_folders_processed bigint,
  album_folders_total bigint
)
language sql
security definer
set search_path = pg_catalog
as $$
  select intent.progress_elapsed_seconds,
         intent.progress_estimated_remaining_seconds,
         intent.progress_files_per_second,
         intent.progress_album_folders_processed,
         intent.progress_album_folders_total
    from library.full_scan_intents as intent
   where intent.library_id = p_library_id
   order by (intent.state in ('accepted', 'running', 'retry_wait')) desc,
            intent.accepted_at desc, intent.id desc
   limit 1;
$$;

create or replace function library.load_authorized_album_total(p_library_id bigint)
returns bigint
language sql
security definer
set search_path = pg_catalog
as $$
  select greatest(
    (select count(distinct album.id)
       from library.local_albums as album
       join library.local_tracks as track
         on track.library_id = album.library_id
        and track.album_id = album.id
       join library.local_track_files as file on file.track_id = track.id
       join library.library_roots as root
         on root.id = file.library_root_id
        and root.library_id = album.library_id
        and root.is_active is true
      where album.library_id = p_library_id
        and coalesce(
          (file.metadata #>> '{scan_cache,stale}')::boolean,
          false
        ) is false),
    coalesce((
      select intent.preview_album_total
        from library.full_scan_intents as intent
       where intent.library_id = p_library_id
         and intent.state in ('accepted', 'running', 'retry_wait')
         and intent.committed_inventory_revision is null
       order by intent.accepted_at desc, intent.id desc
       limit 1
    ), 0)
  );
$$;

create or replace function library.load_authorized_full_scan_relation_status(p_library_id bigint)
returns table (
  relations_processed bigint,
  relations_total bigint,
  relations_phase text,
  relations_source text
)
language sql
security definer
set search_path = pg_catalog
as $$
  with visible_relations as (
    select count(distinct artist.id) as artist_total
      from library.local_artists as artist
      join library.local_albums as album
        on album.library_id = artist.library_id
       and album.artist_id = artist.id
      join library.local_tracks as track
        on track.library_id = album.library_id
       and track.album_id = album.id
      join library.local_track_files as file on file.track_id = track.id
      join library.library_roots as root
        on root.id = file.library_root_id
       and root.library_id = artist.library_id
       and root.is_active is true
     where artist.library_id = p_library_id
       and coalesce(
         (file.metadata #>> '{scan_cache,stale}')::boolean,
         false
       ) is false
  ), latest_intent as (
    select intent.state, intent.progress_phase
      from library.full_scan_intents as intent
     where intent.library_id = p_library_id
     order by (
       intent.state in ('accepted', 'running', 'retry_wait')
     ) desc, intent.accepted_at desc, intent.id desc
     limit 1
  )
  select case
           when latest_intent.state = 'succeeded'
           then visible_relations.artist_total
           else 0
         end,
         visible_relations.artist_total,
         case
           when latest_intent.state = 'succeeded' then 'Artist Family ready'
           else coalesce(latest_intent.progress_phase, 'Idle')
         end,
         'local'::text
    from visible_relations
    left join latest_intent on true;
$$;

create or replace function ops.load_authorized_cover_refresh_status(
  requested_library_id bigint
)
returns table (
  covers_in_progress boolean,
  covers_processed integer,
  covers_total integer,
  covers_downloaded integer,
  covers_current_folder text
)
language sql
security definer
set search_path = pg_catalog, ops
as $$
  with active_refresh as (
    select
      refresh.status in ('pending', 'running') as covers_in_progress,
      refresh.progress_current as covers_processed,
      refresh.progress_total as covers_total,
      refresh.downloaded_count as covers_downloaded,
      refresh.safe_display_label::text as covers_current_folder
      from ops.cover_bulk_refreshes as refresh
     where refresh.library_id = requested_library_id
     order by (refresh.status in ('pending', 'running')) desc,
              refresh.requested_at desc, refresh.id desc
     limit 1
  ), pending_follow_up as (
    select true as covers_in_progress
      from ops.jobs as job
     where job.library_id = requested_library_id
       and job.kind = 'post_scan_cover_refresh'
       and job.state in ('queued', 'running', 'retry_wait')
     order by job.created_at desc, job.id desc
     limit 1
  )
  select
    coalesce(active_refresh.covers_in_progress,
             pending_follow_up.covers_in_progress, false),
    coalesce(active_refresh.covers_processed, 0),
    coalesce(active_refresh.covers_total, 0),
    coalesce(active_refresh.covers_downloaded, 0),
    coalesce(active_refresh.covers_current_folder, '')
    from (select 1) as singleton
    left join active_refresh on true
    left join pending_follow_up on true;
$$;

revoke all on function library.load_authorized_album_total(bigint) from public;
revoke all on function library.load_authorized_full_scan_relation_status(bigint) from public;
revoke all on function library.publish_claimed_full_scan_preview(bigint, bigint, integer, varchar, varchar, jsonb, text[], bigint, timestamptz) from public;
revoke all on function library.load_claimed_full_scan_cache(bigint, bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.load_authorized_full_scan_preview(bigint) from public;
revoke all on function library.clear_terminal_full_scan_preview() from public;
revoke all on function library.checkpoint_claimed_full_scan_v2(bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, text, timestamptz, double precision, double precision, double precision, bigint, bigint) from public;
revoke all on function library.load_authorized_full_scan_metrics(bigint) from public;
revoke all on function ops.load_authorized_cover_refresh_status(bigint) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function library.checkpoint_claimed_full_scan_v2(bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, text, timestamptz, double precision, double precision, double precision, bigint, bigint) to album_haven_worker;
    grant execute on function library.publish_claimed_full_scan_preview(bigint, bigint, integer, varchar, varchar, jsonb, text[], bigint, timestamptz) to album_haven_worker;
    grant execute on function library.load_claimed_full_scan_cache(bigint, bigint, integer, varchar, varchar, timestamptz) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.load_authorized_album_total(bigint) to album_haven_app;
    grant execute on function library.load_authorized_full_scan_relation_status(bigint) to album_haven_app;
    grant execute on function library.load_authorized_full_scan_metrics(bigint) to album_haven_app;
    grant execute on function library.load_authorized_full_scan_preview(bigint) to album_haven_app;
    grant execute on function ops.load_authorized_cover_refresh_status(bigint) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke execute on function library.load_authorized_album_total(bigint) from album_haven_readonly;
    revoke execute on function library.load_authorized_full_scan_relation_status(bigint) from album_haven_readonly;
    revoke execute on function library.load_authorized_full_scan_preview(bigint) from album_haven_readonly;
    revoke execute on function library.publish_claimed_full_scan_preview(bigint, bigint, integer, varchar, varchar, jsonb, text[], bigint, timestamptz) from album_haven_readonly;
    revoke execute on function library.load_claimed_full_scan_cache(bigint, bigint, integer, varchar, varchar, timestamptz) from album_haven_readonly;
    revoke execute on function library.load_authorized_full_scan_metrics(bigint) from album_haven_readonly;
    revoke execute on function library.checkpoint_claimed_full_scan_v2(bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, text, timestamptz, double precision, double precision, double precision, bigint, bigint) from album_haven_readonly;
    revoke execute on function ops.load_authorized_cover_refresh_status(bigint) from album_haven_readonly;
  end if;
end $$;
