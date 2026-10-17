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
class ArtistMixScope:
    """Exact local identities and membership operators, not display labels."""
    memberships: tuple[tuple[int, str], ...]
    album_order: tuple[int, ...]
    categories: tuple[str, ...]
    album_types: tuple[str, ...]

    def as_dict(self):
        return {"kind": "selected_artists",
                "artist_ids": [str(identity) for identity, _ in self.memberships],
                "memberships": [{"artist_id": str(identity), "basis": basis}
                                for identity, basis in self.memberships],
                "album_order": [str(identity) for identity in self.album_order],
                "categories": list(self.categories), "album_types": list(self.album_types)}


def _local_identity(value):
    if (not isinstance(value, str) or not value.isascii() or not value.isdecimal()
            or value.startswith("0") or len(value) > 19):
        raise ValueError("Expected a positive local identity")
    identity = int(value)
    if not 0 < identity < 2**63:
        raise ValueError("Expected a positive local identity")
    return identity


def normalize_artist_mix_scope(value):
    if (not isinstance(value, dict) or set(value) != {
            "kind", "artist_ids", "memberships", "album_order", "categories", "album_types"}
            or value["kind"] != "selected_artists"
            or not isinstance(value["artist_ids"], list)
            or not 1 <= len(value["artist_ids"]) <= MAX_LIBRARY_MIX_ITEMS
            or not isinstance(value["memberships"], list)
            or len(value["memberships"]) != len(value["artist_ids"])
            or not isinstance(value["album_order"], list)
            or len(value["album_order"]) > MAX_LIBRARY_MIX_ITEMS):
        raise ValueError("Invalid Artist selection scope")
    artists = tuple(_local_identity(identity) for identity in value["artist_ids"])
    albums = tuple(_local_identity(identity) for identity in value["album_order"])
    if len(set(artists)) != len(artists) or len(set(albums)) != len(albums):
        raise ValueError("Duplicate local identity")
    memberships = {}
    for item in value["memberships"]:
        if (not isinstance(item, dict) or set(item) != {"artist_id", "basis"}
                or item["basis"] not in ("primary_credit", "family_credit")):
            raise ValueError("Invalid Artist membership operator")
        identity = _local_identity(item["artist_id"])
        if identity in memberships:
            raise ValueError("Duplicate Artist membership operator")
        memberships[identity] = item["basis"]
    if set(memberships) != set(artists):
        raise ValueError("Artist scope and membership operators differ")
    filters = []
    for key, allowed in (("categories", ("main_library", "new_arrivals", "hoard")),
                         ("album_types", ("studio", "ep", "live", "demo", "compilation", "single"))):
        values = value[key]
        if (not isinstance(values, list) or any(not isinstance(item, str) or item not in allowed for item in values)
                or len(set(values)) != len(values)):
            raise ValueError("Invalid Artist selection filter")
        filters.append(tuple(item for item in allowed if item in values))
    return ArtistMixScope(tuple(sorted(memberships.items())), albums, *filters)


def artist_recipe_payload(recipe, scope):
    if not isinstance(scope, ArtistMixScope):
        raise ValueError("Expected a normalized Artist scope")
    normalized = normalize_artist_mix_scope(scope.as_dict())
    if normalized != scope:
        raise ValueError("Artist scope is not canonical")
    return {**recipe_payload(recipe), "version": 2, "source": "artist_selection",
            "scope": scope.as_dict()}


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
