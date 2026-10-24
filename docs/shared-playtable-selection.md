# Shared track selection and Playlist destinations

The existing production React entry owns the common selection and destination
flow. MusicBrainz/source integrations supply authoritative identities and data;
they do not add another menu, selection store, player or Playlist writer.

## Interaction owners

- `music_app/static/js/playtables/selection.mjs`: the ordered, surface-local
  selection reducer and native event binding. Plain click selects one row;
  Ctrl/Cmd toggles rows. Context click preserves a selected set or selects its
  unselected target. A section action targets that section without changing the
  selected set. Single click does not play. Deliberate double click/touch double
  tap and the explicit Play control retain native playback ownership.
- `playtables/selection.jsx`: `usePlaytableSource`, `usePlaytableSelection`,
  `PlaytableSelectionActions` and `mountPlaytableSelection`. React owns committed
  lifetimes and controls; native tables retain their markup and playback paint.
- `runtime/album-track-table.js`: native Album/Loose Tracks table presentation,
  including a rightmost vertical section action for Loose Tracks. Opaque row
  keys must be supplied in multiple-selection mode; paths are not row keys.
- `runtime/playtable-source.js`: private native source binding and native
  Album/Loose Tracks adoption. Media/write refs never enter selection snapshots,
  action packets, React display DTOs or history.
- `playlists/selection-actions.jsx` and `.mjs`: one native destination form,
  existing Add command, and ordinary creation seeded from real source entries.

Home/Activity and saved Playlist tracks consume the same owner. Creation and
unsaved draft editors also use its highlight/context semantics. Their existing
checkbox sets continue to author the draft; highlight does not include/exclude
entries. Those editors have no new inferred media or Add authority. Add is
explicitly unavailable while it would recurse into an active creation form or
when an unsaved source has no supported Playlist write mapping.

## Source integration contract

`window.AlbumHavenPlaytableUI.mount(host, options)` exposes the existing React
mount to native tables. `options.sourceAdapter` supplies:

- `snapshot()`: `{scopeKey, instance, revision?, rows}` where rows contain only
  `{rowKey, sectionKey?, readable, selectable}`. `instance` is an in-memory source
  identity. Actor/library/provider/source replacement retires it; a same-source
  filter/order update changes the view while preserving surviving selected keys.
- `subscribe(listener)`: an unsubscribe callback. Dispose on actual source
  retirement, including denied access. Temporary native form hiding alone must
  not invent or revoke source authority.
- Private `resolveRows(rowKeys)`: `{rows, playlist_creation_source}`. Every row is
  resolved in the requested source order as `{rowKey, track_ref?,
  canonical_track_ref?, entry_ref?}`. No partial or guessed mapping is accepted.
- Optional private `retainNavigation(rowKeys)`: a one-use `{isCurrent, dispose}`
  receipt permitting the native created-Playlist navigation to retire its own UI
  while still checking the actual scope, source, mapping and provider authority.

The action packet is `{scopeKey, row_keys, origin:{tableKey,
target:'selection'|'section', sectionKey?}}`. The selection owner supplies a
separate lifetime with `signal`, `isCurrent`, `subscribeInvalidation` and
`dispose`. `window.AlbumHavenPlaytableUI.open(packet, lifetime, sourceAdapter,
anchor)` opens the same native picker. Only current packets are admitted.

MusicBrainz IDs, titles, indexes and DOM attributes are not app write identities.
`playlist_item_id` identifies a persisted Playlist occurrence; it must never be
fabricated for Loose Tracks. `entry_ref` identifies a real creation-source
occurrence. A native `track_ref` can be private and path-shaped, and belongs only
in the source resolver and authorized writer boundary.

All highlighted occurrences remain selected. Add deduplicates authoritative
canonical identities, or exact native write refs when no canonical mapping is
supplied, in current source order. Unknown occurrences with real `entry_ref`s
remain distinct. They can seed Create when bound to the exact authorized library
descriptor, even without local canonical/media identity. If any selected row
lacks an Add identity, Add is unavailable for the entire selection; no resolved
subset is silently written. Counts distinguish retained unresolved entries.

## Explicit provider integration

Install Playlist providers through `window.AlbumHavenPlaylistUI.configureProviders`.
The new optional `readPlaylistDestinations({scopeKey,signal})` returns a scoped
`ready`/`empty` resource containing `destinations`, exact `allowed_actions.can_create`
and a real `playlist_creation_source` descriptor. Each destination supplies its
real `playlist_id`, title, optional revision, exact `can_add` and optional
`can_open` grants. Denied/unavailable/error resources remain explicit.

Existing Add is reused unchanged:
`addTracks({scopeKey,playlist_id,track_refs,signal})`. The destination is freshly
read before one dispatch. A changed supplied revision requires reselection.
Acknowledged Add and subsequent destination-list refresh have separate status;
an uncertain result never retries automatically.

Create reuses `readPlaylistCreationSource` and the existing ordinary
`createPlaylistFromSelection` item-aware writer. Its library descriptor must
match the source resolver's descriptor. The complete current source is read,
real selected `entry_ref`s are seeded once, and exact operation-key/scope/revision
acknowledgement remains mandatory. It does not use metadata-only creation or
create-then-Add. Unknown/missing readable source entries remain in that selection.

The picker and seeded Create share one NativeForm. Native discard, focus and
history own dismissal. Source-derived navigation waits for native return and a
fresh destination `can_open` grant; its response still checks the retained source.

There is no guessed HTTP transport. The pinned application's reserved Playlist
mutation routes do not establish live Add/Create success. Real persistence needs
the authorized providers/backend integration. Ordinary visible Playlist readers
and the private history-replay reader retain their existing access boundaries.

## Verification boundary

Tests use contract fixtures only. Focused model, component and native DOM/hook
checks and supported bundle builds are recorded separately for the exact source.
They do not establish browser, real-provider, database, full CI, cross-platform
or manual acceptance. The repository/branch/remote commit for adoption must be
supplied after publication is independently verified.
