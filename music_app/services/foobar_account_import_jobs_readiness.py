"""Concrete structural prerequisites for durable account-owned Foobar jobs.

Both tables are mandatory for the final account-import path, including ordinary
Prepare/Apply discovery hooks. Absence or a partial schema fails closed; there
is no optional job marker, prefix convention, fallback, or cached ready flag.

This read-only catalog check covers the documented 47 column shapes, generated
terminal hash, account-scoped keys and unique indexes, exact ownership FK set,
guard signatures/attachments, simple bounds, and effective writer privileges.
It is not function-body attestation, complete CHECK-body certification, RLS QA,
deployment authorization, role hardening, or evidence that tests have executed.
Current authority, command/proof validation and locked CAS remain repository
obligations. No user rows, raw upload, credentials, or function bodies are read.
Concurrent DDL/privilege changes can invalidate a successful catalog snapshot.
"""
from .postgres_connections import pooled_connection
from .foobar_account_source_postgres import SourceUnavailable

# One fixed catalog statement, no frames or request-controlled identifiers.
# Two logical 24 KiB SQL views plus a 16 KiB cursor/result/error allowance.
# The SQL returns exactly one boolean; fetchmany(2) only detects adapter drift.
# The transaction caller owns this phase reservation and its deadline wrapper.
JOB_SCHEMA_PHASE_BYTES = 65536
_MAX_SCHEMA_SQL_BYTES = 24576

_SCHEMA_SQL = r"""
WITH expected_tables(name) AS (VALUES
 ('foobar_import_jobs_v1'),('foobar_import_job_attempts_v1')
),
rels AS MATERIALIZED (
 SELECT c.oid,c.relname,c.relkind,c.relpersistence
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN expected_tables e ON e.name=c.relname WHERE n.nspname='integration'
),
expected_columns(tab,col,typ,required,generated,insertable,updatable) AS (VALUES
 ('foobar_import_jobs_v1','account_id','int8',true,'',true,false),
 ('foobar_import_jobs_v1','source_ref','uuid',true,'',true,false),
 ('foobar_import_jobs_v1','job_ref','uuid',true,'',true,false),
 ('foobar_import_jobs_v1','upload_sha256','bytea',true,'',true,false),
 ('foobar_import_jobs_v1','parser_version','text',true,'',true,false),
 ('foobar_import_jobs_v1','mapping_name','text',true,'',true,false),
 ('foobar_import_jobs_v1','original_matching_library_id','int8',false,'',true,false),
 ('foobar_import_jobs_v1','original_generation','int8',true,'',true,false),
 ('foobar_import_jobs_v1','total_rows','int4',true,'',true,false),
 ('foobar_import_jobs_v1','version','int8',true,'',true,true),
 ('foobar_import_jobs_v1','confirmed_through','int4',true,'',true,true),
 ('foobar_import_jobs_v1','next_batch_no','int4',true,'',true,true),
 ('foobar_import_jobs_v1','cancel_requested','bool',true,'',true,true),
 ('foobar_import_jobs_v1','unchanged_count','int4',true,'',true,true),
 ('foobar_import_jobs_v1','source_only_count','int4',true,'',true,true),
 ('foobar_import_jobs_v1','taste_only_count','int4',true,'',true,true),
 ('foobar_import_jobs_v1','both_count','int4',true,'',true,true),
 ('foobar_import_jobs_v1','ratings_count','int4',true,'',true,true),
 ('foobar_import_jobs_v1','favorites_count','int4',true,'',true,true),
 ('foobar_import_jobs_v1','association_count','int4',true,'',true,true),
 ('foobar_import_jobs_v1','created_at','timestamptz',true,'',true,false),
 ('foobar_import_jobs_v1','updated_at','timestamptz',true,'',true,true),
 ('foobar_import_job_attempts_v1','account_id','int8',true,'',true,false),
 ('foobar_import_job_attempts_v1','source_ref','uuid',true,'',true,false),
 ('foobar_import_job_attempts_v1','job_ref','uuid',true,'',true,false),
 ('foobar_import_job_attempts_v1','batch_no','int4',true,'',true,false),
 ('foobar_import_job_attempts_v1','attempt_no','int8',true,'',true,false),
 ('foobar_import_job_attempts_v1','generation','int8',true,'',true,false),
 ('foobar_import_job_attempts_v1','original_session_id','int8',true,'',true,false),
 ('foobar_import_job_attempts_v1','window_start','int4',true,'',true,false),
 ('foobar_import_job_attempts_v1','window_end','int4',false,'',false,true),
 ('foobar_import_job_attempts_v1','expected_revision','int8',true,'',true,false),
 ('foobar_import_job_attempts_v1','inventory_sha256','bytea',true,'',true,false),
 ('foobar_import_job_attempts_v1','prepare_key','uuid',true,'',true,false),
 ('foobar_import_job_attempts_v1','prepare_command_sha256','bytea',true,'',true,false),
 ('foobar_import_job_attempts_v1','apply_key','uuid',true,'',true,false),
 ('foobar_import_job_attempts_v1','apply_command_sha256','bytea',false,'',false,true),
 ('foobar_import_job_attempts_v1','receipt_ref','uuid',false,'',false,true),
 ('foobar_import_job_attempts_v1','prepared_sha256','bytea',false,'',false,true),
 ('foobar_import_job_attempts_v1','decision_sha256','bytea',false,'',false,true),
 ('foobar_import_job_attempts_v1','authority_sha256','bytea',false,'',false,true),
 ('foobar_import_job_attempts_v1','state','text',true,'',true,true),
 ('foobar_import_job_attempts_v1','terminal_bytes','bytea',false,'',false,true),
 ('foobar_import_job_attempts_v1','terminal_sha256','bytea',false,'sha256(terminal_bytes)',false,false),
 ('foobar_import_job_attempts_v1','committed_revision','int8',false,'',false,true),
 ('foobar_import_job_attempts_v1','created_at','timestamptz',true,'',true,false),
 ('foobar_import_job_attempts_v1','updated_at','timestamptz',true,'',true,true)
),
expected_keys(tab,kind,cols) AS (VALUES
 ('foobar_import_jobs_v1','p','account_id,source_ref,job_ref'),
 ('foobar_import_job_attempts_v1','p','account_id,source_ref,job_ref,batch_no,attempt_no'),
 ('foobar_import_job_attempts_v1','u','account_id,source_ref,generation,prepare_key'),
 ('foobar_import_job_attempts_v1','u','account_id,source_ref,generation,apply_key'),
 ('foobar_import_job_attempts_v1','u','account_id,source_ref,generation,receipt_ref')
),
expected_fks(tab,cols,target_tab,target_cols) AS (VALUES
 ('foobar_import_jobs_v1','account_id,source_ref','foobar_import_streams_v2','account_id,source_ref'),
 ('foobar_import_job_attempts_v1','account_id,source_ref,job_ref','foobar_import_jobs_v1','account_id,source_ref,job_ref')
),
expected_triggers(tab,name) AS (VALUES
 ('foobar_import_jobs_v1','foobar_import_job_guard_v1'),
 ('foobar_import_job_attempts_v1','foobar_import_job_attempt_guard_v1')
),
expected_checks(tab,expression) AS (VALUES
 ('foobar_import_jobs_v1','octet_lengthupload_sha256=32'),
 ('foobar_import_jobs_v1','octet_lengthparser_version>=1andoctet_lengthparser_version<=64'),
 ('foobar_import_jobs_v1','octet_lengthmapping_name>=1andoctet_lengthmapping_name<=64'),
 ('foobar_import_jobs_v1','original_matching_library_id>0'),
 ('foobar_import_jobs_v1','original_generation>=1andoriginal_generation<=2147483647'),
 ('foobar_import_jobs_v1','total_rows>=1andtotal_rows<=100000'),
 ('foobar_import_jobs_v1','version>=0'),
 ('foobar_import_jobs_v1','isfinitecreated_at'),
 ('foobar_import_jobs_v1','isfiniteupdated_at'),
 ('foobar_import_jobs_v1','confirmed_through>=0andconfirmed_through<=total_rows'),
 ('foobar_import_jobs_v1','next_batch_no>=1andnext_batch_no<=total_rows+1'),
 ('foobar_import_jobs_v1','next_batch_no<=confirmed_through+1'),
 ('foobar_import_jobs_v1','unchanged_count>=0andunchanged_count<=100000'),
 ('foobar_import_jobs_v1','source_only_count>=0andsource_only_count<=100000'),
 ('foobar_import_jobs_v1','taste_only_count>=0andtaste_only_count<=100000'),
 ('foobar_import_jobs_v1','both_count>=0andboth_count<=100000'),
 ('foobar_import_jobs_v1','ratings_count>=0andratings_count<=100000'),
 ('foobar_import_jobs_v1','favorites_count>=0andfavorites_count<=100000'),
 ('foobar_import_jobs_v1','association_count>=0andassociation_count<=100000'),
 ('foobar_import_jobs_v1','unchanged_count+source_only_count+taste_only_count+both_count=confirmed_through'),
 ('foobar_import_jobs_v1','ratings_count<=taste_only_count+both_count'),
 ('foobar_import_jobs_v1','favorites_count<=taste_only_count+both_count'),
 ('foobar_import_jobs_v1','ratings_count+favorites_count>=taste_only_count+both_count'),
 ('foobar_import_jobs_v1','association_count<=confirmed_through'),
 ('foobar_import_jobs_v1','updated_at>=created_at'),
 ('foobar_import_job_attempts_v1','batch_no>=1andbatch_no<=100000'),
 ('foobar_import_job_attempts_v1','attempt_no>0'),
 ('foobar_import_job_attempts_v1','generation>=1andgeneration<=2147483647'),
 ('foobar_import_job_attempts_v1','original_session_id>0'),
 ('foobar_import_job_attempts_v1','window_start>=1andwindow_start<=100000'),
 ('foobar_import_job_attempts_v1','expected_revision>=0'),
 ('foobar_import_job_attempts_v1','octet_lengthinventory_sha256=32'),
 ('foobar_import_job_attempts_v1','octet_lengthprepare_command_sha256=32'),
 ('foobar_import_job_attempts_v1','octet_lengthapply_command_sha256=32'),
 ('foobar_import_job_attempts_v1','octet_lengthprepared_sha256=32'),
 ('foobar_import_job_attempts_v1','octet_lengthdecision_sha256=32'),
 ('foobar_import_job_attempts_v1','octet_lengthauthority_sha256=32'),
 ('foobar_import_job_attempts_v1','state=anyarray[''claimed''::text,''ready''::text,''confirmed''::text,''discarded''::text]'),
 ('foobar_import_job_attempts_v1','isfinitecreated_at'),
 ('foobar_import_job_attempts_v1','isfiniteupdated_at'),
 ('foobar_import_job_attempts_v1','prepare_key<>apply_key'),
 ('foobar_import_job_attempts_v1','updated_at>=created_at')
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
),
guard_function AS MATERIALIZED (
 SELECT p.oid FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE n.nspname='integration' AND p.proname='guard_foobar_import_job_v1'
   AND p.pronargs=0 AND p.pronargdefaults=0 AND p.prokind='f'
   AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proisstrict
   AND p.provolatile='v' AND p.prorettype='pg_catalog.trigger'::regtype
   AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
)
SELECT (
 (SELECT count(*) FROM rels WHERE relkind='r' AND relpersistence='p')=2
 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h JOIN rels r
                 ON r.oid=h.inhrelid OR r.oid=h.inhparent)
 AND current_setting('session_replication_role')='origin'
 AND pg_catalog.has_schema_privilege('integration','USAGE')
 AND (SELECT count(*) FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
       WHERE a.attnum>0 AND NOT a.attisdropped)=47
 AND NOT EXISTS (
   SELECT 1 FROM expected_columns e WHERE NOT EXISTS (
     SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
     JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
     JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
     WHERE r.relname=e.tab AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
       AND n.nspname='pg_catalog' AND t.typname=e.typ AND a.atttypmod=-1
       AND a.attnotnull=e.required AND a.attidentity=''
       AND a.attgenerated::text=CASE WHEN e.generated='' THEN '' ELSE 's' END
       AND (e.generated='' OR pg_catalog.pg_get_expr(d.adbin,d.adrelid)=e.generated)
       AND pg_catalog.has_column_privilege(r.oid,a.attnum,'SELECT')
       AND (NOT e.insertable OR pg_catalog.has_column_privilege(r.oid,a.attnum,'INSERT'))
       AND (NOT e.updatable OR pg_catalog.has_column_privilege(r.oid,a.attnum,'UPDATE'))
   )
 )
 AND (SELECT count(*) FROM constraints WHERE contype IN ('p','u'))=5
 AND NOT EXISTS (
   SELECT 1 FROM expected_keys e WHERE NOT EXISTS (
     SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
     JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
     JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid
     JOIN pg_catalog.pg_am am ON am.oid=ix.relam
     WHERE r.relname=e.tab AND c.contype=e.kind::"char" AND c.convalidated
       AND c.column_names=string_to_array(e.cols,',')
       AND NOT c.condeferrable AND NOT c.condeferred
       AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
       AND i.indimmediate AND i.indisprimary=(c.contype='p')
       AND am.amname='btree' AND i.indnatts=i.indnkeyatts
       AND i.indnkeyatts=cardinality(c.column_names)
       AND i.indexprs IS NULL AND i.indpred IS NULL
       AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num
                 ORDER BY k.ord)=c.column_names
   )
 )
 -- Exact FK set excludes live library/session/receipt ownership dependencies.
 AND (SELECT count(*) FROM constraints WHERE contype='f')=2
 AND NOT EXISTS (
   SELECT 1 FROM expected_fks e WHERE NOT EXISTS (
     SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
     JOIN pg_catalog.pg_class target ON target.oid=c.confrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=target.relnamespace
     WHERE r.relname=e.tab AND c.contype='f' AND c.convalidated
       AND c.column_names=string_to_array(e.cols,',')
       AND n.nspname='integration' AND target.relname=e.target_tab
       AND target.relkind='r' AND target.relpersistence='p'
       AND c.target_column_names=string_to_array(e.target_cols,',')
       AND c.confdeltype='c' AND c.confupdtype='a' AND c.confmatchtype='s'
       AND NOT c.condeferrable AND NOT c.condeferred
   )
 )
 AND NOT EXISTS (
   SELECT 1 FROM constraints c JOIN pg_catalog.pg_trigger t ON t.tgconstraint=c.oid
   WHERE c.contype='f' AND t.tgenabled NOT IN ('O','A')
 )
 AND EXISTS (
   SELECT 1 FROM rels r JOIN pg_catalog.pg_index i ON i.indrelid=r.oid
   JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid
   JOIN pg_catalog.pg_am am ON am.oid=ix.relam
   WHERE r.relname='foobar_import_job_attempts_v1'
     AND ix.relname='foobar_import_job_one_confirmation_v1'
     AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
     AND i.indimmediate AND NOT i.indisprimary AND am.amname='btree'
     AND i.indnkeyatts=4 AND i.indnatts=4 AND i.indexprs IS NULL
     AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
               JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num
               ORDER BY k.ord)=ARRAY['account_id','source_ref','job_ref','batch_no']::text[]
     AND lower(regexp_replace(pg_catalog.pg_get_expr(i.indpred,i.indrelid),
                              '[[:space:]()]','','g'))='state=''confirmed''::text'
 )
 AND (SELECT count(*) FROM guard_function)=1
 AND NOT EXISTS (
   SELECT 1 FROM expected_triggers e WHERE NOT EXISTS (
     SELECT 1 FROM rels r JOIN pg_catalog.pg_trigger t ON t.tgrelid=r.oid
     JOIN guard_function f ON f.oid=t.tgfoid
     WHERE r.relname=e.tab AND t.tgname=e.name AND t.tgtype=23
       AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
       AND t.tgnargs=0 AND octet_length(t.tgargs)=0
       AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgconstraint=0
       AND NOT t.tgdeferrable AND NOT t.tginitdeferred
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
) AS structural_ready
"""


def require_foobar_job_schema_on_connection(connection):
    """Read fixed catalog prerequisites inside the caller's guarded transaction.

    No pool, settings, commit, rollback, user-row query, or result cache. The
    actual account transaction owner supplies the deadline and resource phase.
    Every malformed, absent, incompatible or failed result is unavailable.
    """
    try:
        if len(_SCHEMA_SQL) > _MAX_SCHEMA_SQL_BYTES or not _SCHEMA_SQL.isascii():
            raise SourceUnavailable()
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


def require_foobar_job_schema(database_url):
    """Check the mandatory jobs schema at startup through the existing pool."""
    try:
        with pooled_connection(database_url, timeout=1.0) as connection:
            for setting in (
                    'set transaction read only',
                    "set local lock_timeout = '250ms'",
                    "set local statement_timeout = '1000ms'",
                    'set local search_path = pg_catalog'):
                connection.execute(setting).close()
            require_foobar_job_schema_on_connection(connection)
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
