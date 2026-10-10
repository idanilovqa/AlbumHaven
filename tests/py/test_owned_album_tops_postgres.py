"""Real SQL contracts; execution requires an admitted synthetic PostgreSQL DB."""

from contextlib import contextmanager
import base64
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.owned_album_tops import AlbumTopError, normalize_top_command
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


BROWSE = "library.browse.read"
CREATE = "library.album_tops.create"
MANAGE = "library.album_tops.manage"
ITEMS = "library.album_tops.items.manage"
ACTIONS = (BROWSE, CREATE, MANAGE, ITEMS)
BIGINT_MAX = 9223372036854775807
CURSOR_SECRET = "synthetic-album-top-pagination-key-32-bytes"
OWNER_ACTIONS = {
    BROWSE: True, MANAGE: True, ITEMS: True,
    "can_read": True, "can_edit": True, "can_rename": True, "can_add": True,
    "can_remove": True, "can_reorder": True, "can_delete": True, "can_share": True,
    "can_view_sharing": True, "can_request_edit": False, "can_copy": True,
}


@pytest.fixture(scope="module")
def urls():
    app = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")
    setup = os.environ.get("DATABASE_MIGRATOR_URL", "")
    if not app:
        pytest.skip("Requires admitted synthetic PostgreSQL; live SQL was not exercised")
    a, s = urlparse(app), urlparse(setup)
    assert a.scheme in {"postgres", "postgresql"} and s.scheme in {"postgres", "postgresql"}
    assert a.hostname in {"127.0.0.1", "localhost", "::1"}
    assert (a.hostname, a.port, a.path) == (s.hostname, s.port, s.path)
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", a.path.lstrip("/"))
    assert not a.query and not s.query
    return app, setup


class Database:
    def __init__(self, urls):
        self.app_url, self.setup_url = urls
        self.now = datetime.now(timezone.utc)
        self.token = uuid4().hex
        self.service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": self.app_url})
        self.account_ids = []
        self.library_ids = []
        self.album_refs = []
        self.album_ids = []

    def connect(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.setup_url, row_factory=dict_row)

    def actor(self, connection):
        name = "top-" + uuid4().hex
        account = connection.execute("""insert into app.accounts(display_name,account_kind,
            username_display,username_normalized,contact_email,contact_email_normalized)
            values(%s,'managed_user',%s,%s,%s,%s) returning id""",
            (name, name, name, name + "@example.test", name + "@example.test")).fetchone()["id"]
        self.account_ids.append(account)
        session = connection.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""",
            (account, hashlib.sha256(uuid4().bytes).digest(), self.now, self.now, self.now,
             self.now + timedelta(hours=1), self.now + timedelta(days=1))).fetchone()["id"]
        return CurrentActor(state=ActorState.ACTIVE, account_id=account, session_id=session,
                            authenticated_at=self.now)

    def library_for(self, connection, actor):
        library = connection.execute("""insert into library.libraries(owner_account_id,name)
            values(%s,%s) returning id""", (actor.account_id, "Top " + uuid4().hex)).fetchone()["id"]
        self.library_ids.append(library)
        return library

    def member(self, connection, actor, library):
        connection.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
            values(%s,%s,'member')""", (actor.account_id, library))
        for action in ACTIONS:
            connection.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
                values(%s,%s,'library',%s)""", (actor.account_id, action, library))
        return replace(actor, current_library_id=library,
            library_relationships=(LibraryRelationship(library, "member", False),),
            capability_grants=tuple(CapabilityGrant(action, "library", library) for action in ACTIONS))

    def context(self, actor=None):
        actor = actor or self.owner
        return PolicyContext.build(actor=actor, action=BROWSE, library_id=actor.current_library_id,
            target_account_id=actor.account_id, deployment_mode="self_hosted",
            request_origin=RequestOrigin("network", "synthetic:top-contract"), client_surface_class="private_web")

    def create_command(self, *, refs=None, request_key=None):
        return normalize_top_command("create", {"request_key": request_key or str(uuid4()),
            "title": "Synthetic Top", "description": "Authored description",
            "album_refs": self.album_refs[:2] if refs is None else refs})

    def create(self, *, refs=None):
        command = self.create_command(refs=refs)
        return self.service.execute(self.context(), command), command

    def command(self, action, receipt, **changes):
        return normalize_top_command(action, {"request_key": str(uuid4()),
            "revision": receipt["revision"], **changes}, top_ref=receipt["top_ref"])

    def read(self, receipt):
        return self.service.read(self.context(), top_ref=receipt["top_ref"])

    def snapshot(self):
        with self.connect() as connection:
            return {
                "tops": connection.execute("select * from app.album_lists where library_id=%s order by ref", (self.library,)).fetchall(),
                "items": connection.execute("select * from app.album_list_items where library_id=%s order by ref", (self.library,)).fetchall(),
                "operations": connection.execute("select * from app.album_list_operations where library_id=%s order by request_key", (self.library,)).fetchall(),
            }

    def close(self):
        with self.connect() as connection:
            for library in reversed(self.library_ids):
                connection.execute("delete from app.album_list_operations where library_id=%s", (library,))
                connection.execute("delete from app.album_lists where library_id=%s", (library,))
                connection.execute("delete from library.libraries where id=%s", (library,))
            for ref in self.album_refs:
                connection.execute("delete from catalog.release_groups where ref=%s", (ref,))
            for account in self.account_ids:
                connection.execute("delete from app.accounts where id=%s", (account,))


@pytest.fixture
def db(urls):
    database = Database(urls)
    try:
        with database.connect() as connection:
            owner = database.actor(connection)
            database.library = database.library_for(connection, owner)
            database.owner = database.member(connection, owner, database.library)
            artist = connection.execute("""insert into library.local_artists(library_id,artist_key,name)
                values(%s,%s,'Synthetic artist') returning id""", (database.library, database.token)).fetchone()["id"]
            for index in range(3):
                album = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata)
                    values(%s,%s,%s,'Same display title',2000,%s::jsonb) returning id""",
                    (database.library, artist, f"{database.token}:{index}", json.dumps({"edition": f"Synthetic edition {index}"}))).fetchone()["id"]
                database.album_ids.append(album)
        for album in database.album_ids:
            admitted = database.service.admit_inventory_album(database.context(), album_id=album)
            database.album_refs.append(admitted["album_ref"])
        yield database
    finally:
        database.close()


def assert_error(callback, code, status):
    with pytest.raises(AlbumTopError) as caught:
        callback()
    assert (caught.value.code, caught.value.status_code) == (code, status)


def test_inventory_admission_is_stable_but_does_not_deduplicate_display_titles(db):
    again = db.service.admit_inventory_album(db.context(), album_id=db.album_ids[0])
    assert again == {"album_ref": db.album_refs[0]}
    assert len(set(db.album_refs)) == 3
    with db.connect() as connection:
        rows = connection.execute("select catalog_ref from library.catalog_album_links where library_id=%s", (db.library,)).fetchall()
    assert {str(row["catalog_ref"]) for row in rows} == set(db.album_refs)


def test_create_read_and_exact_replay_preserve_authored_order_and_one_receipt(db):
    receipt, command = db.create(refs=list(reversed(db.album_refs)))
    before = db.snapshot()
    assert db.service.execute(db.context(), command) == receipt
    assert db.snapshot() == before
    assert len(before["tops"]) == len(before["operations"]) == 1
    detail = db.read(receipt)
    assert detail["revision"] == "1"
    assert detail["visibility"] == "private"
    assert detail["allowed_actions"] == OWNER_ACTIONS
    assert [row["catalog_ref"] for row in detail["items"]] == list(reversed(db.album_refs))
    assert [row["original_position"] for row in detail["items"]] == [1, 2, 3]
    assert [row["curator_position"] for row in detail["items"]] == [1, 2, 3]
    assert set(detail) == {"top_ref", "title", "description", "revision", "visibility", "allowed_actions", "items"}
    for item in detail["items"]:
        assert set(item) == {"ref", "catalog_ref", "original_position", "curator_position",
                             "title", "artist_display", "release_year"}
    assert "local_album_id" not in json.dumps(detail)


def test_empty_top_can_be_created_and_read(db):
    receipt, _ = db.create(refs=[])
    assert db.read(receipt)["items"] == []
    assert len(db.snapshot()["operations"]) == 1


def test_reused_request_key_with_changed_body_cannot_modify_the_committed_top(db):
    receipt, command = db.create()
    before = db.snapshot()
    changed = normalize_top_command("create", {**command.data, "request_key": command.request_key, "title": "Different"})
    assert_error(lambda: db.service.execute(db.context(), changed), "request_key_conflict", 409)
    assert db.snapshot() == before
    assert db.read(receipt)["title"] == "Synthetic Top"


def test_stale_revision_is_rejected_without_an_operation_receipt(db):
    receipt, _ = db.create()
    saved = db.service.execute(db.context(), db.command("save", receipt, title="New title"))
    before = db.snapshot()
    stale = db.command("save", receipt, description="Stale change")
    assert_error(lambda: db.service.execute(db.context(), stale), "revision_conflict", 409)
    assert db.snapshot() == before
    assert db.read(saved)["description"] == "Authored description"


def test_canonical_duplicate_membership_is_rejected_atomically(db):
    receipt, _ = db.create(refs=db.album_refs[:1])
    before = db.snapshot()
    command = db.command("add", receipt, album_refs=db.album_refs[:2])
    assert_error(lambda: db.service.execute(db.context(), command), "duplicate_album", 409)
    assert db.snapshot() == before


def test_unknown_catalog_reference_rolls_back_the_new_top(db):
    command = db.create_command(refs=[db.album_refs[0], str(uuid4())])
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(), command), "album_unavailable", 409)
    assert db.snapshot() == before


def test_reorder_remove_and_readd_keep_original_admission_order_separate(db):
    receipt, _ = db.create()
    first, second = db.read(receipt)["items"]
    reordered = db.service.execute(db.context(), db.command("reorder", receipt, item_order=[second["ref"], first["ref"]]))
    rows = db.read(reordered)["items"]
    assert [(row["ref"], row["original_position"], row["curator_position"]) for row in rows] == [
        (second["ref"], 2, 1), (first["ref"], 1, 2)]
    removed = db.service.execute(db.context(), db.command("remove", reordered, item_refs=[second["ref"]]))
    survivor = db.read(removed)["items"]
    assert [(row["ref"], row["original_position"], row["curator_position"]) for row in survivor] == [(first["ref"], 1, 1)]
    added = db.service.execute(db.context(), db.command("add", removed, album_refs=[second["catalog_ref"]]))
    rows = db.read(added)["items"]
    assert [row["catalog_ref"] for row in rows] == db.album_refs[:2]
    assert [row["original_position"] for row in rows] == [1, 3]
    assert [row["curator_position"] for row in rows] == [1, 2]
    assert rows[0]["ref"] == first["ref"] and rows[1]["ref"] != second["ref"]
    assert added["revision"] == "4"


@pytest.mark.parametrize("action", ["remove", "reorder"])
def test_unknown_or_incomplete_item_selection_cannot_mutate_membership(db, action):
    receipt, _ = db.create()
    rows = db.read(receipt)["items"]
    changes = {"item_refs": [str(uuid4())]} if action == "remove" else {"item_order": [rows[0]["ref"]]}
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(), db.command(action, receipt, **changes)), "items_changed", 409)
    assert db.snapshot() == before


@pytest.mark.parametrize("scope", ["account", "library"])
def test_foreign_account_or_library_cannot_read_or_mutate_a_top(db, scope):
    receipt, _ = db.create()
    with db.connect() as connection:
        actor = db.actor(connection) if scope == "account" else db.owner
        library = db.library if scope == "account" else db.library_for(connection, actor)
        other = db.member(connection, actor, library)
    context = db.context(other)
    before = db.snapshot()
    assert_error(lambda: db.service.read(context, top_ref=receipt["top_ref"]), "top_unavailable", 404)
    assert_error(lambda: db.service.execute(context, db.command("save", receipt, title="Unauthorized")), "top_unavailable", 404)
    assert db.snapshot() == before


@pytest.mark.parametrize("action,capability", [("create", CREATE), ("save", MANAGE), ("add", ITEMS)])
def test_personal_collection_access_survives_revoked_redundant_fine_grained_grant(db, action, capability):
    receipt, create = db.create(refs=db.album_refs[:1])
    command = create if action == "create" else db.command(action, receipt, **(
        {"title": "Saved"} if action == "save" else {"album_refs": db.album_refs[1:2]}))
    original_receipt = receipt if action == "create" else db.service.execute(db.context(), command)
    with db.connect() as connection:
        connection.execute("""update app.capabilities set revoked_at=now() where account_id=%s
            and capability_key=%s and scope_kind='library' and scope_id=%s""", (db.owner.account_id, capability, db.library))
    before = db.snapshot()
    assert db.service.execute(db.context(), command) == original_receipt
    assert db.snapshot() == before
    fresh = (db.create_command(refs=[]) if action == "create" else
             db.command("save", original_receipt, title="Still owned"))
    assert db.service.execute(db.context(), fresh)["action"] == fresh.action


@pytest.mark.parametrize("grants", [("capability.view",), ("capability.view", "capability.play")])
def test_live_viewer_and_listener_grants_support_owned_top_creation_and_editing(db, grants):
    with db.connect() as connection:
        connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (db.owner.account_id,))
        for grant in grants:
            connection.execute("""insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
                values(%s,%s,'library',%s)""", (db.owner.account_id, grant, db.library))
    viewer = replace(db.owner, capability_grants=tuple(CapabilityGrant(grant, "library", db.library) for grant in grants))
    context = db.context(viewer)
    receipt = db.service.execute(context, db.create_command(refs=db.album_refs[:1]))
    saved = db.service.execute(context, db.command("save", receipt, title="Viewer-authored"))
    added = db.service.execute(context, db.command("add", saved, album_refs=db.album_refs[1:2]))
    detail = db.service.read(context, top_ref=receipt["top_ref"])
    assert detail["title"] == "Viewer-authored" and detail["revision"] == added["revision"] == "3"
    assert len(detail["items"]) == 2
    assert detail["allowed_actions"] == OWNER_ACTIONS


def test_action_specific_constraints_are_rechecked_before_replay(db):
    _, command = db.create()
    before = db.snapshot()

    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != CREATE)

    assert_error(lambda: db.service.execute(db.context(), command, constraints=constraints), "forbidden", 403)
    assert db.snapshot() == before


def test_create_replay_rechecks_browse_on_the_retained_top_resource(db):
    receipt, command = db.create()
    before = db.snapshot()
    observed = []

    def constraints(context):
        observed.append((context.action, context.resource))
        denied = (context.action == BROWSE and context.resource is not None
                  and context.resource.resource_kind == "album_top"
                  and context.resource.resource_ref == receipt["top_ref"])
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    assert_error(lambda: db.service.execute(db.context(), command, constraints=constraints), "forbidden", 403)
    assert any(action == BROWSE and resource is not None
               and resource.resource_ref == receipt["top_ref"] for action, resource in observed)
    assert db.snapshot() == before


@pytest.mark.parametrize("operation", ["create", "save", "read", "list", "replay", "admission"])
def test_session_expiry_during_operation_rejects_response_and_rolls_back_before_commit(db, operation):
    import psycopg
    from psycopg.rows import dict_row

    receipt, original = db.create()
    before = db.snapshot()
    observed_now = [db.now]
    advanced = []
    checkpoint = {
        "create": "insert into app.album_list_operations",
        "save": "insert into app.album_list_operations",
        "read": "join catalog.release_groups",
        "list": "and p.deleted_at is null and p.id>",
        "replay": "from app.album_list_operations",
        "admission": "select catalog_ref from library.catalog_album_links",
    }[operation]

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            result = self.real.execute(sql, params)
            if checkpoint in " ".join(sql.lower().split()):
                observed_now[0] = db.now + timedelta(days=2)
                advanced.append(True)
            return result

    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as real:
            yield Connection(real)

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url},
        connect=connect, clock=lambda: observed_now[0])
    calls = {
        "create": lambda: service.execute(db.context(), db.create_command()),
        "save": lambda: service.execute(db.context(), db.command("save", receipt, title="Must roll back")),
        "read": lambda: service.read(db.context(), top_ref=receipt["top_ref"]),
        "list": lambda: service.list(db.context(), cursor_secret=CURSOR_SECRET),
        "replay": lambda: service.execute(db.context(), original),
        "admission": lambda: service.admit_inventory_album(db.context(), album_id=db.album_ids[0]),
    }
    assert_error(calls[operation], "forbidden", 403)
    assert advanced == [True], "The operation must reach its post-authority expiry checkpoint"
    assert db.snapshot() == before


def test_expired_session_rolls_back_new_catalog_identity_and_inventory_link(db):
    import psycopg
    from psycopg.rows import dict_row

    title = "Expiry admission " + db.token
    with db.connect() as connection:
        artist = connection.execute("select artist_id from library.local_albums where id=%s", (db.album_ids[0],)).fetchone()["artist_id"]
        album = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title,release_year)
            values(%s,%s,%s,%s,2000) returning id""", (db.library, artist, uuid4().hex, title)).fetchone()["id"]
    observed_now = [db.now]
    inserted_refs = []

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            result = self.real.execute(sql, params)
            if "insert into library.catalog_album_links" in " ".join(sql.lower().split()):
                inserted_refs.append(params[2])
                observed_now[0] = db.now + timedelta(days=2)
            return result

    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as real:
            yield Connection(real)

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url},
        connect=connect, clock=lambda: observed_now[0])
    assert_error(lambda: service.admit_inventory_album(db.context(), album_id=album), "forbidden", 403)
    assert len(inserted_refs) == 1
    # Track any leaked identity for fixture cleanup even when this assertion fails.
    db.album_refs.extend(inserted_refs)
    with db.connect() as connection:
        assert connection.execute("select ref from catalog.release_groups where ref=%s", (inserted_refs[0],)).fetchone() is None
        assert connection.execute("select catalog_ref from library.catalog_album_links where local_album_id=%s", (album,)).fetchone() is None


@pytest.mark.parametrize("revoked", ["membership", "session", "browse"])
def test_live_authority_revocation_rejects_cached_context_and_receipt(db, revoked):
    receipt, command = db.create()
    with db.connect() as connection:
        if revoked == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (db.owner.account_id, db.library))
        elif revoked == "session":
            connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.owner.session_id,))
        else:
            connection.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key=%s", (db.owner.account_id, BROWSE))
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(), command), "forbidden", 403)
    assert_error(lambda: db.service.read(db.context(), top_ref=receipt["top_ref"]), "forbidden", 403)
    assert db.snapshot() == before


def test_delete_is_soft_and_its_exact_receipt_can_be_replayed(db):
    receipt, _ = db.create()
    command = db.command("delete", receipt)
    deleted = db.service.execute(db.context(), command)
    before = db.snapshot()
    assert deleted["revision"] == "2"
    assert before["tops"][0]["deleted_at"] is not None
    assert len(before["items"]) == 2
    assert db.service.execute(db.context(), command) == deleted
    assert_error(lambda: db.service.read(db.context(), top_ref=receipt["top_ref"]), "top_unavailable", 404)
    assert_error(lambda: db.service.execute(db.context(), db.command("save", deleted, title="Revive")), "top_unavailable", 404)
    assert db.snapshot() == before


@pytest.mark.parametrize("field,action,error", [("revision", "save", "revision_exhausted"),
                                              ("next_original_position", "add", "position_exhausted")])
def test_bigint_exhaustion_returns_conflict_without_partial_writes(db, field, action, error):
    receipt, _ = db.create(refs=[])
    with db.connect() as connection:
        if field == "revision":
            connection.execute("update app.album_lists set revision=%s where ref=%s", (BIGINT_MAX, receipt["top_ref"]))
            receipt = {**receipt, "revision": str(BIGINT_MAX)}
        else:
            connection.execute("update app.album_lists set next_original_position=%s where ref=%s", (BIGINT_MAX, receipt["top_ref"]))
    changes = {"title": "Overflow"} if action == "save" else {"album_refs": db.album_refs[:1]}
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(), db.command(action, receipt, **changes)), error, 409)
    assert db.snapshot() == before


@pytest.mark.parametrize("fault,after", [("insert into app.album_list_items", False),
                                       ("insert into app.album_list_operations", False),
                                       ("insert into app.album_list_operations", True)])
def test_failure_after_top_insert_rolls_back_items_revision_and_receipt(db, fault, after):
    import psycopg
    from psycopg.rows import dict_row

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            selected = fault in " ".join(sql.split()).lower()
            if selected and not after:
                raise RuntimeError("injected owned Top fault")
            result = self.real.execute(sql, params)
            if selected and after:
                raise RuntimeError("injected owned Top fault")
            return result

    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as real:
            yield Connection(real)

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}, connect=connect)
    command = db.create_command()
    before = db.snapshot()
    with pytest.raises(RuntimeError, match="injected owned Top fault"):
        service.execute(db.context(), command)
    assert db.snapshot() == before
    receipt = db.service.execute(db.context(), command)
    assert len(db.snapshot()["tops"]) == len(db.snapshot()["operations"]) == 1
    assert len(db.read(receipt)["items"]) == 2


def test_index_paginates_without_duplicates_and_excludes_deleted_and_foreign_tops(db):
    receipts = [db.create(refs=[])[0] for _ in range(4)]
    db.service.execute(db.context(), db.command("delete", receipts[1]))
    with db.connect() as connection:
        other = db.member(connection, db.actor(connection), db.library)
    foreign = db.service.execute(db.context(other), db.create_command(refs=[]))
    first = db.service.list(db.context(), limit=2, cursor_secret=CURSOR_SECRET)
    assert [top["top_ref"] for top in first["tops"]] == [receipts[0]["top_ref"], receipts[2]["top_ref"]]
    assert first["allowed_actions"] == {BROWSE: True, CREATE: True, "can_create": True}
    assert isinstance(first["next_cursor"], str)
    encrypted = base64.urlsafe_b64decode(first["next_cursor"])
    assert b"album-top-index-v1" not in encrypted and b'"position"' not in encrypted
    second = db.service.list(db.context(), limit=2, cursor=first["next_cursor"], cursor_secret=CURSOR_SECRET)
    assert [top["top_ref"] for top in second["tops"]] == [receipts[3]["top_ref"]]
    assert second["next_cursor"] is None
    for top in first["tops"] + second["tops"]:
        assert set(top) == {"top_ref", "title", "description", "revision", "visibility", "allowed_actions"}
        assert top["top_ref"] != foreign["top_ref"]
        assert top["allowed_actions"] == OWNER_ACTIONS


@pytest.mark.parametrize("scope", ["account", "session", "library"])
def test_index_cursor_is_bound_to_account_session_and_active_library(db, scope):
    db.create(refs=[])
    db.create(refs=[])
    cursor = db.service.list(db.context(), limit=1, cursor_secret=CURSOR_SECRET)["next_cursor"]
    with db.connect() as connection:
        if scope == "account":
            actor = db.member(connection, db.actor(connection), db.library)
        elif scope == "library":
            actor = db.member(connection, db.owner, db.library_for(connection, db.owner))
        else:
            session = connection.execute("""insert into app.account_sessions(account_id,session_token_hash,
                created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
                values(%s,%s,now(),now(),now(),now()+interval '1 hour',now()+interval '1 day') returning id""",
                (db.owner.account_id, hashlib.sha256(uuid4().bytes).digest())).fetchone()["id"]
            actor = replace(db.owner, session_id=session)
    assert_error(lambda: db.service.list(db.context(actor), cursor=cursor,
                                        cursor_secret=CURSOR_SECRET), "invalid_cursor", 422)


@pytest.mark.parametrize("cursor", ["", "not-an-encrypted-cursor", "x" * 4097, 1, True])
def test_index_rejects_malformed_cursors_without_exposing_rows(db, cursor):
    db.create(refs=[])
    assert_error(lambda: db.service.list(db.context(), cursor=cursor,
                                        cursor_secret=CURSOR_SECRET), "invalid_cursor", 422)


def test_index_rejects_tampered_cursor_and_the_wrong_encryption_key(db):
    db.create(refs=[])
    db.create(refs=[])
    cursor = db.service.list(db.context(), limit=1, cursor_secret=CURSOR_SECRET)["next_cursor"]
    position = len(cursor) // 2
    tampered = cursor[:position] + ("A" if cursor[position] != "A" else "B") + cursor[position + 1:]
    assert_error(lambda: db.service.list(db.context(), cursor=tampered,
                                        cursor_secret=CURSOR_SECRET), "invalid_cursor", 422)
    assert_error(lambda: db.service.list(db.context(), cursor=cursor,
                                        cursor_secret="other-synthetic-pagination-key-32-bytes"), "invalid_cursor", 422)


@pytest.mark.parametrize("limit", [None, True, 0, -1, 101, 1.0, "1"])
def test_index_limit_is_bounded_before_opening_a_connection(limit):
    def forbidden_connection(_url):
        pytest.fail("Invalid limit opened a database connection")

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://synthetic.invalid/unopened"},
                                          connect=forbidden_connection)
    assert_error(lambda: service.list(None, limit=limit, cursor_secret=CURSOR_SECRET), "invalid_query", 422)


@pytest.mark.parametrize("album_id", [None, True, False, 0, -1, "1", 1.0, BIGINT_MAX + 1])
def test_inventory_admission_rejects_malformed_ids_before_opening_a_connection(album_id):
    def forbidden_connection(_url):
        pytest.fail("Invalid album identity opened a database connection")

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://synthetic.invalid/unopened"},
                                          connect=forbidden_connection)
    assert_error(lambda: service.admit_inventory_album(None, album_id=album_id), "invalid_command", 422)


def test_other_library_inventory_and_catalog_references_cannot_be_admitted_or_added(db):
    with db.connect() as connection:
        library = db.library_for(connection, db.owner)
        actor = db.member(connection, db.owner, library)
    context = db.context(actor)
    assert_error(lambda: db.service.admit_inventory_album(context, album_id=db.album_ids[0]), "album_unavailable", 404)
    assert_error(lambda: db.service.execute(context, db.create_command(refs=db.album_refs[:1])), "album_unavailable", 409)
    with db.connect() as connection:
        assert connection.execute("select count(*) as n from app.album_lists where library_id=%s", (library,)).fetchone()["n"] == 0
        assert connection.execute("select count(*) as n from app.album_list_operations where library_id=%s", (library,)).fetchone()["n"] == 0


def test_top_tables_and_sequence_have_only_the_required_private_runtime_grants(db):
    expected = {
        "catalog.release_groups": {"SELECT", "INSERT"},
        "library.catalog_album_links": {"SELECT", "INSERT"},
        "app.album_lists": {"SELECT", "INSERT", "UPDATE"},
        "app.album_list_items": {"SELECT", "INSERT", "UPDATE", "DELETE"},
        "app.album_list_operations": {"SELECT", "INSERT"},
    }
    with db.connect() as connection:
        for table, grants in expected.items():
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                actual = connection.execute("""select has_table_privilege('album_haven_app',%s,%s) as app,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly""",
                    (table, privilege, table, privilege)).fetchone()
                assert actual == {"app": privilege in grants, "readonly": False}, (table, privilege, actual)
            public = connection.execute("""select count(*) as n from pg_class c cross join lateral
                aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p
                where c.oid=%s::regclass and p.grantee=0""", (table,)).fetchone()["n"]
            assert public == 0
        for privilege in ("USAGE", "SELECT", "UPDATE"):
            actual = connection.execute("""select has_sequence_privilege('album_haven_app',
                'app.album_lists_id_seq',%s) as app, has_sequence_privilege('album_haven_readonly',
                'app.album_lists_id_seq',%s) as readonly""", (privilege, privilege)).fetchone()
            assert actual == {"app": privilege in {"USAGE", "SELECT"}, "readonly": False}
        public_sequence = connection.execute("""select count(*) as n from pg_class c cross join lateral
            aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) p
            where c.oid='app.album_lists_id_seq'::regclass and p.grantee=0""").fetchone()["n"]
        assert public_sequence == 0
