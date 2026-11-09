"""Account acknowledgements of watcher warnings; never clears watcher health."""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from hashlib import sha256
import json

from music_app.services.library_watch_health import _connect


def warning_token(health: dict) -> str:
    if health.get("state") != "warning":
        return ""
    durable_tokens = []
    unacknowledged_tokens = []
    events = []
    for problem in health.get("problems", []):
        durable_token = str(
            problem.get("warning_token")
            or problem.get("incident_id")
            or problem.get("event_id")
            or ""
        ).strip()
        if durable_token:
            durable_tokens.append(durable_token)
            if not bool(problem.get("acknowledged")):
                unacknowledged_tokens.append(durable_token)
            continue
        # Retain the exact legacy hash until that warning is replaced.
        events.append((
            str(problem.get("root_key", "")),
            str(problem.get("state", "")),
            str(problem.get("detected_at", "")),
        ))
    if unacknowledged_tokens:
        return sorted(set(unacknowledged_tokens))[0]
    if durable_tokens:
        return sorted(set(durable_tokens))[0]
    if not events:
        return ""
    events.sort()
    return sha256(json.dumps(events, separators=(",", ":")).encode()).hexdigest()


class PostgresLibraryWarningDismissals:
    def __init__(self, config, *, connect=None):
        self.url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
        self.connect = connect or _connect
        self.library_id = None
        self.now = lambda: datetime.now(timezone.utc)

    def load(self, account_id):
        library_id = _positive_id(self.library_id, "library_id")
        with self.connect(self.url) as conn:
            rows = conn.execute(
                """
                select warning_token
                from library.load_watcher_incident_acknowledgements(%s, %s)
                """,
                (library_id, _positive_id(account_id, "account_id")),
            ).fetchall()
        if not rows:
            return ""
        row = rows[0]
        return str(
            row.get("warning_token") if isinstance(row, Mapping) else row[0]
        )

    def save(self, account_id, token, *_legacy_health):
        library_id = _positive_id(self.library_id, "library_id")
        observed_at = self.now()
        with self.connect(self.url) as conn:
            row = conn.execute(
                "select library.acknowledge_watcher_incident(%s, %s, %s::uuid, %s)",
                (
                    library_id,
                    _positive_id(account_id, "account_id"),
                    token,
                    observed_at,
                ),
            ).fetchone()
            acknowledged = (
                next(iter(row.values()), False)
                if isinstance(row, Mapping)
                else bool(row and row[0])
            )
            if acknowledged is not True:
                raise ValueError("watcher incident is not current")
            conn.commit()


def _positive_id(value: object, name: str) -> int:
    parsed = int(value or 0)
    if parsed < 1:
        raise RuntimeError(f"{name} is unavailable")
    return parsed
