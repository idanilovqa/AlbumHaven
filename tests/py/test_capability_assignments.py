"""Role assignment contracts, including policy separation and stale-state safety."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json

import pytest

from music_app.services.admin_authority import is_library_administrator
from music_app.services.admin_member_mutation_postgres import (
    PostgresAdminMemberMutationService, RecentAuthenticationRequired,
)
from music_app.services.admin_account_creation import AdminAccountCreationService, CreatedAccount
from music_app.services.capability_assignments import (
    ASSIGNABLE_CAPABILITY_KEYS, AssignmentConflict, CapabilityAssignment,
    access_revision, assignment_editor, build_assignment, read_assignment,
)
from music_app.services.capabilities import CAPABILITY_KEYS, ROLE_PRESETS
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator

NOW = datetime(2026, 9, 25, tzinfo=timezone.utc)


def actor(keys=(), *, library=9, bootstrap=False, state=ActorState.ACTIVE):
    return CurrentActor(state=state, account_id=7, session_id=11,
        authenticated_at=NOW, is_bootstrap_owner=bootstrap, current_library_id=library,
        library_relationships=(LibraryRelationship(library, "member", bootstrap),),
        capability_grants=tuple(CapabilityGrant(key, "library", library) for key in keys))


def allowed(keys, action, *, surface="private_web"):
    return PolicyEvaluator().evaluate(PolicyContext.build(
        actor=actor(keys), action=action, library_id=9, deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "test"), client_surface_class=surface,
    )).decision.allowed


def test_admin_and_owner_are_separate_but_can_be_combined():
    administrator = build_assignment(["admin"], [])
    owner = build_assignment(["owner"], [])
    assert set(administrator.effective_keys) == {"capability.view", "capability.admin"}
    for action in ("accounts.read", "accounts.manage", "accounts.membership.manage", "accounts.capabilities.manage"):
        assert allowed(administrator.effective_keys, action)
        assert not allowed(owner.effective_keys, action)
    assert not allowed(administrator.effective_keys, "library.media.read")
    assert allowed(owner.effective_keys, "library.media.read")
    assert not allowed(owner.effective_keys, "library.files.edit_tags")  # web Admin ceiling
    combined = build_assignment(["admin", "owner"], [])
    assert allowed(combined.effective_keys, "library.files.edit_tags")
    assert not allowed(combined.effective_keys, "system.admin")
    assert "system.admin" not in ASSIGNABLE_CAPABILITY_KEYS


@pytest.mark.parametrize("roles", [[key] for key in ROLE_PRESETS] + [["viewer", "musician"], ["admin", "owner"]])
def test_choices_round_trip_and_expand_only_on_server(roles):
    assignment = build_assignment(roles, ["capability.change_covers"])
    assert read_assignment(assignment.as_payload(), assignment.effective_keys) == assignment
    assert len(assignment.effective_keys) == len(set(assignment.effective_keys))
    assert set(assignment.effective_keys) <= ASSIGNABLE_CAPABILITY_KEYS


@pytest.mark.parametrize("roles,keys", [
    (["root"], []), (["system.admin"], []), (["admin", "admin"], []),
    ("admin", []), ({"admin": True}, []), ([True], []), (None, []),
    ([], ["system.admin"]), ([], ["role.owner"]), ([], ["capability.unknown"]),
    ([], [False]), ([], ["capability.view", "capability.view"]),
    ([], "capability.admin"), ([], []),
])
def test_invalid_role_or_capability_inputs_fail_closed(roles, keys):
    with pytest.raises(ValueError):
        build_assignment(roles, keys)


def test_removing_a_role_keeps_only_the_explicit_additions():
    before = build_assignment(["admin", "listener"], ["capability.practice"])
    after = build_assignment(["listener"], list(before.capability_keys))
    assert "capability.admin" not in after.effective_keys
    assert "capability.play" in after.effective_keys
    assert "capability.practice" in after.effective_keys
    assert not allowed(after.effective_keys, "accounts.manage")


def test_stale_or_tampered_metadata_cannot_resurrect_revoked_grants():
    assignment = build_assignment(["admin"], [])
    for raw in (assignment.as_payload(), {"version": True, "role_keys": ["admin"], "capability_keys": []},
                {"version": 1, "role_keys": ["superadmin"], "capability_keys": []}):
        displayed = read_assignment(raw, ["capability.view"])
        assert displayed.role_keys == ()
        assert displayed.effective_keys == ("capability.view",)


@pytest.mark.parametrize("surface", ["mobile", "tv"])
def test_assignments_do_not_bypass_existing_client_ceilings(surface):
    keys = build_assignment(["owner", "admin"], []).effective_keys
    for action in ("library.files.edit_tags", "library.inventory.manage", "library.loops.create"):
        assert not allowed(keys, action, surface=surface)
    assert allowed(keys, "accounts.manage", surface=surface) is (surface == "mobile")


def test_library_administration_requires_admin_grant_and_relationship():
    assert is_library_administrator(actor(["capability.admin"]), 9)
    assert is_library_administrator(actor(bootstrap=True), 9)
    assert not is_library_administrator(actor(ROLE_PRESETS["owner"]), 9)
    assert not is_library_administrator(actor(["capability.admin"]), 10)
    assert not is_library_administrator(actor(["capability.admin"], state=ActorState.INACTIVE), 9)
    assert not is_library_administrator(replace(actor(["capability.admin"]), library_relationships=()), 9)


class Result:
    def __init__(self, rows=()): self.rows = list(rows)
    def fetchall(self): return list(self.rows)


class Connection:
    """In-memory transaction observer, not a substitute for the PostgreSQL tests."""
    def __init__(self, *, keys=("capability.view",), assignment=None, authorized=True, stale=False):
        self.keys, self.assignment = tuple(keys), assignment
        self.authorized, self.stale = authorized, stale
        self.operations, self.events = [], []
        self.locked = False
    def __enter__(self): return self
    def __exit__(self, exc_type, exc, tb): return False
    def transaction(self):
        connection = self
        class Transaction:
            def __enter__(self): connection.events.append("begin")
            def __exit__(self, exc_type, exc, tb):
                connection.events.append("rollback" if exc_type else "commit")
        return Transaction()
    def execute(self, sql, params=()):
        statement = " ".join(sql.lower().split())
        self.operations.append((statement, params))
        if "select id from locked_accounts" in statement:
            self.locked = True
            return Result()
        if "as current_capability_keys" in statement:
            assert self.locked, "Grant check must start after the ordered account lock statement"
            assert "admin_grant.revoked_at is null" in statement
            assert "admin_membership.library_id = locked_library.id" in statement
            assert "protected_target.account_id = target.id" in statement
            if not self.authorized: return Result()
            return Result([dict(target_is_active=True, target_has_library_access=True,
                target_is_bootstrap_owner=False, current_capability_keys=self.keys,
                access_assignment=self.assignment)])
        if "from app.account_sessions" in statement:
            return Result([dict(id=11, account_id=7, authenticated_at=NOW-timedelta(minutes=11) if self.stale else NOW,
                idle_expires_at=NOW+timedelta(hours=1), absolute_expires_at=NOW+timedelta(days=1), revoked_at=None)])
        return Result()


def update(connection, *, roles=("admin",), direct=(), revision=None, **overrides):
    current = read_assignment(connection.assignment, connection.keys)
    arguments = dict(actor_account_id=7, actor_session_id=11, actor_authenticated_at=NOW,
        library_id=9, target_account_id=41, is_active=True, current_library_access=True,
        capability_keys=direct, confirm_disable=False, confirm_remove_access=False,
        request_ref="assignment-test", role_keys=list(roles),
        access_revision=revision if revision is not None else access_revision(current, connection.keys, active=True, access=True))
    arguments.update(overrides)
    PostgresAdminMemberMutationService({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test"},
        connect=lambda _: connection, clock=lambda: NOW).update_account(**arguments)


def test_update_persists_choices_and_effective_scoped_grants_in_one_transaction():
    connection = Connection()
    update(connection, roles=("admin", "listener"), direct=("capability.practice",))
    inserts = [params for sql, params in connection.operations if "insert into app.capabilities" in sql]
    assert {values[1] for values in inserts} == {"capability.admin", "capability.view", "capability.play", "capability.practice"}
    assert all(values[0] == 41 and values[2] == 9 for values in inserts)
    metadata = next(params for sql, params in connection.operations if "library_access_assignments_v1" in sql and sql.startswith("update"))
    assert metadata[0] == "9" and metadata[2] == 41
    assert json.loads(metadata[1]) == dict(version=1, role_keys=["admin", "listener"], capability_keys=["capability.practice"])
    assert any("account_updated" in sql for sql, _ in connection.operations)
    assert connection.events == ["begin", "commit"]


@pytest.mark.parametrize("failure", ["revoked-admin", "stale-form", "stale-session"])
def test_rejected_update_rolls_back_without_writing_grants(failure):
    connection = Connection(authorized=failure != "revoked-admin", stale=failure == "stale-session")
    error = {"revoked-admin": PermissionError, "stale-form": AssignmentConflict,
             "stale-session": RecentAuthenticationRequired}[failure]
    with pytest.raises(error):
        update(connection, revision="0"*64 if failure == "stale-form" else None)
    assert not any(sql.startswith(("update ", "insert ", "delete ")) for sql, _ in connection.operations)
    assert connection.events == ["begin", "rollback"]


def test_legacy_update_cannot_silently_discard_saved_roles():
    initial = build_assignment(["admin"], [])
    connection = Connection(keys=initial.effective_keys, assignment=initial.as_payload())
    with pytest.raises(AssignmentConflict, match="assigned roles"):
        update(connection, role_keys=None, access_revision=None, direct=("library.browse.read",))


def test_admin_cannot_lock_itself_out():
    connection = Connection()
    with pytest.raises(PermissionError, match="own account"):
        update(connection, roles=("viewer",), target_account_id=7)


def test_removing_membership_revokes_even_unlisted_existing_grants_and_clears_roles():
    connection = Connection(keys=("capability.view", "library.future.unknown"))
    update(connection, roles=(), direct=(), current_library_access=False, confirm_remove_access=True)
    revocation = next((sql, params) for sql, params in connection.operations if sql.startswith("update app.capabilities"))
    assert "and (%s or capability_key = any(%s))" in revocation[0]
    assert revocation[1][3] is True
    assert not any("insert into app.capabilities" in sql for sql, _ in connection.operations)
    metadata = next(params for sql, params in connection.operations if "library_access_assignments_v1" in sql and sql.startswith("update"))
    assert json.loads(metadata[1]) == dict(version=1, role_keys=[], capability_keys=[])


def test_creation_by_delegated_admin_expands_roles_but_never_changes_account_kind():
    class Repository:
        def create_account(self, **kwargs):
            self.arguments = kwargs
            return CreatedAccount(41, None)
    repository = Repository()
    result = AdminAccountCreationService(repository=repository, invitation_token_seconds=3600,
        clock=lambda: NOW).create_account(actor=actor(["capability.admin"]),
        username="new.member", contact_email="new.member@example.test", capability_keys=[],
        role_keys=["owner"], send_invitation=False, request_ref="create-assignment")
    assert result.account_id == 41
    assert set(repository.arguments["capability_keys"]) == ROLE_PRESETS["owner"]
    assert repository.arguments["assignment"].role_keys == ("owner",)
    assert "capability.admin" not in repository.arguments["capability_keys"]
    assert "is_bootstrap_owner" not in repository.arguments


def test_revision_tracks_roles_grants_membership_and_account_status():
    assignment = build_assignment(["admin"], [])
    base = access_revision(assignment, assignment.effective_keys, active=True, access=True)
    assert base != access_revision(assignment, assignment.effective_keys, active=False, access=True)
    assert base != access_revision(assignment, assignment.effective_keys, active=True, access=False)
    assert base != access_revision(CapabilityAssignment((), assignment.effective_keys), assignment.effective_keys, active=True, access=True)
    assert base != access_revision(assignment, (*assignment.effective_keys, "capability.play"), active=True, access=True)


@pytest.mark.parametrize("roles,expected", [(["admin"], "Admin"), (["owner"], "Owner"),
    (["owner", "admin"], "Admin + Owner"), (["musician"], "Musician")])
def test_roster_labels_report_assigned_roles_not_a_listener_fallback(roles, expected):
    from types import SimpleNamespace
    from music_app.services.capability_assignments import member_role_label
    assignment = build_assignment(roles, [])
    member = SimpleNamespace(is_bootstrap_owner=False, capability_keys=assignment.effective_keys,
        access_assignment=assignment.as_payload(), is_active=True, membership_role="member")
    assert member_role_label(member, ["library.browse.read"]) == expected
    editor = assignment_editor(member, [])
    assert set(editor["inherited_keys"]) == set(assignment.effective_keys)
    assert editor["capability_keys"] == []


def test_assignment_template_inherited_controls_are_checked_and_disabled_before_javascript():
    from pathlib import Path
    from types import SimpleNamespace
    from html.parser import HTMLParser
    from jinja2 import Environment, FileSystemLoader, select_autoescape
    class Inputs(HTMLParser):
        def __init__(self): super().__init__(); self.items = []
        def handle_starttag(self, tag, attrs):
            if tag == "input": self.items.append(dict(attrs))
    assignment = build_assignment(["admin"], ["capability.play"])
    member = SimpleNamespace(is_bootstrap_owner=False, capability_keys=assignment.effective_keys,
        access_assignment=assignment.as_payload(), is_active=True, membership_role="member")
    root = Path(__file__).resolve().parents[2] / "music_app" / "templates"
    env = Environment(loader=FileSystemLoader(root), autoescape=select_autoescape())
    html = env.get_template("partials/admin-capability-assignment.html").render(
        access_editor=assignment_editor(member, []))
    inputs = Inputs(); inputs.feed(html)
    values = {item["value"]: item for item in inputs.items if item.get("name") == "additional_capability_keys"}
    assert "checked" in values["capability.admin"] and "disabled" in values["capability.admin"]
    assert values["capability.admin"]["data-explicit-grant"] == "false"
    assert "checked" in values["capability.play"] and "disabled" not in values["capability.play"]
    assert len([item for item in inputs.items if item.get("name") == "role_keys"]) == 5
    assert "system.admin" not in html
