# Light-theme docked-player divider design

## Outcome

When **Keep regular player style when docked** is enabled, the expanded-sidebar docked player uses a divider that remains visible in the active theme:

- Light themes: the divider uses `--appearance-ink`.
- Dark themes with a customized player: the divider uses `--appearance-player-ink`, matching the regular player.
- Native/default player styling retains its existing translucent green divider.

## Scope

The rule applies only to `.global-player.is-docked-compact:not(.is-rail-compact)` while `data-docked-compact-player-regular-style='true'` is present. The unchecked state, collapsed rail, artbox, and floating presentations remain unchanged.

## Verification

Component coverage asserts the light-theme ink divider, the dark customized-player divider, the native fallback, and the unchecked no-divider state. The result is also checked against the app served on port 5001.
