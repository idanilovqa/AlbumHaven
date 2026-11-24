-- Additive: revoked Android attestation certificate serials as rows, replacing the status file
-- the server parsed on every attest request. Rollback leaves both tables unused.
create table if not exists app.android_attestation_revocations (
  -- Lowercase hex without leading zeros, as format(serial_number, 'x') prints it.
  serial text primary key check (serial ~ '^(0|[1-9a-f][0-9a-f]*)$' and length(serial) <= 64),
  source text not null check (source in ('status-list', 'operator')),
  reason text not null default '' check (length(reason) <= 200),
  refreshed_at timestamptz not null
);

-- A row once Google's status list has been imported: a configured list with no row fails closed.
create table if not exists app.android_attestation_revocation_sources (
  source text primary key check (source = 'status-list'),
  entry_count integer not null check (entry_count >= 0),
  loaded_at timestamptz not null
);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    -- Insert only: the one-time startup import of a previously configured status list.
    grant select, insert on app.android_attestation_revocations, app.android_attestation_revocation_sources
      to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on app.android_attestation_revocations, app.android_attestation_revocation_sources
      to album_haven_migrator;
  end if;
end $$;
