"""The owner's named artists from the second Delivery 1 review, replayed offline.

The fixture holds each artist's local albums (titles, years, track titles and
durations) and the local MusicBrainz mirror's answers, recorded and trimmed to
the fields the resolver reads. Any request the fixture lacks fails the test, so
a retrieval change cannot silently skip evidence.
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

import pytest

from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_enrichment import resolve_artist

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz" / "owner-review-2-mirror.json")
    .read_text(encoding="utf-8")
)
OK = {"status": "network", "http_status": 200, "cache_hit": False}

MATCHED = {
    "10cc": "f37c537b-3557-4031-bfd6-ab63ced32854",
    "10cc / 10cc": "f37c537b-3557-4031-bfd6-ab63ced32854",     # a repeated tag value
    "A Helmet of Gnats": "e918f4f6-5c3a-401a-9e77-5eff8bb3cfe2",
    "The Blue Öyster Cult": "c7423e0c-ab3e-4ab4-be10-cdff5a9d3062",
    "The Dial": "d0bd1f58-87c3-414c-aae6-3db983c282b3",
    "Mothers of Invention": "fe98e268-4ddd-441b-95a0-b219375f9ae4",
    "Constantine": "32f1d5d7-f236-49cb-96e9-662efc3c6fbd",          # local "Cønstantine"
    "Jannick Top": "d37d0870-f6cc-4f17-8d84-353429665794",
    "Punky Bruster": "4448068c-b961-4a0c-b650-304eda2718b8",
    "Zabranjeno Pusenje": "2d894992-3b83-4718-9df9-2a48323b1967",
    "Also Eden": "5f0ac37c-0c9a-4354-a721-4d7616390b4e",            # "[REDACTED]"
    "Dominici": "f7a459bc-e22a-46bb-9b16-12c94aa8f71f",             # "O3 A Trillogy"
    "Shadowland": "b3fd6f66-a24e-4336-9fdd-2fa249de6d3b",
    "Walrus": "b939eecf-d452-4685-a026-c11a5228d950",              # three self-titled "Walrus"
    "Alice Cooper": "ee58c59f-8e7f-4430-b8ca-236c4d3745ae",        # the singer, 20 albums to 7
    "Dragonfly": "d73fdcaf-bbe1-4a2c-b2ed-7a54606b7c16",           # "Génesis" and "Genesis"
    "Agamemnon": "ebc4aca8-5cb3-4d52-b781-542a0565b268",           # band name in the title
    "3 Crows": "3ef2dc4b-b3a9-4453-85db-3054d3ec0e5d",             # credited "3 Crows" on Chris Buck
    "A & Z": "67e87297-3f15-4904-ac62-d7e30c6bacfb",               # "A-Z"
    "Yaruga": "4b85a5c7-6c87-45b4-bf4f-afc38b51a5c8",              # local "ЯRuGa"
    "Dimitris Mystakidis": "ca9e03bb-1008-44ef-955f-60f4b4da0208", # "Morso" and "Μόρσο"
}
# Never accepted, each with the artist the owner is asked to confirm.
UNCONFIRMED = {
    "Alan Parsons Project": "Alan Parsons",          # "The Secret" is his solo album
    "Devin Townsend Project": "Devin Townsend Project",  # box-set discs, not release groups
    "Eric Mongrain": "Erik Mongrain",                # misspelt tag: albums alone never accept another name
    "Birgir": "Birgir Steinn Stefansson",            # credited under the full name, not "Birgir"
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


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["case"])
def test_owner_named_artist(case):
    outcome = resolve_artist(case["context"], client=_client())

    if case["case"] in MATCHED:
        assert outcome["classification"] == "found"
        assert outcome["artist"]["mbid"] == MATCHED[case["case"]]
        assert outcome.get("credit_name") == ("3 Crows" if case["case"] == "3 Crows" else None)
    else:
        assert outcome["classification"] == "unconfirmed"
        assert [candidate["canonical_name"] for candidate in outcome["candidates"]][:1] == [UNCONFIRMED[case["case"]]]


def test_every_named_case_is_covered():
    assert {case["case"] for case in FIXTURE["cases"]} == set(MATCHED) | set(UNCONFIRMED)
