"""An Ignore never waits on a held publication (deadlock part 3, 6.5's ruling: no unbounded wait on a request).

An ignored-repair write tries the inventory publication lock for a bounded moment. When a scan or save holds
it, the write keeps a durable intent row instead, answers "pending" at once, and the drain applies the intents
under the lock once the publication ends: in the order they were made, each once. Until then every read of
the ignored repairs already shows them, so a reload keeps the change.
"""
from __future__ import annotations

import json
from time import monotonic

import psycopg
import psycopg.rows
import pytest

from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)
from tests.py.test_problematic_index_two_writers_postgres import _Writer, library  # noqa: F401 (live fixture)

ANSWER_SECONDS = 1.0


def _keys(library):
    return {f"{album['album_key']}::problem-album::rule": album["album_key"] for album in (library.first, library.second)}


def _stored(library):
    with psycopg.connect(library.fixture.setup_url) as connection:
        return {row[0] for row in connection.execute("select repair_key from library.ignored_repairs").fetchall()}


def _pending(library):
    with psycopg.connect(library.fixture.setup_url) as connection:
        return connection.execute("select count(*) from library.ignored_repair_intents").fetchone()[0]


def _ignore(library, keys):
    from music_app.services.ignored_repairs import create_ignored_repair_keys

    return create_ignored_repair_keys(library.fixture.config, set(keys), album_keys_by_repair_key=dict(keys))


def _unignore(library, keys):
    from music_app.services.ignored_repairs import delete_ignored_repair_keys

    return delete_ignored_repair_keys(library.fixture.config, set(keys))


def _replace(library, keys):
    from music_app.services.ignored_repairs import save_ignored_repair_keys

    return save_ignored_repair_keys(library.fixture.config, set(keys))


def _shown(library):
    from music_app.services.ignored_repairs import load_ignored_repair_keys

    return load_ignored_repair_keys(library.fixture.config)


def _drained(library):
    from music_app.services import ignored_repair_intents

    ignored_repair_intents.wait_for_background_work()


def _timed(write):
    """A write made while the test holds the publication: on its own thread, so a write that waits for the
    lock fails here instead of hanging the test, which releases the lock only afterwards."""
    started = monotonic()
    writer = _Writer(write)
    writer.join(ANSWER_SECONDS * 3)
    assert not writer.is_alive(), "The write is still waiting for the held publication."
    if writer.error is not None:
        raise writer.error
    return writer.result, monotonic() - started


def _answered(write):
    return _timed(write)[0]


WRITERS = {
    "ignore": lambda library, keys: _ignore(library, keys),
    "replace": lambda library, keys: _replace(library, keys),
}


@pytest.mark.parametrize("write", WRITERS.values(), ids=WRITERS.keys())
def test_an_ignore_during_a_held_publication_answers_within_a_second_and_applies_after_it(library, write):
    keys = _keys(library)
    library.clear_marks()
    save = library.save()
    try:
        result, elapsed = _timed(lambda: write(library, keys))
        assert result == "pending"
        assert elapsed < ANSWER_SECONDS, f"The Ignore answered after {elapsed:.3f} s."
        assert _stored(library) == set()
        assert _pending(library) == 1
        # A reload reads the ignored repairs: the pending Ignore already shows.
        assert _shown(library) == set(keys)
        assert library.marked() == []
    finally:
        save.rollback()
        save.close()
    _drained(library)
    assert _stored(library) == set(keys)
    assert _pending(library) == 0
    assert _shown(library) == set(keys)
    assert library.marked() == sorted([library.first["id"], library.second["id"]])


def test_an_unignore_during_a_held_publication_answers_within_a_second_and_applies_after_it(library):
    keys = _keys(library)
    assert _ignore(library, keys) == "applied"
    save = library.save()
    try:
        result, elapsed = _timed(lambda: _unignore(library, keys))
        assert result == "pending"
        assert elapsed < ANSWER_SECONDS, f"The Unignore answered after {elapsed:.3f} s."
        assert _stored(library) == set(keys)
        assert _shown(library) == set()
    finally:
        save.rollback()
        save.close()
    _drained(library)
    assert _stored(library) == set()
    assert _pending(library) == 0


def test_an_ignore_with_no_publication_held_applies_at_once_and_keeps_no_intent(library):
    keys = _keys(library)
    assert _ignore(library, keys) == "applied"
    assert _stored(library) == set(keys)
    assert _pending(library) == 0


@pytest.mark.parametrize("last", ["ignore", "unignore"])
def test_pending_intents_apply_in_the_order_they_were_made(library, last):
    keys = _keys(library)
    first, second = (_unignore, _ignore) if last == "ignore" else (_ignore, _unignore)
    expected = set(keys) if last == "ignore" else set()
    if last == "ignore":
        assert _ignore(library, keys) == "applied"
    save = library.save()
    try:
        assert _answered(lambda: first(library, keys)) == "pending"
        assert _answered(lambda: second(library, keys)) == "pending"
        assert _shown(library) == expected
    finally:
        save.rollback()
        save.close()
    _drained(library)
    assert _stored(library) == expected
    assert _shown(library) == expected
    assert _pending(library) == 0


def test_an_intent_applies_once_and_reapplying_its_effect_changes_nothing(library):
    from music_app.services import ignored_repair_intents

    keys = _keys(library)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, keys)) == "pending"
    finally:
        save.rollback()
        save.close()
    _drained(library)
    with psycopg.connect(library.fixture.setup_url) as connection:
        before = connection.execute(
            "select repair_key, metadata, xmin::text from library.ignored_repairs order by 1").fetchall()
    library.clear_marks()
    # A second drain finds nothing left to apply: no row is written again and no album is marked again.
    assert ignored_repair_intents.drain(library.fixture.config) == 0
    with psycopg.connect(library.fixture.setup_url) as connection:
        after = connection.execute(
            "select repair_key, metadata, xmin::text from library.ignored_repairs order by 1").fetchall()
    assert after == before
    assert library.marked() == []


def test_a_drain_started_during_a_held_publication_waits_for_it_and_never_applies_early(library):
    from music_app.services import ignored_repair_intents

    keys = _keys(library)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, keys)) == "pending"
        drain = _Writer(lambda: ignored_repair_intents.drain(library.fixture.config))
        drain.join(ANSWER_SECONDS * 2)
        assert drain.is_alive(), "The drain did not wait for the publication."
        assert _stored(library) == set()
    finally:
        save.rollback()
        save.close()
    drain.join(30)
    assert not drain.is_alive() and drain.error is None, drain.error
    _drained(library)
    assert _stored(library) == set(keys)
    assert _pending(library) == 0


# 6.5's ruling on the reload: the server lays the pending intents over every read, scoped to what it reads, so
# a reload, a second tab or another device shows the Ignore while the publication still holds it back.
def _repository(library):
    from music_app.services import library_browse_postgres as browse, problematic_index

    repository = browse.PostgresLibraryBrowseRepository({**library.fixture.config, problematic_index.ENABLED_KEY: "1"})
    problematic_index.prepare_for_serving(repository)
    return repository


def _first_album_problem(library, repository):
    """Album A's first album-scope problem, as its detail offers it to Ignore."""
    page = repository.build_problematic_files_page(limit=50, cursor="")
    item = next(item for item in page["items"] if item["name"] == "Album A")
    detail = repository.build_problematic_file_detail_payload(item["key"])
    row = detail["album_problem_rows"][0]
    return item["key"], row["row_key"], row["album_key"], row.get("problem_reason") or row["reason"]


def _reloaded(repository, item_key):
    """What a reload shows: the Rules' ignored problems, the album's detail rows, and its page item."""
    rules = repository.build_utility_rules_payload()
    rule = next(rule for rule in rules["rules"] if rule.get("key") == "problem-ignores")
    ignored = {item["row_key"] for item in rule.get("items") or []}
    detail = repository.build_problematic_file_detail_payload(item_key)
    detail_rows = {row["row_key"] for row in (detail or {}).get("album_problem_rows") or []}
    page = repository.build_problematic_files_page(limit=50, cursor="")
    reasons = next((item["problem_reasons"] for item in page["items"] if item["key"] == item_key), None)
    return ignored, detail_rows, reasons


def test_a_pending_ignore_shows_after_a_reload_in_the_rules_the_details_and_the_page(library):
    repository = _repository(library)
    item_key, row_key, album_key, reason = _first_album_problem(library, repository)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, {row_key: album_key})) == "pending"
        ignored, detail_rows, reasons = _reloaded(repository, item_key)
        assert row_key in ignored
        assert row_key not in detail_rows
        assert reasons is None or reason not in reasons
    finally:
        save.rollback()
        save.close()
    _drained(library)
    assert _pending(library) == 0
    assert _reloaded(repository, item_key) == (ignored, detail_rows, reasons)


def test_a_pending_unignore_shows_after_a_reload_in_the_rules_and_the_details(library):
    repository = _repository(library)
    item_key, row_key, album_key, _reason = _first_album_problem(library, repository)
    assert _ignore(library, {row_key: album_key}) == "applied"
    save = library.save()
    try:
        assert _answered(lambda: _unignore(library, {row_key: album_key})) == "pending"
        ignored, detail_rows, _reasons = _reloaded(repository, item_key)
        assert row_key not in ignored
        assert row_key in detail_rows
    finally:
        save.rollback()
        save.close()
    _drained(library)
    assert _pending(library) == 0
    ignored, detail_rows, _reasons = _reloaded(repository, item_key)
    assert row_key not in ignored
    assert row_key in detail_rows


# 6.5 (11-24): the drain never stalls silently. An intent that cannot be applied is marked failed, logged and
# reported in the Rules payload; the others still apply. A drain that keeps failing as a whole fails its intents
# after DRAIN_ATTEMPTS passes instead of leaving them pending forever.
def _failed(library):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    payload = PostgresLibraryBrowseRepository(library.fixture.config).build_utility_rules_payload()
    # What GET /utilities/rules sends (FTC-UTIL-PROBLEMS-015: a failed intent's datetime made it a 500).
    payload = json.loads(json.dumps(payload))
    return {item["row_key"]: item for item in payload.get("failed_ignored_repairs") or []}


def _index_batch(library):
    """The rows one Problematic Files index batch stores for both albums, and how often it read the intents."""
    from music_app.services import problematic_index, rule_state_postgres
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    intent_reads = []
    read_intents = rule_state_postgres.pending_ignored_repairs

    def counted(*args, **kwargs):
        intent_reads.append(1)
        return read_intents(*args, **kwargs)

    rule_state_postgres.pending_ignored_repairs = counted
    try:
        repository = PostgresLibraryBrowseRepository(library.fixture.config)
        with psycopg.connect(library.fixture.runtime_url, row_factory=psycopg.rows.dict_row) as connection:
            items, _duplicates, _replaced = problematic_index._index_rows(
                repository, connection, problematic_index._library_id(connection),
                [library.first["id"], library.second["id"]], False, duplicates=False)
    finally:
        rule_state_postgres.pending_ignored_repairs = read_intents
    return items, len(intent_reads)


def _waiting_ignore(library, monkeypatch, keys):
    from music_app.services import ignored_repair_intents

    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, keys)) == "pending"
    finally:
        save.rollback()
        save.close()
    assert _pending(library) == 1 and _shown(library) == set(keys), "the Ignore waits and reads already show it"


def test_an_index_batch_with_a_waiting_ignore_stores_the_same_rows_as_with_none(library, monkeypatch):
    """The persisted index holds what the library holds: a waiting Ignore is laid over reads, never stored by an
    index batch (which would keep showing it after the intent fails). The batch reads no intents at all."""
    keys = _keys(library)
    without, _reads = _index_batch(library)
    _waiting_ignore(library, monkeypatch, keys)

    with_waiting, intent_reads = _index_batch(library)

    assert with_waiting == without, "an index batch stored a waiting Ignore"
    assert intent_reads == 0, f"an index batch read the waiting intents {intent_reads} times"


def test_a_failed_ignore_is_not_stored_as_ignored_by_the_next_index_batch(library, monkeypatch):
    keys = _keys(library)
    without, _reads = _index_batch(library)
    _waiting_ignore(library, monkeypatch, keys)
    with psycopg.connect(library.fixture.setup_url) as connection:
        connection.execute("""update library.ignored_repair_intents
                              set failed_at = now(), failure = 'refused', failure_kind = 'error'""")

    after_failure, _reads = _index_batch(library)

    assert _shown(library) == set(), "a failed Ignore is not shown as made"
    assert after_failure == without, "the next index batch stored the failed Ignore"

def test_a_drain_where_one_intent_fails_applies_the_others_and_reports_the_failed_one(library, monkeypatch, caplog):
    from music_app.services import ignored_repair_intents, rule_state_postgres

    keys = _keys(library)
    first, second = sorted(keys)
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, {first: keys[first]})) == "pending"
        assert _answered(lambda: _ignore(library, {second: keys[second]})) == "pending"
    finally:
        save.rollback()
        save.close()
    apply = rule_state_postgres._apply_ignored_repair_intent

    def apply_except_first(connection, intent):
        if first in (intent.get("repair_keys") or []):
            raise RuntimeError("this intent cannot be applied")
        return apply(connection, intent)

    monkeypatch.setattr(rule_state_postgres, "_apply_ignored_repair_intent", apply_except_first)
    with caplog.at_level("WARNING"):
        assert ignored_repair_intents.drain(library.fixture.config) == 1
    assert _stored(library) == {second}
    assert _shown(library) == {second}, "a failed intent is no longer shown as made"
    failed = _failed(library)
    assert set(failed) == {first}
    assert "cannot be applied" in failed[first]["failure"]
    assert any("failed" in record.getMessage() and first in record.getMessage() for record in caplog.records)
    # A later drain does not try the failed intent again, and nothing is left pending.
    monkeypatch.setattr(rule_state_postgres, "_apply_ignored_repair_intent", apply)
    assert ignored_repair_intents.drain(library.fixture.config) == 0
    assert _stored(library) == {second}


def test_intents_a_drain_keeps_failing_to_apply_are_failed_after_its_last_attempt(library, monkeypatch, caplog):
    from music_app.services import ignored_repair_intents, rule_state_postgres

    keys = _keys(library)
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, keys)) == "pending"
    finally:
        save.rollback()
        save.close()

    def broken(_connection):
        raise RuntimeError("the drain cannot run")

    monkeypatch.setattr(rule_state_postgres, "apply_pending_ignored_repair_intents", broken)
    with caplog.at_level("WARNING"):
        for attempt in range(ignored_repair_intents.DRAIN_ATTEMPTS):
            assert _failed(library) == {}, f"failed early, at attempt {attempt}"
            ignored_repair_intents._drain_queued(library.fixture.config, library.fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"])
    assert set(_failed(library)) == set(keys)
    assert _pending(library) == 1
    assert _shown(library) == set(), "a failed intent is no longer shown as made"
    assert any("failed" in record.getMessage() for record in caplog.records)


# 6.5 (11-24): "stuck" is counted only from the moment the lock was free and a drain was due, never while a
# publication holds the library. The bound comes from config (ALBUM_HAVEN_IGNORE_INTENT_STALL_SECONDS).
STALL_SECONDS = 1


def test_a_scan_holding_the_lock_past_the_bound_never_makes_a_waiting_ignore_stuck(library, monkeypatch):
    from music_app.services import ignored_repair_intents

    keys = _keys(library)
    config = {**library.fixture.config, "ALBUM_HAVEN_IGNORE_INTENT_STALL_SECONDS": STALL_SECONDS}
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, keys)) == "pending"
        drain = _Writer(lambda: ignored_repair_intents.drain(config))
        drain.join(STALL_SECONDS * 3)
        assert drain.is_alive(), "the drain waits for the publication"
        later = _Writer(lambda: ignored_repair_intents.drain(config))
        later.join(STALL_SECONDS * 2)
    finally:
        save.rollback()
        save.close()
    for waiting in (drain, later):
        waiting.join(30)
        assert not waiting.is_alive() and waiting.error is None, waiting.error
    assert _failed(library) == {}
    assert _stored(library) == set(keys)
    assert _pending(library) == 0


def test_an_intent_a_drain_could_not_apply_once_the_lock_was_free_is_stuck_after_the_bound(library, monkeypatch):
    from time import sleep

    from music_app.services import ignored_repair_intents, rule_state_postgres

    keys = _keys(library)
    config = {**library.fixture.config, "ALBUM_HAVEN_IGNORE_INTENT_STALL_SECONDS": STALL_SECONDS}
    monkeypatch.setattr(ignored_repair_intents, "queue_drain", lambda _config: None)
    monkeypatch.setattr(ignored_repair_intents, "_schedule_retry", lambda _config: None)
    save = library.save()
    try:
        assert _answered(lambda: _ignore(library, keys)) == "pending"
    finally:
        save.rollback()
        save.close()

    def broken(_connection):
        raise RuntimeError("the drain cannot run")

    monkeypatch.setattr(rule_state_postgres, "apply_pending_ignored_repair_intents", broken)
    # The lock is free and the drain is due, but it fails: the clock starts now.
    ignored_repair_intents._drain_queued(config, config["ALBUM_HAVEN_APP_DATABASE_URL"])
    assert _failed(library) == {}
    sleep(STALL_SECONDS + 1)
    ignored_repair_intents._drain_queued(config, config["ALBUM_HAVEN_APP_DATABASE_URL"])
    failed = _failed(library)
    assert set(failed) == set(keys)
    assert {item["failure_kind"] for item in failed.values()} == {"stuck"}
    assert _shown(library) == set(), "a stuck intent is no longer shown as made"
