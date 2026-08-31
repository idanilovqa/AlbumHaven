alter table app.auth_preflight_tokens
  drop constraint if exists auth_preflight_tokens_purpose_check;

alter table app.auth_preflight_tokens
  add constraint auth_preflight_tokens_purpose_check
  check (purpose in ('login', 'forgot_password'));

create table if not exists app.password_reset_transactions (
  id bigint generated always as identity primary key,
  reset_token_id bigint not null references app.password_reset_tokens(id) on delete cascade,
  transaction_hash bytea not null check (octet_length(transaction_hash) = 32),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at >= created_at)
);

create unique index if not exists password_reset_transactions_hash_idx
  on app.password_reset_transactions (transaction_hash);

create index if not exists password_reset_transactions_reset_token_idx
  on app.password_reset_transactions (reset_token_id);

create index if not exists password_reset_transactions_active_expiry_idx
  on app.password_reset_transactions (expires_at, id)
  where consumed_at is null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table app.password_reset_transactions from album_haven_readonly;
    revoke all on sequence app.password_reset_transactions_id_seq from album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table app.password_reset_transactions from album_haven_app;
    grant select, insert, update, delete on table app.password_reset_transactions to album_haven_app;
    grant usage, select on sequence app.password_reset_transactions_id_seq to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table app.password_reset_transactions to album_haven_migrator;
    grant all privileges on sequence app.password_reset_transactions_id_seq to album_haven_migrator;
  end if;
end $$;
