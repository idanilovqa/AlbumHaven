"""Recipient directory and current-authority checks on owned synthetic PostgreSQL."""
from dataclasses import replace
from uuid import UUID

import pytest

from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import ACCESS, PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_playlist_access_candidates import SECRET
from tests.py.test_playlist_collaboration_postgres import db, urls, sharing, member, write


def candidates(db, receipt, *, actor=None, **kwargs):
    return db.service.read_access_candidates(db.context(actor), receipt["playlist_id"],
        cursor_secret=SECRET, **kwargs)


def test_directory_only_active_other_members_without_social_requirement(sharing):
    db = sharing
    receipt, _ = db.create(refs=[])
    active, inactive, disabled = member(db), member(db), member(db)
    with db.connect() as con:
        outsider = db.actor(con)
        con.execute("update app.accounts set is_active=false where id=%s", (inactive.account_id,))
        con.execute("update app.accounts set disabled_at=now() where id=%s", (disabled.account_id,))
        assert not con.execute("select 1 from app.capabilities where account_id=%s and capability_key='capability.social'",
                               (active.account_id,)).fetchone()
        expected = con.execute("""select p.account_ref::text,a.display_name,a.username_display
            from app.accounts a join app.social_profiles p on p.account_id=a.id where a.id=%s""",
            (active.account_id,)).fetchone()
    page = candidates(db, receipt)
    assert page["candidates"] == [{**expected, "account_id":active.account_id,"grant_ref":None,"role":None,
                                   "allowed_actions":{"can_grant_editor":True}}]
    assert page["next_cursor"] is None and UUID(page["candidates"][0]["account_ref"])
    assert {db.owner.account_id, inactive.account_id, disabled.account_id, outsider.account_id}.isdisjoint(
        row["account_id"] for row in page["candidates"])


def test_search_uses_literal_names_paging_and_current_grant_state(sharing):
    db = sharing
    receipt, _ = db.create(refs=[])
    recipients = [member(db) for _ in range(3)]
    with db.connect() as con:
        for index, actor in enumerate(recipients):
            con.execute("update app.accounts set display_name=%s where id=%s",
                        ("QA%_\\ Name" if index < 2 else "QA-wildcard-decoy", actor.account_id))
    granted, _ = write(db, "grant_editor", receipt, account_id=recipients[1].account_id, role="editor")
    first = candidates(db, granted, query="qa%_\\", limit=1)
    second = candidates(db, granted, query="qa%_\\", limit=1, cursor=first["next_cursor"])
    assert [row["account_id"] for page in (first,second) for row in page["candidates"]] == [a.account_id for a in recipients[:2]]
    assert second["next_cursor"] is None
    assert second["candidates"][0]["grant_ref"] == granted["grant_ref"]
    assert second["candidates"][0]["allowed_actions"]["can_grant_editor"] is False
    with db.connect() as con:
        username = con.execute("select username_display from app.accounts where id=%s", (recipients[2].account_id,)).fetchone()["username_display"]
    assert [row["account_id"] for row in candidates(db, granted, query=username)["candidates"]] == [recipients[2].account_id]
    with db.connect() as con:
        con.execute("update app.accounts set is_active=false where id=%s", (recipients[1].account_id,))
    assert candidates(db, granted, query="qa%_\\", limit=1, cursor=first["next_cursor"])["candidates"] == []


def test_enriched_grants_retain_inactive_member_until_explicit_revoke(sharing):
    db = sharing
    receipt, _ = db.create(refs=[])
    target = member(db)
    granted, _ = write(db, "grant_editor", receipt, account_id=target.account_id, role="editor")
    before = db.service.read_access(db.context(), receipt["playlist_id"])["grants"][0]
    assert before["is_active"] is True and UUID(before["account_ref"])
    with db.connect() as con:
        con.execute("update app.accounts set disabled_at=now() where id=%s", (target.account_id,))
    after = db.service.read_access(db.context(), receipt["playlist_id"])["grants"][0]
    assert after == {**before,"is_active":False}
    assert candidates(db, granted)["candidates"] == []
    write(db, "revoke_editor", granted, grant_ref=granted["grant_ref"])
    assert db.service.read_access(db.context(), receipt["playlist_id"])["grants"] == []


def test_current_owner_access_and_resource_constraints_cannot_be_replayed(sharing):
    db = sharing
    receipt, _ = db.create(refs=[])
    editor = member(db)
    granted, _ = write(db, "grant_editor", receipt, account_id=editor.account_id, role="editor")
    with db.connect() as con:
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'library',%s)",
                    (editor.account_id,ACCESS,db.library))
    editor = replace(editor, capability_grants=(*editor.capability_grants, CapabilityGrant(ACCESS,"library",db.library)))
    with pytest.raises(PlaylistError, match="forbidden"):
        candidates(db, granted, actor=editor)
    with pytest.raises(PlaylistError, match="forbidden"):
        candidates(db, granted, constraints=lambda ctx: PolicyEvaluationConstraints(
            client_surface_allowed=not (ctx.action == ACCESS and ctx.resource is not None)))
    with db.connect() as con:
        con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s",
                    (db.owner.account_id,ACCESS))
    with pytest.raises(PlaylistError, match="forbidden"):
        candidates(db, granted)


def test_session_revocation_and_deleted_playlist_deny_directory(sharing):
    db = sharing
    receipt, _ = db.create(refs=[])
    write(db, "delete", receipt)
    with pytest.raises(PlaylistError, match="playlist_unavailable"):
        candidates(db, receipt)
    other, _ = db.create(refs=[])
    with db.connect() as con:
        con.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.owner.session_id,))
    with pytest.raises(PlaylistError, match="forbidden"):
        candidates(db, other)
