"""Validated account-owned navigation selection appearance in Postgres."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import re
from typing import Any

try:  # pragma: no cover - the driver is optional for import-time tooling.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None
    Jsonb = None


_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def normalize_selection_accent(payload: object) -> dict[str, object]:
    """Accept only the complete preference, never an account or arbitrary CSS."""
    if not isinstance(payload, Mapping) or set(payload) != {"enabled", "color"}:
        raise ValueError("Selection accent requires enabled and color.")
    enabled, color = payload["enabled"], payload["color"]
    if not isinstance(enabled, bool):
        raise ValueError("Selection accent enabled must be a boolean.")
    if not isinstance(color, str) or _COLOR.fullmatch(color) is None:
        raise ValueError("Selection accent color must be a six-digit hex color.")
    return {"enabled": enabled, "color": color.lower()}


class PostgresSelectionAccentStore:
    """Compatibility projection over the aggregate appearance preference."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._connect = connect or _connect

    def load(self, account_id: int) -> dict[str, object] | None:
        account_id = _account_id(account_id)
        with self._connection() as connection:
            row = connection.execute(
                """
                select account_id, selection_accent
                from app.user_appearance_preferences
                where account_id = %s and client_profile = 'desktop'
                """,
                (account_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Selection accent account is unavailable.")
        value = row["selection_accent"]
        return None if value is None else normalize_selection_accent(value)

    def save(self, account_id: int, payload: object) -> dict[str, object]:
        account_id = _account_id(account_id)
        normalized = normalize_selection_accent(payload)
        with self._connection() as connection:
            row = connection.execute(
                """
                update app.user_appearance_preferences
                set selection_accent = %s::jsonb,
                    revision = revision + 1,
                    updated_at = now()
                where account_id = %s and client_profile = 'desktop'
                returning selection_accent
                """,
                (Jsonb(normalized) if Jsonb is not None else normalized, account_id),
            ).fetchone()
            if row is None:
                raise RuntimeError("Selection accent account is unavailable.")
        return normalized

    def _connection(self) -> Any:
        if not self._database_url:
            raise RuntimeError("Postgres is required for selection accent preferences.")
        return self._connect(self._database_url)


def _account_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Selection accent account is invalid.")
    return value


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for selection accent preferences.")
    return psycopg.connect(database_url, row_factory=dict_row)
