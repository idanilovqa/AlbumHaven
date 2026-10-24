"""Read isolation through real normal Postgres tables, never an API mock."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
import re
from urllib.parse import urlparse
import uuid

import pytest

from music_app.services import listen_history as history
from music_app.services import recent_listen_read_seams as recent
from music_app.services.allowed_actions import AllowedActions
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter


NOW = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
START = NOW - timedelta(days=7)
MEASURED = "rendered_local_listen_session"
LEGACY = "runtime_listen_history_adapter"
BACKFILL = "phase_6_json_file_backfill"


@pytest.mark.parametrize("field,value", [
    ("account_id", None), ("account_id", True), ("account_id", 0),
    ("library_id", None), ("library_id", True), ("library_id", -1),
])
def test_recent_adapter_rejects_invalid_scope_before_connect(field, value):
    def forbidden(_url):
        raise AssertionError("Invalid Recent scope must not connect")

    adapter = PostgresListenHistoryAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://localhost/pytest_recent_unit"}, connect=forbidden,
    )
    kwargs = {"account_id": 41, "library_id": 73, "window_start": START, "window_end": NOW}
    kwargs[field] = value
    with pytest.raises(ValueError):
        adapter.load_recent_items(**kwargs)


def test_recent_adapter_queries_are_read_only_without_bootstrap_fallback():
    operations = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, params=None):
            operations.append((" ".join(sql.lower().split()), params))
            return self

        def fetchall(self):
            return []

    adapter = PostgresListenHistoryAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://localhost/pytest_recent_unit"},
        connect=lambda _url: Connection(),
    )
    assert adapter.load_recent_items(account_id=41, library_id=73, window_start=START, window_end=NOW) == []
    assert adapter.load_recent_album_candidates(library_id=73, legacy_track_refs=[]) == []
    assert operations
    for sql, _params in operations:
        assert sql.startswith(("select ", "with "))
        assert not re.search(r"\b(insert|update|delete|truncate|create|alter)\b", sql)
        assert "bootstrap" not in sql
    ledger_sql, ledger_params = next(operation for operation in operations if "integration.listen_history" in operation[0])
    assert "account_id" in ledger_sql and "library_id" in ledger_sql and "played_at" in ledger_sql
    assert ledger_params is not None


@pytest.fixture(scope="module")
def recent_ledger(tmp_path_factory, request):
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb

    app_url = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")
    setup_url = os.environ.get("DATABASE_MIGRATOR_URL", "")
    if not app_url:
        pytest.skip("Requires isolated Postgres contract database; no database coverage ran")
    parsed = urlparse(app_url)
    assert parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", parsed.path.lstrip("/"))
    assert setup_url and urlparse(setup_url).path == parsed.path
    assert urlparse(setup_url).hostname in {"localhost", "127.0.0.1", "::1"}
    token = uuid.uuid4().hex
    root = tmp_path_factory.mktemp("recent-ledger")
    accounts, libraries, event_ids = [], [], []
    events = {}

    def connect():
        return psycopg.connect(setup_url, row_factory=dict_row)

    def account(connection, suffix):
        name = f"recent-{token}-{suffix}"
        value = connection.execute(
            "insert into app.accounts(display_name,username_display,username_normalized,contact_email,contact_email_normalized) "
            "values(%s,%s,%s,%s,%s) returning id",
            (name, name, name, name + "@example.test", name + "@example.test"),
        ).fetchone()["id"]
        accounts.append(value)
        return value

    def catalog(connection, owner, suffix, *, library=None, stale=False):
        if library is None:
            library = connection.execute(
                "insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",
                (owner, f"recent-{token}-{suffix}"),
            ).fetchone()["id"]
            libraries.append(library)
        artist = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name) values(%s,%s,'Same artist') returning id",
            (library, f"artist-{suffix}"),
        ).fetchone()["id"]
        album = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title) values(%s,%s,%s,'Same album') returning id",
            (library, artist, f"album-{suffix}"),
        ).fetchone()["id"]
        track = connection.execute(
            "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,duration_seconds) "
            "values(%s,%s,%s,%s,'Same track',120) returning id",
            (library, album, artist, f"track-{suffix}"),
        ).fetchone()["id"]
        path = root / f"{suffix}.flac"
        path.write_bytes(b"fixture-owned-track-identity")
        connection.execute(
            "insert into library.local_track_files(track_id,private_path,metadata) values(%s,%s,%s)",
            (track, str(path), Jsonb({"scan_cache": {"stale": stale}})),
        )
        return {"library": library, "album": album, "track": track, "key": f"album-{suffix}", "path": str(path)}

    def event(connection, label, owner, catalog, *, source=MEASURED, played_at=NOW - timedelta(hours=1), seconds=12.5, finalized=True, payload_changes=None):
        measured = source == MEASURED
        source_payload = {
            "title": "Same track", "artist": "Same artist", "album_artist": "Same artist",
            "album": "Same album", "track_ref": catalog["path"], "path": catalog["path"],
            "started_at": (NOW - timedelta(days=30)).isoformat(),
            "recorded_at": (NOW + timedelta(days=30)).isoformat(),
            "total_listened_seconds": seconds if not measured else 999,
            "max_contiguous_seconds": seconds if not measured else 999,
            "source_provenance": {"kind": "local_playback"},
        }
        source_payload.update(payload_changes or {})
        value = connection.execute(
            "insert into integration.listen_history(account_id,library_id,track_id,track_key,played_at,source_family,source_entry_id,"
            "measurement_version,measured_listened_seconds,max_measured_contiguous_seconds,finalized,last_sequence,device_id,session_id,metadata) "
            "values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id",
            (owner, catalog["library"], catalog["track"], f"track-{label}", played_at, source,
             f"{token}-{label}", "rendered-pcm-v1" if measured else None,
             seconds if measured else None, min(seconds, 10) if measured else None,
             finalized if measured else None, 1 if measured else None,
             uuid.uuid4() if measured else None, uuid.uuid4() if measured else None,
             Jsonb({"source_payload": source_payload})),
        ).fetchone()["id"]
        event_ids.append(value)
        events[label] = value

    try:
        with connect() as connection:
            a, b, empty = (account(connection, suffix) for suffix in ("a", "b", "empty"))
            first = catalog(connection, a, "first")
            second = catalog(connection, a, "second")
            stale = catalog(connection, a, "stale", library=first["library"], stale=True)
            removed = catalog(connection, a, "removed", library=first["library"])
            event(connection, "measured", a, first)
            event(connection, "same-time-distinct-session", a, first)
            event(connection, "legacy", a, first, source=LEGACY, seconds=31)
            event(connection, "backfill", a, first, source=BACKFILL, seconds=22)
            event(connection, "lower", a, first, played_at=START)
            event(connection, "upper", a, first, played_at=NOW)
            event(connection, "old", a, first, played_at=START - timedelta(microseconds=1))
            event(connection, "future", a, first, played_at=NOW + timedelta(microseconds=1))
            event(connection, "ten", a, first, seconds=10)
            event(connection, "unfinished", a, first, finalized=False)
            event(connection, "unknown-source", a, first, source="unsupported_family", seconds=25)
            event(connection, "other-account", b, first, seconds=80)
            event(connection, "other-library", a, second, seconds=70)
            event(connection, "removed", a, removed, seconds=15)
            connection.execute("delete from library.local_tracks where id=%s", (removed["track"],))
            fuzzy = None
            if getattr(request, "param", None) == "fuzzy":
                # A separate library owns fuzzy matching scenarios. Empty shells are
                # legitimate persisted remnants after tracks detach; none are hidden
                # or rewritten during a read to make these expectations pass.
                fuzzy = catalog(connection, a, "fuzzy")
                artist_id = connection.execute(
                    "select artist_id from library.local_albums where id=%s", (fuzzy["album"],),
                ).fetchone()["artist_id"]
                for key, title in (("competing-shell", "Same album"), ("only-shell", "Shell only")):
                    connection.execute(
                        "insert into library.local_albums(library_id,artist_id,album_key,title,release_year) values(%s,%s,%s,%s,%s)",
                        (fuzzy["library"], artist_id, key, title, 1999),
                    )
                imported_catalog = {**fuzzy, "track": None, "path": ""}
                event(connection, "import-active", a, imported_catalog, source=BACKFILL, payload_changes={
                    "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
                })
                event(connection, "import-shell-only", a, imported_catalog, source=BACKFILL, payload_changes={
                    "album": "Shell only",
                    "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
                })
        yield {
            "config": {"ALBUM_HAVEN_APP_DATABASE_URL": app_url}, "connect": connect,
            "a": a, "b": b, "empty": empty, "first": first, "second": second,
            "stale": stale, "fuzzy": fuzzy, "events": events, "event_ids": event_ids,
        }
    finally:
        with connect() as connection:
            if event_ids:
                connection.execute("delete from integration.listen_history where id=any(%s)", (event_ids,))
            for library in libraries:
                connection.execute("delete from library.libraries where id=%s", (library,))
            for owner in accounts:
                connection.execute("delete from app.accounts where id=%s", (owner,))


def scoped_events(ledger, *, account=None, library=None):
    return history.load_recent_listen_history(
        ledger["config"], account_id=ledger["a"] if account is None else account,
        library_id=ledger["first"]["library"] if library is None else library,
        window_start=START, window_end=NOW,
    )


def test_postgres_recent_history_has_exact_account_and_library_scope(recent_ledger):
    ledger = recent_ledger
    a_events = scoped_events(ledger)
    expected = {ledger["events"][name] for name in (
        "measured", "same-time-distinct-session", "legacy", "backfill", "lower", "upper", "removed",
    )}
    assert {item["row_id"] for item in a_events} == expected
    assert {item["account_id"] for item in a_events} == {ledger["a"]}
    assert {item["library_id"] for item in a_events} == {ledger["first"]["library"]}
    assert [item["row_id"] for item in scoped_events(ledger, account=ledger["b"])] == [ledger["events"]["other-account"]]
    assert [item["row_id"] for item in scoped_events(ledger, library=ledger["second"]["library"])] == [ledger["events"]["other-library"]]
    assert scoped_events(ledger, account=ledger["empty"]) == []


def test_postgres_recent_query_bounds_and_ties_are_typed_and_stable(recent_ledger):
    ledger = recent_ledger
    adapter = PostgresListenHistoryAdapter(ledger["config"])
    rows = adapter.load_recent_items(
        account_id=ledger["a"], library_id=ledger["first"]["library"], window_start=START, window_end=NOW,
    )
    assert all(row["account_id"] == ledger["a"] and row["library_id"] == ledger["first"]["library"] for row in rows)
    assert all(START <= row["played_at"] <= NOW for row in rows)
    assert {ledger["events"]["lower"], ledger["events"]["upper"]} <= {row["id"] for row in rows}
    assert [(row["played_at"], row["id"]) for row in rows] == sorted((row["played_at"], row["id"]) for row in rows)
    assert {row["id"] for row in rows}.isdisjoint({ledger["events"]["old"], ledger["events"]["future"]})
    events = scoped_events(ledger)
    first = next(item for item in events if item["row_id"] == ledger["events"]["measured"])
    assert first["listened_seconds"] == 12.5
    assert first["played_at"] == NOW - timedelta(hours=1)


def test_postgres_recent_album_candidates_do_not_use_foreign_library_or_stale_media(recent_ledger):
    ledger = recent_ledger
    adapter = PostgresListenHistoryAdapter(ledger["config"])
    albums = adapter.load_recent_album_candidates(
        library_id=ledger["first"]["library"],
        legacy_track_refs=[ledger["first"]["path"], ledger["second"]["path"]],
    )
    by_id = {album["id"]: album for album in albums}
    assert ledger["second"]["album"] not in by_id
    assert by_id[ledger["first"]["album"]]["legacy_track_refs"][ledger["first"]["path"]] == ledger["first"]["track"]
    assert all(ledger["second"]["path"] not in album["legacy_track_refs"] for album in albums)
    assert by_id[ledger["first"]["album"]]["can_play"] is True
    assert by_id[ledger["stale"]["album"]]["can_play"] is False


def test_recent_reads_preserve_removed_ledger_rows_and_do_not_reclassify_them(recent_ledger, monkeypatch):
    ledger = recent_ledger
    monkeypatch.setattr(recent, "get_lastfm_user_timezone", lambda _config, *, account_id: "UTC")

    def snapshot():
        with ledger["connect"]() as connection:
            return connection.execute(
                "select * from integration.listen_history where id=any(%s) order by id", (ledger["event_ids"],),
            ).fetchall()

    before = snapshot()
    removed = next(row for row in before if row["id"] == ledger["events"]["removed"])
    assert removed["track_id"] is None and removed["measured_listened_seconds"] == 15
    kwargs = {
        "account_id": ledger["a"], "library_id": ledger["first"]["library"], "now": NOW,
        "allowed_actions_for_album": lambda _album: AllowedActions(("library.browse.read", "library.media.read")),
    }
    first = recent.build_recent_listen_payloads(ledger["config"], **kwargs)
    assert recent.build_recent_listen_payloads(ledger["config"], **kwargs) == first
    assert first["recent_not_local_albums"] == []
    assert [row["album_ref"] for row in first["recent_local_albums"]] == [ledger["first"]["key"]]
    assert first["recent_local_albums"][0]["listen_event_count"] == 6
    assert ledger["first"]["path"] not in repr(first)
    assert ledger["second"]["path"] not in repr(first)
    assert snapshot() == before


@pytest.mark.parametrize("recent_ledger", ["fuzzy"], indirect=True)
def test_empty_album_shells_neither_match_imports_nor_obscure_unique_current_album(recent_ledger, monkeypatch):
    ledger = recent_ledger
    monkeypatch.setattr(recent, "get_lastfm_user_timezone", lambda _config, *, account_id: "UTC")
    result = recent.build_recent_listen_payloads(
        ledger["config"], account_id=ledger["a"], library_id=ledger["fuzzy"]["library"], now=NOW,
        allowed_actions_for_album=lambda _album: AllowedActions(("library.browse.read", "library.media.read")),
    )
    assert [row["album_ref"] for row in result["recent_local_albums"]] == [ledger["fuzzy"]["key"]]
    local = result["recent_local_albums"][0]
    assert local["album_track_count"] == 1
    assert local["listen_event_count"] == 1
    assert local["allowed_actions"] == {"can_open_album": True, "can_play_album": True}
    assert [row["name"] for row in result["recent_not_local_albums"]] == ["Shell only"]
    external = result["recent_not_local_albums"][0]
    assert external["allowed_actions"] == {"can_open_album": False, "can_play_album": False}
    assert external.get("album_ref") is None
