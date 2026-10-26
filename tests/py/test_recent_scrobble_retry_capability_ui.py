"""UNRUN presentation contract. Does not replace route or sender policy checks."""
from music_app.services.capability_ui import ACTION_SELECTORS, UI_ACTIONS, build_capability_ui

ACTION = 'integration.lastfm.scrobbles.submit'
SELECTOR = '[data-recent-scrobble-retry]'


def test_exact_retry_action_is_requested_and_defaults_hidden():
    assert ACTION in UI_ACTIONS
    assert ACTION_SELECTORS[ACTION] == (SELECTOR,)
    assert SELECTOR in build_capability_ui({}, 'private_web')['denied_selectors']
    assert SELECTOR in build_capability_ui({ACTION: False}, 'private_web')['denied_selectors']
    assert SELECTOR not in build_capability_ui({ACTION: True}, 'private_web')['denied_selectors']


def test_foobar_browse_exception_does_not_grant_recent_retry():
    value = build_capability_ui({'library.browse.read': True}, 'private_web')
    assert 'integrations' in value['available_tabs']
    assert SELECTOR in value['denied_selectors']
    assert value['allowed_actions'].get(ACTION) is not True
