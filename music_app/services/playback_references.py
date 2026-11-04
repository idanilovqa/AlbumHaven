"""Path-free, bounded media references backed by the current library inventory."""

import base64
from datetime import datetime, timedelta, timezone
import hmac
import json
from pathlib import Path

from music_app.services.auth_tokens import keyed_bucket_digest
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.postgres_connections import pooled_connection

_REFERENCE_DOMAIN = "playback-reference-v1"
# A resume token names one account's track file without expiry, so a native player may persist it
# and later ask for a fresh reference. Every use rechecks it like a reference; it stops working when
# the key version rotates, the account or its membership ends, or the file stops being current.
_RESUME_DOMAIN = "playback-resume-v1"


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

    def _sign(self, domain, values):
        data = json.dumps(values, separators=(",", ":"))
        encoded = base64.urlsafe_b64encode(data.encode()).decode().rstrip("=")
        return encoded + "." + self._signature(domain, encoded)

    def _signature(self, domain, encoded):
        digest = keyed_bucket_digest(secret=self._secret, key_version=self._version,
            domain=domain, normalized_value=encoded).digest
        return base64.urlsafe_b64encode(digest).decode().rstrip("=")

    def _verified(self, domain, token, length):
        """The integer fields of a token this key signed for [domain]; ValueError otherwise."""
        if not isinstance(token, str) or len(token) > 512:
            raise ValueError()
        encoded, signature = token.split(".")
        if not hmac.compare_digest(signature, self._signature(domain, encoded)):
            raise ValueError()
        data = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
        if not isinstance(data, list) or len(data) != length or any(type(value) is not int for value in data):
            raise ValueError()
        if data[0] != 1 or data[1] != self._version:
            raise ValueError()
        return data

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
            account_id, library_id = require_playback_membership(connection, actor)
            for track in tracks:
                row = self._file(connection, library_id, path=track["path"])
                results.append({"clientKey": track["clientKey"],
                    "playbackRef": self._reference(library_id, row["id"], expires),
                    "resumeToken": self._sign(_RESUME_DOMAIN, [1, self._version, account_id, library_id, row["id"]])})
        return {"protocol": 1, "expiresAt": expires.isoformat(), "tracks": results}

    def _reference(self, library_id, file_id, expires):
        return self._sign(_REFERENCE_DOMAIN, [1, self._version, library_id, file_id, int(expires.timestamp())])

    def exchange_resume_tokens(self, actor, tracks):
        """Fresh references for tracks a native player persisted by resume token.

        A token this key did not sign for this account and library refuses the whole batch (403);
        a track whose file is no longer current answers a null reference, so the others can resume.
        """
        if not isinstance(tracks, list) or not 1 <= len(tracks) <= 100:
            raise PlaybackContractError()
        for track in tracks:
            if not isinstance(track, dict) or set(track) != {"clientKey", "resumeToken"} or any(
                not isinstance(track.get(key), str) or not track[key] or len(track[key]) > limit
                for key, limit in (("clientKey", 128), ("resumeToken", 512))
            ):
                raise PlaybackContractError()
        file_ids = [self._resume_file_id(actor, track["resumeToken"]) for track in tracks]
        expires = self._clock() + timedelta(hours=24)
        results = []
        with self._connect(self._database_url) as connection:
            _, library_id = require_playback_membership(connection, actor)
            for track, file_id in zip(tracks, file_ids):
                try:
                    self._file(connection, library_id, file_id=file_id)
                    reference = self._reference(library_id, file_id, expires)
                except PlaybackContractError:
                    reference = None
                results.append({"clientKey": track["clientKey"], "playbackRef": reference})
        return {"protocol": 1, "expiresAt": expires.isoformat(), "tracks": results}

    def resolve_artwork(self, actor, resume_token):
        """The cover image the web's browse payload names for a resume token's track, rechecked like a reference."""
        file_id = self._resume_file_id(actor, resume_token)
        with self._connect(self._database_url) as connection:
            _, library_id = require_playback_membership(connection, actor)
            row = connection.execute(
                """select coalesce(nullif(btrim(a.cover_path), ''),
                          nullif(btrim(f.metadata #>> '{scan_cache,file_entry,cover_path}'), '')) as cover_path
                   from library.local_track_files f
                   join library.local_tracks t on t.id = f.track_id
                   join library.library_roots r on r.id = f.library_root_id
                   left join library.local_albums a on a.id = t.album_id and a.library_id = t.library_id
                   where t.library_id = %s and r.library_id = t.library_id
                     and r.is_active is true and f.scan_cache_stale is false and f.id = %s""",
                (library_id, file_id),
            ).fetchone()
            roots = [Path(root["root_path"]) for root in connection.execute(
                "select root_path from library.library_roots where library_id = %s and is_active is true",
                (library_id,),
            ).fetchall()]
        if row is None or not row["cover_path"]:
            raise PlaybackContractError(404)
        resolved = resolve_configured_media_path({}, row["cover_path"], configured_root_paths=roots)
        if resolved is None:
            raise PlaybackContractError(404)
        return Path(resolved)

    def _resume_file_id(self, actor, resume_token):
        account_id, library_id = playback_scope(actor)
        try:
            _, _, account, scope, file_id = self._verified(_RESUME_DOMAIN, resume_token, 5)
            if account != account_id or scope != library_id or file_id < 1:
                raise ValueError()
        except (ValueError, TypeError, UnicodeError):
            raise PlaybackContractError(403) from None
        return file_id

    def resolve(self, actor, playback_ref):
        """The media file a reference names, for decoding."""
        return self._resolve_file(actor, playback_ref)["media_path"]

    def resolve_library_path(self, actor, playback_ref):
        """The inventory path the browser names the same track by, so listen history is identical."""
        return self._resolve_file(actor, playback_ref)["private_path"]

    def _resolve_file(self, actor, playback_ref):
        _, library_id = playback_scope(actor)
        try:
            _, _, scope, file_id, expiry = self._verified(_REFERENCE_DOMAIN, playback_ref, 5)
            if scope != library_id or file_id < 1 or expiry <= self._clock().timestamp():
                raise ValueError()
        except (ValueError, TypeError, UnicodeError):
            raise PlaybackContractError(403) from None
        with self._connect(self._database_url) as connection:
            require_playback_membership(connection, actor)
            return self._file(connection, library_id, file_id=file_id)
