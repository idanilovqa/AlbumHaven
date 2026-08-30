from __future__ import annotations

import logging
import re
import threading
import urllib.parse
from collections.abc import Callable
from html import unescape

from config import Config
from music_app.services import cover_provider_http, cover_provider_matching
from music_app.services import music_identity_matching
from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    dedupe_cover_candidates,
    normalize_remote_image_url,
)

_LOGGER = logging.getLogger(__name__)
_APPLE_TRACE_LOCAL = threading.local()
_APPLE_SUFFICIENT_COVER_EDGE = 3000
_APPLE_SUFFICIENT_COVER_SHARPNESS = 4.0
_APPLE_MAX_PAGE_FETCH_RESULTS = 2
_APPLE_MAX_PROBE_CONTENDERS = 3

HttpGetJson = Callable[..., dict | None]
HttpGetText = Callable[..., str | None]
HttpGetTextWithUrl = Callable[..., tuple[str | None, str]]
LogEvent = Callable[..., None]
MatchScore = Callable[..., float]
ParseYear = Callable[[object], int | None]
ProbeMetrics = Callable[..., dict[str, object] | None]
ProbeCandidates = Callable[..., list[CoverCandidate]]
QueryVariants = Callable[[str, str, str | None, int | None], list[tuple[str, str, str | None, int | None]]]
SelectCandidate = Callable[..., CoverCandidate | None]
Similarity = Callable[[str, str], float]
AlbumNameInAlt = Callable[[str, str], bool]
ExtractOgImage = Callable[[str], str | None]
ShouldCancel = Callable[[], bool]


def _canceled(should_cancel: ShouldCancel | None) -> bool:
    return callable(should_cancel) and should_cancel()


def _apple_api_url(path: str, *, config=Config) -> str:
    base_url = str(config.APPLE_API_BASE_URL or "https://itunes.apple.com").strip().rstrip("/")
    return f"{base_url}/{str(path or '').lstrip('/')}"


def begin_apple_request_trace() -> None:
    _APPLE_TRACE_LOCAL.events = []


def finish_apple_request_trace() -> list[dict[str, object]]:
    events = getattr(_APPLE_TRACE_LOCAL, "events", None)
    if not isinstance(events, list):
        return []
    try:
        return [dict(event) for event in events[:8] if isinstance(event, dict)]
    finally:
        _APPLE_TRACE_LOCAL.events = []


def append_apple_request_trace(*, context: str, status: str, elapsed_ms: float) -> None:
    events = getattr(_APPLE_TRACE_LOCAL, "events", None)
    if not isinstance(events, list):
        return
    events.append({
        "context": context,
        "status": status,
        "elapsed_ms": round(float(elapsed_ms or 0.0), 2),
    })


def apple_candidate(artwork_url: str) -> str | None:
    if not artwork_url:
        return None
    return re.sub(r"/\d+x\d+(?:[-a-z0-9]*)?\.(jpg|png|webp)$", r"/9999x9999-100.jpg", artwork_url, flags=re.IGNORECASE)


def apple_page_candidate(artwork_url: str) -> str | None:
    if not artwork_url:
        return None
    bb_match = re.search(r"/(\d+)x(\d+)bb(?:-\d+)?\.(jpg|png|webp)$", artwork_url, flags=re.IGNORECASE)
    if bb_match:
        if int(bb_match.group(1)) != int(bb_match.group(2)):
            return None
        return re.sub(
            r"/\d+x\d+bb(?:-\d+)?\.(jpg|png|webp)$",
            r"/9999x9999bb-100.jpg",
            artwork_url,
            flags=re.IGNORECASE,
        )
    plain_match = re.search(r"/(\d+)x(\d+)(?:[-a-z0-9]*)?\.(jpg|png|webp)$", artwork_url, flags=re.IGNORECASE)
    if plain_match:
        if int(plain_match.group(1)) != int(plain_match.group(2)):
            return None
        return re.sub(
            r"/\d+x\d+(?:[-a-z0-9]*)?\.(jpg|png|webp)$",
            r"/9999x9999-100.jpg",
            artwork_url,
            flags=re.IGNORECASE,
        )
    return None


def apple_artwork_identity(url: str) -> str:
    split = urllib.parse.urlsplit(url or "")
    path_parts = [part for part in split.path.split("/") if part]
    if not path_parts:
        return (url or "").strip().casefold()
    for part in reversed(path_parts):
        if re.fullmatch(r"\d+x\d+(?:[-a-z0-9]*)?\.(jpg|png|webp)", part, flags=re.IGNORECASE):
            continue
        return part.casefold()
    return path_parts[-1].casefold()


def apple_match_variant_priority(meta: dict[str, object]) -> int:
    variant = str(meta.get("variant") or "")
    if variant == "api-artwork":
        return 0
    if variant == "page-srcset":
        return 1
    if variant == "page-web-discovery":
        return 2
    return 3


def dedupe_apple_matches(matches: list[tuple[float, str, dict]]) -> list[tuple[float, str, dict]]:
    deduped: list[tuple[float, str, dict]] = []
    seen: set[str] = set()
    ordered = sorted(
        matches,
        key=lambda item: (-float(item[0]), apple_match_variant_priority(item[2]), item[1]),
    )
    for score, url, meta in ordered:
        identity = apple_artwork_identity(url)
        if identity in seen:
            continue
        seen.add(identity)
        deduped.append((score, url, meta))
    return deduped


def apple_candidate_is_sufficient(metrics: dict[str, object]) -> bool:
    width = int(metrics.get("width") or 0)
    height = int(metrics.get("height") or 0)
    sharpness = float(metrics.get("sharpness") or 0.0)
    return (
        width >= _APPLE_SUFFICIENT_COVER_EDGE
        and height >= _APPLE_SUFFICIENT_COVER_EDGE
        and sharpness >= _APPLE_SUFFICIENT_COVER_SHARPNESS
    )


def _default_http_get_json(url: str, user_agent: str, *, service: str = "remote", context: str = "", **kwargs) -> dict | None:
    return cover_provider_http._http_get_json(
        url,
        user_agent,
        service=service,
        context=context,
        app_event_logger=log_app_event,
        append_apple_request_trace=append_apple_request_trace,
        **kwargs,
    )


def _default_http_get_text(url: str, user_agent: str, *, service: str = "remote", context: str = "") -> str | None:
    return cover_provider_http._http_get_text(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
        app_event_logger=log_app_event,
        append_apple_request_trace=append_apple_request_trace,
    )


def _default_http_get_text_with_url(url: str, user_agent: str, *, service: str = "remote", context: str = "") -> tuple[str | None, str]:
    return cover_provider_http._http_get_text_with_url(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
        app_event_logger=log_app_event,
        append_apple_request_trace=append_apple_request_trace,
    )


def extract_srcset_urls(html: str) -> list[str]:
    urls: list[str] = []
    for match in re.finditer(r'\bsrcset="([^"]+)"', html, flags=re.IGNORECASE):
        raw_srcset = unescape(match.group(1))
        for candidate in raw_srcset.split(","):
            url = candidate.strip().split(" ", 1)[0].strip()
            if url.startswith("https://"):
                urls.append(url)
    return list(dict.fromkeys(urls))


def extract_img_alt(block: str) -> str:
    match = re.search(r'<img[^>]+\balt="([^"]*)"', block, flags=re.IGNORECASE)
    if not match:
        return ""
    return unescape(match.group(1)).strip()


def extract_slot_artwork_urls(
    html: str,
    album: str,
    *,
    album_name_in_alt: AlbumNameInAlt,
) -> list[str]:
    candidates: list[str] = []
    seen_blocks: set[str] = set()
    search_from = 0
    slot_token = 'slot="artwork"'
    while True:
        slot_index = html.find(slot_token, search_from)
        if slot_index < 0:
            break
        block_start = max(0, slot_index - 2000)
        block_end = min(len(html), slot_index + 12000)
        block = html[block_start:block_end]
        search_from = slot_index + len(slot_token)
        if block in seen_blocks:
            continue
        seen_blocks.add(block)
        alt_text = extract_img_alt(block)
        if not album_name_in_alt(album, alt_text):
            continue
        for srcset_url in extract_srcset_urls(block):
            if "mzstatic.com/image/thumb/" not in srcset_url:
                continue
            upgraded = apple_page_candidate(srcset_url)
            if upgraded:
                candidates.append(upgraded)
        for src_match in re.finditer(r'\bsrc="([^"]+)"', block, flags=re.IGNORECASE):
            src_url = unescape(src_match.group(1)).strip()
            if "mzstatic.com/image/thumb/" not in src_url:
                continue
            upgraded = apple_page_candidate(src_url)
            if upgraded:
                candidates.append(upgraded)
    return list(dict.fromkeys(candidates))


def extract_square_mzstatic_artwork_urls(html: str) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'https://[^"\']+mzstatic\.com/image/thumb/[^"\']+', html or "", flags=re.IGNORECASE):
        upgraded = apple_page_candidate(unescape(match.group(0)).strip())
        if not upgraded or upgraded in seen:
            continue
        seen.add(upgraded)
        candidates.append(upgraded)
    return candidates


def collect_apple_page_candidates(
    page_url: str,
    user_agent: str,
    album: str,
    *,
    http_get_text: HttpGetText | None = None,
    extract_og_image: ExtractOgImage,
    album_name_in_alt: AlbumNameInAlt,
    should_cancel: ShouldCancel | None = None,
    logger=None,
) -> list[str]:
    if _canceled(should_cancel):
        return []
    getter = http_get_text or _default_http_get_text
    active_logger = logger or _LOGGER
    html = getter(page_url, user_agent, service="apple", context=f"album-page:{page_url}")
    if _canceled(should_cancel):
        return []
    if not html:
        return []
    candidates: list[str] = []
    candidates.extend(extract_slot_artwork_urls(html, album, album_name_in_alt=album_name_in_alt))
    if not candidates:
        candidates.extend(extract_square_mzstatic_artwork_urls(html))
    if not candidates:
        og_image = extract_og_image(html)
        alt_title = extract_img_alt(html)
        if og_image and album_name_in_alt(album, alt_title or album):
            upgraded = apple_page_candidate(og_image)
            if upgraded:
                candidates.append(upgraded)
    deduped = list(dict.fromkeys(candidates))
    _verbose(
        active_logger,
        "Apple page artwork candidates page=%s count=%s candidates=%s",
        page_url,
        len(deduped),
        deduped,
    )
    return deduped


def extract_apple_meta_content(html: str, *names: str) -> str:
    for name in names:
        pattern = (
            r'<meta[^>]+(?:property|name)="'
            + re.escape(name)
            + r'"[^>]+content="([^"]+)"'
        )
        match = re.search(pattern, html, flags=re.IGNORECASE)
        if match:
            return unescape(match.group(1)).strip()
    return ""


def extract_apple_page_metadata(html: str, *, parse_year: ParseYear) -> tuple[str, str, int | None]:
    album_name = extract_apple_meta_content(html, "og:title")
    if not album_name:
        title_match = re.search(r"<title>(.*?)</title>", html, flags=re.IGNORECASE | re.DOTALL)
        if title_match:
            album_name = unescape(re.sub(r"\s+", " ", title_match.group(1))).strip()
    if album_name:
        album_name = re.sub(r"\s+\bby\s+.+?\s+\bon\s+Apple\s+Music\b.*$", "", album_name, flags=re.IGNORECASE).strip()
        album_name = re.sub(r"\s*-\s*Apple Music.*$", "", album_name, flags=re.IGNORECASE).strip()
    description = extract_apple_meta_content(html, "description", "og:description")
    artist_name = ""
    by_match = re.search(r"\bby\s+(.+?)\s+on\s+Apple\s+Music\b", description, flags=re.IGNORECASE)
    if by_match:
        artist_name = by_match.group(1).strip()
    if not artist_name:
        article_match = re.search(r'aria-label="[^"]*?by\s+([^"]+)"', html, flags=re.IGNORECASE)
        if article_match:
            artist_name = unescape(article_match.group(1)).strip()
    page_year = parse_year(description)
    if page_year is None:
        page_year = parse_year(html[:4000])
    return album_name, artist_name, page_year


def normalize_apple_music_url(url: str) -> str:
    if not url:
        return ""
    split = urllib.parse.urlsplit(url)
    if not split.scheme or not split.netloc:
        return ""
    cleaned = urllib.parse.urlunsplit((split.scheme, split.netloc, split.path, "", ""))
    return cleaned.strip()


def extract_apple_album_urls(html: str) -> list[str]:
    urls: list[str] = []
    for match in re.finditer(r'href="([^"]+/album/[^"]+)"', html, flags=re.IGNORECASE):
        candidate = normalize_apple_music_url(unescape(match.group(1)))
        if candidate:
            urls.append(candidate)
    return list(dict.fromkeys(urls))


def extract_apple_album_links_from_search_html(html: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r'href="([^"]+)"', html or "", flags=re.IGNORECASE):
        raw_href = unescape(match.group(1) or "").strip()
        if not raw_href:
            continue
        candidate = raw_href
        if "uddg=" in raw_href:
            parsed = urllib.parse.urlsplit(raw_href)
            params = urllib.parse.parse_qs(parsed.query)
            uddg_values = params.get("uddg") or []
            if uddg_values:
                candidate = urllib.parse.unquote(uddg_values[0])
        if "/album/" not in candidate:
            continue
        normalized = normalize_apple_music_url(candidate)
        if not normalized:
            continue
        split = urllib.parse.urlsplit(normalized)
        if "music.apple.com" not in split.netloc.casefold():
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)
    return links


def _extract_album_part_marker(value: str) -> int | None:
    match = re.search(
        r"\b(?:pt|part|volume|vol)\.?\s*([0-9]+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
        value or "",
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    token = match.group(1).casefold()
    word_lookup = {
        "one": 1,
        "two": 2,
        "three": 3,
        "four": 4,
        "five": 5,
        "six": 6,
        "seven": 7,
        "eight": 8,
        "nine": 9,
        "ten": 10,
    }
    roman_lookup = {
        "i": 1,
        "ii": 2,
        "iii": 3,
        "iv": 4,
        "v": 5,
        "vi": 6,
        "vii": 7,
        "viii": 8,
        "ix": 9,
        "x": 10,
    }
    if token.isdigit():
        return int(token)
    return word_lookup.get(token) or roman_lookup.get(token)


def album_query_part_variants(value: str) -> list[str]:
    raw = " ".join(str(value or "").split()).strip()
    if not raw:
        return []
    variants = [raw]
    marker = _extract_album_part_marker(raw)
    if marker is not None:
        word_lookup = {
            1: "One",
            2: "Two",
            3: "Three",
            4: "Four",
            5: "Five",
            6: "Six",
            7: "Seven",
            8: "Eight",
            9: "Nine",
            10: "Ten",
        }
        roman_lookup = {
            1: "I",
            2: "II",
            3: "III",
            4: "IV",
            5: "V",
            6: "VI",
            7: "VII",
            8: "VIII",
            9: "IX",
            10: "X",
        }
        replacements = [f"Pt. {marker}", f"Part {marker}"]
        if marker in roman_lookup:
            replacements.extend([f"Pt. {roman_lookup[marker]}", f"Part {roman_lookup[marker]}"])
        if marker in word_lookup:
            replacements.extend([f"Part {word_lookup[marker]}"])
        normalized_replacements = list(dict.fromkeys(replacements))
        variant_pattern = r"\b(?:pt|part|volume|vol)\.?\s*(?:[0-9]+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)\b"
        for replacement in normalized_replacements:
            replaced = re.sub(variant_pattern, replacement, raw, count=1, flags=re.IGNORECASE)
            if replaced and replaced not in variants:
                variants.append(replaced)
    return variants


def build_apple_album_discovery_queries(artist: str, album: str, edition: str | None, year: int | None) -> list[str]:
    queries: list[str] = []
    artist_text = " ".join(str(artist or "").split()).strip()
    edition_text = " ".join(str(edition or "").split()).strip()
    for album_variant in album_query_part_variants(album):
        query_album_text = " ".join(part for part in [album_variant, edition_text] if part).strip()
        if not query_album_text:
            continue
        if artist_text:
            queries.append(f'site:music.apple.com/album "{artist_text}" "{query_album_text}"')
            queries.append(f'"{artist_text}" "{query_album_text}" "Apple Music"')
        queries.append(f'site:music.apple.com/album "{query_album_text}"')
        if year:
            queries.append(f'"{query_album_text}" "Apple Music" {int(year)}')
    deduped: list[str] = []
    seen: set[str] = set()
    for query in queries:
        normalized = " ".join(str(query or "").split()).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def _web_search_url(base_url: str, query_text: str) -> str:
    split = urllib.parse.urlsplit(str(base_url or "").strip())
    query_pairs = urllib.parse.parse_qsl(split.query, keep_blank_values=True)
    query_pairs.append(("q", query_text))
    return urllib.parse.urlunsplit((
        split.scheme,
        split.netloc,
        split.path,
        urllib.parse.urlencode(query_pairs),
        "",
    ))


def discover_apple_album_urls_via_web_search(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text_with_url: HttpGetTextWithUrl | None = None,
    should_cancel: ShouldCancel | None = None,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[str]:
    getter = http_get_text_with_url or _default_http_get_text_with_url
    active_logger = logger or _LOGGER
    discovered_urls: list[str] = []
    seen_urls: set[str] = set()
    for query_text in build_apple_album_discovery_queries(artist, album, edition, year):
        if _canceled(should_cancel):
            break
        for search_url, search_source in (
            (_web_search_url(Config.DUCKDUCKGO_SEARCH_BASE_URL, query_text), "duckduckgo-html"),
            (_web_search_url(Config.BING_SEARCH_BASE_URL, query_text), "bing"),
        ):
            if _canceled(should_cancel):
                break
            html, final_url = getter(
                search_url,
                user_agent,
                service="apple-web-discovery",
                context=f"search:{query_text}:{search_source}",
            )
            if _canceled(should_cancel):
                break
            if not html:
                continue
            links = extract_apple_album_links_from_search_html(html)
            _emit(
                log_event,
                active_logger,
                "Apple album web discovery results",
                artist=artist,
                album=album,
                query=query_text,
                source=search_source,
                final_url=final_url,
                result_count=len(links),
                results=links[:12],
            )
            for link in links:
                if _canceled(should_cancel):
                    break
                if link in seen_urls:
                    continue
                seen_urls.add(link)
                discovered_urls.append(link)
    return discovered_urls


def collect_apple_artist_page_urls(
    query_artist: str,
    user_agent: str,
    *,
    http_get_json: HttpGetJson | None = None,
    similarity: Similarity,
    should_cancel: ShouldCancel | None = None,
) -> list[str]:
    if _canceled(should_cancel):
        return []
    query = urllib.parse.quote(" ".join(query_artist.split()).strip())
    if not query:
        return []
    getter = http_get_json or _default_http_get_json
    url = _apple_api_url(f"search?term={query}&entity=musicArtist&limit=10")
    data = getter(url, user_agent, service="apple", context=f"artist-search:{query_artist}")
    if _canceled(should_cancel):
        return []
    if not data:
        return []
    exact_candidates: list[tuple[float, str]] = []
    fuzzy_candidates: list[tuple[float, str]] = []
    for item in data.get("results") or []:
        if _canceled(should_cancel):
            break
        page_url = normalize_apple_music_url(
            str(item.get("artistLinkUrl") or item.get("artistViewUrl") or "")
        )
        if not page_url:
            continue
        artist_name = str(item.get("artistName") or "")
        exact_identity = music_identity_matching.same_artist_identity(query_artist, artist_name)
        if not music_identity_matching.automatic_artist_identity_match_allowed(
            query_artist,
            artist_name,
        ):
            continue
        score = similarity(query_artist, artist_name)
        if not exact_identity and score <= 0.45:
            continue
        target = (
            exact_candidates
            if exact_identity
            else fuzzy_candidates
        )
        target.append((score, page_url))
    candidates = exact_candidates or fuzzy_candidates
    candidates.sort(key=lambda item: item[0], reverse=True)
    return list(dict.fromkeys(url for _score, url in candidates[:3]))


def collect_apple_artist_ids(
    query_artist: str,
    user_agent: str,
    *,
    http_get_json: HttpGetJson | None = None,
    similarity: Similarity,
    should_cancel: ShouldCancel | None = None,
) -> list[int]:
    if _canceled(should_cancel):
        return []
    query = urllib.parse.quote(" ".join(query_artist.split()).strip())
    if not query:
        return []
    getter = http_get_json or _default_http_get_json
    url = _apple_api_url(f"search?term={query}&entity=musicArtist&limit=10")
    data = getter(url, user_agent, service="apple", context=f"artist-id-search:{query_artist}")
    if _canceled(should_cancel):
        return []
    if not data:
        return []
    exact_candidates: list[tuple[float, int]] = []
    fuzzy_candidates: list[tuple[float, int]] = []
    for item in data.get("results") or []:
        if _canceled(should_cancel):
            break
        try:
            artist_id = int(item.get("artistId"))
        except Exception:
            continue
        artist_name = str(item.get("artistName") or "")
        exact_identity = music_identity_matching.same_artist_identity(query_artist, artist_name)
        if not music_identity_matching.automatic_artist_identity_match_allowed(
            query_artist,
            artist_name,
        ):
            continue
        score = similarity(query_artist, artist_name)
        if not exact_identity and score <= 0.45:
            continue
        target = (
            exact_candidates
            if exact_identity
            else fuzzy_candidates
        )
        target.append((score, artist_id))
    candidates = exact_candidates or fuzzy_candidates
    candidates.sort(key=lambda item: item[0], reverse=True)
    return list(dict.fromkeys(artist_id for _score, artist_id in candidates[:3]))


def collect_apple_artist_lookup_matches(
    query_artist: str,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    enforce_year: bool,
    http_get_json: HttpGetJson | None = None,
    match_score: MatchScore,
    parse_year: ParseYear,
    similarity: Similarity,
    should_cancel: ShouldCancel | None = None,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> tuple[list[tuple[float, str, dict]], list[dict]]:
    getter = http_get_json or _default_http_get_json
    active_logger = logger or _LOGGER
    matches: list[tuple[float, str, dict]] = []
    raw_results: list[dict] = []
    seen_album_urls: set[str] = set()
    for artist_id in collect_apple_artist_ids(
        query_artist,
        user_agent,
        http_get_json=getter,
        similarity=similarity,
        should_cancel=should_cancel,
    ):
        if _canceled(should_cancel):
            break
        url = _apple_api_url(f"lookup?id={artist_id}&entity=album&limit=200")
        data = getter(url, user_agent, service="apple", context=f"artist-lookup:{query_artist}:{artist_id}")
        if _canceled(should_cancel):
            break
        if not data:
            continue
        lookup_results = [item for item in (data.get("results") or []) if isinstance(item, dict)]
        raw_results.extend(lookup_results)
        for item in lookup_results:
            if _canceled(should_cancel):
                break
            if str(item.get("wrapperType") or "").casefold() != "collection":
                continue
            album_url = normalize_apple_music_url(str(item.get("collectionViewUrl") or ""))
            if album_url and album_url in seen_album_urls:
                continue
            score = match_score(
                target_artist=artist,
                target_album=album,
                target_edition=edition,
                target_year=year,
                candidate_artist=str(item.get("artistName") or ""),
                candidate_album=str(item.get("collectionName") or ""),
                candidate_year=parse_year(item.get("releaseDate")),
                enforce_year=enforce_year,
            )
            if score <= 0:
                continue
            api_candidate_url = apple_candidate(str(item.get("artworkUrl100") or ""))
            if not api_candidate_url:
                continue
            if album_url:
                seen_album_urls.add(album_url)
            matches.append((
                score,
                api_candidate_url,
                {
                    **item,
                    "variant": "artist-lookup-api-artwork",
                    "collectionViewUrl": album_url or str(item.get("collectionViewUrl") or ""),
                    "album_url": album_url or str(item.get("collectionViewUrl") or ""),
                },
            ))
    deduped_matches = dedupe_apple_matches(matches)
    deduped_matches.sort(key=lambda item: item[0], reverse=True)
    _emit(
        log_event,
        active_logger,
        "Apple artist lookup results",
        artist=artist,
        album=album,
        query_artist=query_artist,
        result_count=len(deduped_matches),
        top_results=[
            {
                "score": round(score, 4),
                "artist": str(item.get("artistName") or ""),
                "album": str(item.get("collectionName") or ""),
                "year": parse_year(item.get("releaseDate")),
                "album_url": str(item.get("collectionViewUrl") or item.get("album_url") or ""),
            }
            for score, _url, item in deduped_matches[:8]
        ],
    )
    return deduped_matches, raw_results


def collect_apple_web_matches(
    query_artist: str,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    enforce_year: bool,
    http_get_json: HttpGetJson | None = None,
    http_get_text: HttpGetText | None = None,
    http_get_text_with_url: HttpGetTextWithUrl | None = None,
    match_score: MatchScore,
    parse_year: ParseYear,
    similarity: Similarity,
    extract_og_image: ExtractOgImage,
    album_name_in_alt: AlbumNameInAlt,
    should_cancel: ShouldCancel | None = None,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[tuple[float, str, dict]]:
    text_getter = http_get_text or _default_http_get_text
    matches: list[tuple[float, str, dict]] = []
    seen_album_urls: set[str] = set()

    def collect_from_album_urls(album_urls: list[str]) -> None:
        for album_url in album_urls:
            if _canceled(should_cancel):
                break
            if album_url in seen_album_urls:
                continue
            seen_album_urls.add(album_url)
            album_html = text_getter(album_url, user_agent, service="apple", context=f"album-page-discovery:{album_url}")
            if _canceled(should_cancel):
                break
            if not album_html:
                continue
            candidate_album, candidate_artist, candidate_year = extract_apple_page_metadata(album_html, parse_year=parse_year)
            score = match_score(
                target_artist=artist,
                target_album=album,
                target_edition=edition,
                target_year=year,
                candidate_artist=candidate_artist,
                candidate_album=candidate_album,
                candidate_year=candidate_year,
                enforce_year=enforce_year,
            )
            if score <= 0:
                continue
            page_candidates = extract_slot_artwork_urls(album_html, candidate_album or album, album_name_in_alt=album_name_in_alt)
            if not page_candidates:
                og_image = extract_og_image(album_html)
                if og_image and album_name_in_alt(album, candidate_album or album):
                    upgraded = apple_page_candidate(og_image)
                    if upgraded:
                        page_candidates = [upgraded]
            for page_candidate_url in page_candidates:
                if _canceled(should_cancel):
                    break
                matches.append((
                    score,
                    page_candidate_url,
                    {
                        "artistName": candidate_artist,
                        "collectionName": candidate_album,
                        "releaseDate": str(candidate_year or ""),
                        "collectionViewUrl": album_url,
                        "album_url": album_url,
                        "variant": "page-web-discovery",
                    },
                ))

    for artist_page_url in collect_apple_artist_page_urls(
        query_artist,
        user_agent,
        http_get_json=http_get_json,
        similarity=similarity,
        should_cancel=should_cancel,
    ):
        if _canceled(should_cancel):
            break
        artist_html = text_getter(artist_page_url, user_agent, service="apple", context=f"artist-page:{artist_page_url}")
        if _canceled(should_cancel):
            break
        if not artist_html:
            continue
        collect_from_album_urls(extract_apple_album_urls(artist_html)[:20])

    if not matches and not _canceled(should_cancel):
        collect_from_album_urls(discover_apple_album_urls_via_web_search(
            artist,
            album,
            edition,
            year,
            user_agent,
            http_get_text_with_url=http_get_text_with_url,
            should_cancel=should_cancel,
            log_event=log_event,
            logger=logger,
        )[:20])

    matches.sort(key=lambda item: item[0], reverse=True)
    return matches


def collect_apple_matches(
    query_text: str,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    enforce_year: bool,
    stop_on_sufficient: bool = True,
    http_get_json: HttpGetJson | None = None,
    http_get_text: HttpGetText | None = None,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_candidate_metrics: ProbeMetrics,
    extract_og_image: ExtractOgImage,
    album_name_in_alt: AlbumNameInAlt,
    should_cancel: ShouldCancel | None = None,
    logger=None,
) -> tuple[list[tuple[float, str, dict]], list[dict]]:
    if _canceled(should_cancel):
        return [], []
    getter = http_get_json or _default_http_get_json
    active_logger = logger or _LOGGER
    query = urllib.parse.quote(query_text)
    url = _apple_api_url(f"search?term={query}&entity=album&limit=20")
    data = getter(url, user_agent, service="apple", context=f"search:{query_text}")
    if _canceled(should_cancel):
        return [], []
    if not data:
        _verbose(active_logger, "Apple search returned no payload query=%r", query_text)
        return [], []
    raw_results = data.get("results") or []
    _verbose(
        active_logger,
        "Apple raw search results query=%r artist=%r album=%r year=%r results=%s",
        query_text,
        artist,
        album,
        year,
        raw_results,
    )
    scored_results: list[tuple[float, dict]] = []
    matches: list[tuple[float, str, dict]] = []
    for item in raw_results:
        if _canceled(should_cancel):
            break
        score = match_score(
            target_artist=artist,
            target_album=album,
            target_edition=edition,
            target_year=year,
            candidate_artist=str(item.get("artistName") or ""),
            candidate_album=str(item.get("collectionName") or ""),
            candidate_year=parse_year(item.get("releaseDate")),
            enforce_year=enforce_year,
        )
        if score <= 0:
            continue
        scored_results.append((score, item))
        api_candidate_url = apple_candidate(str(item.get("artworkUrl100") or ""))
        if api_candidate_url:
            matches.append((score, api_candidate_url, {**item, "variant": "api-artwork"}))
    scored_results.sort(key=lambda item: item[0], reverse=True)
    deduped_api_matches = dedupe_apple_matches(matches)
    for score, api_candidate_url, item in deduped_api_matches[:2]:
        if _canceled(should_cancel):
            break
        if score < 1.0:
            continue
        metrics = probe_candidate_metrics(
            api_candidate_url,
            user_agent=user_agent,
            service="apple",
            context=f"probe:api-sufficiency:{artist} - {album}",
        )
        if _canceled(should_cancel):
            break
        if not metrics or not apple_candidate_is_sufficient(metrics):
            continue
        _verbose(
            active_logger,
            "Apple API artwork sufficient artist=%r album=%r year=%r score=%.4f width=%s height=%s sharpness=%.4f",
            artist,
            album,
            year,
            score,
            metrics["width"],
            metrics["height"],
            metrics["sharpness"],
        )
        prefetched_match = (
            score,
            api_candidate_url,
            {
                **item,
                "variant": "api-artwork",
                "prefetched_raw_bytes": metrics["raw_bytes"],
                "prefetched_width": metrics["width"],
                "prefetched_height": metrics["height"],
                "prefetched_area": metrics["area"],
                "prefetched_sharpness": metrics["sharpness"],
            },
        )
        if stop_on_sufficient:
            return [prefetched_match], [item for item in raw_results if isinstance(item, dict)]
        replaced = False
        for index, (_existing_score, existing_url, _existing_item) in enumerate(matches):
            if existing_url == api_candidate_url:
                matches[index] = prefetched_match
                replaced = True
                break
        if not replaced:
            matches.append(prefetched_match)
        break
    page_fetch_results = scored_results[:_APPLE_MAX_PAGE_FETCH_RESULTS]
    for score, item in page_fetch_results:
        if _canceled(should_cancel):
            break
        page_url = str(item.get("collectionViewUrl") or "")
        if not page_url:
            continue
        for page_candidate_url in collect_apple_page_candidates(
            page_url,
            user_agent,
            str(item.get("collectionName") or album),
            http_get_text=http_get_text,
            extract_og_image=extract_og_image,
            album_name_in_alt=album_name_in_alt,
            should_cancel=should_cancel,
            logger=active_logger,
        ):
            if _canceled(should_cancel):
                break
            matches.append((
                score,
                page_candidate_url,
                {
                    **item,
                    "variant": "page-srcset",
                    "album_url": page_url,
                },
            ))
    matches = dedupe_apple_matches(matches)
    matches.sort(key=lambda item: item[0], reverse=True)
    _verbose(
        active_logger,
        "Apple search results query=%r count=%s top=%s",
        query_text,
        len(matches),
        [
            {
                "score": round(score, 4),
                "artist": str(item.get("artistName") or ""),
                "album": str(item.get("collectionName") or ""),
                "year": parse_year(item.get("releaseDate")),
            }
            for score, _url, item in matches[:5]
        ],
    )
    return matches, [item for item in raw_results if isinstance(item, dict)]


def summarize_apple_raw_results(raw_results: list[dict] | None, *, parse_year: ParseYear) -> list[dict[str, object]]:
    summary: list[dict[str, object]] = []
    for item in raw_results or []:
        if not isinstance(item, dict):
            continue
        summary.append({
            "artist": str(item.get("artistName") or ""),
            "album": str(item.get("collectionName") or ""),
            "year": parse_year(item.get("releaseDate")),
            "album_url": str(item.get("collectionViewUrl") or ""),
            "artwork_url": str(item.get("artworkUrl100") or ""),
        })
    return summary[:8]


def log_apple_miss(
    artist: str,
    album: str,
    year: int | None,
    matches: list[tuple[float, str, dict]],
    query_mode: str,
    raw_results: list[dict] | None = None,
    *,
    parse_year: ParseYear,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> None:
    active_logger = logger or _LOGGER
    top_candidates = [{
        "score": round(score, 4),
        "artist": str(item.get("artistName") or ""),
        "album": str(item.get("collectionName") or ""),
        "year": parse_year(item.get("releaseDate")),
    } for score, _url, item in matches[:5]]
    _emit(
        log_event,
        active_logger,
        "Apple cover miss",
        artist=artist,
        album=album,
        year=year,
        query_mode=query_mode,
        top_candidates=top_candidates,
        raw_result_count=len(raw_results or []),
        raw_results_summary=summarize_apple_raw_results(raw_results, parse_year=parse_year),
    )


def search_apple(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    allow_web_fallback: bool,
    should_cancel: ShouldCancel | None = None,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    similarity: Similarity,
    probe_candidate_metrics: ProbeMetrics,
    select_largest_candidate: SelectCandidate,
    http_get_json: HttpGetJson | None = None,
    http_get_text: HttpGetText | None = None,
    http_get_text_with_url: HttpGetTextWithUrl | None = None,
    extract_og_image: ExtractOgImage,
    album_name_in_alt: AlbumNameInAlt,
    collect_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]] | None = None,
    collect_artist_lookup_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]] | None = None,
    collect_web_matches: Callable[..., list[tuple[float, str, dict]]] | None = None,
    log_miss: Callable[..., None] | None = None,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> CoverCandidate | None:
    if collect_matches is None:
        def collect_matches(
            query_text: str,
            artist: str,
            album: str,
            edition: str | None,
            year: int | None,
            user_agent: str,
            *,
            enforce_year: bool,
            stop_on_sufficient: bool = True,
        ) -> tuple[list[tuple[float, str, dict]], list[dict]]:
            return collect_apple_matches(
                query_text,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                stop_on_sufficient=stop_on_sufficient,
                http_get_json=http_get_json,
                http_get_text=http_get_text,
                match_score=match_score,
                parse_year=parse_year,
                probe_candidate_metrics=probe_candidate_metrics,
                extract_og_image=extract_og_image,
                album_name_in_alt=album_name_in_alt,
                should_cancel=should_cancel,
                logger=logger,
            )
    if collect_artist_lookup_matches is None:
        def collect_artist_lookup_matches(
            query_artist: str,
            artist: str,
            album: str,
            edition: str | None,
            year: int | None,
            user_agent: str,
            *,
            enforce_year: bool,
        ) -> tuple[list[tuple[float, str, dict]], list[dict]]:
            return collect_apple_artist_lookup_matches(
                query_artist,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                http_get_json=http_get_json,
                match_score=match_score,
                parse_year=parse_year,
                similarity=similarity,
                should_cancel=should_cancel,
                log_event=log_event,
                logger=logger,
            )
    if collect_web_matches is None:
        def collect_web_matches(
            query_artist: str,
            artist: str,
            album: str,
            edition: str | None,
            year: int | None,
            user_agent: str,
            *,
            enforce_year: bool,
        ) -> list[tuple[float, str, dict]]:
            return collect_apple_web_matches(
                query_artist,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                http_get_json=http_get_json,
                http_get_text=http_get_text,
                http_get_text_with_url=http_get_text_with_url,
                match_score=match_score,
                parse_year=parse_year,
                similarity=similarity,
                extract_og_image=extract_og_image,
                album_name_in_alt=album_name_in_alt,
                should_cancel=should_cancel,
                log_event=log_event,
                logger=logger,
            )
    log_miss = log_miss or log_apple_miss
    seen_queries: set[str] = set()
    for query_artist, query_album, query_edition, query_year in build_query_variants(artist, album, edition, year):
        if _canceled(should_cancel):
            break
        for query_text, query_mode, enforce_year in _build_search_queries(
            query_artist,
            query_album,
            query_edition,
            query_year,
            native_artist=artist,
            native_album=album,
        ):
            if _canceled(should_cancel):
                break
            normalized_query = " ".join(query_text.split()).strip()
            if not normalized_query or normalized_query in seen_queries:
                continue
            seen_queries.add(normalized_query)
            matches, raw_results = collect_matches(
                normalized_query,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                stop_on_sufficient=True,
            )
            if _canceled(should_cancel):
                return None
            if matches:
                best_candidate = select_largest_candidate(
                    source="apple",
                    matches=matches,
                    user_agent=user_agent,
                    query_mode=query_mode,
                    artist=artist,
                    album=album,
                    year=year,
                    raw_results=raw_results,
                )
                if best_candidate:
                    return best_candidate
            log_miss(artist, album, year, matches, query_mode, raw_results, parse_year=parse_year, log_event=log_event, logger=logger)
            artist_lookup_matches, artist_lookup_raw_results = collect_artist_lookup_matches(
                query_artist,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
            )
            if _canceled(should_cancel):
                return None
            if artist_lookup_matches:
                best_candidate = select_largest_candidate(
                    source="apple",
                    matches=artist_lookup_matches,
                    user_agent=user_agent,
                    query_mode=f"{query_mode}:artist-lookup",
                    artist=artist,
                    album=album,
                    year=year,
                    raw_results=artist_lookup_raw_results,
                )
                if best_candidate:
                    return best_candidate
            if allow_web_fallback and not _canceled(should_cancel):
                web_matches = collect_web_matches(
                    query_artist,
                    artist,
                    album,
                    edition,
                    year,
                    user_agent,
                    enforce_year=enforce_year,
                )
                if _canceled(should_cancel):
                    return None
                if web_matches:
                    best_candidate = select_largest_candidate(
                        source="apple",
                        matches=web_matches,
                        user_agent=user_agent,
                        query_mode=f"{query_mode}:web-discovery",
                        artist=artist,
                        album=album,
                        year=year,
                    )
                    if best_candidate:
                        return best_candidate
    return None


def search_apple_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    allow_web_fallback: bool,
    should_cancel: ShouldCancel | None = None,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    similarity: Similarity,
    probe_candidate_metrics: ProbeMetrics,
    probe_match_candidates: ProbeCandidates,
    http_get_json: HttpGetJson | None = None,
    http_get_text: HttpGetText | None = None,
    http_get_text_with_url: HttpGetTextWithUrl | None = None,
    extract_og_image: ExtractOgImage,
    album_name_in_alt: AlbumNameInAlt,
    dedupe_candidates: Callable[[list[CoverCandidate]], list[CoverCandidate]] = dedupe_cover_candidates,
    collect_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]] | None = None,
    collect_artist_lookup_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]] | None = None,
    collect_web_matches: Callable[..., list[tuple[float, str, dict]]] | None = None,
    log_miss: Callable[..., None] | None = None,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[CoverCandidate]:
    json_getter = http_get_json or _default_http_get_json
    json_response_cache: dict[str, dict | None] = {}

    def cached_http_get_json(url: str, *args, **kwargs) -> dict | None:
        cache_key = str(url or "")
        if cache_key not in json_response_cache:
            json_response_cache[cache_key] = json_getter(url, *args, **kwargs)
        return json_response_cache[cache_key]

    if collect_matches is None:
        def collect_matches(
            query_text: str,
            artist: str,
            album: str,
            edition: str | None,
            year: int | None,
            user_agent: str,
            *,
            enforce_year: bool,
            stop_on_sufficient: bool = True,
        ) -> tuple[list[tuple[float, str, dict]], list[dict]]:
            return collect_apple_matches(
                query_text,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                stop_on_sufficient=stop_on_sufficient,
                http_get_json=cached_http_get_json,
                http_get_text=http_get_text,
                match_score=match_score,
                parse_year=parse_year,
                probe_candidate_metrics=probe_candidate_metrics,
                extract_og_image=extract_og_image,
                album_name_in_alt=album_name_in_alt,
                should_cancel=should_cancel,
                logger=logger,
            )
    if collect_artist_lookup_matches is None:
        def collect_artist_lookup_matches(
            query_artist: str,
            artist: str,
            album: str,
            edition: str | None,
            year: int | None,
            user_agent: str,
            *,
            enforce_year: bool,
        ) -> tuple[list[tuple[float, str, dict]], list[dict]]:
            return collect_apple_artist_lookup_matches(
                query_artist,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                http_get_json=cached_http_get_json,
                match_score=match_score,
                parse_year=parse_year,
                similarity=similarity,
                should_cancel=should_cancel,
                log_event=log_event,
                logger=logger,
            )
    if collect_web_matches is None:
        def collect_web_matches(
            query_artist: str,
            artist: str,
            album: str,
            edition: str | None,
            year: int | None,
            user_agent: str,
            *,
            enforce_year: bool,
        ) -> list[tuple[float, str, dict]]:
            return collect_apple_web_matches(
                query_artist,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                http_get_json=cached_http_get_json,
                http_get_text=http_get_text,
                http_get_text_with_url=http_get_text_with_url,
                match_score=match_score,
                parse_year=parse_year,
                similarity=similarity,
                extract_og_image=extract_og_image,
                album_name_in_alt=album_name_in_alt,
                should_cancel=should_cancel,
                log_event=log_event,
                logger=logger,
            )
    log_miss = log_miss or log_apple_miss
    seen_queries: set[str] = set()
    candidates: list[CoverCandidate] = []
    deferred_web_fallbacks: dict[
        tuple[str, str, str | None, int | None],
        tuple[str, str, str | None, int | None, str, bool],
    ] = {}
    for query_artist, query_album, query_edition, query_year in build_query_variants(artist, album, edition, year):
        if _canceled(should_cancel):
            break
        for query_text, query_mode, enforce_year in _build_search_queries(
            query_artist,
            query_album,
            query_edition,
            query_year,
            native_artist=artist,
            native_album=album,
        ):
            if _canceled(should_cancel):
                break
            normalized_query = " ".join(query_text.split()).strip()
            if not normalized_query or normalized_query in seen_queries:
                continue
            seen_queries.add(normalized_query)
            found_viable_matches = False
            matches, raw_results = collect_matches(
                normalized_query,
                artist,
                album,
                edition,
                year,
                user_agent,
                enforce_year=enforce_year,
                stop_on_sufficient=False,
            )
            if _canceled(should_cancel):
                return []
            if matches:
                query_candidates = probe_match_candidates(
                    source="apple",
                    matches=matches,
                    user_agent=user_agent,
                    query_mode=query_mode,
                    artist=artist,
                    album=album,
                    year=year,
                    raw_results=raw_results,
                    probe_limit=None,
                    use_score_cutoff=False,
                    should_cancel=should_cancel,
                )
                candidates.extend(query_candidates)
                if any(
                    cover_provider_matching.cover_candidate_is_acceptable(candidate)
                    for candidate in query_candidates
                ):
                    return dedupe_candidates(candidates)
                found_viable_matches = True
            else:
                log_miss(artist, album, year, matches, query_mode, raw_results, parse_year=parse_year, log_event=log_event, logger=logger)
                artist_lookup_matches, artist_lookup_raw_results = collect_artist_lookup_matches(
                    query_artist,
                    artist,
                    album,
                    edition,
                    year,
                    user_agent,
                    enforce_year=enforce_year,
                )
                if _canceled(should_cancel):
                    return []
                if artist_lookup_matches:
                    candidates.extend(probe_match_candidates(
                        source="apple",
                        matches=artist_lookup_matches,
                        user_agent=user_agent,
                        query_mode=f"{query_mode}:artist-lookup",
                        artist=artist,
                        album=album,
                        year=year,
                        raw_results=artist_lookup_raw_results,
                        probe_limit=None,
                        use_score_cutoff=False,
                        should_cancel=should_cancel,
                    ))
                    found_viable_matches = True
            if allow_web_fallback and not found_viable_matches:
                fallback_key = (
                    query_artist,
                    query_album,
                    query_edition,
                    query_year,
                )
                deferred_web_fallbacks[fallback_key] = (
                    query_artist,
                    query_album,
                    query_edition,
                    query_year,
                    query_mode,
                    enforce_year,
                )
    for (
        query_artist,
        _query_album,
        _query_edition,
        _query_year,
        query_mode,
        enforce_year,
    ) in deferred_web_fallbacks.values():
        if _canceled(should_cancel):
            return []
        web_matches = collect_web_matches(
            query_artist,
            artist,
            album,
            edition,
            year,
            user_agent,
            enforce_year=enforce_year,
        )
        if _canceled(should_cancel):
            return []
        if web_matches:
            candidates.extend(probe_match_candidates(
                source="apple",
                matches=web_matches,
                user_agent=user_agent,
                query_mode=f"{query_mode}:web-discovery",
                artist=artist,
                album=album,
                year=year,
                probe_limit=None,
                use_score_cutoff=False,
                should_cancel=should_cancel,
            ))
    return dedupe_candidates(candidates)


def extract_manual_apple_candidates_from_url(
    normalized_url: str,
    *,
    user_agent: str,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    http_get_text: HttpGetText | None = None,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    extract_og_image: ExtractOgImage,
    album_name_in_alt: AlbumNameInAlt,
) -> list[CoverCandidate] | None:
    split = urllib.parse.urlsplit(str(normalized_url or "").strip())
    if "music.apple.com" not in split.netloc.casefold() and "itunes.apple.com" not in split.netloc.casefold():
        return None
    getter = http_get_text or _default_http_get_text
    html = getter(normalized_url, user_agent, service="apple", context=f"manual-apple:{normalized_url}")
    if not html:
        return []
    candidate_album, candidate_artist, candidate_year = extract_apple_page_metadata(html, parse_year=parse_year)
    image_urls = collect_apple_page_candidates(
        normalized_url,
        user_agent,
        candidate_album or target_album,
        http_get_text=lambda *_args, **_kwargs: html,
        extract_og_image=extract_og_image,
        album_name_in_alt=album_name_in_alt,
    )
    if not image_urls:
        og_image = normalize_remote_image_url(extract_og_image(html) or "")
        if og_image:
            upgraded = apple_page_candidate(og_image)
            if upgraded:
                image_urls = [upgraded]
    if not image_urls:
        return []
    normalized_artist = candidate_artist or target_artist
    normalized_album = candidate_album or target_album
    normalized_year = candidate_year or target_year
    score = match_score(
        target_artist=target_artist,
        target_album=target_album,
        target_edition=target_edition,
        target_year=target_year,
        candidate_artist=normalized_artist,
        candidate_album=normalized_album,
        candidate_year=normalized_year,
        enforce_year=False,
    ) or 1.0
    return probe_match_candidates(
        source="apple",
        matches=[
            (
                score,
                image_url,
                {
                    "album": normalized_album,
                    "artist": normalized_artist,
                    "year": normalized_year,
                    "album_url": normalized_url,
                    "variant": "manual-apple",
                    "host": split.netloc,
                    "source_label": "Apple Music",
                },
            )
            for image_url in image_urls
        ],
        user_agent=user_agent,
        query_mode="manual-apple",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=max(1, len(image_urls)),
        use_score_cutoff=False,
    )


def _build_search_queries(
    query_artist: str,
    query_album: str,
    query_edition: str | None,
    query_year: int | None,
    *,
    native_artist: str,
    native_album: str,
) -> list[tuple[str, str, bool]]:
    query_suffix = "translit" if (query_artist, query_album) != (native_artist, native_album) else "native"
    queries: list[tuple[str, str, bool]] = []
    query_album_text = " ".join(part for part in [query_album, query_edition or ""] if str(part).strip())
    if query_year:
        queries.append((f"{query_artist} {query_album_text} {query_year}", f"artist+album+year:{query_suffix}", True))
    queries.append((f"{query_artist} {query_album_text}", f"artist+album:{query_suffix}", False))
    return queries


def _emit(log_event: LogEvent | None, logger, action: str, **fields) -> None:
    if log_event is None:
        return
    log_event({}, logger or _LOGGER, action, level="info", **fields)


def _verbose(logger, message: str, *args) -> None:
    verbose = getattr(logger or _LOGGER, "verbose", None)
    if callable(verbose):
        verbose(message, *args)
