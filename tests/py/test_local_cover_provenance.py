from __future__ import annotations

from music_app.services.local_cover_provenance import (
    attach_local_cover_sources,
    load_local_cover_sources,
    record_local_cover_provenance,
)

TASK = "0f8e3c1a-2b4d-4e6f-8a9b-1c2d3e4f5a6b"


class Connection:
    def __init__(self, rows=()):
        self.calls = []
        self.rows = list(rows)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        rows = self.rows
        return type("Cursor", (), {"fetchall": lambda _self: rows})()


def test_a_downloaded_cover_records_its_provider_per_file():
    # Owner 2026-11-17: a cover downloaded from a provider keeps that provider's badge.
    connection = Connection()
    record_local_cover_provenance(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"}, library_id=1,
        provenance={
            "/music/Album/cover.jpg": {"source": "discogs", "source_label": "Discogs",
                                       "lookup_task_id": TASK.replace("-", ""), "candidate_id": "c1"},
            "/music/Album/cover-2.jpg": {"source": ""},
        },
        connect=lambda _url: connection,
    )

    assert len(connection.calls) == 1
    sql, params = connection.calls[0]
    assert "local_cover_provenance_record" in sql and "on conflict (library_id, path) do update" in sql
    assert params == (1, "/music/Album/cover.jpg", "discogs", "Discogs", TASK, "c1")


def test_loading_providers_is_bounded_to_the_albums_three_covers():
    connection = Connection(rows=[{"path": "/a/cover.jpg", "source": "discogs", "source_label": "Discogs"}])
    sources = load_local_cover_sources(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"}, library_id=1,
        paths=["/a/cover.jpg", "/a/cover.jpg", "/a/2.jpg", "/a/3.jpg", "/a/4.jpg"],
        connect=lambda _url: connection,
    )

    assert sources == {"/a/cover.jpg": {"source": "discogs", "source_label": "Discogs"}}
    assert connection.calls[0][1] == (1, ["/a/cover.jpg", "/a/2.jpg", "/a/3.jpg"])


def album(*slots):
    return {"selected_covers_loaded": True, "selected_covers_album_id": 7, "selected_covers": list(slots)}


def test_album_details_local_slots_carry_their_provider_only_for_remote_readers():
    selection = {7: {"selected_covers": [
        {"selection_id": "a", "kind": "local", "path": "/a/cover.jpg"},
        {"selection_id": "b", "kind": "local", "path": "/a/own.jpg"},
        {"selection_id": "c", "kind": "remote", "url": "https://example.test/c.jpg"},
    ]}}
    calls = []

    def load_sources(_config, *, library_id, paths):
        calls.append((library_id, paths))
        return {"/a/cover.jpg": {"source": "discogs", "source_label": "Discogs"}}

    slots = [{"selection_id": "a", "kind": "local"}, {"selection_id": "b", "kind": "local"},
             {"selection_id": "c", "kind": "remote"}]
    result = attach_local_cover_sources(
        {}, album(*[dict(slot) for slot in slots]), library_id=1, remote_read_allowed=True,
        load_selection=lambda ids: selection, load_sources=load_sources,
    )
    assert result["selected_covers"] == [
        {"selection_id": "a", "kind": "local", "source": "discogs", "source_label": "Discogs"},
        {"selection_id": "b", "kind": "local"},
        {"selection_id": "c", "kind": "remote"},
    ]
    assert calls == [(1, ["/a/cover.jpg", "/a/own.jpg"])]
    # No path ever reaches the payload.
    assert "path" not in repr(result)

    unchanged = album(*[dict(slot) for slot in slots])
    assert attach_local_cover_sources(
        {}, unchanged, library_id=1, remote_read_allowed=False,
        load_selection=lambda ids: (_ for _ in ()).throw(AssertionError("no read without remote access")),
    )["selected_covers"] == slots
