# Chat interaction E2E coverage

Updated in the b14c application worktree, not the companion fixture repository.

| Case | Added coverage |
| --- | --- |
| appearanceControls | Sticky preview hit testing and opaque backing; default blue and saved custom panel outlines; combined artist biography identity; text-selection drag containment and outside-release dismissal; exclusive family/type/source panels; trigger alignment during unfolding; recent-search reopening |
| playerViewModes | Repeated first-click Pause with varied press duration; active-row glow; artwork and compact expand hover stability; two activation lights and duration; title glow; cross-tab disabled play button without Locked text |
| loops.functional | Actual rendered single-center L+R canvas waveform; unchanged play colors across hover frames; repeated first-click Pause |
| tagEditorBackdrop | Shared table/footer; identical first/subsequent row selection behavior; immediate state and visible accent |
| responsiveGallery | Evenly distributed card widths at two viewport sizes, preserved single-line ratings, partly visible cover rows |

Interactions use native browser input and real isolated production servers/Postgres fixtures. Browser evaluation only measures rendered DOM, canvas, or media state. The shared album identity locator now reads the year from the visible subtitle.

## Validation on September 8, 2026

- Production-parity checker: passed.
- Parity, independence, and action-path Node checks: 167 passed.
- Playwright discovery: 93 cases in 28 files.
- Five affected browser cases executed sequentially with fixtures-v1.0.19. None completed green.

| Case | Observed failure / execution limit |
| --- | --- |
| Edit Tags | Selected row computed box-shadow is none; the added accent assertion fails. |
| Responsive gallery | Full row leaves 4.015625px on the right; added maximum 1px gap assertion fails. Later cover-only step not reached. |
| Player views | Added initial Album Details checks passed; existing geometry check then reports a 30px mismatch. Later compact/cross-tab checks not reached. |
| Appearance | Existing saved-color check expects play #345678 / border #456789, receives #51A1C4 / #2F91D1. Later new interaction steps not reached. |
| Loops | Existing player alignment assertion differs by 12px. New loop waveform and Pause steps not reached. |

The final hover helper was strengthened after these runs to inspect every animation frame for 600ms, instead of only settled colors; that refinement is statically checked but has not been rerun in a browser.

Logs and trace artifact locations are recorded in `.codex-restart/e2e-tags.log` and `.codex-restart/e2e-chat-1.log` through `e2e-chat-4.log`. Isolated runner cleanup reports ports free and database/roles removed.

## Scope limits

These changes do not establish that every visual request is correct. Smooth gradient appearance and the final light flash still need visual review; checks of gradient definitions/duration alone cannot prove their visual quality. Artist-image latency and Mac LAN reachability need separate environment/network diagnostics. The proposed full Player/seekbar settings redesign was not implemented in this chat, so it has no new behavior to validate. No application assertions were weakened to hide the observed failures.
