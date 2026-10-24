"""Authored only: actual matching/Prepare/Apply/checkpoint owners, driver seams.

These definitions do not execute PostgreSQL, SQLite, filesystem probes or
product code during preparation. The inherited SQL result driver is not proof
of native isolation, triggers, query plans or physical memory use.
"""
from copy import deepcopy
from dataclasses import replace
import json
import threading
from uuid import uuid4

import pytest
from music_app.services import foobar_account_enhanced_matching as matching
from tests.py.foobar_enhanced_account_v4_testing import *
from tests.py.test_foobar_enhanced_account_v4_chain import raw_boundary


def matched_raw(monkeypatch, aliases=None):
    aliases = [('/synthetic.flac',)] if aliases is None else aliases
    raw = raw_boundary(monkeypatch, len(aliases))
    raw.aliases = dict(enumerate(aliases))
    return raw


def assert_no_taste_io(db):
    assert p.taste._foobar_taste_read_sql() not in db.calls
    assert p.taste._foobar_taste_write_sql() not in db.calls


def test_actual_selected_library_prepare_apply_and_checkpoint_without_taste(monkeypatch):
    db = install(monkeypatch, library=7)
    raw = matched_raw(monkeypatch)
    tastes = deepcopy(db.tastes)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        original = json.loads(db.receipt['prepared'])
        assert original[3] == []
        assert original[4][0][9] == 21
        assert original[2][0][9:] == [None, None, False]
        ready = status(ctx, cmd).current_batch
        apply(ctx, ready)
        result = reconcile(ctx, cmd, ready)
        assert result.status.disposition == 'completed'
        assert result.status.confirmed_counts == (0, 1, 0, 0, 0, 0, 1)
    assert len(db.source_rows) == len(db.bindings) == 1
    assert next(iter(db.bindings.values()))['track'] == 21
    assert len(db.entry_children) == 2
    assert db.tastes == tastes
    assert_no_taste_io(db)


@pytest.mark.parametrize('aliases,expected', [
    ([('/synthetic.flac', '/other.flac')], 0),
    ([('/synthetic.flac', '/other.flac'), ('/synthetic.flac',)], 0),
    ([('/synthetic.flac',), ('/synthetic.flac',)], 0),
    ([('https://remote.invalid/song',)], 0),
    ([()], 0),
])
def test_alias_ambiguity_and_duplicate_claims_do_not_merge_store_keys(monkeypatch, aliases, expected):
    db = install(monkeypatch, library=7)
    raw = matched_raw(monkeypatch, aliases)
    with raw.open() as upload:
        _, _, result = complete(db, upload)
    assert len(db.source_rows) == len(aliases)
    assert len(db.bindings) == expected
    assert result.confirmed_counts[6] == expected
    assert len({bytes.fromhex(row[2]) for row in db.source_rows.values()}) == len(aliases)
    assert_no_taste_io(db)


def test_unchanged_matched_reimport_preserves_decision_and_source_revision(monkeypatch):
    db = install(monkeypatch, library=7)
    with matched_raw(monkeypatch).open() as upload:
        complete(db, upload)
    before = deepcopy((db.source_rows, db.source_versions, db.bindings, db.history, db.entry_children))
    revision = db.revision
    with matched_raw(monkeypatch).open() as upload:
        _, _, result = complete(db, upload)
    assert result.confirmed_counts == (1, 0, 0, 0, 0, 0, 0)
    assert db.revision == revision
    assert (db.source_rows, db.source_versions, db.bindings, db.history, db.entry_children) == before
    assert_no_taste_io(db)


@pytest.mark.parametrize('decision', ['saved', 'detached', 'lost'])
def test_prior_explicit_decision_outweighs_current_alias(monkeypatch, decision):
    db = install(monkeypatch, library=7)
    with matched_raw(monkeypatch).open() as upload:
        complete(db, upload)
    key = next(iter(db.bindings))
    previous = db.bindings[key]
    if decision != 'saved':
        del db.bindings[key]
        if decision == 'detached':
            db.history[key].append(dict(decision=str(uuid4()), version=2,
                action='detach', track=None, operation=str(uuid4())))
    history = deepcopy(db.history)
    # Same store key now names another exact path. No identity merge or implicit rematch.
    raw = matched_raw(monkeypatch, [('/other.flac',)])
    with raw.open() as upload:
        complete(db, upload)
    assert db.history == history
    if decision == 'saved':
        assert db.bindings[key] == previous
    else:
        assert key not in db.bindings
    assert len(db.source_rows) == 1
    assert_no_taste_io(db)


@pytest.mark.parametrize('drift', ['membership', 'inventory', 'binding'])
def test_fresh_apply_rejects_permission_inventory_or_association_drift(monkeypatch, drift):
    db = install(monkeypatch, library=7)
    with matched_raw(monkeypatch).open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        if drift == 'membership':
            db.membership = False
        elif drift == 'inventory':
            db.files[21] = '/changed.flac'
        else:
            original = json.loads(db.receipt['prepared'])
            ref = original[2][0][2]
            db.history[(7, ref)] = [dict(decision=str(uuid4()), version=1,
                action='detach', track=None, operation=str(uuid4()))]
        before = snapshot(db), db.extra_snapshot()
        with pytest.raises((p.source.SourceUnavailable, p.source.SourceStale)):
            apply(ctx, ready)
        assert (snapshot(db), db.extra_snapshot()) == before
        assert not db.entry_children
    assert_no_taste_io(db)


def test_full_preflight_cache_reuses_terminal_alias_pass_not_raw_vector_rescan(monkeypatch):
    db = install(monkeypatch, library=7)
    raw = matched_raw(monkeypatch)
    with raw.open() as upload:
        command = seed(db, upload)
        for attempt in range(2):
            preflight.preflight_indexed_foobar_import(URL, requested_context(7),
                upload=upload, command=command, intake_capacity=CAPACITY,
                cancel_event=threading.Event())
            if attempt == 0:
                cache = upload._matching_cache
                aliases_before = sum(event == ('aliases', 0) for event in raw.events)
                raw_before = sum(event[0] == 'raw' for event in raw.events)
        assert upload._matching_cache is cache
        # The indexed reader constructs its evidence windows normally. The extra
        # alias-only matching pass is cached, not repeated for each preflight.
        # Each genuine evidence-window reread performs one raw and alias read.
        # The second preflight must add no alias-only pass beyond those rereads.
        assert sum(event == ('aliases', 0) for event in raw.events) - aliases_before == (
            sum(event[0] == 'raw' for event in raw.events) - raw_before)
        assert not db.source_rows and not db.bindings and not db.receipts
    assert upload._matching_cache is None
    assert_no_taste_io(db)


def test_empty_taste_exception_is_enhanced_only_not_a_tsv_bypass(monkeypatch):
    db = install(monkeypatch, library=7)
    with matched_raw(monkeypatch).open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        original = p.envelope._freeze(json.loads(db.receipt['prepared']))
        p.envelope._validate(original, original_command=batch.prepare_command,
            expected_header=original[1])
        tsv = replace(batch.prepare_command, mapping_name=p.gate.MAPPING)
        header = list(original[1])
        header[9] = header[10] = p.gate.MAPPING
        forged = (original[0], tuple(header), original[2], (), original[4])
        with pytest.raises(p.source.SourceUnavailable):
            p.envelope._validate(forged, original_command=tsv, expected_header=tuple(header))
        # Even Enhanced cannot smuggle a rating/favorite into its no-taste lane.
        row = list(original[2][0]); row[10] = 5
        forged = (original[0], original[1], (tuple(row),), (), original[4])
        with pytest.raises(p.source.SourceUnavailable):
            p.envelope._validate(forged, original_command=batch.prepare_command,
                expected_header=original[1])


def test_committed_replay_survives_deleted_library_without_native_lookup(monkeypatch):
    db = install(monkeypatch, library=7)
    with matched_raw(monkeypatch).open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        first = apply(ctx, ready)
        db.membership = False
        db.files.clear()
        before = snapshot(db), db.extra_snapshot()
        native_before = len(db.native_calls)
        again = apply(requested_context(None), ready)
        assert again == first
        assert (snapshot(db), db.extra_snapshot()) == before
        assert len(db.native_calls) == native_before
    assert_no_taste_io(db)


def test_same_job_key_different_selected_scope_conflicts_without_new_effect(monkeypatch):
    db = install(monkeypatch, library=7)
    with matched_raw(monkeypatch).open() as upload:
        ctx, cmd, batch = start(db, upload)
        before = snapshot(db), db.extra_snapshot()
        changed = replace(cmd, original_matching_library_id=None)
        with pytest.raises((p.source.SourceUnavailable, p.source.SourceStale)):
            jobs.start_foobar_import_job(URL, requested_context(None), command=changed)
        assert (snapshot(db), db.extra_snapshot()) == before


def test_alias_changed_after_index_terminal_never_publishes_cache_or_ready(monkeypatch):
    db = install(monkeypatch, library=7)
    raw = matched_raw(monkeypatch)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        raw.aliases[0] = ('/other.flac',)
        with pytest.raises((p.source.SourceUnavailable, p.source.SourceStale,
                            enhanced_prepare.windows.EnhancedRawIndexRejected)):
            prepare(ctx, batch, upload)
        assert upload._matching_cache is None
        assert not db.receipts and not db.bindings and not db.source_rows


def test_identical_account_only_evidence_gets_association_only_revision_once(monkeypatch):
    db = install(monkeypatch)
    with matched_raw(monkeypatch).open() as upload:
        complete(db, upload)
    before = deepcopy((db.source_rows, db.source_versions, db.entry_headers, db.entry_children))
    revision = db.revision
    db.library = 7
    with matched_raw(monkeypatch).open() as upload:
        _, _, result = complete(db, upload)
    assert result.confirmed_counts == (1, 0, 0, 0, 0, 0, 1)
    assert db.revision == revision + 1
    assert (db.source_rows, db.source_versions, db.entry_headers, db.entry_children) == before
    assert len(db.bindings) == 1
    with matched_raw(monkeypatch).open() as upload:
        _, _, again = complete(db, upload)
    assert db.revision == revision + 1 and again.confirmed_counts[-1] == 0
    assert_no_taste_io(db)


def test_saved_binding_outside_upload_reserves_target_without_active_candidate(monkeypatch):
    db = install(monkeypatch, library=7)
    with matched_raw(monkeypatch).open() as upload:
        complete(db, upload)
    old = deepcopy((db.bindings, db.history))
    raw = matched_raw(monkeypatch)
    raw.raw = {1: raw.raw[0]}
    raw.aliases = {1: ('/synthetic.flac',)}
    with raw.open() as upload:
        _, _, result = complete(db, upload)
    assert len(db.source_rows) == 2
    assert (db.bindings, db.history) == old
    assert result.confirmed_counts[-1] == 0
    assert_no_taste_io(db)


def test_readable_offline_metadata_can_associate_without_playability(monkeypatch):
    from tests.py.foobar_account_matching_composed_boundary import scalars
    db = install(monkeypatch, library=7)
    execute = db.execute
    def offline_driver(sql, params=None, **kwargs):
        cursor = execute(sql, params, **kwargs)
        if sql == scalars._foobar_inventory_scalar_sql():
            for row in cursor.rows:
                row['selection_status'] = 'missing'
                row['file_available'] = False
        return cursor
    monkeypatch.setattr(db, 'execute', offline_driver)
    with matched_raw(monkeypatch).open() as upload:
        _, _, result = complete(db, upload)
    assert result.confirmed_counts[-1] == 1
    assert next(iter(db.bindings.values()))['track'] == 21
    assert_no_taste_io(db)


def test_duplicate_alias_from_bypassed_reader_is_rejected_without_import_mutation(monkeypatch):
    # The admitted SQLite mapping has a UNIQUE filename primary key. This
    # malformed reader seam must fail closed, not become a successful import.
    db = install(monkeypatch, library=7)
    raw = matched_raw(monkeypatch, [('/synthetic.flac', '/synthetic.flac')])
    with raw.open() as upload:
        with pytest.raises(p.SourceUnavailable):
            complete(db, upload)
    assert not db.source_rows and not db.bindings and not db.receipts and not db.keys
    assert not db.entry_headers and not db.entry_children
    assert p._INSERT_READY_SQL not in db.calls and f._COMMIT_SQL not in db.calls
    assert_no_taste_io(db)
