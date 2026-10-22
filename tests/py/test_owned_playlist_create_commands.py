"""Explicit paged-selection Create commands, not complete-catalogue snapshots."""
from copy import deepcopy
from uuid import UUID

import pytest

from music_app.services import owned_playlists as playlists


REQUEST = "10000000-0000-4000-8000-000000000001"
PLAYLIST = "20000000-0000-4000-8000-000000000001"
SOURCE = "40000000-0000-4000-8000-000000000001"
SOURCE_REVISION = "50000000-0000-4000-8000-000000000001"
ENTRY_A = "60000000-0000-4000-8000-000000000001"
ENTRY_B = "60000000-0000-4000-8000-000000000002"


def body():
    return {
        "request_key": REQUEST, "source_protocol": "library_selection_v1",
        "mode": "ordinary", "source": {"kind": "library", "ref": SOURCE, "revision": SOURCE_REVISION},
        "title": "A selected playlist", "description": "Recorded selection",
        "entry_refs": [ENTRY_B, ENTRY_A],
    }


def normalize(payload):
    return playlists.normalize_playlist_command("create", payload)


def invalid(payload):
    with pytest.raises(playlists.PlaylistError) as error:
        normalize(payload)
    assert (error.value.code, error.value.status_code) == ("invalid_command", 422)


def test_create_preserves_explicit_session_descriptor_and_authored_receipt_order():
    payload = body()
    command = normalize(payload)
    assert command.action == "create"
    assert command.playlist_ref is None
    assert command.request_key == REQUEST
    assert command.data == {key: value for key, value in payload.items() if key != "request_key"}
    assert command.data["entry_refs"] == [ENTRY_B, ENTRY_A]
    assert payload == body()


def test_empty_ordinary_create_is_valid_and_never_implies_select_all():
    payload = body()
    payload["entry_refs"] = []
    assert normalize(payload).data["entry_refs"] == []


def test_create_defaults_omitted_description_to_empty_without_mutating_caller():
    payload = body()
    del payload["description"]
    assert normalize(payload).data["description"] == ""
    assert "description" not in payload


@pytest.mark.parametrize("missing", ["request_key", "source_protocol", "mode", "source", "title", "entry_refs"])
def test_create_requires_every_identity_and_selection_field(missing):
    payload = body()
    del payload[missing]
    invalid(payload)


@pytest.mark.parametrize("protocol", [None, "", "complete_source_v1", "library_selection_v2", 1, True])
def test_paged_selection_protocol_cannot_be_inferred_or_reinterpreted(protocol):
    payload = body()
    payload["source_protocol"] = protocol
    invalid(payload)


@pytest.mark.parametrize("mode", [None, "missing", "history", "import", "derived", ""])
def test_create_accepts_only_implemented_ordinary_mode(mode):
    payload = body()
    payload["mode"] = mode
    invalid(payload)


@pytest.mark.parametrize("field", ["owner_account_id", "account_id", "library_id", "actor", "scopeKey", "visibility", "entries", "entries_complete", "track_refs", "revision"])
def test_create_rejects_spoofed_scope_display_rows_and_other_protocol_fields(field):
    payload = body()
    payload[field] = "forged"
    invalid(payload)


@pytest.mark.parametrize("source", [None, [], "source", {}, {"kind": "library", "ref": SOURCE}])
def test_create_requires_exact_source_descriptor(source):
    payload = body()
    payload["source"] = source
    invalid(payload)


@pytest.mark.parametrize("field,value", [
    ("kind", "home"), ("kind", "history"), ("kind", "missing"),
    ("ref", "inventory-track:73:901"), ("ref", None),
    ("revision", "7"), ("revision", None),
    ("library_id", 74), ("owner_account_id", 42),
])
def test_create_rejects_forged_source_namespace_revision_and_authority(field, value):
    payload = body()
    payload["source"][field] = value
    invalid(payload)


@pytest.mark.parametrize("entry_refs", [None, "entries", {}, [None], [True], [""], ["inventory-track:73:901"], [ENTRY_A, ENTRY_A]])
def test_create_selected_refs_are_dense_unique_receipt_uuids(entry_refs):
    payload = body()
    payload["entry_refs"] = entry_refs
    invalid(payload)


def test_create_selection_limit_rejects_instead_of_truncating():
    payload = body()
    bound = playlists.MAX_PLAYLIST_ITEMS_PER_COMMAND
    payload["entry_refs"] = [str(UUID(int=index + 1)) for index in range(bound)]
    assert normalize(payload).data["entry_refs"] == payload["entry_refs"]
    payload["entry_refs"].append(str(UUID(int=bound + 1)))
    invalid(payload)


@pytest.mark.parametrize("title", [None, "", " \t ", 42, True])
def test_create_title_is_required_text(title):
    payload = body()
    payload["title"] = title
    invalid(payload)


@pytest.mark.parametrize("field,bound_name", [
    ("title", "MAX_PLAYLIST_TITLE_LENGTH"),
    ("description", "MAX_PLAYLIST_DESCRIPTION_LENGTH"),
])
def test_create_metadata_bounds_are_enforced_before_persistence(field, bound_name):
    payload = body()
    payload[field] = "x" * getattr(playlists, bound_name)
    assert normalize(payload).data[field] == payload[field]
    payload[field] += "x"
    invalid(payload)


@pytest.mark.parametrize("description", [None, 42, True])
def test_create_description_never_coerces_null_or_non_text(description):
    payload = body()
    payload["description"] = description
    invalid(payload)


def test_create_must_not_target_a_caller_supplied_collection():
    with pytest.raises(playlists.PlaylistError) as error:
        playlists.normalize_playlist_command("create", body(), playlist_ref=PLAYLIST)
    assert error.value.code == "invalid_command"


@pytest.mark.parametrize("field,value", [
    ("title", "Another title"), ("description", "Another description"),
    ("entry_refs", [ENTRY_A, ENTRY_B]), ("entry_refs", []),
])
def test_create_digest_covers_metadata_and_exact_selected_receipt_order(field, value):
    original = normalize(body())
    payload = body()
    payload[field] = value
    assert normalize(payload).digest != original.digest


@pytest.mark.parametrize("field", ["ref", "revision"])
def test_create_digest_binds_exact_source_session_identity(field):
    original = normalize(body())
    payload = body()
    payload["source"][field] = "70000000-0000-4000-8000-000000000002"
    assert normalize(payload).digest != original.digest


def test_create_digest_ignores_receipt_key_and_dictionary_insertion_order():
    original = normalize(body())
    payload = dict(reversed(list(body().items())))
    payload["source"] = dict(reversed(list(payload["source"].items())))
    payload["request_key"] = "10000000-0000-4000-8000-000000000002"
    assert normalize(payload).digest == original.digest


def test_create_detaches_nested_source_and_selection_from_caller_mutation():
    payload = body()
    command = normalize(payload)
    captured = deepcopy(command.data)
    digest = command.digest
    payload["source"]["revision"] = "70000000-0000-4000-8000-000000000002"
    payload["entry_refs"].reverse()
    assert command.data == captured
    assert command.digest == digest
