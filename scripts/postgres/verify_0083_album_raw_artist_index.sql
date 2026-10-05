-- album_haven_0083_index_contract_v1
-- Return exactly one of: missing, ready, mismatched.
with target_index as (
  select
    index_state.*,
    table_namespace.nspname as table_schema,
    table_relation.relname as table_name,
    access_method.amname as access_method_name,
    operator_namespace.nspname as operator_schema,
    operator_class.opcname as operator_class_name
  from pg_catalog.pg_class as index_relation
  join pg_catalog.pg_namespace as index_namespace
    on index_namespace.oid = index_relation.relnamespace
  join pg_catalog.pg_index as index_state
    on index_state.indexrelid = index_relation.oid
  join pg_catalog.pg_class as table_relation
    on table_relation.oid = index_state.indrelid
  join pg_catalog.pg_namespace as table_namespace
    on table_namespace.oid = table_relation.relnamespace
  join pg_catalog.pg_am as access_method
    on access_method.oid = index_relation.relam
  left join pg_catalog.pg_opclass as operator_class
    on operator_class.oid = index_state.indclass[0]
  left join pg_catalog.pg_namespace as operator_namespace
    on operator_namespace.oid = operator_class.opcnamespace
  where index_namespace.nspname = 'library'
    and index_relation.relname = 'local_albums_normalized_raw_artists_trgm_idx'
)
select case
  when not exists (select 1 from target_index) then 'missing'
  when exists (
    select 1
    from target_index as index_state
    where index_state.table_schema = 'library'
      and index_state.table_name = 'local_albums'
      and index_state.access_method_name = 'gin'
      and not index_state.indisunique
      and not index_state.indisprimary
      and index_state.indisvalid
      and index_state.indisready
      and index_state.indnatts = 1
      and index_state.indnkeyatts = 1
      and index_state.indkey::text = '0'
      and index_state.indexprs is not null
      and index_state.indpred is null
      and index_state.operator_schema = 'library'
      and index_state.operator_class_name = 'gin_trgm_ops'
      and pg_catalog.regexp_replace(
        pg_catalog.lower(
          pg_catalog.pg_get_expr(index_state.indexprs, index_state.indrelid, true)
        ),
        '(::text)|[[:space:]]',
        '',
        'g'
      ) = 'lower(btrim(coalesce(metadata->>''artists'','''')))'
  ) then 'ready'
  else 'mismatched'
end as index_state;
