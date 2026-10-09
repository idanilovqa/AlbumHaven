-- album_haven_track_preferences_scope_v1
-- Read-only preflight. A partial, invalid, or differently defined index fails closed.
with expected(index_name, key_columns, key_types, nulls_not_distinct) as (
  values
    ('track_preferences_account_track_key_idx',
     array['account_id', 'track_key']::name[], array['int8', 'text']::regtype[], false),
    ('track_preferences_account_library_track_key_idx',
     array['account_id', 'library_id', 'track_key']::name[],
     array['int8', 'int8', 'text']::regtype[], true)
), contracts as (
  select expected.index_name, index_relation.oid is not null as present,
    coalesce(
      index_relation.relkind = 'i'
      and access_method.amname = 'btree'
      and index_data.indrelid = to_regclass('app.track_preferences')
      and index_data.indisunique and index_data.indimmediate
      and index_data.indisvalid and index_data.indisready and index_data.indislive
      and not index_data.indisprimary and not index_data.indisexclusion
      and index_data.indnullsnotdistinct = expected.nulls_not_distinct
      and index_data.indpred is null and index_data.indexprs is null
      and index_data.indnkeyatts = cardinality(expected.key_columns)
      and index_data.indnatts = cardinality(expected.key_columns)
      and array(
        select attribute.attname
        from unnest(index_data.indkey::smallint[]) with ordinality as key(attnum, position)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_data.indrelid and attribute.attnum = key.attnum
        order by key.position
      ) = expected.key_columns
      and array(
        select attribute.atttypid::regtype
        from unnest(index_data.indkey::smallint[]) with ordinality as key(attnum, position)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_data.indrelid and attribute.attnum = key.attnum
        order by key.position
      ) = expected.key_types
      and not exists (
        select 1
        from unnest(index_data.indkey::smallint[], index_data.indclass::oid[],
                    index_data.indcollation::oid[], index_data.indoption::smallint[])
             as key(attnum, opclass_oid, collation_oid, options)
        left join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_data.indrelid and attribute.attnum = key.attnum
        left join pg_catalog.pg_opclass opclass on opclass.oid = key.opclass_oid
        where attribute.attname is null or attribute.attisdropped
           or opclass.oid is null or not opclass.opcdefault
           or opclass.opcmethod <> access_method.oid
           or opclass.opcintype <> attribute.atttypid
           or key.collation_oid <> attribute.attcollation or key.options <> 0
      ), false
    ) as exact
  from expected
  left join pg_catalog.pg_namespace namespace on namespace.nspname = 'app'
  left join pg_catalog.pg_class index_relation
    on index_relation.relnamespace = namespace.oid and index_relation.relname = expected.index_name
  left join pg_catalog.pg_index index_data on index_data.indexrelid = index_relation.oid
  left join pg_catalog.pg_am access_method on access_method.oid = index_relation.relam
), shape as (
  select
    bool_or(present) filter (where index_name = 'track_preferences_account_track_key_idx') as old_present,
    bool_or(exact) filter (where index_name = 'track_preferences_account_track_key_idx') as old_exact,
    bool_or(present) filter (where index_name = 'track_preferences_account_library_track_key_idx') as scoped_present,
    bool_or(exact) filter (where index_name = 'track_preferences_account_library_track_key_idx') as scoped_exact
  from contracts
)
select case
  when (
    select count(*) from pg_catalog.pg_attribute attribute
    where attribute.attrelid = to_regclass('app.track_preferences')
      and not attribute.attisdropped and attribute.attgenerated = ''
      and (
        (attribute.attname = 'account_id' and attribute.atttypid = 'int8'::regtype and attribute.attnotnull)
        or (attribute.attname = 'library_id' and attribute.atttypid = 'int8'::regtype and not attribute.attnotnull)
        or (attribute.attname = 'track_key' and attribute.atttypid = 'text'::regtype and attribute.attnotnull)
      )
  ) <> 3 then 'mismatched'
  when exists (
    select 1 from pg_catalog.pg_index extra
    join pg_catalog.pg_class relation on relation.oid = extra.indexrelid
    where extra.indrelid = to_regclass('app.track_preferences')
      and extra.indisunique and not extra.indisprimary
      and relation.relname not in (
        'track_preferences_account_track_key_idx',
        'track_preferences_account_library_track_key_idx'
      )
  ) then 'mismatched'
  when old_exact and not scoped_present then 'legacy'
  when scoped_exact and not old_present then 'scoped'
  else 'mismatched'
end as scope_state
from shape;
