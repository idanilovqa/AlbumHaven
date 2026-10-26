"""AUTHORED ONLY. Real whole-file paged preflight and unchanged default plan."""
from copy import deepcopy
from dataclasses import replace

import pytest

from tests.py.foobar_account_personal_testing import (
    install, seed, matched_payload, direct_preflight, personal_snapshot, p,
    SOURCE, FOREIGN_SOURCE, OBSERVATION,
)
from tests.py.foobar_account_review_testing import (
    running, reviewed, review_sha, requested_context, PolicyEvaluationConstraints,
    begin_review, settled_review, business_snapshot, confirm, settled, PAYLOAD,
)


def test_whole_file_pages_reach_every_conflict_and_keep_exact_total_across_windows(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 203)
    before = personal_snapshot(db)
    plain = direct_preflight(db, payload)
    assert not db.personal_reads and plain.conflicts == () and plain.conflict_after is None
    seen, cursor, page_lengths = [], 0, []
    while cursor is not None:
        first_read = len(db.personal_reads)
        page = direct_preflight(db, payload, after=cursor)
        assert page.status == 'complete_preflight' and page.checked_rows == 203
        assert page.remaining_rows == 0 and page.conflict_count == 406
        assert page.proposal_sha256 == plain.proposal_sha256 and page.window_seals == plain.window_seals
        assert page.proposed_counts == plain.proposed_counts
        assert page.conflict_after == cursor and 1 <= len(page.conflicts) <= 32
        retained = [(item.ordinal, item.field) for item in page.conflicts]
        assert not set(seen).intersection(retained)
        assert all(item.cursor > cursor for item in page.conflicts)
        seen.extend(retained)
        page_lengths.append(len(retained))
        assert page.conflict_remaining == 406 - len(seen)
        assert sum(len(ids) for ids in db.personal_reads[first_read:]) <= 32
        assert all(len(ids) <= 32 for ids in db.personal_reads[first_read:])
        assert page.conflict_next == (page.conflicts[-1].cursor if len(seen) < 406 else None)
        cursor = page.conflict_next
    assert seen == [(row, field) for row in range(1, 204) for field in ('rating', 'favorite')]
    assert page_lengths == [32] * 12 + [22]
    assert personal_snapshot(db) == before
    assert not db.job_rows and not db.attempts and not db.receipts


@pytest.mark.parametrize('rating,favorite', [('', '0'), ('0', '0'), ('-1', '0'),
    ('not-a-rating', '0'), ('N/A', '0'), ('2', '0')])
def test_empty_invalid_zero_equal_ratings_and_false_favorites_do_not_propose_changes(monkeypatch, rating, favorite):
    db = install(monkeypatch)
    payload = matched_payload(db, 1, rating=rating, favorite=favorite)
    before = personal_snapshot(db)
    result = direct_preflight(db, payload, after=0)
    assert result.status == 'complete_preflight'
    assert result.conflicts == () and result.conflict_count == result.conflict_remaining == 0
    assert result.conflict_next is None and not db.personal_reads
    assert personal_snapshot(db) == before


def test_nonactionable_provenance_stays_in_page_and_count_but_foreign_marker_is_actionable(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 2)
    db.native_rows[21]['metadata']['foobar_import_v1'] = {'rating': 'malformed'}
    db.project_native(21)
    db.native_rows[22]['metadata']['foobar_import_v1'] = {'rating': [FOREIGN_SOURCE, OBSERVATION, 1, 2]}
    db.project_native(22)
    report = direct_preflight(db, payload, after=0)
    assert report.conflict_count == 4 and len(report.conflicts) == 4
    first = [item for item in report.conflicts if item.ordinal == 1]
    second = [item for item in report.conflicts if item.ordinal == 2]
    assert all(not item.eligible and item.ineligible_reason == 'provenance_requires_review' for item in first)
    assert all(item.eligible and item.ineligible_reason is None for item in second)
    assert all(len(item.expected_state) == 13 and len(item.association_seal) == 10 for item in report.conflicts)
    assert all(len(item.fence_sha256) == len(item.source_identity_sha256) == 64 for item in report.conflicts)
    assert all(item.observation_ref is None and item.source_revision is None for item in report.conflicts)


@pytest.mark.parametrize('selection', ['missing', 'conflict', 'forbidden'])
def test_unresolved_or_ambiguous_target_is_never_an_override_opportunity(monkeypatch, selection):
    db = install(monkeypatch)
    payload = matched_payload(db, 1)
    db.tastes[21]['selection_status'] = selection
    report = direct_preflight(db, payload, after=0)
    assert report.conflicts == () and report.conflict_count == 0 and not db.personal_reads


@pytest.mark.parametrize('cursor', [False, -1, 200002, '0', 0.0])
def test_malformed_page_cursors_fail_before_native_fence_reads(monkeypatch, cursor):
    db = install(monkeypatch)
    payload = matched_payload(db, 1)
    with pytest.raises(p.gate.PrepareInvalid):
        direct_preflight(db, payload, after=cursor)
    assert not db.personal_reads and not db.personal_frames


def test_default_import_preserves_all_personal_fields_without_opt_in(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    before = deepcopy((db.tastes, db.native_rows))
    with running(monkeypatch, db=db) as (db, handle, catalog):
        review = reviewed(handle, PAYLOAD, library=7)
        assert [(item.ordinal, item.field) for item in review.result.proposed.conflicts] == [(1, 'rating'), (1, 'favorite')]
        confirm(handle, review, PAYLOAD)
        result = settled(handle)
        assert result.phase == 'completed'
        assert (db.tastes, db.native_rows) == before
        assert not db.personal_frames
        assert result.status.confirmed_counts[4:6] == (0, 0)
        assert len(db.source_rows) == 1 and len(db.bindings) == 1


@pytest.mark.parametrize('maximum', [48, 96])
def test_label_sanitizer_preserves_literal_text_and_complete_utf8_codepoints(maximum):
    malicious = ' \x00\x1f\x7f\u0085\u202e\u2066\u2028\u2029\ue000\ud800A<img>\t '
    assert p._bounded_personal_label(malicious, maximum) == 'A<img>'
    assert p._bounded_personal_label(None, maximum) == ''
    assert p._bounded_personal_label(False, maximum) == ''
    assert p._bounded_personal_label('\u00e9' * 1000, maximum) == '\u00e9' * (maximum // 2)
    assert p._bounded_personal_label('\U0001f600' * 1000, maximum) == '\U0001f600' * (maximum // 4)
    prefix = 'x' * (maximum - 1)
    assert p._bounded_personal_label(prefix + '\u00e9tail', maximum) == prefix


def test_genuine_label_visitor_is_bounded_to_selected_windows_and_keeps_default_review_unchanged(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 203)
    active, row_counts, labels, admissions, selected_rows = [False], [], [], [], []
    real_labels, real_rows, real_private = p._personal_conflict_labels, p.indexed.iter_source_rows, p._private
    def observed_private(amount):
        if active[0]:
            admissions[-1] += 1
        return real_private(amount)
    def observed_rows(value, *, offset):
        iterator = real_rows(value, offset=offset)
        try:
            while True:
                try:
                    item = next(iterator)
                except StopIteration as done:
                    return done.value
                if active[0]:
                    row_counts[-1] += 1
                yield item
        finally:
            iterator.close()
    def observed_labels(value, first, original, selected):
        assert not active[0] and len(selected) <= 32 and len(original[2]) <= 100
        selected_rows.append(tuple(sorted({item[2][0] for item in selected})))
        assert selected_rows[-1] and len(original[2]) <= 100
        row_counts.append(0)
        admissions.append(0)
        active[0] = True
        try:
            result = real_labels(value, first, original, selected)
            labels.extend(result)
            return result
        finally:
            active[0] = False
    monkeypatch.setattr(p.indexed, 'iter_source_rows', observed_rows)
    monkeypatch.setattr(p, '_personal_conflict_labels', observed_labels)
    monkeypatch.setattr(p, '_private', observed_private)
    plain = direct_preflight(db, payload)
    assert row_counts == [] and labels == []
    detailed = direct_preflight(db, payload, after=0)
    # The bounded Prepare prefix can span multiple windows before the first
    # 32 fields fill. Only windows contributing selected rows may scan labels.
    assert [row for window in selected_rows for row in window] == list(range(1,17))
    assert row_counts == [100] * len(selected_rows)
    assert admissions == [101] * len(selected_rows)  # Hold plus every scanned row.
    assert len(labels) == 16 and all(len(value.encode()) <= limit
        for row, artist, title, album in labels
        for value, limit in ((artist, 48), (title, 96), (album, 48)))
    assert [(item.ordinal, item.source_title) for item in detailed.conflicts] == [
        (row, 'Synthetic %d' % (row + 20)) for row in range(1, 17) for field in ('rating', 'favorite')]
    assert detailed.proposal_sha256 == plain.proposal_sha256 and detailed.window_seals == plain.window_seals
    assert detailed.proposed_counts == plain.proposed_counts and not db.personal_frames


def test_label_collector_requires_genuine_source_owner_terminal_and_selected_ordinals(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 1)
    real, checked = p._personal_conflict_labels, []
    def inspect_genuine(value, first, original, selected):
        assert not checked and selected
        with pytest.raises(p.SourceUnavailable):
            real(None, first, original, selected)
        with pytest.raises(p.SourceUnavailable):
            real(value, replace(first, source_sha256='0' * 64), original, selected)
        with pytest.raises(p.SourceUnavailable):
            real(value, replace(first, status='not-parsed'), original, selected)
        missing = list(selected[0])
        row = list(missing[2])
        row[0] = 100000
        missing[2] = tuple(row)
        with pytest.raises(p.SourceUnavailable):
            real(value, first, original, (tuple(missing),))
        assert not db.personal_reads  # No native phase overlaps parser failures.
        checked.append(True)
        return real(value, first, original, selected)
    monkeypatch.setattr(p, '_personal_conflict_labels', inspect_genuine)
    result = direct_preflight(db, payload, after=0)
    assert checked == [True] and result.status == 'complete_preflight'
    assert len(result.conflicts) == 2 and result.conflicts[0].source_title == 'Synthetic 21'
    assert not db.personal_frames and not db.job_rows
