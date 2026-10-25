alter table app.mail_outbox
  add column if not exists row_revision bigint not null default 0,
  add column if not exists accepted_attempt integer,
  add column if not exists current_job_id bigint
    references ops.jobs(id) on delete set null,
  add column if not exists request_origin_id bigint
    references app.request_origins(id) on delete set null,
  add column if not exists actor_account_id bigint
    references app.accounts(id) on delete set null,
  add column if not exists authorization_mode varchar(32) not null default 'actor',
  add column if not exists delivery_checkpoint varchar(32) not null default 'accepted',
  add column if not exists provider_disposition varchar(48),
  add column if not exists delivery_reason_code varchar(128),
  add column if not exists updated_at timestamptz not null default now();

update app.mail_outbox
   set delivery_status = 'failed',
       delivery_checkpoint = 'terminal',
       next_attempt_at = null,
       accepted_attempt = 5,
       delivery_reason_code = 'legacy_attempt_exhausted',
       updated_at = now()
 where message_category = 'welcome'
   and attempt_count >= 5
   and current_job_id is null
   and delivery_status in ('pending', 'failed');

update app.mail_outbox
   set delivery_status = 'unknown',
       delivery_checkpoint = 'terminal',
       next_attempt_at = null,
       accepted_attempt = greatest(1, least(5, attempt_count)),
       provider_disposition = 'possible_send_ambiguous',
       delivery_reason_code = 'legacy_sending_unknown',
       updated_at = now()
 where message_category = 'welcome'
   and current_job_id is null
   and delivery_status = 'sending';

update app.mail_outbox
   set delivery_status = 'unknown',
       delivery_checkpoint = 'terminal',
       next_attempt_at = null,
       accepted_attempt = 1,
       provider_disposition = 'possible_send_ambiguous',
       delivery_reason_code = 'legacy_token_unavailable',
       updated_at = now()
 where message_category in ('account_invitation', 'password_reset')
   and current_job_id is null
   and delivery_status in ('pending', 'sending', 'failed');

update app.mail_outbox
   set delivery_checkpoint = 'terminal',
       next_attempt_at = null,
       accepted_attempt = coalesce(
         accepted_attempt,
         case when message_category = 'welcome'
              then greatest(1, least(5, attempt_count)) else 1 end
       ),
       updated_at = now()
 where delivery_status in ('sent', 'unknown')
    or (delivery_status = 'failed' and next_attempt_at is null);

update app.mail_outbox
   set accepted_attempt = attempt_count + 1,
       delivery_checkpoint = 'accepted',
       updated_at = now()
 where message_category = 'welcome'
   and current_job_id is null
   and delivery_status in ('pending', 'failed')
   and attempt_count < 5
   and accepted_attempt is null;

alter table app.mail_outbox
  drop constraint if exists mail_outbox_job_attempt_check;
alter table app.mail_outbox
  add constraint mail_outbox_job_attempt_check check (
    row_revision >= 0 and
    (accepted_attempt is null or (
      accepted_attempt between 1 and 5 and
      accepted_attempt >= greatest(1, least(5, attempt_count)) and
      accepted_attempt <= least(5, attempt_count + 1)
    )) and
    (message_category = 'welcome' or accepted_attempt is null or accepted_attempt = 1)
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_job_timestamp_check;
alter table app.mail_outbox
  add constraint mail_outbox_job_timestamp_check check (
    updated_at >= created_at and
    (claimed_at is null or claimed_at >= created_at) and
    (sent_at is null or sent_at >= created_at) and
    (next_attempt_at is null or next_attempt_at >= created_at)
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_delivery_reason_code_check;
alter table app.mail_outbox
  add constraint mail_outbox_delivery_reason_code_check check (
    delivery_reason_code is null or
    octet_length(delivery_reason_code) between 1 and 128
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_authorization_mode_check;
alter table app.mail_outbox
  add constraint mail_outbox_authorization_mode_check check (
    authorization_mode = 'actor' or
    (authorization_mode = 'public_lifecycle' and actor_account_id is null and
      message_category = 'password_reset')
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_delivery_checkpoint_check;
alter table app.mail_outbox
  add constraint mail_outbox_delivery_checkpoint_check check (
    delivery_checkpoint in (
      'accepted', 'claimed', 'token_issued', 'send_started', 'terminal'
    ) and
    (delivery_status not in ('sent', 'unknown') or next_attempt_at is null) and
    (delivery_checkpoint <> 'terminal' or next_attempt_at is null)
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_provider_disposition_check;
alter table app.mail_outbox
  add constraint mail_outbox_provider_disposition_check check (
    provider_disposition is null or provider_disposition in (
      'delivered', 'known_not_sent_retryable', 'known_not_sent_terminal',
      'possible_send_ambiguous', 'ineligible_before_token',
      'canceled_before_send'
    )
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_token_category_check;
alter table app.mail_outbox
  add constraint mail_outbox_token_category_check check (
    (message_category = 'welcome' and reset_token_id is null and invitation_token_id is null) or
    (message_category = 'password_reset' and invitation_token_id is null) or
    (message_category = 'account_invitation' and reset_token_id is null)
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_job_link_check;
alter table app.mail_outbox
  add constraint mail_outbox_job_link_check check (
    current_job_id is null or (
      accepted_attempt is not null and
      (authorization_mode = 'public_lifecycle' or actor_account_id is not null)
    )
  );

create unique index if not exists mail_outbox_current_job_id_key
  on app.mail_outbox (current_job_id)
  where current_job_id is not null;

create index if not exists mail_outbox_request_origin_id_idx
  on app.mail_outbox (request_origin_id)
  where request_origin_id is not null;

create index if not exists mail_outbox_actor_account_id_idx
  on app.mail_outbox (actor_account_id)
  where actor_account_id is not null;

create index if not exists mail_outbox_due_welcome_job_idx
  on app.mail_outbox (next_attempt_at, id)
  where message_category = 'welcome'
    and delivery_status in ('pending', 'failed')
    and current_job_id is null
    and attempt_count < 5;

create index if not exists mail_outbox_tokenless_accepted_idx
  on app.mail_outbox (message_category, created_at, id)
  where message_category in ('account_invitation', 'password_reset')
    and delivery_status = 'pending'
    and delivery_checkpoint = 'accepted'
    and reset_token_id is null
    and invitation_token_id is null;

create index if not exists mail_outbox_stale_sending_job_idx
  on app.mail_outbox (claimed_at, id)
  where delivery_status = 'sending'
    and delivery_checkpoint in ('claimed', 'token_issued', 'send_started');

create index if not exists mail_outbox_terminal_retention_idx
  on app.mail_outbox (updated_at, id)
  where delivery_status in ('sent', 'failed', 'unknown');

comment on column app.mail_outbox.current_job_id is
  'Generic job owning the currently accepted domain delivery attempt.';
comment on column app.mail_outbox.delivery_reason_code is
  'Bounded lifecycle evidence; never a recipient, token, message, or provider response.';
