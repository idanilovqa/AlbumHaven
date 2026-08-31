"""Transactional reconciliation of the retained Phase 6 bootstrap owner."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from argon2 import extract_parameters
from argon2.exceptions import InvalidHashError
from argon2.low_level import Type

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_OWNER_KEY = "local-bootstrap-owner"
_IDENTITY_UNIQUE_INDEXES = frozenset(
    {"accounts_username_normalized_idx", "accounts_contact_email_normalized_idx"}
)


@dataclass(frozen=True, slots=True)
class BootstrapReconciliationResult:
    """Non-secret identifiers produced by an idempotent reconciliation."""

    account_id: int
    library_id: int
    credential_created: bool


class PostgresAuthBootstrapService:
    """Reconcile Rendref, the current library, and the initial credential."""

    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        self._email = _validated_email(payload.get("bootstrap_email_normalized"))
        self._connect = connect or _connect

    def reconcile_owner(
        self,
        *,
        encoded_hash: str,
        hash_policy_version: int,
    ) -> BootstrapReconciliationResult:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for auth bootstrap."
            )
        _validate_credential(encoded_hash, hash_policy_version)

        try:
            with self._connect(self._database_url) as connection:
                with _transaction(connection):
                    account = _only_row(
                        connection.execute(
                            """
                            select app.accounts.id
                            from app.accounts
                            join app.bootstrap_owners
                              on app.bootstrap_owners.account_id = app.accounts.id
                            where app.bootstrap_owners.owner_key = %s
                            for update of app.accounts
                            """,
                            (_OWNER_KEY,),
                        ).fetchall(),
                        "Bootstrap account context is invalid.",
                    )
                    account_id = _required_id(account, ("id",))

                    collisions = connection.execute(
                        """
                        select app.accounts.id
                        from app.accounts
                        where app.accounts.id <> %s
                          and (
                            app.accounts.username_normalized = %s
                            or app.accounts.contact_email_normalized = %s
                          )
                        order by app.accounts.id
                        for update
                        """,
                        (account_id, "rendref", self._email),
                    ).fetchall()
                    if collisions:
                        raise RuntimeError(
                            "Bootstrap identity conflicts with an account."
                        )

                    owner = _only_row(
                        connection.execute(
                            """
                            select app.bootstrap_owners.account_id
                            from app.bootstrap_owners
                            where app.bootstrap_owners.owner_key = %s
                            for update
                            """,
                            (_OWNER_KEY,),
                        ).fetchall(),
                        "Bootstrap owner context is invalid.",
                    )
                    if _integer_field(owner, "account_id", ("account_id",)) != account_id:
                        raise RuntimeError("Bootstrap owner context is invalid.")

                    library = _only_row(
                        connection.execute(
                            """
                            select library.libraries.id,
                                   library.libraries.owner_account_id
                            from library.libraries
                            where library.libraries.library_kind = 'local'
                            order by library.libraries.id
                            for update
                            """,
                            (),
                        ).fetchall(),
                        "Bootstrap library context is invalid.",
                    )
                    library_payload = _row_mapping(
                        library, ("id", "owner_account_id")
                    )
                    library_id = _required_id(
                        library, ("id", "owner_account_id")
                    )
                    owner_account_id = library_payload.get("owner_account_id")
                    if owner_account_id is not None:
                        try:
                            existing_owner_id = int(owner_account_id)
                        except (TypeError, ValueError):
                            raise RuntimeError(
                                "Bootstrap library context is invalid."
                            ) from None
                        if existing_owner_id != account_id:
                            raise RuntimeError(
                                "Bootstrap library context is invalid."
                            )

                    membership_rows = connection.execute(
                        """
                        select library.library_memberships.id,
                               library.library_memberships.membership_role
                        from library.library_memberships
                        where library.library_memberships.library_id = %s
                          and library.library_memberships.account_id = %s
                        for update
                        """,
                        (library_id, account_id),
                    ).fetchall()
                    if len(membership_rows) > 1:
                        raise RuntimeError("Bootstrap membership context is invalid.")

                    credential_rows = connection.execute(
                        """
                        select app.account_credentials.encoded_hash,
                               app.account_credentials.hash_policy_version,
                               app.account_credentials.credential_version
                        from app.account_credentials
                        where app.account_credentials.account_id = %s
                        for update
                        """,
                        (account_id,),
                    ).fetchall()
                    if len(credential_rows) > 1:
                        raise RuntimeError("Bootstrap credential context is invalid.")
                    credential_created = not credential_rows
                    if credential_rows and not _credential_matches(
                        credential_rows[0], encoded_hash, hash_policy_version
                    ):
                        raise RuntimeError("Bootstrap credential already exists.")

                    connection.execute(
                        """
                        update app.accounts
                        set display_name = %s,
                            account_kind = %s,
                            username_display = %s,
                            username_normalized = %s,
                            contact_email = %s,
                            contact_email_normalized = %s,
                            is_active = true,
                            disabled_at = null,
                            disabled_reason = null,
                            updated_at = now()
                        where id = %s
                        """,
                        (
                            "Rendref",
                            "bootstrap_owner",
                            "Rendref",
                            "rendref",
                            self._email,
                            self._email,
                            account_id,
                        ),
                    )
                    connection.execute(
                        """
                        update library.libraries
                        set owner_account_id = %s, updated_at = now()
                        where id = %s
                        """,
                        (account_id, library_id),
                    )
                    connection.execute(
                        """
                        insert into library.library_memberships (
                          library_id, account_id, membership_role
                        ) values (%s, %s, %s)
                        on conflict (library_id, account_id) do update
                        set membership_role = excluded.membership_role,
                            updated_at = now()
                        """,
                        (library_id, account_id, "owner"),
                    )
                    if credential_created:
                        connection.execute(
                            """
                            insert into app.account_credentials (
                              account_id, encoded_hash, hash_algorithm,
                              hash_policy_version, credential_version,
                              administrator_set
                            ) values (%s, %s, %s, %s, %s, %s)
                            """,
                            (
                                account_id,
                                encoded_hash,
                                "argon2id",
                                hash_policy_version,
                                1,
                                False,
                            ),
                        )
        except Exception as exc:
            if _is_identity_unique_violation(exc):
                raise RuntimeError(
                    "Bootstrap identity conflicts with an account."
                ) from None
            raise

        return BootstrapReconciliationResult(
            account_id=account_id,
            library_id=library_id,
            credential_created=credential_created,
        )


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for auth bootstrap.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if not callable(transaction):
        raise RuntimeError("Postgres auth bootstrap requires transaction support.")
    return transaction()


def _validated_email(value: object) -> str:
    email = str(value or "").strip()
    if not email or "\r" in email or "\n" in email or "@" not in email:
        raise ValueError("Bootstrap email configuration is invalid.")
    return email


def _validate_credential(encoded_hash: object, policy_version: object) -> None:
    if not isinstance(encoded_hash, str) or not encoded_hash.strip():
        raise ValueError("Bootstrap credential is invalid.")
    try:
        parameters = extract_parameters(encoded_hash)
    except (InvalidHashError, TypeError, ValueError):
        raise ValueError("Bootstrap credential is invalid.") from None
    if parameters.type is not Type.ID:
        raise ValueError("Bootstrap credential is invalid.")
    if (
        isinstance(policy_version, bool)
        or not isinstance(policy_version, int)
        or policy_version < 1
    ):
        raise ValueError("Bootstrap credential policy version is invalid.")


def _only_row(rows: object, error: str) -> object:
    values = list(rows or ())
    if len(values) != 1:
        raise RuntimeError(error)
    return values[0]


def _row_mapping(
    row: object, columns: tuple[str, ...] = ()
) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)):
        return dict(zip(columns, row, strict=False))
    return {}


def _integer_field(
    row: object, key: str, columns: tuple[str, ...] = ()
) -> int:
    try:
        value = int(_row_mapping(row, columns).get(key) or 0)
    except (TypeError, ValueError):
        value = 0
    if value < 1:
        raise RuntimeError("Bootstrap persistence context is invalid.")
    return value


def _required_id(row: object, columns: tuple[str, ...] = ("id",)) -> int:
    return _integer_field(row, "id", columns)


def _credential_matches(
    row: object, encoded_hash: str, hash_policy_version: int
) -> bool:
    payload = _row_mapping(
        row, ("encoded_hash", "hash_policy_version", "credential_version")
    )
    return (
        payload.get("encoded_hash") == encoded_hash
        and payload.get("hash_policy_version") == hash_policy_version
        and payload.get("credential_version") == 1
    )


def _is_identity_unique_violation(exc: Exception) -> bool:
    if getattr(exc, "sqlstate", None) != "23505":
        return False
    diagnostics = getattr(exc, "diag", None)
    constraint_name = getattr(diagnostics, "constraint_name", None)
    return constraint_name in _IDENTITY_UNIQUE_INDEXES
