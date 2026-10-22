"""Pure server-observation admission contract, with no I/O or authority grant.

All metadata must come from a future authenticated server owner. Decoder identity
binds one instance, NOT verified file content or interchangeable decoder runs.
Observations mean decoded frames, not delivered audio or human listening.
Checkpoint histogram weights remain application-reported rendering. Bin/range
intersection is consistency support, not exact-position attestation; only the
coverage intervals carry an exact lower bound. No completion is inferred.
"""
from dataclasses import dataclass
import hashlib
import json

from music_app.services import measured_listen_evidence as evidence

ADMISSION_VERSION = "decoder-instance-admission-v1"
VERIFIED_PROVENANCE = "successful_from_zero_decode"


@dataclass(frozen=True)
class AdmissionIdentity:
    scope: evidence.EvidenceScope
    device_id: str
    session_id: str
    sample_rate: int
    decoder_instance_id: str


@dataclass(frozen=True)
class AdmissionMetadata:
    identity: AdmissionIdentity
    metadata_revision: int
    observed_intervals: tuple[tuple[int, int], ...]
    extent_state: str = "observed_partial"
    verified_total_frames: int | None = None
    extent_provenance: str | None = None
    admission_limited: bool = False


@dataclass(frozen=True)
class AcceptedEvidence:
    """Persist together on accept; retain the original admission snapshot.

    This is not a receipt or proof of persistence. A replay decision tells the
    caller to return its exact persisted latest receipt without replacing its
    admission snapshot, digest, or acceptance-time provenance with newer facts.
    """
    admission: AdmissionMetadata
    checkpoint: evidence.Checkpoint
    digest: str


def _identity_values(identity):
    if not isinstance(identity, AdmissionIdentity) or not isinstance(identity.scope, evidence.EvidenceScope):
        raise evidence.EvidenceError("invalid_admission_identity")
    values = {name: evidence._integer(getattr(identity.scope, name), 1)
              for name in ("account_id", "library_id", "track_id")}
    values.update(device_id=evidence._uuid(identity.device_id),
                  session_id=evidence._uuid(identity.session_id),
                  sample_rate=evidence._integer(identity.sample_rate, 8000, 192000),
                  decoder_instance_id=evidence._uuid(identity.decoder_instance_id))
    return values


def validate_admission(metadata):
    """Validate canonical immutable-shaped facts, never authenticate their source.

    A bounded conservative union must retain all earlier admitted ranges. On
    fragmentation overflow the future server can omit NEW ranges and set limited;
    it cannot bridge gaps or forget prior ranges. This function never compacts.
    """
    if not isinstance(metadata, AdmissionMetadata):
        raise evidence.EvidenceError("invalid_admission")
    _identity_values(metadata.identity)
    evidence._integer(metadata.metadata_revision)
    if type(metadata.admission_limited) is not bool:
        raise evidence.EvidenceError("invalid_flag")
    intervals = metadata.observed_intervals
    if type(intervals) is not tuple or len(intervals) > evidence.MAX_INTERVALS:
        raise evidence.EvidenceError("invalid_observed_intervals")
    previous_end = -1
    for pair in intervals:
        if type(pair) is not tuple or len(pair) != 2:
            raise evidence.EvidenceError("invalid_observed_intervals")
        start, end = evidence._integer(pair[0]), evidence._integer(pair[1])
        if end <= start or start <= previous_end:
            raise evidence.EvidenceError("invalid_observed_intervals")
        previous_end = end
    if metadata.extent_state == "observed_partial":
        if metadata.verified_total_frames is not None or metadata.extent_provenance is not None:
            raise evidence.EvidenceError("invalid_extent_provenance")
    elif metadata.extent_state == "verified_complete":
        total = evidence._integer(metadata.verified_total_frames, 1)
        if metadata.extent_provenance != VERIFIED_PROVENANCE:
            raise evidence.EvidenceError("invalid_extent_provenance")
        # Successful from-zero decode must observe the whole decoded stream.
        # Seek-only EOS, estimates, and a maximum observed position cannot pass.
        if intervals != ((0, total),):
            raise evidence.EvidenceError("verified_extent_conflict")
    else:
        raise evidence.EvidenceError("invalid_extent_state")
    return metadata


def compare_admission(previous, incoming):
    """Validate monotonic server metadata independently of evidence sequence.

    Revisions may skip unseen snapshots, but changed facts require an increase.
    A verified extent is final for this decoder instance and cannot be repaired
    by truncation. Metadata updates alone never manufacture rendered evidence.
    """
    validate_admission(previous)
    validate_admission(incoming)
    if previous.identity != incoming.identity:
        raise evidence.EvidenceError("admission_identity_changed")
    if incoming.metadata_revision < previous.metadata_revision:
        raise evidence.EvidenceError("metadata_revision_regressed")
    if incoming.metadata_revision == previous.metadata_revision and incoming != previous:
        raise evidence.EvidenceError("metadata_revision_conflict")
    if (incoming.verified_total_frames is not None and previous.observed_intervals
            and previous.observed_intervals[-1][1] > incoming.verified_total_frames):
        raise evidence.EvidenceError("verified_extent_conflict")
    if previous.extent_state == "verified_complete" and (
            incoming.extent_state != "verified_complete"
            or incoming.verified_total_frames != previous.verified_total_frames):
        raise evidence.EvidenceError("verified_extent_conflict")
    if not evidence._contains_all(previous.observed_intervals, incoming.observed_intervals):
        raise evidence.EvidenceError("observed_intervals_regressed")
    if previous.admission_limited and not incoming.admission_limited:
        raise evidence.EvidenceError("admission_quality_regressed")
    return incoming


def _shape(payload, identity):
    _identity_values(identity)
    # MAX_INTEGER is only the wire format's numeric ceiling; it is not a
    # fabricated total length and is never serialized as decoder metadata.
    checked = evidence._normalize_checkpoint(payload, identity.sample_rate, evidence.MAX_INTEGER)
    if (checked.device_id, checked.session_id) != (identity.device_id, identity.session_id):
        raise evidence.EvidenceError("admission_identity_changed")
    return checked


def normalize_admitted_checkpoint(payload, metadata):
    """Validate new evidence against the current server-observed interval union."""
    validate_admission(metadata)
    checked = _shape(payload, metadata.identity)
    ranges = metadata.observed_intervals
    if not evidence._contains_all(checked.coverage_intervals, ranges):
        raise evidence.EvidenceError("coverage_outside_observation")
    extent = checked.max_observed_frame
    if extent and not evidence._contains_all(((extent - 1, extent),), ranges):
        raise evidence.EvidenceError("extent_outside_observation")
    # Incomplete coverage does not identify all rendered positions. Require
    # at least possible observed support in each occupied bin, clipped to the
    # claimed extent, without imposing unique-frame limits on repeat weights.
    width = checked.histogram_bin_frames
    cursor = 0
    for index, _ in checked.histogram:
        start, end = index * width, min((index + 1) * width, extent)
        while cursor < len(ranges) and ranges[cursor][1] <= start:
            cursor += 1
        if cursor == len(ranges) or ranges[cursor][0] >= end:
            raise evidence.EvidenceError("histogram_outside_observation")
    return checked


def admitted_checkpoint_digest(checkpoint, identity):
    """Stable identity/evidence digest; does not perform current admission checks.

    Mutable ranges, metadata revision, extent/provenance and limited state are
    deliberately excluded. Use normalize/compare for admission, not this digest.
    Fixed MediaMetadata digests retain their separate, unchanged old semantics.
    """
    values = _identity_values(identity)
    if not isinstance(checkpoint, evidence.Checkpoint):
        raise evidence.EvidenceError("invalid_state")
    checked = _shape(checkpoint.wire(), identity)
    values.update(admission_version=ADMISSION_VERSION, checkpoint=checked.wire())
    canonical = json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    return hashlib.sha256(canonical).hexdigest()


def compare_admitted_checkpoint(previous, incoming, metadata):
    """Decide accept/replay/stale; do not persist or manufacture a receipt.

    On accept the caller atomically persists AcceptedEvidence(metadata, incoming,
    decision.digest) with its own receipt. On replay retain that original record.
    Current metadata evolution must also be checked against the latest SERVER
    snapshot by its owner, even when no evidence checkpoints have been accepted.
    """
    validate_admission(metadata)
    digest = admitted_checkpoint_digest(incoming, metadata.identity)
    if previous is None:
        normalize_admitted_checkpoint(incoming.wire(), metadata)
        return evidence._compare_normalized_checkpoints(None, incoming, digest, None)
    if (not isinstance(previous, AcceptedEvidence)
            or not isinstance(previous.checkpoint, evidence.Checkpoint)):
        raise evidence.EvidenceError("invalid_accepted_evidence")
    normalize_admitted_checkpoint(previous.checkpoint.wire(), previous.admission)
    previous_digest = admitted_checkpoint_digest(previous.checkpoint, previous.admission.identity)
    if previous.digest != previous_digest:
        raise evidence.EvidenceError("accepted_digest_mismatch")
    compare_admission(previous.admission, metadata)
    # Exact latest replay is checked against persisted original admission facts;
    # never re-admit the old checkpoint under newly serialized mutable metadata.
    if incoming.checkpoint_sequence <= previous.checkpoint.checkpoint_sequence:
        return evidence._compare_normalized_checkpoints(previous.checkpoint, incoming,
                                                        digest, previous.digest)
    normalize_admitted_checkpoint(incoming.wire(), metadata)
    return evidence._compare_normalized_checkpoints(previous.checkpoint, incoming,
                                                    digest, previous.digest)
