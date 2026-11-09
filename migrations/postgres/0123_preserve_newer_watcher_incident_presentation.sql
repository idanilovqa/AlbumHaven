do $migration$
declare
  function_definition text;
  original_clause constant text := $fragment$
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
$fragment$;
  monotonic_clause constant text := $fragment$
    reason_code = case
      when excluded.last_seen_at >= library.watcher_incidents.last_seen_at
        then excluded.reason_code
      else library.watcher_incidents.reason_code
    end,
    occurrence_count = library.watcher_incidents.occurrence_count + 1,
    accepted_sequence = greatest(
      library.watcher_incidents.accepted_sequence,
      excluded.accepted_sequence
    ),
    dirty_generation = greatest(
      library.watcher_incidents.dirty_generation,
      excluded.dirty_generation
    ),
    last_seen_at = greatest(
      library.watcher_incidents.last_seen_at,
      excluded.last_seen_at
    )
$fragment$;
begin
  select pg_catalog.pg_get_functiondef(
           'library.mark_watcher_roots_dirty(bigint,text[],character varying,timestamp with time zone)'::regprocedure
         )
    into function_definition;
  function_definition := pg_catalog.replace(function_definition, E'\r\n', E'\n');
  if pg_catalog.strpos(function_definition, monotonic_clause) > 0 then
    return;
  end if;
  if pg_catalog.strpos(function_definition, original_clause) = 0 then
    raise exception '0123 watcher incident presentation source changed';
  end if;
  execute pg_catalog.replace(
    function_definition,
    original_clause,
    monotonic_clause
  );
end;
$migration$;
