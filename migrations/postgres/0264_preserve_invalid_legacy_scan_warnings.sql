-- depends on: 0243_close_cover_consistency.sql
-- Keep legacy warnings unless a finite timestamp proves the scan covered them.
do $migration$
declare
  function_definition text;
  original_clause text := $fragment$            where not (
              health_entry.key = any(p_observed_root_ids)
              and nullif(health_entry.value ->> 'detected_at', '') is not null
              and (health_entry.value ->> 'detected_at')::timestamptz <= recovery_cutoff
            )
$fragment$;
  replacement_clause text := $fragment$            where not coalesce(
              health_entry.key = any(p_observed_root_ids)
              and case
                when pg_catalog.jsonb_typeof(health_entry.value -> 'detected_at') = 'string'
                  and pg_catalog.pg_input_is_valid(
                    nullif(health_entry.value ->> 'detected_at', ''),
                    'timestamp with time zone'
                  )
                then pg_catalog.isfinite(
                       (health_entry.value ->> 'detected_at')::timestamptz
                     )
                     and (health_entry.value ->> 'detected_at')::timestamptz
                       <= recovery_cutoff
                else false
              end,
              false
            )
$fragment$;
begin
  select pg_catalog.pg_get_functiondef(
    'library.publish_claimed_full_scan_inventory_0106(bigint,bigint,integer,character varying,character varying,bigint,jsonb,text[],timestamp with time zone)'::regprocedure
  ) into function_definition;

  function_definition := pg_catalog.replace(function_definition, E'\r\n', E'\n');
  original_clause := pg_catalog.replace(original_clause, E'\r\n', E'\n');
  replacement_clause := pg_catalog.replace(replacement_clause, E'\r\n', E'\n');

  if pg_catalog.strpos(function_definition, replacement_clause) > 0 then
    return;
  end if;
  if pg_catalog.strpos(function_definition, original_clause) = 0 then
    raise exception '0243 full scan legacy warning source changed';
  end if;

  execute pg_catalog.replace(
    function_definition,
    original_clause,
    replacement_clause
  );
end;
$migration$;
