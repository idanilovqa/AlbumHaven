"""Deterministic operation counters for backend bounded-interaction contracts.

Tests wrap real collaborators (connections, pools, builders, filesystem and
media seams) so the work an interaction performs is counted, not assumed.
Production code carries no counters.
"""

from __future__ import annotations

import contextlib
import functools
import json
import os
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, fields
from pathlib import Path

REGISTRY_PATH = Path(__file__).resolve().parents[1] / "ci" / "bounded-interactions.json"
EVIDENCE_ENV = "BOUNDED_INTERACTION_EVIDENCE"


@dataclass
class OperationCounts:
    sql_statements: int = 0
    returned_rows: int = 0
    affected_rows: int = 0
    pool_leases: int = 0
    pool_lease_ms: float = 0.0
    leases_held_across_io: int = 0
    builder_calls: int = 0
    candidate_rows: int = 0
    membership_rows: int = 0
    filesystem_enumerations: int = 0
    stat_calls: int = 0
    open_calls: int = 0
    media_parses: int = 0
    queue_claims: int = 0
    generation_changes: int = 0
    invalidations: int = 0
    replay_passes: int = 0
    serialized_rows: int = 0
    serialized_bytes: int = 0
    unrelated_reads: int = 0
    unrelated_writes: int = 0

    def count(self, field_name: str, amount: int | float = 1) -> None:
        if field_name not in _FIELD_NAMES:
            raise AttributeError(f"unknown operation counter {field_name}")
        setattr(self, field_name, getattr(self, field_name) + amount)

    def serialize(self, payload: object, *, rows: int) -> bytes:
        """Counts the serialized response a route would send."""
        body = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
        self.serialized_rows += rows
        self.serialized_bytes += len(body)
        return body


_FIELD_NAMES = frozenset(field.name for field in fields(OperationCounts))


def _statement(query, params) -> tuple:
    # Some drivers reject an explicit None parameter set.
    return (query,) if params is None else (query, params)


class CountingCursor:
    def __init__(self, cursor, counts: OperationCounts):
        self._cursor = cursor
        self._counts = counts

    def execute(self, query, params=None, *args, **kwargs):
        self._counts.sql_statements += 1
        result = self._cursor.execute(*_statement(query, params), *args, **kwargs)
        self._count_affected()
        return self if result is self._cursor or result is None else result

    def executemany(self, query, params_seq, *args, **kwargs):
        params_seq = list(params_seq)
        self._counts.sql_statements += len(params_seq)
        result = self._cursor.executemany(query, params_seq, *args, **kwargs)
        self._count_affected()
        return result

    def _count_affected(self) -> None:
        rowcount = getattr(self._cursor, "rowcount", -1)
        if getattr(self._cursor, "description", None) is None and isinstance(rowcount, int) and rowcount > 0:
            self._counts.affected_rows += rowcount

    def fetchone(self):
        row = self._cursor.fetchone()
        if row is not None:
            self._counts.returned_rows += 1
        return row

    def fetchmany(self, *args, **kwargs):
        rows = self._cursor.fetchmany(*args, **kwargs)
        self._counts.returned_rows += len(rows)
        return rows

    def fetchall(self):
        rows = self._cursor.fetchall()
        self._counts.returned_rows += len(rows)
        return rows

    def __iter__(self):
        for row in self._cursor:
            self._counts.returned_rows += 1
            yield row

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        close = getattr(self._cursor, "__exit__", None)
        return close(*exc) if close else None

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class CountingConnection:
    """Delegates to a real connection while counting statements and rows."""

    def __init__(self, connection, counts: OperationCounts):
        self._connection = connection
        self._counts = counts

    def cursor(self, *args, **kwargs):
        return CountingCursor(self._connection.cursor(*args, **kwargs), self._counts)

    def execute(self, query, params=None, *args, **kwargs):
        self._counts.sql_statements += 1
        cursor = self._connection.execute(*_statement(query, params), *args, **kwargs)
        counted = CountingCursor(cursor, self._counts)
        counted._count_affected()
        return counted

    def __enter__(self):
        self._connection.__enter__()
        return self

    def __exit__(self, *exc):
        return self._connection.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self._connection, name)


class LeaseTracker:
    """Counts pool leases and any lease still held when blocking I/O starts."""

    def __init__(self, counts: OperationCounts, clock: Callable[[], float]):
        self._counts = counts
        self._clock = clock
        self._open: list[float] = []

    @contextlib.contextmanager
    def lease(self):
        self._counts.pool_leases += 1
        started = self._clock()
        self._open.append(started)
        try:
            yield
        finally:
            self._open.remove(started)
            self._counts.pool_lease_ms += (self._clock() - started) * 1000

    def blocking_io(self) -> None:
        """Call from a media, provider, or filesystem seam."""
        self._counts.leases_held_across_io += len(self._open)


def _check_budgets(interaction_id: str, label: str, size: int, counts: OperationCounts, budgets: Mapping[str, float]) -> list[str]:
    violations = []
    values = asdict(counts)
    for metric, budget in budgets.items():
        if metric not in values:
            violations.append(f"{interaction_id}: unknown budget metric {metric}")
        elif values[metric] > budget:
            violations.append(f"{interaction_id}: {metric}={values[metric]} at cardinality {size} ({label}) exceeds budget {budget}")
    return violations


@functools.cache
def _checked_in_entries() -> dict[str, Mapping[str, object]]:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {entry["id"]: entry for entry in registry["interactions"]}


def _registry_mismatches(
    interaction_id: str,
    actual: Mapping[str, object],
    registry: Mapping[str, object] | None,
) -> list[str]:
    """A contract is measured under a registered interaction id and must measure
    exactly the cardinalities, budgets, and growth the registry declares for it.
    An unknown id is an error: a contract never proves an entry it does not name."""
    if registry is None:
        entry = _checked_in_entries().get(interaction_id)
    else:
        entry = next((item for item in registry["interactions"] if item["id"] == interaction_id), None)
    if entry is None:
        return [f"{interaction_id}: measured id is not a registered interaction"]
    cardinalities = entry.get("cardinalities") or {}
    declared_growth = entry.get("growth")
    expected = {
        "small": cardinalities.get("small"),
        "large": cardinalities.get("production"),
        "budgets": entry.get("budgets"),
        "growth": None if declared_growth is None else (declared_growth.get("metric"), declared_growth.get("largeMinusSmallMax")),
    }
    return [
        f"{interaction_id}: {key} {actual[key]!r} differs from the registry's {expected[key]!r}"
        for key in expected
        if actual[key] != expected[key]
    ]


def measure_scale_pair(
    *,
    interaction_id: str,
    small: int,
    large: int,
    run: Callable[[int], OperationCounts],
    budgets: Mapping[str, float],
    growth: tuple[str, float] | None = None,
    registry: Mapping[str, object] | None = None,
) -> tuple[OperationCounts, OperationCounts]:
    """Runs one interaction at two cardinalities; enforces budgets and growth."""
    if not (0 < small < large):
        raise ValueError(f"{interaction_id}: scale pair needs 0 < small < large")
    actual = {"small": small, "large": large, "budgets": dict(budgets), "growth": None if growth is None else tuple(growth)}
    mismatches = _registry_mismatches(interaction_id, actual, registry)
    if mismatches:
        raise AssertionError("\n".join(mismatches))
    small_counts = run(small)
    large_counts = run(large)
    violations = [
        *_check_budgets(interaction_id, "small", small, small_counts, budgets),
        *_check_budgets(interaction_id, "large", large, large_counts, budgets),
    ]
    if growth is not None:
        metric, allowed = growth
        delta = getattr(large_counts, metric) - getattr(small_counts, metric)
        if delta > allowed:
            violations.append(
                f"{interaction_id}: {metric} grew from {getattr(small_counts, metric)} at {small} "
                f"to {getattr(large_counts, metric)} at {large}; allowed growth {allowed}"
            )
    if violations:
        raise AssertionError("\n".join(violations))
    if registry is None:
        _record_measured_id(interaction_id)
    return small_counts, large_counts


def _record_measured_id(interaction_id: str) -> None:
    """Under the gate runner, records which test measured which id so the runner
    can prove each contract entry's own test measured it."""
    evidence = os.environ.get(EVIDENCE_ENV)
    if not evidence:
        return
    # "tests/py/test_x.py::test_name[param] (call)" -> "test_name"
    current = os.environ.get("PYTEST_CURRENT_TEST", "")
    test = current.rsplit(" ", 1)[0].split("::")[-1].split("[", 1)[0] or None
    with open(evidence, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"id": interaction_id, "test": test}) + "\n")


def assert_plateau(samples: Iterable[float], *, warmup_samples: int = 0, max_increase_after_warmup: float = 0, label: str = "retained resources") -> float:
    """Repeated stable cycles must stop producing work after warm-up."""
    values = list(samples)
    if len(values) <= warmup_samples + 1:
        raise ValueError(f"{label}: plateau needs more samples than the {warmup_samples}-sample warm-up")
    settled = values[warmup_samples:]
    increase = max(settled) - settled[0]
    if increase > max_increase_after_warmup:
        raise AssertionError(f"{label}: retained growth of {increase} after warm-up (samples {settled}); allowed {max_increase_after_warmup}")
    return increase


def explain_actual_rows(connection, query: str, params=None, *, relations: Iterable[str] | None = None) -> int:
    """Sums actual rows produced by plan nodes, optionally for named relations.

    Pass only connections from the isolated-database fixtures: EXPLAIN ANALYZE
    executes the query.
    """
    wanted = set(relations or ())
    with connection.cursor() as cursor:
        cursor.execute(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {query}", params)
        document = cursor.fetchone()[0]
    plan = (json.loads(document) if isinstance(document, str) else document)[0]["Plan"]

    def visit(node: Mapping[str, object]) -> int:
        own = 0
        if not wanted or node.get("Relation Name") in wanted:
            own = int(node.get("Actual Rows", 0)) * int(node.get("Actual Loops", 1))
        return own + sum(visit(child) for child in node.get("Plans", ()))

    return visit(plan)
