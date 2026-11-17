"""Tracklist sub-sections from the matched release (MusicBrainz Delivery 2, S8).

A sub-section is a named part of one disc, such as "Where Dead Angels Lie" for tracks 9-13 of
Dissection's one-disc "Storm of the Light's Bane / Where Dead Angels Lie" (owner 2026-11-08).
It is not a CD: a name that starts a local disc names that disc, never a section, and a name
like "CD 2" never becomes one (owner 2026-11-15, after the Alien mix-up).

Sources, in order, never tags:
1. MusicBrainz medium titles, when several media of the release make up one local disc.
2. Discogs tracklist headings, from the release the MusicBrainz release links to or the
   Discogs fallback release. An album titled with " / " (two albums on one disc) is always
   checked on Discogs unless MusicBrainz names its media.

The result is display data: ``[{"disc_number", "track_number", "section"}]`` for each local
track under a heading, in disc and track order. Tags never change.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

# Discogs unavailable (owner 2026-11-16): hourly for a day, then daily, never after a week.
_HOURLY_FOR = timedelta(hours=24)
_RETRIES_END_AFTER = timedelta(days=7)

# "CD 2", "Disc 2: Name", "Disk II", "CD1 - Bonus": a disc's own name.
_DISC_NAME = re.compile(r"^\s*(?:cd|dis[ck])\s*(?:\d+|[ivx]+)\b", re.IGNORECASE)


def local_discs(tracks: list[dict[str, object]]) -> list[list[dict[str, object]]]:
    """The album's tracks grouped by disc number (an untagged disc counts as disc 1), in order."""
    discs: dict[int, list[dict[str, object]]] = {}
    for track in tracks:
        discs.setdefault(int(track.get("disc_number") or 1), []).append(track)
    return [sorted(discs[number], key=lambda track: int(track.get("track_number") or 0)) for number in sorted(discs)]


def _sections(discs: list[list[dict[str, object]]], remote: list[list[str | None]]) -> list[dict[str, object]]:
    """Each local disc beside the remote disc it is, as one heading (or None) per remote track.
    A disc whose track count differs proves nothing, so nothing is shown. The heading a disc
    starts with names that disc and is dropped until the next heading."""
    if len(discs) != len(remote) or any(len(local) != len(names) for local, names in zip(discs, remote)):
        return []
    found = []
    for local, names in zip(discs, remote):
        opening = names[0] if names else None
        for track, name in zip(local, names):
            if name != opening:
                opening = None
            if name and opening is None and not _DISC_NAME.match(name):
                found.append({"disc_number": int(track.get("disc_number") or 1),
                              "track_number": int(track.get("track_number") or 0), "section": name})
    return found


def musicbrainz_names_media(release: dict[str, object] | None) -> bool:
    """MusicBrainz names a section or a CD: then Discogs is not asked (owner 2026-11-08)."""
    return any(str(medium.get("title") or "").strip()
               for medium in (release or {}).get("media") or [] if isinstance(medium, dict))


def musicbrainz_sections(discs: list[list[dict[str, object]]],
                         release: dict[str, object] | None) -> list[dict[str, object]]:
    """Titles of media that, in order, add up to one local disc. A medium that is a local disc
    by itself is a CD ("CD 2 • Name"), never a section."""
    media = [medium for medium in (release or {}).get("media") or [] if isinstance(medium, dict)]
    remote, index = [], 0
    for local in discs:
        names: list[str | None] = []
        while index < len(media) and len(names) < len(local):
            medium = media[index]
            names += [str(medium.get("title") or "").strip() or None] * int(medium.get("track_count") or 0)
            index += 1
        remote.append(names)
    return _sections(discs, remote) if index == len(media) else []


def wants_discogs_sections(title: object, release: dict[str, object] | None) -> bool:
    """A title with " / " suggests two albums on one disc (owner 2026-11-08)."""
    return " / " in str(title or "") and not musicbrainz_names_media(release)


def discogs_sections(discs: list[list[dict[str, object]]], tracks: list[dict[str, object]]) -> list[dict[str, object]]:
    """Discogs headings (``section`` on each track ``DiscogsMetadataClient.release`` returns),
    disc by disc in order."""
    remote: dict[int, list[str | None]] = {}
    for track in tracks:
        remote.setdefault(int(track.get("disc") or 1), []).append(str(track.get("section") or "").strip() or None)
    return _sections(discs, [remote[disc] for disc in sorted(remote)])


def section_retry_at(first_failed_at: datetime, failed_at: datetime) -> datetime | None:
    """When to ask Discogs again after it was unavailable at ``failed_at`` (first at
    ``first_failed_at``); None once a week has passed. A definitive answer is never retried."""
    step = timedelta(hours=1) if failed_at - first_failed_at < _HOURLY_FOR else timedelta(days=1)
    retry_at = failed_at + step
    return retry_at if retry_at <= first_failed_at + _RETRIES_END_AFTER else None
