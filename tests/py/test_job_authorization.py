from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.jobs.authorization import (
    AuthorizationDecision,
    JobAuthorizationService,
    build_auth_mail_resource_validator,
    build_lastfm_retry_resource_validator,
)
from music_app.services.jobs.models import ClaimedJob
from music_app.services.policy import RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator


NOW = datetime(2026, 9, 6, 7, 0, tzinfo=timezone.utc)


def _actor(
    *,
    state: ActorState = ActorState.ACTIVE,
    capability: str = "library.refresh",
    bootstrap: bool = False,
    membership: bool = True,
) -> CurrentActor:
    return CurrentActor(
        state=state,
        account_id=7,
        session_id=None,
        is_bootstrap_owner=bootstrap,
        current_library_id=9 if membership else None,
        library_relationships=(
            (LibraryRelationship(9, "owner", True),) if membership else ()
        ),
        capability_grants=(
            CapabilityGrant(capability, "library", 9),
        ),
    )


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
        "idempotency_key": "phase8:authorization:41",
        "attempt": 1,
        "max_attempts": 2,
        "worker_id": "worker-a",
        "lease_token": "opaque-lease-token",
        "lease_expires_at": NOW,
        "scheduled_at": NOW,
        "scope_version": 5,
        "resource_revision": 11,
    }
    values.update(overrides)
    return ClaimedJob(**values)


class _ContextRepository:
    def __init__(self) -> None:
        self.actor = _actor()
        self.session_is_expired = False
        self.membership_current = True
        self.request_origin_id = 23
        self.request_origin_account_id = 7
        self.request_origin = RequestOrigin("browser", "private-origin-key")
        self.deployment_allowed = True
        self.client_surface_allowed = True
        self.library_current = True
        self.root_current = True
        self.resource_current = True
        self.scope_version = 5
        self.resource_revision = 11
        self.integration_session_ref = "lastfm-session-3"
        self.public_lifecycle_current = True
        self.server_scope_current = True
        self.invalid_row = False
        self.loads: list[tuple[int, datetime]] = []

    def load_authorization_context(self, claim: ClaimedJob, now: datetime):
        self.loads.append((claim.job_id, now))
        if self.invalid_row:
            return {"actor": "untrusted-row"}
        return SimpleNamespace(
            actor=self.actor,
            session_is_expired=self.session_is_expired,
            membership_current=self.membership_current,
            request_origin_id=self.request_origin_id,
            request_origin_account_id=self.request_origin_account_id,
            request_origin=self.request_origin,
            deployment_allowed=self.deployment_allowed,
            client_surface_allowed=self.client_surface_allowed,
            library_current=self.library_current,
            root_current=self.root_current,
            resource_current=self.resource_current,
            scope_version=self.scope_version,
            resource_revision=self.resource_revision,
            integration_session_ref=self.integration_session_ref,
            public_lifecycle_current=self.public_lifecycle_current,
            server_scope_current=self.server_scope_current,
        )


def _resource_scope_validator(claim, context, now):
    assert now == NOW
    if not context.library_current or not context.root_current:
        return AuthorizationDecision(False, "resource_scope_revoked")
    if not context.resource_current:
        return AuthorizationDecision(False, "resource_removed")
    if (
        claim.scope_version is not None
        and context.scope_version != claim.scope_version
    ):
        return AuthorizationDecision(False, "scope_version_changed")
    if (
        claim.resource_revision is not None
        and context.resource_revision != claim.resource_revision
    ):
        return AuthorizationDecision(False, "resource_revision_changed")
    return AuthorizationDecision(True, "resource_scope_current")


def _lastfm_validator(claim, context, now):
    assert now == NOW
    if context.integration_session_ref != claim.parameters.get(
        "integration_session_ref"
    ):
        return AuthorizationDecision(False, "integration_session_replaced")
    return AuthorizationDecision(True, "integration_session_current")


def _public_reset_validator(claim, context, now):
    assert now == NOW
    return AuthorizationDecision(
        bool(context.public_lifecycle_current),
        (
            "public_lifecycle_current"
            if context.public_lifecycle_current
            else "public_lifecycle_invalid"
        ),
    )


def _server_scope_validator(claim, context, now):
    assert now == NOW
    return AuthorizationDecision(
        bool(context.server_scope_current and context.library_current),
        (
            "server_scope_current"
            if context.server_scope_current and context.library_current
            else "server_scope_revoked"
        ),
    )


def _service(repository: _ContextRepository | None = None, *, validators=None):
    context_repository = repository or _ContextRepository()
    resource_validators = {
        "full_scan": _resource_scope_validator,
        "targeted_reconciliation": _server_scope_validator,
        "post_scan_cover_refresh": _server_scope_validator,
        "cover_lookup": _resource_scope_validator,
        "cover_remote_save": _resource_scope_validator,
        "lastfm_scrobble_retry": _lastfm_validator,
        "auth_welcome_delivery": _resource_scope_validator,
        "auth_invitation_delivery": _resource_scope_validator,
        "auth_password_reset_delivery": _public_reset_validator,
    }
    if validators is not None:
        resource_validators = validators
    return (
        JobAuthorizationService(
            context_repository=context_repository,
            policy_evaluator=PolicyEvaluator(),
            resource_validators=resource_validators,
        ),
        context_repository,
    )


def test_active_actor_with_current_scope_capability_origin_and_resource_is_allowed():
    service, repository = _service()

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        True, "authorized"
    )
    assert repository.loads == [(41, NOW)]


def test_ordinary_initiating_session_expiry_does_not_cancel_accepted_work():
    service, repository = _service()
    repository.session_is_expired = True

    assert service.authorize(_claim(), NOW).allowed is True


@pytest.mark.parametrize("state", [ActorState.INACTIVE, ActorState.ANONYMOUS])
def test_disabled_or_inactive_account_fails_closed(state):
    service, repository = _service()
    repository.actor = _actor(state=state)

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "actor_inactive"
    )


@pytest.mark.parametrize("state", [ActorState.INACTIVE, ActorState.ANONYMOUS])
@pytest.mark.parametrize(
    "matrix_field", ["deployment_allowed", "client_surface_allowed"]
)
def test_actor_state_denial_precedes_delivery_matrix_denial(state, matrix_field):
    service, repository = _service()
    repository.actor = _actor(state=state)
    setattr(repository, matrix_field, False)

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "actor_inactive"
    )


def test_removed_library_membership_fails_closed_before_execution():
    service, repository = _service()
    repository.membership_current = False
    repository.actor = _actor(membership=False)

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "membership_revoked"
    )


@pytest.mark.parametrize(
    "actor",
    [
        _actor(capability="library.browse.read"),
        CurrentActor(
            state=ActorState.ACTIVE,
            account_id=7,
            current_library_id=9,
            library_relationships=(LibraryRelationship(9, "owner", True),),
            capability_grants=(),
        ),
    ],
)
def test_removed_or_wrong_current_capability_fails_closed(actor):
    service, repository = _service()
    repository.actor = actor

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "capability_revoked"
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("request_origin_id", None),
        ("request_origin_id", 99),
        ("request_origin_account_id", 8),
        ("request_origin", None),
    ],
)
def test_missing_or_mismatched_request_origin_fails_closed(field, value):
    service, repository = _service()
    setattr(repository, field, value)

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "request_origin_revoked"
    )


def test_changed_deployment_context_fails_closed():
    service, repository = _service()
    repository.deployment_allowed = False

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "deployment_denied"
    )


def test_changed_client_surface_fails_closed():
    service, repository = _service()
    repository.client_surface_allowed = False

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "client_surface_denied"
    )


@pytest.mark.parametrize(
    ("field", "value", "reason_code"),
    [
        ("library_current", False, "resource_scope_revoked"),
        ("root_current", False, "resource_scope_revoked"),
        ("resource_current", False, "resource_removed"),
        ("scope_version", 6, "scope_version_changed"),
        ("resource_revision", 12, "resource_revision_changed"),
    ],
)
def test_removed_scope_or_changed_revision_fails_closed(field, value, reason_code):
    service, repository = _service()
    setattr(repository, field, value)

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, reason_code
    )


def test_replaced_lastfm_integration_session_fails_closed():
    service, repository = _service()
    repository.actor = _actor(capability="integration.lastfm.scrobble")
    repository.integration_session_ref = "lastfm-session-replacement"
    claim = _claim(
        kind="lastfm_scrobble_retry",
        subject_kind="pending_scrobble",
        subject_ref="81",
        capability_key="integration.lastfm.scrobble",
        parameters={"integration_session_ref": "lastfm-session-3"},
        max_attempts=1,
        scope_version=None,
        resource_revision=None,
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        False, "integration_session_replaced"
    )


def test_production_lastfm_validator_fences_pending_attempt_and_opaque_session():
    class RetryRepository:
        def __init__(self):
            self.calls = []

        def validate_claimed_retry(self, **values):
            self.calls.append(values)
            return True

    retry_repository = RetryRepository()
    repository = _ContextRepository()
    repository.actor = _actor(capability="integration.lastfm.scrobble")
    repository.integration_session_ref = "31"
    claim = _claim(
        kind="lastfm_scrobble_retry",
        subject_kind="pending_scrobble",
        subject_ref="53",
        capability_key="integration.lastfm.scrobble",
        parameters={"active_session_ref": "31"},
        max_attempts=1,
        scope_version=5,
        resource_revision=2,
        idempotency_key="lastfm-scrobble:53:attempt:2",
    )
    service, _ = _service(
        repository,
        validators={
            "lastfm_scrobble_retry": build_lastfm_retry_resource_validator(
                retry_repository=retry_repository
            )
        },
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(True, "authorized")
    assert retry_repository.calls == [
        {
            "pending_scrobble_id": 53,
            "active_session_id": 31,
            "account_id": 7,
            "library_id": 9,
            "job_id": 41,
            "attempt": 1,
            "worker_id": "worker-a",
            "lease_token": "opaque-lease-token",
            "now": NOW,
            "row_revision": 5,
            "accepted_attempt": 2,
        }
    ]


def test_production_lastfm_validator_rejects_session_replacement_before_domain_read():
    class RetryRepository:
        def __init__(self):
            self.calls = []

        def validate_claimed_retry(self, **values):
            self.calls.append(values)
            return True

    retry_repository = RetryRepository()
    repository = _ContextRepository()
    repository.actor = _actor(capability="integration.lastfm.scrobble")
    repository.integration_session_ref = "32"
    claim = _claim(
        kind="lastfm_scrobble_retry",
        subject_kind="pending_scrobble",
        subject_ref="53",
        capability_key="integration.lastfm.scrobble",
        parameters={"active_session_ref": "31"},
        max_attempts=1,
        scope_version=5,
        resource_revision=2,
        idempotency_key="lastfm-scrobble:53:attempt:2",
    )
    service, _ = _service(
        repository,
        validators={
            "lastfm_scrobble_retry": build_lastfm_retry_resource_validator(
                retry_repository=retry_repository
            )
        },
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        False, "integration_session_replaced"
    )
    assert retry_repository.calls == []


@pytest.mark.parametrize(
    ("current", "expected"),
    [
        (True, AuthorizationDecision(True, "public_lifecycle_current")),
        (False, AuthorizationDecision(False, "public_lifecycle_invalid")),
    ],
)
def test_public_password_reset_uses_lifecycle_without_synthesizing_actor_grant(
    current, expected
):
    service, repository = _service()
    repository.actor = None
    repository.public_lifecycle_current = current
    claim = _claim(
        kind="auth_password_reset_delivery",
        subject_kind="mail_outbox",
        subject_ref="reset-intent-52",
        account_id=None,
        library_id=None,
        capability_key=None,
        max_attempts=1,
        scope_version=None,
        resource_revision=None,
    )

    assert service.authorize(claim, NOW) == expected
    assert repository.actor is None


@pytest.mark.parametrize(
    ("kind", "category", "capability", "maximum"),
    [
        ("auth_welcome_delivery", "welcome", "accounts.welcome.send", 3),
        (
            "auth_invitation_delivery",
            "account_invitation",
            "accounts.invitation.send",
            1,
        ),
        (
            "auth_password_reset_delivery",
            "password_reset",
            "accounts.password_reset.send",
            1,
        ),
    ],
)
def test_auth_mail_validator_revalidates_exact_category_claim_and_outbox_fence(
    kind, category, capability, maximum
):
    class Repository:
        calls = []

        def validate_claimed_delivery(self, **values):
            self.calls.append(values)
            return True

    repository = Repository()
    validator = build_auth_mail_resource_validator(
        mail_repository=repository, category=category
    )
    claim = _claim(
        kind=kind,
        subject_kind="mail_outbox",
        subject_ref="61",
        parameters={},
        capability_key=capability,
        max_attempts=maximum,
        scope_version=4,
        resource_revision=1,
        idempotency_key=f"auth-mail:{category}:61:attempt:1",
    )

    assert validator(claim, SimpleNamespace(), NOW) == AuthorizationDecision(
        True, "auth_mail_scope_current"
    )
    assert repository.calls == [{
        "outbox_id": 61,
        "category": category,
        "job_id": 41,
        "attempt": 1,
        "worker_id": "worker-a",
        "lease_token": "opaque-lease-token",
        "now": NOW,
        "row_revision": 4,
        "accepted_attempt": 1,
    }]


def test_auth_mail_validator_rejects_category_substitution_before_repository_access():
    class Repository:
        calls = []

        def validate_claimed_delivery(self, **values):
            self.calls.append(values)
            return True

    repository = Repository()
    validator = build_auth_mail_resource_validator(
        mail_repository=repository, category="welcome"
    )
    forged = _claim(
        kind="auth_invitation_delivery",
        subject_kind="mail_outbox",
        subject_ref="61",
        parameters={},
        capability_key="accounts.welcome.send",
        max_attempts=3,
        scope_version=4,
        resource_revision=1,
        idempotency_key="auth-mail:welcome:61:attempt:1",
    )

    assert validator(forged, SimpleNamespace(), NOW) == AuthorizationDecision(
        False, "auth_mail_scope_invalid"
    )
    assert repository.calls == []


def test_public_auth_mail_validator_keeps_target_identity_in_private_repository():
    class Repository:
        calls = []

        def validate_claimed_delivery(self, **values):
            self.calls.append(values)
            return True

    repository = Repository()
    service, context = _service(
        validators={
            "auth_password_reset_delivery": build_auth_mail_resource_validator(
                mail_repository=repository, category="password_reset"
            )
        }
    )
    context.actor = None
    context.request_origin_account_id = None
    claim = _claim(
        kind="auth_password_reset_delivery",
        subject_kind="mail_outbox",
        subject_ref="62",
        parameters={},
        account_id=None,
        library_id=None,
        capability_key=None,
        max_attempts=1,
        scope_version=2,
        resource_revision=1,
        idempotency_key="auth-mail:password_reset:62:attempt:1",
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        True, "auth_mail_scope_current"
    )
    assert repository.calls[0]["outbox_id"] == 62


@pytest.mark.parametrize(
    ("field", "value"),
    [("request_origin_id", 99), ("request_origin", None)],
)
def test_public_password_reset_still_requires_current_persisted_origin(field, value):
    service, repository = _service()
    repository.actor = None
    repository.public_lifecycle_current = True
    setattr(repository, field, value)
    claim = _claim(
        kind="auth_password_reset_delivery",
        subject_kind="mail_outbox",
        subject_ref="reset-intent-53",
        account_id=None,
        library_id=None,
        capability_key=None,
        max_attempts=1,
        scope_version=None,
        resource_revision=None,
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        False, "request_origin_revoked"
    )


@pytest.mark.parametrize(
    ("field", "reason_code"),
    [
        ("deployment_allowed", "deployment_denied"),
        ("client_surface_allowed", "client_surface_denied"),
    ],
)
def test_public_password_reset_enforces_current_delivery_context_before_lifecycle(
    field, reason_code
):
    validator_calls = []

    def validator(claim, context, now):
        validator_calls.append((claim, context, now))
        return AuthorizationDecision(True, "public_lifecycle_current")

    service, repository = _service(
        validators={"auth_password_reset_delivery": validator}
    )
    repository.actor = None
    setattr(repository, field, False)
    claim = _claim(
        kind="auth_password_reset_delivery",
        subject_kind="mail_outbox",
        subject_ref="reset-intent-54",
        account_id=None,
        library_id=None,
        capability_key=None,
        max_attempts=1,
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(False, reason_code)
    assert validator_calls == []


@pytest.mark.parametrize(
    "kind", ["targeted_reconciliation", "post_scan_cover_refresh"]
)
def test_server_owned_work_uses_only_inherited_current_scope(kind):
    service, repository = _service()
    repository.actor = None
    claim = _claim(
        kind=kind,
        account_id=None,
        capability_key=None,
        request_origin_id=None,
        max_attempts=3 if kind == "targeted_reconciliation" else 2,
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        True, "server_scope_current"
    )
    repository.server_scope_current = False
    assert service.authorize(claim, NOW) == AuthorizationDecision(
        False, "server_scope_revoked"
    )


@pytest.mark.parametrize(
    ("field", "reason_code"),
    [
        ("deployment_allowed", "deployment_denied"),
        ("client_surface_allowed", "client_surface_denied"),
    ],
)
def test_server_owned_work_enforces_current_delivery_context_before_scope_validator(
    field, reason_code
):
    validator_calls = []

    def validator(claim, context, now):
        validator_calls.append((claim, context, now))
        return AuthorizationDecision(True, "server_scope_current")

    service, repository = _service(
        validators={"targeted_reconciliation": validator}
    )
    repository.actor = None
    setattr(repository, field, False)
    claim = _claim(
        kind="targeted_reconciliation",
        account_id=None,
        capability_key=None,
        request_origin_id=None,
        max_attempts=3,
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(False, reason_code)
    assert validator_calls == []


def test_server_owned_work_without_inherited_library_scope_fails_before_loading():
    service, repository = _service()
    claim = _claim(
        kind="targeted_reconciliation",
        account_id=None,
        library_id=None,
        capability_key=None,
        request_origin_id=None,
        max_attempts=3,
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        False, "authorization_input_invalid"
    )
    assert repository.loads == []


def test_library_watcher_targeted_work_uses_claim_scoped_validator_without_account_snapshot():
    validator_contexts = []

    def validator(claim, context, now):
        validator_contexts.append(context)
        return AuthorizationDecision(True, "server_scope_current")

    service, repository = _service(
        validators={"targeted_reconciliation": validator}
    )
    claim = _claim(
        kind="targeted_reconciliation",
        account_id=None,
        capability_key=None,
        request_origin_id=None,
        client_surface="library_watcher",
        max_attempts=3,
    )

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        True, "server_scope_current"
    )
    assert repository.loads == []
    assert len(validator_contexts) == 1
    assert validator_contexts[0].actor is None
    assert validator_contexts[0].library_current is True


def test_bootstrap_owner_keeps_accepted_work_with_current_scope():
    service, repository = _service()
    repository.actor = _actor(capability="library.browse.read", bootstrap=True)

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        True, "bootstrap_owner"
    )


def test_missing_validator_and_unknown_kind_fail_closed():
    service, _ = _service(validators={})
    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "authorization_validator_missing"
    )

    service, repository = _service()
    unknown = replace(_claim(), kind="album_move")
    assert service.authorize(unknown, NOW) == AuthorizationDecision(
        False, "job_kind_unregistered"
    )
    assert repository.loads == []


@pytest.mark.parametrize(
    ("claim", "now"),
    [
        (replace(_claim(), job_id=0), NOW),
        (_claim(), datetime(2026, 9, 6, 7, 0)),
        (replace(_claim(), lease_token=""), NOW),
    ],
)
def test_invalid_claim_or_time_fails_closed_without_loading_context(claim, now):
    service, repository = _service()

    assert service.authorize(claim, now) == AuthorizationDecision(
        False, "authorization_input_invalid"
    )
    assert repository.loads == []


def test_invalid_dependency_row_fails_closed():
    service, repository = _service()
    repository.invalid_row = True

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "authorization_context_invalid"
    )


@pytest.mark.parametrize(
    "malformed_relationships",
    [("malformed-relationship",), None],
)
def test_malformed_nested_actor_relationship_fails_closed_without_raising(
    malformed_relationships,
):
    service, repository = _service()
    repository.actor = replace(
        _actor(), library_relationships=malformed_relationships
    )

    assert service.authorize(_claim(), NOW) == AuthorizationDecision(
        False, "authorization_context_invalid"
    )


def test_boolean_actor_account_id_fails_closed_instead_of_matching_integer_id():
    service, repository = _service()
    repository.actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=True,
        current_library_id=1,
        library_relationships=(LibraryRelationship(1, "owner", True),),
        capability_grants=(CapabilityGrant("library.refresh", "library", 1),),
    )
    repository.request_origin_account_id = 1
    claim = _claim(account_id=1, library_id=1, subject_ref="1")

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        False, "authorization_context_invalid"
    )


@pytest.mark.parametrize(
    "malformed_grants",
    [
        (CapabilityGrant("library.refresh", "library", True),),
        [CapabilityGrant("library.refresh", "library", 1)],
    ],
)
def test_malformed_capability_grants_fail_closed_instead_of_matching_scope(
    malformed_grants,
):
    service, repository = _service()
    repository.actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=7,
        current_library_id=1,
        library_relationships=(LibraryRelationship(1, "owner", True),),
        capability_grants=malformed_grants,
    )
    claim = _claim(library_id=1, subject_ref="1")

    assert service.authorize(claim, NOW) == AuthorizationDecision(
        False, "authorization_context_invalid"
    )


def test_decisions_expose_only_bounded_canonical_reason_codes():
    service, repository = _service()
    repository.request_origin = RequestOrigin(
        "browser", "private-origin-key-with-token-and-C:\\Music\\Album"
    )
    repository.request_origin_id = None

    decision = service.authorize(_claim(), NOW)
    rendered = repr(decision)

    assert decision.allowed is False
    assert decision.reason_code == "request_origin_revoked"
    assert len(decision.reason_code) <= 128
    assert decision.reason_code.replace("_", "").isalnum()
    assert "private-origin-key" not in rendered
    assert "C:\\Music\\Album" not in rendered
    assert "token" not in rendered
