"""Fail-closed structural history prerequisites; no DDL or backfill execution.

Checks include the VALIDATED deferred reverse current-projection FK, both forward
source lifecycle links, exact six seek indexes and persistent key/column shapes.
They do not attest codec/backfill semantics, query plans, RLS or role hardening.
Those remain independent activation gates. No successful result is cached.
"""
from .foobar_source_postgres import SourceUnavailable
from .postgres_connections import pooled_connection
from .foobar_enhanced_entry_readiness import require_enhanced_entries_on_connection

HISTORY_SCHEMA_PHASE_BYTES = 65536
_MAX_SCHEMA_SQL_BYTES = 24576

_SCHEMA_SQL = r"""
WITH expected_tables(name) AS (VALUES
 ('foobar_import_streams_v2'),('foobar_import_observations_v2'),
 ('foobar_import_revisions_v2'),('foobar_import_history_projection_v1')
), rels AS MATERIALIZED (
 SELECT c.oid,c.relname FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN expected_tables e ON e.name=c.relname
 WHERE n.nspname='integration' AND c.relkind='r' AND c.relpersistence='p'
), columns(name,typ,required,generated) AS (VALUES
 ('account_id','int8',true,''),('source_ref','uuid',true,''),
 ('observation_ref','uuid',true,''),('source_revision','int8',true,''),
 ('effective_evidence_sha256','bytea',true,''),('display_sha256','bytea',true,''),
 ('projection_bytes','bytea',true,''),('projection_sha256','bytea',false,'sha256(projection_bytes)'),
 ('standard_first','int8',false,''),('standard_last','int8',true,''),
 ('enhanced_first','int8',false,''),('enhanced_last','int8',true,''),
 ('standard_last_present','bool',true,''),('enhanced_last_present','bool',true,''),
 ('evidence_kind','text',true,''),('local_entry_count','int4',false,''),
 ('local_vector_sha256','bytea',false,'')
), keys(tab,kind,cols) AS (VALUES
 ('foobar_import_streams_v2','p','account_id,source_ref'),
 ('foobar_import_observations_v2','p','account_id,source_ref,observation_ref'),
 ('foobar_import_revisions_v2','p','account_id,source_ref,observation_ref,source_revision'),
 ('foobar_import_history_projection_v1','p','account_id,source_ref,observation_ref'),
 ('foobar_import_history_projection_v1','u','account_id,source_ref,observation_ref,source_revision')
), fks(tab,cols,target_tab,target_cols,delete_action,deferred) AS (VALUES
 ('foobar_import_observations_v2','account_id,source_ref','foobar_import_streams_v2','account_id,source_ref','c',false),
 ('foobar_import_revisions_v2','account_id,source_ref,observation_ref','foobar_import_observations_v2','account_id,source_ref,observation_ref','c',true),
 ('foobar_import_observations_v2','account_id,source_ref,observation_ref,current_revision','foobar_import_revisions_v2','account_id,source_ref,observation_ref,source_revision','a',true),
 ('foobar_import_history_projection_v1','account_id,source_ref,observation_ref,source_revision','foobar_import_revisions_v2','account_id,source_ref,observation_ref,source_revision','c',true),
 ('foobar_import_observations_v2','account_id,source_ref,observation_ref,current_revision','foobar_import_history_projection_v1','account_id,source_ref,observation_ref,source_revision','a',true)
), constraints AS MATERIALIZED (
 SELECT c.*,
 ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY ord) cols,
 ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY ord) target_cols
 FROM pg_catalog.pg_constraint c JOIN rels r ON r.oid=c.conrelid
), indexes(name,key_column,predicate) AS (VALUES
 ('foobar_history_standard_first_v2','standard_first','((evidence_kind = ''tsv_snapshot''::text) AND (standard_first IS NOT NULL))'),
 ('foobar_history_standard_last_v2','standard_last','(evidence_kind = ''tsv_snapshot''::text)'),
 ('foobar_history_standard_individual_last_v2','standard_last','((evidence_kind = ''tsv_snapshot''::text) AND standard_last_present)'),
 ('foobar_history_enhanced_first_v2','enhanced_first','((evidence_kind = ''tsv_snapshot''::text) AND (enhanced_first IS NOT NULL))'),
 ('foobar_history_enhanced_last_v2','enhanced_last','(evidence_kind = ''tsv_snapshot''::text)'),
 ('foobar_history_enhanced_individual_last_v2','enhanced_last','((evidence_kind = ''tsv_snapshot''::text) AND enhanced_last_present)')
), checks(tab,expression) AS (VALUES
 ('foobar_import_history_projection_v1','source_revision>0'),
 ('foobar_import_history_projection_v1','octet_lengtheffective_evidence_sha256=32'),
 ('foobar_import_history_projection_v1','octet_lengthdisplay_sha256=32'),
 ('foobar_import_history_projection_v1','octet_lengthprojection_bytes>=1andoctet_lengthprojection_bytes<=8192'),
 ('foobar_import_streams_v2','source_bytes>=0andsource_bytes<=268435456'),
 ('foobar_import_observations_v2','(identity_kind = ANY (ARRAY[''path''::text, ''occurrence''::text, ''store_key''::text]))')
), source_columns(tab,col,typ,required,generated) AS (VALUES
 ('foobar_import_streams_v2','account_id','int8',true,''),('foobar_import_streams_v2','source_ref','uuid',true,''),
 ('foobar_import_streams_v2','source_bytes','int8',true,''),
 ('foobar_import_streams_v2','revision','int8',true,''),('foobar_import_streams_v2','created_at','timestamptz',true,''),
 ('foobar_import_streams_v2','is_default','bool',true,''),('foobar_import_streams_v2','observation_count','int8',true,''),
 ('foobar_import_observations_v2','account_id','int8',true,''),('foobar_import_observations_v2','source_ref','uuid',true,''),
 ('foobar_import_observations_v2','observation_ref','uuid',true,''),('foobar_import_observations_v2','current_revision','int8',true,''),
 ('foobar_import_observations_v2','identity_kind','text',true,''),
 ('foobar_import_revisions_v2','account_id','int8',true,''),('foobar_import_revisions_v2','source_ref','uuid',true,''),
 ('foobar_import_revisions_v2','observation_ref','uuid',true,''),('foobar_import_revisions_v2','source_revision','int8',true,''),
 ('foobar_import_revisions_v2','evidence_sha256','bytea',false,'sha256(evidence_bytes)'),('foobar_import_revisions_v2','display_sha256','bytea',false,'sha256(display_bytes)')
)
SELECT (
 (SELECT count(*) FROM rels)=4
 AND current_setting('session_replication_role')='origin'
 AND pg_catalog.has_schema_privilege('integration','USAGE')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits h JOIN rels r
                ON r.oid=h.inhrelid OR r.oid=h.inhparent)
 AND (SELECT count(*) FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
      WHERE r.relname='foobar_import_history_projection_v1' AND a.attnum>0 AND NOT a.attisdropped)=17
 AND NOT EXISTS(SELECT 1 FROM columns e WHERE NOT EXISTS(
  SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
  JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace ns ON ns.oid=t.typnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
  WHERE r.relname='foobar_import_history_projection_v1' AND a.attname=e.name
    AND NOT a.attisdropped AND a.attnum>0 AND ns.nspname='pg_catalog' AND t.typname=e.typ
    AND a.atttypmod=-1 AND a.attnotnull=e.required AND a.attidentity=''
    AND a.attgenerated::text=CASE WHEN e.generated='' THEN '' ELSE 's' END
    AND (e.generated='' OR pg_catalog.pg_get_expr(d.adbin,d.adrelid)=e.generated)
    AND pg_catalog.has_column_privilege(r.oid,a.attnum,'SELECT')))
 AND NOT EXISTS(SELECT 1 FROM source_columns e WHERE NOT EXISTS(
  SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
  JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace ns ON ns.oid=t.typnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
  WHERE r.relname=e.tab AND a.attname=e.col AND NOT a.attisdropped AND a.attnum>0
    AND ns.nspname='pg_catalog' AND t.typname=e.typ AND a.atttypmod=-1
    AND a.attnotnull=e.required AND a.attidentity=''
    AND a.attgenerated::text=CASE WHEN e.generated='' THEN '' ELSE 's' END
    AND (e.generated='' OR pg_catalog.pg_get_expr(d.adbin,d.adrelid)=e.generated)
    AND pg_catalog.has_column_privilege(r.oid,a.attnum,'SELECT')))
 AND NOT EXISTS(SELECT 1 FROM keys e WHERE NOT EXISTS(
  SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
  JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
  JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ix.relam
  WHERE r.relname=e.tab AND c.contype=e.kind::"char" AND c.convalidated
    AND c.cols=string_to_array(e.cols,',') AND NOT c.condeferrable AND NOT c.condeferred
    AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND i.indisprimary=(c.contype='p') AND am.amname='btree'
    AND i.indexprs IS NULL AND i.indpred IS NULL
    AND i.indnkeyatts=cardinality(c.cols) AND i.indnatts=i.indnkeyatts
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
              JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num ORDER BY ord)=c.cols
    AND ARRAY(SELECT v FROM unnest(i.indoption) WITH ORDINALITY k(v,ord) ORDER BY ord)
        =array_fill(0::smallint,ARRAY[cardinality(c.cols)])
    AND ARRAY(SELECT v FROM unnest(i.indcollation) WITH ORDINALITY k(v,ord) ORDER BY ord)
        =array_fill(0::oid,ARRAY[cardinality(c.cols)])
    AND ARRAY(SELECT op.opcname::text FROM unnest(i.indclass) WITH ORDINALITY k(num,ord)
              JOIN pg_catalog.pg_opclass op ON op.oid=k.num JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace
              WHERE ns.nspname='pg_catalog' AND op.opcmethod=am.oid AND op.opcdefault ORDER BY ord)
        =ARRAY(SELECT CASE WHEN name IN ('account_id','source_revision') THEN 'int8_ops' ELSE 'uuid_ops' END
               FROM unnest(c.cols) WITH ORDINALITY k(name,ord) ORDER BY ord)))
 AND NOT EXISTS(SELECT 1 FROM fks e WHERE NOT EXISTS(
  SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid JOIN rels target ON target.oid=c.confrelid
  WHERE r.relname=e.tab AND target.relname=e.target_tab AND c.contype='f' AND c.convalidated
    AND c.cols=string_to_array(e.cols,',') AND c.target_cols=string_to_array(e.target_cols,',')
    AND c.confdeltype=e.delete_action::"char" AND c.confupdtype='a' AND c.confmatchtype='s'
    AND c.condeferrable=e.deferred AND c.condeferred=e.deferred
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=c.oid
                   AND t.tgenabled NOT IN ('O','A'))))
 AND NOT EXISTS(SELECT 1 FROM checks e WHERE NOT EXISTS(
  SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
  WHERE r.relname=e.tab AND c.contype='c' AND c.convalidated
    AND (CASE WHEN e.tab='foobar_import_observations_v2' THEN
      pg_catalog.pg_get_expr(c.conbin,c.conrelid)
      ELSE lower(regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'[()[:space:]]','','g')) END)=e.expression))
 AND NOT EXISTS(SELECT 1 FROM indexes e WHERE NOT EXISTS(
  SELECT 1 FROM rels r JOIN pg_catalog.pg_index i ON i.indrelid=r.oid
  JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid JOIN pg_catalog.pg_namespace ns ON ns.oid=ix.relnamespace
  JOIN pg_catalog.pg_am am ON am.oid=ix.relam
  WHERE r.relname='foobar_import_history_projection_v1' AND ix.relname=e.name AND ns.nspname='integration'
    AND ix.relkind='i' AND ix.relpersistence='p' AND am.amname='btree'
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
    AND i.indnkeyatts=4 AND i.indnatts=4 AND i.indexprs IS NULL
    AND pg_catalog.pg_get_expr(i.indpred,i.indrelid)=e.predicate
    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
              JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num
              WHERE NOT a.attisdropped ORDER BY ord)
        =ARRAY['account_id','source_ref',e.key_column,'observation_ref']::text[]
    AND ARRAY(SELECT v FROM unnest(i.indoption) WITH ORDINALITY k(v,ord) ORDER BY ord)=ARRAY[0,0,3,3]::smallint[]
    AND ARRAY(SELECT v FROM unnest(i.indcollation) WITH ORDINALITY k(v,ord) ORDER BY ord)=ARRAY[0,0,0,0]::oid[]
    AND ARRAY(SELECT op.opcname::text FROM unnest(i.indclass) WITH ORDINALITY k(num,ord)
              JOIN pg_catalog.pg_opclass op ON op.oid=k.num JOIN pg_catalog.pg_namespace n ON n.oid=op.opcnamespace
              WHERE n.nspname='pg_catalog' AND op.opcmethod=am.oid AND op.opcdefault ORDER BY ord)
        =ARRAY['int8_ops','uuid_ops','int8_ops','uuid_ops']::text[]))
 AND EXISTS(
  SELECT 1 FROM rels r JOIN pg_catalog.pg_trigger t ON t.tgrelid=r.oid
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE r.relname='foobar_import_history_projection_v1' AND t.tgname='foobar_history_projection_account_v1'
    AND t.tgtype=29 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
    AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0
    AND t.tgnargs=0 AND t.tgqual IS NULL AND cardinality(t.tgattr::smallint[])=0
    AND n.nspname='integration' AND p.proname='account_foobar_history_projection_v1'
    AND p.pronargs=0 AND p.pronargdefaults=0 AND p.prokind='f'
    AND NOT p.proretset AND p.prosecdef AND NOT p.proisstrict
    AND p.provolatile='v' AND p.prorettype='pg_catalog.trigger'::regtype
    AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])
) AS history_ready,
( NOT EXISTS(SELECT 1 FROM columns e WHERE e.generated='' AND NOT EXISTS(
 SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
 WHERE r.relname='foobar_import_history_projection_v1' AND a.attname=e.name AND NOT a.attisdropped
   AND pg_catalog.has_column_privilege(r.oid,a.attnum,'INSERT')
   AND (e.name IN ('account_id','source_ref','observation_ref')
        OR pg_catalog.has_column_privilege(r.oid,a.attnum,'UPDATE'))))
) AS history_writer_ready
"""


def require_foobar_history_on_connection(connection, *, for_write=False):
    """No cache/settings/commit; genuine transaction owns deadline and reserve."""
    try:
        if (type(for_write) is not bool or not _SCHEMA_SQL.isascii()
                or len(_SCHEMA_SQL)>_MAX_SCHEMA_SQL_BYTES):
            raise SourceUnavailable()
        cursor = connection.execute(_SCHEMA_SQL)
        try:
            rows = cursor.fetchmany(2)
        finally:
            cursor.close()
        if (type(rows) is not list or len(rows)!=1 or type(rows[0]) is not dict
                or set(rows[0])!={'history_ready','history_writer_ready'}
                or rows[0]['history_ready'] is not True
                or type(rows[0]['history_writer_ready']) is not bool
                or for_write and rows[0]['history_writer_ready'] is not True):
            raise SourceUnavailable()
        require_enhanced_entries_on_connection(connection, for_write=for_write)
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None



def require_foobar_history_schema(database_url):
    """Read-only startup prerequisite for the coordinated writer and reader.

    Requires writer privileges because the final import worker writes projection
    rows. Does not install schema, backfill, activate features or cache readiness.
    """
    try:
        with pooled_connection(database_url, timeout=1.0) as connection:
            for setting in ('set transaction read only', "set local lock_timeout = '250ms'",
                            "set local statement_timeout = '1000ms'", 'set local search_path = pg_catalog'):
                connection.execute(setting).close()
            require_foobar_history_on_connection(connection, for_write=True)
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
