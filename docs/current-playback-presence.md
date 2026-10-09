# Current playback presence

Presence is an authenticated, short-lived Postgres read model. It is separate
from completed listens, scrobbling and playback control. A presence write never
adds listen credit or commands another player.

## Publisher

The native player's current local owner uses a UUID for its ownership lifetime
and one strictly increasing safe integer sequence across both endpoints.

- `POST /playback/session/presence-source`: `track_ref`, `player_ref`, `sequence`.
  The current account, session, library and media policy resolve the native
  path-free `inventory-track:<library>:<track>` reference. Raw paths and other
  aliases are rejected. The response contains an opaque `presence_ref` and `expires_at`.
  Acquisition does not assert that playback is active.
- `POST /playback/session/presence`: `presence_ref`, `sequence`, `state`.
  State is `playing`, `paused` or `stopped`. Only the acquiring authenticated
  session can use the token. New source acquisition retires the previous token.

Both endpoints use the standard session CSRF/origin checks and
`x-albumhaven-context`. Responses have `status`, `data` and `context_ref`.
The server keeps one bounded slot per account/library. Another player/session
cannot acquire a still-owned lease. Presence conflicts must never stop audio.

A playing lease lasts 15 seconds. The client renews every 5 seconds only while
it owns playback and actual playback is active. Playing refreshes closer than
2 seconds are rejected with 429; pause and stop are never delayed by that limit.
Stale sequences fail with 409. Every expired or invalidated token update fails with 410 and requires
fresh acquisition. Unknown playback state must stop renewal and clear the UI.

## Reader

`GET /home/activity/now-playing` reads the actor; optional `subject_ref` selects
an accepted friend by public account reference. Every read rechecks the current
viewer, library membership, friendship, both Social grants, subject session,
source authority and applicable resource history policy. Pause, stop, expiry,
logout and revocation produce no live data (or an authorization denial).
Authority and catalog eligibility transitions durably invalidate the current
token. Restoring the same grants, account or relationship cannot revive an old
observation: fresh acquisition and a new playing update are required.

A ready response has `data: null` or a payload containing `subject_ref`,
`occurrence_ref`, `observed_at`, `expires_at`, `state: playing` and a safe track
`row`. No raw native path, publisher token or history-derived playback guess is
returned. The live row grants no native action or playlist selection: its
occurrence is not a retained activity receipt. Completed-history totals are
unchanged. Clients discard the row at expiry even if the next read fails.

## Subject taste and canonical selection

Ordinary activity rows project explicit subject track ratings/loves and album
ratings. Friend data is read-only. Unknown/denied values are null and never use
actor preferences. Album favorites currently have no durable authoritative
source in this slice and remain null.

Activity album/artist targets retain the row receipt in `ref` and add an opaque
`identity_ref`, comparable only within that snapshot. Details requests may add
`target_kind: album|artist`; playback requests may not. Parents are resolved by
canonical IDs, never names. Album details include a read-only `subject_taste`
overlay keyed by `inventory_track_ref`. Missing overlay entries stay neutral;
`complete: false` reports the 1,000-track projection bound. Apply the overlay to
an isolated detail copy and never write it into the actor's native cache.
