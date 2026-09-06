from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    LibraryRelationship,
)
from music_app.services.jobs.authorization import (
    AuthorizationDecision,
    JobAuthorizationContext,
    JobAuthorizationService,
    PostgresJobAuthorizationContextRepository,
)
from music_app.services.jobs.models import ClaimedJob
from music_app.services.policy import RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator


NOW = datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc)
DATABASE_URL = "postgresql://worker-role@localhost/album_haven"


class _Result:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def fetchall(self):
        return list(self._rows)


class _RecordingConnection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.executed = []
        self.entries = 0
        self.exits = 0

    def __enter__(self):
        self.entries += 1
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.exits += 1

    def execute(self, statement, parameters=None):
        self.executed.append((str(statement), parameters))
        return _Result(self.rows)


class _Connector:
    def __init__(self, connection):
        self.connection = connection
        self.urls = []

    def __call__(self, database_url):
        self.urls.append(database_url)
        return self.connection


def _claim(**overrides) -> ClaimedJob:
    values = {
        "job_id": 41,
        "kind": "full_scan",
        "subject_kind": "library",
        "subject_ref": "9",
        "parameters": {},
        "account_id": 7,
        "library_id": 9,
        "capability_key": "library.refresh",
        "request_origin_id": 23,
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "private_web",
        "idempotency_key": "phase8:authorization-context:41",
        "attempt": 1,
        "max_attempts": 2,
        "worker_id": "worker-a",
        "lease_token": "opaque-lease-token",
        "lease_expires_at": NOW + timedelta(minutes=5),
        "scheduled_at": NOW,
        "scope_version": 5,
        "resource_revision": 11,
    }
    values.update(overrides)
    return ClaimedJob(**values)


def _snapshot_row(**overrides):
    row = {
        "account_id": 7,
        "account_is_active": True,
        "is_bootstrap_owner": True,
        "library_exists": True,
        "membership_current": True,
        "library_relationships": [
            {
                "library_id": 9,
                "membership_role": "owner",
                "is_primary_owner": True,
            },
            {
                "library_id": 12,
                "membership_role": "member",
                "is_primary_owner": False,
            },
        ],
        "capability_grants": [
            {
                "capability_key": "library.refresh",
                "scope_kind": "library",
                "scope_id": 9,
            },
            {
                "capability_key": "app.status.read",
                "scope_kind": "global",
                "scope_id": None,
            },
        ],
        "request_origin_id": 23,
        "request_origin_account_id": 7,
        "request_origin_type": "browser",
        "request_origin_surface": "private_web",
    }
    row.update(overrides)
    return row


def _repository(rows):
    connection = _RecordingConnection(rows)
    connector = _Connector(connection)
    repository = PostgresJobAuthorizationContextRepository(
        DATABASE_URL, connect_to_database=connector
    )
    return repository, connector, connection


def _normalized(statement):
    return " ".join(statement.casefold().split())


def test_loads_one_redacted_current_authorization_snapshot_by_stable_ids():
    repository, connector, connection = _repository([_snapshot_row()])

    context = repository.load_authorization_context(_claim(), NOW)

    assert isinstance(context, JobAuthorizationContext)
    assert context.actor.state is ActorState.ACTIVE
    assert context.actor.account_id == 7
    assert context.actor.session_id is None
    assert context.actor.is_bootstrap_owner is True
    assert context.actor.current_library_id == 9
    assert context.actor.library_relationships == (
        LibraryRelationship(9, "owner", True),
        LibraryRelationship(12, "member", False),
    )
    assert context.actor.capability_grants == (
        CapabilityGrant("app.status.read", "global", None),
        CapabilityGrant("library.refresh", "library", 9),
    )
    assert context.session_is_expired is True
    assert context.membership_current is True
    assert context.library_current is True
    assert context.request_origin_id == 23
    assert context.request_origin_account_id == 7
    assert isinstance(context.request_origin, RequestOrigin)
    assert context.request_origin.origin_type == "browser"
    assert "23" in context.request_origin.origin_key
    assert "<redacted>" in repr(context.request_origin)
    assert connector.urls == [DATABASE_URL]
    assert connection.entries == connection.exits == 1
    assert len(connection.executed) == 1

    sql, parameters = connection.executed[0]
    normalized = _normalized(sql)
    assert parameters == {
        "job_id": 41,
        "attempt": 1,
        "worker_id": "worker-a",
        "lease_token": "opaque-lease-token",
        "now": NOW,
    }
    assert "app.load_claimed_job_authorization_context" in normalized
    for private_column in (
        "password_hash",
        "session_token_hash",
        "token_hash",
        "origin_key",
        "root_path",
        "display_name",
        "username_display",
    ):
        assert private_column not in normalized


@pytest.mark.parametrize(
    (
        "deployment_mode",
        "client_surface",
        "origin_surface",
        "deployment_allowed",
        "client_surface_allowed",
    ),
    [
        ("local_development", "private_web", "private_web", True, True),
        ("self_hosted", "private_web", "private_web", True, True),
        ("self_hosted_private_web", "private_web", "private_web", True, True),
        ("foundation_only", "private_web", "private_web", False, True),
        ("cloud_hosted", "private_web", "private_web", False, True),
        ("self_hosted", "mobile", "private_web", True, False),
        ("self_hosted", "private_web", "mobile", True, False),
    ],
)
def test_execution_matrix_is_closed_to_approved_private_web_contexts(
    deployment_mode,
    client_surface,
    origin_surface,
    deployment_allowed,
    client_surface_allowed,
):
    repository, _, _ = _repository(
        [_snapshot_row(request_origin_surface=origin_surface)]
    )
    claim = _claim(
        deployment_mode=deployment_mode,
        client_surface=client_surface,
    )

    context = repository.load_authorization_context(claim, NOW)

    assert context.deployment_allowed is deployment_allowed
    assert context.client_surface_allowed is client_surface_allowed


def test_common_resource_and_lifecycle_state_defaults_closed_for_kind_validators():
    repository, _, _ = _repository([_snapshot_row()])

    context = repository.load_authorization_context(_claim(), NOW)

    assert context.root_current is False
    assert context.resource_current is False
    assert context.scope_version is None
    assert context.resource_revision is None
    assert context.integration_session_ref is None
    assert context.public_lifecycle_current is False
    assert context.server_scope_current is False


def test_missing_account_and_origin_remain_typed_absent_and_closed():
    repository, _, connection = _repository(
        [
            _snapshot_row(
                account_id=None,
                account_is_active=None,
                is_bootstrap_owner=False,
                membership_current=False,
                library_relationships=[],
                capability_grants=[],
                request_origin_id=None,
                request_origin_account_id=None,
                request_origin_type=None,
                request_origin_surface=None,
            )
        ]
    )
    claim = _claim(account_id=None, request_origin_id=None)

    context = repository.load_authorization_context(claim, NOW)

    assert context.actor is None
    assert context.membership_current is False
    assert context.request_origin_id is None
    assert context.request_origin_account_id is None
    assert context.request_origin is None
    assert context.deployment_allowed is True
    assert context.client_surface_allowed is False
    assert len(connection.executed) == 1


def test_inactive_account_builds_session_independent_inactive_actor():
    repository, _, _ = _repository(
        [_snapshot_row(account_is_active=False, is_bootstrap_owner=False)]
    )

    context = repository.load_authorization_context(_claim(), NOW)

    assert context.actor.state is ActorState.INACTIVE
    assert context.actor.account_id == 7
    assert context.actor.session_id is None
    assert context.session_is_expired is True


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [_snapshot_row(), _snapshot_row()],
        ["untrusted-row"],
        [_snapshot_row(library_relationships="not-json-rows")],
        [_snapshot_row(capability_grants=[{"scope_id": True}])],
    ],
)
def test_malformed_or_nonunique_snapshot_raises_bounded_runtime_error(rows):
    repository, _, _ = _repository(rows)

    with pytest.raises(RuntimeError) as exc_info:
        repository.load_authorization_context(_claim(), NOW)

    assert 0 < len(str(exc_info.value)) <= 128
    assert DATABASE_URL not in str(exc_info.value)
    assert "private-origin" not in str(exc_info.value)


def test_service_converts_snapshot_failure_to_canonical_closed_decision():
    repository, _, _ = _repository([])
    service = JobAuthorizationService(
        context_repository=repository,
        policy_evaluator=PolicyEvaluator(),
        resource_validators={
            "full_scan": lambda claim, context, now: AuthorizationDecision(
                True, "resource_scope_current"
            )
        },
    )

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "authorization_context_invalid"
    )
