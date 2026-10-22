"""The actual Goals command owner, imported through normal pytest discovery."""

from copy import deepcopy
from dataclasses import FrozenInstanceError
import hashlib
import json
from uuid import UUID

import pytest

from music_app.services.listening_goals_commands import (
    GoalsCommand,
    GoalsError,
    MAX_REVISION,
    normalize_goal_command,
    revision,
    uuid_ref,
)


REQUEST_KEY = "16b9234d-97f5-4e41-a03b-c74672fb1825"
EVIDENCE_REF = "267b0628-0081-42be-a9bb-9c78707c2850"
CYCLE_ID = "660638e5-f8cd-472b-b83f-87eaefc24e33"
OTHER_UUID = "fd5b02bc-ce99-45d0-b0e8-cb9927097f60"
VERSION = "0123456789abcdef" * 4


def payload_for(command_action="add", **changes):
    payload = {
        "request_key": REQUEST_KEY,
        "revision": "1",
        "period": "week",
        "timezone_name": "UTC",
    }
    if command_action == "add":
        payload.update(evidence_ref=EVIDENCE_REF, evidence_version=VERSION)
    else:
        payload["expected_cycle_id"] = CYCLE_ID
    payload.update(changes)
    return payload


def assert_invalid(action, payload):
    with pytest.raises(GoalsError) as caught:
        normalize_goal_command(action, payload)
    assert caught.value.code == "invalid_command"
    assert caught.value.status == 400


def test_add_returns_exact_detached_command_without_mutating_input():
    payload = payload_for()
    before = deepcopy(payload)
    command = normalize_goal_command("add", payload)
    assert type(command) is GoalsCommand
    assert command.action == "add"
    assert command.request_key == REQUEST_KEY
    assert dict(command.data) == {
        "revision": "1",
        "period": "week",
        "timezone_name": "UTC",
        "evidence_ref": EVIDENCE_REF,
        "evidence_version": VERSION,
    }
    assert payload == before
    digest = command.digest
    payload["revision"] = "2"
    payload["period"] = "year"
    assert command.data["revision"] == "1"
    assert command.data["period"] == "week"
    assert command.digest == digest


@pytest.mark.parametrize("expected_cycle_id", [None, CYCLE_ID])
def test_reset_accepts_exact_cycle_or_empty_precondition(expected_cycle_id):
    command = normalize_goal_command(
        "reset", payload_for("reset", expected_cycle_id=expected_cycle_id)
    )
    assert command.action == "reset"
    assert command.request_key == REQUEST_KEY
    assert dict(command.data) == {
        "revision": "1",
        "period": "week",
        "timezone_name": "UTC",
        "expected_cycle_id": expected_cycle_id,
    }


@pytest.mark.parametrize("action", ["add", "reset"])
def test_every_declared_field_is_required(action):
    complete = payload_for(action)
    for field in complete:
        payload = {key: value for key, value in complete.items() if key != field}
        assert_invalid(action, payload)


@pytest.mark.parametrize("action", ["add", "reset"])
@pytest.mark.parametrize("field,value", [
    ("account_id", 1),
    ("owner_id", 1),
    ("session_id", 1),
    ("library_id", 1),
    ("top_ref", OTHER_UUID),
    ("aggregate_ref", OTHER_UUID),
    ("catalog_ref", OTHER_UUID),
    ("album_ref", OTHER_UUID),
    ("release_group_id", OTHER_UUID),
    ("cycle_id", CYCLE_ID),
    ("cycle_ids", {"week": CYCLE_ID}),
    ("new_cycle_id", CYCLE_ID),
    ("assignment_id", OTHER_UUID),
    ("occurred_at", "2026-10-15T12:00:00+00:00"),
    ("assigned_at", "2026-10-15T12:00:00+00:00"),
    ("started_at", "2026-10-15T12:00:00+00:00"),
    ("created_at", "2026-10-15T12:00:00+00:00"),
    ("expires_at", "2026-10-15T12:00:00+00:00"),
    ("start_date", "2026-10-15"),
    ("due_date", "2026-10-22"),
    ("title", "Browser supplied album"),
    ("url", "https://example.invalid/album"),
    ("provider", "musicbrainz"),
    ("provenance", "verified"),
    ("trusted", True),
    ("completed", True),
    ("unknown", None),
    ("action", "add"),
])
def test_unknown_and_server_owned_fields_are_rejected(action, field, value):
    assert_invalid(action, payload_for(action, **{field: value}))


@pytest.mark.parametrize("action,extra", [
    ("add", {"expected_cycle_id": None}),
    ("reset", {"evidence_ref": EVIDENCE_REF}),
    ("reset", {"evidence_version": VERSION}),
])
def test_fields_from_other_command_are_rejected(action, extra):
    assert_invalid(action, payload_for(action, **extra))


@pytest.mark.parametrize("action", [None, True, False, 1, [], {}, "", "Add", "RESET", "remove", "complete"])
def test_invalid_or_unsupported_actions_are_rejected(action):
    assert_invalid(action, payload_for())


@pytest.mark.parametrize("payload", [None, True, False, 1, 1.5, "{}", [], (), [payload_for()]])
@pytest.mark.parametrize("action", ["add", "reset"])
def test_payload_must_be_an_object(action, payload):
    assert_invalid(action, payload)


@pytest.mark.parametrize("value", [
    None, True, False, 1, 1.5, b"1", [], {}, "", "0", "00", "01", "+1", "-1",
    "1.0", "1e0", " 1", "1 ", "1\n", "\t1", "١", "１",
    "9223372036854775808", "9" * 20, "9" * 10_000,
])
def test_revision_rejects_noncanonical_or_out_of_range_values(value):
    with pytest.raises(GoalsError) as caught:
        revision(value)
    assert caught.value.code == "invalid_command"
    assert caught.value.status == 400
    assert_invalid("add", payload_for(revision=value))
    assert_invalid("reset", payload_for("reset", revision=value))


@pytest.mark.parametrize("value", ["1", "2", "9007199254740993", "9223372036854775807"])
def test_revision_preserves_canonical_decimal_text_without_float_loss(value):
    assert revision(value) == value
    assert normalize_goal_command("add", payload_for(revision=value)).data["revision"] == value


def test_revision_limit_is_postgres_signed_bigint():
    assert MAX_REVISION == 2**63 - 1


INVALID_UUIDS = [
    None, True, False, 1, [], {}, UUID(REQUEST_KEY), b"16b9234d-97f5-4e41-a03b-c74672fb1825",
    "", "00000000-0000-0000-0000-000000000000", REQUEST_KEY.upper(),
    REQUEST_KEY.replace("-", ""), "{" + REQUEST_KEY + "}", "urn:uuid:" + REQUEST_KEY,
    " " + REQUEST_KEY, REQUEST_KEY + " ", REQUEST_KEY + "\n", "g" + REQUEST_KEY[1:],
    REQUEST_KEY[:-1], REQUEST_KEY + "0", "\ud800" + REQUEST_KEY[1:],
]


@pytest.mark.parametrize("value", INVALID_UUIDS)
def test_uuid_helper_rejects_noncanonical_nonnil_values(value):
    with pytest.raises(GoalsError) as caught:
        uuid_ref(value)
    assert caught.value.code == "invalid_command"
    assert caught.value.status == 400


@pytest.mark.parametrize("action,field", [
    ("add", "request_key"), ("reset", "request_key"),
    ("add", "evidence_ref"), ("reset", "expected_cycle_id"),
])
@pytest.mark.parametrize("value", [value for value in INVALID_UUIDS if value is not None])
def test_uuid_command_fields_use_the_strict_helper(action, field, value):
    assert_invalid(action, payload_for(action, **{field: value}))


@pytest.mark.parametrize("field", ["request_key", "evidence_ref"])
def test_add_uuid_fields_cannot_be_null(field):
    assert_invalid("add", payload_for(**{field: None}))


def test_reset_request_key_cannot_be_null():
    assert_invalid("reset", payload_for("reset", request_key=None))


@pytest.mark.parametrize("value", [REQUEST_KEY, "00000000-0000-0000-0000-000000000001", "ffffffff-ffff-ffff-ffff-ffffffffffff"])
def test_uuid_helper_preserves_nonnil_canonical_identity(value):
    assert uuid_ref(value) == value


@pytest.mark.parametrize("value", [
    None, True, False, 1, [], {}, b"a" * 64, "", "a" * 63, "a" * 65,
    VERSION.upper(), "g" * 64, " " + VERSION, VERSION + " ", VERSION + "\n", "０" * 64,
])
def test_evidence_version_requires_exact_lowercase_sha256_text(value):
    assert_invalid("add", payload_for(evidence_version=value))


@pytest.mark.parametrize("value", [VERSION, "0" * 64, "f" * 64])
def test_evidence_version_is_a_version_not_an_authority_decision(value):
    assert normalize_goal_command("add", payload_for(evidence_version=value)).data["evidence_version"] == value


@pytest.mark.parametrize("value", [None, True, False, 1, [], {}, "", "Week", "weekly", "six_months", "all", "year "])
@pytest.mark.parametrize("action", ["add", "reset"])
def test_period_is_a_bounded_exact_enum(action, value):
    assert_invalid(action, payload_for(action, period=value))


@pytest.mark.parametrize("period", ["week", "month", "six-months", "year"])
@pytest.mark.parametrize("action", ["add", "reset"])
def test_existing_domain_period_names_are_supported(action, period):
    assert normalize_goal_command(action, payload_for(action, period=period)).data["period"] == period


@pytest.mark.parametrize("value", [
    None, True, False, 1, [], {}, "", " ", "utc", "UTC ", "UTC\n", "Mars/Olympus",
    "../UTC", "/UTC", "Etc/../UTC", "Etc//UTC", "Etc/./UTC", "Etc\\UTC",
    "localtime", "posixrules", "posix/UTC", "right/UTC", "\ud800",
])
@pytest.mark.parametrize("action", ["add", "reset"])
def test_timezone_uses_the_existing_domain_validation_safely(action, value):
    assert_invalid(action, payload_for(action, timezone_name=value))


@pytest.mark.parametrize("zone", ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"])
@pytest.mark.parametrize("action", ["add", "reset"])
def test_valid_zone_names_are_preserved_for_domain_calendar_capture(action, zone):
    assert normalize_goal_command(action, payload_for(action, timezone_name=zone)).data["timezone_name"] == zone


def test_boolean_is_not_accepted_for_any_command_field():
    for action in ("add", "reset"):
        for field in payload_for(action):
            for value in (False, True):
                assert_invalid(action, payload_for(action, **{field: value}))


def test_command_and_normalized_payload_are_immutable():
    command = normalize_goal_command("add", payload_for())
    with pytest.raises(FrozenInstanceError):
        command.action = "reset"
    with pytest.raises(FrozenInstanceError):
        command.request_key = OTHER_UUID
    with pytest.raises(FrozenInstanceError):
        command.data = {}
    with pytest.raises(TypeError):
        command.data["revision"] = "2"
    with pytest.raises(TypeError):
        del command.data["period"]


@pytest.mark.parametrize("action", ["add", "reset"])
def test_digest_is_canonical_sha256_independent_of_input_key_order(action):
    payload = payload_for(action)
    command = normalize_goal_command(action, payload)
    reordered = normalize_goal_command(action, dict(reversed(list(payload.items()))))
    expected_bytes = json.dumps(
        {
            "action": action,
            "request_key": REQUEST_KEY,
            "data": {key: value for key, value in payload.items() if key != "request_key"},
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    assert command.digest == hashlib.sha256(expected_bytes).hexdigest()
    assert reordered.digest == command.digest
    assert len(command.digest) == 64


@pytest.mark.parametrize("action,field,value", [
    ("add", "request_key", OTHER_UUID),
    ("add", "revision", "2"),
    ("add", "period", "month"),
    ("add", "timezone_name", "America/Los_Angeles"),
    ("add", "evidence_ref", OTHER_UUID),
    ("add", "evidence_version", "a" * 64),
    ("reset", "request_key", OTHER_UUID),
    ("reset", "revision", "2"),
    ("reset", "period", "year"),
    ("reset", "timezone_name", "Pacific/Kiritimati"),
    ("reset", "expected_cycle_id", OTHER_UUID),
    ("reset", "expected_cycle_id", None),
])
def test_each_accepted_field_is_bound_into_the_digest(action, field, value):
    original = normalize_goal_command(action, payload_for(action))
    changed = normalize_goal_command(action, payload_for(action, **{field: value}))
    assert changed.digest != original.digest


def test_digest_binds_action_and_does_not_equate_add_with_reset():
    add = normalize_goal_command("add", payload_for())
    reset = normalize_goal_command("reset", payload_for("reset"))
    assert add.digest != reset.digest
    # Isolate the action from the differing validated schemas as well.
    assert GoalsCommand("add", REQUEST_KEY, {}).digest != GoalsCommand("reset", REQUEST_KEY, {}).digest


@pytest.mark.parametrize("action", ["add", "reset"])
def test_repository_can_renormalize_the_immutable_command(action):
    command = normalize_goal_command(action, payload_for(action))
    repeated = normalize_goal_command(
        command.action, {**command.data, "request_key": command.request_key}
    )
    assert repeated == command
    assert repeated.digest == command.digest


def test_public_error_preserves_code_and_explicit_status_without_payload():
    error = GoalsError("revision_conflict", 409)
    assert error.code == "revision_conflict"
    assert error.status == 409
    assert str(error) == "revision_conflict"
