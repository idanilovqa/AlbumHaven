"""Publish an isolated fixture through the production projection worker."""

import os
from datetime import datetime, timezone
from urllib.parse import urlsplit

from music_app.jobs.problematic_projection_handlers import build_problematic_projection_handler
from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import JobState, JobTransitionResult
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.problematic_files_projection import project_problematic_files
from music_app.services.problematic_projection_postgres import PostgresProblematicProjectionRepository
from tests.e2e.support import isolatedPostgres


def publish_problematic_fixture(repository):
    worker_url = os.environ["ALBUM_HAVEN_WORKER_DATABASE_URL"]
    runtime_url = repository._database_url
    assert urlsplit(worker_url).path == urlsplit(runtime_url).path
    assert isolatedPostgres._is_owned_isolated_database_name(
        isolatedPostgres._database_name(runtime_url)
    )
    reader = PostgresProblematicProjectionRepository(database_url=runtime_url)
    library_id = reader.resolve_bootstrap_library_id()
    queued = reader.enqueue_rebuild(library_id=library_id, requested_by="test-fixture")
    repository._fixture_problematic_job_ids = {
        *getattr(repository, "_fixture_problematic_job_ids", ()), queued["job_id"],
    }
    now = datetime.now(timezone.utc)
    jobs = PostgresJobRepository(database_url=worker_url)
    claim = jobs.claim(worker_id="test-problematic-fixture", now=now,
                       lease_seconds=120, kinds=("problematic_files_projection",))
    assert claim is not None and claim.job_id == queued["job_id"]

    class Context:
        cancel_requested = False
        lease_active = True

        @staticmethod
        def reauthorize():
            return AuthorizationDecision(True, "problematic_projection_scope_current")

    worker_repository = PostgresProblematicProjectionRepository(database_url=worker_url)
    result = build_problematic_projection_handler(
        repository=worker_repository,
        project_group=project_problematic_files,
    )(claim, Context())
    assert result.next_state is JobState.SUCCEEDED, result
    assert jobs.finish(claim, JobTransitionResult(JobState.SUCCEEDED, result.reason_code),
                       now=datetime.now(timezone.utc))

    payload = repository.build_problematic_files_page(limit=200)
    items = list(payload["items"])
    cursor = payload["next_cursor"]
    while cursor is not None:
        page = repository.build_problematic_files_page(limit=200, cursor=cursor)
        items.extend(page["items"])
        cursor = page["next_cursor"]
    assert len(items) == payload["total"]
    return {**payload, "items": items, "count": len(items),
            "next_cursor": None, "complete": True}
