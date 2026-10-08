from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

import pytest


class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    def __init__(self, *, ledger_row):
        self.ledger_row = ledger_row
        self.calls = []

    def execute(self, query, params=None):
        normalized = " ".join(str(query).split()).lower()
        self.calls.append((normalized, params))
        if "ops.schema_migrations" in normalized:
            return _Result(self.ledger_row)
        if "current_database()" in normalized:
            return _Result(
                {
                    "database_name": "album_haven",
                    "database_oid": "16384",
                    "server_address": "127.0.0.1",
                    "server_port": "5432",
                "catalog_album_count": 0,
                }
            )
        return _Result(None)


def test_build_attestation_requires_exact_0084_ledger_checksum(tmp_path):
    from scripts.attest_production_search_database import build_attestation

    migration = tmp_path / "0084_create_local_artist_search_projection.sql"
    migration.write_text("select 1;\n", encoding="utf-8")
    checksum = hashlib.sha256(migration.read_bytes()).hexdigest()
    connection = _Connection(ledger_row={"checksum": checksum})

    attestation = build_attestation(
        connection,
        migration_path=migration,
        issued_at=datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc),
        hmac_secret="database-proof-secret-0123456789abcdef",
        hmac_key_version=7,
    )

    assert attestation == {
        "schemaVersion": 2,
        "issuedAt": "2026-10-04T12:00:00Z",
        "benchmarkOrigin": "https://sandbox1.albumhaven.org",
        "databaseIdentityProof": {
            "scheme": "hmac-sha256-v1",
            "keyVersion": 7,
            "proof": attestation["databaseIdentityProof"]["proof"],
        },
        "migration": {
            "filename": migration.name,
            "sha256": checksum,
        },
    }
    assert len(attestation["databaseIdentityProof"]["proof"]) == 64
    assert connection.calls[0] == ("set transaction read only", None)
    ledger_query, ledger_params = connection.calls[1]
    assert "where migration_name = %s" in ledger_query
    assert ledger_params == (migration.name,)
    serialized = json.dumps(attestation)
    assert "album_haven" not in serialized
    assert "database_name" not in serialized
    assert "server_address" not in serialized
    assert "server_port" not in serialized
    assert "database-proof-secret" not in serialized


@pytest.mark.parametrize("ledger_row", [None, {"checksum": "wrong"}])
def test_build_attestation_rejects_missing_or_changed_0084(tmp_path, ledger_row):
    from scripts.attest_production_search_database import build_attestation

    migration = tmp_path / "0084_create_local_artist_search_projection.sql"
    migration.write_text("select 1;\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="0084 migration checksum"):
        build_attestation(
            _Connection(ledger_row=ledger_row),
            migration_path=migration,
            issued_at=datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc),
            hmac_secret="database-proof-secret-0123456789abcdef",
            hmac_key_version=7,
        )


def test_write_attestation_replaces_destination_with_sanitized_json(tmp_path):
    from scripts.attest_production_search_database import write_attestation

    destination = tmp_path / "attestation.json"
    destination.write_text("stale", encoding="utf-8")
    payload = {
        "schemaVersion": 2,
        "issuedAt": "2026-10-04T12:00:00Z",
        "benchmarkOrigin": "http://127.0.0.1:5001",
        "databaseIdentityProof": {
            "scheme": "hmac-sha256-v1",
            "keyVersion": 7,
            "proof": "a" * 64,
        },
        "migration": {
            "filename": "0084_create_local_artist_search_projection.sql",
            "sha256": "b" * 64,
        },
    }

    write_attestation(destination, payload)

    assert json.loads(destination.read_text(encoding="utf-8")) == payload
    assert list(tmp_path.iterdir()) == [destination]


def test_identity_hmac_config_uses_benchmark_only_environment_names():
    from scripts.attest_production_search_database import (
        IDENTITY_HMAC_KEY_VERSION_ENV,
        IDENTITY_HMAC_SECRET_ENV,
        identity_hmac_config_from_env,
    )

    secret = "database-proof-secret-0123456789abcdef"
    assert identity_hmac_config_from_env(
        {
            IDENTITY_HMAC_SECRET_ENV: secret,
            IDENTITY_HMAC_KEY_VERSION_ENV: "7",
            "ALBUM_HAVEN_AUTH_HMAC_SECRET": "must-not-be-used",
        }
    ) == (secret, 7)


@pytest.mark.parametrize(
    "environment",
    [
        {},
        {"ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_SECRET": "short"},
        {
            "ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_SECRET": "x" * 32,
            "ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_KEY_VERSION": "0",
        },
    ],
)
def test_identity_hmac_config_rejects_missing_or_invalid_inputs_without_echoing_secret(
    environment,
):
    from scripts.attest_production_search_database import identity_hmac_config_from_env

    with pytest.raises(RuntimeError) as exc_info:
        identity_hmac_config_from_env(environment)

    supplied_secret = str(
        environment.get("ALBUM_HAVEN_PRODUCTION_SEARCH_IDENTITY_HMAC_SECRET")
        or "short"
    )
    assert supplied_secret not in str(exc_info.value)
