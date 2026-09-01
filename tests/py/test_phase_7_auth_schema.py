from __future__ import annotations

import re
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = (
    REPO_ROOT / "migrations" / "postgres" / "0001_create_current_stack_schemas.sql"
)
MIGRATION_PATH = (
    REPO_ROOT / "migrations" / "postgres" / "0046_add_local_auth_lifecycle.sql"
)
INVITATION_MIGRATION_PATH = (
    REPO_ROOT
    / "migrations"
    / "postgres"
    / "0052_add_managed_account_invitations.sql"
)


def _normalized_sql(sql: str) -> str:
    without_line_comments = re.sub(r"--.*", " ", sql)
    return re.sub(r"\s+", " ", without_line_comments.lower()).strip()


def _table_definition(sql: str, qualified_name: str) -> str:
    match = re.search(
        rf"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?"
        rf"{re.escape(qualified_name)}\s*\((.*?)\)\s*;",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    return _normalized_sql(match.group(1)) if match else ""


def _index_statements(sql: str) -> list[str]:
    return [
        _normalized_sql(match.group(0))
        for match in re.finditer(
            r"\bcreate\s+(?:unique\s+)?index\b[^;]*;",
            sql,
            re.IGNORECASE | re.DOTALL,
        )
    ]


def _assert_has_index(sql: str, table: str, *columns: str) -> None:
    matching = [statement for statement in _index_statements(sql) if f" on {table} " in statement]
    assert matching, f"missing index on {table}"
    assert any(all(re.search(rf"\b{re.escape(column)}\b", statement) for column in columns) for statement in matching), (
        f"missing {table} index covering {', '.join(columns)}"
    )


def _granted_privileges(sql: str, role: str, table: str) -> set[str]:
    privileges: set[str] = set()
    normalized = _normalized_sql(sql)
    for match in re.finditer(
        rf"\bgrant\s+([^;]+?)\s+on\s+(?:table\s+)?([^;]+?)\s+to\s+{re.escape(role)}\b",
        normalized,
    ):
        tables = {item.strip() for item in match.group(2).split(",")}
        if table not in tables:
            continue
        privileges.update(item.strip() for item in match.group(1).split(","))
    return privileges


@pytest.fixture
def auth_schema_sql() -> str:
    if not MIGRATION_PATH.exists():
        pytest.skip(
            "Phase 7 auth migration is not present yet; the presence test captures the TDD red state"
        )
    return MIGRATION_PATH.read_text(encoding="utf-8")


@pytest.fixture
def invitation_schema_sql() -> str:
    if not INVITATION_MIGRATION_PATH.exists():
        pytest.skip(
            "managed-account invitation migration is not present yet; the presence "
            "test captures the TDD red state"
        )
    return INVITATION_MIGRATION_PATH.read_text(encoding="utf-8")


def test_phase_7_auth_schema_migration_exists() -> None:
    assert MIGRATION_PATH.exists(), (
        "missing Phase 7 auth migration: "
        "migrations/postgres/0046_add_local_auth_lifecycle.sql"
    )


def test_managed_account_invitation_schema_migration_exists() -> None:
    assert INVITATION_MIGRATION_PATH.exists(), (
        "missing managed-account invitation migration: "
        "migrations/postgres/0052_add_managed_account_invitations.sql"
    )


def test_invitation_tokens_store_only_purpose_bound_hashes_and_one_active_token(
    invitation_schema_sql: str,
) -> None:
    table = _table_definition(
        invitation_schema_sql, "app.account_invitation_tokens"
    )
    assert table
    assert {
        "account_id",
        "token_hash",
        "purpose",
        "created_at",
        "expires_at",
        "consumed_at",
        "revoked_at",
        "request_ref",
    }.issubset(set(table.split()))
    assert "references app.accounts(id) on delete cascade" in table
    assert "octet_length(token_hash) = 32" in table
    assert "purpose = 'account_invitation'" in table
    assert "expires_at > created_at" in table
    assert not re.search(r"\braw_token\b|\btoken_value\b|\binvitation_url\b", table)

    indexes = _index_statements(invitation_schema_sql)
    assert any(
        "unique index" in statement
        and " on app.account_invitation_tokens " in statement
        and "purpose" in statement
        and "token_hash" in statement
        for statement in indexes
    )
    assert any(
        "unique index" in statement
        and "account_invitation_tokens_active_account_idx" in statement
        and "account_id" in statement
        and "consumed_at is null" in statement
        and "revoked_at is null" in statement
        for statement in indexes
    )


def test_invitation_transactions_are_hash_only_expiring_single_use_exchanges(
    invitation_schema_sql: str,
) -> None:
    table = _table_definition(
        invitation_schema_sql, "app.account_invitation_transactions"
    )
    assert table
    assert "invitation_token_id bigint not null unique" in table
    assert "references app.account_invitation_tokens(id) on delete cascade" in table
    assert "transaction_hash bytea not null unique" in table
    assert "octet_length(transaction_hash) = 32" in table
    assert "expires_at > created_at" in table
    assert "consumed_at" in table
    assert not re.search(r"\braw_token\b|\btoken_value\b|\binvitation_url\b", table)

    indexes = _index_statements(invitation_schema_sql)
    assert any(
        "account_invitation_transactions_token_idx" in statement
        and "invitation_token_id" in statement
        for statement in indexes
    )
    assert any(
        "account_invitation_transactions_active_expiry_idx" in statement
        and "expires_at" in statement
        and "consumed_at is null" in statement
        for statement in indexes
    )


def test_invitation_migration_links_outbox_and_preserves_bounded_categories(
    invitation_schema_sql: str,
) -> None:
    sql = _normalized_sql(invitation_schema_sql)
    assert "alter table app.mail_outbox" in sql
    assert "invitation_token_id bigint" in sql
    assert "references app.account_invitation_tokens(id) on delete set null" in sql
    assert any(
        "mail_outbox_invitation_token_idx" in statement
        and " on app.mail_outbox " in statement
        and "invitation_token_id" in statement
        and "where invitation_token_id is not null" in statement
        for statement in _index_statements(invitation_schema_sql)
    )
    assert (
        "message_category in ('welcome', 'password_reset', 'account_invitation')"
        in sql
    )


def test_invitation_tables_have_secret_bounded_runtime_grants(
    invitation_schema_sql: str,
) -> None:
    for table in (
        "app.account_invitation_tokens",
        "app.account_invitation_transactions",
    ):
        assert _granted_privileges(
            invitation_schema_sql, "album_haven_readonly", table
        ) == set()

    assert _granted_privileges(
        invitation_schema_sql, "album_haven_app", "app.account_invitation_tokens"
    ) == {"select", "insert", "update"}
    assert _granted_privileges(
        invitation_schema_sql,
        "album_haven_app",
        "app.account_invitation_transactions",
    ) == {"select", "insert", "update", "delete"}
    assert _granted_privileges(
        invitation_schema_sql,
        "album_haven_migrator",
        "app.account_invitation_tokens",
    ) == {"all privileges"}
    assert _granted_privileges(
        invitation_schema_sql,
        "album_haven_migrator",
        "app.account_invitation_transactions",
    ) == {"all privileges"}

    sql = _normalized_sql(invitation_schema_sql)
    for sequence in (
        "app.account_invitation_tokens_id_seq",
        "app.account_invitation_transactions_id_seq",
    ):
        assert f"revoke all on sequence {sequence} from album_haven_readonly" in sql
        assert f"grant usage, select on sequence {sequence} to album_haven_app" in sql
        assert (
            f"grant all privileges on sequence {sequence} to album_haven_migrator"
            in sql
        )


def test_accounts_gain_normalized_identity_contact_and_disabled_fields(
    auth_schema_sql: str,
) -> None:
    sql = _normalized_sql(auth_schema_sql)
    required_columns = {
        "username_display",
        "username_normalized",
        "contact_email",
        "contact_email_normalized",
        "disabled_at",
        "disabled_reason",
    }
    assert "alter table app.accounts" in sql
    assert sorted(column for column in required_columns if column not in sql) == []
    assert re.search(r"username_normalized\s+text[^;]*(?:not\s+null|set\s+not\s+null)", sql)
    assert re.search(r"contact_email_normalized\s+text[^;]*(?:not\s+null|set\s+not\s+null)", sql)
    assert re.search(
        r"create\s+unique\s+index[^;]+on\s+app\.accounts\s*\([^)]*username_normalized",
        sql,
    )
    assert re.search(
        r"create\s+unique\s+index[^;]+on\s+app\.accounts\s*\([^)]*contact_email_normalized",
        sql,
    )
    assert "username_display <> ''" in sql or "length(username_display)" in sql
    assert "contact_email_normalized <> ''" in sql or "length(contact_email_normalized)" in sql


def test_account_credentials_are_focused_versioned_argon2_records(
    auth_schema_sql: str,
) -> None:
    table = _table_definition(auth_schema_sql, "app.account_credentials")
    assert table
    required = {
        "account_id",
        "encoded_hash",
        "hash_policy_version",
        "credential_version",
        "administrator_set",
        "password_set_at",
    }
    assert sorted(column for column in required if column not in table) == []
    assert "references app.accounts(id)" in table
    assert "on delete cascade" in table
    assert "unique" in table or "primary key" in table
    assert "argon2id" in table
    assert "credential_version > 0" in table or "credential_version >= 1" in table
    assert not re.search(r"\b(?:plain(?:text)?_?password|reversible_password|password_history)\b", table)


def test_password_reset_tokens_store_only_purpose_bound_hashes_and_versions(
    auth_schema_sql: str,
) -> None:
    table = _table_definition(auth_schema_sql, "app.password_reset_tokens")
    assert table
    required = {
        "account_id",
        "token_hash",
        "purpose",
        "credential_version",
        "created_at",
        "expires_at",
        "consumed_at",
        "revoked_at",
        "request_ref",
    }
    assert sorted(column for column in required if column not in table) == []
    assert "references app.accounts(id)" in table
    assert "octet_length(token_hash) = 32" in table
    assert "password_reset" in table
    assert "expires_at > created_at" in table
    assert not re.search(r"\braw_token\b|\btoken_value\b|\breset_link\b", table)

    indexes = _index_statements(auth_schema_sql)
    active = [
        statement
        for statement in indexes
        if " on app.password_reset_tokens " in statement
        and " where " in statement
        and "consumed_at is null" in statement
        and "revoked_at is null" in statement
    ]
    assert active, "missing structurally-active reset-token index"
    assert any("unique index" in statement and "account_id" in statement for statement in active)
    assert any("purpose" in statement for statement in active)


def test_auth_throttles_are_durable_versioned_queryable_buckets(
    auth_schema_sql: str,
) -> None:
    table = _table_definition(auth_schema_sql, "app.auth_throttles")
    assert table
    required = {
        "bucket_kind",
        "bucket_hash",
        "key_version",
        "window_started_at",
        "window_expires_at",
        "failure_count",
        "blocked_until",
        "updated_at",
    }
    assert sorted(column for column in required if column not in table) == []
    assert "octet_length(bucket_hash)" in table
    assert "failure_count >= 0" in table
    assert "window_expires_at > window_started_at" in table
    assert all(
        bucket in table
        for bucket in (
            "login_account",
            "login_source",
            "reset_candidate",
            "reset_account",
            "reset_source",
            "welcome_account",
        )
    )
    _assert_has_index(auth_schema_sql, "app.auth_throttles", "bucket_kind", "key_version", "bucket_hash")


def test_account_sessions_have_hashed_tokens_bounded_lifetimes_and_revocation(
    auth_schema_sql: str,
) -> None:
    sql = _normalized_sql(auth_schema_sql)
    assert "alter table app.account_sessions" in sql
    required = {
        "session_token_hash",
        "authenticated_at",
        "last_seen_at",
        "idle_expires_at",
        "absolute_expires_at",
        "revoked_at",
        "revocation_reason",
    }
    assert sorted(column for column in required if column not in sql) == []
    assert "octet_length(session_token_hash) = 32" in sql
    assert "absolute_expires_at > created_at" in sql
    assert "idle_expires_at <= absolute_expires_at" in sql
    assert "char_length(user_agent)" in sql or "length(user_agent)" in sql


def test_legacy_sessions_are_hashed_revoked_and_backfilled_with_locked_lifetimes(
    auth_schema_sql: str,
) -> None:
    sql = _normalized_sql(auth_schema_sql)

    assert "created_at + interval '12 hours'" in sql
    assert "created_at + interval '7 days'" in sql
    assert "interval '24 hours'" not in sql
    assert "interval '30 days'" not in sql

    pgcrypto_sha256 = re.search(
        r"else\s+digest\s*\(\s*convert_to\s*\(\s*session_token_hash\s*,\s*'utf8'\s*\)"
        r"\s*,\s*'sha256'\s*\)",
        sql,
    )
    core_sha256 = re.search(
        r"else\s+sha256\s*\(\s*convert_to\s*\(\s*session_token_hash\s*,\s*'utf8'\s*\)\s*\)",
        sql,
    )
    assert pgcrypto_sha256 or core_sha256, (
        "legacy non-hex session tokens must be deterministically converted to SHA-256"
    )

    session_updates = re.findall(
        r"\bupdate\s+app\.account_sessions\s+set\s+.*?;",
        sql,
        re.DOTALL,
    )
    legacy_revocations = [
        statement
        for statement in session_updates
        if "revoked_at" in statement
        and "revocation_reason" in statement
        and "legacy" in statement
    ]
    assert legacy_revocations, (
        "sessions that predate Phase 7 must be explicitly revoked with a legacy reason, "
        "not promoted into authenticated sessions"
    )


def test_legacy_session_absolute_expiry_backfill_repairs_invalid_expiries_before_constraint(
    auth_schema_sql: str,
) -> None:
    sql = _normalized_sql(auth_schema_sql)
    session_updates = re.findall(
        r"\bupdate\s+app\.account_sessions\s+set\s+.*?;",
        sql,
        re.DOTALL,
    )
    absolute_updates = [
        statement
        for statement in session_updates
        if "absolute_expires_at" in statement and "expires_at" in statement
    ]
    assert absolute_updates
    backfill = absolute_updates[0]

    assert "created_at + interval '7 days'" in backfill
    assert "least(" in backfill, "legacy absolute expiry must be capped at created_at + 7 days"
    guarded_case = (
        "case" in backfill
        and re.search(r"expires_at[^;]*<=\s*created_at", backfill)
        and re.search(r"then\s+created_at\s*\+\s*interval\s*'[^']+'", backfill)
    )
    guarded_greatest = (
        "greatest(" in backfill
        and re.search(r"greatest\s*\(\s*created_at\s*\+\s*interval\s*'[^']+'", backfill)
    )
    assert guarded_case or guarded_greatest, (
        "legacy expires_at values at or before created_at need a strictly later fallback"
    )

    constraint_position = sql.index("account_sessions_absolute_lifetime_check")
    assert sql.index(backfill) < constraint_position


def test_security_audit_is_append_only_and_secret_averse(auth_schema_sql: str) -> None:
    table = _table_definition(auth_schema_sql, "app.security_audit_events")
    assert table
    required = {
        "actor_account_id",
        "target_account_id",
        "event_category",
        "outcome",
        "reason_code",
        "request_ref",
        "occurred_at",
        "metadata",
    }
    assert sorted(column for column in required if column not in table) == []
    assert "references app.accounts(id)" in table
    assert "jsonb" in table
    assert not re.search(r"password|token_hash|csrf|smtp|filesystem_path|media_path", table)

    sql = _normalized_sql(auth_schema_sql)
    assert re.search(
        r"revoke\s+(?:update\s*,\s*delete|delete\s*,\s*update|all)[^;]*"
        r"on\s+(?:table\s+)?app\.security_audit_events\s+from\s+album_haven_app",
        sql,
    )
    assert re.search(
        r"grant\s+insert[^;]*on\s+(?:table\s+)?app\.security_audit_events\s+to\s+album_haven_app",
        sql,
    )


def test_mail_outbox_is_durable_claimable_and_contains_no_delivery_secrets(
    auth_schema_sql: str,
) -> None:
    table = _table_definition(auth_schema_sql, "app.mail_outbox")
    assert table
    required = {
        "account_id",
        "reset_token_id",
        "message_category",
        "delivery_status",
        "attempt_count",
        "next_attempt_at",
        "claimed_at",
        "sent_at",
        "provider_reference",
        "created_at",
    }
    assert sorted(column for column in required if column not in table) == []
    assert "references app.accounts(id)" in table
    assert "references app.password_reset_tokens(id)" in table
    assert all(value in table for value in ("welcome", "password_reset"))
    assert all(value in table for value in ("pending", "sending", "sent", "failed", "unknown"))
    assert "attempt_count >= 0" in table
    assert not re.search(r"\braw_token\b|\bmessage_body\b|\breset_link\b|\bsmtp_(?:password|secret)\b", table)

    claim_indexes = [
        statement
        for statement in _index_statements(auth_schema_sql)
        if " on app.mail_outbox " in statement
        and "next_attempt_at" in statement
        and " where " in statement
        and "delivery_status" in statement
    ]
    assert claim_indexes, "missing query-compatible pending-mail claim index"


def test_mail_claim_index_retries_only_pending_or_failed_and_reconciles_unknown_separately(
    auth_schema_sql: str,
) -> None:
    indexes = _index_statements(auth_schema_sql)
    claim_indexes = [
        statement
        for statement in indexes
        if "mail_outbox_pending_claim_idx" in statement
    ]
    assert len(claim_indexes) == 1
    claim_states = set(re.findall(r"'([^']+)'", claim_indexes[0]))
    assert claim_states == {"pending", "failed"}
    assert "unknown" not in claim_indexes[0]

    unknown_indexes = [
        statement
        for statement in indexes
        if " on app.mail_outbox " in statement
        and "unknown" in statement
        and "pending_claim" not in statement
    ]
    assert unknown_indexes, "timeout-unknown delivery rows need a separate reconciliation index"
    assert any("provider_reference" in statement or "claimed_at" in statement or "id" in statement for statement in unknown_indexes)


def test_every_new_foreign_key_and_runtime_lookup_has_an_index(auth_schema_sql: str) -> None:
    expected = {
        "app.password_reset_tokens": (("account_id",), ("purpose", "token_hash")),
        "app.security_audit_events": (("actor_account_id",), ("target_account_id",)),
        "app.mail_outbox": (("account_id",), ("reset_token_id",)),
    }
    for table, indexes in expected.items():
        for columns in indexes:
            _assert_has_index(auth_schema_sql, table, *columns)

    baseline = _normalized_sql(BASELINE_PATH.read_text(encoding="utf-8"))
    assert re.search(
        r"create\s+unique\s+index[^;]*account_sessions_token_hash_idx[^;]*"
        r"on\s+app\.account_sessions\s*\([^)]*session_token_hash",
        baseline,
    )
    assert re.search(
        r"create\s+index[^;]*account_sessions_account_id_idx[^;]*"
        r"on\s+app\.account_sessions\s*\([^)]*account_id",
        baseline,
    )
    migration = _normalized_sql(auth_schema_sql)
    assert not re.search(
        r"drop\s+index[^;]*(?:account_sessions_token_hash_idx|account_sessions_account_id_idx)",
        migration,
    )

    statements = _index_statements(auth_schema_sql)
    assert any(
        " on app.account_sessions " in statement
        and "account_id" in statement
        and " where " in statement
        and "revoked_at is null" in statement
        for statement in statements
    ), "missing active-session lookup index"


def test_partial_indexes_use_structural_predicates_not_wall_clock_time(
    auth_schema_sql: str,
) -> None:
    partial_indexes = [
        statement for statement in _index_statements(auth_schema_sql) if " where " in statement
    ]
    assert partial_indexes
    assert all("now()" not in statement and "current_timestamp" not in statement for statement in partial_indexes)
    assert all(not re.search(r"expires_at\s*>\s*", statement) for statement in partial_indexes)


def test_privileges_exclude_readonly_from_secret_adjacent_tables_and_runtime_ddl(
    auth_schema_sql: str,
) -> None:
    sql = _normalized_sql(auth_schema_sql)
    secret_tables = (
        "account_credentials",
        "password_reset_tokens",
        "auth_throttles",
        "account_sessions",
        "mail_outbox",
    )
    for table in secret_tables:
        assert re.search(
            rf"revoke\s+all[^;]*on\s+(?:table\s+)?app\.{table}\s+from\s+album_haven_readonly",
            sql,
        ), f"readonly role retains access to app.{table}"

    assert re.search(
        r"revoke\s+(?:update\s*,\s*delete|delete\s*,\s*update|all)[^;]*"
        r"on\s+(?:table\s+)?app\.security_audit_events\s+from\s+album_haven_readonly",
        sql,
    )
    assert not re.search(r"grant\s+(?:create|truncate|references|trigger)[^;]*to\s+album_haven_app", sql)
    assert not re.search(
        r"grant\s+all(?:\s+privileges)?[^;]*to\s+album_haven_app",
        sql,
    )


def test_new_auth_tables_receive_explicit_bounded_runtime_and_migrator_grants(
    auth_schema_sql: str,
) -> None:
    runtime_contract = {
        "app.account_credentials": {"select", "insert", "update"},
        "app.password_reset_tokens": {"select", "insert", "update"},
        "app.auth_throttles": {"select", "insert", "update", "delete"},
        "app.account_sessions": {"select", "insert", "update"},
        "app.mail_outbox": {"select", "insert", "update"},
        "app.security_audit_events": {"insert"},
    }
    bounded_dml = {"select", "insert", "update", "delete"}
    for table, required in runtime_contract.items():
        granted = _granted_privileges(auth_schema_sql, "album_haven_app", table)
        assert required <= granted, f"album_haven_app lacks {sorted(required - granted)} on {table}"
        assert granted <= bounded_dml, f"album_haven_app has non-DML privileges on {table}: {sorted(granted)}"
        if table == "app.security_audit_events":
            assert granted == {"insert"}

    for table in (
        "app.account_credentials",
        "app.password_reset_tokens",
        "app.auth_throttles",
        "app.security_audit_events",
        "app.mail_outbox",
    ):
        granted = _granted_privileges(auth_schema_sql, "album_haven_migrator", table)
        assert "all" in granted or "all privileges" in granted, (
            f"album_haven_migrator lacks explicit ownership-equivalent access on {table}"
        )


def test_schema_does_not_claim_cross_table_owner_invariants_with_row_checks(
    auth_schema_sql: str,
) -> None:
    sql = _normalized_sql(auth_schema_sql)
    check_clauses = re.findall(r"\bcheck\s*\((.*?)\)", sql, re.DOTALL)
    assert all("select " not in clause and "exists (" not in clause for clause in check_clauses)
    assert not any(
        "bootstrap_owners" in clause or "library_memberships" in clause or "libraries" in clause
        for clause in check_clauses
    )
