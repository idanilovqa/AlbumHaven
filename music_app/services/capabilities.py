"""User-facing capabilities and reusable presets over existing action authority.

Presets are assignment conveniences, not roles trusted from a request/session.
Persist their returned keys through the existing app.capabilities repository.
Unmapped actions retain their existing explicit-grant policy; adding a route does
not silently add it to an ordinary user's preset.
"""

from __future__ import annotations

from collections.abc import Iterable
from types import MappingProxyType


CAPABILITY_ACTIONS = MappingProxyType({
    "view": frozenset({
        "app.shell.read", "app.bootstrap.read", "app.status.read",
        "library.browse.read", "library.artwork.read",
        "library.virtual_discography.read", "library.virtual_discography.create",
    }),
    "play": frozenset({
        "library.media.read", "integration.lastfm.now_playing",
        "integration.lastfm.scrobble", "integration.lastfm.complete",
    }),
    "edit": frozenset({"library.files.edit_tags"}),
    "change_covers": frozenset({
        "library.covers.remote.read", "library.covers.lookup",
        "library.covers.lookup.cancel", "library.covers.fetch",
        "library.covers.fetch.cancel", "library.covers.write",
        "library.covers.upload", "library.covers.link",
        "library.covers.tasks.read", "library.covers.tasks.manage",
    }),
    "delete": frozenset({"library.inventory.manage", "library.covers.delete"}),
    "admin": frozenset({
        "accounts.read", "accounts.create", "accounts.manage",
        "accounts.membership.manage", "accounts.capabilities.manage",
        "accounts.sessions.revoke", "accounts.welcome.send",
        "accounts.password_reset.send", "accounts.invitation.copy",
        "accounts.invitation.send", "accounts.reauthenticate",
    }),
    "create_loop": frozenset({"library.loops.create"}),
    "practice": frozenset({
        "library.loops.read", "library.loops.media.read", "library.loops.preview",
    }),
    "repair": frozenset({"library.problems.read", "library.files.repair"}),
    "rules": frozenset({
        "library.rules.read", "library.rules.manage", "library.versions.manage",
    }),
    "move": frozenset({"library.files.move"}),
})
CAPABILITY_KEYS = frozenset(f"capability.{key}" for key in CAPABILITY_ACTIONS)

# Owner includes every existing library feature, but account administration is
# separately assignable. These finite extras await a more granular user-facing
# mapping; they must not accidentally become part of Listener or Musician.
_OWNER_ADDITIONAL_ACTIONS = frozenset({
    "integration.settings.read", "integration.foobar.read",
    "integration.lastfm.manage", "integration.lastfm.scrobbles.submit",
    "integration.local_playlists.analyze", "integration.local_playlists.import",
    "library.discovery.read", "library.discovery.lookup",
    "library.discovery.preferences.manage", "library.opinions.read",
    "library.resources.read", "library.files.open_location",
    "library.filesystem.browse", "library.logs.read", "library.logs.export",
    "library.loops.delete", "library.loops.reorder", "library.notes.manage",
    "library.playlists.create", "library.playlists.manage",
    "library.playlists.items.manage", "library.playlists.cover.manage",
    "library.playlists.settings.manage", "library.playlists.access.manage",
    "library.ratings.import", "library.refresh", "library.refresh.cancel",
    "library.refresh.read", "library.settings.read", "library.settings.manage",
    "library.tasks.read", "library.track_preferences.manage",
})
ROLE_PRESETS = MappingProxyType({
    "viewer": frozenset({"capability.view"}),
    "listener": frozenset({"capability.view", "capability.play"}),
    "musician": frozenset({
        "capability.view", "capability.play", "capability.create_loop",
        "capability.practice",
    }),
    "owner": (CAPABILITY_KEYS - {"capability.admin"}) | _OWNER_ADDITIONAL_ACTIONS,
    "admin": frozenset({"capability.view", "capability.admin"}),
})

# Compatibility for fine-grained grants assigned before the artwork/custom-cover
# split. These aliases never expand audio authority from a browse-only grant.
ACTION_GRANT_ALIASES = MappingProxyType({
    "library.artwork.read": frozenset({"library.media.read", "library.browse.read"}),
    "library.covers.upload": frozenset({"library.covers.write"}),
    "library.covers.link": frozenset({"library.covers.write"}),
    "library.covers.delete": frozenset({"library.covers.write"}),
})


def capability_keys_for_roles(roles: Iterable[str]) -> tuple[str, ...]:
    """Resolve complete presets for a validated, server-authorized assignment."""
    if isinstance(roles, (str, bytes)):
        raise ValueError("Roles must be a collection of preset keys.")
    try:
        requested = tuple(roles)
    except TypeError:
        raise ValueError("Roles must be a collection of preset keys.") from None
    if not requested or any(not isinstance(role, str) or role not in ROLE_PRESETS for role in requested):
        raise ValueError("Unknown or empty role preset selection.")
    return tuple(sorted(set().union(*(ROLE_PRESETS[role] for role in requested))))


def grant_keys_for_action(action: str) -> frozenset[str]:
    """Alternative durable grants for an action; scope is still checked separately."""
    keys = {action, *ACTION_GRANT_ALIASES.get(action, ())}
    keys.update(
        f"capability.{name}"
        for name, actions in CAPABILITY_ACTIONS.items()
        if action in actions
    )
    if action in {"app.shell.read", "app.bootstrap.read", "app.status.read"}:
        keys.add("library.browse.read")
    if action == "library.tasks.read":
        keys.update({"capability.edit", "capability.repair", "capability.move"})
    return frozenset(keys)


def action_capabilities(action: str) -> frozenset[str]:
    """Classify actions for client ceilings, including direct coarse-key queries."""
    names = {name for name, actions in CAPABILITY_ACTIONS.items() if action in actions}
    if action == "system.admin":
        names.add("admin")
    if action in CAPABILITY_KEYS:
        names.add(action.removeprefix("capability."))
    # Loop lifecycle writes are not part of Practice-only authority. Their
    # preset assignment remains explicit pending the loop-management decision.
    if action in {"library.loops.delete", "library.loops.reorder"}:
        names.add("create_loop")
    return frozenset(names)


def client_allows_action(action: str, surface: str, *, administrator: bool) -> bool:
    """Client restrictions only narrow durable authority, including for owners."""
    capabilities = action_capabilities(action)
    if surface in {"mobile", "tv"} and capabilities & {"edit", "delete", "create_loop"}:
        return False
    if surface == "tv" and capabilities & {"practice", "admin"}:
        return False
    if surface == "tv" and action in {"library.covers.upload", "library.covers.link"}:
        return False
    if surface in {"private_web", "cloud_web"} and "edit" in capabilities and not administrator:
        return False
    return True
