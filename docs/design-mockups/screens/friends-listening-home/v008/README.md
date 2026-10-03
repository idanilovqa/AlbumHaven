# Friends and Listening Home v008: editable review source

Status: **in review**. This is the exact editable adapter source of the delivered fictional-data mock. Browser/geometry verification, exact owner visual approval and production implementation remain pending. Earlier versioned artifacts retain their bytes and review states.

V008 refines the shared Home/Recent header, compact Album and Artist information, Playlist navigation/filters/playback controls, timezone display, accessible controls and return context. It reuses the native GalleryBar, ActionButton, dropdown, AlbumTrackTable, NavigationTree, Artbox, dialogs and three Album layouts. New compositions remain isolated React/native adapters. The optional proposal route demonstrates alternatives without adopting them or saving normal appearance preferences.

## Source and reproduction

The source folder contains seventeen exact editable modules/styles, one labeled source SVG and the unchanged native-input manifest. All sibling module imports are included. This is an archival adapter set, not a standalone app or production dependency. Reproduction requires the complete delivered Site project, its pinned native client, declared dependencies and build scripts. Copy these nineteen files to that project's mock-source folder with the same names. The v008 project includes review-proposals.jsx, sidebar-inactivity.mjs and icon-source-preview.svg, and its rebuild script copies the SVG into served output. Run npm run rebuild:mock, fresh supported preview checks, npm run build and npm run test:sites from the complete project. The existing Vite/esbuild dependencies are sufficient. The main build verifies the exact generated client; no fixture adapter belongs in production or its test harness.

The native source remains 0.9.48 integration tree bf042b5d824e7aeb35a689066e0cbe0f10e8b900, with the existing mobile-layout.css override from accepted main eef9d13fd5dbd2cda3485e3c308c8494ba7d6fd4. All 185 native input pins and 156 served native files are unchanged. The native layout owners were compared with current main during v008; this does not claim the whole snapshot came from that main commit. The full-art coordinator is unchanged.

## Verification and limits

Current evidence covers 19 search checks, 116 comparison projection cases, 24 model groups, 30 isolated component groups, 42 exact-source route groups, 13 header groups, six proposal/source-contract cases, six timestamp cases in two device timezones, 16 fake-clock/sidebar cases and six Worker cases. Repeated builds produced identical 170-file clients. Two complete corrected source/evidence reviews ended clear after an earlier held pass.

These are non-browser checks. The cloud browser was healthy, but the local preview could not be reached and the private hosted preview was unavailable to automated inspection. No current app screenshots or geometry results exist; historical browser evidence remains historical. The SVG is a source preview, not an app screenshot. Actual desktop/phone fit, transitions, clipping, input behavior and accessibility still need browser and owner review.

The opt-in /?mock=proposals route presents black, blue and parchment palette concepts, two Back/expand alternatives and three filter arrangements. No palette or broader Back/filter redesign is selected. Actual screenshots for the earlier U22/U25 requests remain pending.

Fictional people, artists, albums, aggregate factors, affection/queue model and preview transport are unchanged. Displayed dates retain their original synthetic UTC instants and use the existing app timezone with device fallback. Future local/provider reconciliation must preserve original event time and deduplicate equivalent listens; no sync or scrobble submission is implemented. Global metadata says Plays while track Popularity remains distinct from personal/friend Plays. State is ephemeral, audio is unavailable, and production permission/design/manual-acceptance gates remain open.
