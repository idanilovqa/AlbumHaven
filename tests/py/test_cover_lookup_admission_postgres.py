from __future__ import annotations

from datetime import datetime, timezone
import multiprocessing
import os
from uuid import uuid4

import pytest

from music_app.services.album_cover_candidate_snapshots_postgres import AlbumCoverCandidateSnapshotRepository
from music_app.services.cover_lookup_tasks_postgres import CoverLookupTasksPostgresAdapter
import music_app.services.cover_lookup_tasks as task_service
from tests.e2e.support import isolatedPostgres


def _admit_in_process(runtime_url, payload, preferred, barrier, results):
    try:
        repository = CoverLookupTasksPostgresAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect,
        )
        barrier.wait(timeout=20)
        result, claimed = repository.admit_notification(payload, preferred_task_id=preferred)
        results.put((result, claimed, ""))
    except Exception as exc:
        results.put(({}, False, repr(exc)))


@pytest.fixture
def admission_database():
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs not configured.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    token = "cover-admission-" + uuid4().hex
    with isolatedPostgres._connect(setup_url) as connection:
        library_id = connection.execute("""select libraries.id from app.bootstrap_owners owners
            join library.libraries libraries on libraries.owner_account_id=owners.account_id
            where owners.owner_key='local-bootstrap-owner' and libraries.name='Local Library'
              and libraries.library_kind='local'""").fetchone()["id"]
        artist_id = connection.execute("""insert into library.local_artists
            (library_id,artist_key,name) values(%s,%s,%s) returning id""",
            (library_id, token, token)).fetchone()["id"]
        album_id = connection.execute("""insert into library.local_albums
            (library_id,artist_id,album_key,title) values(%s,%s,%s,%s) returning id""",
            (library_id, artist_id, token, token)).fetchone()["id"]
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
    repository = CoverLookupTasksPostgresAdapter(config, connect=isolatedPostgres._connect)
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "id": token, "status": "pending", "type": "cover-art-lookup", "artist": token,
        "album": token, "created_at": now, "notification_order_at": now,
        "track_paths": [str(os.path.abspath(token + ".mp3"))], "manual_urls": [],
        "album_payload": {"id": album_id, "key": token, "name": token, "album_artist": token},
        "job_contract": {"job_kind": "candidate_lookup"}, "notification_action_taken": False,
    }
    try:
        yield repository, config, payload, album_id
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from ops.cover_lookup_tasks where task_key like %s", (token + "%",))
            connection.execute("delete from library.local_albums where id=%s", (album_id,))
            connection.execute("delete from library.local_artists where id=%s", (artist_id,))


@pytest.mark.parametrize("retry", [False, True])
def test_two_processes_admit_only_one_provider_execution(admission_database, retry):
    repository, config, payload, _album_id = admission_database
    preferred = payload["id"] if retry else ""
    if retry:
        repository.upsert_notification({**payload, "status": "completed", "progress": 100,
            "possible_matches": [{"id": "retained", "url": "https://example.org/cover.jpg"}],
            "notification_action_taken": True})
    context = multiprocessing.get_context("spawn")
    barrier, results = context.Barrier(2), context.Queue()
    processes = [context.Process(target=_admit_in_process, args=(
        config["ALBUM_HAVEN_APP_DATABASE_URL"], {**payload, "id": payload["id"] + f"-{index}"},
        preferred, barrier, results,
    )) for index in range(2)]
    try:
        for process in processes:
            process.start()
        outputs = [results.get(timeout=40) for _ in processes]
        for process in processes:
            process.join(timeout=10)
            assert process.exitcode == 0
        assert [error for _, _, error in outputs] == ["", ""]
        assert sum(claimed for _, claimed, _ in outputs) == 1
        admitted = [task for task, _, _ in outputs]
        assert admitted[0]["id"] == admitted[1]["id"]
        assert admitted[0]["search_generation"] == admitted[1]["search_generation"]
        assert admitted[0]["search_generation"] != admitted[0]["id"]
        assert datetime.fromisoformat(admitted[0]["notification_order_at"]) == datetime.fromisoformat(payload["notification_order_at"])
        if retry:
            assert admitted[0]["id"] == preferred
            assert admitted[0]["possible_matches"][0]["id"] == "retained"
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=10)
        results.close()
        results.join_thread()


def test_obsolete_worker_cannot_overwrite_retry_or_manual_selection(admission_database):
    repository, _config, payload, _album_id = admission_database
    first, _ = repository.admit_notification(payload)
    repository.upsert_notification({**first, "status": "completed"},
        expected_search_generation=first["search_generation"])
    second, claimed = repository.admit_notification(payload, preferred_task_id=first["id"])
    assert claimed and second["search_generation"] != first["search_generation"]
    repository.upsert_notification({**first, "status": "failed", "message": "obsolete failure"},
        expected_search_generation=first["search_generation"])
    current = repository.load_notification(second["id"])
    assert current["status"] == "pending"
    assert current["search_generation"] == second["search_generation"]
    # The legacy/manual mutation API remains usable; a worker cannot undo its action.
    selected = {**second, "status": "completed", "notification_action_taken": True,
                "selected_candidate_id": "manual-cover"}
    repository.upsert_notification(selected)
    repository.upsert_notification({**second, "status": "completed", "notification_action_taken": False},
        expected_search_generation=second["search_generation"])
    current = repository.load_notification(second["id"])
    assert current["notification_action_taken"] is True
    assert current["selected_candidate_id"] == "manual-cover"


def test_preferred_task_requires_matching_paths_unless_rebind_is_authorized(admission_database):
    repository, _config, payload, _album_id = admission_database
    first, _ = repository.admit_notification(payload)
    repository.upsert_notification({**first, "status": "completed"}, expected_search_generation=first["search_generation"])
    moved = {**payload, "track_paths": [payload["track_paths"][0] + ".moved"]}
    with pytest.raises(ValueError, match="does not belong"):
        repository.admit_notification(moved, preferred_task_id=first["id"])
    claimed, accepted = repository.admit_notification(moved, preferred_task_id=first["id"], allow_preferred_path_rebind=True)
    assert accepted and claimed["id"] == first["id"]
    assert claimed["track_paths"] == moved["track_paths"]


def test_old_server_timeout_cannot_interrupt_new_execution(admission_database):
    repository, config, payload, _album_id = admission_database
    first, _ = repository.admit_notification(payload)
    repository.upsert_notification({**first, "status": "failed"}, expected_search_generation=first["search_generation"])
    second, _ = repository.admit_notification(payload, preferred_task_id=first["id"])
    task_service.reset_cover_lookup_runtime_state()
    try:
        with task_service._COVER_LOOKUP_TASKS_LOCK:
            task_service._COVER_LOOKUP_TASKS[first["id"]] = {
                **first, "status": "running", "created_at": "2000-01-01T00:00:00+00:00",
                "started_at": "2000-01-01T00:00:00+00:00", "updated_at": "2000-01-01T00:00:00+00:00",
            }
        task_service._reconcile_stale_cover_lookup_tasks(config=config)
        current = repository.load_notification(first["id"])
        assert current["status"] == "pending"
        assert current["search_generation"] == second["search_generation"]
    finally:
        task_service.reset_cover_lookup_runtime_state()


def test_old_completed_memory_cannot_mark_new_running_search_as_art_chosen(admission_database):
    repository, config, payload, _album_id = admission_database
    first, _ = repository.admit_notification(payload)
    completed = {**first, "status": "completed"}
    repository.upsert_notification(completed, expected_search_generation=first["search_generation"])
    second, _ = repository.admit_notification(payload, preferred_task_id=first["id"])
    task_service.reset_cover_lookup_runtime_state()
    try:
        with task_service._COVER_LOOKUP_TASKS_LOCK:
            task_service._COVER_LOOKUP_TASKS[first["id"]] = completed
        assert task_service.mark_cover_lookup_notifications_action_taken_for_track_paths(
            set(payload["track_paths"]), config=config,
        ) == []
        assert task_service.mark_cover_lookup_task_notification_action_taken(first["id"], config=config) is None
        current = repository.load_notification(first["id"])
        assert current["search_generation"] == second["search_generation"]
        assert current["notification_action_taken"] is False
    finally:
        task_service.reset_cover_lookup_runtime_state()


def test_remote_execution_detail_keeps_all_known_retry_candidates(admission_database):
    repository, config, payload, _album_id = admission_database
    candidates = [{"id": f"retained-{index}", "url": f"https://example.org/{index}.jpg"} for index in range(80)]
    repository.upsert_notification({**payload, "status": "completed", "possible_matches": candidates})
    admitted, _ = repository.admit_notification(payload, preferred_task_id=payload["id"])
    task_service.reset_cover_lookup_runtime_state()
    try:
        detail = task_service.read_cover_lookup_task(admitted["id"], config=config)
        assert detail["search_generation"] == admitted["search_generation"]
        assert [candidate["id"] for candidate in detail["possible_matches"]] == [candidate["id"] for candidate in candidates]
        assert task_service.cover_lookup_result(admitted["id"]) == {}
    finally:
        task_service.reset_cover_lookup_runtime_state()


@pytest.mark.parametrize("interrupted", [False, True])
def test_candidate_publication_is_fenced_by_current_task_generation(admission_database, interrupted):
    repository, config, payload, album_id = admission_database
    first, _ = repository.admit_notification(payload)
    snapshots = AlbumCoverCandidateSnapshotRepository(config, connect=isolatedPostgres._connect, task_id=first["id"])
    candidate = {"id": "first", "source": "apple", "url": "https://example.org/first.jpg"}
    params = dict(album_id=album_id, search_kind="manual", search_started_at=payload["created_at"],
                  candidates=[candidate], best_candidate_id="first", automatic_improvement=False)
    assert snapshots.publish_generation(search_generation=first["search_generation"], **params)
    if not interrupted:
        assert snapshots.finish_generation(album_id=album_id, search_generation=first["search_generation"], status="completed")
    repository.upsert_notification({**first, "status": "failed" if interrupted else "completed"},
        expected_search_generation=first["search_generation"])
    second, _ = repository.admit_notification(payload, preferred_task_id=first["id"])
    assert not snapshots.publish_generation(search_generation=first["search_generation"], **params)
    assert not snapshots.finish_generation(album_id=album_id, search_generation=first["search_generation"], status="failed")
    params["search_started_at"] = datetime.now(timezone.utc).isoformat()
    assert snapshots.publish_generation(search_generation=second["search_generation"], **params)
    assert str(snapshots.get_for_album_context(album_id=album_id)["search_generation"]) == second["search_generation"]
