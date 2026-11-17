"""Bounded-interaction contracts for entrypoints that resolve one media path.

Every request or recovery here names its media; resolving it may probe the
configured roots, never the library they hold.
"""

from __future__ import annotations

from contextlib import nullcontext
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import library_roots as library_roots_module
from music_app.services.library_roots import normalize_library_root_settings
from tests.py.asgi_testing import cover_reference_url, create_test_asgi_app, run_asgi_request
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.filesystem_operation_counting import count_filesystem_and_media

_ALBUM_TRACKS = 12


class _CountingRootSettingsStore:
    """Stands in for the Postgres root-settings store; each load is one query."""

    counts: OperationCounts | None = None
    settings: dict[str, object] = {}

    def __init__(self, _config):
        pass

    def load_settings(self, **_kwargs):
        if type(self).counts is not None:
            type(self).counts.count("sql_statements")
        return deepcopy(type(self).settings)


@pytest.fixture
def asgi_app(tmp_path, monkeypatch):
    app = create_test_asgi_app(tmp_path, monkeypatch)
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    _CountingRootSettingsStore.counts = None
    _CountingRootSettingsStore.settings = normalize_library_root_settings(
        {}, fallback_main_root=Path(app.state.config["MUSIC_DIR"]).resolve(),
    )
    monkeypatch.setattr(library_roots_module, "PostgresLibraryRootSettingsStore", _CountingRootSettingsStore)
    return app


def _use_library(asgi_app, music_dir: Path) -> None:
    _CountingRootSettingsStore.settings = normalize_library_root_settings({}, fallback_main_root=music_dir)
    asgi_app.state.config.pop(library_roots_module._CONFIGURED_ROOT_PATHS_SNAPSHOT_KEY, None)


def _seed_library(music_dir: Path, album_count: int) -> list[Path]:
    """Writes ``album_count`` sibling albums and returns the selected album's tracks."""
    for index in range(album_count):
        track = music_dir / f"Artist {index:04d}" / "Album" / "01.mp3"
        track.parent.mkdir(parents=True)
        track.write_bytes(b"track")
    selected = music_dir / "Selected Artist" / "Selected Album"
    selected.mkdir(parents=True)
    tracks = [selected / f"{number:02d}.mp3" for number in range(1, _ALBUM_TRACKS + 1)]
    for track in tracks:
        track.write_bytes(b"track")
    return tracks


def _measure_request(monkeypatch, request) -> OperationCounts:
    """Counts one warm request; the uncounted first one settles process-wide setup."""
    request()
    counts = OperationCounts()
    _CountingRootSettingsStore.counts = counts
    try:
        with count_filesystem_and_media(monkeypatch, counts):
            status = request()
    finally:
        _CountingRootSettingsStore.counts = None
    assert status in {200, 204}
    return counts


def test_track_route_contract_probes_only_the_requested_file_at_production_library_size(
    asgi_app, tmp_path, monkeypatch,
):
    def run(album_count: int) -> OperationCounts:
        music_dir = tmp_path / f"library-{album_count}"
        _use_library(asgi_app, music_dir)
        track = _seed_library(music_dir, album_count)[0]
        return _measure_request(monkeypatch, lambda: run_asgi_request(
            asgi_app, "GET", "/track", query={"path": str(track)},
        )[0])

    measure_scale_pair(
        interaction_id="py:routes/web_asgi.py#track",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 6, "open_calls": 1, "sql_statements": 1},
        growth=("stat_calls", 0),
    )


def test_waveform_route_contract_probes_only_the_requested_file_at_production_library_size(
    asgi_app, tmp_path, monkeypatch,
):
    from music_app.services.waveform_peaks import WaveformPeaksRegistry

    asgi_app.state.waveform_peaks_registry = WaveformPeaksRegistry(cache_repository=None)

    def run(album_count: int) -> OperationCounts:
        music_dir = tmp_path / f"library-{album_count}"
        _use_library(asgi_app, music_dir)
        track = _seed_library(music_dir, album_count)[0]
        return _measure_request(monkeypatch, lambda: run_asgi_request(
            asgi_app, "GET", "/playback/waveform", query={"path": str(track), "cachedOnly": "1"},
        )[0])

    measure_scale_pair(
        interaction_id="py:routes/playback_stream_asgi.py#playback_waveform",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 9, "open_calls": 0, "sql_statements": 1},
        growth=("stat_calls", 0),
    )


@pytest.mark.parametrize(("interaction_id", "by_reference"), [
    ("py:routes/web_asgi.py#cover", False),
    ("py:routes/web_asgi.py#_cover_response", False),
    ("py:routes/web_asgi.py#_legacy_cover_response", False),
    ("py:routes/web_asgi.py#cover_by_reference", True),
    ("py:routes/web_asgi.py#_referenced_cover_response", True),
])
def test_cover_route_contract_probes_only_the_requested_cover_previews_at_production_library_size(
    asgi_app, tmp_path, monkeypatch, interaction_id, by_reference,
):
    from PIL import Image

    def run(album_count: int) -> OperationCounts:
        music_dir = tmp_path / f"library-{album_count}"
        _use_library(asgi_app, music_dir)
        cover = _seed_library(music_dir, album_count)[0].with_name("cover.jpg")
        Image.new("RGB", (1200, 1200), "teal").save(cover, format="JPEG")
        for index in range(album_count):
            (music_dir / f"Artist {index:04d}" / "Album" / "cover.jpg").write_bytes(b"sibling cover")
        # Every sibling is named too, so the store holds a library-sized set of references.
        for index in range(album_count):
            cover_reference_url(asgi_app, music_dir / f"Artist {index:04d}" / "Album" / "cover.jpg")
        reference_url = cover_reference_url(asgi_app, cover)

        def request_previews() -> int:
            # A revisioned gallery preview, then an unrevisioned lookup preview.
            for query in ({"v": "a" * 64}, {}):
                if by_reference:
                    target, params = reference_url, {"size": "480", **query}
                else:
                    target, params = "/cover", {"path": str(cover), "size": "480", **query}
                status, _headers, body = run_asgi_request(asgi_app, "GET", target, query=params)
                assert status == 200
                assert Image.open(BytesIO(body)).size == (480, 480)
            return status

        return _measure_request(monkeypatch, request_previews)

    measure_scale_pair(
        interaction_id=interaction_id,
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 14, "open_calls": 2, "media_parses": 0, "sql_statements": 1},
        growth=("stat_calls", 0),
    )


@pytest.fixture
def recovery_runtime(tmp_path, monkeypatch):
    """Startup tag-edit recovery against an in-memory inventory and journal.

    Media resolution, root settings and filesystem probes are real; the
    Postgres journal, inventory snapshot and inventory writes are doubles.
    """
    from music_app.services import cache, scan_cache_persistence, tag_edit_intents_postgres

    music_dir = (tmp_path / "music").resolve()
    _CountingRootSettingsStore.counts = None
    _CountingRootSettingsStore.settings = normalize_library_root_settings({}, fallback_main_root=music_dir)
    monkeypatch.setattr(library_roots_module, "PostgresLibraryRootSettingsStore", _CountingRootSettingsStore)
    tracks = _seed_library(music_dir, 0)
    intent = {
        "id": "intent-1",
        "status": "prepared",
        "changes": [
            {
                "path": str(track),
                "old_values": {"exception_type": ""},
                "requested_values": {"exception_type": "Non-album rarity"},
            }
            for track in tracks
        ],
    }
    state = SimpleNamespace(file_cache={}, persisted=[], failed=[])

    class IntentRepository:
        def __init__(self, _config):
            pass

        def load_unfinished_intents(self, **_kwargs):
            return [deepcopy(intent)]

        def claim_unfinished_intent(self, _intent_id, **_kwargs):
            return nullcontext(deepcopy(intent))

        def complete_in_transaction(self, *_args, **_kwargs):
            pass

        def mark_recovery_failed(self, intent_id, error):
            state.failed.append((intent_id, str(error)))

    class SnapshotAdapter:
        def load_snapshot(self, _cache_path, _root_identity):
            return state.file_cache, None, {}, None, None

    monkeypatch.setattr(tag_edit_intents_postgres, "PostgresTagEditIntentRepository", IntentRepository)
    monkeypatch.setattr(scan_cache_persistence, "select_scan_cache_adapter", lambda _config: SnapshotAdapter())
    monkeypatch.setattr(
        cache, "save_cache_updates_to_disk_for_config",
        lambda _config, changed_entries, **_kwargs: state.persisted.append(set(changed_entries)),
    )

    def seed_inventory(track_count: int) -> None:
        state.file_cache = {
            str(music_dir / "Other" / f"{index:06d}.mp3"): {"path": str(music_dir / "Other" / f"{index:06d}.mp3")}
            for index in range(track_count)
        }
        state.file_cache.update({str(track): {"path": str(track), "exception_type": None} for track in tracks})
        state.persisted.clear()

    runtime = SimpleNamespace(
        config={
            "MUSIC_DIR": music_dir,
            "CACHE_PATH": tmp_path / "inert-cache.json",
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
            "PERSISTENCE_BACKENDS": {"library_roots": "postgres"},
        },
        logger=SimpleNamespace(info=lambda *_args: None, error=lambda *_args, **_kwargs: None),
    )
    return SimpleNamespace(
        runtime=runtime, tracks=tracks, intent=intent, state=state,
        seed_inventory=seed_inventory, repository=IntentRepository,
    )


def _measure_recovery(monkeypatch, recovery_runtime, track_count: int, recover) -> OperationCounts:
    recovery_runtime.seed_inventory(track_count)
    counts = OperationCounts()
    _CountingRootSettingsStore.counts = counts
    try:
        with count_filesystem_and_media(monkeypatch, counts):
            summary = recover()
    finally:
        _CountingRootSettingsStore.counts = None
    assert summary["completed"] == 1 and summary["failed"] == 0, recovery_runtime.state.failed
    assert recovery_runtime.state.persisted == [{str(track) for track in recovery_runtime.tracks}]
    return counts


def _recovery_budgets(*, startup: bool) -> dict[str, int]:
    """Per journal path: one root-settings read and its probes; startup also
    reads the root identity once."""
    return {
        "filesystem_enumerations": 0,
        "stat_calls": 5 * _ALBUM_TRACKS + startup,
        "open_calls": 0,
        "media_parses": 0,
        "sql_statements": _ALBUM_TRACKS + startup,
    }


def test_claimed_tag_edit_recovery_contract_resolves_only_the_journal_paths_at_production_track_count(
    recovery_runtime, monkeypatch,
):
    from music_app.services.tag_edit_recovery import _reconcile_claimed_tag_edit_intent

    def run(track_count: int) -> OperationCounts:
        return _measure_recovery(monkeypatch, recovery_runtime, track_count, lambda: _reconcile_claimed_tag_edit_intent(
            recovery_runtime.runtime,
            recovery_runtime.repository(None),
            deepcopy(recovery_runtime.intent),
            recovery_runtime.state.file_cache,
        ))

    measure_scale_pair(
        interaction_id="py:services/tag_edit_recovery.py#_reconcile_claimed_tag_edit_intent",
        small=20,
        large=160_000,
        run=run,
        budgets=_recovery_budgets(startup=False),
        growth=("stat_calls", 0),
    )


def test_startup_tag_edit_recovery_contract_resolves_only_the_journal_paths_at_production_track_count(
    recovery_runtime, monkeypatch,
):
    from music_app.services.tag_edit_recovery import reconcile_unfinished_tag_edit_intents_on_startup

    def run(track_count: int) -> OperationCounts:
        return _measure_recovery(
            monkeypatch, recovery_runtime, track_count,
            lambda: reconcile_unfinished_tag_edit_intents_on_startup(recovery_runtime.runtime),
        )

    measure_scale_pair(
        interaction_id="py:services/tag_edit_recovery.py#reconcile_unfinished_tag_edit_intents_on_startup",
        small=20,
        large=160_000,
        run=run,
        budgets=_recovery_budgets(startup=True),
        growth=("stat_calls", 0),
    )


def test_open_album_location_contract_probes_only_the_posted_album_at_production_library_size(
    asgi_app, tmp_path, monkeypatch,
):
    from music_app.routes import web_asgi

    opened: list[list[Path]] = []
    monkeypatch.setattr(web_asgi, "open_in_system_file_explorer", opened.append)

    def run(album_count: int) -> OperationCounts:
        music_dir = tmp_path / f"library-{album_count}"
        _use_library(asgi_app, music_dir)
        tracks = _seed_library(music_dir, album_count)
        album = {"name": "Selected Album", "tracks": [{"path": str(track)} for track in tracks]}
        counts = _measure_request(monkeypatch, lambda: run_asgi_request(
            asgi_app, "POST", "/open-album-location", json_body={"album": album},
            client_host="127.0.0.1", server_host="localhost",
        )[0])
        assert opened[-2:] == [[tracks[0].parent]] * 2
        return counts

    measure_scale_pair(
        interaction_id="py:routes/web_asgi.py#open_album_location",
        small=20,
        large=1_000,
        run=run,
        budgets={
            "filesystem_enumerations": 0,
            "stat_calls": 6 * _ALBUM_TRACKS,
            "open_calls": 0,
            "sql_statements": _ALBUM_TRACKS,
        },
        growth=("stat_calls", 0),
    )


def test_private_boundary_contract_resolves_restricted_artwork_from_the_root_snapshot_at_production_library_size(
    asgi_app, tmp_path, monkeypatch,
):
    """The middleware runs on every request. A View-only member's artwork
    request is answered there, from the cached root snapshot and the one
    requested cover: no root-settings reload, no walk of the roots."""
    from PIL import Image

    from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship

    viewer = CurrentActor(
        state=ActorState.ACTIVE, account_id=7, session_id=11, current_library_id=1,
        library_relationships=(LibraryRelationship(1, "member", False),),
        capability_grants=(CapabilityGrant("capability.view", "library", 1),),
    )
    asgi_app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: viewer)

    def run(album_count: int) -> OperationCounts:
        music_dir = tmp_path / f"library-{album_count}"
        _use_library(asgi_app, music_dir)
        cover = _seed_library(music_dir, album_count)[0].with_name("cover.png")
        Image.new("RGB", (40, 30), "teal").save(cover)

        def request_artwork() -> int:
            status, headers, body = run_asgi_request(asgi_app, "GET", "/cover", query={"path": str(cover)})
            assert status == 200, body
            # The browse rendition the boundary re-encodes, not the cover route's bytes.
            assert dict(headers).get("x-content-type-options") == "nosniff"
            assert Image.open(BytesIO(body)).size == (40, 30)
            return status

        return _measure_request(monkeypatch, request_artwork)

    measure_scale_pair(
        interaction_id="py:services/private_route_boundary.py#install_private_route_boundary.<locals>.require_private_authentication",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 0, "stat_calls": 3, "open_calls": 1, "sql_statements": 0},
        growth=("stat_calls", 0),
    )
