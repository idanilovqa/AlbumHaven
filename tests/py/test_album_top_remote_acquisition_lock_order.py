"""C1 account ordering against actual Top owners and isolated PostgreSQL.

Only provider facts are synthetic. SQL observation preserves actual cursors,
roles, transactions, locks, ACLs and storage. No production method is replaced.
Trusted setup changes only this fixture's synthetic rows for stale-binding cases.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from threading import Event, Lock, local
from time import monotonic

import psycopg
import pytest

from music_app.services.album_top_remote_sources import normalize_remote_destination
from music_app.services.owned_album_tops import BROWSE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.remote_top_postgres_support import (
    CONTEXT, db, urls, remote, destination, payload, runtime,
)
from tests.py.test_album_top_collaboration_postgres import member, write
from tests.py.test_owned_album_tops_postgres import assert_error


_DISCOVERY = "select owner_account_id from app.album_lists where ref=%s and library_id=%s"


def _account_lock(sql):
    return "from app.accounts" in sql and any(mode in sql for mode in (
        "for update", "for no key update", "for share", "for key share"))


def _top_lock(sql):
    return "from app.album_lists" in sql and any(mode in sql for mode in (
        "for update", "for no key update", "for share", "for key share"))


def _ids(params):
    return {value for param in params for value in (
        param if isinstance(param, (tuple, list)) else (param,))}


class SQLTrace:
    """Observe before/after real SQL without replacing a single returned row."""
    def __init__(self, case):
        self.case = case
        self.entries = []
        self.connections = []
        self.local = local()
        self.guard = Lock()
        self.before = None
        self.after = None
        self.connect = case.db.service._connect

    def call(self, label, callback):
        previous = getattr(self.local, "label", "setup")
        self.local.label = label
        try:
            return callback()
        finally:
            self.local.label = previous

    @contextmanager
    def observed(self, *args, **kwargs):
        with self.connect(*args, **kwargs) as connection:
            with self.guard:
                token = len(self.connections)
                self.connections.append(connection)
            trace = self
            label = getattr(self.local, "label", "setup")

            class ObservedConnection:
                def execute(self, sql, params=None):
                    entry = {"sql": " ".join(sql.lower().split()), "params": params or (),
                        "connection": token, "label": label,
                        "pid": connection.info.backend_pid, "completed": False}
                    with trace.guard:
                        entry["order"] = len(trace.entries)
                        trace.entries.append(entry)
                    if trace.before is not None:
                        trace.before(entry, connection)
                    result = connection.execute(sql, params)
                    entry["completed"] = True
                    if trace.after is not None:
                        trace.after(entry, connection)
                    return result

                def __getattr__(self, name):
                    return getattr(connection, name)

            yield ObservedConnection()

    def selected(self, label):
        return [entry for entry in self.entries if entry["label"] == label]

    def assert_order(self, label, actor, owner, top, *, phases):
        entries = self.selected(label)
        discoveries = [entry for entry in entries if entry["sql"] == _DISCOVERY]
        assert len(discoveries) == 1, "Pin one discovery across both provider phases"
        discovery = discoveries[0]
        assert discovery["completed"]
        assert discovery["params"] == (top["top_ref"], actor.current_library_id)
        accounts = [entry for entry in entries if _account_lock(entry["sql"])]
        tops = [entry for entry in entries if _top_lock(entry["sql"])]
        assert len(accounts) == len(tops) == phases
        expected = {actor.account_id, owner.account_id}
        for account, parent in zip(accounts, tops):
            assert account["completed"] and parent["completed"]
            assert account["connection"] == parent["connection"]
            assert discovery["connection"] != account["connection"]
            assert discovery["order"] < account["order"] < parent["order"]
            assert "order by id" in account["sql"] and "for update" in account["sql"]
            assert _ids(account["params"]) == expected
            assert parent["params"] == (top["top_ref"], actor.current_library_id)
            assert not any(_account_lock(entry["sql"]) and entry["order"] > parent["order"]
                for entry in entries if entry["connection"] == parent["connection"]), (
                    "No new account lock may be requested after locking the Top")
        assert len({entry["connection"] for entry in accounts}) == phases
        for entry in entries:
            if entry["sql"].startswith("select app.store_top_remote_acquisition("):
                # The structural helper re-locks the actor and its INSERT checks
                # actor/owner FKs. Both identities must already be prelocked.
                assert entry["params"][2] == actor.account_id
                assert entry["params"][7] == owner.account_id
                assert {entry["params"][2], entry["params"][7]} <= expected
                assert any(parent["connection"] == entry["connection"]
                    and parent["order"] < entry["order"] for parent in tops)
        return accounts, tops


@pytest.fixture
def trace(remote, monkeypatch):
    # Keep the existing strict paired-role/synthetic-database identity contract.
    # Inherited privileges alone, or an arbitrary role name, are insufficient.
    with runtime(remote.db) as connection:
        assert_runtime_role(connection, remote.db)
    observer = SQLTrace(remote)
    monkeypatch.setattr(remote.db.service, "_connect", observer.observed)
    return observer


def _named_top(case, *, editor_first=False):
    other = member(case.db)
    owner, editor = (other, case.db.owner) if editor_first else (case.db.owner, other)
    assert (editor.account_id < owner.account_id) is editor_first
    top = case.db.service.execute(case.db.context(owner), case.db.create_command(refs=[]))
    top, _ = write(case.db, "grant_editor", top, actor=owner,
                   account_id=editor.account_id, role="editor")
    with case.db.connect() as connection:
        row = connection.execute("""select p.owner_account_id,g.account_id,g.role
            from app.album_lists p join app.album_list_access_grants g on g.top_ref=p.ref
            where p.ref=%s and g.account_id=%s""", (top["top_ref"], editor.account_id)).fetchone()
    assert row == {"owner_account_id": owner.account_id,
                   "account_id": editor.account_id, "role": "editor"}
    return owner, editor, top


def _invoke(case, operation, command, actor, **options):
    if operation == "search":
        return case.service.search_candidates(case.db.context(actor),
            destination=command["destination"], title="Remote album", artist="Remote artist",
            context_ref=CONTEXT, **options)
    if operation == "direct":
        with case.service._authorized(case.db.context(actor),
                normalize_remote_destination(command["destination"]),
                options.get("constraints"), options.get("should_cancel")) as (_, live, top):
            return {"actor": live.actor.account_id,
                    "owner": case.service._owner(live, top)}
    return case.acquire(command, actor=actor, **options)


@pytest.mark.parametrize("editor_first", [False, True], ids=["owner-id-first", "editor-id-first"])
@pytest.mark.parametrize("operation", ["search", "acquire", "replay", "direct"])
def test_one_discovery_and_sorted_accounts_precede_each_top_phase(remote, trace, editor_first, operation):
    owner, editor, top = _named_top(remote, editor_first=editor_first)
    command = payload(destination(top))
    prior = remote.acquire(command, actor=editor) if operation == "replay" else None
    before, calls = remote.unrelated(), len(remote.calls)
    result = trace.call("request", lambda: _invoke(remote, operation, command, editor))
    trace.assert_order("request", editor, owner, top,
                       phases=1 if operation in {"replay", "direct"} else 2)
    assert len(remote.calls) == calls + (operation in {"search", "acquire"})
    if operation == "replay":
        assert result == prior
    assert remote.unrelated() == before


@pytest.mark.parametrize("operation", ["search", "acquire", "direct"])
def test_create_locks_only_its_actor_and_never_discovers_or_locks_a_top(remote, trace, operation):
    actor = member(remote.db)
    result = trace.call("create", lambda: _invoke(remote, operation, payload(), actor))
    entries = trace.selected("create")
    accounts = [entry for entry in entries if _account_lock(entry["sql"])]
    assert len(accounts) == (1 if operation == "direct" else 2)
    assert all(entry["completed"] and _ids(entry["params"]) == {actor.account_id}
               and "order by id" in entry["sql"] for entry in accounts)
    assert not any(_top_lock(entry["sql"]) or entry["sql"] == _DISCOVERY for entry in entries)
    if operation == "acquire":
        row = remote.rows()[0]
        assert str(row["ref"]) == result["acquisition_ref"]
        assert row["actor_account_id"] == row["destination_owner_account_id"] == actor.account_id


def _wait_for_blocker(connection, waiter_pid, blocker_pid):
    deadline = monotonic() + 3
    last = None
    while monotonic() < deadline:
        last = connection.execute("select pg_blocking_pids(%s) as blockers", (waiter_pid,)).fetchone()
        if blocker_pid in last["blockers"]:
            return
        Event().wait(0.02)
    pytest.fail(f"Expected runtime backend {waiter_pid} to wait for {blocker_pid}; observed {last}")


@pytest.mark.parametrize("editor_first", [False, True], ids=["owner-id-first", "editor-id-first"])
def test_editor_store_and_actual_owner_save_complete_without_account_top_cycle(remote, trace, editor_first):
    owner, editor, top = _named_top(remote, editor_first=editor_first)
    command = payload(destination(top))
    before = remote.unrelated()
    editor_holds_top, release_editor, owner_requests_account = Event(), Event(), Event()
    checkpoints = {}

    def provider(mbid, **options):
        # Other actors may hold locks; this request must hold no DB transaction.
        remote.outside_authority(check_locks=False)
        remote.calls.append(("acquire", mbid, options))
        return remote.facts

    remote.service.provider = provider

    def after(entry, connection):
        if entry["label"] == "editor" and _top_lock(entry["sql"]) and "for update" in entry["sql"]:
            checkpoints["editor_top"] = entry
            editor_holds_top.set()
            assert release_editor.wait(10), "Bounded editor Top barrier was not released"

    def before_sql(entry, connection):
        if entry["label"] == "owner" and _account_lock(entry["sql"]):
            checkpoints["owner_account"] = entry
            owner_requests_account.set()

    trace.after, trace.before = after, before_sql
    with runtime(remote.db) as monitor:
        assert_runtime_role(monitor, remote.db)
        with ThreadPoolExecutor(max_workers=2) as pool:
            acquired = pool.submit(trace.call, "editor", lambda: remote.acquire(command, actor=editor))
            try:
                assert editor_holds_top.wait(10), "Acquisition did not reach its real write Top lock"
                # Real independent NOWAIT probes establish both row locks,
                # rather than trusting only the observed SQL text/parameters.
                with runtime(remote.db) as probe:
                    assert_runtime_role(probe, remote.db)
                    for account_id in sorted({editor.account_id, owner.account_id}):
                        with pytest.raises(psycopg.errors.LockNotAvailable):
                            with probe.transaction():
                                probe.execute("select id from app.accounts where id=%s for update nowait",
                                              (account_id,)).fetchone()
                saved = pool.submit(trace.call, "owner", lambda: write(remote.db, "save", top,
                    actor=owner, title="Owner save after editor acquisition")[0])
                assert owner_requests_account.wait(5), "Owner did not reach its actual account lock"
                account, parent = checkpoints["owner_account"], checkpoints["editor_top"]
                _wait_for_blocker(monitor, account["pid"], parent["pid"])
                assert account["completed"] is False, "Owner must wait before acquiring its account"
                assert not any(_top_lock(entry["sql"]) for entry in trace.selected("owner")), (
                    "Owner cannot wait for Top while holding an account needed by editor store")
            finally:
                release_editor.set()
            receipt, saved_top = acquired.result(timeout=12), saved.result(timeout=12)
    trace.after = trace.before = None
    trace.assert_order("editor", editor, owner, top, phases=2)
    owner_entries = trace.selected("owner")
    accounts = [entry for entry in owner_entries if _account_lock(entry["sql"])]
    tops = [entry for entry in owner_entries if _top_lock(entry["sql"])]
    assert len(accounts) == len(tops) == 1
    assert accounts[0]["completed"] and accounts[0]["order"] < tops[0]["order"]
    assert _ids(accounts[0]["params"]) == {owner.account_id}
    assert saved_top["revision"] == str(int(top["revision"]) + 1)
    current = remote.db.service.read(remote.db.context(owner), top_ref=top["top_ref"])
    assert current["title"] == "Owner save after editor acquisition"
    rows = remote.rows()
    assert len(rows) == 1 and str(rows[0]["ref"]) == receipt["acquisition_ref"]
    assert rows[0]["actor_account_id"] == editor.account_id
    assert rows[0]["destination_owner_account_id"] == owner.account_id
    assert rows[0]["destination_revision"] == int(top["revision"])
    after_state = remote.unrelated()
    assert {key: value for key, value in after_state.items() if key not in {"tops", "operations"}} == {
        key: value for key, value in before.items() if key not in {"tops", "operations"}}
    assert len(remote.calls) == 1


def _replace_fixture_owner(case, top, replacement, *, remove_grant=False):
    # There is no production transfer API. This trusted fixture-only update
    # exercises a stale untrusted discovery result against genuine SQL and ACLs.
    with case.db.connect() as connection:
        row = connection.execute("""update app.album_lists set owner_account_id=%s
            where ref=%s and library_id=%s returning owner_account_id,revision""",
            (replacement.account_id, top["top_ref"], case.db.library)).fetchone()
        assert row == {"owner_account_id": replacement.account_id, "revision": int(top["revision"])}
        if remove_grant:
            connection.execute("delete from app.album_list_access_grants where ref=%s", (top["grant_ref"],))


@pytest.mark.parametrize("operation", ["search", "acquire"])
@pytest.mark.parametrize("when", ["after_discovery", "during_provider"])
@pytest.mark.parametrize("replacement_kind", ["third_member", "actor_becomes_owner"])
def test_owner_pin_refuses_stale_binding_without_new_owner_authority(remote, trace, operation, when, replacement_kind):
    owner, editor, top = _named_top(remote)
    replacement = editor if replacement_kind == "actor_becomes_owner" else member(remote.db)
    command = payload(destination(top))
    changes = []

    def change():
        assert not changes
        changes.append(True)
        _replace_fixture_owner(remote, top, replacement,
                               remove_grant=replacement_kind == "actor_becomes_owner")

    if when == "after_discovery":
        def after(entry, connection):
            if entry["label"] == "request" and entry["sql"] == _DISCOVERY:
                change()
        trace.after = after
    else:
        remote.provider_hook = change
    assert_error(lambda: trace.call("request", lambda: _invoke(remote, operation, command, editor)),
                 "concurrent_change", 409)
    trace.assert_order("request", editor, owner, top,
                       phases=1 if when == "after_discovery" else 2)
    assert changes == [True] and remote.rows() == []
    assert len(remote.calls) == (when == "during_provider")
    assert not any(entry["sql"].startswith("select app.store_top_remote_acquisition(")
                   for entry in trace.selected("request"))
    # The changed Top really is currently writable by this actor. Its fresh
    # permission must not retroactively authorize the stale acquisition request.
    current = remote.db.service.read(remote.db.context(editor), top_ref=top["top_ref"])
    assert current["allowed_actions"]["can_add"] is True
    if replacement_kind == "third_member":
        assert all(replacement.account_id not in _ids(entry["params"])
            for entry in trace.selected("request") if _account_lock(entry["sql"]))


def test_compatible_direct_authorized_helper_discovers_then_refuses_stale_owner(remote, trace):
    owner, editor, top = _named_top(remote)
    replacement = member(remote.db)
    def after(entry, connection):
        if entry["label"] == "direct" and entry["sql"] == _DISCOVERY:
            _replace_fixture_owner(remote, top, replacement)
    trace.after = after
    assert_error(lambda: trace.call("direct", lambda: _invoke(remote, "direct", payload(destination(top)), editor)),
                 "concurrent_change", 409)
    trace.assert_order("direct", editor, owner, top, phases=1)
    assert remote.calls == [] and remote.rows() == []


@pytest.mark.parametrize("operation", ["search", "acquire"])
@pytest.mark.parametrize("changed", ["deleted", "revision", "editor"])
def test_provider_gap_retains_locked_destination_and_acl_fences(remote, trace, operation, changed):
    owner, editor, top = _named_top(remote)
    def change():
        action, fields = {"deleted": ("delete", {}),
            "revision": ("save", {"title": "Changed while provider was reading"}),
            "editor": ("revoke_editor", {"grant_ref": top["grant_ref"]})}[changed]
        trace.call("owner_change", lambda: write(remote.db, action, top, actor=owner, **fields))
    remote.provider_hook = change
    expected = ("revision_conflict", 409) if changed == "revision" else ("top_unavailable", 404)
    assert_error(lambda: trace.call("request", lambda: _invoke(remote, operation, payload(destination(top)), editor)),
                 *expected)
    trace.assert_order("request", editor, owner, top, phases=2)
    assert len(remote.calls) == 1 and remote.rows() == []


@pytest.mark.parametrize("boundary", ["session_expiry", "policy", "cancel", "late_false_observer"])
def test_final_fence_rolls_back_actual_editor_store_after_ordered_locks(remote, trace, boundary):
    owner, editor, top = _named_top(remote)
    now, inserted, read_pending, denied = [remote.db.now], [], [], []
    remote.db.service._clock = lambda: now[0]
    before = remote.unrelated()

    def after(entry, connection):
        if entry["label"] != "request":
            return
        if entry["sql"].startswith("select app.store_top_remote_acquisition("):
            inserted.append(connection.execute("""select count(*) as n from app.album_top_remote_acquisitions
                where actor_account_id=%s""", (editor.account_id,)).fetchone()["n"])
            if boundary == "session_expiry":
                now[0] += timedelta(days=2)
        if "from app.album_top_remote_acquisitions where ref=" in entry["sql"]:
            read_pending.append(True)

    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            inserted and boundary == "policy" or denied))

    def cancellation():
        if read_pending and boundary == "late_false_observer":
            denied.append(True)
        return bool(inserted and boundary == "cancel")

    trace.after = after
    assert_error(lambda: trace.call("request", lambda: remote.acquire(payload(destination(top)), actor=editor,
        constraints=constraints, should_cancel=cancellation)),
        "provider_cancelled" if boundary == "cancel" else "forbidden", 503 if boundary == "cancel" else 403)
    trace.assert_order("request", editor, owner, top, phases=2)
    assert inserted == [1] and remote.rows() == [] and remote.unrelated() == before
    if boundary == "late_false_observer":
        assert read_pending == [True] and denied


@pytest.mark.parametrize("operation", ["search", "acquire", "direct"])
def test_initial_browse_denial_precedes_owner_discovery_or_any_lock(remote, trace, operation):
    _, editor, top = _named_top(remote)
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != BROWSE)
    assert_error(lambda: trace.call("denied", lambda: _invoke(remote, operation, payload(destination(top)),
        editor, constraints=constraints)), "forbidden", 403)
    assert trace.selected("denied") == []
    assert remote.calls == [] and remote.rows() == []


@pytest.mark.parametrize("operation", ["search", "acquire"])
def test_discovery_is_exactly_current_library_and_missing_top_takes_no_account_lock(remote, trace, operation):
    _, editor, top = _named_top(remote)
    with remote.db.connect() as connection:
        other_library = remote.db.library_for(connection, editor)
        actor = remote.db.member(connection, editor, other_library)
    assert_error(lambda: trace.call("foreign", lambda: _invoke(remote, operation, payload(destination(top)), actor)),
                 "top_unavailable", 404)
    entries = trace.selected("foreign")
    assert [entry["sql"] for entry in entries] == [_DISCOVERY]
    assert entries[0]["params"] == (top["top_ref"], other_library)
    assert remote.calls == [] and remote.rows() == []
