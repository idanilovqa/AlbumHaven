from __future__ import annotations

from collections import UserDict
from copy import deepcopy
from dataclasses import replace
import hashlib
import json

import pytest

from music_app.services.album_top_catalog import ManualTopCatalog
from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.policy import PolicyContext, RequestOrigin


A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
C = "33333333-3333-4333-8333-333333333333"
D = "44444444-4444-4444-8444-444444444444"
V1_DIGEST = "f04a625f08adac035ebeda564db854118693e1cc88e5c5f05daf8edadea87af7"
V2_DIGEST = "6387456acb1830cce6a60e2bc66021b79c775f2349b6fb7d2c7851a6bd5fb56e"
V1 = "manual-catalog:sha256:" + V1_DIGEST
V2 = "manual-catalog:sha256:" + V2_DIGEST

# Literal reviewed UTF-8 evidence; no adapter output is used.
V1_JSON = (
    '[1,[["record-a",{"catalog_album_id":"11111111-1111-4111-8111-111111111111","display":{"artist":"Northern Example'
    '","notes":["catalog-only; no local media assertion"],"title":"Shared title Ω"},"entity_kind":"album","provenance'
    '":{"record_id":"source-a","resolver":"reviewed_mock_catalog"},"resolution_status":"resolved"}],["record-a-alt",{'
    '"catalog_album_id":"11111111-1111-4111-8111-111111111111","display":{"artist":"Northern Example","notes":["catal'
    'og-only; no local media assertion"],"title":"Explicit alternate source"},"entity_kind":"album","provenance":{"re'
    'cord_id":"source-a-alt","resolver":"reviewed_mock_catalog"},"resolution_status":"resolved"}],["record-ambiguous"'
    ',{"catalog_album_id":null,"display":{"artist":"Northern Example","notes":["catalog-only; no local media assertio'
    'n"],"title":"Ambiguous input"},"entity_kind":"album","provenance":{"record_id":"source-ambiguous","resolver":"re'
    'viewed_mock_catalog"},"resolution_status":"ambiguous"}],["record-b",{"catalog_album_id":"22222222-2222-4222-8222'
    '-222222222222","display":{"artist":"Northern Example","notes":["catalog-only; no local media assertion"],"title"'
    ':"Second album"},"entity_kind":"album","provenance":{"record_id":"source-b","resolver":"reviewed_mock_catalog"},'
    '"resolution_status":"resolved"}],["record-c",{"catalog_album_id":"33333333-3333-4333-8333-333333333333","display'
    '":{"artist":"Northern Example","notes":["catalog-only; no local media assertion"],"title":"Third album"},"entity'
    '_kind":"album","provenance":{"record_id":"source-c","resolver":"reviewed_mock_catalog"},"resolution_status":"res'
    'olved"}],["record-d",{"catalog_album_id":"44444444-4444-4444-8444-444444444444","display":{"artist":"Northern Ex'
    'ample","notes":["catalog-only; no local media assertion"],"title":"Shared title Ω"},"entity_kind":"album","prove'
    'nance":{"record_id":"source-d","resolver":"reviewed_mock_catalog"},"resolution_status":"resolved"}],["record-tra'
    'ck",{"catalog_album_id":"22222222-2222-4222-8222-222222222222","display":{"artist":"Northern Example","notes":["'
    'catalog-only; no local media assertion"],"title":"A recording, not an album"},"entity_kind":"track","provenance"'
    ':{"record_id":"source-track","resolver":"reviewed_mock_catalog"},"resolution_status":"resolved"}],["record-unres'
    'olved",{"catalog_album_id":null,"display":{"artist":"Northern Example","notes":["catalog-only; no local media as'
    'sertion"],"title":"Unresolved input"},"entity_kind":"album","provenance":{"record_id":"source-unresolved","resol'
    'ver":"reviewed_mock_catalog"},"resolution_status":"unresolved"}],["record-unsupported",{"catalog_album_id":null,'
    '"display":{"artist":"Northern Example","notes":["catalog-only; no local media assertion"],"title":"Unsupported i'
    'nput"},"entity_kind":"album","provenance":{"record_id":"source-unsupported","resolver":"reviewed_mock_catalog"},'
    '"resolution_status":"unsupported"}]]]'
)

V2_JSON = (
    '[1,[["record-a",{"catalog_album_id":"11111111-1111-4111-8111-111111111111","display":{"artist":"Northern Example'
    '","notes":["catalog-only; no local media assertion","enriched description"],"title":"Shared title Ω (catalog enr'
    'ichment)"},"entity_kind":"album","provenance":{"record_id":"source-a","resolver":"reviewed_mock_catalog"},"resol'
    'ution_status":"resolved"}],["record-a-alt",{"catalog_album_id":"11111111-1111-4111-8111-111111111111","display":'
    '{"artist":"Northern Example","notes":["catalog-only; no local media assertion"],"title":"Explicit alternate sour'
    'ce"},"entity_kind":"album","provenance":{"record_id":"source-a-alt","resolver":"reviewed_mock_catalog"},"resolut'
    'ion_status":"resolved"}],["record-ambiguous",{"catalog_album_id":null,"display":{"artist":"Northern Example","no'
    'tes":["catalog-only; no local media assertion"],"title":"Ambiguous input"},"entity_kind":"album","provenance":{"'
    'record_id":"source-ambiguous","resolver":"reviewed_mock_catalog"},"resolution_status":"ambiguous"}],["record-b",'
    '{"catalog_album_id":"22222222-2222-4222-8222-222222222222","display":{"artist":"Northern Example","notes":["cata'
    'log-only; no local media assertion"],"title":"Second album"},"entity_kind":"album","provenance":{"record_id":"so'
    'urce-b","resolver":"reviewed_mock_catalog"},"resolution_status":"resolved"}],["record-c",{"catalog_album_id":"33'
    '333333-3333-4333-8333-333333333333","display":{"artist":"Northern Example","notes":["catalog-only; no local medi'
    'a assertion"],"title":"Third album"},"entity_kind":"album","provenance":{"record_id":"source-c","resolver":"revi'
    'ewed_mock_catalog"},"resolution_status":"resolved"}],["record-d",{"catalog_album_id":"44444444-4444-4444-8444-44'
    '4444444444","display":{"artist":"Northern Example","notes":["catalog-only; no local media assertion"],"title":"S'
    'hared title Ω"},"entity_kind":"album","provenance":{"record_id":"source-d","resolver":"reviewed_mock_catalog"},"'
    'resolution_status":"resolved"}],["record-track",{"catalog_album_id":"22222222-2222-4222-8222-222222222222","disp'
    'lay":{"artist":"Northern Example","notes":["catalog-only; no local media assertion"],"title":"A recording, not a'
    'n album"},"entity_kind":"track","provenance":{"record_id":"source-track","resolver":"reviewed_mock_catalog"},"re'
    'solution_status":"resolved"}],["record-unresolved",{"catalog_album_id":null,"display":{"artist":"Northern Exampl'
    'e","notes":["catalog-only; no local media assertion"],"title":"Unresolved input"},"entity_kind":"album","provena'
    'nce":{"record_id":"source-unresolved","resolver":"reviewed_mock_catalog"},"resolution_status":"unresolved"}],["r'
    'ecord-unsupported",{"catalog_album_id":null,"display":{"artist":"Northern Example","notes":["catalog-only; no lo'
    'cal media assertion"],"title":"Unsupported input"},"entity_kind":"album","provenance":{"record_id":"source-unsup'
    'ported","resolver":"reviewed_mock_catalog"},"resolution_status":"unsupported"}]]]'
)


def _records(*, enriched=False):
    rows = (
        ("a", A, "Shared title Ω", "resolved", "album"),
        ("a-alt", A, "Explicit alternate source", "resolved", "album"),
        ("b", B, "Second album", "resolved", "album"),
        ("c", C, "Third album", "resolved", "album"),
        ("d", D, "Shared title Ω", "resolved", "album"),
        ("ambiguous", None, "Ambiguous input", "ambiguous", "album"),
        ("unresolved", None, "Unresolved input", "unresolved", "album"),
        ("unsupported", None, "Unsupported input", "unsupported", "album"),
        ("track", B, "A recording, not an album", "resolved", "track"),
    )
    records = {
        "record-" + ref: {
            "catalog_album_id": album_id,
            "resolution_status": status,
            "entity_kind": kind,
            "provenance": {"resolver": "reviewed_mock_catalog", "record_id": "source-" + ref},
            "display": {"title": title, "artist": "Northern Example", "notes": ["catalog-only; no local media assertion"]},
        }
        for ref, album_id, title, status, kind in rows
    }
    if enriched:
        records["record-a"]["display"]["title"] = "Shared title Ω (catalog enrichment)"
        records["record-a"]["display"]["notes"].append("enriched description")
    return records


def _canonical_bytes(records):
    # Test-owned encoding of configuration data, also checked against both literals.
    rows = [[ref, record] for ref, record in sorted(records.items())]
    return json.dumps([1, rows], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _config(records):
    ref = "manual-catalog:sha256:" + hashlib.sha256(_canonical_bytes(records)).hexdigest()
    return ref, {ref: {"records": records}}, _access(ref)


def _access(*refs, accounts=frozenset({41}), libraries=frozenset({7})):
    return {ref: {"account_ids": accounts, "library_ids": libraries} for ref in refs}


def _actor(**changes):
    return replace(
        CurrentActor(
            state=ActorState.ACTIVE,
            account_id=41,
            session_id=9,
            current_library_id=7,
            library_relationships=(LibraryRelationship(7, "member", False),),
        ),
        **changes,
    )


def _context(actor=None, **changes):
    # Direct native construction retains bad input types for admission tests.
    actor = _actor() if actor is None else actor
    return replace(
        PolicyContext(
            actor=actor,
            action="album_tops.create",
            resource=None,
            target_account_id=actor.account_id,
            library_id=actor.current_library_id,
            deployment_mode="self_hosted",
            request_origin=RequestOrigin("network", "catalog-test"),
            client_surface_class="private_web",
        ),
        **changes,
    )


def _expected(ref, selected):
    # Decode literal contract evidence, never the implementation's returned records.
    literal, digest = (V1_JSON, V1_DIGEST) if ref == V1 else (V2_JSON, V2_DIGEST)
    records = dict(json.loads(literal)[1])
    return {"status": "ok", "reason": "", "snapshot_ref": ref, "digest": digest,
            "records": [dict(record_ref=key, **deepcopy(records[key])) for key in selected]}


def _failure(status, reason):
    return {"status": status, "reason": reason, "snapshot_ref": None, "digest": None, "records": []}


EMPTY = {"status": "ok", "reason": "", "snapshot_ref": None, "digest": None, "records": []}
DENIED = _failure("denied", "catalog_access_denied")
INVALID = _failure("invalid", "invalid_selection")
UNAVAILABLE = _failure("unavailable", "catalog_version_unavailable")
UNRESOLVED = _failure("unresolved", "catalog_selection_unresolved")


@pytest.fixture(scope="module")
def catalog():
    return ManualTopCatalog(
        snapshots={V1: {"records": _records()}, V2: {"records": _records(enriched=True)}},
        access=_access(V1, V2),
    )


@pytest.fixture(scope="module")
def unit_catalog():
    return ManualTopCatalog(snapshots={V1: {"records": _records()}},
                            access=_access(V1, accounts=frozenset({1}), libraries=frozenset({1})))


def _unit_context():
    return _context(_actor(account_id=1, session_id=1, current_library_id=1,
                           library_relationships=(LibraryRelationship(1, "member", False),)))


@pytest.mark.parametrize("enriched,literal,digest", [(False, V1_JSON, V1_DIGEST), (True, V2_JSON, V2_DIGEST)])
def test_independent_catalog_encoding_vectors(enriched, literal, digest):
    assert _canonical_bytes(_records(enriched=enriched)) == literal.encode("utf-8")
    assert hashlib.sha256(literal.encode("utf-8")).hexdigest() == digest


def test_two_instances_preserve_explicit_aliases_and_same_title_distinction():
    selected = ["record-a", "record-b", "record-a-alt", "record-c", "record-d", "record-a"]
    expected = _expected(V1, selected)
    assert [record["catalog_album_id"] for record in expected["records"]] == [A, B, A, C, D, A]
    assert expected["records"][0]["display"] == expected["records"][4]["display"]
    for _ in range(2):
        owner = ManualTopCatalog(snapshots={V1: {"records": _records()}}, access=_access(V1))
        assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                              selected_record_refs=selected) == expected


def test_v1_stays_bound_while_v2_enriches_the_same_ids(catalog):
    selected = ["record-d", "record-a-alt", "record-a", "record-c", "record-b"]
    for ref in (V1, V2, V1):
        assert catalog.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                                selected_record_refs=selected) == _expected(ref, selected)
    fresh = ManualTopCatalog(snapshots={V1: {"records": _records()}}, access=_access(V1))
    assert fresh.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                          selected_record_refs=selected) == _expected(V1, selected)


def test_changed_v2_content_cannot_be_rebound_to_v1():
    with pytest.raises(ValueError):
        ManualTopCatalog(snapshots={V1: {"records": _records(enriched=True)}}, access=_access(V1))


def test_reordered_configuration_keys_keep_the_exact_v1_binding():
    records = {key: dict(reversed(list(record.items()))) for key, record in reversed(list(_records().items()))}
    owner = ManualTopCatalog(snapshots={V1: {"records": records}}, access=_access(V1))
    selected = ["record-c", "record-b", "record-a"]
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                          selected_record_refs=selected) == _expected(V1, selected)


def test_constructor_and_returned_nested_evidence_are_detached():
    records = _records()
    snapshots = {V1: {"records": records}}
    access = _access(V1)
    original_config = deepcopy((snapshots, access))
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    other = ManualTopCatalog(snapshots=deepcopy(snapshots), access=deepcopy(access))
    assert (snapshots, access) == original_config
    selected = ["record-a", "record-a", "record-a-alt"]
    result = owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1, selected_record_refs=selected)
    expected = _expected(V1, selected)
    assert result == expected
    assert (snapshots, access) == original_config
    result["records"][0]["display"]["notes"].append("returned mutation")
    result["records"][0]["provenance"]["record_id"] = "returned mutation"
    result["records"][0]["catalog_album_id"] = D
    assert result["records"][1:] == expected["records"][1:]
    result["records"][2]["display"]["title"] = "alias mutation"
    result["records"].clear()
    selected.append("record-missing")
    records["record-a"]["display"]["notes"].append("input mutation")
    records["record-a"]["provenance"]["resolver"] = "input mutation"
    records["record-a"]["catalog_album_id"] = D
    records.clear()
    snapshots.clear()
    access[V1]["account_ids"] = frozenset({42})
    access.clear()
    for reader in (owner, other):
        assert reader.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                               selected_record_refs=["record-a", "record-a", "record-a-alt"]) == expected


@pytest.mark.parametrize("title,artist", [(None, ""), ("", None), (" \t", "  artist Ω  ")])
def test_sparse_metadata_and_exact_opaque_strings_remain_eligible(title, artist):
    records = {"  café e\u0301  ": {"catalog_album_id": "  opaque Ω  ", "resolution_status": "resolved",
               "entity_kind": "album", "provenance": {"resolver": "  catalog Ω  ", "record_id": "source Ω"},
               "display": {"title": title, "artist": artist, "notes": ["", "  ", "e\u0301", "é", "😀"]}}}
    ref, snapshots, access = _config(records)
    selected = ["  café e\u0301  "]
    unknown = ["café é"]
    context = _context()
    expected = {
        "status": "ok", "reason": "", "snapshot_ref": ref, "digest": ref.rsplit(":", 1)[1],
        "records": [{"record_ref": "  café e\u0301  ", **deepcopy(records["  café e\u0301  "])}],
    }
    before = deepcopy((snapshots, access, selected, unknown, context))
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert (snapshots, access, selected, unknown, context) == before
    assert owner.resolve_manual_selection(context=context, catalog_snapshot_ref=ref,
                                          selected_record_refs=selected) == expected
    assert (snapshots, access, selected, unknown, context) == before
    assert owner.resolve_manual_selection(context=context, catalog_snapshot_ref=ref,
                                          selected_record_refs=unknown) == UNRESOLVED
    assert (snapshots, access, selected, unknown, context) == before


def test_source_access_can_change_without_changing_content_identity():
    selected = ["record-a"]
    context = _context(_actor(account_id=42, current_library_id=8,
                              library_relationships=(LibraryRelationship(8, "member", False),)))
    first = ManualTopCatalog(snapshots={V1: {"records": _records()}}, access=_access(V1))
    replacement = ManualTopCatalog(snapshots={V1: {"records": _records()}},
                                   access=_access(V1, accounts=frozenset({41, 42}), libraries=frozenset({7, 8})))
    assert first.resolve_manual_selection(context=context, catalog_snapshot_ref=V1, selected_record_refs=selected) == DENIED
    assert replacement.resolve_manual_selection(context=context, catalog_snapshot_ref=V1,
                                                selected_record_refs=selected) == _expected(V1, selected)


def test_canonically_equivalent_record_refs_remain_distinct_exact_keys():
    records = {"é": _records()["record-a"], "e\u0301": _records()["record-d"]}
    ref, snapshots, access = _config(records)
    selected = ["e\u0301", "é", "e\u0301"]
    context = _context()
    expected = {"status": "ok", "reason": "", "snapshot_ref": ref,
                "digest": ref.rsplit(":", 1)[1],
                "records": [{"record_ref": key, **deepcopy(records[key])} for key in selected]}
    before = deepcopy((snapshots, access, selected, context))
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert (snapshots, access, selected, context) == before
    result = owner.resolve_manual_selection(context=context, catalog_snapshot_ref=ref, selected_record_refs=selected)
    assert result == expected
    assert (snapshots, access, selected, context) == before
    assert [record["catalog_album_id"] for record in result["records"]] == [D, A, D]


def test_catalog_and_record_maps_may_be_empty():
    empty = ManualTopCatalog(snapshots={}, access={})
    assert empty.resolve_manual_selection(context=None, catalog_snapshot_ref=None, selected_record_refs=[]) == EMPTY
    assert empty.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                          selected_record_refs=["record-a"]) == UNAVAILABLE
    ref, snapshots, access = _config({})
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                          selected_record_refs=["record-a"]) == UNRESOLVED


def _assert_bad_configuration(snapshots, access):
    with pytest.raises(ValueError) as error:
        ManualTopCatalog(snapshots=snapshots, access=access)
    assert not isinstance(error.value, UnicodeError)


@pytest.mark.parametrize("bad", [None, [], (), UserDict()])
def test_constructor_requires_dictionary_snapshots(bad):
    _assert_bad_configuration(bad, {})


@pytest.mark.parametrize("bad", [None, [], (), UserDict(_access(V1)), {}, {V2: _access(V2)[V2]}, {**_access(V1), **_access(V2)}])
def test_access_map_requires_a_dictionary_with_exact_snapshot_coverage(bad):
    _assert_bad_configuration({V1: {"records": _records()}}, bad)


@pytest.mark.parametrize("bad", [None, [], {}, {"records": _records(), "private_path": "/private"}])
def test_snapshot_wrapper_has_only_records(bad):
    _assert_bad_configuration({V1: bad}, _access(V1))


@pytest.mark.parametrize("bad", [None, [], (), UserDict(_records())])
def test_records_must_be_a_dictionary(bad):
    _assert_bad_configuration({V1: {"records": bad}}, _access(V1))


@pytest.mark.parametrize("path", [(), ("provenance",), ("display",)])
def test_record_containers_do_not_accept_mapping_substitutes(path):
    records = _records()
    if not path:
        records["record-a"] = UserDict(records["record-a"])
    else:
        records["record-a"][path[0]] = UserDict(records["record-a"][path[0]])
    # If a substitute is coerced, the original V1 digest still matches its contents.
    _assert_bad_configuration({V1: {"records": records}}, _access(V1))


def test_snapshot_and_access_entries_do_not_accept_mapping_substitutes():
    _assert_bad_configuration({V1: UserDict({"records": _records()})}, _access(V1))
    _assert_bad_configuration({V1: {"records": _records()}}, {V1: UserDict(_access(V1)[V1])})


@pytest.mark.parametrize("ref", [None, True, 7, "", " \t", V1.upper(), "manual-catalog:sha256:" + "0" * 64, V1 + " ", V1 + "\ud800"])
def test_constructor_rejects_invalid_or_unbound_snapshot_references(ref):
    _assert_bad_configuration({ref: {"records": _records()}}, _access(ref))


@pytest.mark.parametrize("key", ["", " \t", 3, True, None])
def test_record_reference_keys_must_be_nonblank_exact_strings(key):
    # One key avoids mixed-type sorting errors in the independent encoder.
    _, snapshots, access = _config({key: _records()["record-a"]})
    _assert_bad_configuration(snapshots, access)


@pytest.mark.parametrize("path", [
    ("catalog_album_id",), ("resolution_status",), ("entity_kind",), ("provenance",), ("display",),
    ("provenance", "resolver"), ("provenance", "record_id"),
    ("display", "title"), ("display", "artist"), ("display", "notes"),
])
def test_every_record_and_nested_field_is_required(path):
    record = _records()["record-a"]
    parent = record if len(path) == 1 else record[path[0]]
    del parent[path[-1]]
    _, snapshots, access = _config({"record-a": record})
    _assert_bad_configuration(snapshots, access)


@pytest.mark.parametrize("path,key,value", [
    ((), "local_path", "/private/album"),
    (("provenance",), "import_body", "<private>"),
    (("display",), "raw_stream_url", "file:///private/track"),
])
def test_extra_record_fields_are_rejected_with_a_matching_digest(path, key, value):
    record = _records()["record-a"]
    parent = record if not path else record[path[0]]
    parent[key] = value
    _, snapshots, access = _config({"record-a": record})
    _assert_bad_configuration(snapshots, access)


@pytest.mark.parametrize("path,key,value", [
    ((), "local_path", "/private/album"),
    (("provenance",), "import_body", "<private>"),
    (("display",), "raw_stream_url", "file:///private/track"),
])
def test_extra_fields_cannot_be_filtered_into_valid_v1(path, key, value):
    records = _records()
    expected = _expected(V1, ["record-a"])
    invalid_records = deepcopy(records)
    parent = invalid_records["record-a"] if not path else invalid_records["record-a"][path[0]]
    parent[key] = value
    owner = ManualTopCatalog(snapshots={V1: {"records": records}}, access=_access(V1))
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                          selected_record_refs=["record-a"]) == expected
    # Dropping the sole extra field restores all V1 records and its literal digest.
    with pytest.raises(ValueError) as error:
        ManualTopCatalog(snapshots={V1: {"records": invalid_records}}, access=_access(V1))
    assert type(error.value) is ValueError


def test_missing_title_cannot_default_into_valid_empty_title():
    records = {"record-a": _records()["record-a"]}
    records["record-a"]["display"]["title"] = ""
    ref, snapshots, access = _config(records)
    assert ref == "manual-catalog:sha256:e2e8edbd130ac4966193f5214cf3e898e9a829801030127050ffc95e78182458"
    expected = {"status": "ok", "reason": "", "snapshot_ref": ref,
                "digest": ref.rsplit(":", 1)[1],
                "records": [{"record_ref": "record-a", **deepcopy(records["record-a"])}]}
    invalid_records = deepcopy(records)
    del invalid_records["record-a"]["display"]["title"]
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                          selected_record_refs=["record-a"]) == expected
    # Inserting an empty title would match this valid projection's exact reference.
    with pytest.raises(ValueError) as error:
        ManualTopCatalog(snapshots={ref: {"records": invalid_records}}, access=_access(ref))
    assert type(error.value) is ValueError


def test_numeric_catalog_id_cannot_coerce_into_valid_string_id():
    records = {"record-a": _records()["record-a"]}
    records["record-a"]["catalog_album_id"] = "7"
    ref, snapshots, access = _config(records)
    assert ref == "manual-catalog:sha256:c9a93153757aec470db6864390532bef215ebfbd5aa596c1f493132a6add7745"
    expected = {"status": "ok", "reason": "", "snapshot_ref": ref,
                "digest": ref.rsplit(":", 1)[1],
                "records": [{"record_ref": "record-a", **deepcopy(records["record-a"])}]}
    invalid_records = deepcopy(records)
    invalid_records["record-a"]["catalog_album_id"] = 7
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                          selected_record_refs=["record-a"]) == expected
    # Stringifying only the integer ID would match this valid projection's reference.
    with pytest.raises(ValueError) as error:
        ManualTopCatalog(snapshots={ref: {"records": invalid_records}}, access=_access(ref))
    assert type(error.value) is ValueError


def test_numeric_record_ref_cannot_coerce_into_valid_string_key():
    records = {"3": _records()["record-a"]}
    ref, snapshots, access = _config(records)
    assert ref == "manual-catalog:sha256:b5380e85116c3b5f94d29fe80c57195bb7c49ac13e7841b9d203447b116c1b22"
    expected = {"status": "ok", "reason": "", "snapshot_ref": ref,
                "digest": ref.rsplit(":", 1)[1],
                "records": [{"record_ref": "3", **deepcopy(records["3"])}]}
    invalid_records = {3: deepcopy(records["3"])}
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                          selected_record_refs=["3"]) == expected
    # Stringifying the sole numeric key would match this valid projection's reference.
    with pytest.raises(ValueError) as error:
        ManualTopCatalog(snapshots={ref: {"records": invalid_records}}, access=_access(ref))
    assert type(error.value) is ValueError


@pytest.mark.parametrize("path,bad", [
    ((), None), ((), []),
    (("catalog_album_id",), None), (("catalog_album_id",), ""), (("catalog_album_id",), " \t"),
    (("catalog_album_id",), 7), (("catalog_album_id",), True),
    (("resolution_status",), None), (("resolution_status",), True), (("resolution_status",), "Resolved"),
    (("resolution_status",), "other"),
    (("entity_kind",), None), (("entity_kind",), ""), (("entity_kind",), " \t"), (("entity_kind",), 7),
    (("provenance",), None), (("provenance",), []),
    (("provenance", "resolver"), ""), (("provenance", "resolver"), " \t"), (("provenance", "resolver"), None),
    (("provenance", "record_id"), ""), (("provenance", "record_id"), " \t"), (("provenance", "record_id"), 7),
    (("display",), None), (("display",), []),
    (("display", "title"), 7), (("display", "title"), True), (("display", "artist"), []),
    (("display", "notes"), None), (("display", "notes"), "note"), (("display", "notes"), ("note",)),
    (("display", "notes"), [None]), (("display", "notes"), [7]), (("display", "notes"), [True]),
    (("display", "notes"), [{}]), (("display", "notes"), [[]]),
])
def test_malformed_json_encodable_records_use_correct_content_digests(path, bad):
    record = _records()["record-a"]
    if not path:
        record = bad
    elif len(path) == 1:
        record[path[0]] = bad
    else:
        record[path[0]][path[1]] = bad
    _, snapshots, access = _config({"record-a": record})
    _assert_bad_configuration(snapshots, access)


@pytest.mark.parametrize("status", ["unresolved", "ambiguous", "unsupported"])
def test_nonresolved_status_requires_null_catalog_id(status):
    record = _records()["record-a"]
    record["resolution_status"] = status
    _, snapshots, access = _config({"record-a": record})
    _assert_bad_configuration(snapshots, access)


@pytest.mark.parametrize("path,bad", [
    (("catalog_album_id",), object()),
    (("provenance", "resolver"), b"reviewed_mock_catalog"),
    (("display", "notes"), {"not a list"}),
])
def test_non_json_leaf_values_fail_as_configuration_errors(path, bad):
    record = _records()["record-a"]
    parent = record if len(path) == 1 else record[path[0]]
    parent[path[-1]] = bad
    # These values have no canonical JSON encoding; reject before serialization.
    _assert_bad_configuration({V1: {"records": {"record-a": record}}}, _access(V1))


@pytest.mark.parametrize("path", [
    ("catalog_album_id",), ("resolution_status",), ("entity_kind",),
    ("provenance", "resolver"), ("provenance", "record_id"),
    ("display", "title"), ("display", "artist"), ("display", "notes"),
])
def test_configuration_strings_reject_unpaired_surrogates_without_encoder_errors(path):
    record = _records()["record-a"]
    parent = record if len(path) == 1 else record[path[0]]
    parent[path[-1]] = ["\udfff"] if path[-1] == "notes" else "bad\ud800"
    # Invalid UTF-8 has no canonical byte digest; shape validation must precede hashing.
    _assert_bad_configuration({V1: {"records": {"record-a": record}}}, _access(V1))


def test_record_reference_keys_reject_unpaired_surrogates():
    _assert_bad_configuration({V1: {"records": {"record-\ud800": _records()["record-a"]}}}, _access(V1))


def test_surrogate_title_cannot_bind_to_valid_repaired_content():
    records = {"record-a": _records()["record-a"]}
    records["record-a"]["display"]["title"] = "bad?"
    ref, snapshots, access = _config(records)
    assert ref == "manual-catalog:sha256:3fd3121c1bff397aa34c06034c6f550ccdb187887e3b4e268fd58a9e402db593"
    expected = {"status": "ok", "reason": "", "snapshot_ref": ref,
                "digest": ref.rsplit(":", 1)[1],
                "records": [{"record_ref": "record-a", **deepcopy(records["record-a"])}]}
    invalid_records = deepcopy(records)
    invalid_records["record-a"]["display"]["title"] = "bad\ud800"
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                          selected_record_refs=["record-a"]) == expected
    # Replacing the surrogate with '?' would match this ref and wrongly accept it.
    _assert_bad_configuration({ref: {"records": invalid_records}}, _access(ref))


@pytest.mark.parametrize("bad", [None, [], {}, {"account_ids": frozenset({41})}, {"library_ids": frozenset({7})},
                                 {**_access(V1)[V1], "is_admin": True}])
def test_access_entry_has_exact_required_fields(bad):
    _assert_bad_configuration({V1: {"records": _records()}}, {V1: bad})


@pytest.mark.parametrize("field", ["account_ids", "library_ids"])
@pytest.mark.parametrize("bad", [None, [], [1], {1}, (1,), frozenset(), frozenset({True}),
                                 frozenset({False}), frozenset({0}), frozenset({-1}),
                                 frozenset({"1"}), frozenset({1.0}), frozenset({None})])
def test_access_sets_require_nonempty_frozensets_of_positive_exact_integers(field, bad):
    access = _access(V1)
    access[V1][field] = bad
    _assert_bad_configuration({V1: {"records": _records()}}, access)


@pytest.mark.parametrize("selected", [None, "record-a", ("record-a",), {"record-a": True}, True, 7])
def test_selection_container_is_an_actual_list(catalog, selected):
    assert catalog.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                            selected_record_refs=selected) == INVALID


@pytest.mark.parametrize("bad", ["", " \t\n", None, True, 7, [], {}, "record-\ud800"])
def test_entire_selection_envelope_is_validated_before_a_prefix(catalog, bad):
    selected = ["record-a", bad]
    before = deepcopy(selected)
    assert catalog.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                            selected_record_refs=selected) == INVALID
    assert selected == before


@pytest.mark.parametrize("selected,ref", [
    ([], V1), ([], ""), ([], " \t"), ([], 7), ([], False), ([], []), ([], {}),
    (["record-a"], None), (["record-a"], ""), (["record-a"], " \t"),
    (["record-a"], True), (["record-a"], 7), (["record-a"], []), (["record-a"], {}),
    (["record-a"], "bad\ud800"),
])
def test_snapshot_and_selection_pair_is_validated(catalog, selected, ref):
    assert catalog.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                            selected_record_refs=selected) == INVALID


@pytest.mark.parametrize("context", [None, {}, object(), _context(CurrentActor.anonymous()), _context(_actor(state=ActorState.INACTIVE))])
def test_empty_null_selection_is_neutral_without_context_inspection(catalog, context):
    assert catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=None, selected_record_refs=[]) == EMPTY


@pytest.mark.parametrize("context", [None, {}, object(), replace(_context(), actor=None),
                                     replace(_context(), actor={"state": "active"}),
                                     _context(CurrentActor.anonymous()), _context(_actor(state=ActorState.INACTIVE)),
                                     _context(_actor(state="active"))])
def test_nonempty_read_requires_native_active_actor_context(catalog, context):
    assert catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1, selected_record_refs=["record-a"]) == DENIED


def test_minimum_positive_actor_and_scope_ids_are_admitted(unit_catalog):
    selected = ["record-a"]
    expected = _expected(V1, selected)
    assert unit_catalog.resolve_manual_selection(context=_unit_context(), catalog_snapshot_ref=V1,
                                                 selected_record_refs=selected) == expected


@pytest.mark.parametrize("field", ["account_id", "session_id", "current_library_id"])
@pytest.mark.parametrize("bad", [None, True, False, 0, -1, "1", 1.0])
def test_actor_scope_ids_require_positive_exact_integers(unit_catalog, field, bad):
    context = _unit_context()
    actor = replace(context.actor, **{field: bad})
    context = replace(context, actor=actor, target_account_id=None)
    assert unit_catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1, selected_record_refs=["record-a"]) == DENIED


@pytest.mark.parametrize("field,bad", [
    ("library_id", None), ("library_id", True), ("library_id", False), ("library_id", "1"),
    ("library_id", 1.0), ("library_id", 0), ("library_id", -1), ("library_id", 2),
    ("target_account_id", True), ("target_account_id", False), ("target_account_id", "1"),
    ("target_account_id", 1.0), ("target_account_id", 0), ("target_account_id", -1), ("target_account_id", 2),
])
def test_context_scope_requires_exact_matching_integers(unit_catalog, field, bad):
    context = replace(_unit_context(), **{field: bad})
    assert unit_catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1, selected_record_refs=["record-a"]) == DENIED


@pytest.mark.parametrize("relationship", [None, {"library_id": 1}, LibraryRelationship(2, "member", False),
                                         LibraryRelationship(True, "member", False), LibraryRelationship("1", "member", False),
                                         LibraryRelationship(1.0, "member", False)])
def test_relationship_must_be_native_and_match_an_exact_library_id(unit_catalog, relationship):
    context = _unit_context()
    context = replace(context, actor=replace(context.actor, library_relationships=(relationship,)))
    assert unit_catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1, selected_record_refs=["record-a"]) == DENIED


def test_missing_library_relationship_denies_even_for_bootstrap_and_direct_grants(catalog):
    actor = _actor(is_bootstrap_owner=True, library_relationships=(), capability_grants=(
        CapabilityGrant("album_tops.create", "global", None), CapabilityGrant("capability.admin", "global", None)))
    assert catalog.resolve_manual_selection(context=_context(actor), catalog_snapshot_ref=V1, selected_record_refs=["record-a"]) == DENIED


@pytest.mark.parametrize("accounts,libraries", [(frozenset({42}), frozenset({7})), (frozenset({41}), frozenset({8}))])
def test_source_access_requires_both_sets_even_for_bootstrap_and_grants(accounts, libraries):
    owner = ManualTopCatalog(snapshots={V1: {"records": _records()}}, access=_access(V1, accounts=accounts, libraries=libraries))
    actor = _actor(is_bootstrap_owner=True, capability_grants=(CapabilityGrant("album_tops.create", "global", None),))
    assert owner.resolve_manual_selection(context=_context(actor), catalog_snapshot_ref=V1, selected_record_refs=["record-a"]) == DENIED


@pytest.mark.parametrize("target", [None, 41])
def test_source_read_needs_no_create_or_media_grant(catalog, target):
    actor = _actor(library_relationships=(LibraryRelationship(8, "owner", True),
                                        LibraryRelationship(7, "viewer", False)))
    context = _context(actor, target_account_id=target, action="album_tops.preview")
    before = deepcopy(context)
    assert context.actor.capability_grants == ()
    assert catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1,
                                            selected_record_refs=["record-a"]) == _expected(V1, ["record-a"])
    assert context == before
    assert context.actor.capability_grants == ()


@pytest.mark.parametrize("missing", ["not-a-content-bound-reference", "manual-catalog:sha256:" + "0" * 64, V1 + " "])
def test_exact_unknown_version_never_falls_forward(catalog, missing):
    assert catalog.resolve_manual_selection(context=_context(), catalog_snapshot_ref=missing,
                                            selected_record_refs=["record-a"]) == UNAVAILABLE


def test_v2_only_owner_cannot_satisfy_v1_request():
    owner = ManualTopCatalog(snapshots={V2: {"records": _records(enriched=True)}}, access=_access(V2))
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=V1,
                                          selected_record_refs=["record-a"]) == UNAVAILABLE


@pytest.mark.parametrize("bad", ["record-missing", "record-ambiguous", "record-unresolved", "record-unsupported", "record-track"])
def test_invalid_final_record_denies_whole_selection_without_mutating_caller(catalog, bad):
    selected = ["record-a", "record-b", bad]
    context = _context()
    before = deepcopy((selected, context))
    assert catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1, selected_record_refs=selected) == UNRESOLVED
    assert (selected, context) == before
    assert catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1,
                                            selected_record_refs=["record-a", "record-b"]) == _expected(V1, ["record-a", "record-b"])


@pytest.mark.parametrize("kind", ["Album", " album ", "artist", "future_entity"])
def test_every_non_album_entity_is_configurable_but_not_admitted(kind):
    records = _records()
    records["record-b"]["entity_kind"] = kind
    ref, snapshots, access = _config(records)
    owner = ManualTopCatalog(snapshots=snapshots, access=access)
    assert owner.resolve_manual_selection(context=_context(), catalog_snapshot_ref=ref,
                                          selected_record_refs=["record-a", "record-b"]) == UNRESOLVED


@pytest.mark.parametrize("selected,ref,context,expected", [
    (["record-a", None], V1, _context(CurrentActor.anonymous()), INVALID),
    (["record-a", None], "unknown", _context(), INVALID),
    (["record-a"], "bad\ud800", _context(CurrentActor.anonymous()), INVALID),
    ([], None, _context(CurrentActor.anonymous()), EMPTY),
    (["record-a"], "unknown", _context(CurrentActor.anonymous()), DENIED),
    (["record-missing"], "unknown", _context(), UNAVAILABLE),
])
def test_pairwise_selection_context_and_version_precedence(catalog, selected, ref, context, expected):
    assert catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=ref, selected_record_refs=selected) == expected


@pytest.mark.parametrize("selected", [["record-a"], ["record-missing"], ["record-a", "record-unresolved"]])
def test_known_inaccessible_version_does_not_disclose_record_existence(catalog, selected):
    context = _context(_actor(account_id=42))
    assert catalog.resolve_manual_selection(context=context, catalog_snapshot_ref=V1, selected_record_refs=selected) == DENIED
