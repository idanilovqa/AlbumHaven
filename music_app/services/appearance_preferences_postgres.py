"""Account-owned palettes, legacy backgrounds and grouped player colors."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import json
import re
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - diagnostics without the optional driver
    psycopg = None
    dict_row = None
    Jsonb = None


_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
_FIELDS = ("main_surface_color", "panel_background_color")
_FULL_FIELDS = (*_FIELDS, "palette_id", "panel_index", "player_override")
_COMPACT_FIELDS = (*_FULL_FIELDS, "compact_player_style")
_DOCKED_COMPACT_FIELDS = (*_COMPACT_FIELDS, "docked_compact_player_behavior")
_LEGACY_COMPACT_FIELDS = (*_FIELDS, "compact_player_style")
_ALBUM_PAGE_FIELDS = ("album_details_layout", "album_playing_row_animation")
_ALERT_FIELDS = ("alert_family",)
_PLAYER_FIELDS = ("background", "fill", "edge")
_PLAYER_COLUMNS = (
    "player_background_color", "player_waveform_fill_color", "player_waveform_edge_color"
)
_STORAGE_FIELDS = (*_FIELDS, "palette_id", "panel_index", *_PLAYER_COLUMNS, "waveform_recent_colors", "compact_player_style", "docked_compact_player_behavior", "docked_compact_player_regular_style", "compact_player_motion", "floating_player_edge")
_AGGREGATE_COLUMNS = ("revision", "interaction_overrides", "selection_accent", "player_style_override", "player_recent_sets")
_ROW_COLUMNS = (*_STORAGE_FIELDS, *_ALBUM_PAGE_FIELDS, *_ALERT_FIELDS, *_AGGREGATE_COLUMNS, "loop_control_style")
_READ_COLUMNS = ", ".join(_ROW_COLUMNS)
_SAVED_READ_COLUMNS = ", ".join(f"saved.{name}" for name in _ROW_COLUMNS)
_INTERACTION_COLOR_FIELDS = (
    "item_hover", "item_selected", "button_hover_background", "button_pressed",
)
_ITEM_OUTLINE_SOURCES = frozenset({"automatic", "theme", "player", "custom"})
_AGGREGATE_WRITE_FIELDS = (*_COMPACT_FIELDS, *_ALBUM_PAGE_FIELDS, *_ALERT_FIELDS, "waveform_recent_colors", "interaction_overrides", "selection_accent", "player_style_override", "applied_player_set")
APPEARANCE_PALETTE_IDS = frozenset({
    "steelblue", "navy", "harbor-mint", "parchment-pine", "powderblue", "graphite", "slate", "midnight",
    "black", "blackgray", "paper", "silver", "coollight",
})
ALBUM_DETAILS_LAYOUTS = frozenset({"classic_bar", "stacked_bar", "editorial_canvas"})
ALBUM_PLAYING_ROW_ANIMATIONS = frozenset({"enabled", "disabled"})
ALERT_FAMILIES = frozenset({"ember", "signal", "quiet"})
LOOP_CONTROL_STYLES = frozenset({"capsule", "companion"})
APPEARANCE_DEVICE_PROFILES = ("web_desktop", "mobile", "tv")
APPEARANCE_DEVICE_SECTIONS = ("main", "player", "interaction", "alerts", "album")
_DEVICE_SECTION_FIELDS = {
    "main": frozenset((*_FIELDS, "palette_id", "panel_index")),
    "player": frozenset(("player_override", "player_style_override", "compact_player_style", "docked_compact_player_behavior", "docked_compact_player_regular_style", "compact_player_motion", "floating_player_edge")),
    "interaction": frozenset(("interaction_overrides", "selection_accent", "action_button_outlines")),
    "alerts": frozenset(_ALERT_FIELDS),
    "album": frozenset(_ALBUM_PAGE_FIELDS),
}
_DEVICE_FIELD_DEFAULTS = {"docked_compact_player_behavior": "follow_sidebar", "docked_compact_player_regular_style": False, "compact_player_motion": "normal", "floating_player_edge": {"source": "player", "color": None}}


class AppearanceLoopStyleForbidden(PermissionError):
    """An actual loop-style change requires effective loop-create authority."""


def _closed_choice(value: object, choices: frozenset[str], message: str) -> str:
    if not isinstance(value, str) or value not in choices:
        raise ValueError(message)
    return value


def _color(value: object, *, nullable: bool = True) -> str | None:
    if value is None and nullable:
        return None
    if isinstance(value, str) and _COLOR.fullmatch(value):
        return value.upper()
    raise ValueError("Appearance colors must be six-digit RGB HEX values.")


def _player_style(value: object, *, nullable: bool = True) -> dict[str, object] | None:
    if value is None and nullable:
        return None
    components = {"surface", "controls", "waveform", "handles"}
    if not isinstance(value, Mapping) or not components <= set(value) or set(value) - components - {"native_components"}:
        raise ValueError("A complete player style is required.")
    if "native_components" in value:
        native = value["native_components"]
        if not isinstance(native, list) or len(native) > 4 or any(not isinstance(part, str) or part not in components for part in native) or len(set(native)) != len(native):
            raise ValueError("Invalid native player components.")
    surface, controls, waveform, handles = (value[name] for name in ("surface", "controls", "waveform", "handles"))
    if not all(isinstance(part, Mapping) for part in (surface, controls, waveform, handles)):
        raise ValueError("A complete player style is required.")
    if set(surface) != {"mode", "angle", "start", "end"} or surface["mode"] not in ("gradient", "layered_gradient", "solid"):
        raise ValueError("Invalid player surface.")
    if type(surface["angle"]) not in (int, float) or not 0 <= surface["angle"] <= 360:
        raise ValueError("Invalid player surface angle.")
    if set(controls) != {"fill", "border"} or set(waveform) != {"fill", "edge"} or set(handles) != {"color"}:
        raise ValueError("A complete player style is required.")
    return {
        "surface": {"mode": surface["mode"], "angle": surface["angle"], "start": _color(surface["start"], nullable=False), "end": _color(surface["end"], nullable=False)},
        "controls": {"fill": _color(controls["fill"], nullable=False), "border": _color(controls["border"], nullable=False)},
        "waveform": {"fill": _color(waveform["fill"], nullable=False), "edge": _color(waveform["edge"], nullable=False)},
        "handles": {"color": _color(handles["color"], nullable=False)},
        **({"native_components": list(value["native_components"])} if "native_components" in value else {}),
    }


def _item_outline(value: object) -> dict[str, str | None]:
    if not isinstance(value, Mapping) or set(value) != {"source", "color"}:
        raise ValueError("Item outline requires source and color.")
    source = _closed_choice(
        value["source"], _ITEM_OUTLINE_SOURCES, "Unknown item outline source."
    )
    color = _color(value["color"])
    if source == "custom" and color is None:
        raise ValueError("A custom item outline color is required.")
    if source != "custom" and color is not None:
        raise ValueError("Linked item outline sources cannot store a fixed color.")
    return {"source": source, "color": color}


def _interaction_overrides(value: object) -> dict[str, object]:
    expected = {*_INTERACTION_COLOR_FIELDS, "item_outline"}
    if not isinstance(value, Mapping) or set(value) not in (expected, expected | {"panel_outline"}):
        raise ValueError("Interaction overrides require the complete closed set.")
    return {
        **{name: _color(value[name]) for name in _INTERACTION_COLOR_FIELDS},
        "item_outline": _item_outline(value["item_outline"]),
        **({"panel_outline": _color(value["panel_outline"])} if "panel_outline" in value else {}),
    }


def _selection_accent(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != {"enabled", "color"} or type(value["enabled"]) is not bool:
        raise ValueError("Selection accent requires enabled and color.")
    return {"enabled": value["enabled"], "color": _color(value["color"], nullable=False)}


def merge_player_recent_sets(current: object, candidate: object = None) -> list[dict[str, object]]:
    if not isinstance(current, list) or len(current) > 5:
        raise ValueError("Player history must contain at most five sets.")
    normalized = [_player_style(item, nullable=False) for item in current]
    if len({json.dumps(item, sort_keys=True) for item in normalized}) != len(normalized):
        raise ValueError("Player history must contain distinct sets.")
    if candidate is None:
        return normalized
    applied = _player_style(candidate, nullable=False)
    return [applied, *[item for item in normalized if item != applied]][:5]


class AppearanceRevisionConflict(RuntimeError):
    def __init__(self, *, current: Mapping[str, object]):
        super().__init__("Appearance revision conflict.")
        self.current = dict(current)


def appearance_preference_sections(preferences: Mapping[str, object]) -> dict[str, dict[str, object]]:
    return {
        section: {name: preferences.get(name, _DEVICE_FIELD_DEFAULTS.get(name)) for name in fields}
        for section, fields in _DEVICE_SECTION_FIELDS.items()
    }


def normalize_appearance_device_profiles(
    payload: object, *, base_preferences: Mapping[str, object],
) -> dict[str, object]:
    if payload is None:
        payload = {}
    if not isinstance(payload, Mapping) or set(payload) - {"mobile", "tv"}:
        raise ValueError("Appearance device profiles require Mobile and TV sections.")
    base_sections = appearance_preference_sections(base_preferences)
    normalized: dict[str, object] = {"mobile": {}, "tv": {}}
    for profile in ("mobile", "tv"):
        profile_value = payload.get(profile, {})
        if isinstance(profile_value, Mapping) and set(profile_value) == {"sections"}:
            profile_value = profile_value["sections"]
        if not isinstance(profile_value, Mapping) or set(profile_value) - set(APPEARANCE_DEVICE_SECTIONS):
            raise ValueError("Unknown Appearance device section.")
        sections: dict[str, object] = {}
        for section in APPEARANCE_DEVICE_SECTIONS:
            candidate = profile_value.get(section, {"mode": "follow", "values": {}})
            if not isinstance(candidate, Mapping) or set(candidate) != {"mode", "values"}:
                raise ValueError("Appearance device sections require mode and values.")
            mode = candidate.get("mode")
            values = candidate.get("values")
            if mode not in ("follow", "custom") or not isinstance(values, Mapping):
                raise ValueError("Invalid Appearance device section mode.")
            values = dict(values)
            if section == "player":
                values.pop("loop_control_style", None)
            allowed = _DEVICE_SECTION_FIELDS[section]
            if set(values) - allowed:
                raise ValueError("Unknown Appearance device section value.")
            if mode == "follow" and not values:
                sections[section] = {"mode": mode, "values": {}}
                continue
            merged = {**base_sections[section], **dict(values)}
            if "action_button_outlines" in merged and type(merged["action_button_outlines"]) is not bool:
                raise ValueError("Action button outlines must be enabled or disabled.")
            aggregate_payload = {
                name: base_preferences.get(name)
                for name in _AGGREGATE_WRITE_FIELDS
                if name != "applied_player_set"
            }
            aggregate_payload.update({
                name: value for name, value in merged.items()
                if name != "action_button_outlines"
            })
            if "loop_control_style" in merged:
                aggregate_payload["loop_control_style"] = merged["loop_control_style"]
            validated = normalize_appearance_preferences(aggregate_payload)
            sections[section] = {
                "mode": mode,
                "values": {
                    name: merged.get(name) if name == "action_button_outlines" else validated.get(name)
                    for name in allowed
                },
            }
        normalized[profile] = {"sections": sections}
    return normalized


def resolve_appearance_device_section(
    profiles: Mapping[str, object], *, profile: str, section: str,
    base_preferences: Mapping[str, object],
) -> dict[str, object]:
    if profile not in APPEARANCE_DEVICE_PROFILES or section not in APPEARANCE_DEVICE_SECTIONS:
        raise ValueError("Unknown Appearance profile or section.")
    base = appearance_preference_sections(base_preferences)[section]
    if profile == "web_desktop":
        return base
    profile_value = profiles.get(profile, {}) if isinstance(profiles.get(profile), Mapping) else {}
    candidate = profile_value.get("sections", {}).get(section, {}) if isinstance(profile_value.get("sections"), Mapping) else {}
    return dict(candidate.get("values", {})) if candidate.get("mode") == "custom" else base


def resolve_appearance_device_profile(
    preferences: Mapping[str, object], *, profile: str,
) -> dict[str, object]:
    resolved = dict(preferences)
    client_profile = appearance_client_profile(profile)
    if client_profile not in ("mobile", "tv"):
        return resolved
    profiles = normalize_appearance_device_profiles(
        preferences.get("device_profiles"), base_preferences=preferences,
    )
    for section in APPEARANCE_DEVICE_SECTIONS:
        resolved.update(resolve_appearance_device_section(
            profiles, profile=client_profile, section=section,
            base_preferences=preferences,
        ))
    resolved["device_profiles"] = profiles
    return resolved


def _jsonb(value: object):
    if value is None:
        return None
    return Jsonb(value) if Jsonb is not None else value


def _floating_player_edge(value: object) -> dict[str, str | None]:
    if not isinstance(value, Mapping) or set(value) != {"source", "color"}:
        raise ValueError("Floating player edge requires source and color.")
    source = _closed_choice(value["source"], frozenset(("player", "theme", "custom")),
                            "Unknown floating player edge source.")
    color = _color(value["color"])
    if source == "custom" and color is None:
        raise ValueError("A custom floating player edge color is required.")
    if source != "custom" and color is not None:
        raise ValueError("Linked floating player edge cannot store a fixed color.")
    return {"source": source, "color": color}


def normalize_appearance_preferences(payload: object) -> dict[str, object]:
    """Preserve optional-field omission for older preference writers."""
    if not isinstance(payload, Mapping):
        return _normalize_appearance_preferences(payload)
    writable = dict(payload)
    optional = {}
    if "loop_control_style" in writable:
        optional["loop_control_style"] = _closed_choice(
            writable.pop("loop_control_style"), LOOP_CONTROL_STYLES, "Unknown loop control style.")
    if "compact_player_motion" in writable:
        optional["compact_player_motion"] = _closed_choice(
            writable.pop("compact_player_motion"), frozenset(("normal", "slow")),
            "Unknown compact player motion.")
    if "docked_compact_player_regular_style" in writable:
        enabled = writable.pop("docked_compact_player_regular_style")
        if type(enabled) is not bool:
            raise ValueError("Docked compact player regular style must be enabled or disabled.")
        optional["docked_compact_player_regular_style"] = enabled
    if "floating_player_edge" in writable:
        optional["floating_player_edge"] = _floating_player_edge(writable.pop("floating_player_edge"))
    return {**_normalize_appearance_preferences(writable), **optional}


def _normalize_appearance_preferences(payload: object) -> dict[str, object]:
    """Validate either a legacy pair or the complete palette/player preference."""
    aggregate_shapes = (
        set(_AGGREGATE_WRITE_FIELDS),
        set(_AGGREGATE_WRITE_FIELDS) - {"applied_player_set"},
        set(_AGGREGATE_WRITE_FIELDS) - {"waveform_recent_colors"},
        set(_AGGREGATE_WRITE_FIELDS) - {"waveform_recent_colors", "applied_player_set"},
    )
    aggregate_shapes = (*aggregate_shapes, *(shape | {"docked_compact_player_behavior"} for shape in aggregate_shapes))
    aggregate_shapes = (*aggregate_shapes, *(shape | {"waveform_color_updates"} for shape in aggregate_shapes))
    if isinstance(payload, Mapping) and set(payload) in aggregate_shapes:
        legacy = normalize_appearance_preferences({name: payload[name] for name in _COMPACT_FIELDS})
        result = {
            **legacy,
            "album_details_layout": _closed_choice(
                payload["album_details_layout"], ALBUM_DETAILS_LAYOUTS,
                "Unknown album details layout.",
            ),
            "album_playing_row_animation": _closed_choice(
                payload["album_playing_row_animation"], ALBUM_PLAYING_ROW_ANIMATIONS,
                "Unknown album playing-row animation.",
            ),
            "alert_family": _closed_choice(
                payload["alert_family"], ALERT_FAMILIES,
                "Unknown alert family.",
            ),
            "interaction_overrides": _interaction_overrides(payload["interaction_overrides"]),
            "selection_accent": _selection_accent(payload["selection_accent"]),
            "player_style_override": _player_style(payload["player_style_override"]),
        }
        if "docked_compact_player_behavior" in payload:
            result["docked_compact_player_behavior"] = _closed_choice(
                payload["docked_compact_player_behavior"],
                frozenset(("follow_sidebar", "float_on_collapse", "artbox", "stay_docked")),
                "Unknown docked compact player behavior.",
            )
        if "waveform_recent_colors" in payload:
            result["waveform_recent_colors"] = _recent_colors(payload["waveform_recent_colors"])
        if "applied_player_set" in payload:
            result["applied_player_set"] = _player_style(payload["applied_player_set"])
        if "waveform_color_updates" in payload:
            result["waveform_color_updates"] = _recent_colors(payload["waveform_color_updates"])
        return result
    accepted_shapes = (
        set(_FIELDS), set(_LEGACY_COMPACT_FIELDS), set(_FULL_FIELDS), set(_COMPACT_FIELDS), set(_DOCKED_COMPACT_FIELDS),
        set(_COMPACT_FIELDS) | set(_ALBUM_PAGE_FIELDS),
        set(_DOCKED_COMPACT_FIELDS) | set(_ALBUM_PAGE_FIELDS),
        set(_COMPACT_FIELDS) | set(_ALBUM_PAGE_FIELDS) | set(_ALERT_FIELDS),
        set(_DOCKED_COMPACT_FIELDS) | set(_ALBUM_PAGE_FIELDS) | set(_ALERT_FIELDS),
    )
    if not isinstance(payload, Mapping) or set(payload) - {"waveform_color_updates"} not in accepted_shapes:
        raise ValueError("Appearance requires a complete preference object.")
    result: dict[str, object] = {name: _color(payload[name]) for name in _FIELDS}
    if "waveform_color_updates" in payload:
        result["waveform_color_updates"] = _recent_colors(payload["waveform_color_updates"])
    if "palette_id" not in payload:
        if "compact_player_style" in payload:
            if payload["compact_player_style"] not in ("docked", "floating"):
                raise ValueError("Unknown compact player style.")
            result["compact_player_style"] = payload["compact_player_style"]
        return result
    palette = payload["palette_id"]
    if palette is not None and (not isinstance(palette, str) or palette not in APPEARANCE_PALETTE_IDS):
        raise ValueError("Unknown appearance palette.")
    panel = payload["panel_index"]
    if type(panel) is not int or panel not in (0, 1, 2) or (palette is None and panel != 0):
        raise ValueError("Invalid appearance panel companion.")
    if palette is not None and any(result[name] is not None for name in _FIELDS):
        raise ValueError("A palette cannot also use legacy background overrides.")
    player = payload["player_override"]
    if player is not None:
        if not isinstance(player, Mapping) or set(player) != set(_PLAYER_FIELDS):
            raise ValueError("Custom player colors require a complete background, fill and edge group.")
        player = {name: _color(player[name], nullable=False) for name in _PLAYER_FIELDS}
    result.update(palette_id=palette, panel_index=panel, player_override=player)
    if "compact_player_style" in payload:
        if payload["compact_player_style"] not in ("docked", "floating"):
            raise ValueError("Unknown compact player style.")
        result["compact_player_style"] = payload["compact_player_style"]
    if "docked_compact_player_behavior" in payload:
        result["docked_compact_player_behavior"] = _closed_choice(
            payload["docked_compact_player_behavior"],
            frozenset(("follow_sidebar", "float_on_collapse", "artbox", "stay_docked")),
            "Unknown docked compact player behavior.",
        )
    if set(_ALBUM_PAGE_FIELDS).issubset(payload):
        result["album_details_layout"] = _closed_choice(
            payload["album_details_layout"], ALBUM_DETAILS_LAYOUTS,
            "Unknown album details layout.",
        )
        result["album_playing_row_animation"] = _closed_choice(
            payload["album_playing_row_animation"], ALBUM_PLAYING_ROW_ANIMATIONS,
            "Unknown album playing-row animation.",
        )
    if set(_ALERT_FIELDS).issubset(payload):
        result["alert_family"] = _closed_choice(
            payload["alert_family"], ALERT_FAMILIES,
            "Unknown alert family.",
        )
    return result


def expand_appearance_preferences(payload: object) -> dict[str, object]:
    """Canonical read shape, including defaults for legacy two-color preferences."""
    if not isinstance(payload, Mapping):
        raise ValueError("Appearance requires a complete preference object.")
    writable = dict(payload)
    if set(_AGGREGATE_COLUMNS).issubset(writable):
        revision = writable.pop("revision")
        if type(revision) is not int or revision < 0:
            raise ValueError("Invalid appearance revision.")
        recent_sets = merge_player_recent_sets(writable.pop("player_recent_sets"))
        aggregate = {
            "interaction_overrides": _interaction_overrides(writable.pop("interaction_overrides")),
            "selection_accent": _selection_accent(writable.pop("selection_accent")),
            "player_style_override": _player_style(writable.pop("player_style_override")),
        }
        history = _recent_colors(writable.pop("waveform_recent_colors", []))
        normalized = normalize_appearance_preferences(writable)
        normalized.pop("waveform_color_updates", None)
        return {"palette_id": None, "panel_index": 0, "player_override": None, "compact_player_style": "docked", "docked_compact_player_behavior": "follow_sidebar", "docked_compact_player_regular_style": False,
                "compact_player_motion": "normal", "floating_player_edge": {"source": "player", "color": None},
                "album_details_layout": "classic_bar", "album_playing_row_animation": "enabled",
                "alert_family": "ember", "loop_control_style": "capsule",
                **normalized, "waveform_recent_colors": history, "revision": revision, **aggregate,
                "player_recent_sets": recent_sets}
    history = _recent_colors(writable.pop("waveform_recent_colors", []))
    normalized = normalize_appearance_preferences(writable)
    normalized.pop("waveform_color_updates", None)
    return {"palette_id": None, "panel_index": 0, "player_override": None, "compact_player_style": "docked", "docked_compact_player_behavior": "follow_sidebar", "docked_compact_player_regular_style": False,
            "compact_player_motion": "normal", "floating_player_edge": {"source": "player", "color": None},
            "album_details_layout": "classic_bar", "album_playing_row_animation": "enabled",
            "alert_family": "ember", "loop_control_style": "capsule",
            **normalized, "waveform_recent_colors": history}


def appearance_client_profile(client_surface_class: object = None) -> str:
    value = str(client_surface_class or "private_web").strip().casefold().replace("-", "_")
    if value in ("private_web", "desktop", "cloud_web"):
        return "desktop"
    if value in ("mobile", "tv", "apple"):
        return value
    return "desktop"


def _recent_colors(value: object) -> list[str]:
    if not isinstance(value, list) or len(value) > 5:
        raise ValueError("Waveform color selections must contain at most five colors.")
    colors = [_color(color, nullable=False) for color in value]
    if len(set(colors)) != len(colors):
        raise ValueError("Waveform color selections must be distinct.")
    return colors


def _account_id(value: object) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError("An authenticated account id is required.")
    return value


def _preferences(row: object) -> dict[str, object]:
    if row is None:
        return expand_appearance_preferences({
            **dict.fromkeys(_FIELDS),
            "palette_id": None,
            "panel_index": 0,
            "player_override": None,
            "waveform_recent_colors": [],
            "compact_player_style": "docked",
            "docked_compact_player_behavior": "follow_sidebar",
            "docked_compact_player_regular_style": False,
            "compact_player_motion": "normal", "floating_player_edge": {"source": "player", "color": None},
            "album_details_layout": "classic_bar",
            "album_playing_row_animation": "enabled",
            "alert_family": "ember",
            "revision": 0,
            "interaction_overrides": {
                "item_hover": None,
                "item_selected": None,
                "button_hover_background": None,
                "button_pressed": None,
                "item_outline": {"source": "automatic", "color": None},
            },
            "selection_accent": {"enabled": True, "color": "#34CA78"},
            "player_style_override": None,
            "player_recent_sets": [],
        })
    values = row if isinstance(row, Mapping) else dict(zip(_ROW_COLUMNS, row))
    player = {name: values.get(column) for name, column in zip(_PLAYER_FIELDS, _PLAYER_COLUMNS)}
    if set(_AGGREGATE_COLUMNS).issubset(values):
        return expand_appearance_preferences({
            **{name: values.get(name) for name in _FIELDS},
            "palette_id": values.get("palette_id"),
            "panel_index": values.get("panel_index", 0),
            "player_override": player if any(value is not None for value in player.values()) else None,
            "waveform_recent_colors": values.get("waveform_recent_colors", []),
            "compact_player_style": values.get("compact_player_style", "docked"),
            "docked_compact_player_behavior": values.get("docked_compact_player_behavior", "follow_sidebar"),
            "docked_compact_player_regular_style": values.get("docked_compact_player_regular_style", False),
            "compact_player_motion": values.get("compact_player_motion", "normal"),
            "floating_player_edge": values.get("floating_player_edge", {"source": "player", "color": None}),
            "album_details_layout": values.get("album_details_layout", "classic_bar"),
            "album_playing_row_animation": values.get("album_playing_row_animation", "enabled"),
            "alert_family": values.get("alert_family", "ember"),
            "loop_control_style": values.get("loop_control_style", "capsule"),
            **{name: values.get(name) for name in _AGGREGATE_COLUMNS},
        })
    return expand_appearance_preferences({
        **{name: values[name] for name in _FIELDS},
        "palette_id": values.get("palette_id"),
        "panel_index": values.get("panel_index", 0),
        "player_override": player if any(value is not None for value in player.values()) else None,
        "waveform_recent_colors": values.get("waveform_recent_colors", []),
        "compact_player_style": values.get("compact_player_style", "docked"),
        "docked_compact_player_behavior": values.get("docked_compact_player_behavior", "follow_sidebar"),
        "docked_compact_player_regular_style": values.get("docked_compact_player_regular_style", False),
        "compact_player_motion": values.get("compact_player_motion", "normal"),
        "floating_player_edge": values.get("floating_player_edge", {"source": "player", "color": None}),
    })

def _device_profile_preferences(row: object) -> dict[str, object]:
    base = _preferences(row)
    values = row if isinstance(row, Mapping) else {}
    base = {
        **base,
        "action_button_outlines": values.get("action_button_outlines", True) is not False,
    }
    return {
        **base,
        "device_profiles": normalize_appearance_device_profiles(
            values.get("device_section_profiles"), base_preferences=base,
        ),
    }

class PostgresAppearancePreferencesRepository:
    def __init__(
        self, config: Mapping[str, object], *, connect: Callable[[str], Any] | None = None
    ) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._connect = connect or _connect

    def _connection(self):
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for appearance preferences.")
        return self._connect(self._database_url)

    def load_preferences(self, *, account_id: int, client_profile: str = "desktop") -> dict[str, object]:
        owner = _account_id(account_id)
        profile = appearance_client_profile(client_profile)
        with self._connection() as connection:
            row = connection.execute(
                f"""select {_READ_COLUMNS}
                   from app.user_appearance_preferences where account_id = %s and client_profile = %s""",
                (owner, profile),
            ).fetchone()
        return _preferences(row)

    def load_device_profiles(self, *, account_id: int) -> dict[str, object]:
        owner = _account_id(account_id)
        with self._connection() as connection:
            row = connection.execute(
                f"""select {_READ_COLUMNS}, action_button_outlines, device_section_profiles
                   from app.user_appearance_preferences
                  where account_id = %s and client_profile = 'desktop'""",
                (owner,),
            ).fetchone()
        return _device_profile_preferences(row)

    def save_device_profiles(
        self, *, account_id: int, preferences: object, device_profiles: object,
        action_button_outlines: bool, expected_revision: int,
        allow_loop_control_style: bool = False,
    ) -> dict[str, object]:
        owner = _account_id(account_id)
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("A non-negative expected revision is required.")
        if type(action_button_outlines) is not bool:
            raise ValueError("Action button outlines must be enabled or disabled.")
        colors = normalize_appearance_preferences(preferences)
        if "interaction_overrides" not in colors:
            raise ValueError("Device profiles require the revision-controlled aggregate.")
        base = {**colors, "action_button_outlines": action_button_outlines}
        profiles = normalize_appearance_device_profiles(device_profiles, base_preferences=base)
        # Older editors do not know these fields: preserve saved custom-profile values.
        profile_update = "incoming.profiles"
        for profile in ("mobile", "tv"):
            raw_profile = device_profiles.get(profile, {}) if isinstance(device_profiles, Mapping) else {}
            raw_sections = raw_profile.get("sections", raw_profile)
            raw_player = raw_sections.get("player", {})
            if raw_player.get("mode") != "custom":
                continue
            for field in ("docked_compact_player_regular_style", "compact_player_motion", "floating_player_edge"):
                if field not in raw_player.get("values", {}):
                    path = "{" + f"{profile},sections,player,values,{field}" + "}"
                    profile_update = (
                        f"jsonb_set({profile_update}, '{path}', "
                        f"coalesce(saved.device_section_profiles #> '{path}', incoming.profiles #> '{path}'))"
                    )
        sql = f"""with incoming as (
                   select %s::bigint account_id, %s::jsonb profiles, %s::boolean outlines,
                          %s::text main_surface_color, %s::text panel_background_color,
                          %s::text palette_id, %s::smallint panel_index,
                          %s::jsonb interaction_overrides, %s::jsonb selection_accent,
                          %s::jsonb player_style_override, %s::jsonb applied_player_set,
                          %s::text[] waveform_color_updates, %s::bigint expected_revision,
                           %s::text compact_player_style, %s::text docked_compact_player_behavior,
                           %s::boolean docked_compact_player_regular_style,
                           %s::text compact_player_motion, %s::jsonb floating_player_edge,
                           %s::text album_details_layout,
                          %s::text album_playing_row_animation, %s::text alert_family,
                          %s::text player_background, %s::text player_fill, %s::text player_edge,
                          %s::text loop_control_style, %s::boolean allow_loop_control_style
                 ), updated as (
                   update app.user_appearance_preferences as saved
                      set main_surface_color = incoming.main_surface_color,
                          panel_background_color = incoming.panel_background_color,
                          palette_id = incoming.palette_id, panel_index = incoming.panel_index,
                          interaction_overrides = incoming.interaction_overrides,
                          selection_accent = incoming.selection_accent,
                          player_style_override = incoming.player_style_override,
                          player_background_color = incoming.player_background,
                          player_waveform_fill_color = incoming.player_fill,
                          player_waveform_edge_color = incoming.player_edge,
                          player_recent_sets = app.merge_player_recent_sets(saved.player_recent_sets, incoming.applied_player_set),
                          waveform_recent_colors = app.merge_waveform_recent_colors(incoming.waveform_color_updates || saved.waveform_recent_colors),
                           compact_player_style = incoming.compact_player_style,
                           docked_compact_player_behavior = coalesce(incoming.docked_compact_player_behavior, saved.docked_compact_player_behavior),
                       docked_compact_player_regular_style = coalesce(incoming.docked_compact_player_regular_style, saved.docked_compact_player_regular_style),
                       compact_player_motion = coalesce(incoming.compact_player_motion, saved.compact_player_motion),
                       floating_player_edge = coalesce(incoming.floating_player_edge, saved.floating_player_edge),
                          album_details_layout = incoming.album_details_layout,
                          album_playing_row_animation = incoming.album_playing_row_animation,
                          alert_family = incoming.alert_family,
                          loop_control_style = coalesce(incoming.loop_control_style, saved.loop_control_style),
                          action_button_outlines = incoming.outlines,
                          device_section_profiles = {profile_update},
                          revision = saved.revision + 1, updated_at = now()
                     from incoming
                    where saved.account_id = incoming.account_id and saved.client_profile = 'desktop'
                      and saved.revision = incoming.expected_revision
                      and (incoming.loop_control_style is null or incoming.loop_control_style = saved.loop_control_style or incoming.allow_loop_control_style)
                      and (incoming.allow_loop_control_style or (
                          coalesce(incoming.profiles #>> '{{mobile,sections,player,values,loop_control_style}}', saved.loop_control_style, 'capsule')
                              = coalesce(saved.device_section_profiles #>> '{{mobile,sections,player,values,loop_control_style}}', saved.loop_control_style, 'capsule')
                          and coalesce(incoming.profiles #>> '{{tv,sections,player,values,loop_control_style}}', saved.loop_control_style, 'capsule')
                              = coalesce(saved.device_section_profiles #>> '{{tv,sections,player,values,loop_control_style}}', saved.loop_control_style, 'capsule')
                      ))
                 returning {_SAVED_READ_COLUMNS}, saved.action_button_outlines, saved.device_section_profiles
                 ), inserted as (
                   insert into app.user_appearance_preferences
                     (account_id, client_profile, main_surface_color, panel_background_color,
                      palette_id, panel_index, interaction_overrides, selection_accent,
                      player_style_override, player_recent_sets, waveform_recent_colors,
                       revision, compact_player_style, docked_compact_player_behavior, docked_compact_player_regular_style, compact_player_motion, floating_player_edge, album_details_layout, album_playing_row_animation,
                      alert_family, player_background_color, player_waveform_fill_color,
                      player_waveform_edge_color, loop_control_style, action_button_outlines, device_section_profiles)
                   select account_id, 'desktop', main_surface_color, panel_background_color,
                          palette_id, panel_index, interaction_overrides, selection_accent,
                          player_style_override, app.merge_player_recent_sets('[]'::jsonb, applied_player_set),
                          app.merge_waveform_recent_colors(waveform_color_updates), expected_revision + 1,
                           compact_player_style, coalesce(docked_compact_player_behavior, 'follow_sidebar'),
                       coalesce(docked_compact_player_regular_style, false),
                       coalesce(compact_player_motion, 'normal'), coalesce(floating_player_edge, '{{"source":"player","color":null}}'::jsonb), album_details_layout, album_playing_row_animation,
                          alert_family, player_background, player_fill, player_edge,
                          coalesce(loop_control_style, 'capsule'), outlines, profiles
                     from incoming where expected_revision = 0
                       and (loop_control_style is null or loop_control_style = 'capsule' or allow_loop_control_style)
                       and (allow_loop_control_style or (
                           coalesce(profiles #>> '{{mobile,sections,player,values,loop_control_style}}', loop_control_style, 'capsule')
                               = coalesce(loop_control_style, 'capsule')
                           and coalesce(profiles #>> '{{tv,sections,player,values,loop_control_style}}', loop_control_style, 'capsule')
                               = coalesce(loop_control_style, 'capsule')
                       ))
                   on conflict (account_id, client_profile) do nothing
                   returning {_READ_COLUMNS}, action_button_outlines, device_section_profiles
                 )
                 select * from updated union all select * from inserted"""
        params = (
            owner, _jsonb(profiles), action_button_outlines,
            colors["main_surface_color"], colors["panel_background_color"], colors["palette_id"], colors["panel_index"],
            _jsonb(colors["interaction_overrides"]), _jsonb(colors["selection_accent"]),
            _jsonb(colors["player_style_override"]), _jsonb(colors.get("applied_player_set")),
             colors.get("waveform_color_updates", []), expected_revision, colors["compact_player_style"],
             colors.get("docked_compact_player_behavior"), colors.get("docked_compact_player_regular_style"), colors.get("compact_player_motion"), _jsonb(colors.get("floating_player_edge")),
            colors["album_details_layout"], colors["album_playing_row_animation"], colors["alert_family"],
            *((colors["player_override"] or {}).get(field) for field in _PLAYER_FIELDS),
            colors.get("loop_control_style"), allow_loop_control_style is True,
        )
        with self._connection() as connection:
            row = connection.execute(sql, params).fetchone()
            if row is None:
                current_row = connection.execute(
                    f"""select {_READ_COLUMNS}, action_button_outlines, device_section_profiles
                       from app.user_appearance_preferences
                      where account_id = %s and client_profile = 'desktop'""",
                    (owner,),
                ).fetchone()
                current = _device_profile_preferences(current_row)
                loop_style_changed = (
                    colors.get("loop_control_style") is not None
                    and colors.get("loop_control_style") != current.get("loop_control_style")
                )
                device_loop_style_changed = any(
                    profiles[profile]["sections"]["player"]["values"].get("loop_control_style", colors.get("loop_control_style", "capsule"))
                    != current["device_profiles"][profile]["sections"]["player"]["values"].get("loop_control_style", current.get("loop_control_style", "capsule"))
                    for profile in ("mobile", "tv")
                )
                if (current["revision"] == expected_revision
                        and allow_loop_control_style is not True
                        and (loop_style_changed or device_loop_style_changed)):
                    raise AppearanceLoopStyleForbidden("Loop creation permission is required to change this style.")
                raise AppearanceRevisionConflict(current=current)
        values = row if isinstance(row, Mapping) else {}
        saved = {**_preferences(row), "action_button_outlines": values.get("action_button_outlines", True) is not False}
        return {**saved, "device_profiles": normalize_appearance_device_profiles(
            values.get("device_section_profiles"), base_preferences=saved,
        )}

    def save_preferences(
        self, *, account_id: int, preferences: object, client_profile: str = "desktop",
        expected_revision: int | None = None,
        allow_loop_control_style: bool = False,
    ) -> dict[str, object]:
        owner = _account_id(account_id)
        profile = appearance_client_profile(client_profile)
        colors = normalize_appearance_preferences(preferences)
        if "loop_control_style" in colors and "interaction_overrides" not in colors:
            raise ValueError("Loop style writes require the revision-controlled aggregate.")
        if "interaction_overrides" in colors:
            if type(expected_revision) is not int or expected_revision < 0:
                raise ValueError("A non-negative expected revision is required.")
            sql = f"""with incoming as (
                     select %s::bigint account_id, %s::text client_profile,
                            %s::text main_surface_color, %s::text panel_background_color,
                            %s::text palette_id, %s::smallint panel_index,
                            %s::jsonb interaction_overrides, %s::jsonb selection_accent,
                            %s::jsonb player_style_override, %s::jsonb applied_player_set,
                            %s::text[] waveform_color_updates,
                             %s::bigint expected_revision, %s::text compact_player_style,
                             %s::text docked_compact_player_behavior,
                           %s::boolean docked_compact_player_regular_style,
                           %s::text compact_player_motion, %s::jsonb floating_player_edge,
                            %s::text album_details_layout, %s::text album_playing_row_animation,
                            %s::text alert_family,
                            %s::text player_background, %s::text player_fill, %s::text player_edge,
                            %s::text loop_control_style, %s::boolean allow_loop_control_style
                   ), updated as (
                     update app.user_appearance_preferences as saved
                        set main_surface_color = incoming.main_surface_color,
                            panel_background_color = incoming.panel_background_color,
                            palette_id = incoming.palette_id,
                            panel_index = incoming.panel_index,
                            interaction_overrides = incoming.interaction_overrides,
                            selection_accent = incoming.selection_accent,
                            player_style_override = incoming.player_style_override,
                            player_background_color = incoming.player_background,
                            player_waveform_fill_color = incoming.player_fill,
                            player_waveform_edge_color = incoming.player_edge,
                            player_recent_sets = app.merge_player_recent_sets(saved.player_recent_sets, incoming.applied_player_set),
                            waveform_recent_colors = app.merge_waveform_recent_colors(
                              incoming.waveform_color_updates || saved.waveform_recent_colors
                            ),
                             compact_player_style = incoming.compact_player_style,
                             docked_compact_player_behavior = coalesce(incoming.docked_compact_player_behavior, saved.docked_compact_player_behavior),
                       docked_compact_player_regular_style = coalesce(incoming.docked_compact_player_regular_style, saved.docked_compact_player_regular_style),
                       compact_player_motion = coalesce(incoming.compact_player_motion, saved.compact_player_motion),
                       floating_player_edge = coalesce(incoming.floating_player_edge, saved.floating_player_edge),
                            album_details_layout = incoming.album_details_layout,
                            album_playing_row_animation = incoming.album_playing_row_animation,
                            alert_family = incoming.alert_family,
                            loop_control_style = coalesce(incoming.loop_control_style, saved.loop_control_style),
                            revision = saved.revision + 1,
                            updated_at = now()
                       from incoming
                      where saved.account_id = incoming.account_id
                        and saved.client_profile = incoming.client_profile
                        and saved.revision = incoming.expected_revision
                        and (incoming.loop_control_style is null
                             or incoming.loop_control_style = saved.loop_control_style
                             or incoming.allow_loop_control_style)
                   returning {_SAVED_READ_COLUMNS}
                   ), inserted as (
                   insert into app.user_appearance_preferences
                     (account_id, client_profile, main_surface_color, panel_background_color,
                      palette_id, panel_index, interaction_overrides, selection_accent,
                      player_style_override, player_recent_sets, waveform_recent_colors,
                       revision, compact_player_style, docked_compact_player_behavior, docked_compact_player_regular_style, compact_player_motion, floating_player_edge, album_details_layout, album_playing_row_animation,
                      alert_family, player_background_color, player_waveform_fill_color, player_waveform_edge_color, loop_control_style)
                   select account_id, client_profile, main_surface_color, panel_background_color,
                          palette_id, panel_index, interaction_overrides, selection_accent,
                          player_style_override,
                          app.merge_player_recent_sets('[]'::jsonb, applied_player_set),
                          app.merge_waveform_recent_colors(waveform_color_updates),
                           expected_revision + 1, compact_player_style, coalesce(docked_compact_player_behavior, 'follow_sidebar'),
                       coalesce(docked_compact_player_regular_style, false),
                       coalesce(compact_player_motion, 'normal'), coalesce(floating_player_edge, '{{"source":"player","color":null}}'::jsonb),
                          album_details_layout, album_playing_row_animation, alert_family,
                          player_background, player_fill, player_edge, coalesce(loop_control_style, 'capsule')
                     from incoming where expected_revision = 0
                       and (loop_control_style is null or loop_control_style = 'capsule'
                            or allow_loop_control_style)
                   on conflict (account_id, client_profile) do nothing
                   returning {_READ_COLUMNS}
                   )
                   select {_READ_COLUMNS} from updated
                   union all
                   select {_READ_COLUMNS} from inserted"""
            params = (
                owner, profile, colors["main_surface_color"], colors["panel_background_color"],
                colors["palette_id"], colors["panel_index"], _jsonb(colors["interaction_overrides"]),
                _jsonb(colors["selection_accent"]), _jsonb(colors["player_style_override"]), _jsonb(colors.get("applied_player_set")),
                 colors.get("waveform_color_updates", []), expected_revision, colors["compact_player_style"],
                 colors.get("docked_compact_player_behavior"), colors.get("docked_compact_player_regular_style"), colors.get("compact_player_motion"), _jsonb(colors.get("floating_player_edge")),
                colors["album_details_layout"], colors["album_playing_row_animation"],
                colors["alert_family"],
                *((colors["player_override"] or {}).get(field) for field in _PLAYER_FIELDS),
                colors.get("loop_control_style"), allow_loop_control_style is True,
            )
            with self._connection() as connection:
                row = connection.execute(sql, params).fetchone()
                if row is None:
                    current = connection.execute(
                        f"select {_READ_COLUMNS} from app.user_appearance_preferences where account_id = %s and client_profile = %s",
                        (owner, profile),
                    ).fetchone()
                    current_preferences = _preferences(current)
                    if (current_preferences["revision"] == expected_revision
                            and "loop_control_style" in colors
                            and colors["loop_control_style"] != current_preferences["loop_control_style"]
                            and allow_loop_control_style is not True):
                        raise AppearanceLoopStyleForbidden("Loop creation permission is required to change this style.")
                    raise AppearanceRevisionConflict(current=current_preferences)
            return _preferences(row)
        updates = colors.get("waveform_color_updates", [])
        if "palette_id" not in colors:
            # An older client can edit backgrounds without overwriting the player
            # group last saved by another session. No read/modify/write window.
            history_column = ", waveform_recent_colors" if updates else ""
            history_value = ", %s::text[]" if updates else ""
            style_column = ", compact_player_style" if "compact_player_style" in colors else ""
            style_value = ", %s::text" if "compact_player_style" in colors else ""
            style_update = "compact_player_style = excluded.compact_player_style," if "compact_player_style" in colors else ""
            for name, cast in (("docked_compact_player_regular_style", "boolean"), ("compact_player_motion", "text"), ("floating_player_edge", "jsonb")):
                if name in colors:
                    style_column += f", {name}"
                    style_value += f", %s::{cast}"
                    style_update += f" {name} = excluded.{name},"
            history_update = """waveform_recent_colors = app.merge_waveform_recent_colors(
                             excluded.waveform_recent_colors || saved.waveform_recent_colors
                             || array[saved.player_waveform_fill_color, saved.player_waveform_edge_color]),""" if updates else ""
            sql = f"""insert into app.user_appearance_preferences as saved
                     (account_id, client_profile, main_surface_color, panel_background_color{history_column}{style_column}, revision)
                   values (%s, %s, %s, %s{history_value}{style_value}, 1)
                   on conflict (account_id, client_profile) do update
                     set main_surface_color = excluded.main_surface_color,
                         panel_background_color = excluded.panel_background_color,
                         palette_id = null,
                         panel_index = 0,
                         {history_update}
                         {style_update}
                         revision = saved.revision + 1,
                         updated_at = now()
                   returning {_READ_COLUMNS}"""
            params = (owner, profile, colors["main_surface_color"], colors["panel_background_color"])
            if updates:
                params += (updates,)
            if "compact_player_style" in colors:
                params += (colors["compact_player_style"],)
            if "docked_compact_player_regular_style" in colors:
                params += (colors["docked_compact_player_regular_style"],)
            if "compact_player_motion" in colors:
                params += (colors["compact_player_motion"],)
            if "floating_player_edge" in colors:
                params += (_jsonb(colors["floating_player_edge"]),)
        else:
            player = colors["player_override"] or dict.fromkeys(_PLAYER_FIELDS)
            sql = f"""with incoming as (
                     select %s::bigint as account_id, %s::text as client_profile, %s::text as main_surface_color,
                            %s::text as panel_background_color, %s::text as palette_id,
                            %s::smallint as panel_index, %s::text as player_background_color,
                            %s::text as player_waveform_fill_color, %s::text as player_waveform_edge_color,
                             %s::text[] as updates, %s::text as compact_player_style,
                             %s::text as docked_compact_player_behavior,
                             %s::boolean as docked_compact_player_regular_style,
                             %s::text as compact_player_motion, %s::jsonb as floating_player_edge,
                            %s::text as album_details_layout, %s::text as album_playing_row_animation,
                            %s::text as alert_family
                   )
                   insert into app.user_appearance_preferences as saved
                     (account_id, client_profile, {", ".join(_STORAGE_FIELDS)}, album_details_layout, album_playing_row_animation, alert_family, revision)
                   select account_id, client_profile, main_surface_color, panel_background_color, palette_id, panel_index,
                          player_background_color, player_waveform_fill_color, player_waveform_edge_color,
                          app.merge_waveform_recent_colors(updates || array[player_waveform_fill_color, player_waveform_edge_color]),
                           coalesce(compact_player_style, 'docked'), coalesce(docked_compact_player_behavior, 'follow_sidebar'),
                       coalesce(docked_compact_player_regular_style, false),
                       coalesce(compact_player_motion, 'normal'), coalesce(floating_player_edge, '{{"source":"player","color":null}}'::jsonb), coalesce(album_details_layout, 'classic_bar'),
                          coalesce(album_playing_row_animation, 'enabled'), coalesce(alert_family, 'ember'), 1
                     from incoming where true
                   on conflict (account_id, client_profile) do update
                     set main_surface_color = excluded.main_surface_color,
                         panel_background_color = excluded.panel_background_color,
                         palette_id = excluded.palette_id,
                         panel_index = excluded.panel_index,
                         player_background_color = excluded.player_background_color,
                         player_waveform_fill_color = excluded.player_waveform_fill_color,
                         player_waveform_edge_color = excluded.player_waveform_edge_color,
                          compact_player_style = coalesce((select compact_player_style from incoming), saved.compact_player_style),
                          docked_compact_player_behavior = coalesce((select docked_compact_player_behavior from incoming), saved.docked_compact_player_behavior),
                       docked_compact_player_regular_style = coalesce((select docked_compact_player_regular_style from incoming), saved.docked_compact_player_regular_style),
                       compact_player_motion = coalesce((select compact_player_motion from incoming), saved.compact_player_motion),
                       floating_player_edge = coalesce((select floating_player_edge from incoming), saved.floating_player_edge),
                         album_details_layout = coalesce((select album_details_layout from incoming), saved.album_details_layout),
                         album_playing_row_animation = coalesce((select album_playing_row_animation from incoming), saved.album_playing_row_animation),
                         alert_family = coalesce((select alert_family from incoming), saved.alert_family),
                         revision = saved.revision + 1,
                         waveform_recent_colors = app.merge_waveform_recent_colors(
                           (select updates from incoming)
                           || case when excluded.player_waveform_fill_color is distinct from saved.player_waveform_fill_color
                                then array[excluded.player_waveform_fill_color] else array[]::text[] end
                           || case when excluded.player_waveform_edge_color is distinct from saved.player_waveform_edge_color
                                then array[excluded.player_waveform_edge_color] else array[]::text[] end
                           || case when excluded.player_waveform_fill_color is distinct from saved.player_waveform_fill_color
                                     and not (saved.player_waveform_fill_color = any(saved.waveform_recent_colors))
                                then array[saved.player_waveform_fill_color] else array[]::text[] end
                           || case when excluded.player_waveform_edge_color is distinct from saved.player_waveform_edge_color
                                     and not (saved.player_waveform_edge_color = any(saved.waveform_recent_colors))
                                then array[saved.player_waveform_edge_color] else array[]::text[] end
                           || saved.waveform_recent_colors
                           || array[saved.player_waveform_fill_color, saved.player_waveform_edge_color]),
                         updated_at = now()
                   returning {_READ_COLUMNS}"""
            params = (owner, profile, colors["main_surface_color"], colors["panel_background_color"],
                      colors["palette_id"], colors["panel_index"],
                      player["background"], player["fill"], player["edge"], updates,
                       colors.get("compact_player_style"), colors.get("docked_compact_player_behavior"), colors.get("docked_compact_player_regular_style"), colors.get("compact_player_motion"), _jsonb(colors.get("floating_player_edge")), colors.get("album_details_layout"),
                      colors.get("album_playing_row_animation"), colors.get("alert_family"))
        with self._connection() as connection:
            row = connection.execute(sql, params).fetchone()
            if row is None:
                raise RuntimeError("Appearance preferences were not saved.")
            saved = _preferences(row)
        return saved


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for appearance preferences.")
    return psycopg.connect(database_url, row_factory=dict_row)
