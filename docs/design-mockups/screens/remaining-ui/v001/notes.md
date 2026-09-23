# Remaining UI v001 — visual review

Status: approved on 2026-09-10. Exact assets are fingerprinted in approved-artifacts.json. No production implementation or manual acceptance is claimed. Earlier entries below are historical and are superseded by final corrections and the implementation plan.

Open index.html through the local preview at http://127.0.0.1:8769/.

## Grounding

- Owner-provided current album-details, cover-lookup and notification screenshots are stored in references/.
- Existing Utilities v002 navigation.html, revision.css and navigation-v003.css provide the dark neutral/Harbor Mint direction, joined tabs and wide navigation composition.
- The private UI registry supplies ActionButton (34px), AlbumArtbox, AlbumDetailsHeader, CompactDataTable, NavigationTree, shared footer and state semantics.
- September 6 ImageLightbox and Unified Alerts plans already own those families. This artifact previews their reuse, not an independent replacement architecture.
- All album art and metadata displayed in this mockup are synthetic sample content. No private media is loaded. Screenshots in references remain separate context.
- Mockup-only CSS/JavaScript are isolated here; no imports from production runtime, no external requests and no persistent product data.

## Component coverage

| Owner checklist | Board location | Proposed composition / remaining work |
| --- | --- | --- |
| Cover actions and album details information | 01 Album details | ActionButton overlay in AlbumArtbox; HeaderBar; AlbumDetailsInfo; compact AlbumTrackTable and total footer. Hover/focus shown; Keep visible compares touch/always-visible alternative. |
| Cover Look Up header, gallery, art, dividers, metadata, full-size action | 02 Cover Look Up | Shared HeaderBar, Section, compact GalleryCard variant, AlbumArtbox, selection and magnifier. Preserve compact scale and understated glow. |
| Google/Yandex and memo | 02 Find an image online | Separate editable search query and provider buttons; compact two-line source area accepts the conceptual image/direct-link/album-page flow. External search and image pasting are labeled preview behaviors, not real integrations. |
| Footer, popup body, modal | 02 + 03 confirmation | Shared fixed-to-surface EditorFooter; reusable header/body/footer slots. |
| Notification panel and cards | 02 right panel | Header controls, running progress, completion, failure/retry, elapsed label and empty state; scrolling body and footer. Slide lifecycle remains implementation work. |
| Folded navigation | 03 Navigation | Icon rail for Artist Tree, Problematic Files, Loops and Settings. Expand is only a composition preview. Full tree-specific collapsed mappings still need inventory during implementation planning. |
| Wide navigation rows | 03 Navigation | Artwork, title, artist/year, metadata/count row; all six utility consumers listed. Reuse approved Settings rows. |
| Main table hover/selection; Edit Tags draggable tree | 01 + 03 Edit Tags | Shared compact data table; sample selection and drag reorder preserve visible row data. Full production hierarchy and drag semantics must be preserved in implementation. |
| Page, Edit Tags inputs and numeric footer | 03 Edit Tags | Header, form fields, two-column composition, numeric Start track input, Renumber, Cancel/Save footer. |
| Problematic/Loops art/info/table/subsection | 03 utility specimen | AlbumArtbox and info header, overridable table labels, shared Section and existing loop player family. |
| Tabs | 03 utility specimen | Joined active-tab contour with shared focus; static specimen content remains visible for comparison. |
| Full-size art and close | 03 artwork + interactive lightbox | Existing ImageLightbox family and RoundActionButton; loading/missing/unavailable art specimens. |
| Alert/modal; existing on-page/toast | 03 alert specimens | Shared success/info/warning/error semantics plus confirmation header/body/footer; preview feedback uses one toast. |
| Number inputs / all inputs | Edit Tags + control board | Labeled native inputs and numbers, disabled appearance, search, dropdown, checkbox/radio; reuse for main/admin/login. |
| Scrollbars | Scroll specimen and overflowing surfaces | Shared narrow rounded thumb based on Artist Tree reference. |
| Remaining appearance device behavior | 03 Appearance | Editing-profile selector, theme controls, multi-target selection, save summary and preview. Web/Desktop/Mobile/TV labels are exploratory; device identity grouping and permissions are unresolved. |
| Future component-only work | Review footer and this mapping | Adopt registered families; new reusable variants need a catalog record and exact artifact approval. Governance exists already in private UI registry; future-plan reconciliation remains implementation-plan work. |
| Completed checklist families | Existing design baseline | App bar, gallery cards/bars/families/types/actions, players, compact/docked art, inputs, buttons, menus, artist family and toasts are reused in concept. This pass does not claim implementation audit or parity completion. |

## Open decisions for review

1. Cover action placement: A hover/focus inside art (recommended); B always visible in the same position; C in header (described alternative, not an exact visual artifact).
2. Whether web and desktop are separate Appearance device types, and where tablet/Apple/Tauri fit. Mock labels are provisional.
3. Web/desktop editing any profile and mobile/TV editing only their own is the owner's proposed policy; not yet approved.
4. Existing compact gallery visuals should be checked against the owner screenshot; the synthetic art is not an attempt to redesign actual album covers.

## Review interactions

- Hover/focus album art; toggle Keep visible.
- Cover Look Up button jumps to its panel. Select local or remote candidate and inspect footer selection.
- Enlarge a cover; Escape or Close returns to the board.
- Find better art / Retry shows preview feedback; no provider job runs.
- Clear completed removes sample completed/failed cards only.
- Drag Edit Tags sample rows and change their selection.
- Switch Appearance profile and check extra targets; save summary updates.
- Hide component labels to review the product surfaces without annotations.

This is a mockup review, not production functional/E2E acceptance. Image clipboard ingestion, external provider search, live job progress, data writes, role enforcement, real drawer lifecycle, complete keyboard tab navigation, zoom/pan and device persistence remain implementation work.
## Verification — September 9, 2026

- JavaScript syntax: node --check mockup.js passed.
- Browser: inspected desktop board and 390px cover layout; compact cards fit the narrow viewport. Browser viewport override reset afterward.
- Sample cover selection changed selected card and enlargement became available; full-size dialog opened and closed.
- Device profile selection changed target choices; multi-target sample Save produced preview feedback.
- Browser error log was empty.
- No production suites run: this is isolated mockup documentation, not application implementation.
- Screenshot captures were inspected inline in chat. Saving captures from the browser tool was blocked by filesystem permissions; no screenshot files are claimed. Stored HTML/CSS/JS are the exact review artifact.
- Local preview process: Python PID 21680, 127.0.0.1:8769, serves only this mockup directory; intentionally retained for owner review. preview.pid and scoped logs identify it. No E2E/browser test process was launched.
## Owner refinement — Album Details artwork activation

The owner requested removal of the dedicated full-size icon in Album Details. The artwork itself is now a native button that opens the full-size view on click, Enter or Space. Its overlay contains only Cover Look Up and Fast fetch, as sibling controls; those actions do not activate the image button. Cover Look Up gallery magnifiers and full-size-view Close remain unchanged. The exact revised board remains in_review; this instruction is not approval of all other visuals.
## Owner refinement — preserve approved modal and table geometry

The prior full-board-width Album Details panel and full-width Total Length footer were mockup deviations, not proposed production changes. Album Details is restored to the current 860px modal limit and 18px corners, with 288px artwork and the reclaimed action gutter allowing the table closer to the art. Its table now uses unchanged local snapshots of runtime/compact-data-table.css and runtime/album-track-table.css, matching compact grid columns, header, row spacing, play-control size, hover, bottom-row shape and the separate right-aligned fading Total Length strip. Snapshot files live under components/; no live runtime files are imported. Preserve existing/approved details in subsequent mock revisions; only clearly requested changes may differ. This request does not approve the rest of the board.
## Owner refinement — select artwork by clicking its card

Local and possible-match cards now use a whole-card native selection button, activated by click, Enter or Space. Removed the separate Select/Selected text action; selection remains visible through the existing outline and check badge and exposed with aria-pressed. The overlaid enlargement control is a sibling button, so enlargement does not select the cover. Existing compact card styling and metadata are retained. Selection focus is restored after the mock redraws its cards.

Owner refinement: LOCAL COVERS, REMOTE COVERS and POSSIBLE MATCHES use the same bold, lightly letter-spaced uppercase section-heading treatment. Other headings and layouts are unchanged.


Owner refinement: Remote Covers and Possible Matches render only when their own image list is nonempty. No empty placeholder or header remains. The sample has no remote covers and two possible matches. The review toolbar’s Preview no matches control demonstrates the empty state; it is not a product control.


Owner refinement: LOCAL COVERS always stays visible. With zero images it displays No local cover art. and no image count. Remote Covers and Possible Matches remain hidden when empty. The review-only toolbar can preview missing local artwork; Save is disabled when no cover is selected.


Owner refinement: notification cards open Cover Look Up for their specific album on click, Enter or Space. View lookup is renamed Open Cover Look Up. The mock switches album identity, image search and sample matches, retaining per-album sample selection. Retry remains separate. Production navigation must use the stable authorized album identity rather than the mock keys.


Owner refinement: Find Better Art is the dominant screen action. It appears in a discovery action row directly below the header, before local/remote/match results, with explanatory text and a filled theme-accent primary button. Removed the understated Possible Matches action and footer duplicate. The footer retains selection status, Cancel and Save; internet search/paste remain alternative source input. Narrow layout stacks the explanation and full-width action. This is a proposed primary variant of shared Button, not a new page-local component family.


Owner refinement: source badges pair a monochrome service mark with readable names on remote and found-match cards: Apple, Spotify, Deezer, Bandcamp, Discogs, CAA (Cover Art Archive), YouTube Music. Marks are local representative vector preview assets, not official brand-asset approval. Sample remote covers show Apple/Discogs; possible matches show all seven. No services are contacted. Preview nothing found (or ?state=empty) removes both result sections and displays No cover art found near the primary action; local art remains visible. Initial/no-search and completed-with-no-results are distinct states.


Owner refinement: remove manual provider query input. Google and Yandex build the query from the active album identity (preview feedback only). Shared solid secondary-primary styling matches Save on Google/Yandex/Add Image. The memo starts at 36px and grows with text; pasted/dropped/chosen images add removable thumbnail rows without uploads. Add Image opens a local image picker when the field is empty. Two action placements are available: default top or ?action=footer, controlled by the review-only comparison toggle. Only one Find Better Art action is visible. New source-inputs.js contains mock-only input/placement interactions; no production changes.


Owner correction: folded navigation is solely the collapsed Artist Navigation tree, independent of Settings. Removed the utility-attached rail and its Problematic Files/Loops/Settings shortcuts. Added a standalone expanded-to-folded infographic with one high-contrast Artist Tree pictogram and theme-derived raised-button treatment. Fold/expand calls out preservation of tree selection and scroll. Existing shared utility rows/tabs remain separate. This supersedes the earlier multi-destination rail proposal.


Owner correction: reject the redesigned Edit Tags table. Restore current one-column filename list with trailing file-type badges, compact spacing and selection treatment, grounded in runtime/utility-loaders-and-cover-lookup.js and runtime/utilities.css with appearance-backgrounds.css. Remove mock number column, header, extra format line and persistent drag-grip column. Add direct row drag/reorder while preserving selection and filenames. The 980px dialog and 380px maximum list column follow current geometry. Runtime behavior remains unchanged in this mock-only revision.


Owner refinement: preserve filename drag-across multi-selection. Filename pointer sweep selects a contiguous range; Ctrl/Cmd toggles/adds and Shift selects from the anchor. Multiple selection shows selected count and Mixed values for differing titles. Reorder is confined to a small separate grip; selection and filename metadata survive reordering. This supersedes whole-row drag-to-reorder. Production adoption must retain its existing selection contract.


Owner refinement: action-required/confirmation popups have no internal horizontal separators between header, message and footer. Preserve their outer frame and spacing. This shared dialog variant applies to Discard changes and equivalent action-required popups; other screen/section dividers are unchanged.


Owner refinement: compact alert boxes fit their text and optional action rather than filling the available panel width. Keep normal padding, left alignment and responsive wrapping; Retry stays adjacent to the message. Confirmation-dialog layout is unchanged.

Owner refinement: Appearance is embedded in the Utilities Appearance tab, retaining the existing Main elements / Player & Seekbar / Selection & Hover / Alerts / Album page navigation and editor previews. Removed the separate appearance modal and invented theme editor. Existing editor snapshots are copied from utilities-refactor/v002, retaining their layout; these snapshots are static. Added Web / Desktop, Mobile and TV scope above the editor and optional apply targets before the existing Cancel/Save footer. Device grouping is shown as a proposal, not an approved persistence contract. Device selection and editor navigation are interactive mock controls.

Owner refinement: replace native select specimen with app-styled anchored dropdown. Reuse copied runtime trigger-anchor CSS, neutral menu rows, selected checkmark, keyboard navigation, Escape and outside-click dismissal. No production change.

Owner refinement: search uses copied shared search-input component CSS with one outer focus outline enclosing input and actions. Show empty search, populated/clear, and search+clear+filter variants. Clear resets and focuses input; filter reveals mock choices. Other icon-field inputs also use a single enclosing focus outline.

Button audit / owner comparison: current button-component.css shares geometry and interactions but consumer variants own colors. Appearance Save resolves appearance-primary-button to effective.tokens.control and ink in appearance-backgrounds.js (lines 208–209); its current treatment is neutral, not the mock's green. ActionButton also uses consumer surface tokens. Mock had inconsistent #20392c source buttons and #1db954 Find Better Art. Added current neutral, proposed bright neutral, and proposed existing-accent-blue primary families. All share secondary controls, geometry and interaction treatment; preview selector applies one primary family to mock consumers. Static Appearance reference snapshots intentionally retain their source colors. No palette is approved. Destructive actions retain semantic styling.

Owner refinement: full-color recognizable source logos replace monochrome mock symbols. SVG artwork from Simple Icons (https://github.com/simple-icons/simple-icons), rendered in service colors; Discogs retains its recognizable neutral record mark. CAA uses the official Cover Art Archive logo (https://coverartarchive.org/img/navbar_caa_logo.svg). Deezer uses its purple-heart identity (https://newsroom-deezer.com/2023/11/deezer-new-brand-identity-and-logo/). Logo assets stored locally; visible service names retained. Assets used for this mock review, not a production asset approval.

Library Scan added to remaining component scope (owner request). Inspected the production app from bf02 on 127.0.0.1:8771 with an isolated newly provisioned PostgreSQL database and an empty music directory. Signed in normally and triggered scan/full rescan through the app; empty scans complete immediately and return to a zero-album gallery. Intermediate views were not held or injected into the runtime. Mock states derive from index.html loader markup, loader-status-helpers.js, core-state-and-helpers.js, status-ui-helpers.js and gallery-refresh-and-status.js. Selectable mock states: initial loading, discovery, scanning, cover updates, artist relations, full rescan, cancellation pending, cancelled, complete/idle, no music found, error. Existing app shows some feedback as toasts; explicit empty/error page feedback is a proposed reusable extension requiring visual approval. No fabricated percentages for discovery. Back, available-results browsing, cancellation eligibility and full-rescan label retained. Phase guide is descriptive, not a strict sequential wizard. Map to Page, HeaderBar, AppBar, NavigationTree, shared progress/status, Section, Button, Alert and existing Player. Reusable ScanProgress/empty feedback extension remains unapproved.

Owner refinement: Library status context menu is a shared Dropdown consumer with TriggerAnchor animation, connected accent, right alignment, viewport-aware upward placement, neutral menu rows, keyboard navigation and dismissal. Right click / Shift+F10 / ArrowDown opens it. Retain state-dependent Full Rescan / Go to Scan Page and Fetch Album Covers / Cancel Album Cover Scan labels. Mock initial-scan cover action is disabled. Production queued-cover label must also be retained. Add this consumer to the implementation component inventory.

Owner refinement: align service logo/name rows across Cover Look Up cards. Reserve two title lines on sourced cards and bottom-align the source row; keep service names on a single line.

Owner refinement: each visible cover subsection shows a live N images count (1 image singular). Remote count replaces Current source. Local remains visible with 0 images and No local cover art; empty remote and possible-match sections stay hidden.

Owner refinement: no insertion caret on non-editable UI, including clickable labels, headings, buttons, cards and panels. Carets remain visible in editable inputs and textareas. Preserve keyboard focus indicators and normal text selection. Apply as a shared UI rule in implementation.

Owner refinement: removed redundant helper text below the artwork paste input; retain its placeholder.

Owner correction: expanded Artist Tree must preserve the current flat NavigationTree component. Removed invented nested albums, header icon, boxed rounded panel and green tint. Mock uses scoped current base-layout.css/navigation-tree.css rows with synthetic names/counts and current All artists selection; only addition is header-right collapse ActionButton. Folded rail restored to strict neutral 56px bar, no gradient/glow/green indicator, one Artist Tree icon. Previous green rail proposal rejected.

Owner refinement: drag handles have no hover outline, border, background or glow. Keep the grab cursor and keyboard-only focus indicator.

Owner refinement: Edit Tags selection accent sits at the far-left edge of the complete row, before the drag handle, not at the filename button edge. Multi-selection behavior retained.

Owner correction: folded Artist Tree action uses a literal tree pictogram, borderless on the rail surface, no resting button fill or hover outline. Only a subtle neutral hover wash; retain keyboard-only focus indication. Replaces the boxed hierarchy glyph.

Owner refinement: collapse action precedes Artists in the existing tree header. Use a slim left chevron, transparent borderless button, subtle neutral hover wash, and keyboard-only focus ring.

Owner scope constraint — Edit Tags form: preserve the current production form exactly: field inventory, order, grouping, spacing, labels, sizing, conditional states, mixed-value behavior and footer actions. Convert each existing input/control/element to the corresponding shared component without visual or workflow redesign. The simplified form currently drawn in this board is not an approved replacement for the production form. During implementation, use the current production form as the source of truth. Previously requested file-list reorder grips, drag-to-multiselect, far-left selection accents and unframed drag-handle hover remain in scope.

Owner refinement: short confirmation modal reduced to 360px maximum available width with tighter header, message and action spacing. Retain divider-free design and existing action labels.

Owner refinement: Mobile and TV each default to Follow Web / Desktop (all settings inherited, including later Web/Desktop changes); Customize enables device-specific overrides, leaving Web/Desktop unchanged. Preserve each profile's chosen mode when switching in the mock. Replaces the previous apply-to-checkbox proposal, now hidden. Device selector uses neutral segmented control, no green filled selection. Appearance sidebar restored to existing NavigationTree artist-link/panel semantics and row geometry instead of boxed buttons; existing editor snapshot layouts unchanged. Production implementation must preserve the complete existing Appearance navigation, dimensions and editor layout; only add device scope and inheritance controls. Existing editor snapshots remain static review references, not fully working editors.

Owner correction — Library Scan: FullPage main-content consumer replacing Gallery, not a modal and not a shell. Removed duplicate app bar/search/status line, Artist Tree and player from Scan mock. Back is a quiet arrow before Library Scan with no divider. Active heading is Scanning the library. Replaced descriptive phase panels with dim future / bright active-and-reached progress map and animated ring spinner; map values illustrative and production concurrent subprocesses must retain independent status. Browse Library is a centered continuation action with background-work help; Cancel is a separate quiet action below it. Explicit hidden rules remove empty alert box. State chooser moved to collapsed, clearly marked mock-only review tools outside the FullPage. Library status Dropdown remains a separate app-bar component specimen. Player untouched.

Owner refinement: Find Better Art and Save cover use a stronger solid light-neutral primary fill with dark text. Google/Yandex are external-search secondary actions, with provider logos after the text and a small external-link marker; no primary green fill. Provider icon assets downloaded from official google.com/favicon.ico and yandex.com/favicon.ico. Updated comparison specimens too.

Owner refinement: scan progress illumination is cumulative. Reached steps retain bright labels, accent circles and connecting lines; upcoming steps alone are dim. Current-step semantics remain distinct via aria-current.

Owner refinement: dropdowns invoked from select inputs use regular neutral borders, backgrounds and selection checks; no colored dissipating edge, anchor bridge or connected accent cap. Scope this exception to select-input menus; other anchored dropdown consumers retain their current treatment.

Owner refinement: shared checkbox/radio styling is neutral rather than brand-green. Charcoal unchecked surface, light selected fill with dark check/dot, quiet border hover, neutral keyboard focus ring, muted disabled state. Native input semantics retained and forced-colors restores native presentation. Applies to mock controls; static Appearance reference snapshots remain unchanged.

Owner correction: affirming buttons must stay dark neutral. Replace bright light primary fills with solid medium charcoal (#414141), light text, restrained gray border, neutral hover/pressed changes and keyboard focus. Replace bright/blue comparison alternatives with dark slate and deeper charcoal. Bright neutral proposal rejected.

Owner refinement: the remaining generic Primary action specimen still showed the earlier saturated green. Unify mock .primary action consumers (including Find Better Art, Save and Add Image) around muted gray-green #303c36, subdued edge #536259, hover #3a4840 and pale neutral text. No green hover outline. External-provider actions remain neutral; actual player/loop controls and static approved Appearance snapshots unchanged. This is a new visual proposal, not final palette approval.

Owner refinement: Search actions order is search, filter (when present), clear. Clear X is always the rightmost action, including keyboard tab order.

Owner implementation requirement — global scrollbar standard: use the scrollbar shown in the shared-control specimen (reference codex-clipboard-073f1c9a-10a0-44a7-9a6f-4d8c05477f58.png) everywhere in the application. Apply through shared scrollbar tokens/styles and remove conflicting local overrides. Audit both vertical and horizontal overflow on main pages, Artist Tree/navigation, galleries, tables, dialogs, drawers/notifications, Edit Tags, textareas, dropdown menus, Appearance/settings, admin and authentication surfaces wherever scrollable. Verify applicable browser/native scrollbar limitations without changing the approved visual style where styling is supported. This is implementation scope, not merely a mock specimen.

Owner correction: removed the large Library status panel/header entirely. Show only a compact app-bar action excerpt with the real-size anchored dropdown visibly open for review. No modal frame, heading or helper panel. Menu opens by default only in this mock specimen; production remains right-click invoked.

Owner refinement: action-button colors derive from the active theme. Mock hover blends the main player surface color at 14% with the button surface; border is neutral-biased. Remove bright green pointer-hover outlines, especially Cancel. Scoped to action specimens and Cover Look Up controls to preserve player styling. Fallback colors are mock-only; implementation uses approved theme tokens and verifies theme contrast.

- Owner correction: Clear search shows search and clear only. Search with filters shows search, filters, then clear at the far right; the filter control stays with its own options panel.

- Dropdown correction: Library status rows use neutral shared hover/focus fill, without green outlines. Preserve the split connected top edge and layer the anchor bridge above the app-bar divider.

- Use the current app Library status button: dark control fill, subtle standard border, rounded edges, neutral hover. Preview starts closed so the resting button is visible; preserve the established connected menu when opened.

- Mobile and TV inheritance is independently selectable on every Appearance tab. Follow Web / Desktop hides that tab's editor details; Customize reveals the existing editor. Switching tabs/devices preserves each selection in the mock.

- Destructive actions and interactive error objects retain semantic red hover, pressed and keyboard-focus colors, independent of player/accent colors. Noninteractive error statuses retain their existing red treatment. Production colors must use theme error tokens.

- Edit Tags reorder accepts drops throughout the file-list area, including below the final track. Midpoint insertion excludes the dragged row; the end-of-list marker appears below the final remaining row.

- Tabs reuse settings-branch runtime/utilities.css styling via components/settings-tabs.css, with selectors adapted to mock markup. Preserve active edge fade, divider, dimensions, border and keyboard focus; no new tab design.

- Added Action button options: three matching finish families shown on existing gallery artwork actions, panel header actions and app/gallery bar controls, with default/hover/pressed/focus/disabled states. Selected styles will map to shared role-based components app-wide during implementation; playback and semantic error controls retain their dedicated treatment.

- Corrected the remaining select-option hover leak from generic button styles. All listbox/menu rows use neutral hover and keyboard-focus fills with no green outline, shared across both dropdown types.

- Select chevron uses a centered 16px SVG instead of a baseline-aligned text glyph.

- Restored Library status dropdown's split top edge by mapping the shared anchor border token to the mock theme line token; keeps the opening under the trigger.

- App-wide requirement: every shared non-playback hover must derive its subdued fill and edge from the theme player background mixed with neutrals, never hardcoded bright green. Replaced the generic mock button hover and shared focus/edge fallback so Renumber and previously uncovered controls inherit the treatment. Dropdown rows stay neutral; destructive controls stay red; player controls remain unchanged.

- Owner clarification: tabs touch with zero gap. Preserve the established settings tab design otherwise.

- Fixed Browse Library's ID-specific base style suppressing shared hover feedback; now transitions to shared muted player-derived fill and edge in 150ms, respecting reduced motion.

- Aligned the connected status dropdown's top line with the app-bar divider: matching 8px gap and 1px line thickness. Previously the 6px menu gap and 2px edge produced offset double lines.

- Folded Artist Tree icon changed from pine silhouette to a fine-stroke, bare branching tree inspired by Gondor, preserving the existing borderless rail control.

- Requested Appearance preference: Action button outlines. On uses the existing resting border/fill; off uses bare icons with quiet hover. Preview toggle in Action button options applies across mock action controls and app-bar icons. Preserve keyboard focus and connected open-menu treatment. Future production implementation must expose this as a saved Appearance setting with Mobile/TV inheritance; mock toggle is session-only and does not alter playback.

- Full-page layout mock: full-page.html. Existing Artist Tree rows with 240px expanded / 56px folded sidebar; gallery occupies reclaimed width with auto-fill cards (190px minimum). Toggle preserves gallery scroll and moves keyboard focus. Sample albums; no production player changes.

## Final approval and implementation handoff — 2026-09-10

The owner approved all mocks and requested the implementation plan. Full-page approval is limited to Artist Tree folding and gallery reflow; preserve the actual main app chrome, gallery, typography, spacing and player. Do not transplant the simplified full-page mock design. The final plan and exhaustive use-case matrix live in docs/superpowers/plans/2026-09-10-cover-look-up-and-remaining-ui-implementation.md and 2026-09-10-remaining-ui-use-cases.md. Technical permission/device-policy/renderer gates remain explicit. Frozen v001 visuals must not be silently changed.
