do $migration$
declare
  function_definition text;
  previous_clause constant text := $fragment$    'ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text[],text,text,text,boolean,text,text)',
$fragment$;
  current_clause constant text := $fragment$    'ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text[],text,text,text,boolean,boolean,integer,integer,text,text)',
    'ops.persist_claimed_cover_provider_outcome(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text,text,text,jsonb,text,jsonb)',
$fragment$;
begin
  select pg_catalog.pg_get_functiondef(
    'ops.validate_durable_worker_startup_baseline_0105(text[])'::regprocedure
  )
  into function_definition;
  function_definition := pg_catalog.replace(function_definition, E'\r\n', E'\n');

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
