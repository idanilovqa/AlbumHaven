alter table app.mail_outbox
  add column if not exists target_credential_version integer,
  add column if not exists lifecycle_expires_at timestamptz,
  add column if not exists public_throttle_id bigint
    references app.auth_throttles(id) on delete set null;

create index if not exists mail_outbox_public_throttle_id_idx
  on app.mail_outbox (public_throttle_id)
  where public_throttle_id is not null;

alter table app.mail_outbox
  drop constraint if exists mail_outbox_target_credential_version_check;
alter table app.mail_outbox
  add constraint mail_outbox_target_credential_version_check check (
    target_credential_version is null or target_credential_version >= 1
  );

alter table app.mail_outbox
  drop constraint if exists mail_outbox_lifecycle_expiry_check;
alter table app.mail_outbox
  add constraint mail_outbox_lifecycle_expiry_check check (
    lifecycle_expires_at is null or lifecycle_expires_at > created_at
  );

create or replace function ops.validate_claimed_auth_mail(
  p_outbox_id bigint,
  p_category varchar,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz,
  p_row_revision bigint,
  p_accepted_attempt integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  expected_job_kind varchar;
  expected_capability varchar;
  expected_max_attempts integer;
begin
  if p_category = 'welcome' then
    expected_job_kind := 'auth_welcome_delivery';
    expected_capability := 'accounts.welcome.send';
    expected_max_attempts := 3;
  elsif p_category = 'account_invitation' then
    expected_job_kind := 'auth_invitation_delivery';
    expected_capability := 'accounts.invitation.send';
    expected_max_attempts := 1;
  elsif p_category = 'password_reset' then
    expected_job_kind := 'auth_password_reset_delivery';
    expected_capability := 'accounts.password_reset.send';
    expected_max_attempts := 1;
  else
    return false;
  end if;

  return exists (
    select 1
      from ops.jobs as job
      join app.mail_outbox as outbox
        on outbox.current_job_id = job.id
       and outbox.id = p_outbox_id
      join app.accounts as target_account
        on target_account.id = outbox.account_id
       and target_account.is_active
       and target_account.disabled_at is null
     where job.id = p_job_id
       and job.kind = expected_job_kind
       and job.subject_kind = 'mail_outbox'
       and job.subject_ref = outbox.id::text
       and job.parameters = '{}'::jsonb
       and job.idempotency_key = 'auth-mail:' || p_category || ':' ||
           outbox.id::text || ':attempt:' || outbox.accepted_attempt::text
       and job.max_attempts = expected_max_attempts
       and job.request_origin_id is not distinct from outbox.request_origin_id
       and (
         (outbox.authorization_mode = 'actor'
          and outbox.actor_account_id is not null
          and job.account_id = outbox.actor_account_id
          and job.capability_key = expected_capability) or
         (p_category = 'password_reset'
          and outbox.authorization_mode = 'public_lifecycle'
          and outbox.actor_account_id is null
          and job.account_id is null
         and job.library_id is null
          and job.capability_key is null)
       )
       and outbox.message_category = p_category
       and outbox.delivery_status in ('pending', 'sending')
       and outbox.delivery_checkpoint in (
         'accepted', 'claimed', 'token_issued', 'send_started'
       )
       and outbox.row_revision = p_row_revision
       and outbox.accepted_attempt = p_accepted_attempt
       and outbox.row_revision = job.scope_version
       and outbox.accepted_attempt = job.resource_revision
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now
       and job.cancel_requested_at is null
       and case p_category
         when 'welcome' then
           outbox.reset_token_id is null and outbox.invitation_token_id is null
         when 'account_invitation' then
           outbox.reset_token_id is null
           and outbox.lifecycle_expires_at > p_now
           and not exists (
             select 1 from app.account_credentials as credential
              where credential.account_id = outbox.account_id
           )
           and (
             outbox.invitation_token_id is null or exists (
               select 1 from app.account_invitation_tokens as invitation
                where invitation.id = outbox.invitation_token_id
                  and invitation.account_id = outbox.account_id
                  and invitation.expires_at > p_now
                  and invitation.consumed_at is null
                  and invitation.revoked_at is null
             )
           )
         when 'password_reset' then
           outbox.invitation_token_id is null
           and outbox.lifecycle_expires_at > p_now
           and exists (
             select 1 from app.account_credentials as credential
              where credential.account_id = outbox.account_id
                and credential.credential_version =
                    outbox.target_credential_version
           )
           and (
             outbox.authorization_mode <> 'public_lifecycle' or exists (
               select 1 from app.auth_throttles as throttle
                where throttle.id = outbox.public_throttle_id
                  and throttle.bucket_kind = 'reset_account'
                  and throttle.window_expires_at > outbox.created_at
             )
           )
           and (
             outbox.reset_token_id is null or exists (
               select 1 from app.password_reset_tokens as reset_token
                where reset_token.id = outbox.reset_token_id
                  and reset_token.account_id = outbox.account_id
                  and reset_token.credential_version =
                      outbox.target_credential_version
                  and reset_token.expires_at > p_now
                  and reset_token.consumed_at is null
                  and reset_token.revoked_at is null
             )
           )
         else false
       end
  );
end;
$$;

create or replace function ops.load_claimed_auth_mail_context(
  p_outbox_id bigint,
  p_category varchar,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  outbox_id bigint,
  target_account_id bigint,
  username_display text,
  contact_email text,
  target_credential_version integer,
  lifecycle_expires_at timestamptz,
  delivery_checkpoint varchar,
  row_revision bigint,
  accepted_attempt integer
)
language sql
security definer
set search_path = pg_catalog
as $$
  select outbox.id,
         outbox.account_id,
         account.username_display,
         account.contact_email,
         outbox.target_credential_version,
         outbox.lifecycle_expires_at,
         outbox.delivery_checkpoint,
         outbox.row_revision,
         outbox.accepted_attempt
    from ops.jobs as job
    join app.mail_outbox as outbox on outbox.current_job_id = job.id
    join app.accounts as account on account.id = outbox.account_id
   where job.id = p_job_id
     and outbox.id = p_outbox_id
     and outbox.message_category = p_category
     and ops.validate_claimed_auth_mail(
       p_outbox_id, p_category, p_job_id, p_attempt, p_worker_id,
       p_lease_token, p_now, outbox.row_revision, outbox.accepted_attempt
     );
$$;

create or replace function ops.issue_claimed_auth_mail_token_hash(
  p_outbox_id bigint,
  p_category varchar,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz,
  p_expected_row_revision bigint,
  p_token_hash bytea,
  p_expires_at timestamptz,
  p_request_ref text
)
returns table (token_id bigint, row_revision bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  outbox_record app.mail_outbox%rowtype;
  created_token_id bigint;
  next_revision bigint;
begin
  if p_category not in ('account_invitation', 'password_reset')
     or octet_length(p_token_hash) <> 32
     or p_expires_at <= p_now
     or octet_length(p_request_ref) not between 1 and 256 then
    return;
  end if;

  select outbox.* into outbox_record
    from app.mail_outbox as outbox
   where outbox.id = p_outbox_id
     and outbox.message_category = p_category
     and outbox.delivery_checkpoint = 'accepted'
     and outbox.row_revision = p_expected_row_revision
     and outbox.accepted_attempt is not null
     and outbox.lifecycle_expires_at >= p_expires_at
     and ops.validate_claimed_auth_mail(
       p_outbox_id, p_category, p_job_id, p_attempt, p_worker_id,
       p_lease_token, p_now, p_expected_row_revision,
       outbox.accepted_attempt
     )
   for update;
  if not found then return; end if;

  if p_category = 'password_reset' then
    update app.password_reset_tokens
       set revoked_at = p_now
     where account_id = outbox_record.account_id
       and purpose = 'password_reset'
       and consumed_at is null
       and revoked_at is null;
    insert into app.password_reset_tokens (
      account_id, token_hash, purpose, credential_version,
      created_at, expires_at, request_ref
    ) values (
      outbox_record.account_id, p_token_hash, 'password_reset',
      outbox_record.target_credential_version, p_now, p_expires_at,
      p_request_ref
    ) returning id into created_token_id;
  else
    update app.account_invitation_tokens
       set revoked_at = p_now
     where account_id = outbox_record.account_id
       and consumed_at is null
       and revoked_at is null;
    insert into app.account_invitation_tokens (
      account_id, token_hash, purpose, created_at, expires_at, request_ref
    ) values (
      outbox_record.account_id, p_token_hash, 'account_invitation',
      p_now, p_expires_at, p_request_ref
    ) returning id into created_token_id;
  end if;

  next_revision := outbox_record.row_revision + 1;
  update app.mail_outbox
     set reset_token_id = case when p_category = 'password_reset'
                               then created_token_id else null end,
         invitation_token_id = case when p_category = 'account_invitation'
                                    then created_token_id else null end,
         delivery_status = 'sending',
         delivery_checkpoint = 'token_issued',
         claimed_at = p_now,
         attempt_count = outbox_record.accepted_attempt,
         row_revision = next_revision,
         updated_at = p_now
   where id = outbox_record.id;

  update ops.jobs
     set scope_version = next_revision,
         updated_at = p_now
   where id = p_job_id
     and state = 'running'
     and attempt_count = p_attempt
     and lease_owner = p_worker_id
     and lease_token = p_lease_token
     and lease_expires_at > p_now;
  if not found then
    raise exception 'Authentication mail claim changed during token issuance.';
  end if;

  return query select created_token_id, next_revision;
end;
$$;

revoke all on function ops.validate_claimed_auth_mail(
  bigint, varchar, bigint, integer, varchar, varchar,
  timestamptz, bigint, integer
) from public;
revoke all on function ops.load_claimed_auth_mail_context(
  bigint, varchar, bigint, integer, varchar, varchar, timestamptz
) from public;
revoke all on function ops.issue_claimed_auth_mail_token_hash(
  bigint, varchar, bigint, integer, varchar, varchar, timestamptz,
  bigint, bytea, timestamptz, text
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on table app.accounts from album_haven_worker;
    revoke all on table app.account_credentials from album_haven_worker;
    revoke all on table app.password_reset_tokens from album_haven_worker;
    revoke all on table app.account_invitation_tokens from album_haven_worker;
    revoke all on table app.auth_throttles from album_haven_worker;
    revoke all on table app.mail_outbox from album_haven_worker;
    revoke all on table app.security_audit_events from album_haven_worker;
    revoke all on sequence app.password_reset_tokens_id_seq from album_haven_worker;
    revoke all on sequence app.account_invitation_tokens_id_seq from album_haven_worker;
    grant execute on function ops.validate_claimed_auth_mail(
      bigint, varchar, bigint, integer, varchar, varchar,
      timestamptz, bigint, integer
    ) to album_haven_worker;
    grant execute on function ops.load_claimed_auth_mail_context(
      bigint, varchar, bigint, integer, varchar, varchar, timestamptz
    ) to album_haven_worker;
    grant execute on function ops.issue_claimed_auth_mail_token_hash(
      bigint, varchar, bigint, integer, varchar, varchar, timestamptz,
      bigint, bytea, timestamptz, text
    ) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke execute on function ops.validate_claimed_auth_mail(
      bigint, varchar, bigint, integer, varchar, varchar,
      timestamptz, bigint, integer
    ) from album_haven_readonly;
    revoke execute on function ops.load_claimed_auth_mail_context(
      bigint, varchar, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_readonly;
    revoke execute on function ops.issue_claimed_auth_mail_token_hash(
      bigint, varchar, bigint, integer, varchar, varchar, timestamptz,
      bigint, bytea, timestamptz, text
    ) from album_haven_readonly;
  end if;
end $$;
