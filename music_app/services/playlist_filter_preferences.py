"""Seven-day applied Playlist filters under existing preference/source authority."""
from contextlib import contextmanager
from datetime import timedelta
import json
import math

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session

from music_app.services.owned_playlists import BROWSE, PlaylistCommand, PlaylistError, uuid_ref, playlist_revision
from music_app.services.playlist_preferences_postgres import (
    PREFERENCE_READ, PREFERENCE_WRITE, PostgresPlaylistPreferencesService,
)

DEFAULT_FILTERS = dict(query="", availability="all", love="all", style="",
    minDuration=None, maxDuration=None, minDurationExclusive=False,
    maxDurationExclusive=False, addedWithinDays=None, frequency="all",
    frequencyMode="only", includeUnknown=True)
JS_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def applied_filters(value):
    # Accept the existing normalized applied contract only, never arbitrary
    # display metadata, invalid drafts, disclosure state or executable predicates.
    if not isinstance(value, dict) or set(value) != set(DEFAULT_FILTERS):
        raise PlaylistError("invalid_command")
    result = dict(value)
    for name, limit in (("query", 200), ("style", 100)):
        item = result[name]
        if not isinstance(item, str) or any(ord(c) < 32 or ord(c) == 127 for c in item):
            raise PlaylistError("invalid_command")
        try:
            units = len(item.encode("utf-16-le")) // 2
        except UnicodeEncodeError:
            raise PlaylistError("invalid_command") from None
        if units > limit:
            raise PlaylistError("invalid_command")
    if result["style"] != result["style"].strip(JS_TRIM):
        raise PlaylistError("invalid_command")
    for name, choices in (("availability", ("all", "local", "missing", "unresolved")),
            ("love", ("all", "loved", "obsessed")),
            ("frequency", ("all", "frequent", "mid", "barely", "forgotten")),
            ("frequencyMode", ("only", "exclude"))):
        if result[name] not in choices:
            raise PlaylistError("invalid_command")
    for name in ("minDurationExclusive", "maxDurationExclusive", "includeUnknown"):
        if type(result[name]) is not bool:
            raise PlaylistError("invalid_command")
    for name in ("minDuration", "maxDuration"):
        item = result[name]
        if item is not None:
            try:
                valid = type(item) in (int, float) and math.isfinite(item) and item >= 0
            except (OverflowError, ValueError):
                valid = False
            if not valid:
                raise PlaylistError("invalid_command")
        if item is None and result[name + "Exclusive"]:
            raise PlaylistError("invalid_command")
    low, high = result["minDuration"], result["maxDuration"]
    if low is not None and high is not None and low > high:
        raise PlaylistError("invalid_command")
    days = result["addedWithinDays"]
    if days is not None and (type(days) is not int or days not in (1, 7, 30, 90)):
        raise PlaylistError("invalid_command")
    if result["frequency"] == "all" and result["frequencyMode"] != "only":
        raise PlaylistError("invalid_command")
    return result


def filter_command(playlist_ref, payload):
    if not isinstance(payload, dict) or set(payload) != {"revision", "request_key", "filters"}:
        raise PlaylistError("invalid_command")
    filters = None if payload["filters"] is None else applied_filters(payload["filters"])
    # Explicit Reset and the exact default applied state both clear retention.
    if filters == DEFAULT_FILTERS:
        filters = None
    return PlaylistCommand("playlist_filter_preferences", uuid_ref(playlist_ref),
        uuid_ref(payload["request_key"]), {"revision": playlist_revision(payload["revision"]), "filters": filters})


class PlaylistFilterPreferences:
    def __init__(self, playlist_owner):
        self.owner = playlist_owner

    @contextmanager
    def _authorized(self, context, playlist_ref, action, constraints):
        ref = uuid_ref(playlist_ref)
        # Existing current-library owner locks account/session/library before
        # Playlist parent. No nested connection or inverse preference lock order.
        with self.owner._authorized(context, constraints) as (connection, live, _):
            self._require(live, action, constraints)
            playlist = self.owner._playlist(connection, live, ref)
            self.owner._require(live, (BROWSE,), constraints, playlist)
            yield connection, live, playlist
            self.owner._require(live, (BROWSE,), constraints, playlist)
            self._require(live, action, constraints)
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self.owner._clock)

    @staticmethod
    def _require(context, action, constraints):
        PostgresPlaylistPreferencesService._require(context, action, constraints)

    @staticmethod
    def _row(connection, live, ref):
        return connection.execute("""select filters,expires_at,revision
            from app.user_playlist_filter_preferences
            where account_id=%s and library_id=%s and playlist_ref=%s""",
            (live.actor.account_id, live.library_id, ref)).fetchone()

    def read(self, context, playlist_ref, *, constraints=None):
        with self._authorized(context, playlist_ref, PREFERENCE_READ, constraints) as (con, live, playlist):
            row = self._row(con, live, playlist["ref"])
            self.owner._require(live, (BROWSE,), constraints, playlist)
            self._require(live, PREFERENCE_READ, constraints)
        # Projection follows the final source/session fence, including any wait
        # it incurred. Returning expired values after that fence is forbidden.
        # Reads never renew lifetime or change optimistic revision.
        server_time = self.owner._clock()
        active = row and row["expires_at"] is not None and row["expires_at"] > server_time
        return {"playlist_ref": str(playlist["ref"]), "revision": str(row["revision"]) if row else "1",
            "server_time": server_time.isoformat(),
            "filters": dict(row["filters"]) if active else None,
            "expires_at": row["expires_at"].isoformat() if active else None}

    def execute(self, context, command, *, constraints=None):
        if not isinstance(command, PlaylistCommand) or command.action != "playlist_filter_preferences" or not isinstance(command.data, dict):
            raise PlaylistError("invalid_command")
        command = filter_command(command.playlist_ref, {**command.data, "request_key": command.request_key})
        with self._authorized(context, command.playlist_ref, PREFERENCE_WRITE, constraints) as (con, live, playlist):
            account = live.actor.account_id
            prior = con.execute("""select original_session_id,command_digest,receipt
                from app.playlist_preference_operations where account_id=%s and request_key=%s""",
                (account, command.request_key)).fetchone()
            if prior:
                if prior["original_session_id"] != live.actor.session_id:
                    raise PlaylistError("operation_unavailable", 404)
                if prior["command_digest"] != command.digest:
                    raise PlaylistError("idempotency_key_reused", 409)
                return dict(prior["receipt"])
            row = self._row(con, live, command.playlist_ref)
            revision = row["revision"] if row else 1
            if command.data["revision"] != str(revision):
                raise PlaylistError("revision_conflict", 409)
            now = self.owner._clock()
            previous = row["filters"] if row and row["expires_at"] and row["expires_at"] > now else None
            filters = command.data["filters"]
            # Same-value retries/no-ops do not extend retention. Reset clears
            # even expired physical state, retaining a revision tombstone.
            # Reset advances the tombstone even if already empty: an older
            # revision-1 write must not resurrect filters after a fresh reset.
            changed = previous != filters or filters is None
            expiry = now + timedelta(days=7) if changed and filters is not None else row["expires_at"] if row else None
            if filters is None:
                expiry = None
            revision += int(changed)
            playlist_revision(str(revision))
            if changed:
                con.execute("""insert into app.user_playlist_filter_preferences
                    (account_id,library_id,playlist_ref,filters,expires_at,revision)
                    values (%s,%s,%s,%s::jsonb,%s,%s)
                    on conflict(account_id,library_id,playlist_ref) do update
                    set filters=excluded.filters,expires_at=excluded.expires_at,revision=excluded.revision""",
                    (account, live.library_id, command.playlist_ref,
                     json.dumps(filters) if filters is not None else None, expiry, revision))
            # Receipt stores no filter values, so recovery cannot disclose an
            # expired or superseded filter. The caller reloads current state.
            receipt = {"ok": True, "action": command.action, "request_key": command.request_key,
                "playlist_ref": command.playlist_ref, "revision": str(revision), "changed": changed}
            con.execute("""insert into app.playlist_preference_operations
                (account_id,request_key,original_session_id,command_digest,receipt)
                values (%s,%s,%s,%s,%s::jsonb)""",
                (account, command.request_key, live.actor.session_id, command.digest, json.dumps(receipt)))
            return receipt
