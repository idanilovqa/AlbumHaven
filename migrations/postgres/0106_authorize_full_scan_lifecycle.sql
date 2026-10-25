create or replace function library.create_full_scan_intent_v2(
  p_library_id bigint,
  p_initiating_account_id bigint,
  p_capability_key varchar,
  p_request_origin_ref varchar,
  p_deployment_mode varchar,
  p_client_surface varchar,
  p_mode varchar,
  p_force boolean,
  p_root_ids bigint[],
  p_accepted_at timestamptz
)
returns table (intent_id bigint, job_id bigint, created boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  accepted record;
begin
  select * into accepted
    from library.create_full_scan_intent(
      p_library_id, p_initiating_account_id, p_capability_key,
      p_request_origin_ref, p_deployment_mode, p_client_surface,
      p_mode, p_force, p_root_ids, p_accepted_at
    );
  return query select accepted.intent_id, accepted.job_id,
                      accepted.job_id is null;
end;
$$;

create or replace function library.request_active_full_scan_cancellation(
  p_library_id bigint,
  p_actor_account_id bigint,
  p_requested_at timestamptz
)
returns table (
  job_id bigint,
  prior_state varchar(32),
  next_state varchar(32),
  reason_code varchar(128),
  transition_recorded boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_job_id bigint;
  active_prior_state varchar(32);
  active_attempt_count integer;
begin
  if p_library_id is null or p_library_id <= 0 or
     p_actor_account_id is null or p_actor_account_id <= 0 or
     p_requested_at is null then
    raise exception using
      errcode = '22023',
      message = 'full scan cancellation scope is invalid';
  end if;

  select job.id, job.state, job.attempt_count
    into active_job_id, active_prior_state, active_attempt_count
    from library.full_scan_intents as intent
    join ops.jobs as job on job.id = intent.job_id
   where intent.library_id = p_library_id
     and job.library_id = intent.library_id
     and job.kind = 'full_scan'
     and job.subject_kind = 'full_scan_intent'
     and job.subject_ref = intent.id::text
     and job.parameters = jsonb_build_object('intent_id', intent.id)
     and job.state in ('queued', 'running', 'retry_wait')
   order by job.id
   limit 1
   for update of job;

  if active_job_id is null then
    return;
  end if;

  if active_prior_state in ('queued', 'retry_wait') then
    update ops.jobs as job
       set state = 'canceled',
           cancel_requested_at = p_requested_at,
           cancel_requested_by_account_id = p_actor_account_id,
           cancel_reason_code = 'authorized_library_request',
           completed_at = p_requested_at,
           outcome_code = 'authorized_library_request',
           updated_at = p_requested_at
     where job.id = active_job_id
       and job.state = active_prior_state;

    insert into ops.job_transitions (
      job_id, prior_state, next_state, attempt_count, reason_code,
      retry_decision, transitioned_at
    ) values (
      active_job_id, active_prior_state, 'canceled', active_attempt_count,
      'authorized_library_request', 'none', p_requested_at
    );

    return query
      select active_job_id, active_prior_state, 'canceled'::varchar(32),
             'immediate_canceled'::varchar(128), true;
    return;
  end if;

  update ops.jobs as job
     set cancel_requested_at = coalesce(job.cancel_requested_at, p_requested_at),
         cancel_requested_by_account_id = coalesce(
           job.cancel_requested_by_account_id, p_actor_account_id
         ),
         cancel_reason_code = coalesce(
           job.cancel_reason_code, 'authorized_library_request'
         ),
         updated_at = p_requested_at
   where job.id = active_job_id
     and job.state = 'running';

  return query
    select active_job_id, active_prior_state, active_prior_state,
           'running_requested'::varchar(128), false;
end;
$$;

revoke all on function library.create_full_scan_intent_v2(bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean, bigint[], timestamptz) from public;
revoke all on function library.request_active_full_scan_cancellation(bigint, bigint, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function library.create_full_scan_intent_v2(bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean, bigint[], timestamptz) to album_haven_app;
    grant execute on function library.request_active_full_scan_cancellation(bigint, bigint, timestamptz) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on function library.create_full_scan_intent_v2(bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean, bigint[], timestamptz) from album_haven_worker;
    revoke all on function library.request_active_full_scan_cancellation(bigint, bigint, timestamptz) from album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function library.create_full_scan_intent_v2(bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean, bigint[], timestamptz) from album_haven_readonly;
    revoke all on function library.request_active_full_scan_cancellation(bigint, bigint, timestamptz) from album_haven_readonly;
  end if;
end $$;
