"""Provider-boundary contracts through the actual Top owner and PostgreSQL roles.

Provider/search seams return synthetic validated provider facts. Every authority
check and every SQL response is real; no provider HTTP or app composition runs.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event, get_ident
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from music_app.services.album_top_remote_acquisition import load_pending_remote_source
from music_app.services import album_top_remote_membership as membership
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


def pending(case, receipt, command, *, actor=None, context_ref=CONTEXT, selected=None, target=None, owner=None,
            provide_prelock=True, discovered_override=None):
    target = normalize_remote_destination(target or command["destination"])
    selected = selected or selector(receipt)
    with case.db.connect() as lookup:
        discovered = lookup.execute("select preparation_ref,attempt_ref from app.album_top_remote_acquisitions where ref=%s",
            (selected['acquisition_ref'],)).fetchone()
    descriptor = {**selected, 'preparation_ref': str(discovered['preparation_ref']) if discovered else None,
        'attempt_ref': str(discovered['attempt_ref']) if discovered else None}
    descriptor.pop('kind')
    if discovered_override is not None:
        descriptor.update(discovered_override)
    with case.service._authorized(case.db.context(actor), target, None, None,
            write=True, budget_lock=True) as (connection, live, top):
        # The v2 loader is membership-internal. A Create-only read proves its
        # contract under a real temporary owned Top, with every write rolled back.
        with connection.transaction(force_rollback=True):
            actual_owner = owner if owner is not None else case.service._owner(live, top)
            if top is None:
                top = connection.execute("""insert into app.album_lists(ref,owner_account_id,library_id,title,description)
                    values(%s,%s,%s,'Loader-only transaction','') returning *""",
                    (str(uuid4()), live.actor.account_id, live.library_id)).fetchone()
            locked = None
            if provide_prelock:
                args = (live.library_id, live.actor.account_id, live.actor.session_id, context_ref, target.kind,
                    target.ref, actual_owner, int(target.revision) if target.revision else None,
                    str(top['ref']), int(top['revision']), Jsonb([descriptor]))
                locked = membership._sql(connection, "select app.lock_top_remote_membership_sources(" + ','.join(['%s'] * 11)
                    + ") as sources", args).fetchone()['sources'][0]
            return load_pending_remote_source(connection, selector=selected, live=live,
                destination=target, owner_account_id=actual_owner, context_ref=context_ref,
                prelocked_source=locked)


def test_create_is_per_draft_needs_no_goals_and_never_maps_or_mutates_membership(remote):
    first, second = remote.prepare_v2(), remote.prepare_v2()
    before = remote.unrelated()
    assert not before["listening_goals"] and not before["listening_goal_evidence"]
    searched = search(remote, first)
    assert remote.rows() == []
    assert searched["destination"] == first["destination"]
    assert "acquisition_ref" not in searched and "evidence_version" not in searched["candidates"][0]
    one, two = remote.acquire(first), remote.acquire(second)
    assert one["destination"] != two["destination"]
    assert one["acquisition_ref"] != two["acquisition_ref"]
    assert one['version'] == two['version'] == 2 and one['state'] == two['state'] == 'pending'
    assert one['preparation_ref'] == first['preparation_ref']
    assert two['preparation_ref'] == second['preparation_ref']
    assert one['preparation_ref'] != two['preparation_ref']
    state = remote.c2_state()
    assert len(state['album_top_remote_preparations']) == len(state['album_top_remote_attempts']) == 2
    assert all(row['state'] == 'pending' for row in state['album_top_remote_attempts'])
    assert all(row['attempt_count'] == row['pending_count'] == 1 for row in state['album_top_remote_preparations'])
    assert state['album_top_remote_pending_budgets'][0]['pending_count'] == 2
    assert state['album_top_remote_pending_budgets'][0]['pending_bytes'] == sum(row['facts_bytes'] for row in remote.rows())
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
    command = (remote.prepare_v2(destination(top), actor=actor) if expected is None else
        {"version": 2, "preparation_ref": str(uuid4()), **payload(destination(top))})
    before = remote.unrelated()
    if expected:
        assert_error(lambda: remote.begin_v2(destination(top), actor=actor), *expected)
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
    target = destination(top) if action == ITEMS else destination()
    command = payload(target) if operation == "search" else remote.prepare_v2(target)
    if operation == "replay":
        remote.acquire(command)
    before, calls, c2 = remote.rows(), len(remote.calls), remote.c2_state()
    observed = []
    def constraints(context):
        observed.append(context.action)
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != action)
    callback = (lambda: search(remote, command, constraints=constraints)) if operation == "search" else (
        lambda: remote.acquire(command, constraints=constraints))
    assert_error(callback, "forbidden", 403)
    assert action in observed and len(remote.calls) == calls and remote.rows() == before
    assert remote.c2_state() == c2


@pytest.mark.parametrize("operation", ["search", "acquire"])
@pytest.mark.parametrize("changed", ["account", "session", "membership", "browse", "editor", "revision", "deleted"])
def test_provider_gap_rechecks_current_authority_session_library_and_top(remote, operation, changed):
    database = remote.db
    editor = member(database)
    top, _ = database.create(refs=[])
    top, _ = write(database, "grant_editor", top, account_id=editor.account_id, role="editor")
    grant_ref = top["grant_ref"]
    command = payload(destination(top)) if operation == "search" else remote.prepare_v2(destination(top), actor=editor)
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
    if operation == "acquire":
        assert remote.c2_state() == remote.reservation_states[get_ident()]


@pytest.mark.parametrize("boundary", ["session_expiry", "policy", "cancel"])
def test_late_denial_after_real_insert_rolls_back_acquisition_and_response(remote, boundary):
    observed_now = [remote.db.now]
    remote.db.service._clock = lambda: observed_now[0]
    inserted = []
    def after(sql, connection):
        if sql.startswith("select app.finish_top_remote_attempt("):
            inserted.append(connection.execute("select count(*) as n from app.album_top_remote_acquisitions where actor_account_id=%s",
                                               (remote.db.owner.account_id,)).fetchone()["n"])
            if boundary == "session_expiry":
                observed_now[0] += timedelta(days=2)
    remote.after_statement = after
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (inserted and boundary == "policy"))
    cancelled = lambda: bool(inserted and boundary == "cancel")
    command = remote.prepare_v2()
    before = remote.unrelated()
    assert_error(lambda: remote.acquire(command, constraints=constraints, should_cancel=cancelled),
                 "provider_cancelled" if boundary == "cancel" else "forbidden", 503 if boundary == "cancel" else 403)
    assert inserted == [1]
    assert remote.rows() == [] and remote.unrelated() == before
    assert remote.c2_state() == remote.reservation_states[get_ident()]


def test_lost_response_exact_recovery_keeps_first_facts_without_new_provider_io(remote):
    command = remote.prepare_v2()
    first = remote.acquire(command)
    before = remote.rows()
    c2_before = remote.c2_state()
    remote.facts = evidence(title="Later provider correction")
    assert remote.acquire(command) == first
    assert len(remote.calls) == 1 and remote.rows() == before
    assert remote.c2_state() == c2_before


@pytest.mark.parametrize("change", ["release_group", "draft", "context", "session", "library", "top"])
def test_exact_request_key_is_bound_to_original_command_context_session_and_destination(remote, change):
    database = remote.db
    command = remote.prepare_v2()
    remote.acquire(command)
    before = remote.rows()
    c2_before = remote.c2_state()
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
                 "request_key_conflict" if change == "release_group" else "remote_evidence_unavailable", 409)
    assert len(remote.calls) == 1 and remote.rows() == before
    assert remote.c2_state() == c2_before


# The exact expired expansion is mapped to remote_consumption_expiry_acceptance.py; unexecuted.
@pytest.mark.parametrize("state", ["retired"])
def test_expired_or_retired_exact_recovery_cannot_refresh_or_contact_provider(remote, state):
    command = remote.prepare_v2()
    receipt = remote.acquire(command)
    remote.retire_pending(receipt['acquisition_ref'])
    before = remote.rows(), remote.c2_state()
    assert_error(lambda: remote.acquire(command), "remote_preparation_unavailable", 409)
    assert len(remote.calls) == 1 and (remote.rows(), remote.c2_state()) == before


@pytest.mark.parametrize("change", ["actor", "session", "library", "context", "draft", "top", "revision", "owner", "version"])
def test_pending_source_selector_preserves_every_original_binding(remote, change):
    database = remote.db
    command = remote.prepare_v2()
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
    command = remote.prepare_v2(destination(top))
    receipt = remote.acquire(command)
    saved, _ = write(remote.db, "save", top, title="New saved revision")
    assert_error(lambda: pending(remote, receipt, command), "revision_conflict", 409)
    assert_error(lambda: pending(remote, receipt, command, target=destination(saved)), "remote_evidence_unavailable", 409)


def test_concurrent_same_key_has_one_first_committed_immutable_result(remote):
    command = remote.prepare_v2()
    entered, release = Event(), Event()
    calls = []
    def provider(mbid, **options):
        remote.outside_authority()
        calls.append(mbid)
        entered.set()
        assert release.wait(10)
        return evidence(title="First committed")
    remote.service.provider = provider
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(remote.acquire, command)
        try:
            assert entered.wait(10)
            reserved = remote.c2_state()
            retry = pool.submit(remote.acquire, command).result(timeout=5)
            assert retry['version'] == 2 and retry['state'] == 'in_flight'
            assert remote.c2_state() == reserved and calls == [command['release_group_id']]
        finally:
            release.set()
        winner = first.result(timeout=10)
    after = remote.c2_state()
    assert remote.acquire(command) == winner
    assert remote.c2_state() == after and calls == [command['release_group_id']]
    assert winner['album']['title'] == 'First committed'
    assert len(remote.rows()) == 1 and remote.rows()[0]['title'] == 'First committed'
    assert len(after['album_top_remote_attempts']) == 1
    assert after['album_top_remote_preparations'][0]['attempt_count'] == 1


@pytest.mark.parametrize("operation", ["search", "acquire"])
def test_provider_error_is_checked_after_current_authority_and_leaves_no_evidence(remote, operation):
    def failed(*args, **kwargs):
        remote.outside_authority()
        with remote.db.connect() as connection:
            connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s",
                               (remote.db.owner.session_id,))
        raise RemoteAlbumEvidenceError("provider_unavailable")
    remote.service.provider = remote.service.searcher = failed
    command = payload() if operation == "search" else remote.prepare_v2()
    assert_error((lambda: search(remote, command)) if operation == "search" else (lambda: remote.acquire(command)),
                 "forbidden", 403)
    assert remote.rows() == []
    if operation == 'acquire':
        attempts = remote.c2_state()['album_top_remote_attempts']
        assert len(attempts) == 1 and attempts[0]['state'] == 'reserved'


def test_false_late_cancellation_observer_cannot_change_policy_after_the_final_fence(remote):
    read_pending = []
    denied = []
    def after(sql, connection):
        if sql.startswith("select app.finish_top_remote_attempt("):
            read_pending.append(True)
    def cancellation_observer():
        if read_pending:
            denied.append(True)
        return False
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    remote.after_statement = after
    command = remote.prepare_v2()
    before = remote.unrelated()
    assert_error(lambda: remote.acquire(command, should_cancel=cancellation_observer, constraints=constraints),
                 "forbidden", 403)
    assert read_pending == [True] and denied
    assert remote.rows() == [] and remote.unrelated() == before
    assert remote.c2_state() == next(iter(remote.reservation_states.values()))


# The exact expired expansion is mapped to remote_consumption_expiry_acceptance.py; unexecuted.
@pytest.mark.parametrize("state", ["retired"])
def test_pending_source_loader_rejects_expired_and_retired_rows_under_current_authority(remote, state):
    command = remote.prepare_v2()
    receipt = remote.acquire(command)
    remote.retire_pending(receipt['acquisition_ref'])
    before = remote.c2_state()
    assert_error(lambda: pending(remote, receipt, command), "remote_evidence_unavailable", 409)
    assert len(remote.calls) == 1 and len(remote.rows()) == 1 and remote.c2_state() == before


@pytest.mark.parametrize("changed", ["editor", "session", "revision"])
def test_committed_recovery_still_needs_current_editor_session_and_top_revision(remote, changed):
    database = remote.db
    editor = member(database)
    top, _ = database.create(refs=[])
    top, _ = write(database, "grant_editor", top, account_id=editor.account_id, role="editor")
    command = remote.prepare_v2(destination(top), actor=editor)
    remote.acquire(command, actor=editor)
    if changed == "editor":
        write(database, "revoke_editor", top, grant_ref=top["grant_ref"])
    elif changed == "revision":
        write(database, "save", top, title="Revision changed after acquisition")
    else:
        with database.connect() as connection:
            connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (editor.session_id,))
    before = remote.rows()
    c2_before = remote.c2_state()
    code, status = {"editor": ("top_unavailable", 404), "session": ("forbidden", 403),
                    "revision": ("revision_conflict", 409)}[changed]
    assert_error(lambda: remote.acquire(command, actor=editor), code, status)
    assert len(remote.calls) == 1 and remote.rows() == before
    assert remote.c2_state() == c2_before
