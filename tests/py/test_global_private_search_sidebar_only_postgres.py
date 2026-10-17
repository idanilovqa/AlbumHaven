"""Strict sidebar-only mode through native HTTP, live SQL and shared budgets."""
from datetime import timedelta
import json
import sys

import pytest

from tests.py.test_global_private_search_postgres import db, isolated_urls, connect, album_ref
from tests.py.global_search_review_support import bulk_tracks, observe_consumption
from tests.py.test_global_search_review_cursor_postgres import open_cursor, seal_cursor
from tests.py.global_search_sidebar_review_support import seed_parent, child_params, child_read, assert_only_sidebar_sql
from tests.py.test_global_search_revision2_surface_normalization import configure_scan, forbid_fallback


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
@pytest.mark.parametrize("selection", ["selected", "all_artists"])
@pytest.mark.parametrize("scan", [False, True])
def test_sidebar_only_exact_dto_native_order_and_no_main_or_detail_sql(db, monkeypatch, presentation, selection, scan):
    parent, _records, order = seed_parent(db, presentation, selection, categories=True)
    params = {**child_params(parent), "category": ["main_library", "hoard", "main_library"]}
    configure_scan(db, scan)
    forbid_fallback(monkeypatch)
    with observe_consumption(monkeypatch) as trace:
        child = child_read(db, params, parent=parent)
    assert_only_sidebar_sql(trace, db)
    assert [row["artist"] for row in child["sidebar"]["artists"]] == order[50:]
    assert child["sidebar"]["has_more"] is False
    # Retained main and bounded detail transports remain actual independent
    # route controls; child envelopes are never treated as their return shape.
    main = db.read(search_presentation=presentation, **({"artist": parent["selected_artist"]} if selection == "selected" else {"all_artists": "1"}))
    assert "sidebar_only" not in main and "page" in main and "tracks" in main
    detail = db.read(search_detail_album_ref=album_ref(db, db.main_album))
    assert detail["presentation"] == "album_detail" and "sidebar_only" not in detail


@pytest.mark.parametrize("field,value", [
    ("search_cursor", "foreign-result-cursor"), ("search_detail_album_ref", "inventory-album:1:1"),
    ("omit_sidebar", "1"), ("omit_sidebar", "0"), ("search_page_size", "1"),
    ("gallery_cursor", "root-cursor"), ("gallery_page_size", "50"),
    ("payload_tier", "search_preview"), ("payload_tier", "sidebar"),
    ("search_sidebar_only", "0"), ("search_sidebar_only", "true"),
    ("search_sidebar_only", ""), ("search_sidebar_only", " 1"),
    ("all_artists", "0"), ("unknown_child_filter", "value"),
])
def test_sidebar_only_rejects_incompatible_or_invalid_fields(db, field, value):
    parent, _records, _order = seed_parent(db)
    child_read(db, {**child_params(parent), field: value}, expected=400, code="invalid_private_search_request")
    assert db.sql == []


@pytest.mark.parametrize("missing", ["search_sidebar_cursor", "search_presentation", "all_artists", "q"])
def test_sidebar_only_requires_explicit_stable_selection_presentation_query_and_cursor(db, missing):
    parent, _records, _order = seed_parent(db)
    params = child_params(parent)
    params.pop(missing)
    child_read(db, params, expected=400, code="invalid_private_search_request")
    assert db.sql == []


def test_sidebar_only_rejects_conflicting_explicit_selection_fields(db):
    parent, _records, _order = seed_parent(db, selection="selected")
    child_read(db, {**child_params(parent), "all_artists": "1"}, expected=400, code="invalid_private_search_request")
    assert db.sql == []


@pytest.mark.parametrize("field", ["surface", "q", "search_sidebar_only", "search_presentation", "search_sidebar_cursor", "all_artists"])
def test_sidebar_only_rejects_duplicate_scalars_even_when_identical(db, field):
    parent, _records, _order = seed_parent(db)
    params = child_params(parent)
    pairs = list(params.items()) + [(field, params[field])]
    child_read(db, pairs, expected=400, code="invalid_private_search_request")
    assert db.sql == []


@pytest.mark.parametrize("state", ["pending_page", "empty"])
def test_sidebar_only_rejects_nonstable_sealed_selection_states(db, state):
    parent, _records, _order = seed_parent(db)
    params = child_params(parent)
    decoded = open_cursor(params["search_sidebar_cursor"])
    decoded["selection"] = {"state": state, "artist": None, "witness": None, "pending": None}
    params["search_sidebar_cursor"] = seal_cursor(decoded)
    child_read(db, params, expected=400, code="invalid_private_search_request")


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_sidebar_only_budget_exhaustion_is_empty_resumable_work_not_terminal_zero(db, monkeypatch, presentation):
    parent, records, order = seed_parent(db, presentation)
    next_name = order[50]
    artist, album, previous_witness = records[next_name]
    # Complete test-owned dataset is prepared before the parent is refreshed.
    # Replace no rows: retain the original witness, now denied, and append 101.
    later = bulk_tracks(db, album, 101, title="Sidebar Pending Witness")
    denied = [previous_witness, *later[:99]]
    db.denied.update(("track", str(track)) for track in denied)
    parent = db.read(search_presentation=presentation, all_artists="1")
    params = child_params(parent)
    with observe_consumption(monkeypatch) as trace:
        first = child_read(db, params, parent=parent)
    assert_only_sidebar_sql(trace, db)
    assert first["sidebar"]["artists"] == []
    assert first["sidebar"]["has_more"] is True
    seen = set()
    names = []
    current = first
    for _ in range(len(db.tracks) + len(db.artist_names) + 2):
        cursor = current["sidebar"]["next_cursor"]
        if cursor is None:
            break
        logical = json.dumps(open_cursor(cursor), sort_keys=True)
        assert logical not in seen, "Sidebar pending position did not advance"
        seen.add(logical)
        with observe_consumption(monkeypatch) as trace:
            current = child_read(db, {**params, "search_sidebar_cursor": cursor}, parent=parent)
        assert_only_sidebar_sql(trace, db)
        page_names = [row["artist"] for row in current["sidebar"]["artists"]]
        assert not set(page_names) & set(names)
        names.extend(page_names)
    else:
        pytest.fail("Finite sidebar candidate stream never completed")
    assert names == order[50:]


@pytest.mark.parametrize("denial", ["track", "album", "artist"])
def test_sidebar_only_filters_new_unreadable_candidates_through_native_resource_checks(db, monkeypatch, denial):
    parent, records, order = seed_parent(db)
    name = order[50]
    artist, album, track = records[name]
    db.denied.add((denial, str({"track": track, "album": album, "artist": artist}[denial])))
    with observe_consumption(monkeypatch) as trace:
        child = child_read(db, child_params(parent), parent=parent)
    assert_only_sidebar_sql(trace, db)
    assert [row["artist"] for row in child["sidebar"]["artists"]] == [value for value in order[50:] if value != name]


def test_sidebar_only_session_expiry_after_real_sql_before_response_is_forbidden(db, monkeypatch):
    parent, _records, _order = seed_parent(db)
    # A successful native parent route has already loaded its actual service.
    # Read that registered module rather than importing a proposed/missing module
    # during collection or before the public route's substantive behavior gate.
    route_owner = sys.modules.get("music_app.routes.private_search_asgi")
    assert route_owner is not None, "Successful personal route must have its native registered owner"
    now = [db.now]
    service = route_owner.PostgresPrivateSearchService(db.app.state.config, clock=lambda: now[0])
    db.app.state.private_search_service = service
    import psycopg
    execute = psycopg.Connection.execute
    advanced = []

    def observed(connection, query, params=None, *args, **kwargs):
        cursor = execute(connection, query, params, *args, **kwargs)
        columns = {column.name for column in cursor.description or ()}
        if "track_id" in columns and not advanced:
            advanced.append(True)
            now[0] = db.now + timedelta(hours=13)
        return cursor

    monkeypatch.setattr(psycopg.Connection, "execute", observed)
    child_read(db, child_params(parent), expected=403, code="private_search_forbidden")
    assert advanced, "Clock must advance during an actual native SQL read, not before admission"
    assert sum("from app.account_sessions" in sql.casefold() for sql, _count in db.sql) >= 2


def test_sidebar_only_real_driver_failure_is_private_service_error_without_main_fallback(db, monkeypatch):
    parent, _records, _order = seed_parent(db)
    import psycopg
    execute = psycopg.Connection.execute
    failed = []

    def fault(connection, query, params=None, *args, **kwargs):
        cursor = execute(connection, query, params, *args, **kwargs)
        if "track_id" in {column.name for column in cursor.description or ()}:
            failed.append(True)
            raise RuntimeError("Synthetic native result-consumption failure")
        return cursor

    monkeypatch.setattr(psycopg.Connection, "execute", fault)
    child_read(db, child_params(parent), expected=503, code="private_search_unavailable")
    assert failed, "Service failure must occur at a real native SQL read"
