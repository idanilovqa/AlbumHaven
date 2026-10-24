"""Authored-only, one-row controlled SQL-result boundary, NEVER native SQL proof.

Only the outer account transaction/driver boundary is substituted. Real gates,
codecs, parser, lookup, merge, validators, writer, finalizer and callers run.
This deliberately models only a new one-row observation plus exact replay. It
must reject unknown SQL, not silently return success. Native lock/session/SQL
semantics, concurrency and trigger accounting require separate native tests.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from types import SimpleNamespace
from tests.py.foobar_account_history_driver import init_history_driver, history_driver_rows, UNHANDLED

from music_app.services import foobar_account_import_prepare as p
from music_app.services import foobar_account_import_apply as a
from music_app.services import foobar_account_import_finalize as f
from music_app.services import foobar_account_matching_authority as authority
from music_app.services import foobar_account_import_jobs as jobs
from music_app.services import foobar_account_import_jobs_readiness as job_readiness
from music_app.services.current_actor import CurrentActor, ActorState
from music_app.services.policy import PolicyContext, RequestOrigin

NOW = datetime(2026, 10, 23, tzinfo=timezone.utc)
GEN = (NOW.date() - date(1970, 1, 1)).days
SOURCE = '11111111-1111-4111-8111-111111111111'
KEY = '22222222-2222-4222-8222-222222222222'
APPLY_KEY = '33333333-3333-4333-8333-333333333333'
PAYLOAD = b'path\ttitle\trating\tfavorite\tplay_count\n/synthetic.flac\tSynthetic\t4\t1\t19\n'
CAPACITY = p.intake.FoobarIntakeCapacity(512 * 1024 * 1024)


def context():
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=1, session_id=3,
                         authenticated_at=NOW)
    return PolicyContext.build(actor=actor, action='account.self.foobar.write',
        library_id=None, target_account_id=1, deployment_mode='self_hosted',
        request_origin=RequestOrigin('network', 'synthetic:account-chain'),
        client_surface_class='private_web')


def command(payload=PAYLOAD):
    return p.gate.FoobarPrepareCommand(SOURCE, GEN, KEY, 0,
        hashlib.sha256(payload).hexdigest(), p.gate.MAPPING, 0,
        p.NO_LIBRARY_INVENTORY_SHA256, None)


class Cursor:
    def __init__(self, rows):
        self.rows, self.closed = rows, False

    def fetchmany(self, limit):
        assert not self.closed
        return self.rows[:limit]

    def close(self):
        self.closed = True


class Boundary:
    """Known-query dispatcher. No SQL is sent to any database."""
    autocommit = False
    info = SimpleNamespace(transaction_status=2)  # psycopg INTRANS enum value

    def __init__(self):
        init_history_driver(self)
        self.now = NOW
        self.receipt = None
        self.keys = {}
        self.source_row = None
        self.revision = 0
        self.current_generation = GEN
        self.retired_through = 0
        self.calls, self.cursors = [], []
        self.commits = 0
        self.lose_ack = False
        self.fail_sql = None

    @contextmanager
    def transaction(self):
        yield  # Inner savepoints are not a native-rollback claim.

    @contextmanager
    def outer(self, url, live, *, matching_library_id, constraints=None):
        assert url == 'synthetic:no-network'
        live = authority.require_account_foobar(live, constraints)
        before = deepcopy((self.receipt, self.keys, self.source_row, self.revision, self.history_projections))
        try:
            yield self, live, self.now
            authority.require_account_foobar(live, constraints)
        except BaseException:
            self.receipt, self.keys, self.source_row, self.revision, self.history_projections = before
            raise
        self.commits += 1
        if self.lose_ack:
            self.lose_ack = False
            raise OSError('synthetic lost outer commit acknowledgement')

    def clock(self):
        return dict(updated_at=self.now, clock_high_water=self.now,
            current_generation=self.current_generation,
            retired_through=self.retired_through, observed_at=self.now)

    def stream(self):
        r = self.receipt
        return dict(revision=self.revision, current_generation=self.current_generation,
            retired_through=self.retired_through, prepared_today=int(r is not None),
            receipt_count=int(r is not None), ready_count=int(r is not None and r['state']=='ready'),
            receipt_reserved_bytes=4194304 if r and r['state']=='ready' else 0,
            request_key_count=len(self.keys), observed_at=self.now, isolation='read committed')

    def execute(self, sql, params=None, **kwargs):
        self.calls.append(sql)
        if sql == self.fail_sql:
            raise OSError('synthetic boundary failure')
        history_rows = history_driver_rows(self, sql, params, **kwargs)
        if history_rows is not UNHANDLED:
            cursor = Cursor(history_rows)
            self.cursors.append(cursor)
            return cursor
        if sql.startswith("select set_config('statement_timeout'"):
            rows = []
        elif sql == job_readiness._SCHEMA_SQL:
            assert params is None and not kwargs
            rows = [{'structural_ready': True}]
        else:
            assert kwargs == {'binary': True}
            rows = self.dispatch(sql, params)
        cursor = Cursor(rows)
        self.cursors.append(cursor)
        return cursor

    def dispatch(self, sql, params):
        values = json.loads(params[0])
        if sql in (jobs._FIND_PREPARE_SQL, jobs._FIND_APPLY_SQL):
            assert values['account_id'] == 1 and values['source_ref'] == SOURCE
            assert values['generation'] == GEN and values['job_ref'] is None
            assert p.gate._uuid(values['request_key'])
            if sql == jobs._FIND_APPLY_SQL:
                assert p.gate._uuid(values['receipt_ref'])
            return []  # This existing fixture owns ordinary imports, no job rows.
        g, w = p.gate, p.source
        if sql in (g._LOCK_SQL, g._ROLL_SQL):
            assert values[:2] == [1, None] and values[3] == SOURCE
            return [self.stream()]
        if sql == g._KEY_SQL:
            key = self.keys.get(values[5])
            if key is None:
                return []
            r = self.receipt
            return [dict(operation=key['operation'], command_sha256=key['command_sha256'],
                original_receipt_ref=key['original_receipt_ref'], key_state=key['state'],
                receipt_ref=key['receipt_ref'], receipt_state=r['state'],
                original_session_id=r['original_session_id'], expected_revision=r['expected_revision'],
                prepare_key=r['prepare_key'], prepared_sha256=r['prepared_sha256'],
                decision_sha256=r['decision_sha256'], inventory_sha256=r['inventory_sha256'],
                authority_sha256=r['authority_sha256'], expires_at=r['expires_at'], observed_at=self.now,
                prepared_bytes_size=len(r['prepared']) if r['prepared'] is not None else None,
                terminal_bytes_size=len(r['terminal']) if r['terminal'] is not None else None)]
        if sql == a._APPLY_KEY_SQL:
            key = self.keys.get(values[5])
            return [] if key is None else [dict(key, observed_at=self.now)]
        if sql == p.lookup._CARDINALITY_SQL:
            assert self.source_row is None
            return [dict(ordinal=1, candidate_count=0, comparison_bytes=0, candidates_valid=True)]
        if sql == p.lookup._COMPARE_SQL:
            assert self.source_row is None
            return [dict(matching_count=0, observation_ref=None, source_revision=None,
                evidence_sha256=None, display_sha256=None, identity_bytes=None,
                evidence_bytes=None, display_bytes=None, incoming_evidence_sha256=None,
                incoming_evidence_bytes=None)]
        if sql == p.sizing._MERGED_SIZE_SQL:
            incoming = bytes.fromhex(values[13])
            fields = p.evidence.decode_evidence(incoming)
            return [dict(limits_valid=True, association_valid=True, shape_valid=True,
                origin_unique=True, evidence_unchanged=False, evidence_bytes=len(incoming),
                display_bytes=w.display.display_size(fields))]
        if sql == p._CURRENT_SOURCE_SQL:
            return [dict(ordinal=1, valid=self.source_row is None)]
        if sql == p._CAPACITY_SQL:
            return [dict(observation_count=0, revision_count=0, source_bytes=0)]
        if sql == p._CLOCK_SQL:
            return [self.clock()]
        if sql == p._INSERT_READY_SQL:
            assert self.receipt is None
            h, prepared, decision, digest, size = values
            assert len(params[1]) == size
            self.receipt = dict(original_session_id=h[2], parser_version=h[9], mapping_name=h[10],
                total_rows=h[11], window_start=h[12], window_end=h[13], created_at=self.now,
                ready_until=self.now+timedelta(hours=1), apply_key=None, committed_revision=None,
                committed_at=None, expires_at=self.now+timedelta(hours=1), state='ready',
                expected_revision=h[7], upload_sha256=h[8], inventory_sha256=h[14],
                authority_sha256=h[15], decision_sha256=decision, prepared_sha256=prepared,
                terminal_sha256=None, prepare_key=h[5], prepared=params[1], terminal=None,
                receipt_ref=h[6], header=tuple(h))
            self.keys[h[5]] = dict(operation='prepare', command_sha256=digest,
                original_receipt_ref=h[6], receipt_ref=h[6], state='active')
            return [dict(receipt_ref=h[6], created_at=self.now,
                         ready_until=self.now+timedelta(hours=1), observed_at=self.now)]
        if sql == p._RECEIPT_SCALAR_SQL:
            if self.receipt is None or values[4] != self.receipt['receipt_ref']:
                return []
            r = dict(self.receipt, prepared_size=len(self.receipt['prepared'] or b''),
                terminal_size=len(self.receipt['terminal'] or b''), observed_at=self.now)
            return [{key:r[key] for key in p._RECEIPT_KEYS}]
        for terminal in (False, True):
            if sql == p._receipt_payload_sql(terminal):
                return [dict(payload=self.receipt['terminal' if terminal else 'prepared'], observed_at=self.now)]
        if sql in (w._stream_sql(), w._stream_sql(touch=True)):
            assert len(values) == 5 and values[:4] == [1, SOURCE, GEN, 0]
            return [dict(revision=self.revision, current_generation=GEN,
                         retired_through=0, isolation='read committed')]
        if sql == w._cardinality_sql():
            size = sum(len(bytes.fromhex(self.source_row[i])) for i in (2,6,7,8)) if self.source_row else 0
            return [dict(ordinal=1, candidate_count=int(self.source_row is not None), comparison_bytes=size)]
        if sql == w._current_incoming_sql():
            assert self.source_row is None
            return [dict(ordinal=1, matching_count=0, observation_ref=None,
                current_revision=None, incoming_evidence_sha256=None, incoming_evidence_bytes=None)]
        if sql == w._current_sql():
            row = self.source_row
            if row is None:
                return [dict(ordinal=1, matching_count=0, observation_ref=None, current_revision=None,
                    evidence_sha256=None, display_sha256=None, incoming_evidence_sha256=None,
                    incoming_exact=None, same_bytes=None)]
            digest = lambda i: hashlib.sha256(bytes.fromhex(row[i])).hexdigest()
            return [dict(ordinal=1, matching_count=1, observation_ref=row[0], current_revision=1,
                evidence_sha256=digest(6), display_sha256=digest(7), incoming_evidence_sha256=digest(8),
                incoming_exact=row[8]==values[4][0][8], same_bytes=row==values[4][0])]
        if sql == w._insert_observations_sql():
            assert self.source_row is None
            return [dict(observation_ref=values[4][0][0])]
        if sql == w._insert_revisions_sql():
            assert self.source_row is None
            self.source_row = values[4][0]
            return [dict(observation_ref=self.source_row[0])]
        if sql == w._advance_pointers_sql():
            return []
        if sql == f._GUARD_SQL:
            r = dict(self.receipt, **self.clock(), revision=self.revision,
                prepare_command_sha256=self.keys[self.receipt['prepare_key']]['command_sha256'],
                prepare_key_valid=True, apply_key_absent=values[11] not in self.keys)
            return [{key:r[key] for key in f._GUARD_KEYS}]
        if sql == f._ADVANCE_SQL:
            assert self.revision == values[7]
            self.revision = values[8]
            return [dict(self.clock(), revision=self.revision)]
        if sql == f._COMMIT_SQL:
            r = self.receipt
            assert r['state']=='ready' and values[11] not in self.keys
            r.update(state='committed', prepared=None, terminal=params[1], apply_key=values[11],
                committed_revision=values[8], committed_at=self.now, expires_at=self.now+timedelta(hours=168),
                terminal_sha256=values[13])
            self.keys[values[11]] = dict(operation='apply', command_sha256=values[12],
                original_receipt_ref=r['receipt_ref'], receipt_ref=r['receipt_ref'], state='active')
            return [dict(receipt_ref=r['receipt_ref'], generation=GEN, committed_revision=self.revision,
                terminal_sha256=r['terminal_sha256'], ready_until=r['ready_until'],
                committed_at=self.now, expires_at=r['expires_at'], observed_at=self.now)]
        raise AssertionError('Unmodeled SQL boundary: '+sql[:180])


def install(monkeypatch):
    db = Boundary()
    monkeypatch.setattr(p, 'current_foobar_import_transaction', db.outer)
    return db
