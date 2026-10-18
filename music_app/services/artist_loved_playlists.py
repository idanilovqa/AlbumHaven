"""Own-user Loved/Obsessed Artist recipes, independent of storage and transport.

The caller owns current-library admission, live family resolution and canonical
track-preference reads. A recipe stores its root, never a frozen family or the
Gallery's visible filters. Selection order comes from the existing inventory
album/disc/track owner, not popularity or a second taste authority.
"""
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from music_app.services.owned_playlists import MAX_PLAYLIST_ITEMS_PER_COMMAND


ARTIST_LOVED_PROTOCOL = "artist_loved_selection_v1"
ARTIST_LOVED_SOURCE = "artist_loved"
ARTIST_LOVED_VERSION = 1
LOVED_TIERS = frozenset(("loved", "obsessed"))
_PLAYBACK_ORDERS = ("regular", "shuffle", "unplayed_first")


def _positive_identity(value):
    if type(value) is not int or not 0 < value < 2**63:
        raise ValueError("Expected a positive local identity")
    return value


@dataclass(frozen=True, slots=True)
class ArtistLovedRecipe:
    root_artist_id: int
    scope_mode: str
    playback_order: str = "regular"

    def __post_init__(self):
        _positive_identity(self.root_artist_id)
        if self.scope_mode not in ("artist", "family") or self.playback_order not in _PLAYBACK_ORDERS:
            raise ValueError("Invalid Artist Loved recipe")

    def descriptor(self):
        return {"version": ARTIST_LOVED_VERSION, "root_artist_id": str(self.root_artist_id),
                "scope_mode": self.scope_mode}

    def as_dict(self):
        return {**self.descriptor(), "source": ARTIST_LOVED_SOURCE,
                "auto_update": True, "playback_order": self.playback_order}

    def business_identity(self, account_id, library_id):
        return (_positive_identity(account_id), _positive_identity(library_id),
                self.root_artist_id, self.scope_mode)


def normalize_artist_loved_descriptor(value):
    if (not isinstance(value, dict) or set(value) != {"version", "root_artist_id", "scope_mode"}
            or type(value["version"]) is not int or value["version"] != ARTIST_LOVED_VERSION):
        raise ValueError("Invalid Artist Loved descriptor")
    identity = value["root_artist_id"]
    if (not isinstance(identity, str) or not identity.isascii() or not identity.isdecimal()
            or identity.startswith("0") or len(identity) > 19):
        raise ValueError("Expected a positive local identity")
    return ArtistLovedRecipe(int(identity), value["scope_mode"])


def normalize_artist_loved_recipe(value):
    if (not isinstance(value, dict) or set(value) != {
            "version", "root_artist_id", "scope_mode", "source", "auto_update", "playback_order"}
            or value["source"] != ARTIST_LOVED_SOURCE or value["auto_update"] is not True):
        raise ValueError("Invalid Artist Loved recipe")
    descriptor = normalize_artist_loved_descriptor({key: value[key]
        for key in ("version", "root_artist_id", "scope_mode")})
    return ArtistLovedRecipe(descriptor.root_artist_id, descriptor.scope_mode, value["playback_order"])


class ArtistLovedTooLarge(ValueError):
    """A complete generated result must never be silently truncated."""


def select_artist_loved_track_ids(
    ordered_track_ids: Iterable[int], canonical_love_tiers: Mapping[int, str],
) -> tuple[int, ...]:
    """Select every Love in admitted inventory order, once per exact local ID.

    ``canonical_love_tiers`` is the current actor's canonical preference reader
    output mapped by local track ID. Missing/off taste excludes a track. This
    function cannot establish actor or media authority and never reads storage.
    """
    if not isinstance(canonical_love_tiers, Mapping):
        raise ValueError("Expected canonical track love tiers")
    seen = set()
    selected = []
    for identity in ordered_track_ids:
        _positive_identity(identity)
        if identity in seen:
            continue
        seen.add(identity)
        tier = canonical_love_tiers.get(identity, "off")
        if tier not in ("off", "loved", "obsessed"):
            raise ValueError("Invalid canonical track love tier")
        if tier in LOVED_TIERS:
            selected.append(identity)
            if len(selected) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
                raise ArtistLovedTooLarge("Artist Loved selection exceeds the complete playlist limit")
    return tuple(selected)
