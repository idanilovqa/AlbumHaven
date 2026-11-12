-- 0118 uses this function while rebuilding duplicate album identities. Keep the
-- definition identical to 0124 so fresh and already-upgraded databases agree.
do $compatibility$
declare
  fold_function text := case when current_setting('server_version_num')::integer >= 180000
    then 'casefold' else 'lower' end;
begin
execute format($definition$
create or replace function library.fold_search_accents(value text)
returns text
language sql
immutable
parallel safe
strict
security invoker
set search_path = pg_catalog
as $function$
  select normalize(
    regexp_replace(normalize(%s(btrim(value) collate "und-x-icu"), NFD) collate "C", U&'([a-z])[\0300-\036f]+', '\1', 'g'),
    NFC
  )
$function$;
$definition$, fold_function);
end;
$compatibility$;

revoke all on function library.fold_search_accents(text) from public;

do $privileges$
begin
  if pg_catalog.to_regrole('album_haven_app') is not null then
    grant execute on function library.fold_search_accents(text) to album_haven_app;
  end if;
  if pg_catalog.to_regrole('album_haven_migrator') is not null then
    grant execute on function library.fold_search_accents(text) to album_haven_migrator;
  end if;
end
$privileges$;
