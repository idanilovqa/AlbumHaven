from __future__ import annotations

import time
from copy import deepcopy
from typing import Callable


PROVIDER_STARTED_ACTION = "Cover search provider started"
PROVIDER_COMPLETED_ACTION = "Cover search provider completed"
PROVIDER_FAILED_ACTION = "Cover search provider failed"
PROVIDER_SKIPPED_ACTION = "Cover search provider skipped"


def now_iso8601_utc() -> str:
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


def classify_provider_error(exc: Exception | object) -> str:
    message = str(exc or "").strip()
    lowered = message.lower()
    if "winerror 10013" in lowered or "forbidden by its access permissions" in lowered:
        return "network-blocked"
    if "timed out" in lowered or "timeout" in lowered:
        return "timeout"
    if "name or service not known" in lowered or "temporary failure in name resolution" in lowered:
        return "dns-failure"
    if "401" in lowered or "403" in lowered:
        return "authorization-failure"
    return "provider-error"


def base_provider_result(name: str, *, started_at: str, album: dict[str, object]) -> dict[str, object]:
    return {
        "name": name,
        "status": "not-run",
        "started_at": started_at,
        "finished_at": started_at,
        "duration_ms": 0.0,
        "candidate_count": 0,
        "album": deepcopy(album),
    }


def capture_provider_event(
    captured_events: list[dict[str, object]],
    action: str,
    fields: dict[str, object],
    *,
    captured_at: str | None = None,
) -> None:
    captured_events.append({
        "action": action,
        "captured_at": captured_at or now_iso8601_utc(),
        **deepcopy(fields),
    })


def service_events_to_provider_results(
    service_candidates: list[dict[str, object]],
    captured_events: list[dict[str, object]],
    album: dict[str, object],
) -> list[dict[str, object]]:
    results: dict[str, dict[str, object]] = {}
    for event in captured_events:
        service_name = str(event.get("service") or "").strip()
        if not service_name:
            continue
        entry = results.setdefault(service_name, base_provider_result(service_name, started_at="", album=album))
        action = str(event.get("action") or "")
        if action == PROVIDER_STARTED_ACTION:
            entry["status"] = "running"
            entry["started_at"] = str(event.get("captured_at") or "")
        elif action == PROVIDER_COMPLETED_ACTION:
            entry["status"] = "completed"
            entry["finished_at"] = str(event.get("captured_at") or "")
            entry["duration_ms"] = float(event.get("elapsed_ms") or 0.0)
            entry["candidate_count"] = int(event.get("candidate_count") or 0)
            acceptable_count = _safe_int(event.get("acceptable_candidate_count"))
            if acceptable_count is not None:
                entry["acceptable_candidate_count"] = acceptable_count
        elif action == PROVIDER_FAILED_ACTION:
            entry["status"] = "failed"
            entry["finished_at"] = str(event.get("captured_at") or "")
            entry["duration_ms"] = float(event.get("elapsed_ms") or 0.0)
            error = event.get("error")
            if error:
                entry["error"] = str(error)
                entry["error_kind"] = str(event.get("error_kind") or classify_provider_error(error))
        elif action == PROVIDER_SKIPPED_ACTION:
            entry["status"] = "skipped"
            entry["started_at"] = str(event.get("captured_at") or "")
            entry["finished_at"] = str(event.get("captured_at") or "")
            entry["skip_reason"] = str(event.get("reason") or "")
    for entry in results.values():
        if not entry.get("started_at"):
            entry["started_at"] = entry.get("finished_at") or ""
    acceptable_sources = {
        str(candidate.get("source") or "").strip()
        for candidate in service_candidates
        if isinstance(candidate, dict)
    }
    for service_name, entry in results.items():
        if service_name in acceptable_sources:
            entry.setdefault("matched_sources", [service_name])
    return [results[key] for key in sorted(results.keys())]


def build_provider_warning_messages(
    *,
    scenario_label: object,
    provider_runs: list[dict[str, object]],
    provider_warning_ms: int,
) -> list[str]:
    warnings: list[str] = []
    for provider in provider_runs:
        if not isinstance(provider, dict):
            continue
        provider_name = str(provider.get("name") or "provider")
        provider_status = str(provider.get("status") or "")
        provider_duration = float(provider.get("duration_ms") or 0.0)
        provider_label = f"{scenario_label}: {provider_name}"
        if provider_status == "failed":
            error_kind = str(provider.get("error_kind") or "provider-error")
            warnings.append(f"{provider_label} failed ({error_kind}): {provider.get('error') or 'unknown error'}")
        elif provider_status == "completed" and provider_duration > provider_warning_ms:
            warnings.append(
                f"{provider_label} took {provider_duration:.2f} ms, above the soft warning threshold of {provider_warning_ms} ms."
            )
        nested = provider.get("provider_events")
        if not isinstance(nested, list):
            continue
        for nested_provider in nested:
            if not isinstance(nested_provider, dict):
                continue
            nested_name = str(nested_provider.get("name") or "provider")
            nested_status = str(nested_provider.get("status") or "")
            nested_duration = float(nested_provider.get("duration_ms") or 0.0)
            nested_label = f"{scenario_label}: {provider_name}/{nested_name}"
            if nested_status == "failed":
                error_kind = str(nested_provider.get("error_kind") or "provider-error")
                warnings.append(f"{nested_label} failed ({error_kind}).")
            elif nested_status == "completed" and nested_duration > provider_warning_ms:
                warnings.append(
                    f"{nested_label} took {nested_duration:.2f} ms, above the soft warning threshold of {provider_warning_ms} ms."
                )
    return warnings


def _base_provider_fields(
    *,
    service: str,
    artist: object,
    album: object,
    year: object,
    elapsed_ms: float | None = None,
) -> dict[str, object]:
    fields: dict[str, object] = {
        "service": service,
        "artist": artist,
        "album": album,
        "year": year,
    }
    if elapsed_ms is not None:
        fields["elapsed_ms"] = elapsed_ms
    return fields


def log_provider_started(
    log_app_event: Callable[..., object],
    config: dict[str, object],
    logger: object,
    *,
    service: str,
    artist: object,
    album: object,
    year: object,
) -> None:
    log_app_event(
        config,
        logger,
        PROVIDER_STARTED_ACTION,
        level="info",
        **_base_provider_fields(service=service, artist=artist, album=album, year=year),
    )


def log_provider_completed(
    log_app_event: Callable[..., object],
    config: dict[str, object],
    logger: object,
    *,
    service: str,
    artist: object,
    album: object,
    year: object,
    candidate_count: int,
    acceptable_candidate_count: int,
    elapsed_ms: float,
) -> None:
    log_app_event(
        config,
        logger,
        PROVIDER_COMPLETED_ACTION,
        level="info",
        **_base_provider_fields(service=service, artist=artist, album=album, year=year, elapsed_ms=elapsed_ms),
        candidate_count=candidate_count,
        acceptable_candidate_count=acceptable_candidate_count,
    )


def log_provider_failed(
    log_app_event: Callable[..., object],
    config: dict[str, object],
    logger: object,
    *,
    service: str,
    artist: object,
    album: object,
    year: object,
    elapsed_ms: float,
    exc: Exception | object | None = None,
) -> None:
    fields = _base_provider_fields(service=service, artist=artist, album=album, year=year, elapsed_ms=elapsed_ms)
    if exc is not None:
        fields["error"] = str(exc)
        fields["error_kind"] = classify_provider_error(exc)
    log_app_event(
        config,
        logger,
        PROVIDER_FAILED_ACTION,
        level="info",
        **fields,
    )


def log_provider_skipped(
    log_app_event: Callable[..., object],
    config: dict[str, object],
    logger: object,
    *,
    service: str,
    artist: object,
    album: object,
    year: object,
    reason: str,
) -> None:
    log_app_event(
        config,
        logger,
        PROVIDER_SKIPPED_ACTION,
        level="info",
        **_base_provider_fields(service=service, artist=artist, album=album, year=year),
        reason=reason,
    )
