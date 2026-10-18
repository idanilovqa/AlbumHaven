"""C0a isolated authored tests: SQL parity and fake results are distinct evidence.

Run only in a separately approved isolated Python lane. No product package imports,
configuration file reads, database connections, or SQL evaluation are performed.
The real domain source and the exact session dataclass are loaded from pinned text;
only the resolver's three product imports are replaced by explicit injected values.
Fake rows exercise result interpretation, not PostgreSQL selector execution.
"""
from __future__ import annotations

import ast
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import sys
from types import ModuleType
from typing import Any
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
OWNER = ROOT / "music_app/services/current_actor_postgres.py"
QUERY = Path(__file__).parent / "fixtures/current_actor_canonical_selector_query.sql"
NOW = datetime(2026, 10, 18, tzinfo=timezone.utc)
DATABASE_URL = "fake-c0a-connection"
RAW_TOKEN = object()


def _pinned_source(relative, expected_blob):
    data = (ROOT / relative).read_bytes()
    blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if blob != expected_blob:
        raise AssertionError(f"Review isolated dependency changes before execution: {relative}")
    return data.decode("utf-8")


def _forbidden(*args, **kwargs):
    raise AssertionError("Unexpected product constructor or connection")


def _load_isolated_owner():
    domain = _pinned_source(
        "music_app/services/current_actor.py",
        "7532a1c4999909c01c6c2313f1ae9907f7980529",
    )
    session = _pinned_source(
        "music_app/services/auth_sessions_postgres.py",
        "7a8c94b37446e1494a7536389e8bd4c566de4444",
    )
    session_tree = ast.parse(session)
    session_class = [node for node in session_tree.body
                     if isinstance(node, ast.ClassDef) and node.name == "ResolvedBrowserSession"]
    if len(session_class) != 1:
        raise AssertionError("Expected exactly one guarded session dataclass")
    owner = ast.parse(OWNER.read_text(encoding="utf-8"))
    product_imports = {
        "music_app.services.postgres_connections": [("pooled_connection", "_connect")],
        "music_app.services.auth_sessions_postgres": [
            ("PostgresAuthSessionService", None), ("ResolvedBrowserSession", None)],
        "music_app.services.current_actor": [
            ("ActorState", None), ("CapabilityGrant", None),
            ("CurrentActor", None), ("LibraryRelationship", None)],
    }
    actual = {node.module: [(name.name, name.asname) for name in node.names]
              for node in owner.body if isinstance(node, ast.ImportFrom)
              and (node.module or "").startswith("music_app")}
    if actual != product_imports:
        raise AssertionError("Review changed product import closure")
    # Reject additional imports instead of silently executing a broader closure.
    allowed = {"__future__", "collections.abc", "typing", *product_imports}
    for node in ast.walk(owner):
        if isinstance(node, ast.Import) or (
            isinstance(node, ast.ImportFrom) and node.module not in allowed
        ):
            raise AssertionError("Unreviewed resolver import")
    owner.body = [node for node in owner.body if not (
        isinstance(node, ast.ImportFrom) and node.module in product_imports)]
    module = ModuleType("_c0a_isolated_actor")
    module.__dict__.update(dataclass=dataclass, datetime=datetime,
                           _connect=_forbidden, PostgresAuthSessionService=_forbidden)
    with patch.dict(sys.modules, {module.__name__: module}):
        exec(compile(domain, "<guarded-current-actor>", "exec"), module.__dict__)
        exec(compile(ast.Module(body=session_class, type_ignores=[]),
                     "<guarded-session-dataclass>", "exec"), module.__dict__)
        exec(compile(owner, str(OWNER), "exec"), module.__dict__)
    return module


class _Sessions:
    def __init__(self, resolved):
        self.resolved = resolved
        self.tokens = []

    def resolve_session(self, token):
        self.tokens.append(token)
        return self.resolved


class _Connection:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []
        self.enters = 0
        self.exits = 0
        self.fetchalls = 0

    def __enter__(self):
        self.enters += 1
        return self

    def __exit__(self, *args):
        self.exits += 1
        return False

    def execute(self, sql, params):
        self.calls.append((sql, params))
        return self

    def fetchall(self):
        self.fetchalls += 1
        return list(self.rows)


def _row(**changes):
    row = dict(account_id=41, username_display="owner", display_name="Owner",
               is_active=True, disabled_at=None, is_bootstrap_owner=True,
               current_library_id=73,
               library_relationships=[dict(library_id=73, membership_role="owner",
                                           is_primary_owner=True)],
               capability_grants=[])
    row.update(changes)
    return row


class _ActorCase(unittest.TestCase):
    def setUp(self):
        self.owner = _load_isolated_owner()

    def arrange(self, row=None, *, anonymous=False):
        session = None if anonymous else self.owner.ResolvedBrowserSession(
            session_id=8, account_id=41, created_at=NOW, authenticated_at=NOW,
            last_seen_at=NOW, idle_expires_at=NOW, absolute_expires_at=NOW,
            user_agent=None)
        self.sessions = _Sessions(session)
        self.connection = _Connection([_row() if row is None else row])
        self.connect_urls = []

        def connect(url):
            self.connect_urls.append(url)
            return self.connection

        return self.owner.PostgresCurrentActorResolver(
            {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
            session_service=self.sessions, connect=connect)

    def assert_one_query(self):
        self.assertEqual(self.sessions.tokens, [RAW_TOKEN])
        self.assertEqual(self.connect_urls, [DATABASE_URL])
        self.assertEqual((self.connection.enters, self.connection.exits,
                          self.connection.fetchalls), (1, 1, 1))
        self.assertEqual(len(self.connection.calls), 1)
        self.assertEqual(self.connection.calls[0][1], (41,))


class CanonicalSelectorSqlParity(_ActorCase):
    def test_full_query_bytes_and_parameters_match_guarded_preimage(self):
        self.arrange().resolve(RAW_TOKEN)
        self.assert_one_query()
        # Fixture is the complete pre-extraction execute argument, including spaces.
        self.assertEqual(hashlib.sha256(QUERY.read_bytes()).hexdigest(),
                         "150482e5023236e7f248407e38eb1d437fce81bfc6d683346e54cc17623b130d")
        self.assertEqual(self.connection.calls[0][0].encode("utf-8"), QUERY.read_bytes())
        self.assertEqual(" ".join(self.connection.calls[0][0].split()),
                         " ".join(QUERY.read_text(encoding="utf-8").split()))

    def test_scalar_is_exact_existing_first_local_library_selection(self):
        sql = self.owner.canonical_library_selector_sql()
        self.assertEqual(" ".join(sql.split()),
                         "select library.libraries.id "
                         "from app.bootstrap_owners as runtime_owner "
                         "join library.libraries "
                         "on library.libraries.owner_account_id = runtime_owner.account_id "
                         "where runtime_owner.owner_key = 'local-bootstrap-owner' "
                         "and library.libraries.library_kind = 'local' "
                         "order by library.libraries.id limit 1")
        self.assertNotIn("membership", sql)
        self.assertNotIn("Local Library", sql)
        self.assertNotIn("%s", sql)


class CanonicalSelectorFakeResults(_ActorCase):
    def test_selected_first_library_is_kept_with_membership(self):
        actor = self.arrange().resolve(RAW_TOKEN)
        self.assertEqual(actor.current_library_id, 73)
        self.assertEqual(actor.state, self.owner.ActorState.ACTIVE)
        self.assert_one_query()

    def test_no_selection_does_not_fall_back_to_member_library(self):
        actor = self.arrange(_row(current_library_id=None)).resolve(RAW_TOKEN)
        self.assertIsNone(actor.current_library_id)
        self.assertEqual(actor.library_relationships[0].library_id, 73)
        self.assert_one_query()

    def test_selected_nonmember_library_does_not_fall_back(self):
        actor = self.arrange(_row(current_library_id=12,
                                  is_bootstrap_owner=False)).resolve(RAW_TOKEN)
        self.assertIsNone(actor.current_library_id)
        self.assertEqual(actor.library_relationships[0].library_id, 73)
        self.assert_one_query()

    def test_bootstrap_selected_nonmember_is_inconsistent(self):
        resolver = self.arrange(_row(current_library_id=12))
        with self.assertRaisesRegex(RuntimeError, "^Current actor current library context is invalid\\.$"):
            resolver.resolve(RAW_TOKEN)
        self.assert_one_query()

    def test_anonymous_has_no_connection_or_query(self):
        actor = self.arrange(anonymous=True).resolve(RAW_TOKEN)
        self.assertEqual(actor.state, self.owner.ActorState.ANONYMOUS)
        self.assertEqual(self.sessions.tokens, [RAW_TOKEN])
        self.assertEqual(self.connect_urls, [])
        self.assertEqual(self.connection.calls, [])
        self.assertEqual((self.connection.enters, self.connection.exits,
                          self.connection.fetchalls), (0, 0, 0))

    def test_inactive_ignores_selected_library_and_relationship_payload(self):
        for changes in (dict(is_active=False), dict(disabled_at=NOW)):
            with self.subTest(changes=changes):
                actor = self.arrange(_row(**changes, current_library_id=12,
                                         library_relationships=None)).resolve(RAW_TOKEN)
                self.assertEqual(actor.state, self.owner.ActorState.INACTIVE)
                self.assertIsNone(actor.current_library_id)
                self.assertEqual(actor.library_relationships, ())
                self.assert_one_query()

    def test_absent_current_library_field_still_rejects(self):
        row = _row()
        del row["current_library_id"]
        resolver = self.arrange(row)
        with self.assertRaisesRegex(RuntimeError, "^Current actor current library id is invalid\\.$"):
            resolver.resolve(RAW_TOKEN)
        self.assert_one_query()


if __name__ == "__main__":
    unittest.main()
