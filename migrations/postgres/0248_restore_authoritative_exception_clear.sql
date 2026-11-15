-- depends on: 0243_close_cover_consistency.sql
-- Preserve explicit app-owned exception clears when scan-cache metadata lags.
do $migration$
declare
  function_definition text;
  original_clause text := $fragment$
        (nullif(btrim(files.metadata #>> '{scan_cache,file_entry,album}'), '') is not null
         and nullif(btrim(files.metadata #>> '{scan_cache,file_entry,exception_type}'), '') is null)
$fragment$;
  replacement_clause text := $fragment$
      ((nullif(btrim(files.metadata #>> '{scan_cache,file_entry,album}'), '') is not null
        and nullif(btrim(files.metadata #>> '{scan_cache,file_entry,exception_type}'), '') is null)
       and not (
         incoming.file_entry ? 'exception_type'
         and nullif(btrim(incoming.file_entry ->> 'exception_type'), '') is null
         and (
           select coalesce(
             nullif(btrim(authoritative_override.override_payload ->> 'exception_type'), ''),
             case
               when jsonb_typeof(authoritative_override.override_payload) = 'string'
               then nullif(btrim(authoritative_override.override_payload #>> '{}'), '')
               else null
             end
           )
           from library.exception_overrides as authoritative_override
           where authoritative_override.library_id = requested_library_id
             and (
               authoritative_override.track_key = files.private_path
               or authoritative_override.track_id = tracks.id
             )
           order by case
             when authoritative_override.track_key = files.private_path then 0
             when authoritative_override.track_id = tracks.id then 1
             else 2
           end,
           authoritative_override.updated_at desc,
           authoritative_override.id desc
           limit 1
         ) is not null
       ))
$fragment$;
begin
  select pg_catalog.pg_get_functiondef(
    'library.restore_detached_album_noncover(bigint,text[],bigint,jsonb,jsonb,timestamp with time zone)'::regprocedure
  ) into function_definition;

  function_definition := pg_catalog.replace(function_definition, E'\r\n', E'\n');
  original_clause := pg_catalog.replace(original_clause, E'\r\n', E'\n');
  replacement_clause := pg_catalog.replace(replacement_clause, E'\r\n', E'\n');

  if pg_catalog.strpos(function_definition, replacement_clause) > 0 then
    return;
  end if;
  if pg_catalog.strpos(function_definition, original_clause) = 0 then
    raise exception '0127 detached album eligibility source changed';
  end if;

  execute pg_catalog.replace(
    function_definition,
    original_clause,
    replacement_clause
  );
end;
$migration$;
