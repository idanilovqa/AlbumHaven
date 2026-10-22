"""Independent canonical request/descriptor cases and exact diagnostic budgets."""
from copy import deepcopy
from dataclasses import asdict
from uuid import UUID
import pytest
from music_app.services import sample_playlist_receipts as receipts
from music_app.services.owned_playlists import PlaylistError
from test_sample_playlist_receipts_live import options
from test_sample_playlist_receipt_boundaries import rehash
from test_library_mix_route_boundary import boundary
from test_sample_playlist_native_routes import body, spy, SAMPLE, REPRESENTATIVES


@pytest.mark.parametrize("field,tokens", [
    ("styles", ["genre-tag:Rock", "genre-tag:\ue000", "genre-tag:\U00010000"]),
    ("countries", ["musicbrainz-country:GB", "musicbrainz-country:xY"])])
@pytest.mark.parametrize("path", [SAMPLE, REPRESENTATIVES])
def test_canonical_json_arrays_dispatch_exact_frozenset_without_generic_route_widening(boundary, monkeypatch, field, tokens, path):
    calls = spy(monkeypatch, "capture" if path == SAMPLE else "representatives")
    payload = body(); payload["options"][field] = tokens
    if path == REPRESENTATIVES:
        payload = {k: v for k, v in payload.items() if k not in ("random_order", "request_key")}
    assert boundary.request("POST", path, payload=payload)[0] == 200
    assert getattr(calls[0][3]["options"], field) == frozenset(tokens)
    assert type(getattr(calls[0][3]["options"], field)) is frozenset


@pytest.mark.parametrize("field,prefix", [("styles", "genre-tag:"), ("countries", "musicbrainz-country:")])
@pytest.mark.parametrize("suffixes", [[], [""], ["a", "a"], ["b", "a"], [" x"], ["x "],
    ["\ud800"], ["\U00010000", "\ue000"]])
def test_noncanonical_route_arrays_stay_negative(boundary, monkeypatch, field, prefix, suffixes):
    calls = spy(monkeypatch, "capture"); payload = body()
    payload["options"][field] = [prefix + value for value in suffixes]
    assert boundary.request("POST", SAMPLE, payload=payload)[0] == 422
    assert calls == []


def test_request_encoder_sorts_frozensets_by_unicode_scalar_and_not_internal_set_iteration():
    value = receipts._request(str(UUID(int=1)), "1", options(styles=frozenset({
        "genre-tag:\U00010000", "genre-tag:\ue000", "genre-tag:É"})), None)
    assert value["options"]["styles"] == ["genre-tag:É", "genre-tag:\ue000", "genre-tag:\U00010000"]
    assert value["options"]["countries"] is None


def descriptor(count=1, active=("styles", "countries")):
    opts = asdict(options("random", **{field: frozenset({token}) for field, token in (
        ("styles", "genre-tag:Rock"), ("countries", "musicbrainz-country:GB")) if field in active}))
    for field in active:
        opts[field] = sorted(opts[field])
    facts = [{"track_id": i, "canonical_recording_id": None, "recording_evidence": None,
        "album_ref": f"inventory-album:1:{i}", "primary_artist_ref": None, "source_position": i - 1,
        "disc_number": 1, "track_number": 1, "duration_seconds": None, "styles": None, "countries": None,
        "inventory_digest": "a" * 64, "identity_evidence": {"mapping": None,
            "asserted_recording": None, "asserted_track_artist": None}} for i in range(1, count + 1)]
    reasons = ["missing_canonical_recording",
        *(["style_metadata_unknown"] if "styles" in active else []),
        *(["country_metadata_unknown"] if "countries" in active else [])]
    return rehash({"version": 1, "request": {"playlist_ref": str(UUID(int=10000)), "revision": "1",
        "options": opts, "random_order": []}, "membership_digest": "b" * 64,
        "facts": facts, "ranking": None, "result": {"track_ids": [], "entry_order": [],
            "random_order": [], "diagnostics": [], "group_counts": [[f"inventory-album:1:{i}", 0] for i in range(1, count + 1)]},
        "source_diagnostics": sorted([[i, reason] for i in range(1, count + 1) for reason in reasons])})


@pytest.mark.parametrize("active,maximum", [((), 5000), (("styles",), 10000), (("countries",), 10000),
    (("styles", "countries"), 15000)])
def test_exact_conditional_diagnostic_bound_and_one_over_before_deeper_validation(active, maximum):
    value = descriptor(5000, active)
    assert len(value["source_diagnostics"]) == maximum
    assert receipts._validate_descriptor_shape(value) is None
    value["source_diagnostics"].append(deepcopy(value["source_diagnostics"][-1]))
    with pytest.raises(PlaylistError, match="source_too_large"):
        receipts._validate_descriptor_shape(value)


@pytest.mark.parametrize("mutation", ["duplicate", "two_mapping", "two_style", "two_country", "foreign_track", "unknown_category", "inactive_category"])
def test_diagnostic_category_membership_uniqueness_is_checked_not_only_cardinality(mutation):
    value = descriptor(3); diagnostics = value["source_diagnostics"]
    if mutation == "duplicate": diagnostics.append(deepcopy(diagnostics[0]))
    if mutation == "two_mapping": diagnostics.append([1, "missing_provider_mapping"])
    if mutation == "two_style": diagnostics.append([1, "style_metadata_unresolved"])
    if mutation == "two_country": diagnostics.append([1, "country_metadata_unresolved"])
    if mutation == "foreign_track": diagnostics.append([4, "style_metadata_unknown"])
    if mutation == "unknown_category": diagnostics.append([1, "metadata_unknown"])
    if mutation == "inactive_category":
        value["request"]["options"]["styles"] = None
        rehash(value)
    diagnostics.sort()
    with pytest.raises(PlaylistError, match="source_changed"):
        receipts._validate_descriptor_shape(value)


@pytest.mark.parametrize("field,prefix", [("styles", "genre-tag:"), ("countries", "musicbrainz-country:")])
@pytest.mark.parametrize("count,accepted", [(5000, True), (5001, False)])
def test_request_option_identity_count_is_not_quota_maximum(field, prefix, count, accepted):
    opts = options(songs_per_group=100000, **{field: frozenset(prefix + f"{i:05}" for i in range(count))})
    if accepted:
        value = receipts._request(str(UUID(int=1)), "1", opts, None)
        assert len(value["options"][field]) == count and value["options"]["songs_per_group"] == 100000
    else:
        with pytest.raises((PlaylistError, ValueError)):
            receipts._request(str(UUID(int=1)), "1", opts, None)


@pytest.mark.parametrize("field,values", [
    ("countries", ["musicbrainz-country:DE", "musicbrainz-country:GB"]),
    ("countries", ["musicbrainz-country:GB", "musicbrainz-country:GB"]),
    ("countries", ["country:GB"]), ("styles", ["style:rock"]),
    ("styles", ["genre-tag:\U00010000", "genre-tag:\ue000"]),
    ("styles", ["genre-tag:Rock", "genre-tag:Rock"]),
])
def test_descriptor_fact_arrays_are_canonical_and_country_is_a_singleton(field, values):
    value = descriptor()
    value["facts"][0][field] = values
    value["source_diagnostics"] = [item for item in value["source_diagnostics"]
        if not item[1].startswith("country_" if field == "countries" else "style_")]
    rehash(value)
    with pytest.raises(PlaylistError, match="source_changed"):
        receipts._validate_descriptor_shape(value)


@pytest.mark.parametrize("maximum", [524288, 2097152])
def test_existing_request_descriptor_byte_gates_count_utf8_and_json_escaping(maximum):
    # '"' adds two encoded bytes, é adds two UTF-8 bytes. Independent exact JSON
    # string construction avoids treating Python character count as byte count.
    value = {"x": "é" * ((maximum - 8) // 2)}
    from sample_facet_support import encoded
    while len(encoded(value)) < maximum:
        value["x"] += "x"
    assert len(encoded(value)) == maximum
    receipts._json_bytes(value, maximum)
    value["x"] += '"'
    assert len(encoded(value)) == maximum + 2
    with pytest.raises(PlaylistError, match="source_too_large"):
        receipts._json_bytes(value, maximum)
