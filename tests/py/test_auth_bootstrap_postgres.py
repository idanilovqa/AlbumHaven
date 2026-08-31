from __future__ import annotations

from importlib import import_module, util
from typing import Any

import pytest
from argon2 import PasswordHasher
from argon2.low_level import Type


MODULE = "music_app.services.auth_bootstrap_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
ENCODED_HASH = PasswordHasher(
    memory_cost=65_536,
    time_cost=3,
    parallelism=1,
    salt_len=16,
    hash_len=32,
    type=Type.ID,
).hash("synthetic bootstrap fixture password")
EXISTING_VALID_HASH = PasswordHasher(
    memory_cost=65_536,
    time_cost=3,
    parallelism=1,
    salt_len=16,
    hash_len=32,
    type=Type.ID,
).hash("a different already provisioned password")


def test_auth_bootstrap_postgres_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 bootstrap auth persistence service: "
        "music_app/services/auth_bootstrap_postgres.py"
    )


@pytest.fixture
def auth_bootstrap():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("transaction:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append(
            "transaction:rollback" if exc_type else "transaction:commit"
        )


class RecordingConnection:
    def __init__(
        self,
        *,
        account_rows=({"id": 41},),
        owner_rows=({"account_id": 41},),
        collision_rows=(),
        library_rows=({"id": 73, "owner_account_id": 41},),
        membership_rows=(),
        credential_rows=(),
    ):
        self.account_rows = list(account_rows)
        self.owner_rows = list(owner_rows)
        self.collision_rows = list(collision_rows)
        self.library_rows = list(library_rows)
        self.membership_rows = list(membership_rows)
        self.credential_rows = list(credential_rows)
        self.operations: list[tuple[str, object]] = []
        self.events: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        pass

    def transaction(self):
        return Transaction(self)

    def execute(self, sql: str, params: object = None):
        normalized = " ".join(sql.casefold().split())
        self.operations.append((normalized, params))
        if "from app.accounts" in normalized and "username_normalized" in normalized:
            return Cursor([*self.account_rows, *self.collision_rows])
        if "from app.accounts" in normalized and "for update" in normalized:
            return Cursor(self.account_rows)
        if "from app.bootstrap_owners" in normalized:
            return Cursor(self.owner_rows)
        if "from library.libraries" in normalized and "for update" in normalized:
            return Cursor(self.library_rows)
        if "from library.library_memberships" in normalized:
            return Cursor(self.membership_rows)
        if "from app.account_credentials" in normalized:
            return Cursor(self.credential_rows)
        if "insert into app.account_credentials" in normalized:
            return Cursor(({"created": True},))
        return Cursor()


def _service(auth_bootstrap, connection, *, config=None):
    values = {
        "ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL,
        "bootstrap_email_normalized": "Rendref+owner@example.test",
        "argon2": {
            "memory_cost": 65_536,
            "time_cost": 3,
            "parallelism": 1,
            "salt_len": 16,
            "hash_len": 32,
        },
        "argon2_policy_version": 3,
    }
    if config is not None:
        values = config
    return auth_bootstrap.PostgresAuthBootstrapService(
        values, connect=lambda database_url: connection
    )


def _reconcile(service):
    return service.reconcile_owner(
        encoded_hash=ENCODED_HASH,
        hash_policy_version=3,
    )


def _indexes(connection, fragments):
    sql = [item[0] for item in connection.operations]
    return [next(i for i, statement in enumerate(sql) if fragment in statement) for fragment in fragments]


def test_reconcile_requires_database_url(auth_bootstrap):
    service = _service(auth_bootstrap, RecordingConnection(), config={
        "bootstrap_email_normalized": "Rendref+owner@example.test"
    })
    with pytest.raises(RuntimeError, match="ALBUM_HAVEN_APP_DATABASE_URL"):
        _reconcile(service)


def test_reconcile_preserves_ids_and_uses_one_ordered_transaction(auth_bootstrap):
    connection = RecordingConnection()
    result = _reconcile(_service(auth_bootstrap, connection))

    assert result.account_id == 41
    assert result.library_id == 73
    assert result.credential_created is True
    assert connection.events == ["transaction:enter", "transaction:commit"]
    assert _indexes(connection, [
        "from app.bootstrap_owners",
        "from library.libraries",
        "from app.accounts",
        "from library.library_memberships",
        "from app.account_credentials",
    ]) == sorted(_indexes(connection, [
        "from app.bootstrap_owners",
        "from library.libraries",
        "from app.accounts",
        "from library.library_memberships",
        "from app.account_credentials",
    ]))
    sql = " ".join(statement for statement, _ in connection.operations)
    assert "insert into app.accounts" not in sql
    assert "insert into library.libraries" not in sql
    assert "for update" in sql


def test_reconcile_updates_fixed_identity_owner_pointer_membership_and_credential(auth_bootstrap):
    connection = RecordingConnection()
    _reconcile(_service(auth_bootstrap, connection))

    operations = connection.operations
    account_update = next(item for item in operations if "update app.accounts" in item[0])
    assert {"Rendref", "rendref", "Rendref+owner@example.test", 41}.issubset(
        set(account_update[1])
    )
    assert "is_active" in account_update[0] and "disabled_at" in account_update[0]
    assert "account_kind" in account_update[0]
    assert "bootstrap_owner" in set(account_update[1])
    library_update = next(item for item in operations if "update library.libraries" in item[0])
    assert {41, 73}.issubset(set(library_update[1]))
    membership = next(item for item in operations if "insert into library.library_memberships" in item[0])
    assert "membership_role" in membership[0] and "owner" in set(membership[1])
    credential = next(item for item in operations if "insert into app.account_credentials" in item[0])
    assert ENCODED_HASH in set(credential[1])
    assert "argon2id" in set(credential[1])


def test_reconcile_uses_the_unique_local_library_identity_not_its_mutable_name(auth_bootstrap):
    connection = RecordingConnection()
    _reconcile(_service(auth_bootstrap, connection))

    library_lock = next(
        item
        for item in connection.operations
        if "from library.libraries" in item[0] and "for update" in item[0]
    )
    assert "library_kind = 'local'" in library_lock[0]
    assert "library.libraries.name" not in library_lock[0]
    assert "Local Library" not in repr(library_lock[1])


def test_reconcile_rejects_a_local_library_owned_by_another_account(auth_bootstrap):
    connection = RecordingConnection(
        library_rows=({"id": 73, "owner_account_id": 99},)
    )

    with pytest.raises(RuntimeError, match="library context"):
        _reconcile(_service(auth_bootstrap, connection))

    assert connection.events[-1] == "transaction:rollback"
    assert not any(
        statement.startswith(("update ", "insert "))
        for statement, _ in connection.operations
    )


def test_collision_check_stays_in_the_account_lock_phase(auth_bootstrap):
    connection = RecordingConnection()
    _reconcile(_service(auth_bootstrap, connection))

    sql = [statement for statement, _ in connection.operations]
    collision_index = next(
        index
        for index, statement in enumerate(sql)
        if "username_normalized" in statement and "from app.accounts" in statement
    )
    owner_index = next(
        index for index, statement in enumerate(sql) if "from app.bootstrap_owners" in statement
    )
    library_index = next(
        index for index, statement in enumerate(sql) if "from library.libraries" in statement
    )
    assert owner_index < library_index < collision_index
    assert "for update" in sql[collision_index]
    assert "order by app.accounts.id" in sql[collision_index]


def test_reconcile_fails_closed_without_transaction_support(auth_bootstrap):
    connection = RecordingConnection()
    connection.transaction = None

    with pytest.raises(RuntimeError, match="transaction"):
        _reconcile(_service(auth_bootstrap, connection))

    assert connection.operations == []


def test_injected_tuple_rows_follow_the_same_contract(auth_bootstrap):
    connection = RecordingConnection(
        account_rows=((41,),),
        owner_rows=((41,),),
        library_rows=((73, 41),),
    )

    result = _reconcile(_service(auth_bootstrap, connection))

    assert result.account_id == 41
    assert result.library_id == 73


@pytest.mark.parametrize(
    "overrides",
    [
        {"account_rows": ()},
        {"owner_rows": ()},
        {"library_rows": ()},
        {"library_rows": ({"id": 73}, {"id": 74})},
        {"collision_rows": ({"id": 99},)},
    ],
)
def test_reconcile_rejects_missing_ambiguous_or_colliding_context_before_mutation(
    auth_bootstrap, overrides
):
    connection = RecordingConnection(**overrides)
    with pytest.raises(RuntimeError) as caught:
        _reconcile(_service(auth_bootstrap, connection))

    assert ENCODED_HASH not in str(caught.value)
    assert connection.events[-1] == "transaction:rollback"
    assert not any(
        statement.startswith(("update ", "insert "))
        for statement, _ in connection.operations
    )


def test_any_existing_valid_credential_is_idempotently_preserved_and_not_reinserted(
    auth_bootstrap,
):
    connection = RecordingConnection(credential_rows=({
        "encoded_hash": EXISTING_VALID_HASH,
        "hash_algorithm": "argon2id",
        "hash_policy_version": 2,
        "credential_version": 7,
    },))
    result = _reconcile(_service(auth_bootstrap, connection))

    assert result.credential_created is False
    assert not any("insert into app.account_credentials" in sql for sql, _ in connection.operations)
    assert not any("update app.account_credentials" in sql for sql, _ in connection.operations)


def test_malformed_existing_credential_rolls_back_without_exposing_hash(auth_bootstrap):
    connection = RecordingConnection(credential_rows=({
        "encoded_hash": "$argon2id$v=19$malformed",
        "hash_algorithm": "argon2id",
        "hash_policy_version": 2,
        "credential_version": 1,
    },))
    with pytest.raises(RuntimeError) as caught:
        _reconcile(_service(auth_bootstrap, connection))

    assert ENCODED_HASH not in str(caught.value)
    assert connection.events[-1] == "transaction:rollback"
    assert not any(statement.startswith(("update ", "insert ")) for statement, _ in connection.operations)


def test_result_and_noncredential_operations_redact_hash(auth_bootstrap):
    connection = RecordingConnection()
    result = _reconcile(_service(auth_bootstrap, connection))

    assert ENCODED_HASH not in repr(result)
    for sql, params in connection.operations:
        if "insert into app.account_credentials" not in sql:
            assert ENCODED_HASH not in repr(params)


@pytest.mark.parametrize(
    "encoded_hash",
    ["$argon2id$", "$argon2id$v=19$malformed", "$argon2i$v=19$m=8,t=1,p=1$bad$bad"],
)
def test_reconcile_rejects_malformed_or_non_id_argon2_hash_before_connect(
    auth_bootstrap, encoded_hash
):
    connection = RecordingConnection()

    with pytest.raises(ValueError) as caught:
        _service(auth_bootstrap, connection).reconcile_owner(
            encoded_hash=encoded_hash,
            hash_policy_version=3,
        )

    assert encoded_hash not in str(caught.value)
    assert connection.operations == []


def test_reconcile_rejects_incoming_hash_below_the_configured_floor(auth_bootstrap):
    weak_hash = PasswordHasher(
        memory_cost=8,
        time_cost=1,
        parallelism=1,
        salt_len=8,
        hash_len=16,
        type=Type.ID,
    ).hash("weak bootstrap fixture hash")
    connection = RecordingConnection()

    with pytest.raises(ValueError, match="credential"):
        _service(auth_bootstrap, connection).reconcile_owner(
            encoded_hash=weak_hash,
            hash_policy_version=3,
        )

    assert connection.operations == []


def test_reconcile_requires_the_active_hash_policy_version(auth_bootstrap):
    connection = RecordingConnection()

    with pytest.raises(ValueError, match="policy version"):
        _service(auth_bootstrap, connection).reconcile_owner(
            encoded_hash=ENCODED_HASH,
            hash_policy_version=2,
        )

    assert connection.operations == []
