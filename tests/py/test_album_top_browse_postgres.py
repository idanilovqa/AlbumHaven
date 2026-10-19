"""Native Top browse hints on the admitted, isolated PostgreSQL authority path."""
from uuid import uuid4

import pytest

from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_album_top_collaboration_postgres import db, urls, member, shared, detail
from tests.py.test_owned_album_tops_postgres import assert_error


def canonical(items):
    return [{key: value for key, value in item.items() if key != "native_album"} for item in items]


def test_read_only_viewer_gets_ordered_album_details_without_edit_or_media(db):
    viewer = member(db)
    receipt = shared(db, refs=list(reversed(db.album_refs)))
    before = db.snapshot()
    result = detail(db, receipt, viewer)
    assert result["allowed_actions"]["can_edit"] is False
    assert [item["catalog_ref"] for item in result["items"]] == list(reversed(db.album_refs))
    assert [item["native_album"] for item in result["items"]] == [
        {"inventory_album_ref": f"inventory-album:{db.library}:{album}",
         "artwork_url": f"/library/album-artwork/inventory-album:{db.library}:{album}",
         "allowed_actions": {"can_view_details": True}}
        for album in reversed(db.album_ids)]
    assert canonical(result["items"]) == canonical(detail(db, receipt)["items"])
    assert db.snapshot() == before


@pytest.mark.parametrize("mapping", ["missing", "ambiguous", "foreign_only"])
def test_mapping_changes_never_remove_canonical_members_or_select_an_edition(db, mapping):
    receipt, _ = db.create()
    before = db.read(receipt)
    with db.connect() as connection:
        if mapping != "ambiguous":
            connection.execute("delete from library.catalog_album_links where library_id=%s and catalog_ref=%s",
                               (db.library, db.album_refs[0]))
        if mapping != "missing":
            library = db.library if mapping == "ambiguous" else db.library_for(connection, db.owner)
            album = connection.execute("""insert into library.local_albums(library_id,album_key,title)
                values(%s,%s,'Same display title') returning id""", (library, uuid4().hex)).fetchone()["id"]
            connection.execute("""insert into library.catalog_album_links(library_id,local_album_id,catalog_ref)
                values(%s,%s,%s)""", (library, album, db.album_refs[0]))
    after = db.read(receipt)
    assert canonical(after["items"]) == canonical(before["items"])
    assert after["revision"] == before["revision"]
    assert after["items"][0]["native_album"] is None
    assert after["items"][1]["native_album"] == before["items"][1]["native_album"]


def test_album_browse_and_artwork_constraints_remain_independent(db):
    receipt, _ = db.create()
    before = db.read(receipt)

    def deny_album(context):
        denied = (context.action == "library.browse.read" and context.resource is not None
                  and context.resource.resource_kind == "album"
                  and context.resource.resource_ref == str(db.album_ids[0]))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    def deny_artwork(context):
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != "library.artwork.read")

    restricted = detail(db, receipt, constraints=deny_album)
    assert canonical(restricted["items"]) == canonical(before["items"])
    assert restricted["items"][0]["native_album"] is None
    assert restricted["items"][1]["native_album"] == before["items"][1]["native_album"]
    without_art = detail(db, receipt, constraints=deny_artwork)
    for original, projected in zip(before["items"], without_art["items"]):
        assert projected["native_album"] == {**original["native_album"], "artwork_url": None}


@pytest.mark.parametrize("revocation", ["session", "capabilities", "membership"])
def test_stale_viewer_context_cannot_keep_native_targets_after_authority_revocation(db, revocation):
    viewer = member(db)
    receipt = shared(db)
    assert all(item["native_album"] for item in detail(db, receipt, viewer)["items"])
    with db.connect() as connection:
        if revocation == "session":
            connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (viewer.session_id,))
        elif revocation == "capabilities":
            connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (viewer.account_id,))
        else:
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                               (viewer.account_id, db.library))
    assert_error(lambda: detail(db, receipt, viewer), "forbidden", 403)


def test_album_policy_uses_actual_viewer_not_top_owner(db):
    viewer = member(db)
    receipt = shared(db)

    def deny_viewer_album(context):
        denied = (context.actor.account_id == viewer.account_id
                  and context.action == "library.browse.read" and context.resource is not None
                  and context.resource.resource_kind == "album")
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    owner = detail(db, receipt, constraints=deny_viewer_album)
    viewed = detail(db, receipt, viewer, constraints=deny_viewer_album)
    assert canonical(viewed["items"]) == canonical(owner["items"])
    assert all(item["native_album"] for item in owner["items"])
    assert all(item["native_album"] is None for item in viewed["items"])


def test_final_top_browse_fence_runs_after_native_projection(db):
    receipt, _ = db.create()
    projected = False

    def changing_policy(context):
        nonlocal projected
        resource = context.resource
        if resource is not None and resource.resource_kind == "album":
            projected = True
        denied = (projected and context.action == "library.browse.read"
                  and resource is not None and resource.resource_kind == "album_top")
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    assert_error(lambda: detail(db, receipt, constraints=changing_policy), "forbidden", 403)
    assert projected
