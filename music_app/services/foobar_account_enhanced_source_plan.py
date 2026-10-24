"""Serial Enhanced source planning on the genuine lock-held account transaction.

No receipt, raw-index terminal, new transaction, connection pool or commit is
created here. The outer owner supplies a genuine full-validated raw-index row,
charges its upload/index/reader owners, proves the accepted window terminal,
and admits the complete v4 envelope and future Apply phases independently.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from uuid import uuid4

from . import foobar_enhanced_source_evidence as enhanced
from . import foobar_account_prepare_gate as gate
from . import foobar_account_source_lookup as lookup
from . import foobar_account_source_prior_merge as prior_merge
from . import foobar_account_source_postgres as source
from . import foobar_source_evidence as framing
from .foobar_account_source_postgres import SourceUnavailable, SourceStale, SourceWrite

MAX_PRIVATE_BYTES = 4_194_304
MAX_ROWS = 100
CONTROL_BYTES = 32_768
# Fixed GUID, signed64 key and fixed canonical framing are strictly below this.
IDENTITY_ENCODE_BOUND = 256
# A <=256 UTF-8-byte safe label (at most doubled JSON quoting), fixed identity
# and version/labels/nulls are below1024. This never limits original aliases.
DISPLAY_ENCODE_BOUND = 1024
MAX_QUERY_FRAME_BYTES = 2048


@dataclass(frozen=True, slots=True)
class EnhancedPlannedSource:
    raw_ordinal: int
    ordinal: int
    source_write: SourceWrite
    material_changed: bool
    incoming_semantically_equal: bool
    prior_incoming_sha256: str | None
    prior_incoming_bytes: int
    prior_identity_bytes: int
    prior_effective_bytes: int
    prior_display_bytes: int
    candidate_count: int
    comparison_bytes: int
    # Peak includes caller retention, input-row holder, prior outputs and SQL.
    peak_phase_bytes: int
    # Exact declared logical charge of the complete returned prefix only.
    # It excludes caller-retained envelope/index/readers and future operations.
    retained_phase_bytes: int


class _PrivatePrefixFull(Exception):
    """Only a computed private phase overflow, never malformed/stale authority."""


class _PhaseLedger:
    def __init__(self):
        self.peak = 0

    def admit(self, required):
        if type(required) is not int or required < 0:
            raise SourceUnavailable()
        self.peak = max(self.peak, required)
        if required > MAX_PRIVATE_BYTES:
            raise _PrivatePrefixFull()


def _write_payload_bytes(item):
    if type(item) is not SourceWrite or not gate._uuid(item.observation_ref):
        raise SourceUnavailable()
    size = 0
    for value, limit in (
        (item.identity_bytes, enhanced.MAX_IDENTITY_BYTES),
        (item.incoming_evidence_bytes, enhanced.MAX_EVIDENCE_BYTES),
        (item.evidence_bytes, enhanced.MAX_EVIDENCE_BYTES),
        (item.display_bytes, enhanced.MAX_DISPLAY_BYTES),
    ):
        if type(value) is not bytes or not 1 <= len(value) <= limit:
            raise SourceUnavailable()
        size += len(value)
    if item.previous_revision is None:
        if item.previous_evidence_sha256 is not None or item.previous_display_sha256 is not None:
            raise SourceUnavailable()
    elif (not gate._integer(item.previous_revision, 1, source.MAX_REVISION)
            or not gate._hex(item.previous_evidence_sha256)
            or not gate._hex(item.previous_display_sha256)):
        raise SourceUnavailable()
    return size


def enhanced_plan_retained_bytes(planned):
    """Two complete immutable/caller views, recomputed from actual byte lengths.

    Scalars reported by an earlier result never authorize a later allocation.
    This is a logical holder charge, not a physical RSS measurement.
    """
    if type(planned) is not tuple or len(planned) > MAX_ROWS:
        raise SourceUnavailable()
    size = 1024
    last = None
    for item in planned:
        if (type(item) is not EnhancedPlannedSource
                or not gate._integer(item.raw_ordinal, 0, 99_999)
                or item.ordinal != item.raw_ordinal + 1
                or type(item.ordinal) is not int
                or last is not None and item.raw_ordinal != last + 1
                or type(item.material_changed) is not bool
                or type(item.incoming_semantically_equal) is not bool):
            raise SourceUnavailable()
        last = item.raw_ordinal
        size += 1024 + _write_payload_bytes(item.source_write)
    return 2 * size


def _incoming_sizes(incoming):
    """Count already acquired data without bytes/string/list expansion."""
    if (type(incoming) is not enhanced.EnhancedIncomingEvidence
            or not gate._integer(incoming.store_key, -(2**63), 2**63-1)
            or not gate._integer(incoming.record_ordinal, 0, 99_999)
            or not gate._hex(incoming.upload_sha256)
            or type(incoming.aliases) is not tuple
            or len(incoming.aliases) > enhanced.MAX_ALIASES
            or incoming.raw_blob is not None and type(incoming.raw_blob) is not bytes):
        raise SourceUnavailable()
    raw_length = 0 if incoming.raw_blob is None else len(incoming.raw_blob)
    if raw_length > enhanced.MAX_RECORD_BYTES:
        raise SourceUnavailable()
    alias_bytes = 0
    for alias in incoming.aliases:
        if (type(alias) is not str or not 1 <= len(alias) <= enhanced.MAX_ALIAS_UTF8_BYTES
                or '\x00' in alias):
            raise SourceUnavailable()
        length = enhanced._text_bytes(alias)
        if not 1 <= length <= enhanced.MAX_ALIAS_UTF8_BYTES:
            raise SourceUnavailable()
        alias_bytes += length
        if alias_bytes > enhanced.MAX_EVIDENCE_BYTES:
            raise SourceUnavailable()
    encode_phase = enhanced.incoming_encode_phase_bytes(
        retained_raw_length=raw_length, alias_count=len(incoming.aliases),
        alias_utf8_bytes=alias_bytes,
    )
    # Separate genuine generator/caller input holder. No zero-copy discount:
    # maximum Unicode storage, alias/reference controls and original raw bytes.
    hold = 2 * (1024 + raw_length + 4 * alias_bytes + 80 * len(incoming.aliases))
    return hold, encode_phase


def _same_incoming(first, second):
    """Exactly the genuine writer's incoming array members0..7.

    Canonical decoders already fixed the version/GUID and checked raw hash/hex.
    Only upload SHA and zero-based original record position (members8/9) differ
    without a material change. Alias content, order and raw lanes remain material.
    """
    return (first.store_key == second.store_key
            and first.data_state == second.data_state
            and first.raw_reason == second.raw_reason
            and first.raw_size == second.raw_size
            and first.raw_blob == second.raw_blob
            and first.aliases == second.aliases)


def _same_ticket(current, previous):
    prior_merge._same_ticket(current, previous)
    if (current.source_revision != previous.source_revision
            or current.current_generation != previous.current_generation
            or current.retired_through != previous.retired_through):
        raise SourceStale()


def _query(connection, sql, values, *, ledger, base, result_bytes, maximum=1):
    frame_size = framing._json_size(values)
    if not 1 <= frame_size <= MAX_QUERY_FRAME_BYTES:
        raise SourceUnavailable()
    # Six frame views include native bytea and deadline forwarding. The raw
    # fetch's larger retained/codec phases have already been admitted separately.
    ledger.admit(base + 6 * frame_size + 4 + result_bytes)
    frame = lookup._encode(values)
    if len(frame) != frame_size:
        raise SourceUnavailable()
    try:
        return source._query(connection, sql, frame, maximum=maximum)
    finally:
        del frame


# Preserve the genuine current-pointer/identity/hash/length predicates exactly.
# Only add the actual original identity to the raw projection for strict local
# canonical validation; no string contains a caller-supplied SQL identifier.
_PRIOR_PROJECTION = 'select r.evidence_bytes,r.display_bytes,r.incoming_evidence_bytes'
_PRIOR_SQL = prior_merge._PRIOR_SQL.replace(
    _PRIOR_PROJECTION,
    'select o.identity_bytes,r.evidence_bytes,r.display_bytes,r.incoming_evidence_bytes',
    1,
)


def _prior_payloads(connection, *, fixed, identity, prior, ledger, base):
    if _PRIOR_SQL == prior_merge._PRIOR_SQL:
        raise SourceUnavailable()  # A changed upstream SQL needs explicit review.
    values = fixed + (identity.hex(),)
    total = prior.identity_bytes + prior.evidence_bytes + prior.display_bytes + prior.incoming_evidence_bytes
    rows = _query(connection, _PRIOR_SQL, values, ledger=ledger, base=base,
                  result_bytes=4 * total + 8192)
    if not rows:
        raise SourceStale()
    if (len(rows) != 1 or type(rows[0]) is not dict or set(rows[0]) != {
            'identity_bytes', 'evidence_bytes', 'display_bytes', 'incoming_evidence_bytes'}):
        raise SourceUnavailable()
    row = rows[0]
    for name, length, digest in (
        ('identity_bytes', prior.identity_bytes, sha256(identity).hexdigest()),
        ('evidence_bytes', prior.evidence_bytes, prior.evidence_sha256),
        ('display_bytes', prior.display_bytes, prior.display_sha256),
        ('incoming_evidence_bytes', prior.incoming_evidence_bytes, prior.incoming_evidence_sha256),
    ):
        payload = row[name]
        if (type(payload) is not bytes or len(payload) != length
                or sha256(payload).hexdigest() != digest):
            raise SourceUnavailable()
    if row['identity_bytes'] != identity:
        raise SourceUnavailable()
    return row


def plan_enhanced_source_record_on_connection(
    connection, live_context, *, command, ticket, incoming, retained=(),
    expected=None, caller_retained_bytes=0, constraints=None,
):
    """Plan one genuinely acquired record; return None ONLY for prefix capacity.

    The caller holds current_foobar_account_transaction and its native source
    lock, passes each real index row once, and does not treat any output as a
    complete raw-window proof. A shortened prefix needs exact reacquisition and
    its complete terminal before use. An empty accepted prefix is not success.

    expected, when present, is the genuine SourceWrite reconstructed from an
    authenticated canonical original before receipt insertion, on this SAME new
    ticket. Its fresh observation ref is reused, never regenerated. This is not
    ready/replay validation of historical priors after current pointers advance.

    caller_retained_bytes is additional actual envelope/index/window ownership
    in this private operation, not a caller-controlled capacity or authority.
    Upload/intake owner charges outside this private phase remain separate.
    """
    try:
        source._foobar_taste_connection(connection)
        gate.validate_prepare_command(command)
        # Selected scope is checked before account-only source canonicalization.
        # This is a scope equality fence, not a new grant or native mutation.
        if (command.matching_library_id is not None
                and live_context.library_id != command.matching_library_id):
            raise SourceUnavailable()
        live_context = source.account_foobar_context(live_context)
        source._authority(live_context, constraints)
        if (command.mapping_name != gate.ENHANCED_MAPPING
                or live_context.library_id is not None
                or type(ticket) is not gate.FoobarPrepareTicket
                or ticket.disposition != 'new'
                or ticket.source_revision != command.expected_revision
                or not gate._time(ticket.observed_at)
                or type(caller_retained_bytes) is not int or caller_retained_bytes < 0):
            raise SourceUnavailable()
        prefix_hold = enhanced_plan_retained_bytes(retained)
        if (len(retained) >= MAX_ROWS
                or retained and retained[0].raw_ordinal != command.offset):
            raise SourceUnavailable()
        incoming_hold, encode_phase = _incoming_sizes(incoming)
        if (incoming.upload_sha256 != command.upload_sha256
                or incoming.record_ordinal != command.offset + len(retained)):
            raise SourceUnavailable()
        expected_hold = 0 if expected is None else 2 * (1024 + _write_payload_bytes(expected))
        base = CONTROL_BYTES + caller_retained_bytes + prefix_hold + expected_hold + incoming_hold
        ledger = _PhaseLedger()
        ledger.admit(base + max(encode_phase, gate.PREPARE_GATE_BYTES) + 5 * IDENTITY_ENCODE_BOUND)
        if ticket.command_sha256 != gate.prepare_command_digest(command,
                account_id=live_context.actor.account_id, library_id=command.matching_library_id,
                session_id=live_context.actor.session_id):
            raise SourceUnavailable()
        fresh = gate.begin_foobar_prepare_on_connection(
            connection, live_context, command=command, constraints=constraints)
        _same_ticket(fresh, ticket)
        identity = enhanced.encode_enhanced_identity(incoming.store_key)
        if len(identity) > IDENTITY_ENCODE_BOUND:
            raise SourceUnavailable()
        identity_hash = sha256(identity).hexdigest()
        if any(row.source_write.identity_bytes == identity for row in retained):
            raise SourceUnavailable()
        ordinal = incoming.record_ordinal + 1
        plan = lookup.SourceIdentityScalar(ordinal, 'store_key', identity_hash, len(identity), False)
        account_id = live_context.actor.account_id
        scope = (account_id, None, command.source_ref)
        bucket_rows = _query(connection, lookup._CARDINALITY_SQL,
            scope + ((('store_key', identity_hash),),), ledger=ledger,
            base=base + 2 * len(identity), result_bytes=2 * (1024 + 256))
        candidate_count, comparison_bytes = lookup._candidate_rows(bucket_rows, 1)[0]
        del bucket_rows
        compare_values = scope + ('store_key', identity_hash)
        compare_frame_size = framing._json_size(compare_values) + 2 * len(identity) + 3
        ledger.admit(lookup.source_lookup_comparison_phase_bytes(
            base=base, identity_bytes=len(identity), frame_bytes=compare_frame_size,
            comparison_bytes=comparison_bytes, occurrences=candidate_count) + len(identity))
        compare_values += (identity.hex(),)
        prior_rows = _query(connection, lookup._COMPARE_SQL, compare_values,
            ledger=ledger, base=base + 2 * len(identity) + comparison_bytes + 384 * candidate_count,
            result_bytes=2 * 1024)
        prior = lookup._prior_row(prior_rows, plan, candidate_count=candidate_count,
                                  expected_revision=command.expected_revision)
        del prior_rows, compare_values
        if prior.observation_ref is not None and prior.incoming_evidence_bytes == 0:
            raise SourceUnavailable()  # Enhanced has no legacy synthetic raw lane.
        if expected is not None:
            if (expected.identity_bytes != identity
                    or expected.previous_revision != prior.source_revision
                    or expected.previous_evidence_sha256 != prior.evidence_sha256
                    or expected.previous_display_sha256 != prior.display_sha256
                    or prior.observation_ref is not None and expected.observation_ref != prior.observation_ref):
                raise SourceStale()
        ledger.admit(base + 2 * len(identity) + encode_phase)
        incoming_bytes = enhanced.encode_enhanced_incoming(incoming)
        n, i = len(incoming_bytes), len(identity)
        fixed = scope + (prior.observation_ref, prior.source_revision,
            prior.evidence_sha256, prior.display_sha256, identity_hash, i,
            prior.evidence_bytes, prior.display_bytes, prior.incoming_evidence_sha256,
            prior.incoming_evidence_bytes)
        frame_size = framing._json_size(fixed) + 2 * i + 3
        total_prior = prior.identity_bytes + prior.evidence_bytes + prior.display_bytes + prior.incoming_evidence_bytes
        # All scalar lengths come from genuine same-connection SQL. Admit BEFORE
        # raw projection, canonical prior decode, any merge or output expansion.
        prior_codec = 0
        if prior.observation_ref is not None:
            prior_codec = (enhanced.codec_phase_bytes(prior.incoming_evidence_bytes, prior.evidence_bytes)
                + enhanced.codec_phase_bytes(prior.display_bytes)
                + enhanced.codec_phase_bytes(prior.identity_bytes))
        codec_phase = (enhanced.codec_phase_bytes(n, prior.evidence_bytes)
            + prior_codec + enhanced.codec_phase_bytes(DISPLAY_ENCODE_BOUND))
        ledger.admit(base + 2 * (i + n) + 8 * frame_size + 4 + 4 * total_prior + codec_phase)
        previous_effective = previous_display = None
        same_incoming = False
        if prior.observation_ref is not None:
            raw = _prior_payloads(connection, fixed=fixed, identity=identity, prior=prior,
                                  ledger=ledger, base=base + 2 * (i + n))
            old_key = enhanced.decode_enhanced_identity(raw['identity_bytes'])
            old_incoming = enhanced.decode_enhanced_incoming(raw['incoming_evidence_bytes'])
            old_effective = enhanced.decode_enhanced_effective(raw['evidence_bytes'])
            old_display = enhanced.decode_enhanced_display(raw['display_bytes'])
            if any(key != incoming.store_key for key in (
                    old_key, old_incoming.store_key, old_effective.store_key, old_display.store_key)):
                raise SourceUnavailable()
            enhanced.check_enhanced_display(raw['display_bytes'], old_incoming)
            # A parsed prior must itself explain its effective vectors; an
            # unavailable prior raw observation may preserve an older vector.
            old_merge = enhanced.merge_enhanced_evidence(raw['incoming_evidence_bytes'], raw['evidence_bytes'])
            if old_merge.effective_bytes != raw['evidence_bytes']:
                raise SourceUnavailable()
            same_incoming = _same_incoming(old_incoming, incoming)
            previous_effective = raw['evidence_bytes']
            previous_display = raw['display_bytes']
            del raw, old_key, old_incoming, old_effective, old_display, old_merge
        merged = enhanced.merge_enhanced_evidence(incoming_bytes, previous_effective)
        display_bytes = enhanced.encode_enhanced_display(enhanced.build_enhanced_display(incoming))
        if len(display_bytes) > DISPLAY_ENCODE_BOUND:
            raise SourceUnavailable()
        changed = (prior.observation_ref is None or not same_incoming
                   or merged.effective_bytes != previous_effective or display_bytes != previous_display)
        # Same semantic incoming retains previous stored provenance in the real
        # writer. Never replace new raw provenance in this original: it proves
        # THIS upload/ordinal, while the writer's exact no-op retains old raw.
        payload_bytes = i + n + len(merged.effective_bytes) + len(display_bytes)
        result_hold = 2 * (1024 + payload_bytes)
        resulting_prefix_hold = prefix_hold + result_hold
        ledger.admit(base + 2 * (i + n) + 4 * total_prior
                     + 2 * (len(merged.effective_bytes) + len(display_bytes))
                     + result_hold + gate.PREPARE_GATE_BYTES)
        final = gate.begin_foobar_prepare_on_connection(
            connection, live_context, command=command, constraints=constraints)
        _same_ticket(final, fresh)
        source._authority(live_context, constraints)
        # Allocation happens once, only after every planning phase is admitted.
        observation_ref = prior.observation_ref
        if observation_ref is None:
            observation_ref = expected.observation_ref if expected is not None else str(uuid4())
        if any(row.source_write.observation_ref == observation_ref for row in retained):
            raise SourceUnavailable()
        write = SourceWrite(observation_ref, identity, prior.source_revision,
            prior.evidence_sha256, prior.display_sha256, merged.effective_bytes,
            display_bytes, incoming_bytes)
        if expected is not None and write != expected:
            raise SourceStale()
        return EnhancedPlannedSource(incoming.record_ordinal, ordinal, write, changed,
            same_incoming, prior.incoming_evidence_sha256, prior.incoming_evidence_bytes,
            prior.identity_bytes, prior.evidence_bytes, prior.display_bytes,
            candidate_count, comparison_bytes, ledger.peak, resulting_prefix_hold)
    except _PrivatePrefixFull:
        return None
    except (SourceUnavailable, SourceStale, gate.PrepareInvalid):
        raise
    except Exception:
        raise SourceUnavailable() from None
