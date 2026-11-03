"""Path-free, bounded media references backed by the current library inventory."""

import base64
from datetime import datetime, timedelta, timezone
import hmac
import json
from pathlib import Path

from music_app.services.auth_tokens import keyed_bucket_digest
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.postgres_connections import pooled_connection


class PlaybackContractError(ValueError):
    def __init__(self, status_code=400):
        super().__init__("Invalid or unavailable playback request.")
        self.status_code = status_code


def playback_scope(actor):
    library_id = actor.current_library_id
    if not actor.is_authenticated or not actor.account_id or not library_id or not any(
        member.library_id == library_id for member in actor.library_relationships
    ):
        raise PlaybackContractError(403)
    return actor.account_id, library_id


def require_playback_membership(connection, actor):
    account_id, library_id = playback_scope(actor)
    row = connection.execute(
        """select m.library_id from library.library_memberships m
           join app.accounts a on a.id = m.account_id
           where m.account_id = %s and m.library_id = %s
             and a.is_active is true and a.disabled_at is null""",
        (account_id, library_id),
    ).fetchone()
    if row is None:
        raise PlaybackContractError(403)
    return account_id, library_id


class PlaybackReferenceService:
    def __init__(self, config, *, clock=None, connect=None):
        self._database_url = config.get("ALBUM_HAVEN_APP_DATABASE_URL")
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        policy = config.get("hmac", {})
        secret = policy.get("secret")
        self._version = policy.get("key_version")
        if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32 or type(self._version) is not int or self._version < 1:
            raise PlaybackContractError(503)
        self._secret = secret.encode("utf-8")

    def _signature(self, payload):
        return keyed_bucket_digest(secret=self._secret, key_version=self._version,
            domain="playback-reference-v1", normalized_value=payload).digest

    @staticmethod
    def _file(connection, library_id, *, path=None, file_id=None):
        row = connection.execute(
            """select f.id, f.private_path, r.root_path from library.local_track_files f
               join library.local_tracks t on t.id = f.track_id
               join library.library_roots r on r.id = f.library_root_id
               where t.library_id = %s and r.library_id = t.library_id
                 and r.is_active is true and f.scan_cache_stale is false
                 and """ + ("f.private_path = %s" if path is not None else "f.id = %s"),
            (library_id, path if path is not None else file_id),
        ).fetchone()
        if row is None:
            raise PlaybackContractError(404)
        resolved = resolve_configured_media_path({}, row["private_path"],
            configured_root_paths=[Path(row["root_path"])])
        if resolved is None:
            raise PlaybackContractError(404)
        row["media_path"] = Path(resolved)
        return row

    def issue_batch(self, actor, tracks):
        if not isinstance(tracks, list) or not 1 <= len(tracks) <= 100:
            raise PlaybackContractError()
        for track in tracks:
            if not isinstance(track, dict) or set(track) != {"clientKey", "path"} or any(
                not isinstance(track.get(key), str) or not track[key] or len(track[key]) > limit
                for key, limit in (("clientKey", 128), ("path", 32768))
            ):
                raise PlaybackContractError()
        expires = self._clock() + timedelta(hours=24)
        results = []
        with self._connect(self._database_url) as connection:
            _, library_id = require_playback_membership(connection, actor)
            for track in tracks:
                row = self._file(connection, library_id, path=track["path"])
                data = json.dumps([1, self._version, library_id, row["id"], int(expires.timestamp())], separators=(",", ":"))
                encoded = base64.urlsafe_b64encode(data.encode()).decode().rstrip("=")
                signature = base64.urlsafe_b64encode(self._signature(encoded)).decode().rstrip("=")
                results.append({"clientKey": track["clientKey"], "playbackRef": encoded + "." + signature})
        return {"protocol": 1, "expiresAt": expires.isoformat(), "tracks": results}

    def resolve(self, actor, playback_ref):
        """The media file a reference names, for decoding."""
        return self._resolve_file(actor, playback_ref)["media_path"]

    def resolve_library_path(self, actor, playback_ref):
        """The inventory path the browser names the same track by, so listen history is identical."""
        return self._resolve_file(actor, playback_ref)["private_path"]

    def _resolve_file(self, actor, playback_ref):
        _, library_id = playback_scope(actor)
        try:
            if not isinstance(playback_ref, str) or len(playback_ref) > 512:
                raise ValueError()
            encoded, signature = playback_ref.split(".")
            expected = base64.urlsafe_b64encode(self._signature(encoded)).decode().rstrip("=")
            if not hmac.compare_digest(signature, expected):
                raise ValueError()
            data = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
            if not isinstance(data, list) or len(data) != 5 or any(type(value) is not int for value in data):
                raise ValueError()
            protocol, version, scope, file_id, expiry = data
            if protocol != 1 or version != self._version or scope != library_id or file_id < 1 or expiry <= self._clock().timestamp():
                raise ValueError()
        except (ValueError, TypeError, UnicodeError):
            raise PlaybackContractError(403) from None
        with self._connect(self._database_url) as connection:
            require_playback_membership(connection, actor)
            return self._file(connection, library_id, file_id=file_id)
