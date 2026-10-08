from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path

from music_app.services.database_identity import (
    DATABASE_IDENTITY_PROOF_SCHEME,
    DATABASE_IDENTITY_PROOF_SCHEMA_VERSION,
    database_identity_proof,
    read_database_identity_row,
)


BENCHMARK_ORIGIN = "https://sandbox1.albumhaven.org"
DATABASE_URL_ENV = "ALBUM_HAVEN_PRODUCTION_SEARCH_OPERATOR_DATABASE_URL"
IDENTITY_HMAC_SECRET_ENV = "ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_SECRET"
IDENTITY_HMAC_KEY_VERSION_ENV = (
    "ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_KEY_VERSION"
)
MIGRATION_FILENAME = "0084_create_local_artist_search_projection.sql"
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MIGRATION_PATH = REPOSITORY_ROOT / "migrations" / "postgres" / MIGRATION_FILENAME


def build_attestation(
    connection,
    *,
    hmac_secret: str,
    hmac_key_version: int,
    migration_path: Path = DEFAULT_MIGRATION_PATH,
    issued_at: datetime | None = None,
) -> dict[str, object]:
    migration_path = Path(migration_path)
    if migration_path.name != MIGRATION_FILENAME:
        raise RuntimeError("The exact 0084 migration file is required.")
    migration_sha256 = hashlib.sha256(migration_path.read_bytes()).hexdigest()
    connection.execute("set transaction read only")
    ledger_row = connection.execute(
        "select checksum from ops.schema_migrations where migration_name = %s",
        (MIGRATION_FILENAME,),
    ).fetchone()
    if not ledger_row or str(ledger_row.get("checksum") or "") != migration_sha256:
        raise RuntimeError("The 0084 migration checksum is missing or does not match this worktree.")
    identity_row = read_database_identity_row(connection)
    timestamp = issued_at or datetime.now(timezone.utc)
    timestamp = timestamp.astimezone(timezone.utc).replace(microsecond=0)
    return {
        "schemaVersion": DATABASE_IDENTITY_PROOF_SCHEMA_VERSION,
        "issuedAt": timestamp.isoformat().replace("+00:00", "Z"),
        "benchmarkOrigin": BENCHMARK_ORIGIN,
        "databaseIdentityProof": {
            "scheme": DATABASE_IDENTITY_PROOF_SCHEME,
            "keyVersion": hmac_key_version,
            "proof": database_identity_proof(
                identity_row,
                secret=hmac_secret,
                key_version=hmac_key_version,
            ),
        },
        "migration": {
            "filename": MIGRATION_FILENAME,
            "sha256": migration_sha256,
        },
    }


def identity_hmac_config_from_env(env: Mapping[str, str]) -> tuple[str, int]:
    secret = str(env.get(IDENTITY_HMAC_SECRET_ENV) or "")
    if len(secret.encode("utf-8")) < 32:
        raise RuntimeError(f"{IDENTITY_HMAC_SECRET_ENV} is missing or invalid.")
    raw_key_version = str(env.get(IDENTITY_HMAC_KEY_VERSION_ENV) or "").strip()
    try:
        key_version = int(raw_key_version)
    except (TypeError, ValueError):
        key_version = 0
    if key_version < 1:
        raise RuntimeError(f"{IDENTITY_HMAC_KEY_VERSION_ENV} is missing or invalid.")
    return secret, key_version


def write_attestation(destination: Path, payload: dict[str, object]) -> None:
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(payload, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a short-lived read-only production-search database attestation."
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    database_url = str(os.environ.get(DATABASE_URL_ENV) or "").strip()
    if not database_url:
        parser.error(f"{DATABASE_URL_ENV} is required.")

    try:
        hmac_secret, hmac_key_version = identity_hmac_config_from_env(os.environ)
        import psycopg
        from psycopg.rows import dict_row

        with psycopg.connect(database_url, row_factory=dict_row) as connection:
            payload = build_attestation(
                connection,
                hmac_secret=hmac_secret,
                hmac_key_version=hmac_key_version,
            )
            connection.rollback()
        write_attestation(args.output, payload)
    except Exception as exc:
        raise SystemExit(f"Production search database attestation failed: {type(exc).__name__}") from None
    print("Production search database attestation written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
