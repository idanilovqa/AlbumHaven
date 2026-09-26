"""Account-owned presentation preferences, isolated by client category.

This is presentation state, never an authorization or playback-session source.
Writes merge only explicitly supplied, validated preference families so a phone
cannot overwrite desktop settings or a concurrent change to another family.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
import re
from typing import Any

PROFILES = ("web_desktop", "mobile", "tv")
_DEFAULTS = {
    "galleryDisplayPreferences": {"defaultGalleryDisplayMode": "cards", "defaultGalleryScalePercent": 100},
    "mobileGridColumns": 2,
    "galleryPlaybackPreferences": {"albumTopsEndBehavior": "continue", "artistPagesEndBehavior": "stop"},
    "shellLayoutPreferences": {"contextualPaneWidthPx": 320, "infoDrawerWidthPx": 360, "artistTreeFolded": None},
    "combineSimilarArtists": {},
    "gallerySources": {"main_library": True, "new_arrivals": True, "hoard": True},
    "albumOpenMode": "modal",
    "compactPlayerMode": "expanded",
    "playerAppearance": {"seekbarMode": "default", "waveformFillColor": "#dadde2", "waveformEdgeColor": "#494950"},
}


def normalize_profile(value: object) -> str:
    if not isinstance(value, str) or value not in PROFILES:
        raise ValueError("Unknown client profile.")
    return value


def default_preferences(profile: str) -> dict[str, object]:
    result = deepcopy(_DEFAULTS)
    if normalize_profile(profile) == "mobile":
        result["galleryDisplayPreferences"]["defaultGalleryDisplayMode"] = "list"
        result["albumOpenMode"] = "page"
        result["playerAppearance"]["seekbarMode"] = "thin"
    return result


def _choice(value: object, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ValueError("Invalid preference choice.")
    return value


def _integer(value: object, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Invalid preference number.")
    return value


def _object(value: object, keys: set[str]) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or set(value) != keys:
        raise ValueError("Invalid preference fields.")
    return value


def normalize_changes(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping) or not value or set(value) - set(_DEFAULTS):
        raise ValueError("Invalid layout preference changes.")
    result: dict[str, object] = {}
    for key, candidate in value.items():
        if key == "galleryDisplayPreferences":
            item = _object(candidate, {"defaultGalleryDisplayMode", "defaultGalleryScalePercent"})
            result[key] = {
                "defaultGalleryDisplayMode": _choice(item["defaultGalleryDisplayMode"], ("cards", "covers", "list")),
                "defaultGalleryScalePercent": _integer(item["defaultGalleryScalePercent"], 80, 140),
            }
        elif key == "mobileGridColumns":
            result[key] = _integer(candidate, 1, 3)
        elif key == "galleryPlaybackPreferences":
            item = _object(candidate, set(_DEFAULTS[key]))
            result[key] = {name: _choice(setting, ("stop", "continue")) for name, setting in item.items()}
        elif key == "shellLayoutPreferences":
            item = _object(candidate, set(_DEFAULTS[key]))
            folded = item["artistTreeFolded"]
            if folded is not None and type(folded) is not bool:
                raise ValueError("Invalid artist tree preference.")
            result[key] = {
                "contextualPaneWidthPx": _integer(item["contextualPaneWidthPx"], 240, 520),
                "infoDrawerWidthPx": _integer(item["infoDrawerWidthPx"], 240, 520),
                "artistTreeFolded": folded,
            }
        elif key == "combineSimilarArtists":
            if not isinstance(candidate, Mapping) or len(candidate) > 256 or any(
                not isinstance(name, str) or not 1 <= len(name) <= 300 or type(setting) is not bool
                for name, setting in candidate.items()
            ):
                raise ValueError("Invalid artist preferences.")
            result[key] = dict(candidate)
        elif key == "gallerySources":
            item = _object(candidate, set(_DEFAULTS[key]))
            if any(type(setting) is not bool for setting in item.values()):
                raise ValueError("Invalid source preferences.")
            result[key] = dict(item)
        elif key == "albumOpenMode":
            result[key] = _choice(candidate, ("modal", "page"))
        elif key == "compactPlayerMode":
            result[key] = _choice(candidate, ("compact", "expanded"))
        elif key == "playerAppearance":
            item = _object(candidate, set(_DEFAULTS[key]))
            if any(not isinstance(item[name], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", item[name])
                   for name in ("waveformFillColor", "waveformEdgeColor")):
                raise ValueError("Invalid player colors.")
            result[key] = {**item, "seekbarMode": _choice(item["seekbarMode"], ("default", "waveform", "thin"))}
    return result


def _owner(value: object) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError("An authenticated account is required.")
    return value


def _connect(database_url: str):
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(database_url, row_factory=dict_row)


class PostgresClientLayoutPreferences:
    def __init__(self, config: Mapping[str, object], *, connect: Callable[[str], Any] | None = None):
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._connect = connect or _connect

    def _connection(self):
        if not self._database_url:
            raise RuntimeError("An application database is required for layout preferences.")
        return self._connect(self._database_url)

    def load_profiles(self, *, account_id: int) -> dict[str, dict[str, object]]:
        owner = _owner(account_id)
        profiles = {profile: default_preferences(profile) for profile in PROFILES}
        with self._connection() as connection:
            rows = connection.execute(
                "select client_profile, preferences from app.user_client_layout_preferences where account_id=%s",
                (owner,),
            ).fetchall()
        for row in rows:
            profile = normalize_profile(row["client_profile"])
            saved = row["preferences"]
            if saved:
                profiles[profile].update(normalize_changes(saved))
        return profiles

    def save_changes(self, *, account_id: int, profile: str, changes: object) -> dict[str, object]:
        from psycopg.types.json import Jsonb
        owner = _owner(account_id)
        profile = normalize_profile(profile)
        patch = normalize_changes(changes)
        with self._connection() as connection:
            row = connection.execute(
                """insert into app.user_client_layout_preferences(account_id,client_profile,preferences)
                   values(%s,%s,%s)
                   on conflict(account_id,client_profile) do update
                   set preferences=app.user_client_layout_preferences.preferences || excluded.preferences,
                       updated_at=now()
                   returning preferences""",
                (owner, profile, Jsonb(patch)),
            ).fetchone()
        return {**default_preferences(profile), **dict(row["preferences"])}
