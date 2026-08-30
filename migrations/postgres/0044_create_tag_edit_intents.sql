create table if not exists library.tag_edit_intents (
  id uuid primary key,
  library_root_identity text not null,
  status text not null default 'prepared',
  changes jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  constraint tag_edit_intents_status_check check (
    status in (
      'prepared',
      'files_verified',
      'completed',
      'rolled_back',
      'reconciled_external',
      'recovery_failed'
    )
  ),
  constraint tag_edit_intents_changes_array_check check (
    jsonb_typeof(changes) = 'array'
    and jsonb_array_length(changes) > 0
  )
);

create index if not exists tag_edit_intents_unfinished_idx
  on library.tag_edit_intents (library_root_identity, created_at, id)
  where status in ('prepared', 'files_verified', 'recovery_failed');

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update on table
      library.tag_edit_intents
    to album_haven_app;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant select, insert, update on table
      library.tag_edit_intents
    to album_haven_migrator;
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke select on table library.tag_edit_intents from album_haven_readonly;
  end if;
end $$;
