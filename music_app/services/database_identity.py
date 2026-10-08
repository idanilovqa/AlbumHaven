from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping

from music_app.services.postgres_connections import pooled_connection


DATABASE_IDENTITY_PROOF_SCHEMA_VERSION = 2
DATABASE_IDENTITY_PROOF_SCHEME = "hmac-sha256-v1"
_DATABASE_IDENTITY_PROOF_DOMAIN = b"album-haven/database-identity-proof/v1"


DATABASE_IDENTITY_SQL = """
select
  current_database()::text as database_name,
  (select oid::text from pg_catalog.pg_database where datname = current_database()) as database_oid,
  coalesce(inet_server_addr()::text, '') as server_address,
  coalesce(inet_server_port()::text, '') as server_port,
  (
    select count(library.local_albums.id)::bigint
    from app.bootstrap_owners
    join library.libraries
      on library.libraries.owner_account_id = app.bootstrap_owners.account_id
      and library.libraries.name = 'Local Library'
      and library.libraries.library_kind = 'local'
    left join library.local_albums
      on library.local_albums.library_id = library.libraries.id
    where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  ) as catalog_album_count
"""


def _identity_hmac_config(
    hmac_config: Mapping[str, object] | None,
) -> tuple[str, int]:
    if not isinstance(hmac_config, Mapping):
        raise ValueError("Database identity HMAC configuration is unavailable.")
    secret = hmac_config.get("secret")
    key_version = hmac_config.get("key_version")
    if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32:
        raise ValueError("Database identity HMAC configuration is invalid.")
    if isinstance(key_version, bool) or not isinstance(key_version, int) or key_version < 1:
        raise ValueError("Database identity HMAC configuration is invalid.")
    return secret, key_version


def database_identity_proof(
    row: Mapping[str, object],
    *,
    secret: str,
    key_version: int,
) -> str:
    secret, key_version = _identity_hmac_config(
        {"secret": secret, "key_version": key_version}
    )
    identity = [
        str(row.get("database_name") or ""),
        str(row.get("database_oid") or ""),
        str(row.get("server_address") or ""),
        str(row.get("server_port") or ""),
    ]
    serialized = json.dumps(
        identity,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    message = (
        _DATABASE_IDENTITY_PROOF_DOMAIN
        + b"\0key-version:"
        + str(key_version).encode("ascii")
        + b"\0"
        + serialized
    )
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def read_database_identity_row(connection) -> Mapping[str, object]:
    row = connection.execute(DATABASE_IDENTITY_SQL).fetchone()
    if not isinstance(row, Mapping) or not row.get("database_name") or not row.get("database_oid"):
        raise RuntimeError("Database identity is unavailable.")
    catalog_album_count = row.get("catalog_album_count")
    if (
        isinstance(catalog_album_count, bool)
        or not isinstance(catalog_album_count, int)
        or catalog_album_count < 0
    ):
        raise RuntimeError("Database identity is unavailable.")
    return row


def load_database_identity_status(
    config: Mapping[str, object],
    *,
    hmac_config: Mapping[str, object] | None,
) -> dict[str, object]:
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if not database_url:
        return {"ready": False}
    try:
        secret, key_version = _identity_hmac_config(hmac_config)
    except (TypeError, ValueError):
        return {"ready": False}
    try:
        with pooled_connection(database_url, workload="default") as connection:
            connection.execute("set transaction read only")
            identity_row = read_database_identity_row(connection)
            proof = database_identity_proof(
                identity_row,
                secret=secret,
                key_version=key_version,
            )
    except Exception:
        return {"ready": False}
    return {
        "ready": True,
        "schema_version": DATABASE_IDENTITY_PROOF_SCHEMA_VERSION,
        "scheme": DATABASE_IDENTITY_PROOF_SCHEME,
        "key_version": key_version,
        "proof": proof,
        "catalog_album_count": identity_row["catalog_album_count"],
    }
