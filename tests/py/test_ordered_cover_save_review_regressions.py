"""Review regressions: driver types, offline references and no-op publication."""
from copy import deepcopy
from pathlib import Path
from uuid import UUID
from types import SimpleNamespace

from PIL import Image

import pytest

from music_app.routes import api_wave_d_asgi_routes as routes
from music_app.services.state import invalidate_targeted_library_projections as real_invalidate_projections
from tests.py.test_ordered_cover_save import saved, Connection, local, metadata  # noqa: F401
from tests.py.test_ordered_cover_save_asgi import api, BODY  # noqa: F401
from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401


GENERATION = "e2f769fb-83d5-4f29-8a1a-fb319023e3cd"


@pytest.fixture
def integrated_api(api, monkeypatch, tmp_path):
    """Actual route + production adapter; only actor/root/SQL transport isolated."""
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    root = tmp_path / "repository-album"
    root.mkdir()
    first, second = root / "front.jpg", root / "back.jpg"
    Image.new("RGB", (20, 20), "red").save(first)
    Image.new("RGB", (20, 20), "blue").save(second)
    connection = Connection({"album_id": 72, "cover_path": str(first),
                             "metadata": metadata(local(first), local(second, "back"))})
    connection.root_settings = {"main_library_roots": [{"path": str(tmp_path)}]}
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/review_regression",
              "IMAGE_EXTENSIONS": {".jpg"}}
    adapter = PostgresScanCacheAdapter(config, connect=lambda _: connection)
    saved = SimpleNamespace(root=root, first=first, second=second, adapter=adapter, connection=connection)
    track = saved.root / "track.flac"
    track.write_bytes(b"synthetic track")
    api.context["track_paths"] = [str(track)]
    api.app.state.library_state = {"file_cache": {str(track): {"album_id": 72, "cover_path": str(saved.first)}}}
    monkeypatch.setattr(PostgresLibraryRootSettingsStore, "load_settings",
                        lambda self, **kwargs: {"main_library_roots": [{"path": str(saved.root.parent)}]})
    def persist(config, **kwargs):
        return saved.adapter.persist_ordered_cover_selection(**kwargs)
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", persist)
    return api, saved, track


@pytest.mark.parametrize("request_generation", [GENERATION, UUID(GENERATION).hex, GENERATION.upper()])
def test_real_psycopg_uuid_generation_row_can_select_remote_candidate(saved, request_generation):
    # psycopg returns PostgreSQL uuid columns as UUID, not a JSON string.
    saved.connection.snapshot = {"search_generation": UUID(GENERATION), "candidates": [
        {"id": "candidate", "url": "https://images.example.test/front.jpg", "art_kind": "cover"}]}
    result = saved.save(references=[{"kind": "remote", "candidate_id": "candidate", "candidate_generation": request_generation}])
    selected = result["selected_covers"][0]
    assert selected["candidate_generation"] == GENERATION
    assert isinstance(selected["candidate_generation"], str)
    assert selected["url"] == "https://images.example.test/front.jpg"
    assert result["changed"] is True
    assert saved.connection.commits == 1


@pytest.mark.parametrize("replayed,stale_runtime,recover_explicit", [(False, False, False), (True, False, False), (True, False, True), (True, True, True)])
def test_noop_and_replay_preserve_scan_lifecycle_while_reconciling_primary(api, monkeypatch, replayed, stale_runtime, recover_explicit):
    state = api.app.state.library_state
    canonical = str(Path(api.context["track_paths"][0]).parent / "missing-front.jpg")
    entry = next(iter(state["file_cache"].values()))
    entry["cover_path"] = "/old/front.jpg" if stale_runtime else canonical
    entry["cover_selection_origin"] = "user" if recover_explicit and not stale_runtime else "automatic"
    if recover_explicit and not stale_runtime:
        entry["cover_selection_provenance"] = "explicit"
    prior_entry = deepcopy(entry)
    state.update(scan_generation=41, scan_in_progress=True, scan_mode="manual_full_rescan",
                 scan_current_path="/synthetic/scanning/track.flac", scan_outcome="running",
                 active_scan_preview_state={"generation": 41, "albums": ["prepared"]},
                 scan_committed_generation=40)
    lifecycle = {key: deepcopy(value) for key, value in state.items() if key != "file_cache"}
    def persist(config, **kwargs):
        result = {"selected_covers": [{"selection_id": "front", "kind": "local", "path": canonical}],
                  "selected_covers_revision": 3, "changed": False, "replayed": replayed,
                  "inventory_mutation_revision": 9, "replay_publication_required": recover_explicit}
        def commit():
            api.calls.append(("commit", {}))
            return result
        kwargs["commit_guard"](commit)
        return result
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", persist)
    status, body = api.request()
    assert status == 200 and body["changed"] is False and body["replayed"] is replayed
    assert {key: state.get(key) for key in lifecycle} == lifecycle
    assert "cover_selection_interrupted_scan_mode" not in state
    current_entry = next(iter(state["file_cache"].values()))
    assert current_entry["cover_path"] == canonical
    if not stale_runtime:
        assert current_entry == prior_entry
        if not replayed:
            assert not any(name == "invalidate" for name, _ in api.calls)


@pytest.mark.parametrize("missing_root", [False, True])
def test_offline_album_can_save_retained_ids_with_zero_existing_track_files(api, missing_root):
    track = Path(api.context["track_paths"][0])
    track.unlink()
    if missing_root:
        track.parent.rmdir()
    status, body = api.request()
    assert status == 200 and body["selected_covers_revision"] == 4
    assert any(name == "commit" for name, _ in api.calls)
    assert not track.exists()


def test_offline_retained_repository_reorder_and_replay_need_no_album_folder(saved):
    saved.first.unlink()
    saved.second.unlink()
    saved.root.rmdir()
    saved.connection.root_settings = None
    first = saved.save(album_root=None)
    replay = saved.save(album_root=None)
    assert first["changed"] is True and first["selected_covers_revision"] == 4
    assert [item["selection_id"] for item in first["selected_covers"]] == ["back", "front"]
    assert replay["replayed"] is True and replay["selected_covers"] == first["selected_covers"]
    assert saved.connection.events.count("persist") == 1
    assert "roots" not in saved.connection.events
    assert not saved.root.exists()


def test_offline_new_local_selector_still_requires_current_source_and_root(integrated_api):
    api, saved, track = integrated_api
    before = deepcopy(saved.connection.saved)
    track.unlink()
    status, _ = api.request({**BODY, "references": [{"kind": "local", "path": str(track.parent / "missing.jpg")}]})
    assert status == 404
    assert saved.connection.commits == 0 and saved.connection.saved == before
    assert not any(name == "invalidate" for name, _ in api.calls)


def test_offline_lost_response_new_local_selector_replays_without_source_bytes(integrated_api):
    api, saved, track = integrated_api
    payload = {**BODY, "references": [{"kind": "local", "path": str(saved.second)}]}
    first_status, first = api.request(payload)
    assert first_status == 200 and first["changed"] is True
    track.unlink()
    saved.first.unlink()
    saved.second.unlink()
    saved.root.rmdir()
    status, replay = api.request(payload)
    assert status == 200 and replay["replayed"] is True and replay["changed"] is False
    assert replay["selected_covers"] == first["selected_covers"]
    assert saved.connection.events.count("persist") == 1
    assert not saved.root.exists()


def test_mixed_retained_id_and_new_same_local_source_returns_422(integrated_api):
    api, saved, _ = integrated_api
    before = deepcopy(saved.connection.saved)
    status, _ = api.request({**BODY, "references": [
        {"selection_id": "front"}, {"kind": "local", "path": str(saved.first)}]})
    assert status == 422
    assert saved.connection.commits == 0 and saved.connection.saved == before
    assert not any(name == "invalidate" for name, _ in api.calls)


@pytest.mark.parametrize("references", [
    [{"selection_id": "front"}, {"selection_id": "front"}],
    [{"kind": "local", "path": "/fixture/front.jpg"}, {"kind": "local", "path": "/fixture/./front.jpg"}],
    [{"kind": "remote", "candidate_id": "candidate", "candidate_generation": GENERATION}] * 2,
])
def test_duplicate_selectors_are_malformed_422_before_repository(api, references):
    status, _ = api.request({**BODY, "references": references})
    assert status == 422
    assert not any(name in {"save", "commit", "invalidate"} for name, _ in api.calls)


def test_noop_then_replay_preserves_ambiguous_provenance_through_real_adapter(integrated_api):
    api, saved, _ = integrated_api
    saved.connection.saved["metadata"]["cover_selection_origin"] = "automatic"
    state = api.app.state.library_state
    entry = next(iter(state["file_cache"].values()))
    entry["cover_selection_origin"] = "automatic"
    state.update(scan_generation=41, scan_in_progress=True, scan_mode="background",
                 active_scan_preview_state={"albums": ["uncommitted preview"]})
    before = deepcopy(state)
    payload = {**BODY, "references": [{"selection_id": "front"}, {"selection_id": "back"}]}
    first_status, first = api.request(payload)
    assert not any(name == "invalidate" for name, _ in api.calls)
    replay_status, replay = api.request(payload)
    assert first_status == replay_status == 200
    assert first["changed"] is False and replay["replayed"] is True
    assert state == before
    assert saved.connection.saved["metadata"]["cover_selection_origin"] == "automatic"
    assert "cover_selection_provenance" not in saved.connection.saved["metadata"]
    assert saved.connection.saved["metadata"]["selected_covers_revision"] == 3
    assert "revision" not in saved.connection.events


def test_existing_state_commit_callers_still_supersede_active_scan_by_default():
    state = {"scan_generation": 8, "scan_in_progress": True, "scan_mode": "manual_full_rescan",
             "active_scan_preview_state": {"pending": True}, "scan_committed_generation": 7}
    sentinel = object()
    result = routes.state_service.run_authoritative_cover_commit_for_state(state, lambda: sentinel)
    assert result is sentinel
    assert state["scan_generation"] == 9 and state["scan_in_progress"] is False
    assert state["scan_mode"] == "idle" and state["scan_outcome"] == "cancelled"
    assert state["cover_selection_interrupted_scan_mode"] == "manual_full_rescan"
    assert "active_scan_preview_state" not in state and "scan_committed_generation" not in state


def test_changed_reference_save_supersedes_active_scan_exactly_once(api):
    state = api.app.state.library_state
    state.update(scan_generation=8, scan_in_progress=True, scan_mode="manual_full_rescan",
                 active_scan_preview_state={"pending": True}, scan_committed_generation=7)
    status, body = api.request()
    assert status == 200 and body["changed"] is True
    assert state["scan_generation"] == 9 and state["scan_in_progress"] is False
    assert state["scan_mode"] == "idle" and state["scan_outcome"] == "cancelled"
    assert "active_scan_preview_state" not in state and "scan_committed_generation" not in state
    assert len([name for name, _ in api.calls if name == "commit"]) == 1


@pytest.mark.parametrize("uncertain", [False, True])
def test_commit_exception_leaves_scan_intact_and_does_not_publish(api, monkeypatch, uncertain):
    from music_app.services.cover_mutation import CoverMutationCommitUncertainError, CoverMutationEffect
    state = api.app.state.library_state
    state.update(scan_generation=8, scan_in_progress=True, scan_mode="background",
                 active_scan_preview_state={"pending": True})
    before = deepcopy(state)
    def persist(config, **kwargs):
        def fail_commit():
            if uncertain:
                raise CoverMutationCommitUncertainError(CoverMutationEffect())
            raise RuntimeError("isolated commit failure")
        kwargs["commit_guard"](fail_commit)
    monkeypatch.setattr(routes, "persist_ordered_cover_selection_for_config", persist)
    status, body = api.request()
    assert status == 503
    assert state == before
    if uncertain:
        assert body["persisted"] is None
    assert not any(name == "invalidate" for name, _ in api.calls)


@pytest.mark.parametrize("scenario", ["primary-change", "secondary-order", "absent-runtime"])
def test_same_uuid_replay_repairs_failed_postcommit_projection_invalidation(integrated_api, monkeypatch, scenario):
    from music_app.services import problematic_albums, utility_rules
    api, saved, _ = integrated_api
    state = api.app.state.library_state
    problematic_key = problematic_albums._PROBLEMATIC_ALBUMS_CACHE_KEY
    rules_key = utility_rules._UTILITY_RULES_CACHE_KEY
    state[problematic_key] = {"album": "stale primary projection"}
    state[rules_key] = {"album": "stale primary projection"}
    state["_view_payload_root_browse_cache"] = {"album": "stale primary projection"}
    schedules, invalidations = [], []
    def invalidate(*args, **kwargs):
        invalidations.append("attempt")
        if len(invalidations) == 1:
            raise RuntimeError("isolated projection invalidation failure")
        return real_invalidate_projections(*args, **kwargs)
    monkeypatch.setattr(routes.state_service, "schedule_gallery_projection_refresh", lambda config: schedules.append("scheduled"))
    monkeypatch.setattr(routes.state_service, "invalidate_targeted_library_projections", invalidate)
    references = [{"selection_id": "back"}, {"selection_id": "front"}]
    expected_primary = str(saved.second)
    if scenario == "secondary-order":
        third = saved.root / "booklet.jpg"
        Image.new("RGB", (20, 20), "green").save(third)
        saved.connection.saved["metadata"]["selected_covers"].append(local(third, "booklet"))
        references = [{"selection_id": "front"}, {"selection_id": "booklet"}, {"selection_id": "back"}]
        expected_primary = str(saved.first)
    elif scenario == "absent-runtime":
        state["file_cache"] = {}
    payload = {**BODY, "references": references}
    status, body = api.request(payload)
    assert status == 503 and body["persisted"] is True
    assert saved.connection.saved["metadata"]["selected_covers_revision"] == 4
    if scenario == "absent-runtime":
        assert state["file_cache"] == {}
    else:
        assert next(iter(state["file_cache"].values()))["cover_path"] == expected_primary
    assert state["_view_payload_root_browse_cache"] == {"album": "stale primary projection"}
    assert state["scan_generation"] == 1
    # A new scan can start after the first commit. Replay must repair the
    # unfinished invalidation without cancelling this unrelated new scan.
    state.update(scan_generation=2, scan_in_progress=True, scan_mode="background",
                 active_scan_preview_state={"generation": 2, "pending": True})
    lifecycle = {key: deepcopy(state[key]) for key in (
        "scan_generation", "scan_in_progress", "scan_mode", "active_scan_preview_state")}
    status, replay = api.request(payload)
    assert status == 200 and replay["replayed"] is True and replay["changed"] is False
    assert problematic_key not in state and rules_key not in state
    assert state["_view_payload_root_browse_cache"] == {}
    assert {key: state[key] for key in lifecycle} == lifecycle
    assert saved.connection.events.count("persist") == 1
    assert len(invalidations) == 2 and len(schedules) == 1
    # Idempotent refresh on another replay is allowed; database mutation and
    # scan lifecycle remain exact, and repaired projections stay canonical.
    assert api.request(payload)[0] == 200
    assert state["_view_payload_root_browse_cache"] == {}
    assert {key: state[key] for key in lifecycle} == lifecycle
    assert saved.connection.saved["metadata"]["selected_covers_revision"] == 4
    assert saved.connection.events.count("persist") == 1
