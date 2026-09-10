"""Framework-neutral policy context and scope contracts."""

from __future__ import annotations

from dataclasses import dataclass
import re

from music_app.services.client_surfaces import VALID_CLIENT_SURFACE_CLASSES
from music_app.services.current_actor import CurrentActor


_SAFE_KEY = re.compile(r"[a-z][a-z0-9_]{0,63}", re.ASCII)
_ACTION_KEY = re.compile(
    r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+", re.ASCII
)
_RESOURCE_REFERENCE = re.compile(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,255}", re.ASCII)


@dataclass(frozen=True, slots=True)
class ResourceScope:
    resource_kind: str
    resource_ref: str

    def __post_init__(self) -> None:
        if not _valid_key(self.resource_kind) or not isinstance(
            self.resource_ref, str
        ) or not _RESOURCE_REFERENCE.fullmatch(self.resource_ref):
            raise ValueError("Policy resource scope is invalid.")


@dataclass(frozen=True, repr=False, slots=True)
class RequestOrigin:
    origin_type: str
    origin_key: str

    def __post_init__(self) -> None:
        if not _valid_key(self.origin_type) or not _safe_private_key(self.origin_key):
            raise ValueError("Policy request origin is invalid.")

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(origin_type={self.origin_type!r}, "
            "origin_key=<redacted>)"
        )


@dataclass(frozen=True, slots=True)
class PolicyContext:
    actor: CurrentActor
    action: str
    resource: ResourceScope | None
    target_account_id: int | None
    library_id: int | None
    deployment_mode: str
    request_origin: RequestOrigin
    client_surface_class: str

    @classmethod
    def build(
        cls,
        *,
        actor: CurrentActor,
        action: object,
        deployment_mode: object,
        request_origin: RequestOrigin,
        client_surface_class: object,
        resource: ResourceScope | None = None,
        target_account_id: object | None = None,
        library_id: object | None = None,
    ) -> PolicyContext:
        if not isinstance(actor, CurrentActor):
            raise ValueError("Policy context actor is invalid.")
        if not isinstance(action, str) or len(action) > 128 or not _ACTION_KEY.fullmatch(
            action
        ):
            raise ValueError("Policy context action is invalid.")
        if resource is not None and not isinstance(resource, ResourceScope):
            raise ValueError("Policy context resource is invalid.")
        if not _valid_key(deployment_mode):
            raise ValueError("Policy context deployment mode is invalid.")
        if not isinstance(request_origin, RequestOrigin):
            raise ValueError("Policy context request origin is invalid.")
        if (
            not isinstance(client_surface_class, str)
            or client_surface_class not in VALID_CLIENT_SURFACE_CLASSES
        ):
            raise ValueError("Policy context client surface is invalid.")
        return cls(
            actor=actor,
            action=action,
            resource=resource,
            target_account_id=_optional_positive_integer(
                target_account_id, "target account"
            ),
            library_id=_optional_positive_integer(library_id, "library"),
            deployment_mode=deployment_mode,
            request_origin=request_origin,
            client_surface_class=client_surface_class,
        )


def _valid_key(value: object) -> bool:
    return isinstance(value, str) and bool(_SAFE_KEY.fullmatch(value))


def _safe_private_key(value: object) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 256
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _optional_positive_integer(value: object | None, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"Policy context {field} scope is invalid.")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"Policy context {field} scope is invalid.") from None
    if parsed < 1:
        raise ValueError(f"Policy context {field} scope is invalid.")
    return parsed
