# Postgres Durable Jobs Operations

The durable-jobs worker is a separate process from the Album Haven web server. The shared ledger, transition history, and worker heartbeat live in Postgres; the web process must never be treated as the owner of accepted background work.

Full scans, filesystem-watcher targeted reconciliation, candidate cover lookup, bulk cover refresh, post-scan cover refresh, remote cover save, Last.fm retry delivery, and authentication-mail delivery run through this worker. A successful full-scan publication creates one server-owned `post_scan_cover_refresh` job keyed by the committed library inventory revision and the shared cover-refresh handler executes it. Welcome, invitation, and password-reset routes commit an outbox intent and its generic job atomically; the web process never owns SMTP delivery.

## Configuration

Set the worker connection independently from the application connection:

```powershell
$env:ALBUM_HAVEN_WORKER_DATABASE_URL = '<worker-role Postgres URL>'
```

The worker accepts these bounded integer settings:

| Variable | Default | Accepted range |
| --- | ---: | ---: |
| `ALBUM_HAVEN_WORKER_CONCURRENCY` | `1` | `1..8` |
| `ALBUM_HAVEN_WORKER_LEASE_SECONDS` | `300` | `1..86400` |
| `ALBUM_HAVEN_WORKER_HEARTBEAT_SECONDS` | `30` | `1..28800` |
| `ALBUM_HAVEN_WORKER_POLL_SECONDS` | `1` | `1..300` |
| `ALBUM_HAVEN_WORKER_MAX_IDLE_BACKOFF_SECONDS` | `5` | `1..300` |
| `ALBUM_HAVEN_WORKER_DRAIN_SECONDS` | `30` | `0..300` |

The heartbeat must be no greater than one third of the lease, and the initial poll interval must not exceed the maximum idle backoff. Startup rejects missing or invalid configuration without printing the database URL.

## Development launch and shutdown

Start the web process and worker in separate terminals so each has one visible owner:

```powershell
python start_https.py
```

```powershell
python scripts/run_jobs_worker.py
```

Send Ctrl+C once to the worker. It stops new claims, marks itself draining, requests cooperative cancellation for handlers that support it, and waits up to `ALBUM_HAVEN_WORKER_DRAIN_SECONDS`. A forced exit leaves lease-owned work recoverable according to its registered recovery policy. A running worker reconciles expired leases before claiming more work; do not delete or rewrite the ledger to make a job runnable.

Before stopping either process, record the exact PID tree. After shutdown, verify that every recorded PID exited:

```powershell
$workerPid = 12345 # Replace with the PID printed or recorded at launch.
function Get-OwnedProcessTree([uint32]$RootProcessId) {
  $snapshot = @(Get-CimInstance Win32_Process)
  $pending = [Collections.Generic.Queue[uint32]]::new()
  $owned = [Collections.Generic.HashSet[uint32]]::new()
  $pending.Enqueue($RootProcessId)
  while ($pending.Count -gt 0) {
    $processId = $pending.Dequeue()
    if (-not $owned.Add($processId)) { continue }
    foreach ($child in $snapshot | Where-Object ParentProcessId -eq $processId) {
      $pending.Enqueue([uint32]$child.ProcessId)
    }
  }
  $snapshot | Where-Object { $owned.Contains([uint32]$_.ProcessId) }
}
function Get-RemainingOwnedProcess($RecordedTree) {
  $current = @(Get-CimInstance Win32_Process)
  foreach ($recorded in $RecordedTree) {
    $current | Where-Object {
      $_.ProcessId -eq $recorded.ProcessId -and
      $_.CreationDate -eq $recorded.CreationDate
    }
  }
}
$workerTree = @(Get-OwnedProcessTree $workerPid)
# Send Ctrl+C and wait for the worker command to return, then:
$remaining = @(Get-RemainingOwnedProcess $workerTree)
$remaining | Select-Object ProcessId, ParentProcessId, Name, CreationDate
if ($remaining.Count -ne 0) { throw 'The recorded worker process tree did not exit.' }
```

Do not use blanket Python, Node, browser, or Git termination commands. If descendants remain, verify ownership from the recorded PID, parent PID, process name, and creation time before stopping only that exact owned tree. Inspect arguments only in a protected, non-captured administrator session when those identifiers are insufficient; never copy raw command lines into a terminal transcript, log, or ticket because later handlers may carry private paths or secrets.

## Windows service ownership

Configure the web server and durable-jobs worker as two services with different service names, process owners, logs, and restart policies. The worker service command is the environment's Python executable with `scripts/run_jobs_worker.py` as its argument and this repository as its working directory. Store `ALBUM_HAVEN_WORKER_DATABASE_URL` in the service's protected environment, not in the command line or repository. Python is not itself a Windows Service Control Manager host, so install it only through the deployment's approved service wrapper; do not point `New-Service` or `sc.exe create` directly at this script.

Use the deployed service name for exact lifecycle commands. In the same administrative PowerShell session, define both process helpers shown above, snapshot the service's owned tree before stopping, then verify those process identities exited before restart:

```powershell
$workerServiceName = 'AlbumHavenJobsWorker'
$workerService = Get-CimInstance Win32_Service -Filter "Name='$workerServiceName'"
if ($workerService.State -ne 'Running' -or $workerService.ProcessId -eq 0) {
  throw 'The worker service is not running.'
}
$workerTree = @(Get-OwnedProcessTree ([uint32]$workerService.ProcessId))
Stop-Service -Name $workerServiceName
$service = Get-Service -Name $workerServiceName
$service.WaitForStatus(
  [System.ServiceProcess.ServiceControllerStatus]::Stopped,
  [TimeSpan]::FromSeconds(60)
)
$remaining = @(Get-RemainingOwnedProcess $workerTree)
if ($remaining.Count -ne 0) { throw 'The recorded worker service tree did not exit.' }
Start-Service -Name $workerServiceName
$service = Get-Service -Name $workerServiceName
$service.WaitForStatus(
  [System.ServiceProcess.ServiceControllerStatus]::Running,
  [TimeSpan]::FromSeconds(60)
)
```

`AlbumHavenJobsWorker` is the recommended service name; use the deployed name consistently if an installation chooses another. A stopped service must have no owned process tree before it is started again.

## Health and authorized status

Public `GET /health` keeps web readiness independent from worker availability:

```json
{"status":"ok","worker_status":"worker_ready"}
```

`worker_ready` means the newest active heartbeat is at most 90 seconds old. `worker_degraded` means it is 91 through 300 seconds old or the worker is draining. `worker_unavailable` means there is no active heartbeat, the heartbeat is older than 300 seconds, or the status query failed. Worker failure does not change the web `status` value from `ok`.

Authenticated `/status` callers receive only the same coarse `worker_status` unless the server-side policy grants global `ops.jobs.status.read` (the Phase 8 bootstrap owner receives it). Authorized output contains only an opaque worker identity, lifecycle state, heartbeat age, bounded state counts, oldest queue age, and claim lag. It never contains job parameters, account or library identifiers, subject references, request origins, paths, tokens, addresses, or credentials.

## Scan jobs and recovery

`/refresh-api`, `/refresh`, cold-start scan acceptance, cancellation, `/status`, and bootstrap payloads retain their existing HTTP and response shapes. Acceptance commits a private scan intent and its generic job atomically. The generic ledger contains only stable intent identities and bounded orchestration metadata; roots, watcher paths, deleted subtrees, and move endpoints remain in the private `library` domain.

Only registered job kinds are claimable by a worker process. Full-scan and targeted-reconciliation handlers reload current roots and authorization scope after claiming, checkpoint progress with the active lease, and fence authoritative inventory publication with the same job ID, attempt, worker ID, lease token, and unexpired lease. A removed root, unhealthy watcher scope, revoked account or capability, cancellation request, or lost lease therefore prevents stale publication. Metadata reads remain bounded inside one claimed full-scan job rather than consuming additional durable worker slots.

Expired retry-safe scan leases are reconciled before new claims. Recovery repeats only work that did not commit its authoritative publication. A committed full scan and its revision-keyed cover follow-up are one transaction, so recovery can produce neither committed inventory without its follow-up nor duplicate follow-ups for the same library revision. Do not repair scan jobs by editing the ledger or private intent tables.

For a growing scan backlog, inspect only the authorized aggregate status. Confirm that the worker is ready, the relevant kind is registered, leases are advancing, and the current library/root authority is valid. A growing `post_scan_cover_refresh` backlog is not expected after migrations through `0076` and the matching worker artifact are active. Never copy subject references, generic parameters, scan-domain records, filesystem paths, or SQL parameter values into logs or tickets.

## Cover jobs and recovery

Candidate lookup acceptance commits the existing cover task and its generic job atomically. Bulk refresh uses its private progress record as orchestration authority; the server-owned post-scan kind enters the same claimed execution core without a second job. Generic jobs, transitions, health, and metrics contain only opaque task/resource identities and bounded counters or reason codes. Candidate payloads, provider responses, URLs, image bytes, and filesystem paths remain outside generic operational data.

After claim, the worker reloads current album/root scope and revalidates account, membership, capability, deployment/client, inventory revision, cancellation, and lease authority before provider or publication work. Provider deadlines begin at execution rather than enqueue, and bounded provider/transform concurrency remains internal to the claim. Lost authority or a stale lease prevents later candidate, progress, or cover-selection publication. Ordinary provider no-result/timeout behavior keeps its existing domain outcome instead of becoming an indiscriminate durable retry.

Remote saves checkpoint acceptance, download start, exactly owned artifact creation, Postgres selection commit, local promotion or rollback, and task publication. Retry only when durable checkpoints prove the prior attempt did not leave an uncertain external, filesystem, or selection write. Preserve `ambiguous` jobs and their private checkpoint evidence for operator reconciliation; never reset their state or trigger a replacement download by hand. Cleanup is allowed only for the exact artifact identity recorded for that task/job and only after resolving and verifying it remains under the currently authorized album root.

For a cover backlog, use authorized aggregate status to distinguish queued, running, retry-wait, failed, canceled, and ambiguous work. Confirm the matching handler is registered and the current album/root/inventory authority still exists. Cancellation is cooperative once claimed. During drain, let bounded provider work observe the cancellation/lease predicate and preserve checkpoints; do not terminate unrelated provider, browser, Python, or worker processes.

## Last.fm retry jobs and recovery

Playback performs the first scrobble attempt inline. Only a provider result known not to have sent is accepted for durable retry. The private pending-scrobble row owns the payload, listen identity, active-session reference, attempt count, and provider disposition; the generic job contains only opaque references and bounded orchestration metadata. Each accepted provider attempt has exactly one one-attempt job and a stable idempotency key.

The worker reloads current account, library membership, capability, request origin, and active Last.fm session authority after claim. It can read the session secret only through the lease-fenced claimed-job function and has no direct access to Last.fm tables. Revoked authority, replacement of the bound session, cancellation before send, or lease loss prevents the provider call. A successful reauthentication may release bounded held work onto the new active session; it never silently authorizes an old job against a replacement credential.

Known-not-sent failures schedule at most five domain attempts with exponential delay. Reauthentication-required and permanent rejection are terminal domain outcomes. A timeout, transport loss after dispatch, stale sending lease, or any other possible-send result becomes `ambiguous` and is never replayed automatically. Legacy due rows are adopted in bounded, skip-locked batches; malformed or unprovable legacy state remains held for repair instead of being guessed into execution.

For a Last.fm backlog, use only authorized aggregate job status and bounded reason codes. Confirm that `lastfm_scrobble_retry` is registered, the worker is ready, current membership and capability remain valid, and the account has an active session. Do not expose scrobble payloads, track metadata, usernames, session keys, provider responses, or raw pending rows in logs or tickets. Do not reset an ambiguous row or manufacture another attempt. During drain, already-dispatched provider calls retain their conservative outcome; unclaimed work remains durable for a later worker.

## Authentication mail and recovery

`app.mail_outbox` is authoritative for welcome, account-invitation, and password-reset delivery. Its stable ID is the generic job subject. Generic job rows and transitions contain no recipient, username, candidate address, bearer token or hash, link, message content, provider response, or SMTP setting. SMTP configuration is loaded only by the worker. Invitation and reset intents remain tokenless until a claimed worker revalidates current authority and lifecycle state; it then stores only a token hash and keeps the raw token and composed message in local memory for the provider call.

Welcome delivery alone permits automatic domain retries. A provider result proving no send occurred schedules attempts two through five after 60, 300, 1,800, and 7,200 seconds. Do not manufacture another job after exhaustion. A stale welcome that reached `send_started` is ambiguous rather than assumed unsent.

Invitation and password-reset work is non-replayable after token issuance. Provider timeout, connection loss after dispatch, lease loss, process loss, or stale reconciliation at or beyond `token_issued` becomes `unknown` in the outbox and `ambiguous` in the generic ledger. Preserve the token hash, job, outbox, and audit evidence. Revoke the affected token through the existing authorized lifecycle if required, but never reset the row or enqueue a replacement merely because delivery cannot be confirmed.

The bounded reconciler runs before normal claims. It converges terminal generic jobs with their outboxes and adopts eligible legacy bootstrap-welcome rows using skip-locked row ownership. It never reconstructs a raw token from a hash. Legacy invitation or reset state that cannot prove a safe unsent checkpoint remains terminal and non-replayable.

For an authentication-mail backlog, inspect only authorized aggregate status and bounded job kind, state, age, disposition, and reason labels. Confirm the three handlers are registered, the worker is ready, the mail category is enabled, the target lifecycle remains eligible, and the accepted actor still has the category capability. Do not include recipient details, token material, message text, SMTP values, provider responses, raw outbox rows, or request-origin keys in commands, logs, or tickets. Ordinary status readers receive no mail-category or target detail.

## Promotion

Use this additive order:

1. Back up Postgres and apply migrations through `0080_grant_worker_auth_mail.sql` with the migrator role.
2. Deploy the new worker artifact while the existing web artifact still owns its pre-cutover execution path.
3. Configure the dedicated worker-role URL and mail settings, start the worker, and confirm its closed registry and claim filter include every completed scan, cover, Last.fm, and authentication-mail kind.
4. Verify the worker fingerprint and role checks before deploying the compatible web artifact that enables durable producers. Drain any old request-owned mail tasks first. Exactly one execution owner may accept each workflow during cutover.
5. Verify `/health`, the authorized `/status` projection, unchanged scan and cover contracts, unchanged Last.fm summaries, unchanged administrator mail responses, the padded public forgot-password response, and synchronous invitation-link copying.
6. Keep prior web artifacts out of service after mail producers are cut over; they must not reclaim job-owned outboxes.

Do not insert jobs manually. A worker deliberately ignores kinds without registered handlers; deploy the corresponding handler before expecting that backlog to advance.

## Rollback

Stop new workflow cutovers, disable producer-enabled web code, signal the worker to stop claims, and allow the bounded drain to finish before deploying a previous compatible web artifact. Preserve `ops.jobs`, `ops.job_transitions`, `ops.worker_instances`, and all applied migrations. Job evidence is forward-only; rollback must not depend on destructive schema reversal or deletion of ambiguous work.

Keep the current claim-filtering worker artifact or keep the worker stopped. A previous worker is rollback-safe only if it retains the registered-kind claim filter; schema compatibility alone is insufficient because an older worker can claim and fail an unsupported `post_scan_cover_refresh` job. Do not start such an artifact while any unsupported kind can exist.

If the previous artifact is not compatible with the current schema, keep the worker stopped and restore service only with a compatible artifact. Never replay work by editing state, attempt, lease, tombstone, or idempotency columns manually.

## Retention cleanup

Retention is a maintenance operation and must use only the migrator connection:

```powershell
$env:ALBUM_HAVEN_MIGRATOR_DATABASE_URL = '<migrator-role Postgres URL>'
python scripts/cleanup_jobs.py --batch-size 1000
```

Each invocation processes at most the requested `1..10000` rows in each category. It removes eligible transition detail and compacts non-held succeeded, failed, or canceled jobs after 90 days; deletes those idempotency tombstones after 365 days; and removes stopped, unleased worker records after seven days. It never automatically removes queued, running, retry-wait, ambiguous, audit-held, or active-lease work. The command prints only category counts.

Generic mail-job cleanup follows those same 90-day transition/job and 365-day idempotency-tombstone windows. This command does not delete `app.mail_outbox`, authentication tokens, or security-audit evidence. Preserve every outbox and token record needed to explain an ambiguous delivery and retain security-audit evidence for its independently defined window. Any future domain-record deletion requires a separate bounded migrator-owned procedure and tests proving it cannot cascade into active or ambiguous evidence.

The application and worker roles do not receive retention deletion privileges. Do not substitute `ALBUM_HAVEN_APP_DATABASE_URL` or `ALBUM_HAVEN_WORKER_DATABASE_URL` for the migrator URL.

## Troubleshooting

- Configuration errors: confirm the required URL exists in the correct process environment and integer settings are in range. Do not paste a URL into logs or tickets.
- `worker_degraded`: check whether a planned drain is active, then inspect the exact worker process and its bounded logs.
- `worker_unavailable`: confirm the service state and exact process tree, then check Postgres reachability with an approved secret-safe probe. Web readiness may still be healthy.
- Growing retry or failure counts: use only the authorized aggregate status and opaque job IDs available through approved protected diagnostics. Do not query or publish raw parameters or subject references for diagnostics.
- Scan backlog: confirm the scan handlers are registered, current roots and watcher health are valid, and the account or server-owned scope remains authorized. Let expired-lease reconciliation recover uncommitted work; do not reset attempts or leases manually.
- Post-scan cover backlog: verify the deployed worker includes the shared bulk-cover handler and that the job's committed inventory revision remains current. Do not edit its revision or create a replacement row manually.
- Cover lookup or bulk backlog: verify current album/root authority, the actor capability for user-owned work, worker readiness, and provider configuration using secret-safe checks. Preserve provider order and deadlines; do not bypass them with manual ledger changes.
- Ambiguous remote save: stop automatic intervention, preserve the job and checkpoint evidence, and reconcile whether download, owned-artifact write, selection commit, promotion, rollback, and task publication completed. Remove only an exactly owned artifact after the authorized root containment check succeeds.
- Last.fm retry backlog: verify the handler registration, active session, account/library authority, and bounded attempt state. Reauthentication-held work is released only by a successful new session; possible-send ambiguity must remain held and must not be replayed.
- Authentication-mail backlog: verify all three handlers, category configuration, current actor/target eligibility, and aggregate due age. A tokenless accepted intent may be reconciled safely; a token-issued or send-started invitation/reset must remain non-replayable when its outcome is uncertain.
- Exhausted welcome: confirm five domain attempts and the documented delay sequence. Do not edit attempt counters or create an additional job.
- Ambiguous invitation or reset: preserve the outbox, job, transition, token-hash, and audit records; revoke the token through an authorized lifecycle action if needed, and do not resend automatically.
- Shutdown timeout: preserve the ledger and lease evidence. Diagnose the exact handler and owned child process; do not kill unrelated processes or force a state transition.
- Cleanup failure: verify the migrator connection and migration level. The command intentionally suppresses exception details; inspect protected service logs without copying credentials, URLs, paths, tokens, addresses, media, or private fixtures.
