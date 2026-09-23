from __future__ import annotations

from collections.abc import Iterable

import pytest

from tests.py.asgi_testing import (
    collect_route_paths,
    create_test_asgi_app,
    decode_json,
    run_asgi_request,
)


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
ALBUM_KEY = "transatlantic::smpte-the-roine-stolt-mixes"


class Cursor:
    def __init__(self, rows: Iterable[object] = ()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("begin")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append("rollback" if exc_type else "commit")
        return False


class Connection:
    def __init__(self, result=None, *, execute_error: Exception | None = None):
        self.result = result
        self.execute_error = execute_error
        self.events: list[str] = []
        self.operations: list[tuple[str, object]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=None):
        normalized = " ".join(str(sql).casefold().split())
        self.operations.append((normalized, params))
        if self.execute_error is not None:
            raise self.execute_error
        return Cursor([self.result] if self.result is not None else [])


def _service(connection):
    from music_app.services.missing_album_removal_postgres import (
        PostgresMissingAlbumRemovalService,
    )

    return PostgresMissingAlbumRemovalService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda _database_url: connection,
    )


def test_confirm_removal_deletes_only_missing_album_inventory_and_advances_revision():
    connection = Connection(
        {
            "album_found": True,
            "active_file_count": 0,
            "removed_album_key": ALBUM_KEY,
            "removed_album_count": 1,
            "inventory_mutation_revision": 18,
        }
    )

    result = _service(connection).confirm_removal(ALBUM_KEY)

    assert result == {
        "removed_album_key": ALBUM_KEY,
        "library_revision": 18,
    }
    assert connection.events == ["begin", "commit"]
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert sql == "select * from library.confirm_missing_album_removal(%(album_key)s);"
    assert ALBUM_KEY in _flatten_values(params)


def test_confirm_removal_returns_domain_conflict_when_any_file_reappeared():
    from music_app.services.missing_album_removal_postgres import (
        MissingAlbumReappeared,
    )

    connection = Connection(
        {
            "album_found": True,
            "active_file_count": 1,
            "removed_album_key": None,
            "removed_album_count": 0,
            "inventory_mutation_revision": 17,
        }
    )

    with pytest.raises(MissingAlbumReappeared):
        _service(connection).confirm_removal(ALBUM_KEY)

    assert connection.events == ["begin", "rollback"]


def test_confirm_removal_rolls_back_when_unindexed_file_reappears(tmp_path):
    from music_app.services.missing_album_removal_postgres import MissingAlbumReappeared

    root = tmp_path / "healthy-library"
    root.mkdir()
    track = root / "returned.flac"
    track.write_bytes(b"returned before watcher reconciliation")
    connection = Connection({
        "album_found": True, "active_file_count": 0,
        "removed_album_key": ALBUM_KEY, "removed_album_count": 1,
        "inventory_mutation_revision": 18, "root_private_paths": [str(root)],
        "stale_private_paths": [str(track)],
        "unresolved_root_count": 0, "unhealthy_root_count": 0,
    })

    with pytest.raises(MissingAlbumReappeared):
        _service(connection).confirm_removal(ALBUM_KEY)

    assert connection.events == ["begin", "rollback"]
    assert track.read_bytes() == b"returned before watcher reconciliation"


def test_confirm_removal_preserves_album_when_owning_root_is_unavailable(tmp_path):
    from music_app.services.missing_album_removal_postgres import (
        MissingAlbumRootUnavailable,
    )

    connection = Connection(
        {
            "album_found": True,
            "active_file_count": 0,
            "stale_private_paths": [],
            "root_private_paths": [str(tmp_path / "disconnected-root")],
            "removed_album_key": ALBUM_KEY,
            "removed_album_count": 1,
            "inventory_mutation_revision": 18,
        }
    )

    with pytest.raises(MissingAlbumRootUnavailable):
        _service(connection).confirm_removal(ALBUM_KEY)

    assert connection.events == ["begin", "rollback"]
    sql, params = connection.operations[0]
    assert sql == "select * from library.confirm_missing_album_removal(%(album_key)s);"
    assert ALBUM_KEY in _flatten_values(params)


def test_confirm_removal_preserves_album_when_owning_watcher_is_unhealthy():
    from music_app.services.missing_album_removal_postgres import (
        MissingAlbumRootUnavailable,
    )

    connection = Connection(
        {
            "album_found": True,
            "active_file_count": 0,
            "unhealthy_root_count": 1,
            "removed_album_key": None,
            "removed_album_count": 0,
            "inventory_mutation_revision": 17,
        }
    )

    with pytest.raises(MissingAlbumRootUnavailable):
        _service(connection).confirm_removal(ALBUM_KEY)

    assert connection.events == ["begin", "rollback"]


def test_confirm_removal_reports_unknown_album_without_cross_library_delete():
    from music_app.services.missing_album_removal_postgres import MissingAlbumNotFound

    connection = Connection(
        {
            "album_found": False,
            "active_file_count": 0,
            "removed_album_key": None,
            "removed_album_count": 0,
            "inventory_mutation_revision": 17,
        }
    )

    with pytest.raises(MissingAlbumNotFound):
        _service(connection).confirm_removal("other-library-album")

    sql, params = connection.operations[0]
    assert sql == "select * from library.confirm_missing_album_removal(%(album_key)s);"
    assert "other-library-album" in _flatten_values(params)
    assert connection.events == ["begin", "rollback"]


def test_confirm_removal_rolls_back_database_failure():
    connection = Connection(execute_error=RuntimeError("database write failed"))

    with pytest.raises(RuntimeError, match="database write failed"):
        _service(connection).confirm_removal(ALBUM_KEY)

    assert connection.events == ["begin", "rollback"]


@pytest.mark.parametrize("owning_root", ["unhealthy-root", "healthy-root"])
def test_confirm_removal_route_checks_pending_health_after_database_recovers(
    monkeypatch, tmp_path, owning_root,
):
    from music_app.services import missing_album_removal_postgres as removal
    from music_app.services.library_watch import LibraryEvent, LibraryEventKind
    from music_app.services.library_watch_health import LibraryWatchHealthService

    class RecoveringStore:
        def upsert(self, _problem):
            raise RuntimeError("temporary database outage")

        def load(self):
            # Connectivity recovered, but the failed health write is still pending.
            return []

    health = LibraryWatchHealthService(RecoveringStore())
    with pytest.raises(RuntimeError, match="temporary database outage"):
        health.record_event(LibraryEvent(
            kind=LibraryEventKind.OVERFLOW, root_id="unhealthy-root", path=tmp_path, observed_at=1.0,
        ))
    assert health.root_allows_destructive_reconciliation("unhealthy-root") is False
    assert health.root_allows_destructive_reconciliation("healthy-root") is True

    class RootConnection(Connection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "confirm_missing_album_removal" in str(sql):
                return cursor
            if "pg_advisory_xact_lock" in str(sql):
                return Cursor()
            return Cursor([{"root_id": owning_root}])

    connection = RootConnection({
        "album_found": True, "active_file_count": 0,
        "stale_private_paths": [], "root_private_paths": [str(tmp_path)],
        "unresolved_root_count": 0, "unhealthy_root_count": 0,
        "removed_album_key": ALBUM_KEY, "removed_album_count": 1,
        "inventory_mutation_revision": 18,
    })
    monkeypatch.setattr(removal, "_connect", lambda _url: connection)
    app = create_test_asgi_app(tmp_path, monkeypatch)
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = DATABASE_URL
    app.state.library_watch_health_service = health

    status, _headers, body = run_asgi_request(
        app, "POST", f"/api/library/albums/{ALBUM_KEY}/confirm-removal",
    )

    if owning_root == "unhealthy-root":
        assert status == 409
        assert decode_json(body)["code"] == "library_root_unavailable"
        assert connection.events == ["begin", "rollback"]
        assert not app.state.library_state.get("targeted_inventory_album_keys")
    else:
        assert status == 200
        assert connection.events == ["begin", "commit"]
        assert decode_json(body)["removed_album_key"] == ALBUM_KEY
    assert "pg_advisory_xact_lock" in connection.operations[0][0]
    assert "library.local_track_files" in connection.operations[1][0]
    assert ALBUM_KEY in _flatten_values(connection.operations[1][1])


def test_confirm_removal_route_is_registered_and_owner_can_remove(monkeypatch, tmp_path):
    from music_app.routes import api_wave_a_asgi_routes

    calls: list[str] = []

    class Service:
        def __init__(self, config, *, root_health_check=None):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == DATABASE_URL

        def confirm_removal(self, album_key):
            calls.append(album_key)
            return {"removed_album_key": album_key, "library_revision": 22}

    monkeypatch.setattr(
        api_wave_a_asgi_routes,
        "PostgresMissingAlbumRemovalService",
        Service,
        raising=False,
    )
    app = create_test_asgi_app(tmp_path, monkeypatch)
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = DATABASE_URL

    assert "/api/library/albums/{album_key:path}/confirm-removal" in collect_route_paths(app)
    status, _headers, body = run_asgi_request(
        app,
        "POST",
        f"/api/library/albums/{ALBUM_KEY}/confirm-removal",
    )

    assert status == 200
    assert decode_json(body) == {
        "ok": True,
        "removed_album_key": ALBUM_KEY,
        "library_revision": 22,
    }
    assert calls == [ALBUM_KEY]
    assert app.state.library_state["inventory_mutation_revision"] == 22
    assert app.state.library_state["targeted_inventory_album_keys"] == (ALBUM_KEY,)


def test_removal_runtime_update_serializes_with_scan_publication(monkeypatch, tmp_path):
    from threading import Event, Lock, Thread
    from music_app.routes import api_wave_a_asgi_routes
    from music_app.services import state as runtime_state

    app = create_test_asgi_app(tmp_path, monkeypatch)
    cache_lock = Lock()
    monkeypatch.setattr(runtime_state, "_CACHE_LOCK", cache_lock)
    read_started, publication_attempted = Event(), Event()
    failures = []
    committed = []
    published = [{"key": "retained", "title": "Updated by scan"}, {"key": "new-album"}]

    class Service:
        def __init__(self, _config, *, root_health_check=None):
            pass

        def confirm_removal(self, album_key):
            assert not cache_lock.locked(), "database work must precede the cache lock"
            committed.append(album_key)
            return {"removed_album_key": album_key, "library_revision": 22}

    class InterleavedAlbums(list):
        def __iter__(self):
            assert committed == [ALBUM_KEY]
            read_started.set()
            assert publication_attempted.wait(2), "scan publication did not attempt the lock"
            return super().__iter__()

    app.state.library_state["albums"] = InterleavedAlbums([
        {"key": ALBUM_KEY}, {"key": "retained", "title": "Old metadata"},
    ])
    monkeypatch.setattr(api_wave_a_asgi_routes, "PostgresMissingAlbumRemovalService", Service)

    def publish_scan():
        try:
            assert read_started.wait(2)
            # If removal has no cache lock, publish before its stale assignment.
            # Otherwise announce contention, then publish after removal releases.
            if cache_lock.acquire(blocking=False):
                try:
                    app.state.library_state["albums"] = published
                finally:
                    cache_lock.release()
                    publication_attempted.set()
            else:
                publication_attempted.set()
                with cache_lock:
                    app.state.library_state["albums"] = published
        except BaseException as error:
            failures.append(error)
            publication_attempted.set()

    publisher = Thread(target=publish_scan)
    publisher.start()
    try:
        status, _headers, body = run_asgi_request(
            app, "POST", f"/api/library/albums/{ALBUM_KEY}/confirm-removal",
        )
    finally:
        read_started.set()
        publisher.join(2)
    assert not publisher.is_alive() and failures == []
    assert status == 200 and decode_json(body)["removed_album_key"] == ALBUM_KEY
    assert app.state.library_state["albums"] == published
    assert app.state.library_state["inventory_mutation_revision"] == 22


@pytest.mark.parametrize(
    ("request_album_key", "expected_album_key"),
    (
        ("artist/album", "artist/album"),
        ("artist%2Falbum", "artist%2Falbum"),
    ),
)
def test_confirm_removal_route_preserves_decoded_slashes_and_literal_percent_sequences(
    monkeypatch,
    tmp_path,
    request_album_key,
    expected_album_key,
):
    from music_app.routes import api_wave_a_asgi_routes

    calls: list[str] = []

    class Service:
        def __init__(self, _config, *, root_health_check=None):
            pass

        def confirm_removal(self, album_key):
            calls.append(album_key)
            return {"removed_album_key": album_key, "library_revision": 22}

    monkeypatch.setattr(
        api_wave_a_asgi_routes,
        "PostgresMissingAlbumRemovalService",
        Service,
    )
    app = create_test_asgi_app(tmp_path, monkeypatch)

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        f"/api/library/albums/{request_album_key}/confirm-removal",
    )

    assert status == 200
    assert decode_json(body) == {
        "ok": True,
        "removed_album_key": expected_album_key,
        "library_revision": 22,
    }
    assert calls == [expected_album_key]


def test_confirm_removal_route_maps_reappeared_album_to_409(monkeypatch, tmp_path):
    from music_app.routes import api_wave_a_asgi_routes
    from music_app.services.missing_album_removal_postgres import MissingAlbumReappeared

    class Service:
        def __init__(self, _config, *, root_health_check=None):
            pass

        def confirm_removal(self, _album_key):
            raise MissingAlbumReappeared()

    monkeypatch.setattr(
        api_wave_a_asgi_routes,
        "PostgresMissingAlbumRemovalService",
        Service,
    )
    app = create_test_asgi_app(tmp_path, monkeypatch)

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        f"/api/library/albums/{ALBUM_KEY}/confirm-removal",
    )

    assert status == 409
    assert decode_json(body) == {
        "ok": False,
        "error": "Album was found again. Refresh the library before removing it.",
        "code": "album_reappeared",
    }


def test_confirm_removal_route_maps_unavailable_root_to_409(monkeypatch, tmp_path):
    from music_app.routes import api_wave_a_asgi_routes
    from music_app.services.missing_album_removal_postgres import (
        MissingAlbumRootUnavailable,
    )

    class Service:
        def __init__(self, _config, *, root_health_check=None):
            pass

        def confirm_removal(self, _album_key):
            raise MissingAlbumRootUnavailable()

    monkeypatch.setattr(
        api_wave_a_asgi_routes,
        "PostgresMissingAlbumRemovalService",
        Service,
    )
    app = create_test_asgi_app(tmp_path, monkeypatch)

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        f"/api/library/albums/{ALBUM_KEY}/confirm-removal",
    )

    assert status == 409
    assert decode_json(body) == {
        "ok": False,
        "error": "The album's library root is unavailable. Reconnect it before removing the album.",
        "code": "library_root_unavailable",
    }


def test_confirm_removal_route_rejects_blank_album_key(monkeypatch, tmp_path):
    app = create_test_asgi_app(tmp_path, monkeypatch)

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        "/api/library/albums/ /confirm-removal",
    )

    assert status == 400
    assert decode_json(body) == {"ok": False, "error": "Invalid album key"}


def test_confirm_removal_route_requires_inventory_manage_capability(monkeypatch, tmp_path):
    from music_app.services.current_actor import (
        ActorState,
        CapabilityGrant,
        CurrentActor,
        LibraryRelationship,
    )

    class Resolver:
        def resolve(self, _token):
            return CurrentActor(
                state=ActorState.ACTIVE,
                account_id=9,
                session_id=12,
                username_display="problem reviewer",
                current_library_id=23,
                library_relationships=(LibraryRelationship(23, "member", False),),
                capability_grants=(
                    CapabilityGrant("library.problems.read", "library", 23),
                ),
            )

    app = create_test_asgi_app(tmp_path, monkeypatch)
    app.state.current_actor_resolver = Resolver()

    status, _headers, body = run_asgi_request(
        app,
        "POST",
        f"/api/library/albums/{ALBUM_KEY}/confirm-removal",
    )

    assert status == 403
    assert decode_json(body) == {"detail": "Action not permitted."}


def test_inventory_manage_capability_is_selectable_but_not_a_listener_default():
    from music_app.services.admin_account_creation import MANAGED_CAPABILITY_KEYS
    from music_app.routes.admin_asgi import _CAPABILITY_GROUPS, _LISTENER_DEFAULTS
    from music_app.services.private_route_boundary import private_action_for_route

    catalog = {
        capability
        for _group, capabilities in _CAPABILITY_GROUPS
        for capability, _label in capabilities
    }

    assert "library.inventory.manage" in catalog
    assert "library.inventory.manage" in MANAGED_CAPABILITY_KEYS
    assert "library.inventory.manage" not in _LISTENER_DEFAULTS
    assert private_action_for_route(
        "POST",
        "/api/library/albums/{album_key:path}/confirm-removal",
    ) == "library.inventory.manage"


@pytest.mark.parametrize(
    ("resolver", "expected_actions"),
    (
        (None, {"library.inventory.manage": True}),
        ("read_only", {}),
    ),
)
def test_missing_album_view_payload_projects_request_authority(
    monkeypatch,
    tmp_path,
    resolver,
    expected_actions,
):
    from music_app.routes import api_read_asgi_routes
    from music_app.services.current_actor import (
        ActorState,
        CapabilityGrant,
        CurrentActor,
        LibraryRelationship,
    )

    class Repository:
        def __init__(self, _config):
            pass

        def build_root_sidebar_payload(self, **_kwargs):
            return {
                "artist_groups": [
                    {
                        "artist": "Transatlantic",
                        "albums": [
                            {
                                "key": ALBUM_KEY,
                                "inventory_status": "missing",
                            }
                        ],
                    }
                ]
            }

    class ReadOnlyResolver:
        def resolve(self, _token):
            return CurrentActor(
                state=ActorState.ACTIVE,
                account_id=9,
                session_id=12,
                username_display="problem reviewer",
                current_library_id=23,
                library_relationships=(LibraryRelationship(23, "member", False),),
                capability_grants=(
                    CapabilityGrant("library.browse.read", "library", 23),
                ),
            )

    monkeypatch.setattr(api_read_asgi_routes, "PostgresLibraryBrowseRepository", Repository)
    app = create_test_asgi_app(tmp_path, monkeypatch)
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = DATABASE_URL
    if resolver == "read_only":
        app.state.current_actor_resolver = ReadOnlyResolver()

    status, _headers, body = run_asgi_request(
        app,
        "GET",
        "/view-data",
        query={"payload_tier": "sidebar"},
    )

    assert status == 200
    album = decode_json(body)["artist_groups"][0]["albums"][0]
    assert album["allowed_actions"] == expected_actions
    assert "can_remove_missing_album" not in album


def _flatten_values(value: object) -> list[object]:
    if isinstance(value, dict):
        values: list[object] = []
        for item in value.values():
            values.extend(_flatten_values(item))
        return values
    if isinstance(value, (list, tuple, set)):
        values = []
        for item in value:
            values.extend(_flatten_values(item))
        return values
    return [value]


@pytest.mark.parametrize("contended_stage", ["mutation", "invalidation"])
def test_removal_cache_contention_keeps_event_loop_responsive(monkeypatch, tmp_path, contended_stage):
    import asyncio
    from threading import Event, Lock, Thread
    from music_app.routes import api_wave_a_asgi_routes as routes
    from music_app.services import state as runtime_state
    from tests.py.asgi_testing import run_asgi_request_async

    app = create_test_asgi_app(tmp_path, monkeypatch)
    begin_contention, held, attempted, heartbeat = Event(), Event(), Event(), Event()
    physical_lock = Lock()
    failures, observed, committed = [], [], []

    class ObservedLock:
        def __enter__(self):
            if held.is_set():
                attempted.set()
            physical_lock.acquire()
            return self

        def __exit__(self, *_args):
            physical_lock.release()

    monkeypatch.setattr(runtime_state, "_CACHE_LOCK", ObservedLock())

    class Service:
        def __init__(self, _config, *, root_health_check=None):
            pass

        def confirm_removal(self, album_key):
            assert not physical_lock.locked(), "persistence must precede runtime contention"
            committed.append(album_key)
            return {"removed_album_key": album_key, "library_revision": 22}

    monkeypatch.setattr(routes, "PostgresMissingAlbumRemovalService", Service)
    app.state.library_state["albums"] = [{"key": ALBUM_KEY}, {"key": "retained"}]
    function_name = ("run_runtime_state_mutation_for_state" if contended_stage == "mutation"
                     else "invalidate_targeted_library_projections")
    original = getattr(routes, function_name)

    def gated(*args, **kwargs):
        assert committed == [ALBUM_KEY]
        begin_contention.set()
        assert held.wait(2), "external cache holder did not start"
        return original(*args, **kwargs)

    monkeypatch.setattr(routes, function_name, gated)

    def hold_cache():
        try:
            assert begin_contention.wait(2)
            with physical_lock:
                held.set()
                assert attempted.wait(2), "route did not attempt the held cache lock"
                # An external deadline releases the lock even if old code blocks asyncio.
                observed.append(heartbeat.wait(0.75))
        except BaseException as error:
            failures.append(error)
            held.set()

    async def exercise():
        async def mark_heartbeat():
            assert await asyncio.to_thread(attempted.wait, 3)
            heartbeat.set()
        pulse = asyncio.create_task(mark_heartbeat())
        try:
            response = await run_asgi_request_async(
                app, "POST", f"/api/library/albums/{ALBUM_KEY}/confirm-removal")
            await pulse
            return response
        finally:
            if not pulse.done():
                pulse.cancel()
                await asyncio.gather(pulse, return_exceptions=True)

    holder = Thread(target=hold_cache)
    holder.start()
    try:
        status, _headers, body = asyncio.run(exercise())
    finally:
        begin_contention.set()
        holder.join(4)
    assert not holder.is_alive() and failures == []
    assert observed == [True], f"{contended_stage} cache wait blocked the ASGI event loop"
    assert status == 200 and decode_json(body)["removed_album_key"] == ALBUM_KEY
    assert app.state.library_state["albums"] == [{"key": "retained"}]
    assert app.state.library_state["inventory_mutation_revision"] == 22
