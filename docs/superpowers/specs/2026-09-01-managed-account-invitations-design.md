# Managed Account Invitations Design

Date: 2026-09-01

Status: approved

## Goal

Replace administrator-assigned passwords and password-free welcome messages for
new managed users with a purpose-built invitation lifecycle. An administrator
creates a pending account, optionally sends its invitation through configured
SMTP, or copies a newly rotated invitation URL from the user's three-dot menu.
The recipient follows the one-time link and chooses their own password before
the account can sign in.

The flow must remain fully testable without an external SMTP provider. Browser
tests use either the copied invitation link or Album Haven's local SMTP capture
server, never an operator's real SMTP credentials.

## Decisions

- Managed account creation is invitation-only. The administrator never chooses
  or sees the recipient's password.
- Invitation tokens have a dedicated persistence and service boundary rather
  than reusing password-reset tokens or stateless signed links.
- Every copy or send action creates a new invitation and revokes the previous
  unconsumed invitation for that account.
- A pending account is an enabled managed account without an account credential.
  Existing `is_active` and disabled metadata retain their administrative meaning.
- Invitation acceptance creates the first credential. It does not automatically
  create an authenticated session; the recipient signs in normally afterward.
- Real SMTP configuration is never consumed by E2E. The Phase 7 harness owns and
  injects its loopback SMTP host and port into each test application process.

## Alternatives Considered

### Reuse password-reset tokens

Rejected. Invitation and reset links have different eligibility rules, account
states, audit meanings, and completion transitions. Sharing their persistence
would make purpose confusion and future lifecycle changes easier to introduce.

### Stateless signed invitation links

Rejected. Stateless links make immediate rotation, disablement, one-time
consumption, and concurrent replay protection harder to reason about. Album
Haven already uses Postgres as the durable authority for authentication state.

### Dedicated invitation lifecycle

Selected. A dedicated table and service make expiry, rotation, consumption,
mail linkage, authorization, and audit behavior explicit and transactionally
enforceable.

## Account State Model

`app.account_credentials` remains optional for a managed account:

- enabled plus no credential: `Pending invitation`
- enabled plus credential: `Enabled`
- `is_active = false` or `disabled_at` set: `Disabled`, regardless of credential

Account creation writes the account, current-library membership, capability
grants, and audit event in one short transaction. When email delivery is
selected, that same transaction also writes the initial invitation and linked
outbox row. Without email delivery, no unreachable token is created; the first
copy action issues the account's invitation. Account creation never writes
`app.account_credentials`.

Login continues to use a generic failure for accounts without exactly one
credential. A pending account therefore cannot authenticate, and its presence
is not disclosed through the public login response.

Disabling an invited account revokes its active invitation in the same
transaction. Re-enabling does not silently issue an invitation; the
administrator explicitly copies or sends a new link. An account that already
has a credential follows the existing disable/re-enable behavior.

## Persistence

Add `app.account_invitation_tokens` with:

- identity primary key
- indexed `account_id` foreign key with `on delete cascade`
- 32-byte SHA-256 `token_hash`
- fixed purpose `account_invitation`
- `created_at` and `expires_at` as `timestamptz`
- nullable `consumed_at` and `revoked_at`
- `request_ref` for correlation without secret material

Constraints require a 32-byte hash and expiry after creation. A unique index on
purpose plus hash prevents collisions. A partial unique index permits at most
one unconsumed, unrevoked invitation per account.

The runtime database role receives only the select/insert/update privileges and
sequence access needed by the lifecycle. The read-only role receives no access.
The foreign key is indexed explicitly.

`app.mail_outbox` gains a nullable invitation-token reference and an
`account_invitation` message category. An invitation message is always linked
to the exact committed token it delivers. Outbox rows retain no message body,
raw token, or complete URL.

The raw token contains at least 256 random bits. Postgres stores only its
SHA-256 digest. Token lifetime is configuration-backed with a secure default;
the initial implementation uses 72 hours so an emailed link remains practical
across weekends without becoming long-lived access authority.

## Issuance And Rotation

One invitation service owns creation, copy, and email issuance:

1. Authorize the bootstrap owner for the current library and require recent
   authentication for post-creation rotation actions.
2. Lock the target account, then its invitation rows, following the existing
   Phase 7 lock order.
3. Reject bootstrap owners, disabled accounts, accounts outside the current
   library, and accounts that already have a credential.
4. Revoke every prior unconsumed invitation for the account.
5. Generate a new raw token, persist only its digest, and optionally enqueue an
   invitation mail row.
6. Commit before returning the raw token to the caller or starting delivery.
7. Audit only actor, target, outcome, reason, and request reference.

Account creation may issue and email the initial invitation without a separate
recent-auth prompt because the already-authorized create operation is one
atomic workflow. Copy and resend from the roster are sensitive mutations and
reuse the existing administrator reauthentication mechanism.

The copy endpoint returns the complete configured-public-base invitation URL
only in its successful JSON response. It uses `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. The URL, raw token, and token hash must not enter
application logs, audit metadata, DOM bootstrap payloads, or exception text.

## Invitation Acceptance

The email and copied URL use the same path, token format, and completion flow:

1. `GET /accept-invitation?token=...&purpose=account-invitation` validates the
   token without consuming it.
2. The server creates a short-lived, purpose-bound, `HttpOnly` invitation
   transaction and redirects immediately to token-free
   `/accept-invitation`.
3. The acceptance page collects and confirms a new password using the existing
   Phase 7 password policy, breach checks, Argon2id configuration, one-time
   CSRF, and same-origin enforcement.
4. Password hashing happens before the database transaction.
5. One transaction locks the account and invitation, revalidates eligibility,
   inserts the first credential, consumes the invitation, revokes any remaining
   invitations and reset tokens, and appends the audit event.
6. The completion page directs the recipient to normal sign-in. No lifecycle
   transaction becomes an authenticated session.

Malformed, wrong-purpose, expired, revoked, consumed, concurrently consumed,
already-accepted, and disabled-account links render the same safe invalid-link
result. Successful acceptance and all failure pages are token-free and use
`Cache-Control: no-store` plus `Referrer-Policy: no-referrer`.

## Administration UI

The Add user page removes the password field. Its copy explains that the user
will choose a password from an invitation. `Send invitation email` remains an
optional checkbox, enabled by default when invitation delivery is configured.
Successful creation reports that the account is pending rather than able to
sign in immediately.

The roster replaces the single Edit action with an accessible three-dot button
per user. The menu contains:

- `Copy invite link` for pending, enabled managed accounts
- `Send invitation email` for pending, enabled managed accounts when mail is
  configured
- `Edit` for manageable accounts

Copy invokes rotation, writes the returned URL through the Clipboard API, and
announces success through an ARIA live status. A clipboard failure leaves the
new link visible in a focused read-only field with a manual Copy control so the
administrator does not lose the just-issued secret. The menu closes on Escape,
outside click, action, and focus departure and maintains appropriate expanded
state and keyboard focus.

The roster status column shows `Pending invitation`, `Enabled`, or `Disabled`.
Invitation delivery status replaces the old welcome-email wording. Existing
accepted users do not receive invitation actions; password reset remains their
credential-recovery action on the edit page.

## Mail Delivery

Invitation mail replaces welcome mail for managed account creation. It contains
the username, expiration guidance, and configured-public-base acceptance URL,
but no password. The same provider-neutral SMTP delivery path, TLS policy,
outbox claim behavior, retry rules, and secret redaction continue to apply.

Delivery failure never activates the account and never exposes the link in
logs. An administrator can recover by copying or sending a new invitation,
which deliberately invalidates the failed message's older link.

Existing accounts and bootstrap-owner welcome behavior are migrated only where
needed to remove obsolete managed-user actions. Password-reset delivery remains
unchanged.

## Authorization And Security

- Add named policy actions for invitation copy and send; do not infer authority
  from the UI.
- Require authenticated same-origin requests, session CSRF, managed-account
  scope, and recent admin authentication for rotation.
- Keep invitation secrets out of request/audit logging at the earliest request
  boundary, matching password-reset redaction.
- Build URLs only from the validated configured public base URL, never the Host
  header.
- Reject CRLF-bearing mail fields and retain existing TLS verification.
- Use short transactions and deterministic account-then-token lock order.
- Atomically consume with predicates that prevent replay under concurrency.
- Do not add file, JSON, console-link, or plaintext-token persistence fallbacks.

## Automated Verification

Focused Python tests cover:

- schema constraints, indexes, role grants, and idempotent migration behavior
- invitation-only account creation and rollback on every persistence failure
- purpose binding, hash-only storage, expiry, rotation, revocation, and replay
- concurrent copy/send and concurrent acceptance
- password policy and credential creation only on successful acceptance
- disabled, accepted, wrong-library, and bootstrap-owner eligibility
- CSRF, recent authentication, allowed actions, no-store/no-referrer headers,
  URL construction, and secret-free audits/errors
- invitation outbox claims, retry/unknown outcomes, and SMTP composition

JavaScript tests cover the accessible roster menu, action visibility, clipboard
success/fallback, reauthentication retry, and pending-state rendering.

The dedicated Phase 7 admin-management Playwright suite covers:

1. Create an invitation-only plus-addressed user without sending mail.
2. Open that user's three-dot menu and copy the invitation link.
3. Confirm a second copy rotates the first link.
4. Accept the current link in a fresh browser session, choose a password, and
   sign in successfully.
5. Confirm replay and the prior rotated link fail.

A separate case uses the in-process loopback SMTP capture server to assert that
an invitation message arrives, contains no password, and carries a usable link.
The harness continues to inject its own SMTP host/port into the E2E application
processes, so operator or CI real-SMTP configuration cannot redirect test mail.

Admin-management and auth-lifecycle remain independently schedulable suites and
retain separate GitHub runner jobs. No test depends on another test's data or
execution order.

## Documentation And Compatibility

Update local setup and manual-test instructions to explain pending accounts,
copy-link testing, invitation SMTP configuration, user/password ownership, link
rotation, and recovery. Update the private Phase 7 architecture, task tracker,
migration plan, and users-and-permissions functional cases because the approved
invitation lifecycle supersedes the earlier immediately-active managed-account
decision.

Existing managed accounts with credentials remain enabled and usable after the
migration. No invitation is generated for them. Existing unconsumed password
reset tokens keep their reset-only purpose and behavior.
