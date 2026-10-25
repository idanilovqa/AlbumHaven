create or replace function library.sync_scan_intent_job_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  mapped_state varchar(32);
  targeted_intent_id bigint;
  affected_library_id bigint;
  failure_health text;
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
           execution_attempt = case
             when old.state = 'running'
              and new.state = 'retry_wait'
              and new.attempt_count = old.attempt_count - 1
               then null
             else intent.execution_attempt
           end,
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
       and intent.state is distinct from mapped_state
     returning intent.id, intent.library_id
       into targeted_intent_id, affected_library_id;
    failure_health := case new.outcome_code
      when 'targeted_reconciliation_failed' then 'reconciliation_failed'
      when 'targeted_stable_write_unavailable' then 'stable_write_unavailable'
    end;
    if targeted_intent_id is not null and failure_health is not null
       and old.state = 'running' and new.state = 'failed'
       and old.lease_expires_at > new.updated_at then
      update library.libraries as library_record
         set metadata = jsonb_set(
           coalesce(library_record.metadata, '{}'::jsonb),
           '{library_watch_health}',
           coalesce(library_record.metadata -> 'library_watch_health', '{}'::jsonb)
             || coalesce((
               select jsonb_object_agg(
                 affected.root_id,
                 jsonb_build_object(
                   'state', failure_health,
                   'detected_at', new.updated_at,
                   'event_id', gen_random_uuid()::text
                 )
               )
               from (
                 select root.metadata ->> 'root_id' as root_id
                   from library.targeted_reconciliation_intents as intent
                   join library.library_roots as root on root.id = intent.primary_root_id
                  where intent.id = targeted_intent_id
                 union
                 select root.metadata ->> 'root_id'
                   from library.targeted_reconciliation_intent_moves as move
                   join library.library_roots as root
                     on root.id in (move.source_root_id, move.destination_root_id)
                  where move.intent_id = targeted_intent_id
               ) as affected
               where nullif(btrim(affected.root_id), '') is not null
                 and coalesce(nullif(
                   library_record.metadata #>> array[
                     'library_watch_health', affected.root_id, 'detected_at'
                   ], ''
                 )::timestamptz, '-infinity'::timestamptz) <= new.updated_at
             ), '{}'::jsonb),
           true
         ),
         updated_at = greatest(library_record.updated_at, new.updated_at)
       where library_record.id = affected_library_id;
    end if;
  end if;
  return new;
end;
$$;
