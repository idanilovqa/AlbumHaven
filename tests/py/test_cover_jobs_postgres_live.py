from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.cover_jobs_postgres import PostgresCoverJobRepository
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from tests.e2e.support import isolatedPostgres


def _skip_or_fail_ci(message: str) -> None:
    if any(
        str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    ):
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _database_urls_or_skip() -> tuple[str, str]:
    try:
        setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated setup and runtime Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        ((urlparse(url).hostname or "").casefold(), urlparse(url).port or 5432, urlparse(url).path)
        for url in (setup_url, runtime_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Dedicated Postgres roles do not share one database.")
    return setup_url, runtime_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("drop schema if exists app, integration, library, ops cascade")


@pytest.fixture(scope="module")
def live_cover_database():
    setup_url, runtime_url = _database_urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        yield setup_url, runtime_url
    finally:
        _drop_schemas(setup_url)


def _seed_cover_scope(setup_url: str) -> tuple[int, int, str, str]:
    suffix = uuid4().hex[:10]
    album_key = f"cover-album-{suffix}"
    origin_key = f"cover-origin-{suffix}"
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(connection.execute(
            """
            insert into app.accounts (
              display_name, username_display, username_normalized,
              contact_email, contact_email_normalized, account_kind, is_active
            ) values (%s, %s, %s, %s, %s, 'managed', true)
            returning id
            """,
            (suffix, suffix, suffix, f"{suffix}@example.invalid", f"{suffix}@example.invalid"),
        ).fetchone()["id"])
        library_id = int(connection.execute(
            "insert into library.libraries (owner_account_id, name, library_kind) "
            "values (%s, %s, 'local') returning id",
            (account_id, f"Cover {suffix}"),
        ).fetchone()["id"])
        connection.execute(
            "insert into library.library_memberships (library_id, account_id, membership_role) "
            "values (%s, %s, 'owner')",
            (library_id, account_id),
        )
        connection.execute(
            "insert into app.capabilities (account_id, capability_key, scope_kind, scope_id) "
            "values (%s, 'library.covers.lookup', 'library', %s)",
            (account_id, library_id),
        )
        connection.execute(
            "insert into app.request_origins "
            "(account_id, client_surface_class, origin_type, origin_key) "
            "values (%s, 'private_web', 'browser', %s)",
            (account_id, origin_key),
        )
        root_id = int(connection.execute(
            "insert into library.library_roots "
            "(library_id, root_path, root_kind, is_active, metadata) "
            "values (%s, %s, 'main', true, '{}'::jsonb) returning id",
            (library_id, rf"C:\private\cover-{suffix}"),
        ).fetchone()["id"])
        artist_id = int(connection.execute(
            "insert into library.local_artists (library_id, artist_key, name) "
            "values (%s, %s, 'Cover Artist') returning id",
            (library_id, f"artist-{suffix}"),
        ).fetchone()["id"])
        album_id = int(connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title) "
            "values (%s, %s, %s, 'Cover Album') returning id",
            (library_id, artist_id, album_key),
        ).fetchone()["id"])
        track_id = int(connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title) "
            "values (%s, %s, %s, %s, 'Track') returning id",
            (library_id, album_id, artist_id, f"track-{suffix}"),
        ).fetchone()["id"])
        connection.execute(
            "insert into library.local_track_files "
            "(track_id, library_root_id, private_path, relative_path) "
            "values (%s, %s, %s, '01.flac')",
            (track_id, root_id, rf"C:\private\cover-{suffix}\01.flac"),
        )
    return account_id, library_id, album_key, origin_key


def test_live_cover_acceptance_is_atomic_path_free_restartable_and_revision_fenced(
    live_cover_database,
):
    setup_url, runtime_url = live_cover_database
    account_id, library_id, album_key, origin_key = _seed_cover_scope(setup_url)
    jobs = PostgresJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    )
    repository = PostgresCoverJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=jobs,
    )
    generation = uuid4()
    task_key = f"lookup-{uuid4().hex}"
    accepted = repository.accept_candidate_lookup(
        task_key=task_key,
        library_id=library_id,
        album_key=album_key,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        candidate_generation=generation,
        resource_revision=0,
        scheduled_at=datetime.now(timezone.utc),
    )
    repeated = repository.accept_candidate_lookup(
        task_key=task_key,
        library_id=library_id,
        album_key=album_key,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        candidate_generation=generation,
        resource_revision=0,
        scheduled_at=datetime.now(timezone.utc),
    )

    assert repeated.task_id == accepted.task_id
    assert repeated.job_id == accepted.job_id
    restarted = PostgresCoverJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    )
    task = restarted.get_task(task_key=task_key, library_id=library_id)
    assert task is not None and task["job_id"] == accepted.job_id
    assert task["local_album_id"] is not None and task["library_root_id"] is not None
    assert task["candidate_generation"] == generation
    with isolatedPostgres._connect(setup_url) as connection:
        generic = connection.execute(
            "select subject_ref, parameters, idempotency_key from ops.jobs where id = %s",
            (accepted.job_id,),
        ).fetchone()
    encoded = json.dumps(dict(generic), default=str).casefold()
    assert "private" not in encoded
    assert "01.flac" not in encoded

    updated = restarted.compare_and_set_task(
        task_key=task_key,
        library_id=library_id,
        expected_row_revision=accepted.row_revision,
        allowed_statuses=("pending",),
        next_status="running",
    )
    stale = restarted.compare_and_set_task(
        task_key=task_key,
        library_id=library_id,
        expected_row_revision=accepted.row_revision,
        allowed_statuses=("running",),
        next_status="failed",
        completed_at=datetime.now(timezone.utc),
    )
    assert updated is not None
    assert stale is None


def test_live_claimed_cover_lookup_is_worker_scoped_cancelable_and_fenced(
    live_cover_database,
):
    setup_url, runtime_url = live_cover_database
    account_id, library_id, album_key, origin_key = _seed_cover_scope(setup_url)
    worker_url = os.environ["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"]
    app_jobs = PostgresJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    )
    app_covers = PostgresCoverJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=app_jobs,
    )
    task_key = f"lookup-{uuid4().hex}"
    accepted = app_covers.accept_candidate_lookup(
        task_key=task_key,
        library_id=library_id,
        album_key=album_key,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        candidate_generation=uuid4(),
        resource_revision=0,
        scheduled_at=datetime.now(timezone.utc),
        task_payload={
            "id": task_key,
            "status": "pending",
            "progress": 0,
            "manual_urls": ["https://covers.example/manual.jpg"],
        },
    )
    worker_jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claimed_at = datetime.now(timezone.utc)
    claim = None
    for claim_index in range(3):
        candidate = worker_jobs.claim(
            worker_id=f"cover-worker-live-{claim_index}",
            now=claimed_at,
            lease_seconds=60,
            kinds=("cover_lookup",),
        )
        if candidate is None or candidate.job_id == accepted.job_id:
            claim = candidate
            break
    assert claim is not None and claim.job_id == accepted.job_id
    worker_covers = PostgresCoverJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=worker_jobs,
    )
    claim_values = {
        "task_key": task_key,
        "task_id": accepted.task_id,
        "library_id": library_id,
        "job_id": claim.job_id,
        "attempt": claim.attempt,
        "worker_id": claim.worker_id,
        "lease_token": claim.lease_token,
        "now": claimed_at + timedelta(seconds=1),
    }
    assert worker_covers.validate_claimed_candidate_lookup(**claim_values) is True
    scope = worker_covers.load_claimed_candidate_lookup(**claim_values)
    assert scope is not None
    assert scope.album["name"] == "Cover Album"
    assert len(scope.track_paths) == 1 and scope.track_paths[0].endswith("01.flac")
    assert scope.manual_urls == ("https://covers.example/manual.jpg",)
    running = worker_covers.publish_claimed_candidate_lookup(
        **claim_values,
        expected_row_revision=scope.row_revision,
        task_payload={**scope.task_payload, "status": "running", "progress": 12},
    )
    assert running is not None and running.status == "running"

    canceled = app_covers.request_candidate_lookup_cancellation(
        task_key=task_key,
        library_id=library_id,
        actor_account_id=account_id,
        now=claimed_at + timedelta(seconds=2),
    )
    assert canceled is not None and canceled["cancel_requested"] is True
    assert worker_covers.candidate_lookup_cancel_requested(
        **{**claim_values, "now": claimed_at + timedelta(seconds=3)}
    ) is True
    stale = worker_covers.publish_claimed_candidate_lookup(
        **{**claim_values, "now": claimed_at + timedelta(seconds=3)},
        expected_row_revision=running.row_revision,
        task_payload={**running.task_payload, "status": "completed"},
    )
    assert stale is None


def test_live_bulk_cover_refresh_is_restartable_worker_scoped_and_cancelable(
    live_cover_database,
):
    setup_url, runtime_url = live_cover_database
    account_id, library_id, _album_key, origin_key = _seed_cover_scope(setup_url)
    worker_url = os.environ["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"]
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.libraries set metadata = jsonb_set(metadata, "
            "'{inventory_mutation_revision}', '12'::jsonb) where id = %s",
            (library_id,),
        )

    app_jobs = PostgresJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    )
    app_covers = PostgresCoverJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=app_jobs,
    )
    requested_at = datetime.now(timezone.utc)
    task_key = f"bulk-{uuid4().hex}"
    accepted = app_covers.accept_bulk_refresh(
        task_key=task_key,
        library_id=library_id,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        mode="manual",
        force_search=True,
        resource_revision=12,
        scheduled_at=requested_at,
    )
    repeated = app_covers.accept_bulk_refresh(
        task_key=f"ignored-{uuid4().hex}",
        library_id=library_id,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        mode="manual",
        force_search=True,
        resource_revision=12,
        scheduled_at=requested_at,
    )
    assert repeated.task_id == accepted.task_id
    assert repeated.job_id == accepted.job_id
    assert repeated.already_running is True

    worker_jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claimed_at = requested_at + timedelta(seconds=1)
    claim = worker_jobs.claim(
        worker_id="cover-refresh-live",
        now=claimed_at,
        lease_seconds=60,
        kinds=("cover_bulk_refresh",),
    )
    assert claim is not None and claim.job_id == accepted.job_id
    worker_covers = PostgresCoverJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=worker_jobs,
    )
    claim_values = {
        "task_id": accepted.task_id,
        "library_id": library_id,
        "job_id": claim.job_id,
        "attempt": claim.attempt,
        "worker_id": claim.worker_id,
        "lease_token": claim.lease_token,
        "now": claimed_at + timedelta(seconds=1),
    }
    scope = worker_covers.begin_claimed_cover_refresh(
        **claim_values,
        task_key=task_key,
        mode="manual",
        inventory_revision=12,
    )
    assert scope is not None
    assert scope.mode == "manual" and scope.force_search is True
    assert scope.progress_total == 1
    assert len(scope.file_cache) == 1
    assert next(iter(scope.file_cache)).endswith("01.flac")

    selected_cover = Path(next(iter(scope.file_cache))).parent / "cover.jpg"
    persisted = worker_covers.persist_claimed_automatic_cover_selection(
        **claim_values,
        track_paths=set(scope.file_cache),
        selected_cover_path=selected_cover,
        cover_revision="claimed-revision-1",
        cover_selection_origin="automatic",
        reject_if_user_controlled=True,
    )
    assert persisted["album_rows_updated"] == 1
    with isolatedPostgres._connect(setup_url) as connection:
        selected = connection.execute(
            "select cover_path, metadata ->> 'cover_selection_origin' as origin "
            "from library.local_albums where library_id = %s",
            (library_id,),
        ).fetchone()
    assert selected["cover_path"] == str(selected_cover)
    assert selected["origin"] == "automatic"

    running = app_covers.load_cover_refresh_status(library_id=library_id)
    assert running == {
        "covers_in_progress": True,
        "covers_processed": 0,
        "covers_total": 0,
        "covers_downloaded": 0,
        "covers_current_folder": "",
    }
    next_revision = worker_covers.checkpoint_claimed_cover_refresh(
        **claim_values,
        expected_row_revision=scope.row_revision,
        progress_current=1,
        progress_total=1,
        downloaded_count=1,
        safe_display_label="Cover Album",
    )
    assert next_revision is not None
    assert worker_covers.finish_claimed_cover_refresh(
        **claim_values,
        expected_row_revision=next_revision,
        next_status="completed",
        processed_count=1,
        downloaded_count=1,
    ) is True
    completed = app_covers.load_cover_refresh_status(library_id=library_id)
    assert completed == {
        "covers_in_progress": False,
        "covers_processed": 1,
        "covers_total": 1,
        "covers_downloaded": 1,
        "covers_current_folder": "",
    }
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = %s where id = %s",
            (requested_at, accepted.job_id),
        )
    with pytest.raises(RuntimeError, match="resource or lease fence"):
        worker_covers.persist_claimed_automatic_cover_selection(
            **{**claim_values, "now": requested_at + timedelta(seconds=5)},
            track_paths=set(scope.file_cache),
            selected_cover_path=selected_cover,
            cover_revision="stale-revision",
            cover_selection_origin="automatic",
            reject_if_user_controlled=True,
        )

    canceled_task = app_covers.accept_bulk_refresh(
        task_key=f"cancel-{uuid4().hex}",
        library_id=library_id,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        mode="manual",
        force_search=False,
        resource_revision=12,
        scheduled_at=requested_at + timedelta(seconds=3),
    )
    canceled = app_covers.request_bulk_refresh_cancellation(
        library_id=library_id,
        account_id=account_id,
        now=requested_at + timedelta(seconds=4),
    )
    assert canceled == {"cancelled": True, "covers_in_progress": False}
    with isolatedPostgres._connect(setup_url) as connection:
        state = connection.execute(
            "select state from ops.jobs where id = %s", (canceled_task.job_id,)
        ).fetchone()["state"]
    assert state == "canceled"


def test_live_remote_cover_save_accepts_candidate_and_fences_checkpoints(
    live_cover_database,
):
    setup_url, runtime_url = live_cover_database
    account_id, library_id, album_key, origin_key = _seed_cover_scope(setup_url)
    worker_url = os.environ["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"]
    app_jobs = PostgresJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    )
    app_covers = PostgresCoverJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=app_jobs,
    )
    generation = uuid4()
    task_key = str(generation)
    lookup = app_covers.accept_candidate_lookup(
        task_key=task_key,
        library_id=library_id,
        album_key=album_key,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        candidate_generation=generation,
        resource_revision=0,
        scheduled_at=datetime.now(timezone.utc),
    )
    candidate_id = f"candidate-{uuid4().hex}"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.cover_lookup_tasks set status = 'completed', completed_at = now(), "
            "provider_payload = jsonb_build_object('possible_matches', jsonb_build_array("
            "jsonb_build_object('id', %s::text, 'url', 'https://covers.invalid/private.jpg', "
            "'thumbnail_url', 'https://covers.invalid/thumb.jpg', 'art_kind', 'cover'))), "
            "row_revision = row_revision + 1 where id = %s",
            (candidate_id, lookup.task_id),
        )
        connection.execute(
            "update ops.jobs set state = 'succeeded', started_at = now(), "
            "completed_at = now(), outcome_code = 'seeded' where id = %s",
            (lookup.job_id,),
        )

    accepted = app_covers.accept_remote_save(
        task_key=task_key,
        library_id=library_id,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        candidate_generation=generation,
        candidate_id=candidate_id,
        resource_revision=0,
        scheduled_at=datetime.now(timezone.utc),
    )
    repeated = app_covers.accept_remote_save(
        task_key=task_key,
        library_id=library_id,
        account_id=account_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        candidate_generation=generation,
        candidate_id=candidate_id,
        resource_revision=0,
        scheduled_at=datetime.now(timezone.utc),
    )
    assert repeated.job_id == accepted.job_id
    with isolatedPostgres._connect(setup_url) as connection:
        generic = connection.execute(
            "select parameters from ops.jobs where id = %s", (accepted.job_id,)
        ).fetchone()["parameters"]
    assert "covers.invalid" not in json.dumps(generic)

    worker_jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claimed_at = datetime.now(timezone.utc)
    claim = worker_jobs.claim(
        worker_id="cover-save-live",
        now=claimed_at,
        lease_seconds=60,
        kinds=("cover_remote_save",),
    )
    assert claim is not None and claim.job_id == accepted.job_id
    worker_covers = PostgresCoverJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=worker_jobs,
    )
    claim_values = {
        "task_key": task_key,
        "task_id": accepted.task_id,
        "library_id": library_id,
        "job_id": claim.job_id,
        "attempt": claim.attempt,
        "worker_id": claim.worker_id,
        "lease_token": claim.lease_token,
        "now": claimed_at + timedelta(seconds=1),
    }
    scope = worker_covers.load_claimed_remote_save(**claim_values)
    assert scope is not None
    assert scope.candidate_id == candidate_id
    assert scope.selected_candidate["url"].startswith("https://covers.invalid/")
    assert len(scope.track_paths) == 1 and scope.track_paths[0].endswith("01.flac")

    revision = scope.checkpoint_revision
    for checkpoint in ("download_started", "artifact_written"):
        next_revision = worker_covers.checkpoint_claimed_remote_save(
            **claim_values,
            checkpoint_id=scope.checkpoint_id,
            expected_row_revision=revision,
            next_checkpoint=checkpoint,
            artifact_key=uuid4() if checkpoint == "artifact_written" else None,
        )
        assert next_revision is not None
        revision = next_revision
    next_revision = worker_covers.persist_claimed_remote_cover_selection(
        **claim_values,
        checkpoint_id=scope.checkpoint_id,
        expected_checkpoint_revision=revision,
        selected_cover_path=r"C:\private\cover.jpg",
        selected_cover_revision="cover-revision",
        linked_remote=False,
    )
    assert next_revision is not None
    revision = next_revision
    next_revision = worker_covers.checkpoint_claimed_remote_save(
        **claim_values,
        checkpoint_id=scope.checkpoint_id,
        expected_row_revision=revision,
        next_checkpoint="promotion_completed",
    )
    assert next_revision is not None
    revision = next_revision
    published = worker_covers.publish_claimed_remote_save(
        **claim_values,
        checkpoint_id=scope.checkpoint_id,
        expected_checkpoint_revision=revision,
        expected_task_revision=scope.task_revision,
        selected_cover_path=r"C:\private\cover.jpg",
        linked_remote=False,
    )
    assert published is not None
    with isolatedPostgres._connect(setup_url) as connection:
        completed = connection.execute(
            "select status, selected_cover_private_path from ops.cover_lookup_tasks "
            "where id = %s",
            (accepted.task_id,),
        ).fetchone()
    assert completed["status"] == "completed"
    assert completed["selected_cover_private_path"].endswith("cover.jpg")
