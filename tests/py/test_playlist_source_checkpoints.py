"""Paged source contracts with injected rows, not PostgreSQL search/race proof."""
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal
import json
from uuid import UUID

import pytest

from music_app.services import owned_playlists as commands
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from tests.py.owned_playlist_testing import (
    ACCOUNT, SESSION, LIBRARY, NOW, REQUEST, PLAYLIST, SOURCE, SOURCE_REVISION,
    ENTRY_A, ENTRY_B, Connection, Step, context, authority_steps, receipt_lookup,
    source_row, source_step, inventory_row, inventory_steps, create_body,
)


def observed(row, *, ref=ENTRY_A, source=SOURCE, selection=ENTRY_A):
    return {key: deepcopy(value) for key, value in row.items() if key not in {"inventory_evidence", "sort_key"}} | {
        "ref": ref, "source_ref": source, "selection_ref": selection,
        "evidence_digest": sources.entry_evidence(row),
    }


def assert_error(callback, code, status):
    with pytest.raises(commands.PlaylistError) as caught:
        callback()
    assert (caught.value.code, caught.value.status_code) == (code, status)


def make_cursor(**changes):
    payload = {"source": SOURCE, "revision": SOURCE_REVISION, "query": "needle",
               "upper": 1000, "sort": "title-album-v1", "after": [1, 0, 2020, 501, 1, 1, 901],
               "search_revision": "70000000-0000-4000-8000-000000000001", **changes}
    return payload


def test_begin_source_binds_current_actor_session_and_library_to_inventory_ceiling():
    connection = Connection([Step("select coalesce(max(id),0)", [{"upper_id": 1000}], (LIBRARY,)),
                             Step("insert into app.playlist_creation_sources")])
    result = sources.begin_source(connection, context(), NOW)
    inserted = connection.writes[0][1]
    assert (inserted["actor_account_id"], inserted["session_id"], inserted["library_id"]) == (ACCOUNT, SESSION, LIBRARY)
    assert inserted["inventory_upper_id"] == 1000
    assert inserted["expires_at"] == NOW + timedelta(minutes=30)
    assert result["source_protocol"] == "library_selection_v1"
    assert result["source"] == {"kind": "library", "ref": inserted["ref"], "revision": inserted["revision"]}
    assert "entries_complete" not in result
    connection.done()


@pytest.mark.parametrize("case,code,status", [
    ("missing", "source_unavailable", 404), ("revision", "source_changed", 409),
    ("protocol", "source_changed", 409), ("expiry", "source_expired", 410),
])
def test_source_load_is_actor_session_library_scoped_and_rejects_invalid_receipts(case, code, status):
    row = source_row()
    if case == "revision":
        row["revision"] = ENTRY_A
    elif case == "protocol":
        row["protocol"] = "complete_source_v1"
    elif case == "expiry":
        row["expires_at"] = NOW
    connection = Connection([source_step([] if case == "missing" else [row])])
    assert_error(lambda: sources.load_source(connection, context(), SOURCE, SOURCE_REVISION, NOW), code, status)
    assert connection.writes == []
    connection.done()


@pytest.mark.parametrize("case,code", [("missing", "source_unavailable"), ("duplicate_inventory", "duplicate_identity"),
                                     ("removed_inventory", "source_changed"), ("changed_metadata", "source_changed"),
                                     ("changed_private_file", "source_changed")])
def test_create_rejects_mixed_invalid_selection_before_any_playlist_or_operation_write(case, code):
    first, second = inventory_row(901), inventory_row(902)
    rows = [observed(first), observed(second, ref=ENTRY_B)]
    if case == "missing":
        rows = rows[:1]
    elif case == "duplicate_inventory":
        rows[1] = observed(first, ref=ENTRY_B)
    current = [deepcopy(first), deepcopy(second)]
    if case == "removed_inventory":
        current.pop()
    elif case == "changed_metadata":
        current[1]["title"] = "Changed title"
    elif case == "changed_private_file":
        current[1]["inventory_evidence"][2][0][5] = "changed-signature"
    steps = [*authority_steps(), receipt_lookup(), source_step(),
             Step("from app.playlist_creation_entries", rows, (SOURCE, [ENTRY_A, ENTRY_B]))]
    if case not in {"missing", "duplicate_inventory"}:
        steps.extend(inventory_steps([901, 902], current))
    connection = Connection(steps)
    service = PostgresOwnedPlaylistsService({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://synthetic-invalid/checkpoints"},
                                           connect=lambda _url: connection, clock=lambda: NOW)
    cmd = commands.normalize_playlist_command("create", create_body(refs=[ENTRY_A, ENTRY_B]))
    assert_error(lambda: service.execute(context(), cmd), code, 409)
    assert connection.writes == []
    assert connection.exits[0] is not None
    connection.done()


def test_selected_receipts_preserve_authored_order_after_sorted_lock_preflight():
    first, second = inventory_row(901), inventory_row(902)
    a, b = observed(first), observed(second, ref=ENTRY_B)
    connection = Connection([Step("from app.playlist_creation_entries", [a, b], (SOURCE, [ENTRY_B, ENTRY_A])),
                             *inventory_steps([901, 902], [first, second])])
    result = sources.selected_entries(connection, context(), source_row(), [ENTRY_B, ENTRY_A])
    assert [row["ref"] for row in result] == [ENTRY_B, ENTRY_A]
    assert [row["original_local_track_id"] for row in result] == [902, 901]
    connection.done()


def test_empty_selection_does_not_expand_to_inventory_or_issue_any_query():
    connection = Connection()
    assert sources.selected_entries(connection, context(), source_row(), []) == []
    assert connection.operations == []


@pytest.mark.parametrize("field,index", [("track_key", 0), ("artist_id", 1), ("file_id", 0),
    ("root_id", 1), ("path", 2), ("size", 3), ("modified", 4), ("signature", 5),
    ("stale", 6), ("root_library", 7), ("root_active", 8)])
def test_same_labels_with_changed_private_inventory_evidence_invalidate_observation(field, index):
    before = inventory_row()
    after = deepcopy(before)
    target = after["inventory_evidence"] if field in {"track_key", "artist_id"} else after["inventory_evidence"][2][0]
    value = target[index]
    target[index] = not value if type(value) is bool else value + 1 if type(value) is int else value + "-changed"
    assert before["title"] == after["title"] and before["availability"] == after["availability"]
    assert sources.entry_evidence(before) != sources.entry_evidence(after)


def test_observation_insert_is_immutable_and_selection_identity_stays_stable_across_changed_facts():
    source = source_row()
    rows = [inventory_row(), inventory_row(title="New title")]
    inserted = []
    for row, ref in zip(rows, [ENTRY_A, ENTRY_B]):
        connection = Connection([Step("insert into app.playlist_creation_entries",
                clauses=("on conflict(source_ref,original_local_track_id,evidence_digest) do nothing",)),
            Step("select e.* from app.playlist_creation_entries", [observed(row, ref=ref)])])
        result = sources._observe_page(connection, source, [row])
        values = json.loads(connection.writes[0][1][0])[0]
        inserted.append(values)
        assert result[0]["ref"] == ref
        assert "inventory_evidence" not in values
        assert "/synthetic/" not in json.dumps(values)
        connection.done()
    assert inserted[0]["selection_ref"] == inserted[1]["selection_ref"]
    assert inserted[0]["ref"] != inserted[1]["ref"]
    assert inserted[0]["evidence_digest"] != inserted[1]["evidence_digest"]


def test_selection_identity_is_source_scoped_for_the_same_real_inventory_row():
    values = []
    for source_id in [SOURCE, ENTRY_B]:
        row = inventory_row()
        connection = Connection([Step("insert into app.playlist_creation_entries"),
                                 Step("select e.* from app.playlist_creation_entries", [observed(row)])])
        sources._observe_page(connection, source_row(ref=source_id), [row])
        values.append(json.loads(connection.writes[0][1][0])[0]["selection_ref"])
    assert values[0] != values[1]


def test_public_source_entry_never_exposes_private_evidence_or_file_paths():
    row = observed(inventory_row())
    row["inventory_evidence"] = inventory_row()["inventory_evidence"]
    payload = sources.project_entry(source_row(), row)
    encoded = json.dumps(payload)
    assert "inventory_evidence" not in encoded and "/synthetic/" not in encoded
    assert "evidence_digest" not in encoded and "original_local_track_id" not in encoded
    assert payload["inventory_track_ref"] == "inventory-track:73:901"
    assert payload["parent_album"]["album_ref"] == "inventory-album:73:501"


@pytest.mark.parametrize("changes", [
    {"source": ENTRY_A}, {"revision": ENTRY_A}, {"query": "other"}, {"upper": 1001},
    {"sort": "new-order"}, {"extra": True}, {"search_revision": "7"},
    {"after": None}, {"after": [1, 0, 2020, 501, 1, 901]},
    {"after": [1, 0, 2020, 501, 1, 1, 1001]},
    {"after": [2, 0, 2020, 501, 1, 1, 901]}, {"after": [1, 2, 2020, 501, 1, 1, 901]},
    {"after": [True, 0, 2020, 501, 1, 1, 901]}, {"after": [1, 0, -1, 501, 1, 1, 901]},
    {"after": [1, 0, 2020.0, 501, 1, 1, 901]},
    {"after": [1, 0, 9223372036854775808, 501, 1, 1, 901]},
])
def test_mismatched_or_out_of_range_cursor_fails_before_inventory_query(changes):
    connection = Connection([Step("select payload from app.playlist_source_cursors",
        [{"payload":make_cursor(**changes)}], (ENTRY_B,SOURCE))])
    assert_error(lambda: sources.search_entries(connection, context(), source_row(), query="needle",
                                                cursor=ENTRY_B), "invalid_cursor", 422)
    assert len(connection.operations) == 1
    assert "library.local_tracks" not in connection.operations[0][0]
    connection.done()


@pytest.mark.parametrize("cursor", ["bad!", "a" * 2049, "W10", "bnVsbA", "e30", True, 42])
def test_malformed_cursor_cannot_be_used_as_a_broader_unbounded_query(cursor):
    connection = Connection()
    assert_error(lambda: sources.search_entries(connection, context(), source_row(), cursor=cursor), "invalid_cursor", 422)
    assert connection.operations == []


@pytest.mark.parametrize("query,limit", [(None, 100), ("x" * 201, 100), ("x\x00y", 100),
                                       ("", 0), ("", 101), ("", True), ("", 1.0)])
def test_invalid_query_and_page_bounds_fail_without_reading_inventory(query, limit):
    connection = Connection()
    assert_error(lambda: sources.search_entries(connection, context(), source_row(), query=query, limit=limit), "invalid_source_query", 422)
    assert connection.operations == []


def test_search_is_bounded_literal_escaped_and_never_claims_page_is_complete_catalogue():
    row = inventory_row(duration_seconds=Decimal("123.25"))
    row["sort_key"] = [1, 0, 2020, 501, 1, 1, 901]
    extra = inventory_row(902)
    extra["sort_key"] = [1, 0, 2020, 501, 1, 2, 902]
    stored = observed({**row, "duration_seconds": 123.25})
    connection = Connection([Step("from library.local_tracks t", [row, extra],
        clauses=("t.library_id=%(library)s", "t.id<=%(upper)s", "limit %(limit)s")),
        Step("insert into app.playlist_creation_entries"), Step("select e.* from app.playlist_creation_entries", [stored]),
        Step("insert into app.playlist_source_cursors")])
    result = sources.search_entries(connection, context(), source_row(), query="  50%_\\  mix  ", limit=1)
    params = connection.operations[0][1]
    assert params == {"library": LIBRARY, "query": "50%_\\ mix", "pattern": "%50\\%\\_\\\\ mix%", "upper": 1000, "limit": 2}
    assert result["entries_complete"] is False and result["has_more"] is True
    assert len(result["entries"]) == 1
    assert result["entries"][0]["duration_seconds"] == 123.25
    assert len(json.loads(connection.writes[0][1][0])) == 1
    assert str(UUID(result["search_revision"])) == result["search_revision"]
    connection.done()
    cursor_insert = connection.writes[-1][1]
    assert result["next_cursor"] == str(UUID(cursor_insert[0]))
    next_connection = Connection([Step("select payload from app.playlist_source_cursors",
        [{"payload":json.loads(cursor_insert[2])}], (result["next_cursor"],SOURCE)),
        Step("from library.local_tracks t", [], clauses=("and row(", ") > row("))])
    following = sources.search_entries(next_connection, context(), source_row(), query=result["query"],
                                       cursor=result["next_cursor"], limit=1)
    assert following["search_revision"] == result["search_revision"]
    assert following["entries_complete"] is False and following["has_more"] is False
    assert following["entries"] == [] and following["next_cursor"] is None
    assert [next_connection.operations[1][1][f"after_{index}"] for index in range(7)] == row["sort_key"]
    next_connection.done()
