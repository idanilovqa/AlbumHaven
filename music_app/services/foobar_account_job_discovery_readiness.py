"""Exact read-only index prerequisites, not planner/DDL/function attestation."""
from .foobar_account_source_postgres import SourceUnavailable
from .postgres_connections import pooled_connection

JOB_DISCOVERY_SCHEMA_PHASE_BYTES = 65536
_MAX_SQL_BYTES = 8192

_SCHEMA_SQL = r"""
WITH target AS MATERIALIZED (
 SELECT c.oid FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='integration' AND c.relname='foobar_import_jobs_v1'
   AND c.relkind='r' AND c.relpersistence='p'
), expected(name,predicate) AS (VALUES
 ('foobar_import_jobs_recent_v1',NULL::text),
 ('foobar_import_jobs_unfinished_v1','(confirmed_through < total_rows)'::text)
)
SELECT (
 (SELECT count(*) FROM target)=1
 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h JOIN target t
                  ON t.oid=h.inhrelid OR t.oid=h.inhparent)
 AND NOT EXISTS (
  SELECT 1 FROM expected e WHERE NOT EXISTS (
   SELECT 1 FROM target t JOIN pg_catalog.pg_index i ON i.indrelid=t.oid
   JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid
   JOIN pg_catalog.pg_namespace ns ON ns.oid=ix.relnamespace
   JOIN pg_catalog.pg_am am ON am.oid=ix.relam
   WHERE ix.relname=e.name AND ns.nspname='integration'
     AND ix.relkind='i' AND ix.relpersistence='p' AND am.amname='btree'
     AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
     AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
     AND i.indnkeyatts=4 AND i.indnatts=4 AND i.indexprs IS NULL
     AND pg_catalog.pg_get_expr(i.indpred,i.indrelid) IS NOT DISTINCT FROM e.predicate
     AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
               JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num
               WHERE NOT a.attisdropped AND a.attnotnull ORDER BY k.ord)
         =ARRAY['account_id','updated_at','source_ref','job_ref']::text[]
     -- Default ASC NULLS LAST, then exact DESC NULLS FIRST for all suffix keys.
     AND ARRAY(SELECT v FROM unnest(i.indoption) WITH ORDINALITY o(v,ord) ORDER BY ord)
         =ARRAY[0,3,3,3]::smallint[]
     AND ARRAY(SELECT v FROM unnest(i.indcollation) WITH ORDINALITY o(v,ord) ORDER BY ord)
         =ARRAY[0,0,0,0]::oid[]
     AND ARRAY(SELECT op.opcname::text FROM unnest(i.indclass) WITH ORDINALITY k(num,ord)
               JOIN pg_catalog.pg_opclass op ON op.oid=k.num
               JOIN pg_catalog.pg_namespace n ON n.oid=op.opcnamespace
               WHERE n.nspname='pg_catalog' AND op.opcmethod=am.oid AND op.opcdefault
               ORDER BY k.ord)
         =ARRAY['int8_ops','timestamptz_ops','uuid_ops','uuid_ops']::text[]
  )
 )
) AS discovery_ready
"""


def require_foobar_job_discovery_on_connection(connection):
    """No cache/pool/settings/commit; caller owns phase/deadline and jobs readiness."""
    try:
        if not _SCHEMA_SQL.isascii() or len(_SCHEMA_SQL) > _MAX_SQL_BYTES:
            raise SourceUnavailable()
        cursor = connection.execute(_SCHEMA_SQL)
        try:
            rows = cursor.fetchmany(2)
        finally:
            cursor.close()
        if (type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict
                or set(rows[0]) != {'discovery_ready'} or rows[0]['discovery_ready'] is not True):
            raise SourceUnavailable()
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None


def require_foobar_job_discovery(database_url):
    """Pooled read-only startup check; both existing jobs and new indexes required."""
    from .foobar_account_import_jobs_readiness import require_foobar_job_schema_on_connection
    try:
        with pooled_connection(database_url, timeout=1.0) as connection:
            for setting in ('set transaction read only', "set local lock_timeout = '250ms'",
                            "set local statement_timeout = '1000ms'", 'set local search_path = pg_catalog'):
                connection.execute(setting).close()
            require_foobar_job_schema_on_connection(connection)
            require_foobar_job_discovery_on_connection(connection)
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
