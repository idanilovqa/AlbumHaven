# Mobile demo feedback — 2026-09-26

## Scope and branch boundary

Owner-directed follow-up to `docs/mobile-layout-refactor.md`. The owner collected these observations against the generated-data Render demo and authorized implementing fixes that do not need further design approval. Application changes belong on `2026-09-25-mobile-layout`, starting at `46bea34a62fa5a82ebfbab0f0ff400953b67999b`. Keep Render-only hosting configuration on `2026-09-25-render-demo`; integrate verified application changes there only after verification. Do not merge main, reset the demo account, change secrets, connect real integrations, or upgrade hosting plans.

The latest owner statements supersede the earlier mobile proposal: remove the app-bar profile button; no Back or artist-drawer button in the search row; Artist Tree has only an Artists heading and a Back control; mobile Home gets the proposed personal Recent/News composition only after design approval. Keep the existing plain-JavaScript, template, CSS, Postgres, and streaming-player architecture.

## Implementation plan

1. Pin both branch heads and inspect the existing component owners, capabilities, preference storage, responsive routing, and demo deployment. Reproduce the reported failures with the existing generated dataset.
2. Repair shared chrome, navigation, search, gallery interaction, and mobile player layout at their existing ownership seams. Preserve normal desktop rendering and playback architecture.
3. Repair album-detail scrolling and lightbox, Cover Look Up, and mobile settings navigation/appearance. Keep owner capability checks and hide unsupported mobile actions rather than adding nonfunctional controls.
4. Add an opt-in extended generated library for scroll acceptance: at least one sixteen-track album and a large related-artist family. Preserve existing small fixtures and existing demo credentials/preferences/history.
5. Run focused regression checks and production-path browser scenarios; inspect actual phone, narrow-phone, desktop, dark-theme, and light-theme renders. Do not substitute mockups for verification screenshots or weaken an existing test merely to pass.
6. Present Home/Recent and album-layout design options as explicitly labeled proposals. Do not implement these gated compositions until the owner selects a design.
7. Review the complete repair diff, commit verified work on the mobile branch, and integrate only the verified changes into the demo branch for the authorized Render update. Report exact commits, verification results, remaining approval gates, and actual deployment status.

## Approved repair inventory

Each item below is an unchecked delivery requirement, not a claim that it is already fixed. Count: 35 open repair items; 0 complete. Design gates are tracked separately.

- [ ] R01 — Rows is a mobile/narrow-client view only. Remove it from regular desktop/laptop choices and normalize an inapplicable saved or URL-selected Rows mode without overwriting the user's independent mobile choice. Wide tablets use desktop presentation.
- [ ] R02 — Library status must not replace the idle/ready icon on hover. Preserve the real scanning/progress icon states.
- [ ] R03 — Remove the redundant Your profile button from the app bar; retain existing account access through the account/settings menu.
- [ ] R04 — Gallery view, Album types, and neighboring icon controls use equal dimensions and alignment.
- [ ] R05 — Remove promotional subtitles introduced by the mobile work. Retain useful factual metadata, errors, and necessary settings explanations.
- [ ] R06 — Replace the text column-count button with a magnifier-plus icon to the left of Gallery view. Its dropdown offers 3, 2, and 1 columns. One column means one full-width card/cover, not Rows. Persist this per account and client category.
- [ ] R07 — Remove the horizontal seam below the open Artist Family anchor. Preserve the joined outline/glow without clipping or overlap at the panel's top-left edge.
- [ ] R08 — Repair the mobile bottom player: artwork stays left, artist on the first line, song/album below, a larger standalone play/pause control on the right, no protruding capsule, and a single-line timestamp. Reuse the regular seekbar treatment at a shorter width. Keep one audio engine and uninterrupted playback.
- [ ] R09 — Search expands leftward from its single right-hand icon as one animated pill, focuses immediately, and never shows duplicate search icons. Empty icon activation collapses it; nonempty activation submits the current query while preserving search-as-you-type.
- [ ] R10 — Searching from album details or another inner page returns to the results surface, not a hidden gallery behind the old page. Preserve browser navigation and the mounted player.
- [ ] R11 — Activating the body of a wide album row opens album details. Do not produce a separate selected/highlighted artwork frame. Keep accessible focus on the actionable card and preserve independent child actions.
- [ ] R12 — Align album artwork and the main track table to the same left/right content edges.
- [ ] R13 — Activating the noninteractive body of a main-table track row starts that track. Preserve explicit play/pause and other independent row controls without double activation.
- [ ] R14 — When the large album cover scrolls above the content viewport, show a small cover to the left of the album identity in the Gallery/Album Bar, shifting the identity right. Reverse cleanly when scrolling back.
- [ ] R15 — Full-size artwork uses a minimal X without the outer circular edge on both desktop and mobile; preserve an accessible hit area and keyboard dismissal.
- [ ] R16 — Artist Tree drawer has an Artists heading with a Back control and comfortable padding; remove its Artists/Playlists/Album tops tab row.
- [ ] R17 — On mobile, artwork-series previous/next controls sit below, never over, the artwork. Use minimal controls with adequate touch targets.
- [ ] R18 — Cover Look Up has one correctly worded top Gallery Bar header with album context; remove the duplicate body header.
- [ ] R19 — Hide Possible matches before a search has started. Do not show Google, Yandex, the manual URL/image box, or manual extraction controls on mobile. Preserve desktop access and real loading/result/error states.
- [ ] R20 — Keep Find Better Art anchored at the bottom of Cover Look Up above the persistent player and safe area, with scroll padding so content is not covered.
- [ ] R21 — Mobile Cover Look Up supports at least two cover candidates per row without horizontal overflow.
- [ ] R22 — Make Artist Tree and Artist Family drawers narrower. Proposed bounded rule for this repair: no more than 75% of app width on phones, with a desktop-size maximum and wrapping/ellipsis for long names. Preserve outside-tap dismissal, keyboard focus, independent scroll, and player clearance.
- [ ] R23 — Replace mobile Settings' top tab strip with an existing-style left drawer opened from the Gallery Bar. Use the actual allowed actions to expose Rules, Loops, Log History, Integrations, and Appearance for the demo owner. Keep Edit Tags and Problematic Files unavailable on mobile; do not bypass server capabilities.
- [ ] R24 — Add the selected settings section's subsection dropdown to the right of its Gallery Bar: Integrations includes Library and Scrobbling where authorized, and Appearance includes its applicable appearance sections. Remove duplicate inline navigation on phones.
- [ ] R25 — Open Appearance on the mobile profile. Do not allow editing Web/Desktop or TV from a phone. New mobile preferences follow Web/Desktop by default; preserve an explicitly saved custom mobile choice rather than erasing it on open.
- [ ] R26 — Increase vertical gaps between wrapping appearance pill rows on mobile.
- [ ] R27 — Remove the separator below the final setting, retaining section separation where it is meaningful.
- [ ] R28 — Mobile Settings pages and their footers use the main page theme surface (or a close shade), not a dark modal/panel companion inside a light page. Text and controls must keep readable contrast.
- [ ] R29 — Keep the Player & Seekbar preview pinned at the top of its scrolling editor content, below the page bar, without covering settings.
- [ ] R30 — Hide hover-only and other inapplicable touch-client settings. Preserve applicable selection, focus, player colors, seekbar, and motion settings. Audit compact/docked controls: do not expose desktop sidebar-docking options that cannot affect the always-bottom mobile player; report the supported mobile equivalents.
- [ ] R31 — Follow Web/Desktop must resolve and visibly apply the saved desktop section to the mobile preview; saving persists inheritance and reopening resolves current desktop values. Custom mobile values stay isolated. Do not claim identical source/target palettes prove a broken inheritance flow.
- [ ] R32 — Icon buttons on dark bars use that bar's surface treatment, not an unrelated bright theme fill, and vice versa on light bars. Apply through the shared chrome/content token boundary.
- [ ] R33 — Remove Back and Artist Tree triggers from the search row. Put Artist Tree to the right of the Gallery Bar title (the username on approved Home); preserve inner-page Back navigation in the page/Gallery Bar instead of the search zone.
- [ ] R34 — The All Artists mobile Gallery Bar follows the currently scrolled artist, like desktop. Keep the explicit All Artists surface separate from the personal Home surface.

- [ ] R35 — For actors without Admin Panel access, show My Account in the settings/profile dropdown and open Password. Actors with Admin Panel retain that entry, not a redundant toolbar profile. Password, Users and Edit/Add User use the shared page Gallery Bar component with appropriate Back and mobile account navigation.

## Extended demo data

- [ ] F01 — Provide at least one clearly named sixteen-track album and enough fictional family-linked artists/albums for sustained gallery and drawer scrolling. Generate covers and playable audio before app startup through normal inventory persistence. Do not alter original small-fixture expectations or reset the hosted account, preferences, or listening history.

## Design approval gates

- [ ] D01 — Personal mobile Home/Recent. Header is the authenticated username (Rendref in the demo), no promotional subtitle. Recent and inactive News belong inside Gallery Bar; Recent is initially selected. No Album types, Gallery view, or density controls on this home surface. Under it, a lighter-weight reusable in-page tabs component offers Top tracks, Top albums, and Top Artists; each currently shows exactly: Nothing to show yet. Work in progress. Regular desktop browsers continue opening the full library. Present at least two restrained designs using current app tokens before implementation.
- [ ] D02 — Distinct mobile album-detail layouts. Classic/Stacked/Editorial must not be presented as effective choices when they are visually identical. Present smaller-art and alternative identity/table compositions using the current components; label exact mapping to stored values only after approval. In the first repair pass, hide unsupported/no-op layout controls on mobile rather than silently inventing the new layouts. Preserve working desktop options and the current mobile layout until approval.

## Verification and handoff

Use focused unit/contract coverage for device view normalization, density persistence, navigation transitions, capability filtering, and appearance inheritance. Browser acceptance must cover actual user clicks on album-row and track-row bodies; search from album details; 1/2/3-column geometry; the long album's sticky thumbnail; lightbox controls; two-column cover candidates and pinned action; settings drawer/subsection selection; following desktop then saving/reloading mobile appearance; light/dark surface contrast; and sustained playback while navigating. Reuse existing POM/fixture owners and capture actual renders.

Existing tests that assert an explicitly superseded UI flow may need owner-approved expectation updates. Record the exact conflict and equivalent coverage rather than skipping or weakening it. This task is preview work, not a release or permission to merge main.

## Progress

Intake: all owner comments consolidated, duplicate cover-sizing report deduplicated, latest navigation instructions given precedence. No runtime repair or deployment is claimed by this planning commit. Repair checklist: 0/35 complete; fixture checklist: 0/1; design gates: 0/2. Counts checked against the items above.

## Current repair batch (verification in progress)

The working implementation covers R01–R35 using the existing SearchInput,
GalleryBar/ActionButton, NavigationTree, GalleryCard/AlbumArtbox, AlbumTrackTable,
Appearance editor and player ownership boundaries. `partials/page-gallery-bar.html`
is a shared composition of the existing GalleryBar and ActionButton contract,
used by Password and account-admin pages; it is not a new visual family.

The opt-in extended fixture contains 39 albums and 130 generated tracks, including
Northlight / Sixteen Horizons with 16 tracks and five collaboration families.
The original eight-album fixture is unchanged unless the explicit pre-start
extended fixture switch is selected. Render will use that opt-in only after the
mobile changes pass their real-app checks. No demo credentials are changed.

Focused local verification: 239 JavaScript tests and 16 Python tests passed;
production-path parity check passed. Actual hosted browser verification and
manual screenshot inspection are still pending, so no repair checkboxes are
closed by this progress note. Counter checked: 0/35 repairs, 0/1 fixture,
0/2 design approvals complete.

The owner explicitly replaced these old UI journeys: Artists/Playlists drawer
mode buttons become a single Artists header; a text column-cycle control becomes
a zoom menu; Settings category tabs become a drawer; the profile toolbar shortcut
becomes the existing permission-aware menu/account path; the promotional Home
subtitle is removed. Browser checks now use those requested visible controls,
retaining search, family, persistence, Back/Forward, settings fields, player
continuity and real-app assertions. No timeout, retry, audio architecture or
success condition was relaxed. New tests add row-body activation, sixteen-track
scrolling, sticky identity, search-from-details, single-column geometry,
capability-filtered settings, candidate geometry and full-art control placement.

Home/Recent in-page tabs and distinct mobile album compositions remain D01/D02
approval gates. They are not silently included in the production patch.

### Browser verification follow-up

Run 36247891186 exercised source 973810a21e325fcf28aba598d64ace7b31f85e62. The extended suite reported four failures: a retained 20px list indent misaligned the track table; legacy utility overflow prevented the player preview from sticking; the new single-result artwork test supplied no navigable album series; and the extended fixture had no persisted family projection. Repairs remove the inherited indent/overflow and preserve hidden controls, seed new media in a real nested family folder with normal relation-projection publication, and keep the same artwork-navigation assertion while selecting the intended multi-album series in pre-action setup. No timeout, retry or acceptance bound was widened. Existing eight-album fixture paths and counts remain unchanged. All repair checkboxes remain pending rendered verification.

Design proposals are in `docs/design-mockups/mobile-feedback-2026-09-26/options.html`. Home A/B and Album A/B/C remain owner-approval gated and are not runtime code.


### Visual acceptance correction

Run 36248729830 passed all seven baseline and six extended browser scenarios, plus 239 focused JavaScript checks, 16 Python checks and production parity, on source 78d7d9ccf0b2c6f5e7b3f0ea3b85cfa1006c0b3b. Manual screenshot review still found the Appearance editor's inline companion background overriding the light page, the relocated SearchInput missing its chrome token context, and an emoji-rendered pause glyph. This correction keeps the draft main surface local to the editor, binds SearchInput to the containing chrome colors, and reuses the shared SVG play/pause icons on mobile without rebuilding them per audio tick. Long family names now wrap inside the narrow drawer. Shared page headings retain GalleryBar typography. Added browser assertions check actual selected-palette colors and the player glyph; focused local verification is 240 JavaScript checks, 16 Python checks and production parity. Remote verification remains required before deployment. Checklist counts remain 0/35, 0/1, 0/2 pending final reconciliation.
