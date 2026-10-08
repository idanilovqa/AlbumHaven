"""Capability demo regressions: policy-owned chrome and first-open navigation."""
from pathlib import Path
from types import SimpleNamespace

import pytest
from jinja2 import Environment, FileSystemLoader, select_autoescape

from test_capability_ui import projection


@pytest.mark.parametrize('role', ['viewer', 'listener'])
def test_read_only_roles_have_no_scan_entry_or_scan_authority(role):
    ui = projection([role])
    assert '#scan-indicator' in ui['denied_selectors']
    assert '[data-status-action="full-rescan"]' in ui['denied_selectors']
    assert not ui['allowed_actions'].get('library.refresh', False)
    assert not ui['allowed_actions'].get('library.refresh.cancel', False)
    assert not ui['allowed_actions'].get('library.refresh.read', False)
    assert ui['available_tabs'] == ['appearance']


def test_owner_keeps_scan_and_default_problem_review():
    ui = projection(['owner'])
    assert ui['allowed_actions']['library.refresh'] is True
    assert '#scan-indicator' not in ui['denied_selectors']
    assert ui['available_tabs'][0] == 'problematic-files'


def test_musician_uses_a_permitted_first_tab_without_problem_access():
    ui = projection(['musician'])
    assert ui['available_tabs'] == ['loops', 'appearance']
    assert 'library.problems.read' not in ui['allowed_actions']


def test_nonplaying_account_releases_player_height_before_first_paint():
    templates = Path(__file__).resolve().parents[2] / 'music_app/templates'
    env = Environment(loader=FileSystemLoader(templates), autoescape=select_autoescape())
    render = lambda role: env.get_template('partials/capability-bootstrap.html').render(
        request=SimpleNamespace(state=SimpleNamespace(capability_ui=projection([role]))),
        runtime_asset_version='test',
    )
    assert '--player-height: 0px !important' in render('viewer')
    assert '--player-height: 0px !important' not in render('listener')
