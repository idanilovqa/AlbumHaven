"""Real-Postgres proof of the guarded empty-album cleanup script."""

from __future__ import annotations

import json
import uuid

import pytest

from scripts import retire_empty_local_albums as script
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401


@pytest.fixture
def empty_albums(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    fixture.seed(fixture.entry("Owner/Kept/01.flac", album="Kept"))
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        owner = connection.execute(
            "select library_id, artist_id from library.local_albums"
        ).fetchone()

        def empty(key, metadata="{}"):
            return connection.execute("""
                insert into library.local_albums (library_id, artist_id, album_key, title, metadata)
                values (%s, %s, %s, %s, %s::jsonb) returning id
            """, (owner["library_id"], owner["artist_id"], key, key, metadata)).fetchone()["id"]

        fixture.clean_ids = [empty("owner::clean one"), empty("owner::clean two")]
        fixture.cover_id = empty("owner::user cover", '{"cover_selection_origin": "user"}')
        fixture.probe_id = empty("owner::probe")
        connection.execute("""
            insert into app.album_ratings (account_id, library_id, album_key, rating, provenance)
            select account_id, %s, 'owner::clean one', 6, 'file_tag_scan' from app.bootstrap_owners
        """, (owner["library_id"],))
        connection.execute("""
            create table library.retirement_probe (
              album_id bigint references library.local_albums(id) on delete cascade)
        """)
        connection.execute("insert into library.retirement_probe values (%s)", (fixture.probe_id,))
        fixture.database = connection.execute("select current_database() as name").fetchone()["name"]
    try:
        yield fixture
    finally:
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            connection.execute("drop table if exists library.retirement_probe")


def _album_ids(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return {row["id"] for row in connection.execute("select id from library.local_albums").fetchall()}


def _retire(fixture, tmp_path, **overrides):
    arguments = {
        "expected_count": 1,
        "backup_path": tmp_path / "backup.json",
        "confirm_database": fixture.database,
        **overrides,
    }
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return script.retire(connection, **arguments)


def test_live_dry_run_classifies_empty_albums_without_writing(empty_albums):
    fixture = empty_albums
    before = _album_ids(fixture)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        with connection.transaction():
            connection.execute("set transaction read only")
            report = script.classify(connection)

    assert (report["album_count"], report["empty_album_count"], report["retirable_count"]) == (5, 4, 1)
    assert [row["id"] for row in report["retirable"]] == fixture.clean_ids[1:]
    assert {row["id"]: row["kept_by"] for row in report["kept"]} == {
        fixture.clean_ids[0]: ["rating"],
        fixture.cover_id: ["cover_selection"],
        fixture.probe_id: ["unclassified:library.retirement_probe"],
    }
    assert report["kept_by_reason"]["cover_selection"] == 1
    assert _album_ids(fixture) == before


@pytest.mark.parametrize("overrides, message", [
    ({"expected_count": 2}, "Expected 2 retirable rows but found 1"),
    ({"confirm_database": "album_haven_other"}, "--confirm-database must be"),
])
def test_live_apply_refuses_mismatched_guards_and_writes_nothing(empty_albums, tmp_path, overrides, message):
    fixture = empty_albums
    before = _album_ids(fixture)

    with pytest.raises(script.RetirementRefused, match=message):
        _retire(fixture, tmp_path, **overrides)

    assert _album_ids(fixture) == before
    assert not (tmp_path / "backup.json").exists()


def test_live_apply_refuses_while_tag_edit_is_in_flight(empty_albums, tmp_path):
    fixture = empty_albums
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""
            insert into library.tag_edit_intents (id, library_root_identity, status, changes)
            values (%s, 'retirement-probe', 'prepared', '[{}]')
        """, (str(uuid.uuid4()),))
    before = _album_ids(fixture)

    with pytest.raises(script.RetirementRefused, match="tag edits are in flight"):
        _retire(fixture, tmp_path)

    assert _album_ids(fixture) == before


def test_live_apply_retires_only_unowned_empty_rows_after_backup(empty_albums, tmp_path):
    fixture = empty_albums
    before = _album_ids(fixture)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        revision = connection.execute(
            "select metadata ->> 'inventory_mutation_revision' as value from library.libraries "
            "where library_kind = 'local'"
        ).fetchone()["value"]

    result = _retire(fixture, tmp_path)

    assert result["retired_count"] == 1
    assert _album_ids(fixture) == before - set(fixture.clean_ids[1:])
    backup = json.loads((tmp_path / "backup.json").read_text(encoding="utf-8"))
    assert [album["id"] for album in backup["albums"]] == fixture.clean_ids[1:]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select album_key from app.album_ratings").fetchall() == [
            {"album_key": "owner::clean one"}
        ]
        new_revision = connection.execute(
            "select metadata ->> 'inventory_mutation_revision' as value from library.libraries "
            "where library_kind = 'local'"
        ).fetchone()["value"]
    assert int(new_revision) == int(revision or 0) + 1


def test_apply_on_shared_core_needs_owner_authorization():
    with pytest.raises(script.RetirementRefused, match="--owner-authorized-core"):
        script.assert_apply_target(
            script.SHARED_CORE_DATABASE,
            confirm_database=script.SHARED_CORE_DATABASE,
            owner_authorized_core=False,
        )
    script.assert_apply_target(
        script.SHARED_CORE_DATABASE,
        confirm_database=script.SHARED_CORE_DATABASE,
        owner_authorized_core=True,
    )
