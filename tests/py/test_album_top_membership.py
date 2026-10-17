from __future__ import annotations

from copy import deepcopy
from itertools import permutations

import pytest

from music_app.services import album_top_membership as membership


REVISION = "opaque:structural/token-A"


def _record(membership_id, catalog_album_id, *, position=0, resolver="mock_catalog_v1"):
    return {
        "membership_id": membership_id,
        "catalog_album_id": catalog_album_id,
        "resolution_status": "resolved",
        "entity_kind": "album",
        "provenance": {
            "resolver": resolver,
            "record_id": "provider-record-shared-by-editions",
            "evidence": {"observations": ["resolved by catalog adapter"]},
        },
        "source": {
            "occurrence_id": f"occurrence:{membership_id}",
            "position": position,
            "rank": "1=",
            "evidence": {"lines": ["The Artist | Same Album | 2000"]},
        },
        "display": {"artist": "The Artist", "album": "Same Album", "year": 2000},
        "provider_refs": {"release_group_mbid": "same-provider-reference"},
        "local_media": {"album_id": 17, "track_ref": "synthetic/shared-path"},
    }


def _assert_failure(result, status, reason):
    assert result == {
        "status": status,
        "reason": reason,
        "members": None,
        "curator_order": None,
        "duplicates": [],
    }


def test_empty_append_is_a_valid_empty_snapshot():
    result = membership.append_resolved_albums(
        members=[], curator_order=[], incoming=[],
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result == {
        "status": "ok", "reason": "", "members": [],
        "curator_order": [], "duplicates": [],
    }


@pytest.mark.parametrize("resolver", ["mock_catalog_v1", "catalog_adapter_v1"])
def test_catalog_identity_is_independent_of_provenance_labels_and_local_availability(resolver):
    first = _record("entry-first", "catalog-opaque-A", position=7, resolver=resolver)
    duplicate = _record("entry-second", "catalog-opaque-A", position=2)
    duplicate["display"] = {"artist": "New label", "album": "Renamed", "year": None}
    duplicate["provider_refs"] = {"release_mbid": "another-provider-reference"}
    duplicate["local_media"] = {"album_id": None, "can_play_locally": False}
    duplicate["provenance"]["record_id"] = "different-resolution-record"
    incoming = [first, duplicate]
    before = deepcopy(incoming)

    result = membership.append_resolved_albums(
        members=[], curator_order=[], incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result == {
        "status": "ok", "reason": "", "members": [first],
        "curator_order": ["entry-first"],
        "duplicates": [{
            "incoming_index": 1, "occurrence": duplicate,
            "winner_membership_id": "entry-first", "winner_kind": "incoming",
            "winner_incoming_index": 0,
        }],
    }
    assert incoming == before


def test_distinct_catalog_ids_with_identical_labels_provider_refs_and_paths_stay_distinct():
    incoming = [
        _record("entry-edition-one", "catalog-edition-one", position=4),
        _record("entry-edition-two", "catalog-edition-two", position=4),
    ]

    result = membership.append_resolved_albums(
        members=[], curator_order=[], incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result["status"] == "ok"
    assert result["members"] == incoming
    assert result["curator_order"] == ["entry-edition-one", "entry-edition-two"]
    assert result["duplicates"] == []


@pytest.mark.parametrize("local_media", [None, {}, {"album_id": None, "can_play_locally": False}])
def test_resolved_nonlocal_album_remains_eligible_without_granting_media_authority(local_media):
    candidate = _record("entry-nonlocal", "catalog-nonlocal")
    candidate["local_media"] = deepcopy(local_media)
    candidate["authority"] = {"can_play": False, "actor": "synthetic-actor", "library": "synthetic-library"}
    candidate["provider_refs"] = {}

    result = membership.append_resolved_albums(
        members=[], curator_order=[], incoming=[candidate],
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result == {"status": "ok", "reason": "", "members": [candidate],
                      "curator_order": ["entry-nonlocal"], "duplicates": []}


@pytest.mark.parametrize("catalog_ids", [
    ["catalog:A", "catalog:a"],
    ["catalog:A", " catalog:A "],
    ["catalog:\u00e9", "catalog:e\u0301"],
])
def test_opaque_catalog_ids_are_not_text_normalized(catalog_ids):
    incoming = [_record("entry-one", catalog_ids[0]), _record("entry-two", catalog_ids[1])]

    result = membership.append_resolved_albums(
        members=[], curator_order=[], incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result["status"] == "ok"
    assert result["members"] == incoming
    assert result["duplicates"] == []


def test_every_duplicate_identifies_existing_or_first_incoming_winner_in_input_order():
    existing = _record("entry-existing", "catalog-existing", position=50)
    incoming = [
        _record("candidate-0", "catalog-new-A", position=9),
        _record("candidate-1", "catalog-existing", position=1),
        _record("candidate-2", "catalog-new-A", position=9),
        _record("candidate-3", "catalog-new-B", position=0),
        _record("candidate-4", "catalog-existing", position=4),
        _record("candidate-5", "catalog-new-B", position=8),
        _record("candidate-6", "catalog-new-A", position=2),
    ]

    result = membership.append_resolved_albums(
        members=[existing], curator_order=["entry-existing"], incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result["members"] == [existing, incoming[0], incoming[3]]
    assert result["curator_order"] == ["entry-existing", "candidate-0", "candidate-3"]
    assert result["duplicates"] == [
        {"incoming_index": index, "occurrence": incoming[index],
         "winner_membership_id": winner, "winner_kind": kind,
         "winner_incoming_index": winner_index}
        for index, winner, kind, winner_index in [
            (1, "entry-existing", "existing", None),
            (2, "candidate-0", "incoming", 0),
            (4, "entry-existing", "existing", None),
            (5, "candidate-3", "incoming", 3),
            (6, "candidate-0", "incoming", 0),
        ]
    ]


def test_append_preserves_curator_prefix_and_original_source_placement():
    members = [_record("entry-A", "catalog-A", position=8), _record("entry-B", "catalog-B", position=3)]
    incoming = [_record("entry-C", "catalog-C", position=20), _record("entry-D", "catalog-D", position=1)]
    incoming[0]["source"]["rank"] = {"printed": "tied first", "raw": [1, 1]}
    del incoming[1]["source"]["rank"]
    curator_order = ["entry-B", "entry-A"]
    before = deepcopy((members, curator_order, incoming))

    result = membership.append_resolved_albums(
        members=members, curator_order=curator_order, incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result["members"] == members + incoming
    assert result["curator_order"] == ["entry-B", "entry-A", "entry-C", "entry-D"]
    assert (members, curator_order, incoming) == before


@pytest.mark.parametrize("ordered_ids", list(permutations(["entry-A", "entry-B", "entry-C"])))
def test_every_exact_permutation_changes_only_curator_order(ordered_ids):
    members = [_record("entry-A", "catalog-A", position=7),
               _record("entry-B", "catalog-B", position=0),
               _record("entry-C", "catalog-C", position=7)]
    curator_order = ["entry-C", "entry-A", "entry-B"]
    requested = list(ordered_ids)
    before = deepcopy((members, curator_order, requested))

    result = membership.reorder_members(
        members=members, curator_order=curator_order, ordered_membership_ids=requested,
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result == {"status": "ok", "reason": "", "members": members,
                      "curator_order": requested, "duplicates": []}
    assert (members, curator_order, requested) == before


def test_empty_reorder_is_valid():
    result = membership.reorder_members(
        members=[], curator_order=[], ordered_membership_ids=[],
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result == {"status": "ok", "reason": "", "members": [],
                      "curator_order": [], "duplicates": []}


def test_membership_ids_are_separate_from_catalog_ids_and_preserved_exactly():
    members = [_record("entry", "catalog-A"), _record(" entry ", "catalog-B")]

    result = membership.reorder_members(
        members=members, curator_order=["entry", " entry "],
        ordered_membership_ids=[" entry ", "entry"],
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result["status"] == "ok"
    assert result["curator_order"] == [" entry ", "entry"]
    assert result["members"] == members


@pytest.mark.parametrize("requested", [
    [], ["entry-A"], ["entry-A", "entry-A"],
    ["entry-A", "foreign"], ["entry-A", "entry-B", "foreign"],
    ["catalog-A", "catalog-B"], ["ENTRY-A", "entry-B"],
    [" entry-A ", "entry-B"], ["entry-A", None], ["entry-A", ["entry-B"]],
    ("entry-A", "entry-B"), "entry-A,entry-B", None, {},
])
def test_reorder_rejects_missing_repeated_foreign_or_malformed_entry_ids(requested):
    members = [_record("entry-A", "catalog-A"), _record("entry-B", "catalog-B")]
    curator_order = ["entry-A", "entry-B"]
    before = deepcopy((members, curator_order, requested))

    result = membership.reorder_members(
        members=members, curator_order=curator_order, ordered_membership_ids=requested,
        current_revision=REVISION, expected_revision=REVISION,
    )

    _assert_failure(result, "invalid", "invalid_order")
    assert (members, curator_order, requested) == before


@pytest.mark.parametrize("operation", ["append", "reorder"])
@pytest.mark.parametrize("expected", ["older-token", "OPAQUE:structural/token-A", f" {REVISION} "])
def test_stale_revision_conflicts_without_inspecting_malformed_member_payloads(operation, expected):
    arguments = {"members": None, "curator_order": None,
                 "current_revision": REVISION, "expected_revision": expected}
    if operation == "append":
        result = membership.append_resolved_albums(**arguments, incoming=None)
    else:
        result = membership.reorder_members(**arguments, ordered_membership_ids=None)

    _assert_failure(result, "conflict", "revision_conflict")


@pytest.mark.parametrize("current,expected", [
    (None, None), ("", ""), (" ", " "), (1, 1), (True, True),
    ([], []), ({}, {}), (REVISION, None), (None, REVISION),
])
@pytest.mark.parametrize("operation", ["append", "reorder"])
def test_malformed_revision_precedes_conflict_and_payload_validation(operation, current, expected):
    arguments = {"members": None, "curator_order": None,
                 "current_revision": current, "expected_revision": expected}
    if operation == "append":
        result = membership.append_resolved_albums(**arguments, incoming=None)
    else:
        result = membership.reorder_members(**arguments, ordered_membership_ids=None)

    _assert_failure(result, "invalid", "invalid_revision")


@pytest.mark.parametrize("operation", ["append", "reorder"])
def test_matching_opaque_revisions_are_not_parsed_normalized_or_advanced(operation):
    token = "  no numeric revision protocol / \u03b1  "
    arguments = {"members": [], "curator_order": [],
                 "current_revision": token, "expected_revision": token}
    if operation == "append":
        result = membership.append_resolved_albums(**arguments, incoming=[])
    else:
        result = membership.reorder_members(**arguments, ordered_membership_ids=[])

    assert result == {"status": "ok", "reason": "", "members": [],
                      "curator_order": [], "duplicates": []}


@pytest.mark.parametrize("path,value", [
    (("membership_id",), None), (("membership_id",), " "),
    (("membership_id",), 1), (("catalog_album_id",), None),
    (("catalog_album_id",), ""), (("catalog_album_id",), " \t"),
    (("catalog_album_id",), 17), (("catalog_album_id",), True),
    (("resolution_status",), "unresolved"), (("resolution_status",), "ambiguous"),
    (("resolution_status",), "unsupported"), (("resolution_status",), True),
    (("entity_kind",), "song"), (("entity_kind",), "release_group"),
    (("provenance",), None), (("provenance",), {}),
    (("provenance", "resolver"), " "), (("provenance", "resolver"), True),
    (("provenance", "record_id"), ""), (("provenance", "record_id"), 1),
    (("source",), None), (("source",), {}),
    (("source", "occurrence_id"), ""), (("source", "occurrence_id"), 1),
    (("source", "position"), -1), (("source", "position"), True),
    (("source", "position"), 1.0), (("source", "position"), "0"),
])
@pytest.mark.parametrize("target", ["existing", "incoming"])
def test_invalid_resolved_record_never_uses_labels_provider_ids_or_media_as_fallback(path, value, target):
    invalid = _record("entry-invalid", "catalog-invalid")
    cursor = invalid
    for key in path[:-1]:
        cursor = cursor[key]
    cursor[path[-1]] = deepcopy(value)
    members = [invalid] if target == "existing" else []
    incoming = [] if target == "existing" else [_record("entry-valid", "catalog-valid"), invalid]
    order = ["entry-invalid"] if target == "existing" else []
    before = deepcopy((members, order, incoming))

    result = membership.append_resolved_albums(
        members=members, curator_order=order, incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    _assert_failure(result, "invalid", "invalid_members" if target == "existing" else "invalid_incoming")
    assert (members, order, incoming) == before


@pytest.mark.parametrize("field", [
    "membership_id", "catalog_album_id", "resolution_status", "entity_kind", "provenance", "source",
])
def test_missing_required_incoming_fields_reject_the_whole_batch(field):
    invalid = _record("entry-invalid", "catalog-invalid")
    del invalid[field]
    incoming = [_record("entry-first", "catalog-first"), invalid]
    before = deepcopy(incoming)

    result = membership.append_resolved_albums(
        members=[], curator_order=[], incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    _assert_failure(result, "invalid", "invalid_incoming")
    assert incoming == before


@pytest.mark.parametrize("invalid", [None, {}, (), "entries", [None], [[]], ["entry"]])
@pytest.mark.parametrize("target", ["existing", "incoming"])
def test_record_collections_require_lists_of_dictionaries(invalid, target):
    arguments = {"members": invalid if target == "existing" else [], "curator_order": [],
                 "incoming": [] if target == "existing" else invalid,
                 "current_revision": REVISION, "expected_revision": REVISION}
    before = deepcopy(arguments)

    result = membership.append_resolved_albums(**arguments)

    _assert_failure(result, "invalid", "invalid_members" if target == "existing" else "invalid_incoming")
    assert arguments == before


@pytest.mark.parametrize("duplicate_key", ["membership_id", "catalog_album_id"])
@pytest.mark.parametrize("operation", ["append", "reorder"])
def test_existing_duplicate_identity_is_invalid_before_curator_order(operation, duplicate_key):
    members = [_record("entry-A", "catalog-A"), _record("entry-B", "catalog-B")]
    members[1][duplicate_key] = members[0][duplicate_key]
    before = deepcopy(members)
    arguments = {"members": members, "curator_order": None,
                 "current_revision": REVISION, "expected_revision": REVISION}
    if operation == "append":
        result = membership.append_resolved_albums(**arguments, incoming=None)
    else:
        result = membership.reorder_members(**arguments, ordered_membership_ids=None)

    _assert_failure(result, "invalid", "invalid_members")
    assert members == before


@pytest.mark.parametrize("current_order", [None, (), "entry-A", [], ["foreign"], ["entry-A", "entry-A"]])
@pytest.mark.parametrize("operation", ["append", "reorder"])
def test_invalid_current_curator_order_precedes_operation_payload(operation, current_order):
    arguments = {"members": [_record("entry-A", "catalog-A")], "curator_order": current_order,
                 "current_revision": REVISION, "expected_revision": REVISION}
    if operation == "append":
        result = membership.append_resolved_albums(**arguments, incoming=None)
    else:
        result = membership.reorder_members(**arguments, ordered_membership_ids=None)

    _assert_failure(result, "invalid", "invalid_curator_order")


@pytest.mark.parametrize("collision,catalog_id", [
    ("existing", "catalog-existing"), ("existing", "catalog-new"),
    ("incoming", "catalog-first"), ("incoming", "catalog-new"),
])
def test_candidate_entry_id_collisions_are_invalid_even_for_catalog_duplicates(collision, catalog_id):
    existing = _record("entry-existing", "catalog-existing")
    first = _record("entry-first", "catalog-first")
    colliding_id = "entry-existing" if collision == "existing" else "entry-first"
    incoming = [first, _record(colliding_id, catalog_id)]
    before = deepcopy((existing, incoming))

    result = membership.append_resolved_albums(
        members=[existing], curator_order=["entry-existing"], incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    _assert_failure(result, "invalid", "invalid_incoming")
    assert (existing, incoming) == before


def test_invalid_late_occurrence_exposes_no_partial_members_or_duplicate_report():
    incoming = [_record("entry-first", "catalog-A"), _record("entry-duplicate", "catalog-A"),
                _record("entry-unresolved", "catalog-unresolved")]
    incoming[2]["resolution_status"] = "unresolved"
    incoming[2]["authority"] = {"role": "owner", "unlocked": True, "can_add": True}
    before = deepcopy(incoming)

    result = membership.append_resolved_albums(
        members=[], curator_order=[], incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    _assert_failure(result, "invalid", "invalid_incoming")
    assert incoming == before


@pytest.mark.parametrize("operation", ["append", "reorder"])
def test_stale_transition_preserves_all_caller_evidence(operation):
    members = [_record("entry-A", "catalog-A"), _record("entry-B", "catalog-B")]
    curator_order = ["entry-A", "entry-B"]
    incoming = [_record("entry-C", "catalog-C")]
    requested = ["entry-B", "entry-A"]
    before = deepcopy((members, curator_order, incoming, requested))
    arguments = {"members": members, "curator_order": curator_order,
                 "current_revision": REVISION, "expected_revision": "old"}
    if operation == "append":
        result = membership.append_resolved_albums(**arguments, incoming=incoming)
    else:
        result = membership.reorder_members(**arguments, ordered_membership_ids=requested)

    _assert_failure(result, "conflict", "revision_conflict")
    assert (members, curator_order, incoming, requested) == before


def test_append_snapshots_detach_nested_members_and_every_duplicate_occurrence():
    existing = _record("entry-existing", "catalog-existing")
    incoming = [_record("entry-first", "catalog-new"), _record("entry-duplicate", "catalog-new")]
    members, order = [existing], ["entry-existing"]
    before = deepcopy((members, order, incoming))

    result = membership.append_resolved_albums(
        members=members, curator_order=order, incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )
    captured = deepcopy(result)
    members[0]["source"]["evidence"]["lines"].append("later caller edit")
    incoming[0]["provenance"]["evidence"]["observations"].clear()
    incoming[1]["display"]["album"] = "caller changed duplicate"
    order.clear()
    assert result == captured

    members, order, incoming = deepcopy(before)
    result = membership.append_resolved_albums(
        members=members, curator_order=order, incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )
    result["members"][0]["source"]["evidence"]["lines"].clear()
    result["members"][1]["provenance"]["evidence"]["observations"].clear()
    result["duplicates"][0]["occurrence"]["display"]["album"] = "discarded draft"
    result["curator_order"].reverse()
    assert (members, order, incoming) == before


@pytest.mark.parametrize("operation", ["append", "reorder"])
def test_noop_results_are_fresh_nested_snapshots_and_discarding_them_writes_nothing(operation):
    members = [_record("entry-A", "catalog-A"), _record("entry-B", "catalog-B")]
    order = ["entry-B", "entry-A"]
    requested = list(order)
    before = deepcopy((members, order, requested))
    arguments = {"members": members, "curator_order": order,
                 "current_revision": REVISION, "expected_revision": REVISION}
    if operation == "append":
        result = membership.append_resolved_albums(**arguments, incoming=[])
    else:
        result = membership.reorder_members(**arguments, ordered_membership_ids=requested)

    assert result == {"status": "ok", "reason": "", "members": members,
                      "curator_order": order, "duplicates": []}
    result["members"][0]["source"]["rank"] = "edited draft rank"
    result["members"][1]["source"]["evidence"]["lines"].clear()
    result["members"][0]["provenance"]["evidence"]["observations"].clear()
    result["members"][1]["local_media"]["track_ref"] = None
    result["curator_order"].clear()
    assert (members, order, requested) == before


def test_successful_reorder_snapshot_survives_later_caller_edits():
    members = [_record("entry-A", "catalog-A"), _record("entry-B", "catalog-B")]
    order, requested = ["entry-A", "entry-B"], ["entry-B", "entry-A"]

    result = membership.reorder_members(
        members=members, curator_order=order, ordered_membership_ids=requested,
        current_revision=REVISION, expected_revision=REVISION,
    )
    captured = deepcopy(result)
    members[0]["source"]["evidence"]["lines"].clear()
    members[1]["provenance"]["record_id"] = "later resolution"
    members[1]["display"]["album"] = "later display"
    order.clear()
    requested.reverse()

    assert result == captured


@pytest.mark.parametrize("path,value", [
    (("membership_id",), None), (("membership_id",), " "),
    (("membership_id",), 1), (("catalog_album_id",), None),
    (("catalog_album_id",), ""), (("catalog_album_id",), " \t"),
    (("catalog_album_id",), 17), (("catalog_album_id",), True),
    (("resolution_status",), "unresolved"), (("resolution_status",), "ambiguous"),
    (("resolution_status",), "unsupported"), (("resolution_status",), True),
    (("entity_kind",), "song"), (("entity_kind",), "release_group"),
    (("provenance",), None), (("provenance",), {}),
    (("provenance", "resolver"), " "), (("provenance", "resolver"), True),
    (("provenance", "record_id"), ""), (("provenance", "record_id"), 1),
    (("source",), None), (("source",), {}),
    (("source", "occurrence_id"), ""), (("source", "occurrence_id"), 1),
    (("source", "position"), -1), (("source", "position"), True),
    (("source", "position"), 1.0), (("source", "position"), "0"),
])
def test_reorder_rejects_malformed_current_records_before_either_order(path, value):
    invalid = _record("entry-invalid", "catalog-invalid")
    cursor = invalid
    for key in path[:-1]:
        cursor = cursor[key]
    cursor[path[-1]] = deepcopy(value)
    arguments = {"members": [invalid], "curator_order": None,
                 "ordered_membership_ids": None,
                 "current_revision": REVISION, "expected_revision": REVISION}
    before = deepcopy(arguments)

    result = membership.reorder_members(**arguments)

    _assert_failure(result, "invalid", "invalid_members")
    assert arguments == before


@pytest.mark.parametrize("path", [
    ("membership_id",), ("catalog_album_id",), ("resolution_status",),
    ("entity_kind",), ("provenance",), ("source",),
    ("provenance", "resolver"), ("provenance", "record_id"),
    ("source", "occurrence_id"), ("source", "position"),
])
def test_reorder_rejects_missing_current_record_fields_before_either_order(path):
    invalid = _record("entry-invalid", "catalog-invalid")
    cursor = invalid
    for key in path[:-1]:
        cursor = cursor[key]
    del cursor[path[-1]]
    arguments = {"members": [invalid], "curator_order": None,
                 "ordered_membership_ids": None,
                 "current_revision": REVISION, "expected_revision": REVISION}
    before = deepcopy(arguments)

    result = membership.reorder_members(**arguments)

    _assert_failure(result, "invalid", "invalid_members")
    assert arguments == before


@pytest.mark.parametrize("invalid", [None, {}, (), "entries", [None], [[]], ["entry"]])
def test_reorder_requires_a_list_of_current_record_dictionaries_before_either_order(invalid):
    arguments = {"members": deepcopy(invalid), "curator_order": None,
                 "ordered_membership_ids": None,
                 "current_revision": REVISION, "expected_revision": REVISION}
    before = deepcopy(arguments)

    result = membership.reorder_members(**arguments)

    _assert_failure(result, "invalid", "invalid_members")
    assert arguments == before


@pytest.mark.parametrize("later_catalog_id", ["catalog-new", "catalog-existing"])
def test_discarded_catalog_duplicate_reserves_its_candidate_entry_id(later_catalog_id):
    members = [_record("entry-existing", "catalog-existing")]
    order = ["entry-existing"]
    incoming = [
        _record("entry-discarded", "catalog-existing"),
        _record("entry-discarded", later_catalog_id),
    ]
    before = deepcopy((members, order, incoming))

    result = membership.append_resolved_albums(
        members=members, curator_order=order, incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    _assert_failure(result, "invalid", "invalid_incoming")
    assert (members, order, incoming) == before


@pytest.mark.parametrize("winner_kind", ["existing", "incoming"])
def test_duplicate_nested_source_provenance_and_extra_snapshots_detach_both_directions(winner_kind):
    members = [_record("entry-existing", "catalog-existing")]
    order = ["entry-existing"]
    duplicate_catalog_id = "catalog-existing" if winner_kind == "existing" else "catalog-new"
    duplicate = _record("entry-duplicate", duplicate_catalog_id)
    duplicate["source"]["rank"] = {"printed": {"tokens": ["1="]}}
    duplicate["extra"] = {"annotations": {"labels": ["original annotation"]}}
    incoming = [_record("entry-first", "catalog-new"), duplicate]
    before = deepcopy((members, order, incoming))

    result = membership.append_resolved_albums(
        members=members, curator_order=order, incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )

    assert result == {
        "status": "ok", "reason": "", "members": [members[0], incoming[0]],
        "curator_order": ["entry-existing", "entry-first"],
        "duplicates": [{
            "incoming_index": 1, "occurrence": duplicate,
            "winner_membership_id": "entry-existing" if winner_kind == "existing" else "entry-first",
            "winner_kind": winner_kind,
            "winner_incoming_index": None if winner_kind == "existing" else 0,
        }],
    }
    assert (members, order, incoming) == before
    captured = deepcopy(result)
    incoming[1]["source"]["evidence"]["lines"].append("later caller source edit")
    incoming[1]["source"]["rank"]["printed"]["tokens"].append("caller rank edit")
    incoming[1]["provenance"]["evidence"]["observations"].append("caller provenance edit")
    incoming[1]["extra"]["annotations"]["labels"].append("caller annotation edit")
    assert result == captured

    members, order, incoming = deepcopy(before)
    result = membership.append_resolved_albums(
        members=members, curator_order=order, incoming=incoming,
        current_revision=REVISION, expected_revision=REVISION,
    )
    occurrence = result["duplicates"][0]["occurrence"]
    occurrence["source"]["evidence"]["lines"].clear()
    occurrence["source"]["rank"]["printed"]["tokens"].clear()
    occurrence["provenance"]["evidence"]["observations"].clear()
    occurrence["extra"]["annotations"]["labels"].clear()
    assert (members, order, incoming) == before


@pytest.mark.parametrize("path,value", [
    (("resolution_status",), "unresolved"), (("resolution_status",), "ambiguous"),
    (("resolution_status",), "unsupported"), (("entity_kind",), "song"),
    (("provenance",), None), (("provenance",), {}),
    (("provenance", "resolver"), " "), (("provenance", "record_id"), 1),
    (("source",), None), (("source",), {}),
    (("source", "occurrence_id"), ""), (("source", "position"), -1),
    (("source", "position"), True), (("source", "position"), 1.0),
])
@pytest.mark.parametrize("winner_kind", ["existing", "incoming"])
def test_malformed_catalog_duplicates_reject_entire_batch_without_mutation(path, value, winner_kind):
    duplicate_catalog_id = "catalog-existing" if winner_kind == "existing" else "catalog-new"
    invalid = _record("entry-invalid-duplicate", duplicate_catalog_id, position=3)
    invalid["extra"] = {"annotations": {"labels": ["retain rejected occurrence evidence"]}}
    cursor = invalid
    for key in path[:-1]:
        cursor = cursor[key]
    cursor[path[-1]] = deepcopy(value)
    arguments = {
        "members": [_record("entry-existing", "catalog-existing", position=8)],
        "curator_order": ["entry-existing"],
        "incoming": [
            _record("entry-first", "catalog-new", position=5),
            _record("entry-valid-duplicate", duplicate_catalog_id, position=1),
            invalid,
        ],
        "current_revision": REVISION,
        "expected_revision": REVISION,
    }
    before = deepcopy(arguments)

    result = membership.append_resolved_albums(**arguments)

    _assert_failure(result, "invalid", "invalid_incoming")
    assert arguments == before
