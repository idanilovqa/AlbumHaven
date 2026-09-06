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
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke execute on function ops.validate_claimed_lastfm_retry(
      bigint, bigint, bigint, bigint, bigint, integer, varchar, varchar,
      timestamptz, bigint, integer
    ) from album_haven_readonly;
    revoke execute on function ops.load_claimed_lastfm_session_secret(
      bigint, bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_readonly;
  end if;
end $$;
