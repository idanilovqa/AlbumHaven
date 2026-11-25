"""Owner (2026-11-24): deleting the selected local image removes that picture everywhere.

A local selection is served from the app's copy in the album folder's cover.jpg. Deleting the selected file
replaces that copy with the next selected card (the one the lookup names), keeping no backup of the deleted
picture, and records the next card as the selected source. When no image remains, the copy is removed and the
selection cleared. Generated images and a throwaway database only.
"""
import asyncio
import hashlib
import io
import json
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace

from PIL import Image, ImageDraw

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401


class _Logger:
    handlers = ()
    propagate = False

    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None


def _jpeg(fill, edge=320):
    image = Image.new("RGB", (edge, edge), "white")
    ImageDraw.Draw(image).rectangle((edge // 4, edge // 4, edge * 3 // 4, edge * 3 // 4), fill=fill)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()


def _album(fixture, *images):
    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track = fixture.entry("Owner/Chosen/01.flac", album="Chosen Album")
    folder = Path(track["path"]).parent
    files = {}
    for name, fill in images:
        files[name] = folder / name
        files[name].write_bytes(_jpeg(fill))
    fixture.seed(track)
    config = {**fixture.config, "IMAGE_EXTENSIONS": {".jpg"}}
    entries = PostgresLibraryBrowseRepository(config).build_track_file_entries_by_paths({track["path"]})
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute(
            "select id, album_key from library.local_albums where title = 'Chosen Album'"
        ).fetchone()
    state = {"file_cache": entries, "albums": build_albums_from_file_cache(entries, set()),
             "cover_generation": 0, "scan_generation": 0}
    return SimpleNamespace(config=config, folder=folder, files=files, track_paths={track["path"]}, row=row,
                           state=state, setup_url=fixture.setup_url)


def _context(album):
    from music_app.services.cover_workflow import CoverAlbumContext

    return CoverAlbumContext(album_root=album.folder, track_paths=set(album.track_paths))


def _select(album, source):
    from music_app.routes import api_wave_d_asgi_routes as routes

    inventory = asyncio.run(routes._selected_cover_inventory_state(album.config, album.state, album.track_paths))
    response = routes._utilities_cover_lookup_local_select_response(
        inventory, _context(album), {"key": album.row["album_key"]}, album.config, str(source),
        _Logger(), album.state, None, perf_counter(),
    )
    assert response.status_code == 200, response.body


def _delete(album, monkeypatch, source, next_card=None):
    """The real delete route; only request parsing, album resolution and the inventory worker are supplied."""
    from music_app.routes import api_wave_d_asgi_routes as routes

    async def payload(_request):
        return {"album": {"key": album.row["album_key"]}, "source_path": str(source),
                **({"next_cover_path": str(next_card)} if next_card else {})}

    async def album_context(_config, value, **_kwargs):
        return value, _context(album)

    async def no_history_scope(_request, **_kwargs):
        return None

    monkeypatch.setattr(routes, "_json_payload", payload)
    monkeypatch.setattr(routes, "_app_config", lambda _request: album.config)
    monkeypatch.setattr(routes, "_resolve_album_payload_context", album_context)
    monkeypatch.setattr(routes, "_library_state", lambda _request: album.state)
    monkeypatch.setattr(routes, "_app_logger", lambda _request: _Logger())
    monkeypatch.setattr(routes, "history_scope_for_request", no_history_scope)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()), state=SimpleNamespace(current_actor=None))
    response = asyncio.run(routes.utilities_cover_lookup_local_delete(request))
    return response.status_code, json.loads(response.body)


def _stored(album):
    with isolatedPostgres._connect(album.setup_url) as connection:
        return connection.execute(
            """select cover_path, metadata ->> 'cover_revision' as revision,
                      metadata ->> 'selected_local_cover_source_path' as source
               from library.local_albums where id = %s""",
            (album.row["id"],),
        ).fetchone()


def test_live_deleting_the_selected_image_replaces_the_app_copy_with_the_next_card(watcher_repair_inventory, monkeypatch):
    album = _album(watcher_repair_inventory, ("front.jpg", "navy"), ("back.jpg", "orange"), ("large.jpg", "green"))
    front, back = album.files["front.jpg"], album.files["back.jpg"]
    copy = album.folder / "cover.jpg"
    _select(album, front)
    assert copy.read_bytes() == front.read_bytes(), "the selection is served from the app's copy"
    deleted_bytes = front.read_bytes()

    status, payload = _delete(album, monkeypatch, front, next_card=back)

    assert status == 200, payload
    assert not front.exists()
    assert copy.read_bytes() == back.read_bytes(), "the copy now holds the next card"
    assert not list(album.folder.glob("cover-existing-*.jpg")), "no backup keeps the deleted picture"
    assert all(path.read_bytes() != deleted_bytes for path in album.folder.glob("*.jpg")), "the picture is gone"
    stored = _stored(album)
    assert Path(stored["source"]) == back
    assert Path(stored["cover_path"]) == copy
    assert stored["revision"] == hashlib.sha256(back.read_bytes()).hexdigest()
    assert Path(payload["updated_album"]["cover_path"]) == copy
    assert payload["gallery"]["selected_source_cover_path"] == str(back)


def test_live_deleting_the_only_selected_image_removes_the_copy_and_clears_the_selection(
    watcher_repair_inventory, monkeypatch,
):
    album = _album(watcher_repair_inventory, ("front.jpg", "navy"))
    front = album.files["front.jpg"]
    copy = album.folder / "cover.jpg"
    _select(album, front)
    assert copy.is_file()

    status, payload = _delete(album, monkeypatch, front)

    assert status == 200, payload
    assert not front.exists() and not copy.exists()
    assert not list(album.folder.glob("*.jpg"))
    stored = _stored(album)
    assert stored["cover_path"] is None and stored["source"] is None
