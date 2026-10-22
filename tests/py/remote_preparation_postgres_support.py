"""Additive real-role C2 preparation fixture; no historical-v1 seed or bypass.

This composes the established synthetic db fixture and RemoteCase observation
owner directly. It intentionally does not request the old remote fixture whose
teardown disables the pending immutable trigger. No cutoff trigger is disabled.
"""
from uuid import UUID, uuid4

import pytest

from music_app.services.album_top_remote_sources import normalize_remote_acquisition
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.remote_top_postgres_support import CONTEXT, MBID, RemoteCase, db, urls, runtime


class PreparationCase(RemoteCase):
    def sql(self, function, args=()):
        allowed = {
            "begin_top_remote_preparation", "reserve_top_remote_attempt",
            "finish_top_remote_attempt", "fail_top_remote_attempt",
            "close_top_remote_preparation", "maintain_top_remote_preparations",
            "status_top_remote_preparations",
        }
        assert function in allowed
        with runtime(self.db) as connection:
            assert_runtime_role(connection, self.db)
            return connection.execute("select app." + function + "(" + ",".join(["%s"] * len(args))
                + ") as result", args).fetchone()["result"]

    def binding(self, target, *, actor=None, context_ref=CONTEXT):
        actor = actor or self.db.owner
        owner = actor.account_id
        if target["kind"] == "top":
            with self.db.connect() as connection:
                owner = connection.execute("select owner_account_id from app.album_lists where ref=%s",
                    (target["top_ref"],)).fetchone()["owner_account_id"]
        return (actor.current_library_id, actor.account_id, actor.session_id, context_ref, target["kind"],
            target.get("top_ref", target.get("draft_ref")), owner,
            int(target["revision"]) if target["kind"] == "top" else None)

    def maintain(self, *, actor=None, mode="reclaim"):
        actor = actor or self.db.owner
        return self.sql("maintain_top_remote_preparations", (actor.account_id, actor.current_library_id, mode))

    def status(self, *, actor=None):
        actor = actor or self.db.owner
        return self.sql("status_top_remote_preparations", (actor.account_id, actor.current_library_id))

    def begin(self, target=None, *, actor=None, form_ref=None, initialize=True, context_ref=CONTEXT):
        target = target or {"kind": "create", "draft_ref": str(uuid4())}
        actor = actor or self.db.owner
        if initialize:
            progress = self.maintain(actor=actor)
            # This fixture never seeds legacy rows. Initial sentinel is one step.
            assert progress["capacity"]["legacy_initialized"] is True
        result = self.sql("begin_top_remote_preparation", (*self.binding(target, actor=actor, context_ref=context_ref),
            form_ref or target.get("draft_ref") or str(uuid4())))
        return result, target

    def command(self, preparation, target, *, key=None, mbid=MBID):
        return {"version": 2, "preparation_ref": preparation["preparation_ref"],
            "request_key": key or str(uuid4()), "destination": target, "release_group_id": mbid}

    def request_args(self, command, *, actor=None, context_ref=CONTEXT):
        normalized = normalize_remote_acquisition(command)
        return (command["preparation_ref"], *self.binding(command["destination"], actor=actor, context_ref=context_ref),
            normalized.request_key, normalized.digest, normalized.release_group_id)

    def reserve(self, command, *, actor=None, context_ref=CONTEXT):
        return self.sql("reserve_top_remote_attempt", self.request_args(command, actor=actor, context_ref=context_ref))

    def finish(self, command, reservation, *, actor=None, facts=None, context_ref=CONTEXT):
        facts = facts or self.facts
        return self.sql("finish_top_remote_attempt", (*self.request_args(command, actor=actor, context_ref=context_ref),
            reservation["attempt_ref"], reservation["acquisition_ref"], facts.digest, facts.title,
            facts.artist_display, facts.first_release_date, facts.primary_type,
            None if facts.credited_artist_ids is None else [UUID(value) for value in facts.credited_artist_ids]))

    def fail(self, command, reservation, *, actor=None, error="provider_unavailable", context_ref=CONTEXT):
        return self.sql("fail_top_remote_attempt", (*self.request_args(command, actor=actor, context_ref=context_ref),
            reservation["attempt_ref"], reservation["acquisition_ref"], error))

    def close(self, preparation, *, actor=None):
        actor = actor or self.db.owner
        return self.sql("close_top_remote_preparation",
            (actor.account_id, actor.current_library_id, preparation["preparation_ref"]))

    def state(self):
        with runtime(self.db) as connection:
            assert_runtime_role(connection, self.db)
            return {name: connection.execute("select * from app." + name
                + " where actor_account_id=any(%s) order by 1", (self.db.account_ids,)).fetchall()
                for name in ("album_top_remote_pending_budgets", "album_top_remote_preparations",
                    "album_top_remote_attempts", "album_top_remote_acquisitions")}

    def insert_timed_parent(self, *, age_seconds, target=None, actor=None, initialize=True):
        """Trusted synthetic setup, never a production clock override.

        Parents have their real fixed 30/60-minute windows from insertion. This
        inserts an empty historical parent and exact physical-parent accounting;
        no pending fact, cutoff, state trigger or timestamp is rewritten.
        """
        actor = actor or self.db.owner
        target = target or {"kind": "create", "draft_ref": str(uuid4())}
        if initialize:
            progress = self.maintain(actor=actor)
            assert progress["capacity"]["legacy_initialized"] is True
        ref = str(uuid4())
        with self.db.connect() as connection:
            connection.execute("select id from app.accounts where id=any(%s) order by id for update",
                (sorted(set((actor.account_id, self.binding(target, actor=actor)[6]))),)).fetchall()
            connection.execute("select actor_account_id from app.album_top_remote_pending_budgets "
                "where actor_account_id=%s for update", (actor.account_id,)).fetchone()
            connection.execute("""with t as (select clock_timestamp()-(%s*interval '1 second') as created)
                insert into app.album_top_remote_preparations(ref,library_id,actor_account_id,original_session_id,
                context_ref,destination_kind,destination_ref,destination_owner_account_id,destination_revision,
                form_ref,created_at,accepts_until,fully_expires_at)
                select %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,created,created+interval '30 minutes',created+interval '60 minutes' from t""",
                (age_seconds, ref, *self.binding(target, actor=actor), target.get("draft_ref") or str(uuid4())))
            connection.execute("update app.album_top_remote_pending_budgets set parent_count=parent_count+1 "
                "where actor_account_id=%s", (actor.account_id,))
        return {"preparation_ref": ref}, target

    def cleanup(self):
        # Trusted fixture owner may clean its exact synthetic actors even when a
        # test disabled their accounts or revoked all runtime session authority.
        # Production callers cannot EXECUTE this private reclamation primitive.
        self.db.service._connect = self.original_connect
        with self.db.connect() as connection:
            owner = connection.execute("select rolsuper,current_user=pg_get_userbyid(c.relowner) as owns "
                "from pg_roles r cross join pg_class c where r.rolname=current_user "
                "and c.oid='app.album_top_remote_preparations'::regclass").fetchone()
            assert owner == {"rolsuper": False, "owns": True}
            connection.execute("select id from app.accounts where id=any(%s) order by id for update",
                (self.db.account_ids,)).fetchall()
            connection.execute("select actor_account_id from app.album_top_remote_pending_budgets "
                "where actor_account_id=any(%s) order by actor_account_id for update", (self.db.account_ids,)).fetchall()
            parents = connection.execute("select ref from app.album_top_remote_preparations "
                "where actor_account_id=any(%s) order by ref for update", (self.db.account_ids,)).fetchall()
            for parent in parents:
                connection.execute("select app.reclaim_top_remote_parent_locked(%s,true)", (parent["ref"],)).fetchone()
            assert not connection.execute("select ref from app.album_top_remote_acquisitions "
                "where actor_account_id=any(%s)", (self.db.account_ids,)).fetchall()
            connection.execute("delete from app.album_top_remote_pending_budgets where actor_account_id=any(%s)",
                (self.db.account_ids,))


@pytest.fixture
def preparations(db):
    case = PreparationCase(db)
    try:
        yield case
    finally:
        case.cleanup()
