from __future__ import annotations

from music_app.services import virtual_discography_search as search_module


def test_search_virtual_artist_candidates_formats_musicbrainz_results(monkeypatch):
    captured = {}

    def fake_get_json(url, user_agent, **kwargs):
        captured["url"] = url
        captured["user_agent"] = user_agent
        captured["kwargs"] = kwargs
        return {
            "artists": [
                {
                    "id": "artist-2",
                    "name": "MONO",
                    "sort-name": "MONO",
                    "type": "Group",
                    "area": {"name": "Japan"},
                    "country": "JP",
                    "life-span": {"begin": "1999", "ended": False},
                    "disambiguation": "post-rock band",
                    "score": "100",
                },
                {
                    "id": "artist-1",
                    "name": "Mono",
                    "sort-name": "Mono",
                    "type": "Person",
                    "life-span": {"begin": "1980", "end": "2001"},
                    "score": "80",
                    "aliases": [{"name": "Mononymous"}],
                },
            ]
        }, {"status": "network", "cache_hit": False}

    monkeypatch.setattr(search_module, "musicbrainz_get_json", fake_get_json)

    payload = search_module.search_virtual_artist_candidates("mono")

    assert payload["ok"] is True
    assert payload["query"] == "mono"
    assert payload["provider_state"] == {
        "provider": "musicbrainz",
        "query_performed": True,
        "status": "network",
        "cache_hit": False,
    }
    assert payload["candidate_contract"] == {
        "identity_field": "candidate_ref",
        "submit_route": "/virtual-artists",
        "display_name_field": "display_name",
        "disambiguation_text_field": "disambiguation_text",
        "provider_artist_id_field": "provider_artist_id",
    }
    assert payload["candidates"] == [
        {
            "candidate_ref": "musicbrainz:artist:artist-2",
            "provider": "musicbrainz",
            "provider_artist_id": "artist-2",
            "display_name": "MONO",
            "sort_name": "MONO",
            "disambiguation_text": "Group | Japan | JP | 1999 to present | post-rock band",
            "match_score": 100,
            "identity_match_score": 1.0,
        },
        {
            "candidate_ref": "musicbrainz:artist:artist-1",
            "provider": "musicbrainz",
            "provider_artist_id": "artist-1",
            "display_name": "Mono",
            "sort_name": "Mono",
            "disambiguation_text": "Person | 1980 to 2001",
            "match_score": 80,
            "identity_match_score": 1.0,
            "aliases": ["Mononymous"],
        },
    ]
    assert 'artist%3A%22mono%22' in captured["url"]
    assert captured["kwargs"]["context"] == "virtual-discography-candidate-search:mono"


def test_search_virtual_artist_candidates_keeps_blank_queries_idle():
    payload = search_module.search_virtual_artist_candidates("   ")

    assert payload == {
        "ok": True,
        "query": "",
        "provider_state": {
            "provider": "musicbrainz",
            "query_performed": False,
            "status": "idle",
        },
        "candidate_contract": {
            "identity_field": "candidate_ref",
            "submit_route": "/virtual-artists",
            "display_name_field": "display_name",
            "disambiguation_text_field": "disambiguation_text",
            "provider_artist_id_field": "provider_artist_id",
        },
        "candidates": [],
    }


def test_search_virtual_artist_candidates_ranks_and_annotates_shared_identity(monkeypatch):
    monkeypatch.setattr(
        search_module,
        "musicbrainz_get_json",
        lambda *_args, **_kwargs: (
            {
                "artists": [
                    {
                        "id": "artist-fuzzy",
                        "name": "Morse Portnoy",
                        "sort-name": "Morse Portnoy",
                        "score": "100",
                    },
                    {
                        "id": "artist-exact",
                        "name": "Morse Portnoy George",
                        "sort-name": "Morse Portnoy George",
                        "score": "70",
                    },
                ]
            },
            {"status": "network", "cache_hit": False},
        ),
    )

    payload = search_module.search_virtual_artist_candidates(
        "Morse, Portnoy & George"
    )

    assert [candidate["provider_artist_id"] for candidate in payload["candidates"]] == [
        "artist-exact",
        "artist-fuzzy",
    ]
    assert len(payload["candidates"]) == 2
    exact_score, fuzzy_score = [
        candidate["identity_match_score"] for candidate in payload["candidates"]
    ]
    assert isinstance(exact_score, (int, float))
    assert isinstance(fuzzy_score, (int, float))
    assert exact_score > fuzzy_score


def test_search_virtual_artist_candidates_surfaces_provider_failure(monkeypatch):
    monkeypatch.setattr(
        search_module,
        "musicbrainz_get_json",
        lambda *args, **kwargs: (
            None,
            {
                "status": "blocked",
                "cache_hit": False,
                "blocked_reason": "http_503",
                "retry_after_seconds": 12.5,
            },
        ),
    )

    payload = search_module.search_virtual_artist_candidates("mono")

    assert payload == {
        "query": "mono",
        "provider_state": {
            "provider": "musicbrainz",
            "query_performed": True,
            "status": "blocked",
            "cache_hit": False,
            "blocked_reason": "http_503",
            "retry_after_seconds": 12.5,
        },
        "candidate_contract": {
            "identity_field": "candidate_ref",
            "submit_route": "/virtual-artists",
            "display_name_field": "display_name",
            "disambiguation_text_field": "disambiguation_text",
            "provider_artist_id_field": "provider_artist_id",
        },
        "candidates": [],
        "ok": False,
        "error": "Virtual Discography candidate search is temporarily unavailable.",
    }


def test_search_virtual_artist_candidates_surfaces_cached_miss_as_provider_failure(monkeypatch):
    monkeypatch.setattr(
        search_module,
        "musicbrainz_get_json",
        lambda *args, **kwargs: (
            None,
            {
                "status": "cached_miss",
                "cache_hit": True,
            },
        ),
    )

    payload = search_module.search_virtual_artist_candidates("mono")

    assert payload == {
        "query": "mono",
        "provider_state": {
            "provider": "musicbrainz",
            "query_performed": True,
            "status": "cached_miss",
            "cache_hit": True,
        },
        "candidate_contract": {
            "identity_field": "candidate_ref",
            "submit_route": "/virtual-artists",
            "display_name_field": "display_name",
            "disambiguation_text_field": "disambiguation_text",
            "provider_artist_id_field": "provider_artist_id",
        },
        "candidates": [],
        "ok": False,
        "error": "Virtual Discography candidate search is temporarily unavailable.",
    }
