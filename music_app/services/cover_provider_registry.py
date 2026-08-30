from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import wait
from dataclasses import dataclass
import time

from music_app.services import cover_manual_links
from music_app.services import cover_provider_bandcamp
from music_app.services import cover_provider_discogs
from music_app.services import cover_provider_fallback_web
from music_app.services import cover_provider_cache
from music_app.services import cover_provider_matching
from music_app.services import cover_provider_musicbrainz_caa
from music_app.services import cover_provider_apple
from music_app.services import cover_provider_runtime
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    CURRENT_USE_LOOKUP_MATCH_FIELDS,
    build_lookup_matches_from_candidates,
    normalize_remote_image_url,
    current_use_lookup_match_payload,
)
from music_app.services.cover_provider_diagnostics import (
    log_provider_completed,
    log_provider_failed,
    log_provider_skipped,
    log_provider_started,
)
from music_app.services.cover_provider_deadline import (
    DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS,
    compose_provider_stop_predicate,
    cover_lookup_provider_deadline_at,
    cover_lookup_provider_deadline_seconds,
)
from music_app.services.cover_provider_groups import (
    COVER_LOOKUP_PROVIDER_GROUP_NAMES,
    cover_provider_group_enabled,
    normalize_enabled_music_services,
)
from music_app.services.runtime_shutdown import create_daemon_executor


_CURRENT_USE_CAA_LOOKUP_MATCH_FIELDS = CURRENT_USE_LOOKUP_MATCH_FIELDS - {"debug"}
_LATER_PROVIDER_EXECUTOR = create_daemon_executor(
    max_workers=8,
    thread_name_prefix="albumhaven-cover-later-provider",
)


@dataclass(frozen=True, slots=True)
class CoverLookupProviderQuery:
    artist: str
    album: str
    edition: str | None
    year: int | None
    user_agent: str
    enabled_provider_groups: object = None
    enabled_music_services: object = None


class CoverLookupProviderRegistry:
    provider_group_names = list(COVER_LOOKUP_PROVIDER_GROUP_NAMES)

    def search_music_service_matches(
        self,
        query: CoverLookupProviderQuery,
        *,
        manual_urls: list[str] | None = None,
        should_cancel: Callable[[], bool] | None = None,
        deadline_at: float | None = None,
        enabled_services: list[str] | tuple[str, ...] | set[str] | None = None,
        log_event: Callable[..., object] | None = None,
        on_candidates: Callable[[list[dict[str, object]]], None] | None = None,
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        active_should_cancel = (
            compose_provider_stop_predicate(should_cancel, deadline_at)
            if deadline_at is not None
            else should_cancel
        )
        service_candidates = []
        if cover_provider_group_enabled(query.enabled_provider_groups, "music_services"):
            effective_enabled_services = (
                query.enabled_music_services
                if enabled_services is None
                else enabled_services
            )
            service_search_kwargs = {
                "allow_apple_web_fallback": True,
                "should_cancel": active_should_cancel,
                "enabled_services": effective_enabled_services,
                "log_event": log_event,
            }
            if callable(on_candidates):
                service_search_kwargs["on_candidates"] = on_candidates
            service_candidates = _search_service_cover_candidates(
                artist=query.artist,
                album=query.album,
                edition=query.edition,
                year=query.year,
                user_agent=query.user_agent,
                **service_search_kwargs,
            )
        manual_candidates = (
            cover_manual_links.add_manual_cover_candidates_from_urls(
                manual_urls or [],
                target_artist=query.artist,
                target_album=query.album,
                target_edition=query.edition,
                target_year=query.year,
                user_agent=query.user_agent,
                should_cancel=active_should_cancel,
            )
            if (
                manual_urls
                and cover_provider_group_enabled(query.enabled_provider_groups, "manual_urls")
                and not (callable(active_should_cancel) and active_should_cancel())
            )
            else []
        )
        return service_candidates, manual_candidates

    def search_bandcamp_matches(
        self,
        query: CoverLookupProviderQuery,
        *,
        should_cancel: Callable[[], bool] | None = None,
        deadline_at: float | None = None,
        log_event: Callable[..., object] | None = None,
    ) -> list[dict[str, object]]:
        active_should_cancel = (
            compose_provider_stop_predicate(should_cancel, deadline_at)
            if deadline_at is not None
            else should_cancel
        )
        if (
            not cover_provider_group_enabled(query.enabled_provider_groups, "bandcamp")
            or (callable(active_should_cancel) and active_should_cancel())
        ):
            return []
        candidates = cover_provider_bandcamp.search_bandcamp_cover_candidates(
            artist=query.artist,
            album=query.album,
            edition=query.edition,
            year=query.year,
            user_agent=query.user_agent,
            http_get_text=cover_provider_runtime.http_get_text,
            match_score=cover_provider_matching.match_score,
            similarity=cover_provider_matching.similarity,
            normalize=cover_provider_matching.normalize,
            parse_year=cover_provider_matching.parse_year,
            extract_og_image=cover_provider_fallback_web.extract_og_image,
            extract_meta_content=cover_provider_apple.extract_apple_meta_content,
            probe_match_candidates=cover_provider_runtime.probe_match_candidates,
            fetch_musicbrainz_bandcamp_context=cover_provider_runtime.fetch_musicbrainz_bandcamp_context,
            should_cancel=active_should_cancel,
            canonical_album_title=cover_provider_matching.canonical_album_title,
            dedupe_candidates=cover_provider_matching.dedupe_candidates,
            log_event=log_event or cover_provider_runtime.log_app_event,
            logger=cover_provider_runtime.LOGGER,
        )
        if callable(active_should_cancel) and active_should_cancel():
            return []
        return build_lookup_matches_from_candidates(candidates, lookup_group="services")

    def search_discogs_and_cover_art_archive_matches(
        self,
        query: CoverLookupProviderQuery,
        *,
        include_discogs: bool = True,
        include_cover_art_archive: bool = True,
        should_cancel: Callable[[], bool] | None = None,
        deadline_at: float | None = None,
        log_event: Callable[..., object] | None = None,
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        configured_deadline_seconds = cover_lookup_provider_deadline_seconds(
            cover_provider_runtime.Config
        )
        if (
            deadline_at is None
            and configured_deadline_seconds
            != DEFAULT_COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS
        ):
            deadline_at = cover_lookup_provider_deadline_at(cover_provider_runtime.Config)
        active_should_cancel = (
            compose_provider_stop_predicate(should_cancel, deadline_at)
            if deadline_at is not None
            else should_cancel
        )
        if callable(active_should_cancel) and active_should_cancel():
            return [], []
        include_discogs = include_discogs and cover_provider_group_enabled(
            query.enabled_provider_groups,
            "discogs",
        )
        include_cover_art_archive = include_cover_art_archive and cover_provider_group_enabled(
            query.enabled_provider_groups,
            "cover_art_archive",
        )
        archive_candidates: list[dict[str, object]] = []
        discogs_candidates: list[dict[str, object]] = []
        app_log_event = log_event or cover_provider_runtime.log_app_event
        caa_future = (
            _LATER_PROVIDER_EXECUTOR.submit(
                    cover_provider_musicbrainz_caa.search_cover_art_archive_candidates,
                    artist=query.artist,
                    album=query.album,
                    edition=query.edition,
                    year=query.year,
                    user_agent=query.user_agent,
                    limit=8,
                    normalize=cover_provider_matching.normalize,
                    parse_year=cover_provider_matching.parse_year,
                    match_score=cover_provider_matching.match_score,
                    normalize_remote_image_url=normalize_remote_image_url,
                    probe_candidate_metrics=cover_provider_runtime.probe_candidate_metrics,
                    http_get_json=cover_provider_runtime.http_get_json,
                    http_get_json_via_curl=cover_provider_runtime.http_get_json_via_curl,
                    http_get_json_via_subprocess=cover_provider_runtime.http_get_json_via_subprocess,
                    get_caa_disk_cache=cover_provider_cache._get_caa_results_disk_cache,
                    set_caa_disk_cache=cover_provider_cache._set_caa_results_disk_cache,
                    search_musicbrainz_release_candidates=lambda **kwargs: (
                        cover_provider_runtime.search_musicbrainz_release_candidates(
                            **kwargs,
                            should_cancel=active_should_cancel,
                        )
                    ),
                    should_cancel=active_should_cancel,
                    log_event=app_log_event,
                )
                if include_cover_art_archive
                else None
            )
        discogs_future = (
            _LATER_PROVIDER_EXECUTOR.submit(
                    cover_provider_discogs.search_discogs_cover_candidates,
                    artist=query.artist,
                    album=query.album,
                    edition=query.edition,
                    year=query.year,
                    user_agent=query.user_agent,
                    build_query_variants=cover_provider_matching.build_query_variants,
                    match_score=cover_provider_matching.match_score,
                    parse_year=cover_provider_matching.parse_year,
                    probe_match_candidates=cover_provider_runtime.probe_match_candidates,
                    api_get_json=cover_provider_runtime.discogs_api_get_json,
                    log_event=app_log_event,
                    logger=cover_provider_runtime.LOGGER,
                    config=cover_provider_runtime.Config,
                    should_cancel=active_should_cancel,
                )
                if include_discogs
                else None
            )
        futures = [future for future in (caa_future, discogs_future) if future is not None]
        wait_timeout = None
        if deadline_at is not None:
            wait_timeout = max(0.0, deadline_at - time.perf_counter()) + 0.05
        completed_futures, incomplete_futures = wait(futures, timeout=wait_timeout)
        for future in completed_futures:
            if future is caa_future:
                archive_candidates = [
                    _cover_art_archive_candidate_to_lookup_match(item)
                    for item in (future.result() or [])
                    if isinstance(item, dict)
                ]
            elif future is discogs_future:
                discogs_candidates = future.result() or []
        for future in incomplete_futures:
            future.cancel()
        return discogs_candidates, archive_candidates

    def search_artist_website_matches(
        self,
        query: CoverLookupProviderQuery,
        *,
        should_cancel: Callable[[], bool] | None = None,
        deadline_at: float | None = None,
        log_event: Callable[..., object] | None = None,
    ) -> list[dict[str, object]]:
        active_should_cancel = (
            compose_provider_stop_predicate(should_cancel, deadline_at)
            if deadline_at is not None
            else should_cancel
        )
        if (
            not cover_provider_group_enabled(query.enabled_provider_groups, "artist_website_fallback")
            or (callable(active_should_cancel) and active_should_cancel())
        ):
            return []
        candidates = cover_provider_fallback_web.search_artist_website_candidates(
            artist=query.artist,
            album=query.album,
            edition=query.edition,
            year=query.year,
            user_agent=query.user_agent,
            http_get_text=cover_provider_runtime.http_get_text,
            http_get_json=cover_provider_runtime.http_get_json,
            extract_meta_content=cover_provider_apple.extract_apple_meta_content,
            match_score=cover_provider_matching.match_score,
            parse_year=cover_provider_matching.parse_year,
            probe_match_candidates=cover_provider_runtime.probe_match_candidates,
            dedupe_candidates=cover_provider_matching.dedupe_candidates,
            similarity=cover_provider_matching.similarity,
            log_event=log_event or cover_provider_runtime.log_app_event,
            logger=cover_provider_runtime.LOGGER,
            extract_search_links=cover_provider_fallback_web.extract_generic_search_links,
            extract_og_image=cover_provider_fallback_web.extract_og_image,
            deadline_expired=lambda provider_deadline: (
                (callable(active_should_cancel) and active_should_cancel())
                or (
                    provider_deadline is not None
                    and time.perf_counter() >= provider_deadline
                )
            ),
        )
        if callable(active_should_cancel) and active_should_cancel():
            return []
        return build_lookup_matches_from_candidates(candidates, lookup_group="services")


def _search_service_cover_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    allow_apple_web_fallback: bool = True,
    should_cancel: Callable[[], bool] | None = None,
    enabled_services: list[str] | tuple[str, ...] | set[str] | None = None,
    log_event: Callable[..., object] | None = None,
    on_candidates: Callable[[list[dict[str, object]]], None] | None = None,
) -> list[dict[str, object]]:
    all_candidates: list[CoverCandidate] = []
    app_log_event = log_event or cover_provider_runtime.log_app_event
    enabled_service_names = normalize_enabled_music_services(enabled_services)

    def service_enabled(service_name: str) -> bool:
        return not enabled_service_names or service_name in enabled_service_names

    early_primary_service_searches = [
        (
            "apple",
            lambda: cover_provider_runtime.search_apple_candidates(
                artist,
                album,
                edition,
                year,
                user_agent,
                allow_web_fallback=allow_apple_web_fallback,
                should_cancel=should_cancel,
            ),
        ),
        ("deezer", lambda: cover_provider_runtime.search_deezer_candidates(artist, album, edition, year, user_agent)),
    ]
    early_primary_service_searches = cover_provider_matching.order_provider_items(
        early_primary_service_searches,
        order=cover_provider_matching.EARLY_MANUAL_PRIMARY_PROVIDER_ORDER,
        provider_name=lambda item: item[0],
    )
    early_primary_service_searches = [
        (service_name, search_fn)
        for service_name, search_fn in early_primary_service_searches
        if service_enabled(service_name)
    ]
    youtube_music_searches = [
        ("youtube_music", lambda: cover_provider_runtime.search_youtube_music_candidates(artist, album, edition, year, user_agent)),
    ]
    youtube_music_searches = [
        (service_name, search_fn)
        for service_name, search_fn in youtube_music_searches
        if service_enabled(service_name)
    ]
    spotify_searches = [
        ("spotify", lambda: cover_provider_runtime.search_spotify_candidates(artist, album, edition, year, user_agent)),
    ]
    spotify_searches = [
        (service_name, search_fn)
        for service_name, search_fn in spotify_searches
        if service_enabled(service_name)
    ]

    def run_service_searches(service_searches: list[tuple[str, object]]) -> None:
        for service_name, search_fn in service_searches:
            if callable(should_cancel) and should_cancel():
                app_log_event(
                    {},
                    cover_provider_runtime.LOGGER,
                    "Cover search canceled before provider",
                    level="info",
                    service=service_name,
                    artist=artist,
                    album=album,
                    year=year,
                )
                break
            service_started_at = time.perf_counter()
            log_provider_started(
                app_log_event,
                {},
                cover_provider_runtime.LOGGER,
                service=service_name,
                artist=artist,
                album=album,
                year=year,
            )
            try:
                service_candidates = search_fn() or []
            except Exception as exc:
                cover_provider_runtime.LOGGER.exception(
                    "Cover search provider failed service=%s artist=%r album=%r year=%r",
                    service_name,
                    artist,
                    album,
                    year,
                )
                log_provider_failed(
                    app_log_event,
                    {},
                    cover_provider_runtime.LOGGER,
                    service=service_name,
                    artist=artist,
                    album=album,
                    year=year,
                    elapsed_ms=round((time.perf_counter() - service_started_at) * 1000, 2),
                    exc=exc,
                )
                raise
            if service_name == "apple" and service_candidates:
                acceptable_candidates = [
                    candidate
                    for candidate in service_candidates
                    if cover_provider_runtime.cover_candidate_is_acceptable(candidate)
                ]
                primary_candidate = cover_provider_matching.select_largest_candidate(
                    acceptable_candidates or service_candidates
                )
                service_candidates = [primary_candidate] if primary_candidate is not None else []
            cover_provider_runtime.LOGGER.info(
                "Cover search provider completed service=%s artist=%r album=%r year=%r candidates=%s",
                service_name,
                artist,
                album,
                year,
                len(service_candidates),
            )
            log_provider_completed(
                app_log_event,
                {},
                cover_provider_runtime.LOGGER,
                service=service_name,
                artist=artist,
                album=album,
                year=year,
                candidate_count=len(service_candidates),
                acceptable_candidate_count=sum(
                    1 for candidate in service_candidates if cover_provider_runtime.cover_candidate_is_acceptable(candidate)
                ),
                elapsed_ms=round((time.perf_counter() - service_started_at) * 1000, 2),
            )
            all_candidates.extend(service_candidates)
            if callable(on_candidates) and not (
                callable(should_cancel) and should_cancel()
            ):
                on_candidates(
                    build_lookup_matches_from_candidates(
                        all_candidates,
                        lookup_group="services",
                    )
                )
            if callable(should_cancel) and should_cancel():
                app_log_event(
                    {},
                    cover_provider_runtime.LOGGER,
                    "Cover search canceled after provider",
                    level="info",
                    service=service_name,
                    artist=artist,
                    album=album,
                    year=year,
                )
                break

    run_service_searches(early_primary_service_searches)
    if callable(should_cancel) and should_cancel():
        return build_lookup_matches_from_candidates(all_candidates, lookup_group="services")
    run_service_searches(youtube_music_searches)
    if callable(should_cancel) and should_cancel():
        return build_lookup_matches_from_candidates(all_candidates, lookup_group="services")
    early_primary_acceptable_services = {
        str(candidate.source or "").strip()
        for candidate in all_candidates
        if cover_provider_runtime.cover_candidate_is_acceptable(candidate)
    }
    skip_spotify = bool(
        set(cover_provider_matching.MANUAL_PRIMARY_PROVIDER_ORDER[:-1]) & early_primary_acceptable_services
    )
    if skip_spotify and spotify_searches:
        log_provider_skipped(
            app_log_event,
            {},
            cover_provider_runtime.LOGGER,
            service="spotify",
            artist=artist,
            album=album,
            year=year,
            reason="acceptable_primary_candidate_already_found",
        )
        late_primary_effective_searches = []
    else:
        late_primary_effective_searches = spotify_searches
    run_service_searches(late_primary_effective_searches)
    if callable(should_cancel) and should_cancel():
        return build_lookup_matches_from_candidates(all_candidates, lookup_group="services")
    primary_has_acceptable = any(cover_provider_runtime.cover_candidate_is_acceptable(candidate) for candidate in all_candidates)
    app_log_event(
        {},
        cover_provider_runtime.LOGGER,
        "Cover search primary services evaluated",
        level="info",
        artist=artist,
        album=album,
        year=year,
        total_candidate_count=len(all_candidates),
        acceptable_candidate_count=sum(1 for candidate in all_candidates if cover_provider_runtime.cover_candidate_is_acceptable(candidate)),
        primary_has_acceptable=primary_has_acceptable,
        skip_spotify=skip_spotify,
    )
    if not primary_has_acceptable:
        run_service_searches([
            ("genius", lambda: cover_provider_runtime.search_genius_candidates(artist, album, edition, year, user_agent)),
        ] if service_enabled("genius") else [])
        if callable(should_cancel) and should_cancel():
            return build_lookup_matches_from_candidates(all_candidates, lookup_group="services")
    return build_lookup_matches_from_candidates(all_candidates, lookup_group="services")


def _cover_art_archive_candidate_to_lookup_match(candidate: dict[str, object]) -> dict[str, object]:
    match = {
        str(key): value
        for key, value in candidate.items()
        if str(key) in _CURRENT_USE_CAA_LOOKUP_MATCH_FIELDS
    }
    match.update({
        "source_label": str(candidate.get("source_label") or "Cover Art Archive"),
        "lookup_group": str(candidate.get("lookup_group") or "cover_art_archive"),
        "id": f"caa:{str(candidate.get('id') or '')}",
    })
    return current_use_lookup_match_payload(match)


COVER_LOOKUP_PROVIDER_REGISTRY = CoverLookupProviderRegistry()
