alter table integration.pending_scrobbles
  add column if not exists row_revision bigint not null default 0,
  add column if not exists accepted_attempt integer,
  add column if not exists current_job_id bigint
    references ops.jobs(id) on delete set null,
  add column if not exists active_session_id bigint
    references integration.lastfm_sessions(id) on delete set null,
  add column if not exists request_origin_id bigint
    references app.request_origins(id) on delete set null,
  add column if not exists last_provider_disposition varchar(48),
  add column if not exists repair_reason_code varchar(128);

update integration.pending_scrobbles
   set attempt_count = greatest(0, least(attempt_count, 5)),
       status = case
         when attempt_count >= 5 then 'exhausted'
         when status in (
           'pending', 'accepted', 'sending', 'retry_wait',
           'reauthentication_required', 'permanent', 'exhausted',
           'completed', 'canceled', 'ambiguous', 'orphaned_repair'
         ) then status
         else 'orphaned_repair'
       end,
       repair_reason_code = case
         when attempt_count < 0 or attempt_count > 5 then 'legacy_attempt_repaired'
         when status not in (
           'pending', 'accepted', 'sending', 'retry_wait',
           'reauthentication_required', 'permanent', 'exhausted',
           'completed', 'canceled', 'ambiguous', 'orphaned_repair'
         ) then 'legacy_status_repaired'
         else repair_reason_code
       end,
       updated_at = now()
 where attempt_count < 0
    or attempt_count > 5
    or status not in (
      'pending', 'accepted', 'sending', 'retry_wait',
      'reauthentication_required', 'permanent', 'exhausted',
      'completed', 'canceled', 'ambiguous', 'orphaned_repair'
    );

alter table integration.pending_scrobbles
  drop constraint if exists pending_scrobbles_attempt_state_check;

alter table integration.pending_scrobbles
  add constraint pending_scrobbles_attempt_state_check check (
    attempt_count >= 0 and attempt_count <= 5 and row_revision >= 0 and
    (accepted_attempt is null or (
      accepted_attempt >= 1 and accepted_attempt <= 5 and
      accepted_attempt >= attempt_count
    ))
  );

alter table integration.pending_scrobbles
  drop constraint if exists pending_scrobbles_status_check;

alter table integration.pending_scrobbles
  add constraint pending_scrobbles_status_check check (status in (
    'pending', 'accepted', 'sending', 'retry_wait',
    'reauthentication_required', 'permanent', 'exhausted',
    'completed', 'canceled', 'ambiguous', 'orphaned_repair'
  ));

alter table integration.pending_scrobbles
  drop constraint if exists pending_scrobbles_provider_disposition_check;

alter table integration.pending_scrobbles
  add constraint pending_scrobbles_provider_disposition_check check (
    last_provider_disposition is null or last_provider_disposition in (
      'accepted', 'known_not_sent_retryable', 'reauthentication_required',
      'permanent_rejection', 'possible_send_ambiguous',
      'canceled_before_send'
    )
  );

alter table integration.pending_scrobbles
  drop constraint if exists pending_scrobbles_job_state_check;

alter table integration.pending_scrobbles
  add constraint pending_scrobbles_job_state_check check (
    current_job_id is null or accepted_attempt is not null
  );

create unique index if not exists pending_scrobbles_source_identity_idx
  on integration.pending_scrobbles (
    account_id,
    library_id,
    (payload->>'source_family'),
    (payload->>'source_key')
  )
  where account_id is not null
    and library_id is not null
    and payload ? 'source_family'
    and payload ? 'source_key';

create unique index if not exists pending_scrobbles_current_job_id_key
  on integration.pending_scrobbles (current_job_id)
  where current_job_id is not null;

create index if not exists pending_scrobbles_active_session_id_idx
  on integration.pending_scrobbles (active_session_id);

create index if not exists pending_scrobbles_request_origin_id_idx
  on integration.pending_scrobbles (request_origin_id);

drop index if exists integration.pending_scrobbles_status_next_attempt_idx;

create index if not exists pending_scrobbles_due_retry_idx
  on integration.pending_scrobbles (next_attempt_at, id)
  where status in ('pending', 'retry_wait')
    and current_job_id is null
    and attempt_count < 5;

comment on column integration.pending_scrobbles.current_job_id is
  'One generic one-attempt job owning the currently accepted provider attempt.';

comment on column integration.pending_scrobbles.repair_reason_code is
  'Bounded recovery evidence; never a provider response or payload.';
