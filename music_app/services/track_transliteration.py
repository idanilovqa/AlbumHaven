"""Latin forms of track titles in other scripts (MusicBrainz Delivery 2, S7).

Owner 2026-11-17 (1A): in the album details tracklist a title written in a script other than
Latin always shows its Latin form after it, "桜花抄 • Oukashou"; a Latin title shows nothing.
1E: "Cyrillic stays as it is", so a Cyrillic title never does either. Nor does a title that
already reads in Latin (owner 2026-11-21, "Hide if title has Latin"): "Gianizm Ten (ジャイアニズム天)".

The Latin form comes from MusicBrainz first: the Latin pseudo-release its "transl-tracklisting"
relationship links to the album's matched release, fetched once per release by the album
release lane and stored (0252). Without one, a title with kana falls back to cutlet, and one
of ideographs only by the album's evidence (0270):
to cutlet when MusicBrainz says Japanese, another of the album's titles has kana or the artist
is from Japan; else to pypinyin with tone marks ("exact pronunciation") when MusicBrainz says
Chinese or the artist is from China, Taiwan, Hong Kong or Macao; with neither, to nothing.
Both are in requirements.txt; an install without them shows no fallback. Other scripts (Korean,
Greek, Arabic…) show only MusicBrainz's form. Tags, keys and sorting keep the real titles;
search also finds a track by its Latin form folded like a query (0255, latin_search_key).

An album title gets its Latin form the same way, from the installed fallback by the same
evidence (0256): phone album rows show it under the title (approved b3-1d3) and
search finds the album by its folded key.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from collections.abc import Iterable, Mapping
from functools import lru_cache
from typing import Any

# Unicode blocks, so the decision never depends on a locale or a library version.
_LATIN = ((0x0041, 0x005A), (0x0061, 0x007A), (0x00AA, 0x00AA), (0x00BA, 0x00BA), (0x00C0, 0x02AF),
          (0x1D00, 0x1DBF), (0x1E00, 0x1EFF), (0x2C60, 0x2C7F), (0xA720, 0xA7FF), (0xAB30, 0xAB6F),
          (0xFF21, 0xFF3A), (0xFF41, 0xFF5A))
_CYRILLIC = ((0x0400, 0x052F), (0x1C80, 0x1C8F), (0x2DE0, 0x2DFF), (0xA640, 0xA69F))
# Kana letters. Not the middle dot and other marks of those blocks, which Chinese titles use too.
_KANA = ((0x3041, 0x3096), (0x309D, 0x309F), (0x30A1, 0x30FA), (0x30FC, 0x30FF), (0x31F0, 0x31FF),
         (0xFF66, 0xFF9F))
# CJK ideographs with 々 〆 〇, the extensions and the compatibility ideographs.
_HAN = ((0x3005, 0x3007), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x3134F))
# An album's evidence (_READING_EVIDENCE): MusicBrainz languages, the artist's countries, kana.
_JAPANESE_LANGUAGES, _JAPANESE_COUNTRIES = ("jpn",), ("JP",)
_CHINESE_LANGUAGES, _CHINESE_COUNTRIES = ("zho", "cmn", "yue"), ("CN", "TW", "HK", "MO")


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


def _bracketed(text: object) -> tuple[str, list[str]]:
    """The text outside brackets, and each outermost bracket's content."""
    outside, groups, depth = "", [], 0
    for character in str(text or ""):
        if character in "([（［【":
            depth += 1
            if depth == 1:
                groups.append("")
                continue
        elif character in ")]）］】" and depth:
            depth -= 1
            if not depth:
                continue
        if depth:
            groups[-1] += character
        else:
            outside += character
    return outside, groups


def _reads_in_latin(title: object, latin: object) -> bool:
    """The title already gives its reading: Latin words with the original in brackets after
    them ("Jinsei Game (人生ゲイム)"), or the original with that same Latin form in brackets
    ("桜花抄 (Oukashou)"). Other Latin words are none: "Hello 世界", "桜花抄 (Live)", and a
    bracket opening with Latin ("(feat. 初音ミク)", "(Live at 武道館)")."""
    outside, groups = _bracketed(title)
    if not needs_transliteration(outside):
        openings = ("".join(_letters(group))[:1] for group in groups)
        return _has(outside, _LATIN) and any(needs_transliteration(opening) for opening in openings)
    reading = latin_search_key(_bracketed(latin)[0])
    return bool(reading) and reading in (latin_search_key(group) for group in groups)


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


# A run of Japanese text: kana, ideographs, CJK punctuation and full-width forms. Only these go
# to cutlet; the title's other text stays as written ("Jishō" is not cutlet's to spell, and it
# answers "?" for letters it does not know).
_JAPANESE_RUN = re.compile("[　-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿"
                           "＀-￯\U00020000-\U0003134f]+")


def _romaji(title: str) -> str | None:
    """Each Japanese run in romaji, the rest kept; None when cutlet cannot read a run (its "?")."""
    katsu = _cutlet()
    if katsu is None:
        return None
    pieces, end = [], 0
    for run in _JAPANESE_RUN.finditer(title):
        latin = str(katsu.romaji(run.group()) or "").strip()
        if not latin or latin.count("?") > run.group().count("?"):
            return None
        # cutlet capitalizes the start of what it reads; mid-title that is not a sentence start.
        pieces += [title[end:run.start()], latin if run.start() == 0 else latin[:1].lower() + latin[1:]]
        end = run.end()
    return "".join(pieces + [title[end:]])


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


def _album_reading(stored: Mapping[str, object] | None) -> str | None:
    """How the album's ideographs read: "japanese" on any Japanese evidence, else "chinese" on
    Chinese evidence, else None."""
    evidence = set(str((stored or {}).get("evidence") or "").split())
    if evidence & {"kana", *_JAPANESE_LANGUAGES, *_JAPANESE_COUNTRIES}:
        return "japanese"
    return "chinese" if evidence & {*_CHINESE_LANGUAGES, *_CHINESE_COUNTRIES} else None


def fallback_transliteration(title: object, *, reading: str | None) -> str | None:
    """The installed fallback's Latin form: cutlet for a title with kana, or with ideographs
    read as Japanese; pypinyin for ideographs read as Chinese. None for ideographs with no
    reading and any other script, when the library is missing, or when its answer is not Latin."""
    text = str(title or "").strip()
    if not needs_transliteration(text):
        return None
    if _has(text, _KANA) or (reading == "japanese" and _has(text, _HAN)):
        latin = _romaji(text)
    elif reading == "chinese" and _has(text, _HAN):
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
    MusicBrainz's stored pseudo-release title first, else the installed fallback, reading
    ideographs by the album's evidence."""
    tracks = [track for track in tracks if isinstance(track, Mapping)]
    wanted = [track for track in tracks if needs_transliteration(track.get("title"))]
    if not wanted:
        return {}
    musicbrainz = _musicbrainz_titles(tracks, stored)
    reading = _album_reading(stored)
    shown = {}
    for track in wanted:
        local = (int(track.get("disc_number") or 1), int(track.get("track_number") or 0))
        latin = musicbrainz.get(local)
        if not latin or needs_transliteration(latin):
            latin = fallback_transliteration(track.get("title"), reading=reading)
        if latin and not _reads_in_latin(track.get("title"), latin):
            shown[local] = latin.strip()
    return shown


def album_title_transliteration(title: object, *, stored: Mapping[str, object] | None = None) -> str | None:
    """The Latin form to show under an album title that needs one: the installed fallback,
    reading ideographs by the album's evidence.
    MusicBrainz stores no Latin release title, so there is no MusicBrainz form to prefer."""
    latin = fallback_transliteration(title, reading=_album_reading(stored))
    return None if not latin or _reads_in_latin(title, latin) else latin


def stored_transliteration(connection: Any, album_id: object) -> dict[str, object] | None:
    """What the album's readings are made from: the evidence for its ideographs and, from its
    certain release's stored answer, the Latin pseudo-release with the track pairing."""
    from music_app.services.musicbrainz_enrichment_postgres import _row_mapping
    from music_app.services.musicbrainz_release_identity_postgres import parse_track_pairing

    row = connection.execute(
        f"""
        select decision.release_mbid::text as release_mbid, decision.match_quality, decision.track_pairing,
               decision.track_order_differs, decision.disc_position, transliteration.media,
               {_READING_EVIDENCE} as evidence
        from library.local_albums albums{_EVIDENCE_JOINS}
        where albums.id = %(album_id)s
        """,
        {"album_id": album_id},
    ).fetchone()
    if not row:
        return None
    row = _row_mapping(row)
    return {**(parse_track_pairing(row) or {}), "disc_position": row.get("disc_position"), "media": row.get("media"),
            "evidence": row.get("evidence") or ""}


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


# A character beyond Latin, Cyrillic and general punctuation: the refreshes' coarse test for a
# title that may need a Latin form (needs_transliteration decides exactly). Every title it
# matches keeps a row, a null one when it needs no form ("Intro ♪", "★"), so it is not due again.
# 0255 and 0256 index exactly these titles with this pattern written identically, so it is
# inlined into the SQL (never a parameter): an idle pass then reads only those few titles and
# the stored rows, not every track (0.9-2.1 s per pass on a 163k-track library before).
_BEYOND_LATIN = r"[^\x01-\u024f\u0400-\u052f\u1e00-\u1eff\u2000-\u206f]"
_BEYOND_LATIN_RE = re.compile(_BEYOND_LATIN)
_SOURCE_UPDATED_AT = "greatest(decision.updated_at, transliteration.updated_at)"
_SOURCE_JOINS = """
    left join library.local_album_musicbrainz_releases decision
      on decision.library_id = albums.library_id and decision.album_key = albums.album_key and decision.state = 'release'
    left join integration.musicbrainz_release_transliterations transliteration
      on transliteration.release_mbid = decision.release_mbid"""
# The album's artist is the decided one, else the artist's settled match; never a candidate.
_EVIDENCE_JOINS = _SOURCE_JOINS + """
    left join library.local_album_artist_identities album_artist
      on album_artist.library_id = albums.library_id and album_artist.album_key = albums.album_key
    left join library.local_artist_musicbrainz_matches artist_match
      on artist_match.library_id = albums.library_id and artist_match.local_artist_id = albums.artist_id
     and artist_match.state = 'matched'"""
_KANA_PATTERN = "[" + "".join(f"\\u{start:04x}-\\u{end:04x}" for start, end in _KANA) + "]"
# What _album_reading reads, as space-separated words ("kana jpn JP"). The rows keep it and are
# redone when it differs: evidence arrives late, and a country's observed_at moves on every
# re-check. Every kana title passes the coarse test, so only the indexed titles are read.
_READING_EVIDENCE = f"""concat_ws(' ',
      case when albums.title ~ '{_KANA_PATTERN}' or exists (
          select 1 from library.local_tracks titled
          where titled.library_id = albums.library_id and titled.album_id = albums.id
            and titled.title ~ '{_BEYOND_LATIN}' and titled.title ~ '{_KANA_PATTERN}')
        then 'kana' end,
      case when transliteration.language in {(*_JAPANESE_LANGUAGES, *_CHINESE_LANGUAGES)}
        then transliteration.language end,
      (select string_agg(country.country_code, ' ' order by country.country_code)
       from integration.musicbrainz_artist_countries country
       where country.artist_mbid = coalesce(album_artist.artist_mbid, artist_match.artist_mbid)
         and country.country_code in {(*_JAPANESE_COUNTRIES, *_CHINESE_COUNTRIES)}))"""

# Albums with a track whose title may need a Latin form and no row for it (the partial index),
# or with a row whose title, release decision, MusicBrainz answer or album's reading evidence
# changed since it was made (compared as stored values, never clocks; the evidence once per album).
_DUE_LATIN_ALBUMS_SQL = f"""
    with due as (
      select tracks.album_id from library.local_tracks tracks
      where tracks.library_id = any(%(library_ids)s) and tracks.title ~ '{_BEYOND_LATIN}'
        and not exists (select 1 from library.local_track_latin_titles latin where latin.track_id = tracks.id)
      union
      select tracks.album_id from library.local_track_latin_titles latin
      join library.local_tracks tracks on tracks.id = latin.track_id
      join library.local_albums albums on albums.id = tracks.album_id{_SOURCE_JOINS}
      where latin.library_id = any(%(library_ids)s)
        and (latin.source_title is distinct from tracks.title
             or latin.source_updated_at is distinct from {_SOURCE_UPDATED_AT})
      union
      select albums.id from (
        select distinct tracks.album_id, latin.reading_evidence from library.local_track_latin_titles latin
        join library.local_tracks tracks on tracks.id = latin.track_id
        where latin.library_id = any(%(library_ids)s)
      ) made
      join library.local_albums albums on albums.id = made.album_id{_EVIDENCE_JOINS}
      where made.reading_evidence is distinct from {_READING_EVIDENCE}
    )
    select albums.id as album_id, albums.library_id, albums.album_key,
           {_SOURCE_UPDATED_AT} as source_updated_at, {_READING_EVIDENCE} as reading_evidence
    from due
    join library.local_albums albums on albums.id = due.album_id{_EVIDENCE_JOINS}
    order by albums.id
    limit %(limit)s
"""


def refresh_latin_titles(connection: Any, *, library_ids: list[int], limit: int) -> list[str]:
    """Store the shown Latin form and its search key of each track of up to ``limit`` due
    albums (0255); a track the coarse test passes over keeps no row, one needing no form or
    with no known form a null one. Returns the refreshed albums' keys."""
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
            if not _BEYOND_LATIN_RE.search(str(track.get("title") or "")):
                continue
            latin = shown.get((int(track.get("disc_number") or 1), int(track.get("track_number") or 0))) \
                if needs_transliteration(track.get("title")) else None
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
                " source_updated_at, reading_evidence) values (%(track_id)s, %(library_id)s, %(title)s, %(latin)s,"
                " %(key)s, %(source)s, %(evidence)s)"
                " on conflict (track_id) do update set source_title = excluded.source_title, latin = excluded.latin,"
                " search_key = excluded.search_key, source_updated_at = excluded.source_updated_at,"
                " reading_evidence = excluded.reading_evidence",
                {**row, "library_id": album["library_id"], "source": album["source_updated_at"],
                 "evidence": album["reading_evidence"]})
    return [str(album["album_key"]) for album in albums]


# Albums whose title may need a Latin form and no row for it (the partial index), or with a row
# whose title, release decision, MusicBrainz answer or reading evidence changed since it was
# made (compared as stored values, never clocks). As for tracks (0255).
_DUE_LATIN_ALBUM_TITLES_SQL = f"""
    with due as (
      select albums.id as album_id from library.local_albums albums
      where albums.library_id = any(%(library_ids)s) and albums.title ~ '{_BEYOND_LATIN}'
        and not exists (select 1 from library.local_album_latin_titles latin where latin.album_id = albums.id)
      union
      select albums.id from library.local_album_latin_titles latin
      join library.local_albums albums on albums.id = latin.album_id{_EVIDENCE_JOINS}
      where latin.library_id = any(%(library_ids)s)
        and (latin.source_title is distinct from albums.title
             or latin.source_updated_at is distinct from {_SOURCE_UPDATED_AT}
             or latin.reading_evidence is distinct from {_READING_EVIDENCE})
    )
    select albums.id as album_id, albums.library_id, albums.album_key, albums.title,
           {_SOURCE_UPDATED_AT} as source_updated_at, {_READING_EVIDENCE} as reading_evidence
    from due
    join library.local_albums albums on albums.id = due.album_id{_EVIDENCE_JOINS}
    order by albums.id
    limit %(limit)s
"""


def refresh_album_latin_titles(connection: Any, *, library_ids: list[int], limit: int) -> list[str]:
    """Store the shown Latin title and its search key of up to ``limit`` due albums (0256), as
    for tracks: a title the coarse test passes over keeps no row, one needing no form or with
    no known form a null one. Returns the refreshed albums' keys."""
    from music_app.services.musicbrainz_enrichment_postgres import _row_mapping

    albums = [_row_mapping(row) for row in connection.execute(
        _DUE_LATIN_ALBUM_TITLES_SQL, {"library_ids": library_ids, "limit": limit}).fetchall()]
    for album in albums:
        title = str(album.get("title") or "")
        if not _BEYOND_LATIN_RE.search(title):
            connection.execute("delete from library.local_album_latin_titles where album_id = %(album_id)s",
                               {"album_id": album["album_id"]})
            continue
        latin = album_title_transliteration(
            title, stored=stored_transliteration(connection, album["album_id"])) \
            if needs_transliteration(title) else None
        key = latin_search_key(latin) or None
        connection.execute(
            "insert into library.local_album_latin_titles (album_id, library_id, source_title, latin, search_key,"
            " source_updated_at, reading_evidence) values (%(album_id)s, %(library_id)s, %(title)s, %(latin)s,"
            " %(key)s, %(source)s, %(evidence)s)"
            " on conflict (album_id) do update set source_title = excluded.source_title, latin = excluded.latin,"
            " search_key = excluded.search_key, source_updated_at = excluded.source_updated_at,"
            " reading_evidence = excluded.reading_evidence",
            {"album_id": album["album_id"], "library_id": album["library_id"], "title": title,
             "latin": latin if key else None, "key": key, "source": album["source_updated_at"],
             "evidence": album["reading_evidence"]})
    return [str(album["album_key"]) for album in albums]
