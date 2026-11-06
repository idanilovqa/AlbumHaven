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


MBID = "00000000-0000-4000-8000-000000000001"


@pytest.mark.parametrize("evidence", [
    {},
    {"embedded_mbid": MBID},
    {"existing_assertion_mbid": MBID, "existing_assertion_confidence": "high_confidence"},
    {"asserted_mbid": MBID, "assertion_confidence": "trusted"},
    {"existing_assertion": {"mbid": MBID, "confidence": "high"}},
], ids=["search", "file-tag", "stored-assertion", "asserted", "assertion-object"])
@pytest.mark.parametrize("release_titles", [[], ["Unrelated Solo Record"]], ids=["no-albums", "other-albums"])
def test_no_evidence_source_assigns_an_mbid_without_album_agreement(evidence, release_titles):
    """The single named candidate carries the asserted MBID; without album
    agreement no source, file tags included, may match it."""
    result = _match_artist(
        {
            "name": "Blind Guardian",
            "release_credits": [{"title": "Nightfall in Middle-Earth", "credited_artist": "Blind Guardian"}],
            **evidence,
        },
        [{"mbid": MBID, "canonical_name": "Blind Guardian", "release_titles": release_titles}],
    )

    assert result["classification"] != "matched"
    assert result.get("selected_mbid") is None
