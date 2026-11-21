-- depends on: 0235_grant_worker_lastfm_retry.sql
-- depends on: 0249_create_problematic_files_projection.sql

create table integration.lastfm_reauthentication_continuations (
  account_id bigint not null references app.accounts(id) on delete cascade,
  library_id bigint not null references library.libraries(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  active_session_id bigint references integration.lastfm_sessions(id) on delete set null,
  request_origin_id bigint references app.request_origins(id) on delete set null,
  deployment_mode varchar(128),
  client_surface varchar(128),
  last_request_ref varchar(128),
  drain_requested boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (account_id, library_id)
);

alter table integration.pending_scrobbles
  add column reauthentication_generation bigint not null default 0
    check (reauthentication_generation >= 0);

create index lastfm_reauthentication_ready_idx
  on integration.lastfm_reauthentication_continuations(updated_at, account_id, library_id)
  where drain_requested;
create index pending_scrobbles_reauthentication_generation_idx
  on integration.pending_scrobbles(account_id, library_id, reauthentication_generation, id)
  where status = 'reauthentication_required' and attempt_count < 5;

create function integration.signal_lastfm_reauthentication(
  p_account_id bigint, p_library_id bigint, p_active_session_id bigint,
  p_request_origin_ref text, p_deployment_mode text, p_client_surface text,
  p_request_ref text, p_now timestamptz, p_expected_generation bigint
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_origin_id bigint;
  v_generation bigint;
  previous integration.lastfm_reauthentication_continuations%rowtype;
  v_origin_type text := split_part(p_request_origin_ref, ':', 1);
  v_origin_key text := substr(p_request_origin_ref, strpos(p_request_origin_ref, ':') + 1);
begin
  if p_now is null or not isfinite(p_now)
     or p_expected_generation is null or p_expected_generation < 0
     or coalesce(length(p_request_ref), 0) not between 1 and 128
     or coalesce(length(p_deployment_mode), 0) not between 1 and 128
     or coalesce(length(p_client_surface), 0) not between 1 and 128
     or strpos(p_request_origin_ref, ':') < 2 or v_origin_key = ''
     or not exists (select 1 from app.accounts where id=p_account_id and is_active)
     or not exists (select 1 from library.library_memberships
                    where account_id=p_account_id and library_id=p_library_id)
     or not exists (select 1 from integration.lastfm_sessions
                    where id=p_active_session_id and account_id=p_account_id and is_active)
  then
    raise exception 'Last.fm reconnect scope is unavailable.';
  end if;
  perform id from app.accounts where id=p_account_id and is_active for update;
  if not found then raise exception 'Last.fm reconnect scope is unavailable.'; end if;
  v_origin_id := app.ensure_job_request_origin(
    p_account_id, p_client_surface, v_origin_type, v_origin_key, p_now);
  if v_origin_id is null then
    raise exception 'Last.fm reconnect origin is unavailable.';
  end if;
  select * into previous from integration.lastfm_reauthentication_continuations
   where account_id=p_account_id and library_id=p_library_id;
  if found and previous.last_request_ref=p_request_ref
     and previous.request_origin_id=v_origin_id then
    if previous.active_session_id is distinct from p_active_session_id
       or previous.deployment_mode is distinct from p_deployment_mode
       or previous.client_surface is distinct from p_client_surface then
      raise exception 'Last.fm reconnect request has conflicting context.';
    end if;
    return previous.generation;
  end if;
  if coalesce(previous.generation, 0) <> p_expected_generation then
    raise exception 'Last.fm reconnect was superseded; authenticate again.';
  end if;
  insert into integration.lastfm_reauthentication_continuations as continuation (
    account_id, library_id, generation, active_session_id, request_origin_id,
    deployment_mode, client_surface, last_request_ref, drain_requested, updated_at
  ) values (
    p_account_id, p_library_id, 1, p_active_session_id, v_origin_id,
    p_deployment_mode, p_client_surface, p_request_ref, true, p_now
  ) on conflict (account_id, library_id) do update
    set generation = continuation.generation + 1,
        active_session_id=p_active_session_id, request_origin_id=v_origin_id,
        deployment_mode=p_deployment_mode, client_surface=p_client_surface,
        last_request_ref=p_request_ref, drain_requested=true, updated_at=p_now
  where continuation.generation=p_expected_generation
  returning generation into v_generation;
  if not found then
    raise exception 'Last.fm reconnect was superseded; authenticate again.';
  end if;
  return v_generation;
end;
$$;


create or replace function ops.load_claimed_lastfm_session_credentials(
  p_pending_scrobble_id bigint,
  p_active_session_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (session_key_encrypted text, active_session_id bigint,
               reauthentication_generation bigint)
language sql
security definer
set search_path = pg_catalog
as $$
  select session.session_key_encrypted, session.id,
         coalesce(continuation.generation, 0)
    from ops.jobs as job
    join integration.pending_scrobbles as pending
      on pending.current_job_id = job.id
     and pending.id = p_pending_scrobble_id
    join integration.lastfm_sessions as session
      on session.id = pending.active_session_id
     and session.id = p_active_session_id
     and session.account_id = pending.account_id
     and session.is_active
    left join integration.lastfm_reauthentication_continuations continuation
      on continuation.account_id=pending.account_id
     and continuation.library_id=pending.library_id
   where (continuation.active_session_id is null or continuation.active_session_id=session.id)
     and job.id = p_job_id
     and job.kind = 'lastfm_scrobble_retry'
     and job.subject_kind = 'pending_scrobble'
     and job.subject_ref = pending.id::text
     and job.parameters = jsonb_build_object(
       'active_session_ref', pending.active_session_id::text
     )
     and job.account_id = pending.account_id
     and job.library_id = pending.library_id
     and job.capability_key = 'integration.lastfm.scrobble'
     and job.idempotency_key = 'lastfm-scrobble:' || pending.id::text ||
         ':attempt:' || pending.accepted_attempt::text
     and job.max_attempts = 1
     and job.recovery_policy = 'ambiguous_on_stale_lease'
     and pending.row_revision = job.scope_version
     and pending.accepted_attempt = job.resource_revision
     and pending.status in ('accepted', 'sending')
     and pending.attempt_count < pending.accepted_attempt
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now
     and job.cancel_requested_at is null;
$$;

create or replace function ops.finish_claimed_lastfm_attempt(
  p_pending_scrobble_id bigint,
  p_active_session_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz,
  p_expected_row_revision bigint,
  p_disposition varchar,
  p_reason_code varchar,
  p_history_updates jsonb
)
returns table (domain_status varchar, next_job_id bigint, row_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  pending_record integration.pending_scrobbles%rowtype;
  current_job ops.jobs%rowtype;
  v_domain_status varchar;
  scheduled_at timestamptz;
  created_job_id bigint;
  final_revision bigint;
begin
  if p_disposition not in (
    'accepted', 'known_not_sent_retryable', 'reauthentication_required',
    'permanent_rejection', 'possible_send_ambiguous'
  ) or jsonb_typeof(p_history_updates) <> 'object'
    or octet_length(p_history_updates::text) > 16384
    or octet_length(p_reason_code) not between 1 and 128 then
    return;
  end if;

  select * into current_job from ops.jobs
   where id = p_job_id
     and kind = 'lastfm_scrobble_retry'
     and state = 'running'
     and attempt_count = p_attempt
     and lease_owner = p_worker_id
     and lease_token = p_lease_token
     and lease_expires_at > p_now
     and cancel_requested_at is null
   for update;
  if not found then return; end if;

  select pending.* into pending_record
    from integration.pending_scrobbles as pending
   where pending.id = p_pending_scrobble_id
     and pending.current_job_id = p_job_id
     and pending.active_session_id = p_active_session_id
     and pending.status = 'sending'
     and pending.row_revision = p_expected_row_revision
     and pending.accepted_attempt = current_job.resource_revision
     and pending.attempt_count < pending.accepted_attempt
   for update;
  if not found then return; end if;
  if current_job.lease_expires_at <= clock_timestamp() then return; end if;

  if p_disposition = 'accepted' then v_domain_status := 'completed';
  elsif p_disposition = 'reauthentication_required' then v_domain_status := 'reauthentication_required';
  elsif p_disposition = 'permanent_rejection' then v_domain_status := 'permanent';
  elsif p_disposition = 'possible_send_ambiguous' then v_domain_status := 'ambiguous';
  elsif pending_record.accepted_attempt >= 5 then v_domain_status := 'exhausted';
  else v_domain_status := 'accepted';
  end if;

  final_revision := pending_record.row_revision + 1;
  if v_domain_status = 'accepted' then
    scheduled_at := p_now + make_interval(
      secs => least(1800, 60 * power(2, greatest(0, pending_record.accepted_attempt - 1)))::integer
    );
    insert into ops.jobs (
      kind, state, subject_kind, subject_ref, parameters, account_id,
      library_id, capability_key, request_origin_id, deployment_mode,
      client_surface, scope_version, resource_revision, idempotency_key,
      priority, scheduled_at, attempt_count, max_attempts, recovery_policy
    ) values (
      'lastfm_scrobble_retry', 'queued', 'pending_scrobble',
      pending_record.id::text,
      jsonb_build_object('active_session_ref', pending_record.active_session_id::text),
      pending_record.account_id, pending_record.library_id,
      'integration.lastfm.scrobble', pending_record.request_origin_id,
      current_job.deployment_mode, current_job.client_surface,
      final_revision, pending_record.accepted_attempt + 1,
      'lastfm-scrobble:' || pending_record.id::text || ':attempt:' ||
        (pending_record.accepted_attempt + 1)::text,
      current_job.priority, scheduled_at, 0, 1, 'ambiguous_on_stale_lease'
    ) returning id into created_job_id;
  end if;

  update integration.pending_scrobbles
     set status = v_domain_status,
         attempt_count = pending_record.accepted_attempt,
         accepted_attempt = case when v_domain_status = 'accepted'
                                 then pending_record.accepted_attempt + 1
                                 else pending_record.accepted_attempt end,
         current_job_id = coalesce(created_job_id, pending_record.current_job_id),
         next_attempt_at = scheduled_at,
         last_provider_disposition = p_disposition,
         repair_reason_code = p_reason_code,
         row_revision = final_revision,
         updated_at = p_now
   where id = pending_record.id;

  update integration.listen_history as history
     set scrobble_status = v_domain_status,
         metadata = case
           when pending_record.payload->>'source_family'='rendered_local_listen_session'
           then jsonb_set(coalesce(history.metadata, '{}'::jsonb), '{source_payload}',
             coalesce(history.metadata->'source_payload', '{}'::jsonb) || p_history_updates)
           else history.metadata || p_history_updates end
   where history.account_id = pending_record.account_id
     and history.library_id = pending_record.library_id
     and history.source_entry_id = pending_record.payload->>'source_key'
     and (pending_record.payload->>'source_family' is distinct from 'rendered_local_listen_session'
       or (history.source_family='rendered_local_listen_session'
           and history.measurement_version='rendered-pcm-v1'
           and history.metadata->'source_payload'->>'id'=
               pending_record.payload->'source_payload'->>'id'));
  if pending_record.payload->>'source_family'='rendered_local_listen_session' and not found then
    raise exception 'Measured listen history is unavailable for Last.fm finalization.';
  end if;

  return query select v_domain_status, created_job_id, final_revision;
end;
$$;

create function ops.finish_claimed_lastfm_attempt_with_generation(
  p_pending_scrobble_id bigint, p_active_session_id bigint,
  p_job_id bigint, p_attempt integer, p_worker_id varchar,
  p_lease_token varchar, p_now timestamptz, p_expected_row_revision bigint,
  p_disposition varchar, p_reason_code varchar, p_history_updates jsonb,
  p_reauthentication_generation bigint
)
returns table (domain_status varchar, next_job_id bigint, row_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  result record;
  held integration.pending_scrobbles%rowtype;
begin
  if p_reauthentication_generation is null or p_reauthentication_generation < 0 then return; end if;
  select * into result from ops.finish_claimed_lastfm_attempt(
    p_pending_scrobble_id, p_active_session_id, p_job_id, p_attempt,
    p_worker_id, p_lease_token, p_now, p_expected_row_revision,
    p_disposition, p_reason_code, p_history_updates);
  if not found then return; end if;
  if result.domain_status='reauthentication_required' then
    update integration.pending_scrobbles
       set reauthentication_generation=p_reauthentication_generation
     where id=p_pending_scrobble_id
    returning * into held;
    -- Job, pending and history locks precede the signal lock on every worker path.
    update integration.lastfm_reauthentication_continuations
       set drain_requested=true, updated_at=p_now
     where account_id=held.account_id and library_id=held.library_id
       and generation>p_reauthentication_generation;
  end if;
  return query select result.domain_status, result.next_job_id, result.row_revision;
end;
$$;


create or replace function ops.reconcile_due_lastfm_jobs(
  p_now timestamptz,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  candidate record;
  v_job_id bigint;
  v_origin_id bigint;
  v_client_surface varchar;
  v_session_id bigint;
  v_accepted_attempt integer;
  v_accepted_revision bigint;
  v_count integer := 0;
  ready_scope integration.lastfm_reauthentication_continuations%rowtype;
  v_deployment_mode varchar;
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'Last.fm reconciliation limit is invalid.';
  end if;

  with terminal as (
    select pending.id,
           case
             when job.state = 'ambiguous' or pending.status = 'sending'
               then 'ambiguous'
             when job.state = 'canceled' then 'canceled'
             when job.state = 'failed' and pending.accepted_attempt >= 5
               then 'exhausted'
             when job.state = 'failed' then 'retry_wait'
             else pending.status
           end as next_status,
           job.state
      from integration.pending_scrobbles as pending
      join ops.jobs as job on job.id = pending.current_job_id
     where job.state in ('failed', 'canceled', 'ambiguous')
       and pending.status in ('accepted', 'sending')
     order by pending.id
     for update of pending skip locked
     limit p_limit
  )
  update integration.pending_scrobbles as pending
     set status = terminal.next_status,
         attempt_count = case when terminal.next_status in ('ambiguous', 'retry_wait', 'exhausted')
                              then pending.accepted_attempt
                              else pending.attempt_count end,
         accepted_attempt = case when terminal.next_status = 'retry_wait'
                                 then null else pending.accepted_attempt end,
         current_job_id = case when terminal.next_status = 'retry_wait'
                               then null else pending.current_job_id end,
         next_attempt_at = case when terminal.next_status = 'retry_wait'
                                then p_now else null end,
         last_provider_disposition = case
           when terminal.next_status = 'ambiguous' then 'possible_send_ambiguous'
           when terminal.next_status = 'canceled' then 'canceled_before_send'
           else pending.last_provider_disposition end,
         repair_reason_code = 'generic_terminal_converged',
         row_revision = pending.row_revision + 1,
         updated_at = p_now
    from terminal
   where pending.id = terminal.id;

  -- Discover without taking the signal lock: all pending/job locks come first.
  select * into ready_scope
    from integration.lastfm_reauthentication_continuations
   where drain_requested
   order by updated_at, account_id, library_id limit 1;
  if found then
    with candidates as (
      select pending.id
        from integration.pending_scrobbles pending
       where pending.account_id=ready_scope.account_id
         and pending.library_id=ready_scope.library_id
         and pending.status='reauthentication_required'
         and pending.reauthentication_generation<ready_scope.generation
         and pending.attempt_count<5
         and (pending.current_job_id is null or exists (
           select 1 from ops.jobs job where job.id=pending.current_job_id
             and job.state in ('succeeded', 'failed', 'canceled', 'ambiguous')))
         and exists (select 1 from integration.lastfm_sessions session
                      where session.id=ready_scope.active_session_id
                        and session.account_id=pending.account_id and session.is_active)
       order by pending.reauthentication_generation, pending.id
       for update of pending skip locked limit p_limit
    )
    update integration.pending_scrobbles pending
       set status='pending', current_job_id=null, accepted_attempt=null,
           active_session_id=ready_scope.active_session_id,
           request_origin_id=ready_scope.request_origin_id,
           next_attempt_at=p_now, row_revision=pending.row_revision+1, updated_at=p_now
      from candidates where pending.id=candidates.id;
  end if;
  for candidate in
    select pending.*
      from integration.pending_scrobbles as pending
     where pending.status in ('pending', 'retry_wait')
       and pending.current_job_id is null
       and pending.attempt_count < 5
       and (pending.next_attempt_at is null or pending.next_attempt_at <= p_now)
     order by pending.next_attempt_at nulls first, pending.id
     for update skip locked
     limit p_limit
  loop
    select session.id into v_session_id
      from integration.lastfm_sessions as session
     where session.account_id = candidate.account_id and session.is_active
       and not exists (
         select 1 from integration.lastfm_reauthentication_continuations continuation
          where continuation.account_id=candidate.account_id
            and continuation.library_id=candidate.library_id
            and continuation.generation>0
            and continuation.active_session_id is distinct from session.id
       )
     order by session.updated_at desc, session.id desc limit 1;
    if v_session_id is null then continue; end if;

    select origin_record.id, origin_record.client_surface_class
      into v_origin_id, v_client_surface
      from app.request_origins as origin_record
     where origin_record.account_id = candidate.account_id
       and (candidate.request_origin_id is null
            or origin_record.id = candidate.request_origin_id)
     order by (origin_record.id = candidate.request_origin_id) desc,
              origin_record.id desc
     limit 1;
    if v_origin_id is null then continue; end if;

    v_deployment_mode := 'self_hosted';
    select continuation.deployment_mode into v_deployment_mode
      from integration.lastfm_reauthentication_continuations continuation
     where continuation.account_id=candidate.account_id
       and continuation.library_id=candidate.library_id
       and continuation.request_origin_id=v_origin_id;
    v_deployment_mode := coalesce(v_deployment_mode, 'self_hosted');
    v_accepted_attempt := candidate.attempt_count + 1;
    v_accepted_revision := candidate.row_revision + 1;
    update integration.pending_scrobbles
       set status = 'accepted', accepted_attempt = v_accepted_attempt,
           active_session_id = v_session_id, request_origin_id = v_origin_id,
           row_revision = v_accepted_revision, updated_at = p_now
     where id = candidate.id;

    insert into ops.jobs (
      kind, state, subject_kind, subject_ref, parameters, account_id,
      library_id, capability_key, request_origin_id, deployment_mode,
      client_surface, scope_version, resource_revision, idempotency_key,
      priority, scheduled_at, attempt_count, max_attempts, recovery_policy
    ) values (
      'lastfm_scrobble_retry', 'queued', 'pending_scrobble', candidate.id::text,
      jsonb_build_object('active_session_ref', v_session_id::text),
      candidate.account_id, candidate.library_id,
      'integration.lastfm.scrobble', v_origin_id, v_deployment_mode,
      v_client_surface, v_accepted_revision + 1, v_accepted_attempt,
      'lastfm-scrobble:' || candidate.id::text || ':attempt:' || v_accepted_attempt::text,
      0, p_now, 0, 1, 'ambiguous_on_stale_lease'
    )
    on conflict do nothing
    returning id into v_job_id;
    if v_job_id is null then
      select job.id into v_job_id from ops.jobs as job
       where job.kind = 'lastfm_scrobble_retry'
         and job.account_id = candidate.account_id
         and job.library_id = candidate.library_id
         and job.subject_kind = 'pending_scrobble'
         and job.subject_ref = candidate.id::text
         and job.idempotency_key = 'lastfm-scrobble:' || candidate.id::text ||
             ':attempt:' || v_accepted_attempt::text
         and job.request_origin_id = v_origin_id;
    end if;
    if v_job_id is null then
      raise exception 'Last.fm due job could not be composed.';
    end if;
    update integration.pending_scrobbles
       set current_job_id = v_job_id,
           row_revision = v_accepted_revision + 1,
           updated_at = p_now
     where id = candidate.id and row_revision = v_accepted_revision;
    v_count := v_count + 1;
    v_job_id := null;
    v_origin_id := null;
    v_session_id := null;
  end loop;
  if ready_scope.account_id is not null then
    -- No pending/job locks may be acquired after this signal lock.
    select * into ready_scope
      from integration.lastfm_reauthentication_continuations
     where account_id=ready_scope.account_id and library_id=ready_scope.library_id
     for update;
    update integration.lastfm_reauthentication_continuations continuation
       set drain_requested=exists (
         select 1 from integration.pending_scrobbles pending
          where pending.account_id=ready_scope.account_id
            and pending.library_id=ready_scope.library_id
            and pending.status='reauthentication_required'
            and pending.reauthentication_generation<ready_scope.generation
            and pending.attempt_count<5
       ), updated_at=p_now
     where continuation.account_id=ready_scope.account_id
       and continuation.library_id=ready_scope.library_id;
  end if;
  return v_count;
end;
$$;

-- Preserve the current validator, including projection and typed cover contracts.
alter function ops.validate_durable_worker_startup(text[])
  rename to validate_durable_worker_startup_baseline_0262;

create function ops.validate_durable_worker_startup(p_registered_kinds text[])
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  required_functions constant text[] := array[
    'ops.load_claimed_lastfm_session_credentials(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.finish_claimed_lastfm_attempt_with_generation(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone,bigint,character varying,character varying,jsonb,bigint)'
  ];
begin
  if exists (
    select 1 from unnest(required_functions) as required(signature)
     where to_regprocedure(required.signature) is null
        or not has_function_privilege(session_user, to_regprocedure(required.signature), 'EXECUTE')
  ) or to_regclass('integration.lastfm_reauthentication_continuations') is null
    or to_regclass('integration.lastfm_reauthentication_ready_idx') is null
    or to_regclass('integration.pending_scrobbles_reauthentication_generation_idx') is null
    or not exists (select 1 from pg_attribute
      where attrelid='integration.pending_scrobbles'::regclass
        and attname='reauthentication_generation' and not attisdropped
        and atttypid='bigint'::regtype and attnotnull)
    or not exists (select 1 from pg_attribute
      where attrelid='integration.lastfm_reauthentication_continuations'::regclass
        and attname='generation' and not attisdropped
        and atttypid='bigint'::regtype and attnotnull)
  then return false; end if;
  return ops.validate_durable_worker_startup_baseline_0262(p_registered_kinds);
exception when others then return false;
end;
$$;
revoke all on function ops.validate_durable_worker_startup_baseline_0262(text[])
  from public, album_haven_app, album_haven_readonly, album_haven_worker;
revoke all on function ops.validate_durable_worker_startup(text[])
  from public, album_haven_app, album_haven_readonly;
grant execute on function ops.validate_durable_worker_startup(text[]) to album_haven_worker;

revoke all on table integration.lastfm_reauthentication_continuations from public;
revoke all on function integration.signal_lastfm_reauthentication(bigint,bigint,bigint,text,text,text,text,timestamptz,bigint) from public;
revoke all on function ops.load_claimed_lastfm_session_credentials(bigint,bigint,bigint,integer,varchar,varchar,timestamptz) from public;
revoke all on function ops.finish_claimed_lastfm_attempt_with_generation(bigint,bigint,bigint,integer,varchar,varchar,timestamptz,bigint,varchar,varchar,jsonb,bigint) from public;
do $$
begin
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant select on integration.lastfm_reauthentication_continuations to album_haven_app;
    grant update(drain_requested,updated_at) on integration.lastfm_reauthentication_continuations to album_haven_app;
    grant execute on function integration.signal_lastfm_reauthentication(bigint,bigint,bigint,text,text,text,text,timestamptz,bigint) to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_worker') then
    revoke all on integration.lastfm_reauthentication_continuations from album_haven_worker;
    grant execute on function ops.load_claimed_lastfm_session_credentials(bigint,bigint,bigint,integer,varchar,varchar,timestamptz) to album_haven_worker;
    grant execute on function ops.finish_claimed_lastfm_attempt_with_generation(bigint,bigint,bigint,integer,varchar,varchar,timestamptz,bigint,varchar,varchar,jsonb,bigint) to album_haven_worker;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on integration.lastfm_reauthentication_continuations from album_haven_readonly;
    revoke execute on function integration.signal_lastfm_reauthentication(bigint,bigint,bigint,text,text,text,text,timestamptz,bigint) from album_haven_readonly;
    revoke execute on function ops.load_claimed_lastfm_session_credentials(bigint,bigint,bigint,integer,varchar,varchar,timestamptz) from album_haven_readonly;
    revoke execute on function ops.finish_claimed_lastfm_attempt_with_generation(bigint,bigint,bigint,integer,varchar,varchar,timestamptz,bigint,varchar,varchar,jsonb,bigint) from album_haven_readonly;
  end if;
end $$;
