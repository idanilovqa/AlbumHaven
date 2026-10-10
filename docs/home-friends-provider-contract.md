# Home/Friends provider boundary

The production React client uses `music_app/static/js/home-friends/model.mjs`.
The controller owns transient presentation state, request cancellation, and exact
server-grant checks. It does not implement an account service, infer permissions
from identity, fabricate history, import mock seeds, or persist data.

The existing runtime supplies `readRecent`; its actual Home read remains the
source of `recent_local_albums` and `recent_not_local_albums`. Social/profile and
additional history features require explicitly supplied authenticated providers.
No endpoint is guessed or enabled by this boundary. An absent provider produces
`unavailable`, with no synthetic records, write success, or storage fallback.
The future backend remains responsible for account/library isolation, current
relationship authorization, field-level disclosure, durable storage, and paging.

## Controller

```js
createHomeFriendsController({ readRecent, providers = {} })
```

The returned object exposes:

- `getSnapshot()`: the same frozen snapshot until state changes
- `subscribe(listener)`: returns an unsubscribe function; the listener receives
  no arguments and should read the current snapshot
- `setScope(scopeKey)`: reset on a changed account/library scope; the host must
  update this opaque key whenever its authenticated account or library changes
- `configure(providers)`: replace the entire provider set; unchanged function
  identities do nothing, changed identities clear state and cancel old requests
- `loadRecent()`, `loadFriends()`
- `acceptRecent(payload)`: synchronously validate a fresh real native Home
  projection, cancel any older recent read and publish ready/empty/error
- `selectFriend(accountRef | null)`: synchronously returns whether selection was
  accepted; null selects the user's own context, without inferring a read grant
- `loadActivity({ kind = 'albums', period = 'week', cursor = null } = {})`
- `loadComparison({ kind = 'tracks', period = 'week', cursor = null } = {})`
- `mutate(action, target = null, value = null)`
- `dispose()`: abort requests, remove subscriptions and erase the held snapshot

Loaders and mutations are awaitable. Missing providers update their snapshot
synchronously. A disposed controller is inert. Scope changes and provider
replacement abort every channel, including mutations; selection changes abort
activity/comparison. Providers should honor `signal`, but request identity also
discards late resolutions/rejections when a provider ignores cancellation.

Snapshot shape:

```js
{
  scopeKey: null,
  recent: { status: 'unavailable', data: null },
  friends: { status: 'unavailable', data: null },
  activity: { status: 'unavailable', data: null },
  comparison: { status: 'unavailable', data: null },
  selectedFriendRef: null,
  mutation: { status: 'idle', action: null, target: null, data: null }
}
```

Read status is `loading`, `ready`, `empty`, `denied`, `unavailable`, or `error`.
Loading/error/denied/unavailable resources hold null data. Invalid payloads or
transport failures become `error`; thrown errors with numeric HTTP status 401 or
403 become `denied`. Raw service error text is not displayed or retained.

Legacy `loadActivity` and comparison reads replace the previous page. Explicit
`loadMoreActivity` appends cursor results for the same validated activity query;
`loadActivityPage` uses optional authoritative numbered metadata. Neither merges
across periods/accounts. The host owns navigation and paging controls. Allowed
kinds are `albums`, `tracks`, `artists`, and `listens`.
Period is an opaque nonempty provider key; the controller never invents date
ranges or totals. Cursor is null or a nonempty opaque string.

## Read providers

All providers receive a single object containing `{ scopeKey, signal }`.
`readActivity` and `readComparison` additionally receive
`{ account_ref, kind, period, cursor }`.
Only explicit numbered activity jumps additionally send
`pagination:{mode:'numbered',page,page_size:100}`. Existing initial and cursor
provider requests receive no new fields; comparison remains replacement-only.

A provider can return the raw DTO below or an envelope:

```js
{ status: 'ready' | 'empty' | 'denied' | 'unavailable', data }
```

Denied/unavailable response data is discarded, even if supplied. An explicit
empty envelope can have null data. Otherwise data must validate; a ready result
with no rows becomes `empty`, while an empty envelope containing rows is an
error. Friends/profile data remains available in an empty friends projection,
so a real zero-friends state may still carry a profile and request permission.

### Recent

```js
{
  recent_local_albums: [/* existing server-owned Home row DTOs */],
  recent_not_local_albums: [/* existing server-owned Home row DTOs */]
}
```

The controller validates both arrays and object rows. It preserves the existing
server row fields and normalizes `can_open_album`, `can_play_album`, and independent `can_view_details` to exact
boolean grants. Native Recent rendering remains responsible for existing
local-match/ref guards and album navigation/playback actions.

### Friends and profile

```js
{
  friends: [{
    account_ref: 'opaque-account-ref',
    display_name: 'Server display name',
    handle: 'server-handle',
    relationship: 'accepted',
    allowed_actions: {
      can_view_activity: true,
      can_compare: true,
      can_remove: true,
      can_block: true
    }
  }],
  requests: [{
    request_ref: 'opaque-request-ref',
    display_name: 'Server display name',
    handle: 'server-handle',
    direction: 'incoming', // or 'outgoing'
    allowed_actions: { can_accept: true, can_decline: true }
  }],
  profile: {
    display_name: 'Server display name', handle: 'server-handle', bio: '',
    allowed_actions: { can_edit: true }
  }, // or null
  allowed_actions: { can_request: true }
}
```

Refs must be nonempty and unique within their array. Display strings may be
missing and become empty strings. Missing/nonboolean grants are false; inherited
properties do not count as grants. Any accepted friend can be selected so
explicitly permitted relationship actions remain reachable even when both read
grants are false. Selection grants no access: each selected-account read
independently requires its exact grant. Pending/outgoing requests never
become accepted friends. Comparison requires a selected accepted friend.

Own activity is only available through an explicit `readActivity` provider and
passes `account_ref: null`; the backend must authorize the acting account. This
is not a general account-ID override.

Refreshing friends aborts and clears selected social history immediately. A
removed friend clears selection. Revoking either read grant marks that projection
`denied`; the accepted identity remains selected for any permitted relationship
actions, including when both read grants are revoked. A denied friends response
clears all social history and selection.

### Activity

```js
{
  rows: [{
    id: 'opaque-unique-row-id', kind: 'album', // track | album | artist | listen
    title: 'Server title', artist: 'Server artist',
    listen_count: null, last_listened_at: null
  }],
  total_listens: null,
  period_label: 'Server period label',
  range_label: 'Server range label',
  next_cursor: null
}
```

### Activity page and Load more controls

Activity may additionally supply own `pagination` metadata:
`{mode:'numbered',page:1,page_size:100,total_rows:243}` with `next_cursor:null`.
These values describe the authorized query's rows, not its listen totals. Pages
contain exactly 100 rows except the last partial page; an empty history is page
1 with total_rows 0. Invalid, mixed cursor/numbered, out-of-range or mismatched
page responses are rejected. Page count is derived only from this explicit
authorized row count. Providers must never count unreadable records into it.

Without numbered metadata, an explicit next_cursor enables progressive Load
more. Only the current exact cursor is sent. Append retains distinct canonical
listen-event IDs, deduplicates exact overlapping row IDs, and rejects cursor
cycles or a nonempty page containing no new rows. A terminal empty page ends
loading without discarding the previously displayed authorized rows.

A valid overlapping row replaces its current public facts without moving its
existing position. Explicit, validly identified denials of held rows redact
their metadata and selected details even if the same response has invalid paging
metadata, an invalid/cyclic cursor or no new rows. Those responses still reject
navigation, preserve the previous order/cursor for retry, and admit no new rows.
Invalid or ambiguous row identities do not become revocation authority.

`activityNavigation` holds mode (`none`, `numbered`, `progressive`), status
(`idle`, `loading`, `error`), a frozen query `{account_ref,kind,period}`, committed
page/pageSize, totalPages/totalRows, loadedCount, hasMore, and requestedPage. Query
identity stays stable within one activity session and clears on retirement.
`loadActivityPage(page)`, `loadMoreActivity()` and `retryActivityNavigation()`
are explicit controller operations. A committed active read returns its resource;
invalid, inert, disposed and superseded navigation returns false. Legacy
`loadActivity` retains its existing resource-return contract.

Navigation loading/error keeps the last committed ready/empty resource visible;
first-load statuses still follow the normal null-data contract. Denial,
unavailability, permission revocation, friend/query/scope/provider changes and
disposal erase held pages/cursors and reject late completions. New React query
headings cannot display a previous query's ready rows before their loading effect.
Stale controls cannot page another actor/query or reset its scroll. Page commits
reset the current history viewport; progressive appends preserve its scroll.

### Comparison

```js
{
  rows: [{
    id: 'opaque-unique-row-id', kind: 'track', title: 'Server title', artist: 'Server artist',
    yours: { listen_count: 0, rating: null, last_listened_at: null },
    friend: null
  }],
  next_cursor: null
}
```

Each side may be null. Unknown numeric facts remain null; zero is a known zero.
Numeric strings, negatives and nonfinite values become null, not zero. Invalid
or missing timestamps become null. No client total, rating, personal preference,
or overlap score is inferred. `metric(value)` formats a finite nonnegative
number as a string and unknown values as an en dash (`–`).

## Mutation providers

`action` is one of these exact provider names. The target comes from the current
server projection, except for the explicitly entered new friend handle.

| Action | Arguments to `mutate` | Provider payload in addition to scope/signal | Required grant |
| --- | --- | --- | --- |
| `requestFriend` | handle | `{ handle }` | friends projection `can_request` |
| `acceptRequest` | request ref | `{ request_ref }` | incoming request `can_accept` |
| `declineRequest` | request ref | `{ request_ref }` | incoming request `can_decline` |
| `removeFriend` | account ref | `{ account_ref }` | accepted friend `can_remove` |
| `blockFriend` | account ref | `{ account_ref }` | accepted friend `can_block` |
| `saveProfile` | null, profile values | `{ profile: { display_name, handle, bio } }` | profile `can_edit` |

Profile values must supply all three strings. Extra properties are omitted.
No other action or relationship target is accepted. Each provider must return
an explicit `{ status: 'ready', data? }` or `{ ok: true }` acknowledgement. An
undefined return, empty response, false `ok`, or inconsistent status is an error.
`{ status: 'denied' }` and `{ status: 'unavailable' }` are explicit failures.

The write does not optimistically patch friends/profile from its response. A
successful acknowledgement clears selected history and reloads `readFriends`.
The write stays busy through that refresh; repeated mutation calls cannot issue
a duplicate write. The refresh's independent status remains visible even if a
server-acknowledged write succeeded. There is no automatic write retry.

A server-denied write clears the social projection and cancels an older friends
refresh so it cannot restore private data. A locally missing grant prevents the
provider call. A missing mutation provider reports unavailable and never claims
the relationship or profile changed.

## Verification boundary

`tests/js/runtime/home-friends-model.test.js` uses source-level DTO fixtures to
exercise normalization, nullable metrics, grants, malformed data, missing
providers, scope/provider changes, selection, revocation, delayed responses,
abort errors, mutation denial, duplicate suppression and authoritative refresh.
These focused checks do not validate a database, production social provider,
account migration, browser geometry, full-suite CI or manual acceptance. Those
remain separate integration/release gates.


## Integrated client additions

The production entry exports `window.AlbumHavenHomeUI.configureProviders(next)`
and `refresh()`. Configuring replaces the complete provider set and remounts its
session; it does not create a transport. Native account/library identity and
history-entry identity delimit sessions. Presentation history holds only tabs,
periods, display choices, selected opaque refs and scroll positions. Restored refs
are resolved against fresh current projections before actions.

Member discovery adds `readMembers({scopeKey, query, signal})` and
`requestMember({scopeKey, account_ref, signal})`. Discovery requires the current
friends projection's own `can_discover_members`; requests require the selected
current member's exact `can_request` and `relationship: 'none'`. Member results
contain `members` with unique opaque `account_ref`, supplied display name/handle,
safe avatar URL, relationship and exact actions. At most 100 are accepted. Search
accepts 1–100 characters with no control characters. Selection clears on new
query, refresh, scope/provider change and denial. Pending/accepted/blocked/self
members do not become request targets. Outgoing requests can be cancelled only
with their own `can_cancel` and configured `cancelRequest` writer.

Profiles include a safe avatar URL and separate `can_upload_avatar`. Save draft
limits are display name 1–50, handle 3–30 ASCII letters/digits/underscores, and bio
at most 240 characters. An optional `avatar_file` is a nonempty PNG/JPEG/WebP Blob
of at most 5 MiB with a filename. File upload requires both edit and upload grants;
it passes only to the configured `saveProfile`, never an invented endpoint.

Activity additionally preserves supplied album title, source attribution, safe
server artwork, duration, rating and independent detail refs/grants. Ratings are
bounded by the resource's documented scale. Comparison preserves two independent
sides and unknown values. Client filters/order affect only the current returned
page. No metric, overlap fact, relationship or listening event is inferred.

Album/Artist detail reads follow `home-detail-provider-contract.md`. Custom
readers require the source's independent own `can_view_details` grant. Only the
native Home owner can map current native local-album access to its own guarded
read-only album projection. That mapping is not granted to custom readers.

## Validation boundary

This is a newly reconstructed candidate. Historical checks on a lost checkout
are not evidence for it. Focused tests use populated DTO fixtures only inside
test files. Browser mounting/layout, live backend contracts, database behavior
and the complete CI suites are separate deferred checks.

## Native activity actions and track Love

`configureProviders` routes `readActivity` through the native runtime before it
reaches the React controller. Its optional `resolveActivityTrack` is a synchronous
native-only authority resolver, never a React media provider. It receives
`{scopeKey,account_ref,kind,period,rowId}` and returns null or the current canonical
native track with matching `row_id`, `actor_id`, `library_id`, private `track_ref`
and `path`, display facts, `track_preference` and exact
`playback_state.can_start_here`. It must derive that authority from authenticated
inventory and permission owners. Display titles, relationship, or an opaque row
ID alone cannot grant playback or editing. No default resolver is installed.

The native reader exposes only allowed display fields and a public preference
projection `{identity,love_tier,rating,allowed_actions:{can_set_love_tier}}`.
Its identity is an opaque per-scope key generated inside the native boundary;
private track refs and paths never enter React properties, state or row keys.
Actions resolve the current native authority again. Friend activity can display
supplied Love facts, but does not edit another account's preferences.

The existing `POST /track-preferences` route is the actual Love persistence seam.
Native code uses the existing CSRF-aware fetch owner with
`{track_ref,track_preference:{love_tier}}`, and validates the response's explicit
success, actor, library, canonical ref, tier and permission before painting an
acknowledgement. The route has no revision or operation-key protocol; none is
invented. One write per canonical track may be in flight across both surfaces.
There is no optimistic persistence, automatic retry or client persistence store.
Unknown Love is unavailable, never implicitly Off. The native action cycles
Off, Loved, Obsessed, then Off. Rating remains display-only in this slice.

Tracks and listen events use the shared native track/table owners. Explicit Play,
double-click and Ctrl/Cmd+Enter reach the existing player. Ordinary row selection
and Enter do not start playback; Love never changes the queue or current player.
Missing and denied rows cannot play. Source/query/scope/provider/permission
retirement invalidates deferred actions and acknowledgements. Progressive history
and numbered pages retain their established paging and view-sort ownership.

Home's native Recent/disabled News header uses separate period/date presentation.
Recent Albums always uses informative cards. A new phone session starts on Tracks
and desktop on Albums; a saved explicit user choice takes precedence. Implicit
viewport defaults are distinguished from explicit choices in native presentation
history. Unknown cover or card facts remain unknown rather than being generated.

## Readable account profiles and request entry

`selectedProfileRef` / `profile` are separate from accepted-friend selection and
the own editor's `friends.data.profile`. `selectProfile` resolves only a current
Friends, request or member row with explicit `can_view_profile`; request person
identity must be supplied as `account_ref`, never derived from a handle/name.
`loadProfile` uses optional `readProfile({scopeKey,account_ref,signal})`, validates
the exact returned account and explicit read grant, and discards denied or stale
facts. A missing reader remains unavailable; the UI may separately display an
already-authorized summary. A readable profile grants no private activity,
comparison, relationship action or catalog-resource access.

Native `home_profile` routing is distinct from accepted activity's `home_friend`;
conflicting targets are rejected. Direct/history refs are re-resolved from the
current source. Within one visible account/provider scope the controller survives
Home entry changes while presentation remounts by entry identity. Leaving Home,
scope change or provider replacement still disposes it. This preserves a current
member lookup through profile navigation without storing grants in history.

The content-sized native request dialog re-resolves its exact request/direction
and action grant, prevents a repeated acknowledged write, and closes only on the
required authoritative refreshed fact. Acknowledged mutation and failed Friends
refresh remain distinct; recovery repeats the read only. View profile closes the
native form/parent before its guarded route handoff. Unfriend remains a confirmed
directory action. Own profile/avatar editing retains its existing owner.

## Request notifications in the existing drawer

Incoming request cards reuse the actual global notification drawer and native
card/list owner. Cover-search actions and Clear completed keep their cover-only
scope. Requests use real supplied dates or undated order, never synthetic dates,
persisted client dismissal, a separate drawer or an invented notification API.
Loading/error/denied/unavailable source states remain distinct from known empty.

The account-scoped producer reuses visible Home's Friends projection. Outside
Home it permits one request-only instance of the existing controller on initial
configured registration and explicit drawer access; it never reads or retains
private activity/comparison. Home acquisition retires that fallback. There is no
polling. Provider/scope/source generations invalidate old records, forms and late
responses, including account/provider round trips.

Notification activation is only an entry: current request/person authority is
checked again. Native form acquisition and profile entry outside Home use bounded
scope/current-owner adapters and preserve ordinary Home-only navigation guards.
The native form owns inert drawer parent, stacking and connected focus return.
No page identifier is forwarded to request rendering, so phone requests remain
content-sized. Actual backend integration and painted browser behavior still
require the separately deferred checks.
