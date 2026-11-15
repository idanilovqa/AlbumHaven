-- depends on: 0231_grant_worker_cover_refresh.sql
-- depends on: 0240_create_durable_watcher_recovery.sql
do $migration$
declare
  function_definition text;
  previous_clause text := $fragment$    'ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text[],text,text,text,boolean,text,text)',
$fragment$;
  current_clause text := $fragment$    'ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text[],text,text,text,boolean,boolean,integer,integer,text,text)',
    'ops.persist_claimed_cover_provider_outcome(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text,text,text,jsonb,text,jsonb)',
$fragment$;
begin
  select pg_catalog.pg_get_functiondef(
    'ops.validate_durable_worker_startup_baseline_0105(text[])'::regprocedure
  )
  into function_definition;
  function_definition := pg_catalog.replace(function_definition, E'\r\n', E'\n');
  previous_clause := pg_catalog.replace(previous_clause, E'\r\n', E'\n');
  current_clause := pg_catalog.replace(current_clause, E'\r\n', E'\n');

  if pg_catalog.strpos(function_definition, current_clause) > 0 then
    return;
  end if;
  if pg_catalog.strpos(function_definition, previous_clause) = 0 then
    raise exception '0124 worker preflight source changed';
  end if;

  execute pg_catalog.replace(
    function_definition,
    previous_clause,
    current_clause
  );
end;
$migration$;
