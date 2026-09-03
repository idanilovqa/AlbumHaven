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
_PLAYER_FIELDS = ("background", "fill", "edge")
_PLAYER_COLUMNS = (
    "player_background_color", "player_waveform_fill_color", "player_waveform_edge_color"
)
_STORAGE_FIELDS = (*_FIELDS, "palette_id", "panel_index", *_PLAYER_COLUMNS)
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
    if not isinstance(payload, Mapping) or set(payload) not in (set(_FIELDS), set(_FULL_FIELDS)):
        raise ValueError("Appearance requires a complete preference object.")
    result: dict[str, object] = {name: _color(payload[name]) for name in _FIELDS}
    if set(payload) == set(_FIELDS):
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
    return result


def expand_appearance_preferences(payload: object) -> dict[str, object]:
    """Canonical read shape, including defaults for legacy two-color preferences."""
    return {"palette_id": None, "panel_index": 0, "player_override": None,
            **normalize_appearance_preferences(payload)}


def _account_id(value: object) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError("An authenticated account id is required.")
    return value


def _preferences(row: object) -> dict[str, object]:
    if row is None:
        return expand_appearance_preferences(dict.fromkeys(_FIELDS))
    values = row if isinstance(row, Mapping) else dict(zip(_STORAGE_FIELDS, row))
    player = {name: values.get(column) for name, column in zip(_PLAYER_FIELDS, _PLAYER_COLUMNS)}
    return normalize_appearance_preferences({
        **{name: values[name] for name in _FIELDS},
        "palette_id": values.get("palette_id"),
        "panel_index": values.get("panel_index", 0),
        "player_override": player if any(value is not None for value in player.values()) else None,
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

    def load_preferences(self, *, account_id: int) -> dict[str, object]:
        owner = _account_id(account_id)
        with self._connection() as connection:
            row = connection.execute(
                f"""select {_READ_COLUMNS}
                   from app.user_appearance_preferences where account_id = %s""",
                (owner,),
            ).fetchone()
        return _preferences(row)

    def save_preferences(
        self, *, account_id: int, preferences: object
    ) -> dict[str, object]:
        owner = _account_id(account_id)
        colors = normalize_appearance_preferences(preferences)
        if "palette_id" not in colors:
            # An older client can edit backgrounds without overwriting the player
            # group last saved by another session. No read/modify/write window.
            sql = f"""insert into app.user_appearance_preferences
                     (account_id, main_surface_color, panel_background_color)
                   values (%s, %s, %s)
                   on conflict (account_id) do update
                     set main_surface_color = excluded.main_surface_color,
                         panel_background_color = excluded.panel_background_color,
                         palette_id = null,
                         panel_index = 0,
                         updated_at = now()
                   returning {_READ_COLUMNS}"""
            params = (owner, colors["main_surface_color"], colors["panel_background_color"])
        else:
            player = colors["player_override"] or dict.fromkeys(_PLAYER_FIELDS)
            sql = f"""insert into app.user_appearance_preferences
                     (account_id, {_READ_COLUMNS})
                   values (%s, %s, %s, %s, %s, %s, %s, %s)
                   on conflict (account_id) do update
                     set main_surface_color = excluded.main_surface_color,
                         panel_background_color = excluded.panel_background_color,
                         palette_id = excluded.palette_id,
                         panel_index = excluded.panel_index,
                         player_background_color = excluded.player_background_color,
                         player_waveform_fill_color = excluded.player_waveform_fill_color,
                         player_waveform_edge_color = excluded.player_waveform_edge_color,
                         updated_at = now()
                   returning {_READ_COLUMNS}"""
            params = (owner, colors["main_surface_color"], colors["panel_background_color"],
                      colors["palette_id"], colors["panel_index"],
                      player["background"], player["fill"], player["edge"])
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
