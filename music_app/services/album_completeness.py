"""Whether one album's tracks make a complete album (owner, 2026-11-24).

A full MusicBrainz match decides first; failing that, the track numbers on every disc run 1..N with no gap,
where N is the track total when a tag carries one (total_tracks) and the highest number otherwise. Known
weakness without a total: a set missing only its last tracks looks complete.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping


def full_release_match(tracks: list[Mapping[str, object]]) -> bool | None:
    """The MusicBrainz seam: True or False once enrichment knows the release's full tracklist, else None.

    Not read yet: the MusicBrainz line fills this from its own field."""
    return None


def album_is_complete(tracks: Iterable[Mapping[str, object]]) -> bool:
    tracks = list(tracks)
    matched = full_release_match(tracks)
    if matched is not None:
        return matched
    numbers_by_disc: dict[int, set[int]] = {}
    totals_by_disc: dict[int, int] = {}
    for track in tracks:
        number = _positive(track.get("track_number"))
        if number is None:
            return False
        disc = _positive(track.get("disc_number")) or 1
        numbers_by_disc.setdefault(disc, set()).add(number)
        total = _positive(track.get("total_tracks"))
        if total:
            totals_by_disc[disc] = max(total, totals_by_disc.get(disc, 0))
    return bool(numbers_by_disc) and all(
        numbers == set(range(1, totals_by_disc.get(disc, max(numbers)) + 1))
        for disc, numbers in numbers_by_disc.items()
    )


def _positive(value: object) -> int | None:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None
