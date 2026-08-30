from __future__ import annotations

from threading import Event, Thread
from urllib.parse import parse_qs, unquote, urlsplit

from config import Config
from music_app.services import cover_provider_musicbrainz_caa


def _normalize(value: str) -> str:
    return " ".join(str(value or "").casefold().split())


def _parse_year(value: object) -> int | None:
    text = str(value or "").strip()
    return int(text[:4]) if text[:4].isdigit() else None


def _match_score(**kwargs) -> float:
    candidate_artist = _normalize(str(kwargs.get("candidate_artist") or ""))
    candidate_album = _normalize(str(kwargs.get("candidate_album") or ""))
    target_artist = _normalize(str(kwargs.get("target_artist") or ""))
    target_album = _normalize(str(kwargs.get("target_album") or ""))
    if candidate_artist != target_artist or candidate_album != target_album:
        return 0.0
    if kwargs.get("enforce_year"):
        return 0.95 if kwargs.get("candidate_year") == kwargs.get("target_year") else 0.0
    return 0.9


def _log_events():
    events: list[dict[str, object]] = []

    def log_event(_payload, _logger, message, **kwargs):
        events.append({"message": message, **kwargs})

    return events, log_event


def test_musicbrainz_release_search_cache_order_memory_then_disk_then_http(monkeypatch):
    cover_provider_musicbrainz_caa.clear_musicbrainz_release_cache()
    disk: dict[str, list[dict]] = {}
    http_calls: list[str] = []
    events, log_event = _log_events()

    def http_get_json(url, user_agent, **_kwargs):
        http_calls.append(url)
        return {"releases": [{"id": "http-1", "title": "HTTP Album"}]}

    kwargs = dict(
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        user_agent="AlbumHavenTests/1.0",
        normalize=_normalize,
        http_get_json=http_get_json,
        get_disk_cache=lambda key: disk.get(key),
        set_disk_cache=lambda key, releases: disk.__setitem__(key, releases),
        log_event=log_event,
    )

    assert cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(**kwargs) == [
        {"id": "http-1", "title": "HTTP Album"}
    ]
    assert len(http_calls) == 3

    http_calls.clear()
    assert cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(**kwargs) == [
        {"id": "http-1", "title": "HTTP Album"}
    ]
    assert http_calls == []
    assert any(event["message"] == "MusicBrainz release search cache hit" for event in events)

    cover_provider_musicbrainz_caa.clear_musicbrainz_release_cache()
    disk.clear()
    disk["test artist::test album::::2001"] = [{"id": "disk-1", "title": "Disk Album"}]

    assert cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(**kwargs) == [
        {"id": "disk-1", "title": "Disk Album"}
    ]
    assert http_calls == []
    assert any(event["message"] == "MusicBrainz release search disk cache hit" for event in events)


def test_cancellation_during_musicbrainz_http_prevents_musicbrainz_and_caa_cache_writes(request):
    cover_provider_musicbrainz_caa.clear_musicbrainz_release_cache()
    request.addfinalizer(cover_provider_musicbrainz_caa.clear_musicbrainz_release_cache)
    cancel_event = Event()
    http_entered = Event()
    release_http = Event()
    musicbrainz_disk_writes: list[list[dict]] = []
    caa_disk_writes: list[list[dict[str, object]]] = []
    release_art_requests: list[str] = []
    worker_results: list[list[dict[str, object]]] = []
    worker_errors: list[BaseException] = []

    def blocking_musicbrainz_http(_url, _user_agent, **_kwargs):
        http_entered.set()
        if not release_http.wait(5):
            raise AssertionError("Timed out waiting to release the blocked MusicBrainz HTTP call")
        return {
            "releases": [{
                "id": "release-1",
                "title": "Cancellation Test Album",
                "artist-credit": [{"name": "Cancellation Test Artist"}],
                "date": "2001",
            }],
        }

    def nested_musicbrainz_search(**kwargs):
        return cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(
            **kwargs,
            normalize=_normalize,
            http_get_json=blocking_musicbrainz_http,
            get_disk_cache=lambda _key: None,
            set_disk_cache=lambda _key, value: musicbrainz_disk_writes.append(value),
            should_cancel=cancel_event.is_set,
            log_event=lambda *_args, **_kwargs: None,
        )

    def run_lookup():
        try:
            worker_results.append(cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
                "Cancellation Test Artist",
                "Cancellation Test Album",
                None,
                2001,
                "AlbumHavenTests/1.0",
                normalize=_normalize,
                parse_year=_parse_year,
                match_score=_match_score,
                normalize_remote_image_url=lambda value: value,
                probe_candidate_metrics=lambda *_args, **_kwargs: None,
                http_get_json=lambda url, *_args, **_kwargs: release_art_requests.append(str(url)) or None,
                http_get_json_via_curl=lambda url, *_args, **_kwargs: release_art_requests.append(str(url)) or None,
                http_get_json_via_subprocess=lambda url, *_args, **_kwargs: release_art_requests.append(str(url)) or None,
                get_caa_disk_cache=lambda _key: None,
                set_caa_disk_cache=lambda _key, value: caa_disk_writes.append(value),
                search_musicbrainz_release_candidates=nested_musicbrainz_search,
                should_cancel=cancel_event.is_set,
                log_event=lambda *_args, **_kwargs: None,
            ))
        except BaseException as exc:  # pragma: no cover - asserted below
            worker_errors.append(exc)

    worker = Thread(target=run_lookup, name="blocked-musicbrainz-cancellation")
    worker.start()
    entered = http_entered.wait(5)
    cancel_event.set()
    release_http.set()
    worker.join(5)

    assert entered is True
    assert worker.is_alive() is False
    assert worker_errors == []
    assert worker_results == [[]]
    assert musicbrainz_disk_writes == []
    assert caa_disk_writes == []
    assert release_art_requests == []

    verification_http_calls: list[str] = []
    cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(
        artist="Cancellation Test Artist",
        album="Cancellation Test Album",
        edition=None,
        year=2001,
        user_agent="AlbumHavenTests/1.0",
        normalize=_normalize,
        http_get_json=lambda url, *_args, **_kwargs: verification_http_calls.append(str(url)) or {"releases": []},
        get_disk_cache=lambda _key: None,
        set_disk_cache=lambda _key, _value: None,
        should_cancel=lambda: False,
        log_event=lambda *_args, **_kwargs: None,
    )
    assert verification_http_calls


def test_musicbrainz_release_search_query_variants_include_labels_and_dedupe():
    cover_provider_musicbrainz_caa.clear_musicbrainz_release_cache()
    calls: list[dict[str, object]] = []
    should_cancel = lambda: False

    def http_get_json(url, user_agent, **kwargs):
        calls.append({"url": url, **kwargs})
        return {
            "releases": [
                {"id": "release-1", "title": "Test Album"},
                {"id": "release-1", "title": "Duplicate"},
                {"title": "No ID"},
            ]
        }

    releases = cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(
        artist='Test "Artist"',
        album='Test "Album"',
        edition='Deluxe "Edition"',
        year=2001,
        user_agent="AlbumHavenTests/1.0",
        result_limit=7,
        include_labels=True,
        context_prefix="unit",
        normalize=_normalize,
        http_get_json=http_get_json,
        get_disk_cache=lambda _key: None,
        set_disk_cache=lambda _key, _releases: None,
        log_event=lambda *_args, **_kwargs: None,
        should_cancel=should_cancel,
    )

    assert [release.get("title") for release in releases] == ["Test Album", "No ID"]
    assert len(calls) == 4
    queries = [unquote(parse_qs(urlsplit(str(call["url"])).query)["query"][0]) for call in calls]
    assert queries == [
        'artist:"Test Artist" AND release:"Test Album" AND date:2001',
        'artist:"Test Artist" AND release:"Test Album"',
        'release:"Test Album"',
        'release:"Test Album Deluxe Edition"',
    ]
    assert all(parse_qs(urlsplit(str(call["url"])).query)["fmt"] == ["json"] for call in calls)
    assert all(parse_qs(urlsplit(str(call["url"])).query)["limit"] == ["7"] for call in calls)
    assert all(parse_qs(urlsplit(str(call["url"])).query)["inc"] == ["labels artist-credits"] for call in calls)
    assert all(call["should_cancel"] is should_cancel for call in calls)


def test_musicbrainz_bandcamp_context_resolves_ranked_artist_and_label_url_relations():
    detail_requests: list[str] = []
    releases = [{
        "id": "cover-2-cover-release",
        "title": "Cover 2 Cover",
        "artist-credit": [{
            "name": "Morse Portnoy George",
            "artist": {"id": "mpg-artist", "name": "Morse Portnoy George"},
        }],
        "label-info": [{
            "label": {
                "id": "af64e67e-e3e9-4bc3-bb1a-f8c23f285b31",
                "name": "Inside Out Music",
            },
        }],
        "date": "2020-07-24",
    }]

    def http_get_json(url, _user_agent, **_kwargs):
        detail_requests.append(str(url))
        if "/artist/mpg-artist" in str(url):
            return {
                "relations": [
                    {"type": "official homepage", "url": {"resource": "https://example.com/mpg"}},
                ],
            }
        if "/label/af64e67e-e3e9-4bc3-bb1a-f8c23f285b31" in str(url):
            return {
                "relations": [
                    {"type": "bandcamp", "url": {"resource": "https://insideoutmusic.bandcamp.com/?from=musicbrainz#music"}},
                    {"type": "official site", "url": {"resource": "https://insideoutmusic.com/"}},
                    {"type": "other", "url": {"resource": "javascript:alert(1)"}},
                ],
            }
        raise AssertionError(f"Unexpected MusicBrainz detail URL: {url}")

    context = cover_provider_musicbrainz_caa.fetch_musicbrainz_bandcamp_context(
        "Morse Portnoy George",
        "Cover 2 Cover",
        None,
        2020,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        similarity=lambda left, right: 1.0 if _normalize(left) == _normalize(right) else 0.0,
        match_score=_match_score,
        parse_year=_parse_year,
        search_release_candidates=lambda **_kwargs: releases,
        http_get_json=http_get_json,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert context == {
        "artists": ["Morse Portnoy George"],
        "labels": ["Inside Out Music"],
        "artist_account_urls": [],
        "label_account_urls": ["https://insideoutmusic.bandcamp.com/"],
    }
    assert any("/artist/mpg-artist" in url and "inc=url-rels" in url for url in detail_requests)
    assert any(
        "/label/af64e67e-e3e9-4bc3-bb1a-f8c23f285b31" in url and "inc=url-rels" in url
        for url in detail_requests
    )


def test_musicbrainz_bandcamp_context_falls_back_to_artist_search_without_release_ids():
    requests: list[str] = []

    def http_get_json(url, _user_agent, **_kwargs):
        requests.append(str(url))
        if "/artist/?query=" in str(url):
            return {
                "artists": [
                    {"id": "other-artist", "name": "Other Artist"},
                    {"id": "flaming-row", "name": "Flaming Row"},
                ],
            }
        if "/artist/flaming-row" in str(url):
            return {
                "relations": [{
                    "type": "bandcamp",
                    "url": {"resource": "https://flamingrow.bandcamp.com/"},
                }],
            }
        raise AssertionError(f"Unexpected MusicBrainz URL: {url}")

    context = cover_provider_musicbrainz_caa.fetch_musicbrainz_bandcamp_context(
        "Flaming Rows",
        "Pure Shine",
        None,
        2019,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        similarity=lambda left, right: 0.95 if {left, right} == {"Flaming Rows", "Flaming Row"} else 0.1,
        match_score=_match_score,
        parse_year=_parse_year,
        search_release_candidates=lambda **_kwargs: [],
        http_get_json=http_get_json,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert context["artist_account_urls"] == ["https://flamingrow.bandcamp.com/"]
    assert context["label_account_urls"] == []
    assert any("/artist/?query=" in url for url in requests)
    assert any("/artist/flaming-row" in url and "inc=url-rels" in url for url in requests)


def test_musicbrainz_bandcamp_artist_search_prefers_shared_identity_over_higher_fuzzy_score():
    requests: list[str] = []

    def http_get_json(url, _user_agent, **_kwargs):
        requests.append(str(url))
        if "/artist/?query=" in str(url):
            return {
                "artists": [
                    {"id": "similar-first", "name": "Morse Portnoy Georg"},
                    {"id": "shared-identity", "name": "Morse Portnoy George"},
                ],
            }
        if "/artist/shared-identity" in str(url):
            return {
                "relations": [{
                    "type": "bandcamp",
                    "url": {"resource": "https://insideoutmusic.bandcamp.com/"},
                }],
            }
        if "/artist/similar-first" in str(url):
            return {
                "relations": [{
                    "type": "bandcamp",
                    "url": {"resource": "https://wrong.bandcamp.com/"},
                }],
            }
        raise AssertionError(f"Unexpected MusicBrainz URL: {url}")

    context = cover_provider_musicbrainz_caa.fetch_musicbrainz_bandcamp_context(
        "Morse, Portnoy & George",
        "Cover To Cover",
        None,
        2006,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        similarity=lambda _left, right: 0.99 if right == "Morse Portnoy Georg" else 0.8,
        match_score=_match_score,
        parse_year=_parse_year,
        search_release_candidates=lambda **_kwargs: [],
        http_get_json=http_get_json,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert context["artist_account_urls"] == ["https://insideoutmusic.bandcamp.com/"]
    assert any("/artist/shared-identity" in url for url in requests)
    assert not any("/artist/similar-first" in url for url in requests)


def test_musicbrainz_bandcamp_artist_search_rejects_incompatible_identity_markers():
    detail_requests: list[str] = []

    def http_get_json(url, _user_agent, **_kwargs):
        if "/artist/?query=" in str(url):
            return {"artists": [{"id": "tribute", "name": "Example Band Tribute"}]}
        detail_requests.append(str(url))
        return {}

    context = cover_provider_musicbrainz_caa.fetch_musicbrainz_bandcamp_context(
        "Example Band",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        similarity=lambda _left, _right: 0.99,
        match_score=_match_score,
        parse_year=_parse_year,
        search_release_candidates=lambda **_kwargs: [],
        http_get_json=http_get_json,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert context["artist_account_urls"] == []
    assert detail_requests == []


def test_musicbrainz_bandcamp_artist_search_rejects_added_project_identity():
    detail_requests: list[str] = []

    def http_get_json(url, _user_agent, **_kwargs):
        if "/artist/?query=" in str(url):
            return {"artists": [{"id": "project", "name": "The Alan Parsons Project"}]}
        detail_requests.append(str(url))
        return {}

    context = cover_provider_musicbrainz_caa.fetch_musicbrainz_bandcamp_context(
        "Alan Parsons",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        similarity=lambda _left, _right: 0.99,
        match_score=_match_score,
        parse_year=_parse_year,
        search_release_candidates=lambda **_kwargs: [],
        http_get_json=http_get_json,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert context["artist_account_urls"] == []
    assert detail_requests == []


def test_cover_art_archive_missing_artist_or_album_logs_missing_artist_or_album():
    events, log_event = _log_events()

    assert cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        "",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        parse_year=_parse_year,
        match_score=_match_score,
        normalize_remote_image_url=lambda value: value,
        probe_candidate_metrics=lambda **_kwargs: None,
        http_get_json=lambda *_args, **_kwargs: None,
        http_get_json_via_curl=lambda *_args, **_kwargs: None,
        http_get_json_via_subprocess=lambda *_args, **_kwargs: None,
        get_caa_disk_cache=lambda _key: None,
        set_caa_disk_cache=lambda _key, _candidates: None,
        search_musicbrainz_release_candidates=lambda **_kwargs: [],
        log_event=log_event,
    ) == []

    assert events[0]["message"] == "Cover Art Archive lookup skipped"
    assert events[0]["reason"] == "missing_artist_or_album"


def test_cover_art_archive_disk_cache_hit_returns_sanitized_copies():
    cached = [{"id": "release-1:0", "url": "https://images.example/front.jpg"}]

    first = cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        parse_year=_parse_year,
        match_score=_match_score,
        normalize_remote_image_url=lambda value: value,
        probe_candidate_metrics=lambda **_kwargs: None,
        http_get_json=lambda *_args, **_kwargs: None,
        http_get_json_via_curl=lambda *_args, **_kwargs: None,
        http_get_json_via_subprocess=lambda *_args, **_kwargs: None,
        get_caa_disk_cache=lambda _key: cached,
        set_caa_disk_cache=lambda _key, _candidates: None,
        search_musicbrainz_release_candidates=lambda **_kwargs: (_ for _ in ()).throw(AssertionError("cache hit should not search")),
        log_event=lambda *_args, **_kwargs: None,
    )
    first[0]["url"] = "mutated"

    assert cached == [{"id": "release-1:0", "url": "https://images.example/front.jpg"}]


def test_cover_art_archive_cancellation_after_musicbrainz_skips_release_art_requests_and_probes():
    cancel_event = Event()
    release_art_requests: list[str] = []
    probes: list[str] = []
    disk_writes: list[list[dict[str, object]]] = []

    def search_musicbrainz_release_candidates(**_kwargs):
        cancel_event.set()
        return [{
            "id": "release-1",
            "title": "Test Album",
            "artist-credit": [{"name": "Test Artist"}],
            "date": "2001",
        }]

    def fail_release_art_request(url, *_args, **_kwargs):
        release_art_requests.append(str(url))
        raise AssertionError("Cancellation after MusicBrainz must prevent CAA release-art requests")

    candidates = cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        normalize=_normalize,
        parse_year=_parse_year,
        match_score=_match_score,
        normalize_remote_image_url=lambda value: value,
        probe_candidate_metrics=lambda url, **_kwargs: probes.append(url),
        http_get_json=fail_release_art_request,
        http_get_json_via_curl=fail_release_art_request,
        http_get_json_via_subprocess=fail_release_art_request,
        get_caa_disk_cache=lambda _key: None,
        set_caa_disk_cache=lambda _key, value: disk_writes.append(value),
        search_musicbrainz_release_candidates=search_musicbrainz_release_candidates,
        should_cancel=cancel_event.is_set,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert candidates == []
    assert cancel_event.is_set() is True
    assert release_art_requests == []
    assert probes == []
    assert disk_writes == []


def test_cover_art_archive_does_not_cache_candidates_after_mid_release_cancellation():
    cancel_event = Event()
    disk_writes: list[list[dict[str, object]]] = []
    probe_calls: list[str] = []

    def normalize_and_cancel(value: str) -> str:
        cancel_event.set()
        return value

    candidates = cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        limit=1,
        normalize=_normalize,
        parse_year=_parse_year,
        match_score=_match_score,
        normalize_remote_image_url=normalize_and_cancel,
        probe_candidate_metrics=lambda url, **_kwargs: probe_calls.append(url),
        http_get_json=lambda *_args, **_kwargs: {
            "images": [{
                "front": True,
                "image": "https://images.example/front.jpg",
                "width": 1200,
                "height": 1200,
            }],
        },
        http_get_json_via_curl=lambda *_args, **_kwargs: None,
        http_get_json_via_subprocess=lambda *_args, **_kwargs: None,
        get_caa_disk_cache=lambda _key: None,
        set_caa_disk_cache=lambda _key, value: disk_writes.append(value),
        search_musicbrainz_release_candidates=lambda **_kwargs: [{
            "id": "release-1",
            "title": "Test Album",
            "artist-credit": [{"name": "Test Artist"}],
            "date": "2001",
        }],
        should_cancel=cancel_event.is_set,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert cancel_event.is_set() is True
    assert candidates == []
    assert probe_calls == []
    assert disk_writes == []


def test_cover_art_archive_ranks_limits_filters_probes_and_stops_at_limit():
    releases = [
        {"id": "weak", "title": "Other Album", "artist-credit": [{"name": "Other Artist"}], "date": "2001-01-01"},
        {"id": "best", "title": "Test Album", "artist-credit": [{"name": "Test Artist"}], "date": "2001-01-01"},
        {"id": "second", "title": "Test Album", "artist-credit": [{"name": "Test Artist"}], "date": "2001-02-02"},
    ]
    fetched: list[str] = []
    probed: list[str] = []
    stored: list[dict] = []

    def http_get_json(url, user_agent, **_kwargs):
        release_id = str(url).rsplit("/", 1)[-1]
        fetched.append(release_id)
        if release_id == "best":
            return {
                "images": [
                    {"front": False, "back": True, "types": ["Back"], "image": "https://images.example/back.jpg", "width": 1600, "height": 1600},
                    {"front": True, "image": "https://images.example/small.jpg", "width": 400, "height": 900},
                    {"front": True, "image": "https://images.example/probe.jpg", "thumbnails": {"large": "https://images.example/thumb.jpg"}},
                    {"front": True, "image": "https://images.example/probe.jpg", "width": 1600, "height": 1600},
                ]
            }
        return {"images": [{"front": True, "image": "https://images.example/second.jpg", "width": 1200, "height": 1200}]}

    def probe_candidate_metrics(url, **_kwargs):
        probed.append(url)
        return {"width": 900, "height": 900}

    candidates = cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        limit=2,
        normalize=_normalize,
        parse_year=_parse_year,
        match_score=_match_score,
        normalize_remote_image_url=lambda value: value.strip().casefold(),
        probe_candidate_metrics=probe_candidate_metrics,
        http_get_json=http_get_json,
        http_get_json_via_curl=lambda *_args, **_kwargs: None,
        http_get_json_via_subprocess=lambda *_args, **_kwargs: None,
        get_caa_disk_cache=lambda _key: None,
        set_caa_disk_cache=lambda _key, candidates: stored.extend(candidates),
        search_musicbrainz_release_candidates=lambda **_kwargs: releases,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert fetched == ["best"]
    assert probed == ["https://images.example/probe.jpg"]
    assert [candidate["url"] for candidate in candidates] == [
        "https://images.example/back.jpg",
        "https://images.example/probe.jpg",
    ]
    assert candidates[0]["art_kind"] == "other"
    assert candidates[0]["art_label"] == "Back"
    assert candidates[1]["thumbnail_url"] == "https://images.example/thumb.jpg"
    assert candidates[1]["width"] == 900
    assert candidates[1]["height"] == 900
    assert candidates[1]["art_kind"] == "cover"
    assert candidates[1]["art_label"] == "Front cover"
    assert stored == candidates


def test_cover_art_archive_emits_non_front_art_as_display_only_other_art():
    images = [
        {"front": False, "back": True, "image": "https://images.example/back.jpg", "width": 1000, "height": 1000},
        {"front": False, "types": ["Booklet"], "image": "https://images.example/booklet.jpg", "width": 1000, "height": 1000},
        {"front": False, "image": "https://images.example/other.jpg", "width": 1000, "height": 1000},
    ]

    candidates = cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        limit=3,
        normalize=_normalize,
        parse_year=_parse_year,
        match_score=_match_score,
        normalize_remote_image_url=lambda value: value,
        probe_candidate_metrics=lambda *_args, **_kwargs: None,
        http_get_json=lambda *_args, **_kwargs: {"images": images},
        http_get_json_via_curl=lambda *_args, **_kwargs: None,
        http_get_json_via_subprocess=lambda *_args, **_kwargs: None,
        get_caa_disk_cache=lambda _key: None,
        set_caa_disk_cache=lambda _key, _candidates: None,
        search_musicbrainz_release_candidates=lambda **_kwargs: [
            {"id": "release-1", "title": "Test Album", "artist-credit": [{"name": "Test Artist"}], "date": "2001"}
        ],
        log_event=lambda *_args, **_kwargs: None,
    )

    assert [candidate["art_kind"] for candidate in candidates] == ["other", "other", "other"]
    assert [candidate["art_label"] for candidate in candidates] == ["Back cover", "Booklet", "Other art"]


def test_cover_art_archive_fallback_order_primary_curl_subprocess():
    releases = [
        {"id": "primary", "title": "Test Album", "artist-credit": [{"name": "Test Artist"}], "date": "2001"},
        {"id": "curl", "title": "Test Album", "artist-credit": [{"name": "Test Artist"}], "date": "2001"},
        {"id": "subprocess", "title": "Test Album", "artist-credit": [{"name": "Test Artist"}], "date": "2001"},
    ]
    calls: list[tuple[str, str]] = []

    def payload_for(url, source):
        release_id = str(url).rsplit("/", 1)[-1]
        calls.append((source, release_id))
        if source == release_id:
            return {"images": [{"front": True, "image": f"https://images.example/{release_id}.jpg", "width": 800, "height": 800}]}
        return None

    candidates = cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        limit=3,
        normalize=_normalize,
        parse_year=_parse_year,
        match_score=_match_score,
        normalize_remote_image_url=lambda value: value,
        probe_candidate_metrics=lambda **_kwargs: None,
        http_get_json=lambda url, *_args, **_kwargs: payload_for(url, "primary"),
        http_get_json_via_curl=lambda url, *_args, **_kwargs: payload_for(url, "curl"),
        http_get_json_via_subprocess=lambda url, *_args, **_kwargs: payload_for(url, "subprocess"),
        get_caa_disk_cache=lambda _key: None,
        set_caa_disk_cache=lambda _key, _candidates: None,
        search_musicbrainz_release_candidates=lambda **_kwargs: releases,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert [candidate["release_mbid"] for candidate in candidates] == ["primary", "curl", "subprocess"]
    assert calls == [
        ("primary", "primary"),
        ("primary", "curl"),
        ("curl", "curl"),
        ("primary", "subprocess"),
        ("curl", "subprocess"),
        ("subprocess", "subprocess"),
    ]


def test_musicbrainz_config_enabled_false_does_not_disable_cover_lookup(monkeypatch):
    cover_provider_musicbrainz_caa.clear_musicbrainz_release_cache()
    monkeypatch.setattr(Config, "MUSICBRAINZ_ENABLED", False, raising=False)
    calls: list[str] = []

    releases = cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=None,
        user_agent="AlbumHavenTests/1.0",
        normalize=_normalize,
        http_get_json=lambda url, *_args, **_kwargs: calls.append(url) or {"releases": [{"id": "release-1"}]},
        get_disk_cache=lambda _key: None,
        set_disk_cache=lambda _key, _releases: None,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert releases == [{"id": "release-1"}]
    assert calls
