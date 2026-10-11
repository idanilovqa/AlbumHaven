import asyncio
from types import SimpleNamespace

from music_app.routes import api_wave_a_asgi_routes as routes
from music_app.services.private_route_boundary import csrf_mode_for_route, private_action_for_route


class RequestStub:
    def __init__(self, payload, *, config=None, library_state=None):
        self._payload = payload
        self.app = SimpleNamespace(
            state=SimpleNamespace(
                config=config or {},
                library_state=library_state or {"albums": []},
            )
        )

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
    album = {"key": "artist::album", "tracks": [{"path": source}]}
    monkeypatch.setattr(
        routes,
        "allowed_actions_for_request",
        lambda *_args: _actions(**{"library.files.edit_tags": True, "library.paths.read": True}),
    )
    monkeypatch.setattr(
        routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: False,
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
            RequestStub(
                {"source_path": source, "album": album},
                library_state={"albums": [album]},
            )
    ))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert b'"folder_path":"C:/Music/Album"' in response.body


def _assert_folder_files_rejects_non_authoritative_source(
    monkeypatch,
    *,
    claimed_album,
    source_path,
    authoritative_album,
    source_album=None,
):
    class FakeRepository:
        def __init__(self, _config):
            pass

        def build_album_detail_payload(self, album_key, *, client_surface_class=None):
            assert album_key == claimed_album["key"]
            return authoritative_album

        def build_album_payloads_by_track_paths(self, track_paths):
            assert track_paths == {source_path}
            return [] if source_album is None else [source_album]

    monkeypatch.setattr(
        routes,
        "allowed_actions_for_request",
        lambda *_args: _actions(
            **{"library.files.edit_tags": True, "library.paths.read": True}
        ),
    )
    monkeypatch.setattr(routes, "PostgresLibraryBrowseRepository", FakeRepository)
    monkeypatch.setattr(
        routes,
        "load_tag_editor_folder_files",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Rejected membership must not enumerate the source folder")
        ),
    )

    response = asyncio.run(
        routes.tag_editor_folder_files(
            RequestStub(
                {"source_path": source_path, "album": claimed_album},
                config={
                    "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://pytest/app",
                    "PERSISTENCE_BACKENDS": {"library_browse": "postgres"},
                },
            )
        )
    )

    assert response.status_code == 400


def test_folder_files_route_rejects_existing_source_owned_by_another_album_and_root(
    monkeypatch,
    tmp_path,
):
    claimed_source = tmp_path / "main" / "Artist" / "Claimed" / "01.flac"
    forged_source = tmp_path / "hoard" / "Other" / "Foreign" / "01.flac"
    claimed_source.parent.mkdir(parents=True)
    forged_source.parent.mkdir(parents=True)
    claimed_source.write_bytes(b"claimed")
    forged_source.write_bytes(b"forged")
    claimed_album = {
        "key": "artist::claimed",
        "tracks": [{"path": str(forged_source)}],
    }

    _assert_folder_files_rejects_non_authoritative_source(
        monkeypatch,
        claimed_album=claimed_album,
        source_path=str(forged_source),
        authoritative_album={
            "key": claimed_album["key"],
            "tracks": [{"path": str(claimed_source)}],
        },
        source_album={
            "key": "other::foreign",
            "tracks": [{"path": str(forged_source)}],
        },
    )


def test_folder_files_route_rejects_existing_source_with_stale_album_membership(
    monkeypatch,
    tmp_path,
):
    live_source = tmp_path / "main" / "Artist" / "Album" / "01.flac"
    stale_source = live_source.with_name("removed.flac")
    live_source.parent.mkdir(parents=True)
    live_source.write_bytes(b"live")
    stale_source.write_bytes(b"stale")
    claimed_album = {
        "key": "artist::album",
        "tracks": [{"path": str(stale_source)}],
    }

    _assert_folder_files_rejects_non_authoritative_source(
        monkeypatch,
        claimed_album=claimed_album,
        source_path=str(stale_source),
        authoritative_album={
            "key": claimed_album["key"],
            "tracks": [{"path": str(live_source)}],
        },
    )


def test_folder_files_route_has_edit_capability_and_csrf_boundary():
    assert private_action_for_route("POST", "/utilities/tag-editor/folder-files") == "library.files.edit_tags"
    assert csrf_mode_for_route("POST", "/utilities/tag-editor/folder-files") == "session_header"
