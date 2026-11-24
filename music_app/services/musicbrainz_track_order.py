"""Track order against the matched MusicBrainz edition (owner 2026-11-16).

A local album certainly is a release when its titles and track count agree, in any order.
Its tracks are then paired with the release's by content, never by position alone (Dream
Evil's local track 11 "The Mirror" is the release's 12th): a title that agrees pairs first,
the closest length deciding between same-titled tracks; a track whose title agrees with
none pairs by length within the matcher's 3 seconds, only when that length fits one track
and that track fits it alone.

- ``order_exact``: every pair is at its own position; nothing to store.
- ``reordered``: every track paired, some elsewhere; the pairing is stored.
- ``ambiguous``: a track could not be paired with certainty; the pairing is not trusted.
"""
from __future__ import annotations

from bisect import bisect_left

from music_app.services.musicbrainz_evidence import _compact, _starts_remote_title, _track_title_forms, fold

# The matcher's own per-track length agreement (album_signals' "durations").
_LENGTH_TOLERANCE_SECONDS = 3


def same_track_title(local: object, remote: object) -> bool:
    """The matcher's own track-title agreement: brackets, spacing and ID3v1 truncation aside."""
    return bool(_track_title_forms(local) & _track_title_forms(remote)) or _starts_remote_title(
        local, {_compact(fold(remote))} - {""})


def _flat_remote(release: dict[str, object]) -> list[dict[str, object]]:
    return [{**track, "release_disc": int(medium.get("position") or 1),
             "release_position": int(track.get("position") or 0)}
            for medium in release.get("media") or [] if isinstance(medium, dict)
            for track in medium.get("tracks") or [] if isinstance(track, dict)]


def _gap(local: dict[str, object], remote: dict[str, object]) -> float | None:
    seconds, length = float(local.get("duration_seconds") or 0), float(remote.get("length") or 0) / 1000
    return abs(seconds - length) if seconds and length else None


def _fits(local: dict[str, object], remote: dict[str, object]) -> bool:
    gap = _gap(local, remote)
    return gap is not None and gap <= _LENGTH_TOLERANCE_SECONDS


def _in_order(targets: list[int]) -> int:
    """How many pairs keep the release's order: the longest increasing run of positions."""
    tails: list[int] = []
    for target in targets:
        index = bisect_left(tails, target)
        tails[index:index + 1] = [target]
    return len(tails)


def pair_tracks(local_tracks: list[dict[str, object]], release: dict[str, object]) -> dict[str, object]:
    """``local_tracks`` in disc and track order against ``release`` (its ``media``)."""
    remote = _flat_remote(release)
    pairs: dict[int, int] = {}
    taken: set[int] = set()
    for index, track in enumerate(local_tracks):
        titled = [other for other in range(len(remote)) if other not in taken
                  and same_track_title(track.get("title"), remote[other].get("title"))]
        if titled:
            best = min(titled, key=lambda other: (_gap(track, remote[other]) or 0, abs(other - index)))
            pairs[index] = best
            taken.add(best)
    untitled = [index for index in range(len(local_tracks)) if index not in pairs]
    fits = {index: [other for other in range(len(remote)) if other not in taken
                    and _fits(local_tracks[index], remote[other])] for index in untitled}
    for index in untitled:
        if len(fits[index]) == 1 and sum(fits[index][0] in others for others in fits.values()) == 1:
            pairs[index] = fits[index][0]
    taken = set(pairs.values())
    # A local track left unpaired while a release track is also left could be either.
    ambiguous = any(index not in pairs for index in range(len(local_tracks))) and len(taken) < len(remote)
    aligned = _in_order([pairs[index] for index in sorted(pairs)])
    if ambiguous:
        return {"quality": "ambiguous", "pairing": [], "aligned": aligned}
    if all(local == other for local, other in pairs.items()):
        return {"quality": "order_exact", "pairing": [], "aligned": aligned}
    return {"quality": "reordered", "aligned": aligned, "pairing": [
        {"disc_number": int(local_tracks[index].get("disc_number") or 1),
         "track_number": int(local_tracks[index].get("track_number") or 0),
         "release_disc": remote[other]["release_disc"], "release_position": remote[other]["release_position"]}
        for index, other in sorted(pairs.items())]}
