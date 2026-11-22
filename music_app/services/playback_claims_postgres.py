"""One transactional, expiring playback owner per account and library."""

from datetime import datetime, timedelta, timezone
import hmac
import json
from urllib.parse import urlsplit
from uuid import UUID

from music_app.services.auth_tokens import hash_opaque_token, issue_opaque_token
from music_app.services.playback_references import (
    PlaybackContractError, PlaybackReferenceService, require_playback_membership,
)
from music_app.services.postgres_connections import pooled_connection


_CLAIM_LEASE_SECONDS = 30
# A holder that has not renewed for this long is gone (a browser closed or crashed without a word): the
# first fresh claim replaces it, so a press elsewhere plays at once (sandbox5, 2026-11-21). Browsers
# renew every 4 s, the Android app every 10 s; each limit leaves room for a slow renewal.
_STALE_HOLDER_SECONDS = {"private_web": 10, "mobile": 16}
_HANDOFF_LEASE_SECONDS = 15


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


def _handoff(value):
    if not isinstance(value, dict) or set(value) != {"id", "token"}:
        raise PlaybackContractError()
    return _client(value["id"]), _token(value["token"])


def _position(value):
    """Where the claim's song is, as its client last heard it: {"ms", "durationMs"} or None."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"ms", "durationMs"} or any(
        type(value[key]) is not int for key in value
    ) or value["ms"] < 0 or value["durationMs"] < 1:
        raise PlaybackContractError()
    return {"ms": min(value["ms"], value["durationMs"]), "durationMs": value["durationMs"]}


def validate_taker(client_id, client_surface):
    """A confirmed Play here is checked whole before the playing client is asked to stop."""
    _client(client_id)
    if client_surface not in ("private_web", "mobile"):
        raise PlaybackContractError()


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

    def _state(self, row, client_id, path_for=None):
        here = row is not None and str(row["client_id"]) == client_id
        elsewhere = row is not None and not here
        stored, position = self._stored(row["track"]) if row else (None, None)
        state = {"protocol": 1, "is_playing_here": here, "is_playing_elsewhere": elsewhere,
                 "elsewhere_client_kind": row["client_surface"] if elsewhere else None,
                 "status_label": "Playing elsewhere" if elsewhere else "Playing here" if here else "Ready to play",
                 "can_start_here": not elsewhere,
                 "expiresAt": row["expires_at"].isoformat() if row else None,
                 "track": stored, "position": position}
        if elsewhere and path_for is not None:
            # The browser names a song by its library path, so a takeover can open it there.
            try:
                state["path"] = PlaybackReferenceService(self._config, clock=self._clock, connect=self._connect) \
                    .resolve_library_path(path_for, stored["playbackRef"])
            except PlaybackContractError:
                state["path"] = None
        return state

    def get(self, actor, client_id, *, include_path=False):
        """The claim as `client_id` sees it; `include_path` (browsers only) adds another client's song path."""
        client_id = _client(client_id) if client_id else ""
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            row = connection.execute("""select client_id, client_surface, expires_at, track
                from app.playback_claims where account_id = %s and library_id = %s and expires_at > %s""",
                (account_id, library_id, self._clock())).fetchone()
        return self._state(row, client_id, actor if include_path else None)

    def acquire(self, actor, *, client_id, client_surface, track, claim_token=None, handoff=None,
                takeover=False, position=None):
        client_id = _client(client_id)
        if not isinstance(client_surface, str) or client_surface not in {"private_web", "mobile"}:
            raise PlaybackContractError()
        if handoff is not None and client_surface != "private_web":
            raise PlaybackContractError()
        # playback.claim.takeover (owner, 2026-11-17): a fresh claim may replace another client's
        # live claim of the same account and library.
        if type(takeover) is not bool or (takeover and (claim_token is not None or handoff is not None)):
            raise PlaybackContractError()
        track = self._track(actor, track)
        now = self._clock()
        heard = _position(position)
        stored_track = {**track, "position": {**heard, "at": now.isoformat()}} if heard else track
        expires = now + timedelta(seconds=_CLAIM_LEASE_SECONDS)
        if handoff is not None and claim_token is None:
            raise PlaybackContractError()
        handoff_id, handoff_digest = _handoff(handoff) if handoff is not None else (None, None)
        issued = issue_opaque_token() if claim_token is None else None
        token = issued.raw if issued else claim_token
        digest = issued.digest if issued else _token(token)
        if handoff is not None and digest == handoff_digest:
            raise PlaybackContractError()
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            if handoff is not None:
                row = connection.execute("""update app.playback_claims set
                      client_id = %s, client_surface = %s, token_digest = %s,
                      expires_at = %s, track = %s::jsonb,
                      pending_handoff_id = null, pending_handoff_digest = null,
                      pending_completion_digest = null,
                      pending_handoff_expires_at = null
                    where account_id = %s and library_id = %s
                      and pending_handoff_id = %s and pending_handoff_digest = %s
                      and pending_handoff_expires_at > %s
                      and client_id <> %s and token_digest <> %s
                    returning client_id, client_surface, expires_at, track""",
                    (client_id, client_surface, digest, expires, json.dumps(stored_track),
                     account_id, library_id, handoff_id, handoff_digest, now,
                     client_id, digest)).fetchone()
                if row is None:
                    row = connection.execute("""update app.playback_claims set
                          expires_at = %s, track = %s::jsonb
                        where account_id = %s and library_id = %s and client_id = %s
                          and token_digest = %s and expires_at > %s
                          and pending_handoff_id is null
                          and pending_handoff_digest is null
                          and pending_completion_digest is null
                          and pending_handoff_expires_at is null
                        returning client_id, client_surface, expires_at, track""",
                        (expires, json.dumps(stored_track), account_id, library_id,
                         client_id, digest, now)).fetchone()
            elif issued:
                # A tab that closed (or reloaded) while playing staged a handoff on its way out: its
                # claim gives way to the first fresh claim, so one Play press elsewhere plays at once
                # (sandbox5, 2026-11-18: Play after closing a playing tab was refused for 15-30 s). A
                # reload that comes back first takes its handoff as before.
                row = connection.execute("""insert into app.playback_claims
                    (account_id, library_id, client_id, client_surface, token_digest, expires_at, track)
                    values (%s, %s, %s, %s, %s, %s, %s::jsonb)
                    on conflict (account_id, library_id) do update set
                      client_id = excluded.client_id, client_surface = excluded.client_surface,
                      token_digest = excluded.token_digest, expires_at = excluded.expires_at,
                      track = excluded.track, pending_handoff_id = null,
                      pending_handoff_digest = null, pending_completion_digest = null,
                      pending_handoff_expires_at = null
                    where %s or app.playback_claims.pending_handoff_id is not null
                      or app.playback_claims.expires_at <= %s
                      or (app.playback_claims.client_surface = 'private_web' and app.playback_claims.expires_at <= %s)
                      or (app.playback_claims.client_surface = 'mobile' and app.playback_claims.expires_at <= %s)
                    returning client_id, client_surface, expires_at, track""",
                    (account_id, library_id, client_id, client_surface, digest, expires,
                     json.dumps(stored_track), takeover, now,
                     now + timedelta(seconds=_CLAIM_LEASE_SECONDS - _STALE_HOLDER_SECONDS["private_web"]),
                     now + timedelta(seconds=_CLAIM_LEASE_SECONDS - _STALE_HOLDER_SECONDS["mobile"]))).fetchone()
            else:
                # The token renews its claim even past the lease, as for a client that played on
                # without a network: until another client's acquire replaces the row or its release
                # deletes it, nobody else has played since. The owner renewing (a page of the same
                # tab after a reload) is no longer leaving: a handoff it staged no longer applies.
                row = connection.execute("""update app.playback_claims set expires_at = %s, track = %s::jsonb,
                      pending_handoff_id = null, pending_handoff_digest = null,
                      pending_completion_digest = null, pending_handoff_expires_at = null
                    where account_id = %s and library_id = %s and client_id = %s and token_digest = %s
                    returning client_id, client_surface, expires_at, track""",
                    (expires, json.dumps(stored_track), account_id, library_id, client_id, digest)).fetchone()
            if row is None:
                raise PlaybackContractError(409)
        return {"protocol": 1, "claimToken": token, "expiresAt": expires.isoformat(),
                "leaseMs": _CLAIM_LEASE_SECONDS * 1000, "playbackState": self._state(row, client_id)}

    def stage_handoff(self, actor, *, client_id, claim_token, handoff_id,
                      handoff_token, completion_digest, persist_completion=None):
        client_id = _client(client_id)
        claim_digest = _token(claim_token)
        handoff_id = _client(handoff_id)
        handoff_digest = _token(handoff_token)
        if handoff_digest == claim_digest:
            raise PlaybackContractError()
        if not isinstance(completion_digest, bytes) or len(completion_digest) != 32:
            raise PlaybackContractError()
        now = self._clock()
        handoff_expires = now + timedelta(seconds=_HANDOFF_LEASE_SECONDS)
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            row = connection.execute("""select client_id, client_surface, token_digest, expires_at,
                    pending_handoff_id, pending_handoff_digest, pending_completion_digest,
                    pending_handoff_expires_at
                from app.playback_claims
                where account_id = %s and library_id = %s for update""",
                (account_id, library_id)).fetchone()
            if (row is None or str(row["client_id"]) != client_id
                    or row["client_surface"] != "private_web"
                    or bytes(row["token_digest"]) != claim_digest):
                raise PlaybackContractError(403)
            pending_live = (row["pending_handoff_expires_at"] is not None
                            and row["pending_handoff_expires_at"] > now)
            pending_matches = (pending_live
                               and str(row["pending_handoff_id"]) == handoff_id
                               and bytes(row["pending_handoff_digest"]) == handoff_digest
                               and bytes(row["pending_completion_digest"]) == completion_digest)
            if row["expires_at"] <= now and not pending_matches:
                raise PlaybackContractError(403)
            if pending_live and not pending_matches:
                raise PlaybackContractError(409)
            if persist_completion is not None:
                persist_completion(connection, account_id, library_id)
            if not pending_matches:
                connection.execute("""update app.playback_claims set
                        pending_handoff_id = %s, pending_handoff_digest = %s,
                        pending_completion_digest = %s, pending_handoff_expires_at = %s
                    where account_id = %s and library_id = %s""",
                    (handoff_id, handoff_digest, completion_digest, handoff_expires,
                     account_id, library_id))
            else:
                handoff_expires = row["pending_handoff_expires_at"]
            return {"protocol": 1, "staged": True,
                    "expiresAt": handoff_expires.astimezone(timezone.utc).isoformat()}

    def holder(self, actor):
        """Who a confirmed Play here asks; `client_id` is None when nobody holds a live claim."""
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            row = connection.execute("""select client_id, token_digest from app.playback_claims
                where account_id = %s and library_id = %s and expires_at > %s""",
                (account_id, library_id, self._clock())).fetchone()
        return {"account_id": account_id, "library_id": library_id,
                "client_id": str(row["client_id"]) if row else None,
                "digest": bytes(row["token_digest"]) if row else None}

    def holds(self, holder, token):
        try:
            return hmac.compare_digest(_token(token), holder["digest"])
        except PlaybackContractError:
            return False

    def hand_over(self, actor, *, client_id, client_surface, observed, answer):
        """Replaces the observed holder's claim with the taker's: at the holder's [answer] or, without
        one, at its saved place. It is one statement, only over the token that was observed, so no
        later save of the holder lands after it and a third client that claimed meanwhile keeps playback.
        """
        validate_taker(client_id, client_surface)
        client_id = _client(client_id)
        if client_id == observed["client_id"]:
            raise PlaybackContractError(409)
        track = position = None
        if answer is not None:
            try:
                track, position = self._track(actor, answer["track"]), _position(answer["position"])
            except PlaybackContractError:
                track = position = None
        confirmed = track is not None
        if not confirmed:
            with self._connect(self._database_url) as connection:
                account_id, library_id = require_playback_membership(connection, actor)
                row = connection.execute("""select track from app.playback_claims
                    where account_id = %s and library_id = %s and token_digest = %s""",
                    (account_id, library_id, observed["digest"])).fetchone()
            if row is None:
                raise PlaybackContractError(409)
            track, position = self._stored(row["track"])
        try:
            # The browser opens a song by its library path, as today's takeover read gives it.
            path = PlaybackReferenceService(self._config, clock=self._clock, connect=self._connect) \
                .resolve_library_path(actor, track["playbackRef"])
        except PlaybackContractError:
            # Nothing is taken over for a song this client cannot open.
            raise PlaybackContractError(422) from None
        with self._connect(self._database_url) as connection:
            account_id, library_id = require_playback_membership(connection, actor)
            now = self._clock()
            stored = {**track, "position": {**position, "at": now.isoformat()}} if position else track
            expires = now + timedelta(seconds=_CLAIM_LEASE_SECONDS)
            issued = issue_opaque_token()
            row = connection.execute("""insert into app.playback_claims
                (account_id, library_id, client_id, client_surface, token_digest, expires_at, track)
                values (%s, %s, %s, %s, %s, %s, %s::jsonb)
                on conflict (account_id, library_id) do update set
                  client_id = excluded.client_id, client_surface = excluded.client_surface,
                  token_digest = excluded.token_digest, expires_at = excluded.expires_at,
                  track = excluded.track, pending_handoff_id = null,
                  pending_handoff_digest = null, pending_completion_digest = null,
                  pending_handoff_expires_at = null
                where app.playback_claims.token_digest = %s
                returning client_id""",
                (account_id, library_id, client_id, client_surface, issued.digest, expires,
                 json.dumps(stored), observed["digest"])).fetchone()
            if row is None:
                raise PlaybackContractError(409)
        return {"protocol": 1, "claimToken": issued.raw, "expiresAt": expires.isoformat(),
                "leaseMs": _CLAIM_LEASE_SECONDS * 1000, "confirmed": confirmed,
                "track": track, "position": position, "path": path}

    def _stored(self, stored):
        """A claim's track and where it has played to since its client last said."""
        track = dict(stored)
        heard = track.pop("position", None)
        if not heard:
            return track, None
        played = int((self._clock() - datetime.fromisoformat(heard["at"])).total_seconds() * 1000)
        return track, {"ms": min(heard["ms"] + max(0, played), heard["durationMs"]),
                       "durationMs": heard["durationMs"]}

    def release(self, actor, *, client_id, claim_token):
        """The claim given back, for a Play here pressed on it moments later; None when none was held."""
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
        return {"account_id": account_id, "library_id": library_id, "client_id": client_id, "digest": digest}

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
