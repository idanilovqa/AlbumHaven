from __future__ import annotations

import logging
import re
import urllib.parse
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, wait
from html import unescape
from threading import Event

from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_candidates import CoverCandidate, dedupe_cover_candidates
from music_app.services import music_identity_matching
from music_app.services.runtime_shutdown import create_daemon_executor

_LOGGER = logging.getLogger(__name__)
_BANDCAMP_DISCOVERY_EXECUTOR = create_daemon_executor(
    max_workers=4,
    thread_name_prefix="albumhaven-bandcamp-discovery",
)

HttpGetText = Callable[..., str | None]
LogEvent = Callable[..., None]
MatchScore = Callable[..., float]
Similarity = Callable[[str, str], float]
Normalize = Callable[[str], str]
ParseYear = Callable[[object], int | None]
ExtractOgImage = Callable[[str], str | None]
ExtractMetaContent = Callable[..., str]
ProbeCandidates = Callable[..., list[CoverCandidate]]
DedupeCandidates = Callable[[list[CoverCandidate]], list[CoverCandidate]]
FetchMusicBrainzContext = Callable[..., dict[str, list[str]]]


def bandcamp_candidate_url(image_url: str) -> str | None:
    if not image_url:
        return None
    normalized = str(image_url).strip()
    upgraded = re.sub(
        r"_(\d+)(\.[A-Za-z0-9]+)$",
        lambda match: f"_10{match.group(2)}" if int(match.group(1) or 0) < 10 else match.group(0),
        normalized,
        flags=re.IGNORECASE,
    )
    return upgraded


def bandcamp_client_challenge_detected(html: str) -> bool:
    snippet = (html or "")[:8000]
    lowered = snippet.casefold()
    return (
        "client challenge" in lowered
        or "/_fs-ch-" in lowered
        or "javascript is disabled in your browser" in lowered
    )


def search_bandcamp_cover(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    match_score: MatchScore,
    similarity: Similarity,
    normalize: Normalize,
    parse_year: ParseYear,
    extract_og_image: ExtractOgImage,
    extract_meta_content: ExtractMetaContent,
    probe_match_candidates: ProbeCandidates,
    select_largest_candidate: Callable[..., CoverCandidate | None],
    fetch_musicbrainz_bandcamp_context: FetchMusicBrainzContext,
    should_cancel: Callable[[], bool] | None = None,
    canonical_album_title: Normalize | None = None,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> CoverCandidate | None:
    for query_mode, matches in _build_bandcamp_matches(
        artist,
        album,
        edition,
        year,
        user_agent,
        http_get_text=http_get_text,
        match_score=match_score,
        similarity=similarity,
        normalize=normalize,
        parse_year=parse_year,
        extract_og_image=extract_og_image,
        extract_meta_content=extract_meta_content,
        fetch_musicbrainz_bandcamp_context=fetch_musicbrainz_bandcamp_context,
        should_cancel=should_cancel,
        canonical_album_title=canonical_album_title,
        log_event=log_event,
        logger=logger,
    ):
        best_candidate = select_largest_candidate(
            source="bandcamp",
            matches=matches,
            user_agent=user_agent,
            query_mode=query_mode,
            artist=artist,
            album=album,
            year=year,
        )
        if best_candidate:
            return best_candidate
    return None


def search_bandcamp_cover_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    match_score: MatchScore,
    similarity: Similarity,
    normalize: Normalize,
    parse_year: ParseYear,
    extract_og_image: ExtractOgImage,
    extract_meta_content: ExtractMetaContent,
    probe_match_candidates: ProbeCandidates,
    fetch_musicbrainz_bandcamp_context: FetchMusicBrainzContext,
    should_cancel: Callable[[], bool] | None = None,
    canonical_album_title: Normalize | None = None,
    dedupe_candidates: DedupeCandidates = dedupe_cover_candidates,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[CoverCandidate]:
    candidates: list[CoverCandidate] = []
    for query_mode, matches in _build_bandcamp_matches(
        artist,
        album,
        edition,
        year,
        user_agent,
        http_get_text=http_get_text,
        match_score=match_score,
        similarity=similarity,
        normalize=normalize,
        parse_year=parse_year,
        extract_og_image=extract_og_image,
        extract_meta_content=extract_meta_content,
        fetch_musicbrainz_bandcamp_context=fetch_musicbrainz_bandcamp_context,
        should_cancel=should_cancel,
        canonical_album_title=canonical_album_title,
        log_debug=True,
        log_event=log_event,
        logger=logger,
    ):
        candidates.extend(
            probe_match_candidates(
                source="bandcamp",
                matches=matches,
                user_agent=user_agent,
                query_mode=query_mode,
                artist=artist,
                album=album,
                year=year,
                probe_limit=None,
                use_score_cutoff=False,
            )
        )
    return dedupe_candidates(candidates)


def expand_bandcamp_album_url_candidates(
    normalized_url: str,
    *,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    user_agent: str,
    http_get_text: HttpGetText,
    match_score: MatchScore,
    parse_year: ParseYear,
    extract_og_image: ExtractOgImage,
    extract_meta_content: ExtractMetaContent,
    probe_match_candidates: ProbeCandidates,
) -> list[CoverCandidate]:
    html = http_get_text(normalized_url, user_agent, service="bandcamp", context=f"manual-album:{normalized_url}")
    if not html or bandcamp_client_challenge_detected(html):
        return []
    page_title = extract_meta_content(html, "og:title")
    page_title = re.sub(r"\s*\|\s*Bandcamp\s*$", "", page_title or "", flags=re.IGNORECASE).strip()
    description = extract_meta_content(html, "og:description", "description")
    by_match = re.search(r"\bby\s+(.+?)(?:\s*[.|]\s*|\s*$)", description, flags=re.IGNORECASE)
    page_artist = by_match.group(1).strip() if by_match else description.strip()
    page_year = parse_year(html[:6000])
    image_url = bandcamp_candidate_url(extract_og_image(html) or "")
    if not image_url:
        return []
    return probe_match_candidates(
        source="bandcamp",
        matches=[
            (
                match_score(
                    target_artist=target_artist,
                    target_album=target_album,
                    target_edition=target_edition,
                    target_year=target_year,
                    candidate_artist=page_artist,
                    candidate_album=page_title,
                    candidate_year=page_year,
                    enforce_year=False,
                )
                or 1.0,
                image_url,
                {
                    "album": page_title,
                    "artist": page_artist,
                    "year": page_year,
                    "album_url": normalized_url,
                    "variant": "manual-url",
                },
            )
        ],
        user_agent=user_agent,
        query_mode="manual-url",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=1,
        use_score_cutoff=False,
    )


def _build_bandcamp_matches(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    match_score: MatchScore,
    similarity: Similarity,
    normalize: Normalize,
    parse_year: ParseYear,
    extract_og_image: ExtractOgImage,
    extract_meta_content: ExtractMetaContent,
    fetch_musicbrainz_bandcamp_context: FetchMusicBrainzContext,
    should_cancel: Callable[[], bool] | None = None,
    canonical_album_title: Normalize | None = None,
    log_debug: bool = False,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[tuple[str, list[tuple[float, str, dict]]]]:
    catalog_matches = _build_bandcamp_label_catalog_matches(
        artist,
        album,
        edition,
        year,
        user_agent,
        http_get_text=http_get_text,
        match_score=match_score,
        similarity=similarity,
        normalize=normalize,
        parse_year=parse_year,
        extract_og_image=extract_og_image,
        extract_meta_content=extract_meta_content,
        fetch_musicbrainz_bandcamp_context=fetch_musicbrainz_bandcamp_context,
        should_cancel=should_cancel,
        canonical_album_title=canonical_album_title,
        log_event=log_event,
        logger=logger,
    )
    if log_debug:
        _emit(
            log_event,
            logger,
            "Bandcamp label catalog matches",
            artist=artist,
            album=album,
            match_groups=len(catalog_matches),
            groups=[group_name for group_name, _matches in catalog_matches[:8]],
        )
    if catalog_matches:
        return catalog_matches
    return []


def _build_bandcamp_label_catalog_matches(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    match_score: MatchScore,
    similarity: Similarity,
    normalize: Normalize,
    parse_year: ParseYear,
    extract_og_image: ExtractOgImage,
    extract_meta_content: ExtractMetaContent,
    fetch_musicbrainz_bandcamp_context: FetchMusicBrainzContext,
    should_cancel: Callable[[], bool] | None = None,
    canonical_album_title: Normalize | None = None,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[tuple[str, list[tuple[float, str, dict]]]]:
    local_stop_event = Event()

    def stopped() -> bool:
        return local_stop_event.is_set() or (callable(should_cancel) and should_cancel())

    slug_variants = _bandcamp_album_slug_variants(album, edition, normalize=normalize)
    direct_artist_accounts = _build_bandcamp_guessed_account_urls(
        artist,
        [],
        [],
        normalize=normalize,
    )

    def album_matches(
        base_url: str,
        album_urls: list[str],
        *,
        roster: list[str] | None = None,
        roster_match: bool = False,
        variant: str,
    ) -> list[tuple[float, str, dict]]:
        matches: list[tuple[float, str, dict]] = []
        for album_url in album_urls:
            if stopped():
                break
            album_html = http_get_text(
                album_url,
                user_agent,
                service="bandcamp",
                context=f"account-album:{album_url}",
            )
            if not album_html or bandcamp_client_challenge_detected(album_html):
                continue
            if not _bandcamp_album_url_matches_title(album_url, album, edition, normalize=normalize):
                _emit(
                    log_event,
                    logger,
                    "Bandcamp account album rejected",
                    account_url=base_url,
                    album_url=album_url,
                    reason="album_slug_mismatch",
                )
                continue
            candidate_album, candidate_artist, candidate_year = _extract_bandcamp_album_page_metadata(
                album_html,
                parse_year=parse_year,
                extract_meta_content=extract_meta_content,
            )
            direct_slug_match = any(album_url.rstrip("/").endswith(f"/album/{slug}") for slug in slug_variants)
            score = match_score(
                target_artist=artist,
                target_album=album,
                target_edition=edition,
                target_year=year,
                candidate_artist=candidate_artist,
                candidate_album=candidate_album,
                candidate_year=candidate_year,
                enforce_year=False,
            )
            candidate_similarity = similarity(artist, candidate_artist)
            active_roster = roster or []
            automatic_artist_match_allowed = (
                music_identity_matching.automatic_artist_identity_match_allowed(
                    artist,
                    candidate_artist,
                )
            )
            if active_roster and not roster_match and candidate_artist and (
                not automatic_artist_match_allowed or candidate_similarity < 0.7
            ):
                _emit(
                    log_event,
                    logger,
                    "Bandcamp account album rejected",
                    account_url=base_url,
                    album_url=album_url,
                    candidate_album=candidate_album,
                    candidate_artist=candidate_artist,
                    candidate_year=candidate_year,
                    score=round(float(score), 4),
                    reason="roster_mismatch",
                )
                continue
            image_url = bandcamp_candidate_url(extract_og_image(album_html) or "")
            if direct_slug_match and image_url:
                album_core_score = similarity(
                    _canonical_album(album, normalize=normalize, canonical_album_title=canonical_album_title),
                    _canonical_album(candidate_album, normalize=normalize, canonical_album_title=canonical_album_title),
                )
                plural_artist_variant = _guarded_plural_artist_variant(
                    artist,
                    candidate_artist,
                )
                if album_core_score >= 0.9 and (
                    score > 0
                    or not candidate_artist
                    or plural_artist_variant
                ):
                    score = max(score, 1.05 if candidate_similarity >= 0.6 or not candidate_artist else 0.95)
            if score <= 0:
                _emit(
                    log_event,
                    logger,
                    "Bandcamp account album rejected",
                    account_url=base_url,
                    album_url=album_url,
                    candidate_album=candidate_album,
                    candidate_artist=candidate_artist,
                    candidate_year=candidate_year,
                    score=round(float(score), 4),
                    reason="match_score_non_positive",
                )
                continue
            if not image_url:
                _emit(
                    log_event,
                    logger,
                    "Bandcamp account album rejected",
                    account_url=base_url,
                    album_url=album_url,
                    candidate_album=candidate_album,
                    candidate_artist=candidate_artist,
                    candidate_year=candidate_year,
                    score=round(float(score), 4),
                    reason="missing_image",
                )
                continue
            _emit(
                log_event,
                logger,
                "Bandcamp account album matched",
                account_url=base_url,
                album_url=album_url,
                candidate_album=candidate_album,
                candidate_artist=candidate_artist,
                candidate_year=candidate_year,
                score=round(float(score), 4),
            )
            matches.append((
                score,
                image_url,
                {
                    "album": candidate_album,
                    "artist": candidate_artist,
                    "year": candidate_year,
                    "album_url": album_url,
                    "variant": variant,
                    "account_url": base_url,
                },
            ))
        matches.sort(key=lambda entry: entry[0], reverse=True)
        return matches

    def account_details(account_url: str) -> tuple[str, list[str]]:
        split = urllib.parse.urlsplit(account_url)
        base_url = urllib.parse.urlunsplit((split.scheme or "https", split.netloc, "", "", "")).rstrip("/")
        urls: list[str] = []
        if "/album/" in split.path.casefold():
            urls.append(urllib.parse.urlunsplit((split.scheme or "https", split.netloc, split.path, "", "")))
        for slug in slug_variants:
            candidate = f"{base_url}/album/{slug}"
            if slug and candidate not in urls:
                urls.append(candidate)
        return base_url, urls

    def probe_direct_account_urls(
        account_urls: list[str],
        *,
        variant: str,
    ) -> list[tuple[str, list[tuple[float, str, dict]]]]:
        for account_url in account_urls[:8]:
            if stopped():
                break
            base_url, direct_album_urls = account_details(account_url)
            matches = album_matches(base_url, direct_album_urls, variant=variant)
            if matches:
                return [(f"label-catalog:{urllib.parse.urlsplit(base_url).netloc}", matches)]
        return []

    def probe_account_catalogs(account_urls: list[str]) -> list[tuple[str, list[tuple[float, str, dict]]]]:
        probed_matches: list[tuple[str, list[tuple[float, str, dict]]]] = []
        for account_url in account_urls[:8]:
            if stopped():
                break
            base_url, _direct_album_urls = account_details(account_url)
            homepage_html = http_get_text(f"{base_url}/", user_agent, service="bandcamp", context=f"account-home:{base_url}")
            homepage_available = bool(homepage_html and not bandcamp_client_challenge_detected(homepage_html))
            artist_page_html = (
                http_get_text(f"{base_url}/artists", user_agent, service="bandcamp", context=f"account-artists:{base_url}") or ""
                if homepage_available
                else ""
            )
            roster = _extract_bandcamp_artist_names(artist_page_html) if artist_page_html else []
            roster_match = _bandcamp_artist_roster_matches(artist, roster, similarity=similarity) if roster else False
            visible_album_links: list[str] = []
            if homepage_available:
                for discovered_url in _extract_bandcamp_album_links_from_account_html(homepage_html, base_url):
                    if discovered_url not in visible_album_links:
                        visible_album_links.append(discovered_url)
            deduped_urls: list[str] = []
            seen_urls: set[str] = set()
            for url in visible_album_links:
                if url not in seen_urls:
                    seen_urls.add(url)
                    deduped_urls.append(url)
            _emit(
                log_event,
                logger,
                "Bandcamp account catalog probed",
                account_url=base_url,
                roster_count=len(roster),
                roster_match=roster_match,
                visible_album_count=len(visible_album_links),
                homepage_available=homepage_available,
                slug_variants=slug_variants,
            )
            matches = album_matches(
                base_url,
                deduped_urls[:18],
                roster=roster,
                roster_match=roster_match,
                variant="label-catalog",
            )
            if matches:
                probed_matches.append((f"label-catalog:{urllib.parse.urlsplit(base_url).netloc}", matches))
                break
        return probed_matches

    musicbrainz_future = _BANDCAMP_DISCOVERY_EXECUTOR.submit(
        lambda: fetch_musicbrainz_bandcamp_context(
            artist,
            album,
            edition,
            year,
            user_agent,
            should_cancel=stopped,
        )
    )
    direct_future = _BANDCAMP_DISCOVERY_EXECUTOR.submit(
        lambda: probe_direct_account_urls(direct_artist_accounts, variant="direct-account")
    )
    context: dict[str, list[str]] = {
        "artists": [],
        "labels": [],
        "artist_account_urls": [],
        "label_account_urls": [],
    }
    linked_future = None
    pending = {musicbrainz_future, direct_future}
    while pending and not stopped():
        completed, pending = wait(
            pending,
            timeout=0.05,
            return_when=FIRST_COMPLETED,
        )
        ordered = sorted(
            completed,
            key=lambda future: (
                0
                if future is direct_future
                else 1
                if future is musicbrainz_future
                else 2
            ),
        )
        for future in ordered:
            if future is musicbrainz_future:
                try:
                    context_result = future.result()
                except Exception as exc:
                    _emit(
                        log_event,
                        logger,
                        "Bandcamp MusicBrainz discovery failed",
                        artist=artist,
                        album=album,
                        error=repr(exc),
                    )
                    continue
                if isinstance(context_result, dict):
                    context = {
                        key: list(context_result.get(key) or [])
                        for key in context
                    }
                linked_accounts = [
                    *context["artist_account_urls"],
                    *context["label_account_urls"],
                ]
                if linked_accounts:
                    linked_accounts_snapshot = tuple(linked_accounts)
                    linked_future = _BANDCAMP_DISCOVERY_EXECUTOR.submit(
                        lambda accounts=linked_accounts_snapshot: probe_direct_account_urls(
                            list(accounts),
                            variant="musicbrainz-url",
                        )
                    )
                    pending.add(linked_future)
            else:
                try:
                    discovery_matches = future.result()
                except Exception as exc:
                    _emit(
                        log_event,
                        logger,
                        (
                            "Bandcamp MusicBrainz-linked discovery failed"
                            if future is linked_future
                            else "Bandcamp direct discovery failed"
                        ),
                        artist=artist,
                        album=album,
                        error=repr(exc),
                    )
                    continue
                if discovery_matches:
                    local_stop_event.set()
                    for unfinished_future in pending:
                        unfinished_future.cancel()
                    return discovery_matches

    if stopped():
        return []
    context_artists = context["artists"]
    context_labels = context["labels"]
    linked_accounts = [*context["artist_account_urls"], *context["label_account_urls"]]
    guessed_account_urls = _build_bandcamp_guessed_account_urls(
        artist,
        context_artists,
        context_labels,
        normalize=normalize,
    )
    already_probed = set(direct_artist_accounts) | set(linked_accounts)
    fallback_accounts = [url for url in guessed_account_urls if url not in already_probed]
    _emit(
        log_event,
        logger,
        "Bandcamp discovery context",
        artist=artist,
        album=album,
        context_artists=context_artists[:12],
        context_labels=context_labels[:18],
        musicbrainz_accounts=linked_accounts[:12],
        discovered_account_count=len(guessed_account_urls),
        discovered_accounts=guessed_account_urls[:18],
    )
    fallback_direct_matches = probe_direct_account_urls(fallback_accounts, variant="inferred-account")
    if fallback_direct_matches:
        return fallback_direct_matches
    catalog_accounts = [*linked_accounts, *guessed_account_urls]
    deduped_catalog_accounts = list(dict.fromkeys(catalog_accounts))
    catalog_matches = probe_account_catalogs(deduped_catalog_accounts)
    if catalog_matches:
        return catalog_matches
    _emit(
        log_event,
        logger,
        "Bandcamp direct account guesses exhausted",
        artist=artist,
        album=album,
        guessed_account_count=len(guessed_account_urls),
        guessed_accounts=guessed_account_urls[:12],
        used_bing_search=False,
    )
    return []


def _extract_bandcamp_album_links_from_search_html(html: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'href="([^"]+)"', html or "", flags=re.IGNORECASE):
        raw_href = unescape(match.group(1) or "").strip()
        if not raw_href:
            continue
        candidate = _unwrap_search_href(raw_href)
        if "/album/" not in candidate:
            continue
        split = urllib.parse.urlsplit(candidate)
        if "bandcamp.com" not in split.netloc.casefold():
            continue
        normalized = urllib.parse.urlunsplit((split.scheme or "https", split.netloc, split.path, "", ""))
        if normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)
    return links


def _extract_bandcamp_account_links_from_search_html(html: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'href="([^"]+)"', html or "", flags=re.IGNORECASE):
        raw_href = unescape(match.group(1) or "").strip()
        if not raw_href:
            continue
        candidate = _unwrap_search_href(raw_href)
        split = urllib.parse.urlsplit(candidate)
        if "bandcamp.com" not in split.netloc.casefold():
            continue
        path = (split.path or "/").strip() or "/"
        if any(segment in path.casefold() for segment in ("/album/", "/track/", "/merch/", "/subscribe")):
            continue
        normalized = urllib.parse.urlunsplit((split.scheme or "https", split.netloc, "/" if path == "/" else path.rstrip("/"), "", ""))
        if normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)
    return links


def _build_bandcamp_guessed_account_urls(
    primary_artist: str,
    artists: list[str],
    labels: list[str],
    *,
    normalize: Normalize | None = None,
) -> list[str]:
    account_urls: list[str] = []
    seen: set[str] = set()
    for account_name in [str(primary_artist or "").strip(), *(artists or []), *(labels or [])]:
        slug = _bandcamp_slugify(str(account_name or ""), normalize=normalize).replace("-", "")
        if not slug:
            continue
        slug_variants = [slug]
        if len(slug) > 1 and slug.endswith("s"):
            slug_variants.append(slug[:-1])
        for slug_variant in slug_variants:
            guessed = f"https://{slug_variant}.bandcamp.com"
            if guessed in seen:
                continue
            seen.add(guessed)
            account_urls.append(guessed)
    return account_urls


def _bandcamp_slugify(value: str, *, normalize: Normalize | None = None) -> str:
    normalized = normalize(value) if normalize is not None else _default_normalize(value)
    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return re.sub(r"-{2,}", "-", slug)


def _bandcamp_album_slug_variants(
    album: str,
    edition: str | None,
    *,
    normalize: Normalize | None = None,
) -> list[str]:
    base = " ".join(part for part in [album, edition or ""] if str(part).strip()).strip() or str(album or "").strip()
    article_variant = base[4:].strip() if base.casefold().startswith("the ") else f"The {base}"
    variants = [base, article_variant]
    for variant in list(variants):
        swapped_digit = re.sub(r"\b2\b", "to", variant, flags=re.IGNORECASE)
        swapped_word = re.sub(r"\bto\b", "2", variant, flags=re.IGNORECASE)
        if swapped_digit != variant:
            variants.append(swapped_digit)
        if swapped_word != variant:
            variants.append(swapped_word)
    slug_variants: list[str] = []
    seen: set[str] = set()
    for variant in variants:
        slug = _bandcamp_slugify(variant, normalize=normalize)
        if slug and slug not in seen:
            seen.add(slug)
            slug_variants.append(slug)
    return slug_variants


def _bandcamp_album_url_matches_title(
    album_url: str,
    album: str,
    edition: str | None,
    *,
    normalize: Normalize | None = None,
) -> bool:
    split = urllib.parse.urlsplit(str(album_url or "").strip())
    path = split.path.casefold().rstrip("/")
    if "/album/" not in path:
        return False
    slug_part = path.rsplit("/album/", 1)[-1]
    if not slug_part:
        return False
    slug_variants = _bandcamp_album_slug_variants(album, edition, normalize=normalize)
    if not slug_variants:
        return True
    return any(slug and slug in slug_part for slug in slug_variants)


def _extract_bandcamp_artist_names(html: str) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'<a[^>]+href="/[^"]+"[^>]*>\s*<div[^>]*>\s*([^<]+?)\s*</div>', html or "", flags=re.IGNORECASE | re.DOTALL):
        candidate = unescape(re.sub(r"\s+", " ", match.group(1) or "")).strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            names.append(candidate)
    for match in re.finditer(r'<li[^>]*>\s*<a[^>]+href="/[^"]+"[^>]*>\s*([^<]+?)\s*</a>', html or "", flags=re.IGNORECASE | re.DOTALL):
        candidate = unescape(re.sub(r"\s+", " ", match.group(1) or "")).strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            names.append(candidate)
    return names


def _extract_bandcamp_album_links_from_account_html(html: str, base_url: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'href="([^"]*?/album/[^"]+)"', html or "", flags=re.IGNORECASE):
        candidate = unescape(match.group(1) or "").strip()
        if not candidate:
            continue
        if candidate.startswith("/"):
            candidate = f"{base_url}{candidate}"
        split = urllib.parse.urlsplit(candidate)
        normalized = urllib.parse.urlunsplit((split.scheme or "https", split.netloc, split.path, "", ""))
        if normalized not in seen:
            seen.add(normalized)
            links.append(normalized)
    return links


def _bandcamp_artist_roster_matches(
    target_artist: str,
    roster: list[str],
    *,
    similarity: Similarity,
) -> bool:
    target = str(target_artist or "").strip()
    if not target or not roster:
        return False
    if any(music_identity_matching.same_artist_identity(target, candidate) for candidate in roster):
        return True
    compatible_candidates = [
        candidate
        for candidate in roster
        if music_identity_matching.automatic_artist_identity_match_allowed(target, candidate)
    ]
    best = max((similarity(target, candidate) for candidate in compatible_candidates), default=0.0)
    return best >= 0.72


def _guarded_plural_artist_variant(target_artist: str, candidate_artist: str) -> bool:
    if not music_identity_matching.automatic_artist_identity_match_allowed(
        target_artist,
        candidate_artist,
    ):
        return False
    target_tokens = music_identity_matching.normalize_search_text(target_artist).split()
    candidate_tokens = music_identity_matching.normalize_search_text(candidate_artist).split()
    if not target_tokens or len(target_tokens) != len(candidate_tokens):
        return False
    if target_tokens[0] == "the" or candidate_tokens[0] == "the":
        return False
    if target_tokens[:-1] != candidate_tokens[:-1]:
        return False
    target_tail = target_tokens[-1]
    candidate_tail = candidate_tokens[-1]
    return bool(
        len(target_tail) > 1
        and len(candidate_tail) > 1
        and (
            (target_tail.endswith("s") and target_tail[:-1] == candidate_tail)
            or (candidate_tail.endswith("s") and candidate_tail[:-1] == target_tail)
        )
    )


def _extract_bandcamp_album_page_metadata(
    html: str,
    *,
    parse_year: ParseYear,
    extract_meta_content: ExtractMetaContent,
) -> tuple[str, str, int | None]:
    raw_title = extract_meta_content(html, "og:title", "title").strip()
    raw_description = extract_meta_content(html, "og:description", "description").strip()
    candidate_album = raw_title
    candidate_artist = ""
    if raw_title:
        title_parts = [part.strip() for part in raw_title.split("|") if part.strip()]
        if title_parts:
            candidate_album = title_parts[0]
        if len(title_parts) >= 2:
            candidate_artist = title_parts[1]
        if not candidate_artist:
            by_title_match = re.match(r"^(.*?),\s*by\s+(.+?)\s*$", raw_title, flags=re.IGNORECASE)
            if by_title_match:
                candidate_album = by_title_match.group(1).strip()
                candidate_artist = by_title_match.group(2).strip()
    if not candidate_artist:
        by_match = re.search(r"\bby\s+(.+?)(?:\s*[.|]\s*|\s*$)", raw_description, flags=re.IGNORECASE)
        if by_match:
            candidate_artist = by_match.group(1).strip()
    if not candidate_artist:
        article_match = re.search(r'"byArtist":{"name":"([^"]+)"}', html or "", flags=re.IGNORECASE)
        if article_match:
            candidate_artist = unescape(article_match.group(1)).strip()
    release_date_match = re.search(r"\breleased\s+[A-Za-z]+\s+\d{1,2},\s+((?:19|20)\d{2})", html or "", flags=re.IGNORECASE)
    candidate_year = int(release_date_match.group(1)) if release_date_match else parse_year(raw_description)
    if candidate_year is None:
        candidate_year = parse_year(html[:5000])
    return candidate_album.strip(), candidate_artist.strip(), candidate_year


def _unwrap_search_href(raw_href: str) -> str:
    candidate = raw_href
    if "uddg=" in raw_href:
        parsed = urllib.parse.urlsplit(raw_href)
        params = urllib.parse.parse_qs(parsed.query)
        uddg_values = params.get("uddg") or []
        if uddg_values:
            candidate = urllib.parse.unquote(uddg_values[0])
    return candidate


def _canonical_album(
    value: str,
    *,
    normalize: Normalize,
    canonical_album_title: Normalize | None,
) -> str:
    if canonical_album_title is not None:
        return canonical_album_title(value)
    return normalize(value)


def _default_normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def _emit(log_event: LogEvent | None, logger, action: str, **fields) -> None:
    if log_event is None:
        return
    log_event(
        {},
        logger or _LOGGER,
        action,
        level="info",
        **fields,
    )
