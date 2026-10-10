from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib
import json
import multiprocessing
import os
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from music_app.services.library_watch import LibraryEvent, LibraryEventKind
from tests.e2e.support import isolatedPostgres


NOW = datetime.now(timezone.utc)


def _connect(database_url: str):
    return isolatedPostgres._connect(database_url)


def _accept_in_process(
    start,
    queue,
    app_url: str,
    library_id: int,
    root_id: str,
    root_path: str,
    name: str,
):
    try:
        module = importlib.import_module("music_app.services.watcher_recovery_postgres")
        repository = module.PostgresWatcherRecoveryRepository(
            database_url=app_url,
            connect_to_database=_connect,
        )
        start.wait(15)
        result = repository.accept_event(
            library_id=library_id,
            event=LibraryEvent(
                LibraryEventKind.CREATED,
                root_id,
                Path(root_path) / name,
            ),
            accepted_at=NOW,
        )
        queue.put(("accepted", result.generation_id))
    except BaseException as exc:
        queue.put(("error", type(exc).__name__, str(exc)))


def _accept_move_in_process(
    start,
    queue,
    app_url: str,
    library_id: int,
    source_root_id: str,
    source_root_path: str,
    destination_root_id: str,
    destination_root_path: str,
    name: str,
):
    try:
        module = importlib.import_module("music_app.services.watcher_recovery_postgres")
        repository = module.PostgresWatcherRecoveryRepository(
            database_url=app_url,
            connect_to_database=_connect,
        )
        start.wait(15)
        result = repository.accept_event(
            library_id=library_id,
            event=LibraryEvent(
                LibraryEventKind.MOVED,
                source_root_id,
                Path(source_root_path) / "old" / name,
                destination=Path(destination_root_path) / "new" / name,
                destination_root_id=destination_root_id,
            ),
            accepted_at=NOW,
        )
        queue.put(("accepted", result.generation_id))
    except BaseException as exc:
        queue.put(("error", type(exc).__name__, str(exc)))


def _claim_in_process(
    start,
    queue,
    worker_url: str,
    worker_id: str,
    claim_now: datetime = NOW,
):
    try:
        from music_app.services.jobs.repository_postgres import PostgresJobRepository

        module = importlib.import_module("music_app.services.watcher_recovery_postgres")
        jobs = PostgresJobRepository(
            database_url=worker_url,
            connect_to_database=_connect,
        )
        recovery = module.PostgresWatcherRecoveryRepository(
            database_url=worker_url,
            connect_to_database=_connect,
        )
        start.wait(15)
        claim = jobs.claim(worker_id=worker_id, now=claim_now, lease_seconds=30)
        generation = (
            recovery.claim_generation(claim=claim, now=claim_now)
            if claim is not None
            else None
        )
        queue.put(
            (
                "claimed",
                None if claim is None else claim.job_id,
                None if generation is None else generation.generation_id,
                None if claim is None else claim.attempt,
                None if claim is None else claim.worker_id,
                None if claim is None else claim.lease_token,
            )
        )
    except BaseException as exc:
        queue.put(("error", type(exc).__name__, str(exc)))


def _skip_or_fail_ci(message: str) -> None:
    if any(
        str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    ):
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _urls_or_skip() -> tuple[str, str, str]:
    try:
        setup_url, app_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated watcher multiprocess Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    if not worker_url:
        _skip_or_fail_ci("Dedicated watcher worker Postgres URL is unavailable.")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        (
            (urlparse(value).hostname or "").casefold(),
            urlparse(value).port or 5432,
            urlparse(value).path.lstrip("/"),
        )
        for value in (setup_url, app_url, worker_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Watcher multiprocess role URLs do not share one database.")
    return setup_url, app_url, worker_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


@pytest.fixture
def multiprocess_watcher_database(tmp_path):
    setup_url, app_url, worker_url = _urls_or_skip()
    root_paths = {
        root_id: tmp_path / root_id
        for root_id in ("root-a", "root-b", "root-c", "root-d")
    }
    for path in root_paths.values():
        path.mkdir()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, app_url)
        with isolatedPostgres._connect(setup_url) as connection:
            account_id = int(
                connection.execute(
                    """
                    insert into app.accounts (
                      display_name, username_display, username_normalized,
                      contact_email, contact_email_normalized, account_kind, is_active
                    ) values (
                      'Watcher Multiprocess', 'watcher-multiprocess',
                      'watcher-multiprocess', 'watcher-multiprocess@example.invalid',
                      'watcher-multiprocess@example.invalid', 'managed', true
                    ) returning id
                    """
                ).fetchone()["id"]
            )
            library_id = int(
                connection.execute(
                    """
                    insert into library.libraries (owner_account_id, name, library_kind)
                    values (%s, 'Watcher Multiprocess', 'local') returning id
                    """,
                    (account_id,),
                ).fetchone()["id"]
            )
            root_database_ids = {}
            for logical_id, path in root_paths.items():
                root_database_ids[logical_id] = int(
                    connection.execute(
                        """
                        insert into library.library_roots (
                          library_id, root_path, root_kind, is_active, metadata
                        ) values (%s, %s, 'main', true, %s::jsonb)
                        returning id
                        """,
                        (library_id, str(path), json.dumps({"root_id": logical_id})),
                    ).fetchone()["id"]
                )
        yield SimpleNamespace(
            setup_url=setup_url,
            app_url=app_url,
            worker_url=worker_url,
            library_id=library_id,
            root_paths=root_paths,
            root_database_ids=root_database_ids,
        )
    finally:
        _drop_schemas(setup_url)


def _run_processes(processes, start, queue):
    try:
        for process in processes:
            process.start()
        start.set()
        results = [queue.get(timeout=30) for _process in processes]
        for process in processes:
            process.join(30)
        assert all(not process.is_alive() for process in processes)
        assert [process.exitcode for process in processes] == [0] * len(processes)
        assert not [result for result in results if result[0] == "error"]
        return results
    finally:
        for process in processes:
            if process.pid is None:
                continue
            if process.is_alive():
                process.terminate()
            process.join(30)
        queue.close()
        queue.join_thread()


def test_two_processes_coalesce_same_root_without_losing_acceptance(
    multiprocess_watcher_database,
):
    scope = multiprocess_watcher_database
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    queue = context.Queue()
    processes = [
        context.Process(
            target=_accept_in_process,
            args=(
                start,
                queue,
                scope.app_url,
                scope.library_id,
                "root-a",
                str(scope.root_paths["root-a"]),
                f"process-{index}.mp3",
            ),
        )
        for index in range(2)
    ]

    results = _run_processes(processes, start, queue)

    assert len({result[1] for result in results}) == 1
    with isolatedPostgres._connect(scope.setup_url) as connection:
        lane = connection.execute(
            """
            select accepted_sequence, successor_generation_id
            from library.watcher_lanes where library_id = %s and root_id = %s
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
    assert lane["accepted_sequence"] == 2
    assert lane["successor_generation_id"] == results[0][1]


def test_concurrent_intersecting_successor_merges_lock_the_complete_root_closure(
    multiprocess_watcher_database,
):
    scope = multiprocess_watcher_database
    module = importlib.import_module("music_app.services.watcher_recovery_postgres")
    repository = module.PostgresWatcherRecoveryRepository(
        database_url=scope.app_url,
        connect_to_database=_connect,
    )
    first = repository.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.MOVED,
            "root-a",
            scope.root_paths["root-a"] / "old" / "first.flac",
            destination=scope.root_paths["root-c"] / "new" / "first.flac",
            destination_root_id="root-c",
        ),
        accepted_at=NOW - timedelta(milliseconds=2),
    )
    second = repository.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.MOVED,
            "root-b",
            scope.root_paths["root-b"] / "old" / "second.flac",
            destination=scope.root_paths["root-d"] / "new" / "second.flac",
            destination_root_id="root-d",
        ),
        accepted_at=NOW - timedelta(milliseconds=1),
    )
    assert first.generation_id != second.generation_id

    context = multiprocessing.get_context("spawn")
    start = context.Event()
    queue = context.Queue()
    processes = [
        context.Process(
            target=_accept_move_in_process,
            args=(
                start,
                queue,
                scope.app_url,
                scope.library_id,
                source_root_id,
                str(scope.root_paths[source_root_id]),
                destination_root_id,
                str(scope.root_paths[destination_root_id]),
                name,
            ),
        )
        for source_root_id, destination_root_id, name in (
            ("root-a", "root-b", "inner.flac"),
            ("root-c", "root-d", "outer.flac"),
        )
    ]

    results = _run_processes(processes, start, queue)

    survivor_id = min(first.generation_id, second.generation_id)
    assert {result[1] for result in results} == {survivor_id}
    with isolatedPostgres._connect(scope.setup_url) as connection:
        lanes = connection.execute(
            """
            select root_id, successor_generation_id
            from library.watcher_lanes
            where library_id = %s and root_id = any(%s::bigint[])
            order by root_id
            """,
            (scope.library_id, list(scope.root_database_ids.values())),
        ).fetchall()
        participants = connection.execute(
            """
            select root_id
            from library.watcher_generation_participants
            where generation_id = %s
            order by root_id
            """,
            (survivor_id,),
        ).fetchall()
        moves = connection.execute(
            """
            select source_relative_path, destination_relative_path
            from library.targeted_reconciliation_intent_moves
            where intent_id = %s
            order by source_relative_path
            """,
            (survivor_id,),
        ).fetchall()

    expected_root_ids = sorted(scope.root_database_ids.values())
    assert [row["root_id"] for row in lanes] == expected_root_ids
    assert {row["successor_generation_id"] for row in lanes} == {survivor_id}
    assert [row["root_id"] for row in participants] == expected_root_ids
    assert {
        (row["source_relative_path"], row["destination_relative_path"])
        for row in moves
    } == {
        ("old/first.flac", "new/first.flac"),
        ("old/second.flac", "new/second.flac"),
        ("old/inner.flac", "new/inner.flac"),
        ("old/outer.flac", "new/outer.flac"),
    }


def test_two_worker_processes_cannot_claim_one_root_generation(
    multiprocess_watcher_database,
):
    scope = multiprocess_watcher_database
    module = importlib.import_module("music_app.services.watcher_recovery_postgres")
    app_repository = module.PostgresWatcherRecoveryRepository(
        database_url=scope.app_url,
        connect_to_database=_connect,
    )
    worker_repository = module.PostgresWatcherRecoveryRepository(
        database_url=scope.worker_url,
        connect_to_database=_connect,
    )
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.CREATED,
            "root-a",
            scope.root_paths["root-a"] / "claim.mp3",
        ),
        accepted_at=NOW - timedelta(seconds=1),
    )
    assert worker_repository.dispatch_ready(now=NOW, limit=32) == (
        accepted.generation_id,
    )
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    queue = context.Queue()
    processes = [
        context.Process(
            target=_claim_in_process,
            args=(start, queue, scope.worker_url, f"worker-{index}"),
        )
        for index in range(2)
    ]

    results = _run_processes(processes, start, queue)
    claimed = [result for result in results if result[1] is not None]

    assert len(claimed) == 1
    assert claimed[0][2] == accepted.generation_id


def test_two_worker_processes_claim_unrelated_roots_concurrently(
    multiprocess_watcher_database,
):
    scope = multiprocess_watcher_database
    module = importlib.import_module("music_app.services.watcher_recovery_postgres")
    app_repository = module.PostgresWatcherRecoveryRepository(
        database_url=scope.app_url,
        connect_to_database=_connect,
    )
    worker_repository = module.PostgresWatcherRecoveryRepository(
        database_url=scope.worker_url,
        connect_to_database=_connect,
    )
    accepted = tuple(
        app_repository.accept_event(
            library_id=scope.library_id,
            event=LibraryEvent(
                LibraryEventKind.CREATED,
                root_id,
                scope.root_paths[root_id] / f"{root_id}.mp3",
            ),
            accepted_at=NOW - timedelta(seconds=1),
        )
        for root_id in ("root-a", "root-b")
    )
    assert set(worker_repository.dispatch_ready(now=NOW, limit=32)) == {
        item.generation_id for item in accepted
    }
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    queue = context.Queue()
    processes = [
        context.Process(
            target=_claim_in_process,
            args=(start, queue, scope.worker_url, f"worker-{index}"),
        )
        for index in range(2)
    ]

    results = _run_processes(processes, start, queue)

    assert all(result[1] is not None and result[2] is not None for result in results)
    assert len({result[1] for result in results}) == 2
    assert {result[2] for result in results} == {
        item.generation_id for item in accepted
    }


def test_cross_root_barrier_reclaim_rejects_the_stale_process_claim(
    multiprocess_watcher_database,
):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository

    scope = multiprocess_watcher_database
    now = datetime.now(timezone.utc)
    module = importlib.import_module("music_app.services.watcher_recovery_postgres")
    app_repository = module.PostgresWatcherRecoveryRepository(
        database_url=scope.app_url,
        connect_to_database=_connect,
    )
    worker_repository = module.PostgresWatcherRecoveryRepository(
        database_url=scope.worker_url,
        connect_to_database=_connect,
    )
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.MOVED,
            "root-a",
            scope.root_paths["root-a"] / "old" / "barrier.flac",
            destination=scope.root_paths["root-b"] / "new" / "barrier.flac",
            destination_root_id="root-b",
        ),
        accepted_at=now,
    )
    assert worker_repository.dispatch_ready(now=now, limit=32) == (
        accepted.generation_id,
    )

    context = multiprocessing.get_context("spawn")
    first_start = context.Event()
    first_queue = context.Queue()
    first_results = _run_processes(
        [
            context.Process(
                target=_claim_in_process,
                args=(
                    first_start,
                    first_queue,
                    scope.worker_url,
                    "worker-stale",
                    now,
                ),
            )
        ],
        first_start,
        first_queue,
    )
    first = first_results[0]
    assert first[1] is not None and first[2] == accepted.generation_id

    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=_connect,
    )
    reconciled = jobs.reconcile_stale_leases(
        now=now + timedelta(seconds=31),
        limit=100,
    )
    assert reconciled.retried_count == 1

    second_start = context.Event()
    second_queue = context.Queue()
    second_results = _run_processes(
        [
            context.Process(
                target=_claim_in_process,
                args=(
                    second_start,
                    second_queue,
                    scope.worker_url,
                    "worker-reclaimed",
                    now + timedelta(seconds=31),
                ),
            )
        ],
        second_start,
        second_queue,
    )
    second = second_results[0]
    assert second[1] == first[1]
    assert second[2] == accepted.generation_id
    assert second[3] == first[3] + 1

    stale_claim = SimpleNamespace(
        job_id=first[1],
        attempt=first[3],
        worker_id=first[4],
        lease_token=first[5],
    )
    current_claim = SimpleNamespace(
        job_id=second[1],
        attempt=second[3],
        worker_id=second[4],
        lease_token=second[5],
    )
    assert worker_repository.claim_generation(
        claim=stale_claim,
        now=now + timedelta(seconds=31),
    ) is None
    reclaimed = worker_repository.claim_generation(
        claim=current_claim,
        now=now + timedelta(seconds=31),
    )
    assert reclaimed is not None
    assert reclaimed.generation_id == accepted.generation_id
    assert len(reclaimed.barrier_ids) == 1

    with isolatedPostgres._connect(scope.setup_url) as connection:
        lanes = connection.execute(
            """
            select running_generation_id, running_job_id
            from library.watcher_lanes
            where library_id = %s and root_id = any(%s::bigint[])
            order by root_id
            """,
            (
                scope.library_id,
                [
                    scope.root_database_ids["root-a"],
                    scope.root_database_ids["root-b"],
                ],
            ),
        ).fetchall()
    assert {row["running_generation_id"] for row in lanes} == {
        accepted.generation_id
    }
    assert {row["running_job_id"] for row in lanes} == {second[1]}
