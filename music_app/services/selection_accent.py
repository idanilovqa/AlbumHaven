"""Validated account-owned navigation selection appearance in Postgres."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import json
import re
from typing import Any

try:  # pragma: no cover - the driver is optional for import-time tooling.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


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
    """Read/write one bounded metadata value without replacing sibling settings."""

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
                select id as account_id,
                       metadata -> 'appearance_selection_accent_v1' as selection_accent
                from app.accounts
                where id = %s and is_active and disabled_at is null
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
                update app.accounts
                set metadata = jsonb_set(
                        metadata, '{appearance_selection_accent_v1}', %s::jsonb, true
                    ),
                    updated_at = now()
                where id = %s and is_active and disabled_at is null
                returning metadata -> 'appearance_selection_accent_v1' as selection_accent
                """,
                (json.dumps(normalized), account_id),
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
