create table if not exists ops.log_history (
  id bigint generated always as identity primary key,
  account_id bigint references app.accounts(id) on delete set null,
  library_id bigint references library.libraries(id) on delete cascade,
  entry_key text not null,
  logged_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists log_history_account_logged_at_idx
  on ops.log_history (account_id, logged_at);

create index if not exists log_history_library_logged_at_idx
  on ops.log_history (library_id, logged_at);

create unique index if not exists log_history_entry_key_idx
  on ops.log_history (account_id, library_id, entry_key)
  where account_id is not null
    and library_id is not null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    execute 'grant select on table ops.log_history to album_haven_readonly';
    execute 'grant select on sequence ops.log_history_id_seq to album_haven_readonly';
  end if;

  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    execute 'grant select, insert, update on table ops.log_history to album_haven_app';
    execute 'grant usage, select on sequence ops.log_history_id_seq to album_haven_app';
  end if;
end $$;
