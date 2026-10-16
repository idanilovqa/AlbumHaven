"""Pure dormant Top acquisition contracts; no provider, database, or app setup."""
from collections import UserDict
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
from uuid import UUID

import pytest

from music_app.services.album_top_remote_sources import (
    RemoteTopAcquisitionCommand,
    RemoteTopDestination,
    evidence_from_row,
    normalize_pending_remote_selector,
    normalize_remote_acquisition,
    normalize_remote_destination,
    project_remote_summary,
    remote_context_ref,
)
from music_app.services.owned_album_tops import AlbumTopError, normalize_top_command
from music_app.services.remote_album_evidence import (
    ReleaseGroupEvidence,
    RemoteAlbumEvidenceError,
    project_release_group_evidence,
    release_group_facts_digest,
    validate_release_group_evidence,
)


REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
DRAFT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TOP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
ACQUISITION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
GROUP = "c9fdb94c-4975-4ed6-a96f-ef6d80bb7738"
ARTIST = "8e68819d-71be-4e7d-b41d-f1df81b01d3f"
ZERO = "00000000-0000-0000-0000-000000000000"
HEX = "0123456789abcdef" * 4
# Literal v1 JSON digest vectors, independently hashed without importing source.
BASIC_DIGEST = "d4ce75de701f27f3ccf4b05ba477b1300b6e9fe76c4bbe0988f9c7b34c30c3b2"
UNICODE_DIGEST = "84cf748001b84ae92c364d075cb13c69a69495efa5489551a82545098b741c85"
UNKNOWN_DATE_DIGEST = "13bb8a477f3401d790e3ca45f1d131b81ff02c276d71e1df00ec9a439bbcd875"
CREATE_DIGEST = "1a3377e6c4698113a877d363600341d8efd0cffffe571bb03e2d9b126ae45e91"
TOP_DIGEST = "b648668e46537e32bc7c6b8bb6ab87cfe996c54fce279ac02506b6539695d21b"
LOCAL_CREATE_DIGEST = "cf9ab7d1ce010780700370921b3d2e0601cdcb6d23feef7c09c524e2e42e2eeb"


class DictSubclass(dict):
    pass


class TextSubclass(str):
    pass


BAD_REFS = [None, True, False, 1, 1.0, "", ZERO, REQUEST.upper(),
            REQUEST.replace("-", ""), "{" + REQUEST + "}", "urn:uuid:" + REQUEST,
            " " + REQUEST, REQUEST + "\n", UUID(REQUEST), TextSubclass(REQUEST), [], {}]
BAD_REVISIONS = [None, True, False, 1, 1.0, "", "0", "-1", "+1", "01", "1.0",
                 "1e2", " 1", "1 ", "1\n", "١", "１", "9223372036854775808",
                 "9" * 100, TextSubclass("1"), [], {}]
BAD_DIGESTS = [None, True, 1, "", HEX.upper(), HEX[:-1], HEX + "0", HEX + "\n",
               " " + HEX, "g" * 64, TextSubclass(HEX), [], {}]


def _create_destination():
    return {"kind": "create", "draft_ref": DRAFT}


def _top_destination(revision="1"):
    return {"kind": "top", "top_ref": TOP, "revision": revision}


def _acquisition(destination=None):
    return {"request_key": REQUEST,
            "destination": _create_destination() if destination is None else destination,
            "release_group_id": GROUP}


def _selector():
    return {"kind": "remote_acquisition", "acquisition_ref": ACQUISITION,
            "evidence_version": HEX}


def _fields(**changes):
    return {"release_group_id": GROUP, "title": "Example Album",
            "artist_display": "Example Artist", "first_release_date": "2012-05-22",
            "primary_type": "Album", **changes}


def _facts(**changes):
    return ReleaseGroupEvidence(**{**_fields(), "digest": BASIC_DIGEST, **changes})


def _row(**changes):
    return {"provider": "musicbrainz", "entity_kind": "release-group", "external_id": GROUP,
            "title": "Example Album", "artist_display": "Example Artist",
            "first_release_date": "2012-05-22", "primary_type": "Album",
            "evidence_version": BASIC_DIGEST, **changes}


def _provider(**changes):
    return {"id": GROUP, "title": "Example Album", "first-release-date": "2012-05-22",
            "primary-type": "Album", "artist-credit": [
                {"name": "Example Artist", "joinphrase": "", "artist": {"id": ARTIST}}],
            **changes}


def _assert_top_error(call, code="invalid_command", status=422):
    with pytest.raises(AlbumTopError) as caught:
        call()
    assert caught.value.code == code
    assert caught.value.status_code == status


def _assert_unavailable(call):
    _assert_top_error(call, "remote_evidence_unavailable", 409)


def test_create_destination_is_a_stable_distinct_draft_and_detached_frozen_value():
    payload = _create_destination()
    result = normalize_remote_destination(payload)
    assert type(result) is RemoteTopDestination
    assert (result.kind, result.ref, result.revision) == ("create", DRAFT, None)
    assert result.payload() == payload
    payload["draft_ref"] = OTHER
    assert result.ref == DRAFT
    assert normalize_remote_destination(payload) != result
    exposed = result.payload()
    exposed["draft_ref"] = OTHER
    assert result.payload() == _create_destination()
    with pytest.raises(FrozenInstanceError):
        result.ref = OTHER


@pytest.mark.parametrize("revision", ["1", "9007199254740993", "9223372036854775807"])
def test_top_destination_retains_exact_revision_precision(revision):
    result = normalize_remote_destination(_top_destination(revision))
    assert (result.kind, result.ref, result.revision) == ("top", TOP, revision)
    assert result.payload() == _top_destination(revision)


@pytest.mark.parametrize("value", [None, True, [], (), "{}", UserDict(_create_destination()),
                                  DictSubclass(_create_destination()), {},
    {"kind": "create"}, {"draft_ref": DRAFT},
    {"kind": "create", "draft_ref": DRAFT, "revision": "1"},
    {"kind": "create", "draft_ref": DRAFT, "top_ref": TOP},
    {"kind": "top", "draft_ref": DRAFT}, {"kind": "top", "top_ref": TOP},
    {"kind": "top", "top_ref": TOP, "revision": "1", "draft_ref": DRAFT},
    {"kind": "create", "draft_ref": DRAFT, 1: "extra"},
])
def test_destination_requires_exact_plain_dict_discriminated_shape(value):
    _assert_top_error(lambda: normalize_remote_destination(value))


@pytest.mark.parametrize("kind", [None, True, False, 1, "", "CREATE", "Top", "create ",
                                   "top\n", "existingTop", [], {}])
@pytest.mark.parametrize("destination", [_create_destination(), _top_destination()])
def test_destination_rejects_unknown_kind(kind, destination):
    _assert_top_error(lambda: normalize_remote_destination({**destination, "kind": kind}))


@pytest.mark.parametrize("value", BAD_REFS)
@pytest.mark.parametrize("kind,field", [("create", "draft_ref"), ("top", "top_ref")])
def test_destination_rejects_noncanonical_and_zero_identifiers(value, kind, field):
    payload = _create_destination() if kind == "create" else _top_destination()
    payload[field] = value
    _assert_top_error(lambda: normalize_remote_destination(payload))


@pytest.mark.parametrize("value", BAD_REVISIONS)
def test_existing_top_requires_canonical_positive_bigint_decimal_revision(value):
    _assert_top_error(lambda: normalize_remote_destination(_top_destination(value)))


def test_acquisition_is_frozen_and_isolated_from_nested_inputs_and_output_payloads():
    payload = _acquisition()
    before = deepcopy(payload)
    command = normalize_remote_acquisition(payload)
    assert type(command) is RemoteTopAcquisitionCommand
    assert command.payload() == before == payload
    assert command.digest == CREATE_DIGEST
    payload["request_key"] = OTHER
    payload["release_group_id"] = ARTIST
    payload["destination"]["draft_ref"] = OTHER
    exposed = command.payload()
    exposed["destination"]["draft_ref"] = OTHER
    exposed["request_key"] = OTHER
    assert command.payload() == before
    assert command.digest == CREATE_DIGEST
    with pytest.raises(FrozenInstanceError):
        command.request_key = OTHER
    with pytest.raises(FrozenInstanceError):
        command.destination.ref = OTHER


def test_acquisition_digest_matches_literal_vector_for_precise_existing_top_revision():
    command = normalize_remote_acquisition(_acquisition(_top_destination("9007199254740993")))
    assert command.digest == TOP_DIGEST


def test_acquisition_digest_excludes_request_key_and_input_dictionary_order_only():
    first = normalize_remote_acquisition(_acquisition())
    second = normalize_remote_acquisition({"release_group_id": GROUP,
        "destination": {"draft_ref": DRAFT, "kind": "create"}, "request_key": OTHER})
    assert first.request_key != second.request_key
    assert first.digest == second.digest == CREATE_DIGEST


def test_acquisition_digest_binds_each_destination_and_identity_dimension():
    base = _acquisition()
    variants = [base,
        {**base, "destination": {"kind": "create", "draft_ref": OTHER}},
        {**base, "destination": {"kind": "top", "top_ref": DRAFT, "revision": "1"}},
        _acquisition(_top_destination()), _acquisition(_top_destination("2")),
        {**base, "release_group_id": ARTIST}]
    assert len({normalize_remote_acquisition(value).digest for value in variants}) == len(variants)


@pytest.mark.parametrize("value", [None, True, [], (), "{}", UserDict(_acquisition()),
                                  DictSubclass(_acquisition()), {}])
def test_acquisition_requires_exact_plain_dict(value):
    _assert_top_error(lambda: normalize_remote_acquisition(value))


@pytest.mark.parametrize("field", ["request_key", "destination", "release_group_id"])
def test_acquisition_requires_each_field(field):
    payload = _acquisition()
    del payload[field]
    _assert_top_error(lambda: normalize_remote_acquisition(payload))


@pytest.mark.parametrize("field,value", [
    ("actor_account_id", 41), ("owner_account_id", 41), ("library_id", 7),
    ("context_ref", HEX), ("session_id", 9), ("allowed_actions", ["library.album_tops.items.manage"]),
    ("title", "Browser title"), ("digest", HEX), ("evidence", _fields()),
    ("url", "https://example.invalid/release-group"), ("local_path", "/private/music"),
    ("top_ref", TOP), ("draft_ref", DRAFT), (1, "extra"),
])
def test_acquisition_rejects_browser_supplied_authority_facts_and_extra_fields(field, value):
    _assert_top_error(lambda: normalize_remote_acquisition({**_acquisition(), field: value}))


@pytest.mark.parametrize("value", BAD_REFS)
def test_acquisition_request_key_is_nonzero_canonical_uuid(value):
    _assert_top_error(lambda: normalize_remote_acquisition({**_acquisition(), "request_key": value}))


@pytest.mark.parametrize("value", BAD_REFS)
def test_acquisition_release_group_id_uses_existing_strict_identity_error(value):
    _assert_top_error(lambda: normalize_remote_acquisition({**_acquisition(), "release_group_id": value}),
                      "invalid_release_group_id")


@pytest.mark.parametrize("value", BAD_DIGESTS)
def test_context_reference_is_exact_lowercase_sha256_text(value):
    _assert_top_error(lambda: remote_context_ref(value))


def test_context_reference_accepts_exact_digest_without_implying_authority():
    assert remote_context_ref(HEX) == HEX
    assert remote_context_ref("0" * 64) == "0" * 64


def test_pending_remote_selector_is_typed_detached_and_has_no_display_facts():
    payload = _selector()
    result = normalize_pending_remote_selector(payload)
    assert result == payload
    assert result is not payload
    payload["acquisition_ref"] = OTHER
    assert result == _selector()


@pytest.mark.parametrize("value", [None, True, [], (), "{}", UserDict(_selector()),
                                  DictSubclass(_selector()), {},
    {"kind": "remote_acquisition", "acquisition_ref": ACQUISITION},
    {"kind": "remote_acquisition", "evidence_version": HEX},
    {"acquisition_ref": ACQUISITION, "evidence_version": HEX},
])
def test_pending_selector_requires_exact_plain_dict_and_all_fields(value):
    _assert_top_error(lambda: normalize_pending_remote_selector(value))


@pytest.mark.parametrize("field,value", [
    ("kind", "remote_summary"), ("kind", "local"), ("kind", "release_group"),
    ("kind", "REMOTE_ACQUISITION"), ("kind", None), ("kind", True), ("kind", []),
    ("release_group_id", GROUP), ("selected_local_album_id", 12), ("selected_source_ref", OTHER),
    ("album_ref", OTHER), ("owner_account_id", 41), ("title", "Forged title"),
    ("tracks", []), ("provider", "musicbrainz"), (1, "extra"),
])
def test_pending_selector_rejects_mixed_local_remote_and_fabricated_facts(field, value):
    _assert_top_error(lambda: normalize_pending_remote_selector({**_selector(), field: value}))


@pytest.mark.parametrize("value", BAD_REFS)
def test_pending_selector_reference_is_nonzero_canonical_uuid(value):
    _assert_top_error(lambda: normalize_pending_remote_selector({**_selector(), "acquisition_ref": value}))


@pytest.mark.parametrize("value", BAD_DIGESTS)
def test_pending_selector_requires_exact_evidence_version(value):
    _assert_top_error(lambda: normalize_pending_remote_selector({**_selector(), "evidence_version": value}))


def test_normalized_fact_digest_preserves_original_goals_compatible_v1_vector():
    assert release_group_facts_digest(**_fields()) == BASIC_DIGEST
    projected = project_release_group_evidence(_provider(), requested_id=GROUP)
    assert projected == _facts()
    assert projected.digest == BASIC_DIGEST
    assert validate_release_group_evidence(projected) is projected


def test_unicode_credit_join_phrases_partial_date_and_nullable_type_keep_exact_v1_digest():
    payload = _provider(title="青い Ω", **{"first-release-date": "2012-02", "primary-type": None,
        "artist-credit": [{"name": "Björk", "joinphrase": " feat. ", "artist": {"id": ARTIST}},
                          {"name": "Sigur Rós", "joinphrase": "", "artist": {"id": GROUP}}]})
    result = project_release_group_evidence(payload, requested_id=GROUP)
    assert (result.title, result.artist_display, result.first_release_date, result.primary_type) == (
        "青い Ω", "Björk feat. Sigur Rós", "2012-02", None)
    assert result.digest == UNICODE_DIGEST
    assert release_group_facts_digest(**_fields(title="青い Ω", artist_display="Björk feat. Sigur Rós",
        first_release_date="2012-02", primary_type=None)) == UNICODE_DIGEST
    assert validate_release_group_evidence(result) is result


@pytest.mark.parametrize("date", [None, ""])
def test_provider_unknown_date_normalizes_to_none_without_digest_drift(date):
    result = project_release_group_evidence(_provider(**{"first-release-date": date}), requested_id=GROUP)
    assert result.first_release_date is None and result.release_year is None
    assert result.digest == UNKNOWN_DATE_DIGEST
    assert release_group_facts_digest(**_fields(first_release_date=None)) == UNKNOWN_DATE_DIGEST


@pytest.mark.parametrize("date,year", [("2012", 2012), ("2012-02", 2012), ("2012-02-29", 2012)])
def test_valid_partial_dates_preserve_precision_across_projection_and_validation(date, year):
    result = project_release_group_evidence(_provider(**{"first-release-date": date}), requested_id=GROUP)
    assert result.first_release_date == date and result.release_year == year
    assert validate_release_group_evidence(result) is result
    assert release_group_facts_digest(**_fields(first_release_date=date)) == result.digest


@pytest.mark.parametrize("field,value", [
    ("release_group_id", ARTIST), ("title", "Another Album"), ("artist_display", "Another Artist"),
    ("first_release_date", "2012"), ("primary_type", None), ("primary_type", "EP"),
])
def test_each_normalized_fact_is_digest_bound_and_old_digest_cannot_cover_changed_facts(field, value):
    assert release_group_facts_digest(**_fields(**{field: value})) != BASIC_DIGEST
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_provider_metadata"):
        validate_release_group_evidence(replace(_facts(), **{field: value}))


def test_digest_binds_exact_unicode_and_whitespace_without_normalization():
    assert release_group_facts_digest(**_fields(title="é")) != release_group_facts_digest(**_fields(title="e\u0301"))
    assert release_group_facts_digest(**_fields(title=" Album ")) != release_group_facts_digest(**_fields(title="Album"))


@pytest.mark.parametrize("field,value", [
    ("title", None), ("title", True), ("title", ""), ("title", " \t"),
    ("title", "x" * 1001), ("title", "bad\x00title"), ("title", "bad\ntitle"),
    ("title", "bad\x7ftitle"), ("title", "\ud800"), ("title", TextSubclass("Album")),
    ("artist_display", None), ("artist_display", ""), ("artist_display", "x" * 1001),
    ("artist_display", "bad\nartist"), ("artist_display", "\udfff"),
    ("first_release_date", ""), ("first_release_date", True), ("first_release_date", 2012),
    ("first_release_date", "0000"), ("first_release_date", "2012-13"),
    ("first_release_date", "2012-02-30"), ("first_release_date", "2012-2"),
    ("first_release_date", "2012-01-01T00:00:00Z"), ("first_release_date", "2012\n"),
    ("primary_type", "Recording"), ("primary_type", "album"), ("primary_type", True),
    ("primary_type", 1), ("primary_type", []), ("primary_type", {}),
])
def test_normalized_facts_reject_invalid_or_unnormalized_fields(field, value):
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_provider_metadata"):
        release_group_facts_digest(**_fields(**{field: value}))
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_provider_metadata"):
        validate_release_group_evidence(replace(_facts(), **{field: value}))


@pytest.mark.parametrize("value", BAD_REFS)
def test_normalized_facts_reject_invalid_release_group_identity(value):
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_release_group_id"):
        release_group_facts_digest(**_fields(release_group_id=value))


@pytest.mark.parametrize("primary", [None, "Album", "Single", "EP", "Broadcast", "Other"])
def test_normalized_facts_accept_each_existing_primary_type(primary):
    digest = release_group_facts_digest(**_fields(primary_type=primary))
    value = replace(_facts(), primary_type=primary, digest=digest)
    assert validate_release_group_evidence(value) is value


def test_normalized_facts_keep_existing_unicode_character_bounds():
    fields = _fields(title="🎵" * 1000, artist_display="Ω" * 1000)
    digest = release_group_facts_digest(**fields)
    value = ReleaseGroupEvidence(**fields, digest=digest)
    assert validate_release_group_evidence(value) is value


@pytest.mark.parametrize("value", [None, True, {}, _fields(), UserDict(_fields()), "facts", []])
def test_evidence_validation_requires_the_exact_dataclass(value):
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_provider_metadata"):
        validate_release_group_evidence(value)


def test_evidence_validation_rejects_dataclass_subclasses():
    class EvidenceSubclass(ReleaseGroupEvidence):
        pass
    value = EvidenceSubclass(**_fields(), digest=BASIC_DIGEST)
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_provider_metadata"):
        validate_release_group_evidence(value)


@pytest.mark.parametrize("digest", [*BAD_DIGESTS, "0" * 64, BASIC_DIGEST.upper(),
                                    TextSubclass(BASIC_DIGEST), UNICODE_DIGEST])
def test_frozen_dataclass_construction_does_not_bypass_exact_digest_validation(digest):
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_provider_metadata"):
        validate_release_group_evidence(_facts(digest=digest))


def test_projected_evidence_is_detached_frozen_and_drops_unknown_provider_fields():
    payload = _provider(private_path="/not-retained", tracks=[], release_id=OTHER,
                        cover_art_archive={"artwork": True})
    result = project_release_group_evidence(payload, requested_id=GROUP)
    assert result == _facts()
    payload["title"] = "Changed"
    payload["artist-credit"][0]["name"] = "Changed"
    assert result == _facts()
    with pytest.raises(FrozenInstanceError):
        result.title = "Changed"


def test_stored_fact_projection_validates_and_detaches_exact_normalized_fields():
    row = _row(acquisition_ref=ACQUISITION, private_path="/ignored", tracks=[{"title": "Ignored"}])
    before = deepcopy(row)
    result = evidence_from_row(row)
    assert result == _facts() and row == before
    row["title"] = "Changed"
    assert result == _facts()
    assert validate_release_group_evidence(result) is result


@pytest.mark.parametrize("field", list(_row()))
def test_stored_fact_projection_refuses_missing_fields(field):
    row = _row()
    del row[field]
    _assert_unavailable(lambda: evidence_from_row(row))


@pytest.mark.parametrize("field,value", [
    ("provider", "MusicBrainz"), ("provider", "local"), ("provider", None),
    ("entity_kind", "release"), ("entity_kind", "recording"), ("entity_kind", None),
    ("external_id", ARTIST), ("external_id", ZERO), ("title", "Changed"),
    ("title", "x" * 1001), ("artist_display", "Changed"),
    ("first_release_date", ""), ("first_release_date", "2012-02-30"),
    ("first_release_date", "2012"), ("primary_type", "Single"),
    ("evidence_version", "0" * 64), ("evidence_version", BASIC_DIGEST.upper()),
])
def test_stored_fact_projection_maps_bad_provider_namespace_fields_or_digest_to_unavailable(field, value):
    _assert_unavailable(lambda: evidence_from_row(_row(**{field: value})))


@pytest.mark.parametrize("value", [None, True, 1, "row", [], ()])
def test_stored_fact_projection_rejects_nonrow_inputs_as_unavailable(value):
    _assert_unavailable(lambda: evidence_from_row(value))


def test_remote_summary_has_explicitly_unavailable_track_metadata_and_no_fabricated_media():
    result = project_remote_summary(_facts())
    assert result == {
        "source_kind": "remote_summary", "provider": "musicbrainz", "entity_kind": "release-group",
        "release_group_id": GROUP, "title": "Example Album", "artist_display": "Example Artist",
        "first_release_date": "2012-05-22", "primary_type": "Album",
        "metadata_coverage": "album_summary_only", "track_metadata_status": "unavailable", "track_count": None,
    }
    assert not {"tracks", "edition", "release_id", "local_album_id", "media_id", "artwork",
                "artwork_id", "selected_source_ref", "catalog_album_ref", "playback_url"} & result.keys()
    result["title"] = "Changed"
    assert project_remote_summary(_facts())["title"] == "Example Album"


def test_remote_summary_preserves_partial_date_and_null_primary_type_without_invention():
    fields = _fields(first_release_date="2012", primary_type=None)
    facts = ReleaseGroupEvidence(**fields, digest=release_group_facts_digest(**fields))
    result = project_remote_summary(facts)
    assert result["first_release_date"] == "2012" and result["primary_type"] is None
    assert result["track_count"] is None and "tracks" not in result


@pytest.mark.parametrize("value", [None, {}, _fields(), _facts(title="Changed"), _facts(digest="0" * 64),
                                  _facts(first_release_date=""), _facts(release_group_id=ZERO)])
def test_remote_summary_refuses_forged_or_invalid_facts(value):
    _assert_unavailable(lambda: project_remote_summary(value))


def test_legacy_local_only_create_shape_and_digest_remain_exact():
    command = normalize_top_command("create", {"request_key": REQUEST, "title": "  Local Ω  ",
        "description": "A note", "album_refs": [OTHER]})
    assert command.data == {"title": "Local Ω", "description": "A note", "album_refs": [OTHER]}
    assert command.top_ref is None
    assert command.digest == LOCAL_CREATE_DIGEST
