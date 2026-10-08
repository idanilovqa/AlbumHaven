from types import SimpleNamespace

import pytest

from music_app.services import state as state_service
from music_app.services.library_hydration import hydrate_library_state_from_disk
from music_app.routes import web_asgi


@pytest.mark.parametrize("operation", ["refresh_relation_views_for_state", "start_background_refresh_for_state"])
def test_shared_browse_rejects_library_writers_before_work(operation):
    config = {"SHARED_LIBRARY_BROWSE_ONLY": True}
    args = ({}, config, None) if operation.startswith("start") else ({}, config)
    with pytest.raises(RuntimeError, match="Shared browsing cannot"):
        getattr(state_service, operation)(*args)


def test_shared_browse_hydration_rejects_missing_projection_before_repair():
    with pytest.raises(RuntimeError, match="Shared browsing requires"):
        hydrate_library_state_from_disk(
            {"albums": [{"key": "album"}], "relation_views": {}},
            {"SHARED_LIBRARY_BROWSE_ONLY": True},
            ensure_relation_views=lambda *_: pytest.fail("must not repair shared projections"),
        )


@pytest.mark.parametrize("cached", [False, True])
def test_shared_browse_cover_serves_existing_without_generating(monkeypatch, tmp_path, cached):
    source = tmp_path / "cover.jpg"
    source.write_bytes(b"existing")
    preview = tmp_path / "preview.jpg"
    preview.write_bytes(b"existing preview")
    monkeypatch.setattr(web_asgi, "_app_config", lambda _: {"SHARED_LIBRARY_BROWSE_ONLY": True})
    monkeypatch.setattr(web_asgi, "configured_library_root_paths_snapshot", lambda _: [])
    monkeypatch.setattr(web_asgi, "resolve_configured_media_path", lambda *a, **k: source)
    monkeypatch.setattr(web_asgi, "find_existing_cover_display_variant", lambda *a, **k: preview if cached else None)
    monkeypatch.setattr(web_asgi, "resolve_cover_display_variant", lambda *a, **k: pytest.fail("shared browsing must not write cover previews"))
    monkeypatch.setattr(web_asgi, "_conditional_file_response", lambda request, resolved, **kwargs: resolved)
    request = SimpleNamespace(headers={})
    assert web_asgi._cover_response(request, "cover.jpg", "320") == (preview if cached else source)


@pytest.mark.parametrize("relations", [{}, {"artists": []}])
def test_shared_browse_rejects_loaded_incomplete_projection_before_publication(monkeypatch, relations):
    from music_app.services import library_hydration as hydration
    monkeypatch.setattr(hydration, "library_root_cache_identity", lambda _: "fixture-root")
    adapter = SimpleNamespace(load_snapshot_strict=lambda *args: ({"file": {}}, 1, relations, 1, None))
    state = {}
    with pytest.raises(RuntimeError, match="Shared browsing requires"):
        hydration.hydrate_library_state_from_disk(
            state, {"SHARED_LIBRARY_BROWSE_ONLY": True, "CACHE_PATH": "unused"},
            scan_cache_adapter=adapter,
        )
    assert state == {}, "invalid projection must not publish a partial library state"


@pytest.mark.parametrize("reason", ["", "source_fingerprint_changed"])
def test_shared_browse_projection_reads_healthy_and_refuses_stale_without_rebuild(monkeypatch, reason):
    from music_app.services import relation_projection_postgres as projection
    connections = []
    class Connection:
        def __enter__(self):
            connections.append(self)
            assert len(connections) == 1, "shared reader must not open a rebuild transaction"
            return self
        def __exit__(self, *args):
            pass
        def execute(self, sql):
            return SimpleNamespace(fetchone=lambda: {})
    snapshot = {"relation_views": {"artists": ["fixture"]},
                projection.RELATION_PROJECTION_METADATA_KEY: {"ready": True}}
    monkeypatch.setattr(projection, "_relation_projection_scan_cache_from_row", lambda _: snapshot)
    monkeypatch.setattr(projection, "relation_projection_readiness_stale_reason", lambda _: reason)
    config = {"SHARED_LIBRARY_BROWSE_ONLY": True, "ALBUM_HAVEN_APP_DATABASE_URL": "fixture"}
    if reason:
        with pytest.raises(RuntimeError, match="Shared browsing cannot rebuild"):
            projection.ensure_relation_projection_ready(config, connect=lambda _: Connection())
    else:
        result = projection.ensure_relation_projection_ready(config, connect=lambda _: Connection())
        assert result["startup_rebuilt"] is False
        assert result["relation_views"] == snapshot["relation_views"]
    assert len(connections) == 1


@pytest.mark.parametrize("shared", [True, False])
def test_gallery_read_preview_queue_respects_shared_browse_mode(monkeypatch, shared):
    from music_app.services import covers, library_browse_postgres as browse
    queued = []
    def queue(*args, **kwargs):
        if shared:
            pytest.fail("shared gallery reads must not enqueue media-adjacent preview writes")
        queued.append((args, kwargs))
    monkeypatch.setattr(covers, "queue_cover_display_variant_generation", queue)
    browse._queue_display_cover_variants_for_groups(
        {"SHARED_LIBRARY_BROWSE_ONLY": shared},
        [{"albums": [{"cover_path": "fixture-cover.jpg"}]}],
    )
    assert len(queued) == (0 if shared else 1)
