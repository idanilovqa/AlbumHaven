"""Strict commands for authenticated Top sharing, requests and private copies."""
from dataclasses import replace

import pytest

from music_app.services.owned_album_tops import (
    ACCESS, BROWSE, CREATE, AlbumTopError, command_actions, normalize_top_command,
)
from tests.py.test_owned_album_tops import REQUEST, TOP, OTHER


CASES = (
    ("visibility", {"visibility": "server_shared"}, (BROWSE, ACCESS)),
    ("grant_editor", {"account_id": 44, "role": "editor"}, (BROWSE, ACCESS)),
    ("revoke_editor", {"grant_ref": OTHER}, (BROWSE, ACCESS)),
    ("request_edit", {}, (BROWSE,)),
    ("decide_edit_request", {"request_ref": OTHER, "decision": "approve"}, (BROWSE, ACCESS)),
    ("copy", {"title": "My copy"}, (BROWSE, CREATE)),
)


def command(action, **data):
    return normalize_top_command(action, {"request_key": REQUEST, "revision": "4", **data}, top_ref=TOP)


@pytest.mark.parametrize("action,data,actions", CASES)
def test_collaboration_commands_preserve_exact_identity_and_specific_actions(action, data, actions):
    parsed = command(action, **data)
    assert parsed.top_ref == TOP and parsed.request_key == REQUEST
    assert parsed.data == {"revision": "4", **data}
    assert command_actions(parsed) == actions
    assert parsed.digest == command(action, **data).digest
    assert parsed.digest != replace(parsed, top_ref=OTHER).digest
    assert parsed.digest != command(action, **{**data, "revision": "5"}).digest


@pytest.mark.parametrize("action,data,_", CASES)
@pytest.mark.parametrize("field,value", [
    ("owner_account_id", 41), ("library_id", 7), ("session_id", 9),
    ("allowed_actions", {ACCESS: True}), ("local_path", "/private/music"),
    ("editor_grant", True), ("source_top_ref", OTHER),
])
def test_browser_cannot_supply_authority_or_unrecognized_fields(action, data, _, field, value):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        command(action, **data, **{field: value})


@pytest.mark.parametrize("action,data,_", CASES)
@pytest.mark.parametrize("field", ["request_key", "revision"])
def test_every_collaboration_command_requires_request_key_and_revision(action, data, _, field):
    payload = {"request_key": REQUEST, "revision": "4", **data}
    del payload[field]
    with pytest.raises(AlbumTopError, match="invalid_command"):
        normalize_top_command(action, payload, top_ref=TOP)


@pytest.mark.parametrize("action,data,_", CASES)
@pytest.mark.parametrize("revision", [True, 4, "0", "04", " 4", "4\n", "٤", "9223372036854775808"])
def test_collaboration_revisions_remain_canonical_bigint_strings(action, data, _, revision):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        command(action, **data, revision=revision)


@pytest.mark.parametrize("value", [None, True, False, 0, -1, 44.0, "44", 9223372036854775808, [], {}])
def test_editor_target_is_a_positive_bigint_integer_without_bool_coercion(value):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        command("grant_editor", account_id=value, role="editor")


@pytest.mark.parametrize("value", [1, 9007199254740993, 9223372036854775807])
def test_editor_target_retains_bigint_precision(value):
    assert command("grant_editor", account_id=value, role="editor").data["account_id"] == value


@pytest.mark.parametrize("action,field,other", [
    ("revoke_editor", "grant_ref", {}),
    ("decide_edit_request", "request_ref", {"decision": "approve"}),
])
@pytest.mark.parametrize("value", [None, True, 44, "", OTHER.upper(), OTHER.replace("-", ""), OTHER + "\n", {}, []])
def test_access_and_request_refs_are_canonical_opaque_uuids(action, field, other, value):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        command(action, **other, **{field: value})


@pytest.mark.parametrize("action,data", [
    ("visibility", {"visibility": "public"}), ("visibility", {"visibility": True}),
    ("visibility", {"visibility": "PRIVATE"}), ("visibility", {"visibility": []}),
    ("grant_editor", {"account_id": 44, "role": "owner"}),
    ("grant_editor", {"account_id": 44, "role": "viewer"}),
    ("grant_editor", {"account_id": 44, "role": []}),
    ("decide_edit_request", {"request_ref": OTHER, "decision": "editor"}),
    ("decide_edit_request", {"request_ref": OTHER, "decision": True}),
    ("decide_edit_request", {"request_ref": OTHER, "decision": {}}),
    ("request_edit", {"role": "editor"}), ("copy", {"album_refs": [OTHER]}),
])
def test_allowlisted_modes_cannot_publish_escalate_or_select_a_different_copy(action, data):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        command(action, **data)


def test_copy_title_is_optional_and_normalized_without_inventing_content():
    assert command("copy").data == {"revision": "4"}
    assert command("copy", title="  私の Top  ").data == {"revision": "4", "title": "私の Top"}
    assert command("copy", title="  Copy  ").digest == command("copy", title="Copy").digest
    assert command("copy", title="Copy").digest != command("copy", title="Other").digest


@pytest.mark.parametrize("title", [None, True, "", "   ", "x" * 101, "bad\x00title", "\ud800"])
def test_copy_title_retains_existing_top_validation(title):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        command("copy", title=title)


@pytest.mark.parametrize("visibility", ["private", "server_shared"])
def test_private_and_server_shared_are_the_only_visibility_contracts(visibility):
    assert command("visibility", visibility=visibility).data["visibility"] == visibility


@pytest.mark.parametrize("decision", ["approve", "decline"])
def test_owner_decision_is_explicit_and_digest_bound(decision):
    parsed = command("decide_edit_request", request_ref=OTHER, decision=decision)
    assert parsed.data["decision"] == decision
    assert parsed.digest != command("decide_edit_request", request_ref=TOP, decision=decision).digest
