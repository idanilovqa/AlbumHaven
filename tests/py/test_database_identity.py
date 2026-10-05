from __future__ import annotations

import hashlib
import hmac
import json


class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def execute(self, query, params=None):
        self.calls.append((" ".join(str(query).split()).lower(), params))
        return _Result(self.row)


class _ConnectionContext:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, *_args):
        return False


def test_database_identity_proof_is_keyed_stable_and_opaque():
    from music_app.services.database_identity import database_identity_proof

    row = {
        "database_name": "album_haven",
        "database_oid": "16384",
        "server_address": "127.0.0.1",
        "server_port": "5432",
    }
    secret = "database-proof-secret-0123456789abcdef"
    identity = json.dumps(
        ["album_haven", "16384", "127.0.0.1", "5432"],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    expected = hmac.new(
        secret.encode("utf-8"),
        b"album-haven/database-identity-proof/v1\0key-version:7\0" + identity,
        hashlib.sha256,
    ).hexdigest()

    proof = database_identity_proof(row, secret=secret, key_version=7)

    assert proof == expected
    assert proof != database_identity_proof(
        row,
        secret="different-database-proof-secret-abcdef",
        key_version=7,
    )
    assert proof != database_identity_proof(row, secret=secret, key_version=8)
    assert "album_haven" not in proof
    assert "127.0.0.1" not in proof


def test_load_database_identity_status_uses_read_only_app_connection(monkeypatch):
    from music_app.services import database_identity

    connection = _Connection(
        {
            "database_name": "album_haven",
            "database_oid": "16384",
            "server_address": "127.0.0.1",
            "server_port": "5432",
            "catalog_album_count": 23,
        }
    )
    monkeypatch.setattr(
        database_identity,
        "pooled_connection",
        lambda database_url, *, workload: _ConnectionContext(connection),
    )

    status = database_identity.load_database_identity_status(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://secret@host/database"},
        hmac_config={
            "secret": "database-proof-secret-0123456789abcdef",
            "key_version": 7,
        },
    )

    assert status == {
        "ready": True,
        "schema_version": 2,
        "scheme": "hmac-sha256-v1",
        "key_version": 7,
        "proof": database_identity.database_identity_proof(
            connection.row,
            secret="database-proof-secret-0123456789abcdef",
            key_version=7,
        ),
        "catalog_album_count": 23,
    }
    assert connection.calls[0] == ("set transaction read only", None)
    assert "current_database()" in connection.calls[1][0]
    assert "current_user" not in connection.calls[1][0]
    assert "app.bootstrap_owners" in connection.calls[1][0]
    assert "library.local_albums" in connection.calls[1][0]


def test_load_database_identity_status_rejects_negative_catalog_album_count(monkeypatch):
    from music_app.services import database_identity

    connection = _Connection(
        {
            "database_name": "album_haven",
            "database_oid": "16384",
            "server_address": "127.0.0.1",
            "server_port": "5432",
            "catalog_album_count": -1,
        }
    )
    monkeypatch.setattr(
        database_identity,
        "pooled_connection",
        lambda database_url, *, workload: _ConnectionContext(connection),
    )

    assert database_identity.load_database_identity_status(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://secret@host/database"},
        hmac_config={"secret": "x" * 32, "key_version": 1},
    ) == {"ready": False}


def test_load_database_identity_status_fails_closed_without_leaking_details(monkeypatch):
    from music_app.services import database_identity

    def fail_connection(*_args, **_kwargs):
        raise RuntimeError("postgresql://secret@private-host/database")

    monkeypatch.setattr(database_identity, "pooled_connection", fail_connection)

    assert database_identity.load_database_identity_status(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://secret@host/database"},
        hmac_config={"secret": "x" * 32, "key_version": 1},
    ) == {"ready": False}
    assert database_identity.load_database_identity_status(
        {},
        hmac_config={"secret": "x" * 32, "key_version": 1},
    ) == {"ready": False}


def test_load_database_identity_status_rejects_missing_or_invalid_hmac_without_connecting(
    monkeypatch,
):
    from music_app.services import database_identity

    def fail_connection(*_args, **_kwargs):
        raise AssertionError("Invalid HMAC configuration must fail before connecting")

    monkeypatch.setattr(database_identity, "pooled_connection", fail_connection)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://secret@host/database"}

    assert database_identity.load_database_identity_status(config, hmac_config=None) == {
        "ready": False
    }
    assert database_identity.load_database_identity_status(
        config,
        hmac_config={"secret": "short", "key_version": 1},
    ) == {"ready": False}
    assert database_identity.load_database_identity_status(
        config,
        hmac_config={"secret": "x" * 32, "key_version": 0},
    ) == {"ready": False}
