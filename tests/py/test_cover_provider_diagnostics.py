from __future__ import annotations

from music_app.services import cover_provider_diagnostics


def test_classify_provider_error_groups_common_failure_modes():
    assert cover_provider_diagnostics.classify_provider_error(OSError("WinError 10013 forbidden by its access permissions")) == "network-blocked"
    assert cover_provider_diagnostics.classify_provider_error(TimeoutError("request timed out")) == "timeout"
    assert cover_provider_diagnostics.classify_provider_error(OSError("Temporary failure in name resolution")) == "dns-failure"
    assert cover_provider_diagnostics.classify_provider_error(RuntimeError("HTTP 403 from provider")) == "authorization-failure"
    assert cover_provider_diagnostics.classify_provider_error(RuntimeError("unexpected payload")) == "provider-error"


def test_service_events_to_provider_results_preserves_provider_event_fields():
    album = {"artist": "Test Artist", "album": "Test Album", "year": 2001}
    events = [
        {
            "action": "Cover search provider started",
            "captured_at": "2026-06-28T00:00:00Z",
            "service": "apple",
            "artist": "Test Artist",
            "album": "Test Album",
            "year": 2001,
        },
        {
            "action": "Cover search provider completed",
            "captured_at": "2026-06-28T00:00:01Z",
            "service": "apple",
            "elapsed_ms": 25.5,
            "candidate_count": 2,
            "acceptable_candidate_count": 1,
        },
        {
            "action": "Cover search provider skipped",
            "captured_at": "2026-06-28T00:00:02Z",
            "service": "spotify",
            "reason": "acceptable_primary_candidate_already_found",
        },
        {
            "action": "Cover search provider failed",
            "captured_at": "2026-06-28T00:00:03Z",
            "service": "deezer",
            "elapsed_ms": 12.0,
            "error": "request timed out",
            "error_kind": "timeout",
        },
    ]

    results = cover_provider_diagnostics.service_events_to_provider_results(
        [{"source": "apple"}],
        events,
        album,
    )

    assert results == [
        {
            "name": "apple",
            "status": "completed",
            "started_at": "2026-06-28T00:00:00Z",
            "finished_at": "2026-06-28T00:00:01Z",
            "duration_ms": 25.5,
            "candidate_count": 2,
            "album": album,
            "acceptable_candidate_count": 1,
            "matched_sources": ["apple"],
        },
        {
            "name": "deezer",
            "status": "failed",
            "started_at": "2026-06-28T00:00:03Z",
            "finished_at": "2026-06-28T00:00:03Z",
            "duration_ms": 12.0,
            "candidate_count": 0,
            "album": album,
            "error": "request timed out",
            "error_kind": "timeout",
        },
        {
            "name": "spotify",
            "status": "skipped",
            "started_at": "2026-06-28T00:00:02Z",
            "finished_at": "2026-06-28T00:00:02Z",
            "duration_ms": 0.0,
            "candidate_count": 0,
            "album": album,
            "skip_reason": "acceptable_primary_candidate_already_found",
        },
    ]


def test_log_provider_failed_event_includes_error_and_error_kind():
    captured: list[dict[str, object]] = []

    cover_provider_diagnostics.log_provider_failed(
        lambda config, logger, action, **fields: captured.append({"action": action, **fields}),
        {},
        object(),
        service="apple",
        artist="Test Artist",
        album="Test Album",
        year=2001,
        elapsed_ms=12.34,
        exc=TimeoutError("request timed out"),
    )

    assert captured == [
        {
            "action": "Cover search provider failed",
            "level": "info",
            "service": "apple",
            "artist": "Test Artist",
            "album": "Test Album",
            "year": 2001,
            "elapsed_ms": 12.34,
            "error": "request timed out",
            "error_kind": "timeout",
        }
    ]


def test_build_provider_warning_messages_includes_nested_provider_events():
    warnings = cover_provider_diagnostics.build_provider_warning_messages(
        scenario_label="Main Providers",
        provider_runs=[
            {
                "name": "service_search",
                "status": "completed",
                "duration_ms": 14_000.0,
                "candidate_count": 3,
                "provider_events": [
                    {"name": "apple", "status": "completed", "duration_ms": 13_000.0, "candidate_count": 2},
                    {"name": "spotify", "status": "failed", "duration_ms": 500.0, "candidate_count": 0, "error_kind": "network-blocked"},
                ],
            },
            {"name": "discogs", "status": "failed", "duration_ms": 250.0, "candidate_count": 0, "error": "boom", "error_kind": "provider-error"},
        ],
        provider_warning_ms=12_000,
    )

    assert warnings == [
        "Main Providers: service_search took 14000.00 ms, above the soft warning threshold of 12000 ms.",
        "Main Providers: service_search/apple took 13000.00 ms, above the soft warning threshold of 12000 ms.",
        "Main Providers: service_search/spotify failed (network-blocked).",
        "Main Providers: discogs failed (provider-error): boom",
    ]
