from datetime import datetime, timezone

import pytest

from music_app.services.jobs.models import EnqueueJob, JobKind, JobState, RecoveryPolicy
from music_app.services.jobs.registry import JOB_POLICIES, policy_for, validate_enqueue


NOW = datetime(2026, 9, 5, tzinfo=timezone.utc)

EXPECTED_POLICIES = {
    "full_scan": ({"library.refresh"}, 2, RecoveryPolicy.RETRY_SAFE, False, False),
    "targeted_reconciliation": (set(), 3, RecoveryPolicy.RETRY_SAFE, True, False),
    "post_scan_cover_refresh": (set(), 2, RecoveryPolicy.RETRY_SAFE, True, False),
    "cover_lookup": ({"library.covers.lookup"}, 2, RecoveryPolicy.RETRY_SAFE, False, False),
    "cover_remote_save": (
        {"library.covers.write"},
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
        False,
        False,
    ),
    "lastfm_scrobble_retry": (
        {"integration.lastfm.scrobble"},
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
        False,
        False,
    ),
    "auth_welcome_delivery": (
        {"accounts.welcome.send"},
        3,
        RecoveryPolicy.RETRY_SAFE,
        False,
        False,
    ),
    "auth_invitation_delivery": (
        {"accounts.invitation.send"},
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
        False,
        False,
    ),
    "auth_password_reset_delivery": (
        {"accounts.password_reset.send"},
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
        False,
        True,
    ),
}


def _command(**overrides):
    payload = {
        "kind": "full_scan",
        "subject_kind": "library",
        "subject_ref": "9",
        "parameters": {"mode": "normal"},
        "account_id": 7,
        "library_id": 9,
        "capability_key": "library.refresh",
        "request_origin_ref": "origin:abc123",
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "web",
        "idempotency_key": "refresh:request:abc123",
        "scheduled_at": NOW,
        "max_attempts": 2,
    }
    payload.update(overrides)
    return EnqueueJob(**payload)


def test_registry_is_closed_and_excludes_synchronous_album_moves():
    assert set(JOB_POLICIES) == set(EXPECTED_POLICIES)
    assert {kind.value for kind in JobKind} == set(EXPECTED_POLICIES)
    assert "album_move" not in JOB_POLICIES


def test_job_policy_registry_rejects_assignment():
    original = JOB_POLICIES["full_scan"]
    with pytest.raises(TypeError):
        JOB_POLICIES["full_scan"] = original


def test_job_policy_registry_rejects_addition():
    policy = JOB_POLICIES["full_scan"]
    try:
        with pytest.raises(TypeError):
            JOB_POLICIES["album_move"] = policy
    finally:
        if "album_move" in JOB_POLICIES:
            JOB_POLICIES.pop("album_move")


def test_job_policy_registry_rejects_deletion():
    original = JOB_POLICIES["full_scan"]
    try:
        with pytest.raises(TypeError):
            del JOB_POLICIES["full_scan"]
    finally:
        if "full_scan" not in JOB_POLICIES:
            JOB_POLICIES["full_scan"] = original


def test_job_states_are_the_approved_closed_state_machine():
    assert {state.value for state in JobState} == {
        "queued",
        "running",
        "retry_wait",
        "succeeded",
        "failed",
        "canceled",
        "ambiguous",
    }


@pytest.mark.parametrize(
    ("kind", "expected"),
    EXPECTED_POLICIES.items(),
)
def test_every_job_kind_has_its_approved_capability_attempt_and_recovery_policy(kind, expected):
    capabilities, attempts, recovery, server_owned, public_lifecycle = expected

    policy = policy_for(kind)

    assert policy is JOB_POLICIES[kind]
    assert policy.allowed_capability_keys == frozenset(capabilities)
    assert policy.max_attempts == attempts
    assert policy.recovery_policy is recovery
    assert policy.server_owned is server_owned
    assert policy.public_lifecycle is public_lifecycle


def test_unknown_job_kind_is_rejected():
    with pytest.raises(ValueError, match="job kind"):
        validate_enqueue(_command(kind="album_move"))


def test_actor_owned_work_requires_the_registered_capability():
    with pytest.raises(ValueError, match="capability"):
        validate_enqueue(_command(capability_key="library.covers.write"))


@pytest.mark.parametrize("missing", ["account_id", "library_id", "request_origin_ref"])
def test_actor_owned_library_work_requires_accepted_ownership_context(missing):
    with pytest.raises(ValueError, match="ownership|account|library|origin"):
        validate_enqueue(_command(**{missing: None}))


def test_server_owned_work_inherits_library_scope_without_an_actor_capability():
    command = _command(
        kind="targeted_reconciliation",
        subject_kind="reconciliation_intent",
        subject_ref="intent-42",
        parameters={"inventory_revision": 18},
        account_id=None,
        capability_key=None,
        max_attempts=3,
    )

    assert validate_enqueue(command) is command


@pytest.mark.parametrize(
    ("kind", "subject_kind", "subject_ref", "max_attempts"),
    [
        ("targeted_reconciliation", "reconciliation_intent", "intent-42", 3),
        ("post_scan_cover_refresh", "inventory_revision", "revision-18", 2),
    ],
)
def test_server_owned_work_does_not_require_a_request_origin(
    kind, subject_kind, subject_ref, max_attempts
):
    command = _command(
        kind=kind,
        subject_kind=subject_kind,
        subject_ref=subject_ref,
        parameters={},
        account_id=None,
        capability_key=None,
        request_origin_ref=None,
        max_attempts=max_attempts,
    )

    assert validate_enqueue(command) is command


@pytest.mark.parametrize("missing", ["library_id", "subject_ref"])
def test_server_owned_work_rejects_missing_inherited_resource_scope(missing):
    overrides = {
        "kind": "post_scan_cover_refresh",
        "subject_kind": "inventory_revision",
        "subject_ref": "revision-18",
        "parameters": {},
        "account_id": None,
        "capability_key": None,
        "max_attempts": 2,
    }
    overrides[missing] = None
    command = _command(**overrides)

    with pytest.raises(ValueError, match="scope|library|subject"):
        validate_enqueue(command)


def test_server_owned_work_rejects_a_synthesized_actor_capability():
    command = _command(
        kind="targeted_reconciliation",
        subject_kind="reconciliation_intent",
        subject_ref="intent-42",
        account_id=None,
        capability_key="library.refresh",
        max_attempts=3,
    )

    with pytest.raises(ValueError, match="server-owned|capability"):
        validate_enqueue(command)


def test_public_password_reset_uses_lifecycle_context_without_an_actor_capability():
    command = _command(
        kind="auth_password_reset_delivery",
        subject_kind="mail_outbox",
        subject_ref="outbox-81",
        parameters={},
        account_id=None,
        library_id=None,
        capability_key=None,
        idempotency_key="forgot-password:outbox-81",
        max_attempts=1,
    )

    assert validate_enqueue(command) is command


def test_public_password_reset_still_requires_request_origin_context():
    command = _command(
        kind="auth_password_reset_delivery",
        subject_kind="mail_outbox",
        subject_ref="outbox-81",
        parameters={},
        account_id=None,
        library_id=None,
        capability_key=None,
        request_origin_ref=None,
        idempotency_key="forgot-password:outbox-81",
        max_attempts=1,
    )

    with pytest.raises(ValueError, match="request_origin_ref|origin"):
        validate_enqueue(command)


def test_administrator_password_reset_requires_the_approved_capability():
    command = _command(
        kind="auth_password_reset_delivery",
        subject_kind="mail_outbox",
        subject_ref="outbox-82",
        parameters={},
        library_id=None,
        capability_key="accounts.password_reset.send",
        idempotency_key="admin-reset:outbox-82",
        max_attempts=1,
    )

    assert validate_enqueue(command) is command


def test_non_public_job_cannot_omit_its_actor_capability():
    command = _command(
        kind="auth_invitation_delivery",
        subject_kind="mail_outbox",
        subject_ref="outbox-83",
        parameters={},
        library_id=None,
        capability_key=None,
        idempotency_key="invitation:outbox-83",
        max_attempts=1,
    )

    with pytest.raises(ValueError, match="capability"):
        validate_enqueue(command)


@pytest.mark.parametrize("scheduled_at", ["2026-09-05T00:00:00Z", datetime(2026, 9, 5)])
def test_enqueue_requires_a_timezone_aware_datetime_schedule(scheduled_at):
    with pytest.raises(ValueError, match="scheduled_at|timezone|datetime"):
        validate_enqueue(_command(scheduled_at=scheduled_at))


@pytest.mark.parametrize("field", ["account_id", "library_id"])
@pytest.mark.parametrize("invalid", [True, 0, -1, "9"])
def test_present_account_and_library_identifiers_must_be_positive_integers(
    field, invalid
):
    with pytest.raises(ValueError, match="account_id|library_id|positive integer"):
        validate_enqueue(_command(**{field: invalid}))


def test_positive_account_and_library_identifiers_remain_valid():
    command = _command(account_id=7, library_id=9)

    assert validate_enqueue(command) is command


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("subject_kind", ""),
        ("subject_ref", ""),
        ("idempotency_key", ""),
        ("subject_kind", "subject\nkind"),
        ("subject_ref", "subject\x00ref"),
        ("idempotency_key", "request\rkey"),
        ("subject_kind", "k" * 1025),
        ("subject_ref", "s" * 4097),
        ("idempotency_key", "i" * 4097),
    ],
)
def test_enqueue_rejects_blank_control_character_or_unbounded_keys(field, value):
    with pytest.raises(ValueError, match="subject|idempotency|bounded"):
        validate_enqueue(_command(**{field: value}))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("subject_kind", "album waiting for a scan"),
        ("subject_ref", "the ninth library"),
        ("idempotency_key", "refresh request from the browser"),
        ("request_origin_ref", "origin from the living room browser"),
        ("deployment_mode", "private web on my server"),
        ("client_surface", "the web application"),
    ],
)
def test_enqueue_rejects_prose_and_whitespace_in_stable_identifier_fields(
    field, value
):
    with pytest.raises(ValueError, match="identifier|subject|idempotency|origin|deployment|client"):
        validate_enqueue(_command(**{field: value}))


@pytest.mark.parametrize(
    ("field", "unsafe", "message"),
    [
        ("subject_ref", "member@example.test", "subject|redacted|unsafe"),
        (
            "subject_ref",
            r"C:\Music\Private Artist\Album",
            "subject|redacted|unsafe",
        ),
        (
            "idempotency_key",
            "token=reset-secret-value",
            "idempotency|redacted|unsafe",
        ),
        (
            "request_origin_ref",
            "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
            "origin|redacted|unsafe",
        ),
    ],
)
def test_enqueue_rejects_sensitive_values_in_generic_ledger_string_fields(
    field, unsafe, message
):
    with pytest.raises(ValueError, match=message):
        validate_enqueue(_command(**{field: unsafe}))


def test_parameters_accept_scalars_and_one_level_containers():
    command = _command(
        parameters={
            "force": True,
            "revision": 18,
            "note": None,
            "roots": ["root-1", "root-2"],
            "options": {"mode": "normal", "refresh": False},
        }
    )

    assert validate_enqueue(command) is command


def test_bearer_shaped_value_is_rejected_under_a_benign_non_reference_key():
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={"value": "A" * 43}))


@pytest.mark.parametrize(
    "context_key",
    [
        "integration_session_ref",
        "credential_id",
        "token_id",
        "session_revision",
        "credential_version",
    ],
)
def test_bearer_length_opaque_values_remain_valid_under_stable_metadata_keys(
    context_key,
):
    command = _command(parameters={context_key: "A" * 43})

    assert validate_enqueue(command) is command


@pytest.mark.parametrize(
    "parameters",
    [
        ["not", "an", "object"],
        {"nested": [["too-deep"]]},
        {"nested": {"deeper": {"secret": "value"}}},
        {"objects": [{"not": "scalar"}]},
        {"unsupported": object()},
    ],
)
def test_parameters_reject_non_object_or_deeper_than_one_level_json(parameters):
    with pytest.raises(ValueError, match="parameters|JSON|one-level"):
        validate_enqueue(_command(parameters=parameters))


def test_parameters_reject_an_encoded_payload_larger_than_four_kibibytes():
    with pytest.raises(ValueError, match="4096|4 KiB|parameters"):
        validate_enqueue(_command(parameters={"value": "x" * 4096}))


@pytest.mark.parametrize(
    "unsafe",
    [
        r"C:\Music\Private Artist\Album",
        "/srv/music/private/Artist/Album",
        r"\\nas\music\Artist\Album",
        "member@example.test",
        "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
        "token=reset-secret-value",
        "password=hunter2",
        "api_key=provider-secret",
        "smtp_password=mail-secret",
        "lastfm_secret=provider-secret",
        "fixtures/private/owner-library/album.flac",
    ],
)
def test_enqueue_rejects_paths_addresses_tokens_credentials_provider_secrets_and_private_fixtures(unsafe):
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={"value": unsafe}))


@pytest.mark.parametrize(
    "unsafe",
    [
        r"path=C:\Music\Private Artist\Album",
        "path=/srv/music/private/Artist/Album",
    ],
)
def test_enqueue_rejects_prefixed_absolute_paths_in_parameter_values(unsafe):
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={"value": unsafe}))


@pytest.mark.parametrize(
    "unsafe",
    [
        r"Music\Private Artist\Album",
        "music/private/Artist/Album",
        "/secret",
        "access_token=provider-secret-value",
        "client_secret=provider-secret-value",
    ],
)
def test_enqueue_rejects_relative_paths_single_component_absolute_paths_and_compound_credentials(
    unsafe,
):
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={"value": unsafe}))


@pytest.mark.parametrize(
    ("field", "unsafe", "message"),
    [
        (
            "subject_ref",
            r"root:C:\Music\Private Artist\Album",
            "subject|redacted|unsafe",
        ),
        (
            "request_origin_ref",
            "origin:/srv/music/private/Artist/Album",
            "origin|redacted|unsafe",
        ),
    ],
)
def test_enqueue_rejects_prefixed_absolute_paths_in_generic_ledger_fields(
    field, unsafe, message
):
    with pytest.raises(ValueError, match=message):
        validate_enqueue(_command(**{field: unsafe}))


def test_unsafe_values_are_rejected_inside_allowed_one_level_containers():
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(
            _command(parameters={"metadata": {"provider_token": "secret-value"}})
        )


@pytest.mark.parametrize(
    "parameters",
    [
        {r"C:\Music\Private Artist\Album": "opaque-reference"},
        {"metadata": {"/srv/music/private/Artist/Album": "opaque-reference"}},
    ],
)
def test_enqueue_rejects_raw_paths_used_as_parameter_keys(parameters):
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters=parameters))


@pytest.mark.parametrize(
    "credential_key",
    ["accessToken", "clientSecret", "authorization", "cookie"],
)
def test_enqueue_rejects_common_credential_carrier_parameter_keys(credential_key):
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={credential_key: "opaque-reference"}))


@pytest.mark.parametrize(
    ("context_key", "safe_value"),
    [
        ("integration_session_ref", "session-42"),
        ("session_revision", 4),
        ("credential_version", 3),
        ("token_id", "token-81"),
    ],
)
def test_enqueue_accepts_safe_stable_context_reference_and_version_keys(
    context_key, safe_value
):
    command = _command(parameters={context_key: safe_value})

    assert validate_enqueue(command) is command


@pytest.mark.parametrize("credential_key", ["privateKey", "authHeader"])
def test_enqueue_rejects_additional_credential_carrier_aliases(credential_key):
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={credential_key: "opaque-reference"}))


def test_enqueue_rejects_local_domain_email_parameter_value():
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={"value": "member@localhost"}))


def test_enqueue_rejects_provider_payload_parameter_key_even_with_benign_value():
    with pytest.raises(ValueError, match="redacted parameters"):
        validate_enqueue(_command(parameters={"provider_payload": "opaque-reference"}))


def test_enqueue_accepts_delimiter_safe_opaque_references():
    command = _command(
        subject_kind="reconciliation_intent",
        subject_ref="intent-42.v2_candidate",
        request_origin_ref="origin:abc123",
        idempotency_key="refresh:request:abc123",
        parameters={
            "intent_ref": "intent-42",
            "revision_ref": "018f5e2a-1f2b-7c3d-8e4f_0123456789ab.v2",
        },
    )

    assert validate_enqueue(command) is command
