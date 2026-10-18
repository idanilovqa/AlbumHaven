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
    return _normalize_checkpoint(payload, metadata.sample_rate, metadata.total_frames)


def _normalize_checkpoint(payload, sample_rate, maximum_extent):
    """Shared shape checks; maximum_extent is a bound, not verified media length."""
    if not isinstance(payload, dict) or set(payload) != _FIELDS:
        raise EvidenceError("invalid_fields")
    if payload["version"] != VERSION:
        raise EvidenceError("invalid_version")
    device, session = _uuid(payload["device_id"]), _uuid(payload["session_id"])
    sequence = _integer(payload["checkpoint_sequence"])
    rate = _integer(payload["sample_rate"], 8000, 192000)
    if rate != sample_rate:
        raise EvidenceError("metadata_mismatch")
    frames = _integer(payload["rendered_frames"])
    extent = _integer(payload["max_observed_frame"], 0, maximum_extent)
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
    previous_digest = (checkpoint_digest(previous, metadata, scope)
                       if previous is not None else None)
    return _compare_normalized_checkpoints(previous, incoming, digest, previous_digest)


def _compare_normalized_checkpoints(previous, incoming, digest, previous_digest):
    """Shared progression rules; callers validate both checkpoints and digests."""
    if previous is None:
        if incoming.checkpoint_sequence != 0:
            raise EvidenceError("sequence_gap")
        return Decision("accept", digest)
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


# Separately versioned dormant protocol. None of the v1 entry points call v2.
V2_VERSION = "rendered-position-slices-v2"
V2_DIGEST_DOMAIN = b"AlbumHaven:rendered-position-slices-v2\n"
_V2_FLAGS = ("instrumentation_complete", "occurrence_complete", "coverage_complete")
_V2_ENVELOPE = frozenset(("version", "decoder_instance_id", "process_epoch", "device_id",
    "session_id", "sample_rate", "checkpoint_sequence", "previous_digest", "cumulative",
    "epochs", "slices", "terminal"))
_V2_CUMULATIVE = frozenset(("rendered_frames", "max_observed_frame", "histogram_bin_frames",
    "histogram", "coverage_intervals", "resolution_state", *_V2_FLAGS))
_V2_EPOCH = frozenset(("epoch_id", "audio_origin_tick", "wall_origin_us", "uncertainty_us", "quality"))
_V2_SLICE = frozenset(("slice_id", "epoch_id", "first_consumption_frame", "frames",
    "render_start_tick", "render_end_tick", "runs", "quality"))
_V2_BINDING = ("decoder_instance_id", "process_epoch", "device_id", "session_id", "sample_rate")


def _v2_fields(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise EvidenceError("invalid_fields")


def _v2_list(value, maximum):
    if type(value) is not list or len(value) > maximum:
        raise EvidenceError("collection_limit")
    return value


def _v2_digest(value):
    if type(value) is not str or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise EvidenceError("invalid_digest")
    return value


def _v2_epoch(epoch):
    _v2_fields(epoch, _V2_EPOCH)
    _integer(epoch["epoch_id"], 0, 63)
    _integer(epoch["audio_origin_tick"])
    if epoch["quality"] == "unknown":
        if epoch["wall_origin_us"] is not None or epoch["uncertainty_us"] is not None:
            raise EvidenceError("invalid_epoch")
    elif epoch["quality"] == "app_clock_estimate":
        _integer(epoch["wall_origin_us"], -MAX_INTEGER)
        _integer(epoch["uncertainty_us"])
    else:
        raise EvidenceError("invalid_epoch")


def occurrence_boundary_v2(epoch, tick, sample_rate):
    """App-reported UTC estimate and conservative bound, never proof of audibility."""
    _v2_epoch(epoch)
    _integer(sample_rate, 8000, 192000)
    _integer(tick, epoch["audio_origin_tick"])
    if epoch["quality"] == "unknown":
        return {"wall_us": None, "uncertainty_us": None}
    wall = epoch["wall_origin_us"] + (tick - epoch["audio_origin_tick"]) * 1000000 // sample_rate
    return {"wall_us": _integer(wall, -MAX_INTEGER),
            "uncertainty_us": _integer(epoch["uncertainty_us"] + 1)}


def empty_cumulative_v2(sample_rate):
    _integer(sample_rate, 8000, 192000)
    return {"rendered_frames": 0, "max_observed_frame": 0,
            "histogram_bin_frames": sample_rate, "histogram": [], "coverage_intervals": [],
            "resolution_state": "one_second", **{flag: True for flag in _V2_FLAGS}}


def _v2_cumulative(value, rate):
    _v2_fields(value, _V2_CUMULATIVE)
    for key in _V2_FLAGS:
        if type(value[key]) is not bool:
            raise EvidenceError("invalid_flag")
    if not value["instrumentation_complete"] and (value["occurrence_complete"] or value["coverage_complete"]):
        raise EvidenceError("inconsistent_quality_or_delta")
    frames = _integer(value["rendered_frames"])
    extent = _integer(value["max_observed_frame"])
    width = _integer(value["histogram_bin_frames"], 1)
    if width != bin_width(rate, extent) or value["resolution_state"] != ("one_second" if width == rate else "coarsened"):
        raise EvidenceError("invalid_resolution")
    histogram = _pairs(value["histogram"], MAX_BINS)
    last = -1
    for index, weight in histogram:
        if index <= last or index >= MAX_BINS or weight < 1 or index * width >= extent:
            raise EvidenceError("invalid_histogram")
        last = index
    if sum(w for _, w in histogram) != frames or (frames == 0) != (extent == 0):
        raise EvidenceError("histogram_total_mismatch")
    if histogram and histogram[-1][0] != (extent - 1) // width:
        raise EvidenceError("unsupported_extent")
    last = -1
    coverage = _pairs(value["coverage_intervals"], MAX_INTERVALS)
    for start, end in coverage:
        if start <= last or end <= start or end > extent:
            raise EvidenceError("invalid_coverage")
        last = end
    if sum(b - a for a, b in coverage) > frames:
        raise EvidenceError("coverage_exceeds_rendered")


def normalize_checkpoint_v2(payload):
    """Validate a decoded object and return a detached canonical-shaped copy.

    For untrusted JSON use parse_checkpoint_v2: a decoded dict cannot reveal
    duplicate keys or lexical float spellings. Cross-checkpoint checks are separate.
    """
    _v2_fields(payload, _V2_ENVELOPE)
    if payload["version"] != V2_VERSION:
        raise EvidenceError("invalid_version")
    for name in _V2_BINDING[:-1]:
        _uuid(payload[name])
    rate = _integer(payload["sample_rate"], 8000, 192000)
    seq = _integer(payload["checkpoint_sequence"], 0, 719)
    if seq == 0:
        if payload["previous_digest"] is not None:
            raise EvidenceError("invalid_previous_digest")
    else:
        _v2_digest(payload["previous_digest"])
    if payload["terminal"] not in (None, "source_exhausted", "collection_limited", "client_stopped"):
        raise EvidenceError("invalid_terminal")
    _v2_cumulative(payload["cumulative"], rate)
    for epoch in _v2_list(payload["epochs"], 16):
        _v2_epoch(epoch)
    count = 0
    for item in _v2_list(payload["slices"], 128):
        _v2_fields(item, _V2_SLICE)
        _integer(item["slice_id"], 0, 7199)
        _integer(item["epoch_id"], 0, 63)
        _integer(item["first_consumption_frame"])
        _integer(item["frames"], 1)
        start, end = _integer(item["render_start_tick"]), _integer(item["render_end_tick"])
        if not 0 < end - start <= rate:
            raise EvidenceError("invalid_slice_span")
        quality = item["quality"]
        _v2_fields(quality, ("instrumentation_complete", "occurrence_quality"))
        if type(quality["instrumentation_complete"]) is not bool or quality["occurrence_quality"] not in ("unknown", "app_clock_estimate"):
            raise EvidenceError("invalid_quality")
        runs = _v2_list(item["runs"], 256)
        if not runs:
            raise EvidenceError("empty_slice")
        total, prior = 0, start
        for run in runs:
            if type(run) is not list or len(run) != 3:
                raise EvidenceError("invalid_run")
            source, frames, tick = _integer(run[0]), _integer(run[1], 1), _integer(run[2])
            _integer(source + frames)
            stop = _integer(tick + frames)
            if tick < prior or stop > end:
                raise EvidenceError("invalid_run_order")
            total = _integer(total + frames)
            prior = stop
        if runs[0][2] != start or prior != end or total != item["frames"]:
            raise EvidenceError("slice_total_mismatch")
        _integer(item["first_consumption_frame"] + total)
        count += len(runs)
    if count > 2048:
        raise EvidenceError("collection_limit")
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    if len(body) > MAX_BODY_BYTES:
        raise EvidenceError("checkpoint_body_limit")
    return json.loads(body)


def parse_checkpoint_v2(body):
    """Bounded strict JSON entry: reject duplicate keys and noninteger tokens."""
    if type(body) is not str or not body.isascii() or len(body) > MAX_BODY_BYTES:
        raise EvidenceError("checkpoint_body_limit")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise EvidenceError("duplicate_key")
            result[key] = value
        return result
    def number(token):
        if token == "-0" or len(token.lstrip("-")) > 16:
            raise EvidenceError("invalid_integer")
        return _integer(int(token), -MAX_INTEGER)
    def reject(_):
        raise EvidenceError("invalid_integer")
    try:
        value = json.loads(body, object_pairs_hook=pairs, parse_int=number,
                           parse_float=reject, parse_constant=reject)
    except (ValueError, RecursionError) as exc:
        if isinstance(exc, EvidenceError):
            raise
        raise EvidenceError("invalid_json") from None
    return normalize_checkpoint_v2(value)


def canonical_checkpoint_v2(payload):
    return json.dumps(normalize_checkpoint_v2(payload), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=True).encode("ascii")


def checkpoint_digest_v2(payload):
    return hashlib.sha256(V2_DIGEST_DOMAIN + canonical_checkpoint_v2(payload)).hexdigest()


def _v2_union(intervals, start, end):
    result, inserted = [], False
    for a, b in intervals:
        if b < start:
            result.append([a, b])
        elif end < a:
            if not inserted:
                result.append([start, end])
                inserted = True
            result.append([a, b])
        else:
            start, end = min(start, a), max(end, b)
    if not inserted:
        result.append([start, end])
    return result


def _v2_reduce(base, slices, rate, terminal):
    extent = max([base["max_observed_frame"]] + [s + f for x in slices for s, f, _ in x["runs"]])
    width = bin_width(rate, extent)
    bins = _coarsened(base["histogram"], base["histogram_bin_frames"], width)
    result = {**base, "histogram_bin_frames": width, "max_observed_frame": extent,
              "resolution_state": "one_second" if width == rate else "coarsened"}
    coverage = [list(pair) for pair in base["coverage_intervals"]]
    for item in slices:
        result["instrumentation_complete"] &= item["quality"]["instrumentation_complete"]
        result["occurrence_complete"] &= item["quality"]["occurrence_quality"] == "app_clock_estimate"
        result["rendered_frames"] = _integer(result["rendered_frames"] + item["frames"])
        for start, frames, _ in item["runs"]:
            end = start + frames
            for index in range(start // width, (end - 1) // width + 1):
                bins[index] = _integer(bins.get(index, 0) + min(end, (index + 1) * width) - max(start, index * width))
            merged = _v2_union(coverage, start, end)
            if len(merged) <= MAX_INTERVALS:
                coverage = merged
            else:
                result["coverage_complete"] = False
    if terminal == "collection_limited":
        result["instrumentation_complete"] = False
    if not result["instrumentation_complete"]:
        result["occurrence_complete"] = result["coverage_complete"] = False
    result["histogram"] = [list(pair) for pair in sorted(bins.items())]
    result["coverage_intervals"] = coverage
    return result


def compare_checkpoint_v2(previous, payload, binding, observed_ranges):
    """Pure validation only; caller MUST check live source/auth before any outcome.

    previous is None or the accepted state returned by this function, restored
    from trusted storage. It is not wire input. Replays return no new state or
    receipt: the caller returns its exact original persisted receipt after checks.
    observed_ranges is the durable exact decoded union, not a duration/bin bound.
    Binding contains only the five protocol binding keys; scope stays server-owned.
    """
    incoming = normalize_checkpoint_v2(payload)
    _v2_fields(binding, _V2_BINDING)
    for key in _V2_BINDING[:-1]:
        _uuid(binding[key])
    _integer(binding["sample_rate"], 8000, 192000)
    if any(incoming[key] != binding[key] for key in _V2_BINDING):
        raise EvidenceError("identity_changed")
    observed = _pairs(observed_ranges, MAX_INTERVALS)
    end = -1
    for a, b in observed:
        if a <= end or b <= a:
            raise EvidenceError("invalid_observed_ranges")
        end = b
    digest = checkpoint_digest_v2(incoming)
    latest = None
    epochs = []
    last_slice, last_epoch, last_tick = -1, -1, 0
    if previous is not None:
        _v2_fields(previous, ("latest", "epochs", "last_slice_id", "last_epoch_id", "last_render_end_tick"))
        latest = normalize_checkpoint_v2(previous["latest"])
        if any(latest[key] != binding[key] for key in _V2_BINDING):
            raise EvidenceError("identity_changed")
        epochs = _v2_list(previous["epochs"], 64)
        for index, epoch in enumerate(epochs):
            _v2_epoch(epoch)
            if epoch["epoch_id"] != index:
                raise EvidenceError("invalid_state")
        last_slice = _integer(previous["last_slice_id"], 0, 7199)
        last_epoch = _integer(previous["last_epoch_id"], 0, 63)
        last_tick = _integer(previous["last_render_end_tick"])
        if last_epoch != len(epochs) - 1 or last_tick < epochs[last_epoch]["audio_origin_tick"]:
            raise EvidenceError("invalid_state")
        if last_epoch > last_slice or last_slice >= latest["cumulative"]["rendered_frames"]:
            raise EvidenceError("invalid_state")
        for epoch in latest["epochs"]:
            if epoch["epoch_id"] >= len(epochs) or epoch != epochs[epoch["epoch_id"]]:
                raise EvidenceError("invalid_state")
        tail = latest["slices"]
        if not tail and latest["epochs"]:
            raise EvidenceError("invalid_state")
        if tail:
            final = tail[-1]
            if (final["slice_id"] != last_slice or final["epoch_id"] != last_epoch
                    or final["render_end_tick"] != last_tick
                    or final["first_consumption_frame"] + final["frames"] != latest["cumulative"]["rendered_frames"]):
                raise EvidenceError("invalid_state")
        seq, old_seq = incoming["checkpoint_sequence"], latest["checkpoint_sequence"]
        if seq < old_seq:
            return {"kind": "stale", "digest": digest, "state": None}
        if seq == old_seq:
            if canonical_checkpoint_v2(incoming) != canonical_checkpoint_v2(latest):
                raise EvidenceError("sequence_conflict")
            return {"kind": "replay", "digest": digest, "state": None}
        if latest["terminal"] is not None:
            raise EvidenceError("already_finalized")
        if seq != old_seq + 1:
            raise EvidenceError("sequence_gap")
        if incoming["previous_digest"] != checkpoint_digest_v2(latest):
            raise EvidenceError("previous_digest_mismatch")
    elif incoming["checkpoint_sequence"] != 0:
        raise EvidenceError("sequence_gap")
    if not incoming["slices"] and latest is None:
        raise EvidenceError("empty_initial_checkpoint")
    epochs = [dict(epoch) for epoch in epochs]
    old_count = len(epochs)
    for epoch in incoming["epochs"]:
        if epoch["epoch_id"] != len(epochs) or len(epochs) >= 64:
            raise EvidenceError("epoch_redefinition")
        epochs.append(epoch)
    base = latest["cumulative"] if latest else empty_cumulative_v2(incoming["sample_rate"])
    cursor = base["rendered_frames"]
    used = set()
    for item in incoming["slices"]:
        if item["slice_id"] != last_slice + 1 or item["first_consumption_frame"] != cursor:
            raise EvidenceError("slice_cursor_gap")
        eid = item["epoch_id"]
        if eid < last_epoch:
            raise EvidenceError("retired_epoch")
        if eid >= len(epochs) or eid > last_epoch + 1:
            raise EvidenceError("epoch_gap")
        epoch = epochs[eid]
        if item["quality"]["occurrence_quality"] != epoch["quality"]:
            raise EvidenceError("invalid_quality")
        if eid == last_epoch and item["render_start_tick"] < last_tick:
            raise EvidenceError("overlapping_slice")
        for start, frames, tick in item["runs"]:
            occurrence_boundary_v2(epoch, tick, incoming["sample_rate"])
            occurrence_boundary_v2(epoch, tick + frames, incoming["sample_rate"])
            if not any(a <= start and start + frames <= b for a, b in observed):
                raise EvidenceError("admission_not_ready")
        used.add(eid)
        last_slice, last_epoch, last_tick = item["slice_id"], eid, item["render_end_tick"]
        cursor = _integer(cursor + item["frames"])
    if used.intersection(range(old_count, len(epochs))) != set(range(old_count, len(epochs))):
        raise EvidenceError("unused_epoch")
    expected = _v2_reduce(base, incoming["slices"], incoming["sample_rate"], incoming["terminal"])
    submitted = incoming["cumulative"]
    for key in _V2_CUMULATIVE:
        if (key in _V2_FLAGS and submitted[key] and not expected[key]) or (key not in _V2_FLAGS and submitted[key] != expected[key]):
            raise EvidenceError("inconsistent_quality_or_delta")
    if not incoming["slices"] and incoming["terminal"] is None and all(submitted[k] == base[k] for k in _V2_FLAGS):
        raise EvidenceError("unchanged_checkpoint")
    state = {"latest": incoming, "epochs": epochs, "last_slice_id": last_slice,
             "last_epoch_id": last_epoch, "last_render_end_tick": last_tick}
    return {"kind": "accept", "digest": digest, "state": state}
