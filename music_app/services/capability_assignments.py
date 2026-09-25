"""Validated, library-scoped role assignment records and effective grants.

Role metadata remembers the administrator's choices; only app.capabilities
rows authorize requests. Stale metadata is never expanded into live authority.
"""
from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass
import hashlib
import json

from music_app.services.capabilities import CAPABILITY_KEYS, ROLE_PRESETS

LEGACY_CAPABILITY_KEYS = frozenset({
    "library.browse.read", "library.media.read", "library.problems.read",
    "library.inventory.manage", "library.rules.read", "library.logs.read",
    "library.logs.export", "library.loops.read", "library.loops.media.read",
    "library.discovery.read", "library.virtual_discography.read",
    "library.opinions.read", "library.resources.read", "library.playlists.create",
    "library.playlists.manage", "library.playlists.items.manage",
    "library.track_preferences.manage", "integration.lastfm.scrobbles.submit",
})
ASSIGNABLE_CAPABILITY_KEYS = (
    LEGACY_CAPABILITY_KEYS | CAPABILITY_KEYS | frozenset().union(*ROLE_PRESETS.values())
)
ROLE_LABELS = {key: key.title() for key in ROLE_PRESETS}
CAPABILITY_LABELS = {
    "capability.view": "View", "capability.play": "Play",
    "capability.edit": "Edit", "capability.change_covers": "Change covers",
    "capability.delete": "Delete", "capability.admin": "Admin",
    "capability.create_loop": "Create loop", "capability.practice": "Practice",
    "capability.repair": "Repair", "capability.rules": "Rules", "capability.move": "Move",
}


class AssignmentConflict(ValueError):
    """The displayed access state no longer matches the locked database state."""


@dataclass(frozen=True, slots=True)
class CapabilityAssignment:
    role_keys: tuple[str, ...]
    capability_keys: tuple[str, ...]

    @property
    def effective_keys(self) -> tuple[str, ...]:
        inherited = set().union(*(ROLE_PRESETS[key] for key in self.role_keys))
        return tuple(sorted(inherited | set(self.capability_keys)))

    def as_payload(self) -> dict[str, object]:
        return {"version": 1, "role_keys": list(self.role_keys),
                "capability_keys": list(self.capability_keys)}


def _keys(value: object, allowed: Collection[str], label: str) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)) or len(value) > len(allowed):
        raise ValueError(f"Account {label} are invalid.")
    if any(not isinstance(key, str) or key not in allowed for key in value):
        raise ValueError(f"Account {label} are invalid.")
    if len(set(value)) != len(value):
        raise ValueError(f"Account {label} contain duplicates.")
    return tuple(sorted(value))


def build_assignment(roles: object, capabilities: object, *, allow_empty: bool = False) -> CapabilityAssignment:
    assignment = CapabilityAssignment(
        _keys(roles, ROLE_PRESETS, "roles"),
        _keys(capabilities, ASSIGNABLE_CAPABILITY_KEYS, "capabilities"),
    )
    if not allow_empty and not assignment.effective_keys:
        raise ValueError("Account capabilities must not be empty.")
    return assignment


def read_assignment(payload: object, effective_keys: object) -> CapabilityAssignment:
    """Return recorded choices only when they still describe the live grants."""
    current = tuple(sorted(set(effective_keys) & ASSIGNABLE_CAPABILITY_KEYS))
    if isinstance(payload, Mapping) and type(payload.get("version")) is int and payload["version"] == 1:
        try:
            assignment = build_assignment(payload.get("role_keys"), payload.get("capability_keys"), allow_empty=True)
        except ValueError:
            pass
        else:
            if assignment.effective_keys == current:
                return assignment
    return CapabilityAssignment((), current)


def access_revision(assignment: CapabilityAssignment, effective_keys: object, *, active: bool, access: bool) -> str:
    value = {**assignment.as_payload(), "effective_keys": sorted(set(effective_keys)),
             "active": active, "access": access}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def store_assignment(connection, *, account_id: int, library_id: int,
                     assignment: CapabilityAssignment) -> None:
    """Merge one library's choices without replacing other account metadata."""
    connection.execute(
        """
        update app.accounts
        set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb),
            '{library_access_assignments_v1}',
            coalesce(metadata -> 'library_access_assignments_v1', '{}'::jsonb)
                || jsonb_build_object(%s::text, %s::jsonb), true)
        where id = %s
        """,
        (str(library_id), json.dumps(assignment.as_payload(), sort_keys=True), account_id),
    )


def assignment_editor(member, listener_defaults) -> dict[str, object]:
    keys = tuple(member.capability_keys) if member else tuple(sorted(listener_defaults))
    assignment = read_assignment(getattr(member, "access_assignment", None), keys)
    return {
        **assignment.as_payload(),
        "roles": [{"key": key, "label": ROLE_LABELS[key], "grants": sorted(grants)}
                  for key, grants in ROLE_PRESETS.items()],
        "capabilities": list(CAPABILITY_LABELS.items()),
        "label": member_role_label(member, listener_defaults) if member else "Listener",
        "unmanaged_keys": sorted(set(keys) - ASSIGNABLE_CAPABILITY_KEYS),
        "inherited_keys": sorted(set().union(*(ROLE_PRESETS[key] for key in assignment.role_keys))),
        "unlisted_keys": sorted(set(assignment.capability_keys) - CAPABILITY_KEYS - LEGACY_CAPABILITY_KEYS),
        "revision": access_revision(assignment, keys, active=bool(member and member.is_active),
                                    access=bool(member and member.membership_role)),
    }


def member_role_label(member, listener_defaults) -> str:
    if member.is_bootstrap_owner:
        return "Owner"
    assignment = read_assignment(getattr(member, "access_assignment", None), member.capability_keys)
    if assignment.role_keys:
        return " + ".join(ROLE_LABELS[key] for key in assignment.role_keys)
    if set(member.capability_keys) & CAPABILITY_KEYS:
        return "Custom"
    return "Listener" if set(member.capability_keys) == set(listener_defaults) else "Listener · Customized"
