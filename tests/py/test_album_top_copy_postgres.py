"""Private copies freeze authorized catalog membership without inheriting access."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import CREATE, normalize_top_command
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_album_top_collaboration_postgres import (
    db, urls, member, new_session, write, shared, detail, snapshot, assert_error,
)


def copy_count(database, actor):
    with database.connect() as connection:
        return connection.execute("""select count(*) as n from app.album_lists
            where library_id=%s and owner_account_id=%s""", (database.library, actor.account_id)).fetchone()["n"]


def test_copy_preserves_catalog_membership_and_curator_order_with_fresh_private_ids(db):
    viewer, editor = member(db), member(db)
    original = shared(db, refs=db.album_refs)
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    rows = detail(db, granted)["items"]
    original, _ = write(db, "reorder", granted, item_order=[row["ref"] for row in reversed(rows)])
    before = detail(db, original)
    copied, command = write(db, "copy", original, actor=viewer, title="My independent Top")
    assert copied["top_ref"] != original["top_ref"]
    assert copied["source_top_ref"] == original["top_ref"] and copied["source_revision"] == original["revision"]
    assert copied["added_count"] == len(rows) and copied["revision"] == "1"
    result = detail(db, copied, viewer)
    assert result["title"] == "My independent Top" and result["description"] == before["description"]
    assert result["visibility"] == "private"
    assert [row["catalog_ref"] for row in result["items"]] == [row["catalog_ref"] for row in before["items"]]
    assert {row["ref"] for row in result["items"]}.isdisjoint(row["ref"] for row in before["items"])
    assert [row["curator_position"] for row in result["items"]] == list(range(1, len(rows) + 1))
    assert detail(db, original) == before
    assert db.service.read_access(db.context(viewer), copied["top_ref"])["grants"] == []
    assert db.service.read_edit_requests(db.context(viewer), cursor_secret="synthetic-top-copy-cursor-secret-32-bytes")["requests"] == []
    for actor in (db.owner, editor):
        assert_error(lambda: detail(db, copied, actor), "top_unavailable", 404)
    persisted = snapshot(db)
    assert db.service.execute(db.context(viewer), command) == copied
    assert snapshot(db) == persisted and copy_count(db, viewer) == 1


def test_copy_uses_authorized_catalog_artifact_after_local_inventory_disappears(db):
    viewer = member(db)
    original = shared(db)
    before = detail(db, original, viewer)
    with db.connect() as connection:
        connection.execute("delete from library.local_albums where library_id=%s and id=any(%s)", (db.library, db.album_ids))
        assert connection.execute("select count(*) as n from library.catalog_album_links where library_id=%s", (db.library,)).fetchone()["n"] == 0
    copied, _ = write(db, "copy", original, actor=viewer)
    result = detail(db, copied, viewer)
    assert [row["catalog_ref"] for row in result["items"]] == [row["catalog_ref"] for row in before["items"]]
    assert [row["title"] for row in result["items"]] == [row["title"] for row in before["items"]]
    assert result["visibility"] == "private" and copied["added_count"] == 2
    with db.connect() as connection:
        assert connection.execute("select count(*) as n from library.catalog_album_links where library_id=%s", (db.library,)).fetchone()["n"] == 0


@pytest.mark.parametrize("revoke", ["private", "delete", "editor"])
def test_exact_copy_retry_survives_source_revocation_without_recopied_destination(db, revoke):
    viewer = member(db)
    original = shared(db)
    if revoke == "editor":
        original, _ = write(db, "grant_editor", original, account_id=viewer.account_id, role="editor")
        grant_ref = original["grant_ref"]
        original, _ = write(db, "visibility", original, visibility="private")
    copied, command = write(db, "copy", original, actor=viewer)
    action = "revoke_editor" if revoke == "editor" else "delete" if revoke == "delete" else "visibility"
    changes = {"grant_ref": grant_ref} if revoke == "editor" else {"visibility": "private"} if revoke == "private" else {}
    write(db, action, original, **changes)
    before = snapshot(db)
    assert db.service.execute(db.context(viewer), command) == copied
    assert_error(lambda: write(db, "copy", original, actor=viewer), "top_unavailable", 404)
    assert snapshot(db) == before and copy_count(db, viewer) == 1


@pytest.mark.parametrize("denial", ["create", "destination", "session", "browse", "membership"])
def test_committed_copy_retry_requires_current_destination_permissions_and_session(db, denial):
    viewer = member(db)
    original = shared(db)
    copied, command = write(db, "copy", original, actor=viewer)
    write(db, "visibility", original, visibility="private")
    constraints = None
    if denial == "create":
        constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != CREATE)
    elif denial == "destination":
        constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (
            context.resource is not None and context.resource.resource_ref == copied["top_ref"]))
    else:
        with db.connect() as connection:
            if denial == "session":
                connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (viewer.session_id,))
            elif denial == "browse":
                connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (viewer.account_id,))
            else:
                connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (viewer.account_id, db.library))
    before = snapshot(db)
    assert_error(lambda: db.service.execute(db.context(viewer), command, constraints=constraints), "forbidden", 403)
    assert snapshot(db) == before and copy_count(db, viewer) == 1


def test_copy_retry_retains_top_cross_session_semantics_and_rechecks_only_destination(db):
    viewer = member(db)
    original = shared(db)
    copied, command = write(db, "copy", original, actor=viewer)
    fresh = new_session(db, viewer)
    with db.connect() as connection:
        connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (viewer.session_id,))
    def constraints(context):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            context.resource is not None and context.resource.resource_ref == original["top_ref"]))
    before = snapshot(db)
    assert db.service.execute(db.context(fresh), command, constraints=constraints) == copied
    assert snapshot(db) == before


def test_copy_key_binds_action_source_revision_and_body_without_duplicate_creation(db):
    viewer = member(db)
    original, other = shared(db), shared(db)
    copied, command = write(db, "copy", original, actor=viewer, title="First copy")
    for action, target, changes in (
        ("copy", original, {"title": "Changed title"}),
        ("copy", other, {"title": "First copy"}),
        ("request_edit", original, {}),
        ("copy", {**original, "revision": str(int(original["revision"]) + 1)}, {"title": "First copy"}),
    ):
        assert_error(lambda: write(db, action, target, actor=viewer, key=command.request_key, **changes), "request_key_conflict", 409)
    assert db.service.execute(db.context(viewer), command) == copied
    assert copy_count(db, viewer) == 1


def test_stale_source_revision_rejects_both_request_and_copy_without_side_effects(db):
    viewer = member(db)
    original = shared(db)
    write(db, "save", original, title="New source revision")
    before = snapshot(db)
    for action in ("copy", "request_edit"):
        assert_error(lambda: write(db, action, original, actor=viewer), "revision_conflict", 409)
    assert snapshot(db) == before and copy_count(db, viewer) == 0


def test_concurrent_identical_copy_retries_create_exactly_one_destination(db):
    viewer = member(db)
    original = shared(db)
    command = normalize_top_command("copy", {"revision": original["revision"], "request_key": str(uuid4())}, top_ref=original["top_ref"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: db.service.execute(db.context(viewer), command), range(2)))
    assert results[0] == results[1] and copy_count(db, viewer) == 1


def test_same_copy_key_is_independent_for_other_actors_and_other_copies_remain_private(db):
    first, second, key = member(db), member(db), str(uuid4())
    original = shared(db)
    copied_a, _ = write(db, "copy", original, actor=first, key=key)
    copied_b, _ = write(db, "copy", original, actor=second, key=key)
    assert copied_a["top_ref"] != copied_b["top_ref"]
    assert_error(lambda: detail(db, copied_a, second), "top_unavailable", 404)
    assert_error(lambda: detail(db, copied_b, first), "top_unavailable", 404)
