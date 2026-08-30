from __future__ import annotations

from types import SimpleNamespace

from music_app.services.gallery_playback_context import build_gallery_playback_context


def test_build_gallery_playback_context_supports_future_album_top_reads():
    ordered_albums = [
        SimpleNamespace(
            key="top-1",
            tracks=[SimpleNamespace(path=r"C:\Music\Artist\Top One\01 Track.flac")],
        ),
        SimpleNamespace(
            key="top-2",
            tracks=[],
        ),
    ]

    payload = build_gallery_playback_context(
        kind="album_top",
        ordered_albums=ordered_albums,
    )

    assert payload == {
        "kind": "album_top",
        "end_behavior": "continue",
        "ordered_album_refs": ["top-1", "top-2"],
        "albums": [
            {
                "album_ref": "top-1",
                "can_play": True,
            },
            {
                "album_ref": "top-2",
                "can_play": False,
            },
        ],
    }
