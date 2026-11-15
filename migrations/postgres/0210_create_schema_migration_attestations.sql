-- Append-only attestations that reconcile ops.schema_migrations with the repository
-- without rewriting history. A ledger row is never updated or deleted to make a checksum
-- check pass; instead one attestation binds the repository checksum, the checksum the
-- ledger actually holds (null when the name is absent), the SHA-256 of the catalog
-- evidence manifest that proves the database's state, the reconciliation migration that
-- recorded it, and the owner's approval. The strict release migrator accepts a drifted
-- name only through exactly one matching attestation. The table starts empty: rows are
-- written per database by the reviewed reconciliation tooling, never by this migration.

create table if not exists ops.schema_migration_attestations (
  id bigint generated always as identity primary key,
  migration_name text not null,
  repository_checksum text,
  ledger_checksum text,
  disposition text not null,
  evidence_manifest_sha256 text not null,
  reconciliation_migration_name text not null,
  reconciliation_migration_checksum text not null,
  superseded_by text[],
  approval_reference text not null,
  approved_at timestamptz not null,
  attested_at timestamptz not null default now(),
  attested_by name not null default current_user,
  constraint schema_migration_attestations_name_check
    check (migration_name ~ '^[0-9]{4}_[a-z0-9_]+\.sql$'),
  constraint schema_migration_attestations_reconciliation_name_check
    check (reconciliation_migration_name ~ '^[0-9]{4}_[a-z0-9_]+\.sql$'),
  constraint schema_migration_attestations_checksums_check check (
    (repository_checksum is null or repository_checksum ~ '^[0-9a-f]{64}$')
    and (ledger_checksum is null or ledger_checksum ~ '^[0-9a-f]{64}$')
    and evidence_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and reconciliation_migration_checksum ~ '^[0-9a-f]{64}$'
  ),
  -- contract-present:              catalog evidence equals the repository contract
  -- contract-present-with-extras:  contract complete; unmerged work added more objects
  -- superseded-by-unmerged:        an unmerged branch replaced a definition (owner-approved)
  -- not-applied:                   deliberately never applied (owner-approved)
  -- historical-ledger-row:         a ledger-only name kept as history; no repository file
  constraint schema_migration_attestations_disposition_check check (
    disposition in (
      'contract-present', 'contract-present-with-extras', 'superseded-by-unmerged',
      'not-applied', 'historical-ledger-row'
    )
  ),
  constraint schema_migration_attestations_shape_check check (
    case disposition
      when 'historical-ledger-row' then repository_checksum is null and ledger_checksum is not null
      else repository_checksum is not null and repository_checksum is distinct from ledger_checksum
    end
    and (disposition = 'superseded-by-unmerged') = (superseded_by is not null)
    and (superseded_by is null or cardinality(superseded_by) > 0)
  ),
  constraint schema_migration_attestations_approval_check
    check (length(btrim(approval_reference)) > 0)
);

create unique index if not exists schema_migration_attestations_identity_idx
  on ops.schema_migration_attestations (migration_name, repository_checksum, ledger_checksum)
  nulls not distinct;

create or replace function ops.reject_schema_migration_attestation_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'ops.schema_migration_attestations is append-only';
end
$function$;

revoke all on function ops.reject_schema_migration_attestation_change() from public;

drop trigger if exists schema_migration_attestations_append_only
  on ops.schema_migration_attestations;
create trigger schema_migration_attestations_append_only
  before update or delete on ops.schema_migration_attestations
  for each row execute function ops.reject_schema_migration_attestation_change();

drop trigger if exists schema_migration_attestations_no_truncate
  on ops.schema_migration_attestations;
create trigger schema_migration_attestations_no_truncate
  before truncate on ops.schema_migration_attestations
  for each statement execute function ops.reject_schema_migration_attestation_change();

revoke all on table ops.schema_migration_attestations from public;
revoke update, delete, truncate on table ops.schema_migration_attestations from current_user;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table ops.schema_migration_attestations from album_haven_app;
    revoke all on sequence ops.schema_migration_attestations_id_seq from album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on table ops.schema_migration_attestations to album_haven_readonly;
  end if;
end $$;
