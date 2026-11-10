-- Additive: who may fetch Android update artifacts. Rollback leaves both tables unused.
create table if not exists app.android_artifact_challenges (
  challenge_digest bytea primary key check (octet_length(challenge_digest) = 32),
  account_id bigint not null references app.accounts(id) on delete cascade,
  session_id bigint not null,
  channel text not null check (channel in ('stable', 'sandbox')),
  purpose text not null check (purpose in ('attest', 'request')),
  expires_at timestamptz not null
);

create index if not exists android_artifact_challenges_account_idx
  on app.android_artifact_challenges (account_id, expires_at);

create table if not exists app.android_device_keys (
  id uuid primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  channel text not null check (channel in ('stable', 'sandbox')),
  public_key bytea not null check (octet_length(public_key) between 64 and 256),
  public_key_digest bytea not null check (octet_length(public_key_digest) = 32),
  security_level text not null check (security_level in ('software', 'tee', 'strongbox')),
  created_at timestamptz not null,
  last_used_at timestamptz not null,
  unique (account_id, channel, public_key_digest)
);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on app.android_artifact_challenges, app.android_device_keys to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on app.android_artifact_challenges, app.android_device_keys to album_haven_migrator;
  end if;
end $$;
