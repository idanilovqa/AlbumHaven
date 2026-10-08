alter table ops.jobs
  drop constraint if exists jobs_kind_check;

alter table ops.jobs
  add constraint jobs_kind_check check (kind in (
    'full_scan',
    'targeted_reconciliation',
    'post_scan_cover_refresh',
    'cover_lookup',
    'cover_bulk_refresh',
    'cover_remote_save',
    'lastfm_scrobble_retry',
    'auth_welcome_delivery',
    'auth_invitation_delivery',
    'auth_password_reset_delivery'
  ));

alter table ops.jobs
  drop constraint if exists jobs_kind_attempts_check;

alter table ops.jobs
  add constraint jobs_kind_attempts_check check (
    (kind = 'full_scan' and max_attempts = 2) or
    (kind = 'targeted_reconciliation' and max_attempts = 3) or
    (kind = 'post_scan_cover_refresh' and max_attempts = 2) or
    (kind = 'cover_lookup' and max_attempts = 2) or
    (kind = 'cover_bulk_refresh' and max_attempts = 2) or
    (kind = 'cover_remote_save' and max_attempts = 1) or
    (kind = 'lastfm_scrobble_retry' and max_attempts = 1) or
    (kind = 'auth_welcome_delivery' and max_attempts = 3) or
    (kind = 'auth_invitation_delivery' and max_attempts = 1) or
    (kind = 'auth_password_reset_delivery' and max_attempts = 1)
  );

alter table ops.jobs
  drop constraint if exists jobs_kind_recovery_check;

alter table ops.jobs
  add constraint jobs_kind_recovery_check check (
    (kind in (
      'full_scan', 'targeted_reconciliation', 'post_scan_cover_refresh',
      'cover_lookup', 'cover_bulk_refresh', 'auth_welcome_delivery'
    ) and recovery_policy = 'retry_safe') or
    (kind in (
      'cover_remote_save', 'lastfm_scrobble_retry',
      'auth_invitation_delivery', 'auth_password_reset_delivery'
    ) and recovery_policy = 'ambiguous_on_stale_lease')
  );

alter table ops.cover_lookup_tasks
  add column if not exists local_album_id bigint
    references library.local_albums(id) on delete restrict,
  add column if not exists library_root_id bigint
    references library.library_roots(id) on delete restrict,
  add column if not exists initiating_account_id bigint
    references app.accounts(id) on delete set null,
  add column if not exists request_origin_id bigint
    references app.request_origins(id) on delete set null,
  add column if not exists capability_key varchar(128),
  add column if not exists deployment_mode varchar(128),
  add column if not exists client_surface varchar(128),
  add column if not exists candidate_generation uuid,
  add column if not exists resource_revision bigint not null default 0,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancel_requested_by_account_id bigint
    references app.accounts(id) on delete set null,
  add column if not exists row_revision bigint not null default 0,
  add column if not exists job_id bigint
    references ops.jobs(id) on delete set null;

alter table ops.cover_lookup_tasks
  drop constraint if exists cover_lookup_tasks_status_check;

alter table ops.cover_lookup_tasks
  add constraint cover_lookup_tasks_status_check check (
    status in ('pending', 'running', 'completed', 'failed', 'canceled')
  );

alter table ops.cover_lookup_tasks
  drop constraint if exists cover_lookup_tasks_revision_check;

alter table ops.cover_lookup_tasks
  add constraint cover_lookup_tasks_revision_check check (
    resource_revision >= 0 and row_revision >= 0
  );

create unique index if not exists cover_lookup_tasks_job_id_idx
  on ops.cover_lookup_tasks (job_id)
  where job_id is not null;

create index if not exists cover_lookup_tasks_resource_scope_idx
  on ops.cover_lookup_tasks (library_id, local_album_id, library_root_id);

create index if not exists cover_lookup_tasks_active_status_idx
  on ops.cover_lookup_tasks (library_id, status, requested_at)
  where status in ('pending', 'running');

create table if not exists ops.cover_bulk_refreshes (
  id bigint generated always as identity primary key,
  task_key varchar(128) not null,
  library_id bigint not null references library.libraries(id) on delete restrict,
  initiating_account_id bigint references app.accounts(id) on delete set null,
  request_origin_id bigint references app.request_origins(id) on delete set null,
  capability_key varchar(128),
  deployment_mode varchar(128) not null,
  client_surface varchar(128) not null,
  mode varchar(32) not null,
  force_search boolean not null default false,
  status varchar(32) not null default 'pending',
  progress_current integer not null default 0,
  progress_total integer not null default 0,
  downloaded_count integer not null default 0,
  safe_display_label varchar(256) not null default '',
  resource_revision bigint not null,
  cancel_requested_at timestamptz,
  cancel_requested_by_account_id bigint references app.accounts(id) on delete set null,
  row_revision bigint not null default 0,
  job_id bigint references ops.jobs(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint cover_bulk_refreshes_mode_check check (
    mode in ('manual', 'background', 'post_scan')
  ),
  constraint cover_bulk_refreshes_status_check check (
    status in ('pending', 'running', 'completed', 'failed', 'canceled')
  ),
  constraint cover_bulk_refreshes_progress_check check (
    progress_current >= 0 and progress_total >= 0 and
    progress_current <= progress_total and downloaded_count >= 0 and
    resource_revision >= 0 and row_revision >= 0
  ),
  constraint cover_bulk_refreshes_terminal_check check (
    (status in ('completed', 'failed', 'canceled') and completed_at is not null) or
    (status in ('pending', 'running') and completed_at is null)
  )
);

create unique index if not exists cover_bulk_refreshes_task_key_idx
  on ops.cover_bulk_refreshes (library_id, task_key);

create unique index if not exists cover_bulk_refreshes_job_id_idx
  on ops.cover_bulk_refreshes (job_id)
  where job_id is not null;

create unique index if not exists cover_bulk_refreshes_one_active_per_library_idx
  on ops.cover_bulk_refreshes (library_id)
  where status in ('pending', 'running');

create index if not exists cover_bulk_refreshes_status_requested_idx
  on ops.cover_bulk_refreshes (library_id, status, requested_at desc);

update ops.cover_lookup_tasks
   set metadata = metadata
       #- '{track_paths}'
       #- '{album_payload}'
       #- '{source_payload,track_paths}'
       #- '{source_payload,album_payload}';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on table ops.cover_lookup_tasks
      to album_haven_app;
    grant select, insert, update on table ops.cover_bulk_refreshes
      to album_haven_app;
    grant usage, select on sequence ops.cover_bulk_refreshes_id_seq
      to album_haven_app;
  end if;
end $$;
