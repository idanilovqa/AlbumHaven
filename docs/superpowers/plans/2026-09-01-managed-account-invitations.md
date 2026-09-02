# Managed Account Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Album Haven's Phase 7 workflow also requires separate subagent handoffs for intake, implementation, test authoring, verification, commit, review, review fixes, and publishing.

**Goal:** Replace administrator-set managed-user passwords with revocable invitations that administrators can email or copy from the roster and recipients can accept to choose their own password.

**Architecture:** Postgres stores dedicated invitation-token and invitation-transaction hashes. Account creation omits credentials; one invitation service rotates copy/email tokens, and one public lifecycle service exchanges a URL token for a clean-URL transaction before atomically inserting the first credential. The existing SMTP outbox, administrator reauthentication, policy boundary, and Phase 7 Playwright harness gain invitation-specific paths without sharing password-reset purpose state.

**Tech Stack:** Python 3.13, FastAPI/Starlette, psycopg/Postgres migrations, Jinja, browser JavaScript, aiosmtplib, Node test runner, Playwright 1.61.1, GitHub Actions.

## Global Constraints

- Managed account creation is invitation-only; the administrator never chooses or sees the recipient's password.
- Enabled managed accounts without credentials render as `Pending invitation`; `is_active` and disabled metadata keep their administrative meaning.
- Invitation raw tokens contain at least 256 random bits; Postgres stores only a 32-byte SHA-256 digest.
- Invitation tokens expire after 72 hours, work once, and rotate on each copy or send action.
- Copy/send actions require session CSRF, same-origin validation, target scope, and recent administrator authentication.
- Token-bearing responses and pages use `Cache-Control: no-store`; lifecycle pages also use `Referrer-Policy: no-referrer`.
- Invitation URLs come only from `ALBUM_HAVEN_PUBLIC_BASE_URL`.
- E2E injects a loopback SMTP host and port and never reads operator SMTP credentials.
- Admin-management and auth-lifecycle Playwright suites stay independently schedulable in their existing GitHub jobs.
- Postgres remains the only durable application authority; do not add file, JSON, console-link, or plaintext-token fallbacks.
- Preserve existing managed accounts that already have credentials.
- Keep `.codex-remote-attachments/` and unrelated user changes untouched.

---

## File Structure

### New files

- `migrations/postgres/0052_add_managed_account_invitations.sql`: invitation tokens, clean-URL transactions, outbox linkage/category, indexes, constraints, and role grants.
- `music_app/services/auth_invitation_models.py`: shared invitation constants and redacting value objects used by creation, rotation, lifecycle, routes, and mail.
- `music_app/services/admin_account_invitations_postgres.py`: admin-authorized issue/rotate/copy/send persistence.
- `music_app/services/auth_invitation_lifecycle_postgres.py`: public exchange, transaction validation, and first-credential completion.
- `music_app/services/auth_invitation_csrf.py`: invitation-transaction-bound CSRF derivation.
- `music_app/templates/account-invitation.html`: invalid, password-entry, and completed states.
- `tests/py/test_admin_account_invitations_postgres.py`: rotation, authorization, recent-auth, and audit tests.
- `tests/py/test_auth_invitation_lifecycle_postgres.py`: exchange/completion/replay/concurrency tests.
- `tests/py/test_auth_invitation_csrf.py`: purpose-bound CSRF tests.

### Modified production files

- `music_app/services/auth_config.py`: validated 259,200-second invitation lifetime.
- `music_app/services/mail_config.py`: invitation-delivery enable flag.
- `music_app/services/admin_account_creation.py`: remove password hashing and accept `send_invitation`.
- `music_app/services/admin_account_creation_postgres.py`: persist pending accounts and optional initial invitation/outbox atomically.
- `music_app/services/admin_members_postgres.py`: credential-aware pending status and invitation-delivery projection.
- `music_app/services/admin_member_mutation_postgres.py`: revoke pending invitations when disabling an account.
- `music_app/services/auth_break_glass_postgres.py`: revoke pending invitations and their exchanges during emergency owner reset.
- `music_app/services/auth_mail.py`: compose invitation email.
- `music_app/services/auth_mail_outbox_postgres.py`: claim and deliver invitation outbox rows.
- `music_app/services/auth_audit_postgres.py`: allowlisted invitation audit reasons.
- `music_app/services/policy.py`: change only if focused tests prove the existing bootstrap-owner `accounts.*` rule does not cover invitation actions.
- `music_app/services/private_route_boundary.py`: public acceptance route, token redaction, and private invitation actions.
- `music_app/routes/admin_asgi.py`: invitation-only create plus copy/send endpoints.
- `music_app/routes/auth_asgi.py`: clean-URL invitation exchange and completion.
- `music_app/templates/admin-account-detail.html`: remove administrator password input and update invitation copy.
- `music_app/templates/admin-members.html`: status projection, accessible three-dot menu, fallback link field, and script load.
- `music_app/static/js/admin-members.js`: create payload, menu behavior, rotation actions, clipboard/fallback, and reauthentication retry.
- `music_app/static/css/admin-members.css`: roster menu and copy fallback styles.

### Modified tests, harness, CI, and docs

- `tests/py/test_phase_7_auth_schema.py`, `tests/py/test_postgres_migrations.py`, `tests/py/test_auth_config.py`, `tests/py/test_auth_mail.py`, `tests/py/test_auth_mail_outbox_postgres.py`, `tests/py/test_admin_account_creation.py`, `tests/py/test_admin_account_creation_postgres.py`, `tests/py/test_admin_members_postgres.py`, `tests/py/test_admin_asgi.py`, `tests/py/test_admin_mail_actions_postgres.py`, `tests/py/test_admin_member_mutation_postgres.py`, `tests/py/test_auth_break_glass_postgres.py`, `tests/py/test_auth_asgi.py`, `tests/py/test_private_route_boundary.py`, `tests/py/test_auth_login_postgres.py`, and `tests/py/test_auth_audit_postgres.py`: focused contract updates.
- `tests/js/runtime/admin-members.test.js`: menu, clipboard, fallback, pending state, and payload tests.
- `tests/e2e/support/phase7AuthApp.py`: invitation env and database-state projections while retaining loopback SMTP injection.
- `tests/e2e/phase7/poms/authPages.js`: invitation-aware page objects.
- `tests/e2e/phase7/actions/authActions.js`: invitation URL parsing helper.
- `tests/e2e/phase7/admin-management/adminManagement.spec.js`: copy-link lifecycle and captured-SMTP invitation scenarios.
- `.github/workflows/pr-gates.yml`: assertion-only updates if workflow tests require the existing admin job to name the expanded scope; do not create a third Phase 7 job.
- `docs/local-auth-setup-and-manual-tests.md`: operator setup and manual invitation cases.
- `../album-haven-internal/docs/superpowers/specs/2026-07-21-phase-7-local-auth-account-management-design.md`, `../album-haven-internal/docs/phase-7-TASKS.md`, `../album-haven-internal/docs/migration-plan.md`, `../album-haven-internal/docs/functional-test-cases.md`, and `../album-haven-internal/docs/functional-test-cases/users-and-permissions.md`: superseded decision, progress, and durable functional cases.

---

### Task 0: Clean Baseline Failure Inventory

**Files:**
- Read only: repository test configuration and scoped process logs.

**Interfaces:**
- Produces: a complete pre-implementation failure inventory for every required full suite.
- Consumed by: Tasks 1 through 7 to distinguish regressions from baseline failures.

- [ ] **Step 1: Run every required full suite before implementation**

Run sequentially, preserving one pytest process at a time:

```text
npm test
npm run test:js:all
npm run test:component
npm run check:e2e-production-parity
npm run test:e2e:phase7:auth
npm run test:e2e:phase7:admin
npm run test:e2e:functional
npm run test:e2e:performance
```

Use monitored hidden processes for long-lived Playwright commands on Windows. After each E2E process exits, verify its owned application, browser, Node, Python, Playwright, SMTP, and scoped-port state before starting the next suite.

- [ ] **Step 2: Record the complete baseline result set**

Keep each command, exit code, genuine test failures, log path, and cleanup result in the task record. Continue through all suites even if one fails, unless continuing would be unsafe or impossible.

---

### Task 1: Postgres And Configuration Contracts

**Files:**
- Create: `migrations/postgres/0052_add_managed_account_invitations.sql`
- Create: `music_app/services/auth_invitation_models.py`
- Modify: `music_app/services/auth_config.py`
- Modify: `music_app/services/mail_config.py`
- Test: `tests/py/test_phase_7_auth_schema.py`
- Test: `tests/py/test_postgres_migrations.py`
- Test: `tests/py/test_auth_config.py`
- Test: `tests/py/test_auth_mail.py`
- Test: `tests/py/test_auth_invitation_models.py`

**Interfaces:**
- Produces: `INVITATION_DB_PURPOSE = "account_invitation"`, `INVITATION_URL_PURPOSE = "account-invitation"`, `INVITATION_MESSAGE_CATEGORY = "account_invitation"`, and `INVITATION_TRANSACTION_SECONDS = 900`.
- Produces: `InvitationDelivery`, `CopiedInvitation`, `IssuedInvitationTransaction`, and `InvitationCompletionOutcome` from `music_app.services.auth_invitation_models`.
- Produces: config key `invitation_token_seconds: int = 259_200`.
- Produces: mail key `invitation_enabled: bool` from `ALBUM_HAVEN_INVITATION_EMAIL_ENABLED`.
- Produces: `app.account_invitation_tokens`, `app.account_invitation_transactions`, and `mail_outbox.invitation_token_id`.
- Consumed by: Tasks 2 through 6.

- [ ] **Step 1: Write failing schema and configuration tests**

Assert exact constraints, indexes, role grants, and defaults:

```python
assert config["invitation_token_seconds"] == 259_200
assert build_mail_config({**smtp_env, "ALBUM_HAVEN_INVITATION_EMAIL_ENABLED": "true"})[
    "invitation_enabled"
] is True
assert "create table if not exists app.account_invitation_tokens" in migration
assert "create unique index if not exists account_invitation_tokens_active_account_idx" in migration
assert "create table if not exists app.account_invitation_transactions" in migration
assert "invitation_token_id bigint" in migration
assert "constraint account_invitation_transactions_invitation_token_id_key" in migration
assert "account_invitation_transactions_token_idx" not in migration
assert "grant select, insert, update on table app.account_invitation_transactions" in migration
assert "grant select, insert, update, delete on table app.account_invitation_transactions" not in migration
```

Add `tests/py/test_auth_invitation_models.py` with the exact shared-contract test:

```python
from datetime import datetime, timezone
import pytest

from music_app.services.auth_invitation_models import (
    INVITATION_DB_PURPOSE,
    INVITATION_MESSAGE_CATEGORY,
    INVITATION_TRANSACTION_SECONDS,
    INVITATION_URL_PURPOSE,
    CopiedInvitation,
    InvitationCompletionOutcome,
    InvitationDelivery,
    IssuedInvitationTransaction,
    validated_issued_invitation_token,
)
from music_app.services.auth_tokens import IssuedOpaqueToken


def test_invitation_models_are_purpose_bound_and_redact_bearer_values():
    expires = datetime(2026, 9, 4, tzinfo=timezone.utc)
    delivery = InvitationDelivery(
        outbox_id=7,
        invitation_token_id=8,
        account_id=9,
        recipient="listener@example.test",
        username="listener",
        raw_token="secret-token",
        expires_at=expires,
    )
    copied = CopiedInvitation(
        invitation_url="https://example.test/accept-invitation?token=secret-token",
        expires_at=expires,
    )
    transaction = IssuedInvitationTransaction(
        raw_token="transaction-secret", transaction_id=10, expires_at=expires
    )
    assert INVITATION_DB_PURPOSE == "account_invitation"
    assert INVITATION_URL_PURPOSE == "account-invitation"
    assert INVITATION_MESSAGE_CATEGORY == "account_invitation"
    assert INVITATION_TRANSACTION_SECONDS == 900
    assert InvitationCompletionOutcome.SUCCESS.value == "success"
    assert "secret-token" not in repr(delivery)
    assert "secret-token" not in repr(copied)
    assert "transaction-secret" not in repr(transaction)
    issued = IssuedOpaqueToken(raw="A" * 43, digest=b"x" * 32)
    with pytest.raises(RuntimeError, match="Account invitation token issuance failed"):
        validated_issued_invitation_token(lambda: issued)


@pytest.mark.parametrize("digest", [None, b"short", bytearray(b"x" * 32)])
def test_invitation_token_validator_rejects_invalid_digest_before_compare(digest):
    issued = IssuedOpaqueToken(raw="A" * 43, digest=digest)
    with pytest.raises(
        RuntimeError, match="^Account invitation token issuance failed\\.$"
    ) as raised:
        validated_issued_invitation_token(lambda: issued)
    assert raised.value.__cause__ is None
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `python -m pytest tests/py/test_auth_invitation_models.py tests/py/test_phase_7_auth_schema.py tests/py/test_postgres_migrations.py tests/py/test_auth_config.py -q`

Expected: failures for missing migration and missing configuration keys.

- [ ] **Step 3: Add the shared contracts and migration 0052**

Create `music_app/services/auth_invitation_models.py` exactly as follows:

```python
"""Purpose-bound, secret-redacting invitation value objects."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import hmac

from music_app.services.auth_tokens import (
    IssuedOpaqueToken,
    hash_opaque_token,
)

INVITATION_DB_PURPOSE = "account_invitation"
INVITATION_URL_PURPOSE = "account-invitation"
INVITATION_MESSAGE_CATEGORY = "account_invitation"
INVITATION_TRANSACTION_SECONDS = 15 * 60


class InvitationCompletionOutcome(str, Enum):
    SUCCESS = "success"
    INVALID = "invalid"


@dataclass(frozen=True, repr=False, slots=True)
class InvitationDelivery:
    outbox_id: int
    invitation_token_id: int
    account_id: int
    recipient: str
    username: str
    raw_token: str
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(outbox_id={self.outbox_id!r}, "
            f"invitation_token_id={self.invitation_token_id!r}, "
            f"account_id={self.account_id!r}, recipient=<redacted>, "
            f"username={self.username!r}, raw_token=<redacted>, "
            f"expires_at={self.expires_at!r})"
        )


@dataclass(frozen=True, repr=False, slots=True)
class CopiedInvitation:
    invitation_url: str
    expires_at: datetime

    def __repr__(self) -> str:
        return f"{type(self).__name__}(invitation_url=<redacted>, expires_at={self.expires_at!r})"


@dataclass(frozen=True, repr=False, slots=True)
class IssuedInvitationTransaction:
    raw_token: str
    transaction_id: int
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(raw_token=<redacted>, "
            f"transaction_id={self.transaction_id!r}, expires_at={self.expires_at!r})"
        )


def validated_issued_invitation_token(provider) -> IssuedOpaqueToken:
    value = provider()
    if not isinstance(value, IssuedOpaqueToken):
        raise RuntimeError("Account invitation token issuance failed.")
    try:
        expected = hash_opaque_token(value.raw)
    except (TypeError, ValueError):
        raise RuntimeError("Account invitation token issuance failed.") from None
    if not isinstance(value.digest, bytes) or len(value.digest) != 32:
        raise RuntimeError("Account invitation token issuance failed.") from None
    if not hmac.compare_digest(expected, value.digest):
        raise RuntimeError("Account invitation token issuance failed.")
    return value
```

Create `migrations/postgres/0052_add_managed_account_invitations.sql` with these complete table/index/outbox alterations; use the migration's existing role-grant variables/pattern verbatim for the final grants:

```sql
create table if not exists app.account_invitation_tokens (
  id bigint generated always as identity primary key,
  account_id bigint not null references app.accounts(id) on delete cascade,
  token_hash bytea not null,
  purpose text not null default 'account_invitation',
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  request_ref text not null,
  constraint account_invitation_tokens_hash_check check (octet_length(token_hash) = 32),
  constraint account_invitation_tokens_purpose_check check (purpose = 'account_invitation'),
  constraint account_invitation_tokens_expiry_check check (expires_at > created_at)
);
create unique index if not exists account_invitation_tokens_purpose_hash_idx
  on app.account_invitation_tokens(purpose, token_hash);
create index if not exists account_invitation_tokens_account_idx
  on app.account_invitation_tokens(account_id);
create unique index if not exists account_invitation_tokens_active_account_idx
  on app.account_invitation_tokens(account_id)
  where consumed_at is null and revoked_at is null;

create table if not exists app.account_invitation_transactions (
  id bigint generated always as identity primary key,
  invitation_token_id bigint not null
    references app.account_invitation_tokens(id) on delete cascade,
  transaction_hash bytea not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint account_invitation_transactions_invitation_token_id_key
    unique (invitation_token_id),
  constraint account_invitation_transactions_hash_check
    check (octet_length(transaction_hash) = 32),
  constraint account_invitation_transactions_expiry_check
    check (expires_at > created_at)
);
create index if not exists account_invitation_transactions_active_expiry_idx
  on app.account_invitation_transactions(expires_at)
  where consumed_at is null;

alter table app.mail_outbox
  add column if not exists invitation_token_id bigint
  references app.account_invitation_tokens(id) on delete set null;
create index if not exists mail_outbox_invitation_token_idx
  on app.mail_outbox(invitation_token_id)
  where invitation_token_id is not null;

alter table app.mail_outbox drop constraint if exists mail_outbox_message_category_check;
alter table app.mail_outbox add constraint mail_outbox_message_category_check
  check (message_category in ('welcome', 'password_reset', 'account_invitation'));

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_readonly') then
    revoke all on table app.account_invitation_tokens from album_haven_readonly;
    revoke all on table app.account_invitation_transactions from album_haven_readonly;
    revoke all on sequence app.account_invitation_tokens_id_seq from album_haven_readonly;
    revoke all on sequence app.account_invitation_transactions_id_seq from album_haven_readonly;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    revoke all on table app.account_invitation_tokens from album_haven_app;
    revoke all on table app.account_invitation_transactions from album_haven_app;
    grant select, insert, update on table app.account_invitation_tokens to album_haven_app;
    grant select, insert, update on table app.account_invitation_transactions to album_haven_app;
    grant usage, select on sequence app.account_invitation_tokens_id_seq to album_haven_app;
    grant usage, select on sequence app.account_invitation_transactions_id_seq to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant all privileges on table app.account_invitation_tokens to album_haven_migrator;
    grant all privileges on table app.account_invitation_transactions to album_haven_migrator;
    grant all privileges on sequence app.account_invitation_tokens_id_seq to album_haven_migrator;
    grant all privileges on sequence app.account_invitation_transactions_id_seq to album_haven_migrator;
  end if;
end $$;
```

- [ ] **Step 4: Add validated configuration**

In `build_auth_config`, add:

```python
"invitation_token_seconds": _integer(
    env,
    "ALBUM_HAVEN_INVITATION_TOKEN_SECONDS",
    259_200,
    minimum=3_600,
    maximum=604_800,
),
```

In `build_mail_config`, include invitation delivery in `delivery_enabled` and return `invitation_enabled`.

Use these exact assignments in `music_app/services/mail_config.py`:

```python
invitation_enabled = _boolean(
    env, "ALBUM_HAVEN_INVITATION_EMAIL_ENABLED", default=False
)
delivery_enabled = welcome_enabled or reset_enabled or invitation_enabled
# In the returned MailConfig payload:
"invitation_enabled": invitation_enabled,
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `python -m pytest tests/py/test_auth_invitation_models.py tests/py/test_phase_7_auth_schema.py tests/py/test_postgres_migrations.py tests/py/test_auth_config.py tests/py/test_auth_mail.py -q`.

Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add migrations/postgres/0052_add_managed_account_invitations.sql music_app/services/auth_invitation_models.py music_app/services/auth_config.py music_app/services/mail_config.py tests/py/test_auth_invitation_models.py tests/py/test_phase_7_auth_schema.py tests/py/test_postgres_migrations.py tests/py/test_auth_config.py tests/py/test_auth_mail.py
git commit -m "feat(auth): add managed invitation persistence contracts"
```

---

### Task 2: Invitation-Only Account Creation

**Files:**
- Modify: `music_app/services/admin_account_creation.py`
- Modify: `music_app/services/admin_account_creation_postgres.py`
- Modify: `music_app/routes/admin_asgi.py`
- Test: `tests/py/test_admin_account_creation.py`
- Test: `tests/py/test_admin_account_creation_postgres.py`
- Test: `tests/py/test_admin_asgi.py`

**Interfaces:**
- Consumes: `invitation_token_seconds`, `IssuedOpaqueToken` from `auth_tokens.issue_opaque_token()`, and `InvitationDelivery` from `auth_invitation_models`.
- Produces: `CreatedAccount(account_id: int, invitation_delivery: InvitationDelivery | None)`.
- Produces: create JSON `{account_id, pending: true, invitation_queued: bool}`.
- Consumed by: Tasks 4 through 6.

- [ ] **Step 1: Replace active-password creation tests with pending-account tests**

Replace `tests/py/test_admin_account_creation.py::test_admin_create_normalizes_identity_hashes_before_repository_and_preserves_plus_tag` with the same actor/identity/capability fixtures, remove `password`, `breached_checker`, `argon2`, and `password_hasher`, inject `token_issuer`, and assert the repository call contains exactly the signature shown in Step 3. Replace `tests/py/test_admin_account_creation_postgres.py::test_repository_creates_active_account_credential_membership_grants_welcome_and_audit_atomically` with two parameter cases, `invitation=None` and `invitation=issued`; in both cases assert no SQL contains `insert into app.account_credentials`, and only the issued case contains one invitation insert followed by one linked outbox insert before commit.

```python
result = service.create_account(
    actor=owner,
    username="listener.plus",
    contact_email="listener+phase7@example.test",
    capability_keys=("library.browse.read",),
    send_invitation=False,
)
assert result.invitation_delivery is None
assert password_hasher_calls == []
assert all("account_credentials" not in sql for sql, _params in connection.executed)
```

Replace the route contract assertion with:

```python
response = client.post(
    "/admin/accounts",
    json={
        "username": "listener.plus",
        "contact_email": "listener+phase7@example.test",
        "capability_keys": ["library.browse.read"],
        "send_invitation": False,
    },
    headers={"Origin": "https://example.test", "X-CSRF-Token": csrf},
)
assert response.status_code == 201
assert response.json() == {
    "account_id": 41,
    "pending": True,
    "invitation_queued": False,
}
assert "password" not in repository.calls[0]
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `python -m pytest tests/py/test_admin_account_creation.py tests/py/test_admin_account_creation_postgres.py tests/py/test_admin_asgi.py -q`

Expected: old password-required contracts fail.

- [ ] **Step 3: Change the coordinator and repository**

Replace the `CreatedAccount` definition, constructor, and coordinator method with this contract:

```python
from datetime import datetime, timedelta, timezone
from music_app.services.auth_invitation_models import InvitationDelivery
from music_app.services.auth_tokens import IssuedOpaqueToken, issue_opaque_token


@dataclass(frozen=True, slots=True)
class CreatedAccount:
    account_id: int
    invitation_delivery: InvitationDelivery | None


class AdminAccountCreationService:
    def __init__(self, *, repository, invitation_token_seconds: int,
                 token_issuer=issue_opaque_token, clock=None) -> None:
        self._repository = repository
        self._invitation_token_seconds = invitation_token_seconds
        self._token_issuer = token_issuer
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def create_account(self, *, actor: CurrentActor, username: object,
                       contact_email: object, capability_keys: Iterable[object],
                       send_invitation: object, request_ref: str) -> CreatedAccount:
        library_id = _authorized_library(actor)
        username_display, username_normalized = _username(username)
        email_display, email_normalized = _email(contact_email)
        capabilities = _capabilities(capability_keys)
        if not isinstance(send_invitation, bool):
            raise ValueError("Managed account invitation choice is invalid.")
        issued = self._token_issuer() if send_invitation else None
        if issued is not None and not isinstance(issued, IssuedOpaqueToken):
            raise RuntimeError("Managed account invitation preparation failed.")
        now = self._clock().astimezone(timezone.utc)
        result = self._repository.create_account(
            actor_account_id=actor.account_id,
            library_id=library_id,
            username_display=username_display,
            username_normalized=username_normalized,
            contact_email=email_display,
            contact_email_normalized=email_normalized,
            capability_keys=capabilities,
            invitation=issued,
            invitation_expires_at=(
                now + timedelta(seconds=self._invitation_token_seconds)
                if issued is not None else None
            ),
            created_at=now,
            request_ref=request_ref,
        )
        if not isinstance(result, CreatedAccount):
            raise RuntimeError("Managed account persistence failed.")
        return result
```

Implement this exact repository signature:

```python
def create_account(
    *,
    actor_account_id: int,
    library_id: int,
    username_display: str,
    username_normalized: str,
    contact_email: str,
    contact_email_normalized: str,
    capability_keys: tuple[str, ...],
    invitation: IssuedOpaqueToken | None,
    invitation_expires_at: datetime | None,
    created_at: datetime,
    request_ref: str,
) -> CreatedAccount:
    """Perform the inserts below in one transaction and return their IDs."""
```

Copy the existing `PostgresAdminAccountRepository.create_account` authority query, account insert, membership insert, capability loop, identity-conflict mapping, and transaction context byte-for-byte. Delete only its credential and welcome-outbox inserts, add the exact timestamp/invitation blocks below at those positions, and return the new `CreatedAccount` shape. At the top of the repository method, normalize the caller-owned timestamp once and use only `created_at` throughout the transaction:

```python
created_at = _aware_utc(created_at)
if invitation is None and invitation_expires_at is not None:
    raise ValueError("Managed account invitation expiry is invalid.")
if invitation is not None:
    invitation_expires_at = _aware_utc(invitation_expires_at)
    if invitation_expires_at <= created_at:
        raise ValueError("Managed account invitation expiry is invalid.")
```

Add this repository-local validator beside `_positive_id`:

```python
def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("Managed account timestamp is invalid.")
    return value.astimezone(timezone.utc)
```

Inside the existing transaction, replace the credential insert with these conditional inserts and construct the shared delivery only after both returning IDs exist:

```python
invitation_delivery = None
if invitation is not None:
    token_id = _single_id(connection.execute(
        """
        insert into app.account_invitation_tokens (
          account_id, token_hash, purpose, created_at, expires_at, request_ref
        ) values (%s, %s, 'account_invitation', %s, %s, %s)
        returning id
        """,
        (account_id, invitation.digest, created_at, invitation_expires_at, request_ref),
    ).fetchall(), "invitation token id")
    outbox_id = _single_id(connection.execute(
        """
        insert into app.mail_outbox (
          account_id, invitation_token_id, message_category,
          delivery_status, created_at
        ) values (%s, %s, 'account_invitation', 'pending', %s)
        returning id
        """,
        (account_id, token_id, created_at),
    ).fetchall(), "outbox id")
    invitation_delivery = InvitationDelivery(
        outbox_id=outbox_id,
        invitation_token_id=token_id,
        account_id=account_id,
        recipient=contact_email,
        username=username_display,
        raw_token=invitation.raw,
        expires_at=invitation_expires_at,
    )
connection.execute(
    """
    insert into app.security_audit_events (
      actor_account_id, target_account_id, event_category,
      outcome, reason_code, request_ref, occurred_at, metadata
    ) values (%s, %s, 'account_management', 'success',
              'account_created_pending_invitation', %s, %s, '{}'::jsonb)
    """,
    (actor_account_id, account_id, request_ref, created_at),
)
return CreatedAccount(account_id=account_id, invitation_delivery=invitation_delivery)
```

- [ ] **Step 4: Change the create route and payload**

Use this route body and response mapping; do not include `password` in extraction or response:

```python
_FIELDS = frozenset({
    "username", "contact_email", "capability_keys", "send_invitation"
})

payload = await request.json()
if set(payload) != _FIELDS:
    return _invalid()
if not all(isinstance(payload[key], str) for key in ("username", "contact_email")):
    return _invalid()
if not isinstance(payload["send_invitation"], bool):
    return _invalid()
result = service.create_account(
    actor=request.state.current_actor,
    username=payload.get("username"),
    contact_email=payload.get("contact_email"),
    capability_keys=payload.get("capability_keys", ()),
    send_invitation=payload.get("send_invitation", False),
    request_ref=uuid4().hex,
)
if result.invitation_delivery is not None:
    background_tasks.add_task(
        _deliver_pending_invitation, request.app, result.invitation_delivery
    )
return JSONResponse(
    {
        "account_id": result.account_id,
        "pending": True,
        "invitation_queued": result.invitation_delivery is not None,
    },
    status_code=201,
)
```

Replace the route's service factory with:

```python
def _service(request: Request) -> AdminAccountCreationService:
    injected = getattr(request.app.state, "admin_account_creation", None)
    if injected is not None:
        return injected
    auth_config = request.app.state.auth_policy_config
    return AdminAccountCreationService(
        repository=PostgresAdminAccountRepository(
            request.app.state.repository_config
        ),
        invitation_token_seconds=auth_config["invitation_token_seconds"],
    )
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `python -m pytest tests/py/test_admin_account_creation.py tests/py/test_admin_account_creation_postgres.py tests/py/test_admin_asgi.py -q`.

Expected: all selected tests pass, including transaction rollback injection cases.

- [ ] **Step 6: Commit Task 2**

```bash
git add music_app/services/admin_account_creation.py music_app/services/admin_account_creation_postgres.py music_app/routes/admin_asgi.py tests/py/test_admin_account_creation.py tests/py/test_admin_account_creation_postgres.py tests/py/test_admin_asgi.py
git commit -m "feat(admin): create managed accounts as pending invitations"
```

---

### Task 3: Administrator Invitation Rotation

**Files:**
- Create: `music_app/services/admin_account_invitations_postgres.py`
- Modify: `music_app/services/admin_member_mutation_postgres.py`
- Modify: `music_app/services/auth_break_glass_postgres.py`
- Modify: `music_app/services/auth_audit_postgres.py`
- Modify if tests require: `music_app/services/policy.py`
- Modify: `music_app/services/private_route_boundary.py`
- Modify: `music_app/routes/admin_asgi.py`
- Test: `tests/py/test_admin_account_invitations_postgres.py`
- Test: `tests/py/test_admin_member_mutation_postgres.py`
- Test: `tests/py/test_auth_break_glass_postgres.py`
- Test: `tests/py/test_auth_audit_postgres.py`
- Test: `tests/py/test_admin_asgi.py`
- Test: `tests/py/test_auth_asgi.py`
- Test: `tests/py/test_private_route_boundary.py`

**Interfaces:**
- Consumes: `CopiedInvitation` and `InvitationDelivery` from `auth_invitation_models`; do not redefine them.
- Produces: the exact `PostgresAdminAccountInvitationService.issue_copy` and `queue_email` signatures shown in Step 3.
- Produces: private endpoints `POST /admin/accounts/{account_id}/invitation/copy` and `/invitation/send`.
- Consumed by: Tasks 4 through 6.

- [ ] **Step 1: Write authorization, rotation, and route tests**

Build the service transaction harness by cloning `tests/py/test_admin_member_mutation_postgres.py::test_admin_update_requires_recent_auth_and_explicit_destructive_confirmation`: retain its fixed UTC clock, owner/target rows, and transaction recorder; replace mutation SQL expectations with the Step 3 account-then-invitation lock order. Clone `test_admin_update_cannot_disable_or_detach_bootstrap_owner` for owner/disabled/wrong-library/credentialed rejection. Clone `tests/py/test_auth_break_glass_postgres.py::test_break_glass_replaces_credential_and_revokes_lifecycle_state` and add the two invitation revocation statements from Step 4. Clone the session-CSRF assertions in `tests/py/test_admin_asgi.py` and change only the two route paths/actions and expected copy headers.

```python
copied = service.issue_copy(
    actor_account_id=owner_id,
    actor_authenticated_at=now,
    library_id=library_id,
    target_account_id=pending_id,
    request_ref="a" * 32,
)
assert copied.invitation_url.startswith("https://example.test/accept-invitation?")
raw_token = parse_qs(urlsplit(copied.invitation_url).query)["token"][0]
assert raw_token not in serialized_audit
```

Use the shared field name and prove rotation explicitly:

```python
first = service.issue_copy(
    actor_account_id=owner_id,
    actor_authenticated_at=now,
    library_id=library_id,
    target_account_id=pending_id,
    request_ref="a" * 32,
)
second = service.issue_copy(
    actor_account_id=owner_id,
    actor_authenticated_at=now,
    library_id=library_id,
    target_account_id=pending_id,
    request_ref="b" * 32,
)
first_token = parse_qs(urlsplit(first.invitation_url).query)["token"][0]
second_token = parse_qs(urlsplit(second.invitation_url).query)["token"][0]
assert first_token != second_token
assert repository.active_digest == hash_opaque_token(second_token)
assert repository.revoked_digests == [hash_opaque_token(first_token)]
assert first_token not in serialized_audit
assert second_token not in serialized_audit
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `python -m pytest tests/py/test_admin_account_invitations_postgres.py tests/py/test_admin_member_mutation_postgres.py tests/py/test_admin_asgi.py tests/py/test_auth_asgi.py tests/py/test_private_route_boundary.py -q`

Expected: missing service, actions, and routes fail.

- [ ] **Step 3: Implement the rotation service**

Add the invitation audit allowlist before using it in rotation or acceptance:

```python
class SecurityAuditCategory(str, Enum):
    LOGIN = "login"
    PASSWORD_RECOVERY = "password_recovery"
    CREDENTIAL = "credential"
    ACCOUNT_INVITATION = "account_invitation"

class InvitationAuditReason(str, Enum):
    INVITATION_COPIED = "invitation_copied"
    INVITATION_QUEUED = "invitation_queued"
    INVITATION_ACCEPTED = "invitation_accepted"
    INVITATION_INVALID = "invitation_invalid"

_INVITATION_REASON_MATRIX = {
    SecurityAuditOutcome.SUCCESS: frozenset({
        InvitationAuditReason.INVITATION_COPIED,
        InvitationAuditReason.INVITATION_QUEUED,
        InvitationAuditReason.INVITATION_ACCEPTED,
    }),
    SecurityAuditOutcome.INVALID: frozenset({
        InvitationAuditReason.INVITATION_INVALID,
    }),
    SecurityAuditOutcome.THROTTLED: frozenset(),
}
```

Extend `append_in_transaction`'s reason union with `InvitationAuditReason` and replace `_reason` with:

```python
def _reason(category: SecurityAuditCategory, value: object,
            outcome: SecurityAuditOutcome):
    contracts = {
        SecurityAuditCategory.LOGIN: (LoginAuditReason, _LOGIN_REASON_MATRIX),
        SecurityAuditCategory.PASSWORD_RECOVERY: (
            RecoveryAuditReason, _RECOVERY_REASON_MATRIX
        ),
        SecurityAuditCategory.CREDENTIAL: (
            CredentialAuditReason, _CREDENTIAL_REASON_MATRIX
        ),
        SecurityAuditCategory.ACCOUNT_INVITATION: (
            InvitationAuditReason, _INVITATION_REASON_MATRIX
        ),
    }
    valid_type, matrix = contracts[category]
    if not isinstance(value, valid_type):
        raise TypeError("Security audit reason is invalid.")
    if value not in matrix[outcome]:
        raise ValueError("Security audit outcome and reason are incompatible.")
    return value
```

Keep `_METADATA_KEYS` unchanged so invitation secrets cannot be admitted.

Create the service with these exact public signatures and one private issuer used by both operations:

```python
@dataclass(frozen=True, repr=False, slots=True)
class _RotatedInvitation:
    outbox_id: int | None
    invitation_token_id: int
    account_id: int
    recipient: str
    username: str
    raw_token: str
    expires_at: datetime

class PostgresAdminAccountInvitationService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        token_issuer: Callable[[], object] = issue_opaque_token,
        audit_repository: Any,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        self._public_base_url = str(payload.get("public_base_url") or "").strip()
        seconds = payload.get("invitation_token_seconds")
        if not self._database_url:
            raise RuntimeError("Database configuration is required for invitations.")
        build_public_url(self._public_base_url, "/accept-invitation")
        if isinstance(seconds, bool) or not isinstance(seconds, int) or seconds < 3_600:
            raise ValueError("Invitation lifetime configuration is invalid.")
        if not callable(token_issuer):
            raise TypeError("Invitation token provider is invalid.")
        if not callable(getattr(audit_repository, "append_in_transaction", None)):
            raise TypeError("Invitation audit repository is invalid.")
        self._invitation_token_seconds = seconds
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._token_issuer = token_issuer
        self._audit = audit_repository

    def issue_copy(
        self, *, actor_account_id: object, actor_authenticated_at: object,
        library_id: object, target_account_id: object, request_ref: object,
    ) -> CopiedInvitation:
        delivery = self._issue(
            actor_account_id=actor_account_id,
            actor_authenticated_at=actor_authenticated_at,
            library_id=library_id,
            target_account_id=target_account_id,
            request_ref=request_ref,
            enqueue=False,
        )
        url = _invitation_url(self._public_base_url, delivery.raw_token)
        return CopiedInvitation(invitation_url=url, expires_at=delivery.expires_at)

    def queue_email(
        self, *, actor_account_id: object, actor_authenticated_at: object,
        library_id: object, target_account_id: object, request_ref: object,
    ) -> InvitationDelivery:
        issued = self._issue(
            actor_account_id=actor_account_id,
            actor_authenticated_at=actor_authenticated_at,
            library_id=library_id,
            target_account_id=target_account_id,
            request_ref=request_ref,
            enqueue=True,
        )
        if issued.outbox_id is None:
            raise RuntimeError("Managed account invitation outbox was not created.")
        return InvitationDelivery(
            outbox_id=issued.outbox_id,
            invitation_token_id=issued.invitation_token_id,
            account_id=issued.account_id,
            recipient=issued.recipient,
            username=issued.username,
            raw_token=issued.raw_token,
            expires_at=issued.expires_at,
        )

    def _issue(
        self, *, actor_account_id: object, actor_authenticated_at: object,
        library_id: object, target_account_id: object, request_ref: object,
        enqueue: bool,
    ) -> _RotatedInvitation:
        if not isinstance(enqueue, bool):
            raise ValueError("Invitation delivery choice is invalid.")
        now = _aware_utc(self._clock())
        authenticated = _aware_utc(actor_authenticated_at)
        if (authenticated > now + timedelta(minutes=5)
                or now - authenticated > timedelta(minutes=10)):
            raise RecentAuthenticationRequired("Recent authentication is required.")
        actor_id = _positive_id(actor_account_id)
        current_library_id = _positive_id(library_id)
        target_id = _positive_id(target_account_id)
        reference = _request_ref(request_ref)
        try:
            with self._operation() as connection:
                # Insert the account-lock, rotation, token/outbox, and audit block
                # shown immediately below, substituting actor_id,
                # current_library_id, target_id, and reference.
                rotated = _rotate_invitation_in_transaction(
                    connection=connection, actor_account_id=actor_id,
                    library_id=current_library_id, target_account_id=target_id,
                    request_ref=reference, enqueue=enqueue, now=now,
                    token_issuer=self._token_issuer,
                    invitation_token_seconds=self._invitation_token_seconds,
                    audit_repository=self._audit,
                )
        except (PermissionError, RecentAuthenticationRequired, ValueError):
            raise
        except Exception:
            raise RuntimeError("Managed account invitation persistence failed.") from None
        return rotated

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        with self._connect(self._database_url) as connection:
            transaction = getattr(connection, "transaction", None)
            if not callable(transaction):
                raise RuntimeError("Invitation persistence requires transactions.")
            with transaction():
                yield connection


def _invitation_url(public_base_url: str, raw_token: str) -> str:
    base = build_public_url(public_base_url, "/accept-invitation")
    return f"{base}?{urlencode({'purpose': INVITATION_URL_PURPOSE, 'token': raw_token})}"

def _rotate_invitation_in_transaction(
    *, connection: Any, actor_account_id: int, library_id: int,
    target_account_id: int, request_ref: str, enqueue: bool, now: datetime,
    token_issuer: Callable[[], object], invitation_token_seconds: int,
    audit_repository: Any,
) -> _RotatedInvitation:
    rows = connection.execute(
        """
        with locked_accounts as (
          select id, account_kind, username_display, contact_email,
                 is_active, disabled_at
          from app.accounts where id in (%s, %s) order by id for update
        ), locked_library as (
          select id, owner_account_id from library.libraries where id = %s for update
        )
        select target.id, target.username_display, target.contact_email
        from locked_accounts actor
        join app.bootstrap_owners authority on authority.account_id = actor.id
          and authority.owner_key = 'local-bootstrap-owner'
        join locked_library on locked_library.owner_account_id = actor.id
        join locked_accounts target on target.id = %s
        join library.library_memberships membership
          on membership.account_id = target.id
          and membership.library_id = locked_library.id
        left join app.bootstrap_owners target_owner on target_owner.account_id = target.id
        left join app.account_credentials credential on credential.account_id = target.id
        where actor.id = %s and actor.is_active is true and actor.disabled_at is null
          and target.account_kind = 'managed_user'
          and target.is_active is true and target.disabled_at is null
          and target_owner.account_id is null and credential.account_id is null
        """,
        (actor_account_id, target_account_id, library_id,
         target_account_id, actor_account_id),
    ).fetchall()
    if len(rows) != 1:
        raise PermissionError("Managed account invitation is not permitted.")
    account = rows[0]
    connection.execute(
        """select id from app.account_invitation_tokens
           where account_id = %s order by id for update""",
        (target_account_id,),
    ).fetchall()
    connection.execute(
        """update app.account_invitation_tokens set revoked_at = %s
           where account_id = %s and consumed_at is null and revoked_at is null""",
        (now, target_account_id),
    )
    issued = validated_issued_invitation_token(token_issuer)
    expires_at = now + timedelta(seconds=invitation_token_seconds)
    token_id = _single_id(connection.execute(
        """insert into app.account_invitation_tokens (
             account_id, token_hash, purpose, created_at, expires_at, request_ref
           ) values (%s, %s, %s, %s, %s, %s) returning id""",
        (target_account_id, issued.digest, INVITATION_DB_PURPOSE,
         now, expires_at, request_ref),
    ).fetchall(), "invitation token id")
    outbox_id = None
    if enqueue:
        outbox_id = _single_id(connection.execute(
            """insert into app.mail_outbox (
                 account_id, invitation_token_id, message_category,
                 delivery_status, next_attempt_at
               ) values (%s, %s, %s, 'pending', %s) returning id""",
            (target_account_id, token_id, INVITATION_MESSAGE_CATEGORY, now),
        ).fetchall(), "outbox id")
    audit_repository.append_in_transaction(
        connection, category=SecurityAuditCategory.ACCOUNT_INVITATION,
        outcome=SecurityAuditOutcome.SUCCESS,
        reason=(InvitationAuditReason.INVITATION_QUEUED if enqueue
                else InvitationAuditReason.INVITATION_COPIED),
        actor_account_id=actor_account_id, target_account_id=target_account_id,
        request_ref=request_ref, occurred_at=now, metadata=None,
    )
    return _RotatedInvitation(
        outbox_id=outbox_id, invitation_token_id=token_id,
        account_id=target_account_id, recipient=account["contact_email"],
        username=account["username_display"], raw_token=issued.raw,
        expires_at=expires_at,
    )
```

Inside `_issue`, validate recent authentication with the existing ten-minute/five-minute-skew contract:

```python
now = _aware_utc(self._clock())
authenticated = _aware_utc(actor_authenticated_at)
if authenticated > now + timedelta(minutes=5) or now - authenticated > timedelta(minutes=10):
    raise RecentAuthenticationRequired("Recent authentication is required.")
actor_account_id = _positive_id(actor_account_id)
library_id = _positive_id(library_id)
target_account_id = _positive_id(target_account_id)
request_ref = _request_ref(request_ref)
```

Then use this account-first authority/target lock and eligibility predicate:

```python
accounts = connection.execute(
    """
    with locked_accounts as (
      select id, account_kind, username_display, contact_email,
             is_active, disabled_at
      from app.accounts where id in (%s, %s) order by id for update
    ), locked_library as (
      select id, owner_account_id from library.libraries where id = %s for update
    )
    select target.id, target.username_display, target.contact_email
    from locked_accounts actor
    join app.bootstrap_owners authority
      on authority.account_id = actor.id
     and authority.owner_key = 'local-bootstrap-owner'
    join locked_library on locked_library.owner_account_id = actor.id
    join locked_accounts target on target.id = %s
    join library.library_memberships membership
      on membership.account_id = target.id
     and membership.library_id = locked_library.id
    left join app.bootstrap_owners target_owner on target_owner.account_id = target.id
    left join app.account_credentials credential on credential.account_id = target.id
    where actor.id = %s and actor.is_active is true and actor.disabled_at is null
      and target.account_kind = 'managed_user'
      and target.is_active is true and target.disabled_at is null
      and target_owner.account_id is null and credential.account_id is null
    """,
    (actor_account_id, target_account_id, library_id,
     target_account_id, actor_account_id),
).fetchall()
if len(accounts) != 1:
    raise PermissionError("Managed account invitation is not permitted.")
account = accounts[0]
connection.execute(
    """
    select id from app.account_invitation_tokens
    where account_id = %s order by id for update
    """, (target_account_id,),
).fetchall()
connection.execute(
    """
    update app.account_invitation_tokens set revoked_at = %s
    where account_id = %s and consumed_at is null and revoked_at is null
    """, (now, target_account_id),
)
issued = validated_issued_invitation_token(self._token_issuer)
expires_at = now + timedelta(seconds=self._invitation_token_seconds)
token_id = _single_id(connection.execute(
    """
    insert into app.account_invitation_tokens (
      account_id, token_hash, purpose, created_at, expires_at, request_ref
    ) values (%s, %s, %s, %s, %s, %s) returning id
    """,
    (target_account_id, issued.digest, INVITATION_DB_PURPOSE,
     now, expires_at, request_ref),
).fetchall(), "invitation token id")
outbox_id = None
if enqueue:
    outbox_id = _single_id(connection.execute(
        """
        insert into app.mail_outbox (
          account_id, invitation_token_id, message_category,
          delivery_status, next_attempt_at
        ) values (%s, %s, %s, 'pending', %s) returning id
        """,
        (target_account_id, token_id, INVITATION_MESSAGE_CATEGORY, now),
    ).fetchall(), "outbox id")
self._audit.append_in_transaction(
    connection,
    category=SecurityAuditCategory.ACCOUNT_INVITATION,
    outcome=SecurityAuditOutcome.SUCCESS,
    reason=(InvitationAuditReason.INVITATION_QUEUED if enqueue
            else InvitationAuditReason.INVITATION_COPIED),
    actor_account_id=actor_account_id,
    target_account_id=target_account_id,
    request_ref=request_ref,
    occurred_at=now,
    metadata=None,
)
```

Return this private rotation result after commit; only `queue_email` converts a non-null `outbox_id` to the shared `InvitationDelivery`:

```python
return _RotatedInvitation(
    outbox_id=outbox_id,
    invitation_token_id=token_id,
    account_id=target_account_id,
    recipient=account["contact_email"],
    username=account["username_display"],
    raw_token=issued.raw,
    expires_at=expires_at,
)
```

Build the public URL only with:

```python
build_public_url(config["public_base_url"], "/accept-invitation")
```

plus `urlencode({"purpose": "account-invitation", "token": issued.raw})`.

- [ ] **Step 4: Add policy, route, and disable revocation behavior**

Add the named actions and endpoints with these exact response contracts:

```python
_ADMIN_ACTIONS = (*_ADMIN_ACTIONS, "accounts.invitation.copy", "accounts.invitation.send")

_PRIVATE_ROUTE_ACTIONS.update({
    ("POST", "/admin/accounts/{account_id}/invitation/copy"):
        "accounts.invitation.copy",
    ("POST", "/admin/accounts/{account_id}/invitation/send"):
        "accounts.invitation.send",
})

def _invitation_service(request: Request):
    existing = getattr(request.app.state, "admin_account_invitation_service", None)
    if existing is not None:
        return existing
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "admin_account_invitation_service", None)
        if existing is None:
            auth_config = request.app.state.auth_policy_config
            mail_config = request.app.state.mail_config
            service_config = dict(auth_config)
            service_config["public_base_url"] = mail_config["public_base_url"]
            existing = PostgresAdminAccountInvitationService(
                service_config,
                audit_repository=PostgresSecurityAuditRepository(),
            )
            request.app.state.admin_account_invitation_service = existing
    return existing

@router.post("/admin/accounts/{account_id}/invitation/copy")
async def copy_managed_account_invitation(request: Request, account_id: int) -> Response:
    try:
        copied = await run_in_threadpool(
            _invitation_service(request).issue_copy,
            actor_account_id=request.state.current_actor.account_id,
            actor_authenticated_at=request.state.current_actor.authenticated_at,
            library_id=request.state.current_actor.current_library_id,
            target_account_id=account_id,
            request_ref=uuid4().hex,
        )
    except RecentAuthenticationRequired:
        return JSONResponse({"detail": "Recent authentication is required."}, status_code=409)
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except Exception:
        return JSONResponse({"detail": "Invitation link is temporarily unavailable."}, status_code=503)
    return JSONResponse(
        {"invitation_url": copied.invitation_url,
         "expires_at": copied.expires_at.isoformat()},
        headers={"Cache-Control": "no-store, max-age=0",
                 "Referrer-Policy": "no-referrer"},
    )

@router.post("/admin/accounts/{account_id}/invitation/send", status_code=202)
async def send_managed_account_invitation(
    request: Request, account_id: int, background_tasks: BackgroundTasks
) -> Response:
    if request.app.state.mail_config.get("invitation_enabled") is not True:
        return JSONResponse({"detail": "Invitation email is not configured."}, status_code=409)
    try:
        delivery = await run_in_threadpool(
            _invitation_service(request).queue_email,
            actor_account_id=request.state.current_actor.account_id,
            actor_authenticated_at=request.state.current_actor.authenticated_at,
            library_id=request.state.current_actor.current_library_id,
            target_account_id=account_id,
            request_ref=uuid4().hex,
        )
    except RecentAuthenticationRequired:
        return JSONResponse({"detail": "Recent authentication is required."}, status_code=409)
    except PermissionError:
        return JSONResponse({"detail": "Action not permitted."}, status_code=403)
    except Exception:
        return JSONResponse({"detail": "Invitation email is temporarily unavailable."}, status_code=503)
    background_tasks.add_task(_deliver_pending_invitation, request.app, delivery)
    return JSONResponse({"accepted": True}, status_code=202,
                        background=background_tasks)
```

In both disable and break-glass transactions, execute these statements after locking the account and before commit:

```python
connection.execute(
    """
    update app.account_invitation_tokens set revoked_at = %s
    where account_id = %s and consumed_at is null and revoked_at is null
    """, (now, target_account_id),
)
connection.execute(
    """
    update app.account_invitation_transactions set consumed_at = %s
    where consumed_at is null and invitation_token_id in (
      select id from app.account_invitation_tokens where account_id = %s
    )
    """, (now, target_account_id),
)
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `python -m pytest tests/py/test_admin_account_invitations_postgres.py tests/py/test_admin_member_mutation_postgres.py tests/py/test_admin_asgi.py tests/py/test_auth_asgi.py tests/py/test_private_route_boundary.py tests/py/test_auth_break_glass_postgres.py tests/py/test_auth_audit_postgres.py -q`.

Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add music_app/services/admin_account_invitations_postgres.py music_app/services/admin_member_mutation_postgres.py music_app/services/auth_break_glass_postgres.py music_app/services/auth_audit_postgres.py music_app/services/policy.py music_app/services/private_route_boundary.py music_app/routes/admin_asgi.py tests/py/test_admin_account_invitations_postgres.py tests/py/test_admin_member_mutation_postgres.py tests/py/test_auth_break_glass_postgres.py tests/py/test_auth_audit_postgres.py tests/py/test_admin_asgi.py tests/py/test_auth_asgi.py tests/py/test_private_route_boundary.py
git commit -m "feat(admin): rotate managed account invitations"
```

---

### Task 4: Public Invitation Acceptance Lifecycle

**Files:**
- Create: `music_app/services/auth_invitation_lifecycle_postgres.py`
- Create: `music_app/services/auth_invitation_csrf.py`
- Create: `music_app/templates/account-invitation.html`
- Modify: `music_app/services/private_route_boundary.py`
- Modify: `music_app/routes/auth_asgi.py`
- Test: `tests/py/test_auth_invitation_lifecycle_postgres.py`
- Test: `tests/py/test_auth_invitation_csrf.py`
- Test: `tests/py/test_auth_asgi.py`
- Test: `tests/py/test_private_route_boundary.py`
- Test: `tests/py/test_auth_login_postgres.py`

**Interfaces:**
- Consumes: `InvitationCompletionOutcome` and `IssuedInvitationTransaction` from `auth_invitation_models`; do not redefine them.
- Produces: `exchange_invitation_token`, `validate_transaction`, and `complete_invitation`.
- Produces: public GET/POST `/accept-invitation` and cookie `__Host-album_haven_invitation`.
- Consumed by: Task 6.

- [ ] **Step 1: Write lifecycle and public-route tests**

Clone the four reset lifecycle tests `test_exchange_is_single_use_and_returns_redacted_clean_url_state`, `test_replayed_reset_link_is_one_safe_invalid_result`, `test_completion_replaces_credential_increments_version_and_revokes_all_state`, and `test_invalid_or_replayed_lifecycle_state_is_one_safe_result` from `tests/py/test_auth_password_reset_lifecycle_postgres.py`. Apply these exact deltas: `reset_token` → `invitation_token`, update-in-place credential → first credential insert, credential-required join → `left join` plus `credential.account_id is null`, reset purpose → `INVITATION_DB_PURPOSE`, and reset outcome/types → the Task 1 invitation types. Parameterize the invalid-context fixture with `expired`, `revoked`, `consumed`, `disabled`, `credential_exists`, and `rotated`; run the existing two-thread barrier harness once for exchange and once for completion and assert exactly one non-`None`/`SUCCESS` result.

```python
issued = service.exchange_invitation_token(raw_invite, request_ref="b" * 32)
assert issued is not None
assert service.complete_invitation(
    issued.raw_token,
    new_password="Phase Seven Recipient Passphrase 2026!",
    request_ref="c" * 32,
) is InvitationCompletionOutcome.SUCCESS
```

Clone `tests/py/test_auth_password_reset_lifecycle_postgres.py::test_exchange_is_single_use_and_returns_redacted_clean_url_state`, replace reset table/field names with invitation names, and add the losing `ON CONFLICT DO NOTHING` result:

```python
connection.returning_rows = []
assert service.exchange_invitation_token(
    raw_invite, request_ref="d" * 32
) is None
assert connection.committed is True
```

Add the route-level clean-URL assertion:

```python
response = client.get(
    f"/accept-invitation?purpose=account-invitation&token={raw_invite}",
    follow_redirects=False,
)
assert response.status_code == 303
assert response.headers["location"] == "/accept-invitation"
assert response.headers["cache-control"] == "no-store, max-age=0"
assert response.headers["referrer-policy"] == "no-referrer"
cookie = response.cookies["__Host-album_haven_invitation"]
assert raw_invite not in cookie
assert raw_invite not in caplog.text
```

Clone `tests/py/test_auth_asgi.py::test_reset_completion_requires_origin_csrf_and_matching_passwords_then_clears_state` for invitations, changing only the route, cookie, service method, and form field names; retain its trusted-origin and loopback cases exactly. The explicit hostile-origin assertion is:

```python
status, _, _ = _request(
    app,
    "POST",
    path="/accept-invitation",
    headers={
        "origin": "https://evil.test",
        "cookie": f"{INVITATION_COOKIE}={TRANSACTION}",
    },
    form={
        "new_password": "Phase Seven Recipient Passphrase 2026!",
        "confirm_password": "Phase Seven Recipient Passphrase 2026!",
        "csrf_token": INVITATION_CSRF,
    },
)
assert status == 400
assert lifecycle.completed == []
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `python -m pytest tests/py/test_auth_invitation_lifecycle_postgres.py tests/py/test_auth_invitation_csrf.py tests/py/test_auth_asgi.py tests/py/test_private_route_boundary.py tests/py/test_auth_login_postgres.py -q`

Expected: missing lifecycle modules and routes fail.

- [ ] **Step 3: Implement exchange, validation, and completion**

Copy `PostgresPasswordResetLifecycleService.__init__`, `_operation`, `_digest`, `_issued_token`, `_request_ref`, `_row`, `_single_id`, `_require_updated`, `_positive_integer`, `_required_text`, `_timestamp`, `_aware_utc`, and `_connect` from `music_app/services/auth_password_reset_lifecycle_postgres.py`. Rename user-facing failure strings from `Password reset` to `Account invitation`, change the class to `PostgresInvitationLifecycleService`, keep the injected clock/token issuer/password hasher/breach checker/audit contracts unchanged, and expose these signatures: `exchange_invitation_token(raw_invitation_token, *, request_ref) -> IssuedInvitationTransaction | None`, `validate_transaction(raw_transaction) -> bool`, and `complete_invitation(raw_transaction, *, new_password, request_ref) -> InvitationCompletionOutcome`.

Use this eligibility query in exchange; issue a transaction through `issue_opaque_token()`, store only its digest, and return the raw transaction only after commit:

```python
rows = connection.execute(
    """
    select invitation.id as invitation_token_id, account.id as account_id,
           account.username_display, account.contact_email
    from app.account_invitation_tokens invitation
    join app.accounts account on account.id = invitation.account_id
    left join app.account_credentials credential on credential.account_id = account.id
    where invitation.purpose = %s and invitation.token_hash = %s
      and invitation.consumed_at is null and invitation.revoked_at is null
      and invitation.expires_at > %s
      and account.account_kind = 'managed_user'
      and account.is_active is true and account.disabled_at is null
      and credential.account_id is null
    for update of account, invitation
    """, (INVITATION_DB_PURPOSE, digest, now),
).fetchall()
if len(rows) != 1:
    return None
issued = validated_issued_invitation_token(self._token_issuer)
expires_at = now + timedelta(seconds=INVITATION_TRANSACTION_SECONDS)
inserted = connection.execute(
    """
    insert into app.account_invitation_transactions (
      invitation_token_id, transaction_hash, created_at, expires_at
    ) values (%s, %s, %s, %s)
    on conflict (invitation_token_id) do nothing returning id
    """,
    (rows[0]["invitation_token_id"], issued.digest, now, expires_at),
).fetchall()
if not inserted:
    return None
transaction_id = _single_id(inserted, "transaction id")
return IssuedInvitationTransaction(
    raw_token=issued.raw, transaction_id=transaction_id, expires_at=expires_at
)
```

Implement `validate_transaction` with the reset method's digest/error wrapper and this exact query:

```python
rows = connection.execute(
    """
    select transaction.id
    from app.account_invitation_transactions transaction
    join app.account_invitation_tokens invitation
      on invitation.id = transaction.invitation_token_id
    join app.accounts account on account.id = invitation.account_id
    left join app.account_credentials credential on credential.account_id = account.id
    where transaction.transaction_hash = %s
      and transaction.consumed_at is null and transaction.expires_at > %s
      and invitation.purpose = %s
      and invitation.consumed_at is null and invitation.revoked_at is null
      and invitation.expires_at > %s
      and account.account_kind = 'managed_user'
      and account.is_active is true and account.disabled_at is null
      and credential.account_id is null
    """,
    (digest, now, INVITATION_DB_PURPOSE, now),
).fetchall()
return len(rows) == 1
```

For completion, copy the reset method's pre-lock snapshot and password-hash calls exactly, replacing its snapshot query with the validation joins above plus `account.id`, `username_display`, `contact_email`, `invitation.id`, and `transaction.id`. Hash outside a transaction, then lock in this order:

```python
accounts = connection.execute(
    """select id, account_kind, is_active, disabled_at
       from app.accounts where id = %s for update""", (account_id,)
).fetchall()
credentials = connection.execute(
    "select account_id from app.account_credentials where account_id = %s for update",
    (account_id,),
).fetchall()
invitations = connection.execute(
    """select id, account_id, purpose, expires_at, consumed_at, revoked_at
       from app.account_invitation_tokens where id = %s for update""",
    (invitation_token_id,),
).fetchall()
transactions = connection.execute(
    """select id, invitation_token_id, expires_at, consumed_at
       from app.account_invitation_transactions where id = %s
         and transaction_hash = %s for update""",
    (transaction_id, digest),
).fetchall()
connection.execute(
    "select id from app.password_reset_tokens where account_id = %s order by id for update",
    (account_id,),
)
connection.execute(
    "select id from app.account_sessions where account_id = %s order by id for update",
    (account_id,),
)
```

After those locks, require one account/invitation/transaction row, zero credential rows, an active managed account, an unconsumed/unrevoked/unexpired invitation, and an unconsumed/unexpired transaction:

```python
if not (len(accounts) == len(invitations) == len(transactions) == 1):
    return InvitationCompletionOutcome.INVALID
if credentials:
    return InvitationCompletionOutcome.INVALID
account, invitation, transaction = accounts[0], invitations[0], transactions[0]
if not (
    account["account_kind"] == "managed_user"
    and account["is_active"] is True and account["disabled_at"] is None
    and invitation["account_id"] == account_id
    and invitation["purpose"] == INVITATION_DB_PURPOSE
    and invitation["consumed_at"] is None and invitation["revoked_at"] is None
    and _timestamp(invitation["expires_at"]) > now
    and transaction["invitation_token_id"] == invitation_token_id
    and transaction["consumed_at"] is None
    and _timestamp(transaction["expires_at"]) > now
):
    return InvitationCompletionOutcome.INVALID
```

Then insert the first credential exactly as follows:

```python
connection.execute(
    """
    insert into app.account_credentials (
      account_id, encoded_hash, hash_algorithm, hash_policy_version,
      credential_version, administrator_set, password_set_at, updated_at
    ) values (%s, %s, 'argon2id', %s, 1, false, %s, %s)
    """,
    (account_id, credential.encoded_hash, credential.policy_version, now, now),
)
```

Complete the same transaction with exact one-winner predicates:

```python
_require_updated(connection.execute(
    """
    update app.account_invitation_tokens set consumed_at = %s
    where id = %s and consumed_at is null and revoked_at is null
      and expires_at > %s
    """, (now, invitation_token_id, now),
))
_require_updated(connection.execute(
    """
    update app.account_invitation_transactions set consumed_at = %s
    where id = %s and consumed_at is null and expires_at > %s
    """, (now, transaction_id, now),
))
connection.execute(
    """update app.account_invitation_tokens set revoked_at = %s
       where account_id = %s and id <> %s
         and consumed_at is null and revoked_at is null""",
    (now, account_id, invitation_token_id),
)
connection.execute(
    """update app.password_reset_tokens set revoked_at = %s
       where account_id = %s and consumed_at is null and revoked_at is null""",
    (now, account_id),
)
self._audit.append_in_transaction(
    connection,
    category=SecurityAuditCategory.ACCOUNT_INVITATION,
    outcome=SecurityAuditOutcome.SUCCESS,
    reason=InvitationAuditReason.INVITATION_ACCEPTED,
    actor_account_id=None,
    target_account_id=account_id,
    request_ref=request_ref,
    occurred_at=now,
    metadata=None,
)
return InvitationCompletionOutcome.SUCCESS
```

- [ ] **Step 4: Implement the clean-URL route**

Add the route path to the public boundary and `token`/`purpose` to earliest query redaction, then implement the route split exactly like this:

```python
_PUBLIC_AUTH_PATHS = frozenset({
    "/login", "/forgot-password", "/reset-password", "/accept-invitation"
})

def _redact_lifecycle_link_query(request: Request) -> None:
    prefixes = {
        "/reset-password": "password_reset_link",
        "/accept-invitation": "account_invitation_link",
    }
    prefix = prefixes.get(request.url.path)
    if request.method.upper() != "GET" or prefix is None:
        return
    pairs = list(request.query_params.multi_items())
    if not pairs:
        return
    setattr(request.state, f"{prefix}_query_valid", (
        len(pairs) == 2
        and sum(key == "purpose" for key, _ in pairs) == 1
        and sum(key == "token" for key, _ in pairs) == 1
    ))
    setattr(request.state, f"{prefix}_purpose", request.query_params.get("purpose"))
    setattr(request.state, f"{prefix}_token", request.query_params.get("token"))
    request.scope["query_string"] = b""

# Call this as the first statement in the HTTP middleware, replacing
# `_redact_reset_link_query(request)` while preserving its reset state names.
_redact_lifecycle_link_query(request)

INVITATION_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
}
INVITATION_COOKIE = "__Host-album_haven_invitation"

def _invitation_lifecycle(request: Request):
    existing = getattr(request.app.state, "invitation_lifecycle_service", None)
    if existing is not None:
        return existing
    config = _policy_config(request)
    lock = getattr(request.app.state, "auth_service_lock", None)
    if lock is None:
        lock = threading.Lock()
        request.app.state.auth_service_lock = lock
    with lock:
        existing = getattr(request.app.state, "invitation_lifecycle_service", None)
        if existing is None:
            checker = getattr(request.app.state, "breached_password_checker", None)
            if checker is None:
                from music_app.services.auth_breached_passwords import (
                    HibpRangePasswordChecker,
                )
                checker = HibpRangePasswordChecker()
                request.app.state.breached_password_checker = checker
            if not callable(checker):
                raise RuntimeError("Password screening is unavailable.")
            existing = PostgresInvitationLifecycleService(
                config,
                breached_checker=checker,
                audit_repository=PostgresSecurityAuditRepository(),
            )
            request.app.state.invitation_lifecycle_service = existing
    return existing

@router.get("/accept-invitation")
async def accept_invitation_get(request: Request) -> Response:
    query_present = hasattr(request.state, "account_invitation_link_query_valid")
    purpose = getattr(request.state, "account_invitation_link_purpose", None)
    raw = getattr(request.state, "account_invitation_link_token", None)
    if query_present:
        issued = None
        if (request.state.account_invitation_link_query_valid
                and purpose == INVITATION_URL_PURPOSE and raw is not None):
            issued = await run_in_threadpool(
                _invitation_lifecycle(request).exchange_invitation_token,
                raw, request_ref=uuid4().hex,
            )
        response = RedirectResponse("/accept-invitation", status_code=303,
                                    headers=INVITATION_HEADERS)
        if issued is not None:
            response.set_cookie(
                INVITATION_COOKIE, issued.raw_token, max_age=INVITATION_TRANSACTION_SECONDS,
                secure=True, httponly=True, samesite="strict", path="/",
            )
        return response
    transaction = request.cookies.get(INVITATION_COOKIE)
    valid = await run_in_threadpool(
        _invitation_lifecycle(request).validate_transaction, transaction
    )
    return _render_invitation(
        request,
        valid=valid,
        csrf_token=(
            issue_invitation_csrf(transaction, _policy_config(request))
            if valid else None
        ),
        status_code=200 if valid else 400,
    )

@router.post("/accept-invitation")
async def accept_invitation_post(request: Request) -> Response:
    try:
        config = _policy_config(request)
        secure = _cookie_secure(request, config)
    except Exception:
        return _generic_invitation_unavailable()
    if secure is None or not _same_origin(request, config):
        return _generic_invitation_invalid()
    payload = await _form_payload(
        request,
        allowed=frozenset({"new_password", "confirm_password", "csrf_token"}),
        required=frozenset({"new_password", "confirm_password", "csrf_token"}),
    )
    transaction = request.cookies.get(INVITATION_COOKIE)
    if (
        payload is None
        or payload["new_password"] != payload["confirm_password"]
        or not matches_invitation_csrf(
            transaction, payload["csrf_token"], config
        )
    ):
        return _generic_invitation_invalid()
    try:
        outcome = await run_in_threadpool(
            _invitation_lifecycle(request).complete_invitation,
            transaction,
            new_password=payload["new_password"],
            request_ref=uuid4().hex,
        )
    except PasswordPolicyError:
        response = _render_invitation(
            request, valid=True, csrf_token=payload["csrf_token"],
            password_invalid=True,
        )
        response.status_code = 400
        return _invitation_headers(response)
    except Exception:
        return _generic_invitation_unavailable()
    response = (
        _render_invitation(request, completed=True)
        if outcome is InvitationCompletionOutcome.SUCCESS
        else _generic_invitation_invalid()
    )
    response.delete_cookie(
        INVITATION_COOKIE, path="/", secure=secure,
        httponly=True, samesite="strict",
    )
    return response

def _invitation_headers(response: Response) -> Response:
    response.headers["Referrer-Policy"] = "no-referrer"
    return _no_store(response)

def _render_invitation(
    request: Request, *, valid: bool = False, csrf_token: str | None = None,
    completed: bool = False, password_invalid: bool = False,
    status_code: int = 200,
) -> Response:
    templates = getattr(request.app.state, "templates", _FALLBACK_TEMPLATES)
    response = templates.TemplateResponse(
        request,
        "account-invitation.html",
        {
            "request": request, "valid": valid, "csrf_token": csrf_token,
            "completed": completed, "password_invalid": password_invalid,
        },
        status_code=status_code,
    )
    return _invitation_headers(response)

def _generic_invitation_invalid() -> HTMLResponse:
    return _invitation_headers(HTMLResponse(
        "Invitation link is invalid or expired.", status_code=400
    ))

def _generic_invitation_unavailable() -> HTMLResponse:
    return _invitation_headers(HTMLResponse(
        "Invitation is temporarily unavailable.", status_code=503
    ))
```

In `auth_invitation_csrf.py`, mirror the reset-CSRF primitive with an invitation-only domain:

```python
import base64
from collections.abc import Mapping
import hmac
from music_app.services.auth_tokens import hash_opaque_token, keyed_bucket_digest

_DOMAIN = "account-invitation-csrf"

def issue_invitation_csrf(raw_transaction: object,
                          config: Mapping[str, object] | None) -> str:
    if not isinstance(raw_transaction, str):
        raise ValueError("Invitation CSRF input is invalid.")
    hash_opaque_token(raw_transaction)
    payload = config if isinstance(config, Mapping) else {}
    policy = payload.get("hmac") if isinstance(payload.get("hmac"), Mapping) else {}
    secret_value, key_version = policy.get("secret"), policy.get("key_version")
    if not isinstance(secret_value, str) or not isinstance(key_version, int):
        raise ValueError("Invitation CSRF policy is invalid.")
    digest = keyed_bucket_digest(
        secret=secret_value.encode("utf-8"), key_version=key_version,
        domain=_DOMAIN, normalized_value=raw_transaction,
    ).digest
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

def matches_invitation_csrf(raw_transaction: object, supplied_csrf: object,
                            config: Mapping[str, object] | None) -> bool:
    if not isinstance(supplied_csrf, str):
        return False
    try:
        expected = issue_invitation_csrf(raw_transaction, config)
        hash_opaque_token(supplied_csrf)
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(supplied_csrf, expected)
```

Create `account-invitation.html` with the three explicit states:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Accept Album Haven invitation</title>
  <link rel="stylesheet" href="/static/css/password-recovery.css">
</head>
<body><main class="recovery-glow"><section class="recovery-panel">
  {% if completed %}
    <h1>Your password has been created.</h1>
    <a href="/login">Sign in</a>
  {% elif valid %}
    <h1>Accept invitation</h1>
    {% if error %}<p role="alert">{{ error }}</p>{% endif %}
    <form method="post" action="/accept-invitation">
      <input type="hidden" name="csrf_token" value="{{ csrf_token }}">
      <label>New password <input type="password" name="new_password" required autocomplete="new-password"></label>
      <label>Confirm new password <input type="password" name="confirm_password" required autocomplete="new-password"></label>
      <button type="submit">Set password</button>
    </form>
  {% else %}
    <h1>Invitation link is invalid or expired.</h1>
    <p>Ask your administrator for a new invitation.</p>
  {% endif %}
</section></main></body></html>
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `python -m pytest tests/py/test_auth_invitation_lifecycle_postgres.py tests/py/test_auth_invitation_csrf.py tests/py/test_auth_asgi.py tests/py/test_private_route_boundary.py tests/py/test_auth_login_postgres.py -q`.

Expected: all selected tests pass, including race tests.

- [ ] **Step 6: Commit Task 4**

```bash
git add music_app/services/auth_invitation_lifecycle_postgres.py music_app/services/auth_invitation_csrf.py music_app/templates/account-invitation.html music_app/services/private_route_boundary.py music_app/routes/auth_asgi.py tests/py/test_auth_invitation_lifecycle_postgres.py tests/py/test_auth_invitation_csrf.py tests/py/test_auth_asgi.py tests/py/test_private_route_boundary.py tests/py/test_auth_login_postgres.py
git commit -m "feat(auth): accept managed account invitations"
```

---

### Task 5: Invitation Mail Delivery

**Files:**
- Modify: `music_app/services/auth_mail.py`
- Modify: `music_app/services/auth_mail_outbox_postgres.py`
- Modify: `music_app/routes/admin_asgi.py`
- Modify: `music_app/services/admin_mail_actions_postgres.py`
- Test: `tests/py/test_auth_mail.py`
- Test: `tests/py/test_auth_mail_outbox_postgres.py`
- Test: `tests/py/test_admin_mail_actions_postgres.py`
- Test: `tests/py/test_admin_asgi.py`

**Interfaces:**
- Consumes: `InvitationDelivery` from `auth_invitation_models` as introduced in Task 1.
- Produces: `compose_invitation_email`, `PostgresInvitationOutboxService`, and `deliver_invitation`.
- Produces: invitation body with username, expiry guidance, and acceptance URL.
- Consumed by: Task 6 and the local SMTP E2E harness.

- [ ] **Step 1: Write failing composition and outbox tests**

Clone `tests/py/test_auth_mail_outbox_postgres.py::test_password_reset_delivery_claims_matching_active_token_and_finalizes_once` and `test_password_reset_repository_claim_requires_matching_active_digest_and_is_not_retryable`. Apply these exact deltas: use `InvitationDelivery`, require matching `outbox.invitation_token_id`, change category/purpose to the Task 1 constants, replace the credential-required join with `left join ... credential.account_id is null`, and parameterize `revoked_at`, `consumed_at`, `expires_at <= now`, disabled account, and credential-present rows to return `None`. Clone `test_finalize_maps_delivery_outcome_without_retrying_ambiguous_send` without changing its `DeliveryResult` cases, changing only claim/category names to invitation.

Add this exact composition assertion and use the same `InvitationDelivery` fixture for claim tests:

```python
delivery = InvitationDelivery(
    outbox_id=71,
    invitation_token_id=72,
    account_id=41,
    recipient="listener@example.test",
    username="listener.plus",
    raw_token="A" * 43,
    expires_at=datetime(2026, 9, 4, tzinfo=timezone.utc),
)
mail_config = {
    "public_base_url": "https://example.test",
    "sender_address": "no-reply@example.test",
    "sender_name": "Album Haven",
}
message = compose_invitation_email(
    delivery=delivery,
    config=mail_config,
)
body = message.get_body(preferencelist=("plain",)).get_content()
assert "listener.plus" in body
assert "purpose=account-invitation" in body
assert "token=" in body
assert "password" not in body.casefold()
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `python -m pytest tests/py/test_auth_mail.py tests/py/test_auth_mail_outbox_postgres.py tests/py/test_admin_mail_actions_postgres.py tests/py/test_admin_asgi.py -q`

Expected: invitation category and delivery functions are missing.

- [ ] **Step 3: Implement composition and claim/delivery**

Implement the composer with the shared URL purpose and CRLF-safe existing address helpers:

```python
def compose_invitation_email(
    *, delivery: InvitationDelivery, config: Mapping[str, Any]
) -> EmailMessage:
    url = (
        build_public_url(str(config["public_base_url"]), "/accept-invitation")
        + "?"
        + urlencode({
            "purpose": INVITATION_URL_PURPOSE,
            "token": delivery.raw_token,
        })
    )
    _reject_line_breaks(delivery.username, "username")
    _reject_line_breaks(delivery.raw_token, "invitation token")
    return _multipart_message(
        subject="Accept your Album Haven invitation",
        username=delivery.username,
        recipient=delivery.recipient,
        text=(f"Hello {delivery.username},\n\n"
              f"Accept your invitation and choose your password: {url}\n"
              f"This link expires at {delivery.expires_at.isoformat()}.\n"),
        html=(f"<p>Hello {escape(delivery.username)},</p>"
              f'<p><a href="{escape(url, quote=True)}">Accept invitation</a></p>'
              f"<p>This link expires at {escape(delivery.expires_at.isoformat())}.</p>"),
        config=config,
    )
```

Copy `PasswordResetClaim`, `PostgresPasswordResetOutboxService.__init__`, `finalize_password_reset`, and `deliver_password_reset` from `music_app/services/auth_mail_outbox_postgres.py`; rename them to `InvitationClaim`, `PostgresInvitationOutboxService.__init__`, `finalize_invitation`, and `deliver_invitation`. Keep `attempt_count`, `claimed_at`, `DeliveryResult` mapping (`sent`/`unknown`/`failed`), transaction boundaries, and generic exception handling byte-for-byte. In claim/finalize SQL change category to `INVITATION_MESSAGE_CATEGORY`, reset linkage to `invitation_token_id`, and use this exact claim predicate:

```python
rows = connection.execute(
    """
    select outbox.id as outbox_id, invitation.id as invitation_token_id,
           invitation.account_id, account.contact_email, account.username_display,
           invitation.token_hash, invitation.expires_at
    from app.mail_outbox outbox
    join app.account_invitation_tokens invitation
      on invitation.id = outbox.invitation_token_id
    join app.accounts account on account.id = invitation.account_id
    left join app.account_credentials credential on credential.account_id = account.id
    where outbox.id = %s and invitation.id = %s
      and outbox.message_category = %s and outbox.delivery_status = 'pending'
      and invitation.purpose = %s and invitation.consumed_at is null
      and invitation.revoked_at is null and invitation.expires_at > %s
      and account.is_active is true and account.disabled_at is null
      and credential.account_id is null
    for update of outbox, invitation, account
    """,
    (delivery.outbox_id, delivery.invitation_token_id,
     INVITATION_MESSAGE_CATEGORY, INVITATION_DB_PURPOSE, now),
).fetchall()
if len(rows) != 1 or not matches_opaque_token(
    delivery.raw_token, rows[0]["token_hash"]
):
    return None
```

Compose and submit only after the claim transaction commits:

```python
async def deliver_invitation(
    delivery: InvitationDelivery, *, config: Mapping[str, Any], repository,
    composer=compose_invitation_email, sender=send_auth_email,
) -> DeliveryResult:
    claim = repository.claim_invitation(delivery)
    if claim is None:
        return DeliveryResult(delivered=False, reason="not_eligible")
    try:
        message = composer(delivery=delivery, config=config)
        result = await sender(message, config=config)
        if not isinstance(result, DeliveryResult):
            result = DeliveryResult(delivered=False, reason="failed")
    except Exception:
        result = DeliveryResult(delivered=False, reason="failed")
    repository.finalize_invitation(claim, result)
    return result
```

- [ ] **Step 4: Wire account creation and resend background tasks**

Use one helper for both account creation and send routes:

```python
async def _deliver_pending_invitation(app, delivery: InvitationDelivery) -> None:
    callback = getattr(app.state, "invitation_delivery", None)
    if callable(callback):
        await _maybe_await(callback(delivery))
        return
    config = app.state.mail_config
    if config.get("invitation_enabled") is not True:
        return
    await deliver_invitation(
        delivery,
        repository=PostgresInvitationOutboxService(app.state.repository_config),
        config=config,
    )
```

Keep `/admin/accounts/{id}/welcome` restricted to `account_kind == 'bootstrap_owner'`; delete the managed-user welcome menu branch. There must be no `print`, logger call, JSON field, or exception string containing `delivery.raw_token`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `python -m pytest tests/py/test_auth_mail.py tests/py/test_auth_mail_outbox_postgres.py tests/py/test_admin_mail_actions_postgres.py tests/py/test_admin_asgi.py -q`.

Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add music_app/services/auth_mail.py music_app/services/auth_mail_outbox_postgres.py music_app/routes/admin_asgi.py music_app/services/admin_mail_actions_postgres.py tests/py/test_auth_mail.py tests/py/test_auth_mail_outbox_postgres.py tests/py/test_admin_mail_actions_postgres.py tests/py/test_admin_asgi.py
git commit -m "feat(mail): deliver managed account invitations"
```

---

### Task 6: Pending-State Admin UI And Copy Menu

**Files:**
- Modify: `music_app/services/admin_members_postgres.py`
- Modify: `music_app/templates/admin-account-detail.html`
- Modify: `music_app/templates/admin-members.html`
- Modify: `music_app/static/js/admin-members.js`
- Modify: `music_app/static/css/admin-members.css`
- Test: `tests/py/test_admin_members_postgres.py`
- Test: `tests/py/test_admin_members_asgi.py`
- Test: `tests/js/runtime/admin-members.test.js`

**Interfaces:**
- Consumes: copy/send endpoints and `AdminMemberSummary.has_credential` / `account_status`.
- Produces: accessible three-dot menu, copy fallback panel, and invitation-only create payload.
- Consumed by: Task 7.

- [ ] **Step 1: Write failing roster and JavaScript tests**

Clone `tests/py/test_admin_members_postgres.py::test_member_roster_revalidates_owner_and_returns_bounded_operational_summary`, add one credential row for the enabled case and no credential row for the pending case, then assert the three exact `_account_status` outputs from Step 3. In `tests/js/runtime/admin-members.test.js`, clone `admin add-user form sends only the bounded JSON contract with session CSRF` and replace its password payload with the invitation-only payload below; clone `admin mail actions use distinct endpoints and show ambiguous delivery status` for copy/send, changing endpoints to `/invitation/copy` and `/invitation/send`, and drive Escape, outside pointerdown, focusout, Clipboard resolve/reject, and one 409→reauthenticate→retry sequence through the DOM harness.

```javascript
assert.deepEqual(JSON.parse(fetchCall.options.body), {
  username: 'listener.plus',
  contact_email: 'listener+phase7@example.test',
  capability_keys: ['library.browse.read'],
  send_invitation: false,
});
```

Add the menu and fallback assertions:

```javascript
assert.equal(row.menuButton.getAttribute('aria-haspopup'), 'menu');
await row.menuButton.click();
assert.equal(row.menuButton.getAttribute('aria-expanded'), 'true');
await row.copyInvite.click();
assert.deepEqual(fetchCall.url, '/admin/accounts/41/invitation/copy');
assert.equal(clipboard.value, 'https://example.test/accept-invitation?token=rotated');
clipboard.reject = true;
await row.copyInvite.click();
assert.equal(fallback.hidden, false);
assert.equal(fallback.input.readOnly, true);
assert.equal(fallback.input.value, 'https://example.test/accept-invitation?token=newer');
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/js/runtime/admin-members.test.js`

Run after the Node process exits: `python -m pytest tests/py/test_admin_members_postgres.py tests/py/test_admin_members_asgi.py -q`

Expected: old password form, Edit-only row, and enabled-only status contracts fail.

- [ ] **Step 3: Add credential-aware roster projection and templates**

Extend `AdminMemberSummary` with exact fields and derive status in one place:

```python
@dataclass(frozen=True, slots=True)
class AdminMemberSummary:
    account_id: int
    username: str
    contact_email: str
    is_active: bool
    is_bootstrap_owner: bool
    membership_role: str | None
    capability_keys: tuple[str, ...]
    welcome_status: str | None
    active_session_count: int
    last_active_at: datetime | None
    has_credential: bool
    account_status: str
    invitation_delivery_status: str | None


def _account_status(*, is_active: bool, has_credential: bool) -> str:
    if not is_active:
        return "Disabled"
    return "Enabled" if has_credential else "Pending invitation"
```

Add these query projections and map them without inferring credential state from mail:

```sql
(credential.account_id is not null) as has_credential,
invitation_delivery.delivery_status as invitation_delivery_status
```

```sql
left join app.account_credentials credential on credential.account_id = account.id
left join lateral (
  select delivery_status
  from app.mail_outbox
  where account_id = account.id and message_category = 'account_invitation'
  order by created_at desc, id desc limit 1
) invitation_delivery on true
```

Render the menu with eligibility determined server-side:

```html
<div class="member-actions">
<button type="button" class="member-actions-trigger"
        aria-label="Actions for {{ member.username }}"
        aria-haspopup="menu" aria-expanded="false"
        data-member-menu-trigger="{{ member.account_id }}">⋯</button>
<div class="member-actions-menu" role="menu" hidden data-member-menu="{{ member.account_id }}">
  {% if member.account_status == 'Pending invitation' %}
    <button role="menuitem" data-copy-invitation="{{ member.account_id }}">Copy invite link</button>
    {% if invitation_email_enabled %}
      <button role="menuitem" data-send-invitation="{{ member.account_id }}">Send invitation email</button>
    {% endif %}
  {% endif %}
  <a role="menuitem" href="/admin/accounts/{{ member.account_id }}">Edit</a>
</div>
</div>
```

Place the table and the following controls inside `<section data-admin-roster data-csrf-token="{{ csrf_token }}">`:

```html
<p data-admin-roster-status role="status" aria-live="polite" hidden></p>
<p data-admin-roster-error role="alert" hidden></p>
<section class="invitation-copy-fallback" data-invitation-copy-fallback hidden
         aria-labelledby="invitation-copy-title">
  <h2 id="invitation-copy-title">Copy invitation link</h2>
  <label for="invitation-copy-value">Invitation link</label>
  <input id="invitation-copy-value" data-invitation-copy-value type="text" readonly>
  <button type="button" data-invitation-copy-manual>Copy</button>
  <button type="button" data-invitation-copy-dismiss>Dismiss</button>
</section>
<section data-roster-reauth-panel hidden aria-labelledby="roster-reauth-title">
  <h2 id="roster-reauth-title">Confirm your administrator password</h2>
  <label for="roster-reauth-password">Password</label>
  <input id="roster-reauth-password" data-roster-reauth-password
         type="password" autocomplete="current-password">
  <button type="button" data-roster-reauth-submit>Continue</button>
  <button type="button" data-roster-reauth-cancel>Cancel</button>
</section>
```

Add these minimal menu/fallback styles to `admin-members.css`:

```css
.member-actions { position: relative; }
.member-actions-trigger { min-width: 2.75rem; min-height: 2.75rem; }
.member-actions-menu {
  position: absolute; right: 0; z-index: 10; min-width: 13rem;
  display: grid; padding: .35rem; border: 1px solid var(--border-color);
  border-radius: .6rem; background: var(--panel-background);
}
.member-actions-menu[hidden], .invitation-copy-fallback[hidden] { display: none; }
.invitation-copy-fallback input[readonly] { width: 100%; font-family: monospace; }
```

Remove the password inputs and use this creation copy:

```html
<p>The user will choose their password after opening a one-time invitation link.</p>
<label><input type="checkbox" name="send_invitation"
  {% if invitation_email_enabled %}checked{% endif %}>
  Send invitation email</label>
```

- [ ] **Step 4: Implement menu, clipboard, fallback, and create payload**

Initialize roster behavior before the existing `if (!form) return` and close it through one helper:

```javascript
const roster = document.querySelector('[data-admin-roster]');
const rosterStatus = roster?.querySelector('[data-admin-roster-status]');
const rosterError = roster?.querySelector('[data-admin-roster-error]');
const fallback = roster?.querySelector('[data-invitation-copy-fallback]');
const fallbackValue = roster?.querySelector('[data-invitation-copy-value]');
const reauthPanel = roster?.querySelector('[data-roster-reauth-panel]');
const reauthPassword = roster?.querySelector('[data-roster-reauth-password]');
let rosterRetry = null;

function announce(message) {
  if (!rosterStatus) return;
  rosterStatus.textContent = message;
  rosterStatus.hidden = false;
}

function clearInvitationFallback() {
  if (fallbackValue) fallbackValue.value = '';
  if (fallback) fallback.hidden = true;
}

function showInvitationFallback(url) {
  if (!fallback || !fallbackValue) return;
  fallbackValue.value = url;
  fallback.hidden = false;
  fallbackValue.focus();
  fallbackValue.select();
}

async function rosterRequest(url, payload = {}) {
  return fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Album-Haven-CSRF': roster?.dataset.csrfToken || '',
    },
    body: JSON.stringify(payload),
  });
}

function reauthenticateThen(retry) {
  rosterRetry = retry;
  if (reauthPanel) reauthPanel.hidden = false;
  if (reauthPassword) { reauthPassword.value = ''; reauthPassword.focus(); }
}

function closeMenu(trigger, menu) {
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
}

for (const trigger of document.querySelectorAll('[data-member-menu-trigger]')) {
  const menu = document.querySelector(`[data-member-menu="${trigger.dataset.memberMenuTrigger}"]`);
  trigger.addEventListener('click', () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) menu.querySelector('[role="menuitem"]')?.focus();
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeMenu(trigger, menu);
      trigger.focus();
    }
  });
  menu.addEventListener('focusout', event => {
    if (!menu.contains(event.relatedTarget) && event.relatedTarget !== trigger) {
      closeMenu(trigger, menu);
    }
  });
}
document.addEventListener('pointerdown', event => {
  for (const menu of document.querySelectorAll('[data-member-menu]:not([hidden])')) {
    const trigger = document.querySelector(`[data-member-menu-trigger="${menu.dataset.memberMenu}"]`);
    if (!menu.contains(event.target) && !trigger.contains(event.target)) closeMenu(trigger, menu);
  }
});
```

Call the copy endpoint, then:

```javascript
try {
  await navigator.clipboard.writeText(result.invitation_url);
  announce('Invitation link copied. Older links no longer work.');
} catch {
  showInvitationFallback(result.invitation_url);
}
```

Use this exact request and transient fallback behavior:

```javascript
async function copyInvitation(accountId) {
  const response = await rosterRequest(`/admin/accounts/${encodeURIComponent(accountId)}/invitation/copy`);
  if (response.status === 409) return reauthenticateThen(() => copyInvitation(accountId));
  if (!response.ok) throw new Error('Invitation link could not be created.');
  const result = await response.json();
  clearInvitationFallback();
  try {
    await navigator.clipboard.writeText(result.invitation_url);
    announce('Invitation link copied. Older links no longer work.');
  } catch {
    showInvitationFallback(result.invitation_url);
  }
}

async function sendInvitation(accountId) {
  const response = await rosterRequest(
    `/admin/accounts/${encodeURIComponent(accountId)}/invitation/send`
  );
  if (response.status === 409) return reauthenticateThen(() => sendInvitation(accountId));
  if (!response.ok) throw new Error('Invitation email could not be queued.');
  announce('Invitation email queued. Older invitation links no longer work.');
}

for (const button of document.querySelectorAll('[data-copy-invitation]')) {
  button.addEventListener('click', () => copyInvitation(button.dataset.copyInvitation)
    .catch(error => { if (rosterError) { rosterError.textContent = error.message; rosterError.hidden = false; } }));
}
for (const button of document.querySelectorAll('[data-send-invitation]')) {
  button.addEventListener('click', () => sendInvitation(button.dataset.sendInvitation)
    .catch(error => { if (rosterError) { rosterError.textContent = error.message; rosterError.hidden = false; } }));
}

roster?.querySelector('[data-invitation-copy-dismiss]')?.addEventListener(
  'click', clearInvitationFallback
);
roster?.querySelector('[data-invitation-copy-manual]')?.addEventListener('click', async () => {
  if (!fallbackValue) return;
  try { await navigator.clipboard.writeText(fallbackValue.value); announce('Invitation link copied.'); }
  catch { fallbackValue.focus(); fallbackValue.select(); }
});
roster?.querySelector('[data-roster-reauth-cancel]')?.addEventListener('click', () => {
  rosterRetry = null;
  if (reauthPanel) reauthPanel.hidden = true;
});
roster?.querySelector('[data-roster-reauth-submit]')?.addEventListener('click', async () => {
  const response = await rosterRequest('/admin/reauthenticate', {
    password: reauthPassword?.value || '',
  });
  if (!response.ok) throw new Error('Reauthentication failed.');
  if (reauthPanel) reauthPanel.hidden = true;
  const retry = rosterRetry;
  rosterRetry = null;
  await retry?.();
});
```

Construct the invitation-only form body exactly as follows:

```javascript
const payload = {
  username: form.elements.username.value,
  contact_email: form.elements.contact_email.value,
  capability_keys: new FormData(form).getAll('capability_keys').map(String),
  send_invitation: form.elements.send_invitation.checked,
};
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/js/runtime/admin-members.test.js`.

After Node exits, run: `python -m pytest tests/py/test_admin_members_postgres.py tests/py/test_admin_members_asgi.py -q`.

Expected: both focused suites pass.

- [ ] **Step 6: Commit Task 6**

```bash
git add music_app/services/admin_members_postgres.py music_app/templates/admin-account-detail.html music_app/templates/admin-members.html music_app/static/js/admin-members.js music_app/static/css/admin-members.css tests/py/test_admin_members_postgres.py tests/py/test_admin_members_asgi.py tests/js/runtime/admin-members.test.js
git commit -m "feat(admin): add pending invitation roster actions"
```

---

### Task 7: Playwright, CI Contract, And Operator Documentation

**Files:**
- Modify: `tests/e2e/support/phase7AuthApp.py`
- Modify: `tests/e2e/phase7/poms/authPages.js`
- Modify: `tests/e2e/phase7/actions/authActions.js`
- Modify: `tests/e2e/phase7/admin-management/adminManagement.spec.js`
- Modify if contract assertions require: `.github/workflows/pr-gates.yml`
- Modify: `docs/local-auth-setup-and-manual-tests.md`
- Modify: `../album-haven-internal/docs/superpowers/specs/2026-07-21-phase-7-local-auth-account-management-design.md`
- Modify: `../album-haven-internal/docs/phase-7-TASKS.md`
- Modify: `../album-haven-internal/docs/migration-plan.md`
- Modify: `../album-haven-internal/docs/functional-test-cases.md`
- Modify: `../album-haven-internal/docs/functional-test-cases/users-and-permissions.md`

**Interfaces:**
- Consumes: all production interfaces from Tasks 1 through 6.
- Produces: independently runnable admin-management copy-link and local-SMTP scenarios.
- Produces: manual cases and configuration instructions matching released behavior.

- [ ] **Step 1: Write the failing Playwright invitation scenarios**

Replace the active-before-welcome case with:

```javascript
test('creates, rotates, accepts, and signs in through a copied invitation', async ({ page, freshBrowserSession }) => {
  await signIn(page);
  const members = new MembersPage(page);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({ ...LISTENER, sendInvitation: false });
  await members.submitCreateUser();
  const firstUrl = await members.copyInviteLink(LISTENER.username);
  const secondUrl = await members.copyInviteLink(LISTENER.username);
  const recipient = await freshBrowserSession.create();
  await recipient.page.goto(invitationPathFrom(firstUrl));
  await expect(recipient.page.getByText('Invitation link is invalid or expired.')).toBeVisible();
  await recipient.page.goto(invitationPathFrom(secondUrl));
  await new InvitationPage(recipient.page).complete(LISTENER.password);
  await signIn(recipient.page, LISTENER, '/account');
  await recipient.page.goto(invitationPathFrom(secondUrl));
  await expect(recipient.page.getByText('Invitation link is invalid or expired.')).toBeVisible();
});

test('delivers a usable invitation through the local SMTP capture server', async ({ page, freshBrowserSession }) => {
  await signIn(page);
  const members = new MembersPage(page);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({ ...SMTP_LISTENER, sendInvitation: true });
  await members.submitCreateUser();
  const message = await waitForMessage(SMTP_LISTENER.email);
  expect(message.body).not.toContain(SMTP_LISTENER.password);
  const recipient = await freshBrowserSession.create();
  await recipient.page.goto(invitationPathFrom(message.body));
  await new InvitationPage(recipient.page).complete(SMTP_LISTENER.password);
  await signIn(recipient.page, SMTP_LISTENER, '/account');
});
```

Grant clipboard read/write permissions or assert the fallback field. Do not contact an external SMTP host.

- [ ] **Step 2: Run the new Playwright scenarios and verify RED**

Run: `npm run test:e2e:phase7:admin`.

Expected: the new invitation scenarios fail because the pending-user form, copy action, invitation page object, and invitation delivery path do not exist yet. Audit and close the owned Playwright/application/browser/Python/Node/SMTP process tree before continuing.

- [ ] **Step 3: Update harness, page objects, and database projections**

Add only the invitation flags to the existing E2E environment mapping; retain its forced loopback values exactly:

```python
app_env.update({
    "ALBUM_HAVEN_INVITATION_EMAIL_ENABLED": "true",
    "ALBUM_HAVEN_INVITATION_TOKEN_SECONDS": "259200",
    "ALBUM_HAVEN_SMTP_HOST": "127.0.0.1",
    "ALBUM_HAVEN_SMTP_PORT": str(args.smtp_port),
})
```

Expose hash-free database state only:

```sql
select account_id, expires_at, consumed_at, revoked_at
from app.account_invitation_tokens where account_id = %s order by id;
select invitation_token_id, expires_at, consumed_at
from app.account_invitation_transactions
where invitation_token_id in (
  select id from app.account_invitation_tokens where account_id = %s
) order by id;
select account_id, administrator_set, credential_version
from app.account_credentials where account_id = %s;
```

Add these exact page-object methods:

```javascript
async fillCreateUser({ username, email, sendInvitation }) {
  await this.page.getByLabel('Username').fill(username);
  await this.page.getByLabel('Contact email').fill(email);
  await this.page.getByLabel('Send invitation email').setChecked(sendInvitation);
}

async copyInviteLink(username) {
  const row = this.page.getByRole('row', { name: new RegExp(username) });
  await row.getByRole('button', { name: `Actions for ${username}` }).click();
  await row.getByRole('menuitem', { name: 'Copy invite link' }).click();
  const fallback = this.page.getByLabel('Invitation link');
  if (await fallback.isVisible()) return fallback.inputValue();
  return this.page.evaluate(() => navigator.clipboard.readText());
}

export class InvitationPage {
  constructor(page) { this.page = page; }
  async complete(password) {
    await this.page.getByLabel('New password').fill(password);
    await this.page.getByLabel('Confirm new password').fill(password);
    await this.page.getByRole('button', { name: 'Set password' }).click();
    await expect(this.page.getByText('Your password has been created.')).toBeVisible();
  }
}

export function invitationPathFrom(text) {
  const match = text.match(/https:\/\/[^\s<>]+\/accept-invitation\?[^\s<>]+/);
  if (!match) throw new Error('Invitation URL was not found.');
  const url = new URL(match[0]);
  return `${url.pathname}${url.search}`;
}
```

- [ ] **Step 4: Run focused Phase 7 suites and verify GREEN**

Run `npm run test:e2e:phase7:auth`, audit its owned process tree, then run `npm run test:e2e:phase7:admin`.

Expected: both suites pass and no application, browser, Node, Python, Playwright, or SMTP process remains.

- [ ] **Step 5: Update durable documentation**

Add this operator block to `docs/local-auth-setup-and-manual-tests.md` and mirror the same decision language in the listed private architecture/tracker documents:

```markdown
### Managed-user invitations

Creating a managed user creates a **Pending invitation** account with no password.
The administrator can choose **Send invitation email** when SMTP is configured,
or use **Copy invite link** from the user's three-dot menu. Every copy or send
creates a new 72-hour link and invalidates older links. The recipient opens the
current link, chooses their own password, then signs in normally.

For real delivery, set `ALBUM_HAVEN_PUBLIC_BASE_URL`,
`ALBUM_HAVEN_INVITATION_EMAIL_ENABLED=true`, and the documented
`ALBUM_HAVEN_SMTP_*` variables. Phase 7 E2E ignores those operator SMTP values:
its application process is forced to its own `127.0.0.1` capture server.

Manual checks: current-link acceptance, rotated-link rejection, replay rejection,
expired-link rejection, disabled-account rejection, and resend recovery.
```

Add these exact cases to `functional-test-cases/users-and-permissions.md`:

```markdown
### Copying an invitation rotates the prior link
Given an enabled pending managed account and a recently authenticated owner
When the owner copies its invitation twice
Then the first URL is invalid and only the second URL can reach password setup

### Sending an invitation uses configured SMTP without exposing its token
Given invitation email and SMTP are configured
When the owner sends an invitation to a pending managed account
Then one linked outbox message is delivered and no raw token appears in logs or audit data

### Accepting an invitation creates the recipient-owned first credential
Given a current invitation URL for a pending account
When the recipient chooses a policy-compliant password and confirms it
Then one non-administrator-set credential is created and normal sign-in succeeds

### Expired, replayed, rotated, and disabled-account invitations fail generically
Given invitation URLs in each invalid lifecycle state
When each URL is opened
Then each renders the same token-free invalid-or-expired result

### Phase 7 E2E forces loopback SMTP and cannot use operator SMTP credentials
Given operator SMTP variables are present in the parent environment
When the Phase 7 admin-management suite starts its application
Then the child process uses its owned `127.0.0.1` SMTP capture host and port
```

- [ ] **Step 6: Re-run focused tests after documentation and harness changes**

Run `npm run check:e2e-production-parity`, `npm run test:e2e:phase7:auth`, and then `npm run test:e2e:phase7:admin` sequentially. Expected: all selected checks pass. Preserve logs and audit exact process trees after interruption or failure.

- [ ] **Step 7: Commit Task 7 before the final full-suite rerun**

```bash
git add tests/e2e/support/phase7AuthApp.py tests/e2e/phase7/poms/authPages.js tests/e2e/phase7/actions/authActions.js tests/e2e/phase7/admin-management/adminManagement.spec.js .github/workflows/pr-gates.yml docs/local-auth-setup-and-manual-tests.md
git commit -m "test(auth): cover managed invitation lifecycle"
git -C ../album-haven-internal add docs/superpowers/specs/2026-07-21-phase-7-local-auth-account-management-design.md docs/phase-7-TASKS.md docs/migration-plan.md docs/functional-test-cases.md docs/functional-test-cases/users-and-permissions.md
git -C ../album-haven-internal commit -m "docs(auth): record managed invitation lifecycle"
```

After committing, run these commands sequentially so the final evidence comes from a committed state:

```text
npm test
npm run test:js:all
npm run test:component
npm run check:e2e-production-parity
npm run test:e2e:phase7:auth
npm run test:e2e:phase7:admin
npm run test:e2e:functional
npm run test:e2e:performance
```

- [ ] **Step 8: Perform repository review and publish without merging**

Follow the private Branch Review Process Flow: deterministic diff/status review, local Codex review, `caveman-review`, `requesting-code-review`, `receiving-code-review`, reconciliation, and final verification. Commit through the designated commit subagent, push the current branch, update PR #1, wait for all PR checks and reviews, apply valid findings, and rerun affected/full gates. Leave the PR open for owner local testing.
