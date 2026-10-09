"""Postgres-owned disposable Home receipts with bounded page validation."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re
import secrets

from music_app.services.allowed_actions import AllowedActions
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator
from music_app.services.auth_tokens import issue_opaque_token, hash_opaque_token
from music_app.services.home_activity import (
    ActivityQuery, ActivityScope, ComparisonQuery, HomeActivityError,
    PAGE_SIZE, resolve_activity_window,
)
from music_app.services.lastfm import get_lastfm_user_timezone
from music_app.services.listen_history_postgres import LASTFM_SCROBBLE_SOURCE_FAMILIES
from music_app.services.postgres_connections import pooled_connection

CHUNK_SIZE = 1000
MAX_ACTOR_RECEIPTS = 20
MAX_SESSION_RECEIPTS = 10
MAX_QUERY_RECEIPTS = 2
EXPIRED_CLEANUP_BATCH = 100
SNAPSHOT_LIFETIME = timedelta(hours=1)
MAX_SELECTION_ROWS = 5000


def _expired():
    return HomeActivityError("Activity changed or expired. Refresh the activity.", 410, "activity_snapshot_expired")


@contextmanager
def _capture_lock(connection, scope, *, enabled):
    if not enabled:
        yield
        return
    keys = [f"home-activity:{account}" for account in sorted({scope.account_id, scope.source_account_id})]
    attempted = []
    try:
        # Acquire outside the capture transaction. Otherwise a waiter could
        # retain an RR snapshot predating the previous creator's committed caps.
        for key in keys:
            attempted.append(key)
            connection.execute("select pg_advisory_lock(hashtextextended(%s,0))", (key,))
        connection.commit()
        yield
    finally:
        # Explicit rollback also recovers a failed/aborted capture before the
        # session lock is released. The pool never receives an owned lock.
        try:
            connection.rollback()
            for key in reversed(attempted):
                connection.execute("select pg_advisory_unlock(hashtextextended(%s,0))", (key,))
            connection.commit()
        except BaseException:
            # Uncertain cleanup must retire the physical connection rather
            # than hand a possibly locked session back to another request.
            connection.close()
            raise


_LEDGER_READ = """
select h.id, h.account_id, h.library_id, h.track_id, h.track_key,
       h.played_at, h.source_family, h.measurement_version, h.finalized,
       h.measured_listened_seconds, h.metadata,
       t.id as resolved_track_id, t.track_key as resolved_track_key,
       t.title as resolved_track_title,
       ar.id as resolved_track_artist_id, ar.name as resolved_track_artist_name,
       a.id as resolved_album_id, a.album_key as resolved_album_key,
       a.title as resolved_album_title,
       aa.id as resolved_album_artist_id, aa.name as resolved_album_artist_name,
       t.duration_seconds::double precision as resolved_duration_seconds,
       exists(select 1 from library.local_track_files f
              where f.track_id=t.id and f.scan_cache_stale is false) as active_file,
       (h.track_id is not null and t.id is null) as identity_conflict
from integration.listen_history h
left join lateral (
  select min(candidate.id) as id, count(*) as matches from (
    select matched_track.id from library.local_tracks matched_track
    where h.track_id is null and h.measurement_version is null
      and matched_track.library_id=h.library_id
      and matched_track.track_key = any(array[h.track_key,
        h.metadata->'source_payload'->>'track_ref',h.metadata->'source_payload'->>'path'])
    union
    select matched_file.track_id from library.local_track_files matched_file
    join library.local_tracks file_track on file_track.id=matched_file.track_id
    where h.track_id is null and h.measurement_version is null
      and file_track.library_id=h.library_id and matched_file.scan_cache_stale is false
      and matched_file.private_path = any(array[h.track_key,
        h.metadata->'source_payload'->>'track_ref',h.metadata->'source_payload'->>'path'])
  ) candidate
) matched on true
left join library.local_tracks t on t.id=coalesce(h.track_id,case when matched.matches=1 then matched.id end)
  and t.library_id=h.library_id
left join library.local_albums a on a.id=t.album_id and a.library_id=h.library_id
left join library.local_artists ar on ar.id=t.artist_id and ar.library_id=h.library_id
left join library.local_artists aa on aa.id=a.artist_id and aa.library_id=h.library_id
where h.account_id=%s and h.library_id=%s and h.source_family=any(%s)
  and (%s::timestamptz is null or h.played_at >= %s::timestamptz)
  and h.played_at < %s
  and (%s::timestamptz is null or (h.played_at,h.id)>(%s::timestamptz,%s))
order by h.played_at,h.id limit %s
"""


class HomeActivityPostgresRepository:
    def __init__(self, config, *, connect=None):
        self.config = config
        self.url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self.connect = connect

    def _connection(self):
        if not self.url:
            raise HomeActivityError("Activity persistence is unavailable.", 503, "activity_unavailable")
        return self.connect(self.url) if self.connect else pooled_connection(self.url, workload="browse")

    @staticmethod
    def _authority(connection, scope, now):
        row = connection.execute("""
            select a.id, a.is_active, a.disabled_at, m.membership_role,
              exists(select 1 from app.bootstrap_owners b where b.account_id=a.id
                     and b.owner_key='local-bootstrap-owner') as bootstrap,
              coalesce((select jsonb_agg(jsonb_build_array(c.capability_key,c.scope_kind,c.scope_id)
                        order by c.capability_key,c.scope_kind,c.scope_id)
                        from app.capabilities c where c.account_id=a.id and c.revoked_at is null),
                       '[]'::jsonb) as grants
            from app.accounts a
            join app.account_sessions s on s.account_id=a.id and s.id=%s
            join library.library_memberships m on m.account_id=a.id and m.library_id=%s
            where a.id=%s and a.is_active and a.disabled_at is null and s.revoked_at is null
              and s.idle_expires_at>greatest(%s,clock_timestamp())
              and s.absolute_expires_at>greatest(%s,clock_timestamp())
        """, (scope.session_id, scope.library_id, scope.account_id, now, now)).fetchone()
        if row is None:
            raise HomeActivityError("Action not permitted.", 403, "activity_denied")
        fresh = CurrentActor(
            state=ActorState.ACTIVE, account_id=scope.account_id, session_id=scope.session_id,
            current_library_id=scope.library_id, is_bootstrap_owner=row["bootstrap"],
            library_relationships=(LibraryRelationship(scope.library_id, row["membership_role"], False),),
            capability_grants=tuple(CapabilityGrant(*grant) for grant in row["grants"]),
        )
        # Durable grant admission supplements, never replaces, the actual
        # request's deployment/client/origin/resource policy callback.
        context = PolicyContext.build(actor=fresh, action=scope.read_action,
            library_id=scope.library_id, deployment_mode="self_hosted",
            target_account_id=scope.subject_account_id,
            request_origin=RequestOrigin("internal", "home_activity"), client_surface_class="private_web")
        if not PolicyEvaluator().evaluate(context).decision.allowed:
            raise HomeActivityError("Action not permitted.", 403, "activity_denied")
        return hashlib.sha256(json.dumps(dict(row), sort_keys=True, default=str).encode()).hexdigest()

    @staticmethod
    def _revisions(connection, scope, *, lock=False):
        accounts = sorted({scope.source_account_id, scope.account_id} if scope.audience == "comparison" else {scope.source_account_id})
        if lock:
            rows = []
            for account in accounts:
                rows.extend(connection.execute("select * from app.lock_home_activity_revisions(%s,%s)",
                                               (scope.library_id, account)).fetchall())
        else:
            rows = connection.execute("""select account_id,revision from app.activity_source_revisions
                where library_id=%s and account_id=any(%s) order by account_id""",
                (scope.library_id, [0, *accounts])).fetchall()
        values = {row["account_id"]: row["revision"] for row in rows}
        if len(values) != 1 + len(accounts):
            raise _expired()
        result = (values[scope.source_account_id], values[0])
        return (*result, values[scope.account_id]) if scope.audience == "comparison" else result

    @staticmethod
    @contextmanager
    def _friend_authority(connection, scope):
        if scope.audience == "own":
            yield None
            return
        from music_app.services.friends_postgres import authorized_friend_read, FriendScopeError
        try:
            with authorized_friend_read(connection, account_id=scope.account_id,
                    library_id=scope.library_id, target_account_id=scope.source_account_id) as profile:
                facts = connection.execute("""select a.id,a.is_active,a.disabled_at,m.membership_role,
                    (select jsonb_agg(jsonb_build_array(c.id,c.capability_key,c.scope_kind,c.scope_id)
                       order by c.id) from app.capabilities c where c.account_id=a.id
                       and c.capability_key='capability.social' and c.revoked_at is null
                       and ((c.scope_kind='library' and c.scope_id=m.library_id)
                         or (c.scope_kind='global' and c.scope_id is null))) as social_grants
                    from app.accounts a join library.library_memberships m on m.account_id=a.id
                    where a.id=%s and m.library_id=%s""",
                    (scope.source_account_id, scope.library_id)).fetchone()
                if facts is None or not facts["social_grants"]:
                    raise HomeActivityError("Action not permitted.", 403, "activity_denied")
                yield {"profile": profile, "fingerprint": hashlib.sha256(
                    json.dumps(dict(facts), sort_keys=True, default=str).encode()).hexdigest()}
        except FriendScopeError:
            raise HomeActivityError("Action not permitted.", 403, "activity_denied") from None

    @contextmanager
    def _validated_snapshot(self, connection, scope, query, now, project):
        with self._friend_authority(connection, scope) as friend:
            authority = self._authority(connection, scope, now)
            if query.snapshot_ref:
                snapshot = connection.execute("""select * from app.activity_snapshots
                    where token_digest=%s and account_id=%s and session_id=%s and library_id=%s
                      and subject_account_id=%s and audience=%s
                      and kind=%s and period=%s and ready and expires_at>%s
                    for share nowait""",
                    (hash_opaque_token(query.snapshot_ref), scope.account_id, scope.session_id,
                     scope.library_id, scope.source_account_id, scope.audience,
                     query.kind, query.period, now)).fetchone()
                if snapshot is None:
                    raise _expired()
                token = query.snapshot_ref
            else:
                token, snapshot = self._create(connection, scope, query, now, authority, project, friend)
            revisions = self._revisions(connection, scope, lock=True)
            expected_revisions = (snapshot["ledger_revision"], snapshot["inventory_revision"])
            if scope.audience == "comparison":
                expected_revisions += (snapshot["viewer_ledger_revision"],)
            if snapshot["authority_fingerprint"] != authority or revisions != expected_revisions:
                raise _expired()
            if friend and (snapshot["relationship_revision"] != friend["profile"]["relationship_revision"]
                    or snapshot["subject_authority_fingerprint"] != friend["fingerprint"]):
                raise _expired()
            self._validate_policy(connection, snapshot, project)
            checked_at = self._lock_authority(connection, scope)
            # A selection consumer may own a Read Committed transaction. Its
            # earlier authority read can precede a committed revocation; row
            # locks alone would not reject that newer version at RC.
            if self._authority(connection, scope, now) != authority:
                raise _expired()
            if snapshot["expires_at"] <= checked_at:
                raise _expired()
            yield snapshot, token, friend

    def read(self, *, scope, query, now, build_projection):
        if (not isinstance(scope, ActivityScope) or not isinstance(query, ActivityQuery)
                or isinstance(query, ComparisonQuery) != (scope.audience == "comparison")):
            raise HomeActivityError()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise HomeActivityError()
        now = now.astimezone(timezone.utc)
        # Only serialization/deadlock failures before publication are retried.
        # Rollback happens at the connection context before the next attempt.
        for attempt in range(2):
            try:
                with self._connection() as connection:
                    with _capture_lock(connection, scope, enabled=query.snapshot_ref is None):
                        connection.execute("set transaction isolation level repeatable read")
                        with self._validated_snapshot(connection, scope, query, now, build_projection) as (snapshot, token, friend):
                            response = self._page(connection, snapshot, token, query)
                            if friend:
                                response["account_ref"] = friend["profile"]["account_ref"]
                        connection.commit()
                        return response
            except Exception as error:
                if getattr(error, "sqlstate", None) == "55P03":
                    raise HomeActivityError("Activity is changing. Try the read again.", 503, "activity_busy") from error
                if getattr(error, "sqlstate", None) not in {"40001", "40P01"}:
                    raise
                if attempt == 1:
                    raise HomeActivityError("Activity is changing. Try the read again.", 503, "activity_busy") from error
        raise AssertionError("Unreachable activity retry state")

    def read_selection(self, connection, *, scope, query, row_refs, allowed_actions_for_resource, now=None):
        return self._read_selection(connection,scope=scope,query=query,row_refs=row_refs,
            allowed_actions_for_resource=allowed_actions_for_resource,now=now,
            kinds={"tracks","listens"},audiences={"own","friend"})

    def read_native_selection(self, connection, *, scope, query, row_refs, allowed_actions_for_resource, now=None):
        return self._read_selection(connection,scope=scope,query=query,row_refs=row_refs,
            allowed_actions_for_resource=allowed_actions_for_resource,now=now,
            kinds={"tracks","listens","albums","artists"},audiences={"own","friend","comparison"})

    def _read_selection(self, connection, *, scope, query, row_refs, allowed_actions_for_resource,
                        now, kinds, audiences):
        """Export selected track metadata on the caller's still-open transaction.

        Internal canonical IDs are provenance, never media/playback authority.
        The caller owns commit/rollback and may persist only authorized fields.
        Read Committed and Repeatable Read both retain receipt/revision/current
        authority locks until that commit. This method never changes isolation.
        """
        if (not isinstance(scope, ActivityScope) or type(query) not in {ActivityQuery,ComparisonQuery}
                or isinstance(query,ComparisonQuery)!=(scope.audience=="comparison")
                or not query.snapshot_ref or query.cursor is not None or query.page is not None
                or query.kind not in kinds
                or scope.audience not in audiences
                or not isinstance(row_refs, (list, tuple)) or not 1 <= len(row_refs) <= MAX_SELECTION_ROWS
                or any(not isinstance(ref, str) or not re.fullmatch(r"activity_[a-f0-9]{64}", ref) for ref in row_refs)
                or len(set(row_refs)) != len(row_refs) or not callable(allowed_actions_for_resource)):
            raise HomeActivityError()
        from psycopg.pq import TransactionStatus
        if connection.info.transaction_status != TransactionStatus.INTRANS:
            raise HomeActivityError("An active caller transaction is required.", 503, "activity_transaction_required")
        reference = datetime.now(timezone.utc) if now is None else now
        if not isinstance(reference, datetime) or reference.tzinfo is None or reference.utcoffset() is None:
            raise HomeActivityError()

        def policy_only(*_args):
            raise AssertionError("Selection export must not construct a new receipt")

        policy_only.policy = allowed_actions_for_resource
        policy_only.read_action = scope.read_action
        policy_only.scope_wide_policy = getattr(allowed_actions_for_resource, "scope_wide", False) is True
        with self._validated_snapshot(connection, scope, query, reference, policy_only) as (snapshot, _token, _friend):
            stored = connection.execute("""select row_key,payload from app.activity_snapshot_rows
                where snapshot_id=%s and ordinal is not null and payload->>'id'=any(%s)""", (snapshot["id"], list(row_refs))).fetchall()
            by_ref = {row["payload"]["id"]: row for row in stored}
            if set(by_ref) != set(row_refs):
                raise HomeActivityError("Selection is outside the activity receipt.", 403, "activity_denied")
            listen_events = {row["row_key"]: int(row["row_key"].split(":")[2]) for row in stored
                             if re.fullmatch(r"listen:event:[1-9][0-9]*", row["row_key"])}
            provenance = {}
            if listen_events:
                provenance = {row["row_key"]: row["resources"] for row in connection.execute(
                    """select row_key,resources from app.activity_snapshot_events
                       where snapshot_id=%s and event_id=any(%s)""",
                    (snapshot["id"], list(listen_events.values()))).fetchall()}
            result = []
            for ref in row_refs:
                stored_row = by_ref[ref]
                parts = stored_row["row_key"].split(":")
                canonical = None
                if len(parts) == 2 and parts[0] in {"track", "album", "artist"}:
                    canonical = {"kind": parts[0], "id": int(parts[1])}
                elif len(parts) == 3 and parts[:2] == ["listen", "event"]:
                    track = next((resource_id for kind, resource_id in provenance.get(stored_row["row_key"], [])
                                  if kind == "track"), None)
                    canonical = {"kind": "track", "id": track} if track is not None else None
                facts = {key: stored_row["payload"].get(key) for key in
                         ("kind", "title", "artist", "album_title", "duration_seconds", "source_label", "availability")}
                result.append({"row_ref": ref, "facts": facts, "canonical_resource": canonical,
                    "lineage": {"snapshot_id": snapshot["id"], "viewer_account_id": scope.account_id,
                        "subject_account_id": scope.source_account_id, "library_id": scope.library_id,
                        "audience": scope.audience, "kind": query.kind, "period": query.period,
                        "row_key": stored_row["row_key"], "relationship_revision": snapshot["relationship_revision"]}})
            return result

    def _create(self, connection, scope, query, now, authority, build_projection, friend=None):
        from psycopg.types.json import Jsonb
        # Cleanup never visits another account and is bounded by receipt count.
        connection.execute("""delete from app.activity_snapshots where id in (
            select id from app.activity_snapshots where account_id=%s and expires_at<=%s
            order by expires_at,id limit %s)""", (scope.account_id, now, EXPIRED_CLEANUP_BATCH))
        accounts = {0, scope.source_account_id}
        if scope.audience == "comparison":
            accounts.add(scope.account_id)
        for account in sorted(accounts):
            connection.execute("""insert into app.activity_source_revisions(library_id,account_id)
                values(%s,%s) on conflict do nothing""", (scope.library_id, account))
        revisions = self._revisions(connection, scope)
        ledger_revision, inventory_revision = revisions[:2]
        window = resolve_activity_window(query.period, now=now,
            timezone_name=get_lastfm_user_timezone(self.config, account_id=scope.account_id))
        issued, secret = issue_opaque_token(), secrets.token_bytes(32)
        snapshot = connection.execute("""insert into app.activity_snapshots(
            token_digest,row_secret,account_id,session_id,library_id,kind,period,
            window_start,window_end,timezone,period_label,range_label,
            ledger_revision,inventory_revision,authority_fingerprint,qualification_version,
            created_at,expires_at,subject_account_id,audience,relationship_revision,subject_authority_fingerprint,viewer_ledger_revision)
            values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'meaningful-v1',%s,%s,%s,%s,%s,%s,%s)
            returning *""", (issued.digest, secret, scope.account_id, scope.session_id,
            scope.library_id, query.kind, query.period, window.start, window.end, window.timezone,
            window.period_label, window.range_label, ledger_revision, inventory_revision,
            authority, now, now + SNAPSHOT_LIFETIME, scope.source_account_id, scope.audience,
            friend["profile"]["relationship_revision"] if friend else None,
            friend["fingerprint"] if friend else None, revisions[2] if scope.audience == "comparison" else None)).fetchone()
        snapshot_id = snapshot["id"]
        total_listens = 0
        coverage = build_projection([], window, secret).coverage
        families = set()
        sources = [("yours", scope.account_id), ("friend", scope.source_account_id)] if scope.audience == "comparison" else [(None, scope.source_account_id)]
        for side, account in sources:
            after_time, after_id, side_total = None, 0, 0
            while True:
                records = connection.execute(_LEDGER_READ, (
                    account, scope.library_id, list(LASTFM_SCROBBLE_SOURCE_FAMILIES),
                    window.start, window.start, window.end, after_time, after_time, after_id, CHUNK_SIZE,
                )).fetchall()
                if not records:
                    break
                projection = build_projection([dict(row) for row in records], window, secret, account)
                side_total += projection.total_listens
                families.update(projection.coverage["source_families"])
                for name, operation in (("observed_start", min), ("observed_end", max)):
                    candidate = projection.coverage[name]
                    if candidate:
                        coverage[name] = operation(coverage[name], candidate) if coverage[name] else candidate
                self._store_projection(connection, snapshot_id, projection, side)
                after_time, after_id = records[-1]["played_at"], records[-1]["id"]
            total_listens += side_total
            if side:
                coverage.setdefault("side_total_listens", {})[side] = side_total
        coverage["source_families"] = sorted(families)
        if scope.audience == "comparison":
            from music_app.services.home_activity_comparison_postgres import finalize_comparison
            finalize_comparison(connection, snapshot_id=snapshot_id, scope=scope, query=query,
                                project=build_projection, secret=secret, window=window)
            coverage["taste_freshness"] = "Preferences are frozen at capture; refresh to read later edits."
        connection.execute("""with numbered as (
            select row_key,row_number() over(order by latest_at desc,latest_event_id desc,row_key desc) as ordinal
            from app.activity_snapshot_rows where snapshot_id=%s)
            update app.activity_snapshot_rows r set ordinal=n.ordinal,
              payload=case when %s then r.payload else jsonb_set(jsonb_set(r.payload,'{listen_count}',to_jsonb(r.listen_count)),
                '{source_label}',to_jsonb(array_to_string(array(select unnest(r.source_labels) order by 1),' / '))) end
            from numbered n where r.snapshot_id=%s and r.row_key=n.row_key""", (snapshot_id, scope.audience == "comparison", snapshot_id))
        # Lock revisions only after construction. Repeatable Read detects a
        # concurrent update since capture as a serialization failure here.
        if self._revisions(connection, scope, lock=True) != revisions:
            raise _expired()
        snapshot = connection.execute("""update app.activity_snapshots set ready=true,total_listens=%s,
            total_rows=(select count(*) from app.activity_snapshot_rows where snapshot_id=%s),coverage=%s
            where id=%s returning *""", (total_listens, snapshot_id, Jsonb(coverage), snapshot_id)).fetchone()
        self._cap_receipts(connection, scope, query, now)
        return issued.raw, snapshot

    @staticmethod
    def _store_projection(connection, snapshot_id, projection, side):
        from psycopg.types.json import Jsonb
        with connection.cursor() as cursor:
            cursor.executemany("""insert into app.activity_snapshot_events(snapshot_id,event_id,row_key,resources)
                values(%s,%s,%s,%s)""", [(snapshot_id, event["event_id"], event["group_key"], Jsonb(event["resources"]))
                for event in projection.events])
            cursor.executemany("""insert into app.activity_snapshot_rows(
                snapshot_id,row_key,latest_at,latest_event_id,listen_count,source_labels,payload)
                values(%s,%s,%s,%s,%s,%s,%s)
                on conflict(snapshot_id,row_key) do update set
                  listen_count=app.activity_snapshot_rows.listen_count+excluded.listen_count,
                  source_labels=array(select distinct unnest(app.activity_snapshot_rows.source_labels||excluded.source_labels)),
                  payload=case when (excluded.latest_at,excluded.latest_event_id)>
                                     (app.activity_snapshot_rows.latest_at,app.activity_snapshot_rows.latest_event_id)
                               then excluded.payload else app.activity_snapshot_rows.payload end,
                  latest_event_id=case when (excluded.latest_at,excluded.latest_event_id)>
                                           (app.activity_snapshot_rows.latest_at,app.activity_snapshot_rows.latest_event_id)
                                     then excluded.latest_event_id else app.activity_snapshot_rows.latest_event_id end,
                  latest_at=greatest(app.activity_snapshot_rows.latest_at,excluded.latest_at)
                """, [(snapshot_id, f"{side}/{key}" if side else key, group["latest"], group["latest_id"],
                       group["row"]["listen_count"], sorted(group["sources"]), Jsonb(group["row"]))
                      for key, group in projection.groups.items()])

    @staticmethod
    def _lock_authority(connection, scope):
        connection.execute("select id from app.accounts where id=%s for share nowait", (scope.account_id,)).fetchone()
        connection.execute("select id from app.bootstrap_owners where account_id=%s for share nowait",
                           (scope.account_id,)).fetchone()
        session = connection.execute("""select clock_timestamp() as checked_at,
            revoked_at is null and idle_expires_at>clock_timestamp()
              and absolute_expires_at>clock_timestamp() as usable
            from app.account_sessions where id=%s and account_id=%s for share nowait""",
            (scope.session_id, scope.account_id)).fetchone()
        if session is None or session["usable"] is not True:
            raise HomeActivityError("Action not permitted.", 403, "activity_denied")
        connection.execute("""select id from library.library_memberships
            where account_id=%s and library_id=%s for share nowait""", (scope.account_id, scope.library_id)).fetchone()
        connection.execute("select id from app.capabilities where account_id=%s and revoked_at is null for share nowait",
                           (scope.account_id,)).fetchall()
        return session["checked_at"]

    @staticmethod
    def _cap_receipts(connection, scope, query, now):
        for predicate, arguments, maximum in (
            ("", (), MAX_ACTOR_RECEIPTS),
            (" and session_id=%s", (scope.session_id,), MAX_SESSION_RECEIPTS),
            (" and session_id=%s and library_id=%s and subject_account_id=%s and audience=%s and kind=%s and period=%s",
             (scope.session_id, scope.library_id, scope.source_account_id, scope.audience, query.kind, query.period), MAX_QUERY_RECEIPTS),
        ):
            connection.execute("""update app.activity_snapshots set expires_at=%s where id in (
                select id from app.activity_snapshots where account_id=%s and expires_at>%s"""
                + predicate + " order by created_at desc,id desc offset %s)",
                (now, scope.account_id, now, *arguments, maximum))

    @staticmethod
    def _validate_policy(connection, snapshot, project):
        if project.scope_wide_policy:
            # The normal installed evaluator's only grants are global/library/
            # account scoped. Its current route admission + durable authority
            # fingerprint covers every retained row, including the total.
            return
        # Custom resource constraints have no durable revision owner. Fail
        # closed on any changed retained grant, even outside the current page.
        # Stream only recorded IDs (not event metadata); this optional path is
        # O(retained resources), unlike normal indexed 100-row page reads.
        after = 0
        while True:
            rows = connection.execute("""select event_id,resources from app.activity_snapshot_events
                where snapshot_id=%s and event_id>%s order by event_id limit %s""",
                (snapshot["id"], after, CHUNK_SIZE)).fetchall()
            if not rows:
                break
            for row in rows:
                for kind, reference in row["resources"]:
                    actions = project.policy(kind, reference)
                    if not isinstance(actions, AllowedActions) or not actions.allows(project.read_action):
                        raise _expired()
            after = rows[-1]["event_id"]
        after_row = 0
        while True:
            rows = connection.execute("""select ordinal,resource_ids from app.activity_snapshot_rows
                where snapshot_id=%s and ordinal>%s and resource_ids<>'[]'::jsonb
                order by ordinal limit %s""", (snapshot["id"], after_row, CHUNK_SIZE)).fetchall()
            if not rows:
                return
            for row in rows:
                for kind, reference, action in row["resource_ids"]:
                    actions = project.policy(kind, reference)
                    if not isinstance(actions, AllowedActions) or not actions.allows(action):
                        raise _expired()
            after_row = rows[-1]["ordinal"]

    @staticmethod
    def _page(connection, snapshot, token, query):
        secret = bytes(snapshot["row_secret"])
        numbered = query.numbered
        total_rows = snapshot["total_rows"]
        if numbered:
            page = query.page or 1
            if page > max(1, (total_rows + PAGE_SIZE - 1) // PAGE_SIZE):
                raise HomeActivityError()
            offset = (page - 1) * PAGE_SIZE
        else:
            offset = 0
            if query.cursor:
                receipt, position, signature = query.cursor.split(".")
                expected = hmac.new(secret, f"{receipt}.{position}".encode(), hashlib.sha256).hexdigest()
                if receipt != token or not hmac.compare_digest(expected, signature):
                    raise HomeActivityError()
                offset = int(position)
                if offset >= total_rows or offset % PAGE_SIZE:
                    raise HomeActivityError()
        rows = connection.execute("""select payload from app.activity_snapshot_rows
            where snapshot_id=%s and ordinal>%s and ordinal<=%s order by ordinal""",
            (snapshot["id"], offset, offset + PAGE_SIZE)).fetchall()
        payload = {
            "rows": [dict(row["payload"]) for row in rows], "total_listens": snapshot["total_listens"],
            "period_label": snapshot["period_label"], "range_label": snapshot["range_label"],
            "snapshot_ref": token, "expires_at": snapshot["expires_at"].isoformat(),
            "coverage": dict(snapshot["coverage"]), "next_cursor": None,
        }
        if numbered:
            payload["pagination"] = {"mode": "numbered", "page": page, "page_size": PAGE_SIZE, "total_rows": total_rows}
        elif offset + PAGE_SIZE < total_rows:
            position = offset + PAGE_SIZE
            signature = hmac.new(secret, f"{token}.{position}".encode(), hashlib.sha256).hexdigest()
            payload["next_cursor"] = f"{token}.{position}.{signature}"
        return {"status": "ready" if rows else "empty", "data": payload}
