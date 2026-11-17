"""Native entrypoint preflight contracts with isolated repository and media doubles."""
import asyncio
import json
from pathlib import Path
from threading import RLock
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from music_app.routes import api_wave_d_asgi_routes as routes
from music_app.services import cover_lookup_runtime as runtime
from music_app.services import cover_refresh_execution as refresh
from music_app.services.cover_provider_candidates import SelectedRemoteImage
from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict
from music_app.services.cover_mutation import CoverMutationEffect
from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401


def forbidden(*args, **kwargs):
    pytest.fail("Ordered selection reached a media or task mutation before preflight")


def guard(monkeypatch, module, calls, *, reject=True):
    def check(*, _record=True, **kwargs):
        if _record:
            calls.append(kwargs)
        if reject:
            raise OrderedCoverSelectionConflict("Reload the full cover selection.")
        return {"album_id": 72, "cover_path": None, "metadata": {}}
    def mutate(config, **kwargs):
        check_args = {"track_paths": kwargs["track_paths"]}
        if kwargs.get("allow_ordered_selection"):
            check_args["deleting_source_path"] = kwargs["affected_paths"][0]
        # Keep the original preflight call log; revalidation is a separate
        # boundary operation with the same rejection policy.
        scope = check(_record=not calls, **check_args)
        if kwargs.get("reserve_variant_bytes") is not None:
            scope["reserved_cover_variant_path"] = None
        effect = kwargs["mutate"](scope)
        assert isinstance(effect, CoverMutationEffect)
        if effect.selection is not None:
            config.get("_TEST_PERSIST", lambda paths: None)(kwargs["track_paths"])
        kwargs["commit_guard"](lambda: None, effect)
        if effect.complete:
            effect.complete()
        return {"value": effect.value, "selection": effect.selection}
    monkeypatch.setattr(module, "run_cover_mutation_for_config", mutate)
    adapter = SimpleNamespace(assert_legacy_cover_mutation_allowed=check)
    monkeypatch.setattr(module, "select_scan_cache_adapter", lambda config: adapter, raising=False)


@pytest.fixture
def route_context(monkeypatch, tmp_path, cover_unit_transports):
    root = tmp_path / "version-child"
    root.mkdir()
    source = root / "secondary.jpg"
    source.write_bytes(b"unchanged secondary")
    paths = {str(root / "track.flac")}
    album = {"artist": "Fixture", "album": "Child version", "key": "child", "album_id": 72}
    payload = {"album": album, "source_path": str(source), "data_url": "data:image/png;base64,AAAA",
               "task_id": "task", "candidate_id": "candidate", "snapshot_generation": "generation"}
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "", "IMAGE_EXTENSIONS": {".jpg"},
              "MUSICBRAINZ_USER_AGENT": "IsolatedTests/1.0"}
    state = {"file_cache": {path: {"album_id": 72} for path in paths}}
    async def json_payload(request):
        return payload
    async def context(*args, **kwargs):
        return album, SimpleNamespace(album_root=root, track_paths=paths)
    async def history(*args, **kwargs):
        return None
    monkeypatch.setattr(routes, "_json_payload", json_payload)
    monkeypatch.setattr(routes, "_resolve_album_payload_context", context)
    monkeypatch.setattr(routes, "history_scope_for_request", history)
    monkeypatch.setattr(routes, "_app_config", lambda request: config)
    monkeypatch.setattr(routes, "_app_logger", lambda request: None)
    monkeypatch.setattr(routes, "_library_state", lambda request: state)
    monkeypatch.setattr(routes, "validate_local_cover_source", lambda *args, **kwargs: source)
    monkeypatch.setattr(routes, "ranked_local_cover_candidates", lambda *args, **kwargs: [])
    monkeypatch.setattr(routes, "prepare_pasted_cover_bytes", lambda data: b"prepared")
    monkeypatch.setattr(routes, "decode_image_bytes", lambda data: None)
    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    return SimpleNamespace(root=root, source=source, paths=paths, payload=payload, request=request, state=state, config=config)


def test_automatic_writer_checks_before_persistence_or_promotion(monkeypatch, tmp_path):
    calls = []
    guard(monkeypatch, refresh, calls)
    paths = {str(tmp_path / "track.flac")}
    monkeypatch.setattr(refresh, "begin_prepared_remote_cover_promotion", forbidden)
    def write():
        forbidden()
    write.provisional_cover_revision = "new"
    with pytest.raises(OrderedCoverSelectionConflict):
        callback = refresh._build_automatic_cover_write_guard(config={}, folder=tmp_path, track_paths=paths)
        callback(write, cover_selection_origin="automatic")
    assert calls == [{"track_paths": paths}]


def test_recovery_checks_before_persistence_and_preserves_runtime(monkeypatch, tmp_path):
    calls = []
    guard(monkeypatch, refresh, calls)
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"synthetic cover")
    path = str(tmp_path / "track.flac")
    entry = {"album_id": 72, "cover_path": None, "cover_selection_origin": "automatic"}
    state = {"file_cache": {path: entry.copy()}}
    with pytest.raises(OrderedCoverSelectionConflict):
        refresh._recover_existing_cover_selection(
            config={}, job={"folder": str(tmp_path), "track_paths": [path]}, cover_path=cover,
            file_cache=state["file_cache"], get_state=lambda: state, library_state=state,
            cache_lock=RLock(), scan_generation=None, cover_generation=None,
        )
    assert calls == [{"track_paths": {path}}]
    assert state["file_cache"][path] == entry


def test_unrelated_local_delete_retains_existing_route_behavior(monkeypatch, route_context):
    calls, deleted = [], []
    guard(monkeypatch, routes, calls, reject=False)
    def delete(**kwargs):
        deleted.append(kwargs["source_path"])
        kwargs["source_path"].unlink()
        return CoverMutationEffect()
    async def gallery(*args, **kwargs):
        return {"local_covers": []}
    monkeypatch.setattr(routes, "delete_local_cover_effect", delete)
    monkeypatch.setattr(routes, "_serialize_cover_gallery_from_asgi", gallery)
    route_context.config["_TEST_PERSIST"] = forbidden
    response = asyncio.run(routes.utilities_cover_lookup_local_delete(route_context.request))
    assert response.status_code == 200
    assert json.loads(response.body)["ok"] is True
    assert deleted == [route_context.source]
    assert not route_context.source.exists()
    assert calls == [{"track_paths": route_context.paths, "deleting_source_path": route_context.source}]


def test_legacy_paste_preserves_write_persist_apply_order(monkeypatch, route_context):
    calls, effects = [], []
    guard(monkeypatch, routes, calls, reject=False)
    route_context.payload["task_id"] = ""
    def write(root, prepared, *, reserved_cover_variant_path):
        assert reserved_cover_variant_path is None
        assert prepared == b"prepared"
        assert len(calls) == 1
        assert calls[0]["track_paths"] == route_context.paths
        assert calls[0].get("deleting_source_path") is None
        effects.append("write")
        path = root / "cover.jpg"
        path.write_bytes(b"new fixture image")
        return SimpleNamespace(cover_path=path, promoted_cover_revision="new")
    def persist(paths):
        assert paths == route_context.paths
        effects.append("persist")
    def apply(paths, path, **kwargs):
        assert paths == route_context.paths
        effects.append("apply")
        return [], None
    monkeypatch.setattr(routes, "begin_prepared_remote_cover_promotion", write)
    monkeypatch.setattr(routes, "cover_promotion_effect", lambda promotion, **kwargs:
        CoverMutationEffect(selection={"selected_cover_path": promotion.cover_path, "cover_revision": "new"}, value=promotion.cover_path))
    routes._app_config(route_context.request)["_TEST_PERSIST"] = persist
    monkeypatch.setattr(routes, "build_problematic_album_detail_payload", lambda *args, **kwargs: None)
    monkeypatch.setattr(routes, "apply_cover_path_for_tracks", apply)
    monkeypatch.setattr(routes, "mark_cover_lookup_notifications_action_taken_for_track_paths", lambda *args, **kwargs: [])
    response = asyncio.run(routes.utilities_cover_lookup_pasted_image_save(route_context.request))
    assert response.status_code == 200
    assert effects == ["write", "persist", "apply"]
    assert (route_context.root / "cover.jpg").read_bytes() == b"new fixture image"


def test_refresh_job_conflict_cannot_fallback_to_another_cover(monkeypatch, tmp_path):
    def provider(**kwargs):
        raise OrderedCoverSelectionConflict("Reload full selection.")
    monkeypatch.setattr(refresh.cover_refresh_provider, "ensure_best_cover_for_folder", provider)
    monkeypatch.setattr(refresh, "find_cover_image", forbidden)
    monkeypatch.setattr(refresh.cover_refresh_provider, "validated_selected_cover_path", forbidden)
    cover, downloaded, detail = refresh.execute_cover_job(
        job={"folder": tmp_path, "artist": "Fixture", "album": "Version", "selected_cover_path": str(tmp_path / "front.jpg")},
        image_extensions={".jpg"}, user_agent="IsolatedTests/1.0", cover_cache=None,
        force_search=False, allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False, negative_cache_ttl_seconds=None,
    )
    assert cover is None
    assert downloaded is False
    assert detail["reason"] == "ordered_cover_selection_conflict"
    assert detail["selection_conflict"] is True


def test_refresh_job_checks_current_database_before_provider_or_media(monkeypatch, tmp_path):
    calls = []
    guard(monkeypatch, refresh, calls)
    paths = {str(tmp_path / "track.flac")}
    monkeypatch.setattr(refresh.cover_refresh_provider, "ensure_best_cover_for_folder", forbidden)
    monkeypatch.setattr(refresh, "find_cover_image", forbidden)
    cover, downloaded, detail = refresh.execute_cover_job(
        config={}, job={"folder": tmp_path, "album_id": 72, "artist": "Fixture", "album": "Version",
                        "track_paths": paths, "cover_selection_origin": "automatic"},
        image_extensions={".jpg"}, user_agent="IsolatedTests/1.0", cover_cache=None,
        force_search=True, allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False, negative_cache_ttl_seconds=None,
    )
    assert calls == [{"track_paths": paths}]
    assert cover is None
    assert downloaded is False
    assert detail["reason"] == "ordered_cover_selection_conflict"
    assert detail["selection_conflict"] is True


@pytest.mark.parametrize("kind,status,expected_error,persisted", [
    ("database", 500, "Pasted cover art could not be saved. Try again.", "absent"),
    ("filesystem", 500, "Pasted cover art could not be saved. Try again.", "absent"),
    ("late-validation", 500, "Pasted cover art could not be saved. Try again.", "absent"),
    ("conflict", 409, "Reload this album and retry the selection.", "absent"),
    ("finalization", 500, "Cover selection was persisted, but finalization failed. Reload the app.", True),
    ("uncertain", 503, "Cover save confirmation was interrupted. Reload to check the saved selection before retrying.", None),
])
def test_paste_late_boundary_errors_preserve_safe_status_without_private_diagnostics(
    monkeypatch, route_context, kind, status, expected_error, persisted,
):
    from music_app.services.cover_mutation import (
        CoverMutationCommitUncertainError, CoverMutationFinalizationError,
    )
    calls, phases = [], []
    guard(monkeypatch, routes, calls, reject=False)
    def prepare(data_url):
        phases.append("prepared")
        return b"synthetic prepared image"
    def fail_boundary(config, **kwargs):
        assert len(calls) == 1
        assert calls[0]["track_paths"] == route_context.paths
        assert calls[0].get("deleting_source_path") is None
        assert phases == ["prepared"]
        phases.append("boundary")
        if kind == "database":
            raise RuntimeError("private-diagnostic: SQL update failed for postgresql://private-account@private-host/private-db")
        if kind == "filesystem":
            raise OSError("private-diagnostic: permission denied /private/music/private-album/cover.jpg")
        if kind == "late-validation":
            raise ValueError("private-diagnostic: internal path /private/music/private-album is invalid")
        if kind == "conflict":
            raise OrderedCoverSelectionConflict(expected_error)
        effect = CoverMutationEffect()
        if kind == "finalization":
            raise CoverMutationFinalizationError(effect)
        raise CoverMutationCommitUncertainError(effect)
    monkeypatch.setattr(routes, "prepare_pasted_cover_bytes", prepare)
    monkeypatch.setattr(routes, "run_cover_mutation_for_config", fail_boundary)
    monkeypatch.setattr(routes, "begin_prepared_remote_cover_promotion", forbidden)
    monkeypatch.setattr(routes, "apply_cover_path_for_tracks", forbidden)
    response = asyncio.run(routes.utilities_cover_lookup_pasted_image_save(route_context.request))
    assert response.status_code == status
    expected = {"ok": False, "error": expected_error}
    if persisted != "absent":
        expected["persisted"] = persisted
    assert json.loads(response.body) == expected
    assert phases == ["prepared", "boundary"]
    assert b"private-" not in response.body and b"postgresql://" not in response.body
    assert route_context.source.read_bytes() == b"unchanged secondary"


def test_paste_preparation_validation_keeps_actionable_message_before_boundary(monkeypatch, route_context):
    guard(monkeypatch, routes, [], reject=False)
    def invalid(data_url):
        raise ValueError("Clipboard image must use a supported image format.")
    monkeypatch.setattr(routes, "prepare_pasted_cover_bytes", invalid)
    monkeypatch.setattr(routes, "run_cover_mutation_for_config", forbidden)
    monkeypatch.setattr(routes, "begin_prepared_remote_cover_promotion", forbidden)
    response = asyncio.run(routes.utilities_cover_lookup_pasted_image_save(route_context.request))
    assert response.status_code == 400
    assert json.loads(response.body) == {
        "ok": False, "error": "Clipboard image must use a supported image format.",
    }
