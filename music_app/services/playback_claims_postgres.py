"""One transactional, expiring playback owner per account and library."""

from datetime import datetime, timedelta, timezone
import json
from urllib.parse import urlsplit
from uuid import UUID

from music_app.services.auth_tokens import hash_opaque_token, issue_opaque_token
from music_app.services.playback_references import (
    PlaybackContractError, PlaybackReferenceService, require_playback_membership,
)
from music_app.services.postgres_connections import pooled_connection


def _client(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value.lower():
            raise ValueError()
        return value.lower()
    except (ValueError, TypeError, AttributeError):
        raise PlaybackContractError() from None


def _token(value):
    try:
        return hash_opaque_token(value)
    except (ValueError, TypeError):
        raise PlaybackContractError(403) from None


class PostgresPlaybackClaims:
    def __init__(self, config, *, clock=None, connect=None):
        self._config = config
        self._database_url = config.get("ALBUM_HAVEN_APP_DATABASE_URL")
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._connect = connect or pooled_connection

    def _track(self, actor, track):
        if not isinstance(track, dict) or set(track) != {"playbackRef", "title", "artist", "album", "artworkUrl"}:
            raise PlaybackContractError()
        for key in ("title", "artist", "album"):
            if not isinstance(track[key], str) or len(track[key]) > 512 or any(ord(c) < 32 for c in track[key]):
                raise PlaybackContractError()
        artwork = track["artworkUrl"]
        if artwork is not None:
            if not isinstance(artwork, str) or len(artwork) > 2048 or any(ord(c) < 33 for c in artwork) or "\\" in artwork:
                raise PlaybackContractError()
            try:
                parsed = urlsplit(artwork)
                origin = urlsplit(self._config.get("public_base_url") or "")
            except ValueError:
                raise PlaybackContractError() from None
            if parsed.fragment or parsed.username or parsed.password or (
                parsed.netloc and (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc)
            ) or (not parsed.netloc and (parsed.scheme or not artwork.startswith("/") or artwork.startswith("//"))):
                raise PlaybackContractError()
            # Raw cover paths are not portable native metadata.
            if parsed.query:
                raise PlaybackContractError()
        PlaybackReferenceService(self._config, clock=self._clock, connect=self._connect).resolve(actor, track["playbackRef"])
        return track

    @staticmethod
    def _state(row, client_id):
        here = row is not None and str(row["client_id"]) == client_id
        elsewhere = row is not None and not here
        return {"protocol": 1, "is_playing_here": here, "is_playing_elsewhere": elsewhere,
                "elsewhere_client_kind": row["client_surface"] if elsewhere else None,
                "status_label": "Playing elsewhere" if elsewhere else "Playing here" if here else "Ready to play",
                "can_start_here": not elsewhere,
                "expiresAt": row["expires_at"].isoformat() if row else None,
                "track": row["track"] if row else None}

    def get(self, actor, client_id):
        client_id = _client(client_id) if client_id else ""
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            row = connection.execute("""select client_id, client_surface, expires_at, track
                from app.playback_claims where account_id = %s and library_id = %s and expires_at > %s""",
                (account_id, library_id, self._clock())).fetchone()
        return self._state(row, client_id)

    def acquire(self, actor, *, client_id, client_surface, track, claim_token=None):
        client_id = _client(client_id)
        if client_surface not in {"private_web", "mobile"}:
            raise PlaybackContractError()
        track = self._track(actor, track)
        now = self._clock()
        expires = now + timedelta(seconds=30)
        issued = issue_opaque_token() if claim_token is None else None
        token = issued.raw if issued else claim_token
        digest = issued.digest if issued else _token(token)
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            if issued:
                row = connection.execute("""insert into app.playback_claims
                    (account_id, library_id, client_id, client_surface, token_digest, expires_at, track)
                    values (%s, %s, %s, %s, %s, %s, %s::jsonb)
                    on conflict (account_id, library_id) do update set
                      client_id = excluded.client_id, client_surface = excluded.client_surface,
                      token_digest = excluded.token_digest, expires_at = excluded.expires_at, track = excluded.track
                    where app.playback_claims.expires_at <= %s
                    returning client_id, client_surface, expires_at, track""",
                    (account_id, library_id, client_id, client_surface, digest, expires, json.dumps(track), now)).fetchone()
            else:
                row = connection.execute("""update app.playback_claims set expires_at = %s, track = %s::jsonb
                    where account_id = %s and library_id = %s and client_id = %s
                      and token_digest = %s and expires_at > %s
                    returning client_id, client_surface, expires_at, track""",
                    (expires, json.dumps(track), account_id, library_id, client_id, digest, now)).fetchone()
            if row is None:
                raise PlaybackContractError(409)
        return {"protocol": 1, "claimToken": token, "expiresAt": expires.isoformat(), "playbackState": self._state(row, client_id)}

    def release(self, actor, *, client_id, claim_token):
        client_id, digest = _client(client_id), _token(claim_token)
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            row = connection.execute("""select client_id, token_digest, expires_at from app.playback_claims
                where account_id = %s and library_id = %s for update""", (account_id, library_id)).fetchone()
            if row is None or row["expires_at"] <= self._clock():
                return
            if str(row["client_id"]) != client_id or bytes(row["token_digest"]) != digest:
                raise PlaybackContractError(403)
            connection.execute("delete from app.playback_claims where account_id = %s and library_id = %s", (account_id, library_id))

    def require_claim(self, actor, *, client_id, claim_token):
        digest = _token(claim_token)
        try:
            client_id = _client(client_id)
        except PlaybackContractError:
            raise PlaybackContractError(403) from None
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            row = connection.execute("""select client_id from app.playback_claims
                where account_id = %s and library_id = %s and client_id = %s
                and token_digest = %s and expires_at > %s""",
                (account_id, library_id, client_id, digest, self._clock())).fetchone()
            if row is None:
                raise PlaybackContractError(403)
