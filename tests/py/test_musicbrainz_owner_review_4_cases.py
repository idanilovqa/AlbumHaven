"""The owner's fourth Delivery 1 review (2026-11-09): Unconfirmed artists whose albums
are on MusicBrainz under another title, script, edition or credit, replayed offline.

The fixture holds each artist's local albums and the local MusicBrainz mirror's answers,
recorded and trimmed to the fields the resolver reads. Any request the fixture lacks
fails the test, so a retrieval change cannot silently skip evidence.
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

# Matched through their albums: the owner named the release on MusicBrainz for each.
MATCHED = {
    # A release title in the group, not the group's own title (localized or re-released).
    "Memories Of Machines": "d58c83ac-e74a-4966-b6df-0d3b050e0667",
    "Minyo Crusaders": "1b33c057-e909-49e5-b0ea-6410019b5b70",
    "Motohiro Hata": "959d75a2-44ed-4d14-9220-09f136b398ff",
    "New Trolls Atomic System": "53d452e1-2cf5-4365-a611-a11a1632ed70",
    "Ofra Haza": "7591796a-a545-4b51-ba52-bf2539b90d99",
    "山崎まさよし": "9c98108e-ee2b-4d99-a54c-279e5f32b25b",
    "野見祐二": "b0927e5d-1caf-4f71-860b-4f58c5198b38",
    "Hiroyuki Nanba": "194a0f8d-8040-43e7-b3e6-cea9a1f750e4",
    "Christian Vander": "0933c7f6-aaff-4bd8-bb69-deb3088db745",  # his release in Magma's group
    # Part of the title agrees and the tracklist is certain.
    "Il Castello Di Atlante": "5df152c7-7885-4403-80ae-8c75ce76b3bd",
    "Joanna Wang": "7f381e24-31b2-4321-a82f-012245a2c620",
    "Mundi Domini": "cac702a2-d135-44c3-9534-d381741c9bca",
    "Dessiderium": "91579784-b30d-40bb-9f08-6defd0c2685f",
    "Amaseffer": "773055b0-ae36-44cf-84a2-d1b75b7f29bc",            # "Exodus: Slaves for Life"
    "Celeste": "6ad4d115-3c35-4fff-b288-c78de3aafbd5",              # "(aka …)"
    "Prazsky Vyber": "a826967b-88e5-4475-b4ff-fdb0765cfa68",        # name in parentheses
    "Тампль": "ad71f065-65e4-4191-9845-cf70640d819f",                # tracks, not the title
    # Another script.
    "Joe Hisaishi": "44c64a30-1d58-49c5-b314-6e02fba49526",
    "久石 譲": "44c64a30-1d58-49c5-b314-6e02fba49526",
    "天門": "30b485e2-3317-4dc5-8d4c-a35f17a8e547",
    "잠비나이": "74c9db5a-cece-4381-afa8-a5f381901487",
    "Radwimps": "6f500293-7396-4903-b4fd-118127d06f9e",
    "仙台貨物": "56bcb913-c172-45ef-b5cb-3e801ef60120",               # the bracketed original title
    # A typo, a broken tag encoding.
    "John 5": "66ac10d4-37cc-4b84-91dd-4863e3dc9a32",
    "Korai Цrцm": "9601853b-720d-459a-8b7e-22a99213a6bb",            # "Korai Öröm" read as cp1251
    # The owner's "why not matched" list.
    "Karma": "87a879cb-f600-46da-90f8-badfa01913a0",                 # MusicBrainz lists 4 of 7 tracks
    "Kernunna": "fc8e4f36-cd89-44d6-8820-54a09e9edfe5",              # "The Seim A New" / "Anew"
    "Run The Jewels": "a80c5dc5-b12e-4667-9f5a-b568961f3839",        # "RTJ3"
    "Seckou Keita": "3101d905-ba10-4088-af15-8160b12e65e1",          # "22 Strings/Cordes"
    "The Miles Davis Quintet": "fe7245e7-d734-4ca1-8e26-691883f58201",  # not the compilation's group
    "Toy Matinee": "85c16ec5-e905-4275-8bc3-337c9891d3ca",           # "Toy Manitee"
    "Сергей Терентьев": "69d72327-d93f-4214-a20e-0254db3dd3e2",      # "Up to 30" / "Up to Thirty"
    "Amestigon": "c8887bd4-e36d-4056-aff0-6265890a0680",             # a split release with Angizia
    "Daisuke Kashiwa": "bda64da8-c7b2-40dc-a107-fc3528b5ab8c",       # a Latin release title of 言の葉の庭
    # Left to the user by the owner on the earlier evidence; every track title and length
    # of one of the artist's releases now agrees with the album.
    "ServAnteS": "454a4d71-badf-4a61-adf6-4052aa180698",             # the owner's own link, release "2012"
    "The Addiction Dream": "9371bb8e-8da4-47ab-bd7b-82fe4238da49",   # release "Essence"
}
# MusicBrainz lists no releases for the suggested artist: it stays suggested, and the
# evidence says why instead of claiming the albums disagree.
NO_RELEASES = {"Antehero", "Erik Hammarström", "Fate´s Right Band"}
# Weak evidence the owner leaves to the user, with the suggested artist kept.
LEFT_TO_USER = {
    # Jon Durant has five release groups on MusicBrainz, none of them this album.
    "ProjeKCt Six", "Jon Durant", "Diatom", "Dramatic View", "Iwasaki Hiromi", "Neil Davidge", "Vultress",
    "The Lazarus Trio", "Verge Of Lunacy", "Северный Цвет", "Сергей Калугин",
    "Стыров", "Тиль Уленшпигель", "Oceana", "Ollocs", "SmokeFish", "Ktzat Acheret",
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


CASES = {case["case"]: case for case in FIXTURE["cases"]}


def test_fixture_covers_every_named_case():
    assert set(CASES) == set(MATCHED) | NO_RELEASES | LEFT_TO_USER


@pytest.mark.parametrize("name", sorted(MATCHED))
def test_album_evidence_matches_the_owner_named_artist(name):
    outcome = resolve_artist(CASES[name]["context"], client=_client())

    assert outcome["classification"] == "found", outcome.get("evidence_summary")
    assert outcome["artist"]["mbid"] == MATCHED[name]


@pytest.mark.parametrize("name", sorted(NO_RELEASES))
def test_an_artist_without_releases_stays_suggested_and_says_so(name):
    outcome = resolve_artist(CASES[name]["context"], client=_client())

    assert outcome["classification"] == "unconfirmed"
    assert outcome["candidates"], "the suggested artist stays visible"
    assert "lists no releases" in outcome["evidence_summary"]


@pytest.mark.parametrize("name", sorted(LEFT_TO_USER))
def test_weak_evidence_is_left_to_the_user_with_a_suggestion(name):
    outcome = resolve_artist(CASES[name]["context"], client=_client())

    assert outcome["classification"] in {"unconfirmed", "ambiguous"}
    assert outcome["candidates"]
