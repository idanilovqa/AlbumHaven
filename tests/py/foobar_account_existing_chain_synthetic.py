"""Authored-only extension of pinned new-row boundary, not native persistence.

One exact-path observation, multiple immutable revisions/receipts. All product
callees stay genuine. Only known driver results and outer transaction are modeled.
"""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json

from tests.py.foobar_account_chain_synthetic import Boundary, p, a, f, authority, SOURCE, GEN


def raw(row, index):
    return bytes.fromhex(row[index])


def digest(row, index):
    return hashlib.sha256(raw(row, index)).hexdigest()


def observation_equal(left, right):
    # Independent SQL semantic projection: state/raw/value/code, not provenance.
    old = json.loads(left)[2]
    new = json.loads(right)[2]
    assert len(old) == len(new) == 27
    return all(type(x[k]) is type(y[k]) and x[k] == y[k]
               for x, y in zip(old, new) for k in range(4))


class ExistingBoundary(Boundary):
    def __init__(self):
        super().__init__()
        self.receipts = {}
        self.revisions = {}
        self.observation_revision = None
        self.observation_inserts = 0

    @contextmanager
    def outer(self, url, live, *, matching_library_id, constraints=None):
        assert url == 'synthetic:no-network'
        assert matching_library_id is None
        live = authority.require_account_foobar(live, constraints)
        names = ('receipt', 'receipts', 'keys', 'source_row', 'revision',
                 'revisions', 'observation_revision', 'observation_inserts', 'history_projections')
        before = deepcopy(tuple(getattr(self, name) for name in names))
        try:
            yield self, live, self.now
            authority.require_account_foobar(live, constraints)
        except BaseException:
            for name, value in zip(names, before):
                setattr(self, name, value)
            raise
        self.commits += 1
        if self.lose_ack:
            self.lose_ack = False
            raise OSError('modeled lost commit acknowledgement; state retained')

    def stream(self):
        result = super().stream()
        count = sum(r['state']=='ready' for r in self.receipts.values())
        result.update(prepared_today=len(self.receipts), receipt_count=len(self.receipts),
                      ready_count=count, receipt_reserved_bytes=count*4194304)
        return result

    def same(self, candidate):
        row = self.source_row
        return row is not None and row[2] == candidate[2] and row[6:8] == candidate[6:8] and observation_equal(
            raw(row, 8), raw(candidate, 8))

    def bucket_size(self):
        return 0 if self.source_row is None else sum(len(raw(self.source_row, i)) for i in (2,6,7,8))

    def immutable(self, values):
        assert values[:3] == [1, None, SOURCE]
        row = self.revisions.get(values[4])
        if row is None or row[0] != values[3] or digest(row, 6) != values[5] or digest(row, 7) != values[6]:
            return None
        return row

    def dispatch(self, sql, params):
        v = json.loads(params[0])
        w = p.source
        if sql == p.gate._KEY_SQL:
            key = self.keys.get(v[5])
            if key is not None:
                self.receipt = self.receipts[key['receipt_ref']]
        elif sql == p._RECEIPT_SCALAR_SQL:
            self.receipt = self.receipts.get(v[4])
        elif sql == p._INSERT_READY_SQL:
            assert v[0][5] not in self.keys
            self.receipt = None
            result = super().dispatch(sql, params)
            self.receipts[self.receipt['receipt_ref']] = self.receipt
            return result
        if sql == p.lookup._CARDINALITY_SQL:
            return [dict(ordinal=1, candidate_count=int(self.source_row is not None),
                comparison_bytes=self.bucket_size(), candidates_valid=True)]
        if sql == p.lookup._COMPARE_SQL and self.source_row is not None:
            row = self.source_row
            assert v[:3] == [1, None, SOURCE] and v[5] == row[2]
            return [dict(matching_count=1, observation_ref=row[0], source_revision=self.observation_revision,
                evidence_sha256=digest(row,6), display_sha256=digest(row,7),
                identity_bytes=len(raw(row,2)), evidence_bytes=len(raw(row,6)),
                display_bytes=len(raw(row,7)), incoming_evidence_sha256=digest(row,8),
                incoming_evidence_bytes=len(raw(row,8)))]
        if sql == p.sizing._MERGED_SIZE_SQL:
            incoming = bytes.fromhex(v[13])
            fields = p.evidence.decode_evidence(incoming)
            previous = None if self.source_row is None else p.evidence.decode_evidence(raw(self.source_row,6))
            merged = p.evidence.merge_fields(previous, fields)
            effective = p.evidence.encode_evidence(merged)
            same = self.source_row is not None and effective == raw(self.source_row,6) and observation_equal(
                raw(self.source_row,8), incoming)
            return [dict(limits_valid=True, association_valid=True, shape_valid=True,
                origin_unique=True, evidence_unchanged=same, evidence_bytes=len(effective),
                display_bytes=w.display.display_size(merged))]
        if sql == p.prior_merge._PRIOR_SQL:
            row = self.immutable(v)
            if row is None or v[4] != self.observation_revision:
                return []
            assert v[7] == digest(row,2) and v[13] == row[2]
            return [dict(evidence_bytes=raw(row,6), display_bytes=raw(row,7),
                         incoming_evidence_bytes=raw(row,8))]
        if sql in (p.original_sources._SCALAR_SQL, p.original_sources._RAW_SQL):
            row = self.immutable(v)
            if row is None:
                return []
            if sql == p.original_sources._RAW_SQL:
                return [dict(identity_bytes=raw(row,2), evidence_bytes=raw(row,6),
                    display_bytes=raw(row,7), incoming_evidence_bytes=raw(row,8))]
            return [dict(identity_bytes_size=len(raw(row,2)), evidence_bytes_size=len(raw(row,6)),
                display_bytes_size=len(raw(row,7)), identity_sha256=digest(row,2), identity_kind=row[1],
                incoming_evidence_bytes_size=len(raw(row,8)), incoming_evidence_sha256=digest(row,8))]
        if sql == p._CURRENT_SOURCE_SQL:
            if v[3] != self.revision:
                return []
            ref, revision, evidence_sha, display_sha = v[4][0]
            row = self.source_row
            valid = (row is None) if revision is None else (row is not None and row[0]==ref
                and self.observation_revision==revision and digest(row,6)==evidence_sha
                and digest(row,7)==display_sha)
            return [dict(ordinal=1, valid=valid)]
        if sql == p._CAPACITY_SQL:
            if v[3] != self.revision:
                return []
            size = (len(raw(self.source_row,2)) if self.source_row else 0)+sum(
                len(raw(row,i)) for row in self.revisions.values() for i in (6,7,8))
            return [dict(observation_count=int(self.source_row is not None),
                         revision_count=len(self.revisions), source_bytes=size
                             +sum(len(row["projection_bytes"]) for row in self.history_projections.values()))]
        if sql in (w._stream_sql(), w._stream_sql(touch=True)):
            assert len(v)==5 and v[:3]==[1,SOURCE,GEN]
            return [dict(revision=self.revision, current_generation=self.current_generation,
                retired_through=self.retired_through, isolation='read committed')]
        if sql == w._current_incoming_sql() and self.source_row is not None:
            row = self.source_row
            return [dict(ordinal=1, matching_count=1, observation_ref=row[0],
                current_revision=self.observation_revision, incoming_evidence_sha256=digest(row,8),
                incoming_evidence_bytes=raw(row,8))]
        if sql == w._current_sql() and self.source_row is not None:
            row = self.source_row
            return [dict(ordinal=1, matching_count=1, observation_ref=row[0],
                current_revision=self.observation_revision, evidence_sha256=digest(row,6),
                display_sha256=digest(row,7), incoming_evidence_sha256=digest(row,8),
                incoming_exact=row[8]==v[4][0][8], same_bytes=self.same(v[4][0]))]
        if sql == w._insert_observations_sql():
            if self.source_row is not None:
                return []
            assert v[4][0][3] is None
            self.observation_inserts += 1
            return [dict(observation_ref=v[4][0][0])]
        if sql == w._insert_revisions_sql():
            candidate = v[4][0]
            assert not self.same(candidate) and v[3]+1 not in self.revisions
            self.revisions[v[3]+1] = deepcopy(candidate)
            if self.source_row is None:
                self.source_row = self.revisions[v[3]+1]
                self.observation_revision = v[3]+1
            return [dict(observation_ref=candidate[0])]
        if sql == w._advance_pointers_sql():
            candidate = v[4][0]
            if candidate[3] is None:
                return []
            assert self.observation_revision==candidate[3] and self.source_row[0]==candidate[0]
            self.source_row = self.revisions[v[3]+1]
            self.observation_revision = v[3]+1
            return [dict(observation_ref=candidate[0])]
        return super().dispatch(sql, params)


def install_existing(monkeypatch):
    db = ExistingBoundary()
    monkeypatch.setattr(p, 'current_foobar_import_transaction', db.outer)
    return db
