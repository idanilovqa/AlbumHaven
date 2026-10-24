# Composition N2 reserves one additional deadline-wrapper parameter view.
# This is a logical forwarding owner, never an alias or zero-copy discount.
"""Admitted native size proof only; never a prepared receipt or prior decoder."""
from dataclasses import dataclass

from . import foobar_source_evidence as evidence
from . import foobar_account_source_lookup as lookup
from . import foobar_account_prepare_gate as gate
from .foobar_account_source_postgres import SourceUnavailable, SourceStale, _query


@dataclass(frozen=True, slots=True)
class MergedSourceSizes:
    """Effective sizes plus combined effective/raw semantic no-op proof."""

    ordinal: int
    evidence_bytes: int
    display_bytes: int
    evidence_unchanged: bool


def _base(count):
    if type(count) is not int or not 1 <= count <= 100:
        raise SourceUnavailable()
    return (8192 + 32768 + 2*(1024+128*count) + 2*(1024+64*count)
            + 3*lookup._prior_bound(count) + 1+6*count + gate.PREPARE_GATE_BYTES
            + 2*(1024+128*count))


def merged_source_size_phase_bytes(*, count, incoming_bytes, prior_bytes,
                                   prior_incoming_bytes, frame_bytes):
    if (type(incoming_bytes) is not int or not 1 <= incoming_bytes <= 4194304
            or type(prior_bytes) is not int or not 0 <= prior_bytes <= 4194304
            or type(prior_incoming_bytes) is not int or not 0 <= prior_incoming_bytes <= 4194304
            or type(frame_bytes) is not int or frame_bytes < 1):
        raise SourceUnavailable()
    if prior_bytes == 0 and prior_incoming_bytes != 0:
        raise SourceUnavailable()
    # Three native document/parser views: old effective, old raw and incoming.
    # The old raw payload is never synthesized from effective legacy evidence.
    return (_base(count) + 4*incoming_bytes + 8*frame_bytes + 4
            + 11*(prior_bytes+prior_incoming_bytes+incoming_bytes) + 768 + 3*4096)


_MERGED_SIZE_SQL = r'''
with frame as materialized (
 select convert_from(%b::bytea,'UTF8')::jsonb j
), settings as materialized (
 select current_setting('statement_timeout') st,
 current_setting('lock_timeout') lt,current_setting('transaction_isolation') isolation
), limits as materialized (
 select isolation='read committed'
 and (st='1s' or case when st ~ '^[1-9][0-9]{0,3}ms$'
     then substring(st from '^[0-9]+')::integer <= 1000 else false end)
 and case when lt ~ '^[1-9][0-9]{0,2}ms$'
     then substring(lt from '^[0-9]+')::integer <= 250 else false end valid
 from settings
), bound as materialized (
 select f.j, l.valid limits_valid,
 case when f.j->3='null'::jsonb then
   f.j->4='null'::jsonb and f.j->5='null'::jsonb and f.j->6='null'::jsonb
   and (f.j->>7)::bigint=0 and (f.j->>8)::bigint=0
   and f.j->16='null'::jsonb and (f.j->>17)::bigint=0
 else o.observation_ref is not null and r.observation_ref is not null
   and o.current_revision=(f.j->>4)::bigint
   and o.identity_kind=f.j->>10 and o.identity_sha256=decode(f.j->>11,'hex')
   and octet_length(o.identity_bytes)=(f.j->>12)::bigint
   and r.evidence_sha256=decode(f.j->>5,'hex')
   and r.display_sha256=decode(f.j->>6,'hex')
   and octet_length(r.evidence_bytes)=(f.j->>7)::bigint
   and octet_length(r.display_bytes)=(f.j->>8)::bigint
   and ((r.incoming_evidence_bytes is null and r.incoming_evidence_sha256 is null
       and f.j->16='null'::jsonb and (f.j->>17)::bigint=0)
     or (octet_length(r.incoming_evidence_bytes) between 1 and 4194304
       and r.incoming_evidence_sha256=decode(f.j->>16,'hex')
       and octet_length(r.incoming_evidence_bytes)=(f.j->>17)::bigint)) end association_valid
 from frame f cross join limits l
 left join integration.foobar_import_observations_v2 o on
 (o.account_id,o.source_ref,o.observation_ref)=
 ((f.j->>0)::bigint,(f.j->>2)::uuid,(f.j->>3)::uuid)
 left join integration.foobar_import_revisions_v2 r on
 (r.account_id,r.source_ref,r.observation_ref,r.source_revision)=
 (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
), raw_documents as materialized (
 select 0 kind, case when limits_valid and association_valid
 and (j->>7)::bigint between 0 and 4194304 and (j->>8)::bigint between 0 and 1048576
 then r.evidence_bytes end raw from bound b
 left join integration.foobar_import_revisions_v2 r on
 (r.account_id,r.source_ref,r.observation_ref,r.source_revision)=
 ((b.j->>0)::bigint,(b.j->>2)::uuid,(b.j->>3)::uuid,(b.j->>4)::bigint)
 union all
 select 1,case when limits_valid and association_valid
 and (j->>9)::bigint between 1 and 4194304
 and octet_length(j->>13)=2*(j->>9)::bigint
 then decode(j->>13,'hex') end from bound
 union all
 select 2,case when limits_valid and association_valid
 and (j->>17)::bigint between 1 and 4194304
 then r.incoming_evidence_bytes end from bound b
 left join integration.foobar_import_revisions_v2 r on
 (r.account_id,r.source_ref,r.observation_ref,r.source_revision)=
 ((b.j->>0)::bigint,(b.j->>2)::uuid,(b.j->>3)::uuid,(b.j->>4)::bigint)
), texts as materialized (
 select kind,convert_from(raw,'UTF8') txt from raw_documents
), stripped as materialized (
 select kind,txt,regexp_replace(txt,$lex$"([^"\\]|\\.)*"$lex$,'""','g') bare from texts
), lexical as materialized (
 select kind,txt,coalesce(
 bare !~ '[^\[\],0-9trufalsen"]' and bare !~ '[0-9]{20}'
 and length(bare)-length(replace(bare,'[','')) <= 56
 and length(bare)-length(replace(bare,',','')) <= 300,false) valid
 from stripped
), documents as materialized (
 select kind,valid,case when valid then txt::jsonb else null end doc from lexical
), root_checks as materialized (
 select kind,doc,coalesce(valid and case when jsonb_typeof(doc)='array'
 then jsonb_array_length(doc)=3 and doc->>0='foobar_source_evidence_v1'
 and doc->>1='foobar_text_tools_snapshot_v1'
 and case when jsonb_typeof(doc->2)='array' then jsonb_array_length(doc->2)=27
 else false end else false end,false) valid from documents
), fields as materialized (
 select d.kind,i,d.doc->2->i field,d.valid root_valid
 from root_checks d cross join generate_series(0,26) i
), checked_fields as materialized (
 select *,coalesce(root_valid and case when jsonb_typeof(field)='array'
 then jsonb_array_length(field)=5
 and field->>0 in ('absent','empty','unavailable','valid','invalid','unsupported')
 and case when field->>0='absent' then i<>0 and field->1='null'::jsonb
   and field->2='null'::jsonb and field->3='null'::jsonb and field->4='null'::jsonb
 else jsonb_typeof(field->1)='string' and octet_length(field->>1)<=16384
   and position(chr(9) in (field->>1))=0 and position(chr(10) in (field->>1))=0
   and position(chr(13) in (field->>1))=0
   and case jsonb_typeof(field->2)
     when 'null' then true when 'boolean' then true
     when 'number' then case when (field->>2) ~ '^(0|[1-9][0-9]{0,18})$'
       and length(field->>2)<=19 then (field->>2)::numeric<=9223372036854775807
       else false end
     when 'string' then octet_length(field->>2)<=16384 else false end
   and (field->3='null'::jsonb or (jsonb_typeof(field->3)='string' and octet_length(field->>3)<=64))
   and case when jsonb_typeof(field->4)='array' then jsonb_array_length(field->4)=3
      and jsonb_typeof(field->4->0)='string' and (field->4->>0) ~ '^[0-9a-f]{64}$'
      and case when jsonb_typeof(field->4->1)='number'
        and (field->4->>1) ~ '^[1-9][0-9]{0,5}$'
        then (field->4->>1)::numeric<=100000 else false end
      and case when jsonb_typeof(field->4->2)='number'
        and (field->4->>2) ~ '^(0|[1-9][0-9]?)$'
        then (field->4->>2)::numeric<=63 else false end else false end
 end else false end,false) valid
 from fields
), selected as materialized (
 select n.i,o.field old_field,n.field incoming_field,
 case when b.j->3<>'null'::jsonb and (n.field->>0 in ('absent','empty','unavailable') or
   (o.field->0=n.field->0 and o.field->1=n.field->1
    and o.field->2=n.field->2 and o.field->3=n.field->3))
 then o.field else n.field end field
 from checked_fields n join checked_fields o on o.i=n.i and o.kind=0
 cross join bound b where n.kind=1
), checks as materialized (
 select b.limits_valid,b.association_valid,
 (select bool_and(valid) from checked_fields where kind=1)
 and (b.j->3='null'::jsonb or (select bool_and(valid) from checked_fields where kind=0))
 and (b.j->16='null'::jsonb or (select bool_and(valid) from checked_fields where kind=2))
 and (select bool_and(field->>0='absent' or
      (field->4->>0=b.j->>14 and field->4->>1=b.j->>15))
      from checked_fields where kind=1)
 and (b.j->16='null'::jsonb or (select bool_and(a.field->>0='absent' or
      (a.field->4->0=p.field->4->0 and a.field->4->1=p.field->4->1))
      from checked_fields a join checked_fields p on p.kind=2 and p.i=0 where a.kind=2))
 and (select bool_and(field->>0 in ('absent','empty','valid')) from selected
      where i in (1,2,3,7,4,5,6)) shape_valid,
 not exists (select 1 from checked_fields a join checked_fields c
   on a.kind=c.kind and a.i<c.i and a.field->4<>'null'::jsonb
   and a.field->4->0=c.field->4->0 and a.field->4->2=c.field->4->2
   where a.kind=1 or (a.kind=0 and b.j->3<>'null'::jsonb)
     or (a.kind=2 and b.j->16<>'null'::jsonb))
 and not exists (select 1 from selected a join selected c on a.i<c.i
   and a.field->4<>'null'::jsonb and a.field->4->0=c.field->4->0
   and a.field->4->2=c.field->4->2) origin_unique,
 b.j->3<>'null'::jsonb and b.j->16<>'null'::jsonb
 and (select bool_and(old_field=field) from selected)
 and (select bool_and(o.field->0=n.field->0 and o.field->1=n.field->1
      and o.field->2=n.field->2 and o.field->3=n.field->3)
      from checked_fields n join checked_fields o on o.i=n.i and o.kind=2
      where n.kind=1) evidence_unchanged
 from bound b
), sizes as materialized (
 select (4 + octet_length(to_jsonb('foobar_source_evidence_v1'::text)::text)
  + octet_length(to_jsonb('foobar_text_tools_snapshot_v1'::text)::text) + 28
  + sum(6 + octet_length((field->0)::text) + octet_length((field->1)::text)
    + octet_length((field->2)::text) + octet_length((field->3)::text)
    + case when field->4='null'::jsonb then 4 else 4
       + octet_length((field->4->0)::text) + octet_length((field->4->1)::text)
       + octet_length((field->4->2)::text) end))::bigint evidence_bytes,
 (3 + octet_length(to_jsonb('foobar_source_display_v1'::text)::text) + 8
  + sum(3+octet_length((field->0)::text)+octet_length((field->1)::text))
    filter (where i in (1,2,3,7,4,5,6)))::bigint display_bytes
 from selected
)
select limits_valid,association_valid,coalesce(shape_valid,false) shape_valid,
 coalesce(origin_unique,false) origin_unique,coalesce(evidence_unchanged,false) evidence_unchanged,
 evidence_bytes,display_bytes from checks cross join sizes
'''


def _result(rows, ordinal):
    if type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict:
        raise SourceUnavailable()
    row = rows[0]
    flags = ('limits_valid', 'association_valid', 'shape_valid', 'origin_unique', 'evidence_unchanged')
    if set(row) != set(flags) | {'evidence_bytes', 'display_bytes'}:
        raise SourceUnavailable()
    if any(type(row[name]) is not bool for name in flags):
        raise SourceUnavailable()
    if not row['limits_valid']:
        raise SourceUnavailable()
    if not row['association_valid']:
        raise SourceStale()
    if not row['shape_valid'] or not row['origin_unique']:
        raise SourceUnavailable()
    if any(type(row[name]) is not int or not 1 <= row[name] <= 16777216
           for name in ('evidence_bytes', 'display_bytes')):
        raise SourceUnavailable()
    if row['evidence_bytes'] > 4194304 or row['display_bytes'] > 1048576:
        return None
    return MergedSourceSizes(ordinal, row['evidence_bytes'], row['display_bytes'], row['evidence_unchanged'])


def size_foobar_source_merge_on_connection(
    connection, live_context, *, command, ticket, lookup_result, index,
    incoming_payload, constraints=None,
):
    """Return size record or internal prefix-stop None, never public readiness.

    Incoming bytes MUST come from admitted evidence.encode_evidence on the real
    current selected row; its original field tuple remains charged and unmerged.
    Native prior effective AND raw documents are charged before projection. No
    prior application bytes or previous variable row outputs are allowed at entry.
    """
    gate.validate_prepare_command(command)
    try:
        lookup._admit(8192+32768)
        if (type(lookup_result) is not lookup.SourceLookupScalars
                or type(index) is not int or not 0 <= index < len(lookup_result.prior)
                or type(incoming_payload) is not bytes or not 1 <= len(incoming_payload) <= 4194304
                or type(ticket) is not gate.FoobarPrepareTicket or ticket.disposition != 'new'):
            raise SourceUnavailable()
        n = len(lookup_result.identities)
        item, prior = lookup_result.identities[index], lookup_result.prior[index]
        if (type(item) is not lookup.SourceIdentityScalar or type(prior) is not lookup.PriorSourceScalar
                or item.ordinal != command.offset+index+1 or prior.ordinal != item.ordinal):
            raise SourceUnavailable()
        actor = live_context.actor
        fixed = (actor.account_id,live_context.library_id,command.source_ref,
                 prior.observation_ref,prior.source_revision,prior.evidence_sha256,
                 prior.display_sha256,prior.evidence_bytes,prior.display_bytes,
                 len(incoming_payload),item.identity_kind,item.identity_sha256,item.identity_bytes,
                 command.upload_sha256,item.ordinal,
                 prior.incoming_evidence_sha256,prior.incoming_evidence_bytes)
        frame_size = evidence._json_size(fixed)+2*len(incoming_payload)+3
        required = merged_source_size_phase_bytes(
            count=n,incoming_bytes=len(incoming_payload),prior_bytes=prior.evidence_bytes,
            prior_incoming_bytes=prior.incoming_evidence_bytes,
            frame_bytes=frame_size,
        )
        if required > 4194304:
            return None
        fresh = gate.begin_foobar_prepare_on_connection(
            connection,live_context,command=command,constraints=constraints,
        )
        if (fresh.disposition != 'new' or fresh.command_sha256 != ticket.command_sha256
                or fresh.observed_at < ticket.observed_at):
            raise SourceUnavailable()
        values = list(fixed)
        values.insert(13, incoming_payload.hex())
        frame = lookup._encode(values)
        del values
        if len(frame) != frame_size:
            raise SourceUnavailable()
        rows = _query(connection,_MERGED_SIZE_SQL,frame,maximum=1)
        result = _result(rows,item.ordinal)
        del rows,frame
        final = gate.begin_foobar_prepare_on_connection(
            connection,live_context,command=command,constraints=constraints,
        )
        if (final.disposition != 'new' or final.command_sha256 != fresh.command_sha256
                or final.observed_at < fresh.observed_at):
            raise SourceUnavailable()
        return result
    except (SourceUnavailable, gate.PrepareInvalid):
        raise
    except Exception as exc:
        raise SourceUnavailable() from exc
