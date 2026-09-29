# Phone touch feedback — 2026-09-28

## Scope
Owner requested continuation of the mobile demo repair on `2026-09-25-mobile-layout`, followed by verified promotion to `2026-09-25-render-demo`. Baseline: `cfc8f9167694b15611a57632784039654c6d0e83`. Do not alter the approved album compositions, desktop audio engine, track table, account credentials, capabilities, or main branch.

## Latest acceptance changes
- Drawers start immediately below the app bar, stop above the player, prevent background touch scrolling, and retain their own first-gesture scrolling. Admin and application navigation use the same chrome paint and mobile shadow; desktop navigation follows the same chrome tokens without a standalone perimeter.
- Remove the mobile player's upward shadow and all unused footer space so Gallery remains visible to the player boundary.
- Cover Look Up keeps the actual saved source image selected after reopening/reloading. The canonical `cover.jpg` file remains the playback/scan authority. The picker derives its source from exact persisted content bytes, not browser state. An identical canonical copy is not rendered as a second artwork choice.
- Generated demo media keeps an immutable original and alternative source. This does not change the runtime no-reserve contract for local cover promotion, and does not add app-owned file/JSON persistence.
- Find Better Art is the left secondary action; Save is the right primary action. This explicitly supersedes the previous footer-order assertion, with row alignment and width validation retained. Footer announcements remain accessible; actual cover-search failures remain visible.
- Settings footers use one tight Reset/Cancel/Save row without a divider or status row. Follow/Custom mobile keep selected styling but no prefixed checkmark.
- Notification Clear and Close are 40px targets with restrained 24px SVGs.
- Reveal the existing Library State page bar and its bare shared Back action. Do not add a new navigation stack.
- Center the scrolled album thumbnail and text; use the shared loading artwork; put numeric rating beside the album title in mobile info-bearing views.
- Match the Album Types joined edge to Artist Family; keep native album scrolling functional while hiding initial scrollbar paint until trusted interaction.

## Already present in the baseline
The two-level mobile Loops list/song navigation, one song header without a detail search field, adjacent left-aligned Recent/News, and title/count/actions compact gallery rows are retained and covered by the existing mobile suite.

## Verification
Add exact-byte/source fallback unit coverage and strengthen the existing real cover-save scenario to verify selected source identity after Back and reload, in addition to the canonical persisted revision. Add real-app touch/geometry checks for both Solid Black and Parchment & Pine. Existing functional assertions, retries, timeouts and production-path parity remain in force except the owner-requested left/right footer-order reversal described above. Test result and deployment claims are recorded only after execution.

## First browser pass follow-up
The full first pass preserved all existing behavior: 970 JavaScript checks, the cover/mobile Python checks, the baseline seven browser scenarios and 51 extended browser scenarios passed. Three newly authored scenarios exposed two probe issues and a drawer sizing issue. The new touch helper now uses the existing suite's trusted touchStart/touchMove/touchEnd sequence rather than a synthesized scroll command that did not scroll on the runner. The title/scrollbar scenario now opens a Cards-mode album through its actual title control; the row-body route is intentionally Rows-only. Assertions, timeouts, retries and coverage are not relaxed. The Artist drawer now gives the bounded list its own scrolling area, keeping Back/Artists visible instead of allowing the whole rail to scroll its header away. Possible Matches receives an explicit inter-section gap; compact cover-footer errors remain visible for either supported alert markup.


## Header/search follow-up — owner screenshot

The owner supersedes centered scrolled artwork and nonempty search staying expanded.
The pinned album thumbnail and first title line share a top edge; the metadata
line fits within the thumbnail height. Long text keeps its full accessible content
and uses a single-line ellipsis instead of extending the compact header.

Expanded phone search reserves the existing rightmost Settings action. Clicking
outside collapses it without clearing or changing the query/results; reopening
returns to the same query. A small notification-colored dot and accessible
description indicate a retained query while collapsed. Clear removes that state.
Reload and width transitions must not reopen a collapsed populated search.
Desktop search, album composition, playback, capabilities and the track table
remain unchanged. This uses the existing task-scoped mockup waiver.

Verification scope: focused search state tests, both empty and populated outside
dismissal, clear/reopen, same-tap Settings activation, reload and responsive
transitions, plus top/bottom header geometry and real screenshots on 390px and
320px phones in dark/light themes. Only the superseded centering, right-edge
search width, hidden Settings, and populated-outside-expansion assertions change;
all unrelated acceptance cases and timeout/retry contracts remain intact.
No checklist counter is present in this owning repair note.


### Search retention verification follow-up

Run 36500253754 passed the seven baseline and all 54 existing extended scenarios,
but both new retained-query cases exposed a real request-ordering defect after
Appearance Back: a resumed Home hydration remained eligible for another replay
after the explicit search had acquired the request slot. Foreground navigation
now retires that deferred startup request at the existing fetch owner, alongside
queued startup hydration. The browser flows, assertions, retries and timeouts
are unchanged. A focused unit regression exercises the actual deferred-request
resumer, the interrupted request, and the successful search without a Home replay.


## Gallery count alignment follow-up

Keep the artist/family name and the artist/album counts on one shared left edge,
to the right of the existing 40px hamburger and its 6px gap. On roomy phones,
the first row is the name and the second row holds counts plus right-aligned
actions. At 350px and below, use a third compact row for the actions instead of
moving counts under the hamburger or splitting a number from its label. Keep the
count pair together. Long names may wrap naturally without changing that inset.
Desktop layouts, Home tabs, album headers, search, and all control behavior remain
unchanged. Verify both black and parchment at 320/350/351/390/430/900px, live
resizing, a long artist name and opening/dismissing Artist Family. This is an
additive alignment check. The older compact-header expectation that always put
controls beside counts is superseded only at 350px and below by the owner's
explicit three-row instruction; it now checks both adjacent row gaps against the
same four-pixel limit. Wider-screen row alignment, edge bounds, touch-target
sizes, menu behavior, timeouts and retries are unchanged. No checklist counter
is present in this repair note.


### Gallery alignment verification follow-up

Run 36509616193 passed focused checks, all seven baseline browser cases and 54
extended cases. The new exact-x/row checks passed at all seven tested widths in
both themes. Four failures were test-contract issues: the existing compact-header
probe still required two rows at 320px (now explicitly superseded), and the two
new long-name checks omitted the existing family suffix for an artist that does
have a family. The latter now asserts the full exact family title; no product
name, dataset, navigation behavior, assertion budget or retry policy is changed.
