# Composition N2 reserves one additional deadline-wrapper parameter view.
# This is a logical forwarding owner, never an alias or zero-copy discount.
"""Private Prepare source lookup, not a receipt or source mutation.

Requires the genuine complete-upload window proof and the real matching owner's
native conflict booleans. Upload/proof are still charged to admitted intake.
No prior evidence payload is fetched; no result is public readiness.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json

from . import foobar_source_evidence as evidence
from . import foobar_source_window as window
from . import foobar_prepare_gate as gate
from .foobar_source_postgres import SourceUnavailable, SourceStale, _query

MAX_PRIVATE_BYTES = 4_194_304
CONTROL_BYTES = 8192
COUNTER_WORK_BYTES = 32768


@dataclass(frozen=True, slots=True)
class SourceIdentityScalar:
    ordinal: int
    identity_kind: str
    identity_sha256: str
    identity_bytes: int
    identity_conflict: bool


@dataclass(frozen=True, slots=True)
class PriorSourceScalar:
    ordinal: int
    observation_ref: str | None
    source_revision: int | None
    evidence_sha256: str | None
    display_sha256: str | None
    identity_bytes: int
    evidence_bytes: int
    display_bytes: int
    incoming_evidence_sha256: str | None
    incoming_evidence_bytes: int


@dataclass(frozen=True, slots=True)
class SourceLookupScalars:
    identities: tuple[SourceIdentityScalar, ...]
    candidates: tuple[tuple[int, int], ...]
    prior: tuple[PriorSourceScalar, ...]
    stopped_for_comparison_size: bool


def _admit(value):
    if type(value) is not int or value < 0 or value > MAX_PRIVATE_BYTES:
        raise SourceUnavailable()


def _plan_bound(count):
    return 1024 + 128 * count


def _prior_bound(count):
    # Includes the separately bounded latest raw hash/length, not its payload.
    return 1024 + 384 * count


def _flags(proof, native_conflicts):
    window._validate_proof(proof)
    if (type(native_conflicts) is not tuple or len(native_conflicts) != len(proof.paths)
            or any(type(value) is not bool for value in native_conflicts)):
        raise SourceUnavailable()


def _conflict(proof, native_conflicts, index):
    return native_conflicts[index] or (
        proof.paths[index] != "" and proof.raw_path_row_counts[index] > 1
    )


def _identity_size(proof, native_conflicts, index):
    if proof.paths[index] != "" and not _conflict(proof, native_conflicts, index):
        return "path", 9 + evidence._json_size(proof.paths[index])
    ordinal = str(proof.offset + index + 1)
    return "occurrence", 82 + evidence._json_size(ordinal)


def source_identity_plan_phase_bytes(proof, native_conflicts):
    _admit(CONTROL_BYTES + COUNTER_WORK_BYTES)
    _flags(proof, native_conflicts)
    maximum = max(_identity_size(proof, native_conflicts, i)[1] for i in range(len(proof.paths)))
    return CONTROL_BYTES + 2 * _plan_bound(len(proof.paths)) + 1 + 6 * len(proof.paths) + 5 * maximum + COUNTER_WORK_BYTES + 100


def plan_source_identities(proof, native_conflicts):
    """No full known-field tree: reuse the unchanged canonical identity encoder."""
    _admit(source_identity_plan_phase_bytes(proof, native_conflicts))
    result = []
    for index in range(len(proof.paths)):
        ordinal = proof.offset + index + 1
        conflict = _conflict(proof, native_conflicts, index)
        kind, size = _identity_size(proof, native_conflicts, index)
        encoded = evidence._source_identity_bytes(
            proof.paths[index], upload_sha256=proof.source_sha256,
            ordinal=ordinal, identity_conflict=conflict,
        )
        if len(encoded) != size:
            raise SourceUnavailable()
        result.append(SourceIdentityScalar(
            ordinal, kind, hashlib.sha256(encoded).hexdigest(), size, conflict,
        ))
        del encoded
    return tuple(result)


def _encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")


def _hash_frame_size(plan, account_id, library_id, source_ref):
    rows = 2 + max(0, len(plan)-1)
    for item in plan:
        rows += evidence._json_size((item.identity_kind, item.identity_sha256))
    return evidence._json_size((account_id, library_id, source_ref)) + rows + 1


_CARDINALITY_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
scope as materialized (
 select (j->>0)::bigint account_id,(j->>1)::bigint library_id,(j->>2)::uuid source_ref
 from f
), inputs as materialized (
 select n::integer ordinal,r->>0 identity_kind,decode(r->>1,'hex') identity_sha256
 from f cross join lateral jsonb_array_elements(j->3) with ordinality v(r,n)
)
select i.ordinal,count(c.observation_ref)::integer candidate_count,
 coalesce(sum(c.comparison_bytes),0)::bigint comparison_bytes,
 coalesce(bool_and(c.valid),true) candidates_valid
from scope s cross join inputs i left join lateral (
 select o.observation_ref,
   (octet_length(o.identity_bytes)::bigint + octet_length(r.evidence_bytes)
       + octet_length(r.display_bytes)
       + coalesce(octet_length(r.incoming_evidence_bytes),0)) comparison_bytes,
   (r.observation_ref is not null
    and octet_length(o.identity_bytes) between 1 and 131072
    and octet_length(r.evidence_bytes) between 1 and 4194304
    and octet_length(r.display_bytes) between 1 and 1048576
    and case when r.incoming_evidence_bytes is null
      then r.incoming_evidence_sha256 is null
      else octet_length(r.incoming_evidence_bytes) between 1 and 4194304
        and r.incoming_evidence_sha256 is not null end) valid
 from integration.foobar_import_observations o
 left join integration.foobar_import_revisions r
 on (r.account_id,r.library_id,r.source_ref,r.observation_ref,r.source_revision)
  =(o.account_id,o.library_id,o.source_ref,o.observation_ref,o.current_revision)
 where (o.account_id,o.library_id,o.source_ref)=(s.account_id,s.library_id,s.source_ref)
   and o.identity_kind=i.identity_kind and o.identity_sha256=i.identity_sha256
 order by o.observation_ref limit 101
) c on true group by i.ordinal order by i.ordinal
"""


_COMPARE_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
scope as materialized (
 select (j->>0)::bigint account_id,(j->>1)::bigint library_id,(j->>2)::uuid source_ref,
 j->>3 identity_kind,decode(j->>4,'hex') identity_sha256,decode(j->>5,'hex') identity_bytes
 from f
), candidates as materialized (
 select o.observation_ref,o.identity_bytes,o.current_revision,
 r.evidence_sha256,r.display_sha256,r.incoming_evidence_sha256,
 octet_length(r.evidence_bytes) evidence_bytes,octet_length(r.display_bytes) display_bytes,
 coalesce(octet_length(r.incoming_evidence_bytes),0) incoming_evidence_bytes
 from scope s cross join lateral (
  select o.observation_ref,o.identity_bytes,o.current_revision
  from integration.foobar_import_observations o
  where (o.account_id,o.library_id,o.source_ref)=(s.account_id,s.library_id,s.source_ref)
   and o.identity_kind=s.identity_kind and o.identity_sha256=s.identity_sha256
  order by o.observation_ref limit 100
 ) o left join integration.foobar_import_revisions r
 on (r.account_id,r.library_id,r.source_ref,r.observation_ref,r.source_revision)
  =(s.account_id,s.library_id,s.source_ref,o.observation_ref,o.current_revision)
), matched as materialized (
 select c.*,count(*) over () matching_count from candidates c cross join scope s
 where c.identity_bytes=s.identity_bytes
)
select coalesce(m.matching_count,0)::integer matching_count,
 m.observation_ref::text observation_ref,m.current_revision source_revision,
 encode(m.evidence_sha256,'hex') evidence_sha256,encode(m.display_sha256,'hex') display_sha256,
 octet_length(m.identity_bytes) identity_bytes,m.evidence_bytes,m.display_bytes,
 encode(m.incoming_evidence_sha256,'hex') incoming_evidence_sha256,m.incoming_evidence_bytes
from scope left join lateral (select * from matched order by observation_ref limit 1) m on true
"""


def _candidate_rows(rows, count):
    if type(rows) is not list or len(rows) != count:
        raise SourceUnavailable()
    # Finish the ENTIRE requested cardinality validation before any equality.
    result = []
    for ordinal, row in enumerate(rows, 1):
        if type(row) is not dict or set(row) != {
            "ordinal", "candidate_count", "comparison_bytes", "candidates_valid",
        }:
            raise SourceUnavailable()
        n, size = row["candidate_count"], row["comparison_bytes"]
        if (type(row["ordinal"]) is not int or row["ordinal"] != ordinal
                or type(n) is not int or not 0 <= n <= 100
                or type(size) is not int or not 0 <= size <= n*(131072+4194304+1048576+4194304)
                or type(row["candidates_valid"]) is not bool or not row["candidates_valid"]
                or (n == 0) != (size == 0)):
            raise SourceUnavailable()
        result.append((n, size))
    return tuple(result)


def _prior_row(rows, item, *, candidate_count, expected_revision):
    if type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict:
        raise SourceUnavailable()
    row = rows[0]
    if set(row) != {
        "matching_count", "observation_ref", "source_revision", "evidence_sha256",
        "display_sha256", "identity_bytes", "evidence_bytes", "display_bytes",
        "incoming_evidence_sha256", "incoming_evidence_bytes",
    } or type(row["matching_count"]) is not int or row["matching_count"] not in (0, 1) or row["matching_count"] > candidate_count:
        raise SourceUnavailable()
    if row["matching_count"] == 0:
        if any(row[name] is not None for name in row if name != "matching_count"):
            raise SourceUnavailable()
        return PriorSourceScalar(item.ordinal, None, None, None, None, 0, 0, 0, None, 0)
    try:
        valid = (gate._uuid(row["observation_ref"])
                 and gate._integer(row["source_revision"], 1, expected_revision)
                 and gate._hex(row["evidence_sha256"]) and gate._hex(row["display_sha256"])
                 and type(row["identity_bytes"]) is int and row["identity_bytes"] == item.identity_bytes
                 and gate._integer(row["evidence_bytes"], 1, 4194304)
                 and gate._integer(row["display_bytes"], 1, 1048576)
                 and ((row["incoming_evidence_sha256"] is None
                       and type(row["incoming_evidence_bytes"]) is int
                       and row["incoming_evidence_bytes"] == 0)
                      or (gate._hex(row["incoming_evidence_sha256"])
                          and gate._integer(row["incoming_evidence_bytes"], 1, 4194304))))
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise SourceUnavailable()
    return PriorSourceScalar(
        item.ordinal, row["observation_ref"], row["source_revision"],
        row["evidence_sha256"], row["display_sha256"], row["identity_bytes"],
        row["evidence_bytes"], row["display_bytes"],
        row["incoming_evidence_sha256"], row["incoming_evidence_bytes"],
    )


def source_lookup_comparison_phase_bytes(*, base, identity_bytes, frame_bytes, comparison_bytes, occurrences):
    if any(type(v) is not int or v < 0 for v in (base, identity_bytes, frame_bytes, comparison_bytes, occurrences)):
        raise SourceUnavailable()
    # All preceding selected candidate occurrences count, including repeats.
    return base + identity_bytes + 6 * frame_bytes + 4 + 2 * 1024 + comparison_bytes + 384 * occurrences


def lookup_foobar_source_scalars_on_connection(
    connection, live_context, *, command, ticket, proof, native_conflicts, constraints=None,
):
    """Real scoped SQL, but no prior payload, merged evidence or ready response.

    Entry: a genuine new ticket from the same outer locked transaction; complete
    proof/intake owner retained separately; no other private variable payloads
    yet allocated. Caller retains all returned scalars through later admission.
    """
    gate.validate_prepare_command(command)
    try:
        _admit(CONTROL_BYTES + COUNTER_WORK_BYTES)
        _flags(proof, native_conflicts)
        if (type(ticket) is not gate.FoobarPrepareTicket or ticket.disposition != "new"
                or proof.source_sha256 != command.upload_sha256 or proof.offset != command.offset
                or not gate._time(ticket.observed_at)):
            raise SourceUnavailable()
        n = len(proof.paths)
        plan = plan_source_identities(proof, native_conflicts)
        # Old ticket, command, bounded scalar/control views; full gate operation
        # separately reserved while compact lookup state remains alive.
        base = (CONTROL_BYTES + COUNTER_WORK_BYTES + 2*_plan_bound(n)
                + 2*(1024 + 64*n) + 3*_prior_bound(n) + 1 + 6*n + gate.PREPARE_GATE_BYTES)
        _admit(base)
        fresh = gate.begin_foobar_prepare_on_connection(
            connection, live_context, command=command, constraints=constraints,
        )
        if (fresh.disposition != "new" or fresh.command_sha256 != ticket.command_sha256
                or fresh.observed_at < ticket.observed_at):
            raise SourceUnavailable()
        actor = live_context.actor
        frame_size = _hash_frame_size(plan, actor.account_id, live_context.library_id, command.source_ref)
        _admit(base + 6*frame_size + 4 + 2*(1024+256*n))
        frame = _encode((actor.account_id, live_context.library_id, command.source_ref,
                         tuple((i.identity_kind, i.identity_sha256) for i in plan)))
        if len(frame) != frame_size:
            raise SourceUnavailable()
        rows = _query(connection, _CARDINALITY_SQL, frame, maximum=n)
        candidates = _candidate_rows(rows, n)
        del rows, frame
        prior = []
        comparison = occurrences = 0
        stopped = False
        for index, item in enumerate(plan):
            count, size = candidates[index]
            comparison += size
            occurrences += count
            fixed = (actor.account_id, live_context.library_id, command.source_ref,
                     item.identity_kind, item.identity_sha256)
            # Add quoted hex member and one comma to the known five-member array.
            current_frame_size = evidence._json_size(fixed) + 2*item.identity_bytes + 3
            required = source_lookup_comparison_phase_bytes(
                base=base, identity_bytes=item.identity_bytes, frame_bytes=current_frame_size,
                comparison_bytes=comparison, occurrences=occurrences,
            )
            if required > MAX_PRIVATE_BYTES:
                stopped = True
                break
            # Serial ordinary encoder is also admitted before allocating bytes.
            _admit(base + 5*item.identity_bytes + 100)
            identity = evidence._source_identity_bytes(
                proof.paths[index], upload_sha256=proof.source_sha256,
                ordinal=item.ordinal, identity_conflict=item.identity_conflict,
            )
            if len(identity) != item.identity_bytes or hashlib.sha256(identity).hexdigest() != item.identity_sha256:
                raise SourceUnavailable()
            frame = _encode(fixed + (identity.hex(),))
            if len(frame) != current_frame_size:
                raise SourceUnavailable()
            rows = _query(connection, _COMPARE_SQL, frame, maximum=1)
            prior.append(_prior_row(rows, item, candidate_count=count, expected_revision=command.expected_revision))
            del rows, frame, identity
        final = gate.begin_foobar_prepare_on_connection(
            connection, live_context, command=command, constraints=constraints,
        )
        if (final.disposition != "new" or final.command_sha256 != fresh.command_sha256
                or final.observed_at < fresh.observed_at):
            raise SourceUnavailable()
        return SourceLookupScalars(plan, candidates, tuple(prior), stopped)
    except (SourceUnavailable, SourceStale, gate.PrepareInvalid):
        raise
    except Exception:
        raise SourceUnavailable() from None

