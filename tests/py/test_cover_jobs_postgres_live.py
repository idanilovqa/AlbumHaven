from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
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


@pytest.mark.parametrize("initial_metadata", [{}, {"unrelated": {"preserve": True}}])
def test_live_cover_commit_populates_missing_scan_cache_parent(live_cover_database, initial_metadata):
    setup_url, runtime_url = live_cover_database
    _, library_id, album_key, _ = _seed_cover_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        selected = connection.execute(
            "select album.id as album_id, file.id as file_id, file.private_path "
            "from library.local_albums album "
            "join library.local_tracks track on track.album_id = album.id "
            "join library.local_track_files file on file.track_id = track.id "
            "where album.library_id = %s and album.album_key = %s",
            (library_id, album_key),
        ).fetchone()
        connection.execute(
            "update library.local_track_files set metadata = %s::jsonb where id = %s",
            (json.dumps(initial_metadata), selected["file_id"]),
        )
    cover_path = str(Path(selected["private_path"]).with_name("selected.jpg"))
    with isolatedPostgres._connect(runtime_url) as connection:
        result = connection.execute(
            "select * from library.commit_cover_selection("
            "%s,%s,%s::text[],0,0,null,%s,'new-selection','user',false,"
            "null,null,null,null,null,null,null,null,clock_timestamp())",
            (library_id, selected["album_id"], [selected["private_path"]], cover_path),
        ).fetchone()
        assert result["committed"] is True
        assert result["cover_mutation_revision"] == 1
        metadata = connection.execute(
            "select metadata from library.local_track_files where id = %s",
            (selected["file_id"],),
        ).fetchone()["metadata"]
        assert all(metadata[key] == value for key, value in initial_metadata.items())
        entry = metadata["scan_cache"]["file_entry"]
        assert entry["cover_path"] == cover_path
        assert entry["cover_revision"] == "new-selection"
        assert entry["cover_selection_origin"] == "user"


@pytest.mark.parametrize(
    ("inventory_revision", "cover_revision", "reason"),
    [(None, 0, "inventory_revision_conflict"), (0, None, "revision_conflict")],
)
def test_live_cover_commit_rejects_missing_expected_revision(
    live_cover_database, inventory_revision, cover_revision, reason,
):
    setup_url, runtime_url = live_cover_database
    _, library_id, album_key, _ = _seed_cover_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute(
            "select id from library.local_albums where library_id = %s and album_key = %s",
            (library_id, album_key),
        ).fetchone()["id"]
        paths = [row["private_path"] for row in connection.execute(
            "select file.private_path from library.local_track_files file "
            "join library.local_tracks track on track.id = file.track_id "
            "where track.album_id = %s", (album_id,),
        ).fetchall()]
    with isolatedPostgres._connect(runtime_url) as connection:
        result = connection.execute(
            "select * from library.commit_cover_selection("
            "%s, %s, %s::text[], %s::bigint, %s::bigint, null, null, null, null, "
            "true, null, null, null, null, null, null, null, null, clock_timestamp())",
            (library_id, album_id, paths, inventory_revision, cover_revision),
        ).fetchone()
    assert result["committed"] is False
    assert result["reason_code"] == reason
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select cover_mutation_revision from library.cover_mutation_state where library_id = %s",
            (library_id,),
        ).fetchone()["cover_mutation_revision"] == 0


@pytest.mark.parametrize("missing_field", ["selected_origin", "clear_selection"])
def test_live_cover_commit_rejects_null_selection_controls(live_cover_database, missing_field):
    import psycopg

    setup_url, runtime_url = live_cover_database
    _, library_id, album_key, _ = _seed_cover_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute(
            "update library.local_albums set cover_path='retained.jpg', "
            "metadata=metadata || '{\"cover_revision\":\"retained\","
            "\"cover_selection_origin\":\"user\"}'::jsonb "
            "where library_id=%s and album_key=%s returning id",
            (library_id, album_key),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.cover_mutation_state(library_id,cover_mutation_revision) "
            "values(%s,9) on conflict(library_id) do update set cover_mutation_revision=9",
            (library_id,),
        )
        paths = [row["private_path"] for row in connection.execute(
            "select file.private_path from library.local_track_files file "
            "join library.local_tracks track on track.id=file.track_id where track.album_id=%s",
            (album_id,),
        ).fetchall()]
        snapshot_sql = """select to_jsonb(album) as album, to_jsonb(file) as file,
            library.read_cover_mutation_revision(album.library_id) as cover_revision
            from library.local_albums album
            join library.local_tracks track on track.album_id=album.id
            join library.local_track_files file on file.track_id=track.id
            where album.id=%s order by file.id"""
        before = connection.execute(snapshot_sql, (album_id,)).fetchall()
    with pytest.raises(psycopg.errors.RaiseException, match="selection"):
        with isolatedPostgres._connect(runtime_url) as connection:
            connection.execute(
                "select * from library.commit_cover_selection("
                "%s,%s,%s::text[],0,9,'retained','replacement.jpg','replacement',"
                "%s::text,%s::boolean,null,null,null,null,null,null,null,null,clock_timestamp())",
                (library_id, album_id, paths,
                 None if missing_field == "selected_origin" else "user",
                 None if missing_field == "clear_selection" else False),
            ).fetchone()
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(snapshot_sql, (album_id,)).fetchall() == before


@pytest.mark.parametrize("operation", ["commit", "recover"])
def test_live_cover_authority_rejects_unknown_durable_claim_without_sql_ambiguity(
    live_cover_database, operation,
):
    setup_url, runtime_url = live_cover_database
    _, library_id, album_key, _ = _seed_cover_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute(
            "select id from library.local_albums where library_id = %s and album_key = %s",
            (library_id, album_key),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.cover_mutation_state (library_id) values (%s)",
            (library_id,),
        )
    # A missing claim must reach the fenced query and reject without a SQL error.
    with isolatedPostgres._connect(runtime_url) as connection:
        if operation == "commit":
            result = connection.execute(
                "select * from library.commit_cover_selection("
                "%s, %s, array[]::text[], 0, 0, null, null, null, null, true, null, "
                "%s, -1, 1, 'missing-worker', 'missing-token', -1, 0, clock_timestamp())",
                (library_id, album_id, "a" * 64),
            ).fetchone()
            assert result["committed"] is False
            assert result["reason_code"] == "lease_lost"
        else:
            result = connection.execute(
                "select * from library.recover_cover_mutation("
                "%s, %s, 0, 0, null, 'replacement', %s, -1, 1, "
                "'missing-worker', 'missing-token', -1, 0, clock_timestamp())",
                (library_id, album_id, "a" * 64),
            ).fetchone()
            assert result["recovery_action"] == "ambiguous"


@pytest.mark.parametrize(
    ("kind", "policy", "max_attempts", "attempt_count", "cancel_requested", "expected_state", "expected_decision"),
    [
        ("auth_password_reset_delivery", "ambiguous_on_stale_lease", 1, 1, False, "ambiguous", "none"),
        ("auth_welcome_delivery", "retry_safe", 3, 3, False, "failed", "exhausted"),
        ("auth_welcome_delivery", "retry_safe", 3, 1, False, "retry_wait", "scheduled"),
        ("auth_password_reset_delivery", "ambiguous_on_stale_lease", 1, 1, True, "ambiguous", "none"),
        ("auth_welcome_delivery", "retry_safe", 3, 1, True, "canceled", "none"),
    ],
)
def test_live_cover_stale_reconciliation_preserves_generic_job_policy(
    live_cover_database, kind, policy, max_attempts, attempt_count, cancel_requested,
    expected_state, expected_decision,
):
    setup_url, _ = live_cover_database
    worker_url = os.environ["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"]
    key = f"cover-stale-policy-{uuid4().hex}"
    with isolatedPostgres._connect(setup_url) as connection:
        job_id = connection.execute(
            "insert into ops.jobs (kind, subject_kind, subject_ref, parameters, "
            "deployment_mode, client_surface, idempotency_key, max_attempts, "
            "recovery_policy, scheduled_at, state, attempt_count, lease_owner, "
            "lease_token, lease_expires_at, heartbeat_at, started_at, "
            "cancel_requested_at, cancel_reason_code) values ("
            "%s, 'mail_outbox', %s, '{}'::jsonb, "
            "'self_hosted_private_web', 'private_web', %s, %s, %s, "
            "clock_timestamp() - interval '2 minutes', 'running', %s, "
            "'expired-worker', %s, clock_timestamp() - interval '1 minute', "
            "clock_timestamp() - interval '2 minutes', "
            "clock_timestamp() - interval '2 minutes', "
            "case when %s then clock_timestamp() - interval '1 minute' else null end, "
            "case when %s then 'user_requested' else null end) returning id",
            (kind, key, key, max_attempts, policy, attempt_count, uuid4().hex,
             cancel_requested, cancel_requested),
        ).fetchone()["id"]
    with isolatedPostgres._connect(worker_url) as connection:
        connection.execute(
            "select * from ops.reconcile_stale_job_leases(clock_timestamp(), 1000)"
        ).fetchone()
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute(
            "select job.state, transition.retry_decision from ops.jobs job "
            "join ops.job_transitions transition on transition.job_id = job.id "
            "where job.id = %s and transition.prior_state = 'running'",
            (job_id,),
        ).fetchone()
    assert row == {"state": expected_state, "retry_decision": expected_decision}


def test_live_post_scan_cover_refresh_creates_its_durable_scope(
    live_cover_database,
):
    setup_url, _runtime_url = live_cover_database
    _account_id, library_id, _album_key, _origin_key = _seed_cover_scope(setup_url)
    inventory_revision = 7
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.libraries set metadata = jsonb_set(metadata, "
            "'{inventory_mutation_revision}', to_jsonb(%s::bigint)) where id = %s",
            (inventory_revision, library_id),
        )
        connection.execute(
            "insert into ops.jobs (kind, subject_kind, subject_ref, parameters, "
            "library_id, deployment_mode, client_surface, resource_revision, "
            "idempotency_key, scheduled_at, max_attempts, recovery_policy) "
            "values ('post_scan_cover_refresh', 'inventory_revision', %s, %s::jsonb, "
            "%s, 'self_hosted_private_web', 'private_web', %s, %s, now(), 2, "
            "'retry_safe')",
            (
                f"revision-{inventory_revision}",
                json.dumps({"inventory_revision": inventory_revision}),
                library_id,
                inventory_revision,
                f"post-scan-cover-refresh:{library_id}:{inventory_revision}",
            ),
        )

    worker_url = os.environ["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"]
    worker_jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claimed_at = datetime.now(timezone.utc)
    claim = worker_jobs.claim(
        worker_id="post-scan-cover-live",
        now=claimed_at,
        lease_seconds=60,
        kinds=("post_scan_cover_refresh",),
    )
    assert claim is not None and claim.library_id == library_id
    scope = PostgresCoverJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=worker_jobs,
    ).begin_claimed_cover_refresh(
        library_id=library_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=claimed_at + timedelta(seconds=1),
        task_key=f"revision-{inventory_revision}",
        mode="post_scan",
        inventory_revision=inventory_revision,
    )
    assert scope is not None
    assert scope.task_key == f"post-scan-{inventory_revision}"
    assert scope.mode == "post_scan"
    assert scope.force_search is False
    assert scope.progress_total == 1


def test_live_cover_acceptance_is_atomic_path_free_restartable_and_revision_fenced(
    live_cover_database,
):
    setup_url, runtime_url = live_cover_database
    account_id, library_id, album_key, origin_key = _seed_cover_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "delete from app.request_origins where account_id = %s", (account_id,),
        )
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
    assert repeated.row_revision == accepted.row_revision
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
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = %s",
            (accepted.job_id,),
        )
    assert worker_covers.publish_claimed_candidate_lookup(
        **{**claim_values, "now": claimed_at - timedelta(minutes=1)},
        expected_row_revision=running.row_revision,
        task_payload={**running.task_payload, "progress": 13},
    ) is None

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


def _assert_legacy_cover_fences_stale_observation(setup_url, library_id, expected_revision):
    # Internal observation contract only; runtime roles cannot call this helper.
    with isolatedPostgres._connect(setup_url) as connection:
        album = connection.execute(
            "select id, cover_path, metadata from library.local_albums where library_id=%s",
            (library_id,),
        ).fetchone()
        files = connection.execute(
            "select file.id, file.private_path, file.metadata from library.local_track_files file "
            "join library.local_tracks track on track.id=file.track_id "
            "where track.library_id=%s order by file.id", (library_id,),
        ).fetchall()
        assert connection.execute(
            "select cover_mutation_revision from library.cover_mutation_state where library_id=%s",
            (library_id,),
        ).fetchone()["cover_mutation_revision"] == expected_revision
        observed = [{
            "album_id": album["id"], "cover_path": "stale.jpg",
            "cover_state": {"cover_revision": "stale", "cover_selection_origin": "automatic"},
            "track_paths": [file["private_path"] for file in files],
        }]
        assert connection.execute(
            "select * from library.apply_scanned_cover_observations(%s,%s,%s::jsonb,now())",
            (library_id, expected_revision - 1, json.dumps(observed)),
        ).fetchone() == {
            "cover_publication_stale": True,
            "cover_mutation_revision": expected_revision,
            "changed_album_count": 0,
        }
        assert connection.execute(
            "select id, cover_path, metadata from library.local_albums where library_id=%s",
            (library_id,),
        ).fetchone() == album
        assert connection.execute(
            "select file.id, file.private_path, file.metadata from library.local_track_files file "
            "join library.local_tracks track on track.id=file.track_id "
            "where track.library_id=%s order by file.id", (library_id,),
        ).fetchall() == files


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
    _assert_legacy_cover_fences_stale_observation(setup_url, library_id, 1)
    worker_covers.persist_claimed_automatic_cover_selection(
        **claim_values, track_paths=set(scope.file_cache), selected_cover_path=selected_cover,
        cover_revision="claimed-revision-1", cover_selection_origin="automatic",
        reject_if_user_controlled=True,
    )
    _assert_legacy_cover_fences_stale_observation(setup_url, library_id, 1)
    worker_covers.persist_claimed_automatic_cover_selection(
        **claim_values, track_paths=set(scope.file_cache), selected_cover_path=selected_cover,
        cover_revision="user-selected", cover_selection_origin="user",
        reject_if_user_controlled=False,
    )
    rejected = worker_covers.persist_claimed_automatic_cover_selection(
        **claim_values, track_paths=set(scope.file_cache), selected_cover_path=selected_cover,
        cover_revision="must-not-replace-user", cover_selection_origin="automatic",
        reject_if_user_controlled=True,
    )
    assert rejected["album_rows_updated"] == 0
    _assert_legacy_cover_fences_stale_observation(setup_url, library_id, 2)
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select metadata ->> 'cover_revision' as revision from library.local_albums "
            "where library_id=%s", (library_id,),
        ).fetchone()["revision"] == "user-selected"

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
            "insert into ops.jobs (kind, subject_kind, subject_ref, parameters, "
            "library_id, deployment_mode, client_surface, resource_revision, "
            "idempotency_key, scheduled_at, max_attempts, recovery_policy) values "
            "('post_scan_cover_refresh', 'inventory_revision', 'revision-12', "
            "'{\"inventory_revision\":12}'::jsonb, %s, 'self_hosted_private_web', "
            "'private_web', 12, %s, now(), 2, 'retry_safe')",
            (library_id, f"post-scan-followup-{uuid4().hex}"),
        )
    assert app_covers.load_cover_refresh_status(library_id=library_id)[
        "covers_in_progress"
    ] is True
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = %s",
            (accepted.job_id,),
        )
    with pytest.raises(RuntimeError, match="resource or lease fence"):
        worker_covers.persist_claimed_automatic_cover_selection(
            **{**claim_values, "now": requested_at - timedelta(minutes=1)},
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


@pytest.mark.parametrize("inactive_root", [True, False], ids=["inactive-root", "expired-lease"])
def test_live_cover_recovery_fences_root_without_rejecting_expired_lease(
    live_cover_database, tmp_path, inactive_root,
):
    setup_url, runtime_url = live_cover_database
    account_id, library_id, album_key, origin_key = _seed_cover_scope(setup_url)
    worker_url = os.environ["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"]
    app_covers = PostgresCoverJobRepository(
        database_url=runtime_url, connect_to_database=isolatedPostgres._connect,
    )
    generation = uuid4()
    task_key = str(generation)
    admission = dict(
        task_key=task_key, library_id=library_id, account_id=account_id,
        request_origin_ref=f"browser:{origin_key}", deployment_mode="self_hosted_private_web",
        client_surface="private_web", candidate_generation=generation, resource_revision=0,
        scheduled_at=datetime.now(timezone.utc),
    )
    lookup = app_covers.accept_candidate_lookup(**admission, album_key=album_key)
    candidate_id = f"candidate-{uuid4().hex}"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.cover_lookup_tasks set status='completed',completed_at=now(), "
            "provider_payload=jsonb_build_object('possible_matches',jsonb_build_array("
            "jsonb_build_object('id',%s::text,'url','https://covers.invalid/private.jpg',"
            "'art_kind','cover'))),row_revision=row_revision+1 where id=%s",
            (candidate_id, lookup.task_id),
        )
        connection.execute(
            "update ops.jobs set state='succeeded',started_at=now(),completed_at=now(),"
            "outcome_code='seeded' where id=%s", (lookup.job_id,),
        )
        connection.execute(
            "insert into library.cover_mutation_state(library_id) values(%s) "
            "on conflict(library_id) do nothing", (library_id,),
        )
    accepted = app_covers.accept_remote_save(**admission, candidate_id=candidate_id)
    worker_jobs = PostgresJobRepository(
        database_url=worker_url, connect_to_database=isolatedPostgres._connect,
    )
    now = datetime.now(timezone.utc)
    claim = worker_jobs.claim(
        worker_id=f"recovery-{uuid4().hex}", now=now, lease_seconds=60,
        kinds=("cover_remote_save",),
    )
    assert claim is not None and claim.job_id == accepted.job_id
    worker_covers = PostgresCoverJobRepository(
        database_url=worker_url, connect_to_database=isolatedPostgres._connect,
        job_repository=worker_jobs,
    )
    claim_values = dict(
        task_key=task_key, task_id=accepted.task_id, library_id=library_id,
        job_id=claim.job_id, attempt=claim.attempt, worker_id=claim.worker_id,
        lease_token=claim.lease_token, now=now,
    )
    scope = worker_covers.load_claimed_remote_save(**claim_values)
    assert scope is not None
    revision = worker_covers.checkpoint_claimed_remote_save(
        **claim_values, checkpoint_id=scope.checkpoint_id,
        expected_row_revision=scope.checkpoint_revision, next_checkpoint="download_started",
    )
    assert revision is not None
    artifact = tmp_path / "prepared-cover.bin"
    artifact.write_bytes(b"owned recovery artifact")
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    with isolatedPostgres._connect(worker_url) as connection:
        revision = connection.execute(
            "select ops.checkpoint_claimed_cover_remote_save("
            "%s,%s,%s,%s,%s,%s,%s,'artifact_written',%s,%s,'prepared-revision',null) as revision",
            (scope.checkpoint_id, claim.job_id, claim.attempt, claim.worker_id,
             claim.lease_token, now, revision, uuid4(), digest),
        ).fetchone()["revision"]
    assert revision is not None
    snapshot_sql = (
        "select to_jsonb(album) as album,to_jsonb(state) as authority,"
        "to_jsonb(checkpoint) as checkpoint,to_jsonb(file) as file "
        "from ops.cover_remote_save_checkpoints checkpoint "
        "join library.local_albums album on album.id=checkpoint.local_album_id "
        "join library.cover_mutation_state state on state.library_id=album.library_id "
        "join library.local_tracks track on track.album_id=album.id "
        "join library.local_track_files file on file.track_id=track.id "
        "where checkpoint.id=%s order by file.id"
    )
    with isolatedPostgres._connect(setup_url) as connection:
        if inactive_root:
            connection.execute(
                "update library.library_roots set is_active=false where id=("
                "select library_root_id from ops.cover_remote_save_checkpoints where id=%s)",
                (scope.checkpoint_id,),
            )
        else:
            connection.execute(
                "update ops.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=%s",
                (claim.job_id,),
            )
        before = connection.execute(snapshot_sql, (scope.checkpoint_id,)).fetchall()
    assert len(before) == 1
    with isolatedPostgres._connect(worker_url) as connection:
        result = connection.execute(
            "select * from library.recover_cover_mutation("
            "%s,%s,0,0,null,'prepared-revision',%s,%s,%s,%s,%s,%s,%s,%s)",
            (library_id, before[0]["album"]["id"], digest, claim.job_id, claim.attempt,
             claim.worker_id, claim.lease_token, accepted.task_id, revision, now),
        ).fetchone()
    assert result["recovery_action"] == ("ambiguous" if inactive_root else "compensate")
    if not inactive_root:
        assert result["finalization_checkpoint_id"] == scope.checkpoint_id
        assert result["finalization_checkpoint_revision"] == revision
        assert result["cover_mutation_revision"] == 0
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(snapshot_sql, (scope.checkpoint_id,)).fetchall() == before
    assert hashlib.sha256(artifact.read_bytes()).hexdigest() == digest


@pytest.mark.parametrize("linked_remote", [False, True])
@pytest.mark.parametrize("identical_selection", [False, True])
def test_live_remote_cover_save_accepts_candidate_and_fences_checkpoints(
    live_cover_database, linked_remote, identical_selection,
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

    replay_values = dict(
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
    during_send = app_covers.accept_remote_save(**replay_values)
    assert during_send.row_revision == scope.task_revision

    revision = scope.checkpoint_revision
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = %s",
            (accepted.job_id,),
        )
    assert worker_covers.checkpoint_claimed_remote_save(
        **{**claim_values, "now": claimed_at - timedelta(minutes=1)},
        checkpoint_id=scope.checkpoint_id,
        expected_row_revision=revision,
        next_checkpoint="download_started",
    ) is None
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = clock_timestamp() + interval '60 seconds' where id = %s",
            (accepted.job_id,),
        )
    for checkpoint in ("download_started", "artifact_written"):
        next_revision = worker_covers.checkpoint_claimed_remote_save(
            **claim_values,
            checkpoint_id=scope.checkpoint_id,
            expected_row_revision=revision,
            next_checkpoint=checkpoint,
            artifact_key=uuid4() if checkpoint == "artifact_written" and not linked_remote else None,
        )
        assert next_revision is not None
        revision = next_revision
    for forbidden_checkpoint in ("authority_committed", "runtime_published"):
        assert worker_covers.checkpoint_claimed_remote_save(
            **claim_values,
            checkpoint_id=scope.checkpoint_id,
            expected_row_revision=revision,
            next_checkpoint=forbidden_checkpoint,
        ) is None
    selected_path = None if linked_remote else r"C:\private\cover.jpg"
    selected_revision = None if linked_remote else "cover-revision"
    if identical_selection:
        selected_metadata = {
            "cover_path": selected_path, "cover_revision": selected_revision,
            "cover_selection_origin": "user",
        }
        if linked_remote:
            selected_metadata.update({
                "remote_cover_url": "https://covers.invalid/private.jpg",
                "remote_cover_thumbnail_url": "https://covers.invalid/thumb.jpg",
                "remote_cover_source": None, "remote_cover_source_label": None,
                "remote_cover_album_url": None, "remote_cover_width": None,
                "remote_cover_height": None,
            })
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                "update library.local_albums set cover_path=%s,metadata=%s::jsonb where library_id=%s",
                (selected_path, json.dumps(selected_metadata), library_id),
            )
            connection.execute(
                "update library.local_track_files file set metadata=jsonb_build_object("
                "'scan_cache',jsonb_build_object('file_entry',%s::jsonb)) "
                "from library.local_tracks track where track.id=file.track_id and track.library_id=%s",
                (json.dumps(selected_metadata), library_id),
            )
            connection.execute(
                "insert into library.cover_mutation_state(library_id,cover_mutation_revision) "
                "values(%s,1) on conflict(library_id) do update set cover_mutation_revision=1",
                (library_id,),
            )
            connection.execute(
                "update library.libraries set metadata=metadata || "
                "jsonb_build_object('cover_mutation_revision',1) where id=%s", (library_id,),
            )
    next_revision = worker_covers.persist_claimed_remote_cover_selection(
        **claim_values,
        checkpoint_id=scope.checkpoint_id,
        expected_checkpoint_revision=revision,
        selected_cover_path=selected_path,
        selected_cover_revision=selected_revision,
        linked_remote=linked_remote,
    )
    assert next_revision is not None
    revision = next_revision
    _assert_legacy_cover_fences_stale_observation(setup_url, library_id, 1)
    with isolatedPostgres._connect(setup_url) as connection:
        evidence = connection.execute(
            "select checkpoint,cover_revision,artifact_key,artifact_sha256 "
            "from ops.cover_remote_save_checkpoints where id=%s", (scope.checkpoint_id,),
        ).fetchone()
        album = connection.execute(
            "select cover_path,metadata from library.local_albums where library_id=%s",
            (library_id,),
        ).fetchone()
        entry = connection.execute(
            "select file.metadata #> '{scan_cache,file_entry}' as entry "
            "from library.local_track_files file join library.local_tracks track on track.id=file.track_id "
            "where track.library_id=%s", (library_id,),
        ).fetchone()["entry"]
    assert album["cover_path"] == selected_path
    for projection in (album["metadata"], entry):
        assert projection["cover_path"] == selected_path
        assert projection["cover_revision"] == selected_revision
        if linked_remote:
            assert projection["remote_cover_url"] == "https://covers.invalid/private.jpg"
    assert evidence["checkpoint"] == "selection_committed"
    assert evidence["cover_revision"] == selected_revision
    assert evidence["artifact_sha256"] is None
    if linked_remote:
        assert evidence["artifact_key"] is None
    next_revision = worker_covers.checkpoint_claimed_remote_save(
        **claim_values,
        checkpoint_id=scope.checkpoint_id,
        expected_row_revision=revision,
        next_checkpoint="promotion_completed",
    )
    assert next_revision is not None
    revision = next_revision
    # Probe the legacy terminal edge without replacing its normal service finalizer.
    with isolatedPostgres._connect(worker_url) as connection:
        connection.execute("savepoint legacy_terminal_probe")
        legacy_parameters = (
            scope.checkpoint_id, claim.job_id, claim.attempt, claim.worker_id,
            claim.lease_token, claim_values["now"], revision,
        )
        terminal_sql = (
            "select ops.checkpoint_claimed_cover_remote_save("
            "%s,%s,%s,%s,%s,%s,%s,'publication_completed',null::uuid,null::text,null::text) "
            "as row_revision"
        )
        terminal_revision = connection.execute(
            terminal_sql, legacy_parameters,
        ).fetchone()["row_revision"]
        assert terminal_revision == revision + 1
        assert connection.execute(
            terminal_sql, (*legacy_parameters[:-1], terminal_revision),
        ).fetchone()["row_revision"] == terminal_revision
        connection.execute("rollback to savepoint legacy_terminal_probe")
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select checkpoint, artifact_sha256, row_revision "
            "from ops.cover_remote_save_checkpoints where id=%s", (scope.checkpoint_id,),
        ).fetchone() == {
            "checkpoint": "promotion_completed", "artifact_sha256": None,
            "row_revision": revision,
        }
    published = worker_covers.publish_claimed_remote_save(
        **claim_values,
        checkpoint_id=scope.checkpoint_id,
        expected_checkpoint_revision=revision,
        expected_task_revision=scope.task_revision,
        selected_cover_path=selected_path,
        linked_remote=linked_remote,
    )
    assert published is not None
    with isolatedPostgres._connect(setup_url) as connection:
        completed = connection.execute(
            "select status, selected_cover_private_path from ops.cover_lookup_tasks "
            "where id = %s",
            (accepted.task_id,),
        ).fetchone()
    assert completed["status"] == "completed"
    if linked_remote:
        assert completed["selected_cover_private_path"] is None
    else:
        assert completed["selected_cover_private_path"].endswith("cover.jpg")
    finished_replay = app_covers.accept_remote_save(**replay_values)
    assert finished_replay.job_id == accepted.job_id
    with isolatedPostgres._connect(setup_url) as connection:
        task = connection.execute(
            "select status, row_revision from ops.cover_lookup_tasks where id = %s",
            (accepted.task_id,),
        ).fetchone()
    assert task["status"] == "completed"
    assert finished_replay.row_revision == task["row_revision"]
