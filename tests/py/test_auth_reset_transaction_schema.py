import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = REPO_ROOT / "migrations" / "postgres" / "0048_add_password_reset_transactions.sql"
SINGLE_USE_MIGRATION = REPO_ROOT / "migrations" / "postgres" / "0049_enforce_single_use_password_reset_exchange.sql"


def _sql():
    assert MIGRATION.exists(), "missing password-reset transaction migration"
    return re.sub(r"\s+", " ", MIGRATION.read_text(encoding="utf-8").casefold()).strip()


def test_migration_allows_separate_login_and_forgot_preauth_purposes():
    sql = _sql()
    assert "drop constraint if exists auth_preflight_tokens_purpose_check" in sql
    assert "purpose in ('login', 'forgot_password')" in sql


def test_reset_transactions_store_only_expiring_purpose_bound_hashes():
    sql = _sql()
    match = re.search(
        r"create table(?: if not exists)? app\.password_reset_transactions \((.*?)\);",
        sql,
    )
    assert match
    table = match.group(1)
    for column in (
        "id", "reset_token_id", "transaction_hash", "created_at", "expires_at", "consumed_at"
    ):
        assert column in table
    assert "octet_length(transaction_hash) = 32" in table
    assert "references app.password_reset_tokens(id)" in table
    assert "expires_at > created_at" in table
    assert not re.search(r"\braw_token\b|\bcsrf_token\b|\bpassword\b", table)
    assert re.search(
        r"unique index[^;]+on app\.password_reset_transactions \(transaction_hash\)",
        sql,
    )


def test_reset_transaction_runtime_role_is_least_privilege():
    sql = _sql()
    assert "revoke all on table app.password_reset_transactions from album_haven_readonly" in sql
    assert "grant select, insert, update, delete on table app.password_reset_transactions to album_haven_app" in sql


def test_reset_link_exchange_is_database_enforced_single_use():
    assert SINGLE_USE_MIGRATION.exists(), "missing single-use reset exchange migration"
    sql = re.sub(
        r"\s+", " ", SINGLE_USE_MIGRATION.read_text(encoding="utf-8").casefold()
    ).strip()

    assert "partition by reset_token_id" in sql
    assert "delete from app.password_reset_transactions" in sql
    assert re.search(
        r"create unique index[^;]+on app\.password_reset_transactions \(reset_token_id\)",
        sql,
    )
