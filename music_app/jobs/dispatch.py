"""Closed dispatch registry for durable background jobs."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from typing import Any

from music_app.services.jobs.models import JobKind
from music_app.services.jobs.registry import JOB_POLICIES, policy_for


JobHandler = Callable[..., Any]


def _kind_key(kind: str | JobKind) -> str:
    """Normalize a typed or persisted kind through the closed policy registry."""

    policy_for(kind)
    return kind.value if isinstance(kind, JobKind) else kind


class JobHandlerRegistry:
    """Map registered durable job kinds to trusted in-process handlers."""

    def __init__(self) -> None:
        self._handlers: dict[str, JobHandler] = {}

    def register(self, kind: str | JobKind, handler: JobHandler) -> None:
        """Register one callable for an allowed kind exactly once."""

        key = _kind_key(kind)
        if not callable(handler):
            raise TypeError("job handler must be callable")
        if key in self._handlers:
            raise ValueError("job handler is already registered")
        self._handlers[key] = handler

    def resolve(self, kind: str | JobKind) -> JobHandler:
        """Return a registered handler, failing closed for unknown or missing kinds."""

        key = _kind_key(kind)
        try:
            return self._handlers[key]
        except KeyError as exc:
            raise ValueError("job handler is not registered") from exc

    @property
    def registered_kinds(self) -> tuple[str, ...]:
        """Return the closed set this worker can safely claim."""

        return tuple(sorted(self._handlers))

    @property
    def fingerprint(self) -> str:
        """Return a deterministic fingerprint of the registered dispatch contract."""

        contract = []
        for kind in sorted(self._handlers):
            policy = JOB_POLICIES[kind]
            contract.append(
                {
                    "allowed_capability_keys": sorted(policy.allowed_capability_keys),
                    "kind": kind,
                    "max_attempts": policy.max_attempts,
                    "public_lifecycle": policy.public_lifecycle,
                    "recovery_policy": policy.recovery_policy.value,
                    "server_owned": policy.server_owned,
                }
            )
        encoded = json.dumps(
            {"contract_version": 1, "handlers": contract},
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        return hashlib.sha256(encoded).hexdigest()


__all__ = ["JobHandler", "JobHandlerRegistry"]
