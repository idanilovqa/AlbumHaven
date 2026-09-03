"""Postgres authority for an authenticated account's two background overrides."""

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


def normalize_appearance_preferences(payload: object) -> dict[str, str | None]:
    """Accept a complete pair; null means use that surface's built-in defaults."""
    if not isinstance(payload, Mapping) or set(payload) != set(_FIELDS):
        raise ValueError("Appearance requires exactly two background colors.")
    result = {}
    for name in _FIELDS:
        value = payload[name]
        if value is None:
            result[name] = None
        elif isinstance(value, str) and _COLOR.fullmatch(value):
            result[name] = value.upper()
        else:
            raise ValueError("Appearance colors must be six-digit RGB HEX values or null.")
    return result


def _account_id(value: object) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError("An authenticated account id is required.")
    return value


def _preferences(row: object) -> dict[str, str | None]:
    if row is None:
        return dict.fromkeys(_FIELDS)
    if isinstance(row, Mapping):
        return normalize_appearance_preferences({name: row[name] for name in _FIELDS})
    return normalize_appearance_preferences(dict(zip(_FIELDS, row)))


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

    def load_preferences(self, *, account_id: int) -> dict[str, str | None]:
        owner = _account_id(account_id)
        with self._connection() as connection:
            row = connection.execute(
                """select main_surface_color, panel_background_color
                   from app.user_appearance_preferences where account_id = %s""",
                (owner,),
            ).fetchone()
        return _preferences(row)

    def save_preferences(
        self, *, account_id: int, preferences: object
    ) -> dict[str, str | None]:
        owner = _account_id(account_id)
        colors = normalize_appearance_preferences(preferences)
        with self._connection() as connection:
            row = connection.execute(
                """insert into app.user_appearance_preferences
                     (account_id, main_surface_color, panel_background_color)
                   values (%s, %s, %s)
                   on conflict (account_id) do update
                     set main_surface_color = excluded.main_surface_color,
                         panel_background_color = excluded.panel_background_color,
                         updated_at = now()
                   returning main_surface_color, panel_background_color""",
                (owner, colors["main_surface_color"], colors["panel_background_color"]),
            ).fetchone()
            if row is None:
                raise RuntimeError("Appearance preferences were not saved.")
            saved = _preferences(row)
        return saved


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for appearance preferences.")
    return psycopg.connect(database_url, row_factory=dict_row)
