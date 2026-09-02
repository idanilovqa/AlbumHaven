"""Transactional reconciliation of the retained Phase 6 bootstrap owner."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from argon2 import extract_parameters
from argon2.exceptions import InvalidHashError
from argon2.low_level import ARGON2_VERSION, Type

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
_ARGON2_FLOOR = {
    "memory_cost": 65_536,
    "time_cost": 3,
    "parallelism": 1,
    "salt_len": 16,
    "hash_len": 32,
}


@dataclass(frozen=True, slots=True)
class BootstrapReconciliationResult:
    """Non-secret identifiers produced by an idempotent reconciliation."""

    account_id: int
    library_id: int
    credential_created: bool
    welcome_queued: bool
    welcome_outbox_id: int | None


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
        self._argon2 = payload.get("argon2")
        self._active_policy_version = payload.get("argon2_policy_version")
        self._welcome_enabled = payload.get("welcome_enabled") is True
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
        _validate_credential(
            encoded_hash,
            hash_policy_version,
            argon2=self._argon2,
            active_policy_version=self._active_policy_version,
        )

        try:
            with self._connect(self._database_url) as connection:
                with _transaction(connection):
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
                    account_id = _integer_field(
                        owner, "account_id", ("account_id",)
                    )

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

                    account_rows = connection.execute(
                        """
                        select app.accounts.id
                        from app.accounts
                        where app.accounts.id = %s
                           or (
                            app.accounts.username_normalized = %s
                            or app.accounts.contact_email_normalized = %s
                          )
                        order by app.accounts.id
                        for update
                        """,
                        (account_id, "rendref", self._email),
                    ).fetchall()
                    if len(account_rows) != 1:
                        raise RuntimeError(
                            "Bootstrap identity conflicts with an account."
                        )
                    locked_account_id = _required_id(account_rows[0], ("id",))
                    if locked_account_id != account_id:
                        raise RuntimeError(
                            "Bootstrap identity conflicts with an account."
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
                               app.account_credentials.hash_algorithm,
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
                    if credential_rows and not _stored_credential_valid(
                        credential_rows[0]
                    ):
                        raise RuntimeError("Bootstrap credential context is invalid.")

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
                    welcome_queued = False
                    welcome_outbox_id = None
                    if self._welcome_enabled:
                        welcome_rows = connection.execute(
                            """
                            select app.mail_outbox.id
                            from app.mail_outbox
                            where app.mail_outbox.account_id = %s
                              and app.mail_outbox.message_category = 'welcome'
                            order by app.mail_outbox.id
                            limit 1
                            for update
                            """,
                            (account_id,),
                        ).fetchall()
                        if welcome_rows:
                            welcome_outbox_id = _required_id(welcome_rows[0], ("id",))
                        else:
                            created_welcome = _only_row(
                                connection.execute(
                                    """
                                    insert into app.mail_outbox (
                                      account_id, message_category, delivery_status,
                                      next_attempt_at
                                    ) values (%s, %s, %s, now())
                                    returning id
                                    """,
                                    (account_id, "welcome", "pending"),
                                ).fetchall(),
                                "Bootstrap welcome outbox context is invalid.",
                            )
                            welcome_outbox_id = _required_id(
                                created_welcome, ("id",)
                            )
                            welcome_queued = True
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
            welcome_queued=welcome_queued,
            welcome_outbox_id=welcome_outbox_id,
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


def _validate_credential(
    encoded_hash: object,
    policy_version: object,
    *,
    argon2: object,
    active_policy_version: object,
) -> None:
    if not isinstance(encoded_hash, str) or not encoded_hash.strip():
        raise ValueError("Bootstrap credential is invalid.")
    try:
        parameters = extract_parameters(encoded_hash)
    except (InvalidHashError, TypeError, ValueError):
        raise ValueError("Bootstrap credential is invalid.") from None
    if parameters.type is not Type.ID or parameters.version != ARGON2_VERSION:
        raise ValueError("Bootstrap credential is invalid.")
    if not isinstance(argon2, Mapping):
        raise ValueError("Bootstrap credential configuration is invalid.")
    configured: dict[str, int] = {}
    for key, absolute_minimum in _ARGON2_FLOOR.items():
        value = argon2.get(key)
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < absolute_minimum
        ):
            raise ValueError("Bootstrap credential configuration is invalid.")
        configured[key] = value
    if (
        parameters.memory_cost < configured["memory_cost"]
        or parameters.time_cost < configured["time_cost"]
        or parameters.parallelism < configured["parallelism"]
        or parameters.salt_len < configured["salt_len"]
        or parameters.hash_len < configured["hash_len"]
    ):
        raise ValueError("Bootstrap credential is below the configured floor.")
    if (
        isinstance(policy_version, bool)
        or not isinstance(policy_version, int)
        or policy_version < 1
    ):
        raise ValueError("Bootstrap credential policy version is invalid.")
    if (
        isinstance(active_policy_version, bool)
        or not isinstance(active_policy_version, int)
        or active_policy_version < 1
        or policy_version != active_policy_version
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


def _stored_credential_valid(row: object) -> bool:
    payload = _row_mapping(
        row,
        (
            "encoded_hash",
            "hash_algorithm",
            "hash_policy_version",
            "credential_version",
        ),
    )
    encoded_hash = payload.get("encoded_hash")
    try:
        parameters = extract_parameters(encoded_hash)
        hash_policy_version = int(payload.get("hash_policy_version"))
        credential_version = int(payload.get("credential_version"))
    except (InvalidHashError, TypeError, ValueError):
        return False
    return (
        parameters.type is Type.ID
        and payload.get("hash_algorithm") == "argon2id"
        and hash_policy_version >= 1
        and credential_version >= 1
    )


def _is_identity_unique_violation(exc: Exception) -> bool:
    if getattr(exc, "sqlstate", None) != "23505":
        return False
    diagnostics = getattr(exc, "diag", None)
    constraint_name = getattr(diagnostics, "constraint_name", None)
    return constraint_name in _IDENTITY_UNIQUE_INDEXES
