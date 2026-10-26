"""Serial compact projection maintenance owned by the genuine source writer.

No independent transaction, backfill, commit, public mutation or trusted flag.
Caller must have verified the exact current source postimage under source lock.
"""
import hashlib
import json

from . import foobar_account_history_projection as codec
from .foobar_source_postgres import SourceUnavailable
from .foobar_account_history_readiness import HISTORY_SCHEMA_PHASE_BYTES

MAX_HISTORY_FRAME_BYTES = 18432
HISTORY_WRITE_CONTROL_BYTES = 65536


def history_write_phase_bytes(*, base, frame_size, result_size,
                              maximum_evidence, maximum_display):
    """Genuine scalar owner shared by writer AND Prepare/Apply/finalizer planners.

    Source original/frame/outcomes remain owned across the serial hook. Charge
    all six source frame views, both source result views, then the larger of
    schema, actual-size codec construction, and one bounded projection SQL phase.
    No batch-sized compact payload tuple is ever allocated.
    """
    retained = base + 6*frame_size + 4 + 2*result_size
    return retained + max(HISTORY_SCHEMA_PHASE_BYTES,
        codec.projection_phase_bytes(maximum_evidence, maximum_display),
        8*MAX_HISTORY_FRAME_BYTES + 8*codec.MAX_PROJECTION_BYTES
            + codec.projection_decode_phase_bytes(codec.MAX_PROJECTION_BYTES)
            + HISTORY_WRITE_CONTROL_BYTES)


def individual_last_present(family):
    """Zero-count diagnostic is not a listen; zero remainder after a marker is absent."""
    return (family.aggregate_remainder is None or family.aggregate_remainder>0
            or family.total==0)


def projection_columns(projection):
    return (projection.standard.first_sort_key, projection.standard.grouped_sort_key,
            projection.enhanced.first_sort_key, projection.enhanced.grouped_sort_key,
            individual_last_present(projection.standard), individual_last_present(projection.enhanced))


def _query_one(connection, sql, frame):
    cursor = connection.execute(sql, (frame,), binary=True)
    try:
        rows = cursor.fetchmany(2)
        if type(rows) is not list or len(rows)!=1 or type(rows[0]) is not dict:
            raise SourceUnavailable()
        return rows[0]
    finally:
        cursor.close()


_FRAME_SQL = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::uuid source_ref,
(j->>2)::uuid observation_ref,(j->>3)::bigint source_revision,j from f)
"""
_UPSERT_SQL = _FRAME_SQL + """
insert into integration.foobar_import_history_projection_v1 as p
(account_id,source_ref,observation_ref,source_revision,effective_evidence_sha256,display_sha256,
 standard_first,standard_last,enhanced_first,enhanced_last,standard_last_present,enhanced_last_present,projection_bytes)
select x.account_id,x.source_ref,x.observation_ref,x.source_revision,r.evidence_sha256,r.display_sha256,
 (j->>6)::bigint,(j->>7)::bigint,(j->>8)::bigint,(j->>9)::bigint,(j->>10)::boolean,(j->>11)::boolean,
 decode(j->>12,'hex')
from x join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
  =(x.account_id,x.source_ref,x.observation_ref,x.source_revision)
join integration.foobar_import_revisions_v2 r
 on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
  =(x.account_id,x.source_ref,x.observation_ref,x.source_revision)
where r.evidence_sha256=decode(j->>4,'hex') and r.display_sha256=decode(j->>5,'hex')
on conflict (account_id,source_ref,observation_ref) do update set
 source_revision=excluded.source_revision,effective_evidence_sha256=excluded.effective_evidence_sha256,
 display_sha256=excluded.display_sha256,standard_first=excluded.standard_first,standard_last=excluded.standard_last,
 enhanced_first=excluded.enhanced_first,enhanced_last=excluded.enhanced_last,
 standard_last_present=excluded.standard_last_present,enhanced_last_present=excluded.enhanced_last_present,
 projection_bytes=excluded.projection_bytes
returning observation_ref::text observation_ref
"""
_VERIFY_SQL = _FRAME_SQL + """
select p.source_revision,p.projection_bytes,encode(p.projection_sha256,'hex') projection_sha256,
 encode(p.effective_evidence_sha256,'hex') effective_evidence_sha256,encode(p.display_sha256,'hex') display_sha256,
 p.standard_first,p.standard_last,p.enhanced_first,p.enhanced_last,p.standard_last_present,p.enhanced_last_present,
 o.current_revision,encode(r.evidence_sha256,'hex') current_effective_sha256,
 encode(r.display_sha256,'hex') current_display_sha256
from x left join integration.foobar_import_history_projection_v1 p
 on (p.account_id,p.source_ref,p.observation_ref)=(x.account_id,x.source_ref,x.observation_ref)
left join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.observation_ref)=(x.account_id,x.source_ref,x.observation_ref)
left join integration.foobar_import_revisions_v2 r
 on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
  =(o.account_id,o.source_ref,o.observation_ref,o.current_revision)
"""

_BINDING_KEYS = frozenset(('source_revision','projection_bytes','projection_sha256',
    'effective_evidence_sha256','display_sha256','standard_first','standard_last',
    'enhanced_first','enhanced_last','standard_last_present','enhanced_last_present',
    'current_revision','current_effective_sha256','current_display_sha256'))


def decode_bound_projection(row, *, expected_revision=None):
    """Strict compact decode and CURRENT source binding, including indexed eligibility.

    Caller supplies an actual bounded repository row, never public request data.
    No raw effective/display payload or path is fetched for the history reader.
    """
    if type(row) is not dict or set(row)!=_BINDING_KEYS:
        raise SourceUnavailable()
    payload = row['projection_bytes']
    if type(payload) is not bytes or not 1<=len(payload)<=codec.MAX_PROJECTION_BYTES:
        raise SourceUnavailable()
    if hashlib.sha256(payload).hexdigest()!=row['projection_sha256']:
        raise SourceUnavailable()
    projection = codec.decode_account_history_projection(payload)
    if (type(row['source_revision']) is not int or type(row['current_revision']) is not int
            or row['source_revision']!=row['current_revision']
            or projection.source_revision!=row['source_revision']
            or expected_revision is not None and row['source_revision']!=expected_revision
            or projection.effective_evidence_sha256!=row['effective_evidence_sha256']
            or projection.display_sha256!=row['display_sha256']
            or row['effective_evidence_sha256']!=row['current_effective_sha256']
            or row['display_sha256']!=row['current_display_sha256']):
        raise SourceUnavailable()
    names = ('standard_first','standard_last','enhanced_first','enhanced_last',
             'standard_last_present','enhanced_last_present')
    expected = projection_columns(projection)
    for name, value in zip(names, expected):
        if type(row[name]) is not type(value) or row[name]!=value:
            raise SourceUnavailable()
    return projection


def maintain_current_history_on_connection(connection, *, account_id, source_ref,
                                           expected_revision, items, changed):
    """Called only after genuine writer postcheck, within its existing savepoint.

    Changed inputs are byte-identical to the just-persisted effective/display
    source postimage. SQL additionally fences their persisted current digests.
    A semantic no-op instead verifies retained projection bytes against actual
    current persisted hashes/revision, never regenerating from incoming origins.
    """
    if type(changed) is not tuple or len(changed)!=len(items):
        raise SourceUnavailable()
    for item, change in zip(items, changed):
        if type(change) is not bool:
            raise SourceUnavailable()
        revision = expected_revision+1 if change else item.previous_revision
        if change:
            projection = codec.build_account_history_projection(
                effective_evidence_bytes=item.evidence_bytes, display_bytes=item.display_bytes,
                source_revision=revision)
            payload = codec.encode_account_history_projection(projection)
            fields = (account_id,source_ref,item.observation_ref,revision,
                      projection.effective_evidence_sha256,projection.display_sha256,
                      *projection_columns(projection),payload.hex())
            frame = json.dumps(fields,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
            if len(frame)>MAX_HISTORY_FRAME_BYTES:
                raise SourceUnavailable()
            row = _query_one(connection,_UPSERT_SQL,frame)
            if set(row)!={'observation_ref'} or row['observation_ref']!=item.observation_ref:
                raise SourceUnavailable()
            del fields, frame, payload, projection, row
        frame = json.dumps((account_id,source_ref,item.observation_ref,revision),
                           separators=(',',':'),allow_nan=False).encode('ascii')
        row = _query_one(connection,_VERIFY_SQL,frame)
        projection = decode_bound_projection(row, expected_revision=revision)
        del projection, row, frame


def history_capacity_phase_bytes(maximum_evidence, maximum_display):
    """Serial quota decode, including both actual-sized prepared hex decodes."""
    return (2*(maximum_evidence+maximum_display)
            + history_write_phase_bytes(base=0,frame_size=0,result_size=0,
                maximum_evidence=maximum_evidence,maximum_display=maximum_display))


_OLD_SIZE_SQL = _FRAME_SQL + """
select p.source_revision,octet_length(p.projection_bytes)::bigint projection_size,
 encode(p.effective_evidence_sha256,'hex') effective_evidence_sha256,
 encode(p.display_sha256,'hex') display_sha256,o.current_revision,
 encode(r.evidence_sha256,'hex') current_effective_sha256,
 encode(r.display_sha256,'hex') current_display_sha256
from x left join integration.foobar_import_history_projection_v1 p
 on (p.account_id,p.source_ref,p.observation_ref)=(x.account_id,x.source_ref,x.observation_ref)
left join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.observation_ref)=(x.account_id,x.source_ref,x.observation_ref)
left join integration.foobar_import_revisions_v2 r
 on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
  =(o.account_id,o.source_ref,o.observation_ref,o.current_revision)
"""


def projection_quota_delta_on_connection(connection, *, account_id, source_ref,
                                        expected_revision, original_rows, source_changes):
    """Exact signed replacement bytes and ordered peak for shared capacity gate.

    Caller admits history_capacity_phase_bytes from actual verified original
    lengths BEFORE entry. Source changes are the genuine prepared-source verifier
    decisions. Unchanged/committed replay paths never rebuild or charge a row.
    """
    if type(source_changes) is not tuple or len(source_changes)!=len(original_rows):
        raise SourceUnavailable()
    from .foobar_account_history_readiness import require_foobar_history_on_connection
    require_foobar_history_on_connection(connection, for_write=True)
    delta = peak = 0
    for original, changed in zip(original_rows,source_changes):
        if type(changed) is not bool:
            raise SourceUnavailable()
        if not changed:
            continue
        previous_size = 0
        if original[3] is not None:
            frame = json.dumps((account_id,source_ref,original[2],original[3]),
                               separators=(',',':')).encode('ascii')
            old = _query_one(connection,_OLD_SIZE_SQL,frame)
            if (set(old)!={'source_revision','projection_size','effective_evidence_sha256','display_sha256',
                          'current_revision','current_effective_sha256','current_display_sha256'}
                    or type(old['projection_size']) is not int
                    or not 1<=old['projection_size']<=codec.MAX_PROJECTION_BYTES
                    or type(old['source_revision']) is not int or type(old['current_revision']) is not int
                    or old['source_revision']!=original[3] or old['current_revision']!=original[3]
                    or old['effective_evidence_sha256']!=original[4]
                    or old['display_sha256']!=original[5]
                    or old['current_effective_sha256']!=original[4]
                    or old['current_display_sha256']!=original[5]):
                raise SourceUnavailable()
            previous_size = old['projection_size']
            del old,frame
        effective, display_bytes = bytes.fromhex(original[7]),bytes.fromhex(original[8])
        projection = codec.build_account_history_projection(effective_evidence_bytes=effective,
            display_bytes=display_bytes,source_revision=expected_revision+1)
        payload = codec.encode_account_history_projection(projection)
        delta += len(payload)-previous_size
        peak = max(peak,delta)
        del effective,display_bytes,projection,payload
    return delta,peak

