"""Album Top command validation and resource authority, without storage or UI."""
from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import json
import re
from uuid import UUID

from music_app.services.current_actor import CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext
from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints

BROWSE = "library.browse.read"
CREATE = "library.album_tops.create"
MANAGE = "library.album_tops.manage"
ITEMS = "library.album_tops.items.manage"
ACCESS = "library.album_tops.access.manage"
SETTINGS = "library.album_tops.settings.manage"
PROGRESS = "library.album_tops.progress.manage"
MAX_TOP_ITEMS = 5000
MAX_TOP_COMMAND_BYTES = 512 * 1024
_ACTIONS = frozenset((BROWSE, CREATE, MANAGE, ITEMS, ACCESS, SETTINGS, PROGRESS))
_REVISION = re.compile(r"[1-9][0-9]{0,18}\Z", re.ASCII)
_EVIDENCE = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)


class AlbumTopError(Exception):
    def __init__(self, code: str, status_code: int = 422):
        self.code = code
        self.status_code = status_code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class AlbumTopCommand:
    action: str
    top_ref: str | None
    request_key: str
    data: dict

    @property
    def digest(self) -> str:
        value = {"action": self.action, "top_ref": self.top_ref, "data": self.data}
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False, allow_nan=False).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


def top_uuid(value: object) -> str:
    if type(value) is not str or len(value) != 36:
        raise AlbumTopError("invalid_command")
    try:
        normalized = str(UUID(value))
    except ValueError:
        raise AlbumTopError("invalid_command") from None
    if value != normalized:
        raise AlbumTopError("invalid_command")
    return normalized


def top_revision(value: object) -> str:
    if (type(value) is not str or not _REVISION.fullmatch(value)
            or int(value) > 9223372036854775807):
        raise AlbumTopError("invalid_command")
    return value


def _text(value: object, maximum: int, *, title: bool = False) -> str:
    if type(value) is not str or "\x00" in value:
        raise AlbumTopError("invalid_command")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise AlbumTopError("invalid_command") from None
    text = value.strip() if title else value
    if len(text) > maximum or title and not text:
        raise AlbumTopError("invalid_command")
    return text


def _refs(value: object, *, empty: bool = False) -> list[str]:
    if type(value) is not list or len(value) > MAX_TOP_ITEMS or not empty and not value:
        raise AlbumTopError("invalid_command")
    refs = [top_uuid(item) for item in value]
    if len(set(refs)) != len(refs):
        raise AlbumTopError("invalid_command")
    return refs


def _draft_items(value, *, require_sources=False):
    if type(value) is not list or len(value) > MAX_TOP_ITEMS:
        raise AlbumTopError("invalid_command")
    items, albums, retained = [], set(), set()
    for row in value:
        if (type(row) is not dict or not {"album_ref", "item_ref"} <= row.keys()
                or set(row) - {"album_ref", "item_ref", "selected_local_album_id", "selected_source_ref"}):
            raise AlbumTopError("invalid_command")
        album = top_uuid(row["album_ref"])
        item = top_uuid(row["item_ref"]) if row["item_ref"] is not None else None
        if album in albums or item is not None and item in retained:
            raise AlbumTopError("invalid_command")
        albums.add(album)
        retained.add(item)
        normalized = {"album_ref": album, "item_ref": item}
        source_fields = {"selected_local_album_id", "selected_source_ref"} & row.keys()
        if source_fields or require_sources:
            local = row.get("selected_local_album_id")
            if (len(source_fields) != 2 or type(local) is not int
                    or not 0 < local <= 9223372036854775807):
                raise AlbumTopError("invalid_command")
            normalized.update(selected_local_album_id=local,
                              selected_source_ref=top_uuid(row["selected_source_ref"]))
        items.append(normalized)
    return items


def _remote_top_ref(value):
    ref = top_uuid(value)
    if ref == "00000000-0000-0000-0000-000000000000":
        raise AlbumTopError("invalid_command")
    return ref


def _remote_selection(value, *, allow_retained=True):
    if type(value) is not dict or type(value.get("kind")) is not str:
        raise AlbumTopError("invalid_command")
    # The remote module imports this module's errors/UUID helpers. Keep this
    # import local, after both modules can finish their pure definitions.
    from music_app.services.album_top_remote_sources import (
        normalize_pending_remote_selector, remote_context_ref,
    )
    if value["kind"] == "remote_acquisition":
        return normalize_pending_remote_selector(value)
    if (allow_retained and value["kind"] == "remote_retained"
            and set(value) == {"kind", "admission_ref", "evidence_version"}):
        return {"kind": "remote_retained",
                "admission_ref": _remote_top_ref(value["admission_ref"]),
                "evidence_version": remote_context_ref(value["evidence_version"])}
    raise AlbumTopError("invalid_command")


def _remote_selection_key(value):
    field = "acquisition_ref" if value["kind"] == "remote_acquisition" else "admission_ref"
    # A second version for one selector is still a duplicate request member.
    return value["kind"], value[field]


def _top_selections(value, *, allow_retained, allow_local_only=False):
    if type(value) is not list or not 1 <= len(value) <= MAX_TOP_ITEMS:
        raise AlbumTopError("invalid_command")
    selections, seen, remote = [], set(), False
    for row in value:
        if type(row) is not dict or type(row.get("kind")) is not str:
            raise AlbumTopError("invalid_command")
        if row["kind"] == "local_catalog":
            if set(row) != {"kind", "album_ref"}:
                raise AlbumTopError("invalid_command")
            selection = {"kind": "local_catalog", "album_ref": top_uuid(row["album_ref"])}
            identity = selection["kind"], selection["album_ref"]
        else:
            selection = _remote_selection(row, allow_retained=allow_retained)
            identity = _remote_selection_key(selection)
            remote = True
        if identity in seen:
            raise AlbumTopError("invalid_command")
        seen.add(identity)
        selections.append(selection)
    if not remote and not allow_local_only:
        raise AlbumTopError("invalid_command")
    return selections


def _draft_selection_source(value):
    if type(value) is not dict or type(value.get("kind")) is not str:
        raise AlbumTopError("invalid_command")
    if value["kind"] == "unselected" and set(value) == {"kind"}:
        return {"kind": "unselected"}
    if value["kind"] == "local" and set(value) == {
            "kind", "selected_local_album_id", "selected_source_ref"}:
        local = value["selected_local_album_id"]
        if type(local) is not int or not 0 < local <= 9223372036854775807:
            raise AlbumTopError("invalid_command")
        return {"kind": "local", "selected_local_album_id": local,
                "selected_source_ref": top_uuid(value["selected_source_ref"])}
    return _remote_selection(value)


def _draft_item_selections(value):
    if type(value) is not list or len(value) > MAX_TOP_ITEMS:
        raise AlbumTopError("invalid_command")
    items, albums, retained, remote_sources = [], set(), set(), set()
    for row in value:
        if type(row) is not dict or type(row.get("kind")) is not str:
            raise AlbumTopError("invalid_command")
        kind = row["kind"]
        expected = {"existing": {"kind", "item_ref", "album_ref", "source"},
                    "new_local": {"kind", "album_ref", "source"},
                    "new_remote": {"kind", "source"}}
        if kind not in expected or set(row) != expected[kind]:
            raise AlbumTopError("invalid_command")
        item = {"kind": kind}
        if kind == "existing":
            item["item_ref"] = top_uuid(row["item_ref"])
            if item["item_ref"] in retained:
                raise AlbumTopError("invalid_command")
            retained.add(item["item_ref"])
        if kind != "new_remote":
            item["album_ref"] = top_uuid(row["album_ref"])
            if item["album_ref"] in albums:
                raise AlbumTopError("invalid_command")
            albums.add(item["album_ref"])
        source = _draft_selection_source(row["source"])
        remote = source["kind"] in {"remote_acquisition", "remote_retained"}
        if kind == "new_remote" and not remote or kind == "new_local" and remote:
            raise AlbumTopError("invalid_command")
        if remote:
            identity = _remote_selection_key(source)
            if identity in remote_sources:
                raise AlbumTopError("invalid_command")
            remote_sources.add(identity)
        item["source"] = source
        items.append(item)
    return items


def normalize_top_publication_preview(payload):
    if type(payload) is not dict or set(payload) != {"revision", "items"}:
        raise AlbumTopError("invalid_command")
    return {"revision": top_revision(payload["revision"]),
            "items": _draft_items(payload["items"], require_sources=True)}


def normalize_top_command(action: str, payload: object, *, top_ref: object = None) -> AlbumTopCommand:
    fields = {
        "create": {"request_key", "title", "description", "album_refs", "draft_ref", "selections", "playlist_preview_ref", "source_review", "artist_scope"},
        "unlock_source": {"request_key", "revision"},
        "save": {"request_key", "revision", "title", "description", "items", "item_selections", "evidence_revision", "artwork_publication"},
        "enable_external": {"request_key", "revision", "title", "description", "items", "evidence_revision", "artwork_publication"},
        "revoke_external": {"request_key", "revision"},
        "add": {"request_key", "revision", "album_refs", "selections"},
        "remove": {"request_key", "revision", "item_refs"},
        "reorder": {"request_key", "revision", "item_order"},
        "delete": {"request_key", "revision"},
        "visibility": {"request_key", "revision", "visibility"},
        "grant_editor": {"request_key", "revision", "account_id", "role"},
        "grant_viewer": {"request_key", "revision", "account_id", "role"},
        "revoke_editor": {"request_key", "revision", "grant_ref"},
        "request_edit": {"request_key", "revision"},
        "decide_edit_request": {"request_key", "revision", "request_ref", "decision"},
        "copy": {"request_key", "revision", "title"},
        "set_manual_completion": {"request_key", "album_ref", "progress_revision", "completed"},
        "set_activity": {"request_key", "activity_revision", "active"},
    }
    if type(action) is not str or action not in fields or type(payload) is not dict:
        raise AlbumTopError("invalid_command")
    if set(payload) - fields[action]:
        raise AlbumTopError("invalid_command")
    key = top_uuid(payload.get("request_key"))
    if action == "create":
        if top_ref is not None:
            raise AlbumTopError("invalid_command")
        scope = {}
        if 'artist_scope' in payload:
            from music_app.services.album_top_artist_scope import normalize_artist_scope
            scope = {'artist_scope': normalize_artist_scope(payload['artist_scope'])}
        if 'source_review' in payload:
            if set(payload) - {'request_key', 'title', 'description', 'source_review'}:
                raise AlbumTopError('invalid_command')
            from music_app.services.album_top_source_finalization import normalize_review
            review = normalize_review(payload['source_review'])
            if key != review['job_ref']:
                raise AlbumTopError('invalid_command')
            return AlbumTopCommand(action, None, key, {
                'title': _text(payload.get('title'), 100, title=True),
                'description': _text(payload.get('description', ''), 1000),
                'source_review': review})
        if "playlist_preview_ref" in payload:
            if set(payload) - {'request_key', 'title', 'description', 'playlist_preview_ref'}:
                raise AlbumTopError('invalid_command')
            preview = top_uuid(payload['playlist_preview_ref'])
            # A preview owns exactly one Save identity, even across double
            # clicks, lost acknowledgements or a recreated client controller.
            if key != preview:
                raise AlbumTopError('invalid_command')
            return AlbumTopCommand(action, None, key, {
                'title': _text(payload.get('title'), 100, title=True),
                'description': _text(payload.get('description', ''), 1000),
                'playlist_preview_ref': preview})
        if "selections" in payload:
            if "album_refs" in payload:
                raise AlbumTopError("invalid_command")
            data = {"title": _text(payload.get("title"), 100, title=True),
                    "description": _text(payload.get("description", ""), 1000),
                    "draft_ref": _remote_top_ref(payload.get("draft_ref")),
                    "selections": _top_selections(payload["selections"], allow_retained=False,
                                                  allow_local_only=bool(scope))}
            return AlbumTopCommand(action, None, key, {**data, **scope})
        if "draft_ref" in payload:
            raise AlbumTopError("invalid_command")
        data = {"title": _text(payload.get("title"), 100, title=True),
                "description": _text(payload.get("description", ""), 1000),
                "album_refs": _refs(payload.get("album_refs", []), empty=True)}
        return AlbumTopCommand(action, None, key, {**data, **scope})
    target = top_uuid(top_ref)
    if action == "set_activity":
        revision = payload.get("activity_revision")
        if type(revision) is not str or revision != "0":
            revision = top_revision(revision)
        if type(payload.get("active")) is not bool:
            raise AlbumTopError("invalid_command")
        return AlbumTopCommand(action, target, key, {
            "activity_revision": revision, "active": payload["active"],
        })
    if action == "set_manual_completion":
        revision = payload.get("progress_revision")
        if type(revision) is not str or revision != "0":
            revision = top_revision(revision)
        if type(payload.get("completed")) is not bool:
            raise AlbumTopError("invalid_command")
        return AlbumTopCommand(action, target, key, {
            "album_ref": top_uuid(payload.get("album_ref")),
            "progress_revision": revision, "completed": payload["completed"],
        })
    data = {"revision": top_revision(payload.get("revision"))}
    if action == "visibility":
        if type(payload.get("visibility")) is not str or payload["visibility"] not in {"private", "server_shared"}:
            raise AlbumTopError("invalid_command")
        data["visibility"] = payload["visibility"]
    elif action in {"grant_editor", "grant_viewer"}:
        role = "editor" if action == "grant_editor" else "viewer"
        account = payload.get("account_id")
        if (type(account) is not int or not 0 < account <= 9223372036854775807
                or type(payload.get("role")) is not str or payload["role"] != role):
            raise AlbumTopError("invalid_command")
        data.update(account_id=account, role=role)
    elif action == "revoke_editor":
        data["grant_ref"] = top_uuid(payload.get("grant_ref"))
    elif action == "decide_edit_request":
        data["request_ref"] = top_uuid(payload.get("request_ref"))
        if type(payload.get("decision")) is not str or payload["decision"] not in {"approve", "decline"}:
            raise AlbumTopError("invalid_command")
        data["decision"] = payload["decision"]
    elif action == "copy":
        if "title" in payload:
            data["title"] = _text(payload["title"], 100, title=True)
    elif action in {"save", "enable_external"}:
        if 'artwork_publication' in payload:
            # Must land with execute's replay-first/key-fenced v2 dispatch.
            # A descriptor can never be silently forwarded to the v1 saver.
            from music_app.services import album_top_artwork_review as artwork_review
            if (not {'title', 'description', 'items', 'evidence_revision'} <= payload.keys()
                    or 'item_selections' in payload):
                raise AlbumTopError('invalid_command')
            data.update(artwork_review.publication_header(payload['title'], payload['description']))
            data['items'] = _draft_items(payload['items'], require_sources=True)
            data['artwork_publication'] = artwork_review.normalize_publication_descriptor(payload['artwork_publication'])
        if "title" in payload:
            data["title"] = _text(payload["title"], 100, title=True)
        if "description" in payload:
            data["description"] = _text(payload["description"], 1000)
        if "item_selections" in payload:
            if "items" in payload:
                raise AlbumTopError("invalid_command")
            data["item_selections"] = _draft_item_selections(payload["item_selections"])
        if "items" in payload:
            data["items"] = _draft_items(payload["items"])
        if "evidence_revision" in payload or action == "enable_external":
            evidence = payload.get("evidence_revision")
            if type(evidence) is not str or not _EVIDENCE.fullmatch(evidence):
                raise AlbumTopError("invalid_command")
            data["evidence_revision"] = evidence
        if action == "save" and set(data) == {"revision"}:
            raise AlbumTopError("invalid_command")
    elif action in {"add", "remove", "reorder"}:
        if action == "add" and "selections" in payload:
            if "album_refs" in payload:
                raise AlbumTopError("invalid_command")
            data["selections"] = _top_selections(payload["selections"], allow_retained=True)
        else:
            field = {"add": "album_refs", "remove": "item_refs", "reorder": "item_order"}[action]
            data[field] = _refs(payload.get(field), empty=action == "reorder")
    return AlbumTopCommand(action, target, key, data)


def command_actions(command: AlbumTopCommand) -> tuple[str, ...]:
    if command.action == "enable_external":
        return BROWSE, MANAGE, ITEMS, ACCESS
    if command.action == "revoke_external":
        return BROWSE, ACCESS
    if command.action == "request_edit":
        return (BROWSE,)
    action = {"create": CREATE, "copy": CREATE, "save": MANAGE, "delete": MANAGE, "unlock_source": MANAGE,
              "add": ITEMS, "remove": ITEMS, "reorder": ITEMS, "visibility": ACCESS,
              "grant_editor": ACCESS, "grant_viewer": ACCESS, "revoke_editor": ACCESS,
              "decide_edit_request": ACCESS, "set_manual_completion": PROGRESS,
              "set_activity": PROGRESS}.get(command.action)
    if action is None:
        raise AlbumTopError("invalid_command")
    return BROWSE, action


def require_top_authority(context: PolicyContext, *, required_actions: tuple[str, ...],
                          owner_account_id: int | None, constraints=None,
                          editor_grant: bool = False, viewer_grant: bool = False,
                          visibility: str = "private",
                          owner_only: bool = False) -> None:
    if not isinstance(context, PolicyContext) or not isinstance(context.actor, CurrentActor):
        raise AlbumTopError("forbidden", 403)
    actor = context.actor
    if (not actor.is_authenticated or any(type(value) is not int or value <= 0 for value in
            (actor.account_id, actor.session_id, actor.current_library_id, context.library_id))
            or actor.current_library_id != context.library_id
            or context.target_account_id is not None and (
                type(context.target_account_id) is not int or context.target_account_id != actor.account_id)
            or not isinstance(actor.library_relationships, tuple)
            or not any(isinstance(item, LibraryRelationship) and type(item.library_id) is int
                       and item.library_id == context.library_id for item in actor.library_relationships)):
        raise AlbumTopError("forbidden", 403)
    if (not isinstance(required_actions, tuple) or not required_actions
            or any(type(action) is not str or action not in _ACTIONS for action in required_actions)
            or BROWSE not in required_actions or type(visibility) is not str
            or visibility not in {"private", "server_shared"}):
        raise AlbumTopError("forbidden", 403)
    needs_target = bool(set(required_actions) & {MANAGE, ITEMS, ACCESS, SETTINGS, PROGRESS}) or context.resource is not None
    if owner_account_id is not None or needs_target:
        if type(owner_account_id) is not int or owner_account_id <= 0:
            raise AlbumTopError("forbidden", 403)
        if context.resource is not None and context.resource.resource_kind != "album_top":
            raise AlbumTopError("forbidden", 403)
        owner = owner_account_id == actor.account_id
        editor = editor_grant is True
        if not (owner or editor or viewer_grant is True or visibility == "server_shared"):
            raise AlbumTopError("forbidden", 403)
        if (owner_only or ACCESS in required_actions) and not owner:
            raise AlbumTopError("forbidden", 403)
        if set(required_actions) & {MANAGE, ITEMS, SETTINGS} and not (owner or editor):
            raise AlbumTopError("forbidden", 403)
    evaluator = PolicyEvaluator()
    for action in dict.fromkeys(required_actions):
        target = replace(context, action=action)
        effective = constraints(target) if callable(constraints) else constraints
        if effective is not None and not isinstance(effective, PolicyEvaluationConstraints):
            raise AlbumTopError("forbidden", 403)
        if not evaluator.evaluate(target, constraints=effective).decision.allowed:
            raise AlbumTopError("forbidden", 403)
