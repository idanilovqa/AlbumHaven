"""What kind of change each MusicBrainz data correction is, and which apply without a click
(MusicBrainz Delivery 2, S4; owner 2026-11-16, "Data Correction flow").

Pure functions: an album's tags and its certain release go in, classified difference rows come
out. The classifier follows the read-only breakdown of sandbox6 (mbd2-s4-correction-kinds),
first kind that fits, top to bottom. Curly against straight quotes, apostrophes and dashes are
not differences at all (owner: "Keep ignoring").
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping

from music_app.services.musicbrainz_release_identity import credit_text
from music_app.services.musicbrainz_track_order import same_track_title

KINDS = (
    "case", "spacing", "case_spacing", "punctuation", "accents", "small_edit", "edition_suffix",
    "track_title", "album_title", "track_artist_renamed", "track_artist_joined", "album_artist_renamed",
    "album_artist_joined",
)
# Applied without a click (display only until PR 53 writes tags).
AUTO_KINDS = frozenset({"case", "spacing", "case_spacing", "punctuation", "accents", "small_edit"})
# Wait for the owner; artist kinds only ever per album, never per kind or all at once.
ARTIST_KINDS = frozenset({"track_artist_renamed", "track_artist_joined", "album_artist_renamed",
                          "album_artist_joined"})
REVIEW_KINDS = frozenset(KINDS) - AUTO_KINDS
SUBSTANTIAL_TITLE_KINDS = frozenset({"track_title", "album_title"})
# More than this share of an album's titles changing substantially sends it to review whole.
GUARD_SHARE = 0.30

_TYPOGRAPHIC = str.maketrans("’‘ʼ`´“”„–—‐‑",
                             "'''''\"\"\"----")
_SUFFIX = re.compile(r"\s*([\(\[][^\)\]]*[\)\]]|\s-\s.*)$")
_JOINED = re.compile(r"\b(feat\.?|ft\.?|featuring|with|vs\.?|x)\b|[&,;]| and ", re.IGNORECASE)


def comparable(value: object) -> str:
    """The text as compared: typographic quotes, apostrophes and dashes as plain ASCII."""
    return unicodedata.normalize("NFC", str(value or "")).translate(_TYPOGRAPHIC).replace("…", "...")


def _spaced(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _letters(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.casefold())


def _unaccented(text: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))


def _without_suffixes(text: str) -> str:
    previous = None
    while previous != text:
        previous, text = text, _SUFFIX.sub("", text).strip()
    return text


def _within_two_edits(left: str, right: str) -> bool:
    if abs(len(left) - len(right)) > 2:
        return False
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, 1):
        current = [row]
        for column, right_char in enumerate(right, 1):
            current.append(min(previous[column] + 1, current[column - 1] + 1,
                               previous[column - 1] + (left_char != right_char)))
        previous = current
    return previous[-1] <= 2


def classify(field: str, current: object, proposed: object) -> str:
    """The kind of one change; ``field`` is album, album_artist, title or artist."""
    a, b = comparable(current), comparable(proposed)
    if a.casefold() == b.casefold():
        return "case"
    if _spaced(a) == _spaced(b):
        return "spacing"
    if _spaced(a).casefold() == _spaced(b).casefold():
        return "case_spacing"
    if _letters(a) == _letters(b):
        return "punctuation"
    if _letters(_unaccented(a)) == _letters(_unaccented(b)):
        return "accents"
    if field in ("title", "album"):
        stripped = _without_suffixes(a)
        if stripped and stripped.casefold() == _without_suffixes(b).casefold():
            return "edition_suffix"
        if _within_two_edits(_letters(_unaccented(a)), _letters(_unaccented(b))):
            return "small_edit"
        return "track_title" if field == "title" else "album_title"
    prefix = "track_artist" if field == "artist" else "album_artist"
    return f"{prefix}_joined" if (_JOINED.search(a) or _JOINED.search(b)) else f"{prefix}_renamed"


def _differs(current: object, proposed: object) -> bool:
    return bool(str(proposed or "").strip()) and comparable(current) != comparable(proposed)


def compare_album(album: Mapping[str, object]) -> dict[str, object]:
    """Every difference between an album's tags and its certain release, classified.

    ``album`` carries title, artist_name, release_title, release_credit, media, tracks
    [{disc_number, track_number, title, artist}] and ``pairing`` as album_track_pairing
    returns it (None until the album is re-checked). Tracks pair by the stored edition pairing
    when reordered; by position when the order is exact; without a stored pairing, by position
    only where the titles agree. An ambiguous pairing compares no tracks and sends the album to
    review whole; so does the guard. Returns {"rows": [...], "review_whole": bool}."""
    rows: list[dict[str, object]] = []

    def add(field, disc, track, current, proposed):
        if _differs(current, proposed):
            rows.append({"field": field, "disc_number": disc, "track_number": track,
                         "current_value": str(current or ""), "proposed_value": str(proposed).strip(),
                         "kind": classify(field, current, proposed)})

    add("album", 0, 0, album.get("title"), album.get("release_title"))
    add("album_artist", 0, 0, album.get("artist_name"), album.get("release_credit"))
    pairing = album.get("pairing")
    quality = (pairing or {}).get("match_quality")
    by_position = {(int(medium.get("position") or 1), int(track.get("position") or 0)): track
                   for medium in album.get("media") or [] for track in medium.get("tracks") or []}
    first_medium = int(album.get("disc_position") or 1)
    compared_titles = 0
    if quality != "ambiguous":
        stored = (pairing or {}).get("pairing") or {}
        for local in album.get("tracks") or []:
            disc, number = int(local.get("disc_number") or 1), int(local.get("track_number") or 0)
            if quality == "reordered":
                remote = by_position.get(stored.get((disc, number)))
            else:
                remote = by_position.get((first_medium + disc - 1, number))
                if remote is not None and pairing is None and not same_track_title(local.get("title"), remote.get("title")):
                    remote = None
            if remote is None:
                continue
            compared_titles += 1
            add("title", disc, number, local.get("title"), remote.get("title"))
            add("artist", disc, number, local.get("artist"), credit_text(remote.get("artist_credit") or []))
    substantial = sum(1 for row in rows if row["field"] == "title" and row["kind"] == "track_title")
    review_whole = quality == "ambiguous" or (compared_titles > 0 and substantial / compared_titles > GUARD_SHARE)
    for row in rows:
        row["mode"] = "auto" if row["kind"] in AUTO_KINDS and not review_whole else "review"
    return {"rows": rows, "review_whole": review_whole}
