"""Server projection and pre-paint visibility contracts for the current shell."""
from pathlib import Path
from types import SimpleNamespace

from jinja2 import Environment, FileSystemLoader, select_autoescape

from music_app.services.capabilities import capability_keys_for_roles
from music_app.services.capability_ui import UI_ACTIONS, build_capability_ui
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator


def projection(roles, surface="private_web", bootstrap=False):
    actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=7, session_id=8,
        is_bootstrap_owner=bootstrap,
        capability_grants=tuple(CapabilityGrant(key, "library", 23) for key in capability_keys_for_roles(roles)),
    )
    evaluator = PolicyEvaluator()
    allowed = {}
    for action in UI_ACTIONS:
        context = PolicyContext.build(
            actor=actor, action=action, library_id=23, target_account_id=7,
            deployment_mode="self_hosted", request_origin=RequestOrigin("network", "test"),
            client_surface_class=surface,
        )
        if evaluator.evaluate(context).decision.allowed:
            allowed[action] = True
    return build_capability_ui(allowed, surface)


def test_viewer_has_appearance_but_no_audio_or_privileged_tabs():
    value = projection(["viewer"])
    assert value["allowed_actions"]["account.self.appearance.read"] is True
    assert ".play-track-button" in value["denied_selectors"]
    assert "appearance" not in value["denied_tabs"]
    assert {"problematic-files", "rules", "loops"} <= set(value["denied_tabs"])


def test_listener_keeps_playback_without_loops_problems_or_rules():
    value = projection(["listener"])
    assert ".play-track-button" not in value["denied_selectors"]
    assert ".global-player" not in value["denied_selectors"]
    assert {"problematic-files", "rules", "loops"} <= set(value["denied_tabs"])


def test_musician_keeps_practice_but_mobile_cannot_create():
    desktop = projection(["musician"])
    mobile = projection(["musician"], "mobile")
    assert "loops" not in desktop["denied_tabs"]
    assert "loops" not in mobile["denied_tabs"]
    assert "[data-playback-control-loop-actions]" not in desktop["denied_selectors"]
    assert "[data-playback-control-loop-actions]" in mobile["denied_selectors"]


def test_tv_limits_bootstrap_owner_and_admin_too():
    value = projection(["owner", "admin"], "tv", bootstrap=True)
    assert "loops" in value["denied_tabs"]
    assert "#track-modal-edit-tags" in value["denied_selectors"]
    assert "[data-remove-missing-album]" in value["denied_selectors"]
    assert 'a[href="/admin/members"]' in value["denied_selectors"]
    assert ".play-track-button" not in value["denied_selectors"]


def test_rendref_desktop_projection_does_not_hide_existing_controls():
    value = projection(["owner", "admin"], bootstrap=True)
    assert value["denied_selectors"] == []
    assert value["denied_tabs"] == []


def test_template_serializes_policy_and_hides_denied_controls_before_scripts():
    root = Path(__file__).resolve().parents[2] / "music_app" / "templates"
    # tests/py -> repository root is parents[2].
    environment = Environment(loader=FileSystemLoader(root), autoescape=select_autoescape())
    value = projection(["viewer"])
    rendered = environment.get_template("partials/capability-bootstrap.html").render(
        request=SimpleNamespace(state=SimpleNamespace(capability_ui=value)),
        runtime_asset_version="test-version",
    )
    assert 'id="capability-bootstrap"' in rendered
    assert '.play-track-button' in rendered
    assert '[data-utility-tab="problematic-files"]' in rendered
    assert 'display: none !important' in rendered
    assert rendered.index('id="capability-visibility"') < rendered.index('src="/static/js/capability-ui.js')


def test_unknown_and_false_decisions_are_not_exposed_as_permissions():
    value = build_capability_ui({"library.media.read": False}, "private_web")
    assert ".play-track-button" in value["denied_selectors"]
    assert "appearance" in value["denied_tabs"]
