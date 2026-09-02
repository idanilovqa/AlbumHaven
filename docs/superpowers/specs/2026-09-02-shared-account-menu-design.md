# Shared Account Menu Design

## Goal

Replace the library shell's direct Settings action with a reusable dropdown that exposes Settings, Admin Panel, and Sign Out without adding another top-bar button.

## Approved presentation

The component uses the dark navy surfaces, thin blue-gray borders, compact spacing, and restrained shadow from the approved Phase 7 Admin page. The dropdown is right-aligned below the existing Settings gear. Its rows are 44 pixels tall with 9–10 pixel corner radii. Hover and keyboard-focus states use rounded navy or blue treatments. Disabled actions use muted gray-blue text and reject activation. Sign Out looks like a normal menu row rather than a separate danger button.

Approved state sheet: `../album-haven-internal/docs/design-mockups/components/shared-account-menu/v001/mock.png`.

## Behavior

- Clicking the Settings gear toggles the dropdown and updates `aria-expanded`.
- The first menu item receives focus when the menu opens.
- Escape closes the menu and returns focus to the gear.
- Clicking or focusing outside closes the menu.
- Settings opens the existing Utilities dialog. Existing E2E helpers must follow the new two-step flow.
- Admin Panel navigates to `/admin/members`. The server renders it only when `accounts.read` is allowed.
- Sign Out submits the existing `/logout` POST with the session-bound CSRF token.
- Disabled items remain available as a shared component state, expose native or accessible disabled semantics, and do not activate.

## Account and Admin navigation cleanup

The Account sidebar keeps Password & security and presents Sign Out as a normal navigation row. It removes Sessions and Back to library from the sidebar while keeping the Active sessions content on the page. The Admin sidebar keeps Users as its visible active tab and removes Back to library. The library shell no longer exposes Users & access inside the Utilities tab row because Admin Panel now provides the documented entry point.

## Ownership

The Jinja partial owns semantic markup and server-rendered permissions. A focused runtime module owns menu state and keyboard behavior. A focused runtime stylesheet owns component states and responsive positioning. The shell template consumes the partial; other shell surfaces can reuse it without duplicating markup or behavior.

## E2E contract

The dedicated Phase 7 Admin Management suite adds two production-path cases:

1. An owner opens the Settings menu, opens Settings, returns to the shell, opens Admin Panel, and lands on Users & access with Users active. The test checks the three menu actions, rounded hover styling, and absence of an extra Admin top-bar control.
2. A limited member opens the same menu, sees Settings and Sign Out but no Admin Panel, then signs out and reaches Login. A direct `/admin/members` request remains denied.

The suite uses isolated Postgres and the existing production ASGI application. Existing functional suites continue to use their Settings helpers, updated to select Settings after opening the dropdown. Proposed case IDs are `FTC-PERMISSIONS-010` and `FTC-PERMISSIONS-011`.

## Client support

- Web: required.
- Tauri: required through the shared web shell.
- Android: unsupported for this DOM component.
- TV: unsupported for this DOM component.
- Apple: unsupported for this DOM component.

