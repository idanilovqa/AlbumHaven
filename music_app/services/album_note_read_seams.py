from __future__ import annotations

from music_app.services.source_helpers import field_from_source
from music_app.services.utils import safe_int


def _bool_value(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


def _normalized_album_ref(value: object, fallback: object = None) -> str:
    return str(value or fallback or "").strip()


def _allowed_actions_payload(source: object) -> dict[str, bool]:
    return {
        "can_create": _bool_value(field_from_source(source, "can_create", False)),
        "can_edit": _bool_value(field_from_source(source, "can_edit", False)),
        "can_delete": _bool_value(field_from_source(source, "can_delete", False)),
        "can_share": _bool_value(field_from_source(source, "can_share", False)),
        "can_view_history": _bool_value(field_from_source(source, "can_view_history", False)),
        "can_reply": _bool_value(field_from_source(source, "can_reply", False)),
    }


def _reply_summary_payload(source: object) -> dict[str, object]:
    reply_count = safe_int(field_from_source(source, "reply_count", 0))
    return {
        "reply_count": 0 if reply_count is None else reply_count,
        "latest_reply_at": field_from_source(source, "latest_reply_at", None),
    }


def _author_summary_payload(source: object) -> dict[str, object]:
    return {
        "author_ref": str(field_from_source(source, "author_ref", "") or "").strip() or None,
        "display_name": str(field_from_source(source, "display_name", "") or "").strip() or None,
    }


def build_album_note_payload(source: object, *, album_ref: object = None) -> dict[str, object]:
    note_source = field_from_source(source, "album_note", None)
    if not isinstance(note_source, dict):
        note_source = {}
    allowed_actions = _allowed_actions_payload(
        field_from_source(note_source, "allowed_actions", {}) or {}
    )
    reply_summary = _reply_summary_payload(
        field_from_source(note_source, "reply_summary", {}) or {}
    )
    note_ref = str(field_from_source(note_source, "note_ref", "") or "").strip() or None
    body = field_from_source(note_source, "body", None)
    return {
        "album_ref": _normalized_album_ref(field_from_source(note_source, "album_ref", None), album_ref),
        "note_ref": note_ref,
        "is_present": _bool_value(field_from_source(note_source, "is_present", bool(note_ref or body))),
        "visibility": str(field_from_source(note_source, "visibility", "private") or "private").strip() or "private",
        "body": body,
        "updated_at": field_from_source(note_source, "updated_at", None),
        "revision_count": safe_int(field_from_source(note_source, "revision_count", 0)) or 0,
        "reply_summary": reply_summary,
        "allowed_actions": allowed_actions,
    }


def build_visible_album_notes_payload(source: object, *, album_ref: object = None) -> list[dict[str, object]]:
    raw_notes = field_from_source(source, "visible_album_notes", [])
    payload: list[dict[str, object]] = []
    for note in raw_notes or []:
        if not isinstance(note, dict):
            continue
        payload.append({
            "note_ref": str(note.get("note_ref") or "").strip() or None,
            "album_ref": _normalized_album_ref(note.get("album_ref"), album_ref),
            "visibility": str(note.get("visibility") or "server_shared").strip() or "server_shared",
            "body_preview": note.get("body_preview"),
            "updated_at": note.get("updated_at"),
            "author_summary": _author_summary_payload(note.get("author_summary", {}) or {}),
            "reply_summary": _reply_summary_payload(note.get("reply_summary", {}) or {}),
            "allowed_actions": _allowed_actions_payload(note.get("allowed_actions", {}) or {}),
        })
    return payload
