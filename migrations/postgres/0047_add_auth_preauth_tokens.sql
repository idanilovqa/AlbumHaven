create table if not exists app.auth_preflight_tokens (
  id bigint generated always as identity primary key,
  token_hash bytea not null check (octet_length(token_hash) = 32),
  purpose text not null default 'login' check (purpose = 'login'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at >= created_at)
);

create unique index if not exists auth_preflight_tokens_purpose_hash_idx
  on app.auth_preflight_tokens (purpose, token_hash);

create index if not exists auth_preflight_tokens_active_expiry_idx
  on app.auth_preflight_tokens (expires_at, id);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table app.auth_preflight_tokens from album_haven_readonly;
    revoke all on sequence app.auth_preflight_tokens_id_seq from album_haven_readonly;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table app.auth_preflight_tokens from album_haven_app;
    grant select, insert, update, delete on table app.auth_preflight_tokens to album_haven_app;
    grant usage, select on sequence app.auth_preflight_tokens_id_seq to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table app.auth_preflight_tokens to album_haven_migrator;
    grant all privileges on sequence app.auth_preflight_tokens_id_seq to album_haven_migrator;
  end if;
end $$;
