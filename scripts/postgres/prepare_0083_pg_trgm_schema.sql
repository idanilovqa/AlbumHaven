-- album_haven_0083_pg_trgm_schema_v1
-- Migration 0083 historically qualifies gin_trgm_ops in library. PostgreSQL
-- keeps existing index dependencies by OID when a relocatable extension moves.
do $migration$
declare
  trigram_schema name;
begin
  create extension if not exists pg_trgm with schema library;

  select namespace.nspname
  into trigram_schema
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pg_trgm';

  if trigram_schema is null then
    raise exception using
      errcode = '42704',
      message = 'pg_trgm must be installed before migration 0083';
  end if;

  if trigram_schema <> 'library' then
    alter extension pg_trgm set schema library;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_opclass operator_class
    join pg_catalog.pg_am access_method
      on access_method.oid = operator_class.opcmethod
    join pg_catalog.pg_namespace namespace
      on namespace.oid = operator_class.opcnamespace
    where namespace.nspname = 'library'
      and operator_class.opcname = 'gin_trgm_ops'
      and access_method.amname = 'gin'
  ) then
    raise exception using
      errcode = '42704',
      message = 'library.gin_trgm_ops is unavailable after pg_trgm preparation';
  end if;
end
$migration$;
