# Last.fm Scrobble Status And Submit Design

## Outcome

Extend the connected Last.fm section with three explicit counters and a manual recovery action:

- `Scrobbled`: scrobbles that Album Haven submitted and Last.fm accepted for the authenticated account and current library.
- `LastFM Total`: the connected account's lifetime playcount returned by Last.fm `user.getInfo`.
- `Pending`: retryable Album Haven scrobbles awaiting provider acceptance.
- `Submit`: an explicit attempt to send the current scoped pending set.

This delivery supports the current migration-era Last.fm bridge. It advances the behavior described by `AH-W02-022` and `AH-W02-023`, but it does not complete either roadmap item or replace the retry thread with durable jobs.

## Approved Scope

- Capability: new `integration.lastfm.scrobbles.submit` action.
- Resource scope: authenticated user's own connected Last.fm account and current authorized library. The client cannot select either identifier.
- Deployment: self-hosted and hosted Web required; Tauri optional; Android, TV, and Apple unsupported in this delivery.
- Manual retry: bypass elapsed-time backoff for retryable pending entries. Never resend accepted, attempting, sent, uncertain, permanently rejected, or exhausted entries. Reauthentication-required entries remain blocked.
- Mockup: the owner explicitly waived the mockup gate for this small extension. The implementation must use the existing Last.fm section, Button component, layout tokens, and regular bottom-right alert.
- Approval flow: the owner approved implementation without further approval pauses for this delivery.

## Architecture

### Status read

Add `GET /utilities/integrations/lastfm/scrobbles` under the existing integration-read authority. It derives the request's account and library scope, reads the existing scoped local counts, and requests `user.getInfo` through the backend Last.fm adapter.

Response:

```json
{
  "ok": true,
  "scrobbled": 34,
  "pending": 0,
  "lastfm_total": 12000,
  "can_submit": true
}
```

`lastfm_total` is `null` when the provider read fails or returns malformed data. That failure does not fail the endpoint, block the Integrations section, or create a user alert. The browser renders `LastFM Total: Unavailable`. No process-global or database cache is added.

### Manual submission

Add `POST /utilities/integrations/lastfm/scrobbles/submit` under `integration.lastfm.scrobbles.submit`. The route:

1. derives the authenticated account and current library;
2. verifies Last.fm is enabled and the scoped account is connected;
3. loads only canonical retryable pending rows in that scope;
4. bypasses elapsed-time backoff without bypassing reauthentication, exhausted, permanent, uncertain, or accepted guards;
5. submits through the existing signed Last.fm adapter and transition service;
6. recomputes scoped local counts and reads the remote total on a best-effort basis;
7. returns success only when no attempt failed and no retryable pending rows remain.

The existing automatic 30-minute retry worker remains unchanged apart from sharing the corrected scoped counting and retry options.

### Count integrity

Use one canonical pending predicate for the UI count, worker selection, and manual action. It excludes exhausted rows and submission states `attempting`, `sent`, `uncertain`, and `accepted`. The retry summary counts a failed transition even when the provider attempt did not start, preventing an unsendable item from producing a false success.

## UI Behavior

The connected Last.fm detail renders three separate lines:

```text
Scrobbled: 34
LastFM Total: 12000
Pending: 0
```

While the provider total loads, the second line reads `LastFM Total: Loading...`. A failed provider read changes it to `LastFM Total: Unavailable`.

The shared `Submit` Button sits at the section's bottom-right. It is absent while disconnected, disabled when `Pending` is zero, and disabled with `Submitting...` while the request runs. A successful request refreshes all three values and shows a brief success notification.

A failed or partial submission uses the shared regular Error alert in the global bottom-right alert host. It does not render an inline error inside the Last.fm section. Pending rows remain actionable when their retry contract permits another attempt.

## Error And Log Contract

Submission failures return a provider-safe message plus `attempted`, `succeeded`, `failed`, `pending_before`, and `pending_after`. The route writes one scoped `Last.fm pending scrobble submission failed` Log History event for partial failure, complete failure, disabled provider, disconnected race, or unexpected exception.

The event may include the safe failure category and aggregate counts. It must not contain credentials, session keys, API signatures, provider XML or response bodies, local paths, or media metadata. Numeric log normalization must retain the aggregate counters.

## Functional And Automated Coverage

Update `FTC-PLAYBACK-LASTFM-013` to verify that a connected account shows all three values, `Pending` starts at zero, and an accepted production-path scrobble increments both Album Haven's accepted count and the fake provider's lifetime total.

Add `FTC-PLAYBACK-LASTFM-017`:

1. Configure the existing loopback Last.fm provider to return retryable error code 11 for `track.scrobble`.
2. Complete playback through the production browser, FastAPI, Postgres, signing, and listen-history paths.
3. Verify `Pending: 1`, unchanged `Scrobbled`, unchanged `LastFM Total`, and an enabled Submit button.
4. Click Submit and verify the bottom-right Error alert, retained pending count, and one safe persisted Logs entry with aggregate counts.
5. Switch only the external provider stub to acceptance and click Submit again immediately.
6. Verify the explicit action bypasses time backoff, pending becomes zero, both counts increment once, and the provider records exactly one accepted retry.

The E2E fixture may add loopback-only provider controls and `user.getInfo`; production code cannot observe fixture controls. Tests must not call a real Last.fm account, intercept Album Haven's browser requests, seed pending product rows directly, or add application test-only routes.

## Compatibility And Rollback

The change adds no schema or dependency. Existing connection, disconnection, timezone, playback, direct scrobble, and automatic retry behavior remain compatible. Rolling back the application removes the endpoints and UI without data conversion. Pending rows and their retry evidence remain in Postgres.

## Delivery Checkpoint

This is one cohesive delivery: backend contract, capability registry, live UI, unit/integration tests, functional-case records, fake-provider behavior, and focused Playwright acceptance. Merge and publication require focused verification, the repository review flow, the complete review-first CI pipeline, and owner manual acceptance. The roadmap items remain unchecked because durable jobs, broader sync review, and import prerequisites remain future work.
