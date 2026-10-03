# Album Haven real-UI mock v011

This revision continues live v010 source 83ffdb1b55f2a6586daf0039b1a430ebd0db464a with fictional data and the pinned native Album Haven components. It replaces Play statistics, Recent History/Grouped and Notifications glyphs with faithful vector contours extracted from the owner's supplied artwork. Original source identities are retained; the private phone screenshot surrounding the bell is not distributed in the app. Glyphs inherit neutral ink/currentColor, with theme-accent bell waves, and retain native control sizes, labels, focus and behavior. Supplied thin strokes are preserved rather than redrawn or thickened.

Artist information uses readable Country/Styles/Genres text in the body and distinct native Country and genre labels in its header subline. Only the number in “Plays on LastFM:” is linked to the disclosed fictional preview action. Recent listening history omits the redundant per-event Plays column; grouped tracks retain their counts. Album playback modes remain player-colored before the actual table, while Play statistics is neutral and right-aligned in the same table-width owner. Native loading/hydration retains that toolbar. Both native playback-refresh paths project elapsed time only, with remaining time on hover and full duration in the tooltip.

Expanded Playlist filters extend the header surface with a bottom divider. Comparison has a Tastes comparison widget beneath the unchanged page identity; selecting an album/track reveals the existing Album and Artist panes, while selecting an artist reveals only Artist Info. The same rows remain mounted, friend affection stays read-only, and native history positions retain comparison selection, sorting/filter/view state, both scroll axes and return focus. Modal-to-Artist/full-Album navigation closes through the native owner and replaces its transient modal entry, so Back reaches the original surface. Higher overlays and user focus remain authoritative.

Widget presentation shares one interruptible motion adapter around the existing state/layout owners. History restoration commits synchronously; live surfaces glide with reduced-motion support. A browser without the snapshot transition API gets live entry/reassembly movement with immediate removal. Physical timing and painted layout remain unverified.

## Review options and limits

Open /?mock=proposals for the retained panel-color choices and the new optional Album widget concept. The two full-size links /?mock=home&mock_proposal=album-widget&proposal_description=with and /?mock=home&mock_proposal=album-widget&proposal_description=without demonstrate the native Artist—Album/type/year header with a clearly fictional description or existing rating/plays/count/duration. They do not replace the default widget, fetch Wikipedia, nest another app or persist appearance preferences. Panel colors and the Album header option await owner selection. The earlier contextual Back/Collapse and desktop filter disclosure decisions remain applied.

Source/model/native-DOM/history checks, source-scale icon fidelity, deterministic rebuild and Worker packaging are the available verification. Source SVG/PNG previews are not app screenshots. Browser/full-app geometry, touch behavior, painted motion and whole-artifact visual approval remain pending; the supported local preview failed before readiness and hosted authentication was incomplete. No new login is requested and no rendered app QA is claimed. The separate real implementation effort is not part of this mock deliverable.

## Retained v010 documentation

# Editable real-UI mock v010

These modules compose fictional data with the complete pinned native Album Haven client in ../src/real-ui-v002. They are isolated review adapters, not production feature code. All earlier revisions remain in source history.

## Rebuild and boundaries

Install the root's declared dependencies and run npm run rebuild:mock, npm run build and npm run test:sites. The rebuild uses the existing Vite/esbuild dependencies, validates native served hashes, compiles the React/adapter sources and records source/client hashes in real-ui-delivery-manifest.json. No new dependency is needed.

The native base is 0.9.48 tree bf042b5d824e7aeb35a689066e0cbe0f10e8b900 with the existing mobile-layout.css override from accepted main eef9d13fd5dbd2cda3485e3c308c8494ba7d6fd4. V010 changes none of the 185 pinned inputs or 156 served native files. Desktop full Album uses the actual native content/layout owners with the disclosed page-frame adapter. Artist resource and Playlist compositions remain mock presentation owners.

## Source ownership

- fixture-data.mjs and mock-adapter.mjs keep the fictional seed arrays and bounded transport/denied-write projection unchanged
- listening-model.mjs owns period totals and comparison pairing; recent-history.mjs derives bounded, explicitly synthetic UTC occurrences with unique IDs. Display uses the native app timezone or device fallback, year and AM/PM
- friends-app.jsx owns person/tab/entity state, relationships/Profile, entry-specific selection/origins and native-control portals. Its Recent selection only clears on a completed gesture in empty Recent Albums space
- native-layout.js rehosts the one native shell, Gallery, Details, ArtistInfo, player, dialogs and View root. It retains search/history/full-art owners, and coordinates single-instance table controls and header markers
- comparison-view.mjs and comparison-panel.jsx/css retain stable pairing, numeric ratings, centered comparison content and accessible sort/metric semantics
- artist-view.mjs composes native ArtistInfo, NavigationTree, Artbox and Family. Its release/connection/year metadata is fictional
- playlist-model.mjs owns in-memory affection, filters, inactivity expiry, shuffle/repeat and captured queue IDs. playlist-panel.jsx/css uses native rows, controls and filters with responsive focus restoration and a bounded removed-row exit
- track-social.mjs renders shared affection and fictional global Popularity separately from personal/friend Plays; sidebar-inactivity.mjs owns the guarded desktop Playlists 30-second main-activity policy
- mock-layout.css applies scoped consumer styling; review-proposals.jsx presents optional native-component concepts; icon-source-preview.svg is a passive source preview

## V010 behavior

Recent phone rows retain native play, art, Plays, Love and Length controls within intrinsic column budgets. Multiline track identity and art center together; artist and album have distinct typography. Existing Recent body elements own vertical scrolling and player clearance. The table has no competing scroll viewport; ordinary Gallery virtualization remains unchanged. Browser fit and physical scroll feel are not yet validated.

The slim Choice keeps a stable native trigger and border geometry. Compact menu rules apply before native placement measurement. Desktop Listens/Period moves beside Recent/News; View/Expand stay in the page/module header. Grouped tracks uses two offset musical-note clusters. Circle Artist and complete Friends rows use native filled selection/accent. Directory activation has one pending owner so a newer row supersedes an earlier queued activation.

Sidebar buttons only switch content. Actual playlist rows navigate; phone closes its native drawer and focuses the presented Playlist, while desktop stays open. Content mode controls the label; actual selected main content controls the accent. Playlist section gaps use compact density. Existing inactivity, drawer and fold owners remain authoritative.

Playlist has explicit Expand/Collapse and contextual Back, with per-history-entry selection/scroll and atomic composition restoration. The original GalleryBar marker moves with its header so native synchronization cannot move it outside the restored widget. Deferred transition callbacks are invalidated by newer navigation. A single native header Filter action controls one filter composition: second-row disclosure on desktop, native dialog on phone. Playback stays before the table. Reset is a leading undo action only for nondefault values, and returns focus to a surviving control. Help text stays right-aligned.

Frequency is A lot >=20, Mid 10–19, Barely <10. Forgotten uses an inclusive six-calendar-month UTC cutoff, preserving time-of-day and clamping month ends. Missing/invalid data follows includeUnknown; known never-listened tracks are Barely and do not become Forgotten. Stable existing filter IDs and the seven-day inactivity lifetime remain. This changes filter projection, not fixture seeds.

The latest owner correction places one native-styled, borderless player-themed toolbar for playback and the single Play statistics action before the table in full Album, compact widget and modal. It supersedes the intermediate cover placement and compact omission. Native header identity/handoff, editing, full art and all three layout renderers stay intact. Expanded Artist Info adds bare Back and “Band Name • Artist Info”; the composite Artist page keeps its existing title.

## Proposals and limitations

/?mock=proposals offers black/blue/parchment panels, Back/expand arrangements and filter concepts. Palette demos open full-size with one shell and explicit return links. Proposal colors are applied only to that opt-in document, never saved to normal preferences. Panel colors and actual-app screenshots remain pending owner review; contextual return and desktop filter disclosure are selected.

The supported v010 preview failed before readiness. Browser/full-app geometry, touch behavior and painted animations remain NOT_RUN. Current records cover exact-source, pure model, isolated native/React DOM, route-helper and packaging checks. They do not establish app screenshots or rendered behavior.

All profile/friend/affection/filter state is session memory only and resets on reload. There is no Last.fm API, persistent event store, real account/avatar upload, backend mutation or stream. The native player can select a fictional track and report unavailable audio; no fake running-time clock is added. Queue model transitions and an explicitly labeled Next preview demonstrate intent. Future scrobble reconciliation must preserve original event times and deduplicate local/imported events; it is not implemented here.

## Final v010 Artist, comparison and header corrections

Artist Discography selection reveals the same native Album pane beneath Artist Info, sharing its available height while the right column keeps its width. Close is confined to this Artist context and restores Info space and release focus without navigation. The pane title is Album Name • Album Info. Artist Family uses the native NavigationTree row owner. Country and genre metadata use native labels, with a prominent explicitly fictional Plays on LastFM link. Tree selection defaults to Artist Gallery; explicit name/Full page links open the composite page, and the preference remains available.

Comparison filters/order use the page subheader independently of centered content. Tracks gain native small covers, self affection stays editable and friend affection is a separate stable fictional user/track statistic with no mutation action. Album artist links preserve comparison state and return focus. Native row feedback and cover-local glow are scoped to the existing components. The old numeric personal-listen filters are removed and their state keys normalize inactive, leaving frequency/duration/date/style choices.

Default Friend Recent has no redundant Expand; explicit expansion retains Collapse and the same person identity/actions. A shared frame follows the effective native AppBar edge, with Compare in actual keyboard/DOM order. Browser fit, classic-scrollbar edge effects and physical motion remain unverified.

Future approved production work should use a shared component named Dashboard for common widget sizing, expansion, dismissal and restoration across Recent, Playlist, Artist and Album pages. This is an architecture requirement, not a completed production migration.

The final v010 choice uses one bare left Collapse action for explicit panel expansion and Back for normal page navigation. There is no duplicate right-side Collapse. Default single Home/Profile remains free of redundant expansion controls. The chosen Playlist filter icon sits in the header; its desktop controls expand in the second row below, and phone keeps the compact dialog.

The Artist right column lets Discography fill the remaining space. Artist Family uses its intrinsic first one-to-four rows, then a measured four-row cap and internal scrolling, with viewport bounds and focus/scroll restoration. Discography’s Expand opens the actual native Artist Gallery; its left Collapse returns to the same dashboard composition.
