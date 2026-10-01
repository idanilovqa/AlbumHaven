"""Server-owned action projection for the existing shared application shell.

Selectors reference current reusable controls; they do not replace endpoint
policy. A denied selector applies to current and subsequently rendered controls
without a whole-document MutationObserver or a parallel client role model.
"""

from types import MappingProxyType

from music_app.services.capabilities import CAPABILITY_ACTIONS, CAPABILITY_KEYS
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.cover_provider_candidates import PROVIDER_LOOKUP_GROUPS


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
    "library.refresh": ("#scan-indicator", '[data-status-action="full-rescan"]'),
    "library.refresh.read": ('[data-status-action="go-to-scan-page"]',),
    "library.refresh.cancel": ('[data-status-action="cancel-scan"]',),
    "library.problems.read": ("[data-open-track-problematic]",),
    "library.files.edit_tags": (
        "#track-modal-edit-tags", "[data-open-track-modal-editor]", "[data-open-non-album-tag-editor]", "[data-open-tag-editor]", "#tag-editor-modal",
        "[data-apply-problem-suggestions]",
    ),
    "library.inventory.manage": ("[data-remove-missing-album]",),
    "library.files.move": (
        "[data-move-problematic-album]",
        '[data-album-card-action="move_to_library"]', '[data-album-card-action="move_to_hoard"]',
    ),
    "library.files.open_location": (
        "#track-modal-folder", "[data-open-track-modal-folder]", "[data-open-track-modal-duplicate-folder]",
        "[data-open-problematic-album-folder]",
        '[data-album-card-action="open-explorer"]',
    ),
    "library.versions.manage": (
        '[data-album-card-action="mark-version"]', '[data-album-card-action="unmark-version"]',
        "#version-picker-modal", '[data-save-version-picker="1"]',
    ),
    "library.logs.read": ("[data-open-log-history-alert]",),
    "library.loops.create": ("[data-playback-control-loop-actions]",),
    "library.loops.delete": ("[data-delete-saved-loop]",),
    "library.loops.reorder": ("[data-move-utility-loop]",),
    "library.covers.lookup": (
        "#cover-lookup-drawer-button", "[data-toggle-cover-lookup-drawer]",
        "[data-open-track-modal-cover-lookup]", "[data-open-cover-lookup-task]",
        "[data-track-modal-fast-cover-fetch]", "[data-open-track-modal-fetch-cover]",
        "[data-start-cover-lookup]", "[data-retry-cover-lookup-task]",
        "#cover-lookup-modal", "#cover-lookup-drawer",
    ),
    "library.covers.delete": ("[data-delete-local-cover]", "#cover-lookup-delete-confirm-modal"),
    "library.covers.write": ("[data-save-cover-lookup-remote]",),
    "library.covers.upload": ("[data-choose-cover-lookup-files]", "[data-cover-lookup-file-input]"),
    "library.covers.link": ("[data-add-cover-lookup-remote]",),
    "library.covers.fetch": ("[data-fetch-problematic-cover]", '[data-status-action="fetch-covers"]'),
    "library.covers.fetch.cancel": ('[data-status-action="cancel-cover-scan"]',),
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
    if client_surface == "tv":
        denied_selectors.extend((
            ".cover-lookup-manual-add", "[data-select-local-cover]", "[data-select-pasted-cover]",
        ))
    denied_selectors.extend(f'[data-utility-tab="{tab}"]' for tab in denied_tabs)
    denied_selectors.extend(
        f'[data-required-action="{action}"]' for action in UI_ACTIONS
        if not allowed.get(action, False)
    )
    return {
        "allowed_actions": allowed,
        "client_surface": client_surface,
        "cover_provider_groups": list(PROVIDER_LOOKUP_GROUPS),
        "denied_selectors": denied_selectors,
        "denied_tabs": denied_tabs,
        "available_tabs": [tab for tab in UTILITY_TAB_ACTIONS if tab not in denied_tabs],
    }
