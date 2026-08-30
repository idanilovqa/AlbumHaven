from __future__ import annotations

import html
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from urllib.parse import urlsplit, urlunsplit

from music_app.services.app_logging import ensure_verbose_logging_level
from music_app.services.cover_provider_diagnostics import (
    build_provider_warning_messages,
    capture_provider_event,
    classify_provider_error as _classify_provider_error,
    service_events_to_provider_results,
)
from music_app.services.cover_provider_registry import (
    COVER_LOOKUP_PROVIDER_REGISTRY,
    CoverLookupProviderQuery,
)
from music_app.services.cover_lookup_runtime import merge_lookup_matches


DEFAULT_PROVIDER_WARNING_MS = 12_000
DEFAULT_SCENARIO_WARNING_MS = 30_000
DEFAULT_TOTAL_WARNING_MS = 45_000
_SERVICE_PROVIDER_NAMES = {"apple", "deezer", "youtube_music", "spotify", "genius"}
_PHASE_NAMES = ("discovery", "fetch", "scoring", "persistence")
_SENSITIVE_KEY_FRAGMENTS = (
    "authorization",
    "cookie",
    "password",
    "token",
    "secret",
    "api_key",
    "client_secret",
)
_PRIVATE_DATA_KEY_TOKENS = {"file", "path", "payload", "raw", "useragent"}
_PRIVATE_PAYLOAD_KEYS = {
    "body",
    "content",
    "error_body",
    "request",
    "request_body",
    "response",
    "response_body",
}
_WINDOWS_ABSOLUTE_PATH = re.compile(r"(?i)(?<![a-z0-9])[a-z]:[\\/]")
_UNC_PATH = re.compile(r"\\\\[^\\\s]+\\")
_UNIX_ABSOLUTE_PATH = re.compile(r"(?<![a-z0-9:/])/(?!/)[^\s\"'<>]+", re.IGNORECASE)
_HTTP_URL = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_SENSITIVE_VALUE_MARKER = re.compile(
    r"(?i)(?:\bauthorization\s*:|\bbearer\s+|\b(?:cookie|password|token|api[_ -]?key|client[_ -]?secret)\b\s*[:=])"
)

DEFAULT_DIAGNOSTIC_SCENARIOS: list[dict[str, object]] = [
    {
        "id": "apple-focus",
        "label": "Apple Music",
        "album": {
            "artist": "Pink Floyd",
            "album": "The Dark Side of the Moon",
            "year": 1973,
            "edition": None,
        },
        "expectations": {
            "apple": {"min_candidates": 1},
        },
        "service_provider": "apple",
    },
    {
        "id": "deezer-focus",
        "label": "Deezer",
        "album": {
            "artist": "Pink Floyd",
            "album": "The Dark Side of the Moon",
            "year": 1973,
            "edition": None,
        },
        "expectations": {
            "deezer": {"min_candidates": 1},
        },
        "service_provider": "deezer",
    },
    {
        "id": "youtube-music-focus",
        "label": "YouTube Music",
        "album": {
            "artist": "Pink Floyd",
            "album": "The Dark Side of the Moon",
            "year": 1973,
            "edition": None,
        },
        "expectations": {
            "youtube_music": {"min_candidates": 1},
        },
        "service_provider": "youtube_music",
    },
    {
        "id": "spotify-focus",
        "label": "Spotify",
        "album": {
            "artist": "Pink Floyd",
            "album": "The Dark Side of the Moon",
            "year": 1973,
            "edition": None,
        },
        "expectations": {
            "spotify": {"min_candidates": 1},
        },
        "service_provider": "spotify",
    },
    {
        "id": "bandcamp-focus",
        "label": "Bandcamp Focus",
        "album": {
            "artist": "Morse Portnoy George",
            "album": "Cover 2 Cover",
            "year": 2012,
            "edition": None,
        },
        "providers": ["bandcamp"],
        "expectations": {
            "bandcamp": {"min_candidates": 1},
        },
    },
    {
        "id": "cover-art-archive-focus",
        "label": "Cover Art Archive Focus",
        "album": {
            "artist": "Neal Morse",
            "album": "Sola Scriptura",
            "year": 2007,
            "edition": None,
        },
        "providers": ["cover_art_archive"],
    },
    {
        "id": "discogs-focus",
        "label": "Discogs Focus",
        "album": {
            "artist": "Flaming Row",
            "album": "The Pure Shine",
            "year": 2019,
            "edition": None,
        },
        "providers": ["discogs"],
        "expectations": {
            "discogs": {"min_candidates": 1},
        },
    },
]


def _now_iso8601_utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _safe_int(value: object) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        text = str(value or "").strip()
        if not text:
            return None
        return int(text)
    except Exception:
        return None


def _candidate_count(value: object) -> int:
    return len(value) if isinstance(value, list) else 0


def _escape(value: object) -> str:
    return html.escape(str(value or ""))


def _normalize_album_request(album_request: dict[str, object]) -> dict[str, object]:
    payload = dict(album_request or {})
    payload["artist"] = str(payload.get("artist") or "").strip()
    payload["album"] = str(payload.get("album") or "").strip()
    payload["edition"] = str(payload.get("edition") or "").strip() or None
    payload["year"] = _safe_int(payload.get("year"))
    if not payload["artist"] or not payload["album"]:
        raise ValueError("artist and album are required for cover lookup diagnostics.")
    return payload


def _normalize_scenarios(scenarios: list[dict[str, object]] | None) -> list[dict[str, object]]:
    normalized: list[dict[str, object]] = []
    for index, raw_scenario in enumerate(scenarios or DEFAULT_DIAGNOSTIC_SCENARIOS):
        album = _normalize_album_request(raw_scenario.get("album") if isinstance(raw_scenario.get("album"), dict) else {})
        providers = raw_scenario.get("providers")
        service_provider = str(raw_scenario.get("service_provider") or "").strip() or None
        if service_provider and service_provider not in _SERVICE_PROVIDER_NAMES:
            raise ValueError(f"Unsupported service_provider {service_provider!r} in cover lookup diagnostics.")
        normalized.append({
            "id": str(raw_scenario.get("id") or f"scenario-{index + 1}"),
            "label": str(raw_scenario.get("label") or f"Scenario {index + 1}"),
            "album": album,
            "providers": [str(item).strip() for item in providers] if isinstance(providers, list) else None,
            "expectations": deepcopy(raw_scenario.get("expectations") if isinstance(raw_scenario.get("expectations"), dict) else {}),
            "service_provider": service_provider,
        })
    return normalized


def _provider_query(album_request: dict[str, object], *, user_agent: str) -> CoverLookupProviderQuery:
    edition = album_request.get("edition")
    return CoverLookupProviderQuery(
        artist=str(album_request["artist"]),
        album=str(album_request["album"]),
        edition=edition if isinstance(edition, str) else None,
        year=_safe_int(album_request.get("year")),
        user_agent=user_agent,
    )


def _phase_timing_shape(**overrides: float) -> dict[str, float]:
    return {
        phase_name: round(max(0.0, float(overrides.get(phase_name, 0.0))), 2)
        for phase_name in _PHASE_NAMES
    }


def _phase_count_shape(**overrides: int) -> dict[str, int]:
    return {
        phase_name: max(0, int(overrides.get(phase_name, 0)))
        for phase_name in _PHASE_NAMES
    }


def _diagnostic_key_is_private(key: object) -> bool:
    normalized = str(key or "").strip().casefold().replace("-", "_")
    if normalized in _PRIVATE_PAYLOAD_KEYS:
        return True
    collapsed_key = normalized.replace("_", "")
    if any(
        fragment in normalized or fragment.replace("_", "") in collapsed_key
        for fragment in _SENSITIVE_KEY_FRAGMENTS
    ):
        return True
    tokens = {
        token
        for token in re.split(r"[^a-z0-9]+", normalized)
        if token
    }
    collapsed = re.sub(r"[^a-z0-9]+", "", normalized)
    return bool(tokens & _PRIVATE_DATA_KEY_TOKENS) or collapsed == "useragent"


def _sanitize_diagnostic_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return "[redacted]"
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return value
    hostname = parsed.hostname
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    try:
        port = parsed.port
    except ValueError:
        port = None
    netloc = f"{hostname}:{port}" if port is not None else hostname
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


def _sanitize_diagnostic_string(value: str) -> str:
    sanitized_urls: dict[str, str] = {}

    def mask_url(match: re.Match[str]) -> str:
        marker = f"\x00ALBUM_HAVEN_DIAGNOSTIC_URL_{len(sanitized_urls)}\x00"
        sanitized_urls[marker] = _sanitize_diagnostic_url(match.group(0))
        return marker

    masked_value = _HTTP_URL.sub(mask_url, value)
    stripped = masked_value.strip()
    lowered = stripped.casefold()
    if _SENSITIVE_VALUE_MARKER.search(stripped):
        return "[redacted]"
    if (
        _WINDOWS_ABSOLUTE_PATH.search(stripped)
        or _UNC_PATH.search(stripped)
        or _UNIX_ABSOLUTE_PATH.search(stripped)
    ):
        return "[redacted]"
    if stripped.startswith("/") or '"raw_' in lowered or "'raw_" in lowered:
        return "[redacted]"
    sanitized = masked_value
    for marker, safe_url in sanitized_urls.items():
        sanitized = sanitized.replace(marker, safe_url)
    return sanitized


def _sanitize_diagnostic_value(value: object) -> object:
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for raw_key, item in value.items():
            key = str(raw_key or "")
            if _diagnostic_key_is_private(key):
                continue
            if key.casefold() == "error" and item:
                sanitized[key] = "Provider request failed."
                continue
            if isinstance(item, (bytes, bytearray, memoryview)):
                continue
            sanitized[key] = _sanitize_diagnostic_value(item)
        return sanitized
    if isinstance(value, (list, tuple)):
        return [
            _sanitize_diagnostic_value(item)
            for item in value
            if not isinstance(item, (bytes, bytearray, memoryview))
        ]
    if isinstance(value, (bytes, bytearray, memoryview)):
        return None
    if isinstance(value, str):
        return _sanitize_diagnostic_string(value)
    return value


def _provider_error_message(exc: Exception | object) -> str:
    error_kind = _classify_provider_error(exc)
    sanitized = _sanitize_diagnostic_string(str(exc or "").strip())
    if sanitized and sanitized != "[redacted]":
        return sanitized
    return f"Provider request failed ({error_kind})."


def _run_provider_call(
    name: str,
    provider_call,
    *,
    started_at: str,
    album: dict[str, object],
) -> tuple[list[dict[str, object]], dict[str, object]]:
    captured_events: list[dict[str, object]] = []

    def capture_log_event(config, logger, action, **fields):
        capture_provider_event(captured_events, action, fields)

    started = time.perf_counter()
    try:
        candidates = provider_call(capture_log_event) or []
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        return [], {
            "name": name,
            "status": "failed",
            "started_at": started_at,
            "finished_at": _now_iso8601_utc(),
            "duration_ms": duration_ms,
            "candidate_count": 0,
            "error": _provider_error_message(exc),
            "error_kind": _classify_provider_error(exc),
            "album": deepcopy(album),
            "debug_events": captured_events,
        }
    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    return candidates, {
        "name": name,
        "status": "completed",
        "started_at": started_at,
        "finished_at": _now_iso8601_utc(),
        "duration_ms": duration_ms,
        "candidate_count": _candidate_count(candidates),
        "album": deepcopy(album),
        "debug_events": captured_events,
    }


def _capture_service_events(
    service_candidates: list[dict[str, object]],
    captured_events: list[dict[str, object]],
    album: dict[str, object],
) -> list[dict[str, object]]:
    return service_events_to_provider_results(service_candidates, captured_events, album)


def _run_service_search_with_diagnostics(
    album_request: dict[str, object],
    *,
    user_agent: str,
    enabled_services: list[str] | None = None,
) -> tuple[list[dict[str, object]], dict[str, object], list[dict[str, object]]]:
    ensure_verbose_logging_level()
    captured_events: list[dict[str, object]] = []

    def capture_log_event(config, logger, action, **fields):
        service_name = str(fields.get("service") or "").strip()
        if service_name:
            capture_provider_event(captured_events, action, fields)

    started_at = _now_iso8601_utc()
    started = time.perf_counter()
    try:
        candidates, _manual_candidates = COVER_LOOKUP_PROVIDER_REGISTRY.search_music_service_matches(
            _provider_query(album_request, user_agent=user_agent),
            manual_urls=None,
            should_cancel=None,
            enabled_services=enabled_services,
            log_event=capture_log_event,
        )
    except Exception as exc:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        provider_result = {
            "name": "service_search",
            "status": "failed",
            "started_at": started_at,
            "finished_at": _now_iso8601_utc(),
            "duration_ms": duration_ms,
            "candidate_count": 0,
            "error": _provider_error_message(exc),
            "error_kind": _classify_provider_error(exc),
            "album": deepcopy(album_request),
        }
        return [], provider_result, []

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    provider_result = {
        "name": "service_search",
        "status": "completed",
        "started_at": started_at,
        "finished_at": _now_iso8601_utc(),
        "duration_ms": duration_ms,
        "candidate_count": _candidate_count(candidates),
        "album": deepcopy(album_request),
    }
    return candidates, provider_result, _capture_service_events(candidates, captured_events, album_request)


def _run_service_provider_with_diagnostics(
    provider_name: str,
    album_request: dict[str, object],
    *,
    user_agent: str,
) -> tuple[list[dict[str, object]], dict[str, object]]:
    candidates, service_result, _service_events = _run_service_search_with_diagnostics(
        album_request,
        user_agent=user_agent,
        enabled_services=[provider_name],
    )
    if str(service_result.get("status") or "") == "completed":
        matched_sources = sorted({
            str(candidate.get("source") or "").strip()
            for candidate in candidates
            if isinstance(candidate, dict) and str(candidate.get("source") or "").strip()
        })
        return candidates, {
            "name": provider_name,
            "status": "completed",
            "started_at": str(service_result.get("started_at") or ""),
            "finished_at": str(service_result.get("finished_at") or ""),
            "duration_ms": float(service_result.get("duration_ms") or 0.0),
            "candidate_count": _candidate_count(candidates),
            "album": deepcopy(album_request),
            "matched_sources": matched_sources,
        }
    return candidates, {
        "name": provider_name,
        "status": str(service_result.get("status") or "failed"),
        "started_at": str(service_result.get("started_at") or ""),
        "finished_at": str(service_result.get("finished_at") or ""),
        "duration_ms": float(service_result.get("duration_ms") or 0.0),
        "candidate_count": _candidate_count(candidates),
        "album": deepcopy(album_request),
        "error": str(service_result.get("error") or "Provider result was not captured."),
        "error_kind": str(service_result.get("error_kind") or "provider-error"),
    }


def _build_scenario_warnings(
    scenario_report: dict[str, object],
    *,
    provider_warning_ms: int,
    scenario_warning_ms: int,
) -> list[str]:
    warnings: list[str] = []
    provider_runs = scenario_report.get("provider_runs")
    if isinstance(provider_runs, list):
        warnings.extend(build_provider_warning_messages(
            scenario_label=scenario_report.get("label"),
            provider_runs=[item for item in provider_runs if isinstance(item, dict)],
            provider_warning_ms=provider_warning_ms,
        ))
    scenario_duration = float(scenario_report.get("duration_ms") or 0.0)
    if scenario_duration > scenario_warning_ms:
        warnings.append(
            f"{scenario_report.get('label')} total duration was {scenario_duration:.2f} ms, above the soft warning threshold of {scenario_warning_ms} ms."
        )
    return warnings


def _find_provider_result(provider_runs: list[dict[str, object]], expectation_key: str) -> dict[str, object] | None:
    if "." not in expectation_key:
        for provider in provider_runs:
            if str(provider.get("name") or "") == expectation_key:
                return provider
        return None
    parent_name, child_name = expectation_key.split(".", 1)
    for provider in provider_runs:
        if str(provider.get("name") or "") != parent_name:
            continue
        for nested in provider.get("provider_events") or []:
            if isinstance(nested, dict) and str(nested.get("name") or "") == child_name:
                return nested
    return None


def _evaluate_expectations(scenario_report: dict[str, object]) -> list[dict[str, object]]:
    expectations = scenario_report.get("expectations")
    provider_runs = scenario_report.get("provider_runs")
    if not isinstance(expectations, dict) or not isinstance(provider_runs, list):
        return []
    results: list[dict[str, object]] = []
    for key, raw_expectation in expectations.items():
        if not isinstance(raw_expectation, dict):
            continue
        provider_result = _find_provider_result([item for item in provider_runs if isinstance(item, dict)], str(key))
        minimum = _safe_int(raw_expectation.get("min_candidates"))
        actual_count = int(provider_result.get("candidate_count") or 0) if isinstance(provider_result, dict) else 0
        passed = provider_result is not None and (minimum is None or actual_count >= minimum)
        results.append({
            "key": str(key),
            "label": str(raw_expectation.get("label") or str(key)),
            "min_candidates": minimum,
            "actual_candidates": actual_count,
            "passed": passed,
            "status": str(provider_result.get("status") or "missing") if isinstance(provider_result, dict) else "missing",
        })
    return results


def _album_label(album: dict[str, object]) -> str:
    label = f"{album.get('artist') or ''} - {album.get('album') or ''}".strip()
    year = album.get("year")
    return f"{label} ({year})" if year else label


def _run_scenario(
    scenario: dict[str, object],
    *,
    user_agent: str,
) -> dict[str, object]:
    album = deepcopy(scenario["album"])
    service_provider = str(scenario.get("service_provider") or "").strip() or None
    enabled_providers = set(scenario.get("providers") or [])
    started = time.perf_counter()
    scenario_started_at = _now_iso8601_utc()
    scoring_duration_ms = 0.0

    def merge_candidates(
        existing: list[dict[str, object]],
        incoming: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        nonlocal scoring_duration_ms
        scoring_started = time.perf_counter()
        merged = merge_lookup_matches(existing, incoming)
        scoring_duration_ms += (time.perf_counter() - scoring_started) * 1000
        return merged

    provider_runs: list[dict[str, object]] = []
    result_summary = {
        "service_candidate_count": 0,
        "bandcamp_candidate_count": 0,
        "discogs_candidate_count": 0,
        "cover_art_archive_candidate_count": 0,
        "artist_website_candidate_count": 0,
        "combined_candidate_count": 0,
    }

    if service_provider:
        service_candidates, service_result = _run_service_provider_with_diagnostics(
            service_provider,
            album,
            user_agent=user_agent,
        )
        provider_runs.append(service_result)
        result_summary["service_candidate_count"] = _candidate_count(service_candidates)
    elif not enabled_providers or "service_search" in enabled_providers:
        service_candidates, service_result, service_events = _run_service_search_with_diagnostics(album, user_agent=user_agent)
        service_result["provider_events"] = service_events
        provider_runs.append(service_result)
        result_summary["service_candidate_count"] = _candidate_count(service_candidates)
    else:
        service_candidates = []

    if not service_provider and (not enabled_providers or "bandcamp" in enabled_providers):
        bandcamp_candidates, bandcamp_result = _run_provider_call(
            "bandcamp",
            lambda log_event: COVER_LOOKUP_PROVIDER_REGISTRY.search_bandcamp_matches(
                _provider_query(album, user_agent=user_agent),
                log_event=log_event,
            ),
            started_at=_now_iso8601_utc(),
            album=album,
        )
        provider_runs.append(bandcamp_result)
        result_summary["bandcamp_candidate_count"] = _candidate_count(bandcamp_candidates)
    else:
        bandcamp_candidates = []

    if not service_provider and (not enabled_providers or "discogs" in enabled_providers or "cover_art_archive" in enabled_providers):
        future_map = {}
        discogs_candidates: list[dict[str, object]] = []
        archive_candidates: list[dict[str, object]] = []
        with ThreadPoolExecutor(max_workers=2) as executor:
            if not enabled_providers or "discogs" in enabled_providers:
                future_map[executor.submit(
                    _run_provider_call,
                    "discogs",
                    lambda log_event: COVER_LOOKUP_PROVIDER_REGISTRY.search_discogs_and_cover_art_archive_matches(
                        _provider_query(album, user_agent=user_agent),
                        include_discogs=True,
                        include_cover_art_archive=False,
                        log_event=log_event,
                    )[0],
                    started_at=_now_iso8601_utc(),
                    album=album,
                )] = "discogs"
            if not enabled_providers or "cover_art_archive" in enabled_providers:
                future_map[executor.submit(
                    _run_provider_call,
                    "cover_art_archive",
                    lambda log_event: COVER_LOOKUP_PROVIDER_REGISTRY.search_discogs_and_cover_art_archive_matches(
                        _provider_query(album, user_agent=user_agent),
                        include_discogs=False,
                        include_cover_art_archive=True,
                        log_event=log_event,
                    )[1],
                    started_at=_now_iso8601_utc(),
                    album=album,
                )] = "cover_art_archive"
            for future in as_completed(list(future_map.keys())):
                provider_name = future_map[future]
                candidates, provider_result = future.result()
                provider_runs.append(provider_result)
                if provider_name == "discogs":
                    discogs_candidates = candidates
                    result_summary["discogs_candidate_count"] = _candidate_count(candidates)
                else:
                    archive_candidates = candidates
        result_summary["cover_art_archive_candidate_count"] = len(archive_candidates)
    else:
        discogs_candidates = []
        archive_candidates = []

    combined_candidates = merge_candidates(service_candidates, bandcamp_candidates)
    combined_candidates = merge_candidates(combined_candidates, discogs_candidates)
    combined_candidates = merge_candidates(combined_candidates, archive_candidates)

    if not service_provider and (not enabled_providers or "artist_website" in enabled_providers):
        if combined_candidates and not enabled_providers:
            artist_website_candidates: list[dict[str, object]] = []
            artist_website_result = {
                "name": "artist_website",
                "status": "skipped",
                "started_at": _now_iso8601_utc(),
                "finished_at": _now_iso8601_utc(),
                "duration_ms": 0.0,
                "candidate_count": 0,
                "skip_reason": "combined_candidates_already_found",
                "album": deepcopy(album),
            }
        else:
            artist_website_candidates, artist_website_result = _run_provider_call(
                "artist_website",
                lambda log_event: COVER_LOOKUP_PROVIDER_REGISTRY.search_artist_website_matches(
                    _provider_query(album, user_agent=user_agent),
                    log_event=log_event,
                ),
                started_at=_now_iso8601_utc(),
                album=album,
            )
            combined_candidates = merge_candidates(combined_candidates, artist_website_candidates)
        provider_runs.append(artist_website_result)
        result_summary["artist_website_candidate_count"] = _candidate_count(artist_website_candidates)

    result_summary["combined_candidate_count"] = _candidate_count(combined_candidates)
    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    phase_timings_ms = _phase_timing_shape(
        discovery=max(0.0, duration_ms - scoring_duration_ms),
        scoring=scoring_duration_ms,
    )
    phase_counts = _phase_count_shape(
        discovery=sum(
            int(provider.get("candidate_count") or 0)
            for provider in provider_runs
            if isinstance(provider, dict)
        ),
        scoring=result_summary["combined_candidate_count"],
    )
    return {
        "id": scenario["id"],
        "label": scenario["label"],
        "album": album,
        "expectations": deepcopy(scenario.get("expectations") if isinstance(scenario.get("expectations"), dict) else {}),
        "started_at": scenario_started_at,
        "finished_at": _now_iso8601_utc(),
        "duration_ms": duration_ms,
        "phase_timings_ms": phase_timings_ms,
        "phase_counts": phase_counts,
        "provider_runs": provider_runs,
        "result_summary": result_summary,
    }


def run_cover_lookup_diagnostic(
    scenarios: list[dict[str, object]] | None = None,
    *,
    user_agent: str,
    provider_warning_ms: int = DEFAULT_PROVIDER_WARNING_MS,
    scenario_warning_ms: int = DEFAULT_SCENARIO_WARNING_MS,
    total_warning_ms: int = DEFAULT_TOTAL_WARNING_MS,
    parallel: bool = True,
) -> dict[str, object]:
    ensure_verbose_logging_level()
    normalized_scenarios = _normalize_scenarios(scenarios)
    total_started = time.perf_counter()
    if parallel and len(normalized_scenarios) > 1:
        scenario_runs: list[dict[str, object] | None] = [None] * len(normalized_scenarios)
        with ThreadPoolExecutor(max_workers=len(normalized_scenarios)) as executor:
            future_map = {
                executor.submit(_run_scenario, scenario, user_agent=user_agent): index
                for index, scenario in enumerate(normalized_scenarios)
            }
            for future in as_completed(future_map):
                scenario_runs[future_map[future]] = future.result()
        scenario_runs = [scenario_run for scenario_run in scenario_runs if isinstance(scenario_run, dict)]
    else:
        scenario_runs = [_run_scenario(scenario, user_agent=user_agent) for scenario in normalized_scenarios]
    for scenario_run in scenario_runs:
        scenario_run["expectation_results"] = _evaluate_expectations(scenario_run)
    total_duration_ms = round((time.perf_counter() - total_started) * 1000, 2)

    warnings: list[str] = []
    for scenario_run in scenario_runs:
        warnings.extend(_build_scenario_warnings(
            scenario_run,
            provider_warning_ms=int(provider_warning_ms),
            scenario_warning_ms=int(scenario_warning_ms),
        ))
        for expectation_result in scenario_run.get("expectation_results") or []:
            if not isinstance(expectation_result, dict):
                continue
            if expectation_result.get("passed"):
                continue
            warnings.append(
                f"{scenario_run.get('label')}: expectation {expectation_result.get('key')} failed; "
                f"expected at least {int(expectation_result.get('min_candidates') or 0)} candidate(s), "
                f"got {int(expectation_result.get('actual_candidates') or 0)} with status {expectation_result.get('status') or 'missing'}."
            )
    if total_duration_ms > total_warning_ms:
        warnings.append(
            f"all diagnostic scenarios took {total_duration_ms:.2f} ms, above the soft warning threshold of {total_warning_ms} ms."
        )

    report = {
        "generated_at": _now_iso8601_utc(),
        "provider_warning_ms": int(provider_warning_ms),
        "scenario_warning_ms": int(scenario_warning_ms),
        "total_warning_ms": int(total_warning_ms),
        "total_duration_ms": total_duration_ms,
        "scenario_runs": scenario_runs,
        "warnings": warnings,
    }
    sanitized = _sanitize_diagnostic_value(report)
    return sanitized if isinstance(sanitized, dict) else {}


def format_cover_lookup_diagnostic_report(report: dict[str, object]) -> str:
    lines = [
        "Cover Lookup Diagnostic Report",
        f"Generated: {report.get('generated_at') or ''}",
        f"Total duration: {float(report.get('total_duration_ms') or 0.0):.2f} ms",
        "",
    ]
    for scenario in report.get("scenario_runs") or []:
        if not isinstance(scenario, dict):
            continue
        lines.append(f"{scenario.get('label')}: {_album_label(scenario.get('album') if isinstance(scenario.get('album'), dict) else {})}")
        lines.append(f"Scenario duration: {float(scenario.get('duration_ms') or 0.0):.2f} ms")
        phase_timings = scenario.get("phase_timings_ms")
        phase_counts = scenario.get("phase_counts")
        if isinstance(phase_timings, dict) and isinstance(phase_counts, dict):
            lines.append("Phase timings:")
            for phase_name in _PHASE_NAMES:
                item_count = int(phase_counts.get(phase_name) or 0)
                lines.append(
                    f"- {phase_name}: {float(phase_timings.get(phase_name) or 0.0):.2f} ms, "
                    f"{item_count} {'item' if item_count == 1 else 'items'}"
                )
        lines.append("Provider timings:")
        for provider in scenario.get("provider_runs") or []:
            if not isinstance(provider, dict):
                continue
            line = (
                f"- {provider.get('name')}: {provider.get('status')}, "
                f"{float(provider.get('duration_ms') or 0.0):.2f} ms, "
                f"{int(provider.get('candidate_count') or 0)} candidates"
            )
            if provider.get("skip_reason"):
                line += f" ({provider.get('skip_reason')})"
            if provider.get("error"):
                line += f" ({provider.get('error')})"
            lines.append(line)
            debug_events = provider.get("debug_events")
            if isinstance(debug_events, list) and debug_events:
                lines.append(f"  debug events: {len(debug_events)}")
            for nested in provider.get("provider_events") or []:
                if not isinstance(nested, dict):
                    continue
                nested_line = (
                    f"  - {nested.get('name')}: {nested.get('status')}, "
                    f"{float(nested.get('duration_ms') or 0.0):.2f} ms, "
                    f"{int(nested.get('candidate_count') or 0)} candidates"
                )
                lines.append(nested_line)
        expectation_results = scenario.get("expectation_results")
        if isinstance(expectation_results, list) and expectation_results:
            lines.append("Expectation checks:")
            for expectation_result in expectation_results:
                if not isinstance(expectation_result, dict):
                    continue
                lines.append(
                    f"- {expectation_result.get('key')}: "
                    f"{'PASS' if expectation_result.get('passed') else 'FAIL'} "
                    f"(expected >= {int(expectation_result.get('min_candidates') or 0)}, "
                    f"actual {int(expectation_result.get('actual_candidates') or 0)}, "
                    f"status {expectation_result.get('status') or 'missing'})"
                )
        lines.append("")
    lines.append("Warnings:")
    for warning in report.get("warnings") or []:
        lines.append(f"- {warning}")
    if not report.get("warnings"):
        lines.append("- None")
    return "\n".join(lines)


def render_cover_lookup_diagnostic_html(report: dict[str, object]) -> str:
    scenarios = [scenario for scenario in (report.get("scenario_runs") or []) if isinstance(scenario, dict)]
    max_duration = max(
        [float(report.get("total_duration_ms") or 0.0)]
        + [
            float(provider.get("duration_ms") or 0.0)
            for scenario in scenarios
            for provider in (scenario.get("provider_runs") or [])
            if isinstance(provider, dict)
        ]
        + [
            float(nested.get("duration_ms") or 0.0)
            for scenario in scenarios
            for provider in (scenario.get("provider_runs") or [])
            if isinstance(provider, dict)
            for nested in (provider.get("provider_events") or [])
            if isinstance(nested, dict)
        ]
        + [
            float(phase_timings.get(phase_name) or 0.0)
            for scenario in scenarios
            for phase_timings in [scenario.get("phase_timings_ms")]
            if isinstance(phase_timings, dict)
            for phase_name in _PHASE_NAMES
        ]
        + [1.0]
    )

    def width_for(value: object) -> str:
        duration = float(value or 0.0)
        return f"{max(2.0, (duration / max_duration) * 100.0):.2f}%"

    summary_cards = (
        f'<div class="card"><div class="eyebrow">Generated</div><div class="value">{_escape(report.get("generated_at"))}</div></div>'
        f'<div class="card"><div class="eyebrow">Total Duration</div><div class="value">{float(report.get("total_duration_ms") or 0.0):.2f} ms</div></div>'
        f'<div class="card"><div class="eyebrow">Scenario Count</div><div class="value">{len(scenarios)}</div></div>'
        f'<div class="card"><div class="eyebrow">Warnings</div><div class="value">{len(report.get("warnings") or [])}</div></div>'
    )

    scenario_markup = []
    for scenario in scenarios:
        phase_timings = scenario.get("phase_timings_ms") if isinstance(scenario.get("phase_timings_ms"), dict) else {}
        phase_counts = scenario.get("phase_counts") if isinstance(scenario.get("phase_counts"), dict) else {}
        phase_rows = "".join(
            '<tr>'
            f'<td>{_escape(phase_name)}</td>'
            f'<td>{float(phase_timings.get(phase_name) or 0.0):.2f} ms</td>'
            f'<td>{int(phase_counts.get(phase_name) or 0)}</td>'
            '<td><div class="bar-track"><div class="bar-fill" style="width:'
            f'{width_for(phase_timings.get(phase_name))}"></div></div></td>'
            '</tr>'
            for phase_name in _PHASE_NAMES
        )
        provider_rows = []
        for provider in scenario.get("provider_runs") or []:
            if not isinstance(provider, dict):
                continue
            nested_rows = []
            for nested in provider.get("provider_events") or []:
                if not isinstance(nested, dict):
                    continue
                nested_rows.append(
                    '<tr class="nested-row">'
                    f'<td class="nested-name">{_escape(provider.get("name"))} / {_escape(nested.get("name"))}</td>'
                    f'<td>{_escape(nested.get("status"))}</td>'
                    f'<td>{float(nested.get("duration_ms") or 0.0):.2f} ms</td>'
                    f'<td>{int(nested.get("candidate_count") or 0)}</td>'
                    '<td><div class="bar-track"><div class="bar-fill nested" style="width:'
                    f'{width_for(nested.get("duration_ms"))}"></div></div></td>'
                    '</tr>'
                )
            debug_count = len(provider.get("debug_events")) if isinstance(provider.get("debug_events"), list) else 0
            provider_rows.append(
                '<tr>'
                f'<td>{_escape(provider.get("name"))}</td>'
                f'<td><span class="pill status-{_escape(provider.get("status"))}">{_escape(provider.get("status"))}</span></td>'
                f'<td>{float(provider.get("duration_ms") or 0.0):.2f} ms</td>'
                f'<td>{int(provider.get("candidate_count") or 0)}<div class="muted">{debug_count} debug events</div></td>'
                '<td><div class="bar-track"><div class="bar-fill" style="width:'
                f'{width_for(provider.get("duration_ms"))}"></div></div></td>'
                '</tr>'
                + ''.join(nested_rows)
            )
        expectation_rows = []
        for expectation_result in scenario.get("expectation_results") or []:
            if not isinstance(expectation_result, dict):
                continue
            expectation_rows.append(
                '<tr>'
                f'<td>{_escape(expectation_result.get("key"))}</td>'
                f'<td><span class="pill status-{"completed" if expectation_result.get("passed") else "failed"}">'
                f'{"PASS" if expectation_result.get("passed") else "FAIL"}</span></td>'
                f'<td>{int(expectation_result.get("min_candidates") or 0)}</td>'
                f'<td>{int(expectation_result.get("actual_candidates") or 0)}</td>'
                f'<td>{_escape(expectation_result.get("status"))}</td>'
                '</tr>'
            )
        expectation_table_rows = "".join(expectation_rows) or '<tr><td colspan="5">No hardcoded expectations for this scenario.</td></tr>'
        warnings_markup = ''.join(f'<li>{_escape(warning)}</li>' for warning in _build_scenario_warnings(
            scenario,
            provider_warning_ms=int(report.get("provider_warning_ms") or DEFAULT_PROVIDER_WARNING_MS),
            scenario_warning_ms=int(report.get("scenario_warning_ms") or DEFAULT_SCENARIO_WARNING_MS),
        )) or '<li>None</li>'
        scenario_markup.append(
            '<section class="panel">'
            f'<div class="panel-header"><div><div class="eyebrow">{_escape(scenario.get("label"))}</div>'
            f'<h2>{_escape(_album_label(scenario.get("album") if isinstance(scenario.get("album"), dict) else {}))}</h2>'
            f'<p>Scenario duration: {float(scenario.get("duration_ms") or 0.0):.2f} ms</p></div></div>'
            '<table class="table">'
            '<thead><tr><th>Provider</th><th>Status</th><th>Duration</th><th>Candidates</th><th>Relative Time</th></tr></thead>'
            f'<tbody>{"".join(provider_rows)}</tbody>'
            '</table>'
            '<h3>Runtime Phases</h3>'
            '<table class="table">'
            '<thead><tr><th>Phase</th><th>Duration</th><th>Items</th><th>Relative Time</th></tr></thead>'
            f'<tbody>{phase_rows}</tbody>'
            '</table>'
            '<div class="subgrid">'
            '<div class="panel inset">'
            '<h3>Result Summary</h3>'
            f'<pre>{_escape(json.dumps(scenario.get("result_summary") or {}, indent=2))}</pre>'
            '</div>'
            '<div class="panel inset">'
            '<h3>Expectation Checks</h3>'
            + (
                '<table class="table">'
                '<thead><tr><th>Expectation</th><th>Result</th><th>Expected</th><th>Actual</th><th>Status</th></tr></thead>'
                f'<tbody>{expectation_table_rows}</tbody>'
                '</table>'
            )
            + '</div>'
            '<div class="panel inset">'
            '<h3>Warnings</h3>'
            f'<ul>{warnings_markup}</ul>'
            '</div>'
            '</div>'
            '</section>'
        )

    overall_warnings = ''.join(f'<li>{_escape(warning)}</li>' for warning in (report.get("warnings") or [])) or '<li>None</li>'
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cover Lookup Provider Diagnostic</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f6f1eb;
      --panel: rgba(255,255,255,0.92);
      --panel-strong: #fffaf5;
      --ink: #1f1f1f;
      --muted: #6d625a;
      --accent: #15616d;
      --accent-2: #ff7d00;
      --accent-3: #9c6644;
      --line: rgba(31,31,31,0.12);
      --shadow: 0 28px 60px rgba(31,31,31,0.12);
      --radius: 22px;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "Segoe UI", Inter, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(255,125,0,0.12), transparent 28%),
        radial-gradient(circle at top right, rgba(21,97,109,0.16), transparent 32%),
        linear-gradient(180deg, #f7f2ec 0%, #efe7de 100%);
    }}
    .shell {{ max-width: 1320px; margin: 0 auto; padding: 40px 24px 56px; }}
    .hero {{
      background: linear-gradient(135deg, rgba(255,250,245,0.96), rgba(255,255,255,0.88));
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      padding: 28px 30px;
    }}
    .eyebrow {{
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-size: 12px;
      color: var(--muted);
      font-weight: 700;
    }}
    h1, h2, h3, p {{ margin: 0; }}
    h1 {{ font-size: 34px; margin-top: 8px; }}
    .hero p {{ margin-top: 10px; color: var(--muted); max-width: 900px; line-height: 1.5; }}
    .cards {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-top: 24px;
    }}
    .card, .panel {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }}
    .card {{ padding: 18px 20px; }}
    .card .value {{ margin-top: 8px; font-size: 28px; font-weight: 700; }}
    .stack {{ display: grid; gap: 18px; margin-top: 24px; }}
    .panel {{ padding: 22px; }}
    .panel-header {{ display: flex; justify-content: space-between; gap: 20px; margin-bottom: 16px; }}
    .panel-header p {{ margin-top: 8px; color: var(--muted); }}
    .table {{ width: 100%; border-collapse: collapse; }}
    .table th, .table td {{ text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }}
    .table th {{ color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; }}
    .nested-row td {{ font-size: 13px; color: #4b443f; background: rgba(246,241,235,0.7); }}
    .nested-name {{ padding-left: 28px !important; }}
    .pill {{
      display: inline-flex;
      align-items: center;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      background: rgba(21,97,109,0.12);
      color: var(--accent);
    }}
    .status-failed {{ background: rgba(186,24,27,0.12); color: #ba181b; }}
    .status-completed {{ background: rgba(11,110,79,0.12); color: #0b6e4f; }}
    .status-skipped {{ background: rgba(124,92,59,0.12); color: #7c5c3b; }}
    .bar-track {{
      width: 100%;
      min-width: 180px;
      height: 12px;
      border-radius: 999px;
      background: rgba(31,31,31,0.08);
      overflow: hidden;
    }}
    .bar-fill {{
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
    }}
    .bar-fill.nested {{ background: linear-gradient(90deg, var(--accent-3), var(--accent)); }}
    .subgrid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
      margin-top: 18px;
    }}
    .panel.inset {{
      background: var(--panel-strong);
      box-shadow: none;
      padding: 18px;
    }}
    pre {{
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      color: #312a25;
    }}
    ul {{ margin: 0; padding-left: 20px; }}
    li + li {{ margin-top: 8px; }}
    @media (max-width: 760px) {{
      .shell {{ padding: 20px 14px 36px; }}
      .hero {{ padding: 22px; }}
      h1 {{ font-size: 28px; }}
      .table th:nth-child(5), .table td:nth-child(5) {{ display: none; }}
      .bar-track {{ min-width: 120px; }}
    }}
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">Provider Diagnostic</div>
      <h1>Cover Lookup Provider Timing Report</h1>
      <p>Standalone real-provider diagnostic styled after the Playwright performance reports. This run executes provider-specific backend checks in parallel against isolated temp data so each provider can be inspected independently without touching the app's real data or caches.</p>
      <div class="cards">{summary_cards}</div>
    </section>
    <section class="stack">
      {''.join(scenario_markup)}
      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">Global Warnings</div>
            <h2>Cross-Scenario Findings</h2>
          </div>
        </div>
        <ul>{overall_warnings}</ul>
      </section>
    </section>
  </main>
</body>
</html>"""
