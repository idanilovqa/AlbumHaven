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
