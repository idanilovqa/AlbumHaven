from __future__ import annotations

import inspect
import json
import time

from music_app.services import cover_lookup_diagnostics


def test_default_bandcamp_diagnostic_covers_morse_portnoy_george_second_album():
    scenario = next(
        item
        for item in cover_lookup_diagnostics.DEFAULT_DIAGNOSTIC_SCENARIOS
        if item.get("id") == "bandcamp-focus"
    )

    assert scenario["album"] == {
        "artist": "Morse Portnoy George",
        "album": "Cover 2 Cover",
        "year": 2012,
        "edition": None,
    }


def test_run_cover_lookup_diagnostic_composes_multi_scenario_report(monkeypatch):
    class FakeRegistry:
        def search_bandcamp_matches(self, query, *, log_event=None):
            return [{"id": "bandcamp-1", "source": "bandcamp", "url": "https://images.example/bandcamp.jpg"}]

        def search_discogs_and_cover_art_archive_matches(self, query, *, log_event=None):
            return (
                [{"id": "discogs-1", "source": "discogs", "url": "https://images.example/discogs.jpg"}],
                [{"id": "caa-1", "source": "cover_art_archive", "url": "https://images.example/caa.jpg"}],
            )

        def search_artist_website_matches(self, query, *, log_event=None):
            return []

    monkeypatch.setattr(
        cover_lookup_diagnostics,
        "_run_service_provider_with_diagnostics",
        lambda provider_name, album_request, *, user_agent: (
            [{"id": "apple-1", "source": provider_name, "url": "https://images.example/apple.jpg"}],
            {
                "name": provider_name,
                "status": "completed",
                "started_at": "2026-06-06T00:00:00Z",
                "finished_at": "2026-06-06T00:00:01Z",
                "duration_ms": 10.0,
                "candidate_count": 1,
                "album": album_request,
            },
        ),
    )
    monkeypatch.setattr(cover_lookup_diagnostics, "COVER_LOOKUP_PROVIDER_REGISTRY", FakeRegistry())

    scenarios = [
        {
            "id": "apple",
            "label": "Apple Music",
            "album": {"artist": "Pink Floyd", "album": "The Dark Side of the Moon", "year": 1973},
            "service_provider": "apple",
            "expectations": {"apple": {"min_candidates": 1}},
        },
        {
            "id": "bandcamp",
            "label": "Bandcamp Focus",
            "album": {"artist": "Morse Portnoy George", "album": "Cover to Cover", "year": 2020},
            "providers": ["bandcamp"],
            "expectations": {"bandcamp": {"min_candidates": 1}},
        },
    ]

    report = cover_lookup_diagnostics.run_cover_lookup_diagnostic(
        scenarios,
        user_agent="AlbumHavenTests/1.0",
        provider_warning_ms=999_999,
        scenario_warning_ms=999_999,
        total_warning_ms=999_999,
        parallel=False,
    )

    assert len(report["scenario_runs"]) == 2
    assert report["scenario_runs"][0]["label"] == "Apple Music"
    assert report["scenario_runs"][0]["result_summary"]["combined_candidate_count"] == 1
    assert [provider["name"] for provider in report["scenario_runs"][0]["provider_runs"]] == ["apple"]
    assert report["scenario_runs"][0]["expectation_results"] == [
        {
            "key": "apple",
            "label": "apple",
            "min_candidates": 1,
            "actual_candidates": 1,
            "passed": True,
            "status": "completed",
        },
    ]
    assert [provider["name"] for provider in report["scenario_runs"][1]["provider_runs"]] == ["bandcamp"]
    assert report["warnings"] == []


def test_cover_lookup_diagnostic_exposes_stable_phase_shapes(monkeypatch):
    class FakeRegistry:
        def search_bandcamp_matches(self, query, *, log_event=None):
            return [{"id": "bandcamp-1", "source": "bandcamp", "url": "https://images.example/cover.jpg"}]

    monkeypatch.setattr(cover_lookup_diagnostics, "COVER_LOOKUP_PROVIDER_REGISTRY", FakeRegistry())

    report = cover_lookup_diagnostics.run_cover_lookup_diagnostic(
        [{
            "id": "phase-contract",
            "label": "Phase Contract",
            "album": {"artist": "Test Artist", "album": "Test Album", "year": 2001},
            "providers": ["bandcamp"],
        }],
        user_agent="AlbumHavenTests/1.0",
        parallel=False,
    )

    scenario = report["scenario_runs"][0]
    phase_timings = scenario["phase_timings_ms"]
    phase_counts = scenario["phase_counts"]
    assert list(phase_timings) == ["discovery", "fetch", "scoring", "persistence"]
    assert list(phase_counts) == ["discovery", "fetch", "scoring", "persistence"]
    assert all(isinstance(duration, (int, float)) and duration >= 0 for duration in phase_timings.values())
    assert all(isinstance(count, int) and count >= 0 for count in phase_counts.values())


def test_cover_lookup_diagnostic_sanitizes_provider_secrets_and_payloads(monkeypatch):
    private_url = "https://alice:password@secret.example/private.jpg?token=query-secret#fragment-secret"
    private_user_agent = "AlbumHavenPrivate/9.9"
    private_path = r"X:\PrivateRoot\Music\Album\cover.jpg"
    leaked_values = [
        "Bearer super-secret-token",
        "session-cookie-secret",
        "nested-token-secret",
        "api-key-secret",
        "client-secret-value",
        "alice:password",
        "query-secret",
        "fragment-secret",
        private_user_agent,
        private_path,
        "raw-provider-secret",
        "body-secret",
        "error-body-secret",
        "request-body-secret",
        "response-body-secret",
        "content-secret",
        "nested-request-body-secret",
        "nested-response-content-secret",
        r"X:\PrivateRoot\Music\Album\secret.jpg",
        "/srv/private/music/secret.jpg",
        r"\\private-server\music\secret.jpg",
    ]

    class FakeRegistry:
        def search_bandcamp_matches(self, query, *, log_event=None):
            log_event(
                {},
                object(),
                "Cover lookup fetch debug",
                service="bandcamp",
                phase="fetch",
                status="running",
                duration_ms=12.5,
                candidate_count=1,
                url=private_url,
                authorization="Bearer super-secret-token",
                cookie="session-cookie-secret",
                token="nested-token-secret",
                api_key="api-key-secret",
                client_secret="client-secret-value",
                user_agent=private_user_agent,
                file_path=private_path,
                raw_bytes=b"raw-provider-secret",
                raw_payload={
                    "private": "raw-provider-secret",
                    "nested": [{"authorization": "Bearer super-secret-token"}],
                },
                safe_nested={
                    "status": "completed",
                    "duration_ms": 3.25,
                    "candidate_count": 1,
                },
                body="body-secret",
                error_body="error-body-secret",
                request_body="request-body-secret",
                response_body="response-body-secret",
                content="content-secret",
                request={"safe_timing": 9.5, "body": "nested-request-body-secret"},
                response={"status": 200, "content": "nested-response-content-secret"},
                punctuated_windows_path=r"detail=(X:\PrivateRoot\Music\Album\secret.jpg)",
                punctuated_unix_path="detail=[/srv/private/music/secret.jpg]",
                punctuated_unc_path=r"detail=(\\private-server\music\secret.jpg)",
            )
            raise RuntimeError(f"Authorization: Bearer super-secret-token | {private_url} | {private_path}")

    monkeypatch.setattr(cover_lookup_diagnostics, "COVER_LOOKUP_PROVIDER_REGISTRY", FakeRegistry())

    report = cover_lookup_diagnostics.run_cover_lookup_diagnostic(
        [{
            "id": "sanitized-contract",
            "label": "Sanitized Contract",
            "album": {"artist": "Test Artist", "album": "Test Album", "year": 2001},
            "providers": ["bandcamp"],
        }],
        user_agent=private_user_agent,
        parallel=False,
    )
    serialized = json.dumps(report)

    scenario = report["scenario_runs"][0]
    provider = scenario["provider_runs"][0]
    debug_event = provider["debug_events"][0]
    assert provider["name"] == "bandcamp"
    assert provider["status"] == "failed"
    assert provider["error_kind"] == "provider-error"
    assert isinstance(provider["duration_ms"], (int, float))
    assert provider["candidate_count"] == 0
    assert list(scenario["phase_timings_ms"]) == ["discovery", "fetch", "scoring", "persistence"]
    assert list(scenario["phase_counts"]) == ["discovery", "fetch", "scoring", "persistence"]
    assert debug_event["action"] == "Cover lookup fetch debug"
    assert debug_event["service"] == "bandcamp"
    assert debug_event["phase"] == "fetch"
    assert debug_event["status"] == "running"
    assert debug_event["duration_ms"] == 12.5
    assert debug_event["candidate_count"] == 1
    assert debug_event["url"] == "https://secret.example/private.jpg"
    assert debug_event["safe_nested"] == {
        "status": "completed",
        "duration_ms": 3.25,
        "candidate_count": 1,
    }
    assert not {
        "body",
        "error_body",
        "request_body",
        "response_body",
        "content",
        "request",
        "response",
    } & set(debug_event)
    assert all(secret not in serialized for secret in leaked_values)


def test_cover_lookup_diagnostics_source_does_not_import_legacy_cover_facade():
    source = inspect.getsource(cover_lookup_diagnostics)

    legacy_name = "remote" + "_covers"
    assert legacy_name not in source


def test_service_search_diagnostics_captures_nested_provider_events_through_registry(monkeypatch):
    class FakeRegistry:
        def search_music_service_matches(self, query, *, manual_urls=None, should_cancel=None, enabled_services=None, log_event=None):
            assert enabled_services is None
            log_event(
                {},
                object(),
                "Cover search provider started",
                service="apple",
                artist=query.artist,
                album=query.album,
                year=query.year,
            )
            log_event(
                {},
                object(),
                "Cover search provider completed",
                service="apple",
                artist=query.artist,
                album=query.album,
                year=query.year,
                elapsed_ms=15.0,
                candidate_count=1,
                acceptable_candidate_count=1,
            )
            log_event(
                {},
                object(),
                "Cover search provider skipped",
                service="spotify",
                artist=query.artist,
                album=query.album,
                year=query.year,
                reason="acceptable_primary_candidate_already_found",
            )
            return ([{"id": "apple-1", "source": "apple"}], [])

    monkeypatch.setattr(cover_lookup_diagnostics, "COVER_LOOKUP_PROVIDER_REGISTRY", FakeRegistry())

    candidates, result, provider_events = cover_lookup_diagnostics._run_service_search_with_diagnostics(
        {"artist": "Test Artist", "album": "Test Album", "edition": None, "year": 2001},
        user_agent="AlbumHavenTests/1.0",
    )

    assert candidates == [{"id": "apple-1", "source": "apple"}]
    assert result["name"] == "service_search"
    assert result["status"] == "completed"
    assert provider_events == [
        {
            "name": "apple",
            "status": "completed",
            "started_at": provider_events[0]["started_at"],
            "finished_at": provider_events[0]["finished_at"],
            "duration_ms": 15.0,
            "candidate_count": 1,
            "album": {"artist": "Test Artist", "album": "Test Album", "edition": None, "year": 2001},
            "acceptable_candidate_count": 1,
            "matched_sources": ["apple"],
        },
        {
            "name": "spotify",
            "status": "skipped",
            "started_at": provider_events[1]["started_at"],
            "finished_at": provider_events[1]["finished_at"],
            "duration_ms": 0.0,
            "candidate_count": 0,
            "album": {"artist": "Test Artist", "album": "Test Album", "edition": None, "year": 2001},
            "skip_reason": "acceptable_primary_candidate_already_found",
        },
    ]


def test_provider_diagnostics_route_through_registry_and_preserve_candidate_counts(monkeypatch):
    calls: list[tuple[str, object]] = []

    class FakeRegistry:
        def search_music_service_matches(self, query, *, manual_urls=None, should_cancel=None, enabled_services=None, log_event=None):
            calls.append(("service", tuple(enabled_services or [])))
            log_event(
                {},
                object(),
                "Cover search provider completed",
                service="spotify",
                artist=query.artist,
                album=query.album,
                year=query.year,
                elapsed_ms=7.0,
                candidate_count=1,
                acceptable_candidate_count=1,
            )
            return ([{"id": "spotify-1", "source": "spotify"}], [])

        def search_bandcamp_matches(self, query, *, log_event=None):
            calls.append(("bandcamp", query.album))
            return [{"id": "bandcamp-1", "source": "bandcamp"}]

        def search_discogs_and_cover_art_archive_matches(
            self,
            query,
            *,
            include_discogs=True,
            include_cover_art_archive=True,
            log_event=None,
        ):
            calls.append(("combined", (query.artist, include_discogs, include_cover_art_archive)))
            return (
                [{"id": "discogs-1", "source": "discogs"}] if include_discogs else [],
                (
                    [{"id": "caa:release-1:0", "source": "cover_art_archive", "lookup_group": "cover_art_archive"}]
                    if include_cover_art_archive
                    else []
                ),
            )

        def search_artist_website_matches(self, query, *, log_event=None):
            calls.append(("artist_website", query.year))
            return [{"id": "artist-site-1", "source": "artist_website"}]

    monkeypatch.setattr(cover_lookup_diagnostics, "COVER_LOOKUP_PROVIDER_REGISTRY", FakeRegistry())

    scenarios = [
        {
            "id": "spotify",
            "label": "Spotify",
            "album": {"artist": "Test Artist", "album": "Test Album", "year": 2001},
            "service_provider": "spotify",
        },
        {
            "id": "providers",
            "label": "Providers",
            "album": {"artist": "Test Artist", "album": "Test Album", "year": 2001},
            "providers": ["bandcamp", "discogs", "cover_art_archive", "artist_website"],
        },
    ]

    report = cover_lookup_diagnostics.run_cover_lookup_diagnostic(
        scenarios,
        user_agent="AlbumHavenTests/1.0",
        provider_warning_ms=999_999,
        scenario_warning_ms=999_999,
        total_warning_ms=999_999,
        parallel=False,
    )

    assert calls[:2] == [
        ("service", ("spotify",)),
        ("bandcamp", "Test Album"),
    ]
    assert set(calls[2:4]) == {
        ("combined", ("Test Artist", True, False)),
        ("combined", ("Test Artist", False, True)),
    }
    assert calls[4:] == [("artist_website", 2001)]
    assert report["scenario_runs"][0]["result_summary"]["service_candidate_count"] == 1
    provider_summary = report["scenario_runs"][1]["result_summary"]
    assert provider_summary["bandcamp_candidate_count"] == 1
    assert provider_summary["discogs_candidate_count"] == 1
    assert provider_summary["cover_art_archive_candidate_count"] == 1
    assert provider_summary["artist_website_candidate_count"] == 1
    assert provider_summary["combined_candidate_count"] == 4


def test_run_cover_lookup_diagnostic_runs_scenarios_in_parallel(monkeypatch):
    def fake_run_scenario(scenario, *, user_agent):
        time.sleep(0.2)
        return {
            "id": scenario["id"],
            "label": scenario["label"],
            "album": scenario["album"],
            "expectations": {},
            "started_at": "2026-06-06T00:00:00Z",
            "finished_at": "2026-06-06T00:00:00Z",
            "duration_ms": 1.0,
            "provider_runs": [],
            "result_summary": {"combined_candidate_count": 0},
        }

    monkeypatch.setattr(cover_lookup_diagnostics, "_run_scenario", fake_run_scenario)
    monkeypatch.setattr(cover_lookup_diagnostics, "ensure_verbose_logging_level", lambda: None)

    scenarios = [
        {"id": "one", "label": "One", "album": {"artist": "A", "album": "A"}},
        {"id": "two", "label": "Two", "album": {"artist": "B", "album": "B"}},
    ]

    started = time.perf_counter()
    report = cover_lookup_diagnostics.run_cover_lookup_diagnostic(
        scenarios,
        user_agent="AlbumHavenTests/1.0",
    )
    elapsed = time.perf_counter() - started

    assert [scenario["id"] for scenario in report["scenario_runs"]] == ["one", "two"]
    assert elapsed < 0.35


def test_build_scenario_warnings_flags_slow_and_failed_providers():
    scenario = {
        "label": "Main Providers",
        "duration_ms": 31_500.0,
        "provider_runs": [
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
    }

    warnings = cover_lookup_diagnostics._build_scenario_warnings(
        scenario,
        provider_warning_ms=12_000,
        scenario_warning_ms=30_000,
    )

    assert warnings == [
        "Main Providers: service_search took 14000.00 ms, above the soft warning threshold of 12000 ms.",
        "Main Providers: service_search/apple took 13000.00 ms, above the soft warning threshold of 12000 ms.",
        "Main Providers: service_search/spotify failed (network-blocked).",
        "Main Providers: discogs failed (provider-error): boom",
        "Main Providers total duration was 31500.00 ms, above the soft warning threshold of 30000 ms.",
    ]


def test_format_cover_lookup_diagnostic_report_renders_summary():
    report = {
        "generated_at": "2026-06-06T00:00:00Z",
        "total_duration_ms": 4567.89,
        "scenario_runs": [
            {
                "label": "Apple Music",
                "album": {"artist": "Pink Floyd", "album": "The Dark Side of the Moon", "year": 1973, "edition": None},
                "duration_ms": 1234.56,
                "phase_timings_ms": {
                    "discovery": 700.0,
                    "fetch": 100.0,
                    "scoring": 300.0,
                    "persistence": 134.56,
                },
                "phase_counts": {
                    "discovery": 4,
                    "fetch": 1,
                    "scoring": 3,
                    "persistence": 2,
                },
                "provider_runs": [
                    {
                        "name": "apple",
                        "status": "completed",
                        "duration_ms": 1234.56,
                        "candidate_count": 2,
                    },
                ],
            },
        ],
        "warnings": [],
    }

    rendered = cover_lookup_diagnostics.format_cover_lookup_diagnostic_report(report)

    assert "Cover Lookup Diagnostic Report" in rendered
    assert "Apple Music: Pink Floyd - The Dark Side of the Moon (1973)" in rendered
    assert "Phase timings:" in rendered
    assert "- discovery: 700.00 ms, 4 items" in rendered
    assert "- fetch: 100.00 ms, 1 item" in rendered
    assert "- scoring: 300.00 ms, 3 items" in rendered
    assert "- persistence: 134.56 ms, 2 items" in rendered
    assert "- apple: completed, 1234.56 ms, 2 candidates" in rendered
    assert "- None" in rendered


def test_render_cover_lookup_diagnostic_html_renders_panels():
    report = {
        "generated_at": "2026-06-06T00:00:00Z",
        "total_duration_ms": 4567.89,
        "provider_warning_ms": 12000,
        "scenario_warning_ms": 30000,
        "scenario_runs": [
            {
                "id": "apple-focus",
                "label": "Apple Music",
                "album": {"artist": "Pink Floyd", "album": "The Dark Side of the Moon", "year": 1973, "edition": None},
                "duration_ms": 1234.56,
                "phase_timings_ms": {
                    "discovery": 700.0,
                    "fetch": 100.0,
                    "scoring": 300.0,
                    "persistence": 134.56,
                },
                "phase_counts": {
                    "discovery": 4,
                    "fetch": 1,
                    "scoring": 3,
                    "persistence": 2,
                },
                "provider_runs": [
                    {
                        "name": "apple",
                        "status": "completed",
                        "duration_ms": 1234.56,
                        "candidate_count": 2,
                    },
                    {
                        "name": "bandcamp",
                        "status": "failed",
                        "duration_ms": 2222.0,
                        "candidate_count": 0,
                        "error": "network blocked",
                        "error_kind": "network-blocked",
                    },
                ],
                "result_summary": {"combined_candidate_count": 3},
            },
        ],
        "warnings": ["Main Providers: bandcamp failed (network-blocked): network blocked"],
    }

    html_report = cover_lookup_diagnostics.render_cover_lookup_diagnostic_html(report)

    assert "Cover Lookup Provider Timing Report" in html_report
    assert "Pink Floyd - The Dark Side of the Moon (1973)" in html_report
    assert "Runtime Phases" in html_report
    assert ">discovery<" in html_report
    assert ">fetch<" in html_report
    assert ">scoring<" in html_report
    assert ">persistence<" in html_report
    assert ">700.00 ms<" in html_report
    assert ">4<" in html_report
    assert ">apple<" in html_report
    assert "Main Providers: bandcamp failed (network-blocked): network blocked" in html_report
