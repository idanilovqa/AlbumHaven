# Composition N2 reserves one additional deadline-wrapper parameter view.
# This is a logical forwarding owner, never an alias or zero-copy discount.
"""Account-owned v2 source batch on the genuine caller-owned transaction.

Not Prepare/Apply, not a commit receipt. The outer caller owns original decisions,
receipt/replay, final stream revision, separately authorized local taste, and
whole-command rollback. This is not wired to legacy Prepare/Apply.
"""
from dataclasses import dataclass
import json

from . import foobar_source_evidence as evidence
from . import foobar_source_display as display
from . import foobar_account_history_projection_writer as history
from . import foobar_enhanced_source_evidence as enhanced
from . import foobar_enhanced_entry_postgres as enhanced_history
from .foobar_account_history_readiness import require_foobar_history_on_connection
from .foobar_source_postgres import SourceUnavailable, SourceStale
from .foobar_account_authority import account_foobar_context, require_account_foobar
from .track_preferences_postgres import (
    _foobar_taste_connection, _foobar_taste_uuid,
)


MAX_PHASE_BYTES = 4_194_304
MAX_ROWS = 100
MAX_REVISION = 9_223_372_036_854_775_807


class FoobarSourceCapacityExceeded(SourceUnavailable):
    """Known persistent count/byte/ordered-peak quota rejection, never retryable."""
    code = 'foobar_source_quota_exceeded'
    status_code = 409
    retryable = False

    def __init__(self):
        ValueError.__init__(self, 'Source storage or count capacity would be exceeded while saving this import.')


@dataclass(frozen=True, slots=True)
class SourceWrite:
    observation_ref: str
    identity_bytes: bytes
    previous_revision: int | None
    previous_evidence_sha256: str | None
    previous_display_sha256: str | None
    evidence_bytes: bytes
    display_bytes: bytes
    incoming_evidence_bytes: bytes


@dataclass(frozen=True, slots=True)
class SourceWriteOutcome:
    observation_ref: str
    source_changed: bool
    source_revision: int
    incoming_evidence_sha256: str


def _kind(item):
    if item.identity_bytes.startswith(b'["store_key",'):
        return "store_key"
    return "path" if item.identity_bytes.startswith(b'["path",') else "occurrence"


def source_write_phase_bytes(items, *, account_id, source_ref, generation, expected_revision):
    """Preallocation scalar gate; no decoding or hex/JSON frame construction."""
    if type(items) is not tuple or not 1 <= len(items) <= MAX_ROWS:
        raise SourceUnavailable()
    _foobar_taste_uuid(source_ref)
    for value in (account_id,):
        if type(value) is not int or not 1 <= value <= MAX_REVISION:
            raise SourceUnavailable()
    if type(generation) is not int or not 1 <= generation <= 2147483647:
        raise SourceUnavailable()
    if type(expected_revision) is not int or not 0 <= expected_revision <= MAX_REVISION:
        raise SourceUnavailable()
    raw = row_sizes = maximum_evidence = maximum_identity = maximum_display = 0
    maximum_incoming_evidence = 0
    for index, item in enumerate(items):
        if type(item) is not SourceWrite:
            raise SourceUnavailable()
        if index and (_kind(item)=="store_key")!=(_kind(items[0])=="store_key"):
            raise SourceUnavailable()
        _foobar_taste_uuid(item.observation_ref)
        for value, limit in ((item.identity_bytes, evidence.MAX_IDENTITY_BYTES),
                             (item.evidence_bytes, evidence.MAX_EVIDENCE_BYTES),
                             (item.display_bytes, display.MAX_BYTES),
                             (item.incoming_evidence_bytes, evidence.MAX_EVIDENCE_BYTES)):
            if type(value) is not bytes or not 1 <= len(value) <= limit:
                raise SourceUnavailable()
            raw += len(value)
        if item.previous_revision is None:
            if item.previous_evidence_sha256 is not None or item.previous_display_sha256 is not None:
                raise SourceUnavailable()
        else:
            if type(item.previous_revision) is not int or not 1 <= item.previous_revision <= expected_revision:
                raise SourceUnavailable()
            evidence._digest(item.previous_evidence_sha256)
            evidence._digest(item.previous_display_sha256)
        for previous_index in range(index):
            previous = items[previous_index]
            if previous.observation_ref == item.observation_ref or previous.identity_bytes == item.identity_bytes:
                raise SourceUnavailable()
        # Nine ordered row members; the original eight indices are unchanged.
        row_sizes += 2 + 8 + 38 + evidence._json_size(_kind(item))
        row_sizes += evidence._json_size(item.previous_revision)
        row_sizes += evidence._json_size(item.previous_evidence_sha256) + evidence._json_size(item.previous_display_sha256)
        row_sizes += 2 * (len(item.identity_bytes) + len(item.evidence_bytes)
                         + len(item.display_bytes) + len(item.incoming_evidence_bytes)) + 8
        maximum_identity = max(maximum_identity, len(item.identity_bytes))
        maximum_evidence = max(maximum_evidence, len(item.evidence_bytes))
        maximum_display = max(maximum_display, len(item.display_bytes))
        maximum_incoming_evidence = max(maximum_incoming_evidence, len(item.incoming_evidence_bytes))
    return _source_write_phase_from_sizes(
        count=len(items),raw=raw,row_sizes=row_sizes,maximum_identity=maximum_identity,
        maximum_evidence=maximum_evidence,maximum_display=maximum_display,
        maximum_incoming_evidence=maximum_incoming_evidence,
        enhanced_format=_kind(items[0])=="store_key",
        scope_size=evidence._json_size((account_id,source_ref,generation,expected_revision,())),
    )


def _source_write_phase_from_sizes(*,count,raw,row_sizes,maximum_identity,
                                   maximum_evidence,maximum_display,maximum_incoming_evidence,scope_size,
                                   enhanced_format=False):
    """Private arithmetic over genuine validated source sizes, not admission."""
    if (type(enhanced_format) is not bool or type(count) is not int or not 1 <= count <= MAX_ROWS
            or any(type(v) is not int or v < 1 for v in (raw,row_sizes,maximum_identity,
                maximum_evidence,maximum_display,maximum_incoming_evidence,scope_size))
            or maximum_identity > evidence.MAX_IDENTITY_BYTES
            or maximum_evidence > evidence.MAX_EVIDENCE_BYTES
            or maximum_incoming_evidence > evidence.MAX_EVIDENCE_BYTES
            or maximum_display > display.MAX_BYTES or scope_size > 256):
        raise SourceUnavailable()
    frame = scope_size+row_sizes+count-1
    controls = 1024+640*count
    result = 1024+700*count
    base = raw+controls
    phase = max(base+6*frame+4+2*result,
                base+9*max(maximum_identity,maximum_evidence,maximum_incoming_evidence)+evidence.CLASSIFIER_WORK_BYTES,
                base+maximum_evidence+5*maximum_display+evidence.CLASSIFIER_WORK_BYTES)
    if enhanced_format:
        phase=max(phase,base+enhanced.codec_phase_bytes(maximum_incoming_evidence,maximum_evidence)
            +enhanced.codec_phase_bytes(maximum_display),
            enhanced_history.projection_write_phase_bytes(
                retained_bytes=base+6*frame+4+2*result,
                effective_length=maximum_evidence,display_length=maximum_display))
    else:
        phase = max(phase, history.history_write_phase_bytes(base=base,frame_size=frame,
            result_size=result,maximum_evidence=maximum_evidence,maximum_display=maximum_display))
        phase = max(phase, base+history.history_capacity_phase_bytes(maximum_evidence,maximum_display))
    return phase,frame,base,result


def _frame(items, account_id, source_ref, generation, revision):
    return json.dumps([account_id, source_ref, generation, revision, [
        [i.observation_ref, _kind(i), i.identity_bytes.hex(), i.previous_revision,
         i.previous_evidence_sha256, i.previous_display_sha256,
         i.evidence_bytes.hex(), i.display_bytes.hex(), i.incoming_evidence_bytes.hex()] for i in items
    ]], separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def _prefix():
    return """with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
      scope as materialized (select (j->>0)::bigint account_id,
        (j->>1)::uuid source_ref,(j->>2)::bigint generation,(j->>3)::bigint revision from f),
      inputs as materialized (select n::integer ordinal,(r->>0)::uuid observation_ref,
        r->>1 identity_kind,decode(r->>2,'hex') identity_bytes,(r->>3)::bigint previous_revision,
        decode(r->>4,'hex') previous_evidence_sha256,decode(r->>5,'hex') previous_display_sha256,
        decode(r->>6,'hex') evidence_bytes,decode(r->>7,'hex') display_bytes,
        decode(r->>8,'hex') incoming_evidence_bytes
        from f cross join lateral jsonb_array_elements(j->4) with ordinality v(r,n)) """


def _stream_sql(*, touch=False):
    if touch:
        return _prefix() + """update integration.foobar_import_streams_v2 s set updated_at=clock_timestamp()
          from scope f where (s.account_id,s.source_ref)=(f.account_id,f.source_ref)
          returning s.revision,s.current_generation,s.retired_through,
            current_setting('transaction_isolation') isolation;"""
    return _prefix() + """select s.revision,s.current_generation,s.retired_through,
        current_setting('transaction_isolation') isolation
      from integration.foobar_import_streams_v2 s join scope f
      on (s.account_id,s.source_ref)=(f.account_id,f.source_ref)
      for update of s;"""


def _cardinality_sql():
    # No identity/evidence byte equality here, even for the101 sentinel.
    return _prefix() + """select i.ordinal,count(c.observation_ref)::integer candidate_count,
      coalesce(sum(c.comparison_bytes),0)::bigint comparison_bytes
      from scope f cross join inputs i left join lateral (
        select o.observation_ref,case when r.observation_ref is null then 4194305::bigint
          else octet_length(o.identity_bytes)::bigint
          +octet_length(r.evidence_bytes)+octet_length(r.display_bytes)
          +coalesce(octet_length(r.incoming_evidence_bytes),0) end comparison_bytes
        from integration.foobar_import_observations_v2 o
        left join integration.foobar_import_revisions_v2 r
          on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
           =(o.account_id,o.source_ref,o.observation_ref,o.current_revision)
        where (o.account_id,o.source_ref)=(f.account_id,f.source_ref)
          and o.identity_kind=i.identity_kind and o.identity_sha256=sha256(i.identity_bytes)
        order by o.observation_ref limit101
      ) c on true group by i.ordinal order by i.ordinal;""".replace("limit101", "limit 101")


def _candidates_sql():
    # Only the already admitted complete hash buckets may reach byte equality.
    return _prefix() + """, candidates as materialized (
        select i.ordinal,o.observation_ref,o.identity_bytes,o.current_revision,
          r.evidence_sha256,r.display_sha256,r.evidence_bytes,r.display_bytes,
          r.incoming_evidence_sha256,r.incoming_evidence_bytes
        from scope f cross join inputs i cross join lateral (
          select o.observation_ref,o.identity_bytes,o.current_revision
          from integration.foobar_import_observations_v2 o
          where (o.account_id,o.source_ref)=(f.account_id,f.source_ref)
            and o.identity_kind=i.identity_kind and o.identity_sha256=sha256(i.identity_bytes)
          order by o.observation_ref limit 100
        ) o left join integration.foobar_import_revisions_v2 r
          on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
           =(f.account_id,f.source_ref,o.observation_ref,o.current_revision)
      ) """


def _current_incoming_sql():
    # Raw projection follows cardinality and the complete comparison-phase gate.
    # No stored JSON parsing occurs until the returned bytes pass the strict codec.
    return _candidates_sql() + """select i.ordinal,coalesce(c.matching_count,0)::integer matching_count,
        c.observation_ref::text observation_ref,c.current_revision,
        encode(c.incoming_evidence_sha256,'hex') incoming_evidence_sha256,
        c.incoming_evidence_bytes
      from inputs i left join lateral (
        select c.*,count(*) over () matching_count from candidates c
        where c.ordinal=i.ordinal and c.identity_bytes=i.identity_bytes
        order by c.observation_ref limit 1
      ) c on true order by i.ordinal;"""


def _incoming_same_sql(left, right, kind):
    # Both documents were strictly decoded and identity-associated beforehand.
    # Fixed 27-field projection compares state/raw/value/code, never origins.
    # NULL means a legacy unknown raw observation, not an empty observation.
    # Enhanced excludes ONLY upload hash/record position (members 8/9).
    # Identity, exact raw evidence including cached vectors, and aliases remain
    # material. A same snapshot in another finalized artifact is a no-op and
    # retains its original stored provenance. Missing/malformed SQL shape never
    # becomes equivalent through NULL propagation.
    enhanced = """coalesce((select
      jsonb_typeof(p.old_doc)='array' and jsonb_typeof(p.new_doc)='array'
      and jsonb_array_length(p.old_doc)=10 and jsonb_array_length(p.new_doc)=10
      and p.old_doc->>0='foobar_enhanced_incoming_v1'
      and p.new_doc->>0='foobar_enhanced_incoming_v1'
      and (select bool_and(p.old_doc->n=p.new_doc->n)
           from generate_series(0,7) as member_index(n))
      from (select convert_from(""" + left + """,'UTF8')::jsonb old_doc,
        convert_from(""" + right + """,'UTF8')::jsonb new_doc) p),false)"""
    tsv = """coalesce((
      select bool_and(p.old_doc->2->n->0=p.new_doc->2->n->0
        and p.old_doc->2->n->1=p.new_doc->2->n->1
        and p.old_doc->2->n->2=p.new_doc->2->n->2
        and p.old_doc->2->n->3=p.new_doc->2->n->3)
      from (select convert_from(""" + left + """,'UTF8')::jsonb old_doc,
        convert_from(""" + right + """,'UTF8')::jsonb new_doc) p
      cross join generate_series(0,26) as field_index(n)),false)"""
    return ("(case when "+left+" is null or "+right+" is null then false "
            "when "+kind+"='store_key' then "+enhanced+
            " when "+kind+" in ('path','occurrence') then "+tsv+" else false end)")


def _current_sql():
    return _candidates_sql() + """select i.ordinal,coalesce(c.matching_count,0)::integer matching_count,
        c.observation_ref::text observation_ref,c.current_revision,
        encode(c.evidence_sha256,'hex') evidence_sha256,encode(c.display_sha256,'hex') display_sha256,
        encode(c.incoming_evidence_sha256,'hex') incoming_evidence_sha256,
        (c.incoming_evidence_bytes=i.incoming_evidence_bytes) incoming_exact,
        case when c.observation_ref is null then null else
          (c.evidence_bytes=i.evidence_bytes and c.display_bytes=i.display_bytes and """ + _incoming_same_sql(
            "c.incoming_evidence_bytes", "i.incoming_evidence_bytes", "i.identity_kind") + """) end same_bytes
      from inputs i left join lateral (
        select c.*,count(*) over () matching_count from candidates c
        where c.ordinal=i.ordinal and c.identity_bytes=i.identity_bytes
        order by c.observation_ref limit 1
      ) c on true order by i.ordinal;"""


def _insert_observations_sql():
    return _prefix() + """insert into integration.foobar_import_observations_v2
      (account_id,source_ref,observation_ref,identity_kind,identity_bytes,current_revision)
      select f.account_id,f.source_ref,i.observation_ref,i.identity_kind,i.identity_bytes,f.revision+1
      from scope f cross join inputs i where i.previous_revision is null
      returning observation_ref::text observation_ref;"""


def _insert_revisions_sql():
    return _prefix() + """insert into integration.foobar_import_revisions_v2
      (account_id,source_ref,observation_ref,source_revision,evidence_bytes,display_bytes,incoming_evidence_bytes)
      select f.account_id,f.source_ref,i.observation_ref,f.revision+1,
        i.evidence_bytes,i.display_bytes,i.incoming_evidence_bytes
      from scope f cross join inputs i left join integration.foobar_import_revisions_v2 r
        on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
         =(f.account_id,f.source_ref,i.observation_ref,i.previous_revision)
      where i.previous_revision is null or r.evidence_bytes<>i.evidence_bytes or r.display_bytes<>i.display_bytes
        or not """ + _incoming_same_sql("r.incoming_evidence_bytes", "i.incoming_evidence_bytes", "i.identity_kind") + """
      returning observation_ref::text observation_ref;"""


def _advance_pointers_sql():
    return _prefix() + """update integration.foobar_import_observations_v2 o
      set current_revision=f.revision+1,updated_at=clock_timestamp()
      from scope f cross join inputs i
      where (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
        =(f.account_id,f.source_ref,i.observation_ref,i.previous_revision)
        and exists(select 1 from integration.foobar_import_revisions_v2 r
          where (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
            =(f.account_id,f.source_ref,i.observation_ref,f.revision+1)
            and r.evidence_bytes=i.evidence_bytes and r.display_bytes=i.display_bytes
            and r.incoming_evidence_bytes=i.incoming_evidence_bytes)
      returning o.observation_ref::text observation_ref;"""


def _query(connection, sql, frame, *, maximum=MAX_ROWS):
    cursor = None
    try:
        cursor = connection.execute(sql, (frame,), binary=True)
        rows = cursor.fetchmany(maximum + 1)
        if type(rows) is not list or len(rows) > maximum:
            raise SourceUnavailable()
        return rows
    finally:
        if cursor is not None:
            cursor.close()


def _authority(context, constraints):
    require_account_foobar(context, constraints)


def _stream(rowset, generation, revision):
    if len(rowset) == 0:
        raise SourceStale()
    if len(rowset) != 1 or type(rowset[0]) is not dict or set(rowset[0]) != {
        "revision", "current_generation", "retired_through", "isolation",
    }:
        raise SourceUnavailable()
    row = rowset[0]
    if row["isolation"] != "read committed":
        raise SourceUnavailable()
    if any(type(row[k]) is not int for k in ("revision", "current_generation", "retired_through")) or not (
        0 <= row["revision"] <= MAX_REVISION and 0 <= row["retired_through"] < row["current_generation"] <= 2147483647
    ):
        raise SourceUnavailable()
    if row["revision"] != revision or not row["retired_through"] < generation <= row["current_generation"]:
        raise SourceStale()


def _returning(rows, expected):
    actual = []
    for row in rows:
        if type(row) is not dict or set(row) != {"observation_ref"}:
            raise SourceUnavailable()
        _foobar_taste_uuid(row["observation_ref"])
        actual.append(row["observation_ref"])
    if len(set(actual)) != len(actual):
        raise SourceUnavailable()
    if set(actual) != set(expected):
        raise SourceStale()


def _check_identity(fields, identity, *, incoming=False):
    if identity[0] == "path":
        if identity[1] != fields[0][1]:
            raise SourceUnavailable()
    elif (fields[0][4] is None or identity[1] != fields[0][4][0]
            or int(identity[2]) != fields[0][4][1]):
        raise SourceUnavailable()
    if incoming:
        # Raw is one genuine row, unlike the effective cross-upload selection.
        origin = fields[0][4]
        if origin is None or any(field[4] is not None and field[4][:2] != origin[:2]
                                 for field in fields):
            raise SourceUnavailable()


def _validate_current_incoming(rows, items):
    """Strict serial stored-raw validation after the scalar admission gate."""
    if len(rows) != len(items):
        raise SourceUnavailable()
    digests = []
    for ordinal, (row, item) in enumerate(zip(rows, items), 1):
        if type(row) is not dict or set(row) != {
            "ordinal", "matching_count", "observation_ref", "current_revision",
            "incoming_evidence_sha256", "incoming_evidence_bytes",
        } or type(row["ordinal"]) is not int or row["ordinal"] != ordinal:
            raise SourceUnavailable()
        if type(row["matching_count"]) is not int or row["matching_count"] not in (0, 1):
            raise SourceUnavailable()
        if (row["matching_count"] == 0) != (row["observation_ref"] is None):
            raise SourceUnavailable()
        if row["observation_ref"] is None:
            if any(row[k] is not None for k in (
                    "current_revision", "incoming_evidence_sha256", "incoming_evidence_bytes")):
                raise SourceUnavailable()
            if item.previous_revision is not None:
                raise SourceStale()
            digests.append(None)
            continue
        _foobar_taste_uuid(row["observation_ref"])
        if (type(row["current_revision"]) is not int
                or not 1 <= row["current_revision"] <= MAX_REVISION):
            raise SourceUnavailable()
        if (row["observation_ref"] != item.observation_ref
                or row["current_revision"] != item.previous_revision):
            raise SourceStale()
        payload, digest = row["incoming_evidence_bytes"], row["incoming_evidence_sha256"]
        if payload is None:
            if digest is not None or _kind(item)=="store_key":
                raise SourceUnavailable()
            digests.append(None)  # Legacy unknown, never synthesize raw evidence.
            continue
        if type(payload) is not bytes or not 1 <= len(payload) <= evidence.MAX_EVIDENCE_BYTES:
            raise SourceUnavailable()
        evidence._digest(digest)
        if evidence.evidence_digest(payload) != digest:
            raise SourceUnavailable()
        if _kind(item)=="store_key":
            identity=enhanced.decode_enhanced_identity(item.identity_bytes)
            incoming=enhanced.decode_enhanced_incoming(payload)
            if incoming.store_key!=identity:
                raise SourceUnavailable()
            del identity,incoming
        else:
            fields = evidence.decode_evidence(payload)
            identity = evidence.decode_identity(item.identity_bytes)
            _check_identity(fields, identity, incoming=True)
            del fields, identity
        digests.append(digest)
    return tuple(digests)


def _check_current(rows, items, *, incoming_digests, postcheck=False, changed=(), revision=0):
    if len(rows) != len(items) or type(incoming_digests) is not tuple or len(incoming_digests) != len(items):
        raise SourceUnavailable()
    decisions = []
    for ordinal, (row, item) in enumerate(zip(rows, items), 1):
        if type(row) is not dict or set(row) != {
            "ordinal", "matching_count", "observation_ref", "current_revision", "evidence_sha256", "display_sha256",
            "incoming_evidence_sha256", "incoming_exact", "same_bytes",
        } or type(row["ordinal"]) is not int or row["ordinal"] != ordinal:
            raise SourceUnavailable()
        if type(row["matching_count"]) is not int or row["matching_count"] not in (0, 1):
            raise SourceUnavailable()
        if (row["matching_count"] == 0) != (row["observation_ref"] is None):
            raise SourceUnavailable()
        if row["observation_ref"] is None:
            if any(row[k] is not None for k in ("current_revision", "evidence_sha256", "display_sha256",
                    "incoming_evidence_sha256", "incoming_exact", "same_bytes")):
                raise SourceUnavailable()
            if postcheck or item.previous_revision is not None:
                raise SourceStale()
            decisions.append(True)
            continue
        _foobar_taste_uuid(row["observation_ref"])
        if type(row["current_revision"]) is not int or not 1 <= row["current_revision"] <= MAX_REVISION or type(row["same_bytes"]) is not bool:
            raise SourceUnavailable()
        evidence._digest(row["evidence_sha256"])
        evidence._digest(row["display_sha256"])
        if row["incoming_evidence_sha256"] is None:
            if row["incoming_exact"] is not None or row["same_bytes"]:
                raise SourceUnavailable()
        else:
            evidence._digest(row["incoming_evidence_sha256"])
            if type(row["incoming_exact"]) is not bool:
                raise SourceUnavailable()
        if row["observation_ref"] != item.observation_ref:
            raise SourceStale()
        expected_revision = revision + 1 if postcheck and changed[ordinal - 1] else item.previous_revision
        if row["current_revision"] != expected_revision:
            raise SourceStale()
        if postcheck:
            if not row["same_bytes"]:
                raise SourceStale()
            if changed[ordinal - 1]:
                if (not row["incoming_exact"] or row["incoming_evidence_sha256"] !=
                        evidence.evidence_digest(item.incoming_evidence_bytes)):
                    raise SourceStale()
            elif row["incoming_evidence_sha256"] != incoming_digests[ordinal - 1]:
                raise SourceStale()
        elif row["evidence_sha256"] != item.previous_evidence_sha256 or row["display_sha256"] != item.previous_display_sha256:
            raise SourceStale()
        elif row["incoming_evidence_sha256"] != incoming_digests[ordinal - 1]:
            raise SourceStale()
        decisions.append(not row["same_bytes"])
    return tuple(decisions)


def source_comparison_phase_bytes(rows, items, *, base, frame_size, result_size):
    """Pure owned calculation; scalar rows must come from the actual query."""
    if len(rows) != len(items):
        raise SourceUnavailable()
    comparison = occurrences = 0
    for ordinal, row in enumerate(rows, 1):
        if type(row) is not dict or set(row) != {"ordinal", "candidate_count", "comparison_bytes"}:
            raise SourceUnavailable()
        if (type(row["ordinal"]) is not int or row["ordinal"] != ordinal
                or type(row["candidate_count"]) is not int or not 0 <= row["candidate_count"] <= 101
                or type(row["comparison_bytes"]) is not int or row["comparison_bytes"] < 0):
            raise SourceUnavailable()
        if row["candidate_count"] == 101:
            raise SourceUnavailable()
        if (row["candidate_count"] == 0) != (row["comparison_bytes"] == 0):
            raise SourceUnavailable()
        if row["comparison_bytes"] > row["candidate_count"] * (
                evidence.MAX_IDENTITY_BYTES + 2 * evidence.MAX_EVIDENCE_BYTES + display.MAX_BYTES):
            raise SourceUnavailable()
        comparison += row["comparison_bytes"]
        occurrences += row["candidate_count"]
    # Bound the later current-pointer postimage too, including repeated
    # occurrences of newly inserted candidates in every matching bucket.
    for index, item in enumerate(items):
        new_count = 0
        for other in items:
            if (_kind(item) == _kind(other) and
                    evidence.evidence_digest(item.identity_bytes) == evidence.evidence_digest(other.identity_bytes)):
                comparison += (len(other.identity_bytes) + len(other.evidence_bytes)
                               + len(other.display_bytes) + len(other.incoming_evidence_bytes))
                if other.previous_revision is None:
                    new_count += 1
        if rows[index]["candidate_count"] + new_count > 100:
            raise SourceUnavailable()
        occurrences += new_count
    # Eleven logical views cover native candidate/JSON inputs, driver/raw
    # projection owners and one serial strict decode (including its encoder).
    # The overbound also includes postimages and repeated hash-bucket members.
    # This is not a native detoast/plan/physical-memory or timeout guarantee.
    factor=64 if _kind(items[0])=="store_key" else 11
    return (base + 6 * frame_size + 4 + 2 * result_size + factor * comparison
            + 384 * occurrences + evidence.CLASSIFIER_WORK_BYTES)


def write_foobar_source_on_connection(connection, live_context, *, source_ref, generation, expected_revision, items, constraints=None):
    """Append v2 source revisions, never acknowledge an import or commit alone.

    The outer account transaction must use current_foobar_account_transaction
    (real account/session locks), then own original decisions, receipts and the
    final stream revision before commit. Optional library matching/taste uses
    separate live library authority; this writer neither requires nor grants it.
    No caller-supplied flag can stand in for that native transaction owner.
    """
    try:
        _foobar_taste_connection(connection)
        live_context = account_foobar_context(live_context)
        account_id = live_context.actor.account_id
        phase, frame_size, base, result_size = source_write_phase_bytes(items, account_id=account_id,
            source_ref=source_ref, generation=generation, expected_revision=expected_revision)
        if phase > MAX_PHASE_BYTES:
            raise SourceUnavailable()
        for item in items:
            if _kind(item)=="store_key":
                key=enhanced.decode_enhanced_identity(item.identity_bytes)
                incoming=enhanced.decode_enhanced_incoming(item.incoming_evidence_bytes)
                effective=enhanced.decode_enhanced_effective(item.evidence_bytes)
                if key!=incoming.store_key or key!=effective.store_key:
                    raise SourceUnavailable()
                enhanced.check_enhanced_display(item.display_bytes,incoming)
                del key,incoming,effective
                continue
            fields = evidence.decode_evidence(item.evidence_bytes)
            identity = evidence.decode_identity(item.identity_bytes)
            if identity[0] != _kind(item):
                raise SourceUnavailable()
            _check_identity(fields, identity)
            del identity
            display.check_display(item.display_bytes, fields)
            del fields
            fields = evidence.decode_evidence(item.incoming_evidence_bytes)
            identity = evidence.decode_identity(item.identity_bytes)
            _check_identity(fields, identity, incoming=True)
            del fields, identity
        frame = _frame(items, account_id, source_ref, generation, expected_revision)
        if len(frame) != frame_size:
            raise SourceUnavailable()
        with connection.transaction():
            _authority(live_context, constraints)
            require_foobar_history_on_connection(connection, for_write=True)
            _stream(_query(connection, _stream_sql(), frame, maximum=1), generation, expected_revision)
            # Trigger performs fresh clock/high-water validation after lock wait.
            _stream(_query(connection, _stream_sql(touch=True), frame, maximum=1), generation, expected_revision)
            rows = _query(connection, _cardinality_sql(), frame)
            comparison_phase = source_comparison_phase_bytes(rows, items,
                base=base, frame_size=frame_size, result_size=result_size)
            del rows
            if comparison_phase > MAX_PHASE_BYTES:
                raise SourceUnavailable()
            stored_raw = _query(connection, _current_incoming_sql(), frame)
            incoming_digests = _validate_current_incoming(stored_raw, items)
            del stored_raw
            current = _query(connection, _current_sql(), frame)
            changed = _check_current(current, items, incoming_digests=incoming_digests)
            del current
            if any(changed):
                if expected_revision == MAX_REVISION:
                    raise SourceStale()
                fresh = tuple(i.observation_ref for i in items if i.previous_revision is None)
                appended = tuple(i.observation_ref for i, change in zip(items, changed) if change)
                advanced = tuple(i.observation_ref for i, change in zip(items, changed) if change and i.previous_revision is not None)
                _returning(_query(connection, _insert_observations_sql(), frame), fresh)
                _returning(_query(connection, _insert_revisions_sql(), frame), appended)
                _returning(_query(connection, _advance_pointers_sql(), frame), advanced)
                del fresh, appended, advanced
            final = _query(connection, _current_sql(), frame)
            _check_current(final, items, incoming_digests=incoming_digests,
                           postcheck=True, changed=changed, revision=expected_revision)
            del final
            if _kind(items[0])=="store_key":
                retained=base+6*frame_size+4+2*result_size
                for item,change in zip(items,changed):
                    enhanced_history.maintain_enhanced_history_on_connection(connection,
                        account_id=account_id,source_ref=source_ref,
                        observation_ref=item.observation_ref,
                        source_revision=expected_revision+1 if change else item.previous_revision,
                        previous_revision=item.previous_revision,effective_bytes=item.evidence_bytes,
                        display_bytes=item.display_bytes,changed=change,retained_bytes=retained)
            else:
                history.maintain_current_history_on_connection(connection,account_id=account_id,
                    source_ref=source_ref,expected_revision=expected_revision,items=items,changed=changed)
            _authority(live_context, constraints)
            _stream(_query(connection, _stream_sql(touch=True), frame, maximum=1), generation, expected_revision)
            outcomes = tuple(SourceWriteOutcome(i.observation_ref, change,
                expected_revision + 1 if change else i.previous_revision,
                evidence.evidence_digest(i.incoming_evidence_bytes) if change else incoming_digests[index])
                for index, (i, change) in enumerate(zip(items, changed)))
        return outcomes
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
