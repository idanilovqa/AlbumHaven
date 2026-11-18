from __future__ import annotations

import re
import unicodedata
import urllib.parse
import uuid
from collections.abc import Callable, Mapping
from functools import partial

from music_app.services.musicbrainz_http import count_json_matches
from music_app.services.musicbrainz_http import get_json as _shared_get_json

# Identity enrichment never remembers failures: a direct-entity 404 after a
# successful search is mirror catch-up and must be retried on the next run.
default_get_json = partial(_shared_get_json, cache_failures=False)


JsonDict = dict[str, object]
_DEFAULT_BASE_URL = "http://localhost:5050/ws/2/"
_WHITESPACE = re.compile(r"\s+")


def _text(value: object) -> str:
    return _WHITESPACE.sub(" ", str(value or "").strip())


def normalize_name(value: object) -> str:
    return unicodedata.normalize("NFC", _text(value)).casefold()


_NAME_KEY_DROP = re.compile(r"[\W_]+")
_LUCENE_SPECIAL = re.compile(r'([+\-!(){}\[\]^"~*?:\\/])')
_LUCENE_OPERATOR = re.compile(r"\b(AND|OR|NOT)\b")


def name_match_key(value: object) -> str:
    """Compare artist names regardless of case, punctuation, spacing and "&"/"and".

    "A.A.Williams" and "A.A. Williams", or "...And Oceans" and "…and Oceans",
    share a key. A name made only of punctuation keeps its exact form.
    """
    text = unicodedata.normalize("NFKC", _text(value)).casefold()
    return _NAME_KEY_DROP.sub("", text.replace("&", " and ")) or text


def _escape_phrase(text: str) -> str:
    return _LUCENE_SPECIAL.sub(r"\\\1", text)


def _plain_artist_query(name: str) -> str:
    escaped = _escape_phrase(name)
    return _LUCENE_OPERATOR.sub(lambda match: match.group(1).lower(), escaped)


_BRACKETED_SUFFIX = re.compile(r"[\(\[][^\)\]]*[\)\]]")
_NON_WORD = re.compile(r"[^\w]+")


def release_title_key(value: object) -> str:
    """Compare release titles without edition suffixes or punctuation.

    Local tags often carry "(Remastered)" or "[Deluxe]" where MusicBrainz
    release-group titles do not.
    """
    text = _BRACKETED_SUFFIX.sub(" ", normalize_name(value))
    return " ".join(_NON_WORD.sub(" ", text).split())


def _valid_mbid(value: object) -> str | None:
    text = _text(value).lower()
    try:
        parsed = uuid.UUID(text)
    except (AttributeError, ValueError):
        return None
    if parsed.int == 0 or str(parsed) != text:
        return None
    return text


def _integer(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def artist_url(mbid: object) -> str | None:
    normalized = _valid_mbid(mbid)
    return f"https://musicbrainz.org/artist/{normalized}" if normalized else None


def _bounded_aliases(value: object, limit: int) -> list[JsonDict]:
    aliases: list[JsonDict] = []
    if not isinstance(value, list) or limit <= 0:
        return aliases
    seen: set[tuple[str, str]] = set()
    for raw_alias in value:
        if not isinstance(raw_alias, dict):
            continue
        name = _text(raw_alias.get("name"))
        normalized = normalize_name(name)
        locale = _text(raw_alias.get("locale")).lower()
        key = (normalized, locale)
        if not normalized or key in seen:
            continue
        seen.add(key)
        aliases.append({
            "name": name,
            "normalized_name": normalized,
            "locale": locale or None,
            "primary": bool(raw_alias.get("primary")),
        })
        if len(aliases) >= limit:
            break
    return aliases


def _bounded_votes(value: object, limit: int) -> list[JsonDict]:
    merged: dict[str, JsonDict] = {}
    if isinstance(value, list):
        for raw_item in value:
            if not isinstance(raw_item, dict):
                continue
            name = _text(raw_item.get("name"))
            normalized = normalize_name(name)
            if not normalized:
                continue
            try:
                votes = int(raw_item.get("count") or 0)
            except (TypeError, ValueError):
                votes = 0
            current = merged.get(normalized)
            if current is None:
                merged[normalized] = {"name": name, "normalized_name": normalized, "vote_count": votes}
            else:
                current["vote_count"] = int(current["vote_count"]) + votes
    return sorted(
        merged.values(),
        key=lambda item: (-int(item["vote_count"]), str(item["normalized_name"])),
    )[:limit]


def _contains_native_spelling(value: str) -> bool:
    return any(character.isalpha() and not character.isascii() for character in value)


def project_artist(
    payload: object,
    *,
    max_aliases: int = 24,
    max_tags: int = 64,
    max_genres: int = 24,
) -> JsonDict | None:
    if not isinstance(payload, dict) or "title" in payload:
        return None
    mbid = _valid_mbid(payload.get("id"))
    canonical_name = _text(payload.get("name"))
    if not mbid or not canonical_name:
        return None
    aliases = _bounded_aliases(payload.get("aliases"), max(0, int(max_aliases)))
    preferred_native_name = canonical_name if _contains_native_spelling(canonical_name) else None
    if preferred_native_name is None:
        preferred_native_name = next(
            (
                str(alias["name"])
                for alias in aliases
                if alias["primary"] and _contains_native_spelling(str(alias["name"]))
            ),
            None,
        )
    country = _text(payload.get("country")).upper()
    return {
        "mbid": mbid,
        "canonical_name": canonical_name,
        "sort_name": _text(payload.get("sort-name")) or canonical_name,
        "artist_type": _text(payload.get("type")) or None,
        "disambiguation": _text(payload.get("disambiguation"))[:1024] or None,
        "country_code": country if len(country) == 2 and country.isalpha() else None,
        **_artist_area(payload),
        "preferred_native_name": preferred_native_name,
        "source_url": artist_url(mbid),
        "aliases": aliases,
        "tags": _bounded_votes(payload.get("tags"), max(0, int(max_tags))),
        "genres": _bounded_votes(payload.get("genres"), max(0, int(max_genres))),
        "discogs_artist_id": discogs_artist_id(payload.get("relations")),
    }


_DISCOGS_URL = re.compile(r"^https?://(?:www\.)?discogs\.com/(artist|release)/([1-9][0-9]{0,11})(?:-[^/?#]*)?/?$")


def discogs_artist_id(relations: object) -> int | None:
    """The Discogs artist ID from MusicBrainz url-rels."""
    return discogs_link_id(relations, "artist")


def discogs_link_id(relations: object, kind: str) -> int | None:
    """The Discogs ``kind`` ("artist" or "release") ID from MusicBrainz url-rels.

    Only current "discogs" URL relations to a discogs.com page of that kind count. When
    they name several different Discogs entities, none is chosen.
    """
    found = set()
    for relation in relations if isinstance(relations, list) else []:
        if not isinstance(relation, dict) or relation.get("type") != "discogs" or relation.get("ended"):
            continue
        url = relation.get("url")
        match = _DISCOGS_URL.match(_text(url.get("resource")) if isinstance(url, dict) else "")
        if match and match.group(1) == kind:
            found.add(int(match.group(2)))
    return found.pop() if len(found) == 1 else None


def select_display_genres(genres: object, *, limit: int = 3) -> list[str]:
    items = [item for item in genres if isinstance(item, dict)] if isinstance(genres, list) else []

    def vote_count(item: JsonDict) -> int:
        try:
            return int(item.get("vote_count") or 0)
        except (TypeError, ValueError):
            return 0

    positive = [item for item in items if vote_count(item) > 0]
    eligible = positive or [item for item in items if vote_count(item) == 0]
    selected = sorted(
        eligible,
        key=lambda item: (-vote_count(item), normalize_name(item.get("normalized_name") or item.get("name"))),
    )[:max(0, int(limit))]
    names = [_text(item.get("name")) for item in selected if _text(item.get("name"))]
    return names or ["Genre unavailable"]


def _transport_classification(metadata: JsonDict, *, discovered_by_search: bool = False) -> str:
    status = str(metadata.get("status") or "")
    http_status = _integer(metadata.get("http_status"))
    if http_status == 404:
        return "catch_up_pending" if discovered_by_search else "not_found"
    if http_status == 429:
        return "rate_limited"
    if http_status in {401, 403} or http_status >= 500 or status in {
        "timeout",
        "connection_error",
        "blocked",
        "exhausted",
    }:
        return "provider_unavailable"
    return "invalid_response"


# MusicBrainz's special-purpose "[data]" artist credits a mixed-mode CD's data track.
_DATA_ARTIST_MBID = "33cf029c-63b0-41a0-9855-be2a3665fb3b"


# Video media are not discs of the album (a bonus DVD).
_VIDEO_FORMATS = frozenset({"dvd", "dvd-video", "blu-ray", "hd-dvd", "vhs", "vcd", "svcd", "umd", "laserdisc"})


def _is_audio_medium(medium: JsonDict) -> bool:
    return _text(medium.get("format")).casefold() not in _VIDEO_FORMATS and _integer(medium.get("track-count")) > 0


def _audio_tracks(medium: JsonDict) -> list[JsonDict]:
    """A medium's tracks without its data tracks ("[data track]" on a mixed-mode CD),
    which a local rip never has."""
    return [
        track for track in medium.get("tracks") or [] if isinstance(track, dict)
        and _text(track.get("title")).casefold() != "[data track]"
        and not any(isinstance(credit, dict) and isinstance(credit.get("artist"), dict)
                    and _valid_mbid(credit["artist"].get("id")) == _DATA_ARTIST_MBID
                    for credit in track.get("artist-credit") or [])
    ]


def _artist_credit(value: object) -> list[JsonDict]:
    """An artist credit as MusicBrainz orders it: each credited name, its artist and the
    join phrase after it ("Alan Menken" " & " "Howard Ashman"), its spaces kept."""
    return [
        {"name": _text(credit.get("name")), "artist_mbid": _valid_mbid(credit["artist"].get("id")),
         "artist_name": _text(credit["artist"].get("name")),
         "join_phrase": _WHITESPACE.sub(" ", str(credit.get("joinphrase") or ""))}
        for credit in value or [] if isinstance(credit, dict) and isinstance(credit.get("artist"), dict)
        and _valid_mbid(credit["artist"].get("id"))
    ] if isinstance(value, list) else []


# A series of this many members or more is "Featured In" (owner 2026-11-15): the exact
# size beyond it never matters, so a series is counted only up to it.
SERIES_SIZE_CUTOFF = 50
# Each release group or release a series lists, as its lookup writes the relationship.
_SERIES_MEMBER = re.compile(rb'"target-type"\s*:\s*"release(?:_group)?"')


def _series_parts(relations: object) -> list[JsonDict]:
    """The MusicBrainz series a release or release group is "part of", with its number when
    MusicBrainz gives one ("Colossus Projects", "Release group series", number "18")."""
    parts: dict[str, JsonDict] = {}
    for relation in relations if isinstance(relations, list) else []:
        if not isinstance(relation, dict) or relation.get("target-type") != "series" \
                or relation.get("type") != "part of" or relation.get("direction") != "forward":
            continue
        series = relation.get("series") if isinstance(relation.get("series"), dict) else {}
        mbid, name = _valid_mbid(series.get("id")), _text(series.get("name"))
        if not mbid or not name or mbid in parts:
            continue
        values = relation.get("attribute-values") if isinstance(relation.get("attribute-values"), dict) else {}
        ordering_key = relation.get("ordering-key")
        parts[mbid] = {"mbid": mbid, "name": name, "type": _text(series.get("type")) or None,
                       "disambiguation": _text(series.get("disambiguation")) or None,
                       "number": _text(values.get("number")) or None,
                       "ordering_key": ordering_key if type(ordering_key) is int else None}
    return list(parts.values())


def latin_transliteration_id(release: object) -> str | None:
    """The pseudo-release a release links to by "transl-tracklisting" whose tracklist is in
    Latin script (S7). A translation is not a transliteration: one its disambiguation calls a
    translation ("English translation"), or in another language than the release, never
    counts. Of several left, one called a transliteration first, then the lowest MBID."""
    if not isinstance(release, dict):
        return None
    representation = release.get("text-representation")
    language = _text(representation.get("language")) if isinstance(representation, dict) else ""
    found = []
    for relation in release.get("relations") or []:
        if not isinstance(relation, dict) or relation.get("type") != "transl-tracklisting" \
                or relation.get("direction") != "forward" or not isinstance(relation.get("release"), dict):
            continue
        target = relation["release"]
        mbid = _valid_mbid(target.get("id"))
        script = target.get("text-representation") if isinstance(target.get("text-representation"), dict) else {}
        note = _text(target.get("disambiguation")).casefold()
        other = _text(script.get("language"))
        if not mbid or script.get("script") != "Latn" or "translation" in note.replace("transliteration", "") \
                or (language and other and other != language):
            continue
        found.append(("transliteration" not in note, mbid))
    return min(found)[1] if found else None


def _candidate(payload: object) -> JsonDict | None:
    if not isinstance(payload, dict) or "title" in payload:
        return None
    mbid = _valid_mbid(payload.get("id") or payload.get("mbid"))
    name = _text(payload.get("name") or payload.get("canonical_name"))
    if not mbid or not name:
        return None
    result: JsonDict = {
        "mbid": mbid,
        "canonical_name": name,
        "score": _integer(payload.get("score")),
    }
    sort_name = _text(payload.get("sort-name") or payload.get("sort_name"))
    if sort_name:
        result["sort_name"] = sort_name
    for sources, target in (
        (("type", "artist_type"), "artist_type"),
        (("country", "country_code"), "country_code"),
        (("disambiguation",), "disambiguation"),
        (("release_titles",), "release_titles"),
    ):
        source = next((key for key in sources if key in payload), None)
        if source:
            result[target] = payload[source]
    if isinstance(payload.get("aliases"), list):
        result["aliases"] = _bounded_aliases(payload["aliases"], 24)
    result.update({key: value for key, value in _artist_area(payload).items() if value})
    return result


def _artist_area(payload: Mapping[str, object]) -> JsonDict:
    """The area MusicBrainz gives an artist (a country, region or city such as "Chico"), with its
    MBID; where it names no country, a split name's label shows it (owner 2026-11-17, 0257)."""
    area = payload.get("area") if isinstance(payload.get("area"), Mapping) else {}
    name = _text(area.get("name"))[:256]
    return {"area_mbid": _valid_mbid(area.get("id")) if name else None, "area_name": name or None}


class MusicBrainzClient:
    def __init__(
        self,
        *,
        base_url: str = _DEFAULT_BASE_URL,
        user_agent: str,
        get_json: Callable[..., tuple[dict | None, JsonDict]] = default_get_json,
        count_matches: Callable[..., tuple[int | None, JsonDict]] = count_json_matches,
        search_page_size: int = 25,
        max_search_pages: int = 4,
        max_candidates: int = 25,
    ) -> None:
        self.base_url = (_text(base_url) or _DEFAULT_BASE_URL).rstrip("/")
        self.user_agent = _text(user_agent)
        self.get_json = get_json
        self.count_matches = count_matches
        self.search_page_size = max(1, min(_integer(search_page_size, 25), 100))
        self.max_search_pages = max(1, _integer(max_search_pages, 4))
        self.max_candidates = max(1, _integer(max_candidates, 25))

    def lookup_artist(self, mbid: object, *, discovered_by_search: bool = False) -> JsonDict:
        normalized = _valid_mbid(mbid)
        if not normalized:
            return {"classification": "invalid_request", "artist": None}
        query = urllib.parse.urlencode({"fmt": "json", "inc": "aliases+genres+tags+url-rels"})
        payload, transport = self.get_json(
            f"{self.base_url}/artist/{normalized}?{query}",
            self.user_agent,
        )
        if payload is None:
            return {
                "classification": _transport_classification(transport, discovered_by_search=discovered_by_search),
                "artist": None,
                "transport": transport,
            }
        artist = project_artist(payload)
        if artist is None:
            return {"classification": "invalid_response", "artist": None, "transport": transport}
        return {"classification": "matched", "artist": artist, "transport": transport}

    def browse_release_group_titles(
        self,
        mbid: object,
        *,
        wanted_titles: object = (),
        max_pages: int = 5,
        page_size: int = 100,
    ) -> JsonDict:
        """Return a candidate's release-group titles for local-album evidence.

        Paging is bounded and stops early once every wanted local title is seen.
        """
        normalized = _valid_mbid(mbid)
        if not normalized:
            return {"classification": "invalid_request", "titles": []}
        wanted = {release_title_key(title) for title in wanted_titles or ()} - {""}
        titles: list[str] = []
        release_groups: list[JsonDict] = []
        seen: set[str] = set()
        for page in range(max(1, int(max_pages))):
            query = urllib.parse.urlencode({
                "artist": normalized,
                "fmt": "json",
                "limit": page_size,
                "offset": page * page_size,
            })
            payload, transport = self.get_json(f"{self.base_url}/release-group?{query}", self.user_agent)
            if not isinstance(payload, dict):
                return {"classification": _transport_classification(transport), "titles": titles,
                        "transport": transport}
            groups = payload.get("release-groups")
            if not isinstance(groups, list):
                return {"classification": "invalid_response", "titles": titles, "transport": transport}
            for group in groups:
                title = _text(group.get("title")) if isinstance(group, dict) else ""
                if title:
                    titles.append(title)
                    release_groups.append({
                        "id": _valid_mbid(group.get("id")),
                        "title": title,
                        "first_release_date": _text(group.get("first-release-date")) or None,
                        # An alternative title often lives here ("Straka v hrsti").
                        "disambiguation": _text(group.get("disambiguation")) or None,
                    })
                    seen.add(release_title_key(title))
            total = _integer(payload.get("release-group-count"))
            if (wanted and wanted <= seen) or (page + 1) * page_size >= total:
                break
        return {"classification": "complete", "titles": titles, "groups": release_groups}

    def search_releases(self, title: object, *, credit_name: object = None, phrase: bool = True,
                        limit: int = 25) -> JsonDict:
        """Releases titled like a local album, with their artist credits.

        With ``credit_name`` the search also requires that credited name, which
        reaches an artist known under another name ("3 Crows" on Chris Buck).
        ``phrase=False`` searches the escaped words instead: the index reads
        "It's" as "its", so a phrase can miss a title the words still find.
        """
        query_title = _text(title)
        if not query_title:
            return {"classification": "invalid_request", "releases": []}

        def field(name: str, value: str) -> str:
            return f'{name}:"{_escape_phrase(value)}"' if phrase else f"{name}:({_plain_artist_query(value)})"

        query_text = field("release", query_title)
        if _text(credit_name):
            query_text += " AND " + field("artistname", _text(credit_name))
        query = urllib.parse.urlencode({"query": query_text, "fmt": "json", "limit": max(1, min(int(limit), 100))})
        payload, transport = self.get_json(f"{self.base_url}/release/?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "releases": [], "transport": transport}
        releases: list[JsonDict] = []
        for raw in payload.get("releases") or []:
            if not isinstance(raw, dict):
                continue
            group = raw.get("release-group") if isinstance(raw.get("release-group"), dict) else {}
            credits = [
                {"name": _text(credit.get("name")), "artist_mbid": _valid_mbid(credit["artist"].get("id")),
                 "artist_name": _text(credit["artist"].get("name"))}
                for credit in raw.get("artist-credit") or []
                if isinstance(credit, dict) and isinstance(credit.get("artist"), dict)
            ]
            releases.append({
                "id": _valid_mbid(raw.get("id")), "title": _text(raw.get("title")),
                "date": _text(raw.get("date")) or None, "track_count": _integer(raw.get("track-count")),
                "release_group_id": _valid_mbid(group.get("id")),
                "release_group_title": _text(group.get("title")) or None,
                "credits": [credit for credit in credits if credit["artist_mbid"]],
            })
        return {"classification": "complete" if releases else "not_found", "releases": releases}

    def search_releases_by_barcode(self, barcode: object) -> JsonDict:
        """Releases carrying this barcode (a Discogs release's barcode leads back to MusicBrainz)."""
        digits = re.sub(r"\D", "", _text(barcode))
        if not 8 <= len(digits) <= 14:
            return {"classification": "invalid_request", "releases": []}
        query = urllib.parse.urlencode({"query": f"barcode:{digits}", "fmt": "json", "limit": 10})
        payload, transport = self.get_json(f"{self.base_url}/release/?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "releases": [], "transport": transport}
        releases = [
            {"id": _valid_mbid(raw.get("id")), "title": _text(raw.get("title")), "barcode": _text(raw.get("barcode")),
             "release_group_id": _valid_mbid((raw.get("release-group") or {}).get("id"))
             if isinstance(raw.get("release-group"), dict) else None,
             "credits": _artist_credit(raw.get("artist-credit"))}
            for raw in payload.get("releases") or []
            if isinstance(raw, dict) and _valid_mbid(raw.get("id")) and re.sub(r"\D", "", _text(raw.get("barcode"))) == digits
        ]
        return {"classification": "complete" if releases else "not_found", "releases": releases}

    def release_group_tracks(self, release_group_id: object, *, track_count: int = 0,
                             exclude: tuple[str, ...] = ()) -> JsonDict:
        """The tracks of the release in a release group closest to ``track_count``.

        ``exclude`` skips releases already compared."""
        group = _valid_mbid(release_group_id)
        if not group:
            return {"classification": "invalid_request", "tracks": []}
        query = urllib.parse.urlencode({"release-group": group, "inc": "media", "fmt": "json", "limit": 25})
        payload, transport = self.get_json(f"{self.base_url}/release?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "tracks": [], "transport": transport}
        releases = [release for release in payload.get("releases") or [] if isinstance(release, dict)]
        if not releases:
            return {"classification": "not_found", "tracks": []}

        def count(release: JsonDict) -> int:
            return sum(_integer(medium.get("track-count")) for medium in release.get("media") or [] if isinstance(medium, dict))

        remaining = [release for release in releases if _valid_mbid(release.get("id")) not in exclude]
        if not remaining:
            return {"classification": "not_found", "tracks": []}
        best = min(remaining, key=lambda release: (abs(count(release) - int(track_count or 0)), _text(release.get("date")) or "9999"))
        others = len(remaining) > 1
        release_id = _valid_mbid(best.get("id"))
        if not release_id:
            return {"classification": "invalid_response", "tracks": []}
        query = urllib.parse.urlencode({"inc": "recordings", "fmt": "json"})
        payload, transport = self.get_json(f"{self.base_url}/release/{release_id}?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "tracks": [], "transport": transport}
        tracks = [
            {"title": _text(track.get("title")), "length": _integer(track.get("length"))}
            for medium in payload.get("media") or [] if isinstance(medium, dict)
            for track in _audio_tracks(medium)
        ]
        return {"classification": "complete", "tracks": tracks, "release_id": release_id, "other_releases": others}

    def release_group_editions(self, release_group_id: object) -> JsonDict:
        """The group's releases with their audio track counts and dates (the editions the
        track-order choice compares), from the same browse ``release_group_tracks`` reads."""
        group = _valid_mbid(release_group_id)
        if not group:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"release-group": group, "inc": "media", "fmt": "json", "limit": 25})
        payload, transport = self.get_json(f"{self.base_url}/release?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        return {"classification": "complete", "releases": [
            {"id": _valid_mbid(release.get("id")), "date": _text(release.get("date")) or None,
             "track_count": sum(_integer(medium.get("track-count")) for medium in release.get("media") or []
                                if isinstance(medium, dict) and _is_audio_medium(medium))}
            for release in payload.get("releases") or []
            if isinstance(release, dict) and _valid_mbid(release.get("id"))]}

    def browse_release_discs(self, mbid: object, *, max_pages: int = 3, page_size: int = 100) -> JsonDict:
        """An artist's releases with their discs (title, position, format, track count),
        so a local album can match one disc of a box set."""
        normalized = _valid_mbid(mbid)
        if not normalized:
            return {"classification": "invalid_request", "releases": []}
        releases: list[JsonDict] = []
        for page in range(max(1, int(max_pages))):
            query = urllib.parse.urlencode({"artist": normalized, "inc": "media release-groups", "fmt": "json",
                                            "limit": page_size, "offset": page * page_size})
            payload, transport = self.get_json(f"{self.base_url}/release?{query}", self.user_agent)
            if not isinstance(payload, dict):
                return {"classification": _transport_classification(transport), "releases": releases,
                        "transport": transport}
            for raw in payload.get("releases") or []:
                if not isinstance(raw, dict) or not _valid_mbid(raw.get("id")):
                    continue
                releases.append({
                    "id": _valid_mbid(raw.get("id")), "title": _text(raw.get("title")),
                    "date": _text(raw.get("date")) or None,
                    "release_group_id": _valid_mbid((raw.get("release-group") or {}).get("id"))
                    if isinstance(raw.get("release-group"), dict) else None,
                    "discs": [{"position": _integer(medium.get("position")), "title": _text(medium.get("title")),
                               "format": _text(medium.get("format")), "track_count": _integer(medium.get("track-count"))}
                              for medium in raw.get("media") or [] if isinstance(medium, dict)],
                })
            if (page + 1) * page_size >= _integer(payload.get("release-count")):
                break
        return {"classification": "complete" if releases else "not_found", "releases": releases}

    def lookup_release(self, release_mbid: object) -> JsonDict:
        """One release with its release group and credited artists (a local album's
        Last.fm identifier, checked against the album's own title before it counts)."""
        normalized = _valid_mbid(release_mbid)
        if not normalized:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"inc": "release-groups artist-credits media", "fmt": "json"})
        payload, transport = self.get_json(f"{self.base_url}/release/{normalized}?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        group = payload.get("release-group") if isinstance(payload.get("release-group"), dict) else {}
        return {"classification": "complete", "release": {
            "id": normalized, "title": _text(payload.get("title")), "date": _text(payload.get("date")) or None,
            "track_count": sum(_integer(medium.get("track-count")) for medium in payload.get("media") or []
                               if isinstance(medium, dict)),
            "release_group_id": _valid_mbid(group.get("id")),
            "release_group_title": _text(group.get("title")) or None,
            "credits": [
                {"name": _text(credit.get("name")), "artist_mbid": _valid_mbid(credit["artist"].get("id")),
                 "artist_name": _text(credit["artist"].get("name"))}
                for credit in payload.get("artist-credit") or []
                if isinstance(credit, dict) and isinstance(credit.get("artist"), dict)
                and _valid_mbid(credit["artist"].get("id"))
            ],
        }}

    def lookup_release_group(self, release_group_mbid: object) -> JsonDict:
        """A release group's raw types, first-release date, genres (most votes first) and the
        series it is part of."""
        normalized = _valid_mbid(release_group_mbid)
        if not normalized:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"inc": "genres series-rels", "fmt": "json"})
        payload, transport = self.get_json(f"{self.base_url}/release-group/{normalized}?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        genres = [
            {"name": _text(genre.get("name")), "count": _integer(genre.get("count"))}
            for genre in payload.get("genres") or [] if isinstance(genre, dict) and _text(genre.get("name"))
        ]
        return {"classification": "complete", "release_group": {
            "id": normalized, "title": _text(payload.get("title")),
            "primary_type": _text(payload.get("primary-type")) or None,
            "secondary_types": [_text(kind) for kind in payload.get("secondary-types") or [] if _text(kind)],
            "first_release_date": _text(payload.get("first-release-date")) or None,
            "disambiguation": _text(payload.get("disambiguation")) or None,
            "genres": sorted(genres, key=lambda genre: (-genre["count"], genre["name"].casefold())),
            "series": _series_parts(payload.get("relations")),
        }}

    def lookup_series(self, series_mbid: object) -> JsonDict:
        """How many release groups and releases MusicBrainz lists in a series, counted up to
        SERIES_SIZE_CUTOFF: a list or an award names far more albums than a real series.

        The web service has no count and no paged browse for a series' members; its lookup
        returns every one in a single payload (30 MB for the largest lists). So the response
        is counted while it streams and closed at the cutoff, never parsed or cached. An
        album's own series and number come from its release and release group lookups."""
        normalized = _valid_mbid(series_mbid)
        if not normalized:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"inc": "release-group-rels release-rels", "fmt": "json"})
        count, transport = self.count_matches(f"{self.base_url}/series/{normalized}?{query}", self.user_agent,
                                              pattern=_SERIES_MEMBER, stop_at=SERIES_SIZE_CUTOFF)
        if count is None:
            return {"classification": _transport_classification(transport), "transport": transport}
        return {"classification": "complete", "series": {"id": normalized, "member_count": count}}

    def lookup_series_links(self, series_mbid: object) -> JsonDict:
        """A series' URL relationships (Wikipedia, Wikidata), for its general information."""
        normalized = _valid_mbid(series_mbid)
        if not normalized:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"inc": "url-rels", "fmt": "json"})
        payload, transport = self.get_json(f"{self.base_url}/series/{normalized}?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        relations = payload.get("relations")
        return {"classification": "complete", "relations": relations if isinstance(relations, list) else []}

    def original_release_id(self, release_group_mbid: object) -> JsonDict:
        """The release group's original release: the earliest dated official release
        (undated and unofficial ones only when nothing else exists), and the fewest audio
        discs any of its releases has (owner 2026-11-16: that many discs are the main album;
        None when MusicBrainz lists no media)."""
        group = _valid_mbid(release_group_mbid)
        if not group:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"release-group": group, "inc": "media", "fmt": "json", "limit": 100})
        payload, transport = self.get_json(f"{self.base_url}/release?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        releases = [release for release in payload.get("releases") or []
                    if isinstance(release, dict) and _valid_mbid(release.get("id"))]
        if not releases:
            return {"classification": "not_found"}
        original = min(releases, key=lambda release: (
            _text(release.get("status")) != "Official", not _text(release.get("date")),
            _text(release.get("date")), _valid_mbid(release.get("id"))))
        discs = [sum(1 for medium in release["media"] if isinstance(medium, dict) and _is_audio_medium(medium))
                 for release in releases if isinstance(release.get("media"), list)]
        return {"classification": "complete", "release_id": _valid_mbid(original.get("id")),
                "fewest_discs": min((count for count in discs if count), default=None)}

    def lookup_release_tracklist(self, release_mbid: object) -> JsonDict:
        """One release's media with every track and its artist credit, for the main-album
        end, the track artists shown in place of unreadable tags and the series it is part of."""
        normalized = _valid_mbid(release_mbid)
        if not normalized:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"inc": "recordings artist-credits release-groups series-rels", "fmt": "json"})
        payload, transport = self.get_json(f"{self.base_url}/release/{normalized}?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        group = payload.get("release-group") if isinstance(payload.get("release-group"), dict) else {}
        media = []
        for medium in payload.get("media") or []:
            if not isinstance(medium, dict):
                continue
            # Positions count audio tracks only, as a local rip numbers them.
            tracks = [{"position": index, "title": _text(track.get("title")),
                       "length": _integer(track.get("length")) or None,
                       "artist_credit": _artist_credit(track.get("artist-credit"))}
                      for index, track in enumerate(_audio_tracks(medium), start=1)]
            media.append({
                "position": _integer(medium.get("position")), "title": _text(medium.get("title")) or None,
                "format": _text(medium.get("format")) or None, "track_count": len(tracks), "tracks": tracks,
            })
        return {"classification": "complete", "release": {
            "id": normalized, "title": _text(payload.get("title")), "date": _text(payload.get("date")) or None,
            "country": _text(payload.get("country")) or None, "barcode": _text(payload.get("barcode")) or None,
            "status": _text(payload.get("status")) or None, "disambiguation": _text(payload.get("disambiguation")) or None,
            "release_group_id": _valid_mbid(group.get("id")),
            "artist_credit": _artist_credit(payload.get("artist-credit")), "media": media,
            "series": _series_parts(payload.get("relations")),
        }}

    def lookup_release_discogs_id(self, release_mbid: object) -> JsonDict:
        """The Discogs release a MusicBrainz release links to, for its tracklist headings (S8)."""
        normalized = _valid_mbid(release_mbid)
        if not normalized:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"inc": "url-rels", "fmt": "json"})
        payload, transport = self.get_json(f"{self.base_url}/release/{normalized}?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        return {"classification": "complete",
                "discogs_release_id": discogs_link_id(payload.get("relations"), "release")}

    def lookup_release_transliteration(self, release_mbid: object) -> JsonDict:
        """The Latin pseudo-release holding a release's transliterated tracklist (S7), or None,
        and the release's MusicBrainz language ("jpn"; "" when it gives none)."""
        normalized = _valid_mbid(release_mbid)
        if not normalized:
            return {"classification": "invalid_request"}
        query = urllib.parse.urlencode({"inc": "release-rels", "fmt": "json"})
        payload, transport = self.get_json(f"{self.base_url}/release/{normalized}?{query}", self.user_agent)
        if not isinstance(payload, dict):
            return {"classification": _transport_classification(transport), "transport": transport}
        representation = payload.get("text-representation")
        language = _text(representation.get("language")) if isinstance(representation, dict) else ""
        return {"classification": "complete", "transliteration_mbid": latin_transliteration_id(payload),
                "language": language if re.fullmatch(r"[a-z]{3}", language) else ""}

    def search_artists(self, name: object, *, phrase: bool = True, max_pages: int | None = None) -> JsonDict:
        """Search by exact phrase, or with ``phrase=False`` by escaped plain terms.

        The phrase query misses names whose punctuation or spacing differs from
        MusicBrainz ("A.A.Williams"); the plain query ranks those first.
        """
        query_name = _text(name)
        if not query_name:
            return {"classification": "invalid_request", "candidates": [], "truncated": False}
        query_text = f'artist:"{query_name}"' if phrase else _plain_artist_query(query_name)
        page_limit = self.max_search_pages if max_pages is None else max(1, min(max_pages, self.max_search_pages))
        candidates: dict[str, JsonDict] = {}
        advertised_count = 0
        pages_completed = 0
        for page in range(page_limit):
            offset = page * self.search_page_size
            query = urllib.parse.urlencode({
                "query": query_text,
                "fmt": "json",
                "limit": self.search_page_size,
                "offset": offset,
            })
            payload, transport = self.get_json(f"{self.base_url}/artist/?{query}", self.user_agent)
            if not isinstance(payload, dict):
                ordered_partial = sorted(
                    candidates.values(),
                    key=lambda item: (-int(item["score"]), str(item["mbid"])),
                )
                return {
                    "classification": _transport_classification(transport),
                    "candidates": ordered_partial[:self.max_candidates],
                    "truncated": True,
                    "transport": transport,
                }
            pages_completed += 1
            try:
                advertised_count = max(advertised_count, int(payload.get("count") or 0))
            except (TypeError, ValueError):
                pass
            artists = payload.get("artists")
            if not isinstance(artists, list):
                return {
                    "classification": "invalid_response",
                    "candidates": [],
                    "truncated": False,
                    "transport": transport,
                }
            for raw_artist in artists:
                candidate = _candidate(raw_artist)
                if candidate is not None:
                    mbid = str(candidate["mbid"])
                    existing = candidates.get(mbid)
                    if existing is None or int(candidate["score"]) > int(existing["score"]):
                        candidates[mbid] = candidate
            if (offset + self.search_page_size) >= advertised_count:
                break
        ordered = sorted(candidates.values(), key=lambda item: (-int(item["score"]), str(item["mbid"])))
        capacity = pages_completed * self.search_page_size
        truncated = advertised_count > capacity or len(ordered) > self.max_candidates
        return {
            "classification": "complete" if ordered else "not_found",
            "candidates": ordered[:self.max_candidates],
            "truncated": truncated,
        }
