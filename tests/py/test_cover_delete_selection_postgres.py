"""Deleting a local image repoints the album by its selection in Postgres, not by the runtime cache.

At startup the runtime cache is empty (Postgres browse is authoritative) and a paste updates only a request-local
copy, so the cache can be empty or stale. Generated images and a throwaway database only.
"""
import asyncio
import io
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _finish_live_startup, watcher_repair_inventory  # noqa: F401

JOIN_SECONDS = 30


class _Logger:
    handlers = ()
    propagate = False

    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None


class _Case(SimpleNamespace):
    def __repr__(self):  # pytest prints arguments of failed asserts; the database URLs carry passwords
        return "<delete case>"


def _image(colour, edge):
    buffer = io.BytesIO()
    Image.new("RGB", (edge, edge), colour).save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
def case(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    track = fixture.entry("Owner/Album/01.flac", album="Album")
    folder = Path(track["path"]).parent
    covers = SimpleNamespace(current=folder / "cover.jpg", best=folder / "front.jpg", other=folder / "back.jpg")
    covers.current.write_bytes(_image("navy", 700))
    covers.best.write_bytes(_image("red", 600))
    covers.other.write_bytes(_image("green", 200))
    fixture.seed(track)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        album = connection.execute("select id, album_key from library.local_albums where title = 'Album'").fetchone()
    return _Case(
        setup_url=fixture.setup_url, config={**fixture.config, "IMAGE_EXTENSIONS": {".jpg"}}, track=track,
        paths={track["path"]}, folder=folder, covers=covers, album=album,
    )


def _select(case, cover, origin):
    from music_app.routes.api_cover_helpers import persist_cover_selection_for_tracks
    from music_app.services.cover_workflow import cover_revision_for_path

    persist_cover_selection_for_tracks(
        case.paths, cover, config=case.config, logger=_Logger(), cover_revision=cover_revision_for_path(cover),
        cover_selection_origin=origin, explicit_selection=origin == "user",
    )


def _stored(case):
    with isolatedPostgres._connect(case.setup_url) as connection:
        return dict(connection.execute(
            """select cover_path, metadata ->> 'cover_selection_origin' as origin,
                      metadata ->> 'cover_selection_provenance' as provenance,
                      metadata ->> 'cover_revision' as revision
               from library.local_albums where id = %s""",
            (case.album["id"],),
        ).fetchone())


def _runtime(case, cache, believed):
    if cache == "empty":
        return {"file_cache": {}, "albums": []}
    from music_app.services.library import build_albums_from_file_cache

    entries = {case.track["path"]: {**case.track, "album_id": case.album["id"], "cover_path": str(believed)}}
    return {"file_cache": entries, "albums": build_albums_from_file_cache(entries, set())}


def _delete(case, monkeypatch, cover, library_state):
    """The real route; only request parsing and the gallery answer are supplied."""
    from music_app.routes import api_wave_d_asgi_routes as routes

    async def payload(_request):
        return {"source_path": str(cover), "album": {
            "id": case.album["id"], "album_id": case.album["id"], "key": case.album["album_key"],
            "album_artist": "Owner", "name": "Album", "tracks": [{"path": case.track["path"]}],
        }}

    async def gallery(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(routes, "_json_payload", payload)
    monkeypatch.setattr(routes, "_app_config", lambda _request: case.config)
    monkeypatch.setattr(routes, "_app_logger", lambda _request: _Logger())
    monkeypatch.setattr(routes, "_library_state", lambda _request: library_state)
    monkeypatch.setattr(routes, "_serialize_cover_gallery_from_asgi", gallery)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    response = asyncio.run(routes.utilities_cover_lookup_local_delete(request))
    return response.status_code, json.loads(response.body)


@pytest.mark.parametrize("cache", ["empty", "stale"])
def test_live_deleting_the_current_cover_selects_the_best_remaining_one(case, cache, monkeypatch):
    _select(case, case.covers.current, "user")

    status, body = _delete(case, monkeypatch, case.covers.current, _runtime(case, cache, case.covers.other))

    assert status == 200
    assert not case.covers.current.exists()
    stored = _stored(case)
    assert stored["cover_path"] == str(case.covers.best), "the album still selects the deleted file"
    assert (stored["origin"], stored["provenance"]) == ("user", "explicit")
    assert [album["cover_path"] for album in body["updated_albums"]] == [str(case.covers.best)], (
        "the page was not told which cover replaced the deleted one")


@pytest.mark.parametrize("origin", ["user", "automatic"])
@pytest.mark.parametrize("cache", ["empty", "stale"])
def test_live_deleting_another_image_never_changes_the_selection(case, cache, origin, monkeypatch):
    _select(case, case.covers.current, origin)
    before = _stored(case)

    # A stale cache still believes the image being deleted is the album's cover.
    status, body = _delete(case, monkeypatch, case.covers.other, _runtime(case, cache, case.covers.other))

    assert status == 200
    assert not case.covers.other.exists()
    assert _stored(case) == before, "deleting an image that isn't selected replaced the user's current selection"
    assert body["updated_albums"] == []


@pytest.mark.parametrize("cache", ["empty", "stale"])
def test_live_deleting_the_last_cover_clears_the_selection(case, cache, monkeypatch):
    case.covers.best.unlink()
    case.covers.other.unlink()
    _select(case, case.covers.current, "user")

    status, _body = _delete(case, monkeypatch, case.covers.current, _runtime(case, cache, case.covers.other))

    assert status == 200
    stored = _stored(case)
    assert stored["cover_path"] is None
    assert stored["origin"] != "user"


def test_live_a_selection_saved_while_the_delete_waits_for_the_folder_wins(case, monkeypatch):
    """Lock order: folder lock, then the read of the selection, then the publication lock."""
    from music_app.services.cover_workflow import run_serialized_cover_selection

    _select(case, case.covers.other, "user")
    answers = []
    state = _runtime(case, "stale", case.covers.other)
    delete = threading.Thread(
        target=lambda: answers.append(_delete(case, monkeypatch, case.covers.other, state)), daemon=True,
    )

    def select_while_holding_the_folder():
        delete.start()
        delete.join(1.5)
        assert case.covers.other.exists(), "the delete didn't wait for the album folder's cover lock"
        _select(case, case.covers.current, "user")
        return _stored(case)

    selected = run_serialized_cover_selection(case.folder, select_while_holding_the_folder)
    delete.join(JOIN_SECONDS)

    assert not delete.is_alive(), "lock-order deadlock"
    assert [status for status, _body in answers] == [200]
    assert _stored(case) == selected, "the delete replaced a selection saved before it ran"
