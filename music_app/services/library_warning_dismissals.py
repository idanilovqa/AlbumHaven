"""Account acknowledgements of watcher warnings; never clears watcher health."""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
import re

from music_app.services.library_watch_health import (
    LibraryWatchHealthProblem,
    _connect,
)


def warning_token(health: dict) -> str:
    if health.get("state") != "warning":
        return ""
    events = []
    for problem in health.get("problems", []):
        event_id = str(problem.get("event_id") or "")
        if event_id:
            events.append((event_id,))
            continue
        # Retain the exact legacy hash until that warning is replaced.
        events.append((
            str(problem.get("root_key", "")),
            str(problem.get("state", "")),
            str(problem.get("detected_at", "")),
        ))
    if not events:
        return ""
    events.sort()
    return sha256(json.dumps(events, separators=(",", ":")).encode()).hexdigest()


def _timestamp_text(value: object) -> str:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value)
        normalized = re.sub(
            r"(\.\d{1,5})(?=(?:Z|[+-]\d\d:\d\d)?$)",
            lambda match: match.group(1).ljust(7, "0"),
            text,
        )
        try:
            parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError:
            return text
    if parsed.tzinfo is None:
        return parsed.isoformat()
    return parsed.astimezone(timezone.utc).isoformat()


class PostgresLibraryWarningDismissals:
    def __init__(self, config, *, connect=None):
        self.url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
        self.connect = connect or _connect

    def load(self, account_id):
        with self.connect(self.url) as conn:
            rows = conn.execute(
                """
                select root_id, state, detected_at, event_id
                from library.load_local_watcher_incident_acknowledgements(%s)
                """,
                (account_id,),
            ).fetchall()
        problems = [
            LibraryWatchHealthProblem(
                root_id=str(row["root_id"]),
                state=str(row["state"]),
                detected_at=_timestamp_text(row["detected_at"]),
                event_id=str(row["event_id"]),
            ).as_public_dict()
            for row in rows
        ]
        return warning_token({"state": "warning", "problems": problems})

    def save(self, account_id, token, health):
        if warning_token(health) != token:
            raise ValueError("warning token does not match watcher health")
        incident_tokens = list(
            dict.fromkeys(
                str(problem.get("event_id") or "").strip()
                for problem in health.get("problems", [])
                if str(problem.get("event_id") or "").strip()
            )
        )
        if not incident_tokens:
            raise RuntimeError("watcher acknowledgement changed")
        with self.connect(self.url) as conn:
            row = conn.execute(
                "select library.acknowledge_local_watcher_incidents(%s, %s::uuid[]) "
                "as acknowledged_count",
                (account_id, incident_tokens),
            ).fetchone()
            if int((row or {}).get("acknowledged_count") or 0) != len(incident_tokens):
                raise RuntimeError("watcher acknowledgement changed")
            conn.commit()
