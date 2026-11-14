"""OCR-01: no live page or payload carries a library path where a cover is named.

The app runs in-process on an isolated, migrated Postgres library whose root lives under a
distinctive folder. Every surface that shows covers is fetched through the real middleware stack,
as the owner and as a listener, and each response is searched for the root. Track file paths are
still sent (opaque track references are the next delivery); they are the only allowed exception,
named by field below, and the list may only shrink.
"""

import json
from pathlib import Path
import re
from urllib.parse import unquote

import pytest
from PIL import Image

from music_app.services.cover_references import CoverReferenceStore
from tests.e2e.support import isolatedPostgres
from tests.py.asgi_testing import create_test_asgi_app, run_asgi_request
from tests.py.test_cover_references_postgres import as_actor, connect, member
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (fixture)
from tests.py.test_playback_native_postgres import playback_inventory  # noqa: F401 (fixture)

# Fields that still carry a track file or album folder path until opaque track references
# (Android 3, private plan opaque-track-references-plan.md). This list may only shrink.
TRACK_PATH_FIELDS = frozenset({
    "path", "src", "track_path", "trackPath", "source_path", "file_private_path", "track_ref",
    "open_directory_paths",
})
_BOOTSTRAP = re.compile(r"window\.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = (\{.*?\});\n", re.S)


def leaks(value, root: str, field: str = "") -> list[str]:
    """Each `field: value` whose string, decoded, contains the library root."""
    if isinstance(value, dict):
        # A track's `key` is its file path; any other `key` naming a library path is a leak.
        return [leak for key, item in value.items()
                if not (key == "key" and item == value.get("path"))
                for leak in leaks(item, root, str(key))]
    if isinstance(value, list):
        return [leak for item in value for leak in leaks(item, root, field)]
    if isinstance(value, str) and root in unquote(value).replace("\\\\", "\\") and field not in TRACK_PATH_FIELDS:
        return [f"{field}: {value[:160]}"]
    return []


def page_leaks(html: str, root: str) -> list[str]:
    match = _BOOTSTRAP.search(html)
    assert match, "the app page embeds its bootstrap payload"
    found = leaks(json.loads(match.group(1)), root)
    markup = html.replace(match.group(0), "")
    # Outside the bootstrap JSON, only track-path data attributes may still name a file.
    markup = re.sub(r'data-(?:src|track-path|track-row-path)="[^"]*"', "", markup)
    if root in unquote(markup).replace("&#x27;", "'"):
        found.append("page markup outside the bootstrap payload")
    return found


@pytest.fixture
def library_app(playback_inventory, tmp_path, monkeypatch):
    from music_app.services.gallery_projection_postgres import ensure_gallery_projection_ready

    fixture = playback_inventory
    folder = Path(fixture.paths[0]).parent
    cover = folder / "cover.jpg"
    Image.new("RGB", (64, 64), (30, 120, 90)).save(cover, format="JPEG")
    Image.new("RGB", (64, 32), (90, 30, 120)).save(folder / "booklet.jpg", format="JPEG")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        album_key = connection.execute(
            "update library.local_albums set cover_path = %s where library_id = %s returning album_key",
            (str(cover), fixture.actor.current_library_id),
        ).fetchone()["album_key"]
    ensure_gallery_projection_ready(fixture.config, connect=isolatedPostgres._connect)
    asgi_app = create_test_asgi_app(tmp_path, monkeypatch)
    image_extensions = asgi_app.state.config["IMAGE_EXTENSIONS"]
    asgi_app.state.config.update(fixture.config)
    asgi_app.state.config["IMAGE_EXTENSIONS"] = image_extensions
    asgi_app.state.cover_reference_store = CoverReferenceStore(fixture.config, connect=connect)
    root = str(Path(fixture.roots[0]["path"]))
    assert "Music" in root
    fixture.album_key = album_key
    return asgi_app, fixture, root


def album_payload(fixture):
    return {"key": fixture.album_key, "name": "Repair Album", "album_artist": "Owner",
            "tracks": [{"path": path} for path in fixture.paths]}


SURFACES = (
    ("GET", "/", {}),
    ("GET", "/bootstrap-data", {}),
    ("GET", "/view-data", {"surface": "albums"}),
    ("GET", "/view-data", {"surface": "albums", "q": "Repair"}),
    ("GET", "/view-data", {"artist": "Owner"}),
    ("GET", "/home-data", {}),
    ("GET", "/utilities/problematic-files", {}),
    ("GET", "/utilities/loops", {}),
)


@pytest.mark.parametrize("viewer", ["owner", "listener"])
def test_no_cover_surface_names_a_library_path(library_app, viewer):
    asgi_app, fixture, root = library_app
    actor = fixture.actor if viewer == "owner" else member(
        fixture, "app.shell.read", "app.bootstrap.read", "library.browse.read", "library.artwork.read",
        "library.media.read",
    )
    as_actor(asgi_app, actor)
    found = {}
    for method, route, query in (*SURFACES, ("GET", "/album-details", {"album_key": fixture.album_key})):
        status, headers, body = run_asgi_request(asgi_app, method, route, query=query)
        if status in {401, 403} and viewer == "listener":
            continue
        assert status == 200, (route, query, status, body[:300])
        text = body.decode("utf-8")
        if headers.get("content-type", "").startswith("text/html"):
            found[route] = page_leaks(text, root)
            # Startup cards and their inline handlers read the name the page receives.
            assert "data-cover-path" not in text and "data-cover-ref=" in text, route
        else:
            found[f"{route}?{query}"] = leaks(json.loads(text), root)
        assert "music_dir" not in text and "cover_path" not in text and "/cover?path=" not in text, route
    if viewer == "owner":
        status, _headers, body = run_asgi_request(
            asgi_app, "POST", "/utilities/cover-lookup/gallery", json_body={"album": album_payload(fixture)},
        )
        assert status == 200, body[:300]
        found["cover lookup gallery"] = leaks(json.loads(body), root)
        assert "candidate_cover_ref" in body.decode("utf-8")

    assert {surface: sorted({leak.split(":", 1)[0] for leak in paths}) for surface, paths in found.items() if paths} == {}


def test_a_reference_from_a_page_opens_the_cover_and_the_page_names_it_the_same_way_twice(library_app):
    asgi_app, fixture, _root = library_app
    as_actor(asgi_app, fixture.actor)

    pages = [run_asgi_request(asgi_app, "GET", "/bootstrap-data")[2].decode("utf-8") for _ in range(2)]
    references = [set(re.findall(r'"cover_ref":\s*"([A-Za-z0-9_-]{22})"', page)) for page in pages]

    assert references[0] and references[0] == references[1]
    reference = next(iter(references[0]))
    status, headers, _body = run_asgi_request(asgi_app, "GET", f"/cover/{reference}")
    assert status == 200 and headers["content-type"].startswith("image/")
