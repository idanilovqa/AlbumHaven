"""Owner recipient directory exposes only current-library eligible safe identity."""
from uuid import UUID

import pytest

from music_app.services.owned_album_tops import ACCESS
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_album_top_collaboration_postgres import (
    db, urls, member, new_session, write, assert_error, CURSOR_SECRET,
)


def candidates(database, receipt, actor=None, **options):
    return database.service.read_access_candidates(database.context(actor), receipt["top_ref"],
        cursor_secret=CURSOR_SECRET, **options)


def test_directory_requires_active_current_library_browse_and_exposes_only_safe_identity(db):
    active, inactive, disabled, ungranted = member(db), member(db), member(db), member(db, grants=())
    with db.connect() as connection:
        outsider = db.actor(connection)
        foreign_library = db.library_for(connection, outsider)
        db.member(connection, outsider, foreign_library)
        connection.execute("update app.accounts set is_active=false where id=%s", (inactive.account_id,))
        connection.execute("update app.accounts set disabled_at=now() where id=%s", (disabled.account_id,))
        expected = connection.execute("""select p.account_ref::text,a.display_name,a.username_display
            from app.accounts a join app.social_profiles p on p.account_id=a.id where a.id=%s""", (active.account_id,)).fetchone()
    original, _ = db.create()
    page = candidates(db, original)
    assert page["top_ref"] == original["top_ref"] and page["revision"] == original["revision"]
    assert page["candidates"] == [{**expected, "account_id": active.account_id,
        "grant_ref": None, "role": None, "allowed_actions": {"can_grant_editor": True}}]
    assert page["next_cursor"] is None and UUID(page["candidates"][0]["account_ref"])


def test_directory_search_is_literal_and_paged_with_live_grant_state(db):
    recipients = [member(db) for _ in range(3)]
    with db.connect() as connection:
        for index, actor in enumerate(recipients):
            connection.execute("update app.accounts set display_name=%s where id=%s",
                ("QA%_\\ Name" if index < 2 else "QA wildcard decoy", actor.account_id))
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=recipients[1].account_id, role="editor")
    first = candidates(db, granted, query="qa%_\\", limit=1)
    second = candidates(db, granted, query="qa%_\\", limit=1, cursor=first["next_cursor"])
    assert first["next_cursor"] and second["next_cursor"] is None
    assert [row["account_id"] for page in (first, second) for row in page["candidates"]] == [actor.account_id for actor in recipients[:2]]
    assert second["candidates"][0]["grant_ref"] == granted["grant_ref"]
    assert second["candidates"][0]["role"] == "editor"
    assert second["candidates"][0]["allowed_actions"] == {"can_grant_editor": False}
    with db.connect() as connection:
        connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (recipients[1].account_id,))
    assert candidates(db, granted, query="qa%_\\", limit=1, cursor=first["next_cursor"])["candidates"] == []


@pytest.mark.parametrize("scope", ["query", "top", "session", "library", "tampered", "numeric"])
def test_directory_cursor_cannot_be_reused_for_another_scope(db, scope):
    recipients = [member(db), member(db)]
    original, _ = db.create()
    other, _ = db.create()
    first = candidates(db, original, limit=1)
    assert first["next_cursor"]
    actor, target, query, cursor = db.owner, original, "", first["next_cursor"]
    if scope == "query":
        query = "changed"
    elif scope == "top":
        target = other
    elif scope == "session":
        actor = new_session(db, db.owner)
    elif scope == "library":
        with db.connect() as connection:
            library = db.library_for(connection, db.owner)
            actor = db.member(connection, db.owner, library)
        target = db.service.execute(db.context(actor), db.create_command(refs=[]))
    elif scope == "numeric":
        cursor = str(recipients[0].account_id)
    else:
        cursor = ("A" if cursor[0] != "A" else "B") + cursor[1:]
    assert_error(lambda: candidates(db, target, actor, query=query, cursor=cursor), "invalid_cursor", 422)


def test_directory_cannot_be_read_by_editor_or_when_owner_resource_access_is_denied(db):
    editor = member(db)
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    assert_error(lambda: candidates(db, granted, editor), "forbidden", 403)
    assert_error(lambda: candidates(db, granted, constraints=lambda context: PolicyEvaluationConstraints(
        client_surface_allowed=not (context.action == ACCESS and context.resource is not None))), "forbidden", 403)


def test_directory_honors_recipient_specific_current_resource_constraints(db):
    allowed, denied = member(db), member(db)
    original, _ = db.create()
    def constraints(context):
        return PolicyEvaluationConstraints(deployment_allowed=context.actor.account_id != denied.account_id)
    page = candidates(db, original, constraints=constraints)
    assert [row["account_id"] for row in page["candidates"]] == [allowed.account_id]


def test_access_grants_are_bounded_with_no_private_account_fields(db):
    first, second = member(db), member(db)
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=first.account_id, role="editor")
    granted, _ = write(db, "grant_editor", granted, account_id=second.account_id, role="editor")
    page = db.service.read_access(db.context(), original["top_ref"], cursor_secret=CURSOR_SECRET, limit=1)
    assert len(page["grants"]) == 1 and page["next_cursor"]
    next_page = db.service.read_access(db.context(), original["top_ref"], cursor_secret=CURSOR_SECRET, limit=1, cursor=page["next_cursor"])
    assert len(next_page["grants"]) == 1 and next_page["next_cursor"] is None
    assert {row["account_id"] for result in (page, next_page) for row in result["grants"]} == {first.account_id, second.account_id}
    for result in (page, next_page):
        assert result["top_ref"] == original["top_ref"] and result["revision"] == granted["revision"]
        assert set(result["grants"][0]) == {"grant_ref", "account_id", "role", "is_active", "account_ref", "display_name", "username_display"}


@pytest.mark.parametrize("loss", ["disabled", "browse_revoked"])
def test_owner_can_revoke_retained_ineligible_editor_without_restoration_resurrecting_access(db, loss):
    editor = member(db)
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    before = db.service.read_access(db.context(), original["top_ref"])["grants"]
    assert len(before) == 1 and before[0]["is_active"] is True
    with db.connect() as connection:
        if loss == "disabled":
            connection.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s", (editor.account_id,))
        else:
            connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (editor.account_id,))
    retained = db.service.read_access(db.context(), original["top_ref"])["grants"]
    assert retained == [{**before[0], "is_active": loss != "disabled"}]
    assert retained[0]["grant_ref"] == granted["grant_ref"] and retained[0]["role"] == "editor"
    assert candidates(db, granted)["candidates"] == []
    revoked, _ = write(db, "revoke_editor", granted, grant_ref=retained[0]["grant_ref"])
    assert revoked["grant_ref"] == granted["grant_ref"]
    assert db.service.read_access(db.context(), original["top_ref"])["grants"] == []
    with db.connect() as connection:
        if loss == "disabled":
            connection.execute("update app.accounts set is_active=true,disabled_at=null where id=%s", (editor.account_id,))
        else:
            connection.execute("update app.capabilities set revoked_at=null where account_id=%s", (editor.account_id,))
    assert db.service.read_access(db.context(), original["top_ref"])["grants"] == []
    assert_error(lambda: db.service.read(db.context(editor), top_ref=original["top_ref"]), "top_unavailable", 404)
    restored = candidates(db, revoked)["candidates"]
    assert len(restored) == 1 and restored[0]["account_id"] == editor.account_id
    assert restored[0]["grant_ref"] is None and restored[0]["allowed_actions"] == {"can_grant_editor": True}
