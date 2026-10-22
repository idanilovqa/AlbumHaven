"""Pure typed membership command contracts; no storage, provider, or app setup."""
from collections import UserDict
from copy import deepcopy
import json
from uuid import UUID

import pytest

from music_app.services.owned_album_tops import (
    BROWSE, CREATE, ITEMS, MANAGE, AlbumTopCommand, AlbumTopError,
    command_actions, normalize_top_command, normalize_top_publication_preview,
)


REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
ALBUM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
DRAFT = "ffffffff-ffff-4fff-8fff-ffffffffffff"
ACQUISITION = "11111111-1111-4111-8111-111111111111"
ADMISSION = "22222222-2222-4222-8222-222222222222"
SOURCE = "33333333-3333-4333-8333-333333333333"
ZERO = "00000000-0000-0000-0000-000000000000"
VERSION = "0123456789abcdef" * 4
OTHER_VERSION = "f" * 64


class DictSubclass(dict):
    pass


class ListSubclass(list):
    pass


class TextSubclass(str):
    pass


BAD_REFS = [None, True, False, 1, 1.0, "", ALBUM.upper(), ALBUM.replace("-", ""),
            "{" + ALBUM + "}", "urn:uuid:" + ALBUM, " " + ALBUM, ALBUM + "\n",
            UUID(ALBUM), TextSubclass(ALBUM), [], {}]
BAD_REMOTE_REFS = [ZERO, *BAD_REFS]
BAD_VERSIONS = [None, True, False, 1, 1.0, "", VERSION.upper(), VERSION[:-1],
                VERSION + "0", VERSION + "\n", " " + VERSION, "g" * 64,
                TextSubclass(VERSION), [], {}]
BAD_KINDS = [None, True, False, 1, "", "local", "remote_summary", "REMOTE_ACQUISITION",
             "existing ", "new_remote\n", [], {}]
BAD_REVISIONS = [None, True, False, 1, 1.0, "", "0", "-1", "+1", "01", "1.0",
                 "1e2", " 1", "1 ", "1\n", "١", "１", "9223372036854775808",
                 TextSubclass("1"), [], {}]


def _pending(ref=ACQUISITION, version=VERSION):
    return {"kind": "remote_acquisition", "acquisition_ref": ref, "evidence_version": version}


def _retained(ref=ADMISSION, version=VERSION):
    return {"kind": "remote_retained", "admission_ref": ref, "evidence_version": version}


def _local(ref=ALBUM):
    return {"kind": "local_catalog", "album_ref": ref}


def _unselected():
    return {"kind": "unselected"}


def _local_source(local=12, ref=SOURCE):
    return {"kind": "local", "selected_local_album_id": local, "selected_source_ref": ref}


def _existing(source=None, album=ALBUM, item=ITEM):
    return {"kind": "existing", "item_ref": item, "album_ref": album,
            "source": _retained() if source is None else source}


def _new_local(source=None, album=ALBUM):
    return {"kind": "new_local", "album_ref": album,
            "source": _unselected() if source is None else source}


def _new_remote(source=None):
    return {"kind": "new_remote", "source": _pending() if source is None else source}


def _payload(action, **changes):
    result = {"request_key": REQUEST}
    if action == "create":
        result.update(title="  Mixed Ω  ", draft_ref=DRAFT, selections=[_local(), _pending()])
    elif action == "add":
        result.update(revision="7", selections=[_local(), _pending(), _retained()])
    else:
        result.update(revision="7", item_selections=[_existing(), _new_remote()])
    result.update(changes)
    return result


def _normalize(action, payload=None, **changes):
    return normalize_top_command(action, _payload(action, **changes) if payload is None else payload,
                                 top_ref=None if action == "create" else TOP)


def _invalid(action, payload=None, **changes):
    with pytest.raises(AlbumTopError) as caught:
        _normalize(action, payload, **changes)
    assert caught.value.code == "invalid_command"
    assert caught.value.status_code == 422


def test_create_retains_exact_draft_and_selection_discriminants_with_only_safe_defaults():
    result = _normalize("create")
    assert type(result) is AlbumTopCommand
    assert result.action == "create" and result.top_ref is None and result.request_key == REQUEST
    assert result.data == {"title": "Mixed Ω", "description": "", "draft_ref": DRAFT,
                           "selections": [_local(), _pending()]}
    assert "album_refs" not in result.data
    assert command_actions(result) == (BROWSE, CREATE)


def test_create_accepts_remote_only_and_explicit_description():
    result = _normalize("create", selections=[_pending()], description="Description Ω")
    assert result.data["selections"] == [_pending()]
    assert result.data["description"] == "Description Ω"


def test_add_retains_all_three_selection_types_and_supplied_order():
    selections = [_retained(), _local(OTHER), _pending(), _local()]
    result = _normalize("add", selections=selections)
    assert result.data == {"revision": "7", "selections": selections}
    assert result.top_ref == TOP and result.action == "add"
    assert command_actions(result) == (BROWSE, ITEMS)


@pytest.mark.parametrize("selector", [_pending(), _retained()])
def test_add_accepts_a_single_remote_selector(selector):
    assert _normalize("add", selections=[selector]).data["selections"] == [selector]


@pytest.mark.parametrize("action", ["create", "add"])
@pytest.mark.parametrize("value", [None, True, False, "[]", {}, (), UserDict(), ListSubclass(), [],
                                  [_local()], [_local(), _local(OTHER)]])
def test_create_add_require_plain_nonempty_lists_with_at_least_one_remote(action, value):
    _invalid(action, selections=value)


@pytest.mark.parametrize("action", ["create", "add"])
@pytest.mark.parametrize("value", [[], None, [ALBUM]])
def test_create_add_reject_both_legacy_and_typed_keys_even_if_legacy_is_empty(action, value):
    _invalid(action, album_refs=value)


def test_create_requires_draft_only_on_the_new_branch_and_never_accepts_retained():
    payload = _payload("create")
    del payload["draft_ref"]
    _invalid("create", payload)
    _invalid("create", selections=[_retained()])
    _invalid("create", selections=[_pending(), _retained()])
    payload = {"request_key": REQUEST, "title": "Local", "album_refs": [ALBUM], "draft_ref": DRAFT}
    _invalid("create", payload)
    _invalid("create", {"request_key": REQUEST, "title": "Local", "draft_ref": DRAFT})
    with pytest.raises(AlbumTopError, match="invalid_command"):
        normalize_top_command("create", _payload("create"), top_ref=TOP)
    _invalid("create", revision="1")


@pytest.mark.parametrize("value", BAD_REMOTE_REFS)
def test_create_draft_reference_is_nonzero_canonical_uuid(value):
    _invalid("create", draft_ref=value)


@pytest.mark.parametrize("action", ["create", "add"])
@pytest.mark.parametrize("row", [None, True, False, [], (), "row", {}, UserDict(_pending()),
                                DictSubclass(_pending()), {"kind": "local_catalog"},
                                {"kind": "remote_acquisition", "acquisition_ref": ACQUISITION},
                                {"kind": "remote_acquisition", "evidence_version": VERSION}])
def test_selections_reject_malformed_rows_and_missing_fields(action, row):
    _invalid(action, selections=[row])


@pytest.mark.parametrize("kind", [*BAD_KINDS, TextSubclass("remote_acquisition"),
                                  TextSubclass("local_catalog"), TextSubclass("remote_retained")])
@pytest.mark.parametrize("selector", [_local(), _pending(), _retained()])
def test_selection_discriminator_is_an_exact_supported_string(kind, selector):
    _invalid("add", selections=[{**selector, "kind": kind}])


@pytest.mark.parametrize("value", BAD_REFS)
def test_local_catalog_reference_keeps_existing_canonical_uuid_validation(value):
    _invalid("add", selections=[_local(value), _pending()])


@pytest.mark.parametrize("value", BAD_REMOTE_REFS)
@pytest.mark.parametrize("kind,field", [("remote_acquisition", "acquisition_ref"),
                                      ("remote_retained", "admission_ref")])
def test_remote_selector_reference_is_nonzero_canonical_uuid(value, kind, field):
    _invalid("add", selections=[{"kind": kind, field: value, "evidence_version": VERSION}])


@pytest.mark.parametrize("value", BAD_VERSIONS)
@pytest.mark.parametrize("selector", [_pending(), _retained()])
def test_remote_selector_version_is_exact_lowercase_sha256(value, selector):
    _invalid("add", selections=[{**selector, "evidence_version": value}])


@pytest.mark.parametrize("selector", [_pending(version="0" * 64), _retained(version="0" * 64)])
def test_zero_digest_is_well_formed_but_never_implies_evidence_authority(selector):
    assert _normalize("add", selections=[selector]).data["selections"] == [selector]


@pytest.mark.parametrize("selector", [_local(), _pending(), _retained()])
@pytest.mark.parametrize("field,value", [
    ("title", "Browser title"), ("artist_display", "Browser artist"), ("provider", "musicbrainz"),
    ("release_group_id", OTHER), ("catalog_album_ref", OTHER), ("item_ref", ITEM),
    ("owner_account_id", 41), ("library_id", 7), ("session_id", 9), ("context_ref", VERSION),
    ("destination", {"kind": "top", "top_ref": TOP, "revision": "7"}),
    ("url", "https://example.invalid/release-group"), ("facts", {}), ("tracks", []),
    ("selected_local_album_id", 12), ("selected_source_ref", SOURCE), (1, "extra"),
])
def test_selections_reject_browser_metadata_authority_and_mixed_shapes(selector, field, value):
    _invalid("add", selections=[{**selector, field: value}, _pending(ref=OTHER)])


@pytest.mark.parametrize("selector,field,value", [
    (_pending(), "album_ref", ALBUM), (_pending(), "admission_ref", ADMISSION),
    (_retained(), "album_ref", ALBUM), (_retained(), "acquisition_ref", ACQUISITION),
    (_local(), "acquisition_ref", ACQUISITION), (_local(), "evidence_version", VERSION),
])
def test_selection_namespaces_never_accept_another_branches_fields(selector, field, value):
    _invalid("add", selections=[{**selector, field: value}, _pending(ref=OTHER)])


@pytest.mark.parametrize("selections", [
    [_local(), _local(), _pending()], [_pending(), _pending()],
    [_pending(), _pending(version=OTHER_VERSION)], [_retained(), _retained()],
    [_retained(), _retained(version=OTHER_VERSION)],
])
def test_selection_duplicates_ignore_version_for_the_same_ref(selections):
    _invalid("add", selections=selections)


@pytest.mark.parametrize("selections", [
    [_local(), _local(), _pending()], [_pending(), _pending()],
    [_pending(), _pending(version=OTHER_VERSION)],
])
def test_create_rejects_duplicates_before_consuming_any_draft_bound_selection(selections):
    _invalid("create", selections=selections)


def test_wire_does_not_infer_resolved_catalog_identity_from_separate_reference_namespaces():
    selections = [_local(ALBUM), _pending(ALBUM), _retained(ALBUM)]
    assert _normalize("add", selections=selections).data["selections"] == selections
    # The transaction must still reject these if their resolved catalogs coincide.


@pytest.mark.parametrize("action", ["create", "add"])
def test_selection_bound_is_5000_without_truncating_or_reordering(action):
    selections = [_local(str(UUID(int=index))) for index in range(1, 5000)] + [_pending()]
    assert _normalize(action, selections=selections).data["selections"] == selections
    _invalid(action, selections=[*selections, _local(OTHER)])


@pytest.mark.parametrize("action", ["create", "add"])
def test_remote_only_selection_bound_is_5000(action):
    selections = [_pending(str(UUID(int=index))) for index in range(1, 5001)]
    assert _normalize(action, selections=selections).data["selections"] == selections
    _invalid(action, selections=[*selections, _pending(OTHER)])


@pytest.mark.parametrize("source", [_unselected(), _local_source(), _pending(), _retained()])
def test_existing_draft_row_allows_each_explicit_source_branch(source):
    rows = [_existing(source)]
    result = _normalize("save", item_selections=rows)
    assert result.data == {"revision": "7", "item_selections": rows}
    assert "items" not in result.data
    # Source identity and a current remote item's unselected prohibition require
    # the locked transaction's actual current membership, not browser assertions.
    assert command_actions(result) == (BROWSE, MANAGE)


@pytest.mark.parametrize("source", [_unselected(), _local_source()])
def test_new_local_draft_rows_accept_only_unselected_or_local_sources(source):
    rows = [_new_local(source)]
    assert _normalize("save", item_selections=rows).data["item_selections"] == rows


@pytest.mark.parametrize("source", [_pending(), _retained()])
def test_new_remote_draft_rows_need_no_invented_catalog_or_item_uuid(source):
    rows = [_new_remote(source)]
    result = _normalize("save", item_selections=rows)
    assert result.data["item_selections"] == rows
    assert set(result.data["item_selections"][0]) == {"kind", "source"}


def test_mixed_complete_draft_preserves_all_rows_order_and_explicit_header_changes():
    rows = [_existing(_local_source()), _new_remote(), _new_local(album=OTHER),
            _existing(_retained(), album=DRAFT, item=OTHER)]
    result = _normalize("save", item_selections=rows, title="  New Ω  ", description="", evidence_revision=VERSION)
    assert result.data == {"revision": "7", "title": "New Ω", "description": "",
                           "item_selections": rows, "evidence_revision": VERSION}
    assert command_actions(result) == (BROWSE, MANAGE)


@pytest.mark.parametrize("rows", [[], [_new_local()], [_existing(_local_source())]])
def test_typed_save_can_remove_or_switch_every_remote_member_and_still_request_existing_evidence(rows):
    result = _normalize("save", item_selections=rows, evidence_revision=VERSION)
    assert result.data == {"revision": "7", "item_selections": rows, "evidence_revision": VERSION}
    # Typed commands still require the service-only context gate. This pure
    # command never decides whether an enabled-link owner Save must publish.


@pytest.mark.parametrize("value", [None, True, False, "[]", {}, (), UserDict(), ListSubclass()])
def test_typed_save_requires_a_plain_list(value):
    _invalid("save", item_selections=value)


@pytest.mark.parametrize("value", [None, [], [{"album_ref": ALBUM, "item_ref": ITEM}]])
def test_typed_save_rejects_legacy_items_even_if_empty_or_invalid(value):
    _invalid("save", items=value)


@pytest.mark.parametrize("row", [None, True, False, "row", [], (), {}, UserDict(_existing()),
                                DictSubclass(_existing())])
def test_typed_save_rejects_nonplain_or_incomplete_rows(row):
    _invalid("save", item_selections=[row])


@pytest.mark.parametrize("row", [_existing(), _new_local(), _new_remote()])
def test_typed_save_requires_each_exact_row_field(row):
    for field in row:
        value = {key: val for key, val in row.items() if key != field}
        _invalid("save", item_selections=[value])


@pytest.mark.parametrize("kind", [*BAD_KINDS, TextSubclass("existing"), TextSubclass("new_local"),
                                  TextSubclass("new_remote"), "local_catalog", "remote_acquisition"])
def test_typed_save_row_discriminator_is_strict(kind):
    _invalid("save", item_selections=[{**_existing(), "kind": kind}])


@pytest.mark.parametrize("row", [_existing(), _new_local(), _new_remote()])
@pytest.mark.parametrize("field,value", [
    ("title", "Browser title"), ("provider", "musicbrainz"), ("release_group_id", OTHER),
    ("owner_account_id", 41), ("context_ref", VERSION), ("facts", {}), ("tracks", []),
    ("selected_local_album_id", 12), ("selected_source_ref", SOURCE), (1, "extra"),
])
def test_typed_save_rejects_extra_row_metadata_or_flattened_source_fields(row, field, value):
    _invalid("save", item_selections=[{**row, field: value}])


@pytest.mark.parametrize("row,field,value", [
    (_new_remote(), "item_ref", ITEM), (_new_remote(), "item_ref", None),
    (_new_remote(), "album_ref", ALBUM), (_new_local(), "item_ref", None),
    (_new_local(), "item_ref", ITEM), (_existing(), "item_ref", None),
])
def test_typed_row_namespaces_do_not_accept_legacy_null_or_invented_identifiers(row, field, value):
    _invalid("save", item_selections=[{**row, field: value}])


@pytest.mark.parametrize("field", ["album_ref", "item_ref"])
@pytest.mark.parametrize("value", BAD_REFS)
def test_existing_draft_refs_are_canonical(field, value):
    _invalid("save", item_selections=[{**_existing(), field: value}])


@pytest.mark.parametrize("value", BAD_REFS)
def test_new_local_draft_album_is_canonical(value):
    _invalid("save", item_selections=[_new_local(album=value)])


@pytest.mark.parametrize("source", [None, True, False, "source", [], (), {},
                                   UserDict(_pending()), DictSubclass(_pending())])
def test_draft_source_requires_exact_plain_dict(source):
    _invalid("save", item_selections=[{**_existing(), "source": source}])


@pytest.mark.parametrize("source", [_unselected(), _local_source(), _pending(), _retained()])
def test_draft_source_requires_all_fields(source):
    for field in source:
        value = {key: val for key, val in source.items() if key != field}
        _invalid("save", item_selections=[_existing(value)])


@pytest.mark.parametrize("source", [_unselected(), _local_source(), _pending(), _retained()])
@pytest.mark.parametrize("kind", [None, True, 1, [], {}, "", "local_catalog", "remote_summary"])
def test_draft_source_discriminator_rejects_wrong_types_and_unknown_kinds(source, kind):
    _invalid("save", item_selections=[_existing({**source, "kind": kind})])


@pytest.mark.parametrize("source", [_unselected(), _local_source(), _pending(), _retained()])
def test_draft_source_kind_rejects_string_subclasses(source):
    _invalid("save", item_selections=[_existing({**source, "kind": TextSubclass(source["kind"])})])


@pytest.mark.parametrize("source", [_unselected(), _local_source(), _pending(), _retained()])
@pytest.mark.parametrize("field,value", [
    ("album_ref", ALBUM), ("item_ref", ITEM), ("release_group_id", OTHER),
    ("title", "Browser title"), ("provider", "musicbrainz"), ("facts", {}),
    ("context_ref", VERSION), ("owner_account_id", 41), (1, "extra"),
])
def test_draft_sources_reject_browser_catalog_identity_metadata_and_authority(source, field, value):
    _invalid("save", item_selections=[_existing({**source, field: value})])


@pytest.mark.parametrize("row", [_new_local(_pending()), _new_local(_retained()),
                                _new_remote(_unselected()), _new_remote(_local_source())])
def test_new_member_source_kind_matches_explicit_local_or_remote_row_kind(row):
    _invalid("save", item_selections=[row])


@pytest.mark.parametrize("source,field,value", [
    (_unselected(), "selected_source_ref", SOURCE), (_local_source(), "admission_ref", ADMISSION),
    (_local_source(), "evidence_version", VERSION), (_pending(), "selected_local_album_id", 12),
    (_retained(), "selected_source_ref", SOURCE), (_pending(), "admission_ref", ADMISSION),
    (_retained(), "acquisition_ref", ACQUISITION),
])
def test_draft_source_variants_are_exclusive(source, field, value):
    _invalid("save", item_selections=[_existing({**source, field: value})])


@pytest.mark.parametrize("value", [None, True, False, 0, -1, "12", 12.0, 9223372036854775808, [], {}])
def test_local_source_album_id_is_a_positive_nonboolean_bigint(value):
    _invalid("save", item_selections=[_existing(_local_source(local=value))])


@pytest.mark.parametrize("value", [1, 9007199254740993, 9223372036854775807])
def test_local_source_album_id_keeps_exact_bigint_precision(value):
    source = _local_source(local=value)
    assert _normalize("save", item_selections=[_existing(source)]).data["item_selections"][0]["source"] == source


@pytest.mark.parametrize("value", BAD_REFS)
def test_local_source_reference_uses_existing_canonical_uuid_validation(value):
    _invalid("save", item_selections=[_existing(_local_source(ref=value))])


@pytest.mark.parametrize("source,field", [(_pending(), "acquisition_ref"), (_retained(), "admission_ref")])
@pytest.mark.parametrize("value", BAD_REMOTE_REFS)
def test_draft_remote_source_refs_are_nonzero_canonical(source, field, value):
    _invalid("save", item_selections=[_existing({**source, field: value})])


@pytest.mark.parametrize("source", [_pending(), _retained()])
@pytest.mark.parametrize("value", BAD_VERSIONS)
def test_draft_remote_versions_are_exact_sha256(source, value):
    _invalid("save", item_selections=[_existing({**source, "evidence_version": value})])


@pytest.mark.parametrize("rows", [
    [_existing(_unselected()), _existing(_unselected(), album=OTHER)],
    [_existing(_unselected()), _existing(_unselected(), item=OTHER)],
    [_existing(_unselected()), _new_local()], [_new_local(), _new_local()],
    [_new_remote(), _new_remote()], [_new_remote(), _new_remote(_pending(version=OTHER_VERSION))],
    [_existing(_pending()), _new_remote()],
    [_existing(_retained()), _new_remote(_retained())],
    [_existing(_retained()), _new_remote(_retained(version=OTHER_VERSION))],
])
def test_draft_rejects_duplicate_item_album_or_remote_selector_even_across_row_kinds(rows):
    _invalid("save", item_selections=rows)


def test_draft_remote_reference_namespaces_require_transactional_identity_resolution():
    rows = [_existing(_unselected()), _new_remote(_pending(ALBUM)), _new_remote(_retained(ALBUM))]
    assert _normalize("save", item_selections=rows).data["item_selections"] == rows


@pytest.mark.parametrize("remote", [False, True])
def test_draft_exact_5000_member_bound_preserves_complete_order(remote):
    rows = [(_new_remote(_pending(str(UUID(int=index)))) if remote else
             _new_local(album=str(UUID(int=index)))) for index in range(1, 5001)]
    assert _normalize("save", item_selections=rows).data["item_selections"] == rows
    _invalid("save", item_selections=[*rows, _new_remote(_retained())])


@pytest.mark.parametrize("action", ["create", "add", "save"])
@pytest.mark.parametrize("field,value", [
    ("context_ref", VERSION), ("owner_account_id", 41), ("library_id", 7), ("session_id", 9),
    ("publication_intent", "private"), ("private_only", True), ("publishing", False),
    ("remote_allowed", True), ("provider", "musicbrainz"), ("facts", {}),
])
def test_typed_commands_cannot_supply_context_authority_or_silent_publication_downgrades(action, field, value):
    _invalid(action, **{field: value})


@pytest.mark.parametrize("action", ["create", "add", "save"])
@pytest.mark.parametrize("value", BAD_REFS)
def test_typed_commands_keep_canonical_request_keys(action, value):
    _invalid(action, request_key=value)


@pytest.mark.parametrize("action", ["create", "add", "save"])
def test_typed_commands_require_request_key_and_plain_payload(action):
    payload = _payload(action)
    del payload["request_key"]
    _invalid(action, payload)
    for value in (None, True, [], (), UserDict(_payload(action)), DictSubclass(_payload(action))):
        with pytest.raises(AlbumTopError, match="invalid_command"):
            normalize_top_command(action, value, top_ref=None if action == "create" else TOP)


@pytest.mark.parametrize("action", ["add", "save"])
@pytest.mark.parametrize("value", BAD_REFS)
def test_typed_existing_commands_require_canonical_destination_reference(action, value):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        normalize_top_command(action, _payload(action), top_ref=value)


@pytest.mark.parametrize("action", ["add", "save"])
def test_typed_existing_commands_require_revision_and_reject_create_only_draft_ref(action):
    payload = _payload(action)
    del payload["revision"]
    _invalid(action, payload)
    _invalid(action, draft_ref=DRAFT)


@pytest.mark.parametrize("action", ["create", "save"])
@pytest.mark.parametrize("value", [None, True, 1, [], {}, "", " \t\n ", "x" * 101,
                                  "bad\x00title", "\ud800", TextSubclass("Title")])
def test_typed_create_save_keep_existing_title_validation(action, value):
    _invalid(action, title=value)


@pytest.mark.parametrize("action", ["create", "save"])
@pytest.mark.parametrize("value", [None, True, 1, [], {}, "x" * 1001, "bad\x00description",
                                  "\udfff", TextSubclass("Description")])
def test_typed_create_save_keep_existing_description_validation(action, value):
    _invalid(action, description=value)


@pytest.mark.parametrize("action", ["create", "save"])
def test_typed_header_text_preserves_unicode_character_bounds(action):
    result = _normalize(action, title="  " + "Ω" * 100 + "  ", description="🎵" * 1000)
    assert result.data["title"] == "Ω" * 100
    assert result.data["description"] == "🎵" * 1000


@pytest.mark.parametrize("action", ["add", "save"])
@pytest.mark.parametrize("value", BAD_REVISIONS)
def test_typed_existing_commands_keep_strict_revision_validation(action, value):
    _invalid(action, revision=value)


@pytest.mark.parametrize("action", ["add", "save"])
@pytest.mark.parametrize("value", ["1", "9007199254740993", "9223372036854775807"])
def test_typed_existing_commands_preserve_bigint_revision_precision(action, value):
    assert _normalize(action, revision=value).data["revision"] == value


@pytest.mark.parametrize("value", BAD_VERSIONS)
def test_typed_save_keeps_existing_evidence_revision_validation(value):
    _invalid("save", evidence_revision=value)


@pytest.mark.parametrize("action", ["create", "add", "save"])
def test_typed_command_is_detached_from_input_lists_and_nested_dictionaries(action):
    payload = _payload(action)
    before = deepcopy(payload)
    result = _normalize(action, payload)
    normalized = deepcopy(result.data)
    digest = result.digest
    assert payload == before
    if action == "save":
        payload["item_selections"][0]["source"]["evidence_version"] = OTHER_VERSION
        payload["item_selections"].append(_new_local(album=OTHER))
    else:
        payload["selections"][-1]["evidence_version"] = OTHER_VERSION
        payload["selections"].append(_local(OTHER))
    assert result.data == normalized and result.digest == digest


@pytest.mark.parametrize("action", ["create", "add", "save"])
def test_typed_digest_ignores_only_dictionary_order_request_key_and_title_trimming(action):
    payload = _payload(action)
    first = _normalize(action, payload)
    equivalent = json.loads(json.dumps(payload, sort_keys=True, ensure_ascii=False))
    equivalent["request_key"] = OTHER
    if action == "create":
        equivalent["title"] = "Mixed Ω"
    assert first.digest == _normalize(action, equivalent).digest


def test_create_digest_binds_original_draft_order_remote_ref_and_version():
    payload = _payload("create")
    variants = [payload, {**payload, "draft_ref": OTHER},
        {**payload, "selections": list(reversed(payload["selections"]))},
        {**payload, "selections": [_local(), _pending(ref=OTHER)]},
        {**payload, "selections": [_local(), _pending(version=OTHER_VERSION)]},
        {**payload, "title": "Other"}, {**payload, "description": "Other"}]
    assert len({_normalize("create", value).digest for value in variants}) == len(variants)


def test_add_digest_binds_target_revision_order_and_every_remote_discriminator():
    payload = _payload("add")
    variants = [payload, {**payload, "revision": "8"},
        {**payload, "selections": list(reversed(payload["selections"]))},
        {**payload, "selections": [_local(OTHER), _pending(), _retained()]},
        {**payload, "selections": [_local(), _pending(ref=OTHER), _retained()]},
        {**payload, "selections": [_local(), _pending(version=OTHER_VERSION), _retained()]},
        {**payload, "selections": [_local(), _pending(), _retained(ref=OTHER)]},
        {**payload, "selections": [_local(), _pending(), _retained(version=OTHER_VERSION)]}]
    digests = {_normalize("add", value).digest for value in variants}
    digests.add(normalize_top_command("add", payload, top_ref=OTHER).digest)
    assert len(digests) == len(variants) + 1
    assert _normalize("add", selections=[_pending(ALBUM)]).digest != _normalize(
        "add", selections=[_retained(ALBUM)]).digest


def test_save_digest_binds_row_discriminators_item_album_source_identity_and_order():
    payload = _payload("save")
    variants = [payload, {**payload, "revision": "8"},
        {**payload, "item_selections": list(reversed(payload["item_selections"]))},
        {**payload, "item_selections": [_existing(item=OTHER), _new_remote()]},
        {**payload, "item_selections": [_existing(album=OTHER), _new_remote()]},
        {**payload, "item_selections": [_existing(_retained(version=OTHER_VERSION)), _new_remote()]},
        {**payload, "item_selections": [_existing(_retained(ref=OTHER)), _new_remote()]},
        {**payload, "item_selections": [_existing(), _new_remote(_pending(ref=OTHER))]},
        {**payload, "item_selections": [_existing(), _new_remote(_pending(version=OTHER_VERSION))]},
        {**payload, "evidence_revision": VERSION},
        {**payload, "title": "Other"}, {**payload, "description": "Other"}]
    assert len({_normalize("save", value).digest for value in variants}) == len(variants)
    assert _normalize("save", item_selections=[_existing(_unselected())]).digest != _normalize(
        "save", item_selections=[_new_local()]).digest
    digests = {_normalize("save", item_selections=[_existing(source)]).digest for source in
               [_unselected(), _local_source(), _local_source(local=13), _local_source(ref=OTHER),
                _pending(), _retained()]}
    assert len(digests) == 6


def test_new_typed_fields_do_not_expand_enable_external_or_publication_preview_wire():
    for items in ([], [_new_local()], [_new_remote()]):
        with pytest.raises(AlbumTopError, match="invalid_command"):
            normalize_top_command("enable_external", {"request_key": REQUEST, "revision": "7",
                "item_selections": items, "evidence_revision": VERSION}, top_ref=TOP)
        with pytest.raises(AlbumTopError, match="invalid_command"):
            normalize_top_publication_preview({"revision": "7", "item_selections": items})


@pytest.mark.parametrize("action", ["remove", "reorder", "delete", "copy", "revoke_external"])
@pytest.mark.parametrize("field,value", [("selections", [_pending()]), ("item_selections", []),
                                        ("draft_ref", DRAFT)])
def test_new_fields_remain_unavailable_on_unrelated_command_actions(action, field, value):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        normalize_top_command(action, {"request_key": REQUEST, "revision": "7", field: value}, top_ref=TOP)
