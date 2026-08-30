from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, wait
import re
import urllib.parse
from typing import TYPE_CHECKING

from music_app.services import cover_provider_apple
from music_app.services import cover_provider_bandcamp
from music_app.services import cover_provider_candidates
from music_app.services import cover_provider_deezer
from music_app.services import cover_provider_discogs
from music_app.services import cover_provider_fallback_web
from music_app.services import cover_provider_matching
from music_app.services import cover_provider_runtime
from music_app.services import cover_provider_spotify
from music_app.services import cover_provider_youtube_music
from music_app.services.runtime_shutdown import create_daemon_executor

if TYPE_CHECKING:
    from music_app.services.cover_provider_candidates import CoverCandidate


_MANUAL_URL_EXECUTOR = create_daemon_executor(
    max_workers=4,
    thread_name_prefix="albumhaven-cover-manual-url",
)


def _add_manual_cover_candidates_from_urls_sequential(
    raw_urls: list[str],
    *,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    user_agent: str,
    should_cancel: Callable[[], bool] | None = None,
) -> list[dict[str, object]]:
    candidates: list[CoverCandidate] = []
    for normalized_url in cover_provider_candidates.normalize_pasted_cover_urls(raw_urls):
        if callable(should_cancel) and should_cancel():
            return []
        split = urllib.parse.urlsplit(normalized_url)
        spotify_album_id = cover_provider_spotify.spotify_album_id_from_url(normalized_url)
        if spotify_album_id and cover_provider_spotify.spotify_api_enabled():
            expanded = cover_provider_runtime.spotify_candidates_from_album_url(
                normalized_url,
                target_artist=target_artist,
                target_album=target_album,
                target_edition=target_edition,
                target_year=target_year,
            )
            if callable(should_cancel) and should_cancel():
                return []
            candidates.extend(expanded)
            continue
        if "bandcamp.com" in split.netloc.casefold() and "/album/" in split.path.casefold():
            expanded = cover_provider_bandcamp.expand_bandcamp_album_url_candidates(
                normalized_url,
                target_artist=target_artist,
                target_album=target_album,
                target_edition=target_edition,
                target_year=target_year,
                user_agent=user_agent,
                http_get_text=cover_provider_runtime.http_get_text,
                match_score=cover_provider_matching.match_score,
                parse_year=cover_provider_matching.parse_year,
                extract_og_image=cover_provider_fallback_web.extract_og_image,
                extract_meta_content=cover_provider_apple.extract_apple_meta_content,
                probe_match_candidates=cover_provider_runtime.probe_match_candidates,
            )
            if callable(should_cancel) and should_cancel():
                return []
            candidates.extend(expanded)
            continue

        if "genius.com" in split.netloc.casefold() and "/albums/" in split.path.casefold():
            expanded = cover_provider_fallback_web.expand_manual_genius_album_url_candidates(
                normalized_url,
                target_artist=target_artist,
                target_album=target_album,
                target_edition=target_edition,
                target_year=target_year,
                user_agent=user_agent,
                http_get_text=cover_provider_runtime.http_get_text,
                match_score=cover_provider_matching.match_score,
                parse_year=cover_provider_matching.parse_year,
                probe_match_candidates=cover_provider_runtime.probe_match_candidates,
                extract_meta_content=cover_provider_apple.extract_apple_meta_content,
                extract_album_page_metadata=cover_provider_fallback_web.extract_genius_album_page_metadata,
                log_event=cover_provider_runtime.log_app_event,
                logger=cover_provider_runtime.LOGGER,
            )
            if callable(should_cancel) and should_cancel():
                return []
            candidates.extend(expanded)
            continue

        if "discogs.com" in split.netloc.casefold():
            discogs_candidates = cover_provider_discogs.expand_discogs_url_candidates(
                normalized_url,
                user_agent=user_agent,
                target_artist=target_artist,
                target_album=target_album,
                target_edition=target_edition,
                target_year=target_year,
                api_get_json=cover_provider_runtime.discogs_api_get_json,
                match_score=cover_provider_matching.match_score,
                parse_year=cover_provider_matching.parse_year,
                probe_match_candidates=cover_provider_runtime.probe_match_candidates,
                log_event=cover_provider_runtime.log_app_event,
                logger=cover_provider_runtime.LOGGER,
            )
            if callable(should_cancel) and should_cancel():
                return []
            if discogs_candidates is not None:
                candidates.extend(discogs_candidates)
                continue

        deezer_candidates = cover_provider_deezer.expand_deezer_album_url_candidates(
            normalized_url,
            user_agent=user_agent,
            target_artist=target_artist,
            target_album=target_album,
            target_edition=target_edition,
            target_year=target_year,
            http_get_json=cover_provider_runtime.http_get_json,
            match_score=cover_provider_matching.match_score,
            parse_year=cover_provider_matching.parse_year,
            probe_match_candidates=cover_provider_runtime.probe_match_candidates,
        )
        if callable(should_cancel) and should_cancel():
            return []
        if deezer_candidates is not None:
            candidates.extend(deezer_candidates)
            continue

        if "amazon." in split.netloc.casefold() and "/dp/" in split.path.casefold():
            expanded = cover_provider_fallback_web.expand_manual_amazon_product_url_candidates(
                normalized_url,
                target_artist=target_artist,
                target_album=target_album,
                target_edition=target_edition,
                target_year=target_year,
                user_agent=user_agent,
                http_get_text=cover_provider_runtime.http_get_text,
                extract_meta_content=cover_provider_apple.extract_apple_meta_content,
                match_score=cover_provider_matching.match_score,
                probe_match_candidates=cover_provider_runtime.probe_match_candidates,
                extract_image_candidates=cover_provider_fallback_web.extract_amazon_image_candidates,
            )
            if callable(should_cancel) and should_cancel():
                return []
            candidates.extend(expanded or [])
            continue

        if "music.youtube.com" in split.netloc.casefold():
            expanded = cover_provider_youtube_music.youtube_music_candidates_from_page_url(
                normalized_url,
                user_agent=user_agent,
                target_artist=target_artist,
                target_album=target_album,
                target_edition=target_edition,
                target_year=target_year,
                http_get_text=cover_provider_runtime.http_get_text,
                extract_meta_content=cover_provider_apple.extract_apple_meta_content,
                extract_og_image=cover_provider_fallback_web.extract_og_image,
                match_score=cover_provider_matching.match_score,
                parse_year=cover_provider_matching.parse_year,
                probe_match_candidates=cover_provider_runtime.probe_match_candidates,
            )
            if callable(should_cancel) and should_cancel():
                return []
            candidates.extend(expanded or [])
            continue

        if "music.apple.com" in split.netloc.casefold() or "itunes.apple.com" in split.netloc.casefold():
            expanded = cover_provider_apple.extract_manual_apple_candidates_from_url(
                normalized_url,
                user_agent=user_agent,
                target_artist=target_artist,
                target_album=target_album,
                target_edition=target_edition,
                target_year=target_year,
                http_get_text=cover_provider_runtime.http_get_text,
                match_score=cover_provider_matching.match_score,
                parse_year=cover_provider_matching.parse_year,
                probe_match_candidates=cover_provider_runtime.probe_match_candidates,
                extract_og_image=cover_provider_fallback_web.extract_og_image,
                album_name_in_alt=cover_provider_matching.album_name_in_alt,
            )
            if callable(should_cancel) and should_cancel():
                return []
            if expanded:
                candidates.extend(expanded)
            continue

        if re.search(r"\.(?:jpg|jpeg|png|webp)(?:$|[?#])", split.path, flags=re.IGNORECASE):
            expanded = cover_provider_fallback_web.expand_manual_direct_image_url_candidates(
                normalized_url,
                target_artist=target_artist,
                target_album=target_album,
                target_year=target_year,
                user_agent=user_agent,
                manual_source_details=cover_provider_candidates.manual_source_details,
                probe_match_candidates=cover_provider_runtime.probe_match_candidates,
            )
            if callable(should_cancel) and should_cancel():
                return []
            candidates.extend(expanded)
            continue

        expanded = cover_provider_fallback_web.expand_generic_manual_page_url_candidates(
            normalized_url,
            target_artist=target_artist,
            target_album=target_album,
            target_edition=target_edition,
            target_year=target_year,
            user_agent=user_agent,
            http_get_text=cover_provider_runtime.http_get_text,
            extract_meta_content=cover_provider_apple.extract_apple_meta_content,
            manual_source_details=cover_provider_candidates.manual_source_details,
            match_score=cover_provider_matching.match_score,
            parse_year=cover_provider_matching.parse_year,
            probe_match_candidates=cover_provider_runtime.probe_match_candidates,
            extract_og_image=cover_provider_fallback_web.extract_og_image,
        )
        if callable(should_cancel) and should_cancel():
            return []
        candidates.extend(expanded)
    if callable(should_cancel) and should_cancel():
        return []
    return cover_provider_candidates.build_manual_lookup_matches_from_candidates(
        candidates,
        build_matches=cover_provider_candidates.build_lookup_matches_from_candidates,
    )


def add_manual_cover_candidates_from_urls(
    raw_urls: list[str],
    *,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    user_agent: str,
    should_cancel: Callable[[], bool] | None = None,
) -> list[dict[str, object]]:
    normalized_urls = cover_provider_candidates.normalize_pasted_cover_urls(raw_urls)
    if callable(should_cancel) and should_cancel():
        return []
    if len(normalized_urls) <= 1:
        return _add_manual_cover_candidates_from_urls_sequential(
            normalized_urls,
            target_artist=target_artist,
            target_album=target_album,
            target_edition=target_edition,
            target_year=target_year,
            user_agent=user_agent,
            should_cancel=should_cancel,
        )

    futures = [
        _MANUAL_URL_EXECUTOR.submit(
            _add_manual_cover_candidates_from_urls_sequential,
            [normalized_url],
            target_artist=target_artist,
            target_album=target_album,
            target_edition=target_edition,
            target_year=target_year,
            user_agent=user_agent,
            should_cancel=should_cancel,
        )
        for normalized_url in normalized_urls
    ]
    matches: list[dict[str, object]] = []
    pending = set(futures)
    while pending:
        if callable(should_cancel) and should_cancel():
            for future in pending:
                future.cancel()
            break
        completed, pending = wait(
            pending,
            timeout=0.05,
            return_when=FIRST_COMPLETED,
        )
        for future in completed:
            matches.extend(
                match
                for match in future.result()
                if isinstance(match, dict)
            )
    deduped: list[dict[str, object]] = []
    seen_urls: set[str] = set()
    for match in sorted(
        matches,
        key=lambda item: (
            -float(item.get("score") or 0.0),
            -(
                int(item.get("width") or 0)
                * int(item.get("height") or 0)
            ),
            str(item.get("url") or ""),
        ),
    ):
        normalized_url = str(match.get("url") or "").strip().casefold()
        if not normalized_url or normalized_url in seen_urls:
            continue
        seen_urls.add(normalized_url)
        deduped.append(match)
    return deduped
