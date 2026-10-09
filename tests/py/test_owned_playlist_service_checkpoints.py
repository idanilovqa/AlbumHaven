"""Independent injectable service checkpoints, not live transaction verification.

No database or socket is used here. A failure reaching a connection context exit
proves error propagation, not real PostgreSQL rollback or revocation isolation.
"""
from datetime import timedelta
import json
from uuid import UUID

import pytest

from music_app.services import owned_playlists as commands
from music_app.services import owned_playlists_postgres as postgres
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.owned_playlist_testing import (
    ACCOUNT, SESSION, LIBRARY, NOW, ALL_ACTIONS, REQUEST, PLAYLIST, OTHER_PLAYLIST,
    ITEM_A, ITEM_B, ITEM_C, SOURCE, SOURCE_REVISION, ENTRY_A, ENTRY_B,
    Connection, Step, context, authority_steps, receipt_lookup, playlist_row, owned_step,
    item_row, item_step, source_row, source_step, inventory_row, inventory_steps, create_body,
)


def service(connection, *, clock=lambda: NOW):
    return postgres.PostgresOwnedPlaylistsService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://synthetic-invalid/checkpoints"},
        connect=lambda _url: connection, clock=clock,
    )


def command(action="save", **data):
    return commands.normalize_playlist_command(action, {"request_key": REQUEST, "revision": "7", **data},
                                               playlist_ref=PLAYLIST)


def assert_error(callback, code, status):
    with pytest.raises(commands.PlaylistError) as caught:
        callback()
    assert (caught.value.code, caught.value.status_code) == (code, status)
    return caught.value


def prior_receipt(cmd, **changes):
    receipt = {"ok": True, "action": cmd.action, "request_key": REQUEST,
               "playlist_id": PLAYLIST, "revision": "8", "changed": True,
               "actor_scope": {"account_id": ACCOUNT, "library_id": LIBRARY}}
    return {"original_session_id": SESSION, "command_digest": cmd.digest,
            "action": cmd.action, "playlist_ref": PLAYLIST, "receipt": receipt, **changes}


def existing_steps(*, grants=ALL_ACTIONS, rows=(), playlist=None, recheck=True):
    return [*authority_steps(grants=grants), receipt_lookup(),
            owned_step([playlist] if playlist is not None else None), item_step(rows),
            *([authority_steps()[3]] if recheck else [])]


def test_coarse_denial_never_opens_the_injected_connection():
    connection = Connection()
    assert_error(lambda: service(connection).execute(context(grants=()), command(title="Changed")), "forbidden", 403)
    assert connection.entered == 0


@pytest.mark.parametrize("checkpoint", ["missing_account", "inactive_account", "disabled_account",
    "missing_session", "revoked_session", "idle_expired", "absolute_expired", "missing_membership", "revoked_browse"])
def test_live_authority_is_reloaded_in_lock_order_before_any_receipt_lookup(checkpoint):
    steps = authority_steps()
    stop = 6
    if checkpoint == "missing_account":
        steps[2].rows = []
        stop = 2
    elif checkpoint in {"inactive_account", "disabled_account"}:
        steps[2].rows[0].update({"is_active": False} if checkpoint == "inactive_account" else {"disabled_at": NOW})
        stop = 2
    elif checkpoint in {"missing_session", "revoked_session", "idle_expired", "absolute_expired"}:
        stop = 3
        if checkpoint == "missing_session":
            steps[3].rows = []
        else:
            field = {"revoked_session": "revoked_at", "idle_expired": "idle_expires_at", "absolute_expired": "absolute_expires_at"}[checkpoint]
            steps[3].rows[0][field] = NOW
    elif checkpoint == "missing_membership":
        steps[5].rows = []
        stop = 5
    else:
        steps[6].rows = [row for row in steps[6].rows if row["capability_key"] != commands.BROWSE]
    connection = Connection(steps[:stop + 1])
    error = assert_error(lambda: service(connection).execute(context(), command(title="Changed")), "forbidden", 403)
    connection.done()
    assert connection.writes == []
    assert connection.exits and connection.exits[0] is not None
    assert all("playlist_operations" not in sql for sql, _ in connection.operations)
    assert error.code == "forbidden"


def test_session_expiring_during_session_lock_wait_is_rejected_using_post_wait_time():
    observed_now = [NOW]
    steps = authority_steps()
    steps[3].rows[0]["idle_expires_at"] = NOW + timedelta(seconds=1)
    steps[3].after = lambda: observed_now.__setitem__(0, NOW + timedelta(seconds=2))
    # No later statement is allowed after a session expired during its lock wait.
    connection = Connection(steps[:4])
    assert_error(lambda: service(connection, clock=lambda: observed_now[0]).execute(
        context(), command(title="Changed")), "forbidden", 403)
    connection.done()
    assert connection.writes == []


def test_removed_bootstrap_privilege_is_not_retained_from_initial_actor_snapshot():
    connection = Connection(authority_steps(grants=(), bootstrap=False))
    assert_error(lambda: service(connection).execute(context(grants=(), bootstrap=True),
                 command(title="Changed")), "forbidden", 403)
    assert connection.writes == []
    connection.done()


def test_callable_constraints_see_refreshed_actor_and_original_request_context_before_receipt():
    constraints_seen = []
    original = context()
    connection = Connection(authority_steps(grants=(commands.BROWSE,)))

    def constraints(refreshed):
        constraints_seen.append(refreshed)
        live = len(refreshed.actor.capability_grants) == 1
        return PolicyEvaluationConstraints(request_origin_allowed=not live)

    assert_error(lambda: service(connection).execute(original, command(title="Changed"), constraints=constraints), "forbidden", 403)
    assert len(constraints_seen) >= 2
    assert any(len(value.actor.capability_grants) == 1 for value in constraints_seen)
    for value in constraints_seen:
        assert value.request_origin is original.request_origin
        assert value.client_surface_class == original.client_surface_class
        assert value.deployment_mode == original.deployment_mode
        assert value.library_id == original.library_id
    connection.done()


@pytest.mark.parametrize("bootstrap", [False, True])
@pytest.mark.parametrize("reason", ["unknown", "foreign_owner", "foreign_library"])
def test_absent_or_foreign_target_uses_one_owner_scoped_unavailable_result(bootstrap, reason):
    target = ([owned_step([playlist_row(owner_account_id=ACCOUNT+1)]),
               Step("from app.playlist_access_grants", [], (PLAYLIST,LIBRARY,ACCOUNT))]
              if reason == "foreign_owner" else [owned_step([])])
    connection = Connection([*authority_steps(bootstrap=bootstrap), receipt_lookup(), *target])
    assert_error(lambda: service(connection).execute(context(bootstrap=bootstrap), command(title="Changed")), "playlist_unavailable", 404)
    connection.done()
    assert connection.writes == []


def test_another_session_cannot_replay_or_reuse_an_existing_create_key():
    cmd = commands.normalize_playlist_command("create", create_body())
    connection = Connection([*authority_steps(), receipt_lookup([prior_receipt(cmd, original_session_id=SESSION + 1)])])
    assert_error(lambda: service(connection).execute(context(), cmd), "operation_unavailable", 404)
    connection.done()
    assert connection.writes == []


@pytest.mark.parametrize("action", ["create", "save", "reorder"])
def test_exact_replay_returns_original_receipt_before_source_or_current_revision_checks(action):
    cmd = (commands.normalize_playlist_command("create", create_body()) if action == "create"
           else command(action, **({"title": "Changed"} if action == "save" else {"item_order": [ITEM_B, ITEM_A]})))
    prior = prior_receipt(cmd)
    connection = Connection([*authority_steps(grants=(commands.BROWSE,)), receipt_lookup([prior]),
                             owned_step([playlist_row(revision=99)],write=False),authority_steps()[3]])
    result = service(connection).execute(context(), cmd)
    assert result == prior["receipt"]
    assert result["revision"] == "8"
    assert connection.writes == []
    connection.done()
    assert connection.exits == [None]


def test_replay_rechecks_current_owner_even_when_receipt_and_digest_match():
    cmd = command(title="Changed")
    connection = Connection([*authority_steps(bootstrap=True), receipt_lookup([prior_receipt(cmd)]), owned_step([],write=False)])
    assert_error(lambda: service(connection).execute(context(bootstrap=True), cmd), "playlist_unavailable", 404)
    assert connection.writes == []
    connection.done()


@pytest.mark.parametrize("change", ["title", "description", "order", "revision", "target", "action"])
def test_reused_key_with_different_semantic_command_rejects_before_mutation(change):
    original = command(title="Changed", description="Text", item_order=[ITEM_B, ITEM_A])
    data = dict(original.data)
    action, target = "save", PLAYLIST
    if change == "title":
        data["title"] = "Different"
    elif change == "description":
        data["description"] = "Different"
    elif change == "order":
        data["item_order"] = [ITEM_A, ITEM_B]
    elif change == "revision":
        data["revision"] = "8"
    elif change == "target":
        target = OTHER_PLAYLIST
    else:
        action, data = "reorder", {"revision": "7", "item_order": [ITEM_B, ITEM_A]}
    changed = commands.normalize_playlist_command(action, {**data, "request_key": REQUEST}, playlist_ref=target)
    connection = Connection([*authority_steps(), receipt_lookup([prior_receipt(original)])])
    assert_error(lambda: service(connection).execute(context(), changed), "idempotency_key_reused", 409)
    assert connection.writes == []
    connection.done()


def test_operation_read_binds_original_session_and_returns_unknown_without_leaking_old_receipt():
    step = Step("from app.playlist_operations", [], (ACCOUNT, LIBRARY, REQUEST, SESSION),
                clauses=("original_session_id=%s",))
    connection = Connection([*authority_steps(), step])
    assert service(connection).read_operation(context(), REQUEST) == {"status": "unknown"}
    connection.done()


def test_operation_read_requires_current_owner_before_returning_committed_receipt():
    prior = prior_receipt(command(title="Changed"))
    connection = Connection([*authority_steps(), Step("from app.playlist_operations", [prior],
        (ACCOUNT, LIBRARY, REQUEST, SESSION), clauses=("original_session_id=%s",)), owned_step([],write=False)])
    assert_error(lambda: service(connection).read_operation(context(), REQUEST), "playlist_unavailable", 404)
    connection.done()


def test_stale_revision_rejects_before_loading_items_or_writing_receipt():
    connection = Connection([*authority_steps(), receipt_lookup(), owned_step([playlist_row(revision=8)])])
    assert_error(lambda: service(connection).execute(context(), command(title="Changed")), "revision_conflict", 409)
    assert connection.writes == []
    connection.done()


@pytest.mark.parametrize("missing", [commands.MANAGE, commands.ITEMS])
def test_combined_metadata_and_real_reorder_require_both_live_grants_before_writes(missing):
    steps = existing_steps(grants=tuple(key for key in ALL_ACTIONS if key != missing),
                           rows=[item_row(), item_row(ITEM_B, 902, 2)], recheck=False)
    if missing == commands.MANAGE:
        steps.pop()  # Stronger current metadata admission rejects before reading items.
    connection = Connection(steps)
    assert_error(lambda: service(connection).execute(context(), command(title="Changed", item_order=[ITEM_B, ITEM_A])), "forbidden", 403)
    assert connection.writes == []
    connection.done()


def test_combined_metadata_and_order_mutation_bumps_revision_once_and_records_one_receipt():
    connection = Connection([*existing_steps(rows=[item_row(), item_row(ITEM_B, 902, 2)]),
        Step("update app.playlists set title=", params=("Changed", "Saved description", PLAYLIST)),
        Step("update app.playlist_items i set position=", params=([ITEM_B, ITEM_A], PLAYLIST)),
        Step("update app.playlists set revision=revision+1", [{"revision": 8}], (PLAYLIST,)),
        authority_steps()[3], Step("insert into app.playlist_operations")])
    result = service(connection).execute(context(), command(title="Changed", item_order=[ITEM_B, ITEM_A]))
    assert result["changed"] is True and result["revision"] == "8"
    assert len(connection.writes) == 4
    receipt_params = connection.writes[-1][1]
    assert receipt_params[:6] == (ACCOUNT, LIBRARY, REQUEST, SESSION, "save", PLAYLIST)
    assert json.loads(receipt_params[-1]) == result
    connection.done()
    assert connection.exits == [None]


def test_unchanged_full_order_with_metadata_noop_needs_manage_but_does_not_bump_revision():
    connection = Connection([*existing_steps(grants=(commands.BROWSE, commands.MANAGE), rows=[item_row()]),
                             authority_steps()[3], Step("insert into app.playlist_operations")])
    result = service(connection).execute(context(), command(title="Saved title", item_order=[ITEM_A]))
    assert result["changed"] is False and result["revision"] == "7"
    assert len(connection.writes) == 1
    connection.done()


@pytest.mark.parametrize("order", [[], [ITEM_A], [ITEM_A, ITEM_C]])
def test_every_submitted_order_must_be_the_complete_current_item_permutation(order):
    connection = Connection(existing_steps(rows=[item_row(), item_row(ITEM_B, 902, 2)], recheck=False))
    assert_error(lambda: service(connection).execute(context(), command(item_order=order)), "invalid_item_order", 409)
    assert connection.writes == []
    connection.done()


def test_remove_checks_all_refs_before_delete_and_rejects_mixed_foreign_input():
    connection = Connection(existing_steps(rows=[item_row(), item_row(ITEM_B, 902, 2)]))
    assert_error(lambda: service(connection).execute(context(), command("remove", item_refs=[ITEM_A, ITEM_C])), "item_unavailable", 409)
    assert connection.writes == []
    connection.done()


def test_remove_preserves_survivor_refs_and_compacts_the_authored_order():
    rows = [item_row(), item_row(ITEM_B, 902, 2), item_row(ITEM_C, 903, 3)]
    connection = Connection([*existing_steps(rows=rows),
        Step("delete from app.playlist_items", params=(PLAYLIST, [ITEM_B])),
        Step("update app.playlist_items i set position=", params=([ITEM_A, ITEM_C], PLAYLIST)),
        Step("update app.playlists set revision=revision+1", [{"revision": 8}]),
        authority_steps()[3], Step("insert into app.playlist_operations")])
    result = service(connection).execute(context(), command("remove", item_refs=[ITEM_B]))
    assert result["removed_count"] == 1 and result["revision"] == "8"
    connection.done()


@pytest.mark.parametrize("case", ["foreign_library", "duplicate_saved_identity", "missing_inventory", "unresolved_inventory"])
def test_add_preflights_every_row_and_never_partially_inserts(case):
    steps = existing_steps(rows=[item_row()])
    refs = ["inventory-track:73:902", "inventory-track:73:903"]
    code = "item_unavailable"
    if case == "foreign_library":
        refs[1] = "inventory-track:74:903"
    elif case == "duplicate_saved_identity":
        refs[1], code = "inventory-track:73:901", "duplicate_identity"
    else:
        rows = [inventory_row(902)]
        if case == "unresolved_inventory":
            rows.append(inventory_row(903, availability="unresolved"))
        steps.extend(inventory_steps([902, 903], rows))
        if case == "unresolved_inventory":
            steps.append(Step("from library.local_tracks t join library.local_track_files f", rows=[], params=(LIBRARY, [903])))
    connection = Connection(steps)
    assert_error(lambda: service(connection).execute(context(), command("add", track_refs=refs)), code, 409)
    assert connection.writes == []
    connection.done()


def test_add_preserves_caller_order_and_creates_fresh_item_occurrence_refs():
    connection = Connection([*existing_steps(rows=[item_row()]),
        *inventory_steps([903, 902], [inventory_row(902), inventory_row(903)]),
        authority_steps()[3], Step("insert into app.playlist_items"),
        Step("update app.playlists set revision=revision+1", [{"revision": 8}]),
        authority_steps()[3], Step("insert into app.playlist_operations")])
    result = service(connection).execute(context(), command("add", track_refs=["inventory-track:73:903", "inventory-track:73:902"]))
    inserted = json.loads(connection.writes[0][1][0])
    assert [row["original_local_track_id"] for row in inserted] == [903, 902]
    assert [row["position"] for row in inserted] == [2, 3]
    assert len({row["ref"] for row in inserted}) == 2
    assert all(str(UUID(row["ref"])) == row["ref"] and row["ref"] not in {ITEM_A, ITEM_B, ITEM_C} for row in inserted)
    assert all(row["source_ref"] is None and row["local_track_id"] == row["original_local_track_id"] for row in inserted)
    assert result["added_count"] == 2
    connection.done()


def test_empty_create_still_validates_source_and_writes_collection_and_receipt_together():
    connection = Connection([*authority_steps(), receipt_lookup(), source_step(), authority_steps()[3],
                             Step("insert into app.playlists"), authority_steps()[3], Step("insert into app.playlist_operations")])
    result = service(connection).execute(context(), commands.normalize_playlist_command("create", create_body()))
    assert result["revision"] == "1" and result["added_count"] == 0
    assert len(connection.writes) == 2
    assert connection.writes[0][1][1:] == (ACCOUNT, LIBRARY, "New Playlist", "Authored description")
    assert json.loads(connection.writes[1][1][-1]) == result
    connection.done()


@pytest.mark.parametrize("fault_at", ["metadata", "order", "revision", "receipt", "commit"])
def test_failure_at_each_save_checkpoint_escapes_without_committed_acknowledgement(fault_at):
    fault = RuntimeError(f"Synthetic {fault_at} fault")
    mutations = [Step("update app.playlists set title="), Step("update app.playlist_items i set position="),
                 Step("update app.playlists set revision=revision+1", [{"revision": 8}]),
                 authority_steps()[3], Step("insert into app.playlist_operations")]
    if fault_at != "commit":
        index = ["metadata", "order", "revision", "session", "receipt"].index(fault_at)
        mutations[index].error = fault
        mutations = mutations[:index + 1]
    connection = Connection([*existing_steps(rows=[item_row(), item_row(ITEM_B, 902, 2)]), *mutations],
                            commit_error=fault if fault_at == "commit" else None)
    with pytest.raises(RuntimeError) as caught:
        service(connection).execute(context(), command(title="Changed", item_order=[ITEM_B, ITEM_A]))
    assert caught.value is fault
    assert connection.exits == [None if fault_at == "commit" else fault]
    connection.done()


@pytest.mark.parametrize("sqlstate,code", [("23505", "duplicate_identity"), ("23503", "source_changed"),
                                           ("40001", "concurrent_change"), ("40P01", "concurrent_change")])
def test_known_sql_failures_are_translated_only_after_connection_exit_without_automatic_retry(sqlstate, code):
    fault = RuntimeError("Synthetic database failure")
    fault.sqlstate = sqlstate
    connection = Connection([*existing_steps(), Step("update app.playlists set title=", error=fault)])
    assert_error(lambda: service(connection).execute(context(), command(title="Changed")), code, 409)
    assert connection.exits == [fault]
    assert connection.entered == 1
    connection.done()


def test_direct_caller_mutation_cannot_smuggle_authority_past_command_normalization():
    cmd = command(title="Changed")
    cmd.data["owner_account_id"] = ACCOUNT + 1
    connection = Connection()
    assert_error(lambda: service(connection).execute(context(), cmd), "invalid_command", 422)
    assert connection.entered == 0


def test_orphan_projection_keeps_original_labels_and_ref_without_relinking_by_labels():
    row = item_row(local_track_id=None)
    payload = service(Connection())._track_row(context(), row, None)
    assert payload["playlist_item_id"] == ITEM_A
    assert payload["title"] == row["title"] and payload["album_title"] == row["album_title"]
    assert payload["availability"] == "unresolved" and payload["inventory_track_ref"] is None
    assert payload["source_ref"] == SOURCE
    assert "original_local_track_id" not in payload
