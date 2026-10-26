"""Native rating-intent contracts, authored but not executed.

Real database cases use the existing favorites_db owned synthetic-data fixture.
That fixture commits setup and successful mutations, then deletes only its owned
rows after proving connections are drained. It is NOT a rollback-only fixture.
The bootstrap fixture and actual legacy importer are deliberately not invoked.

Positive cases require a separately authorized, already prepared nullable,
default-free timestamptz native_rating_intent_at column. This module performs no
DDL or migration. Negative catalog seams test fallback decisions, not whether
arbitrary physically incompatible DDL would allow ordinary INSERT statements.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta
from threading import Event

import pytest

from music_app.services.album_preferences import AlbumPreferenceError
from music_app.services.album_top_rating_intent import rating_intent_storage_ready
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.album_favorites_postgres_support import favorites_db, Observe, observed


CAPTURE_FLAG = 'ALBUM_HAVEN_TOP_LISTENING_PRESENTATION_ENABLED'
COMPATIBLE_CATALOG_ROW = {
    'type': 'timestamp with time zone',
    'attnotnull': False,
    'atthasdef': False,
    'attgenerated': '',
}


def normalized(sql):
    return ' '.join(str(sql).lower().split())


def is_intent_catalog_query(sql):
    sql = normalized(sql)
    return 'from pg_attribute' in sql and 'native_rating_intent_at' in sql


class CatalogResult:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class CatalogOnlyConnection:
    """Pure helper input; never used to replace a transaction or a writer."""
    def __init__(self, row):
        self.row, self.queries = row, []

    def execute(self, sql):
        assert is_intent_catalog_query(sql)
        self.queries.append(normalized(sql))
        return CatalogResult(self.row)


@pytest.mark.parametrize('row, ready', [
    (dict(COMPATIBLE_CATALOG_ROW), True),
    (None, False),
    ({**COMPATIBLE_CATALOG_ROW, 'type': 'text'}, False),
    ({**COMPATIBLE_CATALOG_ROW, 'type': 'timestamp without time zone'}, False),
    ({**COMPATIBLE_CATALOG_ROW, 'type': 'timestamp(3) with time zone'}, False),
    ({**COMPATIBLE_CATALOG_ROW, 'attnotnull': True}, False),
    ({**COMPATIBLE_CATALOG_ROW, 'atthasdef': True}, False),
    ({**COMPATIBLE_CATALOG_ROW, 'attgenerated': 's'}, False),
    ({**COMPATIBLE_CATALOG_ROW, 'attgenerated': 'v'}, False),
])
def test_genuine_readiness_helper_rejects_unknown_or_incompatible_storage(row, ready):
    connection = CatalogOnlyConnection(row)
    assert rating_intent_storage_ready(connection) is ready
    assert len(connection.queries) == 1
    query = connection.queries[0]
    assert "to_regclass('app.album_ratings')" in query
    assert "a.attname='native_rating_intent_at'" in query
    assert 'a.attnum>0' in query and 'not a.attisdropped' in query


def expect_error(status, operation):
    with pytest.raises(AlbumPreferenceError) as caught:
        operation()
    assert caught.value.status == status


def own_row(db, album=None, actor=None):
    album, actor = album or db.albums[0], actor or db.owner
    matches = [row for row in db.rows()
        if row['account_id'] == actor.account_id and row['album_key'] == album['key']]
    assert len(matches) == 1
    return matches[0]


def timestamp(row):
    value = datetime.fromisoformat(row['native_rating_intent_at'].replace('Z', '+00:00'))
    assert value.tzinfo is not None and value.utcoffset() is not None
    return value


def database_now(db):
    with db.connect() as connection:
        return connection.execute('select clock_timestamp() as now').fetchone()['now']


def assert_stable_except(before, after, allowed):
    assert before.keys() == after.keys()
    assert {key: value for key, value in after.items() if key not in allowed} == {
        key: value for key, value in before.items() if key not in allowed}


def assert_one_taste_change(before, after):
    assert after['album_taste_revision'] == before['album_taste_revision'] + 1
    assert (after['revision'], after['love_revision']) == (
        before['revision'], before['love_revision'])


@pytest.fixture
def rating_intent_db(favorites_db):
    db = favorites_db
    with db.app_connect(db.app_url) as connection:
        assert rating_intent_storage_ready(connection), (
            'Positive native-intent cases require separately authorized optional '
            'schema preparation; this test must not apply DDL or migrations.')
    db.config[CAPTURE_FLAG] = True
    return db


@pytest.mark.parametrize('configured', ['absent', False, 0, 1, 'true'])
def test_default_off_or_non_boolean_true_never_probes_and_preserves_old_noop(
        favorites_db, configured):
    db = favorites_db
    db.config.pop(CAPTURE_FLAG, None)
    if configured != 'absent':
        db.config[CAPTURE_FLAG] = configured
    statements = []

    def before(sql, params, connection):
        statements.append(normalized(sql))
        assert 'native_rating_intent_at' not in normalized(sql)

    connect = observed(db, before=before)
    first = db.patch(db.albums[0], {'rating': 7}, connect=connect)
    before_rows, before_epoch = db.rows(), db.epochs()
    repeated = db.patch(db.albums[0], {'rating': 7}, 1, connect=connect)
    assert first == repeated and repeated['preference_revision'] == 1
    assert db.rows() == before_rows and db.epochs() == before_epoch
    assert own_row(db).get('native_rating_intent_at') is None
    assert statements and not any(is_intent_catalog_query(sql) for sql in statements)


def test_favorite_only_insert_and_update_never_probe_even_when_enabled(favorites_db):
    db = favorites_db
    db.config[CAPTURE_FLAG] = True

    def before(sql, params, connection):
        assert 'native_rating_intent_at' not in normalized(sql)

    connect = observed(db, before=before)
    first = db.patch(db.albums[0], {'favorite': True}, connect=connect)
    second = db.patch(db.albums[0], {'favorite': False}, 1, connect=connect)
    assert first['preference_revision'] == 1 and second['preference_revision'] == 2
    assert second['rating'] is None and second['favorite'] is False
    assert own_row(db).get('native_rating_intent_at') is None


class UnavailableCatalogConnection(Observe):
    """Substitute only negative catalog facts, not authority, CAS or DML."""
    def __init__(self, connection, row, queries):
        super().__init__(connection)
        self.row, self.queries = row, queries

    def execute(self, sql, params=None, **kwargs):
        self.queries.append(normalized(sql))
        if is_intent_catalog_query(sql):
            assert params is None
            return CatalogResult(self.row)
        assert 'native_rating_intent_at' not in normalized(sql)
        return self.con.execute(sql, params, **kwargs)


@pytest.mark.parametrize('catalog_row', [
    None,
    {**COMPATIBLE_CATALOG_ROW, 'type': 'text'},
    {**COMPATIBLE_CATALOG_ROW, 'attnotnull': True},
    {**COMPATIBLE_CATALOG_ROW, 'atthasdef': True},
    {**COMPATIBLE_CATALOG_ROW, 'attgenerated': 's'},
])
def test_negative_catalog_decision_preserves_real_ordinary_writer(favorites_db, catalog_row):
    # The physical schema is the admitted fixture schema. Only the helper's
    # optional-column catalog response is substituted. In particular this does
    # NOT claim a real extra NOT NULL/no-default column would permit inserts.
    db = favorites_db
    db.config[CAPTURE_FLAG] = True
    queries = []

    @contextmanager
    def connect(url):
        with db.app_connect(url) as connection:
            yield UnavailableCatalogConnection(connection, catalog_row, queries)

    album = db.albums[0]
    first = db.patch(album, {'rating': 7}, connect=connect)
    before_rows, before_epoch = db.rows(), db.epochs()
    assert db.patch(album, {'rating': 7}, 1, connect=connect) == first
    assert db.rows() == before_rows and db.epochs() == before_epoch
    changed = db.patch(album, {'rating': 8}, 1, connect=connect)
    assert changed['rating'] == 8 and changed['preference_revision'] == 2
    assert own_row(db).get('native_rating_intent_at') is None
    assert_one_taste_change(before_epoch, db.epochs())
    assert sum(is_intent_catalog_query(sql) for sql in queries) == 3


def test_explicit_rating_and_same_value_rerating_stamp_only_own_exact_row(rating_intent_db):
    db = rating_intent_db
    album, other = db.albums[0], db.add_album('native-intent-other')
    db.patch(album, {'rating': 4}, actor=db.peer)
    db.patch(other, {'rating': 6})
    unrelated = {row['id']: row for row in db.rows()}
    peer_epoch, baseline_epoch = db.epochs(db.peer), db.epochs()

    earliest = database_now(db)
    first_result = db.patch(album, {'rating': 7})
    first, latest = own_row(db, album), database_now(db)
    assert first_result['preference_revision'] == first['preference_revision'] == 1
    assert first['rating'] == 7 and first['provenance'] == 'personal_rating'
    assert earliest <= timestamp(first) <= latest
    assert_one_taste_change(baseline_epoch, db.epochs())

    first_epoch = db.epochs()
    earliest = database_now(db)
    rerated = db.patch(album, {'rating': 7}, 1)
    second, latest = own_row(db, album), database_now(db)
    assert rerated['preference_revision'] == second['preference_revision'] == 2
    assert earliest <= timestamp(second) <= latest
    assert timestamp(second) > timestamp(first)
    assert_stable_except(first, second, {
        'preference_revision', 'updated_at', 'native_rating_intent_at'})
    assert_one_taste_change(first_epoch, db.epochs())
    assert {row['id']: row for row in db.rows() if row['id'] in unrelated} == unrelated
    assert db.epochs(db.peer) == peer_epoch


def test_duplicate_expected_revision_cannot_refresh_intent(rating_intent_db):
    db, album = rating_intent_db, rating_intent_db.albums[0]
    db.patch(album, {'rating': 7})
    first_rows, first_epoch = db.rows(), db.epochs()
    expect_error(409, lambda: db.patch(album, {'rating': 7}, 0))
    assert db.rows() == first_rows and db.epochs() == first_epoch
    db.patch(album, {'rating': 7}, 1)
    second_rows, second_epoch = db.rows(), db.epochs()
    expect_error(409, lambda: db.patch(album, {'rating': 7}, 1))
    assert db.rows() == second_rows and db.epochs() == second_epoch


def test_favorite_only_change_preserves_existing_native_intent(rating_intent_db):
    db, album = rating_intent_db, rating_intent_db.albums[0]
    db.patch(album, {'rating': 7, 'favorite': True})
    before, epoch = own_row(db), db.epochs()

    def no_probe(sql, params, connection):
        assert 'native_rating_intent_at' not in normalized(sql)

    result = db.patch(album, {'favorite': False}, 1, connect=observed(db, before=no_probe))
    after = own_row(db)
    assert result['favorite'] is False and result['preference_revision'] == 2
    assert after['native_rating_intent_at'] == before['native_rating_intent_at']
    assert_stable_except(before, after, {'favorite', 'preference_revision', 'updated_at'})
    assert_one_taste_change(epoch, db.epochs())
    final_rows, final_epoch = db.rows(), db.epochs()
    assert db.patch(album, {'favorite': False}, 2,
        connect=observed(db, before=no_probe)) == result
    assert db.rows() == final_rows and db.epochs() == final_epoch


def test_explicit_null_clears_intent_without_replacing_the_row(rating_intent_db):
    db, album = rating_intent_db, rating_intent_db.albums[0]
    db.patch(album, {'rating': 7, 'favorite': True})
    before, epoch = own_row(db), db.epochs()
    result = db.patch(album, {'rating': None}, 1)
    after = own_row(db)
    assert result['rating'] is None and result['favorite'] is True
    assert result['preference_revision'] == after['preference_revision'] == 2
    assert after['native_rating_intent_at'] is None
    assert_stable_except(before, after, {
        'rating', 'preference_revision', 'updated_at', 'native_rating_intent_at'})
    assert_one_taste_change(epoch, db.epochs())
    # A further explicit clear consumes a new CAS even though it creates no
    # qualifying timestamp. Replaying the old clear can never refresh evidence.
    repeated = db.patch(album, {'rating': None}, 2)
    assert repeated['preference_revision'] == 3
    assert own_row(db)['native_rating_intent_at'] is None
    final_rows, final_epoch = db.rows(), db.epochs()
    expect_error(409, lambda: db.patch(album, {'rating': None}, 2))
    assert db.rows() == final_rows and db.epochs() == final_epoch


def test_imported_shaped_old_row_remains_unknown_until_explicit_native_rating(rating_intent_db):
    # This is an owned, directly seeded file_tag_scan-shaped row. It is NOT
    # evidence that the real importer ran, nor a historical migration replay.
    db, album = rating_intent_db, rating_intent_db.albums[0]
    row_id = db.seed(album, rating=8, favorite=None)
    original = own_row(db)
    assert original['id'] == row_id and original['provenance'] == 'file_tag_scan'
    assert original['native_rating_intent_at'] is None
    db.patch(album, {'favorite': True}, 1)
    favorite = own_row(db)
    assert favorite['native_rating_intent_at'] is None
    assert_stable_except(original, favorite, {'favorite', 'preference_revision', 'updated_at'})

    earliest = database_now(db)
    result = db.patch(album, {'rating': 8}, 2)
    native, latest = own_row(db), database_now(db)
    assert result['preference_revision'] == 3 and native['provenance'] == 'personal_rating'
    assert earliest <= timestamp(native) <= latest
    assert_stable_except(favorite, native, {
        'provenance', 'preference_revision', 'updated_at', 'native_rating_intent_at'})


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('fault', ['session_clock', 'late_policy', 'source_stale'])
def test_final_real_checks_roll_back_preference_intent_and_epochs(rating_intent_db, existing, fault):
    db, album = rating_intent_db, rating_intent_db.albums[0]
    if existing:
        db.patch(album, {'rating': 3})
    before_rows, before_epoch = db.rows(), db.epochs()
    with db.connect() as connection:
        before_source = connection.execute(
            'select to_jsonb(f) as data from library.local_track_files f where id=%s',
            (album['file'],)).fetchone()['data']
    changed, in_transaction_intents = Event(), []

    def after(sql, params, connection):
        if not normalized(sql).startswith(
                'update app.album_ratings set native_rating_intent_at='):
            return
        changed.set()
        in_transaction_intents.append(connection.execute('''
            select native_rating_intent_at from app.album_ratings
            where account_id=%s and library_id=%s and album_key=%s''',
            (db.owner.account_id, db.library, album['key'])).fetchone()['native_rating_intent_at'])
        if fault == 'session_clock':
            db.clock_time = db.now + timedelta(days=2)
        elif fault == 'source_stale':
            # Real owned-row DML in the same writer transaction, after the intent
            # UPDATE. The real final source reread must reject and roll it back.
            connection.execute('''update library.local_track_files
                set metadata=jsonb_set(metadata,'{scan_cache,stale}','true')
                where id=%s''', (album['file'],))

    def constraints(context):
        return PolicyEvaluationConstraints(
            request_origin_allowed=not (fault == 'late_policy' and changed.is_set()))

    expect_error(409 if fault == 'source_stale' else 403,
        lambda: db.patch(album, {'rating': 7}, int(existing),
            connect=observed(db, after=after), constraints=constraints))
    assert changed.is_set() and len(in_transaction_intents) == 1
    assert in_transaction_intents[0] is not None
    assert db.rows() == before_rows and db.epochs() == before_epoch
    with db.connect() as connection:
        after_source = connection.execute(
            'select to_jsonb(f) as data from library.local_track_files f where id=%s',
            (album['file'],)).fetchone()['data']
    assert after_source == before_source
