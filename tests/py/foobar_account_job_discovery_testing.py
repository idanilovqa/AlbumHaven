"""SOURCE ONLY. SQL-result fixture, not a PostgreSQL/planner/locking proof.

The genuine account transaction, session validator, query driver, repository and
DTO validators remain untouched. Only pooled driver execution is extended.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json

from music_app.services import foobar_account_job_discovery as discovery
from music_app.services import foobar_account_job_discovery_readiness as readiness
from tests.py.foobar_account_import_jobs_testing import (
    install as install_jobs, requested_context, SOURCE, JOB, URL, account_authority,
)

STAMP = '2026-10-23T00:00:00.000000Z'


def install(monkeypatch):
    db = install_jobs(monkeypatch)
    db.discovery_rows = []
    db.discovery_catalog = [{'discovery_ready': True}]
    db.discovery_frames = []
    db.discovery_after = None
    db.discovery_result_override = None
    execute = db.execute

    def extension(sql, params=None, **kwargs):
        if sql == readiness._SCHEMA_SQL:
            db.calls.append(sql)
            assert db.tx_account is not None and params is None and not kwargs
            return db.cursor(deepcopy(db.discovery_catalog))
        if sql in discovery._LIST_SQL.values():
            db.calls.append(sql)
            assert not db.locked_sources
            assert kwargs == {'binary': True}
            assert len(params) == 1 and type(params[0]) is bytes
            assert len(params[0]) <= discovery.MAX_FRAME_BYTES
            frame = json.loads(params[0])
            assert set(frame) == {'account_id', 'updated_at', 'source_ref', 'job_ref'}
            assert frame['account_id'] == db.tx_account
            db.discovery_frames.append((sql, frame))
            unfinished, paged = next(key for key, value in discovery._LIST_SQL.items() if value == sql)
            rows = [deepcopy(row) for row in db.discovery_rows if row['account_id'] == frame['account_id']
                and (not unfinished or row['confirmed_rows'] < row['total_rows'])]
            key = lambda row: (row['updated_at'], row['source_ref'], row['job_ref'])
            if paged:
                position = (datetime.strptime(frame['updated_at'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(
                    tzinfo=timezone.utc), frame['source_ref'], frame['job_ref'])
                rows = [row for row in rows if key(row) < position]
            rows.sort(key=key, reverse=True)
            rows = rows[:21]
            for row in rows:
                del row['account_id']
            if db.discovery_after is not None:
                db.discovery_after(db)
            return db.cursor(rows if db.discovery_result_override is None else db.discovery_result_override)
        return execute(sql, params, **kwargs)
    monkeypatch.setattr(db, 'execute', extension)
    return db


def seed(db, count=43, *, account_id=1):
    for index in range(1, count + 1):
        db.discovery_rows.append(dict(account_id=account_id, source_ref=SOURCE,
            job_ref=f'00000000-0000-4000-8000-{index:012x}', created_at=db.now,
            updated_at=db.now, confirmed_rows=0, total_rows=100000, cancel_requested=False))


def listed(db, *, unfinished=False, cursor=None, context=None):
    return discovery.list_foobar_import_jobs(URL, context or requested_context(None),
        unfinished=unfinished, cursor=cursor)
