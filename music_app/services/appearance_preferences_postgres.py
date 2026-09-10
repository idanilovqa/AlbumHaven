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
_LEGACY_COMPACT_FIELDS = (*_FIELDS, "compact_player_style")
_ALBUM_PAGE_FIELDS = ("album_details_layout", "album_playing_row_animation")
_ALERT_FIELDS = ("alert_family",)
_PLAYER_FIELDS = ("background", "fill", "edge")
_PLAYER_COLUMNS = (
    "player_background_color", "player_waveform_fill_color", "player_waveform_edge_color"
)
_STORAGE_FIELDS = (*_FIELDS, "palette_id", "panel_index", *_PLAYER_COLUMNS, "waveform_recent_colors", "compact_player_style")
_AGGREGATE_COLUMNS = ("revision", "interaction_overrides", "selection_accent", "player_style_override", "player_recent_sets")
_ROW_COLUMNS = (*_STORAGE_FIELDS, *_ALBUM_PAGE_FIELDS, *_ALERT_FIELDS, *_AGGREGATE_COLUMNS)
_READ_COLUMNS = ", ".join(_ROW_COLUMNS)
_SAVED_READ_COLUMNS = ", ".join(f"saved.{name}" for name in _ROW_COLUMNS)
_INTERACTION_COLOR_FIELDS = (
    "item_hover", "item_selected", "button_hover_background", "button_pressed",
)
_ITEM_OUTLINE_SOURCES = frozenset({"automatic", "theme", "player", "custom"})
_AGGREGATE_WRITE_FIELDS = (*_COMPACT_FIELDS, *_ALBUM_PAGE_FIELDS, *_ALERT_FIELDS, "waveform_recent_colors", "interaction_overrides", "selection_accent", "player_style_override", "applied_player_set")
APPEARANCE_PALETTE_IDS = frozenset({
    "steelblue", "navy", "powderblue", "graphite", "slate", "midnight",
    "black", "blackgray", "paper", "silver", "coollight",
})
ALBUM_DETAILS_LAYOUTS = frozenset({"classic_bar", "stacked_bar", "editorial_canvas"})
ALBUM_PLAYING_ROW_ANIMATIONS = frozenset({"enabled", "disabled"})
ALERT_FAMILIES = frozenset({"ember", "signal", "quiet"})


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
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ValueError("Interaction overrides require the complete closed set.")
    return {
        **{name: _color(value[name]) for name in _INTERACTION_COLOR_FIELDS},
        "item_outline": _item_outline(value["item_outline"]),
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


def _jsonb(value: object):
    if value is None:
        return None
    return Jsonb(value) if Jsonb is not None else value


def normalize_appearance_preferences(payload: object) -> dict[str, object]:
    """Validate either a legacy pair or the complete palette/player preference."""
    aggregate_shapes = (
        set(_AGGREGATE_WRITE_FIELDS),
        set(_AGGREGATE_WRITE_FIELDS) - {"applied_player_set"},
        set(_AGGREGATE_WRITE_FIELDS) - {"waveform_recent_colors"},
        set(_AGGREGATE_WRITE_FIELDS) - {"waveform_recent_colors", "applied_player_set"},
    )
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
        if "waveform_recent_colors" in payload:
            result["waveform_recent_colors"] = _recent_colors(payload["waveform_recent_colors"])
        if "applied_player_set" in payload:
            result["applied_player_set"] = _player_style(payload["applied_player_set"])
        if "waveform_color_updates" in payload:
            result["waveform_color_updates"] = _recent_colors(payload["waveform_color_updates"])
        return result
    accepted_shapes = (
        set(_FIELDS), set(_LEGACY_COMPACT_FIELDS), set(_FULL_FIELDS), set(_COMPACT_FIELDS),
        set(_COMPACT_FIELDS) | set(_ALBUM_PAGE_FIELDS),
        set(_COMPACT_FIELDS) | set(_ALBUM_PAGE_FIELDS) | set(_ALERT_FIELDS),
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
        return {"palette_id": None, "panel_index": 0, "player_override": None, "compact_player_style": "docked",
                "album_details_layout": "classic_bar", "album_playing_row_animation": "enabled",
                "alert_family": "ember",
                **normalized, "waveform_recent_colors": history, "revision": revision, **aggregate,
                "player_recent_sets": recent_sets}
    history = _recent_colors(writable.pop("waveform_recent_colors", []))
    normalized = normalize_appearance_preferences(writable)
    normalized.pop("waveform_color_updates", None)
    return {"palette_id": None, "panel_index": 0, "player_override": None, "compact_player_style": "docked",
            "album_details_layout": "classic_bar", "album_playing_row_animation": "enabled",
            "alert_family": "ember",
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
            "album_details_layout": values.get("album_details_layout", "classic_bar"),
            "album_playing_row_animation": values.get("album_playing_row_animation", "enabled"),
            "alert_family": values.get("alert_family", "ember"),
            **{name: values.get(name) for name in _AGGREGATE_COLUMNS},
        })
    return expand_appearance_preferences({
        **{name: values[name] for name in _FIELDS},
        "palette_id": values.get("palette_id"),
        "panel_index": values.get("panel_index", 0),
        "player_override": player if any(value is not None for value in player.values()) else None,
        "waveform_recent_colors": values.get("waveform_recent_colors", []),
        "compact_player_style": values.get("compact_player_style", "docked"),
    })


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

    def save_preferences(
        self, *, account_id: int, preferences: object, client_profile: str = "desktop",
        expected_revision: int | None = None,
    ) -> dict[str, object]:
        owner = _account_id(account_id)
        profile = appearance_client_profile(client_profile)
        colors = normalize_appearance_preferences(preferences)
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
                            %s::text album_details_layout, %s::text album_playing_row_animation,
                            %s::text alert_family,
                            %s::text player_background, %s::text player_fill, %s::text player_edge
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
                            album_details_layout = incoming.album_details_layout,
                            album_playing_row_animation = incoming.album_playing_row_animation,
                            alert_family = incoming.alert_family,
                            revision = saved.revision + 1,
                            updated_at = now()
                       from incoming
                      where saved.account_id = incoming.account_id
                        and saved.client_profile = incoming.client_profile
                        and saved.revision = incoming.expected_revision
                   returning {_SAVED_READ_COLUMNS}
                   ), inserted as (
                   insert into app.user_appearance_preferences
                     (account_id, client_profile, main_surface_color, panel_background_color,
                      palette_id, panel_index, interaction_overrides, selection_accent,
                      player_style_override, player_recent_sets, waveform_recent_colors,
                      revision, compact_player_style, album_details_layout, album_playing_row_animation,
                      alert_family, player_background_color, player_waveform_fill_color, player_waveform_edge_color)
                   select account_id, client_profile, main_surface_color, panel_background_color,
                          palette_id, panel_index, interaction_overrides, selection_accent,
                          player_style_override,
                          app.merge_player_recent_sets('[]'::jsonb, applied_player_set),
                          app.merge_waveform_recent_colors(waveform_color_updates),
                          expected_revision + 1, compact_player_style,
                          album_details_layout, album_playing_row_animation, alert_family,
                          player_background, player_fill, player_edge
                     from incoming where expected_revision = 0
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
                colors["album_details_layout"], colors["album_playing_row_animation"],
                colors["alert_family"],
                *((colors["player_override"] or {}).get(field) for field in _PLAYER_FIELDS),
            )
            with self._connection() as connection:
                row = connection.execute(sql, params).fetchone()
                if row is None:
                    current = connection.execute(
                        f"select {_READ_COLUMNS} from app.user_appearance_preferences where account_id = %s and client_profile = %s",
                        (owner, profile),
                    ).fetchone()
                    raise AppearanceRevisionConflict(current=_preferences(current))
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
        else:
            player = colors["player_override"] or dict.fromkeys(_PLAYER_FIELDS)
            sql = f"""with incoming as (
                     select %s::bigint as account_id, %s::text as client_profile, %s::text as main_surface_color,
                            %s::text as panel_background_color, %s::text as palette_id,
                            %s::smallint as panel_index, %s::text as player_background_color,
                            %s::text as player_waveform_fill_color, %s::text as player_waveform_edge_color,
                            %s::text[] as updates, %s::text as compact_player_style,
                            %s::text as album_details_layout, %s::text as album_playing_row_animation,
                            %s::text as alert_family
                   )
                   insert into app.user_appearance_preferences as saved
                     (account_id, client_profile, {", ".join(_STORAGE_FIELDS)}, album_details_layout, album_playing_row_animation, alert_family, revision)
                   select account_id, client_profile, main_surface_color, panel_background_color, palette_id, panel_index,
                          player_background_color, player_waveform_fill_color, player_waveform_edge_color,
                          app.merge_waveform_recent_colors(updates || array[player_waveform_fill_color, player_waveform_edge_color]),
                          coalesce(compact_player_style, 'docked'), coalesce(album_details_layout, 'classic_bar'),
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
                      colors.get("compact_player_style"), colors.get("album_details_layout"),
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
