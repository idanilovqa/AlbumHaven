# Home, Friends and Playlist UI verification boundary

This is a new candidate reconstructed on `3b64c6ecb69dab6e6d25215d288f7f4a0493225b`.
The unavailable historical commit and its 453 reported checks are not this code's
validation. Later changes merged to the repository's main branch have not been
silently incorporated.

## Implemented source

- Home: existing Recent album projection, native album selection/open/play,
  informative Recent album cards, other activity view choices, native Album detail projection, period/type choices,
  optional track/history/artist projection, desktop widget sizing and mobile
  sections, profile/avatar viewer/editor, history presentation and scroll state.
- Friends: directory, member search, readable account profiles, request dialogs,
  incoming/outgoing actions and native request notification entry,
  selected friend activity, native header/table/card presentation, comparison
  kinds/order/common-only/views/selection, relationship actions and confirmation.
- Playlists: grouped directory, native history navigation, metadata draft,
  scoped create/share dialogs, search/availability/love/style/length/added/listens
  filters, selected Track/Album facts, draft reorder with keyboard and pointer
  controls, native Discard confirmation, whole/missing TXT export, queue controls
  and selected-track local-match review under explicit providers.
- Shared presentation retains native Buttons, GalleryBar, NavigationTree,
  CompactDataTable, GalleryCard, AlbumArtbox, Dashboard, InPageTabs, dialog,
  unfolding selector and player ownership. Header controls have transparent,
  borderless rest states while preserving open menus and native interaction paint.

## Existing live seams and unavailable providers

Native Home reads use `/home-data`; native Album details use `/album-details`;
Playlist reads use `/view-data?surface=playlists`. Native media identity and
permissions stay in the runtime adapter. React receives display-only Playlist
rows, and no private media path is used as a React identity.

Social/member/profile/history/comparison data, their writes, Artist details,
Playlist mutations/sharing/picker, queue acknowledgements and local matching need
explicit authenticated provider functions. Their absent/loading/empty/error/
denied states are implemented. Contract fixtures are test-only. No production
fixture store, guessed endpoint, optimistic write success or persistence fallback
is supplied. The current reserved Playlist write routes are not called.

## Builder extension and remaining UI

The independent follow-on from core commit `aaa1124` adds ordinary and
current-Playlist missing-source creation through one native desktop/mobile form,
explicit item-aware providers, All/Selected Search/grouping, compact uncertainty
review, and native dirty-discard/history ownership. It has fresh verification
independent of the core's earlier result.

Additional Missing-playlist entry adapters from Home/Friends/Album/Tops, candidate
acceptance and native playback of unsaved source occurrences remain outside this
bounded slice. Album Tops persistence also remains separate. Source readiness of
queue or matching controls does not prove backend integration exists.

## Missing-source workflow correction

The first builder checkpoint `8d656361` incorrectly persisted missing-source
creation on Create. This follow-on corrects that behavior: missing Create opens
an unsaved native Playlist page; Save alone persists. Ordinary Create still
persists immediately. The unsaved page supports retained-row removal/reorder,
export before Save, native Discard/history and a grant-checked nested Top intent.
Fresh review and focused verification cover this corrective source separately.
The historical 903 and 468 results below do not validate these later edits.

## Corrective verification

On 2026-10-08, 997 focused checks passed across 48 affected JavaScript files:
zero failed, cancelled or skipped. Both production bundles build and pass Node
syntax checks. The serial run used a 512 MiB heap and an owned temporary link
to the pinned read-only dependencies; the link was removed and reviewed source
hashes did not drift. Three complete independent source passes and a fourth
repair reconciliation preceded the successful run.

The initial run built both bundles but failed 98 checks because gallery refresh
introduced an unguarded browser-host access in its supported isolated harness,
and the shared history bridge changed its established void return. Both source
regressions were repaired, the existing assertions were preserved, and two new
boundary checks were added before the passing rerun. Initial and final command
receipts and source hash manifests are retained with the corrective checkpoint.

The new coverage exercises missing Create without a writer, immutable once-only
transfer after native form close, lifecycle/authority round trips before and
after unmount, draft Save acknowledgement, export/remove/reorder, native
Back/Forward/Discard, acknowledged-source revocation, and async nested Top
retirement. These are unit/component/native-owner harness checks. Real browser
layout and mounted interactions, backend/provider/database behavior, full CI,
manual acceptance and cross-platform verification remain deferred.

## Native controls parity follow-on

The follow-on from corrective commit `369970ef` adopts canonical ActionButton
artwork for Home/Friends and Playlist header actions, shared native Choice menus
for Period, comparison order and Playlist filter choices, and confirmed-missing
row paint in the shared AlbumTrackTable owner. It moves complete TXT export into
the Playlist header while preserving the complete authored order and rechecking
the current source owner immediately before dispatch. Fresh verification of this
follow-on passed 1,039 focused checks across 51 affected JavaScript test files
on 2026-10-08, with no failures, cancellations or skips. Both production bundles
build and pass syntax checks. The serial 512 MiB run preserved source hashes and
removed its owned dependency link afterward. The earlier 997 checks do not
validate these later changes.

Three complete independent review passes resolved selected-icon visibility and
narrow Period placement; the shared Choice owner also retains a held Escape
sequence until keyup/blur so dismissal cannot close its parent. The first run's
six failures were outdated consumer assertions or unnecessarily shared native
fixture setup. Repairs preserved the zero-listener Recent teardown contract and
tested actual lazy Choice options and selected values before the successful
rerun. Both runs remain recorded with exact source hashes. Real browser paint,
mounted interaction and Jinja rendering remain unexecuted, alongside the live
provider/database/full-CI/manual acceptance limits above.

## Historical verification

The builder extension was checked on 2026-10-08 with 903 focused tests passing
across 44 affected runtime/UI/navigation files: zero failed, cancelled or skipped.
Both production bundles build and pass Node syntax checks. Tests ran serially
with a 512 MiB Node heap against the same pinned read-only dependency cache;
the owned dependency link was removed and all source hashes remained stable.
Three full independent source-review passes resolved every validated finding;
post-build generated-output and test-assertion reconciliation is recorded with
the final source manifest. The first run's one failure was the bounded HTML
fixture treating SSR attribute case differently from browser HTML. Its length
limit assertion now checks the same rendered attribute case-insensitively.

These checks cover native-owner harnesses, React/SSR/unit lifecycle seams and
provider contracts. They do not execute a real browser, live backend, database,
full CI or cross-platform acceptance.

The sealed core at `aaa1124` was verified on 2026-10-08 with 468 focused tests passing,
zero failures and zero skips across the 27 selected runtime test files. Both the
81-module native bundle and the React Home/Friends/Playlist bundle build; both
generated JavaScript files pass syntax checks. The changed Python route parses.
Four independent source-review assessments plus generated-output reconciliation
resolved all validated findings. Tests ran serially with a 512 MiB Node heap and
an owned temporary link to exact read-only cached dependencies; the link was
removed and source hashes did not drift during verification.

Jinja template rendering was not executed because that dependency was absent.
Browser layout/mounted interaction, live backend/database checks, complete CI,
manual acceptance and cross-platform behavior remain deferred. A focused unit
or SSR check does not establish visual acceptance or release readiness.

## Remaining requested UI work

The history follow-on from `fe6efd57` adds explicit numbered activity pages and
progressive Load more for own and selected-friend activity. It validates
authoritative 100-row metadata, keeps committed rows through navigation
loading/error, and clears on denial or owner retirement. Native controls and
parent query/scroll guards passed two complete independent source reviews.
Fresh verification on 2026-10-08 passed 1,155 focused checks across 57 affected
JavaScript test files, with zero failed, cancelled or skipped. Both bundles build
and pass syntax checks; reviewed source hashes stayed stable and the temporary
dependency link was removed after the serial 512 MiB run. The first run exposed
a VM test-fixture dependency setup failure before its HomeFriendsView assertions;
externalizing React DOM matched existing probes and preserved every assertion
before the passing rerun. Both receipts remain retained. The previous 1,085
checks do not validate this later source. Comparison keeps its existing
replacement pager. Browser layout/mounted behavior, live providers/database,
Jinja rendering, full CI and manual acceptance remain deferred.

The table follow-on from `88e4d721` adds shared metric-header view sorting,
read-only supplied Love/Rating/personal Plays/global Popularity cells, native
artwork and explicit persisted Playlist row playback gestures. Missing draft
sorting preserves authored Save/export order and disables reorder while sorted.
Home activity gains native Listens/Length sorting. Fresh verification passed
1,085 focused checks across 54 affected JavaScript files on 2026-10-08, with
zero failed, cancelled or skipped. Both bundles build and pass syntax checks.
The serial 512 MiB run preserved reviewed source hashes and removed its owned
dependency link. Two complete independent source passes resolved row-node
retention for double-click, native artwork/availability projection, and narrow
Rating. The previous 1,039 checks do not validate this follow-on.
At that checkpoint Love/Rating editing and Home/Friends track playback remained
unfinished even when read-only values were displayed. The next follow-on below
implements native Love and activity playback; Rating editing remains unfinished.

## Home composition and track interactions follow-on

The candidate based on `2f95d57e` adds the native Recent/disabled News header,
separate date line, responsive initial Tracks/Albums choice with explicit-choice
restoration, and fixed informative Recent Album cards. It adds native activity
track/listen rows with artwork, explicit Play and guarded keyboard/double-click
gestures. Current-player and preference paint preserve live row/button ownership.

Own activity and persisted Playlist Love use the actual existing
`POST /track-preferences` route through the native CSRF fetch owner. Exact current
overlay grants and validated actor/library/ref/tier acknowledgements are required.
Private refs remain native; concurrent same-track writes are rejected, and stale
scope/source/provider results cannot paint success. There is no invented endpoint,
operation-key protocol, optimistic save or automatic write retry. The native
player change only notifies paint subscribers; audio and queue ownership stay
with the existing player. Loved filtering includes Obsessed; Obsessed excludes
ordinary Loved.

Activity playback still needs the explicit authenticated activity reader and
native canonical resolver. A missing provider keeps its controls unavailable.
Friend preference facts remain read-only. Local Recent cover/year/genre facts
are absent from the current read seam and are not manufactured. Rating editing
is outside this bounded follow-on. Fresh verification on 2026-10-08 passed all
1,300 focused checks across 63 affected JavaScript test files, including every
changed or added test file, with no failures, cancellations, skips or timeouts.
Both the 82-module native bundle and React bundle build and pass syntax checks.
The serial 512 MiB run preserved all reviewed source hashes and removed the owned
temporary dependency link. The earlier 1,155 checks do not validate these edits.

Three complete independent review passes resolved deferred Play supersession and
progressive-history revocation before the first run; a fourth complete pass
reconciled that run's repairs before the rerun. Explicit row denial now removes
held metadata and selected details for every activity kind, including malformed
pagination/cursor replies that still retain their navigation error and previous
order/cursor. Rejected pages grant no authority to new rows. Native and controller
integration fixtures exercise those combined boundaries.

The first run built both bundles and reported four failures from three causes:
a stale loader module-count metric, a React fixture that did not invoke lazy
state initialization, and an older Loved-filter expectation excluding Obsessed.
The production metric was corrected; the initializer fixture was aligned with
React semantics without changing its assertions; and the filter case now checks
all retained row identities/order under the user's inclusive Loved rule. Those
repairs received a complete independent reconciliation before the passing rerun.
Initial and final command receipts, source guards and generated hashes remain
preserved. These are focused unit/component/native-owner checks; browser layout,
live provider/database behavior, Jinja, full CI and manual acceptance remain
deferred.

This source is not complete v55 UI parity. The active checklist includes Rating
editing, additional missing-source entry adapters,
named-friend Album statistics, comparison metrics/navigation,
shared collection destinations and scheduled stop,
share/widget presentation and the full responsive filter form. Authenticated providers alone cannot supply absent
controls. Provider-backed controls already implemented also remain subject to the
live verification limits above. Album Tops persistence stays outside this slice.

## Selected-resource and Friends follow-on

The new candidate starts from `f63d826d021f468c122ca473938e09b93c9c95c0` and
adds native Artist rows/circles, a supplied listened-Album list, independently
retained Artist and Album dashboard panes, and native mobile section controls.
Current origin-bound reads and canonical targets drive those panes. The original
Album dialog is leased into the selected pane, with its native table/art/player
owners retained and competing opens retiring the lease. Desktop expansion uses
Dashboard; page actions require the implemented native page owner.

Readable account profiles have a separate route and permission from accepted
friend activity. Friend requests use a content-sized native dialog, Unfriend is
a confirmed directory action, and request cards share the existing global
notification drawer with cover tasks. The request-only producer outside Home
does not load private activity or poll. The existing visible Home controller
survives same-scope entry changes so member-profile authority is not lost during
navigation; hiding Home or changing scope/providers still disposes it.

Current local `can_open_album` already authorizes the native Album's ordinary
artwork/page presentation through `library.browse.read`; no new mandatory backend
grant is invented. Explicit denial and unsupported page-owner states are honored.
Playback still needs its separate media permission. Profile/listening grants
never become catalog-resource or playback authority.

Selected native Album Forward restoration now revalidates supported own-week
Recent and saved Playlist sources through their real readers. History retains
only an opaque token; the native owner checks current scope/source authority after
hydration and preserves original explicit restrictions. Activity replay, expired
Artist-listened-child replay, and evicted/reloaded source tokens remain unfinished
interactions with an explicit unavailable state. The source changes do not claim
complete navigation parity for those origins.

Fresh verification passed **1,652 checks across 78 focused files** on 2026-10-08.
The canonical build produced the 83-module native bundle and React bundle; both
passed `node --check`. The serial 512 MiB run preserved all 71 reviewed source,
test and document hashes, the exact inventory, HEAD/index, dependency metadata,
and 31 earlier receipt files. Its owned temporary dependency link was removed.
The previous 1,300 checks remain evidence for the preceding sealed source only.

Eight complete independent source-review passes resolved the selected-resource,
profile/request/notification and transferred-authority findings. Actual Play and
artwork actions recheck their live native receipt after source/Friends authority
changes; intentional UI retirement remains distinct from permission withdrawal.
Custom detail-only Recent Albums now have a real native Select gesture, with
independent Open/Play grants and current reader/grant checks.

The first focused command timed out with 1,439 passes, 25 failures and 10
cancellations. Its failures exposed dirty-form gate ordering and custom-reader
authority regressions, plus incomplete fixture dependencies and stale expectations.
The second command completed with 1,641 passes and nine native fixture/optional
host failures. Repairs preserved the native owners and contract assertions. Both
failed runs and their reviewed source manifests were retained; the third run
passed with zero failures, cancellations, skips or timeouts. No earlier failed or
partial result is counted as a passing check for this candidate.

No browser, live provider/database, Jinja, complete CI or manual acceptance is
claimed. Native comparison completion, named-friend Album statistics, Rating
editing, Recent missing-source capture, unsaved matching/playback, and remaining
Playlist filter/share/widget/destination/queue presentation remain separate
requested work. Album Tops persistence remains outside the priority scope.

## Deferred manual script

1. Sign in to a prepared test app with real Home Recent/Playlist read data. Verify
   account/library changes clear the old surface immediately.
2. On Home, switch activity views and periods; verify Recent Albums stays in
   informative cards, the initial phone Tracks/desktop Albums choice and restored
   explicit choice. Select/open/play a local album;
   navigate away and Back; verify scroll, selection and native player ownership.
3. With explicit social providers, exercise member search, requests, profile
   editing, friend selection, activity/comparison and grant revocation. Repeat
   with unavailable, denied, empty and failed reads.
4. Open a Playlist and switch filters/selection. With explicit mutation providers,
   edit/reorder/save/discard; change scope during pending work; verify a failed save
   retains its draft and stale completion cannot act in another context.
5. Exercise Share, queue and match controls with granted and revoked projections.
   Verify only explicit acknowledgement changes their displayed authoritative state.
6. Check desktop, narrow mobile, keyboard focus, native modal dismissal, dropdown
   open themes, rest/hover/pressed header paint and visible focus rings.
7. With an authorized missing-source provider, open Create, retain unknown and
   missing originals, and confirm Create opens an unsaved Playlist page without
   a write. Export before Save; remove/reorder rows; open the optional Top UI and
   return; cancel Discard through Close and Back. Save once and verify only the
   acknowledged persisted ID opens. Revoke access or change source revision
   during each pending step, and confirm stale work cannot revive the page.
8. With authorized native activity media/preference resolution, exercise row
   selection versus explicit Play/double-click/Ctrl/Cmd+Enter; pause/resume through
   the existing player and verify current-row paint. Cycle Love through all three
   tiers without affecting playback or selection. Repeat through Playlist, filter
   Loved/Obsessed, deny a write and change actor/library/source while it is pending.
   Verify unavailable authority never becomes an enabled write or playback action.
9. Select an Artist in own and Friend activity, distinguish unknown/empty supplied
   listened Albums, and select one while its Artist pane stays mounted. Change
   period/person/source during hydration; verify retired panes and child targets
   cannot return. Exercise native artwork/modal/page and desktop size controls,
   phone section tabs, Close/Back, and an unrelated native Album opening while
   the selected pane owns the existing dialog. Selection must not start playback.
10. Open readable request/member profiles with activity denied, then with exact
    accepted-friend read grants. Exercise native request Accept/Decline/Cancel,
    acknowledged-write/failed-refresh recovery, removed opener focus and
    directory Unfriend. Profile refs must not become catalog refs or restore
    revoked activity through Back/Forward.
11. Outside Home, open the existing notification drawer with both cover tasks
    and incoming requests. Open a request, dismiss it, enter its profile after
    native close, and accept a request whose card disappears. Check current
    focus, Escape, drawer layering, cover-only Clear completed, account/provider
    changes and any native unsaved-form guard. Repeat on phone; request dialogs
    stay content-sized and no background history/activity read is started.
12. Select a custom detail-only Recent Album and verify its readable detail pane
    while native Open/Play stay denied. For supported native Recent/Playlist
    Album pages, exercise Back/Forward through a fresh source read, cancel a
    pending restoration with newer navigation, and withdraw source permission
    before Play/artwork activation. Confirm Activity/expired Artist-child or
    expired/reloaded token entries report their current unavailable boundary;
    those unfinished restoration paths are not accepted as navigation parity.
