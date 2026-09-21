"""Preserve fixture scope isolation and credential-safe operational metadata."""
from types import SimpleNamespace

import pytest

from tests.py.asgi_testing import configure_test_bootstrap_actor
from music_app.services.log_history import _normalize_log_history_item


def test_bootstrap_fixture_configures_initial_none_media_host_without_resetting_later_scope():
    app = SimpleNamespace(state=SimpleNamespace(media_host_library_id=None))
    configure_test_bootstrap_actor(app)
    assert app.state.media_host_library_id == 1
    resolver = app.state.current_actor_resolver
    app.state.media_host_library_id = None
    configure_test_bootstrap_actor(app)
    assert app.state.current_actor_resolver is resolver
    assert app.state.media_host_library_id is None


def test_bootstrap_fixture_does_not_grant_media_host_scope_to_custom_actor():
    resolver = object()
    app = SimpleNamespace(state=SimpleNamespace(current_actor_resolver=resolver, media_host_library_id=None))
    configure_test_bootstrap_actor(app)
    assert app.state.current_actor_resolver is resolver
    assert app.state.media_host_library_id is None


def test_safe_history_preserves_diagnostics_without_preserving_provider_credentials():
    source = {
        "id": "connection-failed", "action": "Last.fm connection failed",
        "timestamp": "2026-09-18T12:00:00+00:00", "track_number": "04",
        "integration": "Last.fm", "status": "failed", "failure_stage": "provider_authentication",
        "error_kind": "invalid_credentials", "error_code": 4, "retryable": False,
        "error": "password=do-not-retain token=private-token C:/Private/Music/song.flac",
        "username": "private-listener", "password": "do-not-retain", "session_key": "private-key",
        "provider_response": {"api_sig": "secret-signature"},
    }
    item = _normalize_log_history_item(source)
    assert {key: item[key] for key in (
        "track_number", "integration", "status", "failure_stage", "error_kind", "error_code", "retryable",
    )} == {
        "track_number": "04", "integration": "Last.fm", "status": "failed",
        "failure_stage": "provider_authentication", "error_kind": "invalid_credentials",
        "error_code": 4, "retryable": False,
    }
    for key in ("username", "password", "session_key", "provider_response"):
        assert key not in item
    for value in ("do-not-retain", "private-token", "Private/Music", "private-listener", "secret-signature"):
        assert value not in str(item)
    assert _normalize_log_history_item(item) == item


@pytest.mark.parametrize("value", ["false", "true", 0, 1, None, {}, []])
def test_safe_history_does_not_coerce_untrusted_retryable_values(value):
    assert "retryable" not in _normalize_log_history_item({"retryable": value})


def test_log_history_preserves_scrobble_submission_summary_counts():
    item = _normalize_log_history_item({
        "action": "Last.fm pending scrobble submission failed",
        "attempted": 3,
        "succeeded": 2,
        "failed": 1,
        "pending_before": 3,
        "pending_after": 1,
    })

    assert {key: item[key] for key in (
        "attempted", "succeeded", "failed", "pending_before", "pending_after",
    )} == {
        "attempted": 3, "succeeded": 2, "failed": 1,
        "pending_before": 3, "pending_after": 1,
    }
