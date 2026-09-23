create table if not exists ops.jobs (
  id bigint generated always as identity primary key,
  kind varchar(64) not null,
  state varchar(32) not null default 'queued',
  subject_kind varchar(128) not null,
  subject_ref varchar(1024) not null,
  parameters jsonb not null default '{}'::jsonb,
  account_id bigint references app.accounts(id) on delete restrict,
  library_id bigint references library.libraries(id) on delete restrict,
  capability_key varchar(128),
  request_origin_id bigint references app.request_origins(id) on delete set null,
  deployment_mode varchar(128) not null,
  client_surface varchar(128) not null,
  scope_version bigint,
  resource_revision bigint,
  idempotency_key varchar(1024) not null,
  priority smallint not null default 0,
  scheduled_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  max_attempts integer not null,
  recovery_policy varchar(48) not null,
  lease_owner varchar(128),
  lease_token varchar(128),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by_account_id bigint references app.accounts(id) on delete set null,
  cancel_reason_code varchar(128),
  started_at timestamptz,
  completed_at timestamptz,
  outcome_code varchar(128),
  audit_hold boolean not null default false,
  tombstoned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_kind_check check (kind in (
    'full_scan',
    'targeted_reconciliation',
    'post_scan_cover_refresh',
    'cover_lookup',
    'cover_remote_save',
    'lastfm_scrobble_retry',
    'auth_welcome_delivery',
    'auth_invitation_delivery',
    'auth_password_reset_delivery'
  )),
  constraint jobs_state_check check (state in (
    'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled', 'ambiguous'
  )),
  constraint jobs_parameters_shape_check check (jsonb_typeof(parameters) = 'object'),
  constraint jobs_parameters_size_check check (octet_length(parameters::text) <= 4096),
  constraint jobs_scope_revision_check check (
    (scope_version is null or scope_version >= 0) and
    (resource_revision is null or resource_revision >= 0)
  ),
  constraint jobs_attempts_check check (
    attempt_count >= 0 and max_attempts > 0 and attempt_count <= max_attempts
  ),
  constraint jobs_kind_attempts_check check (
    (kind = 'full_scan' and max_attempts = 2) or
    (kind = 'targeted_reconciliation' and max_attempts = 3) or
    (kind = 'post_scan_cover_refresh' and max_attempts = 2) or
    (kind = 'cover_lookup' and max_attempts = 2) or
    (kind = 'cover_remote_save' and max_attempts = 1) or
    (kind = 'lastfm_scrobble_retry' and max_attempts = 1) or
    (kind = 'auth_welcome_delivery' and max_attempts = 3) or
    (kind = 'auth_invitation_delivery' and max_attempts = 1) or
    (kind = 'auth_password_reset_delivery' and max_attempts = 1)
  ),
  constraint jobs_recovery_policy_check check (
    recovery_policy in ('retry_safe', 'ambiguous_on_stale_lease')
  ),
  constraint jobs_kind_recovery_check check (
    (kind in (
      'full_scan', 'targeted_reconciliation', 'post_scan_cover_refresh',
      'cover_lookup', 'auth_welcome_delivery'
    ) and recovery_policy = 'retry_safe') or
    (kind in (
      'cover_remote_save', 'lastfm_scrobble_retry',
      'auth_invitation_delivery', 'auth_password_reset_delivery'
    ) and recovery_policy = 'ambiguous_on_stale_lease')
  ),
  constraint jobs_lease_coherence_check check (
    (
      state = 'running' and
      lease_owner is not null and lease_token is not null and
      lease_expires_at is not null and heartbeat_at is not null
    ) or (
      state <> 'running' and
      lease_owner is null and lease_token is null and
      lease_expires_at is null and heartbeat_at is null
    )
  ),
  constraint jobs_terminal_coherence_check check (
    (
      state in ('succeeded', 'failed', 'canceled', 'ambiguous') and
      completed_at is not null
    ) or (
      state in ('queued', 'running', 'retry_wait') and
      completed_at is null and tombstoned_at is null
    )
  ),
  constraint jobs_started_coherence_check check (
    state in ('queued', 'canceled') or started_at is not null
  ),
  constraint jobs_cancel_request_coherence_check check (
    (cancel_requested_at is null and cancel_requested_by_account_id is null and cancel_reason_code is null) or
    (cancel_requested_at is not null and cancel_reason_code is not null)
  ),
  constraint jobs_tombstone_coherence_check check (
    tombstoned_at is null or completed_at is not null
  )
);

create table if not exists ops.job_transitions (
  id bigint generated always as identity primary key,
  job_id bigint not null references ops.jobs(id) on delete cascade,
  prior_state varchar(32),
  next_state varchar(32) not null,
  attempt_count integer not null,
  reason_code varchar(128) not null,
  retry_decision varchar(32) not null default 'none',
  next_due_at timestamptz,
  worker_instance_id varchar(128),
  transitioned_at timestamptz not null default now(),
  constraint job_transitions_prior_state_check check (
    prior_state is null or prior_state in (
      'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled', 'ambiguous'
    )
  ),
  constraint job_transitions_next_state_check check (next_state in (
    'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled', 'ambiguous'
  )),
  constraint job_transitions_attempt_check check (attempt_count >= 0),
  constraint job_transitions_retry_check check (
    (retry_decision = 'none' and next_due_at is null) or
    (retry_decision = 'scheduled' and next_state = 'retry_wait' and next_due_at is not null) or
    (retry_decision = 'exhausted' and next_state in ('failed', 'ambiguous') and next_due_at is null)
  )
);

create table if not exists ops.worker_instances (
  instance_id varchar(128) primary key,
  lifecycle_state varchar(32) not null,
  started_at timestamptz not null,
  last_heartbeat_at timestamptz not null,
  compatible_schema_version integer not null,
  registered_handler_fingerprint varchar(128) not null,
  drain_state varchar(32) not null default 'none',
  drain_started_at timestamptz,
  drain_deadline_at timestamptz,
  stopped_at timestamptz,
  constraint worker_instances_lifecycle_state_check check (
    lifecycle_state in ('starting', 'running', 'draining', 'stopped')
  ),
  constraint worker_instances_schema_version_check check (compatible_schema_version > 0),
  constraint worker_instances_drain_state_check check (
    drain_state in ('none', 'requested', 'draining', 'complete')
  ),
  constraint worker_instances_drain_coherence_check check (
    (drain_state = 'none' and drain_started_at is null and drain_deadline_at is null) or
    (drain_state in ('requested', 'draining') and drain_started_at is not null and drain_deadline_at is not null) or
    (drain_state = 'complete' and drain_started_at is not null)
  ),
  constraint worker_instances_lifecycle_coherence_check check (
    (lifecycle_state = 'stopped' and stopped_at is not null) or
    (lifecycle_state <> 'stopped' and stopped_at is null)
  )
);

create unique index if not exists jobs_idempotency_idx
  on ops.jobs (
    kind,
    coalesce(account_id, 0),
    coalesce(library_id, 0),
    subject_kind,
    subject_ref,
    idempotency_key
  );

create index if not exists jobs_account_id_idx on ops.jobs (account_id);
create index if not exists jobs_library_id_idx on ops.jobs (library_id);
create index if not exists jobs_request_origin_id_idx on ops.jobs (request_origin_id);
create index if not exists jobs_cancel_requested_by_account_id_idx
  on ops.jobs (cancel_requested_by_account_id);

create index if not exists jobs_runnable_claim_idx
  on ops.jobs (priority desc, scheduled_at, id)
  where state in ('queued', 'retry_wait');

create index if not exists jobs_active_lease_idx
  on ops.jobs (lease_expires_at, id)
  where state = 'running';

create index if not exists jobs_owner_library_status_idx
  on ops.jobs (account_id, library_id, state, created_at desc, id desc);

create index if not exists jobs_retry_due_idx
  on ops.jobs (scheduled_at, id)
  where state = 'retry_wait';

create index if not exists jobs_terminal_retention_idx
  on ops.jobs (completed_at, id)
  where state in ('succeeded', 'failed', 'canceled') and audit_hold = false;

create index if not exists job_transitions_job_id_idx
  on ops.job_transitions (job_id, transitioned_at, id);

create index if not exists worker_instances_heartbeat_idx
  on ops.worker_instances (last_heartbeat_at, instance_id)
  where lifecycle_state in ('starting', 'running', 'draining');

create index if not exists worker_instances_retention_idx
  on ops.worker_instances (last_heartbeat_at, instance_id)
  where lifecycle_state = 'stopped';

revoke all on table ops.jobs from public;
revoke all on table ops.job_transitions from public;
revoke all on table ops.worker_instances from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table ops.jobs from album_haven_readonly;
    revoke all on table ops.job_transitions from album_haven_readonly;
    revoke all on table ops.worker_instances from album_haven_readonly;
    revoke all on sequence ops.jobs_id_seq from album_haven_readonly;
    revoke all on sequence ops.job_transitions_id_seq from album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant usage on schema ops to album_haven_app;
    grant select on table ops.jobs to album_haven_app;
    grant insert (
      kind, subject_kind, subject_ref, parameters, account_id, library_id,
      capability_key, request_origin_id, deployment_mode, client_surface,
      scope_version, resource_revision, idempotency_key, priority, scheduled_at,
      max_attempts, recovery_policy
    ) on table ops.jobs to album_haven_app;
    grant update (
      cancel_requested_at, cancel_requested_by_account_id, cancel_reason_code, updated_at
    ) on table ops.jobs to album_haven_app;
    grant select on table ops.job_transitions, ops.worker_instances to album_haven_app;
    grant usage, select on sequence ops.jobs_id_seq to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant usage on schema ops to album_haven_worker;
    grant select, update on table ops.jobs to album_haven_worker;
    grant select, insert on table ops.job_transitions to album_haven_worker;
    grant select, insert, update on table ops.worker_instances to album_haven_worker;
    grant usage, select on sequence ops.job_transitions_id_seq to album_haven_worker;
  end if;
end $$;
