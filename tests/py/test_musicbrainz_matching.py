from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz" / "artist-search-cases.json")
    .read_text(encoding="utf-8")
)


def _match_artist(local_evidence, candidates):
    try:
        module = importlib.import_module("music_app.services.musicbrainz_matching")
    except ModuleNotFoundError:
        pytest.fail("MusicBrainz artist matcher is not implemented yet", pytrace=False)
    return module.match_artist(local_evidence, candidates)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["case"])
def test_approved_artist_matching_matrix(case):
    result = _match_artist(case["local_evidence"], case["candidates"])

    assert result["classification"] == case["expected_classification"]
    assert result.get("selected_mbid") == case.get("expected_mbid")
    assert [candidate["mbid"] for candidate in result["candidates"]] == case["expected_candidate_order"]


def test_name_only_and_first_result_order_never_authorize_a_match():
    candidates = [
        {"mbid": "00000000-0000-4000-8000-000000000002", "canonical_name": "Nightwish", "score": 100},
        {"mbid": "00000000-0000-4000-8000-000000000001", "canonical_name": "Nightwish", "score": 99},
    ]

    result = _match_artist({"name": "Nightwish", "release_credits": []}, candidates)

    assert result["classification"] == "ambiguous"
    assert result.get("selected_mbid") is None
    assert [candidate["mbid"] for candidate in result["candidates"]] == [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
    ]


def test_album_credit_evidence_disambiguates_homonyms():
    result = _match_artist(
        {"name": "Nightwish", "release_credits": [{"title": "Once", "credited_artist": "Nightwish"}]},
        [
            {"mbid": "00000000-0000-4000-8000-000000000002", "canonical_name": "Nightwish", "release_titles": ["Oceanborn"]},
            {"mbid": "00000000-0000-4000-8000-000000000001", "canonical_name": "Nightwish", "release_titles": ["Once"]},
        ],
    )

    assert result["classification"] == "matched"
    assert result["selected_mbid"] == "00000000-0000-4000-8000-000000000001"


def test_native_script_name_requires_matching_locale_evidence():
    result = _match_artist(
        {"name": "Kipelov", "locale": "ru", "release_credits": [{"title": "Реки времён", "credited_artist": "Кипелов"}]},
        [{
            "mbid": "00000000-0000-4000-8000-000000000001",
            "canonical_name": "Kipelov",
            "aliases": [
                {"name": "Кипелов", "locale": "ru", "primary": True},
                {"name": "Кіпєлов", "locale": "uk", "primary": True},
            ],
            "release_titles": ["Реки времён"],
        }],
    )

    assert result["classification"] == "matched"
    assert result["preferred_native_name"] == "Кипелов"


def test_missing_native_script_evidence_does_not_invent_or_block_identity():
    result = _match_artist(
        {"name": "Kipelov", "locale": "ru", "release_credits": [{"title": "Rivers of Time", "credited_artist": "Kipelov"}]},
        [{
            "mbid": "00000000-0000-4000-8000-000000000001",
            "canonical_name": "Kipelov",
            "aliases": [],
            "release_titles": ["Rivers of Time"],
        }],
    )

    assert result["classification"] == "matched"
    assert result["preferred_native_name"] is None


def test_embedded_mbid_still_rejects_contradictory_entity_and_release_evidence():
    result = _match_artist(
        {
            "name": "Blind Guardian",
            "artist_type": "Group",
            "embedded_mbid": "00000000-0000-4000-8000-000000000001",
            "release_credits": [{"title": "Nightfall in Middle-Earth", "credited_artist": "Blind Guardian"}],
        },
        [{
            "mbid": "00000000-0000-4000-8000-000000000001",
            "canonical_name": "Blind Guardian",
            "artist_type": "Person",
            "release_titles": ["Unrelated Solo Record"],
        }],
    )

    assert result["classification"] == "permanent_mismatch"
    assert result.get("selected_mbid") is None
    assert result["candidates"][0]["rejection_reasons"] == ["artist_type_conflict", "release_evidence_conflict"]
