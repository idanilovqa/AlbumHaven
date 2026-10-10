"""Authenticated Top ACL contracts on the admitted, isolated PostgreSQL fixture."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
import hashlib
from threading import Event
from uuid import uuid4

import pytest

from music_app.services.current_actor import CapabilityGrant, LibraryRelationship
from music_app.services.owned_album_tops import ACCESS, BROWSE, ITEMS, MANAGE, AlbumTopError, normalize_top_command
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error, CURSOR_SECRET


def member(database, *, grants=("capability.view",), library=None):
    """Seed complete authority before any operation receipt is captured."""
    library = database.library if library is None else library
    with database.connect() as connection:
        actor = database.actor(connection)
        connection.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
            values(%s,%s,'member')""", (actor.account_id, library))
        for grant in grants:
            connection.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
                values(%s,%s,'library',%s)""", (actor.account_id, grant, library))
    return replace(actor, current_library_id=library,
        library_relationships=(LibraryRelationship(library, "member", False),),
        capability_grants=tuple(CapabilityGrant(grant, "library", library) for grant in grants))


def new_session(database, actor):
    with database.connect() as connection:
        session = connection.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""",
            (actor.account_id, hashlib.sha256(uuid4().bytes).digest(), database.now, database.now, database.now,
             database.now + timedelta(hours=1), database.now + timedelta(days=1))).fetchone()["id"]
    return replace(actor, session_id=session)


def write(database, action, receipt, *, actor=None, key=None, **data):
    command = normalize_top_command(action, {"revision": receipt["revision"],
        "request_key": key or str(uuid4()), **data}, top_ref=receipt["top_ref"])
    return database.service.execute(database.context(actor), command), command


def shared(database, *, refs=None):
    receipt, _ = database.create(refs=refs)
    return write(database, "visibility", receipt, visibility="server_shared")[0]


def detail(database, receipt, actor=None, **options):
    return database.service.read(database.context(actor), top_ref=receipt["top_ref"], **options)


def snapshot(database):
    with database.connect() as connection:
        return {**database.snapshot(), **{table: connection.execute(
            f"select * from app.{table} where library_id=%s order by ref", (database.library,)).fetchall()
            for table in ("album_list_access_grants", "album_list_edit_requests")}}


def test_private_editor_and_server_shared_reader_have_distinct_content_and_owner_authority(db):
    viewer = member(db)
    original, _ = db.create()
    assert db.service.list(db.context(viewer), cursor_secret=CURSOR_SECRET)["tops"] == []
    assert_error(lambda: detail(db, original, viewer), "top_unavailable", 404)
    visible, _ = write(db, "visibility", original, visibility="server_shared")
    actions = detail(db, visible, viewer)["allowed_actions"]
    assert actions["can_read"] and actions["can_view_sharing"] and actions["can_request_edit"] and actions["can_copy"]
    assert all(actions[key] is False for key in (
        "can_edit", "can_rename", "can_add", "can_remove", "can_reorder", "can_delete", "can_share"))
    assert [top["top_ref"] for top in db.service.list(db.context(viewer), cursor_secret=CURSOR_SECRET)["tops"]] == [original["top_ref"]]
    granted, _ = write(db, "grant_editor", visible, account_id=viewer.account_id, role="editor")
    private, _ = write(db, "visibility", granted, visibility="private")
    actions = detail(db, private, viewer)["allowed_actions"]
    assert all(actions[key] for key in ("can_read", "can_edit", "can_rename", "can_add", "can_remove", "can_reorder", "can_copy"))
    assert not actions["can_delete"] and not actions["can_share"] and not actions["can_request_edit"]
    saved, _ = write(db, "save", private, actor=viewer, title="Viewer edits explicit grant", description="Shared subtitle")
    assert detail(db, saved)["title"] == "Viewer edits explicit grant"
    assert detail(db, saved)["description"] == "Shared subtitle"


def test_explicit_editor_can_mutate_items_but_never_delete_or_manage_access(db):
    editor = member(db, grants=("capability.view", "capability.play"))
    original, _ = db.create(refs=[])
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    added, _ = write(db, "add", granted, actor=editor, album_refs=db.album_refs)
    rows = detail(db, added, editor)["items"]
    reordered, _ = write(db, "reorder", added, actor=editor, item_order=[row["ref"] for row in reversed(rows)])
    removed, _ = write(db, "remove", reordered, actor=editor, item_refs=[rows[1]["ref"]])
    assert [row["ref"] for row in detail(db, removed)["items"]] == [rows[2]["ref"], rows[0]["ref"]]
    before = snapshot(db)
    for action, data in (("delete", {}), ("visibility", {"visibility": "server_shared"}),
        ("grant_editor", {"account_id": db.owner.account_id, "role": "editor"}),
        ("revoke_editor", {"grant_ref": granted["grant_ref"]})):
        assert_error(lambda: write(db, action, removed, actor=editor, **data), "forbidden", 403)
    for read in (db.service.read_access, db.service.read_access_candidates):
        assert_error(lambda: read(db.context(editor), original["top_ref"], cursor_secret=CURSOR_SECRET), "forbidden", 403)
    assert snapshot(db) == before


def test_revoke_editor_removes_private_read_and_exact_editor_replay(db):
    editor = member(db)
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    edited, command = write(db, "save", granted, actor=editor, title="Authorized editor change")
    revoked, revoke = write(db, "revoke_editor", edited, grant_ref=granted["grant_ref"])
    before = snapshot(db)
    assert db.service.execute(db.context(), revoke) == revoked
    assert_error(lambda: detail(db, edited, editor), "top_unavailable", 404)
    assert_error(lambda: db.service.execute(db.context(editor), command), "top_unavailable", 404)
    assert db.service.list(db.context(editor), cursor_secret=CURSOR_SECRET)["tops"] == []
    assert snapshot(db) == before


def test_duplicate_grant_same_visibility_and_exact_retry_do_not_inflate_revision(db):
    editor = member(db)
    original, _ = db.create()
    granted, command = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    assert granted["revision"] == str(int(original["revision"]) + 1)
    before = snapshot(db)
    assert db.service.execute(db.context(), command) == granted
    assert snapshot(db) == before
    duplicate, _ = write(db, "grant_editor", granted, account_id=editor.account_id, role="editor")
    unchanged, _ = write(db, "visibility", duplicate, visibility="private")
    assert duplicate["grant_ref"] == granted["grant_ref"]
    assert unchanged["revision"] == duplicate["revision"] == granted["revision"]
    assert len(db.service.read_access(db.context(), original["top_ref"])["grants"]) == 1


@pytest.mark.parametrize("state", ["owner", "nonmember", "disabled", "foreign_library"])
def test_editor_target_must_be_an_active_other_current_library_member(db, state):
    target = member(db)
    with db.connect() as connection:
        if state == "owner":
            target = db.owner
        elif state == "disabled":
            connection.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s", (target.account_id,))
        else:
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (target.account_id, db.library))
            if state == "foreign_library":
                other = db.library_for(connection, target)
                db.member(connection, target, other)
    original, _ = db.create()
    before = snapshot(db)
    assert_error(lambda: write(db, "grant_editor", original, account_id=target.account_id, role="editor"),
                 "invalid_editor" if state == "owner" else "grant_target_unavailable", 409 if state == "owner" else 404)
    assert snapshot(db) == before


def test_member_rejoin_does_not_restore_deleted_editor_grant(db):
    editor = member(db)
    original, _ = db.create()
    write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    with db.connect() as connection:
        connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (editor.account_id, db.library))
        connection.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')", (editor.account_id, db.library))
    assert db.service.read_access(db.context(), original["top_ref"])["grants"] == []
    assert_error(lambda: detail(db, original, editor), "top_unavailable", 404)


@pytest.mark.parametrize("action", [MANAGE, ITEMS, ACCESS])
def test_action_and_top_resource_constraints_narrow_current_authority(db, action):
    editor = member(db)
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    actor = db.owner if action == ACCESS else editor
    command = db.command("visibility" if action == ACCESS else "save" if action == MANAGE else "add", granted,
        **({"visibility": "server_shared"} if action == ACCESS else {"title": "Denied"} if action == MANAGE else {"album_refs": db.album_refs[2:]}))
    observed = []
    def constraints(context):
        observed.append((context.action, context.resource))
        return PolicyEvaluationConstraints(request_origin_allowed=not (context.action == action and context.resource is not None))
    before = snapshot(db)
    assert_error(lambda: db.service.execute(db.context(actor), command, constraints=constraints), "forbidden", 403)
    assert any(key == action and resource.resource_ref == original["top_ref"] for key, resource in observed if resource)
    assert snapshot(db) == before


def test_revoked_editor_is_rechecked_after_waiting_for_parent_lock(db, monkeypatch):
    editor = member(db)
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    reached_parent = Event()
    load = db.service._top
    def checkpoint(connection, context, ref, **options):
        if context.actor.account_id == editor.account_id and options.get("write"):
            reached_parent.set()
        return load(connection, context, ref, **options)
    monkeypatch.setattr(db.service, "_top", checkpoint)
    command = db.command("save", granted, title="Must not commit")
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("select ref from app.album_lists where ref=%s for update", (original["top_ref"],))
            future = pool.submit(db.service.execute, db.context(editor), command)
            assert reached_parent.wait(5), "Editor did not reach the parent lock"
            blocker.execute("delete from app.album_list_access_grants where ref=%s", (granted["grant_ref"],))
        assert_error(lambda: future.result(timeout=10), "top_unavailable", 404)
    assert detail(db, original)["title"] == "Synthetic Top"


def test_current_session_can_replay_top_receipts_created_in_a_previous_session(db):
    editor = member(db)
    original, create = db.create()
    granted, grant = write(db, "grant_editor", original, account_id=editor.account_id, role="editor")
    owner = new_session(db, db.owner)
    with db.connect() as connection:
        connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.owner.session_id,))
    before = snapshot(db)
    assert db.service.execute(db.context(owner), create) == original
    assert db.service.execute(db.context(owner), grant) == granted
    assert snapshot(db) == before


def test_simultaneous_editors_cannot_commit_two_changes_to_one_revision(db):
    first, second = member(db), member(db)
    original, _ = db.create()
    granted, _ = write(db, "grant_editor", original, account_id=first.account_id, role="editor")
    granted, _ = write(db, "grant_editor", granted, account_id=second.account_id, role="editor")
    def execute(editor):
        try:
            return write(db, "save", granted, actor=editor, title=f"Editor {editor.account_id}")[0]
        except AlbumTopError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(execute, (first, second)))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert results.count("revision_conflict") == 1
    assert detail(db, original)["revision"] == str(int(granted["revision"]) + 1)


@pytest.mark.parametrize("action", ["grant_editor", "decide_edit_request"])
def test_target_accounts_are_locked_in_order_before_the_parent_top(db, monkeypatch, action):
    from music_app.services.postgres_connections import pooled_connection

    viewer = member(db)
    original = shared(db)
    payload = {"account_id": viewer.account_id, "role": "editor"}
    if action == "decide_edit_request":
        requested, _ = write(db, "request_edit", original, actor=viewer)
        payload = {"request_ref": requested["request_ref"], "decision": "approve"}
    statements = []
    class Connection:
        def __init__(self, real):
            self.real = real
        def execute(self, sql, params=()):
            result = self.real.execute(sql, params)
            statements.append((" ".join(sql.lower().split()), params))
            return result
    @contextmanager
    def connect(url):
        with pooled_connection(url) as real:
            yield Connection(real)
    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}, connect=connect)
    load = service._top
    parent_checks = []
    def checkpoint(connection, context, ref, **options):
        if options.get("write"):
            locks = [(sql, params) for sql, params in statements if "from app.accounts" in sql and "for update" in sql]
            assert locks, "The Top parent cannot be locked before its actor and target accounts"
            assert any("order by id" in sql and {db.owner.account_id, viewer.account_id}.issubset(
                {value for param in params for value in (param if isinstance(param, (tuple, list)) else (param,))})
                for sql, params in locks), "Account locks must include the target in deterministic id order"
            parent_checks.append(ref)
        return load(connection, context, ref, **options)
    monkeypatch.setattr(service, "_top", checkpoint)
    command = db.command(action, original, **payload)
    result = service.execute(db.context(), command)
    assert result["action"] == action and parent_checks == [original["top_ref"]]


def test_target_account_disabled_while_grant_waits_is_rechecked_before_commit(db):
    from music_app.services.postgres_connections import pooled_connection

    viewer = member(db)
    original, _ = db.create()
    reached_accounts = Event()
    class Connection:
        def __init__(self, real):
            self.real = real
        def execute(self, sql, params=()):
            normalized = " ".join(sql.lower().split())
            if "from app.accounts" in normalized and "for update" in normalized:
                reached_accounts.set()
            return self.real.execute(sql, params)
    @contextmanager
    def connect(url):
        with pooled_connection(url) as real:
            yield Connection(real)
    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}, connect=connect)
    command = db.command("grant_editor", original, account_id=viewer.account_id, role="editor")
    before = snapshot(db)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute("select id from app.accounts where id=%s for update", (viewer.account_id,))
            future = pool.submit(service.execute, db.context(), command)
            assert reached_accounts.wait(5), "Grant did not reach its ordered account locks"
            blocker.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s", (viewer.account_id,))
        assert_error(lambda: future.result(timeout=10), "grant_target_unavailable", 404)
    assert snapshot(db) == before


def test_collaboration_tables_have_only_private_minimum_runtime_privileges(db):
    expected = {"app.album_list_access_grants": {"SELECT", "INSERT", "DELETE"},
                "app.album_list_edit_requests": {"SELECT", "INSERT", "UPDATE"}}
    with db.connect() as connection:
        for table, allowed in expected.items():
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                actual = connection.execute("""select has_table_privilege('album_haven_app',%s,%s) as app,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly""", (table, privilege, table, privilege)).fetchone()
                assert actual == {"app": privilege in allowed, "readonly": False}, (table, privilege, actual)
            assert connection.execute("""select count(*) as n from pg_class c cross join lateral
                aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p
                where c.oid=%s::regclass and p.grantee=0""", (table,)).fetchone()["n"] == 0
        for privilege in ("USAGE", "SELECT", "UPDATE"):
            actual = connection.execute("""select has_sequence_privilege('album_haven_app',
                'app.album_list_edit_requests_id_seq',%s) as app, has_sequence_privilege('album_haven_readonly',
                'app.album_list_edit_requests_id_seq',%s) as readonly""", (privilege, privilege)).fetchone()
            assert actual == {"app": privilege == "USAGE", "readonly": False}
