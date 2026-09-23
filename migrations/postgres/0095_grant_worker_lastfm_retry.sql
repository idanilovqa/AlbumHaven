drop function if exists app.load_claimed_job_authorization_context(
  bigint, integer, varchar, varchar, timestamptz
);

create function app.load_claimed_job_authorization_context(
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  account_id bigint,
  account_is_active boolean,
  is_bootstrap_owner boolean,
  library_exists boolean,
  membership_current boolean,
  library_relationships jsonb,
  capability_grants jsonb,
  request_origin_id bigint,
  request_origin_account_id bigint,
  request_origin_type varchar,
  request_origin_surface varchar,
  integration_session_ref varchar
)
language sql
security definer
set search_path = pg_catalog
as $$
  select account.id,
         case when account.id is null then null
              else account.is_active and account.disabled_at is null end,
         coalesce(exists (
           select 1 from app.bootstrap_owners as owner_record
            where owner_record.account_id = account.id
              and owner_record.owner_key = 'local-bootstrap-owner'
         ), false),
         library_record.id is not null,
         coalesce(membership.account_id is not null, false),
         case when membership.account_id is null then '[]'::jsonb
              else jsonb_build_array(jsonb_build_object(
                'library_id', membership.library_id,
                'membership_role', membership.membership_role,
                'is_primary_owner', library_record.owner_account_id = account.id
              )) end,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'capability_key', capability.capability_key,
                    'scope_kind', capability.scope_kind,
                    'scope_id', capability.scope_id
                  ))
             from app.capabilities as capability
            where capability.account_id = account.id
              and capability.capability_key = job.capability_key
              and capability.revoked_at is null
         ), '[]'::jsonb),
         request_record.id,
         request_record.account_id,
         request_record.origin_type,
         request_record.client_surface_class,
         case when job.kind = 'lastfm_scrobble_retry'
              then pending.active_session_id::text else null end::varchar
    from ops.jobs as job
    left join app.accounts as account on account.id = job.account_id
    left join library.libraries as library_record on library_record.id = job.library_id
    left join library.library_memberships as membership
      on membership.account_id = account.id
     and membership.library_id = library_record.id
    left join app.request_origins as request_record
      on request_record.id = job.request_origin_id
    left join integration.pending_scrobbles as pending
      on job.kind = 'lastfm_scrobble_retry'
     and pending.current_job_id = job.id
   where job.id = p_job_id
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now;
$$;

create or replace function ops.validate_claimed_lastfm_retry(
  p_pending_scrobble_id bigint,
  p_active_session_id bigint,
  p_account_id bigint,
  p_library_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz,
  p_row_revision bigint,
  p_accepted_attempt integer
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
      from ops.jobs as job
      join integration.pending_scrobbles as pending
        on pending.current_job_id = job.id
       and pending.id = p_pending_scrobble_id
      join integration.lastfm_sessions as session
        on session.id = pending.active_session_id
       and session.id = p_active_session_id
       and session.account_id = pending.account_id
       and session.is_active
     where job.id = p_job_id
       and job.kind = 'lastfm_scrobble_retry'
       and job.subject_kind = 'pending_scrobble'
       and job.subject_ref = pending.id::text
       and job.parameters = jsonb_build_object(
         'active_session_ref', pending.active_session_id::text
       )
       and job.account_id = p_account_id
       and job.account_id = pending.account_id
       and job.library_id = p_library_id
       and job.library_id = pending.library_id
       and job.capability_key = 'integration.lastfm.scrobble'
       and job.idempotency_key = 'lastfm-scrobble:' || pending.id::text ||
           ':attempt:' || pending.accepted_attempt::text
       and job.max_attempts = 1
       and job.recovery_policy = 'ambiguous_on_stale_lease'
       and job.scope_version = p_row_revision
       and pending.row_revision = job.scope_version
       and job.resource_revision = p_accepted_attempt
       and pending.accepted_attempt = job.resource_revision
       and pending.status in ('accepted', 'sending')
       and pending.attempt_count < pending.accepted_attempt
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now
       and job.cancel_requested_at is null
  );
$$;

create or replace function ops.load_claimed_lastfm_session_secret(
  p_pending_scrobble_id bigint,
  p_active_session_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (session_key_encrypted text)
language sql
security definer
set search_path = pg_catalog
as $$
  select session.session_key_encrypted
    from ops.jobs as job
    join integration.pending_scrobbles as pending
      on pending.current_job_id = job.id
     and pending.id = p_pending_scrobble_id
    join integration.lastfm_sessions as session
      on session.id = pending.active_session_id
     and session.id = p_active_session_id
     and session.account_id = pending.account_id
     and session.is_active
   where job.id = p_job_id
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

create or replace function ops.begin_claimed_lastfm_attempt(
  p_pending_scrobble_id bigint,
  p_active_session_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  pending_scrobble_id bigint,
  row_revision bigint,
  accepted_attempt integer,
  listen_id text,
  payload jsonb
)
language sql
security definer
set search_path = pg_catalog
as $$
  update integration.pending_scrobbles as pending
     set status = 'sending',
         row_revision = pending.row_revision + 1,
         updated_at = p_now
    from ops.jobs as job
   where pending.id = p_pending_scrobble_id
     and pending.current_job_id = job.id
     and pending.active_session_id = p_active_session_id
     and pending.status = 'accepted'
     and pending.row_revision = job.scope_version
     and pending.attempt_count < pending.accepted_attempt
     and job.id = p_job_id
     and job.kind = 'lastfm_scrobble_retry'
     and job.subject_kind = 'pending_scrobble'
     and job.subject_ref = pending.id::text
     and job.parameters = jsonb_build_object(
       'active_session_ref', pending.active_session_id::text
     )
     and job.resource_revision = pending.accepted_attempt
     and job.state = 'running'
     and job.attempt_count = p_attempt
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > p_now
     and job.cancel_requested_at is null
     and exists (
       select 1 from integration.lastfm_sessions as session
        where session.id = pending.active_session_id
          and session.account_id = pending.account_id
          and session.is_active
     )
  returning pending.id,
            pending.row_revision,
            pending.accepted_attempt,
            pending.payload->>'source_key',
            pending.payload->'source_payload';
$$;

create or replace function ops.cancel_claimed_lastfm_before_send(
  p_pending_scrobble_id bigint,
  p_active_session_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz,
  p_reason_code varchar
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  with canceled as (
    update integration.pending_scrobbles as pending
       set status = 'canceled',
           last_provider_disposition = 'canceled_before_send',
           repair_reason_code = p_reason_code,
           next_attempt_at = null,
           row_revision = pending.row_revision + 1,
           updated_at = p_now
      from ops.jobs as job
     where pending.id = p_pending_scrobble_id
       and pending.current_job_id = job.id
       and pending.active_session_id = p_active_session_id
       and pending.status = 'accepted'
       and pending.row_revision = job.scope_version
       and job.id = p_job_id
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and octet_length(p_reason_code) between 1 and 128
    returning 1
  )
  select exists (select 1 from canceled);
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

  update integration.listen_history
     set scrobble_status = v_domain_status,
         metadata = metadata || p_history_updates
   where account_id = pending_record.account_id
     and library_id = pending_record.library_id
     and source_entry_id = pending_record.payload->>'source_key';

  return query select v_domain_status, created_job_id, final_revision;
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
         attempt_count = case when terminal.next_status = 'ambiguous'
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
      'integration.lastfm.scrobble', v_origin_id, 'self_hosted',
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
  return v_count;
end;
$$;

revoke all on function app.load_claimed_job_authorization_context(
  bigint, integer, varchar, varchar, timestamptz
) from public;
revoke all on function ops.validate_claimed_lastfm_retry(
  bigint, bigint, bigint, bigint, bigint, integer, varchar, varchar,
  timestamptz, bigint, integer
) from public;
revoke all on function ops.load_claimed_lastfm_session_secret(
  bigint, bigint, bigint, integer, varchar, varchar, timestamptz
) from public;
revoke all on function ops.begin_claimed_lastfm_attempt(
  bigint, bigint, bigint, integer, varchar, varchar, timestamptz
) from public;
revoke all on function ops.cancel_claimed_lastfm_before_send(
  bigint, bigint, bigint, integer, varchar, varchar, timestamptz, varchar
) from public;
revoke all on function ops.finish_claimed_lastfm_attempt(
  bigint, bigint, bigint, integer, varchar, varchar, timestamptz,
  bigint, varchar, varchar, jsonb
) from public;
revoke all on function ops.reconcile_due_lastfm_jobs(timestamptz, integer)
  from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on table integration.lastfm_settings from album_haven_worker;
    revoke all on table integration.lastfm_sessions from album_haven_worker;
    revoke all on table integration.pending_scrobbles from album_haven_worker;
    revoke all on table integration.scrobble_retry_state from album_haven_worker;
    revoke all on table integration.listen_history from album_haven_worker;
    grant execute on function app.load_claimed_job_authorization_context(
      bigint, integer, varchar, varchar, timestamptz
    ) to album_haven_worker;
    grant execute on function ops.validate_claimed_lastfm_retry(
      bigint, bigint, bigint, bigint, bigint, integer, varchar, varchar,
      timestamptz, bigint, integer
    ) to album_haven_worker;
    grant execute on function ops.load_claimed_lastfm_session_secret(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz
    ) to album_haven_worker;
    grant execute on function ops.begin_claimed_lastfm_attempt(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz
    ) to album_haven_worker;
    grant execute on function ops.cancel_claimed_lastfm_before_send(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz, varchar
    ) to album_haven_worker;
    grant execute on function ops.finish_claimed_lastfm_attempt(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz,
      bigint, varchar, varchar, jsonb
    ) to album_haven_worker;
    grant execute on function ops.reconcile_due_lastfm_jobs(timestamptz, integer)
      to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke execute on function ops.validate_claimed_lastfm_retry(
      bigint, bigint, bigint, bigint, bigint, integer, varchar, varchar,
      timestamptz, bigint, integer
    ) from album_haven_readonly;
    revoke execute on function ops.load_claimed_lastfm_session_secret(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_readonly;
    revoke execute on function ops.begin_claimed_lastfm_attempt(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_readonly;
    revoke execute on function ops.cancel_claimed_lastfm_before_send(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz, varchar
    ) from album_haven_readonly;
    revoke execute on function ops.finish_claimed_lastfm_attempt(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz,
      bigint, varchar, varchar, jsonb
    ) from album_haven_readonly;
    revoke execute on function ops.reconcile_due_lastfm_jobs(timestamptz, integer)
      from album_haven_readonly;
  end if;
end $$;
