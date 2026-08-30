from __future__ import annotations

from types import SimpleNamespace

from music_app.services.album_note_read_seams import (
    build_album_note_payload,
    build_visible_album_notes_payload,
)


def test_build_album_note_payload_returns_viewer_scoped_default_overlay():
    payload = build_album_note_payload({}, album_ref="album-1")

    assert payload == {
        "album_ref": "album-1",
        "note_ref": None,
        "is_present": False,
        "visibility": "private",
        "body": None,
        "updated_at": None,
        "revision_count": 0,
        "reply_summary": {
            "reply_count": 0,
            "latest_reply_at": None,
        },
        "allowed_actions": {
            "can_create": False,
            "can_edit": False,
            "can_delete": False,
            "can_share": False,
            "can_view_history": False,
            "can_reply": False,
        },
    }


def test_build_visible_album_notes_payload_projects_shared_note_summaries():
    source = SimpleNamespace(
        visible_album_notes=[
            {
                "note_ref": "note-2",
                "album_ref": " album-1 ",
                "visibility": "server_shared",
                "body_preview": "Warm and tactile.",
                "updated_at": "2026-05-26T12:00:00Z",
                "author_summary": {
                    "author_ref": "user-2",
                    "display_name": "Alice",
                },
                "reply_summary": {
                    "reply_count": "3",
                    "latest_reply_at": "2026-05-27T08:30:00Z",
                },
                "allowed_actions": {
                    "can_reply": True,
                    "can_view_history": True,
                },
            },
        ],
    )

    payload = build_visible_album_notes_payload(source, album_ref="album-1")

    assert payload == [
        {
            "note_ref": "note-2",
            "album_ref": "album-1",
            "visibility": "server_shared",
            "body_preview": "Warm and tactile.",
            "updated_at": "2026-05-26T12:00:00Z",
            "author_summary": {
                "author_ref": "user-2",
                "display_name": "Alice",
            },
            "reply_summary": {
                "reply_count": 3,
                "latest_reply_at": "2026-05-27T08:30:00Z",
            },
            "allowed_actions": {
                "can_create": False,
                "can_edit": False,
                "can_delete": False,
                "can_share": False,
                "can_view_history": True,
                "can_reply": True,
            },
        },
    ]
