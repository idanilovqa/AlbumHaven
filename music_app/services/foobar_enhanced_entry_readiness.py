"""Additional concrete Enhanced projection prerequisites, never schema activation.

Exact bounded ordinal/byte constraints and index shapes are checked here. Trigger
catalog checks are not body attestation, tenant isolation or deployment QA proof.
The existing server-owned deployment gate remains mandatory. No result is cached.
"""
from .foobar_source_postgres import SourceUnavailable

_SQL = r"""
with rels as materialized (
 select c.oid,c.relname from pg_catalog.pg_class c
 join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname='integration' and c.relkind='r' and c.relpersistence='p'
 and c.relname in ('foobar_import_local_entries_v1','foobar_import_history_projection_v1')
), cols(name,typ,required,generated) as (values
 ('account_id','int8',true,''),('source_ref','uuid',true,''),
 ('observation_ref','uuid',true,''),('source_revision','int8',true,''),
 ('source_ordinal','int4',true,''),('raw_filetime_le','bytea',true,''),
 ('resolved','bool',true,''),('sort_key','int8',true,''),
 ('projection_bytes','bytea',true,''),('projection_sha256','bytea',false,'sha256(projection_bytes)')
), checks(tab,preserve_grouping,expression) as (values
 ('foobar_import_local_entries_v1',false,'source_revision>0'),
 ('foobar_import_local_entries_v1',false,'source_ordinal>=0andsource_ordinal<=32765'),
 ('foobar_import_local_entries_v1',false,'octet_lengthraw_filetime_le=8'),
 ('foobar_import_local_entries_v1',false,'octet_lengthprojection_bytes>=1andoctet_lengthprojection_bytes<=512'),
 ('foobar_import_local_entries_v1',true,
 '((resolved AND (sort_key >= ''-116444736000000000''::bigint) AND (sort_key <= ''2534023007999999999''::bigint)) OR ((NOT resolved) AND (sort_key = ''-9223372036854775808''::bigint)))'),
 ('foobar_import_history_projection_v1',true,
 '(((evidence_kind = ''tsv_snapshot''::text) AND (local_entry_count IS NULL) AND (local_vector_sha256 IS NULL)) OR ((evidence_kind = ''enhanced_store''::text) AND (standard_first IS NULL) AND (enhanced_first IS NULL) AND (standard_last = ''-9223372036854775808''::bigint) AND (enhanced_last = ''-9223372036854775808''::bigint) AND (NOT standard_last_present) AND (NOT enhanced_last_present) AND (((local_entry_count IS NULL) AND (local_vector_sha256 IS NULL)) OR ((local_entry_count >= 0) AND (local_entry_count <= 32766) AND (local_entry_count IS NOT NULL) AND (local_vector_sha256 IS NOT NULL) AND (octet_length(local_vector_sha256) = 32)))))')
), indexes(name,is_primary,cols,options,ops) as (values
 ('',true,'account_id,source_ref,observation_ref,source_revision,source_ordinal',
 '0,0,0,0,0','int8_ops,uuid_ops,uuid_ops,int8_ops,int4_ops'),
 ('foobar_local_entries_chronological_v1',false,'account_id,source_ref,sort_key,observation_ref,source_ordinal',
 '0,0,3,3,3','int8_ops,uuid_ops,int8_ops,uuid_ops,int4_ops')
), triggers(tab,name,fn,kind,deferred,security_definer) as (values
 ('foobar_import_local_entries_v1','foobar_local_entry_guard_v1','guard_foobar_local_entry_v1',31,false,false),
 ('foobar_import_local_entries_v1','foobar_local_entry_account_v1','account_foobar_local_entry_v1',13,false,true),
 ('foobar_import_history_projection_v1','foobar_local_vector_complete_v1','check_foobar_local_vector_v1',21,true,false)
)
select (
 (select count(*) from rels)=2
 and current_setting('session_replication_role')='origin'
 and not exists(select 1 from pg_catalog.pg_inherits h join rels r on r.oid=h.inhrelid or r.oid=h.inhparent)
 and (select count(*) from rels r join pg_catalog.pg_attribute a on a.attrelid=r.oid
      where r.relname='foobar_import_local_entries_v1' and a.attnum>0 and not a.attisdropped)=10
 and not exists(select 1 from cols e where not exists(
  select 1 from rels r join pg_catalog.pg_attribute a on a.attrelid=r.oid
  join pg_catalog.pg_type t on t.oid=a.atttypid join pg_catalog.pg_namespace n on n.oid=t.typnamespace
  left join pg_catalog.pg_attrdef d on d.adrelid=r.oid and d.adnum=a.attnum
  where r.relname='foobar_import_local_entries_v1' and a.attname=e.name and a.attnum>0
  and not a.attisdropped and a.atttypmod=-1 and a.attidentity='' and a.attnotnull=e.required
  and n.nspname='pg_catalog' and t.typname=e.typ
  and a.attgenerated::text=case when e.generated='' then '' else 's' end
  and (e.generated='' or pg_catalog.pg_get_expr(d.adbin,d.adrelid)=e.generated)
  and pg_catalog.has_column_privilege(r.oid,a.attnum,'SELECT')))
 and not exists(select 1 from checks e where not exists(
  select 1 from rels r join pg_catalog.pg_constraint c on c.conrelid=r.oid
  where r.relname=e.tab and c.contype='c' and c.convalidated
  and (case when e.preserve_grouping then
      pg_catalog.pg_get_expr(c.conbin,c.conrelid)
      else lower(regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid),'[()[:space:]]','','g'))
      end)=e.expression))
 and not exists(select 1 from indexes e where not exists(
  select 1 from rels r join pg_catalog.pg_index i on i.indrelid=r.oid
  join pg_catalog.pg_class ix on ix.oid=i.indexrelid
  join pg_catalog.pg_namespace n on n.oid=ix.relnamespace join pg_catalog.pg_am am on am.oid=ix.relam
  where r.relname='foobar_import_local_entries_v1' and n.nspname='integration'
  and (e.is_primary or ix.relname=e.name) and ix.relkind='i' and ix.relpersistence='p'
  and am.amname='btree' and i.indisvalid and i.indisready and i.indislive and i.indimmediate
  and i.indisprimary=e.is_primary and i.indisunique=e.is_primary and not i.indisexclusion
  and i.indnkeyatts=5 and i.indnatts=5 and i.indexprs is null and i.indpred is null
  and array(select a.attname::text from unnest(i.indkey) with ordinality k(num,ord)
       join pg_catalog.pg_attribute a on a.attrelid=r.oid and a.attnum=k.num
       where not a.attisdropped order by ord)=string_to_array(e.cols,',')
  and array(select v from unnest(i.indoption) with ordinality k(v,ord) order by ord)=string_to_array(e.options,',')::smallint[]
  and array(select v from unnest(i.indcollation) with ordinality k(v,ord) order by ord)=array[0,0,0,0,0]::oid[]
  and array(select op.opcname::text from unnest(i.indclass) with ordinality k(num,ord)
       join pg_catalog.pg_opclass op on op.oid=k.num join pg_catalog.pg_namespace ns on ns.oid=op.opcnamespace
       where ns.nspname='pg_catalog' and op.opcmethod=am.oid and op.opcdefault order by ord)=string_to_array(e.ops,',')))
 and exists(select 1 from rels r join pg_catalog.pg_constraint c on c.conrelid=r.oid
  join rels h on h.oid=c.confrelid
  where r.relname='foobar_import_local_entries_v1' and h.relname='foobar_import_history_projection_v1'
  and c.contype='f' and c.convalidated and c.condeferrable and c.condeferred
  and c.confdeltype='c' and c.confupdtype='a' and c.confmatchtype='s'
  and array(select a.attname::text from unnest(c.conkey) with ordinality k(num,ord)
       join pg_catalog.pg_attribute a on a.attrelid=r.oid and a.attnum=k.num order by ord)
       =array['account_id','source_ref','observation_ref','source_revision']::text[]
  and array(select a.attname::text from unnest(c.confkey) with ordinality k(num,ord)
       join pg_catalog.pg_attribute a on a.attrelid=h.oid and a.attnum=k.num order by ord)
       =array['account_id','source_ref','observation_ref','source_revision']::text[]
  and not exists(select 1 from pg_catalog.pg_trigger t where t.tgconstraint=c.oid and t.tgenabled not in ('O','A')))
 and not exists(select 1 from triggers e where not exists(
  select 1 from rels r join pg_catalog.pg_trigger t on t.tgrelid=r.oid
  join pg_catalog.pg_proc p on p.oid=t.tgfoid join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  join pg_catalog.pg_language l on l.oid=p.prolang
  where r.relname=e.tab and t.tgname=e.name and t.tgtype=e.kind and t.tgenabled in ('O','A')
  and not t.tgisinternal and t.tgdeferrable=e.deferred and t.tginitdeferred=e.deferred
  and (t.tgconstraint<>0)=e.deferred and t.tgnargs=0 and t.tgqual is null
  and cardinality(t.tgattr::smallint[])=0 and n.nspname='integration' and p.proname=e.fn
  and p.pronargs=0 and p.pronargdefaults=0 and p.prokind='f' and not p.proretset
  and p.prosecdef=e.security_definer and not p.proisstrict and p.provolatile='v'
  and p.prorettype='pg_catalog.trigger'::regtype and l.lanname='plpgsql'
  and p.proconfig=array['search_path=pg_catalog']::text[]))
) as entries_ready,
(
 exists(select 1 from rels r where r.relname='foobar_import_local_entries_v1'
        and pg_catalog.has_table_privilege(r.oid,'DELETE'))
 and not exists(select 1 from cols e where e.generated='' and not exists(
  select 1 from rels r join pg_catalog.pg_attribute a on a.attrelid=r.oid
  where r.relname='foobar_import_local_entries_v1' and a.attname=e.name and not a.attisdropped
  and pg_catalog.has_column_privilege(r.oid,a.attnum,'INSERT')))
) as entries_writer_ready
"""


def require_enhanced_entries_on_connection(connection, *, for_write=False):
    try:
        if type(for_write) is not bool or not _SQL.isascii() or len(_SQL)>24576:
            raise SourceUnavailable()
        cursor=connection.execute(_SQL)
        try:
            rows=cursor.fetchmany(2)
        finally:
            cursor.close()
        if (type(rows) is not list or len(rows)!=1 or type(rows[0]) is not dict
                or set(rows[0])!={'entries_ready','entries_writer_ready'}
                or rows[0]['entries_ready'] is not True
                or type(rows[0]['entries_writer_ready']) is not bool
                or for_write and rows[0]['entries_writer_ready'] is not True):
            raise SourceUnavailable()
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
