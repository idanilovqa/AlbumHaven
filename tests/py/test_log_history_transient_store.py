"""History service boundary regressions after retirement of the transient store.

Durable ordering, revisions, concurrent append and retention are exercised against
Postgres in test_log_history_postgres.py and test_log_history_read_consistency.py.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import log_history


@pytest.fixture
def adapter(monkeypatch):
    calls = []
    result = {"items": [{"id": "saved-entry"}], "revision": "9:42"}

    class Adapter:
        def __init__(self, config):
            calls.append(("config", config))

        def append(self, entry, *, scope):
            calls.append(("append", entry, scope))
            return entry

        def page(self, **kwargs):
            calls.append(("page", kwargs))
            return result

        def revision(self, *, scope):
            calls.append(("revision", scope))
            return result["revision"]

        def export(self, **kwargs):
            calls.append(("export", kwargs))
            return result

    monkeypatch.setattr(log_history, "LogHistoryPostgresAdapter", Adapter)
    return SimpleNamespace(calls=calls, result=result)


def test_scoped_append_normalizes_without_mutating_caller(adapter):
    scope = log_history.HistoryScope(library_id=9)
    timestamp = datetime(2026, 7, 24, 12, 30, tzinfo=timezone.utc)
    entry = {"id": "stable-entry", "timestamp": timestamp, "action": "Refresh completed"}
    saved = log_history.append_log_history({}, entry, scope=scope)
    assert entry["timestamp"] is timestamp
    assert saved["id"] == "stable-entry"
    assert saved["timestamp"] == timestamp.isoformat()
    assert adapter.calls[-1] == ("append", saved, scope)


def test_scoped_append_generates_identity_and_aware_domain_time(adapter):
    saved = log_history.append_log_history({}, {"action": "Refresh started"},
                                            scope=log_history.HistoryScope(library_id=9))
    assert saved["id"]
    assert datetime.fromisoformat(saved["timestamp"]).tzinfo is not None
    assert len([call for call in adapter.calls if call[0] == "append"]) == 1


def test_unscoped_writer_does_not_create_an_operational_fallback(adapter):
    assert log_history.append_log_history({"library_id": 9}, {"action": "Unattributed"}) == []
    assert adapter.calls == []


@pytest.mark.parametrize("reader", [log_history.load_log_history,
                                    log_history.load_log_history_snapshot,
                                    log_history.load_log_history_revision])
def test_readers_require_explicit_scope_before_adapter_access(adapter, reader):
    with pytest.raises(TypeError, match="scope"):
        reader({"library_id": 9})
    assert adapter.calls == []


def test_page_and_export_forward_the_same_normalized_query_and_capture(adapter):
    scope = log_history.HistoryScope(library_id=9)
    query = {"sources": [" scan ", "scan"], "text": "  Album "}
    page = log_history.load_log_history_snapshot({}, scope=scope, query=query,
             snapshot="capture", cursor="next", page_size=12)
    exported = log_history.export_log_history({}, scope=scope, query=query, snapshot="capture")
    page_args = next(call[1] for call in adapter.calls if call[0] == "page")
    export_args = next(call[1] for call in adapter.calls if call[0] == "export")
    assert page is exported is adapter.result
    assert page_args["scope"] is export_args["scope"] is scope
    assert page_args["query"] == export_args["query"] == log_history.normalize_log_history_query(query)
    assert page_args["snapshot"] == export_args["snapshot"] == "capture"
    assert page_args["cursor"] == "next" and page_args["page_size"] == 12


def test_load_and_revision_use_authoritative_adapter_result(adapter):
    scope = log_history.HistoryScope(library_id=9)
    assert log_history.load_log_history({}, scope=scope) is adapter.result["items"]
    assert log_history.load_log_history_revision({}, scope=scope) == "9:42"
    assert adapter.calls[-1] == ("revision", scope)


def test_scoped_history_does_not_create_or_modify_local_files(tmp_path, adapter):
    config = {"DATA_DIR": tmp_path}
    sentinel = tmp_path / "existing.txt"
    sentinel.write_text("unchanged", encoding="utf-8")
    scope = log_history.HistoryScope(library_id=9)
    log_history.append_log_history(config, {"id": "entry-1", "action": "Refresh started"}, scope=scope)
    log_history.load_log_history(config, scope=scope)
    assert sentinel.read_text(encoding="utf-8") == "unchanged"
    assert sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*")) == [Path("existing.txt")]
