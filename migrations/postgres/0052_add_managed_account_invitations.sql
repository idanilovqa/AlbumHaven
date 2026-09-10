create table if not exists app.account_invitation_tokens (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  token_hash bytea not null,
  purpose text not null default 'account_invitation',
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  request_ref text not null,
  constraint account_invitation_tokens_hash_check check (octet_length(token_hash) = 32),
  constraint account_invitation_tokens_purpose_check check (purpose = 'account_invitation'),
  constraint account_invitation_tokens_expiry_check check (expires_at > created_at)
);

create unique index if not exists account_invitation_tokens_purpose_hash_idx
  on app.account_invitation_tokens (purpose, token_hash);

create index if not exists account_invitation_tokens_account_idx
  on app.account_invitation_tokens (account_id);

create unique index if not exists account_invitation_tokens_active_account_idx
  on app.account_invitation_tokens (account_id)
  where consumed_at is null and revoked_at is null;

create table if not exists app.account_invitation_transactions (
  id bigint generated always as identity primary key,
  invitation_token_id bigint not null
    references app.account_invitation_tokens(id) on delete cascade,
  transaction_hash bytea not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint account_invitation_transactions_invitation_token_id_key
    unique (invitation_token_id),
  constraint account_invitation_transactions_hash_check
    check (octet_length(transaction_hash) = 32),
  constraint account_invitation_transactions_expiry_check
    check (expires_at > created_at)
);

create index if not exists account_invitation_transactions_active_expiry_idx
  on app.account_invitation_transactions (expires_at)
  where consumed_at is null;

alter table app.mail_outbox
  add column if not exists invitation_token_id bigint
  references app.account_invitation_tokens(id) on delete set null;

create index if not exists mail_outbox_invitation_token_idx
  on app.mail_outbox (invitation_token_id)
  where invitation_token_id is not null;

alter table app.mail_outbox
  drop constraint if exists mail_outbox_message_category_check;

alter table app.mail_outbox
  add constraint mail_outbox_message_category_check
  check (message_category in ('welcome', 'password_reset', 'account_invitation'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table app.account_invitation_tokens from album_haven_readonly;
    revoke all on table app.account_invitation_transactions from album_haven_readonly;
    revoke all on sequence app.account_invitation_tokens_id_seq from album_haven_readonly;
    revoke all on sequence app.account_invitation_transactions_id_seq from album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table app.account_invitation_tokens from album_haven_app;
    revoke all on table app.account_invitation_transactions from album_haven_app;
    grant select, insert, update on table app.account_invitation_tokens to album_haven_app;
    grant select, insert, update on table app.account_invitation_transactions to album_haven_app;
    grant usage, select on sequence app.account_invitation_tokens_id_seq to album_haven_app;
    grant usage, select on sequence app.account_invitation_transactions_id_seq to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table app.account_invitation_tokens to album_haven_migrator;
    grant all privileges on table app.account_invitation_transactions to album_haven_migrator;
    grant all privileges on sequence app.account_invitation_tokens_id_seq to album_haven_migrator;
    grant all privileges on sequence app.account_invitation_transactions_id_seq to album_haven_migrator;
  end if;
end $$;
