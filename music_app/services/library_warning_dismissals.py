"""Account acknowledgements of watcher warnings; never clears watcher health."""
from __future__ import annotations

from hashlib import sha256
import json

from music_app.services.library_watch_health import _BOOTSTRAP_LIBRARY_SQL, _connect


def warning_token(health: dict) -> str:
    if health.get("state") != "warning":
        return ""
    events = sorted((str(p.get("root_key", "")), str(p.get("state", "")),
                     str(p.get("detected_at", ""))) for p in health.get("problems", []))
    return sha256(json.dumps(events, separators=(",", ":")).encode()).hexdigest()


class PostgresLibraryWarningDismissals:
    def __init__(self, config, *, connect=None):
        self.url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
        self.connect = connect or _connect

    def load(self, account_id):
        with self.connect(self.url) as conn:
            row = conn.execute(_BOOTSTRAP_LIBRARY_SQL + """
                select library.libraries.metadata #>> array['watcher_warning_dismissals', %s] as token
                from library.libraries join bootstrap_library on bootstrap_library.id = library.libraries.id
            """, (str(account_id),)).fetchone()
        return str((row or {}).get("token") or "")

    def save(self, account_id, token):
        with self.connect(self.url) as conn:
            conn.execute(_BOOTSTRAP_LIBRARY_SQL + """
                update library.libraries set metadata = jsonb_set(
                    coalesce(metadata, '{}'::jsonb), '{watcher_warning_dismissals}',
                    coalesce(metadata -> 'watcher_warning_dismissals', '{}'::jsonb)
                        || jsonb_build_object(%s::text, %s::text), true)
                from bootstrap_library where library.libraries.id = bootstrap_library.id
            """, (str(account_id), token))
            conn.commit()
