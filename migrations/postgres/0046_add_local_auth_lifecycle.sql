alter table app.accounts
  add column if not exists username_display text,
  add column if not exists username_normalized text not null default 'migration-pending',
  add column if not exists contact_email text,
  add column if not exists contact_email_normalized text not null default 'migration-pending@invalid',
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_reason text;

update app.accounts
set username_display = coalesce(username_display, 'pending-account-' || id::text),
    username_normalized = case
      when username_normalized is null or username_normalized = 'migration-pending'
        then 'pending-account-' || id::text
      else username_normalized
    end,
    contact_email = coalesce(contact_email, 'pending-account-' || id::text || '@invalid'),
    contact_email_normalized = case
      when contact_email_normalized is null
        or contact_email_normalized = 'migration-pending@invalid'
        then 'pending-account-' || id::text || '@invalid'
      else contact_email_normalized
    end
where username_display is null
   or username_normalized is null
   or username_normalized = 'migration-pending'
   or contact_email is null
   or contact_email_normalized is null
   or contact_email_normalized = 'migration-pending@invalid';

alter table app.accounts
  alter column username_display set not null,
  alter column username_normalized set not null,
  alter column username_normalized drop default,
  alter column contact_email set not null,
  alter column contact_email_normalized set not null,
  alter column contact_email_normalized drop default;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'accounts_username_display_nonempty_check'
      and conrelid = 'app.accounts'::regclass
  ) then
    alter table app.accounts
      add constraint accounts_username_display_nonempty_check
      check (username_display <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'accounts_username_normalized_nonempty_check'
      and conrelid = 'app.accounts'::regclass
  ) then
    alter table app.accounts
      add constraint accounts_username_normalized_nonempty_check
      check (username_normalized <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'accounts_contact_email_nonempty_check'
      and conrelid = 'app.accounts'::regclass
  ) then
    alter table app.accounts
      add constraint accounts_contact_email_nonempty_check
      check (contact_email <> '');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'accounts_contact_email_normalized_nonempty_check'
      and conrelid = 'app.accounts'::regclass
  ) then
    alter table app.accounts
      add constraint accounts_contact_email_normalized_nonempty_check
      check (contact_email_normalized <> '');
  end if;
end $$;

create unique index if not exists accounts_username_normalized_idx
  on app.accounts (username_normalized);

create unique index if not exists accounts_contact_email_normalized_idx
  on app.accounts (contact_email_normalized);

create table if not exists app.account_credentials (
  account_id bigint primary key references app.accounts(id) on delete cascade,
  encoded_hash text not null,
  hash_algorithm text not null default 'argon2id'
    check (hash_algorithm = 'argon2id'),
  hash_policy_version integer not null default 1
    check (hash_policy_version >= 1),
  credential_version integer not null default 1
    check (credential_version >= 1),
  administrator_set boolean not null default false,
  password_set_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.password_reset_tokens (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  token_hash bytea not null check (octet_length(token_hash) = 32),
  purpose text not null default 'password_reset'
    check (purpose = 'password_reset'),
  credential_version integer not null check (credential_version >= 1),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  request_ref text not null,
  check (expires_at > created_at)
);

create index if not exists password_reset_tokens_account_id_idx
  on app.password_reset_tokens (account_id);

create unique index if not exists password_reset_tokens_purpose_hash_idx
  on app.password_reset_tokens (purpose, token_hash);

create unique index if not exists password_reset_tokens_active_account_purpose_idx
  on app.password_reset_tokens (account_id, purpose)
  where consumed_at is null and revoked_at is null;

create table if not exists app.auth_throttles (
  id bigint generated always as identity primary key,
  bucket_kind text not null check (
    bucket_kind in (
      'login_account',
      'login_source',
      'reset_candidate',
      'reset_account',
      'reset_source',
      'welcome_account'
    )
  ),
  bucket_hash bytea not null check (octet_length(bucket_hash) = 32),
  key_version integer not null default 1 check (key_version >= 1),
  window_started_at timestamptz not null,
  window_expires_at timestamptz not null,
  failure_count integer not null default 0 check (failure_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default now(),
  check (window_expires_at > window_started_at)
);

create unique index if not exists auth_throttles_bucket_idx
  on app.auth_throttles (bucket_kind, key_version, bucket_hash);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'app'
      and table_name = 'account_sessions'
      and column_name = 'session_token_hash'
      and data_type = 'text'
  ) then
    alter table app.account_sessions
      alter column session_token_hash type bytea
      using case
        when session_token_hash ~ '^[0-9A-Fa-f]{64}$'
          then decode(session_token_hash, 'hex')
        else sha256(convert_to(session_token_hash, 'UTF8'))
      end;
  end if;
end $$;

alter table app.account_sessions
  add column if not exists authenticated_at timestamptz,
  add column if not exists idle_expires_at timestamptz,
  add column if not exists absolute_expires_at timestamptz,
  add column if not exists revocation_reason text,
  add column if not exists user_agent text;

update app.account_sessions
set authenticated_at = coalesce(authenticated_at, created_at),
    last_seen_at = coalesce(last_seen_at, created_at),
    absolute_expires_at = coalesce(
      absolute_expires_at,
      greatest(
        created_at + interval '1 second',
        least(
          coalesce(expires_at, created_at + interval '7 days'),
          created_at + interval '7 days'
        )
      )
    ),
    revoked_at = coalesce(revoked_at, now()),
    revocation_reason = coalesce(revocation_reason, 'legacy_phase_7_migration')
where authenticated_at is null;

update app.account_sessions
set idle_expires_at = coalesce(
  idle_expires_at,
  least(created_at + interval '12 hours', absolute_expires_at)
);

alter table app.account_sessions
  alter column authenticated_at set not null,
  alter column last_seen_at set not null,
  alter column idle_expires_at set not null,
  alter column absolute_expires_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'account_sessions_token_hash_size_check'
      and conrelid = 'app.account_sessions'::regclass
  ) then
    alter table app.account_sessions
      add constraint account_sessions_token_hash_size_check
      check (octet_length(session_token_hash) = 32);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'account_sessions_absolute_lifetime_check'
      and conrelid = 'app.account_sessions'::regclass
  ) then
    alter table app.account_sessions
      add constraint account_sessions_absolute_lifetime_check
      check (absolute_expires_at > created_at);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'account_sessions_idle_lifetime_check'
      and conrelid = 'app.account_sessions'::regclass
  ) then
    alter table app.account_sessions
      add constraint account_sessions_idle_lifetime_check
      check (idle_expires_at <= absolute_expires_at);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'account_sessions_user_agent_length_check'
      and conrelid = 'app.account_sessions'::regclass
  ) then
    alter table app.account_sessions
      add constraint account_sessions_user_agent_length_check
      check (user_agent is null or char_length(user_agent) <= 1024);
  end if;
end $$;

create index if not exists account_sessions_active_account_idx
  on app.account_sessions (account_id, idle_expires_at, absolute_expires_at)
  where revoked_at is null;

create table if not exists app.security_audit_events (
  id bigint generated always as identity primary key,
  actor_account_id bigint references app.accounts(id) on delete set null,
  target_account_id bigint references app.accounts(id) on delete set null,
  event_category text not null,
  outcome text not null,
  reason_code text,
  request_ref text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists security_audit_events_actor_account_id_idx
  on app.security_audit_events (actor_account_id);

create index if not exists security_audit_events_target_account_id_idx
  on app.security_audit_events (target_account_id);

create index if not exists security_audit_events_category_occurred_at_idx
  on app.security_audit_events (event_category, occurred_at);

create table if not exists app.mail_outbox (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  reset_token_id bigint references app.password_reset_tokens(id) on delete set null,
  message_category text not null check (
    message_category in ('welcome', 'password_reset')
  ),
  delivery_status text not null default 'pending' check (
    delivery_status in ('pending', 'sending', 'sent', 'failed', 'unknown')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_reference text,
  created_at timestamptz not null default now()
);

create index if not exists mail_outbox_account_id_idx
  on app.mail_outbox (account_id);

create index if not exists mail_outbox_reset_token_id_idx
  on app.mail_outbox (reset_token_id);

create index if not exists mail_outbox_pending_claim_idx
  on app.mail_outbox (next_attempt_at, id)
  where delivery_status in ('pending', 'failed');

create index if not exists mail_outbox_unknown_reconciliation_idx
  on app.mail_outbox (claimed_at, id)
  where delivery_status = 'unknown';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table app.account_credentials from album_haven_readonly;
    revoke all on table app.password_reset_tokens from album_haven_readonly;
    revoke all on table app.auth_throttles from album_haven_readonly;
    revoke all on table app.account_sessions from album_haven_readonly;
    revoke all on table app.mail_outbox from album_haven_readonly;
    revoke all on table app.security_audit_events from album_haven_readonly;
    grant select on table app.accounts to album_haven_readonly;
    grant select on table app.security_audit_events to album_haven_readonly;
    revoke all on sequence app.password_reset_tokens_id_seq from album_haven_readonly;
    revoke all on sequence app.auth_throttles_id_seq from album_haven_readonly;
    revoke all on sequence app.security_audit_events_id_seq from album_haven_readonly;
    revoke all on sequence app.mail_outbox_id_seq from album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table app.account_credentials from album_haven_app;
    revoke all on table app.password_reset_tokens from album_haven_app;
    revoke all on table app.auth_throttles from album_haven_app;
    revoke all on table app.account_sessions from album_haven_app;
    revoke all on table app.mail_outbox from album_haven_app;
    revoke all on table app.security_audit_events from album_haven_app;
    grant select, insert, update on table app.account_credentials to album_haven_app;
    grant select, insert, update on table app.password_reset_tokens to album_haven_app;
    grant select, insert, update, delete on table app.auth_throttles to album_haven_app;
    grant select, insert, update on table app.account_sessions to album_haven_app;
    grant select, insert, update on table app.mail_outbox to album_haven_app;
    grant insert on table app.security_audit_events to album_haven_app;
    grant usage, select on sequence app.password_reset_tokens_id_seq to album_haven_app;
    grant usage, select on sequence app.auth_throttles_id_seq to album_haven_app;
    grant usage, select on sequence app.security_audit_events_id_seq to album_haven_app;
    grant usage, select on sequence app.mail_outbox_id_seq to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table app.accounts to album_haven_migrator;
    grant all privileges on table app.account_credentials to album_haven_migrator;
    grant all privileges on table app.password_reset_tokens to album_haven_migrator;
    grant all privileges on table app.auth_throttles to album_haven_migrator;
    grant all privileges on table app.account_sessions to album_haven_migrator;
    grant all privileges on table app.mail_outbox to album_haven_migrator;
    grant all privileges on table app.security_audit_events to album_haven_migrator;
    grant all privileges on sequence app.password_reset_tokens_id_seq to album_haven_migrator;
    grant all privileges on sequence app.auth_throttles_id_seq to album_haven_migrator;
    grant all privileges on sequence app.security_audit_events_id_seq to album_haven_migrator;
    grant all privileges on sequence app.mail_outbox_id_seq to album_haven_migrator;
  end if;
end $$;
