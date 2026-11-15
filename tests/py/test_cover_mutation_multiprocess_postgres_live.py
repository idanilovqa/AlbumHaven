from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, replace
import hashlib
from io import BytesIO
import multiprocessing
from pathlib import Path
from threading import Lock
from time import monotonic, monotonic_ns, sleep
from uuid import uuid4

from PIL import Image
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
import pytest

from music_app.services import cover_mutation_coordinator as coordinator
from music_app.services.cover_mutations_postgres import PostgresCoverMutationRepository
from music_app.services.postgres_connections import close_pools
from tests.e2e.support import isolatedPostgres
from tests.py.test_cover_mutations_postgres_live import (
    _CoverScope,
    _commit_request,
    _database_urls_or_skip,
    _drop_schemas,
    _durable_commit_request,
    _seed_durable_fence,
    _seed_scope,
)


_TIMEOUT = 30


@dataclass(frozen=True, repr=False)
class _Database:
    setup_url: str
    app_url: str
    worker_url: str
    readonly_url: str


@dataclass(frozen=True, repr=False)
class _Writer:
    scope: _CoverScope
    database_url: str
    role: str
    application_name: str
    artifact_path: Path
    content: bytes
    fence: dict[str, object] | None = None


@pytest.fixture(scope="module")
def _database():
    database = _Database(*_database_urls_or_skip())
    try:
        _drop_schemas(database.setup_url)
        isolatedPostgres.prepare_isolated_database(database.setup_url, database.app_url)
        yield database
    finally:
        _drop_schemas(database.setup_url)


def _second_album(scope: _CoverScope) -> _CoverScope:
    album_key = f"{scope.album_key}-second"
    private_path = str(Path(scope.private_path).with_name("02.flac"))
    with isolatedPostgres._connect(scope.setup_url) as connection:
        source = connection.execute(
            "select album.artist_id, file.library_root_id "
            "from library.local_albums album "
            "join library.local_tracks track on track.album_id=album.id "
            "join library.local_track_files file on file.track_id=track.id "
            "where album.id=%s and file.id=%s",
            (scope.album_id, scope.file_id),
        ).fetchone()
        album_id = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title) "
            "values(%s,%s,%s,'Second cover album') returning id",
            (scope.library_id, source["artist_id"], album_key),
        ).fetchone()["id"]
        track_id = connection.execute(
            "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title) "
            "values(%s,%s,%s,%s,'Second track') returning id",
            (scope.library_id, album_id, source["artist_id"], f"{album_key}-track"),
        ).fetchone()["id"]
        file_id = connection.execute(
            "insert into library.local_track_files(track_id,library_root_id,private_path,relative_path) "
            "values(%s,%s,%s,'02.flac') returning id",
            (track_id, source["library_root_id"], private_path),
        ).fetchone()["id"]
    return replace(
        scope, album_id=album_id, file_id=file_id,
        private_path=private_path, album_key=album_key,
    )


def _image_bytes(color: str) -> bytes:
    with BytesIO() as output:
        with Image.new("RGB", (8, 8), color) as image:
            image.save(output, format="PNG")
        return output.getvalue()


def _write_in_process(writer: _Writer, release, messages) -> None:
    original_connection = coordinator.cover_lock_connection
    database_url = make_conninfo(writer.database_url, application_name=writer.application_name)
    local_lock = Lock()

    @contextmanager
    def observed_connection(_database_url):
        with original_connection(_database_url) as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                isolatedPostgres._assert_connected_role(cursor, writer.role)
            messages.put({"stage": "session", "pid": connection.info.backend_pid, "time": monotonic_ns()})
            yield connection

    @contextmanager
    def paused_local_lock():
        with local_lock:
            messages.put({"stage": "entered", "time": monotonic_ns()})
            if not release.wait(_TIMEOUT * 3):
                raise TimeoutError("parent did not release the cover writer")
            yield

    try:
        coordinator.cover_lock_connection = observed_connection
        repository = PostgresCoverMutationRepository(
            database_url=database_url, connect_to_database=isolatedPostgres._connect,
        )
        identity = repository.resolve_identity(
            library_id=writer.scope.library_id, track_paths=[writer.scope.private_path],
        )
        with coordinator.serialize_cover_mutation(
            config={"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
            identity=identity,
            acquire_local_lock=paused_local_lock,
        ):
            baseline = repository.load_baseline(identity=identity)
            writer.artifact_path.write_bytes(writer.content)
            messages.put({"stage": "written", "time": monotonic_ns()})
            digest = hashlib.sha256(writer.content).hexdigest()
            arguments = {
                "expected_inventory_revision": baseline.inventory_revision,
                "expected_cover_mutation_revision": baseline.cover_mutation_revision,
                "expected_selected_cover_revision": baseline.selected_cover_revision,
                "selected_cover_revision": digest,
            }
            request = (
                _durable_commit_request(writer.scope, digest, writer.fence, **arguments)
                if writer.fence is not None else _commit_request(writer.scope, **arguments)
            )
            outcome = repository.commit_selection(request=replace(
                request, selected_cover_path=str(writer.artifact_path), artifact_sha256=digest,
            ))
            messages.put({
                "stage": "committed", "time": monotonic_ns(), "role": writer.role,
                "status": outcome.status.value, "revision": outcome.cover_mutation_revision,
                "selected_revision": outcome.selected_cover_revision,
                "previous_selected_revision": baseline.selected_cover_revision,
                "checkpoint": outcome.checkpoint,
            })
        messages.put({"stage": "released", "time": monotonic_ns()})
    except BaseException as error:
        messages.put({"stage": "error", "type": type(error).__name__})
    finally:
        coordinator.cover_lock_connection = original_connection
        try:
            close_pools()
            messages.put({"stage": "finished", "time": monotonic_ns()})
        except BaseException as error:
            messages.put({"stage": "error", "type": type(error).__name__})
        finally:
            messages.close()
            messages.join_thread()


def _receive(messages, stage: str) -> dict:
    message = messages.get(timeout=_TIMEOUT)
    assert message.get("stage") == stage, message
    return message


def _assert_waiting_for_album_lock(database: _Database, backend_pid: int, identity) -> None:
    first, second = coordinator.cover_advisory_keys(identity)
    deadline = monotonic() + _TIMEOUT
    with isolatedPostgres._connect(database.setup_url) as connection:
        while monotonic() < deadline:
            waiting = connection.execute(
                "select exists(select 1 from pg_locks where pid=%s and locktype='advisory' "
                "and classid::bigint=%s and objid::bigint=%s and objsubid=2 and not granted) as waiting",
                (backend_pid, first & 0xFFFFFFFF, second & 0xFFFFFFFF),
            ).fetchone()["waiting"]
            if waiting:
                return
            sleep(0.02)
    pytest.fail("second writer never waited for the first writer's advisory lock", pytrace=False)


def _assert_no_sessions(database: _Database, application_names: list[str]) -> None:
    deadline = monotonic() + 5
    with isolatedPostgres._connect(database.setup_url) as connection:
        while monotonic() < deadline:
            count = connection.execute(
                "select count(*) as count from pg_stat_activity where application_name=any(%s)",
                (application_names,),
            ).fetchone()["count"]
            if count == 0:
                return
            sleep(0.02)
    pytest.fail("owned cover-writer database sessions remained after process cleanup", pytrace=False)


def _assert_process_pair(database: _Database, tmp_path: Path, *, same_album: bool) -> None:
    scope = _seed_scope(database.setup_url, database.app_url, database.worker_url, database.readonly_url)
    second_scope = scope if same_album else _second_album(scope)
    app_content, worker_content = _image_bytes("red"), _image_bytes("blue")
    (tmp_path / "prepared-worker.png").write_bytes(worker_content)
    fence = _seed_durable_fence(second_scope, hashlib.sha256(worker_content).hexdigest())
    with isolatedPostgres._connect(database.setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at=clock_timestamp()+interval '5 minutes' where id=%s",
            (fence["job_id"],),
        )
    token = uuid4().hex
    first_path = tmp_path / "first-cover.png"
    second_path = first_path if same_album else tmp_path / "second-cover.png"
    writers = [
        _Writer(
            scope, database.app_url, "album_haven_app",
            f"cover-mp-app-{token}", first_path, app_content,
        ),
        _Writer(
            second_scope, database.worker_url, "album_haven_worker",
            f"cover-mp-worker-{token}", second_path, worker_content, fence,
        ),
    ]
    context = multiprocessing.get_context("spawn")
    releases, queues, processes = [], [], []
    try:
        for writer in writers:
            release, messages = context.Event(), context.Queue()
            releases.append(release)
            queues.append(messages)
            processes.append(context.Process(
                target=_write_in_process, args=(writer, release, messages),
            ))
        processes[0].start()
        _receive(queues[0], "session")
        first_entered = _receive(queues[0], "entered")
        processes[1].start()
        second_session = _receive(queues[1], "session")
        if same_album:
            _assert_waiting_for_album_lock(
                database, second_session["pid"],
                coordinator.CoverMutationIdentity(scope.library_id, scope.album_id),
            )
            artifact_exists = first_path.exists()
            assert not artifact_exists
            assert PostgresCoverMutationRepository(database_url=database.app_url).load_baseline(
                identity=coordinator.CoverMutationIdentity(scope.library_id, scope.album_id),
            ).selected_cover_revision is None
        else:
            second_entered = _receive(queues[1], "entered")
            artifacts_exist = first_path.exists() or second_path.exists()
            assert not artifacts_exist
        # Order commits because the cover revision is shared across this library.
        first_release = monotonic_ns()
        releases[0].set()
        first_written = _receive(queues[0], "written")
        first_committed = _receive(queues[0], "committed")
        _receive(queues[0], "released")
        _receive(queues[0], "finished")
        first_bytes = first_path.read_bytes()
        assert first_bytes == app_content
        if same_album:
            second_entered = _receive(queues[1], "entered")
            assert second_entered["time"] >= first_committed["time"]
        else:
            # Windows clock ticks can be equal after both entry acknowledgements arrive.
            assert first_entered["time"] <= first_release
            assert second_entered["time"] <= first_release
        releases[1].set()
        second_written = _receive(queues[1], "written")
        second_committed = _receive(queues[1], "committed")
        _receive(queues[1], "released")
        _receive(queues[1], "finished")
        for process in processes:
            process.join(10)
        assert [process.exitcode for process in processes] == [0, 0]
        assert processes[0].pid != processes[1].pid
        assert first_written["time"] >= first_release
        assert second_written["time"] >= first_committed["time"]
        assert [first_committed["role"], second_committed["role"]] == [
            "album_haven_app", "album_haven_worker",
        ]
        assert [first_committed["status"], second_committed["status"]] == [
            "committed", "committed",
        ]
        assert [first_committed["revision"], second_committed["revision"]] == [1, 2]
        assert second_committed["checkpoint"] == "authority_committed"
        assert first_committed["selected_revision"] == hashlib.sha256(app_content).hexdigest()
        assert second_committed["selected_revision"] == hashlib.sha256(worker_content).hexdigest()
        expected_previous = first_committed["selected_revision"] if same_album else None
        assert second_committed["previous_selected_revision"] == expected_previous
        second_bytes = second_path.read_bytes()
        assert second_bytes == worker_content
        if not same_album:
            first_bytes = first_path.read_bytes()
            assert first_bytes == app_content
        for writer in writers:
            baseline = PostgresCoverMutationRepository(database_url=database.app_url).load_baseline(
                identity=coordinator.CoverMutationIdentity(writer.scope.library_id, writer.scope.album_id),
            )
            expected = (
                worker_content if same_album or writer.role == "album_haven_worker"
                else app_content
            )
            assert baseline.selected_cover_revision == hashlib.sha256(expected).hexdigest()
            selection_matches_artifact = baseline.selected_cover_path == str(writer.artifact_path)
            assert selection_matches_artifact
    finally:
        cleanup_errors = []
        for release in releases:
            release.set()
        for process in processes:
            try:
                if process.pid is not None:
                    process.join(10)
                    if process.is_alive():
                        process.terminate()
                        process.join(5)
                    if process.is_alive():
                        process.kill()
                        process.join(5)
                    if process.is_alive():
                        cleanup_errors.append("owned cover writer did not exit")
                    else:
                        process.close()
                else:
                    process.close()
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
        for messages in queues:
            try:
                messages.close()
                messages.join_thread()
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
        _assert_no_sessions(database, [writer.application_name for writer in writers])
        assert not cleanup_errors, cleanup_errors


def test_same_album_app_and_worker_processes_serialize(_database, tmp_path):
    _assert_process_pair(_database, tmp_path, same_album=True)


def test_different_albums_app_and_worker_processes_enter_concurrently(_database, tmp_path):
    _assert_process_pair(_database, tmp_path, same_album=False)
