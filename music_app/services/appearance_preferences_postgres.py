"""Account-owned palettes, legacy backgrounds and grouped player colors."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import re
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - diagnostics without the optional driver
    psycopg = None
    dict_row = None


_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
_FIELDS = ("main_surface_color", "panel_background_color")
_FULL_FIELDS = (*_FIELDS, "palette_id", "panel_index", "player_override")
_COMPACT_FIELDS = (*_FULL_FIELDS, "compact_player_style")
_LEGACY_COMPACT_FIELDS = (*_FIELDS, "compact_player_style")
_PLAYER_FIELDS = ("background", "fill", "edge")
_PLAYER_COLUMNS = (
    "player_background_color", "player_waveform_fill_color", "player_waveform_edge_color"
)
_STORAGE_FIELDS = (*_FIELDS, "palette_id", "panel_index", *_PLAYER_COLUMNS, "waveform_recent_colors", "compact_player_style")
_READ_COLUMNS = ", ".join(_STORAGE_FIELDS)
APPEARANCE_PALETTE_IDS = frozenset({
    "steelblue", "navy", "powderblue", "graphite", "slate", "midnight",
    "black", "blackgray", "paper", "silver", "coollight",
})


def _color(value: object, *, nullable: bool = True) -> str | None:
    if value is None and nullable:
        return None
    if isinstance(value, str) and _COLOR.fullmatch(value):
        return value.upper()
    raise ValueError("Appearance colors must be six-digit RGB HEX values.")


def normalize_appearance_preferences(payload: object) -> dict[str, object]:
    """Validate either a legacy pair or the complete palette/player preference."""
    if not isinstance(payload, Mapping) or set(payload) - {"waveform_color_updates"} not in (set(_FIELDS), set(_LEGACY_COMPACT_FIELDS), set(_FULL_FIELDS), set(_COMPACT_FIELDS)):
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
    return result


def expand_appearance_preferences(payload: object) -> dict[str, object]:
    """Canonical read shape, including defaults for legacy two-color preferences."""
    if not isinstance(payload, Mapping):
        raise ValueError("Appearance requires a complete preference object.")
    writable = dict(payload)
    history = _recent_colors(writable.pop("waveform_recent_colors", []))
    normalized = normalize_appearance_preferences(writable)
    normalized.pop("waveform_color_updates", None)
    return {"palette_id": None, "panel_index": 0, "player_override": None, "compact_player_style": "docked",
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
        return expand_appearance_preferences(dict.fromkeys(_FIELDS))
    values = row if isinstance(row, Mapping) else dict(zip(_STORAGE_FIELDS, row))
    player = {name: values.get(column) for name, column in zip(_PLAYER_FIELDS, _PLAYER_COLUMNS)}
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
        self, *, account_id: int, preferences: object, client_profile: str = "desktop"
    ) -> dict[str, object]:
        owner = _account_id(account_id)
        profile = appearance_client_profile(client_profile)
        colors = normalize_appearance_preferences(preferences)
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
                     (account_id, client_profile, main_surface_color, panel_background_color{history_column}{style_column})
                   values (%s, %s, %s, %s{history_value}{style_value})
                   on conflict (account_id, client_profile) do update
                     set main_surface_color = excluded.main_surface_color,
                         panel_background_color = excluded.panel_background_color,
                         palette_id = null,
                         panel_index = 0,
                         {history_update}
                         {style_update}
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
                            %s::text[] as updates, %s::text as compact_player_style
                   )
                   insert into app.user_appearance_preferences as saved
                     (account_id, client_profile, {_READ_COLUMNS})
                   select account_id, client_profile, main_surface_color, panel_background_color, palette_id, panel_index,
                          player_background_color, player_waveform_fill_color, player_waveform_edge_color,
                          app.merge_waveform_recent_colors(updates || array[player_waveform_fill_color, player_waveform_edge_color]),
                          coalesce(compact_player_style, 'docked')
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
                      colors.get("compact_player_style"))
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
