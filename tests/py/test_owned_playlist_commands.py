"""Pure owner-playlist command contract; no database or application startup.

Independently authored before implementation. SQL atomicity, locking and durable
receipt behavior require separate, admitted real-Postgres verification.
"""
from copy import deepcopy

import pytest

from music_app.services import owned_playlists as playlists


REQUEST = "10000000-0000-4000-8000-000000000001"
OTHER_REQUEST = "10000000-0000-4000-8000-000000000002"
PLAYLIST = "20000000-0000-4000-8000-000000000001"
OTHER_PLAYLIST = "20000000-0000-4000-8000-000000000002"
ITEM_A = "30000000-0000-4000-8000-000000000001"
ITEM_B = "30000000-0000-4000-8000-000000000002"
ACTIONS = ("save", "add", "remove", "reorder")


def body(action):
    common = {"request_key": REQUEST, "revision": "7"}
    return {
        "save": {**common, "title": "My playlist", "description": "Original description"},
        "add": {**common, "track_refs": ["inventory-track:73:901", "inventory-track:73:902"]},
        "remove": {**common, "item_refs": [ITEM_A, ITEM_B]},
        "reorder": {**common, "item_order": [ITEM_B, ITEM_A]},
    }[action]


def normalize(action, payload=None, *, playlist_ref=PLAYLIST):
    return playlists.normalize_playlist_command(
        action, body(action) if payload is None else payload, playlist_ref=playlist_ref,
    )


def invalid(action, payload, *, playlist_ref=PLAYLIST):
    with pytest.raises(playlists.PlaylistError) as error:
        normalize(action, payload, playlist_ref=playlist_ref)
    assert error.value.code == "invalid_command"
    assert error.value.status_code == 422


@pytest.mark.parametrize("action", ACTIONS)
def test_valid_existing_commands_keep_target_request_key_and_string_revision(action):
    payload = body(action)
    command = normalize(action, payload)
    assert command.action == action
    assert command.playlist_ref == PLAYLIST
    assert command.request_key == REQUEST
    assert command.data["revision"] == "7"
    assert "request_key" not in command.data
    assert payload == body(action)


@pytest.mark.parametrize("payload", [None, [], "body", 1, True])
def test_command_body_must_be_an_object(payload):
    with pytest.raises(playlists.PlaylistError) as error:
        playlists.normalize_playlist_command("save", payload, playlist_ref=PLAYLIST)
    assert (error.value.code, error.value.status_code) == ("invalid_command", 422)


@pytest.mark.parametrize("action", ["delete", "share", "access", "import", "create_for_other", ""])
def test_unsupported_actions_cannot_be_smuggled_into_owner_mutations(action):
    with pytest.raises(playlists.PlaylistError) as error:
        playlists.normalize_playlist_command(action, body("save"), playlist_ref=PLAYLIST)
    assert error.value.code == "invalid_command"


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("field", ["owner_account_id", "account_id", "library_id", "actor", "scopeKey", "visibility"])
def test_all_existing_commands_reject_client_authority_or_scope_fields(action, field):
    payload = body(action)
    payload[field] = "forged"
    invalid(action, payload)


@pytest.mark.parametrize("request_key", [None, "", "not-a-uuid", 12, True])
def test_mutation_requires_uuid_receipt_identity(request_key):
    payload = body("save")
    payload["request_key"] = request_key
    invalid("save", payload)


def test_mutation_rejects_missing_receipt_identity():
    payload = body("save")
    del payload["request_key"]
    invalid("save", payload)


@pytest.mark.parametrize("playlist_ref", [None, "", "track:73:901", "home:occurrence:3", "C:\\Music\\track.flac", 7, True])
def test_existing_mutation_requires_collection_uuid_not_source_or_inventory_identity(playlist_ref):
    invalid("save", body("save"), playlist_ref=playlist_ref)


@pytest.mark.parametrize("revision", [None, "", "0", "-1", "1.0", "1e2", 1, 0, True, [], {}])
def test_revision_is_a_positive_decimal_string_without_coercion(revision):
    payload = body("save")
    payload["revision"] = revision
    invalid("save", payload)


def test_existing_write_cannot_omit_revision():
    payload = body("save")
    del payload["revision"]
    invalid("save", payload)


@pytest.mark.parametrize("title", [None, "", " \t ", 42, True, [], {}])
def test_metadata_title_rejects_blank_or_non_text_values(title):
    payload = body("save")
    payload["title"] = title
    invalid("save", payload)


def test_metadata_title_trims_surrounding_whitespace():
    payload = body("save")
    payload["title"] = "  A deliberate title  "
    command = normalize("save", payload)
    assert command.data["title"] == "A deliberate title"
    assert payload["title"] == "  A deliberate title  "


@pytest.mark.parametrize("description", [None, 42, True, [], {}])
def test_description_must_be_text_instead_of_silently_coerced(description):
    payload = body("save")
    payload["description"] = description
    invalid("save", payload)


def test_description_may_be_deliberately_empty():
    payload = body("save")
    payload["description"] = ""
    assert normalize("save", payload).data["description"] == ""


@pytest.mark.parametrize("action,field", [("add", "track_refs"), ("remove", "item_refs"), ("reorder", "item_order")])
@pytest.mark.parametrize("bad_list", [None, "not-a-list", {}, [None], [True], [""], [[ITEM_A]]])
def test_item_inputs_are_dense_typed_lists(action, field, bad_list):
    payload = body(action)
    payload[field] = bad_list
    invalid(action, payload)


@pytest.mark.parametrize("action,field,value", [
    ("add", "track_refs", "inventory-track:73:901"),
    ("remove", "item_refs", ITEM_A),
    ("reorder", "item_order", ITEM_A),
    ("save", "item_order", ITEM_A),
])
def test_duplicate_refs_reject_whole_command_instead_of_deduping(action, field, value):
    payload = body(action)
    payload[field] = [value, value]
    invalid(action, payload)


@pytest.mark.parametrize("action,field", [("add", "track_refs"), ("remove", "item_refs")])
def test_add_and_remove_reject_empty_batches(action, field):
    payload = body(action)
    payload[field] = []
    invalid(action, payload)


@pytest.mark.parametrize("action", ["save", "reorder"])
def test_full_order_can_be_empty_for_an_empty_playlist(action):
    payload = body(action)
    payload["item_order"] = []
    assert normalize(action, payload).data["item_order"] == []


@pytest.mark.parametrize("action,field", [("remove", "item_refs"), ("reorder", "item_order"), ("save", "item_order")])
def test_item_order_and_removal_do_not_accept_native_track_refs(action, field):
    payload = body(action)
    payload[field] = ["track:73:901"]
    invalid(action, payload)


@pytest.mark.parametrize("action", ACTIONS)
def test_semantic_digest_ignores_request_key_but_not_command_contents(action):
    first = normalize(action)
    changed_key = body(action)
    changed_key["request_key"] = OTHER_REQUEST
    assert first.digest == normalize(action, changed_key).digest
    assert len(first.digest) == 64
    assert all(character in "0123456789abcdef" for character in first.digest)


@pytest.mark.parametrize("changed_field,changed_value", [
    ("revision", "8"), ("title", "Different title"),
    ("description", "Different description"), ("item_order", [ITEM_A, ITEM_B]),
])
def test_metadata_digest_covers_revision_metadata_and_authored_item_order(changed_field, changed_value):
    first = normalize("save")
    payload = body("save")
    payload[changed_field] = changed_value
    assert first.digest != normalize("save", payload).digest


@pytest.mark.parametrize("action,field", [("add", "track_refs"), ("remove", "item_refs"), ("reorder", "item_order")])
def test_digest_retains_supplied_selection_order(action, field):
    payload = body(action)
    first = normalize(action, payload)
    payload[field] = list(reversed(payload[field]))
    assert first.digest != normalize(action, payload).digest


def test_digest_binds_target_collection_and_action():
    assert normalize("save").digest != normalize("save", playlist_ref=OTHER_PLAYLIST).digest
    remove = normalize("remove")
    reorder_body = body("reorder")
    reorder_body["item_order"] = [ITEM_A, ITEM_B]
    assert remove.digest != normalize("reorder", reorder_body).digest


def test_digest_is_independent_of_json_object_key_order():
    payload = body("save")
    reversed_payload = dict(reversed(list(payload.items())))
    assert normalize("save", payload).digest == normalize("save", reversed_payload).digest


def test_command_freezes_a_detached_copy_of_mutable_caller_data():
    payload = body("save")
    payload["item_order"] = [ITEM_B, ITEM_A]
    command = normalize("save", payload)
    captured = deepcopy(command.data)
    digest = command.digest
    payload["item_order"].reverse()
    payload["title"] = "Mutated after validation"
    assert command.data == captured
    assert command.digest == digest


@pytest.mark.parametrize("field,bound_name", [
    ("title", "MAX_PLAYLIST_TITLE_LENGTH"),
    ("description", "MAX_PLAYLIST_DESCRIPTION_LENGTH"),
])
def test_text_bounds_accept_exact_limit_and_reject_over_limit(field, bound_name):
    bound = getattr(playlists, bound_name)
    payload = body("save")
    payload[field] = "x" * bound
    assert normalize("save", payload).data[field] == payload[field]
    payload[field] += "x"
    invalid("save", payload)


@pytest.mark.parametrize("action,field", [("add", "track_refs"), ("remove", "item_refs"), ("reorder", "item_order")])
def test_item_count_is_bounded_before_repository_resolution(action, field):
    from uuid import UUID

    bound = playlists.MAX_PLAYLIST_ITEMS_PER_COMMAND
    payload = body(action)
    payload[field] = [
        f"inventory-track:73:{index + 1}" if action == "add" else str(UUID(int=index + 1))
        for index in range(bound)
    ]
    assert len(normalize(action, payload).data[field]) == bound
    payload[field].append(f"inventory-track:73:{bound + 1}" if action == "add" else str(UUID(int=bound + 1)))
    invalid(action, payload)


@pytest.mark.parametrize("only_field", ["title", "description", "item_order"])
def test_save_accepts_each_independent_edit_without_inventing_omitted_fields(only_field):
    payload = {"request_key": REQUEST, "revision": "7", only_field: {
        "title": "One title", "description": "", "item_order": [ITEM_A],
    }[only_field]}
    command = normalize("save", payload)
    assert set(command.data) == {"revision", only_field}


def test_save_rejects_receipt_only_without_an_edit():
    invalid("save", {"request_key": REQUEST, "revision": "7"})


@pytest.mark.parametrize("track_ref", [
    ITEM_A, "track:73:901", "canonical-track:901", "901", "73:901",
    "C:\\Music\\track.flac", "/private/music/track.flac", "Song title",
    "inventory-track:0:901", "inventory-track:73:0",
    "inventory-track:-1:901", "inventory-track:73:1.0",
    "inventory-track:73:1e2", "inventory-track:other:901",
])
def test_add_requires_explicit_inventory_namespace_without_path_or_title_guess(track_ref):
    payload = body("add")
    payload["track_refs"] = [track_ref]
    invalid("add", payload)


def test_add_does_not_pretend_parser_can_authorize_foreign_inventory_scope():
    payload = body("add")
    payload["track_refs"] = ["inventory-track:74:901"]
    command = normalize("add", payload)
    assert command.data["track_refs"] == ["inventory-track:74:901"]
    # Matching the trusted current library and real row belongs to the repository.
