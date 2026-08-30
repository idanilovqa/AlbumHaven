from __future__ import annotations

import hashlib
from threading import Event, Thread

import pytest

from music_app.services import cover_manual_links
from music_app.services import cover_provider_fallback_web
from music_app.services import cover_provider_runtime
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    build_manual_lookup_matches_from_candidates,
    build_lookup_matches_from_candidates,
    cover_candidate_to_lookup_match,
    cover_candidate_from_current_use_payload,
    CURRENT_USE_COVER_CANDIDATE_FIELDS,
    CURRENT_USE_LOOKUP_MATCH_FIELDS,
    CURRENT_USE_SELECTED_REMOTE_IMAGE_FIELDS,
    current_use_candidate_debug_payload,
    dedupe_cover_candidates,
    manual_source_details,
    normalize_remote_image_url,
    normalize_pasted_cover_urls,
    selected_remote_image_from_lookup_match,
)


@pytest.mark.parametrize(
    ("raw_url", "normalized_url"),
    [
        (" https://images.example/front.jpg#cover ", "https://images.example/front.jpg"),
        ("//images.example/front.jpg?size=large#frag", "https://images.example/front.jpg?size=large"),
        ("http://coverartarchive.org/release/abc/front.jpg", "https://coverartarchive.org/release/abc/front.jpg"),
        ("http://images.example/front.jpg#frag", "http://images.example/front.jpg"),
        ("images.example/front.jpg#kept", "images.example/front.jpg#kept"),
        ("", ""),
    ],
)
def test_normalize_remote_image_url_strips_fragments_and_preserves_current_scheme_rules(
    raw_url: str,
    normalized_url: str,
):
    assert normalize_remote_image_url(raw_url) == normalized_url


@pytest.mark.parametrize(
    ("url", "source", "label"),
    [
        ("https://music.apple.com/us/album/example/1", "apple", "Apple Music"),
        ("https://images-na.ssl-images-amazon.com/images/I/cover.jpg", "amazon", "Amazon"),
        ("https://api.discogs.com/releases/1", "discogs", "Discogs"),
        ("https://i.scdn.co/image/abc", "spotify", "Spotify"),
        ("https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000.jpg", "deezer", "Deezer"),
        ("https://artist.bandcamp.com/album/example", "bandcamp", "Bandcamp"),
        ("https://i.ytimg.com/vi/example/maxresdefault.jpg", "youtube_music", "YouTube Music"),
    ],
)
def test_manual_source_details_labels_known_hosts(url: str, source: str, label: str):
    assert manual_source_details(url) == (source, label)


def test_manual_source_details_falls_back_to_host_or_url_for_unknown_sources():
    assert manual_source_details("https://covers.example/path/front.jpg") == ("direct_url", "covers.example")
    assert manual_source_details("not a url") == ("direct_url", "not a url")


def test_normalize_pasted_cover_urls_trims_dedupes_defaults_https_and_strips_fragments():
    assert normalize_pasted_cover_urls([
        " https://images.example/front.jpg#cover ",
        "https://images.example/front.jpg#duplicate-fragment",
        "images.example/back.png#back",
        "//images.example/side.webp?size=large#side",
        "",
        "   ",
    ]) == [
        "https://images.example/front.jpg",
        "https://images.example/back.png",
        "https://images.example/side.webp?size=large",
    ]


def test_cover_candidate_to_lookup_match_preserves_current_use_payload_contract_and_debug_summary():
    candidate = CoverCandidate(
        source="cover_art_archive",
        url=" https://images.example/front.jpg#cover ",
        score=0.98765,
        width="1200",
        height="1000",
        matched_artist="Test Artist",
        matched_album="Test Album",
        matched_year=2001,
        debug_payload={
            "source_label": "CAA Front",
            "album_url": "https://musicbrainz.example/release/1",
            "query_mode": "release-group",
            "variant": "front",
            "thumbnail_url": "",
            "art_kind": "other",
            "art_label": "Back cover",
            "raw_results": [{
                "image": "https://images.example/front.jpg",
                "musicbrainz_release_group_id": "future-nested-release-group",
                "release_type": "album",
                "artist_credits": [{"name": "Future Credit"}],
                "listenbrainz_recording_id": "future-listenbrainz",
                "virtual_discography_group": "future-virtual-discography",
                "perfect_search_rank": 1,
            }],
            "probed_contenders": [{
                "url": "https://images.example/front.jpg",
                "status": "ok",
                "score": 0.98765,
                "width": 1200,
                "height": 1000,
                "mood": ["Future Mood"],
                "style": ["Future Style"],
                "people": ["Future Person"],
                "roles": ["Future Role"],
            }],
            "musicbrainz_release_group_id": "future-release-group",
            "release_type": "album",
            "artist_credits": [{"name": "Future Credit"}],
            "people": ["Future Person"],
            "roles": ["Future Role"],
            "mood": ["Future Mood"],
            "style": ["Future Style"],
        },
    )

    match = cover_candidate_to_lookup_match(candidate, lookup_group="metadata")

    expected_key = "|".join([
        "metadata",
        "cover_art_archive",
        "Test Artist",
        "Test Album",
        "2001",
        "https://images.example/front.jpg",
    ])
    assert match == {
        "id": hashlib.sha1(expected_key.encode("utf-8", "ignore")).hexdigest(),
        "source": "cover_art_archive",
        "source_label": "CAA Front",
        "lookup_group": "metadata",
        "url": "https://images.example/front.jpg",
        "thumbnail_url": "https://images.example/front.jpg",
        "width": 1200,
        "height": 1000,
        "resolution": "1200x1000",
        "area": 1_200_000,
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2001,
        "score": 0.9877,
        "album_url": "https://musicbrainz.example/release/1",
        "query_mode": "release-group",
        "variant": "front",
        "display_only": True,
        "art_kind": "other",
        "art_label": "Back cover",
        "debug": {
            "raw_results": [{"image": "https://images.example/front.jpg"}],
            "probed_contenders": [{
                "url": "https://images.example/front.jpg",
                "status": "ok",
                "score": 0.98765,
                "width": 1200,
                "height": 1000,
            }],
        },
    }
    assert "debug_payload" not in match
    for leaked_key in [
        "musicbrainz_release_group_id",
        "release_type",
        "artist_credits",
        "people",
        "roles",
        "mood",
        "style",
        "listenbrainz_recording_id",
        "virtual_discography_group",
        "perfect_search_rank",
    ]:
        assert leaked_key not in match
        assert leaked_key not in match["debug"]
        assert leaked_key not in match["debug"]["raw_results"][0]
        assert leaked_key not in match["debug"]["probed_contenders"][0]


def test_current_use_candidate_diagnostics_summarize_apple_provider_raw_keys():
    debug_payload = {
        "raw_results": [{
            "artistName": "Apple Artist",
            "collectionName": "Apple Album",
            "releaseDate": "2001-09-24T07:00:00Z",
            "collectionViewUrl": "https://music.apple.com/us/album/apple-album/100",
            "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg",
            "artworkWidth": 3000,
            "artworkHeight": 3000,
            "artist_credits": [{"name": "Future Credit"}],
            "musicbrainz_release_group_id": "future-release-group",
            "listenbrainz_recording_id": "future-listenbrainz",
            "release_type": "album",
            "credits": [{"name": "Future Credit"}],
            "people": [{"name": "Future Person", "role": "Future Role"}],
            "roles": ["Future Role"],
            "mood": ["Future Mood"],
            "style": ["Future Style"],
        }],
        "probed_contenders": [{
            "artistName": "Apple Artist",
            "collectionName": "Apple Album",
            "releaseDate": "2001-09-24T07:00:00Z",
            "collectionViewUrl": "https://music.apple.com/us/album/apple-album/100",
            "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg",
            "candidate_width": 3000,
            "candidate_height": 3000,
            "musicbrainz_release_id": "future-release",
            "roles": ["Future Role"],
        }],
    }

    shaped_debug = current_use_candidate_debug_payload(debug_payload)

    assert shaped_debug["raw_results"] == [{
        "artist": "Apple Artist",
        "album": "Apple Album",
        "date": "2001-09-24T07:00:00Z",
        "year": 2001,
        "album_url": "https://music.apple.com/us/album/apple-album/100",
        "artwork_url": "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg",
        "thumbnail_url": "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg",
        "width": 3000,
        "height": 3000,
    }]
    assert shaped_debug["probed_contenders"] == [{
        "artist": "Apple Artist",
        "album": "Apple Album",
        "date": "2001-09-24T07:00:00Z",
        "year": 2001,
        "album_url": "https://music.apple.com/us/album/apple-album/100",
        "artwork_url": "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg",
        "thumbnail_url": "https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg",
        "candidate_width": 3000,
        "candidate_height": 3000,
    }]
    for leaked_key in [
        "artistName",
        "collectionName",
        "releaseDate",
        "collectionViewUrl",
        "artworkUrl100",
        "artworkWidth",
        "artworkHeight",
        "musicbrainz_release_id",
        "musicbrainz_release_group_id",
        "artist_credits",
        "release_type",
        "credits",
        "people",
        "roles",
        "mood",
        "style",
        "listenbrainz_recording_id",
    ]:
        assert leaked_key not in shaped_debug["raw_results"][0]
        assert leaked_key not in shaped_debug["probed_contenders"][0]


def test_current_use_candidate_contract_names_only_live_cover_fields():
    assert CURRENT_USE_COVER_CANDIDATE_FIELDS == frozenset({
        "source",
        "url",
        "score",
        "width",
        "height",
        "raw_bytes",
        "matched_artist",
        "matched_album",
        "matched_year",
        "matched_edition",
        "debug_payload",
    })
    assert CURRENT_USE_LOOKUP_MATCH_FIELDS == frozenset({
        "id",
        "source",
        "source_label",
        "lookup_group",
        "url",
        "thumbnail_url",
        "width",
        "height",
        "resolution",
        "area",
        "artist",
        "album",
        "year",
        "score",
        "album_url",
        "query_mode",
        "variant",
        "display_only",
        "art_kind",
        "art_label",
        "debug",
    })
    assert CURRENT_USE_SELECTED_REMOTE_IMAGE_FIELDS == frozenset({
        "id",
        "url",
        "thumbnail_url",
        "source",
        "source_label",
        "lookup_group",
        "album_url",
        "width",
        "height",
        "score",
        "display_only",
        "art_kind",
        "art_label",
        "query_mode",
        "variant",
    })


def test_current_use_candidate_contract_rejects_future_metadata_fields():
    payload = {
        "source": "cover_art_archive",
        "url": "https://images.example/front.jpg",
        "score": 0.9,
        "musicbrainz_release_group_id": "future-release-group",
        "release_type": "album",
        "listenbrainz_recording_id": "future-recording",
        "virtual_discography_group": "future-group",
        "perfect_search_rank": 1,
    }

    with pytest.raises(ValueError, match="Unsupported cover provider candidate field"):
        cover_candidate_from_current_use_payload(payload)


def test_current_use_candidate_contract_builds_candidate_with_defaults():
    candidate = cover_candidate_from_current_use_payload({
        "source": "cover_art_archive",
        "url": " https://images.example/front.jpg#fragment ",
        "matched_artist": "Test Artist",
    })

    assert candidate == CoverCandidate(
        source="cover_art_archive",
        url=" https://images.example/front.jpg#fragment ",
        matched_artist="Test Artist",
    )


def test_selected_remote_image_from_lookup_match_normalizes_save_contract_without_debug_payload():
    selected_image = selected_remote_image_from_lookup_match({
        "id": "candidate-1",
        "source": "discogs",
        "source_label": "Discogs",
        "lookup_group": "discogs",
        "url": " https://images.example/front.jpg#provider-fragment ",
        "thumbnail_url": " https://images.example/thumb.jpg#thumbnail-fragment ",
        "width": "1200",
        "height": 1000,
        "album_url": "https://discogs.example/release/1",
        "query_mode": "manual-url",
        "variant": "release",
        "score": 0.91234,
        "display_only": False,
        "art_kind": "cover",
        "art_label": "Front cover",
        "debug_payload": {
            "raw_provider_payload": {
                "folder": "provider-owned-folder-should-not-cross-boundary",
            },
        },
        "musicbrainz_release_group_id": "future-release-group",
        "release_type": "album",
        "listenbrainz_recording_id": "future-recording",
        "virtual_discography_group": "future-group",
        "perfect_search_rank": 1,
    })

    assert selected_image.id == "candidate-1"
    assert selected_image.url == "https://images.example/front.jpg"
    assert selected_image.thumbnail_url == "https://images.example/thumb.jpg"
    assert selected_image.source == "discogs"
    assert selected_image.source_label == "Discogs"
    assert selected_image.lookup_group == "discogs"
    assert selected_image.album_url == "https://discogs.example/release/1"
    assert selected_image.width == 1200
    assert selected_image.height == 1000
    assert selected_image.score == 0.91234
    assert selected_image.display_only is False
    assert selected_image.art_kind == "cover"
    assert selected_image.art_label == "Front cover"
    assert not hasattr(selected_image, "debug_payload")
    assert not hasattr(selected_image, "musicbrainz_release_group_id")
    assert not hasattr(selected_image, "release_type")
    assert not hasattr(selected_image, "listenbrainz_recording_id")
    assert not hasattr(selected_image, "virtual_discography_group")
    assert not hasattr(selected_image, "perfect_search_rank")


def test_cover_candidate_to_lookup_match_uses_fallback_label_and_unknown_metadata_defaults():
    match = cover_candidate_to_lookup_match(
        CoverCandidate(source="custom_provider", url="https://images.example/front.jpg", score=0.5),
        lookup_group="services",
    )

    assert match["source_label"] == "Custom_Provider"
    assert match["thumbnail_url"] == "https://images.example/front.jpg"
    assert match["width"] == 0
    assert match["height"] == 0
    assert match["resolution"] == "Unknown"
    assert match["area"] == 0
    assert match["score"] == 0.5
    assert match["display_only"] is False
    assert "debug" not in match
    assert "debug_payload" not in match


@pytest.mark.parametrize(
    ("source", "expected_display_only"),
    [
        ("spotify", True),
        ("apple", False),
        ("deezer", False),
        ("youtube_music", False),
    ],
)
def test_cover_candidate_to_lookup_match_marks_only_spotify_display_only(
    source: str,
    expected_display_only: bool,
):
    match = cover_candidate_to_lookup_match(
        CoverCandidate(source=source, url=f"https://{source}.example/front.jpg"),
        lookup_group="services",
    )

    assert match["display_only"] is expected_display_only


def test_dedupe_cover_candidates_sorts_by_score_area_and_casefolded_url():
    candidates = [
        CoverCandidate(source="deezer", url="https://images.example/b.jpg", score=0.80, width=1000, height=1000),
        CoverCandidate(source="spotify", url=" https://images.example/a.jpg ", score=0.90, width=700, height=700),
        CoverCandidate(source="apple", url="HTTPS://IMAGES.EXAMPLE/A.JPG", score=0.95, width=500, height=500),
        CoverCandidate(source="amazon", url="https://images.example/c.jpg", score=0.80, width=1200, height=1200),
        CoverCandidate(source="empty", url="", score=1.0, width=4000, height=4000),
    ]

    deduped = dedupe_cover_candidates(candidates)

    assert [candidate.source for candidate in deduped] == ["apple", "amazon", "deezer"]
    assert [candidate.url for candidate in deduped] == [
        "HTTPS://IMAGES.EXAMPLE/A.JPG",
        "https://images.example/c.jpg",
        "https://images.example/b.jpg",
    ]


def test_build_lookup_matches_from_candidates_dedupes_before_serializing():
    candidates = [
        CoverCandidate(source="spotify", url="https://images.example/a.jpg", score=0.90, width=700, height=700),
        CoverCandidate(source="apple", url="HTTPS://IMAGES.EXAMPLE/A.JPG", score=0.95, width=500, height=500),
    ]

    matches = build_lookup_matches_from_candidates(candidates, lookup_group="services")

    assert len(matches) == 1
    assert matches[0]["source"] == "apple"
    assert matches[0]["url"] == "https://IMAGES.EXAMPLE/A.JPG"


def test_build_manual_lookup_matches_from_candidates_uses_normal_serialization_contract():
    matches = build_manual_lookup_matches_from_candidates([
        CoverCandidate(
            source="direct_url",
            url=" http://images.example/front.jpg#cover ",
            score=1.0,
            width=1400,
            height=1400,
            matched_artist="Test Artist",
            matched_album="Test Album",
            matched_year=2001,
            debug_payload={"query_mode": "manual-url", "source_label": "Manual Debug"},
        )
    ])

    assert len(matches) == 1
    assert matches[0]["source"] == "direct_url"
    assert matches[0]["source_label"] == "Manual Debug"
    assert matches[0]["lookup_group"] == "manual_links"
    assert matches[0]["url"] == "http://images.example/front.jpg"
    assert matches[0]["resolution"] == "1400x1400"
    assert matches[0]["score"] == 1.0


def test_build_manual_lookup_matches_from_candidates_falls_back_to_debug_label_or_manual_link():
    matches = build_manual_lookup_matches_from_candidates([
        CoverCandidate(
            source="",
            url="https://images.example/debug.jpg",
            debug_payload={"source_label": "Debug Label"},
        ),
        CoverCandidate(source="", url="https://images.example/manual.jpg"),
    ])

    assert [match["source_label"] for match in matches] == ["Debug Label", "Manual link"]


def test_add_cover_candidates_from_urls_normalizes_pasted_direct_image_before_serializing(monkeypatch):
    probed_urls: list[str] = []

    def fake_probe_match_candidates(**kwargs):
        score, url, payload = kwargs["matches"][0]
        probed_urls.append(url)
        return [
            CoverCandidate(
                source=kwargs["source"],
                url=url,
                score=score,
                width=1200,
                height=1200,
                matched_artist=kwargs["artist"],
                matched_album=kwargs["album"],
                matched_year=kwargs["year"],
                debug_payload={"query_mode": kwargs["query_mode"], **payload},
            )
        ]

    monkeypatch.setattr(cover_provider_runtime, "probe_match_candidates", fake_probe_match_candidates)

    matches = cover_manual_links.add_manual_cover_candidates_from_urls(
        [
            " images.example/front.jpg#cover ",
            "https://images.example/front.jpg#duplicate",
        ],
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        user_agent="AlbumHavenTests/1.0",
    )

    assert probed_urls == ["https://images.example/front.jpg"]
    assert len(matches) == 1
    assert matches[0]["source"] == "direct_url"
    assert matches[0]["source_label"] == "images.example"
    assert matches[0]["lookup_group"] == "manual_links"
    assert matches[0]["url"] == "https://images.example/front.jpg"
    assert matches[0]["resolution"] == "1200x1200"


def test_add_cover_candidates_from_urls_expands_independent_manual_urls_in_parallel(monkeypatch):
    page_started = Event()
    image_started = Event()
    observed_overlap: list[bool] = []

    def fake_page_expansion(normalized_url, **_kwargs):
        page_started.set()
        observed_overlap.append(image_started.wait(1))
        return [
            CoverCandidate(
                source="direct_url",
                url=f"{normalized_url}/cover.jpg",
                score=1.0,
                width=1400,
                height=1400,
            )
        ]

    def fake_image_expansion(normalized_url, **_kwargs):
        image_started.set()
        observed_overlap.append(page_started.wait(1))
        return [
            CoverCandidate(
                source="direct_url",
                url=normalized_url,
                score=1.0,
                width=1200,
                height=1200,
            )
        ]

    monkeypatch.setattr(
        cover_provider_fallback_web,
        "expand_generic_manual_page_url_candidates",
        fake_page_expansion,
    )
    monkeypatch.setattr(
        cover_provider_fallback_web,
        "expand_manual_direct_image_url_candidates",
        fake_image_expansion,
    )

    matches = cover_manual_links.add_manual_cover_candidates_from_urls(
        [
            "https://manual.example/album",
            "https://images.example/front.jpg",
        ],
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        user_agent="AlbumHavenTests/1.0",
    )

    assert observed_overlap == [True, True]
    assert [match["url"] for match in matches] == [
        "https://manual.example/album/cover.jpg",
        "https://images.example/front.jpg",
    ]


def test_manual_url_expansion_returns_on_cancellation_and_cancels_queued_nested_work(
    monkeypatch,
):
    release_expansions = Event()
    expansion_started = [Event() for _index in range(5)]
    expansion_finished = [Event() for _index in range(5)]
    stop_requested = Event()
    caller_done = Event()
    results: list[list[dict[str, object]]] = []
    errors: list[BaseException] = []

    def blocking_page_expansion(normalized_url, **_kwargs):
        index = int(normalized_url.rsplit("/", 1)[-1])
        expansion_started[index].set()
        assert release_expansions.wait(2)
        expansion_finished[index].set()
        return []

    def collect_manual_matches() -> None:
        try:
            results.append(
                cover_manual_links.add_manual_cover_candidates_from_urls(
                    [
                        f"https://manual.example/album/{index}"
                        for index in range(5)
                    ],
                    target_artist="Test Artist",
                    target_album="Test Album",
                    target_edition=None,
                    target_year=2001,
                    user_agent="AlbumHavenTests/1.0",
                    should_cancel=stop_requested.is_set,
                )
            )
        except BaseException as exc:
            errors.append(exc)
        finally:
            caller_done.set()

    monkeypatch.setattr(
        cover_provider_fallback_web,
        "expand_generic_manual_page_url_candidates",
        blocking_page_expansion,
    )
    caller = Thread(target=collect_manual_matches)
    caller.start()
    try:
        for started in expansion_started[:4]:
            assert started.wait(1)
        assert expansion_started[4].is_set() is False

        stop_requested.set()
        assert caller_done.wait(0.25), (
            "cancellation must release the provider caller without waiting for nested URL work"
        )
    finally:
        release_expansions.set()
        caller.join(timeout=2)

    for finished in expansion_finished[:4]:
        assert finished.wait(1)
    assert not expansion_started[4].wait(0.1)
    assert errors == []
    assert results == [[]]


def test_provider_specific_pasted_candidates_use_manual_lookup_serialization(monkeypatch):
    serialized: dict[str, object] = {}

    monkeypatch.setattr(
        cover_provider_runtime.cover_provider_spotify,
        "spotify_api_enabled",
        lambda: True,
    )
    monkeypatch.setattr(
        cover_provider_runtime,
        "spotify_candidates_from_album_url",
        lambda *_args, **_kwargs: [
            CoverCandidate(
                source="",
                url="https://images.example/spotify.jpg",
                debug_payload={"source_label": "Debug Spotify"},
            )
        ],
    )

    def fake_build_lookup_matches(candidates, *, lookup_group="services"):
        serialized["lookup_group"] = lookup_group
        serialized["candidate_count"] = len(candidates)
        return [{
            "source": "",
            "source_label": "",
            "lookup_group": lookup_group,
            "url": candidates[0].url,
            "debug_payload": candidates[0].debug_payload,
        }]

    monkeypatch.setattr(
        "music_app.services.cover_provider_candidates.build_lookup_matches_from_candidates",
        fake_build_lookup_matches,
    )

    matches = cover_manual_links.add_manual_cover_candidates_from_urls(
        ["https://open.spotify.com/album/abc123?si=share#fragment"],
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        user_agent="AlbumHavenTests/1.0",
    )

    assert serialized == {"lookup_group": "manual_links", "candidate_count": 1}
    assert matches == [{
        "source": "",
        "source_label": "Debug Spotify",
        "lookup_group": "manual_links",
        "url": "https://images.example/spotify.jpg",
        "debug_payload": {"source_label": "Debug Spotify"},
    }]
