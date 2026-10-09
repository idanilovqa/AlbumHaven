import asyncio
from types import SimpleNamespace

from music_app.routes import api_wave_a_asgi_routes as routes
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route


class RequestStub:
    def __init__(self, payload):
        self._payload = payload
        self.app = SimpleNamespace(state=SimpleNamespace(config={}))

    async def json(self):
        return self._payload


def _actions(**values):
    return SimpleNamespace(as_payload=lambda: values)


def test_folder_files_route_requires_path_read(monkeypatch):
    monkeypatch.setattr(
        routes,
        "allowed_actions_for_request",
        lambda *_args: _actions(**{"library.files.edit_tags": True, "library.paths.read": False}),
    )
    response = asyncio.run(routes.tag_editor_folder_files(RequestStub({})))
    assert response.status_code == 403


def test_folder_files_route_validates_source_and_returns_service_payload(monkeypatch):
    source = "C:/Music/Album/one.mp3"
    album = {"tracks": [{"path": source}]}
    monkeypatch.setattr(
        routes,
        "allowed_actions_for_request",
        lambda *_args: _actions(**{"library.files.edit_tags": True, "library.paths.read": True}),
    )
    monkeypatch.setattr(
        routes,
        "load_tag_editor_folder_files",
        lambda _config, path, *, indexed_paths: {
            "folder_path": "C:/Music/Album",
            "tracks": [{"path": path, "title": "One"}],
        },
    )

    response = asyncio.run(routes.tag_editor_folder_files(
        RequestStub({"source_path": source, "album": album})
    ))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert b'"folder_path":"C:/Music/Album"' in response.body


def test_folder_files_route_has_edit_capability_and_csrf_boundary():
    assert private_action_for_route("POST", "/utilities/tag-editor/folder-files") == "library.files.edit_tags"
    assert csrf_mode_for_route("POST", "/utilities/tag-editor/folder-files") == "session_header"
