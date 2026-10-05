from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
import time


DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS = 120.0


class AutomaticCoverDeadlineExceeded(TimeoutError):
    """An automatic cover provider exhausted its bounded lookup time."""


class AutomaticCoverSearchFailed(RuntimeError):
    """A transient automatic lookup failure that must not be negative-cached.

    The optional fields are deliberately limited to sanitized recovery metadata;
    callers must not attach response bodies, URLs, credentials, or local paths.
    """

    def __init__(
        self,
        message: str | None = None,
        *,
        category: str | None = None,
        provider: str | None = None,
        http_status: int | None = None,
        retry_at: float | None = None,
    ) -> None:
        super().__init__(message or "automatic cover provider failed")
        self.category = category
        self.provider = provider
        self.http_status = http_status
        self.retry_at = retry_at


_AUTOMATIC_COVER_DEADLINE: ContextVar[float | None] = ContextVar(
    "automatic_cover_deadline", default=None,
)


@contextmanager
def automatic_cover_budget(seconds: float):
    existing = _AUTOMATIC_COVER_DEADLINE.get()
    deadline = time.perf_counter() + max(0.0, seconds)
    if existing is not None:
        deadline = min(existing, deadline)
    token = _AUTOMATIC_COVER_DEADLINE.set(deadline)
    try:
        yield
    finally:
        _AUTOMATIC_COVER_DEADLINE.reset(token)


def remaining_automatic_cover_seconds(default: float) -> float:
    deadline = _AUTOMATIC_COVER_DEADLINE.get()
    if deadline is None:
        return default
    remaining = deadline - time.perf_counter()
    if remaining <= 0:
        raise AutomaticCoverDeadlineExceeded()
    return min(default, remaining)


def automatic_cover_budget_expired() -> bool:
    deadline = _AUTOMATIC_COVER_DEADLINE.get()
    return deadline is not None and time.perf_counter() >= deadline


def automatic_cover_budget_active() -> bool:
    return _AUTOMATIC_COVER_DEADLINE.get() is not None


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
