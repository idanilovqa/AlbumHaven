"""Authored, UNRUN real-writer cases. No schema installation or auto-migration.

Requires separately approved synthetic PostgreSQL setup with reviewed H3-R2,
private-v2 dependencies and the documented selection schema. Missing readiness
is a failure, not evidence of a passing feature. No public-v2 route is enabled.
"""
from contextlib import contextmanager
from copy import deepcopy
from uuid import uuid4

import pytest

from music_app.services import playback_edition_selection as selection
from music_app.services import playback_capture_postgres as repository
from music_app.services.playback_capture import CaptureError
from music_app.services.private_library_authority import current_library_transaction
from tests.py.test_playback_capture_postgres import capture_db, urls
from tests.py.test_playback_capture_v2_writer_postgres import _data, _write, _global


def connector(db, after=None):
    @contextmanager
    def connect(url):
        import psycopg
        from psycopg.rows import dict_row
        with psycopg.connect(url, row_factory=dict_row) as connection:
            class Observed:
                def execute(self, sql, params=None):
                    db.sql.append(' '.join(sql.lower().split()))
                    result = connection.execute(sql, params)
                    if after:
                        after(connection, sql, params)
                    return result
                def transaction(self):
                    return connection.transaction()
            yield Observed()
    return connect


def selected_data(db):
    with current_library_transaction(db.app_url, db.context, connect=connector(db),
            clock=lambda: db.now, inventory_publication_first=True) as (connection, live, now):
        assert selection.selection_schema_ready(connection), 'Selection schema must be separately provisioned'
        album = connection.execute('select id,album_key from library.local_albums where id=%s', (db.album,)).fetchone()
        rows = connection.execute('select id,album_id,track_key,disc_number,track_number from library.local_tracks where album_id=%s', (db.album,)).fetchall()
        prepared = selection.prepare_edition_selection(live, album, rows)
        assert prepared is not None
        item = str(uuid4())
        result = selection.persist_top_selections(connection, live,
            [(item, str(uuid4()), prepared)], top_ref=str(uuid4()), revision='1', now=now)
        assert item in result
    data = _data(db)
    data['edition_selection_ref'] = result[item]['selection_ref']
    return data


def links(db):
    with db.connect() as connection:
        return connection.execute('select * from integration.playback_edition_capture where account_id=%s', (db.account,)).fetchall()


def test_composed_writer_first_admission_charge_retry_and_ref_conflict(capture_db):
    db = capture_db
    data = selected_data(db)
    before = _global(db)
    reserve = []
    def observe(connection, sql, params):
        if 'update integration.playback_capture_budget' in sql.lower() and 'reserved_bytes' in sql.lower():
            reserve.append((sql, params))
    db.sql.clear()
    receipt = _write(db, data, connect=connector(db, observe))
    charged = _global(db)
    association = links(db)
    assert len(association) == 1 and association[0]['reservation_bytes'] == 512
    assert association[0]['original_track_id'] == db.track
    with db.connect() as c:
        parent = db.rows()[0]
        checkpoint = c.execute('select reservation_bytes from integration.playback_capture_checkpoint where session_id=%s', (parent['id'],)).fetchone()
        # Owner + parent + one run + checkpoint + association; H3 exists from selection.
        assert charged - before == 1024 + 384 + 320 + checkpoint['reservation_bytes'] + 512
    assert len(reserve) == 1 and reserve[0][1][0] == charged - before
    assert sum("array(select name from unnest" in sql for sql in db.sql) == 1
    assert _write(db, data) == receipt and _global(db) == charged and len(links(db)) == 1
    for ref in (None, str(uuid4())):
        changed = deepcopy(data)
        if ref is None:
            changed.pop('edition_selection_ref')
        else:
            changed['edition_selection_ref'] = ref
        with pytest.raises(CaptureError, match='capture_conflict'):
            _write(db, changed)
    assert _global(db) == charged and len(links(db)) == 1


def test_composed_first_admission_final_membership_drift_rolls_back(capture_db):
    db = capture_db
    data = selected_data(db)
    before = _global(db)
    changed = []
    def drift(connection, sql, params):
        if 'insert into integration.playback_edition_capture' in sql.lower() and not changed:
            changed.append(True)
            connection.execute('update library.local_tracks set track_number=track_number+1 where id=%s', (db.track,))
    with pytest.raises(CaptureError, match='capture_selection_unavailable'):
        _write(db, data, connect=connector(db, drift))
    assert changed and db.rows() == [] and links(db) == [] and _global(db) == before
    # The mutation itself rolled back, so the original selection can now admit.
    assert _write(db, data)['accepted_known_frames'] == 2


def test_composed_quota_failure_leaves_no_capture_or_association(capture_db, monkeypatch):
    db = capture_db
    data = selected_data(db)
    before = _global(db)
    def quota(*args):
        raise CaptureError('capture_quota', 429)
    monkeypatch.setattr(repository, '_reserve', quota)
    with pytest.raises(CaptureError, match='capture_quota'):
        _write(db, data)
    assert db.rows() == [] and links(db) == [] and _global(db) == before


def test_composed_partial_readiness_cannot_hide_existing_link(capture_db, monkeypatch):
    db = capture_db
    data = selected_data(db)
    receipt = _write(db, data)
    charged = _global(db)
    # Models a readiness failure without executing trigger/DDL changes.
    monkeypatch.setattr(selection, 'selection_schema_ready', lambda connection: False)
    changed = deepcopy(data)
    changed.pop('edition_selection_ref')
    with pytest.raises(CaptureError, match='capture_selection_unavailable'):
        _write(db, changed)
    assert _global(db) == charged and len(links(db)) == 1
    assert db.rows()[0]['last_sequence'] == receipt['sequence']
