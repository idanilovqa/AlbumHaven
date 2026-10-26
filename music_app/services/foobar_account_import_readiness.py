"""Partial structural prerequisites for the account-owned Foobar import path.

Source specification: foobar-account-owned-source-v2.sql.txt (contract r2).
This is NOT complete schema/security certification, activation approval, RLS
verification or executed QA. The application separately owns deployment opt-in
and its approved security prerequisites. No trusted-ready flag is accepted.

Checks cover five ordinary persistent tables, all 77 documented column shapes,
generated expressions, account keys, deferred receipt/key links, enabled trigger
attachments and function signatures, default-source uniqueness, twenty simple
numeric CHECK expressions and effective column privileges needed by default
source selection, Prepare and Apply. No grants or tables are created here.

Semantic gaps: complex state/timestamp/byte-length CHECK bodies, function/trigger
body semantics, trigger-owner privileges, unrelated triggers/rules, deployment
role hardening and library/taste authorization are not certified. The query
does not inspect user rows or use brittle pg_get_functiondef text equality.
A later concurrent DDL/privilege change can invalidate this snapshot; actual
operations must continue to fail closed under their native transaction owners.
Catalog deparser differences fail closed, never silently skip a prerequisite.
"""
from .postgres_connections import pooled_connection
from .foobar_account_source_postgres import SourceUnavailable

# Fixed text, no request-controlled identifiers or interpolation at execution.
# Every catalog scan is bounded in time; only one boolean is transferred.
_SCHEMA_SQL = r"""
WITH expected_tables(name) AS (VALUES
  ('foobar_import_streams_v2'),
  ('foobar_import_observations_v2'),
  ('foobar_import_revisions_v2'),
  ('foobar_import_receipts_v2'),
  ('foobar_import_request_keys_v2')
),
rels AS MATERIALIZED (
 SELECT c.oid,c.relname,c.relkind,c.relpersistence
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN expected_tables e ON e.name=c.relname WHERE n.nspname='integration'
),
expected_columns(tab,col,typ,required,generated) AS (VALUES
  ('foobar_import_streams_v2','account_id','int8',true,''),
  ('foobar_import_streams_v2','revision','int8',true,''),
  ('foobar_import_streams_v2','current_generation','int8',true,''),
  ('foobar_import_streams_v2','retired_through','int8',true,''),
  ('foobar_import_streams_v2','observation_count','int8',true,''),
  ('foobar_import_streams_v2','revision_count','int8',true,''),
  ('foobar_import_streams_v2','source_bytes','int8',true,''),
  ('foobar_import_streams_v2','receipt_count','int8',true,''),
  ('foobar_import_streams_v2','ready_count','int8',true,''),
  ('foobar_import_streams_v2','receipt_reserved_bytes','int8',true,''),
  ('foobar_import_streams_v2','request_key_count','int8',true,''),
  ('foobar_import_streams_v2','source_ref','uuid',true,''),
  ('foobar_import_streams_v2','is_default','bool',true,''),
  ('foobar_import_streams_v2','prepared_today','int4',true,''),
  ('foobar_import_streams_v2','clock_high_water','timestamptz',true,''),
  ('foobar_import_streams_v2','created_at','timestamptz',true,''),
  ('foobar_import_streams_v2','updated_at','timestamptz',true,''),
  ('foobar_import_observations_v2','account_id','int8',true,''),
  ('foobar_import_observations_v2','current_revision','int8',true,''),
  ('foobar_import_observations_v2','source_ref','uuid',true,''),
  ('foobar_import_observations_v2','observation_ref','uuid',true,''),
  ('foobar_import_observations_v2','identity_kind','text',true,''),
  ('foobar_import_observations_v2','identity_bytes','bytea',true,''),
  ('foobar_import_observations_v2','identity_sha256','bytea',false,'sha256(identity_bytes)'),
  ('foobar_import_observations_v2','created_at','timestamptz',true,''),
  ('foobar_import_observations_v2','updated_at','timestamptz',true,''),
  ('foobar_import_revisions_v2','account_id','int8',true,''),
  ('foobar_import_revisions_v2','source_revision','int8',true,''),
  ('foobar_import_revisions_v2','source_ref','uuid',true,''),
  ('foobar_import_revisions_v2','observation_ref','uuid',true,''),
  ('foobar_import_revisions_v2','incoming_evidence_bytes','bytea',false,''),
  ('foobar_import_revisions_v2','incoming_evidence_length','int4',false,'octet_length(incoming_evidence_bytes)'),
  ('foobar_import_revisions_v2','incoming_evidence_sha256','bytea',false,'sha256(incoming_evidence_bytes)'),
  ('foobar_import_revisions_v2','evidence_bytes','bytea',true,''),
  ('foobar_import_revisions_v2','display_bytes','bytea',true,''),
  ('foobar_import_revisions_v2','evidence_sha256','bytea',false,'sha256(evidence_bytes)'),
  ('foobar_import_revisions_v2','display_sha256','bytea',false,'sha256(display_bytes)'),
  ('foobar_import_revisions_v2','created_at','timestamptz',true,''),
  ('foobar_import_receipts_v2','account_id','int8',true,''),
  ('foobar_import_receipts_v2','generation','int8',true,''),
  ('foobar_import_receipts_v2','original_session_id','int8',true,''),
  ('foobar_import_receipts_v2','expected_revision','int8',true,''),
  ('foobar_import_receipts_v2','committed_revision','int8',false,''),
  ('foobar_import_receipts_v2','source_ref','uuid',true,''),
  ('foobar_import_receipts_v2','receipt_ref','uuid',true,''),
  ('foobar_import_receipts_v2','prepare_key','uuid',true,''),
  ('foobar_import_receipts_v2','apply_key','uuid',false,''),
  ('foobar_import_receipts_v2','state','text',true,''),
  ('foobar_import_receipts_v2','parser_version','text',true,''),
  ('foobar_import_receipts_v2','mapping_name','text',true,''),
  ('foobar_import_receipts_v2','total_rows','int4',true,''),
  ('foobar_import_receipts_v2','window_start','int4',true,''),
  ('foobar_import_receipts_v2','window_end','int4',true,''),
  ('foobar_import_receipts_v2','upload_sha256','bytea',true,''),
  ('foobar_import_receipts_v2','inventory_sha256','bytea',true,''),
  ('foobar_import_receipts_v2','authority_sha256','bytea',true,''),
  ('foobar_import_receipts_v2','decision_sha256','bytea',true,''),
  ('foobar_import_receipts_v2','prepared_sha256','bytea',true,''),
  ('foobar_import_receipts_v2','prepared_bytes','bytea',false,''),
  ('foobar_import_receipts_v2','terminal_bytes','bytea',false,''),
  ('foobar_import_receipts_v2','terminal_sha256','bytea',false,'sha256(terminal_bytes)'),
  ('foobar_import_receipts_v2','created_at','timestamptz',true,''),
  ('foobar_import_receipts_v2','ready_until','timestamptz',true,''),
  ('foobar_import_receipts_v2','expires_at','timestamptz',true,''),
  ('foobar_import_receipts_v2','committed_at','timestamptz',false,''),
  ('foobar_import_request_keys_v2','account_id','int8',true,''),
  ('foobar_import_request_keys_v2','generation','int8',true,''),
  ('foobar_import_request_keys_v2','source_ref','uuid',true,''),
  ('foobar_import_request_keys_v2','request_key','uuid',true,''),
  ('foobar_import_request_keys_v2','original_receipt_ref','uuid',true,''),
  ('foobar_import_request_keys_v2','receipt_ref','uuid',false,''),
  ('foobar_import_request_keys_v2','operation','text',true,''),
  ('foobar_import_request_keys_v2','state','text',true,''),
  ('foobar_import_request_keys_v2','retired_reason','text',false,''),
  ('foobar_import_request_keys_v2','command_sha256','bytea',true,''),
  ('foobar_import_request_keys_v2','created_at','timestamptz',true,''),
  ('foobar_import_request_keys_v2','retired_at','timestamptz',false,'')
),
expected_keys(tab,kind,cols) AS (VALUES
  ('foobar_import_streams_v2','p','account_id,source_ref'),
  ('foobar_import_observations_v2','p','account_id,source_ref,observation_ref'),
  ('foobar_import_revisions_v2','p','account_id,source_ref,observation_ref,source_revision'),
  ('foobar_import_receipts_v2','p','account_id,source_ref,generation,receipt_ref'),
  ('foobar_import_receipts_v2','u','account_id,source_ref,generation,prepare_key'),
  ('foobar_import_receipts_v2','u','account_id,source_ref,generation,apply_key'),
  ('foobar_import_request_keys_v2','p','account_id,source_ref,generation,request_key'),
  ('foobar_import_request_keys_v2','u','account_id,source_ref,generation,original_receipt_ref,operation')
),
expected_fks(tab,cols,target_schema,target_tab,target_cols,delete_action,deferred) AS (VALUES
  ('foobar_import_streams_v2','account_id','app','accounts','id','r',false),
  ('foobar_import_observations_v2','account_id,source_ref','integration','foobar_import_streams_v2','account_id,source_ref','c',false),
  ('foobar_import_revisions_v2','account_id,source_ref,observation_ref','integration','foobar_import_observations_v2','account_id,source_ref,observation_ref','c',true),
  ('foobar_import_observations_v2','account_id,source_ref,observation_ref,current_revision','integration','foobar_import_revisions_v2','account_id,source_ref,observation_ref,source_revision','a',true),
  ('foobar_import_receipts_v2','account_id,source_ref','integration','foobar_import_streams_v2','account_id,source_ref','c',false),
  ('foobar_import_request_keys_v2','account_id,source_ref','integration','foobar_import_streams_v2','account_id,source_ref','c',false),
  ('foobar_import_request_keys_v2','account_id,source_ref,generation,receipt_ref','integration','foobar_import_receipts_v2','account_id,source_ref,generation,receipt_ref','a',true),
  ('foobar_import_receipts_v2','account_id,source_ref,generation,prepare_key','integration','foobar_import_request_keys_v2','account_id,source_ref,generation,request_key','a',true),
  ('foobar_import_receipts_v2','account_id,source_ref,generation,apply_key','integration','foobar_import_request_keys_v2','account_id,source_ref,generation,request_key','a',true)
),
expected_functions(name,security_definer) AS (VALUES
  ('guard_foobar_import_row_v2',false),
  ('account_foobar_import_row_v2',true),
  ('check_foobar_import_links_v2',false)
),
expected_triggers(tab,name,flags,function_name,deferred) AS (VALUES
  ('foobar_import_streams_v2','foobar_import_stream_guard_v2',23,'guard_foobar_import_row_v2',false),
  ('foobar_import_observations_v2','foobar_import_observation_guard_v2',19,'guard_foobar_import_row_v2',false),
  ('foobar_import_revisions_v2','foobar_import_revision_guard_v2',19,'guard_foobar_import_row_v2',false),
  ('foobar_import_receipts_v2','foobar_import_receipt_guard_v2',31,'guard_foobar_import_row_v2',false),
  ('foobar_import_request_keys_v2','foobar_import_key_guard_v2',31,'guard_foobar_import_row_v2',false),
  ('foobar_import_observations_v2','foobar_import_observation_account_v2',13,'account_foobar_import_row_v2',false),
  ('foobar_import_revisions_v2','foobar_import_revision_account_v2',13,'account_foobar_import_row_v2',false),
  ('foobar_import_receipts_v2','foobar_import_receipt_account_v2',29,'account_foobar_import_row_v2',false),
  ('foobar_import_request_keys_v2','foobar_import_key_account_v2',13,'account_foobar_import_row_v2',false),
  ('foobar_import_observations_v2','foobar_import_observation_links_v2',21,'check_foobar_import_links_v2',true),
  ('foobar_import_revisions_v2','foobar_import_revision_links_v2',5,'check_foobar_import_links_v2',true),
  ('foobar_import_receipts_v2','foobar_import_receipt_links_v2',21,'check_foobar_import_links_v2',true),
  ('foobar_import_request_keys_v2','foobar_import_key_links_v2',21,'check_foobar_import_links_v2',true)
),
expected_checks(tab,expression) AS (VALUES
  ('foobar_import_streams_v2','revision>=0'),
  ('foobar_import_streams_v2','current_generation>=1andcurrent_generation<=2147483647'),
  ('foobar_import_streams_v2','retired_through>=0andretired_through<current_generation'),
  ('foobar_import_streams_v2','prepared_today>=0andprepared_today<=4000'),
  ('foobar_import_streams_v2','observation_count>=0andobservation_count<=100000'),
  ('foobar_import_streams_v2','revision_count>=0andrevision_count<=1000000'),
  ('foobar_import_streams_v2','source_bytes>=0andsource_bytes<=268435456'),
  ('foobar_import_streams_v2','receipt_count>=0andreceipt_count<=40000'),
  ('foobar_import_streams_v2','ready_count>=0andready_count<=8'),
  ('foobar_import_streams_v2','receipt_reserved_bytes>=0andreceipt_reserved_bytes<=67108864'),
  ('foobar_import_streams_v2','request_key_count>=0andrequest_key_count<=80000'),
  ('foobar_import_observations_v2','current_revision>0'),
  ('foobar_import_revisions_v2','source_revision>0'),
  ('foobar_import_receipts_v2','generation>=1andgeneration<=2147483647'),
  ('foobar_import_receipts_v2','original_session_id>0'),
  ('foobar_import_receipts_v2','expected_revision>=0'),
  ('foobar_import_receipts_v2','total_rows>=0andtotal_rows<=100000'),
  ('foobar_import_receipts_v2','window_start>=1andwindow_start<=100001'),
  ('foobar_import_receipts_v2','window_end>=1andwindow_end<=100001'),
  ('foobar_import_request_keys_v2','generation>=1andgeneration<=2147483647')
),
expected_privileges(tab,col,operation) AS (VALUES
  ('foobar_import_streams_v2','account_id','SELECT'),
  ('foobar_import_streams_v2','revision','SELECT'),
  ('foobar_import_streams_v2','current_generation','SELECT'),
  ('foobar_import_streams_v2','retired_through','SELECT'),
  ('foobar_import_streams_v2','observation_count','SELECT'),
  ('foobar_import_streams_v2','revision_count','SELECT'),
  ('foobar_import_streams_v2','source_bytes','SELECT'),
  ('foobar_import_streams_v2','receipt_count','SELECT'),
  ('foobar_import_streams_v2','ready_count','SELECT'),
  ('foobar_import_streams_v2','receipt_reserved_bytes','SELECT'),
  ('foobar_import_streams_v2','request_key_count','SELECT'),
  ('foobar_import_streams_v2','source_ref','SELECT'),
  ('foobar_import_streams_v2','is_default','SELECT'),
  ('foobar_import_streams_v2','prepared_today','SELECT'),
  ('foobar_import_streams_v2','clock_high_water','SELECT'),
  ('foobar_import_streams_v2','created_at','SELECT'),
  ('foobar_import_streams_v2','updated_at','SELECT'),
  ('foobar_import_observations_v2','account_id','SELECT'),
  ('foobar_import_observations_v2','current_revision','SELECT'),
  ('foobar_import_observations_v2','source_ref','SELECT'),
  ('foobar_import_observations_v2','observation_ref','SELECT'),
  ('foobar_import_observations_v2','identity_kind','SELECT'),
  ('foobar_import_observations_v2','identity_bytes','SELECT'),
  ('foobar_import_observations_v2','identity_sha256','SELECT'),
  ('foobar_import_observations_v2','created_at','SELECT'),
  ('foobar_import_observations_v2','updated_at','SELECT'),
  ('foobar_import_revisions_v2','account_id','SELECT'),
  ('foobar_import_revisions_v2','source_revision','SELECT'),
  ('foobar_import_revisions_v2','source_ref','SELECT'),
  ('foobar_import_revisions_v2','observation_ref','SELECT'),
  ('foobar_import_revisions_v2','incoming_evidence_bytes','SELECT'),
  ('foobar_import_revisions_v2','incoming_evidence_length','SELECT'),
  ('foobar_import_revisions_v2','incoming_evidence_sha256','SELECT'),
  ('foobar_import_revisions_v2','evidence_bytes','SELECT'),
  ('foobar_import_revisions_v2','display_bytes','SELECT'),
  ('foobar_import_revisions_v2','evidence_sha256','SELECT'),
  ('foobar_import_revisions_v2','display_sha256','SELECT'),
  ('foobar_import_revisions_v2','created_at','SELECT'),
  ('foobar_import_receipts_v2','account_id','SELECT'),
  ('foobar_import_receipts_v2','generation','SELECT'),
  ('foobar_import_receipts_v2','original_session_id','SELECT'),
  ('foobar_import_receipts_v2','expected_revision','SELECT'),
  ('foobar_import_receipts_v2','committed_revision','SELECT'),
  ('foobar_import_receipts_v2','source_ref','SELECT'),
  ('foobar_import_receipts_v2','receipt_ref','SELECT'),
  ('foobar_import_receipts_v2','prepare_key','SELECT'),
  ('foobar_import_receipts_v2','apply_key','SELECT'),
  ('foobar_import_receipts_v2','state','SELECT'),
  ('foobar_import_receipts_v2','parser_version','SELECT'),
  ('foobar_import_receipts_v2','mapping_name','SELECT'),
  ('foobar_import_receipts_v2','total_rows','SELECT'),
  ('foobar_import_receipts_v2','window_start','SELECT'),
  ('foobar_import_receipts_v2','window_end','SELECT'),
  ('foobar_import_receipts_v2','upload_sha256','SELECT'),
  ('foobar_import_receipts_v2','inventory_sha256','SELECT'),
  ('foobar_import_receipts_v2','authority_sha256','SELECT'),
  ('foobar_import_receipts_v2','decision_sha256','SELECT'),
  ('foobar_import_receipts_v2','prepared_sha256','SELECT'),
  ('foobar_import_receipts_v2','prepared_bytes','SELECT'),
  ('foobar_import_receipts_v2','terminal_bytes','SELECT'),
  ('foobar_import_receipts_v2','terminal_sha256','SELECT'),
  ('foobar_import_receipts_v2','created_at','SELECT'),
  ('foobar_import_receipts_v2','ready_until','SELECT'),
  ('foobar_import_receipts_v2','expires_at','SELECT'),
  ('foobar_import_receipts_v2','committed_at','SELECT'),
  ('foobar_import_request_keys_v2','account_id','SELECT'),
  ('foobar_import_request_keys_v2','generation','SELECT'),
  ('foobar_import_request_keys_v2','source_ref','SELECT'),
  ('foobar_import_request_keys_v2','request_key','SELECT'),
  ('foobar_import_request_keys_v2','original_receipt_ref','SELECT'),
  ('foobar_import_request_keys_v2','receipt_ref','SELECT'),
  ('foobar_import_request_keys_v2','operation','SELECT'),
  ('foobar_import_request_keys_v2','state','SELECT'),
  ('foobar_import_request_keys_v2','retired_reason','SELECT'),
  ('foobar_import_request_keys_v2','command_sha256','SELECT'),
  ('foobar_import_request_keys_v2','created_at','SELECT'),
  ('foobar_import_request_keys_v2','retired_at','SELECT'),
  ('foobar_import_streams_v2','account_id','INSERT'),
  ('foobar_import_streams_v2','source_ref','INSERT'),
  ('foobar_import_streams_v2','is_default','INSERT'),
  ('foobar_import_streams_v2','current_generation','INSERT'),
  ('foobar_import_streams_v2','retired_through','INSERT'),
  ('foobar_import_streams_v2','clock_high_water','INSERT'),
  ('foobar_import_streams_v2','created_at','INSERT'),
  ('foobar_import_streams_v2','updated_at','INSERT'),
  ('foobar_import_observations_v2','account_id','INSERT'),
  ('foobar_import_observations_v2','source_ref','INSERT'),
  ('foobar_import_observations_v2','observation_ref','INSERT'),
  ('foobar_import_observations_v2','identity_kind','INSERT'),
  ('foobar_import_observations_v2','identity_bytes','INSERT'),
  ('foobar_import_observations_v2','current_revision','INSERT'),
  ('foobar_import_revisions_v2','account_id','INSERT'),
  ('foobar_import_revisions_v2','source_ref','INSERT'),
  ('foobar_import_revisions_v2','observation_ref','INSERT'),
  ('foobar_import_revisions_v2','source_revision','INSERT'),
  ('foobar_import_revisions_v2','incoming_evidence_bytes','INSERT'),
  ('foobar_import_revisions_v2','evidence_bytes','INSERT'),
  ('foobar_import_revisions_v2','display_bytes','INSERT'),
  ('foobar_import_receipts_v2','account_id','INSERT'),
  ('foobar_import_receipts_v2','source_ref','INSERT'),
  ('foobar_import_receipts_v2','generation','INSERT'),
  ('foobar_import_receipts_v2','receipt_ref','INSERT'),
  ('foobar_import_receipts_v2','prepare_key','INSERT'),
  ('foobar_import_receipts_v2','original_session_id','INSERT'),
  ('foobar_import_receipts_v2','state','INSERT'),
  ('foobar_import_receipts_v2','expected_revision','INSERT'),
  ('foobar_import_receipts_v2','upload_sha256','INSERT'),
  ('foobar_import_receipts_v2','parser_version','INSERT'),
  ('foobar_import_receipts_v2','mapping_name','INSERT'),
  ('foobar_import_receipts_v2','total_rows','INSERT'),
  ('foobar_import_receipts_v2','window_start','INSERT'),
  ('foobar_import_receipts_v2','window_end','INSERT'),
  ('foobar_import_receipts_v2','inventory_sha256','INSERT'),
  ('foobar_import_receipts_v2','authority_sha256','INSERT'),
  ('foobar_import_receipts_v2','decision_sha256','INSERT'),
  ('foobar_import_receipts_v2','prepared_bytes','INSERT'),
  ('foobar_import_receipts_v2','prepared_sha256','INSERT'),
  ('foobar_import_receipts_v2','created_at','INSERT'),
  ('foobar_import_receipts_v2','ready_until','INSERT'),
  ('foobar_import_receipts_v2','expires_at','INSERT'),
  ('foobar_import_request_keys_v2','account_id','INSERT'),
  ('foobar_import_request_keys_v2','source_ref','INSERT'),
  ('foobar_import_request_keys_v2','generation','INSERT'),
  ('foobar_import_request_keys_v2','request_key','INSERT'),
  ('foobar_import_request_keys_v2','operation','INSERT'),
  ('foobar_import_request_keys_v2','command_sha256','INSERT'),
  ('foobar_import_request_keys_v2','original_receipt_ref','INSERT'),
  ('foobar_import_request_keys_v2','receipt_ref','INSERT'),
  ('foobar_import_request_keys_v2','state','INSERT'),
  ('foobar_import_request_keys_v2','created_at','INSERT'),
  ('foobar_import_streams_v2','revision','UPDATE'),
  ('foobar_import_streams_v2','current_generation','UPDATE'),
  ('foobar_import_streams_v2','updated_at','UPDATE'),
  ('foobar_import_observations_v2','current_revision','UPDATE'),
  ('foobar_import_observations_v2','updated_at','UPDATE'),
  ('foobar_import_receipts_v2','state','UPDATE'),
  ('foobar_import_receipts_v2','prepared_bytes','UPDATE'),
  ('foobar_import_receipts_v2','apply_key','UPDATE'),
  ('foobar_import_receipts_v2','committed_revision','UPDATE'),
  ('foobar_import_receipts_v2','terminal_bytes','UPDATE'),
  ('foobar_import_receipts_v2','committed_at','UPDATE'),
  ('foobar_import_receipts_v2','expires_at','UPDATE')
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
 (SELECT count(*) FROM rels WHERE relkind='r' AND relpersistence='p')=5
 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h JOIN rels r
                 ON r.oid=h.inhrelid OR r.oid=h.inhparent)
 AND current_setting('session_replication_role')='origin'
 AND pg_catalog.has_schema_privilege('integration','USAGE')
 AND NOT EXISTS (
   SELECT 1 FROM expected_privileges e WHERE NOT EXISTS (
     SELECT 1 FROM rels r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
     WHERE r.relname=e.tab AND a.attname=e.col AND NOT a.attisdropped
       AND pg_catalog.has_column_privilege(r.oid,a.attnum,e.operation)
   )
 )
 AND NOT EXISTS (
   SELECT 1 FROM constraints c JOIN pg_catalog.pg_trigger t ON t.tgconstraint=c.oid
   WHERE c.contype='f' AND t.tgenabled NOT IN ('O','A')
 )
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
       AND i.indexprs IS NULL AND i.indpred IS NULL
   )
 )
 AND NOT EXISTS (
   SELECT 1 FROM expected_fks e WHERE NOT EXISTS (
     SELECT 1 FROM constraints c JOIN rels r ON r.oid=c.conrelid
     JOIN pg_catalog.pg_class target ON target.oid=c.confrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=target.relnamespace
     WHERE r.relname=e.tab AND c.contype='f' AND c.convalidated
       AND c.column_names=string_to_array(e.cols,',')
       AND n.nspname=e.target_schema AND target.relname=e.target_tab
       AND c.target_column_names=string_to_array(e.target_cols,',')
       AND c.confdeltype=e.delete_action::"char" AND c.confupdtype='a'
       AND c.confmatchtype='s' AND c.condeferrable=e.deferred AND c.condeferred=e.deferred
   )
 )
 AND EXISTS (
   SELECT 1 FROM rels r JOIN pg_catalog.pg_index i ON i.indrelid=r.oid
   JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid
   JOIN pg_catalog.pg_am am ON am.oid=ix.relam
   JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attname='account_id'
   WHERE r.relname='foobar_import_streams_v2' AND ix.relname='foobar_import_default_source_v2'
     AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
     AND am.amname='btree' AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=a.attnum
     AND i.indexprs IS NULL AND pg_catalog.pg_get_expr(i.indpred,i.indrelid)='is_default'
 )
 AND NOT EXISTS (
   SELECT 1 FROM expected_functions e WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     JOIN pg_catalog.pg_language l ON l.oid=p.prolang
     WHERE n.nspname='integration' AND p.proname=e.name AND p.pronargs=0
       AND p.pronargdefaults=0 AND p.prokind='f' AND NOT p.proretset
       AND p.prorettype='pg_catalog.trigger'::regtype AND l.lanname='plpgsql'
       AND p.prosecdef=e.security_definer AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
   )
 )
 AND NOT EXISTS (
   SELECT 1 FROM expected_triggers e WHERE NOT EXISTS (
     SELECT 1 FROM rels r JOIN pg_catalog.pg_trigger t ON t.tgrelid=r.oid
     JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
     JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     WHERE r.relname=e.tab AND t.tgname=e.name AND t.tgtype=e.flags
       AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
       AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgattr=''::int2vector
       AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
       AND (t.tgconstraint<>0)=e.deferred
       AND n.nspname='integration' AND p.proname=e.function_name AND p.pronargs=0
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


def require_account_import_schema(database_url):
    """Raise SourceUnavailable unless partial structural prerequisites hold.

    No successful readiness result is cached or promoted to policy authority.
    The existing pool owns commit/rollback and uses the real dict-row adapter.
    """
    try:
        with pooled_connection(database_url,timeout=1.0) as connection:
            for setting in (
                    'set transaction read only',
                    "set local lock_timeout = '250ms'",
                    "set local statement_timeout = '1000ms'",
                    'set local search_path = pg_catalog'):
                connection.execute(setting).close()
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
