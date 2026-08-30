from __future__ import annotations

import json
import logging
import re
import time
import urllib.parse
from collections.abc import Callable
from html import unescape
from html.parser import HTMLParser

from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_candidates import CoverCandidate, dedupe_cover_candidates, normalize_remote_image_url
from music_app.services.music_identity_matching import (
    automatic_artist_identity_match_allowed,
    artist_identity_similarity,
    same_artist_identity,
)

_LOGGER = logging.getLogger(__name__)
ARTIST_WEBSITE_SEARCH_TIMEOUT_SECONDS = 8.0

HttpGetText = Callable[..., str | None]
HttpGetJson = Callable[..., dict | None]
LogEvent = Callable[..., None]
MatchScore = Callable[..., float]
Similarity = Callable[[str, str], float]
ParseYear = Callable[[object], int | None]
ExtractMetaContent = Callable[..., str]
ManualSourceDetails = Callable[[str], tuple[str, str]]
ProbeCandidates = Callable[..., list[CoverCandidate]]
DedupeCandidates = Callable[[list[CoverCandidate]], list[CoverCandidate]]


def classify_manual_direct_image_art(image_url: str) -> tuple[str, str]:
    decoded_path = urllib.parse.unquote(urllib.parse.urlsplit(image_url).path).casefold()
    normalized_path = " ".join(part for part in re.split(r"[^a-z0-9]+", decoded_path) if part)
    filename = decoded_path.rsplit("/", 1)[-1]
    filename_stem = filename.rsplit(".", 1)[0]
    filename_tokens = [part for part in re.split(r"[^a-z0-9]+", filename_stem) if part]
    compact_filename = "".join(filename_tokens)

    if re.search(r"\bother art\b", normalized_path) or compact_filename.startswith("otherart"):
        return "other", "Other art"
    if re.search(r"\bbooklet\b", normalized_path):
        return "other", "Booklet"
    if (
        re.search(r"\b(?:back cover|cover back)\b", normalized_path)
        or re.fullmatch(r"(?:back|backcover|coverback)\d*", compact_filename)
    ):
        return "other", "Back cover"
    if any(re.fullmatch(r"(?:disc|disk|cd)\d*", token) for token in filename_tokens):
        return "other", "Disc art"
    if any(re.fullmatch(r"media\d*", token) for token in filename_tokens):
        return "other", "Media art"
    return "cover", "Front cover"


def _default_parse_year(value: object) -> int | None:
    match = re.search(r"(19|20)\d{2}", str(value))
    return int(match.group(0)) if match else None


def _default_similarity(left: str, right: str) -> float:
    return artist_identity_similarity(left, right)


def genius_candidate(image_url: str) -> str | None:
    if not image_url:
        return None
    normalized = str(image_url).strip()
    if not normalized:
        return None
    if "t2.genius.com/unsafe/" in normalized:
        proxy_match = re.search(r"/unsafe/\d+x\d+/(https?%3A%2F%2F[^?#]+)", normalized, flags=re.IGNORECASE)
        if proxy_match:
            decoded = proxy_match.group(1)
            for _ in range(2):
                next_decoded = urllib.parse.unquote(decoded)
                if next_decoded == decoded:
                    break
                decoded = next_decoded
            if decoded.startswith("http://") or decoded.startswith("https://"):
                normalized = decoded
        else:
            normalized = re.sub(r"/unsafe/\d+x\d+/", "/unsafe/816x0/", normalized, flags=re.IGNORECASE)
    return normalized


def extract_genius_header_cover_art_images(html: str) -> list[str]:
    class _GeniusHeaderImageParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self._cover_art_depth = 0
            self._tag_stack: list[bool] = []
            self.candidates: list[str] = []

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            attr_map = {name.casefold(): (value or "") for name, value in attrs}
            classes = attr_map.get("class", "")
            class_tokens = {token.strip().casefold() for token in classes.split() if token.strip()}
            enters_cover_art = "header_with_cover_art-cover_art" in class_tokens
            self._tag_stack.append(enters_cover_art)
            if enters_cover_art:
                self._cover_art_depth += 1
            if tag.casefold() != "img" or self._cover_art_depth <= 0:
                return
            if "cover_art-image" not in class_tokens:
                return
            src = (attr_map.get("src") or "").strip()
            if not src:
                return
            if "genius.com" not in src.casefold():
                return
            self.candidates.append(src)

        def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            self.handle_starttag(tag, attrs)
            self.handle_endtag(tag)

        def handle_endtag(self, tag: str) -> None:
            if not self._tag_stack:
                return
            if self._tag_stack.pop():
                self._cover_art_depth = max(0, self._cover_art_depth - 1)

    parser = _GeniusHeaderImageParser()
    parser.feed(html)
    return parser.candidates


def extract_genius_page_data_album(html: str) -> dict[str, object] | None:
    meta_tag_match = re.search(
        r'<meta[^>]*itemprop="page_data"[^>]*>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not meta_tag_match:
        return None
    meta_tag = meta_tag_match.group(0)
    content_match = re.search(r'\bcontent="([^"]+)"', meta_tag, flags=re.IGNORECASE | re.DOTALL)
    if not content_match:
        return None
    encoded_payload = content_match.group(1)
    if not encoded_payload:
        return None
    try:
        payload = json.loads(unescape(encoded_payload))
    except Exception:
        return None
    album_payload = payload.get("album") if isinstance(payload, dict) else None
    return album_payload if isinstance(album_payload, dict) else None


def extract_genius_cover_art_payload_images(html: str) -> list[str]:
    album_payload = extract_genius_page_data_album(html)
    if not album_payload:
        return []
    candidates: list[str] = []
    cover_arts = album_payload.get("cover_arts")
    if isinstance(cover_arts, list):
        for item in cover_arts:
            if not isinstance(item, dict):
                continue
            image_url = str(item.get("image_url") or "").strip()
            thumbnail_url = str(item.get("thumbnail_image_url") or "").strip()
            if image_url:
                candidates.append(image_url)
            elif thumbnail_url:
                candidates.append(thumbnail_url)
    return candidates


def extract_genius_image_candidates(html: str) -> list[str]:
    candidates: list[str] = []
    for match in extract_genius_cover_art_payload_images(html):
        if match:
            candidates.append(match)
    if not candidates:
        for match in extract_genius_header_cover_art_images(html):
            if match:
                candidates.append(match)
    if not candidates:
        field_patterns = (
            r'"cover_art_url"\s*:\s*"((?:https?:)?//t2\.genius\.com/unsafe/[^"\\]+)"',
            r'"header_image_url"\s*:\s*"((?:https?:)?//t2\.genius\.com/unsafe/[^"\\]+)"',
            r'"cover_art_url"\s*:\s*"((?:https?:)?//[^"\\]+?\.(?:jpg|jpeg|png|webp))"',
            r'"header_image_url"\s*:\s*"((?:https?:)?//[^"\\]+?\.(?:jpg|jpeg|png|webp))"',
            r'"imageUrl"\s*:\s*"((?:https?:)?//[^"\\]+?\.(?:jpg|jpeg|png|webp))"',
        )
        for pattern in field_patterns:
            for match in re.findall(pattern, html, flags=re.IGNORECASE):
                if match:
                    candidates.append(unescape(str(match)))
    normalized_candidates: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = normalize_remote_image_url(genius_candidate(candidate) or "")
        if normalized and normalized not in seen:
            seen.add(normalized)
            normalized_candidates.append(normalized)
    return normalized_candidates


def extract_genius_album_page_metadata(
    html: str,
    page_url: str,
    *,
    extract_meta_content: ExtractMetaContent | None = None,
    parse_year: ParseYear = _default_parse_year,
    extract_image_candidates: Callable[[str], list[str]] = extract_genius_image_candidates,
) -> tuple[str, str, int | None, list[str]]:
    if extract_meta_content is None:
        extract_meta_content = extract_meta_content_from_html
    page_title = extract_meta_content(html, "og:title", "twitter:title").strip()
    if not page_title:
        title_match = re.search(r"<title>(.*?)</title>", html, flags=re.IGNORECASE | re.DOTALL)
        if title_match:
            page_title = unescape(re.sub(r"\s+", " ", title_match.group(1))).strip()
    page_title = re.sub(r"\s*(?:Lyrics\s+and\s+Tracklist|Tracklist|Album)\s*\|\s*Genius\s*$", "", page_title, flags=re.IGNORECASE).strip()
    page_title = re.sub(r"\s*\|\s*Genius\s*$", "", page_title, flags=re.IGNORECASE).strip()
    description = extract_meta_content(html, "og:description", "description").strip()
    page_year = parse_year(description or html[:8000])

    page_artist = ""
    album_name = page_title
    title_by_match = re.match(r"(.+?)\s+by\s+(.+)$", page_title, flags=re.IGNORECASE)
    if title_by_match:
        album_name = title_by_match.group(1).strip()
        page_artist = title_by_match.group(2).strip()

    if not page_artist:
        description_by_match = re.search(r"\bby\s+(.+?)(?:\s*[.|]\s*|\s*$)", description, flags=re.IGNORECASE)
        if description_by_match:
            page_artist = description_by_match.group(1).strip()

    split = urllib.parse.urlsplit(page_url)
    path_match = re.match(r"^/albums/([^/]+)/([^/?#]+)", split.path or "", flags=re.IGNORECASE)
    if path_match:
        if not page_artist:
            page_artist = urllib.parse.unquote(path_match.group(1)).replace("-", " ").strip()
        if not album_name:
            album_name = urllib.parse.unquote(path_match.group(2)).replace("-", " ").strip()

    image_candidates = extract_image_candidates(html)
    return album_name, page_artist, page_year, image_candidates


def extract_genius_album_links_from_search_html(html: str) -> list[str]:
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
        split = urllib.parse.urlsplit(candidate)
        if "genius.com" not in split.netloc.casefold():
            continue
        if "/albums/" not in split.path.casefold():
            continue
        normalized = urllib.parse.urlunsplit((split.scheme or "https", split.netloc, split.path, "", ""))
        if normalized and normalized not in seen:
            seen.add(normalized)
            links.append(normalized)
    return links


def build_genius_album_discovery_queries(artist: str, album: str, edition: str | None, year: int | None) -> list[str]:
    queries: list[str] = []
    query_album_text = " ".join(part for part in [album, edition or ""] if str(part).strip())
    artist_text = " ".join(str(artist or "").split()).strip()
    if artist_text and query_album_text:
        queries.append(f'site:genius.com/albums "{artist_text}" "{query_album_text}"')
        queries.append(f'"{artist_text}" "{query_album_text}" genius album')
    if query_album_text:
        queries.append(f'site:genius.com/albums "{query_album_text}"')
        queries.append(f'"{query_album_text}" genius album')
        if year:
            queries.append(f'"{query_album_text}" genius album {int(year)}')
    return list(dict.fromkeys(query.strip() for query in queries if str(query or "").strip()))


def discover_genius_album_urls_via_web_search(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    extract_album_links: Callable[[str], list[str]] = extract_genius_album_links_from_search_html,
) -> list[str]:
    discovered_urls: list[str] = []
    seen_urls: set[str] = set()
    for query_text in build_genius_album_discovery_queries(artist, album, edition, year):
        encoded = urllib.parse.quote_plus(query_text)
        for search_url, search_engine in (
            (f"https://duckduckgo.com/html/?q={encoded}", "duckduckgo-html"),
            (f"https://www.bing.com/search?q={encoded}", "bing"),
        ):
            html = http_get_text(
                search_url,
                user_agent,
                service="genius-discovery",
                context=f"{search_engine}:{query_text}",
            )
            if not html:
                continue
            links = extract_album_links(html)
            for candidate_url in links:
                if candidate_url not in seen_urls:
                    seen_urls.add(candidate_url)
                    discovered_urls.append(candidate_url)
    return discovered_urls


def search_genius_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    dedupe_candidates: DedupeCandidates = dedupe_cover_candidates,
    extract_meta_content: ExtractMetaContent | None = None,
    extract_album_links: Callable[[str], list[str]] = extract_genius_album_links_from_search_html,
    extract_album_page_metadata: Callable[..., tuple[str, str, int | None, list[str]]] = extract_genius_album_page_metadata,
) -> list[CoverCandidate]:
    candidates: list[CoverCandidate] = []
    album_urls = discover_genius_album_urls_via_web_search(
        artist,
        album,
        edition,
        year,
        user_agent,
        http_get_text=http_get_text,
        extract_album_links=extract_album_links,
    )
    for album_url in album_urls[:12]:
        html = http_get_text(album_url, user_agent, service="genius", context=f"album-page:{album_url}")
        if not html:
            continue
        candidate_album, candidate_artist, candidate_year, image_urls = extract_album_page_metadata(
            html,
            album_url,
            extract_meta_content=extract_meta_content,
            parse_year=parse_year,
        )
        if not image_urls:
            continue
        score = match_score(
            target_artist=artist,
            target_album=album,
            target_edition=edition,
            target_year=year,
            candidate_artist=candidate_artist or artist,
            candidate_album=candidate_album or album,
            candidate_year=candidate_year,
            enforce_year=False,
        )
        if score <= 0:
            continue
        matches = [
            (
                score,
                image_url,
                {
                    "album": candidate_album or album,
                    "artist": candidate_artist or artist,
                    "year": candidate_year or year,
                    "album_url": album_url,
                    "variant": "album-page",
                    "host": urllib.parse.urlsplit(album_url).netloc,
                    "source_label": "Genius",
                },
            )
            for image_url in image_urls
        ]
        candidates.extend(
            probe_match_candidates(
                source="genius",
                matches=matches,
                user_agent=user_agent,
                query_mode="genius-album-page",
                artist=artist,
                album=album,
                year=year,
                probe_limit=max(1, min(len(matches), 3)),
                use_score_cutoff=False,
            )
        )
    return dedupe_candidates(candidates)


def expand_manual_genius_album_url_candidates(
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
    probe_match_candidates: ProbeCandidates,
    extract_meta_content: ExtractMetaContent | None = None,
    extract_album_page_metadata: Callable[..., tuple[str, str, int | None, list[str]]] = extract_genius_album_page_metadata,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[CoverCandidate]:
    split = urllib.parse.urlsplit(normalized_url)
    if log_event:
        log_event(
            {},
            logger or _LOGGER,
            "Manual Genius album link detected",
            level="info",
            artist=target_artist,
            album=target_album,
            url=normalized_url,
        )
    html = http_get_text(normalized_url, user_agent, service="genius", context=f"manual-album:{normalized_url}")
    if not html:
        if log_event:
            log_event(
                {},
                logger or _LOGGER,
                "Manual Genius album fetch failed",
                level="info",
                artist=target_artist,
                album=target_album,
                url=normalized_url,
                reason="empty_html",
            )
        return []
    page_title, page_artist, page_year, image_urls = extract_album_page_metadata(
        html,
        normalized_url,
        extract_meta_content=extract_meta_content,
        parse_year=parse_year,
    )
    if not image_urls:
        if log_event:
            log_event(
                {},
                logger or _LOGGER,
                "Manual Genius album image missing",
                level="info",
                artist=target_artist,
                album=target_album,
                url=normalized_url,
                page_title=page_title,
                page_artist=page_artist,
                page_year=page_year,
            )
        return []
    if log_event:
        log_event(
            {},
            logger or _LOGGER,
            "Manual Genius album images extracted",
            level="info",
            artist=target_artist,
            album=target_album,
            url=normalized_url,
            page_title=page_title,
            page_artist=page_artist,
            page_year=page_year,
            image_count=len(image_urls),
            image_urls=image_urls,
        )
    score = match_score(
        target_artist=target_artist,
        target_album=target_album,
        target_edition=target_edition,
        target_year=target_year,
        candidate_artist=page_artist or target_artist,
        candidate_album=page_title or target_album,
        candidate_year=page_year,
        enforce_year=False,
    ) or 1.0
    probed = probe_match_candidates(
        source="direct_url",
        matches=[
            (
                score,
                image_url,
                {
                    "album": page_title or target_album,
                    "artist": page_artist or target_artist,
                    "year": page_year if isinstance(page_year, int) else target_year,
                    "album_url": normalized_url,
                    "variant": "manual-url",
                    "host": split.netloc or "genius.com",
                    "source_label": "Genius",
                },
            )
            for image_url in image_urls
        ],
        user_agent=user_agent,
        query_mode="manual-url",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=max(1, len(image_urls)),
        use_score_cutoff=False,
    )
    if probed:
        if log_event:
            log_event(
                {},
                logger or _LOGGER,
                "Manual Genius album candidates probed",
                level="info",
                artist=target_artist,
                album=target_album,
                url=normalized_url,
                candidate_count=len(probed),
            )
        return probed
    if log_event:
        log_event(
            {},
            logger or _LOGGER,
            "Manual Genius album candidates fell back to unprobed images",
            level="info",
            artist=target_artist,
            album=target_album,
            url=normalized_url,
            image_count=len(image_urls),
        )
    return [
        CoverCandidate(
            source="direct_url",
            url=image_url,
            score=score,
            matched_artist=page_artist or target_artist,
            matched_album=page_title or target_album,
            matched_year=page_year if isinstance(page_year, int) else target_year,
            debug_payload={
                "query_mode": "manual-url",
                "variant": "manual-url",
                "album_url": normalized_url,
                "host": split.netloc or "genius.com",
                "source_label": "Genius",
                "raw_results": [],
                "probed_contenders": [],
            },
        )
        for image_url in image_urls
    ]


def extract_og_image(html: str) -> str | None:
    match = re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', html, flags=re.IGNORECASE)
    if match:
        return unescape(match.group(1))
    return None


def extract_meta_content_from_html(html: str, *names: str) -> str:
    for name in names:
        escaped = re.escape(str(name or ""))
        patterns = [
            rf'<meta[^>]+property="{escaped}"[^>]+content="([^"]*)"',
            rf'<meta[^>]+name="{escaped}"[^>]+content="([^"]*)"',
            rf'<meta[^>]+content="([^"]*)"[^>]+property="{escaped}"',
            rf'<meta[^>]+content="([^"]*)"[^>]+name="{escaped}"',
        ]
        for pattern in patterns:
            match = re.search(pattern, html or "", flags=re.IGNORECASE | re.DOTALL)
            if match:
                return unescape(match.group(1)).strip()
    if "title" in {str(name or "").casefold() for name in names}:
        title_match = re.search(r"<title>(.*?)</title>", html or "", flags=re.IGNORECASE | re.DOTALL)
        if title_match:
            return unescape(re.sub(r"\s+", " ", title_match.group(1))).strip()
    return ""


def extract_amazon_image_candidates(html: str, *, extract_og: Callable[[str], str | None] = extract_og_image) -> list[str]:
    candidates: list[str] = []
    patterns = (
        r'"hiRes"\s*:\s*"(https://m\.media-amazon\.com/images/[^"]+)"',
        r'"large"\s*:\s*"(https://m\.media-amazon\.com/images/[^"]+)"',
        r'data-old-hires="(https://m\.media-amazon\.com/images/[^"]+)"',
        r'<img[^>]+id="landingImage"[^>]+src="(https://m\.media-amazon\.com/images/[^"]+)"',
        r'data-a-dynamic-image="({[^"]+})"',
        r'"mainUrl"\s*:\s*"(https?:\\\/\\\/[^"]+amazon\.com\\\/images\\\/[^"]+)"',
        r'"image"\s*:\s*"(https?:\\\/\\\/[^"]+amazon\.com\\\/images\\\/[^"]+)"',
        r'"mainUrl"\s*:\s*"(https?:\\?/\\?/[^"]+amazon\.com/images/[^"]+)"',
        r'"image"\s*:\s*"(https?:\\?/\\?/[^"]+amazon\.com/images/[^"]+)"',
        r'(https://(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)/images/[A-Za-z0-9._~:/?#\[\]@!$&\'()*+,;=%-]+)',
    )
    for pattern in patterns:
        for match in re.findall(pattern, html, flags=re.IGNORECASE):
            if match:
                candidate_text = unescape(str(match)).replace("\\/", "/").strip()
                if candidate_text.startswith("{") and candidate_text.endswith("}"):
                    for image_url in re.findall(r'"(https?://[^"]+amazon\.com/images/[^"]+)"', candidate_text, flags=re.IGNORECASE):
                        if image_url:
                            candidates.append(unescape(str(image_url)).strip())
                    continue
                if candidate_text.startswith("//"):
                    candidate_text = f"https:{candidate_text}"
                if '"' in candidate_text:
                    candidate_text = candidate_text.split('"', 1)[0]
                candidates.append(candidate_text)
    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate.casefold().endswith("null"):
            continue
        cleaned = re.sub(r"\._[A-Z0-9_,]+_\.", ".", candidate)
        cleaned = normalize_remote_image_url(cleaned)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            normalized.append(cleaned)
    if not normalized:
        og_image = normalize_remote_image_url(extract_og(html) or "")
        if og_image:
            cleaned = re.sub(r"\._[A-Z0-9_,]+_\.", ".", og_image)
            normalized.append(normalize_remote_image_url(cleaned))
    return normalized


def expand_manual_amazon_product_url_candidates(
    normalized_url: str,
    *,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    user_agent: str,
    http_get_text: HttpGetText,
    extract_meta_content: ExtractMetaContent,
    match_score: MatchScore,
    probe_match_candidates: ProbeCandidates,
    extract_image_candidates: Callable[[str], list[str]] = extract_amazon_image_candidates,
) -> list[CoverCandidate] | None:
    split = urllib.parse.urlsplit(normalized_url)
    if "amazon." not in split.netloc.casefold() or "/dp/" not in split.path.casefold():
        return None
    html = http_get_text(normalized_url, user_agent, service="amazon", context=f"manual-product:{normalized_url}")
    if not html:
        return []
    image_urls = extract_image_candidates(html)
    if not image_urls:
        return []
    page_title = re.sub(
        r"\s*:\s*Amazon\.[A-Za-z.]+\s*$",
        "",
        extract_meta_content(html, "og:title", "title").strip(),
        flags=re.IGNORECASE,
    )
    score = match_score(
        target_artist=target_artist,
        target_album=target_album,
        target_edition=target_edition,
        target_year=target_year,
        candidate_artist=target_artist,
        candidate_album=page_title or target_album,
        candidate_year=target_year,
        enforce_year=False,
    ) or 1.0
    return probe_match_candidates(
        source="amazon",
        matches=[
            (
                score,
                image_url,
                {
                    "album": page_title or target_album,
                    "artist": target_artist,
                    "year": target_year,
                    "album_url": normalized_url,
                    "variant": "manual-product",
                    "host": split.netloc,
                    "source_label": "Amazon",
                },
            )
            for image_url in image_urls
        ],
        user_agent=user_agent,
        query_mode="manual-product",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=max(1, len(image_urls)),
        use_score_cutoff=False,
    )


def expand_manual_direct_image_url_candidates(
    normalized_url: str,
    *,
    target_artist: str,
    target_album: str,
    target_year: int | None,
    user_agent: str,
    manual_source_details: ManualSourceDetails,
    probe_match_candidates: ProbeCandidates,
) -> list[CoverCandidate]:
    split = urllib.parse.urlsplit(normalized_url)
    manual_source, manual_source_label = manual_source_details(normalized_url)
    art_kind, art_label = classify_manual_direct_image_art(normalized_url)
    match_payload = {
        "album": target_album,
        "artist": target_artist,
        "year": target_year,
        "album_url": normalized_url,
        "variant": "manual-url",
        "host": split.netloc or normalized_url,
        "source_label": manual_source_label,
        "art_kind": art_kind,
        "art_label": art_label,
    }
    probed = probe_match_candidates(
        source=manual_source,
        matches=[(1.0, normalized_url, match_payload)],
        user_agent=user_agent,
        query_mode="manual-url",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=1,
        use_score_cutoff=False,
    )
    if probed:
        return probed
    return [
        CoverCandidate(
            source=manual_source,
            url=normalized_url,
            score=1.0,
            matched_artist=target_artist,
            matched_album=target_album,
            matched_year=target_year,
            debug_payload={
                "query_mode": "manual-url",
                "variant": "manual-url",
                "album_url": normalized_url,
                "host": split.netloc or normalized_url,
                "source_label": manual_source_label,
                "art_kind": art_kind,
                "art_label": art_label,
                "raw_results": [],
                "probed_contenders": [],
            },
        )
    ]


def expand_generic_manual_page_url_candidates(
    normalized_url: str,
    *,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    user_agent: str,
    http_get_text: HttpGetText,
    extract_meta_content: ExtractMetaContent,
    manual_source_details: ManualSourceDetails,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    extract_og_image: Callable[[str], str | None] = extract_og_image,
) -> list[CoverCandidate]:
    split = urllib.parse.urlsplit(normalized_url)
    html = http_get_text(normalized_url, user_agent, service="manual-remote", context=f"manual-page:{normalized_url}")
    if not html:
        return []
    page_title = extract_meta_content(html, "og:title", "title").strip()
    page_description = extract_meta_content(html, "og:description", "description").strip()
    image_url = normalize_remote_image_url(extract_og_image(html) or "")
    if not image_url:
        return []
    host_label = split.netloc or normalized_url
    manual_source, manual_source_label = manual_source_details(normalized_url)
    return probe_match_candidates(
        source=manual_source,
        matches=[
            (
                match_score(
                    target_artist=target_artist,
                    target_album=target_album,
                    target_edition=target_edition,
                    target_year=target_year,
                    candidate_artist=target_artist,
                    candidate_album=page_title or target_album,
                    candidate_year=parse_year(page_description or page_title),
                    enforce_year=False,
                )
                or 1.0,
                image_url,
                {
                    "album": page_title or target_album,
                    "artist": target_artist,
                    "year": target_year,
                    "album_url": normalized_url,
                    "variant": "manual-page",
                    "host": host_label,
                    "source_label": manual_source_label,
                },
            )
        ],
        user_agent=user_agent,
        query_mode="manual-page",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=1,
        use_score_cutoff=False,
    )


ARTIST_WEBSITE_BLOCKED_HOST_TOKENS = (
    "apple.com",
    "bandcamp.com",
    "deezer.com",
    "discogs.com",
    "facebook.com",
    "genius.com",
    "instagram.com",
    "last.fm",
    "musicbrainz.org",
    "open.spotify.com",
    "rateyourmusic.com",
    "soundcloud.com",
    "tidal.com",
    "wikipedia.org",
    "wikidata.org",
    "x.com",
    "youtube.com",
    "youtu.be",
)


def extract_generic_search_links(html: str) -> list[str]:
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
        split = urllib.parse.urlsplit(candidate)
        if split.scheme not in {"http", "https"} or not split.netloc:
            continue
        normalized = urllib.parse.urlunsplit((split.scheme, split.netloc, split.path, "", ""))
        if normalized and normalized not in seen:
            seen.add(normalized)
            links.append(normalized)
    return links


def artist_website_allowed(url: str) -> bool:
    host = urllib.parse.urlsplit(str(url or "").strip()).netloc.casefold()
    if not host:
        return False
    return not any(token in host for token in ARTIST_WEBSITE_BLOCKED_HOST_TOKENS)


def artist_website_deadline_expired(deadline: float | None) -> bool:
    return deadline is not None and time.perf_counter() >= deadline


def discover_artist_website_urls_via_musicbrainz(
    artist: str,
    user_agent: str,
    *,
    http_get_json: HttpGetJson,
    similarity: Similarity = _default_similarity,
    log_event: LogEvent | None = log_app_event,
    logger=None,
    deadline: float | None = None,
    deadline_expired: Callable[[float | None], bool] = artist_website_deadline_expired,
) -> list[str]:
    artist_text = " ".join(str(artist or "").split()).strip()
    if not artist_text or deadline_expired(deadline):
        return []
    search_url = "https://musicbrainz.org/ws/2/artist/?query=" + urllib.parse.quote(f'artist:"{artist_text}"') + "&fmt=json&limit=5"
    payload = http_get_json(
        search_url,
        user_agent,
        service="musicbrainz",
        context=f"artist-website-search:{artist_text}",
    )
    artist_items = payload.get("artists") if isinstance(payload, dict) else []
    if not isinstance(artist_items, list):
        artist_items = []
    best_artist_id = ""
    best_score = 0.0
    best_artist_is_shared_identity = False
    for item in artist_items:
        if not isinstance(item, dict):
            continue
        candidate_id = str(item.get("id") or "").strip()
        candidate_name = str(item.get("name") or "").strip()
        if not candidate_id or not candidate_name:
            continue
        if not automatic_artist_identity_match_allowed(artist_text, candidate_name):
            continue
        candidate_is_shared_identity = same_artist_identity(artist_text, candidate_name)
        score = float(similarity(artist_text, candidate_name) or 0.0)
        if (
            candidate_is_shared_identity and not best_artist_is_shared_identity
        ) or (
            candidate_is_shared_identity == best_artist_is_shared_identity
            and score > best_score
        ):
            best_score = score
            best_artist_id = candidate_id
            best_artist_is_shared_identity = candidate_is_shared_identity
    if not best_artist_id or best_score < 0.7 or deadline_expired(deadline):
        if log_event:
            log_event(
                {},
                logger or _LOGGER,
                "Artist website MusicBrainz discovery completed",
                level="info",
                artist=artist,
                matched_artist_id=best_artist_id,
                matched_artist_score=round(best_score, 4),
                url_count=0,
            )
        return []
    detail_url = f"https://musicbrainz.org/ws/2/artist/{urllib.parse.quote(best_artist_id)}?fmt=json&inc=url-rels"
    detail_payload = http_get_json(
        detail_url,
        user_agent,
        service="musicbrainz",
        context=f"artist-website-detail:{best_artist_id}",
    )
    relations = detail_payload.get("relations") if isinstance(detail_payload, dict) else []
    discovered_urls: list[str] = []
    seen: set[str] = set()
    for relation in relations if isinstance(relations, list) else []:
        if not isinstance(relation, dict):
            continue
        relation_type = str(relation.get("type") or "").strip().casefold()
        if relation_type not in {"official homepage", "homepage"}:
            continue
        resource = relation.get("url") if isinstance(relation.get("url"), dict) else {}
        candidate_url = str(resource.get("resource") or "").strip()
        if not candidate_url or not artist_website_allowed(candidate_url):
            continue
        normalized = urllib.parse.urlunsplit(urllib.parse.urlsplit(candidate_url)._replace(query="", fragment=""))
        if normalized and normalized not in seen:
            seen.add(normalized)
            discovered_urls.append(normalized)
    if log_event:
        log_event(
            {},
            logger or _LOGGER,
            "Artist website MusicBrainz discovery completed",
            level="info",
            artist=artist,
            matched_artist_id=best_artist_id,
            matched_artist_score=round(best_score, 4),
            url_count=len(discovered_urls),
            urls=discovered_urls[:4],
        )
    return discovered_urls


def discover_artist_website_urls_via_web_search(
    artist: str,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    deadline: float | None = None,
    deadline_expired: Callable[[float | None], bool] = artist_website_deadline_expired,
    extract_search_links: Callable[[str], list[str]] = extract_generic_search_links,
) -> list[str]:
    artist_text = " ".join(str(artist or "").split()).strip()
    if not artist_text or deadline_expired(deadline):
        return []
    discovered_urls: list[str] = []
    seen_urls: set[str] = set()
    queries = [
        f'"{artist_text}" official site',
        f'"{artist_text}" official website',
    ]
    for query_text in queries:
        if deadline_expired(deadline):
            break
        encoded = urllib.parse.quote_plus(query_text)
        search_url = f"https://www.bing.com/search?q={encoded}"
        html = http_get_text(search_url, user_agent, service="artist_website", context=f"artist-website:{query_text}")
        if not html:
            continue
        for candidate_url in extract_search_links(html):
            if not artist_website_allowed(candidate_url):
                continue
            if candidate_url not in seen_urls:
                seen_urls.add(candidate_url)
                discovered_urls.append(candidate_url)
                if len(discovered_urls) >= 3:
                    return discovered_urls
    return discovered_urls


def discover_artist_album_page_urls_via_web_search(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    domain: str,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    deadline: float | None = None,
    deadline_expired: Callable[[float | None], bool] = artist_website_deadline_expired,
    extract_search_links: Callable[[str], list[str]] = extract_generic_search_links,
) -> list[str]:
    artist_text = " ".join(str(artist or "").split()).strip()
    album_text = " ".join(part for part in [album, edition or ""] if str(part).strip())
    if not domain or not album_text or deadline_expired(deadline):
        return []
    discovered_urls: list[str] = []
    seen_urls: set[str] = set()
    queries = [
        f'site:{domain} "{album_text}" "{artist_text}"',
        f'site:{domain} "{album_text}"',
    ]
    if year:
        queries.append(f'site:{domain} "{album_text}" {int(year)}')
    for query_text in queries:
        if deadline_expired(deadline):
            break
        encoded = urllib.parse.quote_plus(query_text)
        search_url = f"https://www.bing.com/search?q={encoded}"
        html = http_get_text(search_url, user_agent, service="artist_website", context=f"artist-album-page:{query_text}")
        if not html:
            continue
        for candidate_url in extract_search_links(html):
            split = urllib.parse.urlsplit(candidate_url)
            if split.netloc.casefold() != domain.casefold():
                continue
            normalized = urllib.parse.urlunsplit((split.scheme or "https", split.netloc, split.path, "", ""))
            if normalized not in seen_urls:
                seen_urls.add(normalized)
                discovered_urls.append(normalized)
                if len(discovered_urls) >= 4:
                    return discovered_urls
    return discovered_urls


def search_artist_website_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_text: HttpGetText,
    http_get_json: HttpGetJson,
    extract_meta_content: ExtractMetaContent,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    dedupe_candidates: DedupeCandidates = dedupe_cover_candidates,
    similarity: Similarity = _default_similarity,
    log_event: LogEvent | None = log_app_event,
    logger=None,
    now: Callable[[], float] = time.perf_counter,
    deadline_expired: Callable[[float | None], bool] | None = None,
    extract_search_links: Callable[[str], list[str]] = extract_generic_search_links,
    extract_og_image: Callable[[str], str | None] = extract_og_image,
) -> list[CoverCandidate]:
    started_at = now()
    deadline = started_at + ARTIST_WEBSITE_SEARCH_TIMEOUT_SECONDS
    is_deadline_expired = deadline_expired or (lambda value: value is not None and now() >= value)
    candidates: list[CoverCandidate] = []
    artist_site_urls = discover_artist_website_urls_via_musicbrainz(
        artist,
        user_agent,
        http_get_json=http_get_json,
        similarity=similarity,
        log_event=log_event,
        logger=logger,
        deadline=deadline,
        deadline_expired=is_deadline_expired,
    )
    if not artist_site_urls and not is_deadline_expired(deadline):
        artist_site_urls = discover_artist_website_urls_via_web_search(
            artist,
            user_agent,
            http_get_text=http_get_text,
            deadline=deadline,
            deadline_expired=is_deadline_expired,
            extract_search_links=extract_search_links,
        )
    for site_url in artist_site_urls[:2]:
        if is_deadline_expired(deadline):
            break
        domain = urllib.parse.urlsplit(site_url).netloc
        page_urls = discover_artist_album_page_urls_via_web_search(
            artist,
            album,
            edition,
            year,
            domain,
            user_agent,
            http_get_text=http_get_text,
            deadline=deadline,
            deadline_expired=is_deadline_expired,
            extract_search_links=extract_search_links,
        )
        for page_url in page_urls[:3]:
            if is_deadline_expired(deadline):
                break
            html = http_get_text(page_url, user_agent, service="artist_website", context=f"album-page:{page_url}")
            if not html:
                continue
            page_title = extract_meta_content(html, "og:title", "title").strip()
            page_description = extract_meta_content(html, "og:description", "description").strip()
            image_url = normalize_remote_image_url(extract_og_image(html) or "")
            if not image_url:
                continue
            candidate_year = parse_year(page_description or page_title)
            score = match_score(
                target_artist=artist,
                target_album=album,
                target_edition=edition,
                target_year=year,
                candidate_artist=artist,
                candidate_album=page_title or album,
                candidate_year=candidate_year,
                enforce_year=False,
            ) or 1.0
            candidates.extend(
                probe_match_candidates(
                    source="artist_website",
                    matches=[(
                        score,
                        image_url,
                        {
                            "album": page_title or album,
                            "artist": artist,
                            "year": candidate_year or year,
                            "album_url": page_url,
                            "variant": "artist-website",
                            "host": domain,
                            "source_label": "Artist Website",
                        },
                    )],
                    user_agent=user_agent,
                    query_mode="artist-website",
                    artist=artist,
                    album=album,
                    year=year,
                    probe_limit=1,
                    use_score_cutoff=False,
                )
            )
    deduped_candidates = dedupe_candidates(candidates)
    if log_event:
        log_event(
            {},
            logger or _LOGGER,
            "Artist website search completed",
            level="info",
            artist=artist,
            album=album,
            year=year,
            candidate_count=len(deduped_candidates),
            elapsed_ms=round((now() - started_at) * 1000, 2),
            timed_out=is_deadline_expired(deadline),
        )
    return deduped_candidates
