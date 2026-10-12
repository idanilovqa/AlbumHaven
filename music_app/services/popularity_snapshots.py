"""Pure app-owned values and selection over cached Last.fm global popularity.

These records are normalized application inputs, not a crawler wire contract.
Callers own local admission, genre/artist filtering and cache-only snapshot reads.
This module neither grants access nor performs provider, storage or refresh work.
"""
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal


@dataclass(frozen=True)
class PopularityObservation:
    provider: str
    metric: str
    source_entity_id: str
    source_revision: str
    observed_at: datetime
    imported_at: datetime
    count: int | None
    attribution_state: Literal["resolved", "missing", "ambiguous"]


@dataclass(frozen=True)
class LocalTrackEvidence:
    track_id: int
    mapping_revision: str
    provider: str
    source_entity_id: str
    canonical_recording_id: str | None
    recording_evidence: str | None
    canonical_artist_id: str | None
    artist_evidence: str | None


@dataclass(frozen=True)
class CachedPopularity:
    local_track_id: int
    mapping_revision: str
    observation: PopularityObservation


@dataclass(frozen=True)
class PopularitySelection:
    tracks: tuple[LocalTrackEvidence, ...]
    total: int
    diagnostics: tuple[tuple[int, str], ...]


def _nonblank(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _integer(value: object, minimum: int) -> bool:
    return type(value) is int and value >= minimum


def validate_observation(value: PopularityObservation) -> PopularityObservation:
    """Reject malformed normalized values without coercing provider data."""
    if not isinstance(value, PopularityObservation):
        raise ValueError("Expected a normalized popularity observation")
    if value.provider != "lastfm" or value.metric != "overall_scrobbles":
        raise ValueError("Unsupported global popularity metric")
    if not _nonblank(value.source_entity_id) or not _nonblank(value.source_revision):
        raise ValueError("Source identity and revision are required")
    for timestamp in (value.observed_at, value.imported_at):
        if not isinstance(timestamp, datetime) or timestamp.utcoffset() != timedelta(0):
            raise ValueError("Popularity timestamps must be timezone-aware UTC")
    if value.imported_at < value.observed_at:
        raise ValueError("Import cannot precede provider observation")
    if value.attribution_state not in ("resolved", "missing", "ambiguous"):
        raise ValueError("Invalid attribution state")
    if value.count is not None and (
        not _integer(value.count, 0) or value.count > 2**53 - 1
    ):
        raise ValueError("Global count must be a nonnegative safe integer")
    if value.attribution_state == "resolved" and value.count is None:
        raise ValueError("Resolved attribution requires a global count")
    if value.attribution_state == "missing" and value.count is not None:
        raise ValueError("Missing global count must remain unknown")
    return value


def reconcile_observation(
    current: PopularityObservation | None, incoming: PopularityObservation
) -> tuple[str, PopularityObservation]:
    """Reconcile one source slot by observation time, never revision ordering.

    Import time is ingestion provenance only. Replaying the same observation
    retains its original import time. A successful newer observation can decrease.
    Persistence adapters must separately enforce atomic compare-and-replace.
    """
    validate_observation(incoming)
    if current is None:
        return "accepted", incoming
    validate_observation(current)
    if (current.provider, current.metric, current.source_entity_id) != (
        incoming.provider, incoming.metric, incoming.source_entity_id
    ):
        return "conflict", current
    if current.source_revision == incoming.source_revision:
        if (current.observed_at, current.count, current.attribution_state) == (
            incoming.observed_at, incoming.count, incoming.attribution_state
        ):
            return "idempotent", current
        return "conflict", current
    if incoming.observed_at == current.observed_at:
        return "conflict", current
    if incoming.observed_at < current.observed_at:
        return "stale", current
    return "accepted", incoming


def _validate_track(item: LocalTrackEvidence) -> None:
    if not isinstance(item, LocalTrackEvidence) or not _integer(item.track_id, 1):
        raise ValueError("Expected positive local track identity")
    if not all(_nonblank(value) for value in (
        item.mapping_revision, item.provider, item.source_entity_id
    )):
        raise ValueError("Expected a versioned provider mapping")
    for identity, evidence in (
        (item.canonical_recording_id, item.recording_evidence),
        (item.canonical_artist_id, item.artist_evidence),
    ):
        if identity is None:
            if evidence is not None:
                raise ValueError("Canonical evidence requires its identity")
        elif not _nonblank(identity) or not _nonblank(evidence):
            raise ValueError("Canonical identity requires nonblank evidence")


def _snapshot_reason(
    item: LocalTrackEvidence, snapshot: CachedPopularity | None
) -> str | None:
    if snapshot is None:
        return "missing_global_metric"
    if not isinstance(snapshot, CachedPopularity):
        raise ValueError("Expected a typed cached popularity snapshot")
    if (
        not _integer(snapshot.local_track_id, 1)
        or snapshot.local_track_id != item.track_id
        or snapshot.mapping_revision != item.mapping_revision
    ):
        return "mapping_mismatch"
    observation = validate_observation(snapshot.observation)
    if (observation.provider, observation.source_entity_id) != (
        item.provider, item.source_entity_id
    ):
        return "mapping_mismatch"
    if observation.attribution_state == "missing":
        return "missing_global_metric"
    if observation.attribution_state == "ambiguous":
        return "ambiguous_attribution"
    return None


def _evidence_order(row: tuple[LocalTrackEvidence, PopularityObservation]) -> tuple:
    item, _ = row
    # Choose an original local copy; do not manufacture canonical evidence.
    return (
        -(int(item.canonical_recording_id is not None)
          + int(item.canonical_artist_id is not None)),
        item.canonical_recording_id is None,
        item.canonical_artist_id is None,
        item.track_id,
    )


def select_local_popular_tracks(
    candidates: Iterable[LocalTrackEvidence],
    *,
    is_local_readable: Callable[[LocalTrackEvidence], bool],
    matches_filter: Callable[[LocalTrackEvidence], bool],
    read_snapshot: Callable[[LocalTrackEvidence], CachedPopularity | None],
    max_per_artist: int | None = None,
    offset: int = 0,
    limit: int = 50,
) -> PopularitySelection:
    """Filter admitted local tracks, deduplicate, rank, cap, then paginate.

    Neither callback failures nor invalid normalized values become fake zeroes.
    Denied rows never reach validation, filters, cache reads or diagnostics.
    The returned total is after the artist cap and before pagination.
    """
    if not _integer(offset, 0) or not _integer(limit, 1):
        raise ValueError("Offset must be nonnegative and limit positive integers")
    if max_per_artist is not None and not _integer(max_per_artist, 1):
        raise ValueError("Artist cap must be a positive integer")

    diagnostics = []
    provider_groups = defaultdict(list)
    for item in candidates:
        if not is_local_readable(item):
            continue
        _validate_track(item)
        if not matches_filter(item):
            continue
        snapshot = read_snapshot(item)
        reason = _snapshot_reason(item, snapshot)
        if reason is not None:
            diagnostics.append((item.track_id, reason))
            continue
        provider_groups[(item.provider, item.source_entity_id)].append(
            (item, snapshot.observation)
        )

    recordings = defaultdict(list)
    for provider_identity, rows in provider_groups.items():
        recording_ids = {
            item.canonical_recording_id for item, _ in rows
            if item.canonical_recording_id is not None
        }
        artist_ids = {
            item.canonical_artist_id for item, _ in rows
            if item.canonical_artist_id is not None
        }
        if len(recording_ids) > 1 or len(artist_ids) > 1:
            diagnostics.extend((item.track_id, "ambiguous_attribution") for item, _ in rows)
            continue
        # Provider identity bridges partial canonical coverage. All copies join
        # the same canonical group without rewriting any original candidate.
        identity = (
            ("canonical", next(iter(recording_ids)))
            if recording_ids else ("provider", *provider_identity)
        )
        recordings[identity].extend(rows)

    ranked = []
    for identity, rows in recordings.items():
        if max_per_artist is not None:
            with_artist = [row for row in rows if row[0].canonical_artist_id is not None]
            if not with_artist:
                diagnostics.extend((item.track_id, "missing_canonical_artist") for item, _ in rows)
                continue
            rows = with_artist
        item, observation = min(rows, key=_evidence_order)
        ranked.append((item, observation, identity))
    ranked.sort(key=lambda row: (-row[1].count, row[2], row[0].track_id))

    selected = []
    artist_counts = defaultdict(int)
    for item, _, _ in ranked:
        if max_per_artist is not None:
            if artist_counts[item.canonical_artist_id] >= max_per_artist:
                continue
            artist_counts[item.canonical_artist_id] += 1
        selected.append(item)
    return PopularitySelection(
        tracks=tuple(selected[offset:offset + limit]),
        total=len(selected),
        diagnostics=tuple(sorted(diagnostics)),
    )
