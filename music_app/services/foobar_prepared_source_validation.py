# Composition N2 reserves one additional deadline-wrapper parameter view.
# This is a logical forwarding owner, never an alias or zero-copy discount.
"""Actual immutable-prior source validation, not receipt or commit success."""
import hashlib
import json
from . import foobar_source_evidence as evidence
from . import foobar_source_display as display
from . import foobar_prepared_envelope as envelope
from .foobar_source_postgres import SourceUnavailable, _authority, _query
from .track_preferences_postgres import _foobar_taste_connection, _foobar_taste_context

MAX_BYTES = 4_194_304
CONTROL_BYTES = 8192

_PREFIX = """with frame as materialized (
 select convert_from(%b::bytea,'UTF8')::jsonb j), scope as materialized (
 select (j->>0)::bigint account_id,(j->>1)::bigint library_id,
 (j->>2)::uuid source_ref,(j->>3)::uuid observation_ref,
 (j->>4)::bigint source_revision,decode(j->>5,'hex') evidence_sha256,
 decode(j->>6,'hex') display_sha256,j from frame)
"""
_JOIN = """ from scope x join integration.foobar_import_observations o
 on (o.account_id,o.library_id,o.source_ref,o.observation_ref)
  =(x.account_id,x.library_id,x.source_ref,x.observation_ref)
 join integration.foobar_import_revisions r
 on (r.account_id,r.library_id,r.source_ref,r.observation_ref,r.source_revision)
  =(x.account_id,x.library_id,x.source_ref,x.observation_ref,x.source_revision)
 where r.evidence_sha256=x.evidence_sha256 and r.display_sha256=x.display_sha256
"""
_SCALAR_SQL = _PREFIX + """select octet_length(o.identity_bytes) identity_bytes_size,
 octet_length(r.evidence_bytes) evidence_bytes_size,
 octet_length(r.display_bytes) display_bytes_size,encode(o.identity_sha256,'hex') identity_sha256,
 coalesce(octet_length(r.incoming_evidence_bytes),0) incoming_evidence_bytes_size,
 encode(r.incoming_evidence_sha256,'hex') incoming_evidence_sha256,
 case when o.identity_kind in ('path','occurrence') then o.identity_kind else null end identity_kind
""" + _JOIN + ";"
_RAW_SQL = _PREFIX + """select o.identity_bytes,r.evidence_bytes,r.display_bytes,r.incoming_evidence_bytes
""" + _JOIN + """ and octet_length(o.identity_bytes)=(x.j->>7)::integer
 and octet_length(r.evidence_bytes)=(x.j->>8)::integer
 and octet_length(r.display_bytes)=(x.j->>9)::integer
 and o.identity_sha256=decode(x.j->>10,'hex') and o.identity_kind=x.j->>11
 and coalesce(octet_length(r.incoming_evidence_bytes),0)=(x.j->>12)::integer
 and r.incoming_evidence_sha256 is not distinct from decode(x.j->>13,'hex');"""


def _phase_bytes(*, prepared_bytes, identity_bytes, incoming_bytes, merged_bytes,
                 display_bytes, prior_identity_bytes, prior_bytes, prior_display_bytes, prior_incoming_bytes, frame_bytes):
    values = (prepared_bytes,identity_bytes,incoming_bytes,merged_bytes,display_bytes,
              prior_identity_bytes,prior_bytes,prior_display_bytes,frame_bytes)
    if any(type(value) is not int or value < 0 for value in values) or not all(values[:5]):
        raise SourceUnavailable()
    p,i,n,m,s,ip,o,d,f = values
    if (p > MAX_BYTES or i > evidence.MAX_IDENTITY_BYTES
            or n > evidence.MAX_EVIDENCE_BYTES or m > evidence.MAX_EVIDENCE_BYTES
            or s > display.MAX_BYTES or ip > evidence.MAX_IDENTITY_BYTES
            or o > evidence.MAX_EVIDENCE_BYTES or d > display.MAX_BYTES or not 1 <= f <= 1024
            or bool(ip) != bool(o) or bool(o) != bool(d)):
        raise SourceUnavailable()
    if type(prior_incoming_bytes) is not int or not 0 <= prior_incoming_bytes <= evidence.MAX_EVIDENCE_BYTES:
        raise SourceUnavailable()
    base = 5*p+CONTROL_BYTES+10*prior_incoming_bytes+evidence.CLASSIFIER_WORK_BYTES
    classifier = evidence.CLASSIFIER_WORK_BYTES+128
    return max(
        envelope.prepared_envelope_phase_bytes(p,decode=True),
        base+10*f+4+1024,
        base+8*i+classifier,
        base+2*i+8*n+classifier,
        base+2*i+n+10*f+4+4*(ip+o+d)+1024,
        base+i+n+d+8*o+classifier,
        base+i+n+o+6*d+classifier,
        base+i+3*(o+n)+classifier,
        base+i+o+n+5*m+classifier,
        base+i+o+n+m+6*s+classifier,
    )


def _frame_values(header,row):
    return (header[0],header[1],header[3],row[2],row[3],row[4],row[5])


def _encode_frame(values):
    # Fixed bounded controls only; admitted before this text/bytes allocation.
    return json.dumps(values,ensure_ascii=True,separators=(',',':')).encode('ascii')


def _one(connection,sql,frame,keys):
    rows = _query(connection,sql,frame,maximum=1)
    if len(rows) != 1 or type(rows[0]) is not dict or set(rows[0]) != keys:
        raise SourceUnavailable()
    return rows[0]


def _scalar(row):
    limits = (('identity_bytes_size',evidence.MAX_IDENTITY_BYTES),
              ('evidence_bytes_size',evidence.MAX_EVIDENCE_BYTES),('display_bytes_size',display.MAX_BYTES))
    for name,limit in limits:
        if type(row[name]) is not int or not 1 <= row[name] <= limit:
            raise SourceUnavailable()
    evidence._digest(row['identity_sha256'])
    if type(row['identity_kind']) is not str or row['identity_kind'] not in ('path','occurrence'):
        raise SourceUnavailable()
    raw_size,raw_hash = row['incoming_evidence_bytes_size'],row['incoming_evidence_sha256']
    if type(raw_size) is not int or not 0 <= raw_size <= evidence.MAX_EVIDENCE_BYTES:
        raise SourceUnavailable()
    if raw_size == 0:
        if raw_hash is not None:
            raise SourceUnavailable()
    else:
        evidence._digest(raw_hash)
    return (row['identity_bytes_size'],row['evidence_bytes_size'],row['display_bytes_size'],
            row['identity_sha256'],row['identity_kind'],raw_size,raw_hash)


def _identity_fields(identity,fields):
    if identity[0] == 'path':
        if identity[1] != fields[0][1]:
            raise SourceUnavailable()
    elif (identity[0] != 'occurrence' or fields[0][4] is None or identity[1] != fields[0][4][0]
          or int(identity[2]) != fields[0][4][1]):
        raise SourceUnavailable()


def _incoming(fields,header,row):
    for field in fields:
        if field[0] != 'absent' and (field[4] is None or field[4][0] != header[8]
                                    or field[4][1] != row[0]):
            raise SourceUnavailable()
    rating = fields[evidence.parser.FIELD_NAMES.index('rating')]
    favorite = fields[evidence.parser.FIELD_NAMES.index('favorite')]
    if row[10] is not None and (rating[0] != 'valid' or type(rating[2]) is not int or row[10] != rating[2]):
        raise SourceUnavailable()
    if row[11] and (favorite[0] != 'valid' or favorite[2] is not True):
        raise SourceUnavailable()


CLASSIFICATION_BYTES = 2048  # At most100 list/tuple bool occurrences plus loop state.


def validate_prepared_sources_on_connection(connection,live_context,*,original_value,
                                            original_command,expected_header,constraints=None):
    """Verify source identities/evidence/merge/display against immutable priors.

    Caller owns trusted digest verification, full compound admission, real locks,
    whole-upload/header/ambiguity provenance and all later current-pointer checks.
    This function emits no public response and performs no mutation.
    """
    try:
        _foobar_taste_connection(connection)
        _foobar_taste_context(live_context)
        prepared_bytes = evidence._json_size(original_value)
        if envelope.prepared_envelope_phase_bytes(prepared_bytes,decode=True)+CLASSIFICATION_BYTES > MAX_BYTES:
            raise SourceUnavailable()
        envelope._validate(original_value,original_command=original_command,expected_header=expected_header)
        changes = []
        header = original_value[1]
        if header[:3] != (live_context.actor.account_id,live_context.library_id,live_context.actor.session_id):
            raise SourceUnavailable()
        _authority(live_context,constraints)
        for row in original_value[2]:
            i,n,m,s = (len(row[index])//2 for index in (1,6,7,8))
            controls = _frame_values(header,row)
            scalar_frame_size = evidence._json_size(controls)
            # No previous variable source bytes are projected by this first query.
            if 5*prepared_bytes+CLASSIFICATION_BYTES+CONTROL_BYTES+10*scalar_frame_size+4+1024 > MAX_BYTES:
                raise SourceUnavailable()
            if row[3] is None:
                ip=o=d=prior_incoming_size=0
                prior_incoming_hash = None
                prior_hash = prior_kind = None
                full_controls = controls
            else:
                frame = _encode_frame(controls)
                scalar = _one(connection,_SCALAR_SQL,frame,{
                    'identity_bytes_size','evidence_bytes_size','display_bytes_size','identity_sha256','identity_kind',
                    'incoming_evidence_bytes_size','incoming_evidence_sha256'})
                del frame
                ip,o,d,prior_hash,prior_kind,prior_incoming_size,prior_incoming_hash = _scalar(scalar)
                del scalar
                if ip != i:
                    raise SourceUnavailable()
                full_controls = controls+(ip,o,d,prior_hash,prior_kind,prior_incoming_size,prior_incoming_hash)
            frame_size = evidence._json_size(full_controls)
            if _phase_bytes(prepared_bytes=prepared_bytes,identity_bytes=i,incoming_bytes=n,
                merged_bytes=m,display_bytes=s,prior_identity_bytes=ip,prior_bytes=o,
                prior_display_bytes=d,prior_incoming_bytes=prior_incoming_size,frame_bytes=frame_size)+CLASSIFICATION_BYTES > MAX_BYTES:
                raise SourceUnavailable()
            identity_bytes = bytes.fromhex(row[1])
            identity = evidence.decode_identity(identity_bytes)
            if prior_kind is not None and identity[0] != prior_kind:
                raise SourceUnavailable()
            incoming_bytes = bytes.fromhex(row[6])
            incoming = evidence.decode_evidence(incoming_bytes)
            del incoming_bytes
            _incoming(incoming,header,row)
            _identity_fields(identity,incoming)
            previous = previous_incoming = None
            if row[3] is not None:
                frame = _encode_frame(full_controls)
                raw = _one(connection,_RAW_SQL,frame,{'identity_bytes','evidence_bytes','display_bytes','incoming_evidence_bytes'})
                del frame
                old_identity,old_evidence,old_display = raw['identity_bytes'],raw['evidence_bytes'],raw['display_bytes']
                old_incoming = raw['incoming_evidence_bytes']
                del raw
                if (type(old_identity) is not bytes or type(old_evidence) is not bytes
                        or type(old_display) is not bytes or (len(old_identity),len(old_evidence),len(old_display)) != (ip,o,d)
                        or old_identity != identity_bytes
                        or hashlib.sha256(old_identity).hexdigest() != prior_hash
                        or hashlib.sha256(old_evidence).hexdigest() != row[4]
                        or hashlib.sha256(old_display).hexdigest() != row[5]):
                    raise SourceUnavailable()
                del old_identity,identity_bytes
                if prior_incoming_size == 0:
                    if old_incoming is not None:
                        raise SourceUnavailable()
                elif (type(old_incoming) is not bytes or len(old_incoming) != prior_incoming_size
                      or hashlib.sha256(old_incoming).hexdigest() != prior_incoming_hash):
                    raise SourceUnavailable()
                else:
                    previous_incoming = evidence.decode_evidence(old_incoming)
                    _identity_fields(identity,previous_incoming)
                del old_incoming
                previous = evidence.decode_evidence(old_evidence)
                del old_evidence
                _identity_fields(identity,previous)
                display.check_display(old_display,previous)
                del old_display
            else:
                del identity_bytes
            if evidence.merged_evidence_size(previous,incoming) != m:
                raise SourceUnavailable()
            merged = evidence.merge_fields(previous,incoming)
            changed = not evidence.same_observation(previous_incoming,incoming) or previous is None or not all(
                evidence._same(old[k],new[k]) for old,new in zip(previous,merged) for k in range(5))
            encoded = evidence.encode_evidence(merged)
            expected_merged = bytes.fromhex(row[7])
            if encoded != expected_merged:
                raise SourceUnavailable()
            del encoded,expected_merged
            if display.display_size(merged) != s:
                raise SourceUnavailable()
            expected_display = bytes.fromhex(row[8])
            display.check_display(expected_display,merged)
            changes.append(changed)
            del expected_display,merged,previous,previous_incoming,incoming,identity,controls,full_controls
        _authority(live_context,constraints)
        return tuple(changes)
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
