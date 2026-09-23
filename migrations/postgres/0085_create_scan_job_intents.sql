create table if not exists library.full_scan_intents (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete restrict,
  initiating_account_id bigint not null references app.accounts(id) on delete restrict,
  capability_key varchar(128) not null,
  request_origin_id bigint not null references app.request_origins(id) on delete restrict,
  deployment_mode varchar(128) not null,
  client_surface varchar(128) not null,
  mode varchar(32) not null,
  force boolean not null,
  state varchar(32) not null default 'accepted',
  progress_current bigint not null default 0,
  progress_total bigint not null default 0,
  committed_inventory_revision bigint,
  outcome_code varchar(128),
  job_id bigint references ops.jobs(id) on delete restrict,
  accepted_at timestamptz not null,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint full_scan_intents_mode_check check (
    mode in ('normal', 'background', 'manual_full_rescan', 'library_settings_update')
  ),
  constraint full_scan_intents_state_check check (state in (
    'accepted', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled'
  )),
  constraint full_scan_intents_progress_check check (
    progress_current >= 0 and progress_total >= 0 and
    progress_current <= progress_total
  ),
  constraint full_scan_intents_revision_check check (
    committed_inventory_revision is null or committed_inventory_revision >= 0
  ),
  constraint full_scan_intents_terminal_check check (
    (state in ('succeeded', 'failed', 'canceled') and completed_at is not null) or
    (state in ('accepted', 'running', 'retry_wait') and completed_at is null)
  )
);

create table if not exists library.full_scan_intent_roots (
  intent_id bigint not null references library.full_scan_intents(id) on delete cascade,
  root_id bigint not null references library.library_roots(id) on delete restrict,
  ordinal integer not null,
  primary key (intent_id, root_id),
  constraint full_scan_intent_roots_ordinal_check check (ordinal >= 0)
);

create table if not exists library.targeted_reconciliation_intents (
  id bigint generated always as identity primary key,
  library_id bigint not null references library.libraries(id) on delete restrict,
  primary_root_id bigint not null references library.library_roots(id) on delete restrict,
  producer_request_key varchar(256) not null,
  request_digest varchar(64) not null,
  deployment_mode varchar(128) not null,
  client_surface varchar(128) not null,
  state varchar(32) not null default 'accepted',
  job_id bigint references ops.jobs(id) on delete restrict,
  accepted_at timestamptz not null,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome_code varchar(128),
  constraint targeted_reconciliation_intents_state_check check (state in (
    'accepted', 'running', 'retry_wait', 'succeeded', 'failed', 'canceled'
  )),
  constraint targeted_reconciliation_intents_request_digest_check check (
    request_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint targeted_reconciliation_intents_terminal_check check (
    (state in ('succeeded', 'failed', 'canceled') and completed_at is not null) or
    (state in ('accepted', 'running', 'retry_wait') and completed_at is null)
  )
);

create table if not exists library.targeted_reconciliation_intent_paths (
  intent_id bigint not null references library.targeted_reconciliation_intents(id) on delete cascade,
  path_kind varchar(32) not null,
  path text not null,
  ordinal integer not null,
  primary key (intent_id, path_kind, ordinal),
  constraint targeted_reconciliation_intent_paths_kind_check check (
    path_kind in ('active', 'deleted', 'deleted_subtree', 'preserved_subtree')
  ),
  constraint targeted_reconciliation_intent_paths_value_check check (
    length(path) between 1 and 4096 and path !~ '[[:cntrl:]]'
  ),
  constraint targeted_reconciliation_intent_paths_ordinal_check check (ordinal >= 0)
);

create table if not exists library.targeted_reconciliation_intent_moves (
  intent_id bigint not null references library.targeted_reconciliation_intents(id) on delete cascade,
  source_path text not null,
  destination_path text not null,
  source_root_id bigint not null references library.library_roots(id) on delete restrict,
  destination_root_id bigint not null references library.library_roots(id) on delete restrict,
  is_directory boolean not null,
  ordinal integer not null,
  primary key (intent_id, ordinal),
  constraint targeted_reconciliation_intent_moves_source_check check (
    length(source_path) between 1 and 4096 and source_path !~ '[[:cntrl:]]'
  ),
  constraint targeted_reconciliation_intent_moves_destination_check check (
    length(destination_path) between 1 and 4096 and destination_path !~ '[[:cntrl:]]'
  ),
  constraint targeted_reconciliation_intent_moves_ordinal_check check (ordinal >= 0)
);

create index if not exists full_scan_intents_library_id_idx
  on library.full_scan_intents (library_id, accepted_at desc, id desc);
create unique index if not exists full_scan_intents_job_id_idx
  on library.full_scan_intents (job_id) where job_id is not null;
create index if not exists full_scan_intent_roots_root_id_idx
  on library.full_scan_intent_roots (root_id);
create unique index if not exists library_roots_active_logical_root_id_idx
  on library.library_roots (library_id, (metadata ->> 'root_id'))
  where is_active is true
    and nullif(btrim(metadata ->> 'root_id'), '') is not null;
create index if not exists targeted_reconciliation_intents_library_id_idx
  on library.targeted_reconciliation_intents (library_id, accepted_at desc, id desc);
create unique index if not exists targeted_reconciliation_intents_producer_request_idx
  on library.targeted_reconciliation_intents (library_id, producer_request_key);
create unique index if not exists targeted_reconciliation_intents_job_id_idx
  on library.targeted_reconciliation_intents (job_id) where job_id is not null;
create index if not exists targeted_reconciliation_intent_paths_intent_id_idx
  on library.targeted_reconciliation_intent_paths (intent_id, ordinal);
create index if not exists targeted_reconciliation_intent_moves_source_root_id_idx
  on library.targeted_reconciliation_intent_moves (source_root_id);
create index if not exists targeted_reconciliation_intent_moves_destination_root_id_idx
  on library.targeted_reconciliation_intent_moves (destination_root_id);

create unique index if not exists jobs_one_active_full_scan_per_library_idx
  on ops.jobs (library_id)
  where kind = 'full_scan'
    and state in ('queued', 'running', 'retry_wait')
    and library_id is not null;

create or replace function library.create_full_scan_intent(
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
returns table (intent_id bigint, job_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created_intent_id bigint;
  active_intent_id bigint;
  active_job_id bigint;
  accepted_request_origin_id bigint;
begin
  if p_library_id is null or p_initiating_account_id is null or
     p_capability_key <> 'library.refresh' or
     p_request_origin_ref is null or strpos(p_request_origin_ref, ':') < 2 or
     p_deployment_mode is null or p_client_surface is null or
     p_mode is null or p_force is null or p_accepted_at is null or
     coalesce(array_length(p_root_ids, 1), 0) < 1 or
     coalesce(array_length(p_root_ids, 1), 0) > 256 then
    raise exception 'full scan intent is invalid';
  end if;
  select origin.id
    into accepted_request_origin_id
    from app.request_origins as origin
   where origin.account_id = p_initiating_account_id
     and origin.client_surface_class = p_client_surface
     and origin.origin_type = split_part(p_request_origin_ref, ':', 1)
     and origin.origin_key = substring(
       p_request_origin_ref from strpos(p_request_origin_ref, ':') + 1
     )
   order by origin.id desc
   limit 1;
  if accepted_request_origin_id is null then
    raise exception 'full scan request origin is invalid';
  end if;
  if exists (
    select 1
      from unnest(p_root_ids) as requested(root_id)
      left join library.library_roots as root_record
        on root_record.id = requested.root_id
       and root_record.library_id = p_library_id
       and root_record.is_active is true
     where root_record.id is null
  ) then
    raise exception 'full scan root scope is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('album-haven:full-scan:' || p_library_id::text, 0)
  );
  select intent.id, job.id
    into active_intent_id, active_job_id
    from library.full_scan_intents as intent
    join ops.jobs as job on job.id = intent.job_id
   where intent.library_id = p_library_id
     and job.kind = 'full_scan'
     and job.state in ('queued', 'running', 'retry_wait')
   order by job.id
   limit 1;
  if active_job_id is not null then
    return query select active_intent_id, active_job_id;
    return;
  end if;

  insert into library.full_scan_intents (
    library_id, initiating_account_id, capability_key, request_origin_id,
    deployment_mode, client_surface, mode, force, accepted_at
  ) values (
    p_library_id, p_initiating_account_id, p_capability_key,
    accepted_request_origin_id, p_deployment_mode, p_client_surface,
    p_mode, p_force, p_accepted_at
  ) returning id into created_intent_id;

  insert into library.full_scan_intent_roots (intent_id, root_id, ordinal)
  select created_intent_id, requested.root_id, requested.ordinality - 1
    from unnest(p_root_ids) with ordinality as requested(root_id, ordinality);

  return query select created_intent_id, null::bigint;
end;
$$;

create or replace function library.create_targeted_reconciliation_intent(
  p_library_id bigint,
  p_primary_root_id bigint,
  p_producer_request_key varchar,
  p_request_digest varchar,
  p_deployment_mode varchar,
  p_client_surface varchar,
  p_active_paths text[],
  p_deleted_paths text[],
  p_deleted_subtrees text[],
  p_preserved_subtrees text[],
  p_moves jsonb,
  p_accepted_at timestamptz
)
returns table (intent_id bigint, job_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created_intent_id bigint;
  existing_intent_id bigint;
  existing_job_id bigint;
  existing_digest varchar(64);
begin
  if p_library_id is null or p_primary_root_id is null or p_accepted_at is null or
     p_producer_request_key is null or
     p_producer_request_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$' or
     p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$' or
     p_deployment_mode is null or p_client_surface is null or
     jsonb_typeof(coalesce(p_moves, '[]'::jsonb)) <> 'array' or
     coalesce(array_length(p_active_paths, 1), 0) > 4096 or
     coalesce(array_length(p_deleted_paths, 1), 0) > 4096 or
     coalesce(array_length(p_deleted_subtrees, 1), 0) > 4096 or
     coalesce(array_length(p_preserved_subtrees, 1), 0) > 4096 or
     jsonb_array_length(coalesce(p_moves, '[]'::jsonb)) > 4096 then
    raise exception 'targeted reconciliation intent is invalid';
  end if;
  if not exists (
    select 1 from library.library_roots
     where id = p_primary_root_id and library_id = p_library_id and is_active is true
  ) then
    raise exception 'targeted reconciliation root scope is invalid';
  end if;
  if exists (
    select 1
      from unnest(
        coalesce(p_preserved_subtrees, array[]::text[])
      ) as preserved(path)
     where preserved.path is null
        or not exists (
          select 1
            from library.library_roots as primary_root
           where primary_root.id = p_primary_root_id
             and primary_root.library_id = p_library_id
             and primary_root.is_active is true
             and (
               library.local_path_key(preserved.path)
                 = library.local_path_key(primary_root.root_path)
               or left(
                    library.local_path_key(preserved.path),
                    char_length(library.local_path_key(primary_root.root_path)) + 1
                  ) = library.local_path_key(primary_root.root_path)
                      || case library.local_path_style(primary_root.root_path)
                           when 'windows' then E'\\' else '/' end
             )
        )
  ) then
    raise exception 'targeted reconciliation preserved subtree scope is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'album-haven:targeted-reconciliation:' || p_library_id::text || ':' || p_producer_request_key,
      0
    )
  );
  select intent.id, intent.job_id, intent.request_digest
    into existing_intent_id, existing_job_id, existing_digest
    from library.targeted_reconciliation_intents as intent
   where intent.library_id = p_library_id
     and intent.producer_request_key = p_producer_request_key;
  if existing_intent_id is not null then
    if existing_digest <> p_request_digest then
      raise exception 'targeted reconciliation request key payload mismatch';
    end if;
    return query select existing_intent_id, existing_job_id;
    return;
  end if;

  insert into library.targeted_reconciliation_intents (
    library_id, primary_root_id, producer_request_key, request_digest,
    deployment_mode, client_surface, accepted_at
  ) values (
    p_library_id, p_primary_root_id, p_producer_request_key, p_request_digest,
    p_deployment_mode, p_client_surface, p_accepted_at
  ) on conflict (library_id, producer_request_key) do nothing
  returning id into created_intent_id;

  if created_intent_id is null then
    select intent.id, intent.job_id, intent.request_digest
      into existing_intent_id, existing_job_id, existing_digest
      from library.targeted_reconciliation_intents as intent
     where intent.library_id = p_library_id
       and intent.producer_request_key = p_producer_request_key;
    if existing_digest <> p_request_digest then
      raise exception 'targeted reconciliation request key payload mismatch';
    end if;
    return query select existing_intent_id, existing_job_id;
    return;
  end if;

  insert into library.targeted_reconciliation_intent_paths (
    intent_id, path_kind, path, ordinal
  )
  select created_intent_id, source.path_kind, source.path, source.ordinality - 1
    from (
      select 'active'::varchar as path_kind, path, ordinality
        from unnest(coalesce(p_active_paths, array[]::text[])) with ordinality as item(path, ordinality)
      union all
      select 'deleted'::varchar, path, ordinality
        from unnest(coalesce(p_deleted_paths, array[]::text[])) with ordinality as item(path, ordinality)
      union all
      select 'deleted_subtree'::varchar, path, ordinality
        from unnest(coalesce(p_deleted_subtrees, array[]::text[])) with ordinality as item(path, ordinality)
      union all
      select 'preserved_subtree'::varchar, path, ordinality
        from unnest(coalesce(p_preserved_subtrees, array[]::text[])) with ordinality as item(path, ordinality)
    ) as source;

  insert into library.targeted_reconciliation_intent_moves (
    intent_id, source_path, destination_path, source_root_id,
    destination_root_id, is_directory, ordinal
  )
  select created_intent_id,
         item.value ->> 'source_path',
         item.value ->> 'destination_path',
         (item.value ->> 'source_root_id')::bigint,
         (item.value ->> 'destination_root_id')::bigint,
         coalesce((item.value ->> 'is_directory')::boolean, false),
         coalesce((item.value ->> 'ordinal')::integer, item.ordinality - 1)
    from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb))
         with ordinality as item(value, ordinality)
    join library.library_roots as source_root
      on source_root.id = (item.value ->> 'source_root_id')::bigint
     and source_root.library_id = p_library_id
     and source_root.is_active is true
    join library.library_roots as destination_root
      on destination_root.id = (item.value ->> 'destination_root_id')::bigint
     and destination_root.library_id = p_library_id
     and destination_root.is_active is true;

  if (select count(*) from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb))) <>
     (select count(*)
        from library.targeted_reconciliation_intent_moves as stored_move
       where stored_move.intent_id = created_intent_id) then
    raise exception 'targeted reconciliation move scope is invalid';
  end if;

  return query select created_intent_id, null::bigint;
end;
$$;

create or replace function library.link_scan_intent_job(
  p_kind varchar,
  p_intent_id bigint,
  p_job_id bigint
)
returns table (intent_id bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_kind = 'full_scan' then
    update library.full_scan_intents as intent
       set job_id = p_job_id, updated_at = now()
     where id = p_intent_id and job_id is null
       and exists (
         select 1
           from ops.jobs as job
          where job.id = p_job_id
            and job.kind = 'full_scan'
            and job.subject_kind = 'full_scan_intent'
            and job.subject_ref = p_intent_id::text
            and job.parameters = jsonb_build_object('intent_id', p_intent_id)
            and job.library_id = intent.library_id
            and job.account_id = intent.initiating_account_id
            and job.capability_key = intent.capability_key
            and job.capability_key = 'library.refresh'
            and job.request_origin_id = intent.request_origin_id
            and job.deployment_mode = intent.deployment_mode
            and job.client_surface = intent.client_surface
       );
  elsif p_kind = 'targeted_reconciliation' then
    update library.targeted_reconciliation_intents as intent
       set job_id = p_job_id, updated_at = now()
     where id = p_intent_id and job_id is null
       and exists (
         select 1
           from ops.jobs as job
          where job.id = p_job_id
            and job.kind = 'targeted_reconciliation'
            and job.subject_kind = 'targeted_reconciliation_intent'
            and job.subject_ref = p_intent_id::text
            and job.parameters = jsonb_build_object('intent_id', p_intent_id)
            and job.library_id = intent.library_id
            and job.account_id is null
            and job.capability_key is null
            and job.request_origin_id is null
            and job.deployment_mode = intent.deployment_mode
            and job.client_surface = intent.client_surface
       );
  else
    raise exception 'scan intent kind is invalid';
  end if;
  if not found then
    raise exception 'scan intent job link failed';
  end if;
  return query select p_intent_id;
end;
$$;

create or replace function library.sync_scan_intent_job_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  mapped_state varchar(32);
begin
  if new.kind not in ('full_scan', 'targeted_reconciliation') then
    return new;
  end if;
  mapped_state := case new.state
    when 'queued' then 'accepted'
    when 'running' then 'running'
    when 'retry_wait' then 'retry_wait'
    when 'succeeded' then 'succeeded'
    when 'canceled' then 'canceled'
    else 'failed'
  end;
  if new.kind = 'full_scan' then
    update library.full_scan_intents as intent
       set state = mapped_state,
           completed_at = case
             when mapped_state in ('succeeded', 'failed', 'canceled')
               then coalesce(new.completed_at, now())
             else null
           end,
           outcome_code = new.outcome_code,
           updated_at = new.updated_at
     where intent.job_id = new.id
       and intent.state is distinct from mapped_state;
  else
    update library.targeted_reconciliation_intents as intent
       set state = mapped_state,
           completed_at = case
             when mapped_state in ('succeeded', 'failed', 'canceled')
               then coalesce(new.completed_at, now())
             else null
           end,
           outcome_code = new.outcome_code,
           updated_at = new.updated_at
     where intent.job_id = new.id
       and intent.state is distinct from mapped_state;
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_sync_scan_intent_state on ops.jobs;
create trigger jobs_sync_scan_intent_state
after update of state on ops.jobs
for each row
execute function library.sync_scan_intent_job_state();

create or replace function library.checkpoint_claimed_scan_intent(
  p_kind varchar,
  p_intent_id bigint,
  p_job_id bigint,
  p_attempt integer,
  p_worker_id varchar,
  p_lease_token varchar,
  p_expected_state varchar,
  p_progress_current bigint,
  p_progress_total bigint,
  p_inventory_revision bigint,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_kind not in ('full_scan', 'targeted_reconciliation') or
     p_intent_id is null or p_job_id is null or
     p_attempt is null or p_attempt < 1 or
     p_worker_id is null or p_lease_token is null or p_now is null or
     p_expected_state <> 'running' then
    raise exception 'scan intent checkpoint is invalid';
  end if;
  if p_kind = 'full_scan' then
    update library.full_scan_intents as intent
       set progress_current = coalesce(p_progress_current, intent.progress_current),
           progress_total = coalesce(p_progress_total, intent.progress_total),
           committed_inventory_revision = coalesce(
             p_inventory_revision, intent.committed_inventory_revision
           ),
           updated_at = p_now
      from ops.jobs as job
     where intent.id = p_intent_id
       and intent.job_id = p_job_id
       and intent.state = p_expected_state
       and p_now >= intent.updated_at
       and (
         p_progress_current is null or
         p_progress_current >= intent.progress_current
       )
       and (
         p_progress_total is null or
         p_progress_total >= intent.progress_total
       )
       and (
         p_inventory_revision is null or
         intent.committed_inventory_revision is null or
         p_inventory_revision >= intent.committed_inventory_revision
       )
       and job.id = p_job_id
       and job.kind = p_kind
       and job.subject_ref = p_intent_id::text
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now;
  else
    update library.targeted_reconciliation_intents as intent
       set updated_at = p_now
      from ops.jobs as job
     where intent.id = p_intent_id
       and intent.job_id = p_job_id
       and intent.state = p_expected_state
       and p_progress_current is null
       and p_progress_total is null
       and p_inventory_revision is null
       and job.id = p_job_id
       and job.kind = p_kind
       and job.subject_ref = p_intent_id::text
       and job.state = 'running'
       and job.attempt_count = p_attempt
       and job.lease_owner = p_worker_id
       and job.lease_token = p_lease_token
       and job.lease_expires_at > p_now;
  end if;
  return found;
end;
$$;

create or replace function library.repair_orphaned_scan_intents(
  p_now timestamptz,
  p_limit integer
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  repaired_count bigint;
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'scan orphan repair request is invalid';
  end if;
  with full_candidates as materialized (
    select 'full_scan'::varchar as kind, intent.id, intent.accepted_at
      from library.full_scan_intents as intent
     where intent.job_id is null and intent.state = 'accepted'
       and intent.accepted_at <= p_now - interval '5 minutes'
     order by intent.accepted_at, intent.id
     limit p_limit
     for update skip locked
  ), targeted_candidates as materialized (
    select 'targeted_reconciliation'::varchar as kind,
           intent.id, intent.accepted_at
      from library.targeted_reconciliation_intents as intent
     where intent.job_id is null and intent.state = 'accepted'
       and intent.accepted_at <= p_now - interval '5 minutes'
     order by intent.accepted_at, intent.id
     limit p_limit
     for update skip locked
  ), candidates as materialized (
    select kind, id, accepted_at from full_candidates
    union all
    select kind, id, accepted_at from targeted_candidates
    order by accepted_at, id
    limit p_limit
  ), repaired_full as (
    update library.full_scan_intents as intent
       set state = 'failed', completed_at = p_now,
           outcome_code = 'orphaned_before_job_link', updated_at = p_now
      from candidates
     where candidates.kind = 'full_scan' and intent.id = candidates.id
       and intent.job_id is null and intent.state = 'accepted'
     returning intent.id
  ), repaired_targeted as (
    update library.targeted_reconciliation_intents as intent
       set state = 'failed', completed_at = p_now,
           outcome_code = 'orphaned_before_job_link', updated_at = p_now
      from candidates
     where candidates.kind = 'targeted_reconciliation'
       and intent.id = candidates.id
       and intent.job_id is null and intent.state = 'accepted'
     returning intent.id
  )
  select (select count(*) from repaired_full) +
         (select count(*) from repaired_targeted)
    into repaired_count;
  return repaired_count;
end;
$$;

create or replace function library.load_claimed_targeted_reconciliation_intent(
  p_job_id bigint,
  p_worker_id varchar,
  p_lease_token varchar
)
returns table (
  intent_id bigint,
  logical_root_id text,
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
  select intent.id,
         primary_root.metadata ->> 'root_id',
         coalesce(array_agg(path.path order by path.ordinal)
           filter (where path.path_kind = 'active'), array[]::text[]),
         coalesce(array_agg(path.path order by path.ordinal)
           filter (where path.path_kind = 'deleted'), array[]::text[]),
         coalesce(array_agg(path.path order by path.ordinal)
           filter (where path.path_kind = 'deleted_subtree'), array[]::text[]),
         coalesce(array_agg(path.path order by path.ordinal)
           filter (where path.path_kind = 'preserved_subtree'), array[]::text[]),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'source_path', move.source_path,
             'destination_path', move.destination_path,
             'source_root_ref', source_root.metadata ->> 'root_id',
             'destination_root_ref', destination_root.metadata ->> 'root_id',
             'is_directory', move.is_directory
           ) order by move.ordinal)
             from library.targeted_reconciliation_intent_moves as move
             join library.library_roots as source_root on source_root.id = move.source_root_id
             join library.library_roots as destination_root on destination_root.id = move.destination_root_id
            where move.intent_id = intent.id
         ), '[]'::jsonb)
    from ops.jobs as job
    join library.targeted_reconciliation_intents as intent
      on intent.job_id = job.id
    join library.library_roots as primary_root on primary_root.id = intent.primary_root_id
    left join library.targeted_reconciliation_intent_paths as path
      on path.intent_id = intent.id
   where job.id = p_job_id
     and job.kind = 'targeted_reconciliation'
     and job.state = 'running'
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > now()
   group by intent.id, primary_root.metadata;
$$;

create or replace function library.load_claimed_full_scan_intent(
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
  logical_root_ids text[]
)
language sql
security definer
set search_path = pg_catalog
as $$
  select intent.id,
         intent.library_id,
         intent.initiating_account_id,
         intent.mode,
         intent.force,
         array_agg(root_record.metadata ->> 'root_id' order by intent_root.ordinal)
    from ops.jobs as job
    join library.full_scan_intents as intent on intent.job_id = job.id
    join library.full_scan_intent_roots as intent_root on intent_root.intent_id = intent.id
    join library.library_roots as root_record on root_record.id = intent_root.root_id
   where job.id = p_job_id
     and job.kind = 'full_scan'
     and job.state = 'running'
     and job.lease_owner = p_worker_id
     and job.lease_token = p_lease_token
     and job.lease_expires_at > now()
   group by intent.id;
$$;

revoke all on table library.full_scan_intents from public;
revoke all on table library.full_scan_intent_roots from public;
revoke all on table library.targeted_reconciliation_intents from public;
revoke all on table library.targeted_reconciliation_intent_paths from public;
revoke all on table library.targeted_reconciliation_intent_moves from public;
revoke all on sequence library.full_scan_intents_id_seq from public;
revoke all on sequence library.targeted_reconciliation_intents_id_seq from public;

revoke all on function library.create_full_scan_intent(bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean, bigint[], timestamptz) from public;
revoke all on function library.create_targeted_reconciliation_intent(bigint, bigint, varchar, varchar, varchar, varchar, text[], text[], text[], text[], jsonb, timestamptz) from public;
revoke all on function library.link_scan_intent_job(varchar, bigint, bigint) from public;
revoke all on function library.sync_scan_intent_job_state() from public;
revoke all on function library.checkpoint_claimed_scan_intent(varchar, bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, bigint, timestamptz) from public;
revoke all on function library.repair_orphaned_scan_intents(timestamptz, integer) from public;
revoke all on function library.load_claimed_full_scan_intent(bigint, varchar, varchar) from public;
revoke all on function library.load_claimed_targeted_reconciliation_intent(bigint, varchar, varchar) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table library.full_scan_intents from album_haven_app;
    revoke all on table library.full_scan_intent_roots from album_haven_app;
    revoke all on table library.targeted_reconciliation_intents from album_haven_app;
    revoke all on table library.targeted_reconciliation_intent_paths from album_haven_app;
    revoke all on table library.targeted_reconciliation_intent_moves from album_haven_app;
    revoke all on sequence library.full_scan_intents_id_seq from album_haven_app;
    revoke all on sequence library.targeted_reconciliation_intents_id_seq from album_haven_app;
    grant execute on function library.create_full_scan_intent(bigint, bigint, varchar, varchar, varchar, varchar, varchar, boolean, bigint[], timestamptz) to album_haven_app;
    grant execute on function library.create_targeted_reconciliation_intent(bigint, bigint, varchar, varchar, varchar, varchar, text[], text[], text[], text[], jsonb, timestamptz) to album_haven_app;
    grant execute on function library.link_scan_intent_job(varchar, bigint, bigint) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on table library.full_scan_intents from album_haven_worker;
    revoke all on table library.full_scan_intent_roots from album_haven_worker;
    revoke all on table library.targeted_reconciliation_intents from album_haven_worker;
    revoke all on table library.targeted_reconciliation_intent_paths from album_haven_worker;
    revoke all on table library.targeted_reconciliation_intent_moves from album_haven_worker;
    revoke all on sequence library.full_scan_intents_id_seq from album_haven_worker;
    revoke all on sequence library.targeted_reconciliation_intents_id_seq from album_haven_worker;
    grant execute on function library.load_claimed_full_scan_intent(bigint, varchar, varchar) to album_haven_worker;
    grant execute on function library.load_claimed_targeted_reconciliation_intent(bigint, varchar, varchar) to album_haven_worker;
    grant execute on function library.checkpoint_claimed_scan_intent(varchar, bigint, bigint, integer, varchar, varchar, varchar, bigint, bigint, bigint, timestamptz) to album_haven_worker;
    grant execute on function library.repair_orphaned_scan_intents(timestamptz, integer) to album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table library.full_scan_intents from album_haven_readonly;
    revoke all on table library.full_scan_intent_roots from album_haven_readonly;
    revoke all on table library.targeted_reconciliation_intents from album_haven_readonly;
    revoke all on table library.targeted_reconciliation_intent_paths from album_haven_readonly;
    revoke all on table library.targeted_reconciliation_intent_moves from album_haven_readonly;
    revoke all on sequence library.full_scan_intents_id_seq from album_haven_readonly;
    revoke all on sequence library.targeted_reconciliation_intents_id_seq from album_haven_readonly;
  end if;
end $$;
