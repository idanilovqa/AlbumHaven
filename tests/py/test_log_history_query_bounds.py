"""Bounded operational-history input and persisted severity contracts."""
from types import SimpleNamespace

import pytest

from music_app.services import app_logging, log_history


@pytest.mark.parametrize("payload", [
    {"text": "a" * 2049},
    {"sources": ["scan"] * 101},
    {"event_types": ["event"] * 101},
    {"event_ids": ["id"] * 101},
    {"sources": ["a" * 257]},
    {"event_types": ["a" * 257]},
    {"event_ids": ["a" * 257]},
])
def test_query_rejects_oversized_inputs_before_store_access(payload, monkeypatch):
    monkeypatch.setattr(log_history, "LogHistoryPostgresAdapter",
                        lambda *_: pytest.fail("invalid query reached the store"))
    with pytest.raises(log_history.LogHistoryQueryError) as caught:
        log_history.load_log_history_snapshot({}, scope=log_history.HistoryScope(library_id=9), query=payload)
    assert caught.value.status_code == 400


def test_query_accepts_exact_limits_and_unregistered_action_labels():
    query = log_history.normalize_log_history_query({
        "text": "a" * 2048,
        "sources": ["a" * 256],
        "event_types": [f"Future action {index}" for index in range(100)],
        "event_ids": ["b" * 256],
    })
    assert len(query.text) == 2048 and len(query.event_types) == 100
    assert query.sources == ("a" * 256,) and query.event_ids == ("b" * 256,)


@pytest.mark.parametrize("level", ["error", "warning", "info"])
def test_operational_history_preserves_severity_and_captured_scope(level, monkeypatch):
    captured = []
    scope = log_history.HistoryScope(library_id=9, account_id=7, origin_kind="request")
    monkeypatch.setattr(app_logging, "append_log_history",
        lambda config, entry, *, scope: captured.append((dict(entry), scope)))
    messages = []
    logger = SimpleNamespace(log=lambda number, message: messages.append((number, message)))
    app_logging.log_app_event({}, logger, "Refresh completed", level=level,
                              history=True, history_scope=scope)
    assert captured[0][0]["level"] == level
    assert captured[0][1] is scope
    assert "history_scope" not in captured[0][0]
    assert messages
