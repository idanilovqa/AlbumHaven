"""Unexecuted full composed existing-source transitions at modeled DB boundary."""
from dataclasses import replace
import hashlib
import json

import pytest

from tests.py.foobar_account_chain_synthetic import (
    p, a, f, GEN, SOURCE, PAYLOAD, CAPACITY, context, command,
)
from tests.py.foobar_account_existing_chain_synthetic import install_existing, raw, digest


def key(n):
    return '00000000-0000-4000-8000-%012d' % n


def payload(count, ignored=None):
    value = PAYLOAD.replace(b'\t19\n', b'\t'+str(count).encode('ascii')+b'\n')
    if ignored is not None:
        lines = value.rstrip(b'\n').split(b'\n')
        value = lines[0]+b'\tunknown_extra\n'+lines[1]+b'\t'+ignored+b'\n'
    return value


def prepare(db, upload, n):
    cmd = replace(command(upload), expected_revision=db.revision, request_key=key(n))
    receipt = p.prepare_foobar_import('synthetic:no-network', context(), payload=upload,
        command=cmd, intake_capacity=CAPACITY)
    stored = db.receipts[receipt.receipt_ref]
    original = p.envelope.decode_prepared_envelope(stored['prepared'], original_command=cmd,
        expected_header=stored['header'], prepared_sha256=receipt.prepared_sha256,
        decision_sha256=receipt.decision_sha256)
    acmd = a.apply_command.FoobarApplyCommand(SOURCE, GEN, key(n+1000),
        receipt.receipt_ref, receipt.decision_sha256, None)
    return cmd, receipt, original, acmd


def apply(cmd):
    return a.apply_foobar_import('synthetic:no-network', context(), command=cmd,
                                intake_capacity=CAPACITY)


def seed(db):
    _, receipt, original, cmd = prepare(db, payload(19), 1)
    apply(cmd)
    assert db.revision == db.observation_revision == 1
    assert len(db.revisions)==1 and db.observation_inserts==1
    return receipt, original


def field(data, name):
    return p.evidence.decode_evidence(data)[p.parser.FIELD_NAMES.index(name)]


def assert_terminal(result, *, old, new, counts):
    record = tuple(json.loads(result.terminal_bytes))
    assert record[0]=='foobar_acct_v4' and record[11:13]==(old,new)
    assert len(record)==24 and record[22]==0
    assert record[16:22]==counts
    assert all(record[index]==0 for index in (18,19,20,21))


def test_valid_to_raw_unavailable_then_origin_only_raw_repeat_is_noop(monkeypatch):
    db = install_existing(monkeypatch)
    seed_receipt, seed_original = seed(db)
    old_effective = raw(db.source_row,6)
    old_display = raw(db.source_row,7)
    observation_ref = db.source_row[0]
    pcmd, receipt, original, acmd = prepare(db, payload('N/A'), 2)
    assert original[2][0][2:6] == (observation_ref, 1,
        hashlib.sha256(old_effective).hexdigest(), hashlib.sha256(old_display).hexdigest())
    assert original[3]==() and original[2][0][9:]==(None,None,False)
    assert field(bytes.fromhex(original[2][0][6]),'play_count')[0:3] == ('unavailable','N/A',None)
    assert field(bytes.fromhex(original[2][0][7]),'play_count')[1:3] == ('19',19)
    assert bytes.fromhex(original[2][0][7])==old_effective
    result = apply(acmd)
    assert_terminal(result, old=1, new=2, counts=(0,1,0,0,0,0))
    assert db.observation_inserts==1 and len(db.revisions)==2
    assert db.revision==db.observation_revision==2
    assert raw(db.source_row,6)==old_effective and raw(db.source_row,7)==old_display
    assert field(raw(db.source_row,8),'play_count')[0]=='unavailable'
    stored_raw = raw(db.source_row,8)
    stored_raw_digest = digest(db.source_row,8)
    # New upload hash changes provenance, not observed field state/raw/value/code.
    pcmd2, receipt2, original2, acmd2 = prepare(db, payload('N/A',b'ignored'), 3)
    incoming2 = bytes.fromhex(original2[2][0][6])
    assert incoming2 != stored_raw
    assert p.evidence.same_observation(p.evidence.decode_evidence(stored_raw),
                                     p.evidence.decode_evidence(incoming2))
    appends = db.calls.count(p.source._insert_revisions_sql())
    result2 = apply(acmd2)
    assert_terminal(result2, old=2, new=2, counts=(1,0,0,0,0,0))
    assert db.revision==db.observation_revision==2 and len(db.revisions)==2
    assert db.calls.count(p.source._insert_revisions_sql())==appends
    assert raw(db.source_row,8)==stored_raw and digest(db.source_row,8)==stored_raw_digest
    assert raw(db.source_row,6)==old_effective
    # Historical committed key replay selects its own receipt, not newest receipt.
    replay_seed = a.apply_command.FoobarApplyCommand(SOURCE,GEN,key(1001),
        seed_receipt.receipt_ref,seed_receipt.decision_sha256,None)
    assert apply(replay_seed).terminal_bytes==db.receipts[seed_receipt.receipt_ref]['terminal']
    assert db.revision==2 and len(db.revisions)==2
    # These exact production owners were traversed for existing immutable priors.
    for sql in (p.prior_merge._PRIOR_SQL,p.original_sources._SCALAR_SQL,
                p.original_sources._RAW_SQL,p.source._current_incoming_sql(),
                p.source._advance_pointers_sql()):
        assert sql in db.calls
    assert all(cursor.closed for cursor in db.cursors)


def test_lower_and_zero_valid_counts_replace_never_add(monkeypatch):
    db = install_existing(monkeypatch)
    seed(db)
    for n, count in ((2,5),(3,0)):
        old = db.revision
        _, receipt, original, acmd = prepare(db,payload(count),n)
        effective = bytes.fromhex(original[2][0][7])
        assert field(effective,'play_count')[1:3]==(str(count),count)
        result = apply(acmd)
        assert_terminal(result,old=old,new=old+1,counts=(0,1,0,0,0,0))
        assert field(raw(db.source_row,6),'play_count')[2]==count
        assert field(raw(db.source_row,8),'play_count')[2]==count
    assert db.revision==3 and len(db.revisions)==3 and db.observation_inserts==1
    assert field(raw(db.revisions[1],6),'play_count')[2]==19
    assert field(raw(db.revisions[2],6),'play_count')[2]==5
    assert field(raw(db.revisions[3],6),'play_count')[2]==0


def test_prepared_prior_becomes_stale_after_other_genuine_apply(monkeypatch):
    db = install_existing(monkeypatch)
    seed(db)
    _, stale_receipt, stale_original, stale_cmd = prepare(db,payload('N/A'),2)
    _, winner_receipt, winner_original, winner_cmd = prepare(db,payload(5),3)
    assert stale_original[2][0][3]==winner_original[2][0][3]==1
    apply(winner_cmd)
    assert db.revision==2
    start = len(db.calls)
    with pytest.raises(p.SourceStale):
        apply(stale_cmd)
    assert p.source._insert_revisions_sql() not in db.calls[start:]
    assert db.receipts[stale_receipt.receipt_ref]['state']=='ready'
    assert stale_cmd.request_key not in db.keys
    assert db.revision==2 and len(db.revisions)==2
    assert field(raw(db.source_row,6),'play_count')[2]==5


def test_existing_raw_change_lost_ack_exact_replay_does_not_append_twice(monkeypatch):
    db = install_existing(monkeypatch)
    seed(db)
    pcmd, receipt, original, acmd = prepare(db,payload('N/A'),2)
    db.lose_ack = True
    with pytest.raises(a.FoobarApplyCommitUncertain):
        apply(acmd)
    assert db.receipts[receipt.receipt_ref]['state']=='committed'
    assert db.revision==2 and len(db.revisions)==2
    terminal = db.receipts[receipt.receipt_ref]['terminal']
    appends = db.calls.count(p.source._insert_revisions_sql())
    commits = db.calls.count(f._COMMIT_SQL)
    result = apply(acmd)
    assert result.terminal_bytes==terminal
    assert_terminal(result,old=1,new=2,counts=(0,1,0,0,0,0))
    replay = p.prepare_foobar_import('synthetic:no-network',context(),payload=payload('N/A'),
        command=pcmd,intake_capacity=CAPACITY)
    assert replay.terminal_bytes==terminal
    assert db.calls.count(p.source._insert_revisions_sql())==appends
    assert db.calls.count(f._COMMIT_SQL)==commits
    assert db.observation_inserts==1 and db.revision==2
