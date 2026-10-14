"""Whole-library mix recipes over the shared cached global-popularity owner.

The caller supplies an authenticated current local-library snapshot. This module
does not read storage, fetch Last.fm, grant playback, or persist membership.
"""
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from music_app.services.popularity_snapshots import (
    CachedPopularity, LocalTrackEvidence, select_local_popular_tracks,
)

MAX_LIBRARY_MIX_ITEMS = 5000
LIBRARY_MIX_VERSION = 1
LIBRARY_MIX_SOURCE = "whole_library"
LIBRARY_MIX_PROVIDER = "lastfm"
LIBRARY_MIX_METRIC = "overall_scrobbles"


@dataclass(frozen=True, slots=True)
class LibraryMixRecipe:
    selection_basis: str
    songs_per_group: int
    auto_update: bool
    playback_order: str = "regular"

    def as_dict(self) -> dict:
        return {"selection_basis": self.selection_basis,
                "songs_per_group": self.songs_per_group,
                "auto_update": self.auto_update, "playback_order": self.playback_order}


@dataclass(frozen=True, slots=True)
class LibraryMixCandidate:
    track: LocalTrackEvidence
    album_ref: str | None
    primary_artist_ref: str | None
    album_position: int
    disc_number: int | None
    track_number: int | None


@dataclass(frozen=True, slots=True)
class LibraryMixSelection:
    recipe: LibraryMixRecipe
    tracks: tuple[LibraryMixCandidate, ...]
    total: int
    diagnostics: tuple[tuple[int, str], ...]


class LibraryMixTooLarge(ValueError):
    """A generated result must never silently truncate to a command limit."""


def normalize_library_mix_recipe(value: object) -> LibraryMixRecipe:
    if (not isinstance(value, dict)
            or not {"selection_basis", "songs_per_group", "auto_update"} <= set(value)
            or set(value) - {"selection_basis", "songs_per_group", "auto_update", "playback_order"}
            or value["selection_basis"] not in ("per_artist", "per_album")
            or type(value["songs_per_group"]) is not int
            or not 1 <= value["songs_per_group"] <= MAX_LIBRARY_MIX_ITEMS
            or type(value["auto_update"]) is not bool
            or value.get("playback_order", "regular") not in ("regular", "shuffle", "unplayed_first")):
        raise ValueError("Invalid library mix recipe")
    return LibraryMixRecipe(**value)


def recipe_payload(recipe: LibraryMixRecipe) -> dict:
    if not isinstance(recipe, LibraryMixRecipe):
        raise ValueError("Expected a normalized library mix recipe")
    normalize_library_mix_recipe(recipe.as_dict())
    return {"version": LIBRARY_MIX_VERSION, "source": LIBRARY_MIX_SOURCE,
            "provider": LIBRARY_MIX_PROVIDER, "metric": LIBRARY_MIX_METRIC,
            **recipe.as_dict()}


def _validate_candidate(candidate: LibraryMixCandidate) -> None:
    if not isinstance(candidate, LibraryMixCandidate) or not isinstance(candidate.track, LocalTrackEvidence):
        raise ValueError("Expected a normalized local-library mix candidate")
    if type(candidate.track.track_id) is not int or candidate.track.track_id < 1:
        raise ValueError("Expected positive local track identity")
    for identity in (candidate.album_ref, candidate.primary_artist_ref):
        if identity is not None and (not isinstance(identity, str) or not identity.strip()):
            raise ValueError("Group identity must be nonblank or missing")
    if type(candidate.album_position) is not int or candidate.album_position < 0:
        raise ValueError("Expected a stable source album position")
    for position in (candidate.disc_number, candidate.track_number):
        if position is not None and (type(position) is not int or position < 1):
            raise ValueError("Track positions must be positive integers or unknown")


def build_library_mix(
    candidates: Iterable[LibraryMixCandidate],
    recipe: LibraryMixRecipe,
    *,
    is_local_readable: Callable[[LibraryMixCandidate], bool],
    read_snapshot: Callable[[LibraryMixCandidate], CachedPopularity | None],
) -> LibraryMixSelection:
    """Recompute top N from the current admitted library; never append a delta.

    Group refs come from the server's real identities, not labels. Per-artist
    adapters use primary album artist, with primary track artist for compilations;
    featured guests do not create quotas. Missing groups/counts remain diagnostic.
    A recording on multiple albums occurs once, assigned to its earliest source
    album/disc/track copy; a group can therefore have fewer than N rows.
    """
    if not isinstance(recipe, LibraryMixRecipe):
        raise ValueError("Expected a normalized library mix recipe")
    normalize_library_mix_recipe(recipe.as_dict())
    admitted = {}
    for candidate in candidates:
        # No rejected row metadata, provider cache, or diagnostic is observed.
        if not is_local_readable(candidate):
            continue
        _validate_candidate(candidate)
        track_id = candidate.track.track_id
        if track_id in admitted and admitted[track_id] != candidate:
            raise ValueError("Conflicting local track evidence")
        admitted[track_id] = candidate

    def group(track):
        candidate = admitted[track.track_id]
        return candidate.album_ref if recipe.selection_basis == "per_album" else candidate.primary_artist_ref

    def source_order(track):
        candidate = admitted[track.track_id]
        return (candidate.album_position,
                candidate.disc_number is None, candidate.disc_number or 0,
                candidate.track_number is None, candidate.track_number or 0,
                track.track_id)

    selected = select_local_popular_tracks(
        (candidate.track for candidate in admitted.values()),
        is_local_readable=lambda track: True,
        matches_filter=lambda track: True,
        read_snapshot=lambda track: read_snapshot(admitted[track.track_id]),
        max_per_group=recipe.songs_per_group,
        group_identity=group,
        tie_breaker=source_order,
        limit=MAX_LIBRARY_MIX_ITEMS + 1,
    )
    if selected.total > MAX_LIBRARY_MIX_ITEMS:
        raise LibraryMixTooLarge("Library mix exceeds the 5000-track Playlist limit")
    return LibraryMixSelection(recipe=recipe,
        tracks=tuple(admitted[track.track_id] for track in selected.tracks),
        total=selected.total, diagnostics=selected.diagnostics)
