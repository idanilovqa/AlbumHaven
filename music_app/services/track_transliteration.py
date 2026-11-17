"""Latin forms of track titles in other scripts (MusicBrainz Delivery 2, S7).

Owner 2026-11-17 (1A): in the album details tracklist a title written in a script other than
Latin always shows its Latin form after it, "桜花抄 • Oukashou"; a Latin title shows nothing.
1E: "Cyrillic stays as it is", so a Cyrillic title never does either.

The Latin form comes from MusicBrainz first: the Latin pseudo-release its "transl-tracklisting"
relationship links to the album's matched release, fetched once per release by the album
release lane and stored (0252). Without one, a title with kana falls back to cutlet, and one
of ideographs only to cutlet when the release's MusicBrainz language is Japanese, else to
pypinyin with tone marks (owner 2026-11-17: "Use MB language", "exact pronunciation"; both in
requirements.txt; an install without them simply shows no fallback). Other scripts (Korean,
Greek, Arabic…) show only MusicBrainz's form. Tags, keys and sorting keep the real titles;
search also finds a track by its Latin form folded like a query (0255, latin_search_key).
"""
from __future__ import annotations

import json
import logging
import unicodedata
from collections.abc import Iterable, Mapping
from functools import lru_cache
from typing import Any

# Unicode blocks, so the decision never depends on a locale or a library version.
_LATIN = ((0x0041, 0x005A), (0x0061, 0x007A), (0x00AA, 0x00AA), (0x00BA, 0x00BA), (0x00C0, 0x02AF),
          (0x1D00, 0x1DBF), (0x1E00, 0x1EFF), (0x2C60, 0x2C7F), (0xA720, 0xA7FF), (0xAB30, 0xAB6F),
          (0xFF21, 0xFF3A), (0xFF41, 0xFF5A))
_CYRILLIC = ((0x0400, 0x052F), (0x1C80, 0x1C8F), (0x2DE0, 0x2DFF), (0xA640, 0xA69F))
_KANA = ((0x3040, 0x309F), (0x30A0, 0x30FF), (0x31F0, 0x31FF), (0xFF66, 0xFF9F))
# CJK ideographs with 々 〆 〇, the extensions and the compatibility ideographs.
_HAN = ((0x3005, 0x3007), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x3134F))


def _within(character: str, ranges: tuple[tuple[int, int], ...]) -> bool:
    code = ord(character)
    return any(start <= code <= end for start, end in ranges)


def _letters(text: object) -> list[str]:
    return [character for character in str(text or "") if character.isalpha()]


def needs_transliteration(title: object) -> bool:
    """A letter in any script but Latin and Cyrillic: Japanese, Chinese, Korean, Greek,
    Arabic… A title mixing Latin and Japanese needs one; digits and punctuation never do."""
    return any(not _within(letter, _LATIN) and not _within(letter, _CYRILLIC) for letter in _letters(title))


def _has(text: object, ranges: tuple[tuple[int, int], ...]) -> bool:
    return any(_within(letter, ranges) for letter in _letters(text))


@lru_cache(maxsize=1)
def _cutlet():
    try:
        import cutlet
    except ImportError:
        return None
    try:
        # The defaults the approved mockup was generated with (Hepburn, foreign spellings).
        return cutlet.Cutlet()
    except Exception:  # A missing dictionary: no fallback rather than a failed album page.
        logging.getLogger(__name__).warning("cutlet is installed but could not start; no Japanese fallback.")
        return None


def _romaji(title: str) -> str | None:
    katsu = _cutlet()
    return katsu.romaji(title) if katsu is not None else None


def _pinyin(title: str) -> str | None:
    try:
        from pypinyin import Style, lazy_pinyin
    except ImportError:
        return None
    text = ""
    for part in (part.strip() for part in lazy_pinyin(title, style=Style.TONE)):
        # Syllables and other words are spaced; punctuation stays against the word before it.
        if part:
            text += part if text and not any(character.isalnum() for character in part) else f" {part}"
    text = text.strip()
    return text[:1].upper() + text[1:]


def fallback_transliteration(title: object, *, japanese: bool) -> str | None:
    """The installed fallback's Latin form: cutlet for a title with kana, or with ideographs on
    a ``japanese`` album; pypinyin for other ideographs. None for any other script, when the
    library is missing, or when its answer is still not Latin."""
    text = str(title or "").strip()
    if not needs_transliteration(text):
        return None
    if _has(text, _KANA) or (japanese and _has(text, _HAN)):
        latin = _romaji(text)
    elif _has(text, _HAN):
        latin = _pinyin(text)
    else:
        return None
    latin = str(latin or "").strip()
    return latin if latin and not needs_transliteration(latin) else None


def transliteration_media(release: Mapping[str, object]) -> list[dict[str, object]]:
    """The stored form of a pseudo-release's tracklist (lookup_release_tracklist's release):
    each medium's position and its tracks' positions and titles."""
    return [{"position": int(medium.get("position") or 1),
             "tracks": [{"position": int(track.get("position") or 0), "title": str(track.get("title") or "")}
                        for track in medium.get("tracks") or [] if isinstance(track, Mapping)]}
            for medium in release.get("media") or [] if isinstance(medium, Mapping)]


def _musicbrainz_titles(tracks: list[Mapping[str, object]], stored: Mapping[str, object] | None,
                        ) -> dict[tuple[int, int], str]:
    """Each local (disc, track) and its title on the stored pseudo-release, paired as the data
    correction pairs tracks with the matched edition (album_track_pairing): through the stored
    pairing when reordered, by position when the order is exact (one disc of a larger release
    starts at its ``disc_position``), never when the pairing is ambiguous or not yet made."""
    quality = (stored or {}).get("match_quality")
    if quality not in {"order_exact", "reordered"}:
        return {}
    media = stored.get("media")
    if isinstance(media, str):
        media = json.loads(media)
    remote = {(int(medium.get("position") or 1), int(track.get("position") or 0)): str(track.get("title") or "")
              for medium in media or [] for track in medium.get("tracks") or []}
    pairing = stored.get("pairing") or {}
    first_medium = int(stored.get("disc_position") or 1)
    titles = {}
    for track in tracks:
        local = (int(track.get("disc_number") or 1), int(track.get("track_number") or 0))
        position = pairing.get(local) if quality == "reordered" else (first_medium + local[0] - 1, local[1])
        if remote.get(position):
            titles[local] = remote[position]
    return titles


def latin_search_key(text: object) -> str:
    """A Latin form or a search query folded alike (0255): without tone marks or accents,
    lower case, letters and digits only, so "Tiān mén", "tian men" and "tianmen" meet."""
    decomposed = unicodedata.normalize("NFKD", str(text or ""))
    return "".join(character for character in decomposed.casefold()
                   if character.isascii() and character.isalnum())


def track_transliterations(tracks: Iterable[Mapping[str, object]], *, stored: Mapping[str, object] | None = None,
                           ) -> dict[tuple[int, int], str]:
    """The Latin form to show beside each local (disc, track) whose title needs one:
    MusicBrainz's stored pseudo-release title first, else the installed fallback. Ideographs
    are read as Japanese only when the release's MusicBrainz language is Japanese."""
    tracks = [track for track in tracks if isinstance(track, Mapping)]
    wanted = [track for track in tracks if needs_transliteration(track.get("title"))]
    if not wanted:
        return {}
    musicbrainz = _musicbrainz_titles(tracks, stored)
    japanese = (stored or {}).get("language") == "jpn"
    shown = {}
    for track in wanted:
        local = (int(track.get("disc_number") or 1), int(track.get("track_number") or 0))
        latin = musicbrainz.get(local)
        if not latin or needs_transliteration(latin):
            latin = fallback_transliteration(track.get("title"), japanese=japanese)
        if latin:
            shown[local] = latin.strip()
    return shown


def stored_transliteration(connection: Any, album_id: object) -> dict[str, object] | None:
    """The album's certain release's stored answer: its Latin pseudo-release with the track
    pairing, when MusicBrainz links one, and its language. None when not fetched yet."""
    from music_app.services.musicbrainz_enrichment_postgres import _row_mapping
    from music_app.services.musicbrainz_release_identity_postgres import parse_track_pairing

    row = connection.execute(
        """
        select decision.release_mbid::text as release_mbid, decision.match_quality, decision.track_pairing,
               decision.track_order_differs, decision.disc_position, transliteration.media,
               transliteration.language
        from library.local_albums album
        join library.local_album_musicbrainz_releases decision
          on decision.library_id = album.library_id and decision.album_key = album.album_key
         and decision.state = 'release'
        join integration.musicbrainz_release_transliterations transliteration
          on transliteration.release_mbid = decision.release_mbid and transliteration.checked_at is not null
        where album.id = %(album_id)s
        """,
        {"album_id": album_id},
    ).fetchone()
    if not row:
        return None
    row = _row_mapping(row)
    return {**(parse_track_pairing(row) or {}), "disc_position": row.get("disc_position"), "media": row.get("media"),
            "language": row.get("language") or ""}


def apply_track_transliterations(connection: Any, album: dict[str, object] | None, *,
                                 album_id: object) -> dict[str, object] | None:
    """Name each track row's Latin form (``title_transliteration``) where its title needs one.
    The stored MusicBrainz form is read only for an album that has such a title."""
    rows = [row for row in (album or {}).get("track_rows") or [] if isinstance(row, dict)]
    if not album_id or not any(needs_transliteration(row.get("title")) for row in rows):
        return album
    shown = track_transliterations(rows, stored=stored_transliteration(connection, album_id))
    for row in rows:
        latin = shown.get((int(row.get("disc_number") or 1), int(row.get("track_number") or 0)))
        if latin:
            row["title_transliteration"] = latin
    return album


# Albums with a track whose title may need a Latin form (the claim's test, refined in Python)
# and no current row for it: none yet, its title changed, or the album's release decision or
# MusicBrainz answer is newer than the row.
_DUE_LATIN_ALBUMS_SQL = r"""
    select distinct albums.id as album_id, albums.library_id, albums.album_key
    from library.local_albums albums
    join library.local_tracks tracks on tracks.library_id = albums.library_id and tracks.album_id = albums.id
    left join library.local_track_latin_titles latin on latin.track_id = tracks.id
    left join library.local_album_musicbrainz_releases decision
      on decision.library_id = albums.library_id and decision.album_key = albums.album_key and decision.state = 'release'
    left join integration.musicbrainz_release_transliterations transliteration
      on transliteration.release_mbid = decision.release_mbid
    where albums.library_id = any(%(library_ids)s)
      and ((tracks.title ~ '[^\x01-ɏЀ-ԯḀ-ỿ -⁯]'
            and (latin.track_id is null
                 or latin.computed_at < greatest(decision.updated_at, transliteration.updated_at)))
           or (latin.track_id is not null and latin.source_title is distinct from tracks.title))
    order by albums.id
    limit %(limit)s
"""


def refresh_latin_titles(connection: Any, *, library_ids: list[int], limit: int, now: object) -> list[str]:
    """Store the shown Latin form and its search key of each track of up to ``limit`` due
    albums (0255); a track needing none keeps no row, one with no known form a null one.
    Returns the refreshed albums' keys."""
    from music_app.services.musicbrainz_enrichment_postgres import _row_mapping

    albums = [_row_mapping(row) for row in connection.execute(
        _DUE_LATIN_ALBUMS_SQL, {"library_ids": library_ids, "limit": limit}).fetchall()]
    for album in albums:
        tracks = [_row_mapping(row) for row in connection.execute(
            "select id, disc_number, track_number, title from library.local_tracks where album_id = %(album_id)s",
            {"album_id": album["album_id"]}).fetchall()]
        shown = track_transliterations(tracks, stored=stored_transliteration(connection, album["album_id"]))
        rows = []
        for track in tracks:
            if not needs_transliteration(track.get("title")):
                continue
            latin = shown.get((int(track.get("disc_number") or 1), int(track.get("track_number") or 0)))
            key = latin_search_key(latin) or None
            rows.append({"track_id": track["id"], "title": str(track.get("title") or ""),
                         "latin": latin if key else None, "key": key})
        connection.execute(
            "delete from library.local_track_latin_titles where track_id = any(%(track_ids)s)"
            " and track_id <> all(%(kept)s)",
            {"track_ids": [track["id"] for track in tracks], "kept": [row["track_id"] for row in rows]})
        for row in rows:
            connection.execute(
                "insert into library.local_track_latin_titles (track_id, library_id, source_title, latin, search_key,"
                " computed_at) values (%(track_id)s, %(library_id)s, %(title)s, %(latin)s, %(key)s, %(now)s)"
                " on conflict (track_id) do update set source_title = excluded.source_title, latin = excluded.latin,"
                " search_key = excluded.search_key, computed_at = excluded.computed_at",
                {**row, "library_id": album["library_id"], "now": now})
    return [str(album["album_key"]) for album in albums]
