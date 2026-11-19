"""Live contracts for migration 0189 and the change-event repository.

CI supplies its isolated, fully migrated contract database as
ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL (app role) and DATABASE_MIGRATOR_URL. Every test
creates its own accounts and libraries and removes only those; change rows cascade with them.
"""
from __future__ import annotations

import os
import re
import select
import uuid
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from music_app.services.library_change_events_postgres import LibraryChangeEventRepository


@pytest.fixture
def pg():
    import psycopg
    from psycopg.rows import dict_row

    url = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("Live change-event contract requires the CI isolated Postgres contract URL.")
    parsed = urlparse(url)
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", parsed.path.lstrip("/"))
    setup_url = os.environ.get("DATABASE_MIGRATOR_URL", "").strip()
    assert setup_url, "CI provisioning must supply DATABASE_MIGRATOR_URL for uniquely owned fixture cleanup"
    assert urlparse(setup_url).path == parsed.path

    def connect(*, autocommit=False, setup=False):
        return psycopg.connect(setup_url if setup else url, row_factory=dict_row, autocommit=autocommit)

    token = uuid.uuid4().hex
    accounts, libraries = [], []
    try:
        with connect(setup=True) as connection:
            for index in range(2):
                name = f"live-events-{token}-{index}"
                accounts.append(connection.execute(
                    "insert into app.accounts(display_name,username_display,username_normalized,contact_email,"
                    "contact_email_normalized) values (%s,%s,%s,%s,%s) returning id",
                    (name, name, name, f"{name}@example.test", f"{name}@example.test"),
                ).fetchone()["id"])
            for index in range(2):
                libraries.append(connection.execute(
                    "insert into library.libraries(owner_account_id,name,metadata) values (%s,%s,%s::jsonb) returning id",
                    (accounts[0], f"live-events-{token}-{index}", '{"inventory_mutation_revision": 3}'),
                ).fetchone()["id"])
        yield SimpleNamespace(
            connect=connect,
            accounts=accounts,
            libraries=libraries,
            repository=LibraryChangeEventRepository({"ALBUM_HAVEN_APP_DATABASE_URL": url}),
        )
    finally:
        with connect(setup=True) as connection:
            for library in libraries:
                connection.execute("delete from library.libraries where id = %s", (library,))
            for account in accounts:
                connection.execute("delete from app.accounts where id = %s", (account,))


def _events(pg, connection):
    return connection.execute(
        "select revision, library_id, account_id, kinds, refs from library.change_events "
        "where library_id = any(%s) or account_id = any(%s) order by revision",
        (pg.libraries, pg.accounts),
    ).fetchall()


def _bump_inventory(connection, library_id):
    connection.execute(
        "update library.libraries set metadata = jsonb_set(metadata, '{inventory_mutation_revision}', "
        "to_jsonb(coalesce((metadata ->> 'inventory_mutation_revision')::bigint, 0) + 1)) where id = %s",
        (library_id,),
    )


def _save_preference(connection, account_id, library_id, track_key):
    connection.execute(
        "insert into app.track_preferences(account_id, library_id, track_key, love_tier) values (%s,%s,%s,'loved')",
        (account_id, library_id, track_key),
    )


def test_inventory_revision_bump_records_one_library_event_at_commit_and_notifies(pg):
    library = pg.libraries[0]
    with pg.connect(autocommit=True) as listener:
        listener.execute("listen album_haven_library_changes")
        with pg.connect() as writer:
            _bump_inventory(writer, library)
            _bump_inventory(writer, library)
            assert _events(pg, writer) == []  # recorded only when the transaction commits
        select.select([listener.pgconn.socket], [], [], 5)
        payloads = [notice.payload for notice in listener.notifies(timeout=1)]
    with pg.connect() as reader:
        events = _events(pg, reader)
    assert [(e["library_id"], e["account_id"], e["kinds"], e["refs"]) for e in events] == [
        (library, None, ["inventory"], {}),
    ]
    assert str(events[0]["revision"]) in payloads


def test_rolled_back_write_records_nothing(pg):
    with pg.connect() as writer:
        _bump_inventory(writer, pg.libraries[0])
        writer.rollback()
    with pg.connect(setup=True) as reader:
        assert _events(pg, reader) == []
        assert reader.execute("select count(*) as n from library.change_event_pending").fetchone()["n"] == 0


def test_one_transaction_merges_kinds_and_identities_into_one_event_per_audience(pg):
    library, account = pg.libraries[0], pg.accounts[0]
    with pg.connect() as writer:
        _bump_inventory(writer, library)
        writer.execute(
            "update library.libraries set metadata = metadata || '{\"cover_mutation_revision\": 2}' where id = %s",
            (library,),
        )
        _save_preference(writer, account, library, "track-b")
        _save_preference(writer, account, library, "track-a")
    with pg.connect() as reader:
        events = {(e["library_id"], e["account_id"]): e for e in _events(pg, reader)}
    assert set(events) == {(library, None), (library, account)}
    assert events[(library, None)]["kinds"] == ["inventory", "covers"]
    assert events[(library, account)]["kinds"] == ["track_preferences"]
    assert events[(library, account)]["refs"] == {"track_refs": ["track-a", "track-b"]}


def test_more_than_two_hundred_identities_become_a_bulk_change(pg):
    library, account = pg.libraries[0], pg.accounts[0]
    with pg.connect() as writer:
        writer.execute(
            "insert into app.track_preferences(account_id, library_id, track_key) "
            "select %s, %s, 'track-' || n from generate_series(1, 201) n",
            (account, library),
        )
    with pg.connect() as reader:
        (event,) = _events(pg, reader)
    assert (event["kinds"], event["refs"]) == (["track_preferences"], {"bulk": ["track_preferences"]})


def test_statements_touching_no_rows_record_nothing(pg):
    with pg.connect() as writer:
        writer.execute("update app.track_preferences set love_tier = 'loved' where account_id = %s", (pg.accounts[1],))
        writer.execute("delete from app.saved_loops where account_id = %s", (pg.accounts[1],))
    with pg.connect() as reader:
        assert _events(pg, reader) == []


def test_reader_sees_its_library_and_own_account_events_in_revision_order(pg):
    (library, other_library), (account, other_account) = pg.libraries, pg.accounts
    since = pg.repository.head()
    with pg.connect() as writer:
        _bump_inventory(writer, library)
    with pg.connect() as writer:
        _bump_inventory(writer, other_library)
    with pg.connect() as writer:
        _save_preference(writer, other_account, library, "theirs")
    with pg.connect() as writer:
        _save_preference(writer, account, library, "mine")

    page = pg.repository.read_since(library_id=library, account_id=account, since=since)

    assert page.resync is False
    assert [(event.kinds, event.refs) for event in page.events] == [
        (("inventory",), {}),
        (("track_preferences",), {"track_refs": ["mine"]}),
    ]
    assert page.events[0].revision < page.events[1].revision
    assert page.head == pg.repository.head() == page.events[-1].revision


def test_reader_must_resync_when_its_cursor_cannot_be_replayed(pg):
    library, account = pg.libraries[0], pg.accounts[0]
    since = pg.repository.head()
    for _ in range(3):
        with pg.connect() as writer:
            _bump_inventory(writer, library)
    head = pg.repository.head()

    assert pg.repository.read_since(library_id=library, account_id=account, since=since, limit=2).resync is True
    assert pg.repository.read_since(library_id=library, account_id=account, since=head + 5).resync is True

    with pg.connect(setup=True) as connection:
        connection.execute(
            "update library.change_events set created_at = now() - interval '25 hours' "
            "where library_id = %s and revision < %s",
            (library, head),
        )
    assert pg.repository.prune() >= 2
    assert pg.repository.read_since(library_id=library, account_id=account, since=since).resync is True
    page = pg.repository.read_since(library_id=library, account_id=account, since=head - 1)
    assert (page.resync, [event.revision for event in page.events]) == (False, [head])
