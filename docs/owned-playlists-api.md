# Same-server Playlist API

This backend stores same-server Playlists, explicit editor grants and private/server_shared visibility in Postgres. Native adapters must be installed before the UI can use these contracts. It does not supply public links, source import/history capture, local matching, covers, playback or derived collections.

All endpoints authenticate the current browser session and current library membership. The repository rechecks live account/session/member/grant authority inside its transaction, including for bootstrap owners. No JSON account, owner or library parameter supplies authority. Existing grant assignments are unchanged. Responses are private/no-store. Each successful HTTP envelope has a top-level context_ref from the shared private_ui_context_ref owner, matching the trusted shell data-private-ui-context. It is a freshness check, never authorization.

## Reads

- GET /view-data?surface=playlists[&playlist_id=UUID]: currently readable directory or complete authored detail. Owners, explicitly granted editors and same-library readers of server_shared Playlists qualify, with independent current browse authority. Deleted/unreadable identities are unavailable; there is no process-global Playlist fallback.
- GET /playlists/destinations: readable destinations and exact can_add/can_open plus root can_create.
- GET /playlists/creation-source/current: start an ordinary current-library selection session. Requires browse and create. Returns source_protocol=library_selection_v1, source={kind:library,ref,revision}, grants, UTC expiry, page_size=100, max_selected_entries=5000, max_command_bytes=524288 and actor_scope.
- GET /playlists/creation-source/entries?source_ref=S&source_revision=R&q=Q&cursor=C&limit=L: bounded server search (1..100 rows, q at most 200 characters). Returns normalized query, fresh search_revision on a first page and the same revision through its cursor, limit, entries, has_more and next_cursor.
- GET /playlists/operations/UUID: committed receipt or unknown. Original-session equality is required even for another session of the same account. A hidden old key cannot be reused to create another Playlist.

Paged sources are explicitly distinct from complete-source providers. A page has entries_complete=false; it never claims to contain the library. Continuation tokens are random UUID references to immutable server-owned receipts under the authenticated source. They contain no browser-decodable inventory order facts; source/query/order/window/search-generation checks still run before every continuation. A page filtered to zero readable rows can still carry a continuation to later readable results. Search is live and server ordered: exact title match first, known parent Album first, chronological year null-last, stable Album identity, disc/track positions null-last and real inventory identity. An initial inventory ceiling prevents new insertions entering an open source. Metadata changes can move rows; clients deduplicate pages by selection_ref without modifying pinned selections.

Each row carries an immutable entry_ref receipt and source-scoped selection_ref. Reobserving changed facts issues a new receipt; old selected facts are not overwritten. Query changes do not clear selections. Explicit deselect/reselect selects the newer observation. Save sends every retained receipt in authored order; one stale, foreign, removed or duplicate identity rejects everything. Complete bounded source workflows retain their independent contracts and are not silently mapped to this protocol.

Inventory identity is explicitly inventory-track:LIBRARY_ID:TRACK_ID. It is not a canonical recording identity. No path/title alias is accepted for Add. Original safe metadata survives local inventory deletion; local linkage becomes null and availability unresolved. No absent/offline/unobserved file is automatically called missing. Source receipts expire after an internal 30-minute default. Saved rows and durable operation keys do not expire with them. Source receipt cleanup is a separate operational task.

## Writes

Every new Playlist write and creation-source begin requires X-AlbumHaven-Context matching the current shared server-derived context_ref before a transaction starts. Missing/mismatched context returns 409 stale_context with zero mutation. Every write also uses the existing session-CSRF header and a UUID request_key. Existing collections also require the exact positive-decimal string revision. Requests above 512 KiB or 5,000 refs fail clearly; there is no truncation or partial success.

- POST /playlists: {source_protocol:library_selection_v1,mode:ordinary,source:{kind:library,ref,revision},title,description?,entry_refs,request_key}. Browse+create; empty ordinary selection allowed. Atomically writes metadata, every selected receipt in order and operation receipt.
- PATCH /playlists/P: {title?,description?,item_order?,revision,request_key}; at least one edit field. Browse+manage. A changed submitted order additionally needs items.manage. Any submitted order must be the complete current permutation even when unchanged.
- POST /playlists/P/items: {track_refs,revision,request_key}. Browse+items.manage. Every supplied scoped inventory ref must resolve to an authorized active local row; mixed unrepresentable input and duplicates reject wholly.
- POST /playlists/P/items/reorder: {item_order,revision,request_key}. Browse+items.manage. Use this route for pure reorder without metadata; IDs remain stable.
- POST /playlists/P/items/remove: {item_refs,revision,request_key}. Browse+items.manage; every item must belong to the collection. Compacts order atomically.
- DELETE /playlists/P/items/I: {revision,request_key}; the same item-removal transaction.

The owner is immutable. Editor grants supply collection-specific eligibility; current manage/items capabilities remain independently necessary. A same-library reader of a server_shared Playlist has no editing eligibility without an explicit editor grant. Administrators and bootstrap accounts never bypass these collection predicates.

- GET /playlists/P/access-grants: actual owner plus browse/access.manage only. Returns playlist_id, revision, visibility, actor_scope and grants:[{grant_ref,account_ref,account_id,display_name,username_display,is_active,role:editor}]. Inactive current-library grantees remain visible for owner revocation, with is_active:false. Removed membership cascades its grant. Contact details and other account records are not returned.
- GET /playlists/P/access-candidates?q=Q&cursor=C&limit=L: same owner plus browse/access.manage gate. Direct response: {playlist_id,revision,candidates:[{account_ref,account_id,display_name,username_display,grant_ref,role,allowed_actions:{can_grant_editor}}],next_cursor,actor_scope,context_ref}. Lists active current-library accounts except the owner, independently of Social permissions/friendship. Existing editors have grant_ref and role:editor and can_grant_editor:false; other candidates have null grant_ref/role and can_grant_editor:true. Search matches literal display-name or username text, case-insensitively; q is at most 100 characters, limit defaults to 50 and is bounded 1..100. Only q,cursor,limit are accepted, each once. Encrypted continuations bind to authenticated account/session/library, Playlist and exact query, and expose no numeric boundary. Each page revalidates live owner/access/session authority and current recipient eligibility; it is not a frozen account snapshot. Numeric account_id remains private transport data for the existing grant-write contract; React identity uses stable account_ref. The existing all-account social_profiles UUID mapping is used without creating or requiring Social access.
- PATCH /playlists/P/visibility: {visibility:private|server_shared,revision,request_key}. Actual owner plus browse/access.manage. Same value is an unchanged-revision no-op.
- POST /playlists/P/access-grants: {account_id:positive_integer,role:editor,revision,request_key}. Actual owner plus browse/access.manage. Recipient must be another active current-library member. Duplicate existing editor returns its original grant_ref with changed:false. Removing a library member cascades their editor grant; rejoining does not restore it.
- DELETE /playlists/P/access-grants/G: {revision,request_key}. Same owner/access policy; exact current grant only. Unknown or foreign grants are unavailable. No owner transfer or viewer-role grant is introduced; PATCH-grant remains reserved.
- DELETE /playlists/P: {revision,request_key}. Actual owner plus browse/manage. Atomically marks deleted_at and increments revision. Normal directory/detail/destination/access reads and all new writes then exclude the Playlist. Metadata, items, grants and operation keys are retained, with no automatic purge or irreversible physical deletion. No restore UI/API is introduced by this slice.

Sharing never supplies playback or raw-file permission. Current per-track browse constraints are applied before observing source receipts and before selected Create/Add. Detail may retain the Playlist's readable saved original metadata while withholding a currently forbidden inventory link and reporting unresolved availability. No hidden track facts or private paths enter a source response.

Create returns {status:ready,data:RECEIPT}; other mutations return RECEIPT. A receipt is {ok:true,action,request_key,playlist_id,revision,changed,actor_scope,added_count?,removed_count?}. actor_scope contains only authenticated account/library IDs; the shared opaque context_ref is the browser session-freshness anchor; it never becomes request authority or React presentation data. The native adapter adds its current lifecycle scopeKey only after validating the server receipt. Client abort does not undo a committed transaction.

Same actor/library/key plus the same semantic command and original session returns the original receipt after current read authorization. The original owner can reconcile retained receipts after a soft delete; other actors cannot read deleted collections or their receipts. Different data/action/target conflicts. Keys remain durable after draft expiry or session deletion. A failed connection after commit is ambiguous; reconcile the operation rather than creating another key automatically. SQL constraint/serialization/deadlock failures roll back before a structured error; the service does not automatically retry mutations.

Errors are bounded codes (forbidden, playlist_unavailable, source_unavailable, source_expired, source_changed, invalid_command, invalid_cursor, invalid_item_order, item_unavailable, duplicate_identity, revision_conflict, idempotency_key_reused, concurrent_change, command_too_large, stale_context, private_ui_context_unavailable). No private SQL/path/provider diagnostics are returned. Existing unimplemented cover/settings/derived/matching/PATCH-access-grant methods keep their reserved response. Additional lifecycle errors are grant_target_unavailable, grant_unavailable and invalid_editor. Invalid recipient-directory parameters return invalid_access_query; invalid or cross-scope continuations return invalid_cursor.

## Verification boundaries

Migration 0089 follows the separately owned 0088 history receipt migration. Migration 0091 extends the foundation with collaboration and retained deletion; 0090 belongs to Friends. New private grant tables deny readonly/public access and give the app only select/insert/delete. Writers use the account-administration lock order, live session checks, READ COMMITTED and a locked Playlist parent before evaluating current editor eligibility; directory readers take parent share locks and refresh editor grants after waits. Real PostgreSQL migration/constraint/locking/race checks, composed native adapters, browser acceptance and complete CI remain required. Pure command tests and connection doubles do not prove transaction isolation, real constraints or browser behavior. This document describes the implemented contract, not a passed deployment or verification result.

## Account-owned Playlist order preference

GET /account/playlist-preferences returns preferences:{remember_order_mode,last_order_mode,effective_order_mode,revision}. Defaults are remember_order_mode:true and last_order_mode:regular, revision:"1". When memory is disabled, effective_order_mode is regular while the last remembered choice remains retained. These values apply to Playlists only and never supply a playback authorization or a Repeat mode.

PUT /account/playlist-preferences accepts {remember_order_mode?,last_order_mode?,revision,request_key}, with at least one setting. Booleans are exact and last_order_mode is regular|shuffle only. The account comes from authentication, never the payload. The route requires current browser context freshness and CSRF, limits JSON to 4 KiB, and uses account.self.playlist_preferences.write. It does not require or grant collection settings/manage capabilities. Active account and current session are revalidated under the shared account/session locks. Actual changes increment the account preference revision; no-ops retain it.

A last_order_mode write while remembering is disabled returns order_memory_disabled. The player may still use session-only Shuffle; it must not persist that choice. A single command may enable remembering and choose the remembered mode. Repeat One/All, suggestions, album preferences and collection content are outside this setting.

Same account/key/semantic command/original session reconciles to the original receipt. A different session cannot reuse a retained key; changed command data conflicts. GET /account/playlist-preferences/operations/K returns committed/unknown under current account-self read authority and original-session equality. Preference operations are independent of Playlist collection revisions and soft deletion. Migration0092 owns this account preference state and its private, non-purgeable-by-app operation receipts.

## Saved metric-header sort

POST /playlists/P/default-sort accepts {sort:{key,direction}|null,revision,request_key}. The exact keys are love_tier, play_count, popularity_count and duration; direction is asc|desc. There are no aliases. Null explicitly clears the saved choice. The action requires current browse plus library.playlists.settings.manage and actual owner or explicit editor eligibility; server_shared read access is insufficient.

The command uses the same collection revision and durable operation receipt rules as metadata edits. It returns saved_default_sort with changed/revision. Same-value saves are no-ops. Detail reads return saved_default_sort separately from active_sort. Saved choices never mutate authored item positions; these server track_rows remain in authored order, with active_sort={key:playlist_position,direction:asc}. The client applies the saved metric-header choice as its view sort using current supplied metric facts; unknown values remain unknown. Native playback uses the displayed eligible-item order after that view sort. No missing metrics, playback rights or suggestion continuations are manufactured by persisting a choice.

## Viewer requests and private copies

Migration 0100 adds durable Playlist edit requests. It does not add role presets,
Social grants or playback authority. A current authenticated reader can open
Share; `can_share` remains owner access-management authority, while
`can_view_sharing`, `can_request_edit` and `can_copy` are separate projections.

- GET /playlists/P/sharing[?cursor=C] returns the current revision, visibility,
  can_manage/can_request_edit/can_copy, the caller's request_status and
  pending_requests. Only the owner with access.manage receives requester names.
  Owner request pages contain at most 100 rows and next_pending_cursor.
- GET /playlists/edit-requests[?cursor=C&limit=L] supplies normal Notifications
  with owner-addressed pending requests across Playlists. Pages default to 50,
  maximum 100; encrypted cursors bind to account, session and current library.
  Rows include request_ref, playlist_id, title, account_ref, public display names
  and created_at. Removed, disabled, revoked and no-longer-readable requests do
  not appear. Notification opening navigates to the exact Playlist Share dialog.
- POST /playlists/P/edit-requests accepts {revision,request_key}. Only a current
  non-owner reader without an Editor grant may request. It creates at most one
  pending request per reader/Playlist and never grants rights or changes the
  Playlist revision. The receipt includes request_ref, request_status and
  request_created; changed remains false because Playlist content/ACL is unchanged.
- POST /playlists/P/edit-requests/R/decision accepts
  {revision,request_key,decision:approve|decline}. Only the actual owner with
  access.manage may decide a current pending request. Approval uses the existing
  Editor grant operation; declining does not grant rights. Decisions increment
  the Playlist revision and resolve the request atomically with their receipt.
- POST /playlists/P/copy accepts {revision,request_key,title?}. Current source
  read and independent create authority are both required. At most 5,000 ordered
  occurrences become a fresh actor-owned private Playlist with new item IDs.
  Source metadata/order and same-library track links are retained; source ACL,
  personal taste/listening state and private activity lineage are not copied.
  Only source Playlist/item/revision lineage is retained. Unknown availability
  stays unknown and grants no playback. The original remains unchanged.

Copy receipts use playlist_id for the new destination and source_playlist_id /
source_revision for the source. Exact-key reconciliation returns that same copy,
including after subsequent source access revocation; it cannot create another
copy. The destination's current read and original-session checks still apply.
Other actions retain the existing actor/library/key digest and replay rules.

Requests retain the exact browse-authority grant IDs present at creation.
Revocation, deletion or scope/key changes to those grants, account disable,
membership removal, source deletion or making the source private retires an old
pending request. Restoring access does not revive it. A new request uses a new
request identity. Owner notification reads do not acquire requester locks after
Playlist locks; decisions lock the requester account in the existing ordered
account-lock transaction before evaluating it.

The UI reuses the native Share form and notification drawer. The owner chooses
Editor and applies explicitly; opening or reading a notification changes no
access. Notification read paint is scoped to the active client lifecycle and is
independent of pending-request persistence.

### Retained Queue selections

`POST /playlists/creation-source/queue` accepts exactly `occurrences`, an ordered
array of 1–5000 source occurrences. Each occurrence has an inventory `track_ref`
and one of these exact shapes:

- Inventory: `{kind: "inventory", track_ref}`.
- Activity: `{kind: "activity", track_ref, origin, row_ref}`. `origin` is the
  existing exact Activity audience, subject, kind, period and snapshot receipt;
  the row must belong to that receipt and resolve to the supplied track.
- Playlist: `{kind: "playlist", track_ref, playlist_ref, revision, item_ref}`.
  The current readable Playlist revision and item must resolve to the track.

The response uses the existing `complete_inventory_selection_v1` library source
envelope, with first-occurrence canonical order. Repeated tracks produce one
entry but retain every contributing source occurrence privately. No private
lineage, media path or playback grant is exposed. Readable missing inventory
remains selectable. Capture requires Browse; final Create and Add independently
require their existing mutation grants.

Queue Add commands include `source_guard: {source_protocol, source, entry_refs}`
alongside their ordinary `track_refs`, destination revision and request key.
The guard is part of the original command digest. Its selected entries must
match the ordered track identities exactly. An ordinary inventory receipt
cannot be substituted as a Queue guard. Create uses the existing source tuple.
Both commands revalidate all retained selected occurrences, current inventory,
actor/session, source expiry and source read authority inside the mutation
transaction. Source and destination Playlist locks are ordered together, and
all friend subjects are locked with the actor before current policy is loaded.
An unchanged, committed request-key retry returns its existing receipt; changing
or dropping the guard with that key is a conflict. Source revocation prevents a
new write, without retroactively undoing an already committed operation.
