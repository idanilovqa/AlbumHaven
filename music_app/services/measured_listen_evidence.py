"""Pure bounded rendered-position evidence; no I/O or authentication.

The future service must authenticate scope and validate decoder metadata before
calling this module. Successful normalization proves shape/consistency only.
"""
from dataclasses import dataclass
import hashlib
import json
from uuid import UUID

VERSION = "rendered-position-histogram-v1"
MAX_INTEGER = 9_007_199_254_740_991
MAX_BINS = 2048
MAX_INTERVALS = 4096
MAX_BODY_BYTES = 262_144
_FIELDS = frozenset(("version", "device_id", "session_id", "checkpoint_sequence",
                     "sample_rate", "histogram_bin_frames", "histogram",
                     "rendered_frames", "max_observed_frame", "coverage_intervals",
                     "coverage_complete", "instrumentation_complete",
                     "resolution_state", "finalized"))


class EvidenceError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class MediaMetadata:
    """Decoder facts supplied by the caller; this type grants no authority."""
    sample_rate: int
    total_frames: int


@dataclass(frozen=True)
class EvidenceScope:
    """Resolved identity supplied by the caller, never accepted from wire JSON."""
    account_id: int
    library_id: int
    track_id: int


@dataclass(frozen=True)
class Checkpoint:
    device_id: str
    session_id: str
    checkpoint_sequence: int
    sample_rate: int
    histogram_bin_frames: int
    histogram: tuple[tuple[int, int], ...]
    rendered_frames: int
    max_observed_frame: int
    coverage_intervals: tuple[tuple[int, int], ...]
    coverage_complete: bool
    instrumentation_complete: bool
    resolution_state: str
    finalized: bool

    def wire(self):
        return {"version": VERSION, "device_id": self.device_id,
                "session_id": self.session_id,
                "checkpoint_sequence": self.checkpoint_sequence,
                "sample_rate": self.sample_rate,
                "histogram_bin_frames": self.histogram_bin_frames,
                "histogram": [list(pair) for pair in self.histogram],
                "rendered_frames": self.rendered_frames,
                "max_observed_frame": self.max_observed_frame,
                "coverage_intervals": [list(pair) for pair in self.coverage_intervals],
                "coverage_complete": self.coverage_complete,
                "instrumentation_complete": self.instrumentation_complete,
                "resolution_state": self.resolution_state, "finalized": self.finalized}


@dataclass(frozen=True)
class Decision:
    # replay means return the caller's exact persisted latest receipt; stale is
    # never a claim that an older receipt exists or that its bytes were accepted.
    kind: str
    digest: str


def _integer(value, minimum=0, maximum=MAX_INTEGER):
    if type(value) is not int or not minimum <= value <= maximum:
        raise EvidenceError("invalid_integer")
    return value


def _uuid(value):
    if not isinstance(value, str):
        raise EvidenceError("invalid_identity")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError):
        raise EvidenceError("invalid_identity") from None
    if parsed.int == 0 or str(parsed) != value:
        raise EvidenceError("invalid_identity")
    return value


def _metadata(metadata):
    if not isinstance(metadata, MediaMetadata):
        raise EvidenceError("invalid_metadata")
    _integer(metadata.sample_rate, 8000, 192000)
    _integer(metadata.total_frames, 1)


def bin_width(sample_rate, max_observed_frame):
    """One-second bins, doubled only as far as needed for the observed extent."""
    _integer(sample_rate, 8000, 192000)
    _integer(max_observed_frame)
    width = sample_rate
    while max_observed_frame > width * MAX_BINS:
        width *= 2
    return width


def _pairs(value, limit):
    if not isinstance(value, list) or len(value) > limit:
        raise EvidenceError("invalid_pairs")
    result = []
    for pair in value:
        if not isinstance(pair, list) or len(pair) != 2:
            raise EvidenceError("invalid_pairs")
        result.append((_integer(pair[0]), _integer(pair[1])))
    return tuple(result)


def normalize_checkpoint(payload, metadata):
    """Reject noncanonical shape; do not silently sort, merge or discard input."""
    _metadata(metadata)
    if not isinstance(payload, dict) or set(payload) != _FIELDS:
        raise EvidenceError("invalid_fields")
    if payload["version"] != VERSION:
        raise EvidenceError("invalid_version")
    device, session = _uuid(payload["device_id"]), _uuid(payload["session_id"])
    sequence = _integer(payload["checkpoint_sequence"])
    rate = _integer(payload["sample_rate"], 8000, 192000)
    if rate != metadata.sample_rate:
        raise EvidenceError("metadata_mismatch")
    frames = _integer(payload["rendered_frames"])
    extent = _integer(payload["max_observed_frame"], 0, metadata.total_frames)
    width = _integer(payload["histogram_bin_frames"], 1)
    if width != bin_width(rate, extent):
        raise EvidenceError("invalid_resolution")
    resolution = "one_second" if width == rate else "coarsened"
    if payload["resolution_state"] != resolution:
        raise EvidenceError("invalid_resolution")
    histogram = _pairs(payload["histogram"], MAX_BINS)
    coverage = _pairs(payload["coverage_intervals"], MAX_INTERVALS)
    for flag in ("coverage_complete", "instrumentation_complete", "finalized"):
        if type(payload[flag]) is not bool:
            raise EvidenceError("invalid_flag")
    last = -1
    for index, weight in histogram:
        if index <= last or index >= MAX_BINS or weight < 1 or index * width >= extent:
            raise EvidenceError("invalid_histogram")
        last = index
    if sum(weight for _, weight in histogram) != frames:
        raise EvidenceError("histogram_total_mismatch")
    if (frames == 0) != (extent == 0) or (frames == 0) != (not histogram):
        raise EvidenceError("invalid_extent")
    if histogram and histogram[-1][0] != (extent - 1) // width:
        raise EvidenceError("unsupported_extent")
    previous_end = -1
    for start, end in coverage:
        if end <= start or start <= previous_end or end > extent:
            raise EvidenceError("invalid_coverage")
        previous_end = end
    if sum(end - start for start, end in coverage) > frames:
        raise EvidenceError("coverage_exceeds_rendered")
    # Each claimed covered frame needs at least one rendered frame in that bin.
    required = {}
    for start, end in coverage:
        first, final = start // width, (end - 1) // width
        for index in range(first, final + 1):
            required[index] = required.get(index, 0) + min(end, (index + 1) * width) - max(start, index * width)
    weights = dict(histogram)
    if any(weights.get(index, 0) < count for index, count in required.items()):
        raise EvidenceError("coverage_without_rendered_support")
    if payload["coverage_complete"] and any(index not in required for index in weights):
        raise EvidenceError("rendered_without_coverage")
    if payload["coverage_complete"] and frames and (not coverage or coverage[-1][1] != extent):
        raise EvidenceError("incomplete_extent_coverage")
    return Checkpoint(device, session, sequence, rate, width, histogram, frames,
                      extent, coverage, payload["coverage_complete"],
                      payload["instrumentation_complete"], resolution, payload["finalized"])


def _canonical(checkpoint, metadata, scope):
    if not isinstance(checkpoint, Checkpoint) or not isinstance(scope, EvidenceScope):
        raise EvidenceError("invalid_state")
    # Frozen dataclasses can still be constructed by callers: validate again.
    checked = normalize_checkpoint(checkpoint.wire(), metadata)
    values = {name: _integer(getattr(scope, name), 1)
              for name in ("account_id", "library_id", "track_id")}
    values.update(metadata_sample_rate=metadata.sample_rate,
                  metadata_total_frames=metadata.total_frames, checkpoint=checked.wire())
    return json.dumps(values, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def checkpoint_digest(checkpoint, metadata, scope):
    return hashlib.sha256(_canonical(checkpoint, metadata, scope)).hexdigest()


def _coarsened(histogram, old_width, new_width):
    if new_width < old_width or new_width % old_width:
        raise EvidenceError("resolution_regressed")
    factor, result = new_width // old_width, {}
    for index, weight in histogram:
        target = index // factor
        result[target] = result.get(target, 0) + weight
    return result


def _contains_all(previous, incoming):
    index = 0
    for start, end in previous:
        while index < len(incoming) and incoming[index][1] <= start:
            index += 1
        if index == len(incoming) or incoming[index][0] > start or incoming[index][1] < end:
            return False
    return True


def _added_coverage(previous, incoming):
    """Subtract the previous exact lower bound; never backfill unknown frames."""
    index = 0
    added = []
    for start, end in incoming:
        cursor = start
        while index < len(previous) and previous[index][1] <= start:
            index += 1
        scan = index
        while scan < len(previous) and previous[scan][0] < end:
            old_start, old_end = previous[scan]
            if old_start > cursor:
                added.append((cursor, min(old_start, end)))
            cursor = max(cursor, old_end)
            if cursor >= end:
                break
            scan += 1
        if cursor < end:
            added.append((cursor, end))
    return added


def compare_checkpoint(previous, incoming, metadata, scope):
    """Decide latest/replay/stale without persisting or manufacturing receipts."""
    digest = checkpoint_digest(incoming, metadata, scope)
    if previous is None:
        if incoming.checkpoint_sequence != 0:
            raise EvidenceError("sequence_gap")
        return Decision("accept", digest)
    previous_digest = checkpoint_digest(previous, metadata, scope)
    if (previous.device_id, previous.session_id, previous.sample_rate) != (
            incoming.device_id, incoming.session_id, incoming.sample_rate):
        raise EvidenceError("identity_changed")
    if incoming.checkpoint_sequence < previous.checkpoint_sequence:
        return Decision("stale", digest)
    if incoming.checkpoint_sequence == previous.checkpoint_sequence:
        if digest != previous_digest:
            raise EvidenceError("sequence_conflict")
        return Decision("replay", digest)
    if previous.finalized:
        raise EvidenceError("already_finalized")
    if incoming.checkpoint_sequence != previous.checkpoint_sequence + 1:
        raise EvidenceError("sequence_gap")
    if (incoming.rendered_frames < previous.rendered_frames
            or incoming.max_observed_frame < previous.max_observed_frame):
        raise EvidenceError("counter_regressed")
    if (not previous.coverage_complete and incoming.coverage_complete
            or not previous.instrumentation_complete and incoming.instrumentation_complete):
        raise EvidenceError("quality_regressed")
    if not _contains_all(previous.coverage_intervals, incoming.coverage_intervals):
        raise EvidenceError("coverage_regressed")
    old_bins = _coarsened(previous.histogram, previous.histogram_bin_frames,
                          incoming.histogram_bin_frames)
    new_bins = dict(incoming.histogram)
    if any(new_bins.get(index, 0) < count for index, count in old_bins.items()):
        raise EvidenceError("histogram_regressed")
    # Cumulative repeated weight cannot be repurposed as new unique positions.
    # This also applies when previous coverage was incomplete: unknown old
    # positions are not permission to retrofit a more favorable coverage map.
    added = _added_coverage(previous.coverage_intervals, incoming.coverage_intervals)
    if sum(end - start for start, end in added) > incoming.rendered_frames - previous.rendered_frames:
        raise EvidenceError("coverage_without_new_rendered_support")
    required = {}
    width = incoming.histogram_bin_frames
    for start, end in added:
        for index in range(start // width, (end - 1) // width + 1):
            required[index] = required.get(index, 0) + min(end, (index + 1) * width) - max(start, index * width)
    if any(new_bins.get(index, 0) - old_bins.get(index, 0) < count
           for index, count in required.items()):
        raise EvidenceError("coverage_without_new_rendered_support")
    if incoming.max_observed_frame > previous.max_observed_frame:
        last = (incoming.max_observed_frame - 1) // width
        if new_bins.get(last, 0) <= old_bins.get(last, 0):
            raise EvidenceError("extent_without_new_rendered_support")
    return Decision("accept", digest)
