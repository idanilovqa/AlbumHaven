"""Server-owned policy decisions and allowed-action projection."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable


_ACTION_KEY = re.compile(
    r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+", re.ASCII
)
_REASON_CODE = re.compile(r"[a-z][a-z0-9_-]{0,63}", re.ASCII)


@dataclass(frozen=True, repr=False, slots=True)
class PolicyDecision:
    action: str
    allowed: bool
    reason_code: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.action, str)
            or len(self.action) > 128
            or not _ACTION_KEY.fullmatch(self.action)
            or not isinstance(self.allowed, bool)
            or not isinstance(self.reason_code, str)
            or not _REASON_CODE.fullmatch(self.reason_code)
        ):
            raise ValueError("Policy decision is invalid.")

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(action={self.action!r}, "
            f"allowed={self.allowed!r}, reason_code=<redacted>)"
        )


@dataclass(frozen=True, slots=True)
class AllowedActions:
    keys: tuple[str, ...]

    @classmethod
    def from_decisions(
        cls, decisions: Iterable[PolicyDecision]
    ) -> AllowedActions:
        try:
            received = tuple(decisions)
        except TypeError:
            raise ValueError("Allowed actions input is invalid.") from None
        if any(not isinstance(item, PolicyDecision) for item in received):
            raise ValueError("Allowed actions input is invalid.")
        actions = [item.action for item in received]
        if len(set(actions)) != len(actions):
            raise ValueError("Allowed actions contain duplicate decisions.")
        return cls(
            keys=tuple(sorted(item.action for item in received if item.allowed))
        )

    def allows(self, action: object) -> bool:
        return isinstance(action, str) and action in self.keys

    def as_payload(self) -> dict[str, bool]:
        return {action: True for action in self.keys}
