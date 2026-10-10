# Home Album/Artist detail projection

This React display boundary is paired with independently guarded native Album
and Artist actions. It remains separate from account profiles, friend listening
authorization and playback. It adds no endpoint, backend, seeded account,
fixture import, storage fallback, or persistence. An absent reader is explicitly
unavailable. Unknown facts are not replaced with plausible metadata or zeros.

## Verified existing owners

- `runtime/track-modal-lightbox-helpers.js` owns
  `fetchTrackModalAlbumDetails(albumKey, {signal})`, which reads the existing
  `/album-details?album_key=…` route. The server route in
  `routes/api_read_asgi_routes.py` resolves current actor/library scope; the private
  route boundary requires `library.browse.read`.
- `runtime/home-friends-bridge.js` owns Home's current native album grants and
  `albumIntent`. Its exact local match, unique ref, visible scope, current request,
  native hydration and playback checks must remain there.
- `AlbumDetailsHeader` is reused through its `copy` variant. The normal album
  variant defaults a missing release type to `ALBUM`, which is unsuitable when
  the projection does not know the type.
- `AlbumArtbox` renders supplied safe server artwork or its existing empty state.
- `AlbumTrackTable` has an explicit read-only projection mode for the Playlist
  boundary that omits all playback/path/problem hooks. This detail boundary
  composes its underlying `CompactDataTable` with escaped title/secondary text;
  it never fabricates a path or a secretly wired playback button. The native
  track-title class also carries a pointer cursor and is deliberately not used
  for these read-only cells. Native local overflow owns narrow table scrolling.
- The existing Artist information resolver includes trial biography/image
  fallbacks and generated summary prose. It is not a source for these panels.
  No authenticated Artist detail provider has been established by this slice.

## Read contract and source grant

An explicitly configured provider implements:

```js
readDetail({scopeKey, kind, ref, origin, signal})
```

`kind` is exactly `album` or `artist`; `ref` is an opaque nonempty resource
reference from a fresh authenticated source. The caller must resolve a selected
row against its current source, never trust a restored history record as a grant.
The current selection must supply an own boolean
`allowed_actions.can_view_details === true`. History `can_view_activity`,
`can_compare`, matching names, visible artwork and raw ref strings do not grant
detail access. The provider must independently enforce current server authority.

The native Home bridge may explicitly map its already-verified real local-album
`can_open_album` into this detail-read grant at that existing owner. This is not
an automatic fallback in the controller. For that bridge implementation:

1. Check its unique local row, exact local-match state, live Home visibility,
   account/library scope and current native `can_open_album` before reading.
2. Use the existing native reader with the supplied abort signal. Do not reuse a
   global native modal cache across scopes and do not create a new endpoint.
3. Recheck the same guards after awaiting, and verify returned album identity.
4. Whitelist the fields below before crossing into React. Never spread a native
   album, `track_rows`, raw `tracks`, cover path, playback state or preference
   overlay into this DTO. Native `track_ref` currently aliases a filesystem path.
5. Use presentation-only row IDs when a safe opaque row identity is unavailable.
   Position-based UI keys are acceptable; they are not fabricated track numbers,
   playback refs or authority. Preserve supplied titles/numbers/durations only.
6. Leave unknown fields null/empty and leave unimplemented Artist reads
   unavailable. Missing metadata is not evidence of a current or last-known fact.

## Whitelisted response

The provider returns the DTO directly or `{status: 'ready', data: DTO}`:

```js
{
  kind: 'album',                 // or 'artist', must match the requested kind
  ref: 'opaque-resource-ref',    // must exactly match the requested ref
  title: 'Supplied title',
  artist: 'Supplied album artist',
  year: '',                     // display string; absent is unknown
  release_type: '',              // no default ALBUM type
  metadata_state: 'current',     // current | last_known | unknown
  artwork_url: null,
  summary: '',                   // plain supplied information, never HTML
  source_label: '',              // only when the provider has attribution
  duration_seconds: null,
  track_count: null,
  release_count: null,
  native_actions: null,
  tracks: [                     // album only: null/omitted means unknown
    {
      id: 'opaque-display-row',
      title: 'Supplied track title',
      artist: 'Supplied secondary artist',
      track_number: null,
      disc_number: null,
      duration_seconds: null
    }
  ]
}
```

Artist DTOs have `discography` instead of `tracks`:

```js
discography: [
  {
    id: 'opaque-display-row', title: 'Supplied release title',
    year: '', release_type: '', metadata_state: 'last_known',
    artwork_url: null, native_actions: null
  }
]
```

Collections are null when not supplied and arrays when supplied. An empty array
means the provider returned no rows, not that the artist has never released
anything or an album cannot have tracks. Counts and total durations come only
from provider values; the panel does not infer totals from a partial collection.
IDs must be nonempty and unique within a collection. The provider owns paging or
completeness; the panel makes no claim that the supplied rows are exhaustive.

Finite nonnegative numbers are preserved; count and row-number fields also
require safe integers. Missing/invalid numbers become null, distinct from a
known zero. Display strings default to empty. Unknown/invalid freshness becomes
`unknown`, visibly distinguished from `last_known`; the client never labels a
cached response last-known on its own. Errors, loading and revocations erase old
data immediately instead of displaying it as a fallback.

Artwork accepts only root-relative server URLs under the shared
`safeServerArtworkUrl` guard. The provider must supply an authorized image URL
with no local filesystem paths or secrets; it must not forward raw `cover_path`,
`remote_cover_url`, track URLs, or construct a URL from raw private media paths.
Foreign URLs, protocol-relative URLs, active/data/blob/file schemes, backslashes,
spaces and control characters are discarded. No default image is invented.

Optional native action metadata is a separate, whitelisted structure:

```js
native_actions: {
  album_ref: 'opaque-native-album-ref',
  allowed_actions: {can_open_album: true, can_play_album: false}
}
```

Both grants require own exact booleans, and play also requires open. The detail
panel can expose guarded native action intents. Every action must go through
the existing native owner, resolve its fresh grant again and keep detail/history
authorization distinct. No result from this reader authorizes media by itself.

Other supported responses are `{status: 'empty', data: null}`,
`{status: 'denied'}` and `{status: 'unavailable'}`. Empty-with-data is invalid.
Denied/unavailable data is always discarded. Invalid structure or an identity
mismatch becomes a generic error. Numeric HTTP 401/403 errors become denied;
other failures become error, while a provider abort becomes unavailable. Raw
service errors are neither retained nor displayed.

## Controller and React wiring

`createDetailProjectionController({readDetail})` exports:

- `getSnapshot()` and `subscribe(listener)` for a stable immutable external store
- `setScope(scopeKey)`: a changed account/library scope aborts and clears selection
- `configure({readDetail})`: replace the reader; a changed identity clears selection
- `select({kind, ref, allowed_actions})`: synchronously replace/revalidate selection;
  returns whether the explicit read grant is present; does not start a read
- `load()`: read the current granted selection; repeated calls supersede earlier ones
- `clear()`: abort and erase selection/data on Close or departure
- `dispose()`: abort, clear data/listeners and make future operations inert

Snapshot shape is `{scopeKey, selection, detail: {status, data}}`. Re-selecting an
identical target/grant is a no-op; an explicit refresh uses `load()`. The host
must synchronize grants on every source refresh, clear when a selected row is no
longer present or authorized, and reset on account/library change. Abort signals
are supported, and request identity also rejects late responses/rejections when
a provider ignores cancellation. Details and grants must not be put in browser
history; restored identity must be freshly resolved before selecting.

`normalizeDetailResult(result, selection)` and `detailSelection(value)` are also
exported for an existing parent store to reuse this boundary without introducing
another controller. Do not bypass normalization in rendering.

`DetailProjectionPanel({runtime, value, selection, onRetry})` receives the current
normalized detail resource and current source selection. It additionally rejects
stale data whose identity does not match that selection. Parent wiring provides:

- `runtime.detailHeaderHtml(config)` forwarding `buildAlbumDetailsHeaderHtml`
- Existing `artboxHtml`, `tableHtml`, `alertHtml`, `buttonHtml`, `actionHtml`,
  `escapeHtml` adapters
- The owned `home-detail-projection.css` stylesheet
- Selection placement, close/focus restoration and existing native Open/Play UI

The projection itself has no raw-media hooks or preview state machinery. For a
currently authorized local Album, the native runtime may acquire the existing
Album dialog into the selected pane. That bounded lease moves the original node,
preserves its native table/art/player owners, and retires before a competing
modal/page open. Selection alone does not start playback or replace the queue.

## Origin-bound composition and native ownership

Selections may include `origin` with source (`recent`, `activity`, `playlist` or
`comparison`), account reference, kind/period, and optional supplied snapshot
reference; Playlist origins instead carry their canonical Playlist reference.
An origin-bound response must echo that exact origin in addition to kind/ref.
An origin change invalidates the held result even when the resource ref matches.
Legacy unbound callers remain compatible. History holds only presentation refs;
it cannot restore access or old metadata.

Activity/Playlist rows can supply independent `album_target` and `artist_target`
selections. Artist identity is never inferred from a title. Artist detail may
supply `listened_albums`, separate from `discography`, with each Album's own
detail target and native actions. Null means not supplied; an empty list is known
empty. No count or membership is synthesized from a partial history page.

`ResourceDetail` may portal that supplied list into its parent's Artist-row
outlet using `listenedAlbumsHost`. Its `onDetailChange(value,target)` reports the
current normalized read to the composition owner; a chosen child Album is
resolved against that current ready list while the Artist pane stays mounted.
Native child-target retention is bound to the live Artist read, parent source,
origin and provider, and erases on retirement. A stale child card cannot retain
either detail or native-action authority.

Native `canResourceIntent` / `resourceIntent` support separate open, artwork,
page and Artist Gallery intents. Their source is re-resolved before and after
hydration; abort/lifetime and native-owner generations reject late work. The
verified current local Album `can_open_album` derives from `library.browse.read`
and already owns its native artwork/page presentation. Absent optional
presentation overrides reuse that authority; explicit denial is honored.
Playback still requires its separate media/read permission. A page intent also
requires an implemented native page owner; desktop widget expansion uses the
existing Dashboard. Artist Gallery navigation requires an explicitly resolved
native Gallery target, not a query fabricated from a displayed name.

The embedded Artist information renderer is an opt-in presentation of the
existing native component with supplied image/summary only. It adds no fictional
biography, fallback link or unavailable action disguised as a working control.

## Native source-page restoration

A selected local Album transfers an opaque source token to the existing native
mobile history owner. Grants, raw Albums and source callbacks remain in a bounded
transient native registry. Ordinary native Album entries without that token keep
their existing restoration behavior. Responsive promotion also checks the
current page restriction before moving an existing modal into a page.

Forward can revalidate own-week Recent Albums through a fresh `/home-data` read,
or a saved Playlist Album through the existing Playlist reader at the exact
original Playlist revision. Both paths require the same account/library, a
unique current readable source and local Album mapping, and current native open
permission. The native owner checks the fresh source receipt after hydration and
before presentation; navigation, scope or source replacement retires late work.
Original explicit false artwork/play/page restrictions remain upper bounds.

Initial opening transfers a current native receipt before the source UI retires.
The old UI signal and visibility do not revoke that accepted transfer, but source,
provider, account/library and retained parent-detail changes do. Actual native
Play and artwork activation recheck the receipt. Completed normalized Friends
results can only retire a transferred friend's authority when its accepted
activity grant disappears; unchanged accepted results preserve it. Neither a
positive refresh nor a history token can revive an expired receipt.

Custom Activity replay and an Album known only through an expired Artist
listened-Album response remain unfinished interactions: the current contracts
lack a safe fresh relationship/page lookup or parent-Artist detail replay.
An evicted token or process reload also cannot reconstruct the transient source
authority. These cases show the native unavailable state and require a new
selection from the source. This is not complete Back/Forward or reload parity.

## Verification scope

Focused source tests cover exact source grants, normalization/whitelisting,
identity mismatch, request supersession, scope reset, revocation, provider change,
close/disposal, unknown versus empty/zero/last-known data, unsafe artwork and
native renderer output without playback hooks. Tests and build execution require
the parent task's serial admission. Browser, database, functional E2E, visual
acceptance, CI, commit and publication are separate gates; this source boundary
does not claim them.
