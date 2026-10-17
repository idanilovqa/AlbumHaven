"""Confirmed-version contracts over an admitted, isolated PostgreSQL database."""

from contextlib import contextmanager
from dataclasses import replace
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from test_owned_album_tops_postgres import BROWSE, assert_error, db, urls


@pytest.fixture
def confirmed_versions(db):
    # Fixture evidence explicitly confirms this version. Inventory admission must
    # never infer equivalence from the shared display title or edition metadata.
    with db.connect() as connection:
        version = connection.execute("""insert into library.local_albums
            (library_id,artist_id,album_key,title,release_year,metadata)
            select library_id,artist_id,%s,title,release_year,
                '{"edition":"Synthetic confirmed alternate version"}'::jsonb
            from library.local_albums where id=%s returning id""",
            (uuid4().hex, db.album_ids[0])).fetchone()["id"]
        connection.execute("""insert into library.catalog_album_links
            (library_id,local_album_id,catalog_ref) values(%s,%s,%s)""",
            (db.library, version, db.album_refs[0]))
    return db, (db.album_ids[0], version)


def _ordered_catalog_service(db, *, reverse):
    """Vary only real SQL row order; preserve the runtime role and transaction."""
    import psycopg
    from psycopg.rows import dict_row

    observed = []

    class CatalogRows:
        def __init__(self, cursor):
            self.cursor = cursor

        def fetchall(self):
            rows = sorted(self.cursor.fetchall(), key=lambda row: row["local_album_id"], reverse=reverse)
            observed.extend(row["local_album_id"] for row in rows)
            return rows

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            cursor = self.real.execute(sql, params)
            if "from library.catalog_album_links l join library.local_albums a" in " ".join(sql.lower().split()):
                return CatalogRows(cursor)
            return cursor

    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as real:
            yield Connection(real)

    service = PostgresOwnedAlbumTopsService({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}, connect=connect)
    return service, observed


def test_confirmed_versions_make_one_membership_without_merging_same_title_refs(confirmed_versions):
    db, versions = confirmed_versions
    refs = [db.album_refs[2], db.album_refs[0], db.album_refs[1]]
    receipt, command = db.create(refs=refs)
    before = db.snapshot()
    assert db.service.execute(db.context(), command) == receipt
    assert db.snapshot() == before
    rows = db.read(receipt)["items"]
    assert [row["catalog_ref"] for row in rows] == refs
    assert len({row["catalog_ref"] for row in rows}) == 3
    assert {row["title"] for row in rows} == {"Same display title"}
    assert [row["original_position"] for row in rows] == [1, 2, 3]
    assert [row["curator_position"] for row in rows] == [1, 2, 3]
    assert len(before["tops"]) == len(before["operations"]) == 1
    with db.connect() as connection:
        links = connection.execute("""select local_album_id from library.catalog_album_links
            where library_id=%s and catalog_ref=%s order by local_album_id""",
            (db.library, db.album_refs[0])).fetchall()
    assert [row["local_album_id"] for row in links] == list(versions)


def test_inventory_admission_preserves_confirmed_and_independent_existing_identities(confirmed_versions):
    db, versions = confirmed_versions
    with db.connect() as connection:
        before = connection.execute("""select * from library.catalog_album_links
            where library_id=%s order by local_album_id""", (db.library,)).fetchall()
    for album in versions:
        assert db.service.admit_inventory_album(db.context(), album_id=album) == {"album_ref": db.album_refs[0]}
    for album, ref in zip(db.album_ids[1:], db.album_refs[1:]):
        assert db.service.admit_inventory_album(db.context(), album_id=album) == {"album_ref": ref}
    with db.connect() as connection:
        after = connection.execute("""select * from library.catalog_album_links
            where library_id=%s order by local_album_id""", (db.library,)).fetchall()
    assert after == before


@pytest.mark.parametrize("denied_index", [0, 1])
def test_inventory_admission_cannot_borrow_a_sibling_versions_browse_permission(confirmed_versions, denied_index):
    db, versions = confirmed_versions
    denied_album = versions[denied_index]

    def constraints(context):
        denied = (context.action == BROWSE and context.resource is not None
                  and context.resource.resource_kind == "album"
                  and context.resource.resource_ref == str(denied_album))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    assert db.service.admit_inventory_album(db.context(), album_id=versions[1 - denied_index],
        constraints=constraints) == {"album_ref": db.album_refs[0]}
    before = db.snapshot()
    assert_error(lambda: db.service.admit_inventory_album(db.context(), album_id=denied_album,
        constraints=constraints), "forbidden", 403)
    assert db.snapshot() == before


@pytest.mark.parametrize("action", ["create", "add"])
@pytest.mark.parametrize("reverse", [False, True], ids=["denied-first", "allowed-first"])
def test_one_authorized_version_admits_canonical_album_in_either_row_order(confirmed_versions, action, reverse):
    db, versions = confirmed_versions
    if action == "create":
        command = db.create_command(refs=db.album_refs[:1])
        expected = db.album_refs[:1]
    else:
        receipt, _ = db.create(refs=db.album_refs[1:2])
        command = db.command("add", receipt, album_refs=db.album_refs[:1])
        expected = [db.album_refs[1], db.album_refs[0]]
    service, observed = _ordered_catalog_service(db, reverse=reverse)

    def constraints(context):
        denied = (context.action == BROWSE and context.resource is not None
                  and context.resource.resource_kind == "album"
                  and context.resource.resource_ref == str(versions[0]))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    receipt = service.execute(db.context(), command, constraints=constraints)
    assert observed == sorted(versions, reverse=reverse)
    assert [row["catalog_ref"] for row in db.read(receipt)["items"]] == expected


@pytest.mark.parametrize("action", ["create", "add"])
@pytest.mark.parametrize("denied_constraint", ["deployment_allowed", "client_surface_allowed", "request_origin_allowed"])
def test_all_versions_denied_rolls_back_entire_selection(confirmed_versions, action, denied_constraint):
    db, versions = confirmed_versions
    refs = [db.album_refs[1], db.album_refs[0]]
    if action == "create":
        command = db.create_command(refs=refs)
    else:
        receipt, _ = db.create(refs=db.album_refs[2:3])
        command = db.command("add", receipt, album_refs=refs)
    before = db.snapshot()

    def constraints(context):
        denied = (context.action == BROWSE and context.resource is not None
                  and context.resource.resource_kind == "album"
                  and context.resource.resource_ref in {str(album) for album in versions})
        return PolicyEvaluationConstraints(**{denied_constraint: not denied})

    assert_error(lambda: db.service.execute(db.context(), command, constraints=constraints), "forbidden", 403)
    assert db.snapshot() == before


def test_allowed_version_does_not_hide_malformed_constraints_on_another_version(confirmed_versions):
    db, versions = confirmed_versions
    service, observed = _ordered_catalog_service(db, reverse=True)
    before = db.snapshot()

    def constraints(context):
        if (context.action == BROWSE and context.resource is not None
                and context.resource.resource_kind == "album"
                and context.resource.resource_ref == str(versions[0])):
            return object()
        return PolicyEvaluationConstraints()

    with pytest.raises(RuntimeError, match="Private library policy constraints are invalid"):
        service.execute(db.context(), db.create_command(refs=db.album_refs[:1]), constraints=constraints)
    assert observed == list(reversed(versions))
    assert db.snapshot() == before


@pytest.mark.parametrize("authority", ["current_library", "membership", "session", "browse"])
def test_confirmed_versions_do_not_bypass_current_authority_or_replay_checks(confirmed_versions, authority):
    db, _ = confirmed_versions
    _, replay = db.create(refs=db.album_refs[:1])
    context = db.context()
    with db.connect() as connection:
        if authority == "current_library":
            other_library = db.library_for(connection, db.owner)
            context = replace(context, library_id=other_library)
        elif authority == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                (db.owner.account_id, db.library))
        elif authority == "session":
            connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.owner.session_id,))
        else:
            connection.execute("""update app.capabilities set revoked_at=now()
                where account_id=%s and capability_key=%s""", (db.owner.account_id, BROWSE))
    before = db.snapshot()
    fresh = db.create_command(refs=db.album_refs[:1])
    for command in (fresh, replay):
        assert_error(lambda: db.service.execute(context, command), "forbidden", 403)
        assert db.snapshot() == before


@pytest.mark.parametrize("foreign_link", [False, True], ids=["no-local-link", "other-library-only"])
def test_catalog_identity_without_current_library_link_cannot_admit_any_selection(confirmed_versions, foreign_link):
    db, _ = confirmed_versions
    unavailable = str(uuid4())
    db.album_refs.append(unavailable)
    with db.connect() as connection:
        connection.execute("""insert into catalog.release_groups(ref,title,artist_display,release_year)
            values(%s,'Same display title','Synthetic artist',2000)""", (unavailable,))
        if foreign_link:
            other_library = db.library_for(connection, db.owner)
            album = connection.execute("""insert into library.local_albums(library_id,album_key,title)
                values(%s,%s,'Same display title') returning id""",
                (other_library, uuid4().hex)).fetchone()["id"]
            connection.execute("""insert into library.catalog_album_links(library_id,local_album_id,catalog_ref)
                values(%s,%s,%s)""", (other_library, album, unavailable))
    before = db.snapshot()
    command = db.create_command(refs=[db.album_refs[0], unavailable])
    assert_error(lambda: db.service.execute(db.context(), command), "album_unavailable", 409)
    assert db.snapshot() == before


def test_link_cannot_claim_a_local_album_from_another_library(confirmed_versions):
    import psycopg

    db, _ = confirmed_versions
    with db.connect() as connection:
        other_library = db.library_for(connection, db.owner)
        album = connection.execute("""insert into library.local_albums(library_id,album_key,title)
            values(%s,%s,'Synthetic unlinked album') returning id""",
            (db.library, uuid4().hex)).fetchone()["id"]
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        with db.connect() as connection:
            connection.execute("""insert into library.catalog_album_links(library_id,local_album_id,catalog_ref)
                values(%s,%s,%s)""", (other_library, album, db.album_refs[0]))
    with db.connect() as connection:
        assert connection.execute("select * from library.catalog_album_links where local_album_id=%s",
            (album,)).fetchone() is None


def test_one_local_version_cannot_link_to_two_canonical_albums(confirmed_versions):
    import psycopg

    db, versions = confirmed_versions
    with pytest.raises(psycopg.errors.UniqueViolation):
        with db.connect() as connection:
            connection.execute("""insert into library.catalog_album_links(library_id,local_album_id,catalog_ref)
                values(%s,%s,%s)""", (db.library, versions[1], db.album_refs[1]))
    assert db.service.admit_inventory_album(db.context(), album_id=versions[1]) == {"album_ref": db.album_refs[0]}


def test_multiple_versions_do_not_relax_duplicate_membership_conflicts(confirmed_versions):
    import psycopg

    db, _ = confirmed_versions
    receipt, _ = db.create(refs=db.album_refs[:1])
    before = db.snapshot()
    command = db.command("add", receipt, album_refs=[db.album_refs[1], db.album_refs[0]])
    assert_error(lambda: db.service.execute(db.context(), command), "duplicate_album", 409)
    assert db.snapshot() == before
    # The durable guard remains independent of the service's duplicate check.
    with pytest.raises(psycopg.errors.UniqueViolation):
        with db.connect() as connection:
            connection.execute("""insert into app.album_list_items
                (ref,top_ref,library_id,catalog_ref,original_position,curator_position)
                values(%s,%s,%s,%s,2,2)""",
                (str(uuid4()), receipt["top_ref"], db.library, db.album_refs[0]))
    assert db.snapshot() == before


def test_versioned_membership_reorder_remove_readd_and_exact_retry_keep_item_identity(confirmed_versions):
    db, _ = confirmed_versions
    receipt, _ = db.create(refs=db.album_refs[:2])
    versioned, independent = db.read(receipt)["items"]
    reordered = db.service.execute(db.context(), db.command("reorder", receipt,
        item_order=[independent["ref"], versioned["ref"]]))
    rows = db.read(reordered)["items"]
    assert [(row["ref"], row["original_position"], row["curator_position"]) for row in rows] == [
        (independent["ref"], 2, 1), (versioned["ref"], 1, 2)]
    removed = db.service.execute(db.context(), db.command("remove", reordered, item_refs=[versioned["ref"]]))
    add = db.command("add", removed, album_refs=db.album_refs[:1])
    added = db.service.execute(db.context(), add)
    before = db.snapshot()
    assert db.service.execute(db.context(), add) == added
    assert db.snapshot() == before
    rows = db.read(added)["items"]
    assert [row["catalog_ref"] for row in rows] == [db.album_refs[1], db.album_refs[0]]
    assert [row["original_position"] for row in rows] == [2, 3]
    assert [row["curator_position"] for row in rows] == [1, 2]
    assert rows[0]["ref"] == independent["ref"]
    assert rows[1]["ref"] != versioned["ref"]
    assert added["revision"] == "4"
    assert len(before["operations"]) == 4
