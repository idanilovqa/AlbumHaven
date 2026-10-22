"""Existing publication owner and real SQL; no guest hosting is enabled by this fixture."""
import asyncio
from contextlib import contextmanager
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import ACCESS, MANAGE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error, CURSOR_SECRET
from tests.py.test_album_top_collaboration_postgres import member, write, new_session
from tests.py.test_owned_album_top_route_boundary import middleware_app, mutation_headers, asgi_response


def configured(database):
    database.service._config.update(ALBUM_HAVEN_PUBLIC_SHARING_ENABLED=True,
        ALBUM_HAVEN_PUBLIC_BASE_URL="https://public.example.test",
        ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN="https://public.example.test")
    connect = database.service._connect

    @contextmanager
    def bounded(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute("set local statement_timeout='10s'")
            yield connection
    database.service._connect = bounded
    return database


def sharing(database, receipt, actor=None, **options):
    return database.service.read_sharing(database.context(actor), receipt["top_ref"],
        cursor_secret=CURSOR_SECRET, **options)


def enable(database, receipt, action="enable_external", **changes):
    preview = database.service.publication_preview(database.context(), top_ref=receipt["top_ref"],
        payload={"revision": receipt["revision"], "items": []})
    return write(database, action, receipt, title="Explicit publication", description="Approved",
        items=[], evidence_revision=preview["evidence_revision"], **changes)


def retained(database):
    with database.connect() as connection:
        return {**database.snapshot(), **{table: connection.execute(
            f"select * from app.{table} where library_id=%s order by ref", (database.library,)).fetchall()
            for table in ("shared_links", "album_list_publications")}}


def test_saved_owner_projection_unpublished_enabled_disabled_and_revoked_without_read_writes(db):
    configured(db)
    top, _ = db.create(refs=[])
    before = retained(db)
    first = sharing(db, top)["publication"]
    assert first == {"state": "unpublished", "share_ref": None, "link_revision": None,
        "publication_ref": None, "publication_revision": None, "public_path": None, "public_url": None,
        "deployment_available": True, "can_enable_external": True, "can_revoke_external": False}
    assert retained(db) == before
    published, command = enable(db, top)
    saved = sharing(db, published)["publication"]
    assert {key: saved[key] for key in published["publication"]} == published["publication"]
    assert saved["public_path"] == "/public/album-tops/" + saved["share_ref"]
    assert saved["public_url"] == "https://public.example.test" + saved["public_path"]
    assert saved["can_enable_external"] and saved["can_revoke_external"]
    assert db.service.execute(db.context(), command) == published
    before = retained(db)
    assert sharing(db, published)["publication"] == saved
    assert retained(db) == before
    db.service._config["ALBUM_HAVEN_PUBLIC_SHARING_ENABLED"] = False
    disabled = sharing(db, published)["publication"]
    assert {key: disabled[key] for key in published["publication"]} == published["publication"]
    assert disabled["public_url"] is None and disabled["public_path"] == saved["public_path"]
    assert not disabled["deployment_available"] and not disabled["can_enable_external"]
    assert disabled["can_revoke_external"]
    revoked, command = write(db, "revoke_external", published)
    assert db.service.execute(db.context(), command) == revoked
    final = sharing(db, revoked)["publication"]
    assert final["state"] == "revoked" and final["share_ref"] == saved["share_ref"]
    assert int(final["link_revision"]) > int(saved["link_revision"])
    assert final["publication_ref"] is None and final["publication_revision"] is None
    assert final["public_path"] is None and final["public_url"] is None
    assert not final["can_revoke_external"]


@pytest.mark.parametrize("base,origin", [("http://public.example.test", "http://public.example.test"),
    ("https://public.example.test/path", "https://public.example.test"),
    ("https://public.example.test", "https://foreign.example.test"), (None, None)])
def test_invalid_deployment_origin_never_becomes_saved_url_or_enable_permission(db, base, origin):
    configured(db)
    top, _ = db.create(refs=[])
    top, _ = enable(db, top)
    db.service._config.update(ALBUM_HAVEN_PUBLIC_BASE_URL=base, ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN=origin)
    state = sharing(db, top)["publication"]
    assert state["state"] == "enabled" and state["publication_ref"] == top["publication"]["publication_ref"]
    assert state["public_url"] is None and not state["deployment_available"] and not state["can_enable_external"]
    assert state["can_revoke_external"]


def test_editor_and_viewer_never_receive_owner_publication_and_cannot_publish_or_revoke(db):
    configured(db)
    top, _ = db.create(refs=[])
    editor, viewer = member(db), member(db)
    top, _ = write(db, "grant_editor", top, account_id=editor.account_id, role="editor")
    top, _ = write(db, "grant_viewer", top, account_id=viewer.account_id, role="viewer")
    top, _ = enable(db, top)
    for actor in (editor, viewer):
        assert "publication" not in sharing(db, top, actor)
        before = retained(db)
        assert_error(lambda: write(db, "revoke_external", top, actor=actor), "forbidden", 403)
        assert_error(lambda: write(db, "enable_external", top, actor=actor,
            items=[], evidence_revision="0" * 64), "forbidden", 403)
        assert retained(db) == before
    saved = sharing(db, top)["publication"]
    edited, _ = write(db, "save", top, actor=editor, title="Working edit only")
    assert sharing(db, edited)["publication"] == saved
    republished, _ = enable(db, edited, action="save")
    latest = sharing(db, republished)["publication"]
    assert latest["share_ref"] == saved["share_ref"]
    assert latest["publication_ref"] != saved["publication_ref"]
    assert int(latest["publication_revision"]) == int(saved["publication_revision"]) + 1


def test_owner_action_specific_constraints_keep_revoke_independent_of_edit(db):
    configured(db)
    top, _ = db.create(refs=[])
    top, _ = enable(db, top)
    denied_edit = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != MANAGE)
    state = sharing(db, top, constraints=denied_edit)["publication"]
    assert not state["can_enable_external"] and state["can_revoke_external"]
    denied_access = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != ACCESS)
    assert "publication" not in sharing(db, top, constraints=denied_access)


def test_real_private_routes_commit_exact_owner_receipts_and_return_saved_sharing(db):
    configured(db)
    top, _ = db.create(refs=[])
    preview = db.service.publication_preview(db.context(), top_ref=top["top_ref"],
        payload={"revision": top["revision"], "items": []})
    app = middleware_app(db.service, db.owner)
    payload = {"request_key": str(uuid4()), "revision": top["revision"],
        "title": "Explicit route publication", "description": "Approved", "items": [],
        "evidence_revision": preview["evidence_revision"]}
    path = f"/album-tops/{top['top_ref']}/enable_external"
    status, response, headers = asyncio.run(asgi_response(app, "POST", path,
        headers=mutation_headers(app, db.owner), payload=payload))
    assert status == 200 and headers[b"cache-control"] == b"private, no-store"
    receipt = response["data"]
    assert receipt["action"] == "enable_external" and receipt["request_key"] == payload["request_key"]
    assert sharing(db, receipt)["publication"]["publication_ref"] == receipt["publication"]["publication_ref"]
    status, replay, _ = asyncio.run(asgi_response(app, "POST", path,
        headers=mutation_headers(app, db.owner), payload=payload))
    assert status == 200 and replay["data"] == receipt


def test_stale_evidence_and_disabled_deployment_cannot_create_publication(db):
    configured(db)
    top, _ = db.create(refs=[])
    before = retained(db)
    assert_error(lambda: write(db, "enable_external", top, items=[], evidence_revision="0" * 64), "evidence_stale", 409)
    assert retained(db) == before
    db.service._config["ALBUM_HAVEN_PUBLIC_SHARING_ENABLED"] = False
    assert_error(lambda: enable(db, top), "forbidden", 403)
    assert retained(db) == before


def test_current_owner_session_replay_retains_existing_account_scoped_receipt_semantics(db):
    configured(db)
    top, _ = db.create(refs=[])
    published, command = enable(db, top)
    before = retained(db)
    current = new_session(db, db.owner)
    assert db.service.execute(db.context(current), command) == published
    assert retained(db) == before
    with db.connect() as connection:
        connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (current.session_id,))
    assert_error(lambda: db.service.execute(db.context(current), command), "forbidden", 403)
    assert_error(lambda: sharing(db, published, current), "forbidden", 403)
    assert retained(db) == before


def test_foreign_actor_and_deleted_top_cannot_read_saved_publication(db):
    configured(db)
    top, _ = db.create(refs=[])
    top, _ = enable(db, top)
    foreign = member(db)
    assert_error(lambda: sharing(db, top, foreign), "top_unavailable", 404)
    deleted, _ = write(db, "delete", top)
    assert_error(lambda: sharing(db, deleted), "top_unavailable", 404)


def test_publication_read_rechecks_owner_access_after_actual_saved_link_lock(db):
    configured(db)
    top, _ = db.create(refs=[])
    top, _ = enable(db, top)
    connect = db.service._connect
    state = {"after_link": False}

    class ObservedConnection:
        def __init__(self, connection):
            self.connection = connection
        def __getattr__(self, name):
            return getattr(self.connection, name)
        def execute(self, query, params=None):
            result = self.connection.execute(query, params)
            if "from app.shared_links where top_ref=" in query:
                state["after_link"] = True
            return result

    @contextmanager
    def observed(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            yield ObservedConnection(connection)
    db.service._connect = observed
    constraints = lambda context: PolicyEvaluationConstraints(
        request_origin_allowed=not (state["after_link"] and context.action == ACCESS))
    before = retained(db)
    assert_error(lambda: sharing(db, top, constraints=constraints), "forbidden", 403)
    assert state["after_link"]
    assert retained(db) == before
