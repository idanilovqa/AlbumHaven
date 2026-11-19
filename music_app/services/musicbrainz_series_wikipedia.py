"""A MusicBrainz series' general information, from Wikipedia only (Delivery 2, S6).

Owner 2026-11-17: "Unless there's a Wikipedia link from which there could be shown a general
info about this series/list, nothing should be shown. Because number of albums and all of
that is seen in our gallery." The link comes from the series' MusicBrainz URL relationships:
a Wikipedia link, else its Wikidata item's English article, else another Wikipedia article
of that item. The article's introduction is read from the Wikipedia REST summary in the
enrichment worker's idle time (step ``musicbrainz_series_wikipedia``), a few series per pass
and at most one Wikimedia request a second; page loads only read what is stored.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone

from version import RELEASE_VERSION

JOB_KIND = "musicbrainz_series_wikipedia"
SERIES_PER_PASS = 3
REFRESH_AFTER = timedelta(days=90)
FIRST_FAILURE_REST = timedelta(days=1)
LONGEST_FAILURE_REST = timedelta(days=30)
EXTRACT_LIMIT = 2000
NOT_FOUND = "__not_found__"
# Owner-approved (2026-11-17): the app and its public project page; no contact, user or host details.
USER_AGENT = f"AlbumHaven/{RELEASE_VERSION} (+https://github.com/idanilovqa/AlbumHaven)"

_MIN_INTERVAL_SECONDS = 1.0
_PACE = threading.Lock()
_LAST_REQUEST = [0.0]
_WIKIPEDIA_URL = re.compile(r"^https?://([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.(?:m\.)?wikipedia\.org/wiki/([^?#]+)$")
_WIKIDATA_URL = re.compile(r"^https?://(?:www\.)?wikidata\.org/wiki/(Q[1-9][0-9]{0,11})$")
_ALLOWED_HOST = re.compile(r"^(?:[a-z][a-z0-9-]*\.wikipedia\.org|www\.wikidata\.org)$")


def article(language: str, title: str) -> dict[str, str] | None:
    """A Wikipedia article by language and title, with its canonical URL."""
    title = " ".join(str(title or "").replace("_", " ").split())
    if not title or len(title) > 512 or not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", language or "") \
            or len(language) > 32:
        return None
    path = urllib.parse.quote(title.replace(" ", "_"), safe="")
    return {"language": language, "title": title, "url": f"https://{language}.wikipedia.org/wiki/{path}"}


def _article_from_url(url: object) -> dict[str, str] | None:
    match = _WIKIPEDIA_URL.match(str(url or "").strip())
    return article(match.group(1), urllib.parse.unquote(match.group(2))) if match else None


def _current_links(relations: object, kind: str) -> list[str]:
    return [str(relation["url"].get("resource") or "") for relation in relations if isinstance(relation, dict)
            and relation.get("type") == kind and not relation.get("ended") and isinstance(relation.get("url"), dict)] \
        if isinstance(relations, list) else []


def wikipedia_link(relations: object) -> dict[str, str] | None:
    """The series' own Wikipedia link: English first when it has several."""
    found = [link for link in map(_article_from_url, _current_links(relations, "wikipedia")) if link]
    return min(found, key=lambda link: (link["language"] != "en", link["language"], link["title"]), default=None)


def wikidata_item(relations: object) -> str | None:
    """The series' Wikidata item ("Q164932"), when it names exactly one."""
    found = {match.group(1) for match in map(_WIKIDATA_URL.match, _current_links(relations, "wikidata")) if match}
    return found.pop() if len(found) == 1 else None


def sitelink_article(payload: object, item: str) -> dict[str, str] | None:
    """The English Wikipedia article of a Wikidata item, else another Wikipedia article of it."""
    entity = (payload.get("entities") or {}).get(item) if isinstance(payload, Mapping) else None
    sitelinks = entity.get("sitelinks") if isinstance(entity, Mapping) else None
    found = {}
    for site, link in (sitelinks.items() if isinstance(sitelinks, Mapping) else ()):
        if isinstance(link, Mapping):
            match = _article_from_url(link.get("url"))
            # Wikipedias only: never Commons, Wikiquote or the like.
            if match and site == f"{match['language'].replace('-', '_')}wiki":
                found[site] = match
    return found.get("enwiki") or (found[min(found)] if found else None)


def wikidata_url(item: str) -> str:
    query = urllib.parse.urlencode({"action": "wbgetentities", "ids": item, "props": "sitelinks/urls",
                                    "format": "json"})
    return f"https://www.wikidata.org/w/api.php?{query}"


def summary_url(link: Mapping[str, str]) -> str:
    title = urllib.parse.quote(link["title"].replace(" ", "_"), safe="")
    return f"https://{link['language']}.wikipedia.org/api/rest_v1/page/summary/{title}"


def plain_extract(value: object) -> str:
    """The introduction as one plain-text paragraph, cut at a word within the cap."""
    text = " ".join(str(value or "").split())
    if len(text) <= EXTRACT_LIMIT:
        return text
    cut = text[:EXTRACT_LIMIT - 1].rsplit(" ", 1)[0]
    return f"{cut}…"


def failure_rest(failure_count: int) -> timedelta:
    """A day after the first failure, doubling after each next one, at most a month."""
    return min(FIRST_FAILURE_REST * (2 ** max(0, failure_count - 1)), LONGEST_FAILURE_REST)


def wikimedia_get_json(url: str, *, timeout: float = 15.0) -> object:
    """One Wikimedia request, at most one a second from this process: the payload, NOT_FOUND
    for a 404, or None when Wikimedia did not answer (retried later)."""
    host = urllib.parse.urlsplit(url).hostname or ""
    if not url.startswith("https://") or not _ALLOWED_HOST.match(host):
        raise ValueError("Only Wikipedia and Wikidata are asked.")
    with _PACE:
        wait = _LAST_REQUEST[0] + _MIN_INTERVAL_SECONDS - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _LAST_REQUEST[0] = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return NOT_FOUND if error.code == 404 else None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


class SeriesWikipediaProcessor:
    """Looks up the Wikipedia introduction of a few due series of the library per pass."""

    def __init__(self, *, repository, musicbrainz, get_json: Callable[[str], object] = wikimedia_get_json,
                 now: Callable[[], datetime] | None = None, per_pass: int = SERIES_PER_PASS) -> None:
        self._repository = repository
        self._musicbrainz = musicbrainz
        self._get_json = get_json
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._per_pass = per_pass

    def process_next(self, *, worker_id: str) -> dict[str, object]:
        observed_at = self._now()
        due = self._repository.due_series(limit=self._per_pass, now=observed_at, refresh_after=REFRESH_AFTER)
        if not due:
            return {"processed": False, "state": "idle"}
        for mbid in due:
            found = self.lookup(mbid)
            self._repository.store(mbid=mbid, found=found, observed_at=observed_at)
            if found is None:
                # A provider did not answer: the rest wait for the next pass.
                return {"processed": True, "state": "retry_wait", "job_kind": JOB_KIND}
        return {"processed": True, "state": "succeeded", "job_kind": JOB_KIND}

    def lookup(self, mbid: str) -> dict[str, str] | bool | None:
        """The article and its introduction; False when the series has none; None when
        MusicBrainz or Wikimedia did not answer."""
        links = self._musicbrainz.lookup_series_links(mbid)
        if links.get("classification") in {"not_found", "invalid_request"}:
            return False
        if links.get("classification") != "complete":
            return None
        link = wikipedia_link(links["relations"])
        if link is None:
            item = wikidata_item(links["relations"])
            if item is None:
                return False
            entity = self._get_json(wikidata_url(item))
            if entity is None:
                return None
            link = sitelink_article(entity, item) if entity != NOT_FOUND else None
            if link is None:
                return False
        summary = self._get_json(summary_url(link))
        if summary is None:
            return None
        if not isinstance(summary, Mapping) or summary.get("type") == "disambiguation":
            return False
        extract = plain_extract(summary.get("extract"))
        if not extract:
            return False
        page = (((summary.get("content_urls") or {}).get("desktop") or {}).get("page")
                if isinstance(summary.get("content_urls"), Mapping) else None)
        # The article a redirect lands on, when Wikipedia names it.
        canonical = _article_from_url(page) or article(link["language"], summary.get("title") or "") or link
        return {**canonical, "extract": extract}
