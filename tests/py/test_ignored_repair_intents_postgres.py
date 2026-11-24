"""An Ignore never waits on a held publication (deadlock part 3, 6.5's ruling: no unbounded wait on a request).

An ignored-repair write tries the inventory publication lock for a bounded moment. When a scan or save holds
it, the write keeps a durable intent row instead, answers "pending" at once, and the drain applies the intents
under the lock once the publication ends: in the order they were made, each once. Until then every read of
the ignored repairs already shows them, so a reload keeps the change.
"""
from __future__ import annotations

from time import monotonic

import psycopg
import pytest

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
    started = monotonic()
    result = write()
    return result, monotonic() - started


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
        assert first(library, keys) == "pending"
        assert second(library, keys) == "pending"
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
        assert _ignore(library, keys) == "pending"
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
        assert _ignore(library, keys) == "pending"
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
