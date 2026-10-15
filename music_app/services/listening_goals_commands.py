"""Pure, exact-shape commands for the account-owned Goals repository.

Only client-controlled concurrency and selection inputs belong here. Account,
session, current state, evidence authority and event times are resolved by the
repository. No calendar arithmetic or persistence is duplicated in this module.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from types import MappingProxyType
from typing import Mapping
from uuid import UUID
from zoneinfo import available_timezones

from music_app.services.listening_goals import GOAL_PERIODS, GoalsDomainError, _zone


MAX_REVISION = 9_223_372_036_854_775_807
_REVISION = re.compile(r"[1-9][0-9]{0,18}")
_EVIDENCE_VERSION = re.compile(r"[0-9a-f]{64}")
_COMMON_FIELDS = frozenset({"request_key", "revision", "period", "timezone_name"})
_COMMAND_FIELDS = {
    "add": _COMMON_FIELDS | {"evidence_ref", "evidence_version"},
    "reset": _COMMON_FIELDS | {"expected_cycle_id"},
}


class GoalsError(ValueError):
    """A public Goals error whose code and HTTP status are safe to expose."""

    def __init__(self, code: str, status: int = 400):
        self.code = code
        self.status = status
        super().__init__(code)


def uuid_ref(value) -> str:
    """Require an already-canonical, lowercase, nonnil UUID string."""
    if type(value) is not str or len(value) != 36:
        raise GoalsError("invalid_command")
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise GoalsError("invalid_command") from error
    if parsed.int == 0 or str(parsed) != value:
        raise GoalsError("invalid_command")
    return value


def revision(value) -> str:
    """Require canonical positive decimal text that fits PostgreSQL bigint."""
    if type(value) is not str or _REVISION.fullmatch(value) is None:
        raise GoalsError("invalid_command")
    if int(value) > MAX_REVISION:
        raise GoalsError("invalid_command")
    return value


@dataclass(frozen=True)
class GoalsCommand:
    """A detached immutable command; validated data contains only scalar values.

    Use ``normalize_goal_command`` at each trust boundary. Repositories can
    revalidate with ``{**command.data, "request_key": command.request_key}``.
    """

    action: str
    request_key: str
    data: Mapping[str, str | None]

    def __post_init__(self):
        # A frozen dataclass alone would still expose a mutable payload dict.
        object.__setattr__(self, "data", MappingProxyType(dict(self.data)))

    @property
    def digest(self) -> str:
        encoded = json.dumps(
            {
                "action": self.action,
                "request_key": self.request_key,
                "data": dict(self.data),
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


def normalize_goal_command(action, payload) -> GoalsCommand:
    """Validate Add or Reset without trusting any browser-supplied authority.

    The route bounds and decodes the request body before calling this function.
    A nullable Reset cycle is syntactically valid; only the repository can check
    whether the selected period is actually empty under its account lock.
    """
    if type(action) is not str or action not in _COMMAND_FIELDS:
        raise GoalsError("invalid_command")
    if type(payload) is not dict or payload.keys() != _COMMAND_FIELDS[action]:
        raise GoalsError("invalid_command")

    request_key = uuid_ref(payload["request_key"])
    command_revision = revision(payload["revision"])
    period = payload["period"]
    if type(period) is not str or period not in GOAL_PERIODS:
        raise GoalsError("invalid_command")

    timezone_name = payload["timezone_name"]
    try:
        # Keep the domain's timezone allowlist and path-safety semantics intact.
        _zone(timezone_name, available_timezones(), "invalid_command")
    except GoalsDomainError as error:
        raise GoalsError(error.code) from error

    data = {
        "revision": command_revision,
        "period": period,
        "timezone_name": timezone_name,
    }
    if action == "add":
        data["evidence_ref"] = uuid_ref(payload["evidence_ref"])
        version = payload["evidence_version"]
        if type(version) is not str or _EVIDENCE_VERSION.fullmatch(version) is None:
            raise GoalsError("invalid_command")
        data["evidence_version"] = version
    else:
        expected_cycle_id = payload["expected_cycle_id"]
        data["expected_cycle_id"] = (
            None if expected_cycle_id is None else uuid_ref(expected_cycle_id)
        )
    return GoalsCommand(action, request_key, data)
