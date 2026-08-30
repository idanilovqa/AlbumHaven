from __future__ import annotations

from threading import Event, Thread
import time

from music_app.services import cover_provider_apple
from music_app.services import cover_provider_fallback_web
from music_app.services import cover_provider_matching
from music_app.services.cover_provider_candidates import CoverCandidate


def _logger():
    return type("Logger", (), {"verbose": lambda self, *args, **kwargs: None})()


def _probe_from_matches(**kwargs) -> list[CoverCandidate]:
    candidates: list[CoverCandidate] = []
    for score, url, meta in kwargs["matches"]:
        candidates.append(
            CoverCandidate(
                source=kwargs["source"],
                url=url,
                score=score,
                width=1200,
                height=1200,
                matched_artist=str(meta.get("artist") or ""),
                matched_album=str(meta.get("album") or ""),
                matched_year=meta.get("year") if isinstance(meta.get("year"), int) else None,
                debug_payload={
                    **meta,
                    "query_mode": kwargs["query_mode"],
                    "probed_contenders": [{"url": url, "status": "ok"}],
                },
            )
        )
    return candidates


def test_candidate_url_upgrades_mid_size_bcbits_images():
    from music_app.services import cover_provider_bandcamp as bandcamp

    assert bandcamp.bandcamp_candidate_url("https://f4.bcbits.com/img/a123_5.jpg") == "https://f4.bcbits.com/img/a123_10.jpg"
    assert bandcamp.bandcamp_candidate_url("https://f4.bcbits.com/img/a123_10.jpg") == "https://f4.bcbits.com/img/a123_10.jpg"
    assert bandcamp.bandcamp_candidate_url("") is None


def test_client_challenge_detection_matches_current_bandcamp_markers():
    from music_app.services import cover_provider_bandcamp as bandcamp

    assert bandcamp.bandcamp_client_challenge_detected("<title>Client Challenge</title>") is True
    assert bandcamp.bandcamp_client_challenge_detected('<script src="/_fs-ch-abc.js"></script>') is True
    assert bandcamp.bandcamp_client_challenge_detected("JavaScript is disabled in your browser") is True
    assert bandcamp.bandcamp_client_challenge_detected("<html>normal album page</html>") is False


def test_slug_variants_include_edition_and_two_to_variants():
    from music_app.services import cover_provider_bandcamp as bandcamp

    assert bandcamp._bandcamp_album_slug_variants("2 Hearts", "Deluxe Edition") == [
        "2-hearts-deluxe-edition",
        "the-2-hearts-deluxe-edition",
        "to-hearts-deluxe-edition",
        "the-to-hearts-deluxe-edition",
    ]
    assert bandcamp._bandcamp_album_slug_variants("Road to Home", None) == [
        "road-to-home",
        "the-road-to-home",
        "road-2-home",
        "the-road-2-home",
    ]
    assert bandcamp._bandcamp_album_url_matches_title(
        "https://artist.bandcamp.com/album/2-hearts-deluxe-edition",
        "2 Hearts",
        "Deluxe Edition",
    )


def test_direct_artist_account_match_returns_before_catalog_probe():
    from music_app.services import cover_provider_bandcamp as bandcamp

    html_by_url = {
        "https://testartist.bandcamp.com/": '<a href="/album/test-album">Test Album</a>',
        "https://testartist.bandcamp.com/artists": "<html></html>",
        "https://testartist.bandcamp.com/album/test-album": """
            <meta property="og:title" content="Test Album | Test Artist">
            <meta property="og:description" content="Test Album by Test Artist">
            <meta property="og:image" content="https://f4.bcbits.com/img/a123_5.jpg">
            released January 1, 2001
        """,
    }
    events: list[dict[str, object]] = []
    calls: list[str] = []

    candidates = bandcamp.search_bandcamp_cover_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        http_get_text=lambda url, *args, **kwargs: calls.append(url) or html_by_url.get(url),
        match_score=lambda **kwargs: 0.93,
        similarity=lambda left, right: 1.0 if left and right else 0.0,
        normalize=cover_provider_matching.normalize,
        parse_year=cover_provider_matching.parse_year,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        probe_match_candidates=_probe_from_matches,
        dedupe_candidates=lambda items: items,
        fetch_musicbrainz_bandcamp_context=lambda *args, **kwargs: {
            "artists": ["Test Artist"],
            "labels": ["Test Label"],
            "artist_account_urls": [],
            "label_account_urls": [],
        },
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=_logger(),
    )

    assert "https://testartist.bandcamp.com/" not in calls
    assert "https://testartist.bandcamp.com/album/test-album" in calls
    assert candidates[0].url == "https://f4.bcbits.com/img/a123_10.jpg"
    assert candidates[0].debug_payload["variant"] == "direct-account"
    assert candidates[0].debug_payload["album_url"] == "https://testartist.bandcamp.com/album/test-album"
    assert not any(event["action"] == "Bandcamp account catalog probed" for event in events)
    assert any(event["action"] == "Bandcamp account album matched" for event in events)


def test_artist_plural_and_missing_album_article_find_bandcamp_account():
    from music_app.services import cover_provider_bandcamp as bandcamp

    html_by_url = {
        "https://flamingrow.bandcamp.com/": (
            '<a href="/album/the-pure-shine">The Pure Shine</a>'
        ),
        "https://flamingrow.bandcamp.com/artists": "<html></html>",
        "https://flamingrow.bandcamp.com/album/the-pure-shine": """
            <meta property="og:title" content="The Pure Shine | Flaming Row">
            <meta property="og:description" content="The Pure Shine by Flaming Row">
            <meta property="og:image" content="https://f4.bcbits.com/img/a987_5.jpg">
            released December 10, 2019
        """,
    }
    calls: list[str] = []

    candidates = bandcamp.search_bandcamp_cover_candidates(
        "Flaming Rows",
        "Pure Shine",
        None,
        2019,
        "AlbumHavenTests/1.0",
        http_get_text=lambda url, *args, **kwargs: calls.append(url) or html_by_url.get(url),
        match_score=cover_provider_matching.match_score,
        similarity=cover_provider_matching.similarity,
        normalize=cover_provider_matching.normalize,
        parse_year=cover_provider_matching.parse_year,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        probe_match_candidates=_probe_from_matches,
        dedupe_candidates=lambda items: items,
        fetch_musicbrainz_bandcamp_context=lambda *args, **kwargs: {
            "artists": [],
            "labels": [],
            "artist_account_urls": [],
            "label_account_urls": [],
        },
        log_event=None,
        logger=_logger(),
    )

    assert "https://flamingrow.bandcamp.com/" not in calls
    assert "https://flamingrow.bandcamp.com/album/the-pure-shine" in calls
    assert len(candidates) == 1
    assert candidates[0].matched_artist == "Flaming Row"
    assert candidates[0].matched_album == "The Pure Shine"


def test_bandcamp_roster_uses_shared_identity_and_rejects_marker_mismatch():
    from music_app.services import cover_provider_bandcamp as bandcamp

    assert bandcamp._bandcamp_artist_roster_matches(
        "Morse, Portnoy & George",
        ["Morse Portnoy George"],
        similarity=lambda _target, _candidate: 0.1,
    )
    assert not bandcamp._bandcamp_artist_roster_matches(
        "Morse, Portnoy & George",
        ["Morse Portnoy George Tribute"],
        similarity=lambda _target, _candidate: 0.99,
    )


def test_bandcamp_direct_and_label_accounts_do_not_use_plural_escape_for_other_artists():
    from music_app.services import cover_provider_bandcamp as bandcamp

    album_html = """
        <meta property="og:title" content="The Album | The Signal">
        <meta property="og:description" content="The Album by The Signal">
        <meta property="og:image" content="https://f4.bcbits.com/img/a555_5.jpg">
        released January 1, 2001
    """

    for album_url, context in (
        (
            "https://thesignals.bandcamp.com/album/the-album",
            {
                "artists": [],
                "labels": [],
                "artist_account_urls": [],
                "label_account_urls": [],
            },
        ),
        (
            "https://testlabel.bandcamp.com/album/the-album",
            {
                "artists": [],
                "labels": ["Test Label"],
                "artist_account_urls": [],
                "label_account_urls": ["https://testlabel.bandcamp.com/"],
            },
        ),
    ):
        candidates = bandcamp.search_bandcamp_cover_candidates(
            "The Signals",
            "The Album",
            None,
            2001,
            "AlbumHavenTests/1.0",
            http_get_text=lambda url, *_args, **_kwargs: (
                album_html if url == album_url else None
            ),
            match_score=cover_provider_matching.match_score,
            similarity=lambda _target, _candidate: 0.99,
            normalize=cover_provider_matching.normalize,
            parse_year=cover_provider_matching.parse_year,
            extract_og_image=cover_provider_fallback_web.extract_og_image,
            extract_meta_content=cover_provider_apple.extract_apple_meta_content,
            probe_match_candidates=_probe_from_matches,
            dedupe_candidates=lambda items: items,
            fetch_musicbrainz_bandcamp_context=lambda *_args, **_kwargs: context,
            log_event=None,
            logger=_logger(),
        )

        assert candidates == [], album_url


def test_musicbrainz_label_account_finds_morse_portnoy_george_without_catalog_crawl():
    from music_app.services import cover_provider_bandcamp as bandcamp

    album_url = "https://insideoutmusic.bandcamp.com/album/cover-to-cover"
    calls: list[str] = []
    html_by_url = {
        album_url: """
            <meta property="og:title" content="Cover To Cover | Morse/Portnoy/George">
            <meta property="og:description" content="Cover To Cover by Morse/Portnoy/George">
            <meta property="og:image" content="https://f4.bcbits.com/img/a193_5.jpg">
            released July 24, 2020
        """,
    }

    candidates = bandcamp.search_bandcamp_cover_candidates(
        "Morse, Portnoy & George",
        "Cover To Cover",
        None,
        2006,
        "AlbumHavenTests/1.0",
        http_get_text=lambda url, *args, **kwargs: calls.append(url) or html_by_url.get(url),
        match_score=cover_provider_matching.match_score,
        similarity=cover_provider_matching.similarity,
        normalize=cover_provider_matching.normalize,
        parse_year=cover_provider_matching.parse_year,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        probe_match_candidates=_probe_from_matches,
        dedupe_candidates=lambda items: items,
        fetch_musicbrainz_bandcamp_context=lambda *args, **kwargs: {
            "artists": ["Morse Portnoy George"],
            "labels": ["Inside Out Music"],
            "artist_account_urls": [],
            "label_account_urls": ["https://insideoutmusic.bandcamp.com/"],
        },
        log_event=None,
        logger=_logger(),
    )

    assert [candidate.debug_payload["album_url"] for candidate in candidates] == [album_url]
    assert album_url in calls
    assert "https://insideoutmusic.bandcamp.com/" not in calls
    assert "https://insideoutmusic.bandcamp.com/artists" not in calls
    assert all("unrelated" not in url for url in calls)


def test_direct_bandcamp_discovery_does_not_wait_for_musicbrainz_context():
    from music_app.services import cover_provider_bandcamp as bandcamp

    context_started = Event()
    release_context = Event()
    album_url = "https://flamingrow.bandcamp.com/album/the-pure-shine"

    def fetch_context(*_args, **_kwargs):
        context_started.set()
        release_context.wait(2)
        return {
            "artists": [],
            "labels": [],
            "artist_account_urls": [],
            "label_account_urls": [],
        }

    def http_get_text(url, *_args, **_kwargs):
        if url != album_url:
            return None
        return """
            <meta property="og:title" content="The Pure Shine | Flaming Row">
            <meta property="og:description" content="The Pure Shine by Flaming Row">
            <meta property="og:image" content="https://f4.bcbits.com/img/a987_5.jpg">
            released December 10, 2019
        """

    started_at = time.perf_counter()
    try:
        candidates = bandcamp.search_bandcamp_cover_candidates(
            "Flaming Rows",
            "Pure Shine",
            None,
            2019,
            "AlbumHavenTests/1.0",
            http_get_text=http_get_text,
            match_score=cover_provider_matching.match_score,
            similarity=cover_provider_matching.similarity,
            normalize=cover_provider_matching.normalize,
            parse_year=cover_provider_matching.parse_year,
            extract_og_image=cover_provider_fallback_web.extract_og_image,
            extract_meta_content=cover_provider_apple.extract_apple_meta_content,
            probe_match_candidates=_probe_from_matches,
            dedupe_candidates=lambda items: items,
            fetch_musicbrainz_bandcamp_context=fetch_context,
            log_event=None,
            logger=_logger(),
        )
        elapsed_seconds = time.perf_counter() - started_at
    finally:
        release_context.set()

    assert context_started.is_set()
    assert elapsed_seconds < 0.5
    assert [candidate.debug_payload["album_url"] for candidate in candidates] == [album_url]


def test_direct_bandcamp_match_does_not_wait_for_blocked_musicbrainz_linked_probe():
    from music_app.services import cover_provider_bandcamp as bandcamp

    linked_probe_started = Event()
    release_linked_probe = Event()
    search_done = Event()
    direct_album_url = "https://raceartist.bandcamp.com/album/race-album"
    linked_album_url = "https://slowlabel.bandcamp.com/album/race-album"
    results: list[list[CoverCandidate]] = []
    errors: list[BaseException] = []

    def fetch_context(*_args, **_kwargs):
        return {
            "artists": ["Race Artist"],
            "labels": ["Slow Label"],
            "artist_account_urls": [],
            "label_account_urls": ["https://slowlabel.bandcamp.com"],
        }

    def http_get_text(url, *_args, **_kwargs):
        if url == linked_album_url:
            linked_probe_started.set()
            release_linked_probe.wait(2)
            return None
        if url == direct_album_url:
            assert linked_probe_started.wait(0.5)
            return """
                <meta property="og:title" content="Race Album | Race Artist">
                <meta property="og:description" content="Race Album by Race Artist">
                <meta property="og:image" content="https://f4.bcbits.com/img/a2468_5.jpg">
                released January 1, 2001
            """
        return None

    def run_search() -> None:
        try:
            results.append(
                bandcamp.search_bandcamp_cover_candidates(
                    "Race Artist",
                    "Race Album",
                    None,
                    2001,
                    "AlbumHavenTests/1.0",
                    http_get_text=http_get_text,
                    match_score=cover_provider_matching.match_score,
                    similarity=cover_provider_matching.similarity,
                    normalize=cover_provider_matching.normalize,
                    parse_year=cover_provider_matching.parse_year,
                    extract_og_image=cover_provider_fallback_web.extract_og_image,
                    extract_meta_content=cover_provider_apple.extract_apple_meta_content,
                    probe_match_candidates=_probe_from_matches,
                    dedupe_candidates=lambda items: items,
                    fetch_musicbrainz_bandcamp_context=fetch_context,
                    log_event=None,
                    logger=_logger(),
                )
            )
        except BaseException as exc:
            errors.append(exc)
        finally:
            search_done.set()

    search_thread = Thread(target=run_search, daemon=True)
    search_thread.start()
    try:
        assert linked_probe_started.wait(0.5)
        assert search_done.wait(0.5), (
            "Bandcamp search blocked on a MusicBrainz-linked account after its parallel direct account matched"
        )
    finally:
        release_linked_probe.set()
        search_thread.join(2)

    assert not errors
    assert len(results) == 1
    assert [candidate.debug_payload["album_url"] for candidate in results[0]] == [direct_album_url]


def test_bandcamp_search_observes_cancellation_while_discovery_futures_are_blocked():
    from music_app.services import cover_provider_bandcamp as bandcamp

    musicbrainz_started = Event()
    direct_probe_started = Event()
    release_discovery = Event()
    cancel_search = Event()
    search_done = Event()
    results: list[list[CoverCandidate]] = []
    errors: list[BaseException] = []

    def fetch_context(*_args, **_kwargs):
        musicbrainz_started.set()
        release_discovery.wait(2)
        return {
            "artists": [],
            "labels": [],
            "artist_account_urls": [],
            "label_account_urls": [],
        }

    def http_get_text(_url, *_args, **_kwargs):
        direct_probe_started.set()
        release_discovery.wait(2)
        return None

    def run_search() -> None:
        try:
            results.append(
                bandcamp.search_bandcamp_cover_candidates(
                    "Blocked Artist",
                    "Blocked Album",
                    None,
                    2001,
                    "AlbumHavenTests/1.0",
                    http_get_text=http_get_text,
                    match_score=cover_provider_matching.match_score,
                    similarity=cover_provider_matching.similarity,
                    normalize=cover_provider_matching.normalize,
                    parse_year=cover_provider_matching.parse_year,
                    extract_og_image=cover_provider_fallback_web.extract_og_image,
                    extract_meta_content=cover_provider_apple.extract_apple_meta_content,
                    probe_match_candidates=_probe_from_matches,
                    dedupe_candidates=lambda items: items,
                    fetch_musicbrainz_bandcamp_context=fetch_context,
                    should_cancel=cancel_search.is_set,
                    log_event=None,
                    logger=_logger(),
                )
            )
        except BaseException as exc:
            errors.append(exc)
        finally:
            search_done.set()

    search_thread = Thread(target=run_search, daemon=True)
    search_thread.start()
    try:
        assert musicbrainz_started.wait(0.5)
        assert direct_probe_started.wait(0.5)

        cancel_search.set()

        assert search_done.wait(0.5), "Bandcamp search ignored cancellation while discovery futures were blocked"
    finally:
        release_discovery.set()
        search_thread.join(2)

    assert not errors
    assert results == [[]]


def test_musicbrainz_failure_does_not_suppress_direct_bandcamp_match():
    from music_app.services import cover_provider_bandcamp as bandcamp

    direct_probe_started = Event()
    album_url = "https://flamingrow.bandcamp.com/album/the-pure-shine"

    def fail_context(*_args, **_kwargs):
        assert direct_probe_started.wait(0.5)
        raise RuntimeError("MusicBrainz unavailable")

    def http_get_text(url, *_args, **_kwargs):
        if url != album_url:
            return None
        direct_probe_started.set()
        time.sleep(0.02)
        return """
            <meta property="og:title" content="The Pure Shine | Flaming Row">
            <meta property="og:description" content="The Pure Shine by Flaming Row">
            <meta property="og:image" content="https://f4.bcbits.com/img/a987_5.jpg">
            released December 10, 2019
        """

    candidates = bandcamp.search_bandcamp_cover_candidates(
        "Flaming Rows",
        "Pure Shine",
        None,
        2019,
        "AlbumHavenTests/1.0",
        http_get_text=http_get_text,
        match_score=cover_provider_matching.match_score,
        similarity=cover_provider_matching.similarity,
        normalize=cover_provider_matching.normalize,
        parse_year=cover_provider_matching.parse_year,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        probe_match_candidates=_probe_from_matches,
        dedupe_candidates=lambda items: items,
        fetch_musicbrainz_bandcamp_context=fail_context,
        log_event=None,
        logger=_logger(),
    )

    assert [candidate.debug_payload["album_url"] for candidate in candidates] == [album_url]


def test_rejection_paths_skip_bad_bandcamp_account_album_pages():
    from music_app.services import cover_provider_bandcamp as bandcamp

    html_by_url = {
        "https://testartist.bandcamp.com/": '<a href="/album/wrong-album">Wrong</a><a href="/album/test-album">Test Album</a>',
        "https://testartist.bandcamp.com/artists": '<li><a href="/other">Other Artist</a></li>',
        "https://testartist.bandcamp.com/album/wrong-album": """
            <meta property="og:title" content="Wrong Album | Other Artist">
            <meta property="og:description" content="Wrong Album by Other Artist">
        """,
        "https://testartist.bandcamp.com/album/test-album": """
            <meta property="og:title" content="Test Album | Other Artist">
            <meta property="og:description" content="Test Album by Other Artist">
        """,
        "https://testlabel.bandcamp.com/": '<a href="/album/test-album">Test Album</a>',
        "https://testlabel.bandcamp.com/artists": "client challenge",
        "https://testlabel.bandcamp.com/album/test-album": """
            <meta property="og:title" content="Test Album | Test Artist">
            <meta property="og:description" content="Test Album by Test Artist">
            <meta property="og:image" content="https://f4.bcbits.com/img/a123_5.jpg">
        """,
    }
    events: list[dict[str, object]] = []

    candidates = bandcamp.search_bandcamp_cover_candidates(
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        http_get_text=lambda url, *args, **kwargs: html_by_url.get(url),
        match_score=lambda **kwargs: 0.0 if kwargs["candidate_artist"] == "Test Artist" else 0.8,
        similarity=lambda left, right: 0.2,
        normalize=cover_provider_matching.normalize,
        parse_year=cover_provider_matching.parse_year,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        probe_match_candidates=_probe_from_matches,
        dedupe_candidates=lambda items: items,
        fetch_musicbrainz_bandcamp_context=lambda *args, **kwargs: {
            "artists": ["Test Artist"],
            "labels": ["Test Label"],
            "artist_account_urls": [],
            "label_account_urls": [],
        },
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=_logger(),
    )

    assert candidates == []
    rejection_reasons = {
        str(event.get("reason"))
        for event in events
        if event.get("action") == "Bandcamp account album rejected"
    }
    assert {"album_slug_mismatch", "roster_mismatch", "match_score_non_positive"} <= rejection_reasons
    assert any(event["action"] == "Bandcamp direct account guesses exhausted" for event in events)


def test_direct_album_slug_does_not_override_rejected_artist_identity():
    from music_app.services import cover_provider_bandcamp as bandcamp

    html_by_url = {
        "https://metallica.bandcamp.com/": "<html></html>",
        "https://metallica.bandcamp.com/artists": "<html></html>",
        "https://metallica.bandcamp.com/album/kill-em-all": """
            <meta property="og:title" content="Kill 'Em All | Metallica Orchestra">
            <meta property="og:image" content="https://f4.bcbits.com/img/a123_5.jpg">
            released July 25, 1983
        """,
    }

    candidates = bandcamp.search_bandcamp_cover_candidates(
        "Metallica",
        "Kill 'Em All",
        None,
        1983,
        "AlbumHavenTests/1.0",
        http_get_text=lambda url, *args, **kwargs: html_by_url.get(url),
        match_score=cover_provider_matching.match_score,
        similarity=cover_provider_matching.similarity,
        normalize=cover_provider_matching.normalize,
        parse_year=cover_provider_matching.parse_year,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        probe_match_candidates=_probe_from_matches,
        dedupe_candidates=lambda items: items,
        fetch_musicbrainz_bandcamp_context=lambda *args, **kwargs: {
            "artists": [],
            "labels": [],
            "artist_account_urls": [],
            "label_account_urls": [],
        },
        log_event=None,
        logger=_logger(),
    )

    assert candidates == []


def test_manual_pasted_bandcamp_album_url_expands_to_candidate():
    from music_app.services import cover_provider_bandcamp as bandcamp

    candidates = bandcamp.expand_bandcamp_album_url_candidates(
        "https://testartist.bandcamp.com/album/test-album?from=search",
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        user_agent="AlbumHavenTests/1.0",
        http_get_text=lambda url, *args, **kwargs: """
            <meta property="og:title" content="Test Album | Bandcamp">
            <meta property="og:description" content="Test Album by Test Artist. Released 2001.">
            <meta property="og:image" content="https://f4.bcbits.com/img/a123_5.jpg">
        """,
        match_score=lambda **kwargs: 0.91,
        parse_year=cover_provider_matching.parse_year,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        probe_match_candidates=_probe_from_matches,
    )

    assert len(candidates) == 1
    assert candidates[0].url == "https://f4.bcbits.com/img/a123_10.jpg"
    assert candidates[0].debug_payload["query_mode"] == "manual-url"
    assert candidates[0].debug_payload["variant"] == "manual-url"
    assert candidates[0].debug_payload["album_url"] == "https://testartist.bandcamp.com/album/test-album?from=search"
