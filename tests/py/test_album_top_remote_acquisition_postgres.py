"""Provider-boundary contracts through the actual Top owner and PostgreSQL roles.

Provider/search seams return synthetic validated provider facts. Every authority
check and every SQL response is real; no provider HTTP or app composition runs.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event, get_ident
from uuid import uuid4

import pytest

from music_app.services.album_top_remote_acquisition import load_pending_remote_source
from music_app.services.album_top_remote_sources import normalize_remote_destination
from music_app.services.owned_album_tops import BROWSE, CREATE, ITEMS
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.test_album_top_collaboration_postgres import member, new_session, write
from tests.py.remote_top_postgres_support import CONTEXT, MBID, db, urls, remote, payload, destination, evidence


def search(case, command, *, actor=None, **options):
    return case.service.search_candidates(case.db.context(actor), destination=command["destination"],
        title="Remote album", artist="Remote artist", context_ref=CONTEXT, **options)


def selector(receipt):
    return {"kind": "remote_acquisition", "acquisition_ref": receipt["acquisition_ref"],
            "evidence_version": receipt["evidence_version"]}


def pending(case, receipt, command, *, actor=None, context_ref=CONTEXT, selected=None, target=None, owner=None):
    target = normalize_remote_destination(target or command["destination"])
    with case.service._authorized(case.db.context(actor), target, None, None) as (connection, live, top):
        return load_pending_remote_source(connection, selector=selected or selector(receipt), live=live,
            destination=target, owner_account_id=owner if owner is not None else case.service._owner(live, top),
            context_ref=context_ref)


def test_create_is_per_draft_needs_no_goals_and_never_maps_or_mutates_membership(remote):
    first, second = payload(), payload()
    before = remote.unrelated()
    assert not before["listening_goals"] and not before["listening_goal_evidence"]
    searched = search(remote, first)
    assert remote.rows() == []
    assert searched["destination"] == first["destination"]
    assert "acquisition_ref" not in searched and "evidence_version" not in searched["candidates"][0]
    one, two = remote.acquire(first), remote.acquire(second)
    assert one["destination"] != two["destination"]
    assert one["acquisition_ref"] != two["acquisition_ref"]
    assert one["album"] == two["album"] == searched["candidates"][0]
    assert one["album"]["track_metadata_status"] == "unavailable"
    assert one["album"]["metadata_coverage"] == "album_summary_only"
    assert one["album"]["track_count"] is None
    assert not {"tracks", "artwork", "media_ref", "edition", "album_ref", "catalog_ref"} & one["album"].keys()
    assert remote.unrelated() == before
    assert all("listening_goal" not in sql and "provider_identities" not in sql for sql in remote.statements)
    assert [call[0] for call in remote.calls] == ["search", "acquire", "acquire"]
    assert all(call[-1]["user_agent"] == "AlbumHaven-Synthetic-Contract/1.0" for call in remote.calls)


@pytest.mark.parametrize("role", ["owner", "editor", "viewer", "server_reader", "private_stranger"])
def test_current_named_owner_editor_items_authority_is_required(remote, role):
    database = remote.db
    other = member(database)
    top, _ = database.create(refs=[])
    actor = database.owner
    expected = None
    if role in {"editor", "viewer"}:
        top, _ = write(database, "grant_" + role, top, account_id=other.account_id, role=role)
        actor = other
        expected = None if role == "editor" else ("forbidden", 403)
    elif role == "server_reader":
        top, _ = write(database, "visibility", top, visibility="server_shared")
        actor, expected = other, ("forbidden", 403)
    elif role == "private_stranger":
        actor, expected = other, ("top_unavailable", 404)
    command = payload(destination(top))
    before = remote.unrelated()
    if expected:
        assert_error(lambda: search(remote, command, actor=actor), *expected)
        assert_error(lambda: remote.acquire(command, actor=actor), *expected)
        assert remote.calls == [] and remote.rows() == []
    else:
        search(remote, command, actor=actor)
        receipt = remote.acquire(command, actor=actor)
        assert receipt["destination"] == command["destination"]
        row = remote.rows()[0]
        assert row["actor_account_id"] == actor.account_id
        assert row["destination_owner_account_id"] == database.owner.account_id
    assert remote.unrelated() == before


@pytest.mark.parametrize("operation", ["search", "acquire", "replay"])
@pytest.mark.parametrize("action", [BROWSE, CREATE, ITEMS])
def test_current_action_constraints_precede_io_and_recovery(remote, operation, action):
    top, _ = remote.db.create(refs=[])
    command = payload(destination(top) if action == ITEMS else destination())
    if operation == "replay":
        remote.acquire(command)
    before, calls = remote.rows(), len(remote.calls)
    observed = []
    def constraints(context):
        observed.append(context.action)
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != action)
    callback = (lambda: search(remote, command, constraints=constraints)) if operation == "search" else (
        lambda: remote.acquire(command, constraints=constraints))
    assert_error(callback, "forbidden", 403)
    assert action in observed and len(remote.calls) == calls and remote.rows() == before


@pytest.mark.parametrize("operation", ["search", "acquire"])
@pytest.mark.parametrize("changed", ["account", "session", "membership", "browse", "editor", "revision", "deleted"])
def test_provider_gap_rechecks_current_authority_session_library_and_top(remote, operation, changed):
    database = remote.db
    editor = member(database)
    top, _ = database.create(refs=[])
    top, _ = write(database, "grant_editor", top, account_id=editor.account_id, role="editor")
    grant_ref = top["grant_ref"]
    command = payload(destination(top))
    def change():
        with database.connect() as connection:
            if changed == "account":
                connection.execute("update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s", (editor.account_id,))
            elif changed == "session":
                connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (editor.session_id,))
            elif changed == "membership":
                connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (editor.account_id, database.library))
            elif changed == "browse":
                connection.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s", (editor.account_id,))
            elif changed == "editor":
                connection.execute("delete from app.album_list_access_grants where ref=%s", (grant_ref,))
        if changed == "revision":
            write(database, "save", top, title="Changed during provider read")
        elif changed == "deleted":
            write(database, "delete", top)
    remote.provider_hook = change
    expected = ("top_unavailable", 404) if changed in {"editor", "deleted"} else (
        ("revision_conflict", 409) if changed == "revision" else ("forbidden", 403))
    callback = (lambda: search(remote, command, actor=editor)) if operation == "search" else (
        lambda: remote.acquire(command, actor=editor))
    assert_error(callback, *expected)
    assert len(remote.calls) == 1 and remote.rows() == []


@pytest.mark.parametrize("boundary", ["session_expiry", "policy", "cancel"])
def test_late_denial_after_real_insert_rolls_back_acquisition_and_response(remote, boundary):
    observed_now = [remote.db.now]
    remote.db.service._clock = lambda: observed_now[0]
    inserted = []
    def after(sql, connection):
        if sql.startswith("select app.store_top_remote_acquisition("):
            inserted.append(connection.execute("select count(*) as n from app.album_top_remote_acquisitions where actor_account_id=%s",
                                               (remote.db.owner.account_id,)).fetchone()["n"])
            if boundary == "session_expiry":
                observed_now[0] += timedelta(days=2)
    remote.after_statement = after
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (inserted and boundary == "policy"))
    cancelled = lambda: bool(inserted and boundary == "cancel")
    before = remote.unrelated()
    assert_error(lambda: remote.acquire(payload(), constraints=constraints, should_cancel=cancelled),
                 "provider_cancelled" if boundary == "cancel" else "forbidden", 503 if boundary == "cancel" else 403)
    assert inserted == [1]
    assert remote.rows() == [] and remote.unrelated() == before


def test_lost_response_exact_recovery_keeps_first_facts_without_new_provider_io(remote):
    command = payload()
    first = remote.acquire(command)
    before = remote.rows()
    remote.facts = evidence(title="Later provider correction")
    assert remote.acquire(command) == first
    assert len(remote.calls) == 1 and remote.rows() == before


@pytest.mark.parametrize("change", ["release_group", "draft", "context", "session", "library", "top"])
def test_exact_request_key_is_bound_to_original_command_context_session_and_destination(remote, change):
    database = remote.db
    command = payload()
    remote.acquire(command)
    before = remote.rows()
    options = {}
    changed = dict(command)
    if change == "release_group":
        changed["release_group_id"] = str(uuid4())
    elif change == "draft":
        changed["destination"] = destination()
    elif change == "context":
        options["context_ref"] = "b" * 64
    elif change == "session":
        options["actor"] = new_session(database, database.owner)
    elif change == "library":
        with database.connect() as connection:
            library = database.library_for(connection, database.owner)
            options["actor"] = database.member(connection, database.owner, library)
    elif change == "top":
        top, _ = database.create(refs=[])
        changed["destination"] = destination(top)
    assert_error(lambda: remote.acquire(changed, **options),
                 "remote_evidence_unavailable" if change == "session" else "request_key_conflict", 409)
    assert len(remote.calls) == 1 and remote.rows() == before


@pytest.mark.parametrize("state", ["expired", "retired"])
def test_expired_or_retired_exact_recovery_cannot_refresh_or_contact_provider(remote, state):
    command = remote.seed(1, state=state)
    before = remote.rows()
    assert_error(lambda: remote.acquire(command), "remote_evidence_unavailable", 409)
    assert remote.calls == [] and remote.rows() == before


@pytest.mark.parametrize("change", ["actor", "session", "library", "context", "draft", "top", "revision", "owner", "version"])
def test_pending_source_selector_preserves_every_original_binding(remote, change):
    database = remote.db
    command = payload()
    receipt = remote.acquire(command)
    row, facts = pending(remote, receipt, command)
    assert str(row["ref"]) == receipt["acquisition_ref"] and facts.digest == receipt["evidence_version"]
    options = {}
    if change == "actor":
        options["actor"] = member(database)
    elif change == "session":
        options["actor"] = new_session(database, database.owner)
    elif change == "library":
        with database.connect() as connection:
            library = database.library_for(connection, database.owner)
            options["actor"] = database.member(connection, database.owner, library)
    elif change == "context":
        options["context_ref"] = "b" * 64
    elif change == "draft":
        options["target"] = destination()
    elif change in {"top", "revision"}:
        top, _ = database.create(refs=[])
        options["target"] = destination(top)
        if change == "revision":
            options["target"]["revision"] = "2"
    elif change == "owner":
        options["owner"] = member(database).account_id
    elif change == "version":
        options["selected"] = {**selector(receipt), "evidence_version": "f" * 64}
    assert_error(lambda: pending(remote, receipt, command, **options),
                 "revision_conflict" if change == "revision" else "remote_evidence_unavailable", 409)
    assert len(remote.calls) == 1 and len(remote.rows()) == 1


def test_pending_top_acquisition_requires_its_exact_saved_revision(remote):
    top, _ = remote.db.create(refs=[])
    command = payload(destination(top))
    receipt = remote.acquire(command)
    saved, _ = write(remote.db, "save", top, title="New saved revision")
    assert_error(lambda: pending(remote, receipt, command), "revision_conflict", 409)
    assert_error(lambda: pending(remote, receipt, command, target=destination(saved)), "remote_evidence_unavailable", 409)


def test_concurrent_same_key_has_one_first_committed_immutable_result(remote):
    command = payload()
    both_reading = Barrier(2)
    first_committed = Event()
    calls = []
    def provider(mbid, **options):
        assert not any(owner == get_ident() for owner, _ in remote.active_connections)
        name = options["should_cancel"].__name__
        calls.append(name)
        both_reading.wait(timeout=10)
        if name == "second":
            assert first_committed.wait(10)
        return evidence(title="First committed" if name == "first" else "Later result")
    remote.service.provider = provider
    def first():
        return False
    def second():
        return False
    def run_first():
        try:
            return remote.acquire(command, should_cancel=first)
        finally:
            first_committed.set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(run_first)
        two = pool.submit(remote.acquire, command, should_cancel=second)
        winner, recovered = one.result(timeout=15), two.result(timeout=15)
    assert sorted(calls) == ["first", "second"]
    assert winner == recovered and winner["album"]["title"] == "First committed"
    assert len(remote.rows()) == 1 and remote.rows()[0]["title"] == "First committed"


@pytest.mark.parametrize("operation", ["search", "acquire"])
def test_provider_error_is_checked_after_current_authority_and_leaves_no_evidence(remote, operation):
    def failed(*args, **kwargs):
        remote.outside_authority()
        with remote.db.connect() as connection:
            connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s",
                               (remote.db.owner.session_id,))
        raise RemoteAlbumEvidenceError("provider_unavailable")
    remote.service.provider = remote.service.searcher = failed
    command = payload()
    assert_error((lambda: search(remote, command)) if operation == "search" else (lambda: remote.acquire(command)),
                 "forbidden", 403)
    assert remote.rows() == []


def test_false_late_cancellation_observer_cannot_change_policy_after_the_final_fence(remote):
    read_pending = []
    denied = []
    def after(sql, connection):
        if "from app.album_top_remote_acquisitions where ref=" in sql:
            read_pending.append(True)
    def cancellation_observer():
        if read_pending:
            denied.append(True)
        return False
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    remote.after_statement = after
    before = remote.unrelated()
    assert_error(lambda: remote.acquire(payload(), should_cancel=cancellation_observer, constraints=constraints),
                 "forbidden", 403)
    assert read_pending == [True] and denied
    assert remote.rows() == [] and remote.unrelated() == before


@pytest.mark.parametrize("state", ["expired", "retired"])
def test_pending_source_loader_rejects_expired_and_retired_rows_under_current_authority(remote, state):
    command = remote.seed(1, state=state)
    row = remote.rows()[0]
    receipt = {"acquisition_ref": str(row["ref"]), "evidence_version": row["evidence_version"]}
    assert_error(lambda: pending(remote, receipt, command), "remote_evidence_unavailable", 409)
    assert remote.calls == [] and len(remote.rows()) == 1


@pytest.mark.parametrize("changed", ["editor", "session", "revision"])
def test_committed_recovery_still_needs_current_editor_session_and_top_revision(remote, changed):
    database = remote.db
    editor = member(database)
    top, _ = database.create(refs=[])
    top, _ = write(database, "grant_editor", top, account_id=editor.account_id, role="editor")
    command = payload(destination(top))
    remote.acquire(command, actor=editor)
    if changed == "editor":
        write(database, "revoke_editor", top, grant_ref=top["grant_ref"])
    elif changed == "revision":
        write(database, "save", top, title="Revision changed after acquisition")
    else:
        with database.connect() as connection:
            connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (editor.session_id,))
    before = remote.rows()
    code, status = {"editor": ("top_unavailable", 404), "session": ("forbidden", 403),
                    "revision": ("revision_conflict", 409)}[changed]
    assert_error(lambda: remote.acquire(command, actor=editor), code, status)
    assert len(remote.calls) == 1 and remote.rows() == before
