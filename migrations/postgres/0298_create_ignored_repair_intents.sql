-- 0298_create_ignored_repair_intents.sql
-- An Ignore or Unignore made while a publication holds the library waits at most a moment, then keeps an
-- intent here and answers. The drain applies the intents in id order under the inventory publication lock
-- once the publication ends, and deletes them; every read of the ignored repairs lays them over the
-- stored rows meanwhile. The table holds only intents not yet applied.

create table if not exists library.ignored_repair_intents (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  action text not null check (action in ('replace', 'upsert', 'delete')),
  repair_keys text[] not null,
  album_keys jsonb not null default '{}'::jsonb,
  remove_keys text[] not null default '{}'::text[],
  -- The albums and files the intent names (rule_state_postgres.ignored_repair_identity): a read of one
  -- album's or one page's problems takes only the intents that name its rows.
  scope_identities text[] not null default '{}'::text[],
  -- The name the user saw for each rule ("Artist – Album" or the file name), kept with the rule it adds.
  labels jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  -- A drain never leaves an intent pending forever: one it cannot apply, or that its last attempt still left
  -- pending, is failed here, logged, and listed in the Rules until the same rule is written again.
  drain_attempts integer not null default 0,
  failed_at timestamptz,
  failure text,
  -- 'error' (the library could not save it) or 'stuck' (still waiting past the drain's time bound).
  failure_kind text check (failure_kind in ('error', 'stuck'))
);
create index if not exists ignored_repair_intents_library_order_idx
  on library.ignored_repair_intents (library_id, id);
create index if not exists ignored_repair_intents_scope_idx
  on library.ignored_repair_intents using gin (scope_identities);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant select, insert, update, delete on library.ignored_repair_intents to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    grant select on library.ignored_repair_intents to album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on library.ignored_repair_intents to album_haven_migrator;
  end if;
end $$;
