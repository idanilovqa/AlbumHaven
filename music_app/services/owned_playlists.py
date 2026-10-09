"""Same-server Playlist commands and policy, independent from storage/transport."""
from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import json
import re
from uuid import UUID

from music_app.services.policy import PolicyContext
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator

MAX_PLAYLIST_TITLE_LENGTH = 100
MAX_PLAYLIST_DESCRIPTION_LENGTH = 1000
MAX_PLAYLIST_ITEMS_PER_COMMAND = 5000
MAX_PLAYLIST_COMMAND_BYTES = 512 * 1024
PLAYLIST_SOURCE_PROTOCOL = "library_selection_v1"
COMPLETE_INVENTORY_PROTOCOL = "complete_inventory_selection_v1"
COMPLETE_ACTIVITY_PROTOCOL = "complete_activity_selection_v1"
MISSING_PLAYLIST_PROTOCOL = "missing_playlist_selection_v1"
SOURCE_PROTOCOL_KINDS = {
    PLAYLIST_SOURCE_PROTOCOL: "library", COMPLETE_INVENTORY_PROTOCOL: "library",
    COMPLETE_ACTIVITY_PROTOCOL: "activity", MISSING_PLAYLIST_PROTOCOL: "playlist",
}
BROWSE = "library.browse.read"
CREATE = "library.playlists.create"
MANAGE = "library.playlists.manage"
ITEMS = "library.playlists.items.manage"
ACCESS = "library.playlists.access.manage"
SETTINGS = "library.playlists.settings.manage"
SAVED_SORT_KEYS = frozenset(("love_tier", "play_count", "popularity_count", "duration"))
_ACTIONS = frozenset((BROWSE, CREATE, MANAGE, ITEMS, ACCESS, SETTINGS))
_POSITIVE = re.compile(r"[1-9][0-9]{0,18}\Z", re.ASCII)
_INVENTORY_REF = re.compile(r"inventory-track:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})\Z", re.ASCII)
_MAX_BIGINT = 9223372036854775807


class PlaylistError(Exception):
    def __init__(self, code: str, status_code: int = 422):
        self.code = code
        self.status_code = status_code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class PlaylistCommand:
    action: str
    playlist_ref: str | None
    request_key: str
    data: dict

    @property
    def digest(self) -> str:
        return evidence_digest({"action": self.action, "playlist_ref": self.playlist_ref, "data": self.data})


def evidence_digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def uuid_ref(value: object) -> str:
    if not isinstance(value, str) or len(value) != 36:
        raise PlaylistError("invalid_command")
    try:
        parsed = str(UUID(value))
    except (ValueError, AttributeError):
        raise PlaylistError("invalid_command") from None
    if value.casefold() != parsed:
        raise PlaylistError("invalid_command")
    return parsed


def inventory_identity(value: object) -> tuple[int, int]:
    match = _INVENTORY_REF.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise PlaylistError("invalid_command")
    library_id, track_id = (int(part) for part in match.groups())
    if max(library_id, track_id) > _MAX_BIGINT:
        raise PlaylistError("invalid_command")
    return library_id, track_id


def playlist_revision(value: object) -> str:
    if not isinstance(value, str) or not _POSITIVE.fullmatch(value) or int(value) > _MAX_BIGINT:
        raise PlaylistError("invalid_command")
    return value


def _text(value: object, *, maximum: int, title: bool = False) -> str:
    if not isinstance(value, str) or "\x00" in value or any("\ud800" <= char <= "\udfff" for char in value):
        raise PlaylistError("invalid_command")
    result = value.strip() if title else value
    if len(result) > maximum or title and not result:
        raise PlaylistError("invalid_command")
    return result


def _refs(value: object, *, inventory: bool = False, empty: bool = False) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_PLAYLIST_ITEMS_PER_COMMAND or not empty and not value:
        raise PlaylistError("invalid_command")
    result = []
    for item in value:
        if inventory:
            library_id, track_id = inventory_identity(item)
            result.append(f"inventory-track:{library_id}:{track_id}")
        else:
            result.append(uuid_ref(item))
    if len(set(result)) != len(result):
        raise PlaylistError("invalid_command")
    return result


def normalize_playlist_command(action: str, payload: object, *, playlist_ref: object = None) -> PlaylistCommand:
    fields = {
        "create": {"mode", "source_protocol", "source", "title", "description", "entry_refs", "request_key"},
        "save": {"title", "description", "item_order", "revision", "request_key"},
        "add": {"track_refs", "revision", "request_key"},
        "remove": {"item_refs", "revision", "request_key"},
        "reorder": {"item_order", "revision", "request_key"},
        "visibility": {"visibility", "revision", "request_key"},
        "grant_editor": {"account_id", "role", "revision", "request_key"},
        "revoke_editor": {"grant_ref", "revision", "request_key"},
        "delete": {"revision", "request_key"},
        "default_sort": {"sort", "revision", "request_key"},
    }
    if not isinstance(action, str) or action not in fields or not isinstance(payload, dict) or set(payload) - fields[action]:
        raise PlaylistError("invalid_command")
    request_key = uuid_ref(payload.get("request_key"))
    if action == "create":
        protocol = payload.get("source_protocol")
        if (playlist_ref is not None or not isinstance(protocol,str) or protocol not in SOURCE_PROTOCOL_KINDS
                or payload.get("mode") != ("missing" if protocol==MISSING_PLAYLIST_PROTOCOL else "ordinary")):
            raise PlaylistError("invalid_command")
        source = payload.get("source")
        if not isinstance(source, dict) or set(source) != {"kind", "ref", "revision"} or source["kind"] != SOURCE_PROTOCOL_KINDS[protocol]:
            raise PlaylistError("invalid_command")
        data = {"mode": payload["mode"], "source_protocol": protocol,
                "source": {"kind": source["kind"], "ref": uuid_ref(source["ref"]),
                    "revision": playlist_revision(source["revision"]) if protocol==MISSING_PLAYLIST_PROTOCOL else uuid_ref(source["revision"])},
                "title": _text(payload.get("title"), maximum=MAX_PLAYLIST_TITLE_LENGTH, title=True),
                "description": _text(payload.get("description", ""), maximum=MAX_PLAYLIST_DESCRIPTION_LENGTH),
                "entry_refs": _refs(payload.get("entry_refs"), empty=protocol!=MISSING_PLAYLIST_PROTOCOL)}
        return PlaylistCommand(action, None, request_key, data)
    target = uuid_ref(playlist_ref)
    data = {"revision": playlist_revision(payload.get("revision"))}
    if action == "save":
        if not set(payload).intersection(("title", "description", "item_order")):
            raise PlaylistError("invalid_command")
        if "title" in payload:
            data["title"] = _text(payload["title"], maximum=MAX_PLAYLIST_TITLE_LENGTH, title=True)
        if "description" in payload:
            data["description"] = _text(payload["description"], maximum=MAX_PLAYLIST_DESCRIPTION_LENGTH)
        if "item_order" in payload:
            data["item_order"] = _refs(payload["item_order"], empty=True)
    elif action == "add":
        data["track_refs"] = _refs(payload.get("track_refs"), inventory=True)
    elif action == "remove":
        data["item_refs"] = _refs(payload.get("item_refs"))
    elif action == "reorder":
        data["item_order"] = _refs(payload.get("item_order"), empty=True)
    elif action == "visibility":
        if payload.get("visibility") not in ("private", "server_shared"):
            raise PlaylistError("invalid_command")
        data["visibility"] = payload["visibility"]
    elif action == "grant_editor":
        account = payload.get("account_id")
        if type(account) is not int or not 0 < account <= _MAX_BIGINT or payload.get("role") != "editor":
            raise PlaylistError("invalid_command")
        data.update(account_id=account, role="editor")
    elif action == "revoke_editor":
        data["grant_ref"] = uuid_ref(payload.get("grant_ref"))
    elif action == "default_sort":
        if "sort" not in payload:
            raise PlaylistError("invalid_command")
        sort = payload["sort"]
        if sort is not None:
            if (not isinstance(sort, dict) or set(sort) != {"key", "direction"}
                    or not isinstance(sort["key"], str) or sort["key"] not in SAVED_SORT_KEYS
                    or sort["direction"] not in ("asc", "desc")):
                raise PlaylistError("invalid_command")
            sort = {"key": sort["key"], "direction": sort["direction"]}
        data["sort"] = sort
    return PlaylistCommand(action, target, request_key, data)


def command_actions(command: PlaylistCommand) -> tuple[str, ...]:
    if command.action == "create":
        return BROWSE, CREATE
    if command.action in {"visibility", "grant_editor", "revoke_editor"}:
        return BROWSE, ACCESS
    if command.action == "delete":
        return BROWSE, MANAGE
    if command.action == "default_sort":
        return BROWSE, SETTINGS
    if command.action == "save":
        return (BROWSE, MANAGE, ITEMS) if "item_order" in command.data else (BROWSE, MANAGE)
    return BROWSE, ITEMS


def require_playlist_authority(context: PolicyContext, *, required_actions: tuple[str, ...],
                                    owner_account_id: int | None,
                                    constraints: PolicyEvaluationConstraints | None = None,
                                    editor_grant: bool = False, visibility: str = "private",
                                    owner_only: bool = False) -> None:
    if not isinstance(context, PolicyContext):
        raise PlaylistError("forbidden", 403)
    actor = context.actor
    if (not actor.is_authenticated or any(type(value) is not int or value <= 0 for value in
            (actor.account_id, actor.session_id, actor.current_library_id, context.library_id))
            or actor.current_library_id != context.library_id
            or not any(item.library_id == context.library_id for item in actor.library_relationships)):
        raise PlaylistError("forbidden", 403)
    if (not required_actions or BROWSE not in required_actions
            or any(action not in _ACTIONS for action in required_actions)):
        raise PlaylistError("forbidden", 403)
    target_required = (MANAGE in required_actions or ITEMS in required_actions or ACCESS in required_actions or SETTINGS in required_actions
                       or context.resource is not None and context.resource.resource_kind == "playlist")
    if owner_account_id is not None or target_required:
        if type(owner_account_id) is not int or owner_account_id <= 0 or visibility not in ("private", "server_shared"):
            raise PlaylistError("forbidden", 403)
        is_owner = owner_account_id == actor.account_id
        is_editor = editor_grant is True
        if not (is_owner or is_editor or visibility == "server_shared"):
            raise PlaylistError("forbidden", 403)
        if (owner_only or ACCESS in required_actions) and not is_owner:
            raise PlaylistError("forbidden", 403)
        if (MANAGE in required_actions or ITEMS in required_actions or SETTINGS in required_actions) and not (is_owner or is_editor):
            raise PlaylistError("forbidden", 403)
    evaluator = PolicyEvaluator()
    for action in dict.fromkeys(required_actions):
        if not evaluator.evaluate(replace(context, action=action), constraints=constraints).decision.allowed:
            raise PlaylistError("forbidden", 403)


def require_owned_playlist_authority(context: PolicyContext, *, required_actions: tuple[str, ...],
                                    owner_account_id: int | None,
                                    constraints: PolicyEvaluationConstraints | None = None) -> None:
    """Retain the strict owner-only foundation contract for existing callers."""
    if any(action not in (BROWSE, CREATE, MANAGE, ITEMS) for action in required_actions):
        raise PlaylistError("forbidden", 403)
    require_playlist_authority(context, required_actions=required_actions,
        owner_account_id=owner_account_id, constraints=constraints, owner_only=True)
