# Friends and Listening Home v005: editable review source

Status: **in review**. These are the exact editable adapters from the delivered fictional-data preview. Approval of the exact visual artifact and production implementation remain pending. Earlier versioned records retain their original bytes and review history.

V005 puts Edit beside the own profile name on desktop and phone, removes it from Friends, uses a proper Show friends statistics checkbox and a chart action, and brings request dialogs above their originating panel. Phone Period sits beside Recent/News, outside the tablist. Recent track rows use the native small album artbox. Full art hides navigation while loading and supports background/edge/Back dismissal through a single preview history coordinator.

## Source and reuse

The five adapter files are byte-identical to the delivered preview. Native shell/tree/Gallery/Card/Table/Details/Home/player/dialog/notification owners remain reused. Recent track artwork extends the existing AlbumTrackTable title cell with buildUtilityAlbumArtbox; it does not clone the row renderer. The chart glyph is authored within the native ActionButton. The checkbox uses a native input and existing selection-accent styling.

The retained 0.9.48 native content tree is bf042b5d824e7aeb35a689066e0cbe0f10e8b900. The 185-input manifest explicitly overrides only music_app/static/css/mobile-layout.css with accepted main eef9d13fd5dbd2cda3485e3c308c8494ba7d6fd4. It does not claim the entire snapshot came from main. V005 changes four editable runtime adapters; fixture data and native pins remain unchanged from v004.

## Rebuild boundary

This eight-file archive is not a standalone app. The native client, generated assets, dependencies and build scripts remain in the complete delivered Site source available to the owner. In that project, replace the five mock-source files with these copies and copy source/native-input-manifest.json to mock-source/upstream-manifest.json. Retain the full src/real-ui-v002 client and its pinned CSS override. Use the project's declared dependencies and npm run rebuild:mock, repeat preview QA, then npm run build and npm run test:sites. The portable rebuild checks native pins and marks fresh QA required. The matching private record identifies the exact source/version/deployment. Do not import these archive files into the production app or test harness.

## Retained behavior and limits

Desktop Home starts with Recent only and no selected item; deliberate selection reveals secondary panes. Phone retains native Home with the owner-requested Edit action and Period. Recent always shows native card metadata/listens; ordinary Gallery retains No info. Album Details opens as native-content pages with its three layouts and Back. Named friend counts precede Length. Gallery extends behind the player. Search focus preserves the current page.

The native snapshot has no production full-art history entry. This preview coordinator adds one transient browser-history descriptor through the existing history writer/pop seam while preserving native loading, image navigation, focus, background dismissal and pan/zoom. It handles direct/reloaded entries and skipped-entry Forward; it is not a production platform navigation implementation. The extra native Edit action makes the phone name row 16px taller, as requested.

Seven people, four artists, eight albums and deterministic aggregate period factors are fictional, not timestamped events, real date queries or session rollups. Profile/friendship/statistics and supported Album Appearance choices are memory-only and reset on reload. The art descriptor belongs only to browser history. Avatar selection never uploads. Player gestures select tracks but start no audio stream; native feedback can defer when space is constrained. Unsupported account/provider/filesystem operations remain unavailable.

The preview passed 75 bounded UI groups and six separate Worker routing/packaging checks. These do not certify physical Android/iOS gestures, backend/security behavior or exhaustive production acceptance. Exact design approval, capabilities/client decisions, accepted-main integration, approved production cases and manual acceptance remain required.
