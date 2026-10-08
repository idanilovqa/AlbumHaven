# Mobile release finalization

## Scope and acceptance

Owner-authorized final repairs on `2026-09-25-mobile-layout`, based on
`3534ebd5ee6a9d30499ee55499980c8d8cad0176`. Preserve the approved mobile
compositions, account capabilities, desktop audio architecture and saved data.
The owner explicitly waives hosted review with `skip_reviews`, not tests, and
requests two severe self-review passes and a release after all required CI passes.

- The owner's September 30 clarification limits dismiss-only consumption to an
  actual backdrop or dimming scrim. Its gesture cannot activate a covered control.
  Uncovered controls, including the persistent player on desktop and mobile,
  activate on the first gesture while a panel is open. Existing nonblocking
  outside handlers may close their own panels. Inside actions, scrolling and
  opener toggling remain usable. A drag originating inside is not an outside tap.
- Loading artwork is a plain square with centered loading text. Ready, missing
  and empty artwork retain their established semantics.
- Selected navigation items use the shared theme-colored left accent, while
  preserving explicit account selection-accent overrides and their disable flag.

## Implementation and regression boundaries

Use a shared capture-phase gesture boundary in main and standalone account/admin
chrome. Existing surface owners still close/settle their own dialogs and retain
focus, draft guards and promises; no new navigation/modal stack or persistence.
Expanded search itself retains its approved outside-click behavior; its content
popup is a surface. Exclude mobile full-page outlets from modal dismissal.

Add focused unit cases and real-application E2Es with isolated PostgreSQL and
generated media for touch/mouse background dismissal, nested menus, repeat taps,
inside-to-outside gestures, standalone navigation and theme selection. Update the
existing loading assertion because the owner explicitly superseded the image.
Audit all main-to-branch executable changes and their coverage. Retain original
functional/performance budgets and scenarios; add validations rather than skip or
weaken them. No new performance budget is warranted for one bounded input-event
boundary; existing interaction/scroll and memory gates remain required.

## Authorized scenario updates

The September 30 clarification supersedes the earlier blanket close-only rule.
Mobile panel exclusivity and loop speed-to-pitch scenarios exercise the first
uncovered activation; actual Artists/Admin scrims and desktop modal backdrops
remain dismiss-only. Exposed-player coverage checks the rendered hit target and
actual production playback state with each relevant surface initially open.
No timeouts, retries, playback checks or performance budgets are relaxed.

Settings uses its documented mobile page region, Back and section drawer at
narrow widths; desktop Settings navigation remains visible. S05 retains its
narrow filter bounds, Escape focus, query, reopen and navigation hit-target checks.

## Gates

Pending: focused checks; full PR CI with skip_reviews; complete failure inventory
and repair; two complete self-review passes; coverage audit; version/release notes;
merge/tag/release. A successful preview-only workflow is not release evidence.

## Dismissal repair checkpoint — 2026-09-29

The failed candidate `234d4f5c579be29b3f19dcd72afb7719c13d4ed4` lets the
follow-up native click through when the owner's dismissal callback restores
focus. The capture-phase window blur listener also receives descendant blur
notifications and incorrectly resets the pending click guard. Filter only that
listener by its actual window target; retain focus restoration, cancellation,
keyboard activation, normal next gestures and listener disposal.

Added bound-listener regressions reproduce the defect for touch, mouse and pen:
all three fail against the original source and pass after this correction. The
focused Node dismissal file reports 16 passed, zero failed/skipped. The extra
window-focus-loss case verifies that genuine window blur still resets the guard.
Existing E2E scenarios, assertions, timeouts and performance budgets are unchanged.
The real-app dismissal scenarios and the complete PR pipeline still require a
new run on the repaired head; the other failed jobs remain unresolved. This
checkpoint is not a green-CI, full-review, coverage-audit or release claim.

## Reconstructed repair verification — 2026-09-30

Recovery was applied to the verified `5bfac491dabef5e96eb88af5ae603e8364af2ee0`
baseline and reverified, rather than treating lost workspace results as current.
The Home hamburger's painted SVG edge aligns with Recent and Top tracks while
retaining its hitbox. Gallery context changes only after the complete scrolling
artist label is clipped, including wrapped labels and reverse scrolling.

Responsive navigation transfers the same live dialog nodes back to desktop and
to mobile again, preserving original ARIA attributes and parent history. Closing
on desktop retires the descriptor; narrowing must not reopen it. Canonical parent
routes distinguish Gallery displayed at `/` from actual Home. Route and scroll
restoration are gated to the immediate parent history position, not a destination
skipped by browser history. Both Gallery controls and the data request use that
same retained route. Existing local view changes do not rewrite browser history;
a later fresh reload still honors an explicit display-mode URL override.

The mobile Filters menu no longer spills four pixels past its page boundary.
Its existing utility keyboard owner handles Escape when Settings is a page,
closing only the dropdown and restoring anchor focus. The filter's outside-close
owner also clears its state so the next activation reopens it correctly.

Fresh focused browser results: both requested header regressions, five actual
backdrop/exposed-action cases, FTC-SETTINGS-S05, the unchanged complete FTC-TAGS-022
physical-tag/reopen/fresh-browser case, and FTC-ARTIST-TREE-002 pass. Each stateful
case used a fresh isolated invocation; all final runs verified normal app,
database-lease and PostgreSQL cleanup. Exposed-player coverage checks pause/start/
pause with Artists, notifications and Settings initially open respectively; it
does not claim both directions for every individual panel. Full CI and complete
review remain required before publication.
