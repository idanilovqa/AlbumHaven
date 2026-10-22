"""Pure display rows for one normalized, source-owned Foobar observation.

The caller owns authorization, count provenance, UTC normalization and event
membership. Display anchors are not measured-listen timestamps. This module
does not read, persist, parse dates, merge sources or assign playback access.
"""

from __future__ import annotations

from dataclasses import dataclass


_VERSION = "foobar_history_projection_v1"
_MIN_KEY = -(2**63)
_MAX_KEY = 2**63 - 1
_MAX_EVENTS = 10000
_ROW_KINDS = (
    "first_boundary", "dated_event", "unknown_dates_bucket", "grouped_aggregate",
)


class HistoryProjectionError(ValueError):
    """A malformed projection input, without exposing source values."""

    code = "invalid_history_projection_input"

    def __init__(self):
        super().__init__("Invalid Foobar history projection input.")


@dataclass(frozen=True, slots=True)
class NormalizedBoundary:
    label: str
    order_key: int | None
    precision: str


@dataclass(frozen=True, slots=True)
class NormalizedEvent:
    event_ref: str
    at: NormalizedBoundary


@dataclass(frozen=True, slots=True)
class HistoryInput:
    observation_ref: str
    revision: str
    track_ref: str
    source_kind: str
    total: int
    first: NormalizedBoundary | None
    last: NormalizedBoundary | None
    events: tuple[NormalizedEvent, ...]
    coverage: str
    first_relation: str


@dataclass(frozen=True, slots=True)
class HistoryDisplayRow:
    row_key: tuple[str, str, str, str, str, str]
    kind: str
    weight: int
    anchor: NormalizedBoundary | None
    show_count: bool
    unknown_dates: bool
    interval_start: NormalizedBoundary | None
    interval_end: NormalizedBoundary | None


@dataclass(frozen=True, slots=True)
class HistoryProjection:
    version: str
    status: str
    reason: str | None
    mode: str
    observation_ref: str
    revision: str
    track_ref: str
    total: int
    rows: tuple[HistoryDisplayRow, ...]


def _valid_text(value: object) -> bool:
    # Bound encoding work before checking the stricter byte-size limit.
    if type(value) is not str or not 0 < len(value) <= 128:
        return False
    try:
        return len(value.encode("utf-8", errors="strict")) <= 128
    except UnicodeEncodeError:
        return False


def _valid_boundary(value: object) -> bool:
    if type(value) is not NormalizedBoundary or not _valid_text(value.label):
        return False
    if type(value.precision) is not str or value.precision not in (
        "millisecond", "second", "day", "unknown",
    ):
        return False
    key = value.order_key
    if key is None:
        return True
    return (
        type(key) is int and _MIN_KEY <= key <= _MAX_KEY
        and (value.precision != "second" or key % 1000 == 0)
    )


def _valid_history(history: object) -> bool:
    if type(history) is not HistoryInput:
        return False
    if not all(_valid_text(value) for value in (
        history.observation_ref, history.revision, history.track_ref,
    )):
        return False
    if type(history.source_kind) is not str or history.source_kind != "foobar_local":
        return False
    if type(history.total) is not int or not 0 <= history.total <= _MAX_KEY:
        return False
    if any(value is not None and not _valid_boundary(value)
           for value in (history.first, history.last)):
        return False
    if type(history.events) is not tuple or len(history.events) > _MAX_EVENTS:
        return False
    if type(history.coverage) is not str or history.coverage not in (
        "none", "within_total", "unreconciled",
    ):
        return False
    if type(history.first_relation) is not str or history.first_relation not in (
        "not_applicable", "included", "additional", "unknown",
    ):
        return False
    if ((history.events and history.coverage == "none")
            or (not history.events and history.coverage != "none")):
        return False
    if history.first is None:
        if history.first_relation != "not_applicable":
            return False
    elif not history.events:
        if history.first_relation != "additional":
            return False
    elif history.first_relation == "not_applicable":
        return False

    event_refs = set()
    for event in history.events:
        if type(event) is not NormalizedEvent or not _valid_text(event.event_ref):
            return False
        if not _valid_boundary(event.at):
            return False
        if event.at.order_key is None or event.at.precision not in ("millisecond", "second"):
            return False
        if event.event_ref in event_refs:
            return False
        event_refs.add(event.event_ref)
    return True


def _occurrence_interval(boundary: NormalizedBoundary | None) -> tuple[int, int] | None:
    """Only fine, nonnull UTC anchors carry an occurrence-time interval."""
    if boundary is None or boundary.order_key is None:
        return None
    key = boundary.order_key
    if boundary.precision == "millisecond":
        return key, key
    if boundary.precision == "second":
        # Mathematical integers: do not wrap or clip an endpoint above MAX_KEY.
        return key, key + 999
    return None


def _reconciliation_reason(history: HistoryInput) -> str | None:
    """Shared contradictions take precedence over either presentation mode."""
    event_count = len(history.events)
    if event_count > history.total:
        return "events_exceed_total"
    if event_count and history.coverage == "unreconciled":
        return "event_coverage_unknown"
    if event_count and history.first_relation == "additional" and event_count == history.total:
        return "first_boundary_exceeds_total"

    first = _occurrence_interval(history.first)
    last = _occurrence_interval(history.last)
    if first is not None and last is not None and first[0] > last[1]:
        return "boundary_order_conflict"
    if history.total == 0 and (history.first is not None or history.last is not None):
        return "zero_count_with_boundaries"
    if (history.total == 1 and first is not None and last is not None
            and (first[1] < last[0] or last[1] < first[0])):
        return "single_count_boundary_conflict"
    return None


def _row(
    history: HistoryInput, mode: str, kind: str, weight: int,
    anchor: NormalizedBoundary | None, discriminator: str = "",
) -> HistoryDisplayRow:
    dated_event = kind == "dated_event"
    return HistoryDisplayRow(
        row_key=(history.observation_ref, history.revision, history.track_ref,
                 mode, kind, discriminator),
        kind=kind,
        weight=weight,
        anchor=anchor,
        show_count=weight > 1,
        unknown_dates=not dated_event,
        interval_start=None if dated_event else history.first,
        interval_end=None if dated_event else history.last,
    )


def _display_order(row: HistoryDisplayRow) -> tuple:
    key = row.anchor.order_key if row.anchor is not None else None
    # A separate unknown flag keeps every known key before unknown anchors,
    # including MIN_KEY. Negation is exact Python integer arithmetic.
    return (key is None, -key if key is not None else 0,
            _ROW_KINDS.index(row.kind), row.row_key)


def _result(
    history: HistoryInput, mode: str, rows: tuple[HistoryDisplayRow, ...] = (),
    *, reason: str | None = None,
) -> HistoryProjection:
    return HistoryProjection(
        version=_VERSION,
        status="ready" if reason is None else "needs_reconciliation",
        reason=reason,
        mode=mode,
        observation_ref=history.observation_ref,
        revision=history.revision,
        track_ref=history.track_ref,
        total=history.total,
        rows=rows,
    )


def project_foobar_history(history: HistoryInput, *, mode: str) -> HistoryProjection:
    """Project immutable rows without manufacturing dates or changing counts.

    A reconciliation result retains the supplied total but has no display rows;
    it does not assert zero listens or a union of conflicting evidence.
    """
    if type(mode) is not str or mode not in ("grouped", "individual"):
        raise HistoryProjectionError()
    try:
        valid = _valid_history(history)
    except AttributeError:
        # An exact dataclass allocated without its initializer is malformed too.
        valid = False
    if not valid:
        raise HistoryProjectionError()

    reason = _reconciliation_reason(history)
    if reason is not None:
        return _result(history, mode, reason=reason)
    if history.total == 0:
        return _result(history, mode)
    if mode == "grouped":
        return _result(history, mode, (
            _row(history, mode, "grouped_aggregate", history.total, history.last),
        ))

    remaining = history.total - len(history.events)
    if history.first_relation == "unknown" and remaining > 0:
        return _result(history, mode, reason="first_boundary_overlap_unknown")
    if not history.events and history.total == 1:
        anchor = history.first if history.first is not None else history.last
        kind = "first_boundary" if anchor is not None else "unknown_dates_bucket"
        return _result(history, mode, (_row(history, mode, kind, 1, anchor),))

    rows = [_row(history, mode, "dated_event", 1, event.at, event.event_ref)
            for event in history.events]
    if history.first_relation == "additional":
        # Structural checks require first; shared reconciliation reserves a member.
        rows.append(_row(history, mode, "first_boundary", 1, history.first))
        remaining -= 1
    if remaining > 0:
        rows.append(_row(history, mode, "unknown_dates_bucket", remaining, history.last))
    return _result(history, mode, tuple(sorted(rows, key=_display_order)))
