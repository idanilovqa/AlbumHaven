create table if not exists ops.log_history_heads (
 library_id bigint primary key references library.libraries(id) on delete cascade,
 revision bigint not null default 0 check(revision>=0),
 retention_epoch bigint not null default 0,
 token_secret uuid not null default gen_random_uuid()
);
create table if not exists ops.log_history_events (
 library_id bigint not null references library.libraries(id) on delete cascade,
 event_id text not null,
 revision bigint not null check(revision>0),
 event_timestamp timestamptz not null,
 recorded_at timestamptz not null default now(),
 payload jsonb not null,
 primary key(library_id,revision)
);
create index if not exists log_history_version_idx on ops.log_history_events(library_id,event_id,revision desc);
create index if not exists log_history_retention_idx on ops.log_history_events(library_id,recorded_at);
do $$ begin
 if exists(select 1 from pg_roles where rolname='album_haven_app') then
  grant select,insert,update on ops.log_history_heads to album_haven_app;
  grant select,insert,delete on ops.log_history_events to album_haven_app;
 end if;
 if exists(select 1 from pg_roles where rolname='album_haven_readonly') then grant select on ops.log_history_heads,ops.log_history_events to album_haven_readonly; end if;
end $$;
