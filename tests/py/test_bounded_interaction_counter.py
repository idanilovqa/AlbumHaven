from __future__ import annotations

import itertools
import json
import sqlite3
from pathlib import Path

import pytest

from tests.py.bounded_interactions import (
    CountingConnection,
    LeaseTracker,
    OperationCounts,
    assert_plateau,
    explain_actual_rows,
    measure_scale_pair,
)


def _self_registered_pair(*, interaction_id, small, large, budgets, growth=None, **rest):
    """Measures a self-test contract against a registry that declares exactly it."""
    entry = {
        "id": interaction_id,
        "cardinalities": {"small": small, "production": large},
        "budgets": budgets,
        "growth": None if growth is None else {"metric": growth[0], "largeMinusSmallMax": growth[1]},
    }
    return measure_scale_pair(
        interaction_id=interaction_id, small=small, large=large, budgets=budgets, growth=growth,
        registry={"interactions": [entry]}, **rest,
    )


def test_scale_pair_rejects_linear_query_growth():
    with pytest.raises(AssertionError, match=r"sql_statements=1001.*budget 2"):
        _self_registered_pair(
            interaction_id="example",
            small=20,
            large=1_000,
            run=lambda size: OperationCounts(sql_statements=size + 1),
            budgets={"sql_statements": 2},
            growth=("sql_statements", 0),
        )


def test_unknown_metrics_fail_closed():
    with pytest.raises(AttributeError, match="unknown operation counter"):
        OperationCounts().count("queries")
    with pytest.raises(AssertionError, match="unknown budget metric queries"):
        _self_registered_pair(interaction_id="x", small=1, large=2, run=lambda _: OperationCounts(), budgets={"queries": 1})


def test_plateau_rejects_generation_growth_after_warmup():
    with pytest.raises(AssertionError, match="retained growth of 3"):
        assert_plateau([1, 2, 3, 4, 5], warmup_samples=1)
    assert assert_plateau([1, 2, 2, 2], warmup_samples=1) == 0


def _album_db(size: int) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("create table tracks (album_id integer, title text)")
    connection.executemany("insert into tracks values (?, ?)", ((index % 13, f"t{index}") for index in range(size)))
    return connection


# BI-H05/H08 shape: a selected-album lookup that reads every track row, or one
# query per album, versus one selected-set batch predicate.
def _duplicate_lookup(size: int, *, strategy: str) -> OperationCounts:
    counts = OperationCounts()
    connection = CountingConnection(_album_db(size), counts)
    selected = list(range(13))
    if strategy == "global-scan":
        rows = connection.execute("select album_id, title from tracks").fetchall()
        [row for row in rows if row[0] in selected]
    elif strategy == "per-album":
        for album_id in range(size // 13):
            connection.execute("select title from tracks where album_id = ? limit 1", (album_id % 13,)).fetchall()
    else:
        placeholders = ",".join("?" * len(selected))
        connection.execute(f"select album_id, count(*) from tracks where album_id in ({placeholders}) group by album_id", selected).fetchall()
    return counts


@pytest.mark.parametrize(
    ("strategy", "message"),
    [
        ("global-scan", r"returned_rows=1600 at cardinality 1600"),
        ("per-album", r"sql_statements=123 at cardinality 1600"),
    ],
)
def test_selected_album_lookup_rejects_global_and_n_plus_one_reads(strategy, message):
    with pytest.raises(AssertionError, match=message):
        _self_registered_pair(
            interaction_id="BI-H08-selected-album-duplicates",
            small=26,
            large=1_600,
            run=lambda size: _duplicate_lookup(size, strategy=strategy),
            budgets={"sql_statements": 1, "returned_rows": 13},
            growth=("returned_rows", 0),
        )


def test_selected_album_lookup_accepts_one_batched_selected_set_query():
    _, large = _self_registered_pair(
        interaction_id="BI-H08-selected-album-duplicates",
        small=26,
        large=1_600,
        run=lambda size: _duplicate_lookup(size, strategy="batched"),
        budgets={"sql_statements": 1, "returned_rows": 13},
        growth=("returned_rows", 0),
    )
    assert (large.sql_statements, large.returned_rows) == (1, 13)


def test_counting_connection_counts_affected_rows():
    counts = OperationCounts()
    connection = CountingConnection(_album_db(10), counts)
    connection.execute("update tracks set title = 'x' where album_id = 1")
    assert (counts.sql_statements, counts.affected_rows) == (1, 1)


# BI-H05/H14 shape: a cache miss that synchronously rebuilds a global builder.
def _search_cache_miss(artists: int, *, rebuild: bool) -> OperationCounts:
    counts = OperationCounts()

    def build_relation_views(source_rows):
        counts.count("builder_calls")
        counts.count("candidate_rows", len(source_rows))
        return {}

    if rebuild:
        build_relation_views(range(artists * 19))
    else:
        counts.count("candidate_rows", 1)
    counts.serialize({"artists": ["A"]}, rows=1)
    return counts


def test_cache_miss_rejects_synchronous_global_rebuild():
    contract = dict(
        interaction_id="BI-H05-interactive-search-projection",
        small=20,
        large=14_000,
        budgets={"builder_calls": 0, "candidate_rows": 1, "serialized_rows": 1},
        growth=("candidate_rows", 0),
    )
    with pytest.raises(AssertionError, match=r"builder_calls=1 at cardinality 20"):
        _self_registered_pair(run=lambda size: _search_cache_miss(size, rebuild=True), **contract)
    _self_registered_pair(run=lambda size: _search_cache_miss(size, rebuild=False), **contract)


# BI-H16 shape: save finalization that keeps its database lease during media I/O.
def _finalize_save(*, release_before_media: bool) -> OperationCounts:
    counts = OperationCounts()
    ticks = itertools.count()
    tracker = LeaseTracker(counts, clock=lambda: next(ticks) / 1000)
    if release_before_media:
        with tracker.lease():
            counts.count("affected_rows")
        tracker.blocking_io()
        with tracker.lease():
            counts.count("affected_rows")
    else:
        with tracker.lease():
            counts.count("affected_rows")
            tracker.blocking_io()
            counts.count("affected_rows")
    return counts


def test_lease_tracker_rejects_leases_held_across_media_io():
    assert _finalize_save(release_before_media=False).leases_held_across_io == 1
    repaired = _finalize_save(release_before_media=True)
    assert (repaired.leases_held_across_io, repaired.pool_leases) == (0, 2)


# BI-H10 shape: relocation and backfill that restart each other forever.
def _preview_cycles(cycles: int, *, recorded_matches_written: bool) -> list[int]:
    counts = OperationCounts()
    samples = []
    for _ in range(cycles):
        if not recorded_matches_written:
            counts.count("queue_claims")
            counts.count("generation_changes")
        samples.append(counts.generation_changes)
    return samples


def test_preview_relocation_must_converge():
    with pytest.raises(AssertionError, match="retained growth of 99"):
        assert_plateau(_preview_cycles(101, recorded_matches_written=False), warmup_samples=1, label="BI-H10 previews")
    assert_plateau(_preview_cycles(101, recorded_matches_written=True), warmup_samples=1, label="BI-H10 previews")


class _ExplainCursor:
    def __init__(self, plan):
        self._plan = plan
        self.query = ""

    def execute(self, query, params=None):
        self.query = query

    def fetchone(self):
        return (json.dumps([{"Plan": self._plan}]),)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None


class _ExplainConnection:
    def __init__(self, plan):
        self.cursor_instance = _ExplainCursor(plan)

    def cursor(self):
        return self.cursor_instance


def test_explain_actual_rows_sums_rows_times_loops_for_named_relations():
    plan = {
        "Node Type": "Limit", "Actual Rows": 50, "Actual Loops": 1,
        "Plans": [
            {"Node Type": "Seq Scan", "Relation Name": "track_files", "Actual Rows": 1_000, "Actual Loops": 3},
            {"Node Type": "Index Scan", "Relation Name": "albums", "Actual Rows": 1, "Actual Loops": 50},
        ],
    }
    connection = _ExplainConnection(plan)
    assert explain_actual_rows(connection, "select 1", relations=["track_files"]) == 3_000
    assert explain_actual_rows(connection, "select 1") == 50 + 3_000 + 50
    assert connection.cursor_instance.query.startswith("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1")


# BI-H09 shape: targeted reconciliation that absorbs unrelated dirty backlog.
def _reconcile_one_track(unrelated_dirty: int, *, absorb_backlog: bool) -> OperationCounts:
    counts = OperationCounts()
    dirty = {"changed-track", *(f"unrelated-{index}" for index in range(unrelated_dirty))}
    targets = dirty if absorb_backlog else {"changed-track"}
    for identity in sorted(targets):
        counts.count("affected_rows")
        if identity != "changed-track":
            counts.count("unrelated_writes")
    return counts


def test_targeted_reconciliation_rejects_unrelated_backlog_absorption():
    contract = dict(
        interaction_id="BI-H09-targeted-reconciliation",
        small=1,
        large=1_000,
        budgets={"unrelated_writes": 0, "affected_rows": 12},
        growth=("affected_rows", 0),
    )
    with pytest.raises(AssertionError, match=r"unrelated_writes=1000 at cardinality 1000"):
        _self_registered_pair(run=lambda size: _reconcile_one_track(size, absorb_backlog=True), **contract)
    _self_registered_pair(run=lambda size: _reconcile_one_track(size, absorb_backlog=False), **contract)


_REGISTERED = {
    "interactions": [{
        "id": "py:routes/example.py#items",
        "proof": "contract",
        "cardinalities": {"small": 20, "production": 1000},
        "budgets": {"sql_statements": 2},
        "growth": {"metric": "sql_statements", "largeMinusSmallMax": 0},
    }],
}


def _registered_pair(**overrides):
    arguments = {
        "interaction_id": "py:routes/example.py#items",
        "small": 20,
        "large": 1_000,
        "run": lambda size: OperationCounts(sql_statements=1),
        "budgets": {"sql_statements": 2},
        "growth": ("sql_statements", 0),
        "registry": _REGISTERED,
        **overrides,
    }
    return measure_scale_pair(**arguments)


def test_scale_pair_under_registry_id_matches_the_registered_contract():
    _registered_pair()


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"large": 500}, r"large 500 differs from the registry's 1000"),
        ({"small": 10}, r"small 10 differs from the registry's 20"),
        ({"budgets": {"sql_statements": 20}}, r"budgets .* differs from the registry's"),
        ({"growth": ("sql_statements", 5)}, r"growth \('sql_statements', 5\) differs"),
        ({"growth": None}, r"growth None differs"),
    ],
)
def test_scale_pair_under_registry_id_rejects_drift_from_the_registry(overrides, message):
    with pytest.raises(AssertionError, match=message):
        _registered_pair(**overrides)


def test_scale_pair_under_unregistered_id_is_rejected():
    with pytest.raises(AssertionError, match=r"example: measured id is not a registered interaction"):
        _registered_pair(interaction_id="example", large=500, budgets={"sql_statements": 20})
    with pytest.raises(AssertionError, match=r"py:services/helper\.py#helper: measured id is not a registered interaction"):
        measure_scale_pair(
            interaction_id="py:services/helper.py#helper", small=1, large=2,
            run=lambda size: OperationCounts(), budgets={"sql_statements": 1},
        )


def test_checked_in_measurement_records_the_measuring_test_under_the_gate(tmp_path, monkeypatch):
    from tests.py import bounded_interactions

    evidence = tmp_path / "evidence.jsonl"
    monkeypatch.setenv(bounded_interactions.EVIDENCE_ENV, str(evidence))
    registry = json.loads(bounded_interactions.REGISTRY_PATH.read_text(encoding="utf-8"))
    contract = next(entry for entry in registry["interactions"] if entry["proof"] == "contract" and entry["id"].startswith("py:"))
    growth = contract["growth"]
    measure_scale_pair(
        interaction_id=contract["id"],
        small=contract["cardinalities"]["small"],
        large=contract["cardinalities"]["production"],
        run=lambda size: OperationCounts(),
        budgets=contract["budgets"],
        growth=(growth["metric"], growth["largeMinusSmallMax"]),
    )
    # A measurement against an explicit registry is never evidence.
    _registered_pair()
    assert [json.loads(line) for line in evidence.read_text(encoding="utf-8").splitlines()] == [
        {"id": contract["id"], "test": "test_checked_in_measurement_records_the_measuring_test_under_the_gate"},
    ]


def test_scale_pair_uses_the_checked_in_registry_by_default():
    registry = json.loads((Path(__file__).resolve().parents[1] / "ci" / "bounded-interactions.json").read_text(encoding="utf-8"))
    contract = next(entry for entry in registry["interactions"] if entry["proof"] == "contract")
    with pytest.raises(AssertionError, match=r"large \d+ differs from the registry's \d+"):
        measure_scale_pair(
            interaction_id=contract["id"],
            small=contract["cardinalities"]["small"],
            large=contract["cardinalities"]["production"] + 1,
            run=lambda size: OperationCounts(),
            budgets=contract["budgets"],
            growth=(contract["growth"]["metric"], contract["growth"]["largeMinusSmallMax"]),
        )


def test_a_budget_failure_names_the_threads_that_did_the_counted_work(tmp_path, monkeypatch):
    import threading

    from tests.py.filesystem_operation_counting import count_filesystem_and_media

    target = tmp_path / "file.txt"
    target.write_text("x")

    def run(size: int) -> OperationCounts:
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts):
            target.stat()
            if size > 1:
                worker = threading.Thread(target=target.stat, name="leftover-render")
                worker.start()
                worker.join()
        return counts

    with pytest.raises(AssertionError, match=r"stat_calls=2 at cardinality 2 \(large\) exceeds budget 1 \(by thread: MainThread=1, leftover-render=1\)"):
        _self_registered_pair(interaction_id="py:routes/example.py#thread_breakdown", small=1, large=2, run=run, budgets={"stat_calls": 1})


def test_counting_drains_work_left_on_the_cover_render_executors_first(tmp_path, monkeypatch):
    """Work an earlier request queued on the cover preview executors finishes
    before the window opens, so it is never counted against the next interaction."""
    import threading

    from music_app.services import covers
    from tests.py.filesystem_operation_counting import count_filesystem_and_media

    target = tmp_path / "cover.jpg"
    target.write_bytes(b"x")
    release = threading.Event()
    started = threading.Event()

    def leftover_render():
        started.set()
        release.wait(5)
        target.stat()

    covers._COVER_VARIANT_PREWARM_EXECUTOR.submit(leftover_render)
    assert started.wait(5)
    threading.Timer(0.2, release.set).start()
    counts = OperationCounts()
    with count_filesystem_and_media(monkeypatch, counts):
        # Long enough for the leftover render to land here, were it not drained.
        release.wait(5)
        threading.Event().wait(0.3)
    assert counts.stat_calls == 0
