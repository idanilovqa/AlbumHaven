"""Domain types for one request-scoped authenticated actor."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class ActorState(str, Enum):
    ANONYMOUS = "anonymous"
    ACTIVE = "active"
    INACTIVE = "inactive"


@dataclass(frozen=True, slots=True)
class LibraryRelationship:
    library_id: int
    membership_role: str
    is_primary_owner: bool


@dataclass(frozen=True, slots=True)
class CapabilityGrant:
    capability_key: str
    scope_kind: str
    scope_id: int | None


@dataclass(frozen=True, slots=True)
class CurrentActor:
    state: ActorState
    account_id: int | None = None
    session_id: int | None = None
    username_display: str | None = None
    display_name: str | None = None
    authenticated_at: datetime | None = None
    is_bootstrap_owner: bool = False
    library_relationships: tuple[LibraryRelationship, ...] = ()
    capability_grants: tuple[CapabilityGrant, ...] = ()

    @property
    def is_authenticated(self) -> bool:
        return self.state is ActorState.ACTIVE

    @classmethod
    def anonymous(cls) -> CurrentActor:
        return cls(state=ActorState.ANONYMOUS)
