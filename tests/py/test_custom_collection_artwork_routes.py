import base64
import io

from PIL import Image

from tests.py.asgi_testing import create_test_asgi_app, decode_json, run_asgi_request


def jpeg_data_url() -> str:
    output = io.BytesIO()
    Image.new("RGB", (48, 32), (12, 34, 56)).save(output, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")


class Repository:
    saved = []
    deleted = []

    def __init__(self, _config):
        pass

    def load(self, *, library_id, collection_name):
        return {
            "collection_name": collection_name,
            "revision": 3,
            "content_sha256": "a" * 64,
            "width": 48,
            "height": 32,
            "filename": "night.jpg",
            "updated_at": "now",
        }

    def load_image(self, *, library_id, collection_name):
        return {
            "image_bytes": b"jpeg-bytes",
            "content_type": "image/jpeg",
            "content_sha256": "a" * 64,
            "revision": 3,
        }

    def save(self, **kwargs):
        self.saved.append(kwargs)
        return self.load(
            library_id=kwargs["library_id"],
            collection_name=kwargs["collection_name"],
        )

    def delete(self, **kwargs):
        self.deleted.append(kwargs)
        return True


def test_collection_artwork_routes_are_library_scoped_and_path_free(tmp_path, monkeypatch):
    import music_app.routes.api_wave_d_asgi_routes as routes

    Repository.saved.clear()
    Repository.deleted.clear()
    monkeypatch.setattr(routes, "CustomCollectionArtworkRepository", Repository, raising=False)
    app = create_test_asgi_app(tmp_path, monkeypatch)

    status, _headers, body = run_asgi_request(
        app,
        "GET",
        "/api/custom-collections/artwork",
        query={"collection_name": "Night"},
    )
    payload = decode_json(body)
    assert status == 200
    assert payload["artwork"]["image_url"].startswith("/api/custom-collections/artwork/image?")
    assert "path" not in str(payload).lower()

    status, headers, body = run_asgi_request(
        app,
        "GET",
        "/api/custom-collections/artwork/image",
        query={"collection_name": "Night", "revision": 3},
    )
    assert status == 200
    assert headers["content-type"] == "image/jpeg"
    assert body == b"jpeg-bytes"

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        "/api/custom-collections/artwork",
        json_body={
            "collection_name": "Night",
            "data_url": jpeg_data_url(),
            "filename": "night.png",
        },
    )
    assert status == 200
    assert decode_json(body)["artwork"]["revision"] == 3
    assert Repository.saved[-1]["library_id"] == 1
    assert Repository.saved[-1]["account_id"] == 1
    assert Repository.saved[-1]["width"] == 48
    assert Repository.saved[-1]["height"] == 32

    status, _headers, body = run_asgi_request(
        app,
        "DELETE",
        "/api/custom-collections/artwork",
        json_body={"collection_name": "Night"},
    )
    assert status == 200
    assert decode_json(body) == {"ok": True, "deleted": True}
    assert Repository.deleted == [{"library_id": 1, "collection_name": "Night"}]


def test_collection_artwork_link_extract_and_remote_save_are_bounded_and_path_free(tmp_path, monkeypatch):
    import music_app.routes.api_wave_d_asgi_routes as routes
    from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS

    Repository.saved.clear()
    assert _PRIVATE_ROUTE_ACTIONS[("POST", "/api/custom-collections/artwork/extract")] == "library.covers.link"
    assert _PRIVATE_ROUTE_ACTIONS[("POST", "/api/custom-collections/artwork/remote")] == "library.covers.link"
    monkeypatch.setattr(routes, "CustomCollectionArtworkRepository", Repository, raising=False)
    extracted = []

    def extract(urls, **kwargs):
        extracted.append((urls, kwargs))
        return [{
            "id": "manual-1",
            "url": "https://images.example/night.jpg",
            "thumbnail_url": "https://images.example/night-small.jpg",
            "source": "manual",
            "width": 640,
            "height": 640,
            "path": r"N:\\Music\\must-not-leak.jpg",
        }]

    monkeypatch.setattr(routes, "add_manual_cover_candidates_from_urls", extract)
    monkeypatch.setattr(routes, "fetch_remote_cover_bytes", lambda *_args, **_kwargs: (base64.b64decode(jpeg_data_url().split(",", 1)[1]), "image/jpeg"))
    app = create_test_asgi_app(tmp_path, monkeypatch)

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        "/api/custom-collections/artwork/extract",
        json_body={"collection_name": "Night", "urls": ["https://example.test/album"]},
    )
    payload = decode_json(body)
    assert status == 200
    assert payload["candidates"] == [{
        "id": "manual-1",
        "url": "https://images.example/night.jpg",
        "thumbnail_url": "https://images.example/night-small.jpg",
        "source": "manual",
        "width": 640,
        "height": 640,
    }]
    assert "must-not-leak" not in body.decode("utf-8")
    assert extracted[0][0] == ["https://example.test/album"]

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        "/api/custom-collections/artwork/remote",
        json_body={"collection_name": "Night", "url": "https://images.example/night.jpg"},
    )
    assert status == 200
    assert decode_json(body)["artwork"]["revision"] == 3
    assert Repository.saved[-1]["collection_name"] == "Night"
    assert Repository.saved[-1]["filename"] == "collection-cover.jpg"


def test_collection_artwork_rejects_invalid_image_stale_revision_and_missing_collection(tmp_path, monkeypatch):
    import music_app.routes.api_wave_d_asgi_routes as routes

    monkeypatch.setattr(routes, "CustomCollectionArtworkRepository", Repository, raising=False)
    app = create_test_asgi_app(tmp_path, monkeypatch)

    status, _headers, _body = run_asgi_request(
        app,
        "GET",
        "/api/custom-collections/artwork/image",
        query={"collection_name": "Night", "revision": "999"},
    )
    assert status == 404

    status, _headers, _body = run_asgi_request(
        app,
        "POST",
        "/api/custom-collections/artwork",
        json_body={"collection_name": "Night", "data_url": "data:text/plain;base64,AA=="},
    )
    assert status == 400

    class MissingCollectionRepository(Repository):
        def save(self, **_kwargs):
            raise ValueError("Custom collection does not exist in this library.")

    monkeypatch.setattr(routes, "CustomCollectionArtworkRepository", MissingCollectionRepository)
    status, _headers, body = run_asgi_request(
        app,
        "POST",
        "/api/custom-collections/artwork",
        json_body={"collection_name": "Missing", "data_url": jpeg_data_url()},
    )
    assert status == 400
    assert "does not exist" in decode_json(body)["error"]
