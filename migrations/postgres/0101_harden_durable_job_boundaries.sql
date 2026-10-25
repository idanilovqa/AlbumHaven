alter table ops.job_transitions
  drop constraint if exists job_transitions_legal_pair_check;

alter table ops.job_transitions
  add constraint job_transitions_legal_pair_check check (
    (prior_state is null and next_state = 'queued') or
    (prior_state = 'queued' and next_state in ('running', 'canceled')) or
    (prior_state = 'retry_wait' and next_state in ('running', 'canceled')) or
    (prior_state = 'running' and next_state in ('succeeded', 'failed', 'retry_wait', 'canceled', 'ambiguous'))
  );

create or replace function ops.request_job_cancellation(
  p_job_id bigint,
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
  v_prior_state varchar(32);
  v_attempt_count integer;
begin
  if p_job_id is null or p_job_id <= 0 then
    raise exception using
      errcode = '22023',
      message = 'job id must be positive';
  end if;
  if p_actor_account_id is null or p_actor_account_id <= 0 then
    raise exception using
      errcode = '22023',
      message = 'actor account id must be positive';
  end if;
  if p_requested_at is null then
    raise exception using
      errcode = '22023',
      message = 'requested timestamp is required';
  end if;

  select jobs.state, jobs.attempt_count
    into v_prior_state, v_attempt_count
    from ops.jobs as jobs
   where jobs.id = p_job_id
     and jobs.account_id = p_actor_account_id
   for update;

  if not found then
    return query
      select p_job_id, null::varchar(32), null::varchar(32),
             'not_found'::varchar(128), false;
    return;
  end if;

  if v_prior_state in ('queued', 'retry_wait') then
    update ops.jobs as jobs
       set state = 'canceled',
           cancel_requested_at = p_requested_at,
           cancel_requested_by_account_id = p_actor_account_id,
           cancel_reason_code = 'owner_request',
           completed_at = p_requested_at,
           outcome_code = 'owner_request',
           updated_at = p_requested_at
     where jobs.id = p_job_id
       and jobs.state = v_prior_state;

    insert into ops.job_transitions (
      job_id, prior_state, next_state, attempt_count, reason_code,
      retry_decision, transitioned_at
    ) values (
      p_job_id, v_prior_state, 'canceled', v_attempt_count, 'owner_request',
      'none', p_requested_at
    );

    return query
      select p_job_id, v_prior_state, 'canceled'::varchar(32),
             'canceled'::varchar(128), true;
    return;
  end if;

  if v_prior_state = 'running' then
    update ops.jobs as jobs
       set cancel_requested_at = coalesce(jobs.cancel_requested_at, p_requested_at),
           cancel_requested_by_account_id = coalesce(
             jobs.cancel_requested_by_account_id, p_actor_account_id
           ),
           cancel_reason_code = coalesce(jobs.cancel_reason_code, 'owner_request'),
           updated_at = p_requested_at
     where jobs.id = p_job_id
       and jobs.state = 'running';

    return query
      select p_job_id, v_prior_state, v_prior_state,
             'cancel_requested'::varchar(128), false;
    return;
  end if;

  return query
    select p_job_id, v_prior_state, v_prior_state,
           'terminal_noop'::varchar(128), false;
end;
$$;

revoke all on function ops.request_job_cancellation(bigint, bigint, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke update on table ops.jobs from album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke update on table ops.jobs from album_haven_worker;
    grant select on table ops.jobs to album_haven_worker;
    grant update (
      state, scheduled_at, attempt_count, lease_owner, lease_token,
      lease_expires_at, heartbeat_at, started_at, completed_at,
      outcome_code, updated_at
    ) on table ops.jobs to album_haven_worker;
  end if;
end $$;
