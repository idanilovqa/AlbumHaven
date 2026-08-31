from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone, tzinfo
from importlib import import_module, util

import pytest


MODULE = "music_app.services.auth_audit_postgres"
NOW = datetime(2026, 8, 31, 15, 0, tzinfo=timezone.utc)


def test_auth_audit_postgres_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 security-audit repository: "
        "music_app/services/auth_audit_postgres.py"
    )


@pytest.fixture
def audit():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    module = import_module(MODULE)
    assert callable(module.PostgresSecurityAuditRepository)
    assert set(module.SecurityAuditCategory.__members__) == {"LOGIN"}
    assert set(module.SecurityAuditOutcome.__members__) == {
        "SUCCESS", "INVALID", "THROTTLED"
    }
    assert set(module.LoginAuditReason.__members__) == {
        "VERIFIED", "CREDENTIAL_MISMATCH", "ACCOUNT_INELIGIBLE",
        "CANDIDATE_INVALID", "BUCKET_BLOCKED", "VERIFICATION_CAPACITY",
        "CREDENTIAL_RACE",
    }
    return module


class Cursor:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class SecretExplodingMapping(Mapping):
    def __getitem__(self, key):
        raise KeyError(key)

    def __iter__(self):
        return iter(("id",))

    def __len__(self):
        return 1

    def get(self, key, default=None):
        assert key == "id"
        raise RuntimeError("private-returned-id-secret")


class SecretExplodingTimezone(tzinfo):
    def utcoffset(self, value):
        raise RuntimeError("private-timestamp-secret")

    def dst(self, value):
        return timedelta(0)

    def tzname(self, value):
        return "secret-exploding-timezone"


_DEFAULT_RETURNED_ROW = object()


class RecordingConnection:
    def __init__(self, *, returned_row=_DEFAULT_RETURNED_ROW, failure=None):
        self.returned_row = (
            {"id": 91}
            if returned_row is _DEFAULT_RETURNED_ROW
            else returned_row
        )
        self.failure = failure
        self.operations = []
        self.transaction_calls = 0

    def transaction(self):
        self.transaction_calls += 1
        raise AssertionError("caller-owned repository must not open a transaction")

    def execute(self, sql, params=None):
        self.operations.append((" ".join(sql.casefold().split()), params))
        if self.failure is not None:
            raise self.failure
        return Cursor(self.returned_row)


def _append(audit, connection, **overrides):
    values = {
        "category": audit.SecurityAuditCategory.LOGIN,
        "outcome": audit.SecurityAuditOutcome.SUCCESS,
        "reason": audit.LoginAuditReason.VERIFIED,
        "actor_account_id": 41,
        "target_account_id": 41,
        "request_ref": "login-request_123",
        "occurred_at": NOW,
        "metadata": {
            "session_id": 73,
            "hmac_key_version": 3,
            "argon2_policy_version": 4,
            "credential_rehashed": True,
            "source_class": "trusted_proxy",
        },
    }
    values.update(overrides)
    return audit.PostgresSecurityAuditRepository().append_in_transaction(
        connection, **values
    )


@pytest.mark.parametrize("returned_row", [{"id": 91}, (91,)])
def test_append_in_transaction_inserts_once_and_returns_dict_or_tuple_id(
    audit, returned_row
):
    connection = RecordingConnection(returned_row=returned_row)

    assert _append(audit, connection) == 91

    assert connection.transaction_calls == 0
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert sql.startswith("insert into app.security_audit_events")
    assert "returning id" in sql
    for column in (
        "actor_account_id", "target_account_id", "event_category", "outcome",
        "reason_code", "request_ref", "occurred_at", "metadata",
    ):
        assert column in sql
    assert params[:7] == (
        41, 41, "login", "success", "verified", "login-request_123", NOW,
    )
    assert getattr(params[7], "obj", None) == {
        "session_id": 73,
        "hmac_key_version": 3,
        "argon2_policy_version": 4,
        "credential_rehashed": True,
        "source_class": "trusted_proxy",
    }


@pytest.mark.parametrize(
    ("outcome", "reason"),
    [
        ("SUCCESS", "VERIFIED"),
        ("INVALID", "CREDENTIAL_MISMATCH"),
        ("INVALID", "ACCOUNT_INELIGIBLE"),
        ("INVALID", "CANDIDATE_INVALID"),
        ("INVALID", "CREDENTIAL_RACE"),
        ("THROTTLED", "BUCKET_BLOCKED"),
        ("THROTTLED", "VERIFICATION_CAPACITY"),
    ],
)
def test_fixed_login_outcome_reason_matrix_is_accepted(audit, outcome, reason):
    connection = RecordingConnection()
    assert _append(
        audit, connection,
        outcome=getattr(audit.SecurityAuditOutcome, outcome),
        reason=getattr(audit.LoginAuditReason, reason), metadata={},
    ) == 91


@pytest.mark.parametrize(
    ("outcome", "reason"),
    [
        ("SUCCESS", "CREDENTIAL_MISMATCH"),
        ("INVALID", "VERIFIED"),
        ("INVALID", "BUCKET_BLOCKED"),
        ("THROTTLED", "CANDIDATE_INVALID"),
    ],
)
def test_mismatched_outcome_reason_is_rejected_before_sql(audit, outcome, reason):
    connection = RecordingConnection()
    with pytest.raises(ValueError):
        _append(
            audit, connection,
            outcome=getattr(audit.SecurityAuditOutcome, outcome),
            reason=getattr(audit.LoginAuditReason, reason),
        )
    assert connection.operations == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("category", "login"), ("outcome", "success"),
        ("reason", "verified"), ("actor_account_id", 0),
        ("actor_account_id", True), ("target_account_id", -1),
        ("request_ref", ""), ("request_ref", "x" * 129),
        ("request_ref", "private\nref"),
        ("occurred_at", NOW.replace(tzinfo=None)),
        ("occurred_at", NOW.astimezone(timezone(timedelta(hours=1)))),
    ],
)
def test_invalid_enums_ids_reference_or_timestamp_are_rejected_before_sql(
    audit, field, value
):
    connection = RecordingConnection()
    with pytest.raises((TypeError, ValueError)) as caught:
        _append(audit, connection, **{field: value})
    assert "private" not in str(caught.value)
    assert connection.operations == []


@pytest.mark.parametrize(
    "request_ref",
    [
        "private request",
        "private\u2028request",
        "private\u2029request",
        "privat\N{LATIN SMALL LETTER E WITH ACUTE}",
        "private@example",
        "private/request",
        "private?request",
        "password=private-secret",
    ],
)
def test_request_reference_requires_a_full_ascii_opaque_token(
    audit, request_ref
):
    connection = RecordingConnection()

    with pytest.raises(ValueError) as caught:
        _append(audit, connection, request_ref=request_ref)

    assert "private" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert connection.operations == []


def test_timestamp_validation_failure_is_generic_secret_safe_and_cause_free(audit):
    connection = RecordingConnection()
    occurred_at = datetime(
        2026, 8, 31, 15, 0, tzinfo=SecretExplodingTimezone()
    )

    with pytest.raises(ValueError) as caught:
        _append(audit, connection, occurred_at=occurred_at)

    assert "private-timestamp-secret" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert connection.operations == []


@pytest.mark.parametrize(
    "source_class", ["loopback", "private", "public", "trusted_proxy"]
)
def test_nullable_ids_optional_reference_and_allowed_source_classes(audit, source_class):
    connection = RecordingConnection()
    assert _append(
        audit, connection, actor_account_id=None, target_account_id=None,
        request_ref=None, metadata={"source_class": source_class},
    ) == 91


@pytest.mark.parametrize(
    "metadata",
    [
        {"password": "private-password"}, {"token_hash": "private-hash"},
        {"unknown": 1}, {"nested": {"value": 1}}, {"session_id": 0},
        {"session_id": True}, {"hmac_key_version": 0},
        {"argon2_policy_version": False}, {"credential_rehashed": 1},
        {"source_class": "direct"},
    ],
)
def test_unknown_nested_sensitive_or_malformed_metadata_is_rejected_before_sql(
    audit, metadata
):
    connection = RecordingConnection()
    with pytest.raises((TypeError, ValueError)) as caught:
        _append(audit, connection, metadata=metadata)
    assert "private" not in str(caught.value)
    assert connection.operations == []


@pytest.mark.parametrize("metadata", [None, {}])
def test_absent_or_empty_metadata_persists_an_empty_json_object(audit, metadata):
    connection = RecordingConnection()
    assert _append(audit, connection, metadata=metadata) == 91
    assert getattr(connection.operations[0][1][7], "obj", None) == {}


@pytest.mark.parametrize("returned_row", [None, {}, (), {"id": 0}, (False,)])
def test_missing_or_invalid_returned_id_fails_closed(audit, returned_row):
    connection = RecordingConnection(returned_row=returned_row)
    with pytest.raises(RuntimeError):
        _append(audit, connection)


def test_returned_mapping_id_failure_is_generic_secret_safe_and_cause_free(audit):
    connection = RecordingConnection(returned_row=SecretExplodingMapping())

    with pytest.raises(RuntimeError) as caught:
        _append(audit, connection)

    assert "private-returned-id-secret" not in str(caught.value)
    assert caught.value.__cause__ is None


def test_provider_failure_is_generic_and_secret_safe(audit):
    private = "private-login-request"
    connection = RecordingConnection(failure=RuntimeError(f"leaked {private}"))

    with pytest.raises(RuntimeError) as caught:
        _append(audit, connection, request_ref=private)

    assert private not in str(caught.value)
    assert caught.value.__cause__ is None
    assert connection.transaction_calls == 0
