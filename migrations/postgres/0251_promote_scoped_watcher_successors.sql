-- depends on: 0240_create_durable_watcher_recovery.sql
-- depends on: 0246_preserve_cover_selection_metadata.sql
-- Reuse fenced watcher promotion within an already-locked completion scope.

create or replace function library.dispatch_watcher_generation_internal(
  p_generation_id bigint,
  p_now timestamptz,
  p_prelocked_root_ids bigint[],
  p_prelocked_repair_ids bigint[]
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  intent record;
  v_library_id bigint;
  v_job_id bigint;
  v_lane_count integer;
  v_participant_count integer;
  v_scheduled_at timestamptz;
begin
  select candidate.library_id into v_library_id
  from library.targeted_reconciliation_intents as candidate
  where candidate.id = p_generation_id
    and candidate.watcher_generation_kind in ('exact', 'root_catch_up')
    and candidate.watcher_job_linked_at is null
    and candidate.state = 'accepted';
  if not found then return null; end if;

  if p_prelocked_root_ids is null then
    perform 1
    from library.watcher_repairs as repair
    where repair.library_id = (
      select candidate.library_id
      from library.targeted_reconciliation_intents as candidate
      where candidate.id = p_generation_id
    )
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update;

    perform 1
    from library.watcher_lanes as lane
    join (
      select participant.library_id, participant.root_id
      from library.watcher_generation_participants as participant
      where participant.generation_id = p_generation_id
      union
      select peer.library_id, peer.root_id
      from library.watcher_barrier_participants as candidate_barrier
      join library.watcher_barrier_participants as peer
        on peer.barrier_id = candidate_barrier.barrier_id
      where candidate_barrier.generation_id = p_generation_id
    ) locked
      on locked.library_id = lane.library_id and locked.root_id = lane.root_id
    order by lane.library_id, lane.root_id
    for update of lane;

  else
    -- Completion must not expand its repair/lane lock footprint.
    if exists (
      select 1
      from (
        select participant.root_id
        from library.watcher_generation_participants as participant
        where participant.generation_id = p_generation_id
        union
        select peer.root_id
        from library.watcher_barrier_participants as candidate_barrier
        join library.watcher_barrier_participants as peer
          on peer.barrier_id = candidate_barrier.barrier_id
        where candidate_barrier.generation_id = p_generation_id
      ) as required_root
      where required_root.root_id <> all(p_prelocked_root_ids)
    ) or exists (
      select 1
      from library.watcher_repairs as repair
      where repair.library_id = v_library_id
        and repair.state in ('scanning', 'catch_up')
        and repair.id <> all(coalesce(p_prelocked_repair_ids, array[]::bigint[]))
    ) then
      return null;
    end if;
  end if;

  select candidate.id, candidate.library_id, candidate.deployment_mode,
         candidate.client_surface, candidate.watcher_generation_kind
  into intent
  from library.targeted_reconciliation_intents as candidate
  where candidate.id = p_generation_id
    and candidate.watcher_generation_kind in ('exact', 'root_catch_up')
    and candidate.watcher_job_linked_at is null
    and candidate.state = 'accepted'
  for update of candidate skip locked;
  if not found then
    return null;
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
      from library.full_scan_intents as full_scan
       join library.watcher_repairs as repair
         on repair.id = full_scan.watcher_repair_id
        and repair.state = 'scanning'
       join ops.jobs as full_scan_job
         on full_scan_job.id = full_scan.job_id
        and full_scan_job.kind = 'full_scan'
        and full_scan_job.state in ('queued', 'running', 'retry_wait')
        and (full_scan_job.state <> 'running'
           or full_scan_job.lease_expires_at > p_now)
       where full_scan.library_id = intent.library_id
         and full_scan.state in ('accepted', 'running', 'retry_wait')
     )
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
    return null;
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
  return v_job_id;
end;
$$;

revoke all on function library.dispatch_watcher_generation_internal(
  bigint,timestamptz,bigint[],bigint[]
) from public;

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
  v_job_id bigint;
  v_candidate_id bigint;
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
        from library.full_scan_intents as full_scan
        join library.watcher_repairs as repair
          on repair.id = full_scan.watcher_repair_id
         and repair.state = 'scanning'
        join ops.jobs as full_scan_job
          on full_scan_job.id = full_scan.job_id
         and full_scan_job.kind = 'full_scan'
         and full_scan_job.state in ('queued', 'running', 'retry_wait')
           and (full_scan_job.state <> 'running'
             or full_scan_job.lease_expires_at > p_now)
        where full_scan.library_id = candidate.library_id
          and full_scan.state in ('accepted', 'running', 'retry_wait')
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
    v_job_id := library.dispatch_watcher_generation_internal(
      v_candidate_id, p_now, null::bigint[], null::bigint[]
    );
    if v_job_id is null then continue; end if;
    generation_id := v_candidate_id;
    job_id := v_job_id;
    return next;
    v_dispatched := v_dispatched + 1;
    exit when v_dispatched >= p_limit;
  end loop;
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
  v_prelocked_repair_ids bigint[];
  v_prelocked_root_ids bigint[];
  v_successor_id bigint;
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
  select coalesce(pg_catalog.array_agg(locked.id order by locked.id), array[]::bigint[])
  into v_prelocked_repair_ids
  from (
    select repair.id
    from library.watcher_repairs as repair
    where repair.library_id = v_library_id
      and repair.state in ('scanning', 'catch_up')
    order by repair.id
    for update
  ) as locked;

  select coalesce(pg_catalog.array_agg(link.repair_id order by link.repair_id),
                  array[]::bigint[])
  into v_repair_ids
  from library.watcher_generation_repairs as link
  where link.generation_id = p_generation_id;

  select coalesce(pg_catalog.array_agg(locked.root_id order by locked.root_id), array[]::bigint[])
  into v_prelocked_root_ids
  from (
    select lane.root_id
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
    for update of lane
  ) as locked;
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
  for v_successor_id in
    select candidate.id
    from library.targeted_reconciliation_intents as candidate
    where candidate.id in (
      select lane.successor_generation_id
      from library.watcher_lanes as lane
      where lane.library_id = v_library_id
        and lane.root_id = any(v_prelocked_root_ids)
        and lane.successor_generation_id is not null
    )
    order by candidate.accepted_at, candidate.id
  loop
    perform library.dispatch_watcher_generation_internal(
      v_successor_id, p_now, v_prelocked_root_ids, v_prelocked_repair_ids
    );
  end loop;
  return true;
end;
$$;

do $watcher_promotion_privileges$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on function library.dispatch_watcher_generation_internal(
      bigint, timestamptz, bigint[], bigint[]
    ) from album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    revoke all on function library.dispatch_watcher_generation_internal(
      bigint, timestamptz, bigint[], bigint[]
    ) from album_haven_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on function library.dispatch_watcher_generation_internal(
      bigint, timestamptz, bigint[], bigint[]
    ) from album_haven_readonly;
  end if;
end;
$watcher_promotion_privileges$;
