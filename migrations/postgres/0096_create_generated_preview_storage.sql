create table if not exists app.generated_preview_storage (
  storage_key smallint primary key default 1,
  mode text not null default 'album_folders',
  active_root text,
  requested_mode text,
  requested_root text,
  operation_id uuid unique,
  operation_state text not null default 'idle',
  revision bigint not null default 0,
  total_count bigint not null default 0,
  completed_count bigint not null default 0,
  failed_count bigint not null default 0,
  total_bytes bigint not null default 0,
  completed_bytes bigint not null default 0,
  cancel_requested boolean not null default false,
  failure_summary jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generated_preview_storage_singleton_check check (storage_key = 1),
  constraint generated_preview_storage_mode_check check (
    mode in ('album_folders', 'custom')
    and (mode <> 'custom' or active_root is not null)
  ),
  constraint generated_preview_storage_requested_mode_check check (
    requested_mode is null
    or (
      requested_mode in ('album_folders', 'custom')
      and (requested_mode <> 'custom' or requested_root is not null)
    )
  ),
  constraint generated_preview_storage_operation_state_check check (
    operation_state in (
      'idle', 'queued', 'running', 'cancel_requested', 'completed',
      'completed_with_failures', 'failed', 'canceled'
    )
  ),
  constraint generated_preview_storage_revision_check check (revision >= 0),
  constraint generated_preview_storage_counters_check check (
    total_count >= 0 and completed_count >= 0 and failed_count >= 0
    and total_bytes >= 0 and completed_bytes >= 0
    and completed_count + failed_count <= total_count
    and completed_bytes <= total_bytes
  ),
  constraint generated_preview_storage_failure_summary_check check (
    jsonb_typeof(failure_summary) = 'array'
    and jsonb_array_length(failure_summary) <= 20
  )
);

insert into app.generated_preview_storage (storage_key)
values (1)
on conflict (storage_key) do nothing;

create table if not exists app.generated_preview_inventory (
  id bigint generated always as identity primary key,
  album_preview_path text not null,
  managed_relative_path text not null unique,
  byte_count bigint not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generated_preview_inventory_byte_count_check check (byte_count >= 0),
  constraint generated_preview_inventory_sha256_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint generated_preview_inventory_relative_path_check check (
    managed_relative_path ~ '^v1/cover_variants/[0-9a-f]{2}/[0-9a-f]+\\.[a-z0-9]+$'
  )
);

create table if not exists app.generated_preview_relocation_items (
  id bigint generated always as identity primary key,
  storage_key smallint not null default 1 references app.generated_preview_storage(storage_key),
  operation_id uuid not null,
  inventory_id bigint not null references app.generated_preview_inventory(id) on delete cascade,
  source_path text not null,
  target_path text not null,
  expected_bytes bigint not null,
  expected_sha256 text not null,
  status text not null default 'pending',
  actual_bytes bigint,
  actual_sha256 text,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  attempt_count integer not null default 0,
  constraint generated_preview_relocation_operation_fk
    foreign key (operation_id)
    references app.generated_preview_storage(operation_id)
    on update cascade on delete cascade,
  constraint generated_preview_relocation_identity_unique
    unique (operation_id, inventory_id),
  constraint generated_preview_relocation_status_check check (
    status in ('pending', 'running', 'completed', 'failed', 'skipped')
  ),
  constraint generated_preview_relocation_bytes_check check (
    expected_bytes >= 0 and (actual_bytes is null or actual_bytes >= 0)
  ),
  constraint generated_preview_relocation_sha256_check check (
    expected_sha256 ~ '^[0-9a-f]{64}$'
    and (actual_sha256 is null or actual_sha256 ~ '^[0-9a-f]{64}$')
  )
);

create index if not exists generated_preview_relocation_claim_idx
  on app.generated_preview_relocation_items (operation_id, status, id);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table
      app.generated_preview_storage,
      app.generated_preview_inventory,
      app.generated_preview_relocation_items
    to album_haven_app;
    grant usage, select on sequence
      app.generated_preview_inventory_id_seq,
      app.generated_preview_relocation_items_id_seq
    to album_haven_app;
  end if;
end $$;
