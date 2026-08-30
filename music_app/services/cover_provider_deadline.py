from __future__ import annotations

from collections.abc import Callable, Mapping
import time


DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS = 120.0


def cover_lookup_provider_deadline_seconds(config: object) -> float:
    raw_value = (
        config.get("COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS")
        if isinstance(config, Mapping)
        else getattr(config, "COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS", None)
    )
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        value = DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS
    if value <= 0:
        return DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS
    return value


def cover_lookup_provider_deadline_at(
    config: object,
    *,
    now: Callable[[], float] = time.perf_counter,
) -> float:
    return now() + cover_lookup_provider_deadline_seconds(config)


def cover_lookup_provider_deadline_reached(
    deadline_at: float,
    *,
    now: Callable[[], float] = time.perf_counter,
) -> bool:
    return now() >= deadline_at


def compose_provider_stop_predicate(
    should_cancel: Callable[[], bool] | None,
    deadline_at: float,
    *,
    now: Callable[[], float] = time.perf_counter,
) -> Callable[[], bool]:
    return lambda: (
        (callable(should_cancel) and should_cancel())
        or now() >= deadline_at
    )
