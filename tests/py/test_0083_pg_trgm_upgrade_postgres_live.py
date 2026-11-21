"""Live regression coverage for schema-aware execution of migration 0083."""

from hashlib import sha256
from pathlib import Path

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
)


_MIGRATION_NAME = "0083_add_album_raw_artist_search_index.sql"
_RELEASED_SHA256 = "6531983a2ca6020cef9df58f968c855f160993fdd82582b81fed1b04af69c1f4"


def _index_contract(connection):
    return connection.execute(
        """
        select
          index_state.indexrelid::oid as index_oid,
          index_state.indisvalid,
          index_state.indisready,
          operator_namespace.nspname as operator_schema,
          operator_class.opcname as operator_class_name,
          exists (
            select 1
            from pg_catalog.pg_depend operator_dependency
            join pg_catalog.pg_extension extension
              on extension.oid = operator_dependency.refobjid
            where operator_dependency.classid = 'pg_catalog.pg_opclass'::regclass
              and operator_dependency.objid = operator_class.oid
              and operator_dependency.refclassid = 'pg_catalog.pg_extension'::regclass
              and operator_dependency.deptype = 'e'
              and extension.extname = 'pg_trgm'
          ) as operator_class_owned_by_pg_trgm
        from pg_catalog.pg_class index_relation
        join pg_catalog.pg_namespace index_namespace
          on index_namespace.oid = index_relation.relnamespace
        join pg_catalog.pg_index index_state
          on index_state.indexrelid = index_relation.oid
        join pg_catalog.pg_opclass operator_class
          on operator_class.oid = index_state.indclass[0]
        join pg_catalog.pg_namespace operator_namespace
          on operator_namespace.oid = operator_class.opcnamespace
        where index_namespace.nspname = 'library'
          and index_relation.relname = 'local_albums_normalized_raw_artists_trgm_idx'
        """
    ).fetchone()


def test_live_0083_upgrade_uses_public_pg_trgm_opclass_and_keeps_original_ledger(
    monkeypatch,
):
    setup_url, _ = _dedicated_database_urls_or_skip(monkeypatch)
    root = Path(__file__).resolve().parents[2]
    migrations = sorted((root / "migrations" / "postgres").glob("*.sql"))
    legacy = [path for path in migrations if path.name < _MIGRATION_NAME]
    migration = root / "migrations" / "postgres" / _MIGRATION_NAME
    verifier = root / "scripts" / "postgres" / "verify_0083_album_raw_artist_index.sql"

    assert legacy[-1].name == "0082_preserve_relations_for_missing_album_removal.sql"
    assert sha256(migration.read_bytes()).hexdigest() == _RELEASED_SHA256

    try:
        _drop_application_schemas(setup_url)
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("drop extension if exists pg_trgm cascade")
            connection.execute("create extension pg_trgm with schema public")

        isolatedPostgres.apply_migrations(setup_url, legacy)
        isolatedPostgres.apply_migrations(setup_url, [migration])

        with isolatedPostgres._connect(setup_url) as connection:
            extension_schema = connection.execute(
                """
                select namespace.nspname
                from pg_catalog.pg_extension extension
                join pg_catalog.pg_namespace namespace
                  on namespace.oid = extension.extnamespace
                where extension.extname = 'pg_trgm'
                """
            ).fetchone()["nspname"]
            first_index = _index_contract(connection)
            first_ledger = connection.execute(
                """
                select checksum, applied_at
                from ops.schema_migrations
                where migration_name = %s
                """,
                (_MIGRATION_NAME,),
            ).fetchone()
            verifier_state = connection.execute(
                verifier.read_text(encoding="utf-8")
            ).fetchone()["index_state"]

        assert extension_schema == "public"
        assert first_index["indisvalid"] is True
        assert first_index["indisready"] is True
        assert first_index["operator_schema"] == "public"
        assert first_index["operator_class_name"] == "gin_trgm_ops"
        assert first_index["operator_class_owned_by_pg_trgm"] is True
        assert first_ledger["checksum"] == _RELEASED_SHA256
        assert verifier_state == "ready"

        isolatedPostgres.apply_migrations(setup_url, [migration])

        with isolatedPostgres._connect(setup_url) as connection:
            second_index = _index_contract(connection)
            second_ledger = connection.execute(
                """
                select checksum, applied_at
                from ops.schema_migrations
                where migration_name = %s
                """,
                (_MIGRATION_NAME,),
            ).fetchone()

        assert second_index == first_index
        assert second_ledger == first_ledger
    finally:
        _drop_application_schemas(setup_url)
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("drop extension if exists pg_trgm cascade")
