from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import psycopg
import pytest

from music_app.services.cover_mutation_coordinator import (
    CoverMutationConflict,
    CoverMutationIdentity,
    CoverMutationRecovery,
    CoverMutationRetryRequired,
    CoverMutationStatus,
    CoverSelectionCommit,
)
from music_app.services.cover_mutations_postgres import PostgresCoverMutationRepository
from tests.e2e.support import isolatedPostgres


_FUNCTIONS = {
    "revision": "library.read_cover_mutation_revision(bigint)",
    "identity": "library.resolve_cover_mutation_identity(bigint,text[])",
    "commit": (
        "library.commit_cover_selection(bigint,bigint,text[],bigint,bigint,"
        "text,text,text,text,boolean,integer,integer,boolean,jsonb,text,bigint,integer,text,text,bigint,"
        "bigint,timestamptz)"
    ),
    "recover": (
        "library.recover_cover_mutation(bigint,bigint,bigint,bigint,text,text,"
        "text,bigint,integer,text,text,bigint,bigint,timestamptz)"
    ),
}

_FORBIDDEN_COVER_FIELDS = (
    "cover_path",
    "cover_revision",
    "cover_selection_origin",
    "cover_selection_provenance",
    "local_cover_width",
    "local_cover_height",
    "cover_validation_path",
    "cover_validation_mtime_ns",
    "cover_validation_size",
    "remote_cover_url",
    "remote_cover_thumbnail_url",
    "remote_cover_source",
    "remote_cover_source_label",
    "remote_cover_album_url",
    "remote_cover_width",
    "remote_cover_height",
)


@dataclass(frozen=True)
class _CoverScope:
    setup_url: str
    app_url: str
    worker_url: str
    readonly_url: str
    account_id: int
    library_id: int
    album_id: int
    file_id: int
    private_path: str
    album_key: str
    artist_key: str


def _skip_or_fail_ci(message: str) -> None:
    if any(
        str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    ):
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _database_urls_or_skip() -> tuple[str, str, str, str]:
    try:
        setup_url, app_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated cover-mutation Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    readonly_url = str(os.environ.get("DATABASE_READONLY_URL") or "").strip()
    if not worker_url or not readonly_url:
        _skip_or_fail_ci("Dedicated cover-mutation role URLs are unavailable.")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        (
            (urlparse(value).hostname or "").casefold(),
            urlparse(value).port or 5432,
            urlparse(value).path.lstrip("/"),
        )
        for value in (setup_url, app_url, worker_url, readonly_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Cover-mutation role URLs do not share one isolated database.")
    return setup_url, app_url, worker_url, readonly_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


def _seed_scope(
    setup_url: str,
    app_url: str,
    worker_url: str,
    readonly_url: str,
) -> _CoverScope:
    token = uuid4().hex[:12]
    private_path = f"C:/isolated-cover-{token}/01.flac"
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(
            connection.execute(
                "insert into app.accounts(display_name,username_display,username_normalized,"
                "contact_email,contact_email_normalized,account_kind,is_active) "
                "values(%s,%s,%s,%s,%s,'managed',true) returning id",
                (token, token, token, f"{token}@example.invalid", f"{token}@example.invalid"),
            ).fetchone()["id"]
        )
        library_id = int(
            connection.execute(
                "insert into library.libraries (owner_account_id, name, library_kind) "
                "values (%s, %s, 'local') returning id",
                (account_id, f"Cover mutation {token}"),
            ).fetchone()["id"]
        )
        connection.execute(
            "insert into library.library_memberships "
            "(library_id, account_id, membership_role) values (%s, %s, 'owner')",
            (library_id, account_id),
        )
        connection.execute(
            "insert into app.capabilities "
            "(account_id, capability_key, scope_kind, scope_id) "
            "values (%s, 'library.covers.lookup', 'library', %s)",
            (account_id, library_id),
        )
        root_id = int(
            connection.execute(
                "insert into library.library_roots "
                "(library_id, root_path, root_kind, is_active, metadata) "
                "values (%s, %s, 'main', true, '{}'::jsonb) returning id",
                (library_id, f"C:/isolated-cover-{token}"),
            ).fetchone()["id"]
        )
        artist_key = f"cover-artist-{token}"
        artist_id = int(
            connection.execute(
                "insert into library.local_artists (library_id, artist_key, name) "
                "values (%s, %s, 'Cover Artist') returning id",
                (library_id, artist_key),
            ).fetchone()["id"]
        )
        album_key = f"cover-album-{token}"
        album_id = int(
            connection.execute(
                "insert into library.local_albums "
                "(library_id, artist_id, album_key, title, metadata) "
                "values (%s, %s, %s, 'Cover Album', '{}'::jsonb) returning id",
                (library_id, artist_id, album_key),
            ).fetchone()["id"]
        )
        track_id = int(
            connection.execute(
                "insert into library.local_tracks "
                "(library_id, album_id, artist_id, track_key, title) "
                "values (%s, %s, %s, %s, 'Track') returning id",
                (library_id, album_id, artist_id, f"cover-track-{token}"),
            ).fetchone()["id"]
        )
        file_id = int(
            connection.execute(
                "insert into library.local_track_files "
                "(track_id, library_root_id, private_path, relative_path, metadata) "
                "values (%s, %s, %s, '01.flac', '{}'::jsonb) returning id",
                (track_id, root_id, private_path),
            ).fetchone()["id"]
        )
        connection.execute(
            "insert into library.cover_mutation_state (library_id) values (%s) "
            "on conflict (library_id) do nothing",
            (library_id,),
        )
    return _CoverScope(
        setup_url=setup_url,
        app_url=app_url,
        worker_url=worker_url,
        readonly_url=readonly_url,
        account_id=account_id,
        library_id=library_id,
        album_id=album_id,
        file_id=file_id,
        private_path=private_path,
        album_key=album_key,
        artist_key=artist_key,
    )


@pytest.fixture(scope="module")
def _cover_mutation_database_urls() -> tuple[str, str, str, str]:
    setup_url, app_url, worker_url, readonly_url = _database_urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, app_url)
        with isolatedPostgres._connect(setup_url) as connection:
            assert connection.execute(
                "select count(*) as count from library.libraries library "
                "join app.bootstrap_owners owner on owner.account_id=library.owner_account_id "
                "where owner.owner_key='local-bootstrap-owner' and library.library_kind='local'",
            ).fetchone()["count"] == 1
        yield setup_url, app_url, worker_url, readonly_url
    finally:
        _drop_schemas(setup_url)


@pytest.fixture
def live_cover_mutation_database(_cover_mutation_database_urls) -> _CoverScope:
    return _seed_scope(*_cover_mutation_database_urls)


def _repository(database_url: str) -> PostgresCoverMutationRepository:
    return PostgresCoverMutationRepository(
        database_url=database_url,
        connect_to_database=isolatedPostgres._connect,
    )


def _persisted_cover_metadata(scope: _CoverScope) -> tuple[dict, dict]:
    with isolatedPostgres._connect(scope.setup_url) as connection:
        album_metadata = connection.execute(
            "select metadata from library.local_albums where id = %s",
            (scope.album_id,),
        ).fetchone()["metadata"]
        file_metadata = connection.execute(
            "select metadata #> '{scan_cache,file_entry}' as metadata "
            "from library.local_track_files where id = %s",
            (scope.file_id,),
        ).fetchone()["metadata"]
    return album_metadata, file_metadata


def _commit_request(
    scope: _CoverScope,
    *,
    expected_inventory_revision: int = 0,
    expected_cover_mutation_revision: int = 0,
    expected_selected_cover_revision: str | None = None,
    selected_cover_revision: str = "selected-v1",
) -> CoverSelectionCommit:
    return CoverSelectionCommit(
        identity=CoverMutationIdentity(scope.library_id, scope.album_id),
        track_paths=(scope.private_path,),
        expected_inventory_revision=expected_inventory_revision,
        expected_cover_mutation_revision=expected_cover_mutation_revision,
        expected_selected_cover_revision=expected_selected_cover_revision,
        selected_cover_path=f"C:/isolated-cover-{scope.album_key}/cover.jpg",
        promoted_cover_revision=selected_cover_revision,
        selected_origin="user",
        clear_selection=False,
        remote_cover=None,
        artifact_sha256=None,
        observed_at=datetime.now(timezone.utc),
        job_id=None,
        attempt=None,
        worker_id=None,
        lease_token=None,
        task_id=None,
        checkpoint_revision=None,
    )


def _seed_durable_fence(scope: _CoverScope, artifact_sha256: str) -> dict[str, object]:
    token = uuid4().hex
    worker_id = f"cover-worker-{token}"
    lease_token = f"cover-lease-{token}"
    with isolatedPostgres._connect(scope.setup_url) as connection:
        root_id = int(
            connection.execute(
                "select library_root_id from library.local_track_files where id = %s",
                (scope.file_id,),
            ).fetchone()["library_root_id"]
        )
        job_id = int(
            connection.execute(
                "insert into ops.jobs (kind,state,subject_kind,subject_ref,parameters,"
                "account_id,library_id,capability_key,deployment_mode,client_surface,"
                "resource_revision,idempotency_key,scheduled_at,attempt_count,"
                "max_attempts,recovery_policy,lease_owner,lease_token,lease_expires_at,"
                "heartbeat_at,started_at) values ('cover_remote_save','running',"
                "'cover_lookup_task',%s,'{}'::jsonb,%s,%s,'library.covers.lookup',"
                "'self_hosted_private_web','private_web',0,%s,clock_timestamp(),1,1,"
                "'ambiguous_on_stale_lease',%s,%s,clock_timestamp()+interval '1 minute',"
                "clock_timestamp(),clock_timestamp()) returning id",
                (token, scope.account_id, scope.library_id, token, worker_id, lease_token),
            ).fetchone()["id"]
        )
        generation = uuid4()
        task_id = int(
            connection.execute(
                "insert into ops.cover_lookup_tasks (library_id,task_key,status,album_key,"
                "local_album_id,library_root_id,initiating_account_id,capability_key,"
                "deployment_mode,client_surface,candidate_generation,resource_revision,"
                "row_revision,job_id) values (%s,%s,'running',%s,%s,%s,%s,"
                "'library.covers.lookup','self_hosted_private_web','private_web',%s,0,0,%s) "
                "returning id",
                (
                    scope.library_id,
                    token,
                    scope.album_key,
                    scope.album_id,
                    root_id,
                    scope.account_id,
                    generation,
                    job_id,
                ),
            ).fetchone()["id"]
        )
        checkpoint = connection.execute(
            "insert into ops.cover_remote_save_checkpoints (task_id,job_id,library_id,"
            "local_album_id,library_root_id,candidate_generation,candidate_id,checkpoint,"
            "artifact_key,artifact_sha256,resource_revision,row_revision) values "
            "(%s,%s,%s,%s,%s,%s,%s,'artifact_written',%s,%s,0,2) "
            "returning id,row_revision",
            (
                task_id,
                job_id,
                scope.library_id,
                scope.album_id,
                root_id,
                generation,
                f"candidate-{token}",
                uuid4(),
                artifact_sha256,
            ),
        ).fetchone()
    return {
        "job_id": job_id,
        "attempt": 1,
        "worker_id": worker_id,
        "lease_token": lease_token,
        "task_id": task_id,
        "checkpoint_id": int(checkpoint["id"]),
        "checkpoint_revision": int(checkpoint["row_revision"]),
    }


def _durable_commit_request(
    scope: _CoverScope,
    digest: str,
    fence: dict[str, object],
    **changes,
) -> CoverSelectionCommit:
    return replace(
        _commit_request(scope, **changes),
        artifact_sha256=digest,
        job_id=fence["job_id"],
        attempt=fence["attempt"],
        worker_id=fence["worker_id"],
        lease_token=fence["lease_token"],
        task_id=fence["task_id"],
        checkpoint_revision=fence["checkpoint_revision"],
    )


def _recovery_request(
    scope: _CoverScope,
    digest: str,
    fence: dict[str, object],
    *,
    expected_inventory_revision: int = 0,
    expected_cover_mutation_revision: int = 0,
    expected_selected_cover_revision: str | None = None,
    promoted_cover_revision: str = "selected-v1",
    checkpoint_revision: int | None = None,
) -> CoverMutationRecovery:
    return CoverMutationRecovery(
        identity=CoverMutationIdentity(scope.library_id, scope.album_id),
        expected_inventory_revision=expected_inventory_revision,
        expected_cover_mutation_revision=expected_cover_mutation_revision,
        expected_selected_cover_revision=expected_selected_cover_revision,
        promoted_cover_revision=promoted_cover_revision,
        artifact_sha256=digest,
        job_id=int(fence["job_id"]),
        attempt=int(fence["attempt"]),
        worker_id=str(fence["worker_id"]),
        lease_token=str(fence["lease_token"]),
        task_id=int(fence["task_id"]),
        checkpoint_revision=(
            int(fence["checkpoint_revision"])
            if checkpoint_revision is None
            else checkpoint_revision
        ),
        observed_at=datetime.now(timezone.utc),
    )


def test_live_cover_mutation_privilege_matrix(live_cover_mutation_database) -> None:
    scope = live_cover_mutation_database
    expected = {
        "album_haven_app": {"revision", "identity", "commit", "recover"},
        "album_haven_worker": {"revision", "identity", "commit", "recover"},
        "album_haven_readonly": {"revision"},
        "public": set(),
    }
    for database_url, allowed_names in (
        (scope.app_url, {"revision", "identity", "commit", "recover"}),
        (scope.worker_url, {"revision", "identity", "commit", "recover"}),
        (scope.readonly_url, {"revision"}),
    ):
        with isolatedPostgres._connect(database_url) as role_connection:
            actual_role = str(
                role_connection.execute(
                    "select current_user as role"
                ).fetchone()["role"]
            )
        expected[actual_role] = allowed_names
    with isolatedPostgres._connect(scope.setup_url) as connection:
        for role, allowed_names in expected.items():
            for name, signature in _FUNCTIONS.items():
                allowed = connection.execute(
                    "select has_function_privilege(%s, %s, 'EXECUTE') as allowed",
                    (role, signature),
                ).fetchone()["allowed"]
                assert allowed is (name in allowed_names)
            assert connection.execute(
                "select has_table_privilege(%s, 'library.cover_mutation_state', "
                "'SELECT,INSERT,UPDATE,DELETE') as allowed",
                (role,),
            ).fetchone()["allowed"] is False
            for table in ("library.local_albums", "library.local_track_files"):
                assert connection.execute(
                    "select has_table_privilege(%s, %s, 'INSERT,UPDATE,DELETE') "
                    "as allowed",
                    (role, table),
                ).fetchone()["allowed"] is False

    for role, database_url in (
        ("album_haven_app", scope.app_url),
        ("album_haven_worker", scope.worker_url),
        ("album_haven_readonly", scope.readonly_url),
    ):
        with isolatedPostgres._connect(database_url) as connection:
            isolatedPostgres._assert_connected_role(connection, role)
            for statement, row_id in (
                ("update library.local_albums set cover_path = 'forbidden' where id = %s", scope.album_id),
                (
                    "update library.local_albums set metadata = "
                    "jsonb_build_object('cover_revision','forbidden') where id = %s",
                    scope.album_id,
                ),
                (
                    "update library.local_track_files set metadata = "
                    "jsonb_build_object('scan_cache',jsonb_build_object('file_entry',"
                    "jsonb_build_object('cover_revision','forbidden'))) where id = %s",
                    scope.file_id,
                ),
            ):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    with connection.transaction():
                        connection.execute(statement, (row_id,))

    with isolatedPostgres._connect(scope.setup_url) as connection:
        album = connection.execute(
            "select cover_path, metadata from library.local_albums where id = %s",
            (scope.album_id,),
        ).fetchone()
        file_metadata = connection.execute(
            "select metadata from library.local_track_files where id = %s",
            (scope.file_id,),
        ).fetchone()["metadata"]
    assert album == {"cover_path": None, "metadata": {}}
    assert file_metadata == {}


def test_live_repository_commit_repairs_stale_files_and_preserves_no_op_revision(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    repository = _repository(scope.app_url)
    identity = repository.resolve_identity(
        library_id=scope.library_id,
        track_paths=[scope.private_path],
    )
    assert identity == CoverMutationIdentity(scope.library_id, scope.album_id)
    assert repository.current_library_revision(library_id=scope.library_id) == 0

    committed = repository.commit_selection(request=_commit_request(scope))
    assert committed.status is CoverMutationStatus.COMMITTED
    assert committed.cover_mutation_revision == 1
    assert repository.current_library_revision(library_id=scope.library_id) == 1

    no_change = repository.commit_selection(
        request=_commit_request(
            scope,
            expected_cover_mutation_revision=1,
            expected_selected_cover_revision="selected-v1",
        )
    )
    assert no_change.status is CoverMutationStatus.COMMITTED
    assert no_change.cover_mutation_revision == 1

    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            "update library.local_track_files set metadata = "
            "jsonb_build_object('scan_cache', jsonb_build_object('file_entry', "
            "coalesce(metadata #> '{scan_cache,file_entry}', '{}'::jsonb) || "
            "jsonb_build_object('cover_revision', 'stale'))) where id = %s",
            (scope.file_id,),
        )
    repaired = repository.commit_selection(
        request=_commit_request(
            scope,
            expected_cover_mutation_revision=1,
            expected_selected_cover_revision="selected-v1",
        )
    )
    assert repaired.cover_mutation_revision == 2
    with isolatedPostgres._connect(scope.setup_url) as connection:
        persisted = connection.execute(
            "select metadata #>> '{scan_cache,file_entry,cover_revision}' as revision "
            "from library.local_track_files where id = %s",
            (scope.file_id,),
        ).fetchone()["revision"]
    assert persisted == "selected-v1"


def test_live_repository_normalizes_manual_linked_and_cleared_cover_metadata(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    repository = _repository(scope.app_url)

    manual = repository.commit_selection(
        request=replace(
            _commit_request(scope),
            explicit_selection=True,
            local_cover_width=1200,
            local_cover_height=800,
        )
    )
    assert manual.status is CoverMutationStatus.COMMITTED
    album_metadata, file_metadata = _persisted_cover_metadata(scope)
    for metadata in (album_metadata, file_metadata):
        assert metadata["cover_selection_provenance"] == "explicit"
        assert metadata["local_cover_width"] == 1200
        assert metadata["local_cover_height"] == 800

    linked = repository.commit_selection(
        request=replace(
            _commit_request(
                scope,
                expected_cover_mutation_revision=1,
                expected_selected_cover_revision="selected-v1",
            ),
            selected_cover_path=None,
            promoted_cover_revision=None,
            remote_cover={
                "remote_cover_url": "https://images.invalid/linked.jpg",
                "remote_cover_source": "spotify",
            },
            explicit_selection=True,
            local_cover_width=None,
            local_cover_height=None,
        )
    )
    assert linked.status is CoverMutationStatus.COMMITTED
    album_metadata, file_metadata = _persisted_cover_metadata(scope)
    for metadata in (album_metadata, file_metadata):
        assert metadata["cover_selection_provenance"] == "explicit"
        assert metadata["remote_cover_url"] == "https://images.invalid/linked.jpg"
        assert metadata["remote_cover_source"] == "spotify"
        assert "cover_revision" not in metadata
        assert "local_cover_width" not in metadata
        assert "local_cover_height" not in metadata

    cleared = repository.commit_selection(
        request=replace(
            _commit_request(
                scope,
                expected_cover_mutation_revision=2,
                expected_selected_cover_revision=None,
            ),
            selected_cover_path=None,
            promoted_cover_revision=None,
            selected_origin=None,
            clear_selection=True,
            remote_cover=None,
            explicit_selection=False,
            local_cover_width=None,
            local_cover_height=None,
        )
    )
    assert cleared.status is CoverMutationStatus.COMMITTED
    album_metadata, file_metadata = _persisted_cover_metadata(scope)
    for metadata in (album_metadata, file_metadata):
        assert "cover_selection_provenance" not in metadata
        assert "local_cover_width" not in metadata
        assert "local_cover_height" not in metadata
        assert "remote_cover_url" not in metadata


def test_live_repository_maps_durable_commit_and_no_op_checkpoints(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    repository = _repository(scope.worker_url)
    digest = "d" * 64

    first_fence = _seed_durable_fence(scope, digest)
    committed = repository.commit_selection(
        request=replace(
            _commit_request(scope),
            artifact_sha256=digest,
            job_id=first_fence["job_id"],
            attempt=first_fence["attempt"],
            worker_id=first_fence["worker_id"],
            lease_token=first_fence["lease_token"],
            task_id=first_fence["task_id"],
            checkpoint_revision=first_fence["checkpoint_revision"],
        )
    )
    assert committed.status is CoverMutationStatus.COMMITTED
    assert committed.cover_mutation_revision == 1
    assert committed.checkpoint == "authority_committed"
    assert committed.finalization_checkpoint_id == first_fence["checkpoint_id"]
    assert committed.finalization_checkpoint_revision == 3

    second_fence = _seed_durable_fence(scope, digest)
    no_change = repository.commit_selection(
        request=replace(
            _commit_request(
                scope,
                expected_cover_mutation_revision=1,
                expected_selected_cover_revision="selected-v1",
            ),
            artifact_sha256=digest,
            job_id=second_fence["job_id"],
            attempt=second_fence["attempt"],
            worker_id=second_fence["worker_id"],
            lease_token=second_fence["lease_token"],
            task_id=second_fence["task_id"],
            checkpoint_revision=second_fence["checkpoint_revision"],
        )
    )
    assert no_change.status is CoverMutationStatus.COMMITTED
    assert no_change.cover_mutation_revision == 1
    assert no_change.checkpoint == "authority_committed"
    assert no_change.finalization_checkpoint_id == second_fence["checkpoint_id"]
    assert no_change.finalization_checkpoint_revision == 3

    with isolatedPostgres._connect(scope.setup_url) as connection:
        rows = connection.execute(
            "select id,checkpoint,artifact_sha256,authority_cover_mutation_revision,"
            "row_revision from ops.cover_remote_save_checkpoints where id = any(%s) "
            "order by id",
            ([first_fence["checkpoint_id"], second_fence["checkpoint_id"]],),
        ).fetchall()
    assert rows == [
        {
            "id": first_fence["checkpoint_id"],
            "checkpoint": "authority_committed",
            "artifact_sha256": digest,
            "authority_cover_mutation_revision": 1,
            "row_revision": 3,
        },
        {
            "id": second_fence["checkpoint_id"],
            "checkpoint": "authority_committed",
            "artifact_sha256": digest,
            "authority_cover_mutation_revision": 1,
            "row_revision": 3,
        },
    ]


def test_live_recovery_maps_owned_artifact_to_compensation_with_evidence(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    digest = "c" * 64
    fence = _seed_durable_fence(scope, digest)

    outcome = _repository(scope.worker_url).recover_ambiguous(
        request=_recovery_request(scope, digest, fence)
    )

    assert outcome.status is CoverMutationStatus.CANCELED
    assert outcome.cover_mutation_revision == 0
    assert outcome.selected_cover_revision is None
    assert outcome.library_id == scope.library_id
    assert outcome.local_album_id == scope.album_id
    assert outcome.task_id == fence["task_id"]
    assert outcome.finalization_checkpoint_id == fence["checkpoint_id"]
    assert outcome.finalization_checkpoint_revision == fence["checkpoint_revision"]


def test_live_recovery_maps_committed_checkpoint_with_evidence(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    digest = "d" * 64
    fence = _seed_durable_fence(scope, digest)
    repository = _repository(scope.worker_url)
    committed = repository.commit_selection(
        request=_durable_commit_request(scope, digest, fence)
    )

    outcome = repository.recover_ambiguous(
        request=_recovery_request(scope, digest, fence)
    )

    assert committed.status is CoverMutationStatus.COMMITTED
    assert outcome.status is CoverMutationStatus.COMMITTED
    assert outcome.cover_mutation_revision == 1
    assert outcome.selected_cover_revision == "selected-v1"
    assert outcome.checkpoint == "authority_committed"
    assert outcome.finalization_checkpoint_id == fence["checkpoint_id"]
    assert outcome.finalization_checkpoint_revision == 3


@pytest.mark.parametrize("conflict", ["digest", "checkpoint", "later_authority"])
def test_live_recovery_maps_conflicting_owned_state_to_ambiguous(
    live_cover_mutation_database,
    conflict,
) -> None:
    scope = live_cover_mutation_database
    digest = "e" * 64
    fence = _seed_durable_fence(scope, digest)
    request_digest = digest
    checkpoint_revision = None
    expected_revision = 0
    selected_revision = None

    if conflict == "digest":
        request_digest = "f" * 64
    elif conflict == "checkpoint":
        checkpoint_revision = int(fence["checkpoint_revision"]) + 1
    else:
        committed = _repository(scope.app_url).commit_selection(
            request=_commit_request(scope, selected_cover_revision="selected-v2")
        )
        assert committed.cover_mutation_revision == 1
        expected_revision = 1
        selected_revision = "selected-v2"

    outcome = _repository(scope.worker_url).recover_ambiguous(
        request=_recovery_request(
            scope,
            request_digest,
            fence,
            checkpoint_revision=checkpoint_revision,
        )
    )

    assert outcome.status is CoverMutationStatus.AMBIGUOUS
    assert outcome.cover_mutation_revision == expected_revision
    assert outcome.selected_cover_revision == selected_revision
    if conflict == "later_authority":
        assert outcome.finalization_checkpoint_id == fence["checkpoint_id"]
        assert outcome.finalization_checkpoint_revision == fence["checkpoint_revision"]
    else:
        assert outcome.finalization_checkpoint_id is None
        assert outcome.finalization_checkpoint_revision is None


@pytest.mark.parametrize("invalid_fence", ["canceled", "lease_lost", "stale_revision"])
def test_live_durable_rejection_does_not_advance_authority(
    live_cover_mutation_database,
    invalid_fence,
) -> None:
    scope = live_cover_mutation_database
    digest = "a" * 64
    fence = _seed_durable_fence(scope, digest)
    with isolatedPostgres._connect(scope.setup_url) as connection:
        if invalid_fence == "canceled":
            connection.execute(
                "update ops.jobs set cancel_requested_at = clock_timestamp(), "
                "cancel_reason_code = 'user_requested' where id = %s",
                (fence["job_id"],),
            )
        elif invalid_fence == "lease_lost":
            connection.execute(
                "update ops.jobs set lease_token = %s where id = %s",
                (f"lost-{uuid4().hex}", fence["job_id"]),
            )
        else:
            connection.execute(
                "update ops.cover_remote_save_checkpoints "
                "set row_revision = row_revision + 1 where id = %s",
                (fence["checkpoint_id"],),
            )

    outcome = _repository(scope.worker_url).commit_selection(
        request=_durable_commit_request(scope, digest, fence)
    )

    assert outcome.status is CoverMutationStatus.CANCELED
    assert outcome.cover_mutation_revision == 0
    assert _repository(scope.app_url).current_library_revision(
        library_id=scope.library_id
    ) == 0


def test_live_repository_inventory_retry_and_cross_library_identity_fences(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    repository = _repository(scope.app_url)
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            "update library.libraries set metadata = "
            "jsonb_set(metadata, '{inventory_mutation_revision}', '1'::jsonb, true) "
            "where id = %s",
            (scope.library_id,),
        )
        other_library_id = int(
            connection.execute(
                "insert into library.libraries (owner_account_id, name, library_kind) "
                "values (%s, %s, 'local') returning id",
                (scope.account_id, f"Cross library {uuid4().hex}"),
            ).fetchone()["id"]
        )
    with pytest.raises(CoverMutationConflict) as conflict:
        repository.commit_selection(
            request=_commit_request(
                scope,
                expected_inventory_revision=0,
            expected_cover_mutation_revision=0,
            expected_selected_cover_revision=None,
                selected_cover_revision="selected-v2",
            )
        )
    assert conflict.value.reason_code == "inventory_revision_conflict"
    assert repository.current_library_revision(library_id=scope.library_id) == 0
    assert repository.commit_selection(
        request=_commit_request(
            scope,
            expected_inventory_revision=1,
            expected_cover_mutation_revision=0,
            expected_selected_cover_revision=None,
            selected_cover_revision="selected-v2",
        )
    ).cover_mutation_revision == 1
    with pytest.raises(CoverMutationRetryRequired):
        repository.resolve_identity(
            library_id=other_library_id,
            track_paths=[scope.private_path],
        )


def test_live_recovery_without_owned_checkpoint_is_ambiguous(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    outcome = _repository(scope.worker_url).recover_ambiguous(
        request=CoverMutationRecovery(
            identity=CoverMutationIdentity(scope.library_id, scope.album_id),
            expected_inventory_revision=1,
            expected_cover_mutation_revision=1,
            expected_selected_cover_revision="selected-v2",
            promoted_cover_revision="selected-v3",
            artifact_sha256="a" * 64,
            job_id=987_654_321,
            attempt=1,
            worker_id="missing-worker",
            lease_token="missing-lease",
            task_id=987_654_322,
            checkpoint_revision=1,
            observed_at=datetime.now(timezone.utc),
        )
    )
    assert outcome.status is CoverMutationStatus.AMBIGUOUS
    assert outcome.cover_mutation_revision == 0
    assert outcome.selected_cover_revision is None


def _structural_payload(scope: _CoverScope, album: str) -> tuple[list[dict[str, object]], dict[str, object]]:
    input_rows = [{
        "private_path": scope.private_path,
        "track_artist_key": scope.artist_key,
        "track_artist_name": "Cover Artist",
        "file_entry": {
            "path": scope.private_path,
            "album": album,
            "artist": "Cover Artist",
            "album_artist": "Cover Artist",
            "mtime": 1.0,
            "size": 1,
        },
    }]
    destination = {
        "destination_album_key": scope.album_key,
        "destination_artist_key": scope.artist_key,
        "destination_artist_name": "Cover Artist",
        "destination_artist_metadata": {},
        "destination_album_title": album,
        "destination_release_year": None,
        "destination_release_date": None,
        "destination_edition": "",
        "destination_separate_release_key": None,
        "destination_is_explicit_separate": False,
        "updates_release_year": False,
    }
    return input_rows, destination


@pytest.mark.parametrize("cover_key", _FORBIDDEN_COVER_FIELDS)
def test_live_structural_tag_edit_rejects_cover_keys_but_normal_edit_succeeds(
    live_cover_mutation_database,
    cover_key,
) -> None:
    scope = live_cover_mutation_database
    input_rows, destination = _structural_payload(scope, "Renamed Album")
    invalid_payloads = []
    invalid_rows = json.loads(json.dumps(input_rows))
    invalid_rows[0]["file_entry"][cover_key] = "forbidden"
    invalid_payloads.append((invalid_rows, destination, ["album"]))
    invalid_destination = json.loads(json.dumps(destination))
    invalid_destination[cover_key] = "forbidden"
    invalid_payloads.append((input_rows, invalid_destination, ["album"]))
    invalid_artist_metadata = json.loads(json.dumps(destination))
    invalid_artist_metadata["destination_artist_metadata"][cover_key] = "forbidden"
    invalid_payloads.append((input_rows, invalid_artist_metadata, ["album"]))
    invalid_payloads.append((input_rows, destination, ["album", cover_key]))

    for invalid_rows, invalid_destination, changed_fields in invalid_payloads:
        with isolatedPostgres._connect(scope.app_url) as connection, pytest.raises(
            psycopg.errors.InvalidParameterValue
        ):
            with connection.transaction():
                connection.execute(
                    "select * from library.persist_authorized_structural_tag_edit_noncover("
                    "%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s)",
                    (
                        scope.library_id,
                        [scope.private_path],
                        0,
                        json.dumps(invalid_rows),
                        json.dumps(invalid_destination),
                        changed_fields,
                        datetime.now(timezone.utc),
                    ),
                ).fetchone()

    with isolatedPostgres._connect(scope.app_url) as connection:
        result = connection.execute(
            "select * from library.persist_authorized_structural_tag_edit_noncover("
            "%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s)",
            (
                scope.library_id,
                [scope.private_path],
                0,
                json.dumps(input_rows),
                json.dumps(destination),
                ["album"],
                datetime.now(timezone.utc),
            ),
        ).fetchone()
    assert result["album_rows_updated"] == 1
    assert result["track_rows_updated"] == 1
    assert result["track_file_rows_updated"] == 1


def _plan_nodes(plan: object) -> list[tuple[str, str]]:
    if not isinstance(plan, dict):
        return []
    nodes = [
        (
            str(plan.get("Node Type") or ""),
            str(plan.get("Index Name") or ""),
        )
    ]
    for child in plan.get("Plans") or []:
        nodes.extend(_plan_nodes(child))
    return nodes


def test_live_cover_revision_index_identity_plan_and_state_cascade(
    live_cover_mutation_database,
) -> None:
    scope = live_cover_mutation_database
    with isolatedPostgres._connect(scope.setup_url) as connection:
        new_ids = [
            int(row["id"])
            for row in connection.execute(
                "insert into library.libraries (owner_account_id, name, library_kind) "
                "select %s, 'Cover scale ' || %s || '-' || value, 'local' "
                "from generate_series(1, 1000) value returning id",
                (scope.account_id, uuid4().hex),
            ).fetchall()
        ]
        connection.execute(
            "insert into library.cover_mutation_state (library_id) "
            "select unnest(%s::bigint[])",
            (new_ids,),
        )
        revision_plan = connection.execute(
            "explain (analyze, buffers, format json) "
            "select cover_mutation_revision from library.cover_mutation_state "
            "where library_id = %s",
            (scope.library_id,),
        ).fetchone()["QUERY PLAN"][0]["Plan"]
        identity_plan = connection.execute(
            "explain (analyze, buffers, format json) "
            "select * from library.resolve_cover_mutation_identity(%s,%s::text[])",
            (scope.library_id, [scope.private_path]),
        ).fetchone()["QUERY PLAN"][0]["Plan"]
        revision_nodes = _plan_nodes(revision_plan)
        diagnostic = json.dumps(revision_nodes + _plan_nodes(identity_plan))
        assert any(
            index_name == "cover_mutation_state_pkey"
            for _node_type, index_name in revision_nodes
        )
        assert scope.private_path not in diagnostic

        cascade_library_id = new_ids[0]
        connection.execute("delete from library.libraries where id = %s", (cascade_library_id,))
        assert connection.execute(
            "select count(*) as count from library.cover_mutation_state where library_id = %s",
            (cascade_library_id,),
        ).fetchone()["count"] == 0


def test_live_cover_migration_rerun_preserves_state(live_cover_mutation_database) -> None:
    scope = live_cover_mutation_database
    migration_sql = (
        Path(__file__).parents[2] / "migrations" / "postgres" / "0243_close_cover_consistency.sql"
    ).read_text(encoding="utf-8")
    metadata_migration_sql = (
        Path(__file__).parents[2]
        / "migrations"
        / "postgres"
        / "0246_preserve_cover_selection_metadata.sql"
    ).read_text(encoding="utf-8")
    with isolatedPostgres._connect(scope.setup_url) as connection:
        before = connection.execute(
            "select cover_mutation_revision, updated_at "
            "from library.cover_mutation_state where library_id = %s",
            (scope.library_id,),
        ).fetchone()
        connection.execute(migration_sql)
        connection.execute(migration_sql)
        connection.execute(metadata_migration_sql)
        connection.execute(metadata_migration_sql)
        after = connection.execute(
            "select cover_mutation_revision, updated_at "
            "from library.cover_mutation_state where library_id = %s",
            (scope.library_id,),
        ).fetchone()
    assert after == before
