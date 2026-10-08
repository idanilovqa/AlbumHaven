# Production Playlist UI provider contract

The React slice lives in `music_app/static/js/playlists/`. It implements the
approved Playlist directory, header actions, metadata/order drafts, compact
track presentation, filters, sharing form and TXT semantics. It does not import
the preview fixture catalogue, fake transport, canonical model, playback queue,
sharing link generator or persistence. DTO examples belong only in source tests.

## Verified native boundary

The current read is `GET /view-data?surface=playlists`, with optional
`playlist_id` for detail, in `music_app/routes/api_read_asgi_routes.py`.
`build_view_payload` calls `playlist_read_seams.build_playlist_surface_payload`.
The existing shell/history owner controls navigation to the same surface. The
initial bootstrap may be an empty shell, so absent content is not a confirmed
empty playlist directory. `/refresh` starts a library scan and is not a playlist
reader. There is no live `GET /playlists` contract in this checkout.

All ordinary create, item, metadata, reorder, cover, sharing, default-sort and
derived-playlist writes under `/playlists` are reserved 409 responses in
`api_wave_b_asgi_routes.py`. This UI calls none of them. A Windows metadata draft
has not been incorporated. A rendered action or frontend provider interface is
not evidence of an implemented backend, database migration or working write API.

The verified native read fields are:

- `playlist_sidebar: { active_playlist_id, items }`. Items contain `playlist_id`,
  `title`, `item_count`, `is_active`, and `allowed_actions.can_open`.
- `playlist_index: { query, playlists }`. Records contain `playlist_id`, `title`,
  `description`, `visibility`, `item_count`, and `can_open/can_play/can_edit`.
- Or `playlist_detail`, containing `playlist_id`, `title`, `description`,
  `visibility`, `playlist_kind`, `query`, `track_rows`, `active_sort`,
  `saved_default_sort`, `playback_mode`, `listen_to_suggestions_after_playlist`,
  and exact `can_play/can_edit/can_rename/can_delete/can_reorder` grants.
- Track rows contain `playlist_item_id`, `playlist_position`, `album_title`,
  `track_ref/path` in private responses, title/secondary artist, track/disc number,
  duration, preferences/statistics/popularity and playback-state projections.
  Public rows omit private track refs and paths.

Native read defaults are conservative; extra frontend actions require explicit
provider extensions below. This slice never infers editability from a role,
playlist name, DOM state, array length, file path or current viewer identity.

## Mount and runtime ownership

`mountPlaylists({ host, runtime, providers = {} })` in `index.jsx` creates one
React root and transient controller. The parent production bundle owns boot and
calls this function for `#playlists-root`. It returns
`configureProviders(next)`, `refresh()`, and `dispose()`. The production entry supplies auto-boot and exposes
`window.AlbumHavenPlaylistUI.configureProviders(next)` and `refresh()`; this module
has no second native state store. Replacing provider
identities clears drafts and cancels old requests; account/library scope changes
also erase all held projections and drafts.

Runtime methods:

- `snapshot()` returns a stable object until changed:
  `{visible, scopeKey, playlistId, payload, entryKey?}`. `scopeKey` must change on
  account/library/access invalidation. `payload` is the native projection above,
  or null while no authoritative playlist content exists.
- `subscribe(listener)` returns an unsubscribe callback.
- `readPlaylists({scopeKey, playlist_id, signal})` optionally uses the verified
  native read. A supplied `providers.readPlaylists` replaces it. These reads must
  not emit their result back as a fresh native snapshot: that would invalidate
  the controller's own pending write refresh.
- `navigate({playlist_id})` uses the existing native navigation/history owner and
  rejects if navigation failed. The React adapter reconciles with the current
  native snapshot on rejection; it never changes history itself.
- Existing presentation owners: `buttonHtml`, `actionHtml`, `alertHtml`,
  `galleryBarHtml`, `tableHtml`, `navigationItemHtml`, and `escapeHtml`.
- `albumTrackRow(row,index,{playlist,readOnly:true})` returns native
  AlbumTrackTable cell presentation. Its read-only mode must omit raw media/path
  hooks. CompactDataTable owns the overall compact table and cells.
- Optional `canTrackIntent('play',row,{playlist_id})` must return exactly true
  before a play button is enabled. `trackIntent('play',row,{playlist_id})`
  rechecks current authorization and delegates to the native player owner.
  The UI never constructs a media URL, queue, playback success or local identity.
  Playback is keyed by item ID, not title/path matching. Selection displays
  already-readable DTO facts; Album detail reads independently require an own
  `can_view_details` grant, opaque album ref and explicit configured reader.
- `openForm` is the existing native dialog owner, using the same contract as
  Home/Friends. The generic NativeDialog React portal owns only its inner host;
  native code retains dismissal/focus-trap/return-focus ownership.
- Optional `pickTracks({playlist_id,signal})` returns selected opaque track refs or null.
  Without it Add remains disabled. The result is scope/selection-checked before
  reaching an explicitly supplied `addTracks` writer.
- Optional `downloadText({text,filename})` delegates an explicit TXT download.
  This is an export, never application data persistence or a save acknowledgement.

The parent may reuse generic Home/Friends Button, Status, NativeHtml and
NativeDialog wrappers. There is no shared domain state or cross-controller store.

## Provider projection extensions

Readers return the raw native DTO or `{status,data}` with `status` equal to
`ready`, `empty`, `denied`, or `unavailable`. Invalid payloads and unexpected
transport failures become `error`; numeric 401/403 errors become `denied`.
Loading/error/denied states do not display stale detail data. Denied data is
discarded regardless of the response body. Sparse arrays, duplicate directory
IDs and duplicate explicit playlist-item IDs are rejected. Missing item IDs
receive presentation-only row keys and cannot authorize reorder or media access.

A future authenticated provider can add:

- `playlist_actions.can_create: true` on the root projection.
- Detail `allowed_actions.can_add`, `can_share`, `can_export`,
  `can_create_album_top`, `can_create_sample`, each exactly true.
- Detail `revision` as an opaque string for backend concurrency checks, and
  `items_complete: true` only when every canonical item is supplied. This is
  mandatory for reorder and TXT export; filtered/paged projections cannot claim
  to be a complete authoring/export source.
- Row `artist`, `album_ref`, `source_ref`, `source_label`, `source_kind`, and
  `availability` equal to `local`, `missing`, or `unresolved`. Unknown availability
  stays unresolved. No title-based match or canonical identity is manufactured.
- Row `source_readable: false` or a present own `allowed_actions.can_read` value
  other than exact `true` marks an unreadable source. Its private display text is discarded, action grants are
  removed, and it is excluded from all TXT output. Readable unknown-availability originals remain in ordinary TXT and ordinary
  source creation, but do not enter missing-only inspection or TXT. Unknown
  canonical identity remains eligible when availability is confirmed missing.

All grants require own properties with exact boolean true. Numeric/string truthy
values and inherited grants confer no permission. Provider responses are copied
and frozen; the UI cannot mutate the native projection.

## Transient authoring and writes

`createPlaylistController({readPlaylists,providers})` exposes subscription and
snapshot methods, `setScope`, `configure`, `load`, `accept`, `select`, `suspend`,
`available`, `edit`, `reorder`, `discard`, `filter`, `readSharing`, `mutate`, and
`dispose`. No localStorage, sessionStorage, file persistence or fabricated
server-success fallback exists.

Metadata drafts are held per playlist in memory while switching selections.
Title limit is 100 characters and description limit 1,000. Title changes require
both `can_edit` and `can_rename`; description changes require `can_edit`.
Authoritative changes to baseline metadata, revision or a drafted item order
mark a conflict and preserve the draft, blocking save until it is discarded.
Filtering does not mutate saved rows or order. Reorder requires exact complete
item IDs, `can_edit` and `can_reorder`, and the unfiltered authoring view.

Each writer receives `{scopeKey,playlist_id,signal,...data}`:

| Provider | Additional data | Required grant |
| --- | --- | --- |
| `createPlaylist` | `title,description`; playlist_id is null | root `can_create` |
| `savePlaylist` | `title,description,revision,item_order?` | `can_edit`, plus `can_rename`/`can_reorder` for respective changes |
| `addTracks` | unique `track_refs` from explicit native selection | `can_add` |
| `createAlbumTop` | selected playlist identity | `can_create_album_top` |
| `createSamplePlaylist` | selected playlist identity | `can_create_sample` |
| `saveSharing` | `mode,people:[{account_ref,role}]` | `can_share` plus current sharing projection below |

Writers must return `{ok:true}` or `{status:'ready',data?}` explicitly. Undefined,
empty or contradictory responses never count as a save. Denied/unavailable
responses are explicit failures. A successful acknowledgement clears only the
saved metadata/order draft and refreshes the authoritative read. The busy state
spans that refresh and rejects repeated writes. A refresh failure is displayed
independently from the server-confirmed mutation. No write is automatically
retried. Signals and request identity prevent late completions from crossing
selection, account, provider or disposed-controller boundaries. Cancellation
cannot undo a write already accepted by a server; backend idempotency and
revision handling remain mandatory integration responsibilities.

Derived/sample providers must own their real create/preview workflow. Merely
supplying a callback does not authorize a fabricated saved resource. Their
absence keeps actions disabled; no production sample fixture is created.

## Sharing

Absent sharing providers show unavailable in the native form. The UI does not
invent people, a public URL or sharing success. `readSharing` receives the same
scope/playlist/signal arguments and returns either a status envelope or:

```
{
  mode: 'private' | 'people' | 'link',
  allowed_modes: [/* explicitly supported modes */],
  can_manage: true,
  people: [{account_ref,display_name,selected,role:'viewer'|'editor',can_edit}]
}
```

The current read must permit management, the requested mode and every recipient.
Locked recipients cannot be removed or have their roles changed. User-visible
names do not become account identifiers. Changing playlist/scope/providers or
refreshing its projection invalidates prior sharing authorization. The backend
must independently enforce all authorization, disclosure and recipient checks.

## TXT and verification boundary

Ordinary TXT exports the complete canonical or unsaved draft order. View filters
never silently narrow it. Missing-only TXT uses the same order and includes only readable rows whose
availability is explicitly `missing`. Unknown availability is not confirmation;
unknown canonical identity does not exclude a confirmed-missing occurrence.
Exports contain only artist/title/album text, not local media paths or refs, and
never save a draft. Line breaks/tabs in fields are normalized into text.

Source tests are `playlists-react-model.test.js` and
`playlists-react-components.test.js`. They cover DTO normalization, sparse data,
exact grants, stale reads/writes, scope/provider cancellation, draft conflicts,
reorder identity, sharing restrictions, truthful status, native rendering and
export semantics. Tests use fixtures only inside test source. Historical checks
on a lost checkout do not apply to this reconstructed candidate. Fresh focused
verification must be recorded separately after execution. Component tests use
an in-memory Node fixture bundle/SSR render; they do not verify browser geometry,
live providers, database behavior, complete CI or manual acceptance.


## Integrated controls

The grouped directory consumes explicit `playlist_kind`; unknown kinds stay in
Other playlists. Search, availability, love, style, duration, added-date and
listening-frequency filters compose as transient view state. Unknown supplied
facts stay unknown and follow the explicit filter policy.

Selected rows expose Track and Album information with native presentation.
Canonical item refs survive current-detail refresh only when still readable;
anonymous projection positions never acquire persistent identity. Album reads
require an explicit provider and independent source grant. Missing/unresolved
rows expose a compact Review control; selecting candidates does not accept them.

Reorder handles support pointer drag and keyboard Arrow/Home/End commands. They
require exact edit/reorder grants, complete rows, canonical author order and no
active filters. Commands reread current scope, playlist, grants and draft before
application. Discard uses native confirmation and rechecks the same draft after
awaiting. TXT export also requires complete canonical order, excludes unreadable
sources, and missing-only retains only confirmed-missing availability.

Optional `readPlayback`, `subscribePlayback`, `playbackIntent`, `readMatches` and
`acceptMatch` providers are implemented in `integrations.mjs`. They require exact
scope/playlist/selection/revision context and explicit action acknowledgements.
Absent providers show unavailable controls. No queue, shuffle/repeat result,
match identity or write success is fabricated. Current track paint updates
`aria-current` in place without replacing the live reorder owner.

The ordinary and missing-source Playlist builder is implemented as described
below. Additional entry adapters from Home/Friends/Album/Tops and matching or
native playback of unsaved source occurrences remain separate work. Album Tops
persistence, queue-backed end-of-list behavior and match persistence remain
provider work; populated fixture states do not prove live integration.


## Item-aware Playlist creation

The visible Create action uses one native form for ordinary library source
creation. Inspect missing tracks directly prepares the regular full unsaved
Playlist page from the current Playlist detail. It never opens the creation
form. Neither path falls back to metadata-only creation, which would drop the
selected source occurrences.

The authenticated Playlist read may provide an own `playlist_creation_source`
(root) or `missing_playlist_creation_source` (detail):
`{kind, ref, revision, allowed_actions:{can_read:true,can_use_for_playlist:true}}`.
Kind is library for ordinary and playlist for missing. The root's own
`playlist_actions.can_create` must also be exactly true. Missing grants,
inherited fields, paths used as references and incomplete identities do not
admit a session. The native reader whitelists only explicit fields and supplies
no creation source when the backend does not return one.

The source reader is required for ordinary creation and direct inspection. The writer is required for
ordinary Create and for an unsaved missing Playlist's explicit Save:

- `readPlaylistCreationSource({scopeKey,mode,source,signal})`
- `createPlaylistFromSelection({scopeKey,playlist_id:null,mode,source,title,
  description,entry_refs,request_key,signal})`

The source is only `{kind,ref,revision}`. The source response repeats exact scope,
mode and source identity, grants read/use permission, declares
`entries_complete:true`, and supplies dense `entries` and separate
`retained_parent_albums`. Each row has a supplied occurrence `entry_ref` (or null
for display-only), optional canonical track ref, supplied display facts, exact
read/select grants and explicit parent resolution. Unknown musical identity does
not remove a selectable supplied occurrence; missing occurrence identity never
becomes a guessed track ID. Titles, durations, years, track/disc numbers,
availability and metadata freshness are not manufactured. Known parents group by
opaque identity; unknown or ambiguous parents remain separate occurrences.

Inspection retains only readable confirmed-missing rows before deduplication,
preparation and Save. Local and unknown/ambiguous availability are excluded.
Missing rows with unknown canonical identity retain their real occurrence refs,
original metadata and source order. Read-only review uses existing Track/Album
facts; unsaved keys never enter persisted-item matching or native playback. A known
album with a confirmed-missing member is Incomplete even if the album itself is
present. Retained parents remain separate and are never added as tracks or sent
to the Playlist writer; the unsaved page's Create Top adapter revalidates that evidence.

The form offers Name/description, canonical native Search, All/Selected tabs,
chronological known-album groups and selection of visible eligible rows. Selected
preserves chosen order. Search never changes the source or musical identity.
Ordinary creation may be empty; direct inspection needs eligible confirmed-missing rows.

The writer must atomically create the Playlist with every selected occurrence in
order or reject it. Its only accepted acknowledgement is
`{status:'ready',data:{scopeKey,request_key,playlist_id,revision}}` with exact scope
and operation key plus supplied opaque created identity. The UI never splits
creation into metadata and later item writes, generates a Playlist ID or fakes a
directory item. A secure `crypto.randomUUID` supplies the operation key, which is
an idempotency token rather than musical identity. An attempted write stays
locked if its outcome is ambiguous; no automatic retry is made.

An ordinary form's confirmed write immediately retires private source rows and leaves a minimal
confirmed state while the real Playlist reader refreshes. Only a fresh returned
created ID with exact `can_open` may navigate, after the native form's parent
history return completes. Refresh failure retains truthful creation success and
never resends the write. Scope/provider/surface lifecycle changes invalidate old
completion, including a later restoration of identical descriptor strings.

Parent access refresh pauses source authority without discarding typed metadata.
Private rows and selections are cleared immediately. A fresh same-revision
context requires explicit source reload/new selection; a new revision exposes
conflict while retaining metadata. Denial, actor change, provider replacement or
source identity replacement erases the inaccessible session. Pending write keys
remain terminal across pause and revision changes.

## Unsaved missing Playlist page

Inspect missing tracks is visible only when the current readable source contains
a confirmed-missing row. It freshly reads the complete authorized source and
transfers retained confirmed-missing occurrences directly to the native full
Playlist edit page, without a modal or writer call. The title is prefilled from
the source; the ordinary header includes the shared green Save disk. A fresh
empty, denied, unavailable or retired source does not open a partial draft. Its per-document draft token is solely a
presentation/history marker; it is never a `playlist_id`, persisted item ID,
operation key or backend reference. The ordinary Create path continues to
persist its complete selected occurrence list immediately.

The page keeps Name/description, selection, search/filters, ordered removal and
pointer/keyboard reorder. It exports currently retained readable confirmed-missing
originals in authored order before Save, regardless of the visible filter. It
does not reintroduce removed rows, local rows or unknown availability. Playback of
unsaved source occurrences remains explicitly unavailable; their occurrence
references never enter the persisted Playlist player or match interface.

Save alone invokes `createPlaylistFromSelection`, using the current retained
occurrence order and the exact source revision. The same exact acknowledgement
and ambiguous-write lock apply. A fresh real directory read and `can_open` grant
are required to navigate to the saved ID. Refresh/navigation failure reports the
acknowledged Save truthfully and never repeats the write.

Close and departing native history/navigation use the existing native Discard
confirmation. Cancel preserves the same page; a discarded token cannot be
restored by Forward. History stores only token and scope, never the page's source
rows. Actor, provider, source identity or read/use grant retirement erases the
draft. A same-source revision change clears display authority, preserves typed
metadata and retained occurrence order, and requires an explicit source refresh.
Refresh intersects that order with freshly authorized confirmed-missing occurrences.

Create Album Top is a UI-only optional `openAlbumTopDraft` boundary, independent
of any Top persistence provider. It requires the source detail's exact
`can_create_album_top` grant and current retained known-parent read/Top evidence.
The intent is `{scopeKey,source:{kind,ref,revision},album_refs}`; it deduplicates
known parents in retained first-appearance order. Unknown or removed parents are
never inferred, and explicit empty occurrence associations grant nothing.
The UI callback's second argument is `{signal,isCurrent,retainNavigation}`.
After any asynchronous read, the adapter must honor cancellation, recheck
`isCurrent()` and open its native child inside `retainNavigation(callback)`.
Changes to retained rows/source/Top grants retire that operation. Native Back
returns to the same retained draft; no draft token enters the provider intent.

## Track table view and supplied metrics

Metric headers cycle ascending, descending and default order through the shared
CompactDataTable owner. Unknowns stay last in both directions; equal values keep
the incoming authored order. Sorting changes the view only. Save and TXT retain
the complete authored order, and all native, keyboard and button reorder paths
are unavailable until default table order returns. Rating uses the existing
measured-width narrow-table contract and is hidden at widths of 480px or less.

The optional scalar display fields are `love_tier` (`off`, `loved`, `obsessed`),
`track_rating` (integer 1–5), `play_count` (nonnegative integer personal plays),
`popularity_count` (nonnegative integer global popularity), and numeric
`duration_seconds`. No count is derived from another count: in particular,
`listen_count` is not personal Plays and local scrobbles are not global
Popularity. Unknown values remain unavailable, never zero. A supplied nonempty
`duration_display` may remain a display-only fallback; it never supplies a
numeric sorting value. Rating remains read-only. Love editing uses the existing
native track-preference route only when the current private row carries a valid
preference overlay and exact `can_set_love_tier` grant; see below.

Native Playlist projection preserves only explicit safe relative artwork URLs
and strict supplied availability values. It does not infer local availability
from streamability. Explicit unreadable rows are redacted before display and
native playback resolution. Their item identity remains in private duplicate
detection so conflicting duplicates cannot become uniquely playable.

Explicit Play, a row double-click, and Ctrl/Cmd+Enter on a focused readable row
use the same current canonical runtime playback adapter. Selection clicks and
ordinary Enter select only. Interactive subcontrols and held keys do not start
row playback. Sorting cannot rewrite queue order or fabricate a media identity;
confirmed missing and denied rows stay unplayable. Source, scope, provider and
view changes are rechecked before synchronous native dispatch. Selection/current-player
paint retains the live row nodes so the first click does not remove a physical
double-click target.

## Native Love editing

Native track Love uses `POST /track-preferences`, independently of the reserved
Playlist mutation routes. The shared native adapter retains canonical private
refs, uses the current CSRF fetch owner and checks actor/library/ref/tier/grant
acknowledgements. React receives only an opaque preference identity and supplied
preference facts. Missing overlay authority keeps the control read-only; Playlist
edit rights alone confer no track-preference permission.

The canonical Love action cycles Off, Loved, Obsessed, then Off. Pending writes
are deduplicated across Home/Playlist occurrences of the same native track.
Failure never implies a saved value or triggers an automatic retry; retirement
ignores late completion. Validated acknowledgements paint in place and update
view filtering/sorting without replacing canonical rows, metadata drafts, authored
order, history pagination or player state. Loved includes both Loved and Obsessed;
Obsessed includes only Obsessed. Unknown facts keep the explicit filter policy.

The route does not accept a revision or operation-key contract. This adapter
does not invent one or reuse the Playlist creation acknowledgement protocol.
Rating editing, unsaved source playback and local matching remain separate work.

## Selected resource navigation

Selected rows may additionally supply independent `album_target` and
`artist_target` descriptors for the shared detail/native resource owner. These
retain their exact Playlist/revision origin and current source grants. Artist
identity is never derived from an artist label, and private native Gallery/media
targets do not enter React. Native opening/artwork/page actions re-resolve the
current source; the display projection itself grants no media access. Existing
Track selection, Love, explicit playback and authored Playlist order keep their
separate owners.

Native mobile Forward restoration can reread a saved Playlist through the
existing native reader without exposing hidden-surface reads as public actions.
It requires the exact original Playlist/revision, current directory open
permission, a readable canonical Album target and unambiguous local mapping.
An active draft blocks replay, and original explicit presentation/media denials
remain bounds on the refreshed target. Changed revisions, missing mappings or
expired transient history tokens require a new selection; they do not fall back
to an unrestricted ordinary Album page. This source restoration is separate from
the unsaved Playlist draft's own existing history token.

## Native form lifecycle

`NativeDialog` forwards opt-in `pageId:'create-playlist'` and
`beforeDismiss(reason)` to the existing native form owner. Cancel, Escape,
backdrop, native Back and history/replacement intents share serialized exact-true
dismissal. Dirty discard uses native confirmation and rechecks the same draft.
Forced disposal removes data immediately without navigating over a newer route.
Forced successful close returns an awaitable native parent traversal before the
existing Playlist navigation owner opens the created ID. Mobile history holds
only an opaque live-form token, never draft/source/provider data. Browser layout
and mounted end-to-end behavior remain separate deferred verification.
