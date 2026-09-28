# Mobile layout review — 2026-09-28

## Scope and acceptance source

Review of `2026-09-25-mobile-layout` from `d4dd05df85d39e912dc20292b3a08c075523e34a`, including the inherited work and these corrections. The initial reviewed head was `dd60411380dfa9d19497f22638bccf8cd132e266`. The original conversation, checked through its authenticated UI and subsequently the app internal read_thread tool, and the recorded Sep 26/27 feedback and approval documents supply acceptance. The internal tool returned six recent turns, including the final loop-navigation request; older conversation loading was incomplete. The repository's detailed acceptance inventory supplies the remaining traceability. This is generated-data preview work, not main/release certification.

Later approvals supersede the original Home recents requirement: Home A intentionally shows the account name, Recent/disabled News and placeholder Top tabs. The unselected Home B and album C concepts are not missing features. Three album choices remain: original large artwork, approved compact A, and centered B. See `docs/design-mockups/mobile-feedback-2026-09-26/approval.md`.

## Validated findings and repairs

| Finding | Repair at the existing owner | Regression proof |
| --- | --- | --- |
| Resizing could apply unsaved mobile appearance to the live app. | Resolve live themes exclusively from saved preferences. | Appearance controller regression and dark/light resize E2E. |
| Open appearance editors did not follow a desktop browser crossing the mobile breakpoint. | Remount the same editor while retaining drafts and integration callbacks. | Profile, Cancel, Save and breakpoint checks. |
| Seekbar drafts could be saved into the wrong device profile after resize. | Track saved/draft mode per profile and write each captured dirty profile. | Controller/store/bridge checks and responsive E2E. |
| Open desktop dialogs were stranded when narrowed, and retained wide pages lacked a usable Back path. | Promote existing surfaces in stacking order; retain Back and its SVG styling at wide widths. | Settings/album transition, history and visible-icon checks. |
| Home refresh replaced the approved account-name heading. | Read the existing authenticated account name. | Home and gallery refresh checks. |
| Paper-theme Add user and Change password had dark text on a dark button. | Use the shared paired play-button ink token. | Minimum 4.5:1 contrast checks in black, Paper and Parchment. |
| At 320px, gallery actions squeezed Northlight to a nearly unreadable fragment. | Wrap Gallery actions onto a second row at <=350px. | Actual title-fit measurement and screenshot. |
| Admin menu keyboard focus disappeared in desktop themes. | Restore a visible shared focus outline. | Keyboard activation and computed outline checks at phone/desktop widths. |
| Regular/waveform mobile appearance previews squeezed artist, track and album into one row. | Reuse the existing mobile preview grid for all three modes. | Non-overlapping metadata measurements for regular/waveform/thin previews. |

No second player, duplicate artwork owner, persistence fallback or new dependency was introduced. GalleryCard, AlbumArtbox, AlbumTrackTable, ActionButton, GalleryBar, NavigationTree, Appearance and the existing transport remain responsible for behavior. Mobile navigation relocates existing surfaces; authorization remains server-owned. Full-diff review covered source, templates, styles, tests, migration and hosting boundaries. The second pass's visual findings required a third integrated reassessment.

## Requirements and coverage

| Acceptance group | Result / evidence |
| --- | --- |
| R01–R11, R22, R33–R34: navigation, search, gallery modes, density, Family | Implemented; browser scenarios cover actual controls, search from details, exclusive panels, native-touch pinch/first swipe, persistence and desktop widths. |
| R12–R21: album/table, playback, sticky identity, cover lookup/lightbox | Implemented with shared components; 16-track scrolling, Back/Forward, A/B/classic round trips, real seeking and playback continuity are covered. |
| R23–R32: Settings, Appearance, theme readability | Implemented; real section/subsection navigation, Follow/Custom locking, Save/Cancel, pinned preview and light/dark checks. Additional repairs above close review findings. |
| R35 and M16–M19: account/admin/table/hierarchy | Implemented; owner menu, non-admin template contract, responsive table, permissions contrast and hierarchical Back. |
| M01–M14, M20–M24: subsequent visual/interaction refinements | Implemented; keyboard/touch/navigation tests and real screenshots retained. Physical-device acceptance remains below. |
| F01 and M15: generated preview inventory | 39 fictional albums, 130 generated tracks, 16-track Sixteen Horizons, and 8 saved clips including 4 for Open Water. Later loop request supersedes the earlier seven-clip text. Preserve existing account and library data on hosting restart. |
| Additional failure cases | Offline appearance saves retain drafts, reconnect saves/reloads, sign-out from another tab blocks stale saves, and removed-loop deep links recover to the index. |

Historical intake checkboxes in earlier documents remain historical; they are not silently rewritten as release acceptance.

## Verification evidence

- Run [36372598161](https://github.com/idanilovqa/AlbumHaven/actions/runs/36372598161): 7 baseline + 28 extended production-app browser cases passed, zero skipped/flaky/unexpected. Isolated PostgreSQL and generated media; no production API mocks.
- Focused local appearance/device/bridge checks: 130 JavaScript tests passed in the earlier repair checkpoint. Production parity and whitespace checks passed after the final visual fixes.
- Run [36373169471](https://github.com/idanilovqa/AlbumHaven/actions/runs/36373169471): 7 baseline + 27 extended passed; the new focus assertion exposed the shared dropdown `!important` reset overriding the first outline fix. Increased the scoped rule priority; retained the assertion and failure evidence.
- Final mobile run [36373692126](https://github.com/idanilovqa/AlbumHaven/actions/runs/36373692126), functional source `b956873e5aed278a01f1f185461c0280ec13d9f9`: **329 JavaScript + 21 Python tests and 35 browser scenarios passed** (7 baseline, 28 extended; zero skipped/flaky/unexpected). Production parity passed. Final artifact `10950596013` was downloaded and screenshots inspected, including the retained desktop Back arrow, mobile waveform preview and single-heading Parchment loop page.
- Render staging [36378157060](https://github.com/idanilovqa/AlbumHaven/actions/runs/36378157060), `fc9f80e70628bda6427aae7617abfdf9e31f6f85`: deployment guards, legacy generated-demo upgrade, repeated startup and normal authentication passed. The staging tree differs from tested mobile source only by the six preserved hosting files.
- Live promotion `deee0270c1fe0ff2b9214872c4113af5fef5c36b`: Render deployment `dep-dasusvbtqb8s73a6akf0` became live at 2026-09-28 04:40:37 UTC. Public check [36378399194](https://github.com/idanilovqa/AlbumHaven/actions/runs/36378399194) passed HTTPS, normal login routing, health and exact reviewed stylesheet.
- Authenticated live check at 390×844 confirmed the account-name Home heading, Settings navigation and readable waveform draft preview. Cancel discarded the draft; resizing to 1280×900 selected the saved desktop profile and retained a visible working Back button. Screenshots captured; temporary browser viewport restored. Existing account preferences were not saved over.
- This final report update is documentation only. The tested functional source remains `b956873`; no claim that a later documentation commit reran the complete suite.

## Manual mobile cases

1. At 320px and ordinary phone width, browse Northlight; use Rows/Cards/No info and 1/2/3-column zoom. Check that the heading and controls remain legible. Pinch and scroll the family drawer.
2. Open Sixteen Horizons, switch among all three album layouts in Appearance, scroll down/up, and use Cover Look Up and Back. Confirm one identity and the same track table.
3. Play a track, seek, visit Settings and Password, and return through player artwork. Playback must continue; a second track-row tap pauses and double tap restarts.
4. In Appearance, compare Follow Web/Desktop with Custom mobile. Try Paper, black and Parchment; inspect all subsections and regular/waveform/thin previews. Cancel must discard only drafts; Save must survive reload.
5. Resize an open Settings/album page above 900px and back. Check visible Back arrows, desktop controls, preserved drafts and separate device settings.
6. In Admin, inspect Users, Edit and Password in all three themes. Open the user menu with Enter; verify a visible focus outline and Escape dismissal. Do not change credentials for this review.
7. Open Loops, filter Bridge study, open Open Water, use play/seek/repeat/speed/pitch, then Back/Forward/reload. Four clips remain on the song page.
8. On a real phone, test portrait/landscape, the onscreen keyboard, safe-area insets, browser Back and touch target comfort. These hardware/browser behaviors are not certified by Chromium emulation.

## Limits

The task-specific cloud workflow is not the complete main/release regression pipeline. Physical iOS/Safari, native packaging, background audio and every device/theme combination are not certified. The original branch documented three unrelated baseline failures in a larger local seam suite; this review does not relabel that as a full green release. Generated audio proves interaction, not quality against the owner's unavailable real library. Owner manual acceptance remains outstanding.
