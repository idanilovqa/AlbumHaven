"""Isolated form rendering: role controls must preserve the legacy field contract."""
import ast
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace

import pytest
from jinja2 import ChoiceLoader, DictLoader, Environment, FileSystemLoader, select_autoescape

from music_app.services.admin_account_creation import MANAGED_CAPABILITY_KEYS
from music_app.services.admin_members_postgres import AdminMemberSummary, AdminMembersRoster
from music_app.services.allowed_actions import AllowedActions
from music_app.services.capability_assignments import assignment_editor, build_assignment, member_role_label

ROOT = Path(__file__).resolve().parents[2]


def constant(name):
    tree = ast.parse((ROOT / 'music_app/routes/admin_asgi.py').read_text(encoding='utf-8'))
    value = next(node.value for node in tree.body if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
    return ast.literal_eval(value.args[0] if isinstance(value, ast.Call) else value)


class Inputs(HTMLParser):
    def __init__(self, html):
        super().__init__(); self.inputs = []; self.feed(html)
    def handle_starttag(self, tag, attrs):
        if tag == 'input': self.inputs.append(dict(attrs))
    def named(self, name): return [item for item in self.inputs if item.get('name') == name]


def member(bootstrap=False, assignment=None):
    defaults = tuple(sorted(constant('_LISTENER_DEFAULTS')))
    return AdminMemberSummary(account_id=7 if bootstrap else 41, username='Member',
        contact_email='member@example.test', is_active=True, is_bootstrap_owner=bootstrap,
        membership_role='owner' if bootstrap else 'member',
        capability_keys=assignment.effective_keys if assignment else defaults,
        welcome_status=None, active_session_count=1, last_active_at=datetime.now(timezone.utc),
        has_credential=True, account_status='Enabled', invitation_delivery_status=None,
        access_assignment=assignment.as_payload() if assignment else None)


def render(target, *, administrator_is_bootstrap=True, allowed=None, template='admin-account-detail.html'):
    # This is a template unit test, not an HTTP/browser test. Shared chrome is
    # replaced by empty macros so assertions cover the production form itself.
    stubs = {name: '' for name in ['partials/navigation-tree-assets.html',
        'partials/admin-settings-nav.html', 'partials/appearance-bootstrap.html']}
    stubs['partials/app-bar.html'] = '{% macro app_bar() %}{% endmacro %}'
    stubs['components/on-page-alert.html'] = "{% macro on_page_alert(message='') %}{{ kwargs and '' }}{% endmacro %}"
    env = Environment(loader=ChoiceLoader([DictLoader(stubs), FileSystemLoader(ROOT / 'music_app/templates')]),
        autoescape=select_autoescape())
    defaults = constant('_LISTENER_DEFAULTS')
    return env.get_template(template).render(member=target,
        roster=AdminMembersRoster(9, 'Library', (target,) if target else ()),
        capability_groups=constant('_CAPABILITY_GROUPS'), listener_defaults=defaults,
        access_editor=assignment_editor(target, defaults), member_role_label=member_role_label,
        allowed_actions=AllowedActions(tuple(constant('_ADMIN_ACTIONS')) if allowed is None else tuple(allowed)),
        csrf_token='test-token', invitation_email_enabled=True, created=False,
        request=SimpleNamespace(state=SimpleNamespace(current_actor=SimpleNamespace(
            is_bootstrap_owner=administrator_is_bootstrap))))


@pytest.mark.parametrize('target', [None, member()])
def test_legacy_eighteen_fields_are_unchanged_and_new_capabilities_are_separate(target):
    html = render(target); inputs = Inputs(html)
    legacy = inputs.named('capability_keys')
    assert len(legacy) == len(MANAGED_CAPABILITY_KEYS) == 18
    assert {item['value'] for item in legacy} == MANAGED_CAPABILITY_KEYS
    assert all(item['type'] == 'checkbox' and 'disabled' not in item for item in legacy)
    assert {item['value'] for item in legacy if 'checked' in item} == constant('_LISTENER_DEFAULTS')
    assert len(inputs.named('additional_capability_keys')) == 11
    assert len(inputs.named('role_keys')) == 5
    assert '<option value="listener">Listener</option>' in html
    assert '<option value="owner"' not in html
    assert 'Individual permissions below override' in html


def test_bootstrap_owner_keeps_inherited_legacy_form_and_no_assignable_roles():
    html = render(member(bootstrap=True)); inputs = Inputs(html)
    switches = [item for item in inputs.named('capability_keys') if item['type'] == 'checkbox']
    hidden = [item for item in inputs.named('capability_keys') if item['type'] == 'hidden']
    assert len(switches) == len(hidden) == 18
    assert all('checked' in item and 'disabled' in item for item in switches)
    assert not inputs.named('role_keys') and not inputs.named('additional_capability_keys')
    assert 'Owner · Full access' in html


def test_delegated_admin_sees_protected_owner_read_only():
    html = render(member(bootstrap=True), administrator_is_bootstrap=False, allowed=['accounts.read'])
    assert not Inputs(html).named('role_keys')
    assert 'Save changes' not in html
    assert 'data-admin-action=' not in html
    roster = render(member(bootstrap=True), administrator_is_bootstrap=False, template='admin-members.html')
    assert 'Actions for Member' not in roster


def test_named_roles_render_without_implicit_other_role_or_system_authority():
    html = render(member(assignment=build_assignment(['admin'], []))); inputs = Inputs(html)
    roles = {item['value']: item for item in inputs.named('role_keys')}
    assert 'checked' in roles['admin'] and 'checked' not in roles['owner']
    assert 'system.admin' not in html
    assert 'value="owner"' in html  # An independently assignable checkbox, not bootstrap ownership.
