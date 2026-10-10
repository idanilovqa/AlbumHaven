create or replace function library.local_root_relative_path(
  p_root_path text,
  p_candidate_path text
)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_style text := library.local_path_style(p_root_path);
  v_root_key text := library.local_path_key(p_root_path);
  v_candidate_key text := library.local_path_key(p_candidate_path);
  v_root_normalized text;
  v_candidate_normalized text;
  v_separator text;
  v_relative text;
begin
  if v_style not in ('windows', 'posix')
     or library.local_path_style(p_candidate_path) <> v_style then
    raise exception 'targeted path style is invalid' using errcode = '22023';
  end if;

  if v_candidate_key = v_root_key then
    return '.';
  end if;

  v_separator := case v_style when 'windows' then E'\\' else '/' end;
  if pg_catalog.left(v_candidate_key, pg_catalog.char_length(v_root_key) + 1)
       <> v_root_key || v_separator then
    raise exception 'targeted path is outside its accepted root'
      using errcode = '22023';
  end if;

  v_root_normalized := pg_catalog.regexp_replace(
    pg_catalog.replace(pg_catalog.btrim(p_root_path), E'\\', '/'),
    '/+$', ''
  );
  v_candidate_normalized := pg_catalog.replace(
    pg_catalog.btrim(p_candidate_path), E'\\', '/'
  );
  v_relative := pg_catalog.substr(
    v_candidate_normalized,
    pg_catalog.char_length(v_root_normalized) + 2
  );
  if v_relative = ''
     or pg_catalog.left(v_relative, 1) = '/'
     or pg_catalog.length(v_relative) > 4096
     or v_relative ~ '[[:cntrl:]]'
     or exists (
       select 1
       from pg_catalog.unnest(pg_catalog.string_to_array(v_relative, '/')) segment(value)
       where segment.value in ('', '.', '..')
     ) then
    raise exception 'targeted relative path is invalid' using errcode = '22023';
  end if;
  return v_relative;
end;
$$;

create or replace function library.canonical_watcher_relative_path(
  p_relative_path text
)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
begin
  if p_relative_path = ''
     or p_relative_path = '.'
     or pg_catalog.left(p_relative_path, 1) = '/'
     or pg_catalog.strpos(p_relative_path, E'\\') > 0
     or pg_catalog.length(p_relative_path) > 4096
     or p_relative_path ~ '[[:cntrl:]]'
     or exists (
       select 1
       from pg_catalog.unnest(
         pg_catalog.string_to_array(p_relative_path, '/')
       ) segment(value)
       where segment.value in ('', '.', '..')
     ) then
    raise exception 'watcher relative path is invalid' using errcode = '22023';
  end if;
  return p_relative_path;
end;
$$;

alter table library.targeted_reconciliation_intents
  add column if not exists watcher_generation_kind varchar(32),
  add column if not exists accepted_sequence_lower bigint,
  add column if not exists accepted_sequence_upper bigint,
  add column if not exists dirty_generation bigint,
  add column if not exists watcher_job_linked_at timestamptz,
  add column if not exists watcher_completed_at timestamptz;

alter table library.full_scan_intents
  add column if not exists watcher_repair_id bigint;

alter table library.targeted_reconciliation_intent_paths
  add column if not exists library_id bigint,
  add column if not exists root_id bigint,
  add column if not exists relative_path text;

alter table library.targeted_reconciliation_intent_moves
  add column if not exists library_id bigint,
  add column if not exists source_relative_path text,
  add column if not exists destination_relative_path text;

create unique index if not exists library_roots_library_id_id_watcher_uniq
  on library.library_roots (library_id, id);
create unique index if not exists targeted_reconciliation_intents_id_library_watcher_uniq
  on library.targeted_reconciliation_intents (id, library_id);
create unique index if not exists targeted_reconciliation_intents_library_primary_root_watcher_uniq
  on library.targeted_reconciliation_intents (library_id, primary_root_id, id);
create unique index if not exists full_scan_intents_id_library_watcher_uniq
  on library.full_scan_intents (id, library_id);

update library.targeted_reconciliation_intent_paths as scope
set library_id = intent.library_id,
    root_id = intent.primary_root_id,
    relative_path = library.local_root_relative_path(
      intent.accepted_primary_root_path, scope.path
    )
from library.targeted_reconciliation_intents as intent
where intent.id = scope.intent_id
  and scope.root_id is null;

update library.targeted_reconciliation_intent_moves as move
set library_id = intent.library_id,
    source_relative_path = library.local_root_relative_path(
      move.accepted_source_root_path, move.source_path
    ),
    destination_relative_path = library.local_root_relative_path(
      move.accepted_destination_root_path, move.destination_path
    )
from library.targeted_reconciliation_intents as intent
where intent.id = move.intent_id
  and move.library_id is null;

alter table library.targeted_reconciliation_intent_paths
  drop constraint if exists watcher_scope_root_keyed;
alter table library.targeted_reconciliation_intent_paths
  add constraint watcher_scope_root_keyed check (
    (library_id is null and root_id is null and relative_path is null)
    or
    (library_id is not null and root_id is not null
      and nullif(pg_catalog.btrim(relative_path), '') is not null)
  ) not valid;
alter table library.targeted_reconciliation_intent_paths
  validate constraint watcher_scope_root_keyed;

alter table library.targeted_reconciliation_intent_moves
  drop constraint if exists watcher_move_scope_root_keyed;
alter table library.targeted_reconciliation_intent_moves
  add constraint watcher_move_scope_root_keyed check (
    (library_id is null
      and source_relative_path is null
      and destination_relative_path is null)
    or
    (library_id is not null
      and nullif(pg_catalog.btrim(source_relative_path), '') is not null
      and nullif(pg_catalog.btrim(destination_relative_path), '') is not null)
  ) not valid;
alter table library.targeted_reconciliation_intent_moves
  validate constraint watcher_move_scope_root_keyed;

create index if not exists targeted_reconciliation_intent_paths_library_root_idx
  on library.targeted_reconciliation_intent_paths (library_id, root_id);
create unique index if not exists targeted_reconciliation_intent_paths_root_key_idx
  on library.targeted_reconciliation_intent_paths
    (intent_id, root_id, path_kind, relative_path)
  where root_id is not null;
create index if not exists targeted_reconciliation_intent_moves_source_root_idx
  on library.targeted_reconciliation_intent_moves (library_id, source_root_id);
create index if not exists targeted_reconciliation_intent_moves_destination_root_idx
  on library.targeted_reconciliation_intent_moves (library_id, destination_root_id);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'targeted_reconciliation_intent_paths_tenant_root_fk'
      and conrelid = 'library.targeted_reconciliation_intent_paths'::regclass
  ) then
    alter table library.targeted_reconciliation_intent_paths
      add constraint targeted_reconciliation_intent_paths_tenant_root_fk
      foreign key (library_id, root_id)
      references library.library_roots(library_id, id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'targeted_reconciliation_intent_moves_source_tenant_root_fk'
      and conrelid = 'library.targeted_reconciliation_intent_moves'::regclass
  ) then
    alter table library.targeted_reconciliation_intent_moves
      add constraint targeted_reconciliation_intent_moves_source_tenant_root_fk
      foreign key (library_id, source_root_id)
      references library.library_roots(library_id, id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'targeted_reconciliation_intent_moves_destination_tenant_root_fk'
      and conrelid = 'library.targeted_reconciliation_intent_moves'::regclass
  ) then
    alter table library.targeted_reconciliation_intent_moves
      add constraint targeted_reconciliation_intent_moves_destination_tenant_root_fk
      foreign key (library_id, destination_root_id)
      references library.library_roots(library_id, id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'targeted_reconciliation_intent_paths_tenant_intent_fk'
      and conrelid = 'library.targeted_reconciliation_intent_paths'::regclass
  ) then
    alter table library.targeted_reconciliation_intent_paths
      add constraint targeted_reconciliation_intent_paths_tenant_intent_fk
      foreign key (intent_id, library_id)
      references library.targeted_reconciliation_intents(id, library_id)
      on delete cascade;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'targeted_reconciliation_intent_moves_tenant_intent_fk'
      and conrelid = 'library.targeted_reconciliation_intent_moves'::regclass
  ) then
    alter table library.targeted_reconciliation_intent_moves
      add constraint targeted_reconciliation_intent_moves_tenant_intent_fk
      foreign key (intent_id, library_id)
      references library.targeted_reconciliation_intents(id, library_id)
      on delete cascade;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'targeted_reconciliation_intents_tenant_primary_root_fk'
      and conrelid = 'library.targeted_reconciliation_intents'::regclass
  ) then
    alter table library.targeted_reconciliation_intents
      add constraint targeted_reconciliation_intents_tenant_primary_root_fk
      foreign key (library_id, primary_root_id)
      references library.library_roots(library_id, id) on delete restrict;
  end if;
end;
$$;

create table if not exists library.watcher_lanes (
  library_id bigint not null references library.libraries(id) on delete cascade,
  root_id bigint not null,
  accepted_sequence bigint not null default 0 check (accepted_sequence >= 0),
  applied_sequence bigint not null default 0 check (applied_sequence >= 0),
  dirty_generation bigint not null default 0 check (dirty_generation >= 0),
  repaired_dirty_generation bigint not null default 0 check (repaired_dirty_generation >= 0),
  coalesced_event_count bigint not null default 0 check (coalesced_event_count >= 0),
  catch_up_count bigint not null default 0 check (catch_up_count >= 0),
  running_generation_id bigint,
  running_job_id bigint references ops.jobs(id) on delete restrict,
  successor_generation_id bigint,
  next_eligible_at timestamptz not null default pg_catalog.now(),
  disposition_code varchar(32) not null default 'idle',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (library_id, root_id),
  foreign key (library_id, root_id)
    references library.library_roots(library_id, id) on delete cascade,
  constraint watcher_lanes_sequence_order check (applied_sequence <= accepted_sequence),
  constraint watcher_lanes_dirty_order check (repaired_dirty_generation <= dirty_generation),
  constraint watcher_lanes_distinct_generations check (
    running_generation_id is null or successor_generation_id is null
    or running_generation_id <> successor_generation_id
  ),
  constraint watcher_lanes_coherent_running_job check (
    (running_generation_id is null) = (running_job_id is null)
  )
);

create index if not exists watcher_lanes_ready_idx
  on library.watcher_lanes (next_eligible_at, library_id, root_id)
  where successor_generation_id is not null
     or dirty_generation > repaired_dirty_generation;
create index if not exists watcher_lanes_root_id_idx
  on library.watcher_lanes (root_id);
create index if not exists watcher_lanes_running_generation_idx
  on library.watcher_lanes (running_generation_id)
  where running_generation_id is not null;
create index if not exists watcher_lanes_successor_generation_idx
  on library.watcher_lanes (successor_generation_id)
  where successor_generation_id is not null;
create index if not exists watcher_lanes_running_job_idx
  on library.watcher_lanes (running_job_id)
  where running_job_id is not null;
create index if not exists targeted_reconciliation_watcher_ready_idx
  on library.targeted_reconciliation_intents
    (watcher_generation_kind, accepted_at, id)
  where watcher_job_linked_at is null
    and watcher_generation_kind is not null;

create table if not exists library.watcher_generation_participants (
  generation_id bigint not null,
  library_id bigint not null,
  root_id bigint not null,
  accepted_sequence_lower bigint not null check (accepted_sequence_lower > 0),
  accepted_sequence_upper bigint not null check (
    accepted_sequence_upper >= accepted_sequence_lower
  ),
  dirty_generation bigint not null check (dirty_generation >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (generation_id, root_id),
  unique (generation_id, library_id, root_id),
  foreign key (generation_id, library_id)
    references library.targeted_reconciliation_intents(id, library_id) on delete cascade,
  foreign key (library_id, root_id)
    references library.watcher_lanes(library_id, root_id) on delete cascade
);
create index if not exists watcher_generation_participants_library_root_idx
  on library.watcher_generation_participants (library_id, root_id);
create index if not exists watcher_generation_participants_root_id_idx
  on library.watcher_generation_participants (root_id);

create table if not exists library.watcher_barriers (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  barrier_token uuid not null default pg_catalog.gen_random_uuid() unique,
  created_at timestamptz not null,
  completed_at timestamptz,
  unique (id, library_id),
  check (completed_at is null or completed_at >= created_at)
);
create index if not exists watcher_barriers_library_id_idx
  on library.watcher_barriers (library_id);

create table if not exists library.watcher_barrier_participants (
  barrier_id bigint not null,
  generation_id bigint not null,
  library_id bigint not null,
  root_id bigint not null,
  accepted_sequence bigint not null check (accepted_sequence > 0),
  primary key (barrier_id, root_id),
  foreign key (barrier_id, library_id)
    references library.watcher_barriers(id, library_id) on delete cascade,
  foreign key (generation_id, library_id, root_id)
    references library.watcher_generation_participants(
      generation_id, library_id, root_id
    ) on delete cascade,
  foreign key (library_id, root_id)
    references library.watcher_lanes(library_id, root_id) on delete cascade
);
create index if not exists watcher_barrier_participants_generation_id_idx
  on library.watcher_barrier_participants (generation_id);
create index if not exists watcher_barrier_participants_library_root_idx
  on library.watcher_barrier_participants (library_id, root_id);
create index if not exists watcher_barrier_participants_root_id_idx
  on library.watcher_barrier_participants (root_id);

create table if not exists library.watcher_incidents (
  incident_id uuid primary key default pg_catalog.gen_random_uuid(),
  warning_token uuid not null default pg_catalog.gen_random_uuid() unique,
  library_id bigint not null,
  root_id bigint not null,
  incident_family varchar(32) not null check (incident_family = 'watcher_recovery'),
  reason_code varchar(32) not null check (reason_code in (
    'overflow', 'root_unavailable', 'stable_write_unavailable',
    'reconciliation_failed', 'cross_root_uncertain', 'rollback_pending_work'
  )),
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  accepted_sequence bigint not null check (accepted_sequence >= 0),
  dirty_generation bigint not null check (dirty_generation >= 0),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  resolved_at timestamptz,
  unique (incident_id, library_id),
  foreign key (library_id, root_id)
    references library.watcher_lanes(library_id, root_id) on delete cascade,
  check (last_seen_at >= first_seen_at),
  check (resolved_at is null or resolved_at >= first_seen_at)
);
create unique index if not exists watcher_incidents_unresolved_root_family_idx
  on library.watcher_incidents (library_id, root_id, incident_family)
  where resolved_at is null;
create index if not exists watcher_incidents_library_id_idx
  on library.watcher_incidents (library_id);
create index if not exists watcher_incidents_root_id_idx
  on library.watcher_incidents (root_id);

create table if not exists library.watcher_repairs (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete cascade,
  repair_generation bigint not null check (repair_generation > 0),
  state varchar(16) not null check (state in ('scanning', 'catch_up', 'complete')),
  inventory_revision bigint check (inventory_revision is null or inventory_revision >= 0),
  started_at timestamptz not null,
  completed_at timestamptz,
  unique (library_id, repair_generation),
  unique (id, library_id),
  check ((state = 'complete') = (completed_at is not null)),
  check (completed_at is null or completed_at >= started_at)
);

create table if not exists library.watcher_repair_roots (
  repair_id bigint not null,
  library_id bigint not null,
  root_id bigint not null,
  incident_id uuid not null,
  captured_accepted_sequence bigint not null check (captured_accepted_sequence >= 0),
  captured_dirty_generation bigint not null check (captured_dirty_generation >= 0),
  primary key (repair_id, root_id),
  foreign key (repair_id, library_id)
    references library.watcher_repairs(id, library_id) on delete cascade,
  foreign key (incident_id, library_id)
    references library.watcher_incidents(incident_id, library_id) on delete restrict,
  foreign key (library_id, root_id)
    references library.watcher_lanes(library_id, root_id) on delete cascade
);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'full_scan_intents_tenant_repair_fk'
      and conrelid = 'library.full_scan_intents'::regclass
  ) then
    alter table library.full_scan_intents
      add constraint full_scan_intents_tenant_repair_fk
      foreign key (watcher_repair_id, library_id)
      references library.watcher_repairs(id, library_id) on delete restrict;
  end if;
end;
$$;
create index if not exists watcher_repair_roots_library_root_idx
  on library.watcher_repair_roots (library_id, root_id);
create index if not exists watcher_repair_roots_root_id_idx
  on library.watcher_repair_roots (root_id);
create index if not exists watcher_repair_roots_incident_id_idx
  on library.watcher_repair_roots (incident_id);

create table if not exists library.watcher_incident_acknowledgements (
  incident_id uuid not null,
  library_id bigint not null,
  account_id bigint not null references app.accounts(id) on delete cascade,
  acknowledged_at timestamptz not null,
  primary key (incident_id, account_id),
  foreign key (incident_id, library_id)
    references library.watcher_incidents(incident_id, library_id) on delete cascade
);
create index if not exists watcher_incident_acknowledgements_account_id_idx
  on library.watcher_incident_acknowledgements (account_id);

create table if not exists library.watcher_generation_repairs (
  generation_id bigint not null,
  repair_id bigint not null,
  library_id bigint not null,
  created_at timestamptz not null,
  primary key (generation_id, repair_id),
  foreign key (generation_id, library_id)
    references library.targeted_reconciliation_intents(id, library_id) on delete cascade,
  foreign key (repair_id, library_id)
    references library.watcher_repairs(id, library_id) on delete cascade
);
create index if not exists watcher_generation_repairs_repair_idx
  on library.watcher_generation_repairs (repair_id, generation_id);
create index if not exists watcher_generation_repairs_library_id_idx
  on library.watcher_generation_repairs (library_id);

create table if not exists library.watcher_legacy_health_imports (
  library_id bigint not null,
  root_id bigint not null,
  source_key text not null check (source_key = 'legacy_library_watch_health_v1'),
  imported_at timestamptz not null,
  primary key (library_id, root_id, source_key),
  foreign key (library_id, root_id)
    references library.watcher_lanes(library_id, root_id) on delete cascade
);
create index if not exists watcher_legacy_health_imports_root_id_idx
  on library.watcher_legacy_health_imports (root_id);

create table if not exists library.watcher_runtime_state (
  singleton boolean primary key default true check (singleton),
  acceptance_enabled boolean not null default true,
  disabled_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  check (acceptance_enabled or disabled_at is not null)
);
insert into library.watcher_runtime_state (singleton)
values (true) on conflict (singleton) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'watcher_lanes_running_generation_fk'
      and conrelid = 'library.watcher_lanes'::regclass
  ) then
    alter table library.watcher_lanes
      add constraint watcher_lanes_running_generation_fk
      foreign key (running_generation_id, library_id)
      references library.targeted_reconciliation_intents(id, library_id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'watcher_lanes_successor_generation_fk'
      and conrelid = 'library.watcher_lanes'::regclass
  ) then
    alter table library.watcher_lanes
      add constraint watcher_lanes_successor_generation_fk
      foreign key (successor_generation_id, library_id)
      references library.targeted_reconciliation_intents(id, library_id)
      on delete restrict;
  end if;
end;
$$;

create or replace function library.reject_watcher_incident_identity_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.incident_id is distinct from old.incident_id
     or new.warning_token is distinct from old.warning_token
     or new.library_id is distinct from old.library_id
     or new.root_id is distinct from old.root_id
     or new.incident_family is distinct from old.incident_family
     or new.first_seen_at is distinct from old.first_seen_at then
    raise exception 'watcher incident identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists watcher_incidents_identity_immutable
  on library.watcher_incidents;
create trigger watcher_incidents_identity_immutable
before update on library.watcher_incidents
for each row execute function library.reject_watcher_incident_identity_change();

do $$
begin
  if pg_catalog.to_regprocedure(
    'library.create_full_scan_intent_baseline_0107(bigint,bigint,character varying,character varying,character varying,character varying,character varying,boolean,bigint[],timestamp with time zone)'
  ) is null then
    alter function library.create_full_scan_intent_v2(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) rename to create_full_scan_intent_baseline_0107;
  end if;
end;
$$;

create or replace function library.create_full_scan_intent_v2(
  p_library_id bigint,
  p_initiating_account_id bigint,
  p_capability_key varchar,
  p_request_origin_ref varchar,
  p_deployment_mode varchar,
  p_client_surface varchar,
  p_mode varchar,
  p_force boolean,
  p_root_ids bigint[],
  p_accepted_at timestamptz
)
returns table (intent_id bigint, job_id bigint, created boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  accepted record;
  v_repair_id bigint;
  v_published_repair_id bigint;
  v_job_state varchar;
  v_job_attempt integer;
  v_job_worker_id varchar;
  v_job_lease_token varchar;
  v_committed_inventory_revision bigint;
begin
  if p_mode = 'manual_full_rescan' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:watcher:' || p_library_id::text, 0
      )
    );
  end if;

  loop
    select * into accepted
    from library.create_full_scan_intent_baseline_0107(
      p_library_id, p_initiating_account_id, p_capability_key,
      p_request_origin_ref, p_deployment_mode, p_client_surface,
      p_mode, p_force, p_root_ids, p_accepted_at
    );
    exit when p_mode <> 'manual_full_rescan' or accepted.job_id is null;

    select job.state, job.attempt_count, job.lease_owner, job.lease_token
    into v_job_state, v_job_attempt, v_job_worker_id, v_job_lease_token
    from ops.jobs as job
    where job.id = accepted.job_id
    for update;
    exit when found and v_job_state in ('queued', 'running', 'retry_wait');
  end loop;

  if p_mode = 'manual_full_rescan' then
    select intent.watcher_repair_id, intent.committed_inventory_revision
    into v_repair_id, v_committed_inventory_revision
    from library.full_scan_intents as intent
    where intent.id = accepted.intent_id
      and intent.library_id = p_library_id
    for update;
    if not found then
      raise exception 'full scan intent disappeared during watcher repair admission'
        using errcode = '40001';
    end if;
    if v_job_state = 'running'
       and v_committed_inventory_revision is not null then
      v_published_repair_id := v_repair_id;
      v_repair_id := null;
    end if;
    if v_job_state in ('queued', 'retry_wait') then
      insert into library.full_scan_intent_roots (intent_id, root_id, ordinal)
      select accepted.intent_id, requested.root_id,
             coalesce((
               select pg_catalog.max(existing.ordinal)
               from library.full_scan_intent_roots as existing
               where existing.intent_id = accepted.intent_id
             ), -1) + requested.ordinality::integer
      from pg_catalog.unnest(p_root_ids)
        with ordinality as requested(root_id, ordinality)
      where not exists (
        select 1
        from library.full_scan_intent_roots as existing
        where existing.intent_id = accepted.intent_id
          and existing.root_id = requested.root_id
      )
      on conflict on constraint full_scan_intent_roots_pkey do nothing;
    end if;

    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = p_library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;

    perform 1
    from library.watcher_lanes as lane
    where lane.library_id = p_library_id
      and lane.root_id = any(p_root_ids)
    order by lane.library_id, lane.root_id
    for update;

    if v_repair_id is not null then
      perform 1
      from library.watcher_repairs as repair
      where repair.id = v_repair_id
        and repair.library_id = p_library_id
        and repair.state = 'scanning';
      if not found then
        raise exception 'active full scan watcher repair is not extendable'
          using errcode = '55000';
      end if;
    else
      select repair.id into v_repair_id
      from library.watcher_repairs as repair
      where repair.library_id = p_library_id
        and repair.state = 'scanning'
        and exists (
          select 1
          from library.watcher_repair_roots as repair_root
          join library.watcher_incidents as incident
            on incident.incident_id = repair_root.incident_id
           and incident.library_id = repair_root.library_id
           and incident.resolved_at is null
          where repair_root.repair_id = repair.id
        )
        and not exists (
          select 1
          from library.watcher_repair_roots as repair_root
          where repair_root.repair_id = repair.id
            and not (repair_root.root_id = any(p_root_ids))
        )
      order by repair.id
      limit 1;
    end if;

    if v_repair_id is null and exists (
      select 1
      from library.watcher_incidents as incident
      where incident.library_id = p_library_id
        and incident.root_id = any(p_root_ids)
        and incident.resolved_at is null
    ) then
      insert into library.watcher_repairs (
        library_id, repair_generation, state, started_at
      )
      select p_library_id, coalesce(pg_catalog.max(repair.repair_generation), 0) + 1,
             'scanning', p_accepted_at
      from library.watcher_repairs as repair
      where repair.library_id = p_library_id
      returning id into v_repair_id;
    end if;

    if v_repair_id is not null then
      insert into library.watcher_repair_roots (
        repair_id, library_id, root_id, incident_id,
        captured_accepted_sequence, captured_dirty_generation
      )
      select v_repair_id, lane.library_id, lane.root_id, incident.incident_id,
             case when v_job_state = 'running'
               then lane.applied_sequence else lane.accepted_sequence end,
             case when v_job_state = 'running'
               then lane.repaired_dirty_generation else lane.dirty_generation end
      from library.watcher_lanes as lane
      join library.watcher_incidents as incident
        on incident.library_id = lane.library_id
       and incident.root_id = lane.root_id
       and incident.resolved_at is null
      where lane.library_id = p_library_id
        and lane.root_id = any(p_root_ids)
      on conflict on constraint watcher_repair_roots_pkey do update
      set incident_id = excluded.incident_id,
          captured_accepted_sequence = excluded.captured_accepted_sequence,
          captured_dirty_generation = excluded.captured_dirty_generation;

      if v_job_state = 'running'
         and v_committed_inventory_revision is not null then
        update library.full_scan_intents
        set watcher_repair_id = v_repair_id
        where id = accepted.intent_id
          and library_id = p_library_id
          and watcher_repair_id is not distinct from v_published_repair_id;
        if not found then
          raise exception 'late watcher repair link changed'
            using errcode = '40001';
        end if;
        perform library.complete_watcher_repair_internal(
          v_repair_id,
          accepted.job_id,
          v_job_attempt,
          v_job_worker_id,
          v_job_lease_token,
          v_committed_inventory_revision,
          p_accepted_at,
          true
        );
        perform 1
        from library.watcher_repairs as repair
        where repair.id = v_repair_id
          and repair.inventory_revision = v_committed_inventory_revision
          and repair.state in ('catch_up', 'complete');
        if not found then
          raise exception 'late watcher repair catch-up fence changed'
            using errcode = '40001';
        end if;
        update library.full_scan_intents
        set watcher_repair_id = v_published_repair_id
        where id = accepted.intent_id
          and library_id = p_library_id
          and watcher_repair_id = v_repair_id;
      else
        update library.full_scan_intents
        set watcher_repair_id = v_repair_id
        where id = accepted.intent_id
          and library_id = p_library_id
          and watcher_repair_id is null;
      end if;
    end if;
  end if;

  return query select accepted.intent_id, accepted.job_id,
                      accepted.job_id is null;
end;
$$;

create or replace function library.create_full_scan_intent_v3(
  p_library_id bigint,
  p_initiating_account_id bigint,
  p_capability_key varchar,
  p_request_origin_ref varchar,
  p_deployment_mode varchar,
  p_client_surface varchar,
  p_mode varchar,
  p_force boolean,
  p_root_ids bigint[],
  p_accepted_at timestamptz
)
returns table (intent_id bigint, job_id bigint, created boolean)
language sql
security definer
set search_path = pg_catalog
as $$
  select *
  from library.create_full_scan_intent_v2(
    p_library_id, p_initiating_account_id, p_capability_key,
    p_request_origin_ref, p_deployment_mode, p_client_surface,
    p_mode, p_force, p_root_ids, p_accepted_at
  );
$$;

create or replace function library.load_claimed_full_scan_intent_v3(
  p_job_id bigint,
  p_worker_id varchar,
  p_lease_token varchar
)
returns table (
  intent_id bigint,
  library_id bigint,
  initiating_account_id bigint,
  mode varchar,
  force boolean,
  logical_root_ids text[],
  inventory_mutation_revision bigint,
  committed_inventory_revision bigint,
  watcher_repair_id bigint
)
language sql
security definer
set search_path = pg_catalog
as $$
  select claimed.intent_id,
         claimed.library_id,
         claimed.initiating_account_id,
         claimed.mode,
         claimed.force,
         claimed.logical_root_ids,
         claimed.inventory_mutation_revision,
         claimed.committed_inventory_revision,
         intent.watcher_repair_id
  from library.load_claimed_full_scan_intent_v2(
    p_job_id, p_worker_id, p_lease_token
  ) as claimed
  join library.full_scan_intents as intent on intent.id = claimed.intent_id;
$$;

create or replace function library.load_local_watcher_incidents()
returns table (
  root_id text,
  state text,
  detected_at timestamptz,
  event_id text
)
language sql
security definer
set search_path = pg_catalog
as $$
  select root.metadata ->> 'root_id', incident.reason_code::text,
         incident.last_seen_at, incident.incident_id::text
  from app.bootstrap_owners as owner
  join library.libraries as local_library
    on local_library.owner_account_id = owner.account_id
   and local_library.name = 'Local Library'
   and local_library.library_kind = 'local'
  join library.watcher_incidents as incident
    on incident.library_id = local_library.id
   and incident.resolved_at is null
  join library.library_roots as root
    on root.library_id = incident.library_id
   and root.id = incident.root_id
  where owner.owner_key = 'local-bootstrap-owner'
  order by root.id;
$$;

create or replace function library.load_local_watcher_incident_acknowledgements(
  p_account_id bigint
)
returns table (
  root_id text,
  state text,
  detected_at timestamptz,
  event_id text
)
language sql
security definer
set search_path = pg_catalog
as $$
  select root.metadata ->> 'root_id', incident.reason_code::text,
         incident.last_seen_at, incident.incident_id::text
  from app.bootstrap_owners as owner
  join library.libraries as local_library
    on local_library.owner_account_id = owner.account_id
   and local_library.name = 'Local Library'
   and local_library.library_kind = 'local'
  join library.watcher_incidents as incident
    on incident.library_id = local_library.id
   and incident.resolved_at is null
  join library.watcher_incident_acknowledgements as acknowledgement
    on acknowledgement.incident_id = incident.incident_id
   and acknowledgement.library_id = incident.library_id
   and acknowledgement.account_id = p_account_id
  join library.library_memberships as membership
    on membership.library_id = incident.library_id
   and membership.account_id = p_account_id
  join library.library_roots as root
    on root.library_id = incident.library_id
   and root.id = incident.root_id
  where owner.owner_key = 'local-bootstrap-owner'
  order by root.id;
$$;

create or replace function library.acknowledge_local_watcher_incidents(
  p_account_id bigint,
  p_warning_tokens uuid[]
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  acknowledged_count bigint;
begin
  if p_account_id is null or coalesce(array_length(p_warning_tokens, 1), 0) = 0 then
    return 0;
  end if;

  insert into library.watcher_incident_acknowledgements (
    incident_id, library_id, account_id, acknowledged_at
  )
  select incident.incident_id, incident.library_id, p_account_id,
         clock_timestamp()
  from app.bootstrap_owners as owner
  join library.libraries as local_library
    on local_library.owner_account_id = owner.account_id
   and local_library.name = 'Local Library'
   and local_library.library_kind = 'local'
  join library.watcher_incidents as incident
    on incident.library_id = local_library.id
   and incident.resolved_at is null
   and incident.incident_id = any(p_warning_tokens)
  join library.library_memberships as membership
    on membership.library_id = incident.library_id
   and membership.account_id = p_account_id
  where owner.owner_key = 'local-bootstrap-owner'
  on conflict (incident_id, account_id) do update
    set acknowledged_at = excluded.acknowledged_at;

  get diagnostics acknowledged_count = row_count;
  return acknowledged_count;
end;
$$;

create or replace function library.load_watcher_status(
  p_library_id bigint
)
returns table (
  logical_root_id text,
  state text,
  detected_at timestamptz,
  incident_id uuid,
  warning_token uuid,
  occurrence_count bigint,
  acknowledged boolean
)
language sql
security definer
set search_path = pg_catalog
as $$
  select root.metadata ->> 'root_id',
         incident.reason_code::text,
         incident.first_seen_at,
         incident.incident_id,
         incident.warning_token,
         incident.occurrence_count,
         exists (
           select 1
           from library.watcher_incident_acknowledgements as acknowledgement
           where acknowledgement.incident_id = incident.incident_id
             and acknowledgement.library_id = incident.library_id
         )
  from library.watcher_incidents as incident
  join library.library_roots as root
    on root.library_id = incident.library_id
   and root.id = incident.root_id
  where incident.library_id = p_library_id
    and incident.resolved_at is null
  order by root.id;
$$;

create or replace function library.load_watcher_incident_acknowledgements(
  p_library_id bigint,
  p_account_id bigint
)
returns table (warning_token uuid)
language sql
security definer
set search_path = pg_catalog
as $$
  select incident.warning_token
  from library.watcher_incidents as incident
  join library.watcher_incident_acknowledgements as acknowledgement
    on acknowledgement.incident_id = incident.incident_id
   and acknowledgement.library_id = incident.library_id
   and acknowledgement.account_id = p_account_id
  join library.library_memberships as membership
    on membership.library_id = incident.library_id
   and membership.account_id = p_account_id
  where incident.library_id = p_library_id
    and incident.resolved_at is null
  order by incident.warning_token;
$$;

create or replace function library.acknowledge_watcher_incident(
  p_library_id bigint,
  p_account_id bigint,
  p_warning_token uuid,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  acknowledged_count bigint;
begin
  if p_library_id is null or p_account_id is null
     or p_warning_token is null or p_now is null then
    return false;
  end if;

  insert into library.watcher_incident_acknowledgements (
    incident_id, library_id, account_id, acknowledged_at
  )
  select incident.incident_id, incident.library_id, p_account_id, p_now
  from library.watcher_incidents as incident
  join library.library_memberships as membership
    on membership.library_id = incident.library_id
   and membership.account_id = p_account_id
  where incident.library_id = p_library_id
    and incident.warning_token = p_warning_token
    and incident.resolved_at is null
  on conflict (incident_id, account_id) do update
    set acknowledged_at = excluded.acknowledged_at;

  get diagnostics acknowledged_count = row_count;
  return acknowledged_count = 1;
end;
$$;

create or replace function library.load_watcher_metrics(
  p_library_id bigint,
  p_now timestamptz
)
returns table (
  ready bigint,
  running bigint,
  coalesced bigint,
  dirty bigint,
  barrier_waiting bigint,
  lag_1_9 bigint,
  lag_10_99 bigint,
  lag_100_plus bigint,
  coalesced_events bigint,
  catch_ups bigint,
  oldest_ready_seconds double precision,
  oldest_repair_seconds double precision
)
language sql
security definer
set search_path = pg_catalog
as $$
  with lane_metrics as (
    select count(*) filter (
             where lane.successor_generation_id is not null
           )::bigint as ready,
           count(*) filter (
             where lane.running_generation_id is not null
           )::bigint as running,
           count(*) filter (
             where lane.disposition_code = 'coalesced'
           )::bigint as coalesced,
           count(*) filter (
             where lane.dirty_generation > lane.repaired_dirty_generation
           )::bigint as dirty,
           count(*) filter (
             where lane.disposition_code = 'barrier_waiting'
           )::bigint as barrier_waiting,
           count(*) filter (
             where lane.accepted_sequence - lane.applied_sequence between 1 and 9
           )::bigint as lag_1_9,
           count(*) filter (
             where lane.accepted_sequence - lane.applied_sequence between 10 and 99
           )::bigint as lag_10_99,
           count(*) filter (
             where lane.accepted_sequence - lane.applied_sequence >= 100
           )::bigint as lag_100_plus,
           coalesce(pg_catalog.sum(lane.coalesced_event_count), 0)::bigint
             as coalesced_events,
           coalesce(pg_catalog.sum(lane.catch_up_count), 0)::bigint
             as catch_ups,
           coalesce(
             pg_catalog.max(greatest(
               extract(epoch from (p_now - lane.next_eligible_at)),
               0
             )) filter (where lane.successor_generation_id is not null),
             0
           )::double precision as oldest_ready_seconds
    from library.watcher_lanes as lane
    where lane.library_id = p_library_id
  ), repair_metrics as (
    select coalesce(
             pg_catalog.max(greatest(
               extract(epoch from (p_now - repair.started_at)),
               0
             )),
             0
           )::double precision as oldest_repair_seconds
    from library.watcher_repairs as repair
    where repair.library_id = p_library_id
      and repair.state in ('scanning', 'catch_up')
  )
  select lane_metrics.ready,
         lane_metrics.running,
         lane_metrics.coalesced,
         lane_metrics.dirty,
         lane_metrics.barrier_waiting,
         lane_metrics.lag_1_9,
         lane_metrics.lag_10_99,
         lane_metrics.lag_100_plus,
         lane_metrics.coalesced_events,
         lane_metrics.catch_ups,
         lane_metrics.oldest_ready_seconds,
         repair_metrics.oldest_repair_seconds
  from lane_metrics
  cross join repair_metrics;
$$;

insert into library.watcher_lanes (library_id, root_id)
select root.library_id, root.id
from library.library_roots as root
where root.is_active is true
on conflict (library_id, root_id) do nothing;

create or replace function library.mark_watcher_roots_dirty(
  p_library_id bigint,
  p_logical_root_ids text[],
  p_reason_code varchar,
  p_observed_at timestamptz
)
returns table (
  logical_root_id text,
  generation_id bigint,
  accepted_sequence_lower bigint,
  accepted_sequence_upper bigint,
  dirty_generation bigint,
  incident_id uuid,
  warning_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_root record;
  v_generation_id bigint;
  v_sequence bigint;
  v_dirty_generation bigint;
  v_incident_id uuid;
  v_warning_token uuid;
  v_digest varchar(64);
begin
  if p_library_id is null or p_observed_at is null
     or p_reason_code not in ('overflow', 'root_unavailable')
     or coalesce(pg_catalog.array_length(p_logical_root_ids, 1), 0)
          not between 1 and 256 then
    raise exception 'watcher dirty request is invalid' using errcode = '22023';
  end if;
  if not coalesce((
    select state.acceptance_enabled
    from library.watcher_runtime_state as state
    where state.singleton is true
  ), false) then
    raise exception 'watcher acceptance is disabled' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );
  for v_root in
    select root.id, root.metadata ->> 'root_id' as logical_id
    from library.library_roots as root
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = any(p_logical_root_ids)
    order by root.id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:watcher-root:' || p_library_id::text || ':' || v_root.id::text,
        0
      )
    );
    insert into library.watcher_lanes (library_id, root_id)
    values (p_library_id, v_root.id)
    on conflict (library_id, root_id) do nothing;
  end loop;

  if (
    select pg_catalog.count(distinct root.metadata ->> 'root_id')
    from library.library_roots as root
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = any(p_logical_root_ids)
  ) <> (
    select pg_catalog.count(distinct requested.logical_id)
    from pg_catalog.unnest(p_logical_root_ids) requested(logical_id)
  ) then
    raise exception 'watcher dirty root scope is invalid' using errcode = '22023';
  end if;

  perform 1
  from library.watcher_repairs as repair
  where repair.library_id = p_library_id
    and repair.state in ('scanning', 'catch_up')
  order by repair.id
  for update;

  for v_root in
    select root.id, root.metadata ->> 'root_id' as logical_id
    from library.library_roots as root
    join library.watcher_lanes as lane
      on lane.library_id = root.library_id and lane.root_id = root.id
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = any(p_logical_root_ids)
    order by lane.library_id, lane.root_id
    for update of lane
  loop
    update library.watcher_lanes as lane
    set accepted_sequence = lane.accepted_sequence + 1,
        dirty_generation = lane.dirty_generation + 1,
        catch_up_count = lane.catch_up_count + 1,
        disposition_code = 'dirty',
        next_eligible_at = p_observed_at,
        updated_at = p_observed_at
    where lane.library_id = p_library_id and lane.root_id = v_root.id
    returning lane.accepted_sequence, lane.dirty_generation,
              lane.successor_generation_id
      into v_sequence, v_dirty_generation, v_generation_id;

    if v_generation_id is null then
      v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        'watcher-dirty:' || p_library_id::text || ':' || v_root.id::text || ':'
          || v_sequence::text || ':' || v_dirty_generation::text,
        'UTF8'
      )), 'hex');
      insert into library.targeted_reconciliation_intents (
        library_id, primary_root_id, producer_request_key, request_digest,
        deployment_mode, client_surface, state, accepted_at, updated_at,
        watcher_generation_kind, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation
      ) values (
        p_library_id, v_root.id,
        'watcher-dirty:' || v_root.id::text || ':' || v_sequence::text,
        v_digest, 'self_hosted_private_web', 'library_watcher', 'accepted',
        p_observed_at, p_observed_at, 'root_catch_up', v_sequence, v_sequence,
        v_dirty_generation
      ) returning id into v_generation_id;
      update library.watcher_lanes as lane
      set successor_generation_id = v_generation_id
      where lane.library_id = p_library_id and lane.root_id = v_root.id;
    else
      update library.targeted_reconciliation_intents as intent
      set watcher_generation_kind = 'root_catch_up',
          accepted_sequence_upper = v_sequence,
          dirty_generation = v_dirty_generation,
          request_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'watcher-dirty:' || p_library_id::text || ':' || v_root.id::text || ':'
              || v_sequence::text || ':' || v_dirty_generation::text,
            'UTF8'
          )), 'hex'),
          updated_at = p_observed_at
      where intent.id = v_generation_id
        and intent.watcher_job_linked_at is null;
      delete from library.targeted_reconciliation_intent_paths
      where intent_id = v_generation_id;
      delete from library.targeted_reconciliation_intent_moves
      where intent_id = v_generation_id;
    end if;

    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    ) values (
      v_generation_id, p_library_id, v_root.id, v_sequence, v_sequence,
      v_dirty_generation, p_observed_at, p_observed_at
    ) on conflict on constraint watcher_generation_participants_pkey do update
      set accepted_sequence_upper = excluded.accepted_sequence_upper,
          dirty_generation = excluded.dirty_generation,
          updated_at = excluded.updated_at;

    insert into library.watcher_incidents (
      library_id, root_id, incident_family, reason_code, occurrence_count,
      accepted_sequence, dirty_generation, first_seen_at, last_seen_at
    ) values (
      p_library_id, v_root.id, 'watcher_recovery', p_reason_code, 1,
      v_sequence, v_dirty_generation, p_observed_at, p_observed_at
  ) on conflict (library_id, root_id, incident_family)
    where resolved_at is null
  do update set
    reason_code = excluded.reason_code,
    occurrence_count = library.watcher_incidents.occurrence_count + 1,
    accepted_sequence = greatest(
      library.watcher_incidents.accepted_sequence,
      excluded.accepted_sequence
    ),
    dirty_generation = greatest(
      library.watcher_incidents.dirty_generation,
      excluded.dirty_generation
    ),
    last_seen_at = excluded.last_seen_at
    returning library.watcher_incidents.incident_id,
              library.watcher_incidents.warning_token
      into v_incident_id, v_warning_token;

    logical_root_id := v_root.logical_id;
    generation_id := v_generation_id;
    accepted_sequence_lower := v_sequence;
    accepted_sequence_upper := v_sequence;
    dirty_generation := v_dirty_generation;
    incident_id := v_incident_id;
    warning_token := v_warning_token;
    return next;
  end loop;
end;
$$;

create or replace function library.accept_watcher_event(
  p_library_id bigint,
  p_primary_root_id bigint,
  p_event jsonb,
  p_accepted_at timestamptz
)
returns table (
  logical_root_id text,
  generation_id bigint,
  accepted_sequence_lower bigint,
  accepted_sequence_upper bigint,
  dirty_generation bigint,
  coalesced boolean,
  needs_dispatch boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_kind text := p_event ->> 'kind';
  v_source_logical_id text := p_event ->> 'source_root_id';
  v_destination_logical_id text := p_event ->> 'destination_root_id';
  v_source_relative text := p_event ->> 'source_path';
  v_destination_relative text := p_event ->> 'destination_path';
  v_is_directory boolean := coalesce((p_event ->> 'is_directory')::boolean, false);
  v_destination_root_id bigint;
  v_participant_root_ids bigint[];
  v_closure_root_ids bigint[];
  v_existing_generation_ids bigint[];
  v_generation_id bigint;
  v_loser_id bigint;
  v_root record;
  v_sequence bigint;
  v_dirty_generation bigint;
  v_was_coalesced boolean;
  v_path_kind varchar(32);
  v_ordinal integer;
  v_barrier_id bigint;
  v_digest varchar(64);
  v_scope_count bigint;
  v_scope_bytes bigint;
  v_generation_is_catch_up boolean := false;
begin
  if not coalesce((
    select state.acceptance_enabled
    from library.watcher_runtime_state as state
    where state.singleton is true
  ), false) then
    raise exception 'watcher acceptance is disabled' using errcode = '55000';
  end if;
  if p_library_id is null or p_primary_root_id is null or p_accepted_at is null
     or v_kind not in ('created', 'modified', 'deleted', 'moved')
     or nullif(btrim(v_source_logical_id), '') is null
     or nullif(btrim(v_source_relative), '') is null
     or pg_catalog.octet_length(p_event::text) > 262144 then
    raise exception 'watcher event is invalid' using errcode = '22023';
  end if;
  v_source_relative := library.canonical_watcher_relative_path(
    v_source_relative
  );

  perform 1
  from library.library_roots as root
  where root.id = p_primary_root_id
    and root.library_id = p_library_id
    and root.is_active is true
    and root.metadata ->> 'root_id' = v_source_logical_id;
  if not found then
    raise exception 'watcher source root is invalid' using errcode = '22023';
  end if;

  if v_kind = 'moved' then
    if nullif(btrim(v_destination_logical_id), '') is null
       or nullif(btrim(v_destination_relative), '') is null
       then
      raise exception 'watcher move destination is invalid' using errcode = '22023';
    end if;
    v_destination_relative := library.canonical_watcher_relative_path(
      v_destination_relative
    );
    select root.id into v_destination_root_id
    from library.library_roots as root
    where root.library_id = p_library_id
      and root.is_active is true
      and root.metadata ->> 'root_id' = v_destination_logical_id;
    if v_destination_root_id is null then
      raise exception 'watcher destination root is invalid' using errcode = '22023';
    end if;
  end if;

  v_participant_root_ids := case
    when v_destination_root_id is null or v_destination_root_id = p_primary_root_id
      then array[p_primary_root_id]
    else array[
        least(p_primary_root_id, v_destination_root_id),
        greatest(p_primary_root_id, v_destination_root_id)
    ]
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:watcher:' || p_library_id::text, 0)
  );
  insert into library.watcher_lanes (library_id, root_id)
  select p_library_id, requested.root_id
  from pg_catalog.unnest(v_participant_root_ids) requested(root_id)
  on conflict (library_id, root_id) do nothing;

  perform 1
  from library.watcher_repairs as repair
  where repair.library_id = p_library_id
    and repair.state in ('scanning', 'catch_up')
  order by repair.id
  for update;

  with recursive successor_closure(root_id, generation_id) as (
    select lane.root_id, lane.successor_generation_id
    from library.watcher_lanes as lane
    where lane.library_id = p_library_id
      and lane.root_id = any(v_participant_root_ids)
    union
    select participant.root_id, participant_lane.successor_generation_id
    from successor_closure as current
    join library.watcher_generation_participants as participant
      on participant.generation_id = current.generation_id
    join library.watcher_lanes as participant_lane
      on participant_lane.library_id = p_library_id
     and participant_lane.root_id = participant.root_id
    where current.generation_id is not null
  ), locked_lanes as materialized (
    select lane.root_id, lane.successor_generation_id
    from library.watcher_lanes as lane
    where lane.library_id = p_library_id
      and lane.root_id in (select closure.root_id from successor_closure as closure)
    order by lane.library_id, lane.root_id
    for update of lane
  )
  select pg_catalog.array_agg(locked.root_id order by locked.root_id),
         pg_catalog.array_agg(distinct locked.successor_generation_id
                              order by locked.successor_generation_id)
           filter (where locked.successor_generation_id is not null)
  into v_closure_root_ids, v_existing_generation_ids
  from locked_lanes as locked;
  v_was_coalesced := coalesce(pg_catalog.array_length(v_existing_generation_ids, 1), 0) > 0;

  if not v_was_coalesced then
    v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      p_event::text || ':' || p_accepted_at::text, 'UTF8'
    )), 'hex');
    insert into library.targeted_reconciliation_intents (
      library_id, primary_root_id, producer_request_key, request_digest,
      deployment_mode, client_surface, state, accepted_at, updated_at,
      watcher_generation_kind, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation
    ) values (
      p_library_id, p_primary_root_id,
      'watcher-event:' || v_digest, v_digest,
      'self_hosted_private_web', 'library_watcher', 'accepted',
      p_accepted_at, p_accepted_at, 'exact', 1, 1, 0
    ) returning id into v_generation_id;
  else
    v_generation_id := v_existing_generation_ids[1];
  end if;

  if coalesce(pg_catalog.array_length(v_existing_generation_ids, 1), 0) > 1 then
    foreach v_loser_id in array v_existing_generation_ids[2:]
    loop
      select coalesce(pg_catalog.max(scope.ordinal), -1) + 1 into v_ordinal
      from library.targeted_reconciliation_intent_paths as scope
      where scope.intent_id = v_generation_id;
      insert into library.targeted_reconciliation_intent_paths (
        intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
      )
      select v_generation_id, scope.path_kind, scope.path,
             v_ordinal + pg_catalog.row_number() over (order by scope.path_kind, scope.ordinal) - 1,
             scope.library_id, scope.root_id, scope.relative_path
      from library.targeted_reconciliation_intent_paths as scope
      where scope.intent_id = v_loser_id
      on conflict do nothing;

      select coalesce(pg_catalog.max(move.ordinal), -1) + 1 into v_ordinal
      from library.targeted_reconciliation_intent_moves as move
      where move.intent_id = v_generation_id;
      insert into library.targeted_reconciliation_intent_moves (
        intent_id, source_path, destination_path, source_root_id,
        destination_root_id, is_directory, ordinal,
        accepted_source_root_path, accepted_destination_root_path,
        library_id, source_relative_path, destination_relative_path
      )
      select v_generation_id, move.source_path, move.destination_path,
             move.source_root_id, move.destination_root_id, move.is_directory,
             v_ordinal + pg_catalog.row_number() over (order by move.ordinal) - 1,
             move.accepted_source_root_path, move.accepted_destination_root_path,
             move.library_id, move.source_relative_path, move.destination_relative_path
      from library.targeted_reconciliation_intent_moves as move
      where move.intent_id = v_loser_id
      on conflict do nothing;

      insert into library.watcher_generation_participants (
        generation_id, library_id, root_id, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation, created_at, updated_at
      )
      select v_generation_id, participant.library_id, participant.root_id,
             participant.accepted_sequence_lower, participant.accepted_sequence_upper,
             participant.dirty_generation, participant.created_at, p_accepted_at
      from library.watcher_generation_participants as participant
      where participant.generation_id = v_loser_id
      on conflict on constraint watcher_generation_participants_pkey do update set
        accepted_sequence_lower = least(
          library.watcher_generation_participants.accepted_sequence_lower,
          excluded.accepted_sequence_lower
        ),
        accepted_sequence_upper = greatest(
          library.watcher_generation_participants.accepted_sequence_upper,
          excluded.accepted_sequence_upper
        ),
        dirty_generation = greatest(
          library.watcher_generation_participants.dirty_generation,
          excluded.dirty_generation
        ),
        updated_at = excluded.updated_at;
      update library.watcher_barrier_participants as barrier
      set generation_id = v_generation_id
      where barrier.generation_id = v_loser_id;
      insert into library.watcher_generation_repairs (
        generation_id, repair_id, library_id, created_at
      )
      select v_generation_id, link.repair_id, link.library_id, link.created_at
      from library.watcher_generation_repairs as link
      where link.generation_id = v_loser_id
      on conflict on constraint watcher_generation_repairs_pkey do nothing;
      delete from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = v_loser_id;
      if exists (
        select 1 from library.targeted_reconciliation_intents as loser
        where loser.id = v_loser_id
          and loser.watcher_generation_kind = 'root_catch_up'
      ) then
        v_generation_is_catch_up := true;
      end if;
      update library.watcher_lanes as lane
      set successor_generation_id = v_generation_id, updated_at = p_accepted_at
      where lane.library_id = p_library_id
        and lane.successor_generation_id = v_loser_id;
      delete from library.targeted_reconciliation_intents
      where id = v_loser_id and watcher_job_linked_at is null;
    end loop;
  end if;

  if v_generation_is_catch_up then
    update library.targeted_reconciliation_intents
    set watcher_generation_kind = 'root_catch_up', updated_at = p_accepted_at
    where id = v_generation_id;
  end if;
  select intent.watcher_generation_kind = 'root_catch_up'
  into v_generation_is_catch_up
  from library.targeted_reconciliation_intents as intent
  where intent.id = v_generation_id;

  for v_root in
    update library.watcher_lanes as lane
    set accepted_sequence = lane.accepted_sequence + 1,
        coalesced_event_count = lane.coalesced_event_count +
          case when v_was_coalesced then 1 else 0 end,
        successor_generation_id = v_generation_id,
        next_eligible_at = p_accepted_at,
        disposition_code = 'pending',
        updated_at = p_accepted_at
    where lane.library_id = p_library_id
      and lane.root_id = any(v_participant_root_ids)
    returning lane.root_id, lane.accepted_sequence, lane.dirty_generation
  loop
    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    ) values (
      v_generation_id, p_library_id, v_root.root_id,
      v_root.accepted_sequence, v_root.accepted_sequence,
      v_root.dirty_generation, p_accepted_at, p_accepted_at
    ) on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_upper = excluded.accepted_sequence_upper,
      dirty_generation = excluded.dirty_generation,
      updated_at = excluded.updated_at;
  end loop;

  if v_generation_is_catch_up then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id;
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = v_generation_id;
  elsif v_kind in ('created', 'modified') then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = p_primary_root_id
      and relative_path = v_source_relative
      and path_kind in ('deleted', 'deleted_subtree');
    insert into library.targeted_reconciliation_intent_paths (
      intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
    )
    select v_generation_id, 'preserved_subtree',
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || deleted.relative_path,
           coalesce((select pg_catalog.max(path.ordinal) + 1
                     from library.targeted_reconciliation_intent_paths path
                     where path.intent_id = v_generation_id), 0),
           p_library_id, p_primary_root_id, deleted.relative_path
    from library.targeted_reconciliation_intent_paths as deleted
    join library.library_roots as root on root.id = p_primary_root_id
    where deleted.intent_id = v_generation_id
      and deleted.root_id = p_primary_root_id
      and deleted.path_kind = 'deleted_subtree'
      and (v_source_relative = deleted.relative_path
           or pg_catalog.left(
                v_source_relative,
                pg_catalog.char_length(deleted.relative_path) + 1
              ) = deleted.relative_path || '/')
    on conflict do nothing;
  elsif v_kind = 'deleted' and v_is_directory then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = p_primary_root_id
      and (relative_path = v_source_relative
           or pg_catalog.left(
                relative_path,
                pg_catalog.char_length(v_source_relative) + 1
              ) = v_source_relative || '/');
  else
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = p_primary_root_id
      and relative_path = v_source_relative
      and path_kind = 'active';
  end if;

  select coalesce(pg_catalog.max(scope.ordinal), -1) + 1 into v_ordinal
  from library.targeted_reconciliation_intent_paths as scope
  where scope.intent_id = v_generation_id;
  v_path_kind := case
    when v_kind in ('created', 'modified') then 'active'
    when v_is_directory then 'deleted_subtree'
    else 'deleted'
  end;
  insert into library.targeted_reconciliation_intent_paths (
    intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
  )
  select v_generation_id, v_path_kind,
         root.root_path || case library.local_path_style(root.root_path)
           when 'windows' then E'\\' else '/' end || v_source_relative,
         v_ordinal, p_library_id, root.id, v_source_relative
  from library.library_roots as root
  where root.id = p_primary_root_id
    and not v_generation_is_catch_up
  on conflict do nothing;

  if v_kind = 'moved' and not v_generation_is_catch_up then
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_generation_id
      and root_id = v_destination_root_id
      and relative_path = v_destination_relative
      and path_kind in ('deleted', 'deleted_subtree');
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = v_generation_id
      and source_root_id = v_destination_root_id
      and source_relative_path = v_destination_relative;

    insert into library.targeted_reconciliation_intent_paths (
      intent_id, path_kind, path, ordinal, library_id, root_id, relative_path
    )
    select v_generation_id, 'active',
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || v_destination_relative,
           v_ordinal + 1, p_library_id, root.id, v_destination_relative
    from library.library_roots as root
    where root.id = v_destination_root_id
    on conflict do nothing;

    select coalesce(pg_catalog.max(move.ordinal), -1) + 1 into v_ordinal
    from library.targeted_reconciliation_intent_moves as move
    where move.intent_id = v_generation_id;
    insert into library.targeted_reconciliation_intent_moves (
      intent_id, source_path, destination_path, source_root_id,
      destination_root_id, is_directory, ordinal,
      accepted_source_root_path, accepted_destination_root_path,
      library_id, source_relative_path, destination_relative_path
    )
    select v_generation_id,
           source_root.root_path || case library.local_path_style(source_root.root_path)
             when 'windows' then E'\\' else '/' end || v_source_relative,
           destination_root.root_path || case library.local_path_style(destination_root.root_path)
             when 'windows' then E'\\' else '/' end || v_destination_relative,
           source_root.id, destination_root.id, v_is_directory, v_ordinal,
           source_root.root_path, destination_root.root_path,
           p_library_id, v_source_relative, v_destination_relative
    from library.library_roots as source_root
    cross join library.library_roots as destination_root
    where source_root.id = p_primary_root_id
      and destination_root.id = v_destination_root_id;

    if v_destination_root_id <> p_primary_root_id then
      insert into library.watcher_barriers (library_id, created_at)
      values (p_library_id, p_accepted_at)
      returning id into v_barrier_id;
      insert into library.watcher_barrier_participants (
        barrier_id, generation_id, library_id, root_id, accepted_sequence
      )
      select v_barrier_id, v_generation_id, participant.library_id,
             participant.root_id, participant.accepted_sequence_upper
      from library.watcher_generation_participants as participant
      where participant.generation_id = v_generation_id
        and participant.root_id = any(v_participant_root_ids);
    end if;
  end if;

  for v_root in
    select participant.root_id
    from library.watcher_generation_participants as participant
    where participant.generation_id = v_generation_id
    order by participant.library_id, participant.root_id
  loop
    select
      (select pg_catalog.count(*)
       from library.targeted_reconciliation_intent_paths as scope
       where scope.intent_id = v_generation_id
         and scope.root_id = v_root.root_id)
      +
      (select pg_catalog.count(*)
       from library.targeted_reconciliation_intent_moves as move
       where move.intent_id = v_generation_id
         and (move.source_root_id = v_root.root_id
              or move.destination_root_id = v_root.root_id)),
      coalesce((select pg_catalog.sum(pg_catalog.octet_length(scope.relative_path))
                from library.targeted_reconciliation_intent_paths as scope
                where scope.intent_id = v_generation_id
                  and scope.root_id = v_root.root_id), 0)
      + coalesce((select pg_catalog.sum(
                    pg_catalog.octet_length(move.source_relative_path)
                    + pg_catalog.octet_length(move.destination_relative_path)
                  )
                  from library.targeted_reconciliation_intent_moves as move
                  where move.intent_id = v_generation_id
                    and (move.source_root_id = v_root.root_id
                         or move.destination_root_id = v_root.root_id)), 0)
    into v_scope_count, v_scope_bytes;
    if v_scope_count > 4096 or v_scope_bytes > 262144 then
      update library.watcher_lanes as lane
      set dirty_generation = lane.dirty_generation + 1,
          catch_up_count = lane.catch_up_count + 1,
          disposition_code = 'dirty',
          updated_at = p_accepted_at
      where lane.library_id = p_library_id
        and lane.root_id in (
          select participant.root_id
          from library.watcher_generation_participants as participant
          where participant.generation_id = v_generation_id
        );
      update library.watcher_generation_participants as participant
      set dirty_generation = lane.dirty_generation,
          updated_at = p_accepted_at
      from library.watcher_lanes as lane
      where participant.generation_id = v_generation_id
        and lane.library_id = participant.library_id
        and lane.root_id = participant.root_id;
      update library.targeted_reconciliation_intents
      set watcher_generation_kind = 'root_catch_up', updated_at = p_accepted_at
      where id = v_generation_id;
      delete from library.targeted_reconciliation_intent_paths
      where intent_id = v_generation_id;
      delete from library.targeted_reconciliation_intent_moves
      where intent_id = v_generation_id;
      exit;
    end if;
  end loop;

  update library.targeted_reconciliation_intents as intent
  set accepted_sequence_lower = participant.minimum_sequence,
      accepted_sequence_upper = participant.maximum_sequence,
      dirty_generation = participant.maximum_dirty_generation,
      request_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        v_generation_id::text || ':' || participant.maximum_sequence::text || ':'
          || p_event::text,
        'UTF8'
      )), 'hex'),
      updated_at = p_accepted_at
  from (
    select pg_catalog.min(generation_participant.accepted_sequence_lower)
             as minimum_sequence,
           pg_catalog.max(generation_participant.accepted_sequence_upper)
             as maximum_sequence,
           pg_catalog.max(generation_participant.dirty_generation)
             as maximum_dirty_generation
    from library.watcher_generation_participants generation_participant
    where generation_participant.generation_id = v_generation_id
  ) as participant
  where intent.id = v_generation_id;

  return query
  select root.metadata ->> 'root_id', participant.generation_id,
         participant.accepted_sequence_lower,
         participant.accepted_sequence_upper, participant.dirty_generation,
         v_was_coalesced, true
  from library.watcher_generation_participants as participant
  join library.library_roots as root on root.id = participant.root_id
  where participant.generation_id = v_generation_id
  order by participant.library_id, participant.root_id;
end;
$$;

do $$
begin
  if pg_catalog.to_regprocedure(
    'library.load_claimed_targeted_reconciliation_intent_legacy_0107(bigint,character varying,character varying)'
  ) is null then
    alter function library.load_claimed_targeted_reconciliation_intent_v2(
      bigint, varchar, varchar
    ) rename to load_claimed_targeted_reconciliation_intent_legacy_0107;
  else
    drop function if exists library.load_claimed_targeted_reconciliation_intent_v2(
      bigint, varchar, varchar
    );
  end if;
end;
$$;

create or replace function library.load_claimed_targeted_reconciliation_intent_v2(
  p_job_id bigint,
  p_worker_id varchar,
  p_lease_token varchar
)
returns table (
  intent_id bigint,
  library_id bigint,
  logical_root_id text,
  active_paths text[],
  deleted_paths text[],
  deleted_subtrees text[],
  preserved_subtrees text[],
  moves jsonb,
  exception_overrides jsonb,
  watcher_generation_kind varchar
)
language sql
security definer
set search_path = pg_catalog
as $$
  with legacy as materialized (
    select *
    from library.load_claimed_targeted_reconciliation_intent_legacy_0107(
      p_job_id, p_worker_id, p_lease_token
    )
  ), claimed as materialized (
    select intent.id, intent.library_id, intent.primary_root_id,
           intent.watcher_generation_kind
    from ops.jobs as job
    join library.targeted_reconciliation_intents as intent
      on intent.job_id = job.id
    where job.id = p_job_id
      and job.kind = 'targeted_reconciliation'
      and job.state = 'running'
      and job.lease_owner = p_worker_id
      and job.lease_token = p_lease_token
      and job.lease_expires_at > pg_catalog.clock_timestamp()
  )
  select legacy.intent_id, legacy.library_id,
         case when claimed.watcher_generation_kind is null
           then legacy.logical_root_id
           else primary_root.metadata ->> 'root_id'
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.active_paths
           when claimed.watcher_generation_kind = 'root_catch_up' then coalesce((
             select pg_catalog.array_agg(root.root_path order by participant.root_id)
             from library.watcher_generation_participants as participant
             join library.library_roots as root
               on root.library_id = participant.library_id
              and root.id = participant.root_id
              and root.is_active is true
             where participant.generation_id = claimed.id
           ), array[]::text[])
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'active'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.deleted_paths
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'deleted'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.deleted_subtrees
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'deleted_subtree'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.preserved_subtrees
           else coalesce((
             select pg_catalog.array_agg(
               root.root_path || case library.local_path_style(root.root_path)
                 when 'windows' then E'\\' else '/' end || scope.relative_path
               order by scope.ordinal
             )
             from library.targeted_reconciliation_intent_paths as scope
             join library.library_roots as root
               on root.library_id = scope.library_id
              and root.id = scope.root_id
              and root.is_active is true
             where scope.intent_id = claimed.id
               and scope.root_id is not null
               and scope.relative_path is not null
               and scope.path_kind = 'preserved_subtree'
           ), array[]::text[])
         end,
         case when claimed.watcher_generation_kind is null
           then legacy.moves
           else coalesce((
             select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'source_path', source_root.root_path
                 || case library.local_path_style(source_root.root_path)
                      when 'windows' then E'\\' else '/' end
                 || move.source_relative_path,
               'destination_path', destination_root.root_path
                 || case library.local_path_style(destination_root.root_path)
                      when 'windows' then E'\\' else '/' end
                 || move.destination_relative_path,
               'source_root_ref', source_root.metadata ->> 'root_id',
               'destination_root_ref', destination_root.metadata ->> 'root_id',
               'is_directory', move.is_directory
             ) order by move.ordinal)
             from library.targeted_reconciliation_intent_moves as move
             join library.library_roots as source_root
               on source_root.library_id = move.library_id
              and source_root.id = move.source_root_id
              and source_root.is_active is true
             join library.library_roots as destination_root
               on destination_root.library_id = move.library_id
              and destination_root.id = move.destination_root_id
              and destination_root.is_active is true
             where move.intent_id = claimed.id
               and move.source_relative_path is not null
               and move.destination_relative_path is not null
           ), '[]'::jsonb)
         end,
         legacy.exception_overrides,
         claimed.watcher_generation_kind
  from legacy
  join claimed on claimed.id = legacy.intent_id
  join library.library_roots as primary_root
    on primary_root.library_id = claimed.library_id
   and primary_root.id = claimed.primary_root_id;
$$;

create or replace function library.dispatch_ready_watcher_generations(
  p_now timestamptz,
  p_limit integer
)
returns table (generation_id bigint, job_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  intent record;
  v_job_id bigint;
  v_lane_count integer;
  v_participant_count integer;
  v_candidate_id bigint;
  v_scheduled_at timestamptz;
  v_dispatched integer := 0;
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 128 then
    raise exception 'watcher dispatch request is invalid' using errcode = '22023';
  end if;

  for v_candidate_id in
    select candidate.id
    from library.targeted_reconciliation_intents as candidate
    where candidate.watcher_generation_kind in ('exact', 'root_catch_up')
      and candidate.watcher_job_linked_at is null
      and candidate.state = 'accepted'
      and exists (
        select 1
        from library.watcher_generation_participants as participant
        join library.watcher_lanes as lane
          on lane.library_id = participant.library_id
         and lane.root_id = participant.root_id
        where participant.generation_id = candidate.id
          and lane.next_eligible_at <= p_now
      )
      and not exists (
        select 1
        from library.watcher_generation_participants as participant
        join library.watcher_lanes as lane
          on lane.library_id = participant.library_id
         and lane.root_id = participant.root_id
        left join library.library_roots as root
          on root.library_id = participant.library_id
         and root.id = participant.root_id
         and root.is_active is true
        where participant.generation_id = candidate.id
          and (lane.successor_generation_id is distinct from candidate.id
               or lane.running_generation_id is not null
               or lane.running_job_id is not null
               or lane.next_eligible_at > p_now
               or participant.accepted_sequence_lower
                    <> lane.applied_sequence + 1
               or participant.accepted_sequence_upper
                    <> lane.accepted_sequence
               or root.id is null)
      )
      and not (
        candidate.watcher_generation_kind = 'exact'
        and exists (
          select 1
          from library.watcher_generation_participants as participant
          join library.watcher_incidents as incident
            on incident.library_id = participant.library_id
           and incident.root_id = participant.root_id
           and incident.resolved_at is null
          where participant.generation_id = candidate.id
        )
      )
      and not exists (
        select 1
        from library.watcher_barrier_participants as candidate_barrier
        join library.watcher_barrier_participants as peer
          on peer.barrier_id = candidate_barrier.barrier_id
        join library.watcher_lanes as peer_lane
          on peer_lane.library_id = peer.library_id
         and peer_lane.root_id = peer.root_id
        where candidate_barrier.generation_id = candidate.id
          and peer_lane.applied_sequence < peer.accepted_sequence - 1
      )
    order by candidate.accepted_at, candidate.id
    limit p_limit
  loop
    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = (
      select candidate.library_id
      from library.targeted_reconciliation_intents as candidate
      where candidate.id = v_candidate_id
    )
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;

    perform 1
    from library.watcher_lanes as lane
    join (
      select participant.library_id, participant.root_id
      from library.watcher_generation_participants as participant
      where participant.generation_id = v_candidate_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as candidate_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = candidate_barrier.barrier_id
      where candidate_barrier.generation_id = v_candidate_id
    ) locked
      on locked.library_id = lane.library_id and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;

    select candidate.id, candidate.library_id, candidate.deployment_mode,
           candidate.client_surface, candidate.watcher_generation_kind
    into intent
    from library.targeted_reconciliation_intents as candidate
    where candidate.id = v_candidate_id
      and candidate.watcher_generation_kind in ('exact', 'root_catch_up')
      and candidate.watcher_job_linked_at is null
      and candidate.state = 'accepted'
    for update of candidate skip locked;
    if not found then
      continue;
    end if;

    select pg_catalog.count(*) into v_participant_count
    from library.watcher_generation_participants
    where watcher_generation_participants.generation_id = intent.id;
    select pg_catalog.max(lane.next_eligible_at) into v_scheduled_at
    from library.watcher_generation_participants as participant
    join library.watcher_lanes as lane
      on lane.library_id = participant.library_id
     and lane.root_id = participant.root_id
    where participant.generation_id = intent.id;
    select pg_catalog.count(*) into v_lane_count
    from library.watcher_generation_participants as participant
    join library.watcher_lanes as lane
      on lane.library_id = participant.library_id
     and lane.root_id = participant.root_id
    where participant.generation_id = intent.id
      and lane.successor_generation_id = intent.id
      and lane.running_generation_id is null
      and lane.running_job_id is null
      and lane.next_eligible_at <= p_now
      and participant.accepted_sequence_lower = lane.applied_sequence + 1
      and participant.accepted_sequence_upper = lane.accepted_sequence
      and exists (
        select 1 from library.library_roots as root
        where root.library_id = participant.library_id
          and root.id = participant.root_id
          and root.is_active is true
      );
    if v_participant_count < 1 or v_lane_count <> v_participant_count
       or (intent.watcher_generation_kind = 'exact' and exists (
         select 1
         from library.watcher_generation_participants as participant
         join library.watcher_incidents as incident
           on incident.library_id = participant.library_id
          and incident.root_id = participant.root_id
          and incident.resolved_at is null
         where participant.generation_id = intent.id
       ))
       or exists (
         select 1
         from library.watcher_barrier_participants as candidate_barrier
         join library.watcher_barrier_participants as peer
           on peer.barrier_id = candidate_barrier.barrier_id
         join library.targeted_reconciliation_intents as candidate
           on candidate.id = intent.id
         join library.watcher_lanes as peer_lane
           on peer_lane.library_id = peer.library_id
          and peer_lane.root_id = peer.root_id
         where candidate_barrier.generation_id = candidate.id
           and peer_lane.applied_sequence < peer.accepted_sequence - 1
       ) then
      continue;
    end if;

    insert into ops.jobs (
      kind, state, subject_kind, subject_ref, parameters, library_id,
      deployment_mode, client_surface, scope_version, resource_revision,
      idempotency_key, priority, scheduled_at, max_attempts, recovery_policy
    )
    select 'targeted_reconciliation', 'queued',
           'targeted_reconciliation_intent', intent.id::text,
           pg_catalog.jsonb_build_object('intent_id', intent.id),
           intent.library_id, intent.deployment_mode, intent.client_surface,
           1, pg_catalog.max(participant.accepted_sequence_upper),
           'watcher-generation:' || intent.id::text, 0, v_scheduled_at, 3,
           'retry_safe'
    from library.watcher_generation_participants as participant
    where participant.generation_id = intent.id
    returning id into v_job_id;

    perform library.link_scan_intent_job(
      'targeted_reconciliation', intent.id, v_job_id
    );
    update library.targeted_reconciliation_intents as linked
    set watcher_job_linked_at = p_now, updated_at = p_now
    where linked.id = intent.id;
    update library.watcher_lanes as lane
    set running_generation_id = intent.id,
        running_job_id = v_job_id,
        successor_generation_id = null,
        disposition_code = 'running',
        updated_at = p_now
    from library.watcher_generation_participants as participant
    where participant.generation_id = intent.id
      and lane.library_id = participant.library_id
      and lane.root_id = participant.root_id
      and lane.successor_generation_id = intent.id
      and lane.running_generation_id is null;
    get diagnostics v_lane_count = row_count;
    if v_lane_count <> v_participant_count then
      raise exception 'watcher lane promotion raced' using errcode = '40001';
    end if;
    generation_id := intent.id;
    job_id := v_job_id;
    return next;
    v_dispatched := v_dispatched + 1;
    exit when v_dispatched >= p_limit;
  end loop;
end;
$$;

create or replace function library.load_claimed_watcher_generation(
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  generation_id bigint,
  intent_id bigint,
  library_id bigint,
  participants jsonb,
  generation_kind varchar,
  barrier_ids bigint[]
)
language sql
security definer
set search_path = pg_catalog
as $$
  select intent.id, intent.id, intent.library_id,
         pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'logical_root_id', root.metadata ->> 'root_id',
           'accepted_sequence_lower', participant.accepted_sequence_lower,
           'accepted_sequence_upper', participant.accepted_sequence_upper,
           'dirty_generation', participant.dirty_generation
         ) order by participant.root_id),
         intent.watcher_generation_kind,
         coalesce((
           select pg_catalog.array_agg(distinct barrier.barrier_id order by barrier.barrier_id)
           from library.watcher_barrier_participants as barrier
           where barrier.generation_id = intent.id
         ), array[]::bigint[])
  from ops.jobs as job
  join library.targeted_reconciliation_intents as intent on intent.job_id = job.id
  join library.watcher_generation_participants as participant
    on participant.generation_id = intent.id
  join library.library_roots as root
    on root.library_id = participant.library_id and root.id = participant.root_id
  where job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
    and intent.watcher_generation_kind is not null
    and not exists (
      select 1
      from library.watcher_generation_participants as expected
      left join library.watcher_lanes as lane
        on lane.library_id = expected.library_id
       and lane.root_id = expected.root_id
       and lane.running_generation_id = intent.id
       and lane.running_job_id = job.id
      where expected.generation_id = intent.id
        and lane.root_id is null
    )
  group by intent.id;
$$;

create or replace function library.try_complete_watcher_repairs(
  p_repair_ids bigint[], p_now timestamptz
)
returns bigint[]
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_completed bigint[] := '{}';
  v_repair_id bigint;
  v_repair_state varchar(16);
  v_root record;
  v_blocking record;
  v_successor_id bigint;
  v_accepted_sequence bigint;
  v_dirty_generation bigint;
begin
  foreach v_repair_id in array p_repair_ids loop
    select state into v_repair_state
    from library.watcher_repairs
    where id = v_repair_id;
    if v_repair_state is null
       or v_repair_state not in ('scanning', 'catch_up') then
      continue;
    end if;

    perform 1
    from library.watcher_lanes lane
    where (lane.library_id, lane.root_id) in (
      select repair_root.library_id, repair_root.root_id
      from library.watcher_repair_roots repair_root
      where repair_root.repair_id = v_repair_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants peer
      where peer.barrier_id in (
        select touched.barrier_id
        from library.watcher_barrier_participants touched
        join library.watcher_repair_roots repair_root
          on repair_root.library_id = touched.library_id
         and repair_root.root_id = touched.root_id
        where repair_root.repair_id = v_repair_id
      )
    )
    order by lane.library_id, lane.root_id
    for update of lane;

    update library.watcher_barriers barrier
    set completed_at = p_now
    where barrier.completed_at is null
      and exists (
        select 1
        from library.watcher_barrier_participants participant
        join library.watcher_repair_roots repair_root
          on repair_root.root_id = participant.root_id
         and repair_root.library_id = participant.library_id
        where participant.barrier_id = barrier.id
          and repair_root.repair_id = v_repair_id
      )
      and not exists (
        select 1
        from library.watcher_barrier_participants participant
        join library.watcher_lanes lane
          on lane.library_id = participant.library_id
         and lane.root_id = participant.root_id
        where participant.barrier_id = barrier.id
          and lane.applied_sequence < participant.accepted_sequence
      );

    if not exists (
      select 1
      from library.watcher_repair_roots repair_root
      join library.watcher_lanes lane
        on lane.library_id = repair_root.library_id
       and lane.root_id = repair_root.root_id
      where repair_root.repair_id = v_repair_id
        and (
          lane.accepted_sequence <> lane.applied_sequence
          or lane.dirty_generation <> lane.repaired_dirty_generation
          or lane.accepted_sequence > repair_root.captured_accepted_sequence
          or lane.dirty_generation > repair_root.captured_dirty_generation
          or lane.applied_sequence < repair_root.captured_accepted_sequence
          or lane.repaired_dirty_generation < repair_root.captured_dirty_generation
          or exists (
            select 1
            from library.watcher_barrier_participants barrier_participant
            join library.watcher_barriers barrier
              on barrier.id = barrier_participant.barrier_id
            where barrier_participant.root_id = repair_root.root_id
              and barrier_participant.accepted_sequence
                    <= repair_root.captured_accepted_sequence
              and barrier.completed_at is null
          )
        )
    ) then
      update library.watcher_repairs
      set state = 'complete', completed_at = p_now
      where id = v_repair_id and state in ('scanning', 'catch_up');

      update library.watcher_incidents incident
      set resolved_at = p_now
      from library.watcher_repair_roots repair_root
      where repair_root.repair_id = v_repair_id
        and incident.incident_id = repair_root.incident_id
        and incident.resolved_at is null;

      delete from library.watcher_generation_repairs
      where repair_id = v_repair_id;
      v_completed := array_append(v_completed, v_repair_id);
    else
      for v_blocking in
        select distinct peer_lane.library_id,
               peer_lane.root_id,
               peer_lane.applied_sequence,
               peer_lane.running_generation_id,
               peer_lane.successor_generation_id
        from library.watcher_repair_roots repair_root
        join library.watcher_barrier_participants touched
          on touched.library_id = repair_root.library_id
         and touched.root_id = repair_root.root_id
        join library.watcher_barriers barrier
          on barrier.id = touched.barrier_id and barrier.completed_at is null
        join library.watcher_barrier_participants peer
          on peer.barrier_id = touched.barrier_id
        join library.watcher_lanes peer_lane
          on peer_lane.library_id = peer.library_id
         and peer_lane.root_id = peer.root_id
        where repair_root.repair_id = v_repair_id
          and peer_lane.applied_sequence < peer.accepted_sequence
      loop
        v_successor_id := null;
        v_accepted_sequence := null;
        v_dirty_generation := null;
        if v_blocking.running_generation_id is null
           and v_blocking.successor_generation_id is null then
          update library.watcher_lanes as lane
          set accepted_sequence = lane.accepted_sequence + 1,
              dirty_generation = lane.dirty_generation + 1,
              catch_up_count = lane.catch_up_count + 1,
              disposition_code = 'dirty',
              next_eligible_at = p_now,
              updated_at = p_now
          where lane.library_id = v_blocking.library_id
            and lane.root_id = v_blocking.root_id
            and lane.running_generation_id is null
            and lane.successor_generation_id is null
          returning lane.accepted_sequence, lane.dirty_generation
            into v_accepted_sequence, v_dirty_generation;
          if not found then
            raise exception 'watcher repair barrier extension raced'
              using errcode = '40001';
          end if;

          insert into library.targeted_reconciliation_intents (
            library_id, primary_root_id, producer_request_key, request_digest,
            deployment_mode, client_surface, state, accepted_at, updated_at,
            watcher_generation_kind, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation
          ) values (
            v_blocking.library_id, v_blocking.root_id,
            'watcher-repair-extension:' || v_repair_id::text || ':'
              || v_blocking.root_id::text || ':' || v_accepted_sequence::text,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              'watcher-repair-extension:' || v_repair_id::text || ':'
                || v_blocking.root_id::text || ':' || v_accepted_sequence::text,
              'UTF8'
            )), 'hex'),
            'self_hosted_private_web', 'library_watcher', 'accepted', p_now, p_now,
            'root_catch_up', v_blocking.applied_sequence + 1,
            v_accepted_sequence, v_dirty_generation
          ) returning id into v_successor_id;

          update library.watcher_lanes as lane
          set successor_generation_id = v_successor_id
          where lane.library_id = v_blocking.library_id
            and lane.root_id = v_blocking.root_id
            and lane.running_generation_id is null
            and lane.successor_generation_id is null;
          if not found then
            raise exception 'watcher repair barrier successor raced'
              using errcode = '40001';
          end if;

          insert into library.watcher_generation_participants (
            generation_id, library_id, root_id, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation, created_at, updated_at
          ) values (
            v_successor_id, v_blocking.library_id, v_blocking.root_id,
            v_blocking.applied_sequence + 1, v_accepted_sequence,
            v_dirty_generation, p_now, p_now
          );
          v_blocking.successor_generation_id := v_successor_id;
        end if;

        insert into library.watcher_generation_repairs (
          generation_id, repair_id, library_id, created_at
        )
        select generation_id, v_repair_id, v_blocking.library_id, p_now
        from unnest(array[
          v_blocking.running_generation_id,
          v_blocking.successor_generation_id
        ]) as pending(generation_id)
        where generation_id is not null
        on conflict on constraint watcher_generation_repairs_pkey do nothing;
      end loop;

      for v_root in
        select repair_root.library_id, repair_root.root_id,
               lane.accepted_sequence, lane.applied_sequence,
               lane.dirty_generation, lane.running_generation_id,
               lane.successor_generation_id
        from library.watcher_repair_roots repair_root
        join library.watcher_lanes lane
          on lane.library_id = repair_root.library_id
         and lane.root_id = repair_root.root_id
        where repair_root.repair_id = v_repair_id
          and (
            lane.accepted_sequence <> lane.applied_sequence
            or lane.dirty_generation <> lane.repaired_dirty_generation
            or lane.accepted_sequence > repair_root.captured_accepted_sequence
            or lane.dirty_generation > repair_root.captured_dirty_generation
          )
      order by repair_root.library_id, repair_root.root_id
      loop
        v_accepted_sequence := null;
        v_dirty_generation := null;
        v_successor_id := null;
        if v_root.running_generation_id is null
           and v_root.successor_generation_id is null then
          update library.watcher_lanes as lane
          set accepted_sequence = lane.accepted_sequence + 1,
              dirty_generation = lane.dirty_generation + 1,
              catch_up_count = lane.catch_up_count + 1,
              disposition_code = 'dirty',
              next_eligible_at = p_now,
              updated_at = p_now
          where lane.library_id = v_root.library_id
            and lane.root_id = v_root.root_id
            and lane.running_generation_id is null
            and lane.successor_generation_id is null
          returning lane.accepted_sequence, lane.dirty_generation
            into v_accepted_sequence, v_dirty_generation;
          if not found then
            raise exception 'watcher repair extension raced' using errcode = '40001';
          end if;

          insert into library.targeted_reconciliation_intents (
            library_id, primary_root_id, producer_request_key, request_digest,
            deployment_mode, client_surface, state, accepted_at, updated_at,
            watcher_generation_kind, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation
          ) values (
            v_root.library_id, v_root.root_id,
            'watcher-repair-extension:' || v_repair_id::text || ':'
              || v_root.root_id::text || ':' || v_accepted_sequence::text,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              'watcher-repair-extension:' || v_repair_id::text || ':'
                || v_root.root_id::text || ':' || v_accepted_sequence::text,
              'UTF8'
            )), 'hex'),
            'self_hosted_private_web', 'library_watcher', 'accepted', p_now, p_now,
            'root_catch_up', v_root.applied_sequence + 1,
            v_accepted_sequence, v_dirty_generation
          ) returning id into v_successor_id;

          update library.watcher_lanes
          set successor_generation_id = v_successor_id,
              disposition_code = 'dirty', updated_at = p_now
          where library_id = v_root.library_id
            and root_id = v_root.root_id
            and running_generation_id is null
            and successor_generation_id is null;
          if not found then
            raise exception 'watcher repair successor raced' using errcode = '40001';
          end if;
        elsif v_root.successor_generation_id is not null then
          update library.targeted_reconciliation_intents
          set watcher_generation_kind = 'root_catch_up',
              accepted_sequence_lower = least(
                accepted_sequence_lower, v_root.applied_sequence + 1
              ),
              accepted_sequence_upper = greatest(
                accepted_sequence_upper, v_root.accepted_sequence
              ),
              dirty_generation = greatest(
                dirty_generation, v_root.dirty_generation
              )
          where id = v_root.successor_generation_id
            and watcher_job_linked_at is null
            and state = 'accepted'
          returning id into v_successor_id;
          if found then
            delete from library.targeted_reconciliation_intent_paths
            where intent_id = v_successor_id;
            delete from library.targeted_reconciliation_intent_moves
            where intent_id = v_successor_id;
          end if;
        end if;

        if v_successor_id is not null then
          insert into library.watcher_generation_participants (
            generation_id, library_id, root_id, accepted_sequence_lower,
            accepted_sequence_upper, dirty_generation, created_at, updated_at
          ) values (
            v_successor_id, v_root.library_id, v_root.root_id,
            v_root.applied_sequence + 1,
            coalesce(v_accepted_sequence, v_root.accepted_sequence),
            coalesce(v_dirty_generation, v_root.dirty_generation), p_now, p_now
          )
          on conflict on constraint watcher_generation_participants_pkey do update
          set accepted_sequence_lower = least(
                library.watcher_generation_participants.accepted_sequence_lower,
                excluded.accepted_sequence_lower
              ),
              accepted_sequence_upper = greatest(
                library.watcher_generation_participants.accepted_sequence_upper,
                excluded.accepted_sequence_upper
              ),
              dirty_generation = greatest(
                library.watcher_generation_participants.dirty_generation,
                excluded.dirty_generation
              ),
              updated_at = p_now;
        end if;

        insert into library.watcher_generation_repairs (
          generation_id, repair_id, library_id, created_at
        )
        select generation_id, v_repair_id, v_root.library_id, p_now
        from unnest(array[
          v_root.running_generation_id,
          v_root.successor_generation_id,
          v_successor_id
        ]) as pending(generation_id)
        where generation_id is not null
        on conflict on constraint watcher_generation_repairs_pkey do nothing;

        if not exists (
          select 1
          from library.watcher_generation_repairs as link
          where link.repair_id = v_repair_id
            and link.generation_id = any(array[
              v_root.running_generation_id,
              v_root.successor_generation_id,
              v_successor_id
            ])
        ) then
          raise exception 'watcher repair extension has no completion trigger'
            using errcode = '23514';
        end if;

        update library.watcher_repair_roots as repair_root
        set captured_accepted_sequence = lane.accepted_sequence,
            captured_dirty_generation = lane.dirty_generation
        from library.watcher_lanes as lane
        where repair_root.repair_id = v_repair_id
          and repair_root.root_id = v_root.root_id
          and lane.library_id = repair_root.library_id
          and lane.root_id = repair_root.root_id;
      end loop;

      update library.watcher_repairs
      set state = 'catch_up', completed_at = null
      where id = v_repair_id;
    end if;
  end loop;

  update library.libraries as local_library
  set metadata = pg_catalog.jsonb_set(
        coalesce(local_library.metadata, '{}'::jsonb),
        '{library_watch_health}',
        coalesce(
          local_library.metadata -> 'library_watch_health', '{}'::jsonb
        ) - coalesce((
          select pg_catalog.array_agg(
                   distinct root.metadata ->> 'root_id'
                   order by root.metadata ->> 'root_id'
                 )
          from library.watcher_repair_roots as repair_root
          join library.library_roots as root
            on root.library_id = repair_root.library_id
           and root.id = repair_root.root_id
          where repair_root.repair_id = any(v_completed)
            and repair_root.library_id = local_library.id
        ), array[]::text[]),
        true
      ),
      updated_at = greatest(local_library.updated_at, p_now)
  where exists (
    select 1
    from library.watcher_repair_roots as repair_root
    where repair_root.repair_id = any(v_completed)
      and repair_root.library_id = local_library.id
  );
  return v_completed;
end;
$$;
create or replace function library.complete_watcher_generation(
  p_generation_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count integer;
  v_expected integer;
  v_library_id bigint;
  v_library_count integer;
  v_repair_ids bigint[];
begin
  perform 1
  from ops.jobs as job
  join library.targeted_reconciliation_intents as intent
    on intent.id = p_generation_id
   and intent.job_id = job.id
  where job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of job;
  if not found then return false; end if;

  select pg_catalog.min(participant.library_id),
         pg_catalog.count(*),
         pg_catalog.count(distinct participant.library_id)
  into v_library_id, v_expected, v_library_count
  from library.watcher_generation_participants as participant
  where participant.generation_id = p_generation_id;
  if v_expected < 1 or v_library_count <> 1 then
    raise exception 'watcher generation library scope invalid'
      using errcode = '23514';
  end if;

  -- Lock every active repair that could acquire a link to this generation.
  -- Every link creator follows the same repair-before-lane order.
  perform 1
  from library.watcher_repairs as repair
  where repair.library_id = v_library_id
    and repair.state in ('scanning', 'catch_up')
  order by repair.id
  for update;

  select coalesce(pg_catalog.array_agg(link.repair_id order by link.repair_id),
                  array[]::bigint[])
  into v_repair_ids
  from library.watcher_generation_repairs as link
  where link.generation_id = p_generation_id;

  perform 1
  from library.watcher_lanes as lane
  join (
    select participant.library_id, participant.root_id
    from library.watcher_generation_participants as participant
    where participant.generation_id = p_generation_id
    union
    select peer.library_id, peer.root_id
    from library.watcher_barrier_participants as owned_barrier
    join library.watcher_barrier_participants as peer
      on peer.barrier_id = owned_barrier.barrier_id
    where owned_barrier.generation_id = p_generation_id
  ) as locked
    on locked.library_id = lane.library_id
   and locked.root_id = lane.root_id
  order by lane.library_id, lane.root_id
  for update of lane;
  update library.watcher_lanes as lane
      set applied_sequence = greatest(
        lane.applied_sequence, participant.accepted_sequence_upper
      ),
          repaired_dirty_generation = greatest(
        lane.repaired_dirty_generation, participant.dirty_generation
      ),
      running_generation_id = null,
      running_job_id = null,
      disposition_code = case when lane.successor_generation_id is null
        then 'idle' else 'pending' end,
      updated_at = p_now
  from library.watcher_generation_participants as participant
  where participant.generation_id = p_generation_id
    and lane.library_id = participant.library_id
    and lane.root_id = participant.root_id
    and lane.running_generation_id = p_generation_id
    and lane.running_job_id = p_job_id;
  get diagnostics v_count = row_count;
  if v_expected < 1 or v_count <> v_expected then
    raise exception 'stale watcher completion fence'
      using errcode = '40001';
  end if;
  update library.targeted_reconciliation_intents
  set watcher_completed_at = coalesce(watcher_completed_at, p_now),
      updated_at = greatest(updated_at, p_now)
  where id = p_generation_id;
  update library.watcher_barriers as barrier
  set completed_at = coalesce(barrier.completed_at, p_now)
  where exists (
      select 1 from library.watcher_barrier_participants as participant
      where participant.barrier_id = barrier.id
        and participant.generation_id = p_generation_id
    )
    and not exists (
      select 1
      from library.watcher_barrier_participants as participant
      join library.watcher_lanes as lane
        on lane.library_id = participant.library_id
       and lane.root_id = participant.root_id
      where participant.barrier_id = barrier.id
        and lane.applied_sequence < participant.accepted_sequence
    );
  perform library.try_complete_watcher_repairs(v_repair_ids, p_now);
  return true;
end;
$$;

create or replace function library.fail_claimed_watcher_generation(
  p_generation_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_reason_code varchar,
  p_now timestamptz
)
returns table (failed boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_library_id bigint;
  v_primary_root_id bigint;
  v_successor_id bigint;
  v_digest varchar(64);
  v_participant record;
  v_count integer;
  v_expected integer;
  v_closure_root_ids bigint[];
  v_existing_successor_ids bigint[];
  v_loser_id bigint;
begin
  if p_reason_code not in (
    'root_unavailable', 'overflow', 'stable_write_unavailable',
    'reconciliation_failed', 'cross_root_uncertain'
  ) then
    raise exception 'watcher failure reason is invalid' using errcode = '22023';
  end if;
  select intent.library_id, intent.primary_root_id
  into v_library_id, v_primary_root_id
  from ops.jobs as job
  join library.targeted_reconciliation_intents as intent on intent.job_id = job.id
  where intent.id = p_generation_id
    and job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  ;
  if not found then
    return query select false;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:watcher:' || v_library_id::text, 0
    )
  );

  perform 1
  from library.watcher_repairs as repair
  where repair.library_id = v_library_id
    and repair.state in ('scanning', 'catch_up')
  order by repair.id
  for update;
  with recursive successor_closure(library_id, root_id, generation_id) as (
    select participant.library_id, participant.root_id,
           lane.successor_generation_id
    from library.watcher_generation_participants as participant
    join library.watcher_lanes as lane
      on lane.library_id = participant.library_id
     and lane.root_id = participant.root_id
    where participant.generation_id = p_generation_id
    union
    select participant.library_id, participant.root_id,
           participant_lane.successor_generation_id
    from successor_closure as current
    join library.watcher_generation_participants as participant
      on participant.generation_id = current.generation_id
    join library.watcher_lanes as participant_lane
      on participant_lane.library_id = participant.library_id
     and participant_lane.root_id = participant.root_id
    where current.generation_id is not null
  ), lock_roots as (
    select closure.library_id, closure.root_id
    from successor_closure as closure
    union
    select peer.library_id, peer.root_id
    from library.watcher_barrier_participants as owned_barrier
    join library.watcher_barrier_participants as peer
      on peer.barrier_id = owned_barrier.barrier_id
    where owned_barrier.generation_id = p_generation_id
  ), locked_lanes as materialized (
    select lane.library_id, lane.root_id, lane.successor_generation_id
    from library.watcher_lanes as lane
    join lock_roots as locked
      on locked.library_id = lane.library_id and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane
  )
  select pg_catalog.array_agg(locked.root_id order by locked.root_id),
         pg_catalog.array_agg(distinct locked.successor_generation_id
                              order by locked.successor_generation_id)
           filter (
             where locked.successor_generation_id is not null
               and exists (
                 select 1 from successor_closure as closure
                 where closure.library_id = locked.library_id
                   and closure.root_id = locked.root_id
               )
           )
  into v_closure_root_ids, v_existing_successor_ids
  from locked_lanes as locked;

  perform 1
  from ops.jobs as job
  join library.targeted_reconciliation_intents as intent
    on intent.job_id = job.id
  where intent.id = p_generation_id
    and job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of job, intent;
  if not found then
    return query select false;
    return;
  end if;

  select pg_catalog.count(*) into v_expected
  from library.watcher_generation_participants generation_participant
  where generation_participant.generation_id = p_generation_id;
  v_successor_id := v_existing_successor_ids[1];
  if v_successor_id is null then
    v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'watcher-failure:' || p_generation_id::text || ':' || p_attempt::text,
      'UTF8'
    )), 'hex');
    insert into library.targeted_reconciliation_intents (
      library_id, primary_root_id, producer_request_key, request_digest,
      deployment_mode, client_surface, state, accepted_at, updated_at,
      watcher_generation_kind, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation
    )
    select v_library_id, v_primary_root_id,
           'watcher-failure:' || p_generation_id::text || ':' || p_attempt::text,
           v_digest, 'self_hosted_private_web', 'library_watcher', 'accepted',
           p_now, p_now, 'root_catch_up',
           pg_catalog.min(lane.accepted_sequence),
           pg_catalog.max(lane.accepted_sequence),
           pg_catalog.max(lane.dirty_generation) + 1
    from library.watcher_lanes as lane
    join library.watcher_generation_participants as participant
      on participant.library_id = lane.library_id
     and participant.root_id = lane.root_id
    where participant.generation_id = p_generation_id
    returning id into v_successor_id;
  end if;

  foreach v_loser_id in array coalesce(v_existing_successor_ids[2:], array[]::bigint[])
  loop
    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    )
    select v_successor_id, participant.library_id, participant.root_id,
           participant.accepted_sequence_lower,
           participant.accepted_sequence_upper, participant.dirty_generation,
           participant.created_at, p_now
    from library.watcher_generation_participants as participant
    where participant.generation_id = v_loser_id
    on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_lower = least(
        library.watcher_generation_participants.accepted_sequence_lower,
        excluded.accepted_sequence_lower
      ),
      accepted_sequence_upper = greatest(
        library.watcher_generation_participants.accepted_sequence_upper,
        excluded.accepted_sequence_upper
      ),
      dirty_generation = greatest(
        library.watcher_generation_participants.dirty_generation,
        excluded.dirty_generation
      ),
      updated_at = excluded.updated_at;
    update library.watcher_barrier_participants as barrier_link
    set generation_id = v_successor_id
    where barrier_link.generation_id = v_loser_id;
    insert into library.watcher_generation_repairs (
      generation_id, repair_id, library_id, created_at
    )
    select v_successor_id, repair_link.repair_id, repair_link.library_id,
           repair_link.created_at
    from library.watcher_generation_repairs as repair_link
    where repair_link.generation_id = v_loser_id
    on conflict on constraint watcher_generation_repairs_pkey do nothing;
    delete from library.watcher_generation_repairs repair_link
    where repair_link.generation_id = v_loser_id;
    update library.watcher_lanes
    set successor_generation_id = v_successor_id, updated_at = p_now
    where successor_generation_id = v_loser_id;
    delete from library.targeted_reconciliation_intents
    where id = v_loser_id and watcher_job_linked_at is null;
  end loop;

  update library.targeted_reconciliation_intents
  set watcher_generation_kind = 'root_catch_up', updated_at = p_now
  where id = v_successor_id and watcher_job_linked_at is null;
  delete from library.targeted_reconciliation_intent_paths
  where intent_id = v_successor_id;
  delete from library.targeted_reconciliation_intent_moves
  where intent_id = v_successor_id;

  v_count := 0;
  for v_participant in
    update library.watcher_lanes as lane
    set dirty_generation = lane.dirty_generation + 1,
        successor_generation_id = v_successor_id,
        running_generation_id = null,
        running_job_id = null,
        disposition_code = 'dirty',
        next_eligible_at = p_now,
        updated_at = p_now
    from library.watcher_generation_participants as participant
    where participant.generation_id = p_generation_id
      and lane.library_id = participant.library_id
      and lane.root_id = participant.root_id
      and lane.running_generation_id = p_generation_id
      and lane.running_job_id = p_job_id
    returning lane.library_id, lane.root_id, lane.accepted_sequence,
              lane.dirty_generation
  loop
    v_count := v_count + 1;
    insert into library.watcher_generation_participants (
      generation_id, library_id, root_id, accepted_sequence_lower,
      accepted_sequence_upper, dirty_generation, created_at, updated_at
    ) values (
      v_successor_id, v_participant.library_id, v_participant.root_id,
      v_participant.accepted_sequence, v_participant.accepted_sequence,
      v_participant.dirty_generation, p_now, p_now
    ) on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_lower = least(
        library.watcher_generation_participants.accepted_sequence_lower,
        excluded.accepted_sequence_lower
      ),
      accepted_sequence_upper = greatest(
        library.watcher_generation_participants.accepted_sequence_upper,
        excluded.accepted_sequence_upper
      ),
      dirty_generation = excluded.dirty_generation,
      updated_at = excluded.updated_at;
    insert into library.watcher_incidents (
      library_id, root_id, incident_family, reason_code, occurrence_count,
      accepted_sequence, dirty_generation, first_seen_at, last_seen_at
    ) values (
      v_participant.library_id, v_participant.root_id, 'watcher_recovery',
      p_reason_code, 1, v_participant.accepted_sequence,
      v_participant.dirty_generation, p_now, p_now
    ) on conflict (library_id, root_id, incident_family)
      where resolved_at is null
      do update set
        reason_code = excluded.reason_code,
        occurrence_count = library.watcher_incidents.occurrence_count + 1,
      accepted_sequence = greatest(
        library.watcher_incidents.accepted_sequence,
        excluded.accepted_sequence
      ),
      dirty_generation = greatest(
        library.watcher_incidents.dirty_generation,
        excluded.dirty_generation
      ),
        last_seen_at = excluded.last_seen_at;
  end loop;
  update library.watcher_barrier_participants as barrier_link
  set generation_id = v_successor_id
  where barrier_link.generation_id = p_generation_id;
  insert into library.watcher_generation_repairs (
    generation_id, repair_id, library_id, created_at
  )
  select v_successor_id, repair_link.repair_id, repair_link.library_id,
         repair_link.created_at
  from library.watcher_generation_repairs as repair_link
  where repair_link.generation_id = p_generation_id
  on conflict on constraint watcher_generation_repairs_pkey do nothing;
  delete from library.watcher_generation_repairs as repair_link
  where repair_link.generation_id = p_generation_id;
  return query select v_expected > 0 and v_count = v_expected;
end;
$$;

create or replace function library.load_claimed_watcher_private_scope(
  p_generation_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_now timestamptz
)
returns table (
  intent_id bigint,
  library_id bigint,
  active_paths text[],
  deleted_paths text[],
  deleted_subtrees text[],
  preserved_subtrees text[],
  moves jsonb
)
language sql
security definer
set search_path = pg_catalog
as $$
  with claimed as (
    select intent.id, intent.library_id
    from ops.jobs as job
    join library.targeted_reconciliation_intents as intent
      on intent.job_id = job.id
    where intent.id = p_generation_id
      and job.id = p_job_id
      and job.kind = 'targeted_reconciliation'
      and job.state = 'running'
      and job.attempt_count = p_attempt
      and job.lease_owner = p_worker_id
      and job.lease_token = p_lease_token
      and job.lease_expires_at > pg_catalog.clock_timestamp()
      and intent.watcher_generation_kind is not null
  )
  select claimed.id, claimed.library_id,
         coalesce(pg_catalog.array_agg(
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || path.relative_path
           order by path.ordinal
         ) filter (where path.path_kind = 'active'), array[]::text[]),
         coalesce(pg_catalog.array_agg(
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || path.relative_path
           order by path.ordinal
         ) filter (where path.path_kind = 'deleted'), array[]::text[]),
         coalesce(pg_catalog.array_agg(
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || path.relative_path
           order by path.ordinal
         ) filter (where path.path_kind = 'deleted_subtree'), array[]::text[]),
         coalesce(pg_catalog.array_agg(
           root.root_path || case library.local_path_style(root.root_path)
             when 'windows' then E'\\' else '/' end || path.relative_path
           order by path.ordinal
         ) filter (where path.path_kind = 'preserved_subtree'), array[]::text[]),
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'source_path', source_root.root_path
               || case library.local_path_style(source_root.root_path)
                    when 'windows' then E'\\' else '/' end
               || move.source_relative_path,
             'destination_path', destination_root.root_path
               || case library.local_path_style(destination_root.root_path)
                    when 'windows' then E'\\' else '/' end
               || move.destination_relative_path,
             'source_root_ref', source_root.metadata ->> 'root_id',
             'destination_root_ref', destination_root.metadata ->> 'root_id',
             'is_directory', move.is_directory
           ) order by move.ordinal)
           from library.targeted_reconciliation_intent_moves as move
           join library.library_roots as source_root
             on source_root.library_id = move.library_id
            and source_root.id = move.source_root_id
            and source_root.is_active is true
           join library.library_roots as destination_root
             on destination_root.library_id = move.library_id
            and destination_root.id = move.destination_root_id
            and destination_root.is_active is true
           where move.intent_id = claimed.id
         ), '[]'::jsonb)
  from claimed
  left join library.targeted_reconciliation_intent_paths as path
    on path.intent_id = claimed.id
  left join library.library_roots as root
    on root.library_id = path.library_id
   and root.id = path.root_id
   and root.is_active is true
  group by claimed.id, claimed.library_id;
$$;

create or replace function library.complete_watcher_repair_internal(
  p_repair_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_inventory_revision bigint,
  p_now timestamptz,
  p_allow_committed_publication boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_completed boolean := false;
  v_library_id bigint;
  v_repair_state varchar(16);
  v_repair_inventory_revision bigint;
  v_successor_ids bigint[];
  v_covered_successor_ids bigint[];
begin
  if p_inventory_revision is null or p_inventory_revision < 0 then
    raise exception 'watcher repair inventory revision is invalid'
      using errcode = '22023';
  end if;
  select job.library_id into v_library_id
  from ops.jobs as job
  where job.id = p_job_id
    and job.kind = 'full_scan'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and (
      p_allow_committed_publication
      or job.lease_expires_at > pg_catalog.clock_timestamp()
    )
  for update of job;
  if not found then return false; end if;

  perform 1
  from library.full_scan_intents as intent
  where intent.watcher_repair_id = p_repair_id
    and intent.library_id = v_library_id
    and intent.job_id = p_job_id
    and (
      not p_allow_committed_publication
      or intent.committed_inventory_revision = p_inventory_revision
    )
  for update of intent;
  if not found then return false; end if;

  select repair.state, repair.inventory_revision
  into v_repair_state, v_repair_inventory_revision
  from library.watcher_repairs as repair
  where repair.id = p_repair_id
    and repair.library_id = v_library_id
  order by repair.id
  for update of repair;
  if not found then return false; end if;
  if v_repair_state = 'complete' then
    return coalesce(v_repair_inventory_revision = p_inventory_revision, false);
  end if;
  if v_repair_state not in ('scanning', 'catch_up') then
    return false;
  end if;

  with locked_lanes as materialized (
    select lane.successor_generation_id
    from library.watcher_lanes as lane
    join (
      select repair_root.library_id, repair_root.root_id
      from library.watcher_repair_roots as repair_root
      where repair_root.repair_id = p_repair_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_repair_roots as repair_root
      join library.watcher_barrier_participants as touched
        on touched.library_id = repair_root.library_id
       and touched.root_id = repair_root.root_id
      join library.watcher_barriers as barrier
        on barrier.id = touched.barrier_id
       and barrier.completed_at is null
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = touched.barrier_id
      where repair_root.repair_id = p_repair_id
    ) as locked
      on locked.library_id = lane.library_id
     and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane
  )
  select coalesce(
           pg_catalog.array_agg(
             distinct locked.successor_generation_id
             order by locked.successor_generation_id
           ) filter (where locked.successor_generation_id is not null),
           array[]::bigint[]
         )
  into v_successor_ids
  from locked_lanes as locked;

  perform 1
  from library.targeted_reconciliation_intents as successor
  where successor.id = any(v_successor_ids)
    and successor.watcher_generation_kind = 'root_catch_up'
    and successor.watcher_job_linked_at is null
    and successor.state = 'accepted'
  order by successor.id
  for update of successor;

  update library.watcher_lanes as lane
      set applied_sequence = greatest(
        lane.applied_sequence, repair_root.captured_accepted_sequence
      ),
          repaired_dirty_generation = greatest(
        lane.repaired_dirty_generation, repair_root.captured_dirty_generation
      ),
      updated_at = p_now
  from library.watcher_repair_roots as repair_root
  where repair_root.repair_id = p_repair_id
    and lane.library_id = repair_root.library_id
    and lane.root_id = repair_root.root_id;

  select coalesce(
           pg_catalog.array_agg(successor.id order by successor.id),
           array[]::bigint[]
         )
  into v_covered_successor_ids
  from library.targeted_reconciliation_intents as successor
  where successor.id = any(v_successor_ids)
    and successor.watcher_generation_kind in ('exact', 'root_catch_up')
    and successor.watcher_job_linked_at is null
    and successor.state = 'accepted'
    and exists (
      select 1
      from library.watcher_generation_participants as participant
      where participant.generation_id = successor.id
    )
    and not exists (
      select 1
      from library.watcher_generation_participants as participant
      left join library.watcher_lanes as lane
        on lane.library_id = participant.library_id
       and lane.root_id = participant.root_id
      where participant.generation_id = successor.id
        and (
          lane.root_id is null
          or lane.successor_generation_id is distinct from successor.id
          or lane.running_generation_id is not null
          or lane.running_job_id is not null
          or participant.accepted_sequence_upper > lane.applied_sequence
          or participant.dirty_generation > lane.repaired_dirty_generation
        )
    );
  update library.watcher_lanes as lane
  set successor_generation_id = null,
      disposition_code = 'idle',
      updated_at = p_now
  where lane.successor_generation_id = any(v_covered_successor_ids)
    and lane.running_generation_id is null
    and lane.running_job_id is null;
  delete from library.targeted_reconciliation_intents as successor
  where successor.id = any(v_covered_successor_ids)
    and successor.watcher_job_linked_at is null
    and successor.state = 'accepted';

  update library.watcher_repairs
  set inventory_revision = p_inventory_revision,
      state = 'catch_up', completed_at = null
  where id = p_repair_id;

  update library.watcher_generation_participants as participant
  set accepted_sequence_lower = lane.applied_sequence + 1,
      accepted_sequence_upper = lane.accepted_sequence,
      dirty_generation = lane.dirty_generation,
      updated_at = p_now
  from library.watcher_lanes as lane
  where participant.generation_id = any(v_successor_ids)
    and lane.library_id = participant.library_id
    and lane.root_id = participant.root_id
    and lane.successor_generation_id = participant.generation_id
    and lane.running_generation_id is null
    and lane.running_job_id is null
    and lane.accepted_sequence > lane.applied_sequence
    and exists (
      select 1
      from library.targeted_reconciliation_intents as successor
      where successor.id = participant.generation_id
        and successor.watcher_generation_kind = 'root_catch_up'
        and successor.watcher_job_linked_at is null
        and successor.state = 'accepted'
    );

  update library.targeted_reconciliation_intents as successor
  set accepted_sequence_lower = fences.accepted_sequence_lower,
      accepted_sequence_upper = fences.accepted_sequence_upper,
      dirty_generation = fences.dirty_generation,
      updated_at = p_now
  from (
    select participant.generation_id,
           pg_catalog.min(participant.accepted_sequence_lower)
             as accepted_sequence_lower,
           pg_catalog.max(participant.accepted_sequence_upper)
             as accepted_sequence_upper,
           pg_catalog.max(participant.dirty_generation) as dirty_generation
    from library.watcher_generation_participants as participant
    where participant.generation_id = any(v_successor_ids)
    group by participant.generation_id
  ) as fences
  where successor.id = fences.generation_id
    and successor.watcher_generation_kind = 'root_catch_up'
    and successor.watcher_job_linked_at is null
    and successor.state = 'accepted';

  select p_repair_id = any(
    library.try_complete_watcher_repairs(array[p_repair_id], p_now)
  ) into v_completed;
  return v_completed;
end;
$$;

create or replace function library.complete_watcher_repair(
  p_repair_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_inventory_revision bigint,
  p_now timestamptz
)
returns boolean
language sql
security definer
set search_path = pg_catalog
as $$
  select library.complete_watcher_repair_internal(
    p_repair_id, p_job_id, p_attempt, p_worker_id, p_lease_token,
    p_inventory_revision, p_now, true
  );
$$;

create or replace function library.reconcile_due_watcher_generations(
  p_now timestamptz,
  p_limit integer
)
returns table (generation_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  candidate record;
  participant record;
  v_successor_id bigint;
  v_digest varchar(64);
  v_closure_root_ids bigint[];
  v_existing_successor_ids bigint[];
  v_loser_id bigint;
  v_inactive_changed boolean;
  v_accepted_sequence bigint;
  v_dirty_generation bigint;
  v_reconciled integer := 0;
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 128 then
    raise exception 'watcher recovery request is invalid' using errcode = '22023';
  end if;

  for candidate in
    select intent.id as generation_id, intent.library_id
    from library.targeted_reconciliation_intents as intent
    where intent.watcher_generation_kind in ('exact', 'root_catch_up')
      and intent.watcher_job_linked_at is null
      and intent.state = 'accepted'
      and exists (
        select 1
        from library.watcher_generation_participants as owned
        join library.watcher_lanes as lane
          on lane.library_id = owned.library_id
         and lane.root_id = owned.root_id
        left join library.library_roots as active_root
          on active_root.library_id = owned.library_id
         and active_root.id = owned.root_id
         and active_root.is_active is true
        where owned.generation_id = intent.id
          and lane.successor_generation_id = intent.id
          and active_root.id is null
          and (
            intent.watcher_generation_kind = 'exact'
            or not exists (
              select 1
              from library.watcher_incidents as incident
              where incident.library_id = lane.library_id
                and incident.root_id = lane.root_id
                and incident.incident_family = 'watcher_recovery'
                and incident.reason_code = 'root_unavailable'
                and incident.resolved_at is null
                and incident.accepted_sequence >= lane.accepted_sequence
                and incident.dirty_generation >= lane.dirty_generation
            )
          )
      )
    order by intent.accepted_at, intent.id
    limit p_limit
  loop
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:watcher:' || candidate.library_id::text, 0
      )
    ) then
      continue;
    end if;

    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = candidate.library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;

    perform 1
    from library.watcher_lanes as lane
    join (
      select owned.library_id, owned.root_id
      from library.watcher_generation_participants as owned
      where owned.generation_id = candidate.generation_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as owned_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = owned_barrier.barrier_id
      where owned_barrier.generation_id = candidate.generation_id
    ) as locked
      on locked.library_id = lane.library_id
     and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;

    perform 1
    from library.targeted_reconciliation_intents as intent
    where intent.id = candidate.generation_id
      and intent.watcher_generation_kind in ('exact', 'root_catch_up')
      and intent.watcher_job_linked_at is null
      and intent.state = 'accepted'
      and exists (
        select 1
        from library.watcher_generation_participants as owned
        join library.watcher_lanes as lane
          on lane.library_id = owned.library_id
         and lane.root_id = owned.root_id
        left join library.library_roots as active_root
          on active_root.library_id = owned.library_id
         and active_root.id = owned.root_id
         and active_root.is_active is true
        where owned.generation_id = intent.id
          and lane.successor_generation_id = intent.id
          and active_root.id is null
          and (
            intent.watcher_generation_kind = 'exact'
            or not exists (
              select 1
              from library.watcher_incidents as incident
              where incident.library_id = lane.library_id
                and incident.root_id = lane.root_id
                and incident.incident_family = 'watcher_recovery'
                and incident.reason_code = 'root_unavailable'
                and incident.resolved_at is null
                and incident.accepted_sequence >= lane.accepted_sequence
                and incident.dirty_generation >= lane.dirty_generation
            )
          )
      )
    for update of intent;
    if not found then
      continue;
    end if;

    v_inactive_changed := false;
    for participant in
      select owned.library_id, owned.root_id
      from library.watcher_generation_participants as owned
      join library.watcher_lanes as lane
        on lane.library_id = owned.library_id
       and lane.root_id = owned.root_id
      join library.targeted_reconciliation_intents as intent
        on intent.id = owned.generation_id
      left join library.library_roots as active_root
        on active_root.library_id = owned.library_id
       and active_root.id = owned.root_id
       and active_root.is_active is true
      where owned.generation_id = candidate.generation_id
        and lane.successor_generation_id = candidate.generation_id
        and active_root.id is null
        and (
          intent.watcher_generation_kind = 'exact'
          or not exists (
            select 1
            from library.watcher_incidents as incident
            where incident.library_id = lane.library_id
              and incident.root_id = lane.root_id
              and incident.incident_family = 'watcher_recovery'
              and incident.reason_code = 'root_unavailable'
              and incident.resolved_at is null
              and incident.accepted_sequence >= lane.accepted_sequence
              and incident.dirty_generation >= lane.dirty_generation
          )
        )
      order by owned.library_id, owned.root_id
    loop
      update library.watcher_lanes as lane
      set dirty_generation = lane.dirty_generation + 1,
          catch_up_count = lane.catch_up_count + 1,
          disposition_code = 'dirty',
          next_eligible_at = p_now,
          updated_at = p_now
      where lane.library_id = participant.library_id
        and lane.root_id = participant.root_id
        and lane.successor_generation_id = candidate.generation_id
        returning lane.accepted_sequence, lane.dirty_generation
        into v_accepted_sequence, v_dirty_generation;
      if not found then
        raise exception 'inactive watcher successor lane raced'
          using errcode = '40001';
      end if;

      update library.watcher_generation_participants as owned
           set accepted_sequence_upper = v_accepted_sequence,
               dirty_generation = v_dirty_generation,
          updated_at = p_now
      where owned.generation_id = candidate.generation_id
        and owned.library_id = participant.library_id
        and owned.root_id = participant.root_id;

      insert into library.watcher_incidents (
        library_id, root_id, incident_family, reason_code, occurrence_count,
        accepted_sequence, dirty_generation, first_seen_at, last_seen_at
      ) values (
          participant.library_id, participant.root_id, 'watcher_recovery',
          'root_unavailable', 1, v_accepted_sequence,
          v_dirty_generation, p_now, p_now
      )
      on conflict (library_id, root_id, incident_family)
        where resolved_at is null
      do update set
        reason_code = excluded.reason_code,
        occurrence_count = library.watcher_incidents.occurrence_count + 1,
      accepted_sequence = greatest(
        library.watcher_incidents.accepted_sequence,
        excluded.accepted_sequence
      ),
      dirty_generation = greatest(
        library.watcher_incidents.dirty_generation,
        excluded.dirty_generation
      ),
        last_seen_at = excluded.last_seen_at;

      v_inactive_changed := true;
    end loop;

    if not v_inactive_changed then
      continue;
    end if;

    update library.targeted_reconciliation_intents as intent
    set watcher_generation_kind = 'root_catch_up',
        accepted_sequence_lower = participant_fences.accepted_sequence_lower,
        accepted_sequence_upper = participant_fences.accepted_sequence_upper,
        dirty_generation = participant_fences.dirty_generation,
        updated_at = p_now
    from (
      select pg_catalog.min(owned.accepted_sequence_lower) as accepted_sequence_lower,
             pg_catalog.max(owned.accepted_sequence_upper) as accepted_sequence_upper,
             pg_catalog.max(owned.dirty_generation) as dirty_generation
        from library.watcher_generation_participants as owned
       where owned.generation_id = candidate.generation_id
    ) as participant_fences
    where intent.id = candidate.generation_id;

    delete from library.targeted_reconciliation_intent_paths
    where intent_id = candidate.generation_id;
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = candidate.generation_id;

    v_reconciled := v_reconciled + 1;
    generation_id := candidate.generation_id;
    return next;
  end loop;

  if v_reconciled >= p_limit then
    return;
  end if;

  for candidate in
    select distinct lane.running_generation_id as generation_id,
           lane.running_job_id as job_id, lane.library_id,
           intent.primary_root_id, job.state, job.lease_expires_at
    from library.watcher_lanes as lane
    join library.targeted_reconciliation_intents as intent
      on intent.id = lane.running_generation_id
    left join ops.jobs as job on job.id = lane.running_job_id
    where lane.running_generation_id is not null
      and lane.running_job_id is not null
      and not (
        job.state in ('queued', 'retry_wait')
        or (job.state = 'running'
            and job.lease_expires_at > pg_catalog.clock_timestamp())
      )
      and (job.id is null
           or job.state in ('canceled', 'failed', 'ambiguous', 'succeeded'))
    order by lane.running_generation_id
    limit p_limit - v_reconciled
  loop
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'album-haven:watcher:' || candidate.library_id::text, 0
      )
    ) then
      continue;
    end if;

    perform 1 from library.watcher_repairs as repair
    where repair.library_id = candidate.library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id for update;
    with recursive successor_closure(library_id, root_id, generation_id) as (
      select owned.library_id, owned.root_id, lane.successor_generation_id
      from library.watcher_generation_participants as owned
      join library.watcher_lanes as lane
        on lane.library_id = owned.library_id and lane.root_id = owned.root_id
      where owned.generation_id = candidate.generation_id
      union
      select owned.library_id, owned.root_id,
             owned_lane.successor_generation_id
      from successor_closure as current
      join library.watcher_generation_participants as owned
        on owned.generation_id = current.generation_id
      join library.watcher_lanes as owned_lane
        on owned_lane.library_id = owned.library_id
       and owned_lane.root_id = owned.root_id
      where current.generation_id is not null
    ), lock_roots as (
      select closure.library_id, closure.root_id
      from successor_closure as closure
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as owned_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = owned_barrier.barrier_id
      where owned_barrier.generation_id = candidate.generation_id
    ), locked_lanes as materialized (
      select lane.library_id, lane.root_id, lane.successor_generation_id
      from library.watcher_lanes as lane
      join lock_roots as locked
        on locked.library_id = lane.library_id and locked.root_id = lane.root_id
      order by lane.library_id, lane.root_id
      for update of lane
    )
    select pg_catalog.array_agg(locked.root_id order by locked.root_id),
           pg_catalog.array_agg(distinct locked.successor_generation_id
                                order by locked.successor_generation_id)
             filter (
               where locked.successor_generation_id is not null
                 and exists (
                   select 1 from successor_closure as closure
                   where closure.library_id = locked.library_id
                     and closure.root_id = locked.root_id
                 )
             )
    into v_closure_root_ids, v_existing_successor_ids
    from locked_lanes as locked;
    if exists (
      select 1 from ops.jobs as job
      where job.id = candidate.job_id
        and (job.state in ('queued', 'retry_wait')
             or job.state = 'running')
    ) then
      continue;
    end if;
    v_successor_id := v_existing_successor_ids[1];
    if v_successor_id is null then
      v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        'watcher-recovery:' || candidate.generation_id::text, 'UTF8'
      )), 'hex');
      insert into library.targeted_reconciliation_intents (
        library_id, primary_root_id, producer_request_key, request_digest,
        deployment_mode, client_surface, state, accepted_at, updated_at,
        watcher_generation_kind, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation
      )
      select candidate.library_id, candidate.primary_root_id,
             'watcher-recovery:' || candidate.generation_id::text,
             v_digest, 'self_hosted_private_web', 'library_watcher',
             'accepted', p_now, p_now, 'root_catch_up',
             pg_catalog.min(lane.accepted_sequence),
             pg_catalog.max(lane.accepted_sequence),
             pg_catalog.max(lane.dirty_generation) + 1
      from library.watcher_lanes as lane
      join library.watcher_generation_participants as owned
        on owned.library_id = lane.library_id and owned.root_id = lane.root_id
      where owned.generation_id = candidate.generation_id
      returning id into v_successor_id;
    end if;
    foreach v_loser_id in array coalesce(
      v_existing_successor_ids[2:], array[]::bigint[]
    )
    loop
      insert into library.watcher_generation_participants (
        generation_id, library_id, root_id, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation, created_at, updated_at
      )
      select v_successor_id, owned.library_id, owned.root_id,
             owned.accepted_sequence_lower, owned.accepted_sequence_upper,
             owned.dirty_generation, owned.created_at, p_now
      from library.watcher_generation_participants as owned
      where owned.generation_id = v_loser_id
    on conflict on constraint watcher_generation_participants_pkey do update set
      accepted_sequence_lower = least(
          library.watcher_generation_participants.accepted_sequence_lower,
          excluded.accepted_sequence_lower
        ),
      accepted_sequence_upper = greatest(
          library.watcher_generation_participants.accepted_sequence_upper,
          excluded.accepted_sequence_upper
        ),
      dirty_generation = greatest(
          library.watcher_generation_participants.dirty_generation,
          excluded.dirty_generation
        ),
        updated_at = excluded.updated_at;
      update library.watcher_barrier_participants as barrier_link
      set generation_id = v_successor_id
      where barrier_link.generation_id = v_loser_id;
      insert into library.watcher_generation_repairs (
        generation_id, repair_id, library_id, created_at
      )
      select v_successor_id, repair_link.repair_id, repair_link.library_id,
             repair_link.created_at
      from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = v_loser_id
      on conflict on constraint watcher_generation_repairs_pkey do nothing;
      delete from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = v_loser_id;
      update library.watcher_lanes
      set successor_generation_id = v_successor_id, updated_at = p_now
      where successor_generation_id = v_loser_id;
      delete from library.targeted_reconciliation_intents
      where id = v_loser_id and watcher_job_linked_at is null;
    end loop;
    update library.targeted_reconciliation_intents
    set watcher_generation_kind = 'root_catch_up', updated_at = p_now
    where id = v_successor_id and watcher_job_linked_at is null;
    delete from library.targeted_reconciliation_intent_paths
    where intent_id = v_successor_id;
    delete from library.targeted_reconciliation_intent_moves
    where intent_id = v_successor_id;
    for participant in
      update library.watcher_lanes as lane
      set dirty_generation = lane.dirty_generation + 1,
          successor_generation_id = v_successor_id,
          running_generation_id = null, running_job_id = null,
        disposition_code = 'dirty',
        next_eligible_at = p_now + interval '1 microsecond',
          updated_at = p_now
      from library.watcher_generation_participants as owned
      where owned.generation_id = candidate.generation_id
        and lane.library_id = owned.library_id and lane.root_id = owned.root_id
        and lane.running_generation_id = candidate.generation_id
        and lane.running_job_id = candidate.job_id
      returning lane.library_id, lane.root_id, lane.accepted_sequence,
                lane.dirty_generation
    loop
      insert into library.watcher_generation_participants (
        generation_id, library_id, root_id, accepted_sequence_lower,
        accepted_sequence_upper, dirty_generation, created_at, updated_at
      ) values (
        v_successor_id, participant.library_id, participant.root_id,
        participant.accepted_sequence, participant.accepted_sequence,
        participant.dirty_generation, p_now, p_now
    ) on conflict on constraint watcher_generation_participants_pkey do update set
        accepted_sequence_upper = excluded.accepted_sequence_upper,
        dirty_generation = excluded.dirty_generation,
        updated_at = excluded.updated_at;
      insert into library.watcher_incidents (
        library_id, root_id, incident_family, reason_code, occurrence_count,
        accepted_sequence, dirty_generation, first_seen_at, last_seen_at
      ) values (
        participant.library_id, participant.root_id, 'watcher_recovery',
        'reconciliation_failed', 1, participant.accepted_sequence,
        participant.dirty_generation, p_now, p_now
      ) on conflict (library_id, root_id, incident_family)
        where resolved_at is null do update set
          reason_code = excluded.reason_code,
          occurrence_count = library.watcher_incidents.occurrence_count + 1,
      accepted_sequence = greatest(
        library.watcher_incidents.accepted_sequence,
        excluded.accepted_sequence
      ),
      dirty_generation = greatest(
        library.watcher_incidents.dirty_generation,
        excluded.dirty_generation
      ),
          last_seen_at = excluded.last_seen_at;
    end loop;
    update library.watcher_barrier_participants as barrier_link
    set generation_id = v_successor_id
    where barrier_link.generation_id = candidate.generation_id;
    insert into library.watcher_generation_repairs (
      generation_id, repair_id, library_id, created_at
    ) select v_successor_id, repair_link.repair_id, repair_link.library_id,
             repair_link.created_at
      from library.watcher_generation_repairs as repair_link
      where repair_link.generation_id = candidate.generation_id
    on conflict on constraint watcher_generation_repairs_pkey do nothing;
    delete from library.watcher_generation_repairs as repair_link
    where repair_link.generation_id = candidate.generation_id;
    generation_id := candidate.generation_id;
    return next;
  end loop;
end;
$$;

create or replace function library.disable_watcher_acceptance(
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_now is null then
    raise exception 'watcher acceptance disable time is required'
      using errcode = '22023';
  end if;
  update library.watcher_runtime_state
  set acceptance_enabled = false, disabled_at = p_now, updated_at = p_now
  where singleton is true;
  return true;
end;
$$;

create or replace function library.prepare_legacy_watcher_rollback(
  p_now timestamptz
)
returns table (
  retained_generation_ids bigint[],
  affected_logical_root_ids text[]
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_now is null or exists (
    select 1 from library.watcher_runtime_state
    where singleton is true and acceptance_enabled is true
  ) then
    raise exception 'watcher acceptance must be disabled before rollback'
      using errcode = '55000';
  end if;
  perform 1 from library.watcher_repairs as repair
  where repair.state in ('scanning', 'catch_up')
  order by repair.id for update;
  perform 1 from library.watcher_lanes as lane
  where lane.accepted_sequence > lane.applied_sequence
     or lane.dirty_generation > lane.repaired_dirty_generation
  order by lane.library_id, lane.root_id for update;
  insert into library.watcher_incidents (
    library_id, root_id, incident_family, reason_code, occurrence_count,
    accepted_sequence, dirty_generation, first_seen_at, last_seen_at
  )
  select lane.library_id, lane.root_id, 'watcher_recovery',
         'rollback_pending_work', 1, lane.accepted_sequence,
         lane.dirty_generation, p_now, p_now
  from library.watcher_lanes as lane
  where lane.accepted_sequence > lane.applied_sequence
     or lane.dirty_generation > lane.repaired_dirty_generation
  on conflict (library_id, root_id, incident_family)
    where resolved_at is null do update set
      reason_code = excluded.reason_code,
      occurrence_count = library.watcher_incidents.occurrence_count + 1,
      accepted_sequence = greatest(
        library.watcher_incidents.accepted_sequence,
        excluded.accepted_sequence
      ),
      dirty_generation = greatest(
        library.watcher_incidents.dirty_generation,
        excluded.dirty_generation
      ),
      last_seen_at = excluded.last_seen_at;
  return query
  select coalesce(pg_catalog.array_agg(distinct generation_id order by generation_id)
                    filter (where generation_id is not null), array[]::bigint[]),
         coalesce(pg_catalog.array_agg(distinct logical_root_id order by logical_root_id),
                  array[]::text[])
  from (
    select lane.running_generation_id as generation_id,
           root.metadata ->> 'root_id' as logical_root_id
    from library.watcher_lanes as lane
    join library.library_roots as root
      on root.library_id = lane.library_id and root.id = lane.root_id
    where lane.accepted_sequence > lane.applied_sequence
       or lane.dirty_generation > lane.repaired_dirty_generation
    union all
    select lane.successor_generation_id,
           root.metadata ->> 'root_id'
    from library.watcher_lanes as lane
    join library.library_roots as root
      on root.library_id = lane.library_id and root.id = lane.root_id
    where lane.accepted_sequence > lane.applied_sequence
       or lane.dirty_generation > lane.repaired_dirty_generation
  ) retained;
end;
$$;

revoke all on function library.publish_claimed_full_scan(
  bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz
) from public;
revoke all on function library.publish_claimed_targeted_reconciliation(
  bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz
) from public;

do $$
begin
  if pg_catalog.to_regprocedure(
    'library.publish_claimed_full_scan_inventory_0106(bigint,bigint,integer,character varying,character varying,bigint,jsonb,text[],timestamp with time zone)'
  ) is null then
    alter function library.publish_claimed_full_scan(
      bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz
    ) rename to publish_claimed_full_scan_inventory_0106;
  else
    execute 'drop function library.publish_claimed_full_scan(bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz)';
  end if;
  if pg_catalog.to_regprocedure(
    'library.publish_claimed_targeted_reconciliation_inventory_0106(bigint,bigint,integer,character varying,character varying,jsonb,jsonb,timestamp with time zone)'
  ) is null then
    alter function library.publish_claimed_targeted_reconciliation(
      bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz
    ) rename to publish_claimed_targeted_reconciliation_inventory_0106;
  else
    execute 'drop function library.publish_claimed_targeted_reconciliation(bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz)';
  end if;
end;
$$;

do $migration$
declare
  function_definition text;
  original_scope text := $fragment$    with allowed_stale as (
      select authorized_primary_root_id as root_id, 'path'::text as stale_kind, path
        from unnest(coalesce(authorized_deleted_paths, array[]::text[])) as item(path)
      union all
      select authorized_primary_root_id, 'subtree', path
        from unnest(coalesce(authorized_deleted_subtrees, array[]::text[])) as item(path)
      union all
      select move ->> 'source_root_ref',
             case when coalesce((move ->> 'is_directory')::boolean, false)
                  then 'subtree' else 'path' end,
             move ->> 'source_path'
        from jsonb_array_elements(coalesce(authorized_moves, '[]'::jsonb)) as item(move)
    ), submitted_stale as ($fragment$;
  root_aware_scope text := $fragment$    with allowed_stale as (
      select authorized_primary_root_id as root_id, 'path'::text as stale_kind, path
        from unnest(coalesce(authorized_deleted_paths, array[]::text[])) as item(path)
      union all
      select authorized_primary_root_id, 'subtree', path
        from unnest(coalesce(authorized_deleted_subtrees, array[]::text[])) as item(path)
      union all
      select move ->> 'source_root_ref',
             case when coalesce((move ->> 'is_directory')::boolean, false)
                  then 'subtree' else 'path' end,
             move ->> 'source_path'
        from jsonb_array_elements(coalesce(authorized_moves, '[]'::jsonb)) as item(move)
      union all
      select root.metadata ->> 'root_id',
             case authorized.path_kind
               when 'deleted_subtree' then 'subtree' else 'path' end,
             root.root_path
               || case library.local_path_style(root.root_path)
                    when 'windows' then E'\\' else '/' end
               || authorized.relative_path
        from library.targeted_reconciliation_intent_paths as authorized
        join library.targeted_reconciliation_intents as intent
          on intent.id = authorized.intent_id
         and intent.watcher_generation_kind is not null
        join library.library_roots as root
          on root.library_id = authorized.library_id
         and root.id = authorized.root_id
         and root.is_active is true
       where authorized.intent_id = p_intent_id
         and authorized.path_kind in ('deleted', 'deleted_subtree')
    ), submitted_stale as ($fragment$;
begin
  select pg_catalog.pg_get_functiondef(
           'library.publish_claimed_targeted_reconciliation_inventory_0106(bigint,bigint,integer,character varying,character varying,jsonb,jsonb,timestamp with time zone)'::regprocedure
         )
    into function_definition;
  function_definition := pg_catalog.replace(function_definition, E'\r\n', E'\n');
  original_scope := pg_catalog.replace(original_scope, E'\r\n', E'\n');
  root_aware_scope := pg_catalog.replace(root_aware_scope, E'\r\n', E'\n');
  if pg_catalog.strpos(function_definition, root_aware_scope) > 0 then
    return;
  end if;
  if pg_catalog.strpos(function_definition, original_scope) = 0 then
    raise exception '0107 targeted publication authorization source changed';
  end if;
  function_definition := pg_catalog.replace(
    function_definition,
    original_scope,
    root_aware_scope
  );
  execute function_definition;
end;
$migration$;

create or replace function library.publish_claimed_full_scan(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_expected_inventory_revision bigint,
  p_inventory jsonb,
  p_observed_root_ids text[],
  p_now timestamptz
)
returns table (
  publication_won boolean,
  inventory_mutation_revision bigint,
  cover_publication_stale boolean,
  cover_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_publication record;
  v_repair_id bigint;
  v_library_id bigint;
begin
  select job.library_id
  into v_library_id
  from ops.jobs as job
  where job.id = p_job_id
    and job.kind = 'full_scan'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update of job;
  if not found then
    return query select false, null::bigint, false, 0::bigint;
    return;
  end if;

  select intent.watcher_repair_id
  into v_repair_id
  from library.full_scan_intents as intent
  where intent.id = p_intent_id
    and intent.job_id = p_job_id
    and intent.library_id = v_library_id
    and intent.state = 'running'
  for update of intent;
  if not found then
    return query select false, null::bigint, false, 0::bigint;
    return;
  end if;

  if v_repair_id is not null then
    perform 1
    from library.watcher_repairs as repair
    where repair.id = v_repair_id
      and repair.library_id = v_library_id
    order by repair.id
    for update;
    if not found then
      raise exception 'full scan watcher repair fence changed'
        using errcode = '40001';
    end if;

    perform 1
    from library.watcher_lanes as lane
    join (
      select repair_root.library_id, repair_root.root_id
      from library.watcher_repair_roots as repair_root
      where repair_root.repair_id = v_repair_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_repair_roots as repair_root
      join library.watcher_barrier_participants as touched
        on touched.library_id = repair_root.library_id
       and touched.root_id = repair_root.root_id
      join library.watcher_barriers as barrier
        on barrier.id = touched.barrier_id
       and barrier.completed_at is null
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = touched.barrier_id
      where repair_root.repair_id = v_repair_id
    ) as locked
      on locked.library_id = lane.library_id
     and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;
  end if;
  select * into v_publication
  from library.publish_claimed_full_scan_inventory_0106(
    p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token,
    p_expected_inventory_revision, p_inventory, p_observed_root_ids, p_now
  );
  if coalesce(v_publication.publication_won, false)
     and v_repair_id is not null then
    perform library.complete_watcher_repair_internal(
      v_repair_id,
      p_job_id,
      p_attempt,
      p_worker_id,
      p_lease_token,
      v_publication.inventory_mutation_revision,
      p_now,
      false
    );
    perform 1
    from library.watcher_repairs as repair
    where repair.id = v_repair_id
      and repair.inventory_revision = v_publication.inventory_mutation_revision
      and repair.state in ('catch_up', 'complete');
    if not found then
      raise exception 'watcher repair publication fence changed'
        using errcode = '40001';
    end if;
  end if;
  return query select
    coalesce(v_publication.publication_won, false),
    v_publication.inventory_mutation_revision,
    false,
    0::bigint;
end;
$$;

create or replace function library.publish_claimed_targeted_reconciliation(
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_inventory jsonb,
  p_stale_scopes jsonb,
  p_now timestamptz
)
returns table (
  publication_won boolean,
  inventory_mutation_revision bigint,
  affected_album_keys text[],
  cover_publication_stale boolean,
  cover_mutation_revision bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_publication record;
  v_is_watcher boolean;
  v_stored_attempt integer;
  v_stored_revision bigint;
  v_stored_keys text[];
  v_retry_authorized boolean;
  v_library_id bigint;
begin
  select intent.library_id, intent.watcher_generation_kind is not null
  into v_library_id, v_is_watcher
  from library.targeted_reconciliation_intents as intent
  join ops.jobs as job on job.id = intent.job_id
  where intent.id = p_intent_id
    and job.id = p_job_id
    and job.kind = 'targeted_reconciliation'
    and job.state = 'running'
    and job.attempt_count = p_attempt
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > pg_catalog.clock_timestamp();
  if coalesce(v_is_watcher, false) then
    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = v_library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;
    perform 1
    from library.watcher_lanes as lane
    join (
      select participant.library_id, participant.root_id
      from library.watcher_generation_participants as participant
      where participant.generation_id = p_intent_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as owned_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = owned_barrier.barrier_id
      where owned_barrier.generation_id = p_intent_id
    ) as locked
      on locked.library_id = lane.library_id and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;
  end if;
  select intent.publication_attempt, intent.committed_inventory_revision,
         intent.affected_album_keys, intent.watcher_generation_kind is not null,
         job.id is not null
  into v_stored_attempt, v_stored_revision, v_stored_keys, v_is_watcher,
       v_retry_authorized
  from library.targeted_reconciliation_intents as intent
  left join ops.jobs as job
    on job.id = p_job_id
   and job.id = intent.job_id
   and job.kind = 'targeted_reconciliation'
   and job.state = 'running'
   and job.attempt_count = p_attempt
   and job.lease_owner = p_worker_id
   and job.lease_token = p_lease_token
   and job.lease_expires_at > pg_catalog.clock_timestamp()
  where intent.id = p_intent_id
  for update of intent;
  select * into v_publication
  from library.publish_claimed_targeted_reconciliation_inventory_0106(
    p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token,
    p_inventory, p_stale_scopes, p_now
  );
  if v_stored_attempt is not null then
    return query select
      coalesce(v_is_watcher, false)
        and coalesce(v_retry_authorized, false)
        and v_stored_attempt = p_attempt,
      v_stored_revision,
      coalesce(v_stored_keys, array[]::text[]),
      false,
      0::bigint;
    return;
  end if;
  if coalesce(v_publication.publication_won, false) then
    perform library.retire_claimed_targeted_reconciliation_vacated_albums(
      p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token, p_now
    );
    if coalesce(v_is_watcher, false) and not library.complete_watcher_generation(
      p_intent_id, p_job_id, p_attempt, p_worker_id, p_lease_token, p_now
    ) then
      raise exception 'watcher publication completion fence failed'
        using errcode = '40001';
    end if;
    if coalesce(v_is_watcher, false) then
      perform 1
      from library.targeted_reconciliation_intents as completed
      join library.watcher_generation_participants as participant
        on participant.generation_id = completed.id
      join library.watcher_lanes as lane
        on lane.library_id = participant.library_id
       and lane.root_id = participant.root_id
      where completed.id = p_intent_id
        and completed.watcher_completed_at is not null
        and lane.running_generation_id is null
        and lane.running_job_id is null;
    end if;
  end if;
  return query select
    coalesce(v_publication.publication_won, false),
    v_publication.inventory_mutation_revision,
    coalesce(v_publication.affected_album_keys, array[]::text[]),
    false,
    0::bigint;
end;
$$;

revoke all on function ops.validate_durable_worker_startup(text[]) from public;
do $$
begin
  if pg_catalog.to_regprocedure(
    'ops.validate_durable_worker_startup_baseline_0105(text[])'
  ) is null then
    alter function ops.validate_durable_worker_startup(text[])
      rename to validate_durable_worker_startup_baseline_0105;
  end if;
end;
$$;

create or replace function ops.validate_durable_worker_startup(
  p_registered_kinds text[]
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  required_functions constant text[] := array[
    'library.load_claimed_full_scan_intent_v3(bigint,character varying,character varying)',
    'library.reconcile_due_watcher_generations(timestamp with time zone,integer)',
    'library.dispatch_ready_watcher_generations(timestamp with time zone,integer)',
    'library.load_claimed_watcher_generation(bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_watcher_private_scope(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.fail_claimed_watcher_generation(bigint,bigint,integer,character varying,character varying,character varying,timestamp with time zone)',
    'library.complete_watcher_repair(bigint,bigint,integer,character varying,character varying,bigint,timestamp with time zone)',
    'library.load_watcher_metrics(bigint,timestamp with time zone)'
  ];
  required record;
begin
  if not ops.validate_durable_worker_startup_baseline_0105(p_registered_kinds) then
    return false;
  end if;
  for required in select pg_catalog.unnest(required_functions) as signature
  loop
    if pg_catalog.to_regprocedure(required.signature) is null
       or not pg_catalog.has_function_privilege(
         session_user, required.signature, 'EXECUTE'
       ) then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function library.try_parse_watcher_timestamptz(
  p_value text,
  p_fallback timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog
as $$
begin
  if nullif(pg_catalog.btrim(p_value), '') is null then
    return p_fallback;
  end if;
  return p_value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then
  return p_fallback;
end;
$$;

with legacy_evidence as (
  select library_record.id as library_id, root.id as root_id,
         root.metadata ->> 'root_id' as logical_root_id, health.value
  from library.libraries as library_record
  cross join lateral pg_catalog.jsonb_each(coalesce(
    library_record.metadata -> 'library_watch_health', '{}'::jsonb
  )) as health
  join library.library_roots as root
    on root.library_id = library_record.id
   and root.metadata ->> 'root_id' = health.key
   and root.is_active is true
), newly_imported as (
  insert into library.watcher_legacy_health_imports (
    library_id, root_id, source_key, imported_at
  )
  select library_id, root_id, 'legacy_library_watch_health_v1', pg_catalog.now()
  from legacy_evidence
  on conflict (library_id, root_id, source_key) do nothing
  returning library_id, root_id
)
select library.mark_watcher_roots_dirty(
  imported.library_id,
  array[evidence.logical_root_id],
  case evidence.value ->> 'state'
    when 'overflow' then 'overflow'::varchar
    else 'root_unavailable'::varchar
  end,
  library.try_parse_watcher_timestamptz(
    evidence.value ->> 'detected_at', pg_catalog.clock_timestamp()
  )
)
from newly_imported as imported
join legacy_evidence as evidence using (library_id, root_id);

revoke all on table library.watcher_lanes from public;
revoke all on table library.watcher_generation_participants from public;
revoke all on table library.watcher_barriers from public;
revoke all on table library.watcher_barrier_participants from public;
revoke all on table library.watcher_repairs from public;
revoke all on table library.watcher_repair_roots from public;
revoke all on table library.watcher_generation_repairs from public;
revoke all on table library.watcher_legacy_health_imports from public;
revoke all on table library.watcher_incidents from public;
revoke all on table library.watcher_incident_acknowledgements from public;
revoke all on table library.watcher_runtime_state from public;
revoke all on sequence library.watcher_barriers_id_seq from public;
revoke all on sequence library.watcher_repairs_id_seq from public;
revoke all on function library.local_root_relative_path(text, text) from public;
revoke all on function library.canonical_watcher_relative_path(text) from public;
revoke all on function library.try_parse_watcher_timestamptz(text, timestamptz) from public;
revoke all on function library.reject_watcher_incident_identity_change() from public;
revoke all on function library.create_full_scan_intent_baseline_0107(
  bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
  bigint[], timestamptz
) from public;
revoke all on function library.create_full_scan_intent_v2(
  bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
  bigint[], timestamptz
) from public;
revoke all on function library.create_full_scan_intent_v3(
  bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
  bigint[], timestamptz
) from public;
revoke all on function library.load_claimed_full_scan_intent_v3(
  bigint, varchar, varchar
) from public;
revoke all on function library.load_local_watcher_incidents() from public;
revoke all on function library.load_local_watcher_incident_acknowledgements(bigint) from public;
revoke all on function library.acknowledge_local_watcher_incidents(bigint, uuid[]) from public;
revoke all on function library.load_watcher_status(bigint) from public;
revoke all on function library.load_watcher_incident_acknowledgements(bigint, bigint) from public;
revoke all on function library.acknowledge_watcher_incident(
  bigint, bigint, uuid, timestamptz
) from public;
revoke all on function library.load_watcher_metrics(bigint, timestamptz) from public;
revoke all on function library.mark_watcher_roots_dirty(bigint, text[], varchar, timestamptz) from public;
revoke all on function library.accept_watcher_event(bigint, bigint, jsonb, timestamptz) from public;
revoke all on function library.load_claimed_targeted_reconciliation_intent_v2(bigint, varchar, varchar) from public;
revoke all on function library.load_claimed_targeted_reconciliation_intent_legacy_0107(bigint, varchar, varchar) from public;
revoke all on function library.dispatch_ready_watcher_generations(timestamptz, integer) from public;
revoke all on function library.reconcile_due_watcher_generations(timestamptz, integer) from public;
revoke all on function library.load_claimed_watcher_generation(bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.load_claimed_watcher_private_scope(bigint, bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.complete_watcher_generation(bigint, bigint, integer, varchar, varchar, timestamptz) from public;
revoke all on function library.complete_watcher_repair(bigint, bigint, integer, varchar, varchar, bigint, timestamptz) from public;
revoke all on function library.complete_watcher_repair_internal(bigint, bigint, integer, varchar, varchar, bigint, timestamptz, boolean) from public;
revoke all on function library.try_complete_watcher_repairs(bigint[], timestamptz) from public;
revoke all on function library.fail_claimed_watcher_generation(bigint, bigint, integer, varchar, varchar, varchar, timestamptz) from public;
revoke all on function library.disable_watcher_acceptance(timestamptz) from public;
revoke all on function library.prepare_legacy_watcher_rollback(timestamptz) from public;
revoke all on function library.publish_claimed_full_scan(
  bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz
) from public;
revoke all on function library.publish_claimed_targeted_reconciliation(
  bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz
) from public;
revoke all on function library.publish_claimed_full_scan_inventory_0106(
  bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz
) from public;
revoke all on function library.publish_claimed_targeted_reconciliation_inventory_0106(
  bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz
) from public;
revoke all on function ops.validate_durable_worker_startup(text[]) from public;
revoke all on function ops.validate_durable_worker_startup_baseline_0105(text[]) from public;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'album_haven_app') then
    revoke all on table library.watcher_lanes from album_haven_app;
    revoke all on table library.watcher_generation_participants from album_haven_app;
    revoke all on table library.watcher_barriers from album_haven_app;
    revoke all on table library.watcher_barrier_participants from album_haven_app;
    revoke all on table library.watcher_repairs from album_haven_app;
    revoke all on table library.watcher_repair_roots from album_haven_app;
    revoke all on table library.watcher_generation_repairs from album_haven_app;
    revoke all on table library.watcher_legacy_health_imports from album_haven_app;
    revoke all on table library.watcher_incidents from album_haven_app;
    revoke all on table library.watcher_incident_acknowledgements from album_haven_app;
    revoke all on table library.watcher_runtime_state from album_haven_app;
    revoke all on sequence library.watcher_barriers_id_seq from album_haven_app;
    revoke all on sequence library.watcher_repairs_id_seq from album_haven_app;
    revoke execute on function library.create_full_scan_intent_baseline_0107(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) from album_haven_app;
    grant execute on function library.create_full_scan_intent_v2(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) to album_haven_app;
    grant execute on function library.create_full_scan_intent_v3(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) to album_haven_app;
    revoke execute on function library.load_claimed_full_scan_intent_v3(
      bigint, varchar, varchar
    ) from album_haven_app;
    grant execute on function library.load_local_watcher_incidents()
      to album_haven_app;
    grant execute on function library.load_local_watcher_incident_acknowledgements(bigint)
      to album_haven_app;
    grant execute on function library.acknowledge_local_watcher_incidents(bigint, uuid[])
      to album_haven_app;
    grant execute on function library.load_watcher_status(bigint)
      to album_haven_app;
    grant execute on function library.load_watcher_incident_acknowledgements(bigint, bigint)
      to album_haven_app;
    grant execute on function library.acknowledge_watcher_incident(
      bigint, bigint, uuid, timestamptz
    ) to album_haven_app;
    grant execute on function library.load_watcher_metrics(bigint, timestamptz)
      to album_haven_app;
    grant execute on function library.mark_watcher_roots_dirty(
      bigint, text[], varchar, timestamptz
    ) to album_haven_app;
    grant execute on function library.accept_watcher_event(
      bigint, bigint, jsonb, timestamptz
    ) to album_haven_app;
    revoke execute on function library.dispatch_ready_watcher_generations(
      timestamptz, integer
    ) from album_haven_app;
    revoke execute on function library.load_claimed_targeted_reconciliation_intent_v2(
      bigint, varchar, varchar
    ) from album_haven_app;
    revoke execute on function library.load_claimed_targeted_reconciliation_intent_legacy_0107(
      bigint, varchar, varchar
    ) from album_haven_app;
    revoke execute on function library.complete_watcher_generation(
      bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_app;
    revoke execute on function library.reconcile_due_watcher_generations(
      timestamptz, integer
    ) from album_haven_app;
    revoke execute on function library.load_claimed_watcher_private_scope(
      bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_app;
    revoke execute on function library.complete_watcher_repair(
      bigint, bigint, integer, varchar, varchar, bigint, timestamptz
    ) from album_haven_app;
    revoke execute on function library.prepare_legacy_watcher_rollback(
      timestamptz
    ) from album_haven_app;
    revoke execute on function library.disable_watcher_acceptance(
      timestamptz
    ) from album_haven_app;
    revoke execute on function library.try_complete_watcher_repairs(
      bigint[], timestamptz
    ) from album_haven_app;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'album_haven_worker') then
    revoke all on table library.watcher_lanes from album_haven_worker;
    revoke all on table library.watcher_generation_participants from album_haven_worker;
    revoke all on table library.watcher_barriers from album_haven_worker;
    revoke all on table library.watcher_barrier_participants from album_haven_worker;
    revoke all on table library.watcher_repairs from album_haven_worker;
    revoke all on table library.watcher_repair_roots from album_haven_worker;
    revoke all on table library.watcher_generation_repairs from album_haven_worker;
    revoke all on table library.watcher_legacy_health_imports from album_haven_worker;
    revoke all on table library.watcher_incidents from album_haven_worker;
    revoke all on table library.watcher_incident_acknowledgements from album_haven_worker;
    revoke all on table library.watcher_runtime_state from album_haven_worker;
    revoke all on sequence library.watcher_barriers_id_seq from album_haven_worker;
    revoke all on sequence library.watcher_repairs_id_seq from album_haven_worker;
    revoke execute on function library.create_full_scan_intent_baseline_0107(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) from album_haven_worker;
    revoke execute on function library.create_full_scan_intent_v2(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) from album_haven_worker;
    revoke execute on function library.create_full_scan_intent_v3(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) from album_haven_worker;
    grant execute on function library.load_claimed_full_scan_intent_v3(
      bigint, varchar, varchar
    ) to album_haven_worker;
    revoke execute on function library.load_local_watcher_incidents()
      from album_haven_worker;
    revoke execute on function library.load_local_watcher_incident_acknowledgements(bigint)
      from album_haven_worker;
    revoke execute on function library.acknowledge_local_watcher_incidents(bigint, uuid[])
      from album_haven_worker;
    revoke execute on function library.load_watcher_status(bigint)
      from album_haven_worker;
    revoke execute on function library.load_watcher_incident_acknowledgements(bigint, bigint)
      from album_haven_worker;
    revoke execute on function library.acknowledge_watcher_incident(
      bigint, bigint, uuid, timestamptz
    ) from album_haven_worker;
    grant execute on function library.load_watcher_metrics(bigint, timestamptz)
      to album_haven_worker;
    revoke execute on function library.mark_watcher_roots_dirty(
      bigint, text[], varchar, timestamptz
    ) from album_haven_worker;
    revoke execute on function library.accept_watcher_event(
      bigint, bigint, jsonb, timestamptz
    ) from album_haven_worker;
    grant execute on function library.dispatch_ready_watcher_generations(
      timestamptz, integer
    ) to album_haven_worker;
    grant execute on function library.reconcile_due_watcher_generations(
      timestamptz, integer
    ) to album_haven_worker;
    grant execute on function library.load_claimed_watcher_generation(
      bigint, integer, varchar, varchar, timestamptz
    ) to album_haven_worker;
    grant execute on function library.load_claimed_targeted_reconciliation_intent_v2(
      bigint, varchar, varchar
    ) to album_haven_worker;
    revoke execute on function library.load_claimed_targeted_reconciliation_intent_legacy_0107(
      bigint, varchar, varchar
    ) from album_haven_worker;
    grant execute on function library.load_claimed_watcher_private_scope(
      bigint, bigint, integer, varchar, varchar, timestamptz
    ) to album_haven_worker;
    revoke execute on function library.complete_watcher_generation(
      bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_worker;
    grant execute on function library.complete_watcher_repair(
      bigint, bigint, integer, varchar, varchar, bigint, timestamptz
    ) to album_haven_worker;
    revoke execute on function library.try_complete_watcher_repairs(
      bigint[], timestamptz
    ) from album_haven_worker;
    revoke execute on function library.prepare_legacy_watcher_rollback(
      timestamptz
    ) from album_haven_worker;
    revoke execute on function library.disable_watcher_acceptance(
      timestamptz
    ) from album_haven_worker;
    grant execute on function library.fail_claimed_watcher_generation(
      bigint, bigint, integer, varchar, varchar, varchar, timestamptz
    ) to album_haven_worker;
    revoke execute on function library.publish_claimed_full_scan_inventory_0106(
      bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz
    ) from album_haven_worker;
    revoke execute on function library.publish_claimed_targeted_reconciliation_inventory_0106(
      bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz
    ) from album_haven_worker;
    grant execute on function library.publish_claimed_full_scan(
      bigint, bigint, integer, varchar, varchar, bigint, jsonb, text[], timestamptz
    ) to album_haven_worker;
    grant execute on function library.publish_claimed_targeted_reconciliation(
      bigint, bigint, integer, varchar, varchar, jsonb, jsonb, timestamptz
    ) to album_haven_worker;
    revoke execute on function ops.validate_durable_worker_startup_baseline_0105(
      text[]
    ) from album_haven_worker;
    grant execute on function ops.validate_durable_worker_startup(
      text[]
    ) to album_haven_worker;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table library.watcher_lanes from album_haven_readonly;
    revoke all on table library.watcher_generation_participants from album_haven_readonly;
    revoke all on table library.watcher_barriers from album_haven_readonly;
    revoke all on table library.watcher_barrier_participants from album_haven_readonly;
    revoke all on table library.watcher_repairs from album_haven_readonly;
    revoke all on table library.watcher_repair_roots from album_haven_readonly;
    revoke all on table library.watcher_generation_repairs from album_haven_readonly;
    revoke all on table library.watcher_legacy_health_imports from album_haven_readonly;
    revoke all on table library.watcher_incidents from album_haven_readonly;
    revoke all on table library.watcher_incident_acknowledgements from album_haven_readonly;
    revoke all on table library.watcher_runtime_state from album_haven_readonly;
    revoke all on sequence library.watcher_barriers_id_seq from album_haven_readonly;
    revoke all on sequence library.watcher_repairs_id_seq from album_haven_readonly;
    revoke execute on function library.create_full_scan_intent_baseline_0107(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.create_full_scan_intent_v2(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.create_full_scan_intent_v3(
      bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean,
      bigint[], timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.load_claimed_full_scan_intent_v3(
      bigint, varchar, varchar
    ) from album_haven_readonly;
    revoke execute on function library.load_local_watcher_incidents()
      from album_haven_readonly;
    revoke execute on function library.load_local_watcher_incident_acknowledgements(bigint)
      from album_haven_readonly;
    revoke execute on function library.acknowledge_local_watcher_incidents(bigint, uuid[])
      from album_haven_readonly;
    grant execute on function library.load_watcher_status(bigint)
      to album_haven_readonly;
    revoke execute on function library.load_watcher_incident_acknowledgements(bigint, bigint)
      from album_haven_readonly;
    revoke execute on function library.acknowledge_watcher_incident(
      bigint, bigint, uuid, timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.load_watcher_metrics(bigint, timestamptz)
      from album_haven_readonly;
    revoke execute on function library.mark_watcher_roots_dirty(
      bigint, text[], varchar, timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.accept_watcher_event(
      bigint, bigint, jsonb, timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.dispatch_ready_watcher_generations(
      timestamptz, integer
    ) from album_haven_readonly;
    revoke execute on function library.load_claimed_targeted_reconciliation_intent_v2(
      bigint, varchar, varchar
    ) from album_haven_readonly;
    revoke execute on function library.load_claimed_targeted_reconciliation_intent_legacy_0107(
      bigint, varchar, varchar
    ) from album_haven_readonly;
    revoke execute on function library.complete_watcher_generation(
      bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.reconcile_due_watcher_generations(
      timestamptz, integer
    ) from album_haven_readonly;
    revoke execute on function library.load_claimed_watcher_private_scope(
      bigint, bigint, integer, varchar, varchar, timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.complete_watcher_repair(
      bigint, bigint, integer, varchar, varchar, bigint, timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.prepare_legacy_watcher_rollback(
      timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.disable_watcher_acceptance(
      timestamptz
    ) from album_haven_readonly;
    revoke execute on function library.try_complete_watcher_repairs(
      bigint[], timestamptz
    ) from album_haven_readonly;
  end if;
end;
$$;
