"""Controlled driver extension only; never a history business implementation.

At future test execution, actual codecs, writer hooks, catalog checks, authority
and transaction owners run. This file records exact bound parameters and returns
known SQL rows. It neither grants authority nor substitutes business receipts.
No PostgreSQL query/trigger/locking guarantee follows from this simulation.
"""
from copy import deepcopy
from hashlib import sha256
import json
from music_app.services import foobar_account_history_projection_writer as history_writer
from music_app.services import foobar_account_history_readiness as history_readiness
from music_app.services import foobar_enhanced_entry_readiness as enhanced_readiness

UNHANDLED = object()


def init_history_driver(db):
    db.history_projections = {}
    db.history_catalog = [{'history_ready': True, 'history_writer_ready': True}]
    db.history_frames = []
    db.history_override = None
    db.history_after = None


def current_source(db, observation_ref):
    if hasattr(db, 'source_rows'):
        row = db.source_rows.get(observation_ref)
        version = db.source_versions.get(observation_ref)
    else:
        row = db.source_row
        row = row if row is not None and row[0] == observation_ref else None
        version = getattr(db, 'observation_revision', 1 if row is not None else None)
    return row, version


def history_driver_rows(db, sql, params=None, **kwargs):
    if sql == enhanced_readiness._SQL:
        assert params is None and not kwargs
        return [{"entries_ready": True, "entries_writer_ready": True}]
    if sql not in (history_readiness._SCHEMA_SQL, history_writer._UPSERT_SQL,
                   history_writer._VERIFY_SQL, history_writer._OLD_SIZE_SQL):
        return UNHANDLED
    if sql == history_readiness._SCHEMA_SQL:
        assert params is None and not kwargs
        return deepcopy(db.history_catalog)
    assert kwargs == {'binary': True} and len(params) == 1 and type(params[0]) is bytes
    assert len(params[0]) <= history_writer.MAX_HISTORY_FRAME_BYTES
    frame = json.loads(params[0])
    assert len(frame) == (13 if sql == history_writer._UPSERT_SQL else 4)
    account, source, observation, revision = frame[:4]
    assert account == (db.tx_account if getattr(db, 'tx_account', None) is not None else 1)
    if hasattr(db, 'locked_sources'):
        assert (account, source) in db.locked_sources
    db.history_frames.append((sql, deepcopy(frame)))
    source_row, current_revision = current_source(db, observation)
    scope = account, source, observation
    if sql == history_writer._UPSERT_SQL:
        assert source_row is not None and current_revision == revision
        effective = sha256(bytes.fromhex(source_row[6])).hexdigest()
        labels = sha256(bytes.fromhex(source_row[7])).hexdigest()
        # Model the actual current-revision/hash join. Never regenerate a codec
        # value or silently accept a detached proposed projection.
        if frame[4:6] != [effective, labels]:
            return []
        body = bytes.fromhex(frame[12])
        db.history_projections[scope] = dict(source_revision=revision, projection_bytes=body,
            projection_sha256=sha256(body).hexdigest(), effective_evidence_sha256=effective,
            display_sha256=labels, standard_first=frame[6], standard_last=frame[7],
            enhanced_first=frame[8], enhanced_last=frame[9], standard_last_present=frame[10],
            enhanced_last_present=frame[11])
        result = [dict(observation_ref=observation)]
    else:
        stored = db.history_projections.get(scope)
        if stored is None:
            result = [{name: None for name in history_writer._BINDING_KEYS}]
        else:
            result = [dict(deepcopy(stored), current_revision=current_revision,
                current_effective_sha256=None if source_row is None else sha256(bytes.fromhex(source_row[6])).hexdigest(),
                current_display_sha256=None if source_row is None else sha256(bytes.fromhex(source_row[7])).hexdigest())]
    if sql == history_writer._OLD_SIZE_SQL:
        row = result[0]
        result = [dict(source_revision=row['source_revision'],
            projection_size=None if row['projection_bytes'] is None else len(row['projection_bytes']),
            **{name: row[name] for name in ('effective_evidence_sha256', 'display_sha256',
                'current_revision', 'current_effective_sha256', 'current_display_sha256')})]
    if db.history_after is not None:
        db.history_after(db, sql)
    return result if db.history_override is None else deepcopy(db.history_override)
