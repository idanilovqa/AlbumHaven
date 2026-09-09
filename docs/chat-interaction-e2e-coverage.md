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

## Failure investigation follow-up

- Edit Tags is a product cascade bug: the neutral hover selector outranked selected-row styling. Excluding selected tag rows from that hover rule restores the accent. The unchanged FTC-TAGS-016 now passes fully in `.codex-restart/e2e-fix-1.log`.
- Gallery width is a product calculation bug: JavaScript deducted 8px while the scroll container has 4px right padding. Corrected the deduction; unchanged width and rating assertions pass at both viewport sizes. The case then fails the retired cover-placeholder check.
- Waveform metadata is a product layout bug: restoring the collapse control added 22px plus an 8px gap to the leading controls, but the metadata offset remained 114px. Updated it to 144px; unchanged regular and waveform geometry checks pass. The following loop-cancel step samples the height transition at 68.234375px before it settles to 68px. Waiting for the exact existing height before measurement awaits owner approval.
- Appearance's saved control-color assertion conflicts with the approved September 5 bidirectional color pairing. Later waveform edits correctly derive #51A1C4 and #2F91D1. Exact expectation maintenance awaits owner approval.
- Loops' three 12px vertical-offset assertions conflict with the approved September 4 shared centerline. Exact maintenance to zero offset with the existing 1px tolerance awaits owner approval.

Focused virtual-grid and Appearance unit checks pass (52 tests), and focused player checks pass (9 tests). Production parity passes. No timeout or retry policy was changed.

The responsive-gallery rerun additionally identifies outdated coverless markup coverage: the shared Artbox renders an empty-state disc mark, while the old assertion searches for `.cover-placeholder`. Proposed replacement preserves an explicit empty-state and visible-mark check, pending owner approval. All browser run ports report ownerCount zero after cleanup. The affected cases are not all green; later checks remain blocked by these test-contract issues.

## Approved-correction rerun results

The owner approved the four initial corrections plus fat-dot album-heading separators, a genuinely idle floating-player baseline, and targeting Album types for palette integration. These edits are applied and recorded in the internal functional registry.

- Edit Tags: full pass (`e2e-fix-1.log`).
- Responsive gallery: full pass, including empty Artbox and cover-only clipping (`e2e-approved-1.log`).
- Player views: full pass, including cross-tab locking (`e2e-approved-final-1.log`). This run also verifies the additional product fix that keeps the floating expand chevron color stable on hover.
- Appearance: exact paired-color and Album types palette checks pass. The next step deselects the initially selected primary artist and then waits for it to be selected. Proposed explicit off/on coverage awaits approval (`e2e-approved-final-2.log`).
- Loops: shared centerline and bullet-heading checks pass. The next assertion still expects a 108px waveform player instead of the approved 92px height. Both occurrences were identified; their correction awaits approval (`e2e-approved-final-3.log`).

All isolated reruns completed cleanup and reported zero port owners. Production parity and diff whitespace checks pass. The 167 E2E guard tests passed after updating the shared-centerline guard. The full affected browser set is not yet green; no full release regression or push was performed.
