"""Server-owned action projection for the existing shared application shell.

Selectors reference current reusable controls; they do not replace endpoint
policy. A denied selector applies to current and subsequently rendered controls
without a whole-document MutationObserver or a parallel client role model.
"""

from types import MappingProxyType

from music_app.services.capabilities import CAPABILITY_ACTIONS, CAPABILITY_KEYS
from music_app.services.client_surfaces import client_surface_from_request


UTILITY_TAB_ACTIONS = MappingProxyType({
    "problematic-files": "library.problems.read",
    "rules": "library.rules.read",
    "loops": "library.loops.read",
    "log-history": "library.logs.read",
    "integrations": "integration.settings.read",
    "appearance": "account.self.appearance.read",
})
ACTION_SELECTORS = MappingProxyType({
    "library.media.read": (
        ".global-player", ".compact-player-shell", ".play-track-button",
    ),
    "library.problems.read": ("[data-open-track-problematic]",),
    "library.files.edit_tags": (
        "#track-modal-edit-tags", "[data-open-tag-editor]", "#tag-editor-modal",
        "[data-apply-problem-suggestions]",
    ),
    "library.inventory.manage": ("[data-remove-missing-album]",),
    "library.files.move": ("[data-move-problematic-album]",),
    "library.files.open_location": ("#track-modal-folder", "[data-open-problematic-album-folder]",),
    "library.loops.create": ("[data-playback-control-loop-actions]",),
    "library.loops.delete": ("[data-delete-saved-loop]",),
    "library.loops.reorder": ("[data-move-utility-loop]",),
    "library.covers.lookup": ("#cover-lookup-drawer-button",),
    "library.covers.fetch": ("[data-fetch-problematic-cover]",),
    "library.rules.manage": ("[data-revert-problem-ignore]",),
    "accounts.read": ('a[href="/admin/members"]',),
})
UI_ACTIONS = tuple(sorted({
    *CAPABILITY_KEYS, *ACTION_SELECTORS, *UTILITY_TAB_ACTIONS.values(),
    *(action for actions in CAPABILITY_ACTIONS.values() for action in actions),
}))


def project_capability_ui(request) -> dict[str, object]:
    # Imported here to keep policy evaluation independent of its HTTP adapter.
    from music_app.services.policy_asgi import allowed_actions_for_request

    actor = request.state.current_actor
    allowed = allowed_actions_for_request(
        request, UI_ACTIONS, target_account_id=actor.account_id,
    ).as_payload()
    return build_capability_ui(allowed, client_surface_from_request(request))


def build_capability_ui(allowed: dict[str, bool], client_surface: str) -> dict[str, object]:
    """Build presentation from exact policy decisions, never from role labels."""
    denied_selectors = [
        selector
        for action, selectors in ACTION_SELECTORS.items()
        if not allowed.get(action, False)
        for selector in selectors
    ]
    denied_tabs = [tab for tab, action in UTILITY_TAB_ACTIONS.items() if not allowed.get(action, False)]
    denied_selectors.extend(f'[data-utility-tab="{tab}"]' for tab in denied_tabs)
    denied_selectors.extend(
        f'[data-required-action="{action}"]' for action in UI_ACTIONS
        if not allowed.get(action, False)
    )
    return {
        "allowed_actions": allowed,
        "client_surface": client_surface,
        "denied_selectors": denied_selectors,
        "denied_tabs": denied_tabs,
    }
