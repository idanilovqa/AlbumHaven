"""Editor requests are private owner notifications, never implicit edit grants."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Event
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import ACCESS, BROWSE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_album_top_collaboration_postgres import (
    db, urls, member, new_session, write, shared, detail, snapshot, assert_error, CURSOR_SECRET,
)


def feed(database, actor=None, **options):
    return database.service.read_edit_requests(database.context(actor), cursor_secret=CURSOR_SECRET, **options)


def sharing(database, receipt, actor=None, **options):
    return database.service.read_sharing(database.context(actor), receipt["top_ref"], cursor_secret=CURSOR_SECRET, **options)


def test_pending_request_deduplicates_without_content_revision_or_editor_grant(db):
    viewer, other = member(db), member(db)
    original = shared(db)
    before = detail(db, original)
    requested, command = write(db, "request_edit", original, actor=viewer)
    repeated, _ = write(db, "request_edit", original, actor=viewer)
    assert requested["request_ref"] == repeated["request_ref"]
    assert requested["request_created"] is True and repeated["request_created"] is False
    assert requested["revision"] == repeated["revision"] == original["revision"]
    assert db.service.execute(db.context(viewer), command) == requested
    assert detail(db, original) == before
    assert detail(db, original, viewer)["allowed_actions"]["can_edit"] is False
    assert db.service.read_access(db.context(), original["top_ref"])["grants"] == []
    assert sharing(db, original, viewer)["request_status"] == "pending"
    assert sharing(db, original, viewer)["pending_requests"] == []
    assert sharing(db, original, other)["request_status"] == "none"
    assert feed(db, other)["requests"] == []
    row = feed(db)["requests"][0]
    assert row["request_ref"] == requested["request_ref"] and row["top_ref"] == original["top_ref"]
    assert set(row) == {"request_ref", "top_ref", "title", "account_ref", "display_name", "username_display", "created_at"}
    assert datetime.fromisoformat(row["created_at"]).tzinfo is not None
    assert sharing(db, original)["pending_requests"] == [row]


@pytest.mark.parametrize("decision", ["approve", "decline"])
def test_only_owner_can_explicitly_resolve_request_and_exact_retry_is_stable(db, decision):
    viewer, other = member(db), member(db)
    original = shared(db)
    requested, _ = write(db, "request_edit", original, actor=viewer)
    for actor in (viewer, other):
        assert_error(lambda: write(db, "decide_edit_request", original, actor=actor,
            request_ref=requested["request_ref"], decision=decision), "forbidden", 403)
    decided, command = write(db, "decide_edit_request", original,
        request_ref=requested["request_ref"], decision=decision)
    assert decided["request_status"] == ("approved" if decision == "approve" else "declined")
    before = snapshot(db)
    assert db.service.execute(db.context(), command) == decided
    assert snapshot(db) == before
    assert feed(db)["requests"] == []
    assert detail(db, decided, viewer)["allowed_actions"]["can_edit"] is (decision == "approve")
    assert len(db.service.read_access(db.context(), original["top_ref"])["grants"]) == (1 if decision == "approve" else 0)


def test_owner_or_explicit_editor_cannot_create_a_redundant_request(db):
    editor = member(db)
    original = shared(db)
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    before = snapshot(db)
    for actor in (db.owner, editor):
        assert_error(lambda: write(db, "request_edit", granted, actor=actor), "editor_request_not_needed", 409)
    assert snapshot(db) == before


@pytest.mark.parametrize("change", ["private", "delete"])
def test_private_or_deleted_source_retires_request_and_cannot_resurrect_it(db, change):
    viewer = member(db)
    original = shared(db)
    requested, request_command = write(db, "request_edit", original, actor=viewer)
    latest, _ = write(db, "visibility" if change == "private" else "delete", original,
        **({"visibility": "private"} if change == "private" else {}))
    assert feed(db)["requests"] == []
    assert_error(lambda: db.service.execute(db.context(viewer), request_command), "top_unavailable", 404)
    if change == "private":
        latest, _ = write(db, "visibility", latest, visibility="server_shared")
        assert sharing(db, latest, viewer)["request_status"] == "none"
        assert_error(lambda: write(db, "decide_edit_request", latest,
            request_ref=requested["request_ref"], decision="approve"), "request_unavailable", 404)
        fresh, _ = write(db, "request_edit", latest, actor=viewer)
        assert fresh["request_ref"] != requested["request_ref"] and fresh["request_created"] is True


@pytest.mark.parametrize("change", ["disabled", "membership", "browse_revoke", "browse_delete", "view_revoke", "view_delete"])
@pytest.mark.parametrize("observe_revocation", [False, True])
def test_restoring_requester_authority_never_revives_old_pending_request(db, change, observe_revocation):
    capability = BROWSE if change.startswith("browse_") else "capability.view"
    viewer = member(db, grants=(capability,))
    original = shared(db)
    requested, _ = write(db, "request_edit", original, actor=viewer)
    with db.connect() as connection:
        if change == "disabled":
            connection.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s", (viewer.account_id,))
        elif change == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (viewer.account_id, db.library))
        elif change.endswith("revoke"):
            connection.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s", (viewer.account_id, capability))
        else:
            connection.execute("delete from app.capabilities where account_id=%s and capability_key=%s", (viewer.account_id, capability))
    if observe_revocation:
        assert feed(db)["requests"] == []
    with db.connect() as connection:
        if change == "disabled":
            connection.execute("update app.accounts set is_active=true,disabled_at=null where id=%s", (viewer.account_id,))
        elif change == "membership":
            connection.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (viewer.account_id, db.library))
        elif change.endswith("revoke"):
            connection.execute("update app.capabilities set revoked_at=null where account_id=%s and capability_key=%s", (viewer.account_id, capability))
        else:
            connection.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
                values(%s,%s,'library',%s)""", (viewer.account_id, capability, db.library))
    assert feed(db)["requests"] == []
    assert_error(lambda: write(db, "decide_edit_request", original,
        request_ref=requested["request_ref"], decision="approve"), "request_unavailable", 404)
    fresh, _ = write(db, "request_edit", original, actor=viewer)
    assert fresh["request_ref"] != requested["request_ref"] and fresh["request_created"] is True


def test_explicit_grant_retires_pending_request_without_later_resurrection(db):
    viewer = member(db)
    original = shared(db)
    requested, _ = write(db, "request_edit", original, actor=viewer)
    granted, _ = write(db, "grant_editor", original, account_id=viewer.account_id, role="editor")
    assert feed(db)["requests"] == []
    revoked, _ = write(db, "revoke_editor", granted, grant_ref=granted["grant_ref"])
    assert feed(db)["requests"] == []
    assert sharing(db, revoked, viewer)["request_status"] == "none"
    assert_error(lambda: write(db, "decide_edit_request", revoked,
        request_ref=requested["request_ref"], decision="approve"), "request_unavailable", 404)


@pytest.mark.parametrize("scope", ["actor", "session", "library", "tampered"])
def test_notification_cursor_is_bound_to_current_actor_library_and_session(db, scope):
    viewers = [member(db), member(db)]
    original = shared(db)
    for viewer in viewers:
        write(db, "request_edit", original, actor=viewer)
    first = feed(db, limit=1)
    assert len(first["requests"]) == 1 and first["next_cursor"]
    second = feed(db, limit=1, cursor=first["next_cursor"])
    assert len(second["requests"]) == 1 and second["next_cursor"] is None
    assert first["requests"][0]["request_ref"] != second["requests"][0]["request_ref"]
    actor, token = db.owner, first["next_cursor"]
    if scope == "actor":
        actor = viewers[0]
    elif scope == "session":
        actor = new_session(db, db.owner)
    elif scope == "library":
        with db.connect() as connection:
            library = db.library_for(connection, db.owner)
            actor = db.member(connection, db.owner, library)
    else:
        token = ("A" if token[0] != "A" else "B") + token[1:]
    assert_error(lambda: feed(db, actor, cursor=token), "invalid_cursor", 422)


def test_owner_notification_feed_honors_current_resource_access_constraint(db):
    viewer = member(db)
    original = shared(db)
    write(db, "request_edit", original, actor=viewer)
    def constraints(context):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            context.action == ACCESS and context.resource is not None and context.resource.resource_ref == original["top_ref"]))
    assert feed(db, constraints=constraints)["requests"] == []


def test_concurrent_same_and_distinct_keys_create_one_pending_request(db):
    viewer = member(db)
    original = shared(db)
    for keys in ((str(uuid4()),) * 2, (str(uuid4()), str(uuid4()))):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda key: write(db, "request_edit", original, actor=viewer, key=key)[0], keys))
        assert results[0]["request_ref"] == results[1]["request_ref"]
        if keys[0] == keys[1]:
            assert results[0] == results[1]
    with db.connect() as connection:
        assert connection.execute("select count(*) as n from app.album_list_edit_requests where library_id=%s", (db.library,)).fetchone()["n"] == 1
    assert detail(db, original)["revision"] == original["revision"]


def test_request_ref_cannot_be_decided_under_a_different_top(db):
    viewer = member(db)
    first, second = shared(db), shared(db)
    requested, _ = write(db, "request_edit", first, actor=viewer)
    before = snapshot(db)
    assert_error(lambda: write(db, "decide_edit_request", second,
        request_ref=requested["request_ref"], decision="approve"), "request_unavailable", 404)
    assert snapshot(db) == before


def test_owner_notification_read_and_requester_retry_do_not_invert_account_parent_locks(db, monkeypatch):
    from music_app.services import album_top_viewer_actions as viewers

    viewer = member(db)
    original = shared(db)
    requested, _ = write(db, "request_edit", original, actor=viewer)
    reader_at_member, writer_at_parent, release_reader = Event(), Event(), Event()
    project_member, load = viewers.member_context, db.service._top
    def member_checkpoint(connection, context, account_id, **options):
        if account_id == viewer.account_id:
            assert options.get("lock", False) is False
            reader_at_member.set()
            assert release_reader.wait(5), "The owner reader was not released"
        return project_member(connection, context, account_id, **options)
    def parent_checkpoint(connection, context, ref, **options):
        if context.actor.account_id == viewer.account_id and options.get("write"):
            writer_at_parent.set()
        return load(connection, context, ref, **options)
    monkeypatch.setattr(viewers, "member_context", member_checkpoint)
    monkeypatch.setattr(db.service, "_top", parent_checkpoint)
    with ThreadPoolExecutor(max_workers=2) as pool:
        reading = pool.submit(feed, db)
        try:
            assert reader_at_member.wait(5), "Owner feed did not reach its requester projection"
            writing = pool.submit(write, db, "request_edit", original, actor=viewer)
            assert writer_at_parent.wait(5), "Requester retry did not reach the parent lock"
        finally:
            release_reader.set()
        result, (repeated, _) = reading.result(timeout=10), writing.result(timeout=10)
    assert result["requests"][0]["request_ref"] == requested["request_ref"]
    assert repeated["request_ref"] == requested["request_ref"] and repeated["request_created"] is False
