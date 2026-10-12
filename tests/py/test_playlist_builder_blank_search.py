"""Pure source-query contracts; not app startup, authorization or PostgreSQL proof.

Uses the real source module and its real command/policy imports. No configuration
module, application service, sys.modules substitution or import interception.
The caller must already have authenticated and loaded the source receipt.
"""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from uuid import UUID

from music_app.services import playlist_creation_sources_postgres as sources


SOURCE = "40000000-0000-4000-8000-000000000071"
REVISION = "50000000-0000-4000-8000-000000000071"
CURSOR = "60000000-0000-4000-8000-000000000071"
SEARCH_REVISION = "70000000-0000-4000-8000-000000000071"


def source_receipt():
    return {"ref": SOURCE, "revision": REVISION, "library_id": 73,
            "actor_account_id": 41, "session_id": 8,
            "protocol": "library_selection_v1", "inventory_upper_id": 1000,
            "expires_at": datetime(2026, 10, 12, 8, tzinfo=timezone.utc)}


def cursor_payload(**changes):
    return {"source": SOURCE, "revision": REVISION, "query": "",
            "upper": 1000, "sort": "title-album-v1",
            "after": [1, 0, 2020, 501, 1, 1, 901],
            "search_revision": SEARCH_REVISION, **changes}


class Connection:
    """One scripted cursor read, or no IO; never a database implementation."""
    def __init__(self, cursor_rows=None):
        self.expected_cursor_rows = deepcopy(cursor_rows)
        self.operations = []

    def execute(self, sql, params=()):
        sql = " ".join(sql.casefold().split())
        self.operations.append((sql, deepcopy(params)))
        if self.expected_cursor_rows is None:
            raise AssertionError(f"Unexpected SQL at source-query boundary: {sql}")
        assert "select payload from app.playlist_source_cursors" in sql
        assert "where ref=%s and source_ref=%s" in sql
        assert params == (CURSOR, SOURCE)
        rows, self.expected_cursor_rows = self.expected_cursor_rows, None
        return SimpleNamespace(fetchone=lambda: deepcopy(rows[0]) if rows else None)

    def done(self):
        assert self.expected_cursor_rows is None, "Expected cursor read was not issued"


class BuilderBlankSearchTests(unittest.TestCase):
    def assert_empty_receipt(self, result):
        self.assertEqual(result["query"], "")
        self.assertEqual(result["source_protocol"], "library_selection_v1")
        self.assertEqual(result["mode"], "ordinary")
        self.assertEqual(result["source"], {"kind": "library", "ref": SOURCE, "revision": REVISION})
        self.assertEqual(result["allowed_actions"], {"can_read": True, "can_use_for_playlist": True})
        self.assertEqual(result["expires_at"], source_receipt()["expires_at"].isoformat())
        self.assertEqual(result["entries"], [])
        self.assertIs(result["entries_complete"], False)
        self.assertEqual(result["limit"], 7)
        self.assertIs(result["has_more"], False)
        self.assertIsNone(result["next_cursor"])
        self.assertEqual(str(UUID(result["search_revision"])), result["search_revision"])

    def assert_error(self, connection, *, code, **arguments):
        with self.assertRaises(sources.PlaylistError) as caught:
            sources.search_entries(connection, SimpleNamespace(library_id=73), source_receipt(), **arguments)
        self.assertEqual((caught.exception.code, caught.exception.status_code), (code, 422))
        connection.done()

    def test_blank_query_has_no_inventory_or_receipt_io(self):
        for query in ("", " \t\n "):
            with self.subTest(query=query):
                connection = Connection()
                result = sources.search_entries(connection, SimpleNamespace(library_id=73),
                                                source_receipt(), query=query, limit=7)
                self.assert_empty_receipt(result)
                self.assertEqual(connection.operations, [])
                connection.done()

    def test_blank_query_still_rejects_malformed_cursor_before_io(self):
        for cursor in ("bad!", True, 42):
            with self.subTest(cursor=cursor):
                connection = Connection()
                self.assert_error(connection, code="invalid_cursor", query=" \t ", cursor=cursor)
                self.assertEqual(connection.operations, [])

    def test_blank_query_still_validates_stored_cursor_identity(self):
        for changes in ({"query": "old search"}, {"revision": CURSOR}, {"source": CURSOR},
                        {"upper": 1001}, {"after": [1, 0, 2020, 501, 1, 1, 1001]}):
            with self.subTest(changes=changes):
                connection = Connection([{"payload": cursor_payload(**changes)}])
                self.assert_error(connection, code="invalid_cursor", query="", cursor=CURSOR)
                self.assertEqual(len(connection.operations), 1)

    def test_valid_blank_cursor_preserves_search_revision_without_enumerating(self):
        connection = Connection([{"payload": cursor_payload()}])
        result = sources.search_entries(connection, SimpleNamespace(library_id=73),
                                        source_receipt(), query=" \t ", cursor=CURSOR, limit=7)
        self.assert_empty_receipt(result)
        self.assertEqual(result["search_revision"], SEARCH_REVISION)
        self.assertEqual(len(connection.operations), 1)
        connection.done()

    def test_blank_fast_path_does_not_skip_query_or_limit_validation(self):
        for query, limit in ((None, 7), ("x\x00y", 7), ("x" * 201, 7),
                             ("", 0), ("", 101), ("", True), ("", 1.0)):
            with self.subTest(query=query, limit=limit):
                connection = Connection()
                self.assert_error(connection, code="invalid_source_query", query=query, limit=limit)
                self.assertEqual(connection.operations, [])
