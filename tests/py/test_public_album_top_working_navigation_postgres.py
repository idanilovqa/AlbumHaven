"""Same-link working navigation against the admitted real PostgreSQL fixture.

The nonempty publication, SQL authority, immutable seals, named grants and final
session fence are real. The connection observer only records/forwards SQL; its
closed statement allowlist also rejects writes hidden in SELECT functions/CTEs.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import BROWSE
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.public_album_tops_postgres import PostgresPublicAlbumTopsService
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error, CURSOR_SECRET
from tests.py.test_album_top_collaboration_postgres import member, write
from tests.py.test_public_album_top_http_postgres import published


def normalized(sql):
    return " ".join(str(sql).lower().split())


DISCOVER = normalized("""select t.ref,t.owner_account_id,t.library_id,t.deleted_at
    from app.shared_links s join app.album_lists t
      on t.ref=s.top_ref and t.library_id=s.library_id where s.ref=%s""")
ACCOUNT_LOCK = ("with locked_accounts as ( select id from app.accounts "
                "where id in (%s, %s) order by id for update ) "
                "select id from locked_accounts")
SESSION = normalized("""select id, account_id, authenticated_at, idle_expires_at,
    absolute_expires_at, revoked_at from app.account_sessions
    where id = %s and account_id = %s for update""")
PUBLIC_PARENT = normalized("""select ref,owner_account_id,library_id,deleted_at
    from app.album_lists where ref=%s for share""")
WORKING_PARENT = normalized("""select * from app.album_lists where ref=%s
    and library_id=%s for share""")
NAMED_GRANT = normalized("""select ref,role from app.album_list_access_grants
    where top_ref=%s and library_id=%s and account_id=%s""")
LINK = normalized("""select ref,top_ref,library_id,state,active_publication_ref,
    link_revision from app.shared_links where top_ref=%s and library_id=%s for share""")
MANIFEST = normalized("""select count(*) as total,
    count(*) filter(where i.top_ref=%s and i.library_id=%s
        and p.catalog_ref=i.catalog_ref and p.contract_version=1
        and e.library_id=i.library_id and e.capture_builder_version=1
        and s.sealed_at is not null and s.seal_contract_version=1
        and s.library_id=e.library_id and s.selected_source_ref=e.selected_source_ref
        and s.capture_builder_version=e.capture_builder_version and s.evidence_digest=e.evidence_digest
        and s.track_count between 0 and %s and s.content_digest ~ '^[0-9a-f]{64}$') as valid,
    coalesce(sum(s.track_count),0) as total_tracks,
    min(i.curator_position) as first,max(i.curator_position) as last
    from app.album_list_publication_items i
    left join catalog.album_presentation_versions p on p.ref=i.presentation_ref
    left join library.album_presentation_evidence e on e.presentation_ref=i.presentation_ref
    left join library.album_presentation_seals s on s.presentation_ref=i.presentation_ref
    where i.publication_ref=%s""")
RETAINED_SOURCES = normalized("""select distinct e.selected_local_album_id,e.selected_source_ref,
    e.selected_library_root_id from app.album_list_publication_items i
    join library.album_presentation_evidence e on e.presentation_ref=i.presentation_ref
    where i.publication_ref=%s""")

# This is a complete SQL read contract, not implementation of any authority.
# In particular, do not accept arbitrary SELECT/WITH/SET prefixes: a SELECT can
# invoke a mutating capture function, and WITH can contain writes.
READ_STATEMENTS = frozenset({
    DISCOVER, ACCOUNT_LOCK, SESSION, PUBLIC_PARENT, WORKING_PARENT, NAMED_GRANT,
    LINK, MANIFEST, RETAINED_SOURCES,
    "set transaction isolation level read committed",
    "select id,is_active,disabled_at from app.accounts where id=%s",
    "select is_active,disabled_at from app.accounts where id=%s",
    "select account_id from app.bootstrap_owners where account_id=%s and owner_key='local-bootstrap-owner' for share",
    normalized("""select m.membership_role,l.owner_account_id=%s as is_primary_owner
        from library.library_memberships m join library.libraries l on l.id=m.library_id
        where m.account_id=%s and m.library_id=%s for share of m,l"""),
    normalized("""select m.membership_role,l.owner_account_id=%s as is_primary_owner
        from library.library_memberships m join library.libraries l on l.id=m.library_id
        where m.library_id=%s and m.account_id=%s for share of m,l"""),
    normalized("""select capability_key,scope_kind,scope_id from app.capabilities
        where account_id=%s and revoked_at is null order by id for share"""),
    normalized("""select p.ref,p.top_ref,p.library_id,p.approved_by_account_id,
        p.publication_revision,p.contract_version,p.title,p.description,s.item_count
        from app.album_list_publications p join app.album_list_publication_seals s
          on s.publication_ref=p.ref and s.sealed_at is not null
            and s.seal_contract_version=p.contract_version and s.content_digest ~ '^[0-9a-f]{64}$'
        where p.ref=%s and p.top_ref=%s and p.library_id=%s"""),
})


class SQLObserver:
    """Forward every allowed statement to PostgreSQL without altering its result."""
    def __init__(self, connect):
        self.real_connect = connect
        self.opened = []
        self.calls = []
        self.completed = []
        self.unexpected = []
        self.reached_parent = Event()
        self.parent_pid = None

    @contextmanager
    def connect(self, *args, **kwargs):
        observer = self
        # The existing configured fixture applies only its bounded transaction
        # timeouts before yielding this connection. It is not an authority mock.
        with self.real_connect(*args, **kwargs) as real:
            self.opened.append(real.info.backend_pid)

            class Connection:
                def execute(self, sql, params=None):
                    statement = normalized(sql)
                    if statement not in READ_STATEMENTS:
                        observer.unexpected.append(statement)
                        raise AssertionError("Unexpected resolver SQL: " + statement)
                    observer.calls.append((statement, tuple(params or ())))
                    if statement == PUBLIC_PARENT:
                        observer.parent_pid = real.info.backend_pid
                        observer.reached_parent.set()
                    result = real.execute(sql, params)
                    observer.completed.append(statement)
                    return result

                def __getattr__(self, name):
                    return getattr(real, name)

            yield Connection()

    @property
    def statements(self):
        return [statement for statement, _ in self.calls]


def observed_service(database, *, clock=None):
    observer = SQLObserver(database.service._connect)
    service = PostgresOwnedAlbumTopsService(database.service._config,
        connect=observer.connect, clock=clock or database.service._clock)
    return service, observer


def retained(database):
    """Read-only before/after evidence for authored, publication and source state."""
    values = database.snapshot()
    with database.connect() as connection:
        for relation in (
            "app.album_list_access_grants", "app.album_list_edit_requests",
            "app.shared_links", "app.album_list_publications", "app.album_list_publication_items",
            "library.album_presentation_evidence", "library.album_presentation_seals",
            "library.public_metadata_source_state", "library.album_metadata_sources",
            "library.local_albums", "library.local_tracks", "library.library_roots",
            "library.catalog_album_links", "library.library_memberships",
        ):
            order = {"app.album_list_publication_items": "publication_ref,item_ref",
                     "library.catalog_album_links": "local_album_id",
                     "library.library_memberships": "account_id"}.get(relation, "1")
            values[relation] = connection.execute(
                f"select * from {relation} where library_id=%s order by {order}", (database.library,)).fetchall()
        values["publication_seals"] = connection.execute("""select s.*
            from app.album_list_publication_seals s join app.album_list_publications p
              on p.ref=s.publication_ref where p.library_id=%s order by s.publication_ref""",
            (database.library,)).fetchall()
        values["working_sources"] = connection.execute("""select s.*
            from app.album_list_item_publication_sources s join app.album_lists t on t.ref=s.top_ref
            where t.library_id=%s order by s.top_ref,s.item_ref""", (database.library,)).fetchall()
        values["presentations"] = connection.execute("""select * from catalog.album_presentation_versions
            where catalog_ref=any(%s::uuid[]) order by ref""", (database.album_refs,)).fetchall()
        values["presentation_tracks"] = connection.execute("""select t.*
            from catalog.album_presentation_tracks t join catalog.album_presentation_versions p
              on p.ref=t.presentation_ref where p.catalog_ref=any(%s::uuid[])
            order by t.presentation_ref,t.position""", (database.album_refs,)).fetchall()
        values["files"] = connection.execute("""select f.* from library.local_track_files f
            join library.local_tracks t on t.id=f.track_id where t.library_id=%s order by f.id""",
            (database.library,)).fetchall()
        for relation, key in (("app.accounts", "id"), ("app.account_sessions", "account_id"),
                              ("app.capabilities", "account_id")):
            values[relation] = connection.execute(
                f"select * from {relation} where {key}=any(%s) order by id",
                (database.account_ids,)).fetchall()
    return values


def resolve(database, share_ref, actor=None, *, service=None, **options):
    return (service or database.service).resolve_public_link(
        database.context(actor), share_ref=share_ref, **options)


def assert_real_read_only_resolution(observer, *, requester, owner, named):
    assert not observer.unexpected
    assert len(observer.opened) == 2  # discovery, then the current authority transaction
    statements = observer.statements
    assert statements[0] == DISCOVER
    assert statements.count(DISCOVER) == statements.count(ACCOUNT_LOCK) == 1
    assert statements.count(SESSION) == 2
    assert [params for sql, params in observer.calls if sql == ACCOUNT_LOCK] == [
        (requester.account_id, owner.account_id)]
    assert [params for sql, params in observer.calls if sql == SESSION] == [
        (requester.session_id, requester.account_id)] * 2
    assert statements.index(ACCOUNT_LOCK) < statements.index(PUBLIC_PARENT)
    assert statements.index(PUBLIC_PARENT) < statements.index(LINK) < statements.index(WORKING_PARENT)
    assert statements.index(WORKING_PARENT) < statements.index(MANIFEST) < statements.index(RETAINED_SOURCES)
    assert statements[-1] == SESSION
    assert statements.count(NAMED_GRANT) == int(named)
    if named:
        assert statements.index(WORKING_PARENT) < statements.index(NAMED_GRANT) < statements.index(MANIFEST)
    assert observer.completed == statements


@pytest.mark.parametrize("role", ["owner", "editor", "viewer", "server_shared"])
def test_resolve_returns_only_identity_for_current_working_readers_without_side_effects(published, role):
    database, original, _, items = published
    share_ref = original["publication"]["share_ref"]
    top = original
    actor = database.owner if role == "owner" else member(database)
    if role in {"editor", "viewer"}:
        top, _ = write(database, "grant_" + role, top, account_id=actor.account_id, role=role)
    elif role == "server_shared":
        top, _ = write(database, "visibility", top, visibility="server_shared")
    before = retained(database)
    assert len(items) == len(before["app.album_list_publication_items"]) == 2
    assert len(before["publication_seals"]) == 1 and before["publication_seals"][0]["sealed_at"] is not None
    assert len(before["library.album_presentation_seals"]) == 2
    service, observer = observed_service(database)
    result = resolve(database, share_ref, actor, service=service)
    assert type(result) is str and result == original["top_ref"]
    assert_real_read_only_resolution(observer, requester=actor, owner=database.owner, named=role != "owner")
    assert retained(database) == before

    # The existing working owner separately reauthorizes the navigation target.
    detail = database.service.read(database.context(actor), top_ref=result)
    actions = detail["allowed_actions"]
    assert actions["can_read"] is True
    assert actions["can_edit"] is (role in {"owner", "editor"})
    assert actions["can_share"] is (role == "owner")
    assert actions["can_delete"] is (role == "owner")
    if role in {"viewer", "server_shared"}:
        assert all(actions[key] is False for key in ("can_rename", "can_add", "can_remove", "can_reorder"))
        assert_error(lambda: write(database, "save", top, actor=actor, title="Must remain read only"),
                     "forbidden", 403)
    assert retained(database) == before


def test_publication_only_member_read_never_substitutes_for_working_acl(published):
    database, top, _, _ = published
    actor = member(database)
    share_ref = top["publication"]["share_ref"]
    public = PostgresPublicAlbumTopsService(database.service._config,
        connect=database.service._connect, clock=database.service._clock)
    before = retained(database)
    page = public.read_published(database.context(actor), top_ref=top["top_ref"], share_ref=share_ref,
        context_ref="c" * 64, cursor_secret=CURSOR_SECRET)
    assert page["share_ref"] == share_ref and page["title"] == "Approved Top"
    assert len(page["items"]) == 2 and page["allowed_actions"] == {"can_read": True, "can_open_item": True}
    service, observer = observed_service(database)
    assert_error(lambda: resolve(database, share_ref, actor, service=service), "top_unavailable", 404)
    assert not observer.unexpected and NAMED_GRANT in observer.completed
    assert MANIFEST not in observer.statements
    assert_error(lambda: database.service.read(database.context(actor), top_ref=top["top_ref"]),
                 "top_unavailable", 404)
    assert retained(database) == before


def test_same_share_cannot_select_a_different_current_library(published):
    database, top, _, _ = published
    with database.connect() as connection:
        actor = database.actor(connection)
        other_library = database.library_for(connection, actor)
        actor = database.member(connection, actor, other_library)
    before = retained(database)
    service, observer = observed_service(database)
    assert_error(lambda: resolve(database, top["publication"]["share_ref"], actor, service=service),
                 "unavailable", 404)
    assert not observer.unexpected and PUBLIC_PARENT not in observer.statements
    assert retained(database) == before


@pytest.mark.parametrize("state", ["disabled_deployment", "revoked_link", "deleted_top", "unknown_share"])
def test_unavailable_share_never_falls_back_to_an_independently_readable_top(published, state):
    database, top, _, _ = published
    share_ref = top["publication"]["share_ref"]
    if state == "disabled_deployment":
        database.service._config["ALBUM_HAVEN_PUBLIC_SHARING_ENABLED"] = False
    elif state == "revoked_link":
        top, _ = write(database, "revoke_external", top)
    elif state == "deleted_top":
        top, _ = write(database, "delete", top)
    else:
        share_ref = str(uuid4())
    before = retained(database)
    service, observer = observed_service(database)
    assert_error(lambda: resolve(database, share_ref, service=service), "unavailable", 404)
    assert not observer.unexpected
    if state == "disabled_deployment":
        assert observer.opened == []
    if state != "deleted_top":
        assert database.service.read(database.context(), top_ref=top["top_ref"])["allowed_actions"]["can_read"]
    assert retained(database) == before


@pytest.mark.parametrize("state,code", [
    ("disabled_owner", "unavailable"), ("missing_owner_membership", "unavailable"),
    ("revoked_owner_browse", "unavailable"),
    ("disabled_requester", "forbidden"), ("missing_requester_membership", "forbidden"),
    ("revoked_requester_session", "forbidden"), ("expired_requester_session", "forbidden"),
    ("revoked_requester_browse", "forbidden"),
])
def test_live_account_membership_session_and_browse_override_stale_actor_context(published, state, code):
    database, top, _, _ = published
    share_ref = top["publication"]["share_ref"]
    actor = member(database)
    write(database, "grant_viewer", top, account_id=actor.account_id, role="viewer")
    with database.connect() as connection:
        if state in {"disabled_owner", "disabled_requester"}:
            target = database.owner if state == "disabled_owner" else actor
            connection.execute("update app.accounts set is_active=false,disabled_at=now() where id=%s",
                               (target.account_id,))
        elif state in {"missing_owner_membership", "missing_requester_membership"}:
            target = database.owner if state == "missing_owner_membership" else actor
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                               (target.account_id, database.library))
        elif state == "revoked_requester_session":
            connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (actor.session_id,))
        elif state != "expired_requester_session":
            target = database.owner if state == "revoked_owner_browse" else actor
            connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (target.account_id,))
    before = retained(database)
    clock = (lambda: database.now + timedelta(hours=2)) if state == "expired_requester_session" else None
    service, observer = observed_service(database, clock=clock)
    assert_error(lambda: resolve(database, share_ref, actor, service=service), code,
                 404 if code == "unavailable" else 403)
    assert not observer.unexpected
    assert retained(database) == before


@pytest.mark.parametrize("kind", ["album", "album_metadata_source", "library_root"])
def test_retained_source_current_owner_scoped_denial_rejects_navigation(published, kind):
    database, top, _, items = published
    before = retained(database)
    source = next(row for row in before["library.album_presentation_evidence"]
                  if str(row["selected_source_ref"]) == items[0]["selected_source_ref"])
    denied_ref = str(source[{"album": "selected_local_album_id",
        "album_metadata_source": "selected_source_ref", "library_root": "selected_library_root_id"}[kind]])
    denied_contexts = []

    def constraints(context):
        denied = (context.action == BROWSE and context.resource is not None
            and context.resource.resource_kind == kind and context.resource.resource_ref == denied_ref)
        if denied:
            denied_contexts.append((context.actor.account_id, context.actor.session_id))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    service, observer = observed_service(database)
    assert_error(lambda: resolve(database, top["publication"]["share_ref"], service=service,
        constraints=constraints), "unavailable", 404)
    assert denied_contexts == [(database.owner.account_id, None)]
    assert not observer.unexpected and RETAINED_SOURCES in observer.completed
    # Retained evidence drives current scoped policy. No assertion or query
    # treats mutable source active-state inventory as the immutable publication.
    assert retained(database) == before


def test_requester_working_resource_browse_denial_is_independent_of_public_owner_eligibility(published):
    database, top, _, _ = published
    share_ref = top["publication"]["share_ref"]
    actor = member(database)
    write(database, "grant_viewer", top, account_id=actor.account_id, role="viewer")
    observed = []

    def constraints(context):
        scoped = (context.action == BROWSE and context.resource is not None
            and context.resource.resource_kind == "album_top" and context.resource.resource_ref == top["top_ref"])
        if scoped:
            observed.append((context.actor.account_id, context.actor.session_id))
        return PolicyEvaluationConstraints(request_origin_allowed=not (scoped and context.actor.account_id == actor.account_id))

    before = retained(database)
    service, observer = observed_service(database)
    assert_error(lambda: resolve(database, share_ref, actor, service=service, constraints=constraints), "forbidden", 403)
    assert (database.owner.account_id, None) in observed
    assert (actor.account_id, actor.session_id) in observed
    assert not observer.unexpected and NAMED_GRANT in observer.completed and MANIFEST not in observer.statements
    assert retained(database) == before


def wait_for_parent_block(database, observer, blocker, future):
    """Establish a real lock wait, rather than merely a thread reaching a hook."""
    assert observer.reached_parent.wait(3), "Resolver did not reach the publication parent lock"
    deadline = monotonic() + 3
    with database.connect() as probe:
        while monotonic() < deadline:
            blocked = probe.execute("select %s=any(pg_blocking_pids(%s)) as blocked",
                (blocker.info.backend_pid, observer.parent_pid)).fetchone()["blocked"]
            if blocked:
                assert not future.done()
                return
            if future.done():
                future.result()
                pytest.fail("Resolver escaped the held parent lock")
            sleep(0.01)
    pytest.fail("PostgreSQL did not report the resolver waiting on the held parent lock")


@pytest.mark.parametrize("role", ["editor", "viewer", "server_shared"])
def test_working_access_revoked_during_real_parent_wait_is_rechecked_after_discovery(published, role):
    database, top, _, _ = published
    share_ref = top["publication"]["share_ref"]
    actor = member(database)
    if role == "server_shared":
        granted, _ = write(database, "visibility", top, visibility="server_shared")
    else:
        granted, _ = write(database, "grant_" + role, top, account_id=actor.account_id, role=role)
    before = retained(database)
    service, observer = observed_service(database)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with database.connect() as blocker:
            blocker.execute("select ref from app.album_lists where ref=%s for update", (top["top_ref"],))
            future = pool.submit(resolve, database, share_ref, actor, service=service)
            wait_for_parent_block(database, observer, blocker, future)
            # Same parent serialization as the existing collaboration fixture;
            # no authority method or PostgreSQL result is replaced.
            if role == "server_shared":
                changed = blocker.execute("update app.album_lists set visibility='private' where ref=%s returning *",
                    (top["top_ref"],)).fetchone()
                expected = {**before, "tops": [changed if str(row["ref"]) == top["top_ref"] else row
                    for row in before["tops"]]}
            else:
                blocker.execute("delete from app.album_list_access_grants where ref=%s", (granted["grant_ref"],))
                expected = {**before, "app.album_list_access_grants": [row for row in before["app.album_list_access_grants"]
                    if str(row["ref"]) != granted["grant_ref"]]}
        assert_error(lambda: future.result(timeout=10), "top_unavailable", 404)
    assert not observer.unexpected
    assert observer.statements.index(PUBLIC_PARENT) < observer.statements.index(WORKING_PARENT) < observer.statements.index(NAMED_GRANT)
    assert observer.statements.count(NAMED_GRANT) == 1 and MANIFEST not in observer.statements
    assert retained(database) == expected


def test_real_owner_session_expiry_after_parent_wait_reaches_final_authority_fence(published):
    database, top, _, _ = published
    share_ref = top["publication"]["share_ref"]
    before = retained(database)
    now = [database.now]
    service, observer = observed_service(database, clock=lambda: now[0])
    with ThreadPoolExecutor(max_workers=1) as pool:
        with database.connect() as blocker:
            blocker.execute("select ref from app.album_lists where ref=%s for update", (top["top_ref"],))
            future = pool.submit(resolve, database, share_ref, database.owner, service=service)
            wait_for_parent_block(database, observer, blocker, future)
            assert observer.statements.count(SESSION) == 1 and SESSION in observer.completed
            now[0] = database.now + timedelta(hours=2)
        assert_error(lambda: future.result(timeout=10), "forbidden", 403)
    # The real manifest/source policies completed before the real session owner
    # rejected the now-expired persisted session at the response/commit fence.
    assert_real_read_only_resolution(observer, requester=database.owner, owner=database.owner, named=False)
    assert retained(database) == before


def test_authorized_target_is_not_a_reusable_grant_for_the_next_native_read(published):
    database, top, _, _ = published
    share_ref = top["publication"]["share_ref"]
    actor = member(database)
    granted, _ = write(database, "grant_viewer", top, account_id=actor.account_id, role="viewer")
    target = resolve(database, share_ref, actor)
    assert database.service.read(database.context(actor), top_ref=target)["allowed_actions"]["can_edit"] is False
    write(database, "revoke_editor", granted, grant_ref=granted["grant_ref"])
    before = retained(database)
    assert_error(lambda: database.service.read(database.context(actor), top_ref=target), "top_unavailable", 404)
    assert_error(lambda: resolve(database, share_ref, actor), "top_unavailable", 404)
    assert retained(database) == before
