from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = REPO_ROOT / "migrations" / "postgres" / "0047_add_auth_preauth_tokens.sql"


def _sql() -> str:
    assert MIGRATION_PATH.exists(), "missing durable pre-auth token migration"
    return re.sub(r"\s+", " ", MIGRATION_PATH.read_text(encoding="utf-8").lower()).strip()


def test_preauth_migration_stores_only_one_time_purpose_bound_hashes():
    sql = _sql()
    match = re.search(
        r"create table(?: if not exists)? app\.auth_preflight_tokens \((.*?)\);",
        sql,
    )
    assert match
    table = match.group(1)
    for column in ("id", "token_hash", "purpose", "created_at", "expires_at", "consumed_at"):
        assert column in table
    assert "octet_length(token_hash) = 32" in table
    assert "purpose = 'login'" in table
    assert "expires_at > created_at" in table
    assert not re.search(r"\braw_token\b|\btoken_value\b|\bcsrf_value\b", table)
    assert re.search(
        r"create unique index[^;]+on app\.auth_preflight_tokens \(purpose, token_hash\)",
        sql,
    )
    cleanup_index = re.search(
        r"create index[^;]+on app\.auth_preflight_tokens \(expires_at, id\)([^;]*);",
        sql,
    )
    assert cleanup_index
    assert "where" not in cleanup_index.group(1)


def test_preauth_migration_preserves_least_privilege_roles():
    sql = _sql()
    assert "revoke all on table app.auth_preflight_tokens from album_haven_readonly" in sql
    assert re.search(
        r"grant select, insert, update, delete on table app\.auth_preflight_tokens to album_haven_app",
        sql,
    )
    assert re.search(
        r"grant usage, select on sequence app\.auth_preflight_tokens_id_seq to album_haven_app",
        sql,
    )
    assert "grant all privileges on table app.auth_preflight_tokens to album_haven_migrator" in sql
    assert "grant all privileges on sequence app.auth_preflight_tokens_id_seq to album_haven_migrator" in sql
