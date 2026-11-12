"""Matcher rules from the owner's fourth Delivery 1 review (2026-11-09), one replayed
artist per rule, each the clearest example the owner named, with a negative case.

The fixture holds each artist's local albums and the local MusicBrainz mirror's answers,
recorded and trimmed to the fields the resolver reads. Any request the fixture lacks
fails the test, so a retrieval change cannot silently skip evidence. Title forms,
mojibake, lengths and evidence levels are covered rule by rule in
test_musicbrainz_matching.py; a person and their band in test_musicbrainz_resolve_artist.py
and the Alice Cooper case in test_musicbrainz_owner_review_cases.py.
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

import pytest

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_enrichment import resolve_artist

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz" / "owner-review-4-mirror.json")
    .read_text(encoding="utf-8")
)
OK = {"status": "network", "http_status": 200, "cache_hit": False}
CASES = {case["case"]: case for case in FIXTURE["cases"]}

# rule -> (artist, MBID its albums must prove)
MATCHES = {
    "a release's own title inside the group (a re-release under the band's name)":
        ("Memories Of Machines", "d58c83ac-e74a-4966-b6df-0d3b050e0667"),
    "a partial title with a certain tracklist":
        ("Il Castello Di Atlante", "5df152c7-7885-4403-80ae-8c75ce76b3bd"),
    "an 'aka' alternative title in the group comment":
        ("Celeste", "6ad4d115-3c35-4fff-b288-c78de3aafbd5"),
    "a parenthesised alternative name in the group comment":
        ("Prazsky Vyber", "a826967b-88e5-4475-b4ff-fdb0765cfa68"),
    "a bracketed original-script title":
        ("仙台貨物", "56bcb913-c172-45ef-b5cb-3e801ef60120"),
    "one title in two scripts":
        ("잠비나이", "74c9db5a-cece-4381-afa8-a5f381901487"),
    "a bounded typo with the tracklist bar":
        ("Toy Matinee", "85c16ec5-e905-4275-8bc3-337c9891d3ca"),
    "a tag read with the wrong code page":
        ("Korai Цrцm", "9601853b-720d-459a-8b7e-22a99213a6bb"),
    "the next title-matching group when the first one's tracks differ":
        ("The Miles Davis Quintet", "fe7245e7-d734-4ca1-8e26-691883f58201"),
    "a split release co-credited with another band, found by its tracks":
        ("Amestigon", "c8887bd4-e36d-4056-aff0-6265890a0680"),
    "a release matched by every track title and length":
        ("ServAnteS", "454a4d71-badf-4a61-adf6-4052aa180698"),
}
# rule -> (artist, the evidence summary must contain)
LEFT_TO_THE_USER = {
    "an artist without releases says so":
        ("Antehero", "lists no releases"),
    "an artist whose releases do not match is not called empty":
        ("Jon Durant", "none of your albums confirm it"),
    "a tracklist that only partly agrees stays a suggestion":
        ("Vultress", ""),
    "lengths that differ track by track are never a match (7:40 against 3:00)":
        ("Diatom", ""),
}


def _client():
    def get_json(url, _user_agent, **_kwargs):
        parsed = urlparse(url)
        key = parsed.path.replace("/ws/2", "") + "?" + parsed.query
        assert key in FIXTURE["responses"], f"unrecorded mirror request {key}"
        payload = FIXTURE["responses"][key]
        if isinstance(payload, dict) and "__status__" in payload:
            return None, {"status": "network", "http_status": payload["__status__"], "cache_hit": False}
        return payload, OK

    return MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)


def test_fixture_holds_exactly_the_rule_examples():
    assert set(CASES) == {artist for artist, _ in [*MATCHES.values(), *LEFT_TO_THE_USER.values()]}


@pytest.mark.parametrize("rule", sorted(MATCHES))
def test_album_evidence_rule_matches_the_owner_named_artist(rule):
    artist, mbid = MATCHES[rule]
    outcome = resolve_artist(CASES[artist]["context"], client=_client())

    assert outcome["classification"] == "found", outcome.get("evidence_summary")
    assert outcome["artist"]["mbid"] == mbid


@pytest.mark.parametrize("rule", sorted(LEFT_TO_THE_USER))
def test_weak_evidence_is_left_to_the_user_with_a_suggestion(rule):
    artist, wording = LEFT_TO_THE_USER[rule]
    outcome = resolve_artist(CASES[artist]["context"], client=_client())

    assert outcome["classification"] in {"unconfirmed", "ambiguous"}
    assert outcome["candidates"], "the suggested artist stays visible"
    assert wording in outcome["evidence_summary"]
