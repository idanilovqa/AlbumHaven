# Mobile release finalization

## Scope and acceptance

Owner-authorized final repairs on `2026-09-25-mobile-layout`, based on
`3534ebd5ee6a9d30499ee55499980c8d8cad0176`. Preserve the approved mobile
compositions, account capabilities, desktop audio architecture and saved data.
The owner explicitly waives hosted review with `skip_reviews`, not tests, and
requests two severe self-review passes and a release after all required CI passes.

- Outside taps dismiss the foremost sliding panel or floating dialog only.
  Consume pointer activation and its follow-up click so background album links,
  navigation, form controls and the persistent player do not activate.
  The next independent gesture works normally. Inside actions, scrolling and
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

The last owner request changes outside activation from switch-and-open to
close-only. The existing mobile panel exclusivity scenario now asserts that the
other panel is still closed after the first tap, before tapping again to open it.
The loop speed-to-pitch scenario retains both menu assertions and now checks the
intermediate closed state before the second tap. No timeouts, retries, playback
checks or unrelated acceptance assertions changed.

## Gates

Pending: focused checks; full PR CI with skip_reviews; complete failure inventory
and repair; two complete self-review passes; coverage audit; version/release notes;
merge/tag/release. A successful preview-only workflow is not release evidence.
