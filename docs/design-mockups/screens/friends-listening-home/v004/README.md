# Friends and Listening Home v004: editable review source

Status: **in review**. These are the exact editable adapters from the delivered fictional-data mock. Owner approval of the exact visual artifact and production implementation remain pending. V002/v003 records remain unchanged.

Desktop Home starts with Recent alone; selection reveals Album/Artist panes. Phone uses the native 0.9.48 Home with Period and no supporting album cards beneath Tracks/Artists. Recent always shows native card metadata/listens, following the owner's explicit clarification; ordinary Gallery retains No info. All Album opens are pages using the real renderer and layouts, with Back. Album settings chooses named friend statistics. Friends is a phone page and desktop modal. Search focus preserves the current page; Gallery/Recent extend behind the fixed player.

## Source and reuse

The five source files are copied byte-for-byte from the delivered preview. Native shell/tree/Gallery/Card/Table/Details/Home/player/dialog/notification owners remain reused. The retained base is historical 0.9.48 content tree bf042b5d824e7aeb35a689066e0cbe0f10e8b900. The native input manifest explicitly overrides only music_app/static/css/mobile-layout.css with accepted main eef9d13fd5dbd2cda3485e3c308c8494ba7d6fd4. This is not a claim that the whole snapshot came from main.

The standalone preview rehosts native Details in a desktop page frame because production desktop has no separate native Album page presenter. Phone retains the native page owner with narrow preview-route synchronization. Artist Info full view rehosts the same overlay; it does not implement a native Artist resource page. New React composition and Count insertion are mock adapters, not migrated production owners.

## Rebuild boundary

This eight-file record is not a standalone app. It intentionally omits the rendered native client, dependencies, artwork and hosting configuration. The owner can obtain the complete delivered Site source identified by the matching private review record. In that complete project, replace the five mock-source files with these copies and copy source/native-input-manifest.json to mock-source/upstream-manifest.json. Retain the full src/real-ui-v002 client and its pinned CSS override. Use the project's declared dependencies and npm run rebuild:mock, then repeat preview QA, npm run build and npm run test:sites. The portable rebuild script verifies native pins and marks fresh QA required. Do not import these files into the production app or test harness.

## Data and acceptance limits

Seven people, four artists, eight albums and deterministic aggregate period factors are fictional. They are not timestamped events, date queries or session rollups. Profile/friendship/count and supported Album Appearance choices are memory-only; reload resets them. Native Appearance Save/Cancel supports only preview Album settings and rejects unrelated changes. Avatar selection is local, never uploaded.

Native player gestures select the track; no audio stream starts. A dense phone screen can defer the native no-audio toast until non-overlapping space exists. Other real account/provider/filesystem operations remain unavailable. Named counts are temporary; narrow desktop modules disclose horizontal table scrolling when needed.

The delivered preview passed 55 bounded UI groups and six Worker packaging/routing checks. Those results are not backend, security, client-platform or exhaustive production acceptance. Production work still needs accepted-main integration on the feature branch, exact visual/technical approval, capabilities and client/deployment decisions, approved cases, a production slice and manual acceptance.
