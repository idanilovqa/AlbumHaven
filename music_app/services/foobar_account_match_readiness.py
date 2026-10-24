"""Partial structural prerequisite check for explicit account match decisions.

Source: documentation-only account-owned-associations-v2.sql.txt contract r2.
This does not execute that specification or require its legacy transfer map.
No grants, migrations, RLS policy or schema objects are created here.

Check both runtime tables, all 20 column shapes, five account-scoped keys,
four exact foreign keys, native local-track uniqueness, both lookup indexes,
simple numeric/actor/action/time checks, timestamp default and effective privileges.
Only optional current availability may cascade with a local track. Historical
decisions must retain account ownership and append/read-only effective grants.

This is not complete schema/security certification or activation approval:
expected-pair/track-action CHECK semantics, extra triggers/rules, role
hardening and current per-library policy remain separate owners. The real
repository must validate commands, lock authority and compare expected state.
A server-owned approved deployment gate is still required. No library access
is granted by this catalog result and no user rows are read here.
Catalog deparser differences fail closed; no equivalent-expression guessing.
Concurrent DDL/privilege changes can invalidate this snapshot. Actual operations
remain responsible for transaction-time failure and rollback. No result cache.
"""
from .postgres_connections import pooled_connection
from .foobar_account_source_postgres import SourceUnavailable

_SCHEMA_SQL = r"""
WITH expected_tables(name) AS (VALUES
 ('foobar_import_local_matches_v2'),('foobar_import_match_decisions_v2')
),
rels AS MATERIALIZED (
 SELECT c.oid,c.relname,c.relkind,c.relpersistence
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN expected_tables e ON e.name=c.relname WHERE n.nspname='integration'
),
expected_columns(tab,col,typ,required) AS (VALUES
 ('foobar_import_local_matches_v2','account_id','int8',true),
 ('foobar_import_local_matches_v2','library_id','int8',true),
 ('foobar_import_local_matches_v2','match_version','int8',true),
 ('foobar_import_local_matches_v2','source_ref','uuid',true),
 ('foobar_import_local_matches_v2','observation_ref','uuid',true),
 ('foobar_import_local_matches_v2','decision_ref','uuid',true),
 ('foobar_import_local_matches_v2','track_key','text',true),
 ('foobar_import_match_decisions_v2','account_id','int8',true),
 ('foobar_import_match_decisions_v2','match_version','int8',true),
 ('foobar_import_match_decisions_v2','original_library_id','int8',true),
 ('foobar_import_match_decisions_v2','actor_account_id','int8',true),
 ('foobar_import_match_decisions_v2','expected_match_version','int8',false),
 ('foobar_import_match_decisions_v2','original_track_id','int8',false),
 ('foobar_import_match_decisions_v2','source_ref','uuid',true),
 ('foobar_import_match_decisions_v2','observation_ref','uuid',true),
 ('foobar_import_match_decisions_v2','decision_ref','uuid',true),
 ('foobar_import_match_decisions_v2','operation_ref','uuid',true),
 ('foobar_import_match_decisions_v2','expected_decision_ref','uuid',false),
 ('foobar_import_match_decisions_v2','action','text',true),
 ('foobar_import_match_decisions_v2','created_at','timestamptz',true)
),
expected_keys(tab,kind,cols) AS (VALUES
 ('foobar_import_local_matches_v2','p','account_id,source_ref,observation_ref,library_id'),
 ('foobar_import_match_decisions_v2','p','account_id,source_ref,observation_ref,decision_ref'),
 ('foobar_import_match_decisions_v2','u','account_id,source_ref,observation_ref,original_library_id,match_version'),
 ('foobar_import_match_decisions_v2','u','account_id,source_ref,operation_ref'),
 ('foobar_import_match_decisions_v2','u','account_id,source_ref,observation_ref,decision_ref,original_library_id,match_version')
),
expected_fks(tab,cols,target_schema,target_tab,target_cols,update_action,delete_action) AS (VALUES
 ('foobar_import_local_matches_v2','account_id,source_ref,observation_ref','integration','foobar_import_observations_v2','account_id,source_ref,observation_ref','a','r'),
 ('foobar_import_match_decisions_v2','account_id,source_ref,observation_ref','integration','foobar_import_observations_v2','account_id,source_ref,observation_ref','a','r'),
 ('foobar_import_local_matches_v2','library_id,track_key','library','local_tracks','library_id,track_key','c','c'),
 ('foobar_import_local_matches_v2','account_id,source_ref,observation_ref,decision_ref,library_id,match_version','integration','foobar_import_match_decisions_v2','account_id,source_ref,observation_ref,decision_ref,original_library_id,match_version','a','r')
),
expected_checks(tab,expression) AS (VALUES
 ('foobar_import_local_matches_v2','match_version>0'),
 ('foobar_import_match_decisions_v2','match_version>0'),
 ('foobar_import_match_decisions_v2','original_library_id>0'),
 ('foobar_import_match_decisions_v2','actor_account_id=account_id'),
 ('foobar_import_match_decisions_v2','isfinitecreated_at'),
 ('foobar_import_match_decisions_v2','action=anyarray[''match''::text,''rematch''::text,''detach''::text]')
),
expected_privileges(tab,col,operation) AS (VALUES
 ('foobar_import_local_matches_v2','account_id','SELECT'),
 ('foobar_import_local_matches_v2','account_id','INSERT'),
 ('foobar_import_local_matches_v2','library_id','SELECT'),
 ('foobar_import_local_matches_v2','library_id','INSERT'),
 ('foobar_import_local_matches_v2','match_version','SELECT'),
 ('foobar_import_local_matches_v2','match_version','INSERT'),
 ('foobar_import_local_matches_v2','source_ref','SELECT'),
 ('foobar_import_local_matches_v2','source_ref','INSERT'),
 ('foobar_import_local_matches_v2','observation_ref','SELECT'),
 ('foobar_import_local_matches_v2','observation_ref','INSERT'),
 ('foobar_import_local_matches_v2','decision_ref','SELECT'),
 ('foobar_import_local_matches_v2','decision_ref','INSERT'),
 ('foobar_import_local_matches_v2','track_key','SELECT'),
 ('foobar_import_local_matches_v2','track_key','INSERT'),
 ('foobar_import_match_decisions_v2','account_id','SELECT'),
 ('foobar_import_match_decisions_v2','account_id','INSERT'),
 ('foobar_import_match_decisions_v2','match_version','SELECT'),
 ('foobar_import_match_decisions_v2','match_version','INSERT'),
 ('foobar_import_match_decisions_v2','original_library_id','SELECT'),
 ('foobar_import_match_decisions_v2','original_library_id','INSERT'),
 ('foobar_import_match_decisions_v2','actor_account_id','SELECT'),
 ('foobar_import_match_decisions_v2','actor_account_id','INSERT'),
 ('foobar_import_match_decisions_v2','expected_match_version','SELECT'),
 ('foobar_import_match_decisions_v2','expected_match_version','INSERT'),
 ('foobar_import_match_decisions_v2','original_track_id','SELECT'),
 ('foobar_import_match_decisions_v2','original_track_id','INSERT'),
 ('foobar_import_match_decisions_v2','source_ref','SELECT'),
 ('foobar_import_match_decisions_v2','source_ref','INSERT'),
 ('foobar_import_match_decisions_v2','observation_ref','SELECT'),
 ('foobar_import_match_decisions_v2','observation_ref','INSERT'),
 ('foobar_import_match_decisions_v2','decision_ref','SELECT'),
 ('foobar_import_match_decisions_v2','decision_ref','INSERT'),
 ('foobar_import_match_decisions_v2','operation_ref','SELECT'),
 ('foobar_import_match_decisions_v2','operation_ref','INSERT'),
 ('foobar_import_match_decisions_v2','expected_decision_ref','SELECT'),
 ('foobar_import_match_decisions_v2','expected_decision_ref','INSERT'),
 ('foobar_import_match_decisions_v2','action','SELECT'),
 ('foobar_import_match_decisions_v2','action','INSERT'),
 ('foobar_import_match_decisions_v2','created_at','SELECT'),
 ('foobar_import_local_matches_v2','track_key','UPDATE'),
 ('foobar_import_local_matches_v2','match_version','UPDATE'),
 ('foobar_import_local_matches_v2','decision_ref','UPDATE')
),
constraints AS MATERIALIZED (
 SELECT c.*,
   ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num
         ORDER BY k.ord) AS column_names,
   ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num
         ORDER BY k.ord) AS target_column_names
 FROM pg_catalog.pg_constraint c JOIN rels r ON r.oid=c.conrelid
)
SELECT (
 (SELECT count(*) FROM rels WHERE relkind='r' AND relpersistence='p')=2
 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h JOIN rels r
                 ON r.oid=h.inhrelid OR r.oid=h.inhparent)
 AND current_setting('session_replication_role')='origin'
 AND pg_catalog.has_schema_privilege('integration','USAGE')
 AND pg_catalog.has_schema_privilege('library','USAGE')
 AND NOT EXISTS (
   SELECT 1 FROM expected_columns e WHERE NOT EXISTS (
     SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
     JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
     JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
     WHERE r.relname=e.tab AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
       AND n.nspname='pg_catalog' AND t.typname=e.typ AND a.atttypmod=-1
       AND a.attnotnull=e.required AND a.attidentity='' AND a.attgenerated=''
   )
 )
 AND NOT EXISTS (
   SELECT 1 FROM expected_keys e WHERE NOT EXISTS (
     SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
     JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
     WHERE r.relname=e.tab AND c.contype=e.kind::"char"
       AND c.column_names=string_to_array(e.cols,',')
       AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
       AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
       AND i.indimmediate AND i.indexprs IS NULL AND i.indpred IS NULL
   )
 )
 -- Exact FK set prevents introducing live-library ownership into history.
 AND (SELECT count(*) FROM constraints WHERE contype='f')=4
 AND NOT EXISTS (
   SELECT 1 FROM expected_fks e WHERE NOT EXISTS (
     SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
     JOIN pg_catalog.pg_class target ON target.oid=c.confrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=target.relnamespace
     WHERE r.relname=e.tab AND c.contype='f' AND c.convalidated
       AND c.column_names=string_to_array(e.cols,',')
       AND n.nspname=e.target_schema AND target.relname=e.target_tab
       AND c.target_column_names=string_to_array(e.target_cols,',')
       AND c.confdeltype=e.delete_action::"char" AND c.confupdtype=e.update_action::"char"
       AND c.confmatchtype='s' AND NOT c.condeferrable AND NOT c.condeferred
   )
 )
 AND NOT EXISTS (
   SELECT 1 FROM constraints c JOIN pg_catalog.pg_trigger t ON t.tgconstraint=c.oid
   WHERE c.contype='f' AND t.tgenabled NOT IN ('O','A')
 )
 AND EXISTS (
   SELECT 1 FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
   JOIN pg_catalog.pg_index i ON i.indrelid=r.oid
   JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid
   JOIN pg_catalog.pg_am am ON am.oid=ix.relam
   WHERE n.nspname='library' AND r.relname='local_tracks' AND r.relkind='r'
     AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
     AND am.amname='btree' AND i.indnkeyatts=2
     AND i.indexprs IS NULL AND i.indpred IS NULL
     AND ARRAY(
       SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num
       WHERE k.ord<=i.indnkeyatts ORDER BY k.ord
     )=ARRAY['library_id','track_key']::text[]
 )
 AND NOT EXISTS (
   SELECT 1 FROM (VALUES
     ('foobar_import_local_matches_target_v2','account_id,library_id,track_key'),
     ('foobar_import_local_matches_library_target_v2','library_id,track_key')
   ) e(name,cols) WHERE NOT EXISTS (
     SELECT 1 FROM rels r JOIN pg_catalog.pg_index i ON i.indrelid=r.oid
     JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid
     JOIN pg_catalog.pg_am am ON am.oid=ix.relam
     WHERE r.relname='foobar_import_local_matches_v2' AND ix.relname=e.name
       AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
       AND am.amname='btree' AND i.indexprs IS NULL AND i.indpred IS NULL
       AND i.indnatts=i.indnkeyatts
       AND ARRAY(
         SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num
         ORDER BY k.ord
       )=string_to_array(e.cols,',')
   )
 )
 AND NOT EXISTS (
   SELECT 1 FROM expected_checks e WHERE NOT EXISTS (
     SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
     WHERE r.relname=e.tab AND c.contype='c' AND c.convalidated
       AND lower(regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),
                                '[[:space:]()]','','g'))=e.expression
   )
 )
 AND EXISTS (
   SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
   JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
   WHERE r.relname='foobar_import_match_decisions_v2' AND a.attname='created_at'
     AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='clock_timestamp()'
 )
 AND NOT EXISTS (
   SELECT 1 FROM expected_privileges e WHERE NOT EXISTS (
     SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
     WHERE r.relname=e.tab AND a.attname=e.col AND NOT a.attisdropped
       AND pg_catalog.has_column_privilege(r.oid,a.attnum,e.operation)
   )
 )
 AND EXISTS (
   SELECT 1 FROM rels r WHERE r.relname='foobar_import_local_matches_v2'
     AND pg_catalog.has_table_privilege(r.oid,'DELETE')
 )
 -- History is append/read only: inherited and column grants count as effective.
 AND EXISTS (
   SELECT 1 FROM rels r WHERE r.relname='foobar_import_match_decisions_v2'
     AND NOT pg_catalog.has_any_column_privilege(r.oid,'UPDATE')
     AND NOT pg_catalog.has_table_privilege(r.oid,'DELETE,TRUNCATE')
 )
) AS structural_ready
"""


def require_foobar_match_schema_on_connection(connection):
    """Check catalog prerequisites inside an existing guarded transaction.

    No pool checkout, transaction settings, commit or rollback. Import callers
    invoke this only after committed receipt replay has returned, so durable
    account replay never depends on a current local association projection.
    This remains structural evidence only, not deployment authorization.
    """
    try:
        cursor = connection.execute(_SCHEMA_SQL)
        try:
            rows = cursor.fetchmany(2)
        finally:
            cursor.close()
        if (type(rows) is not list or len(rows) != 1
                or type(rows[0]) is not dict
                or set(rows[0]) != {'structural_ready'}
                or rows[0]['structural_ready'] is not True):
            raise SourceUnavailable()
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None


def require_foobar_match_schema(database_url):
    """Return None or fail closed; never accept a caller-supplied ready flag."""
    try:
        with pooled_connection(database_url,timeout=1.0) as connection:
            for setting in (
                    'set transaction read only',
                    "set local lock_timeout = '250ms'",
                    "set local statement_timeout = '1000ms'",
                    'set local search_path = pg_catalog'):
                connection.execute(setting).close()
            require_foobar_match_schema_on_connection(connection)
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
