"""AUTHORED ONLY. Real parser/planner diagnostic pages; never executed here."""
import pytest

from tests.py.foobar_account_personal_testing import (
    install, seed, matched_payload, direct_preflight, personal_snapshot, p,
)


def diagnostic_payload(count, *, title='Source title', artist='Source artist', album='Source album'):
    return ('path\tartist\ttitle\talbum\tplay_count_enhanced\tplayed_times\n' + ''.join(
        '/unknown-%d.flac\t%s\t%s\t%s\tbad-count\t[unsupported]\n' % (row, artist, title, album)
        for row in range(1, count + 1))).encode()


def identities(items):
    return [(item.cursor, item.ordinal, item.code, item.field) for item in items]


def expected_diagnostics(count):
    return [(row * 32 + index, row, code, field) for row in range(1, count + 1)
        for index, (code, field) in enumerate((('invalid_count', 'play_count_enhanced'),
            ('unsupported_history_field', 'played_times'), ('no_local_match', None)))]


def test_all_diagnostic_instances_reachable_across_windows_without_plan_or_legacy_changes(monkeypatch):
    db = install(monkeypatch)
    payload = diagnostic_payload(203)
    before = personal_snapshot(db)
    plain = direct_preflight(db, payload)
    assert plain.problem_items == () and plain.problem_after is None
    seen, cursor, lengths = [], 0, []
    while cursor is not None:
        page = direct_preflight(db, payload, problem_after=cursor)
        assert page.status == 'complete_preflight' and page.checked_rows == 203
        assert page.problem_count == 609 and page.problem_after == cursor
        assert 1 <= len(page.problem_items) <= 32
        assert all(item.cursor > cursor for item in page.problem_items)
        seen.extend(identities(page.problem_items))
        lengths.append(len(page.problem_items))
        assert page.problem_remaining == 609 - len(seen)
        assert page.problem_next == (page.problem_items[-1].cursor if len(seen) < 609 else None)
        for attribute in ('proposal_sha256', 'window_seals', 'proposed_counts', 'review_counts',
                          'review_problems', 'review_truncated'):
            assert getattr(page, attribute) == getattr(plain, attribute)
        assert page.conflicts == () and page.conflict_after is None
        cursor = page.problem_next
    assert seen == expected_diagnostics(203)
    assert lengths == [32] * 19 + [1]
    assert personal_snapshot(db) == before and not db.personal_frames and not db.job_rows


def test_overlapping_categories_are_instances_not_distinct_rows(monkeypatch):
    db = install(monkeypatch)
    report = direct_preflight(db, diagnostic_payload(1), problem_after=0)
    assert identities(report.problem_items) == expected_diagnostics(1)
    assert report.problem_count == 3 and report.review_counts[1] == 1
    assert report.review_counts[3] == 1 and report.field_error_count == 2
    assert report.unsupported_nonempty_field_count == 1
    assert report.problem_next is None and report.problem_remaining == 0


def test_duplicate_source_identity_is_real_ambiguous_diagnostic_not_an_action(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 1)
    payload += payload.splitlines(keepends=True)[1]
    report = direct_preflight(db, payload, after=0, problem_after=0)
    assert identities(report.problem_items) == [
        (32, 1, 'duplicate_source_identity', None),
        (64, 2, 'duplicate_source_identity', None)]
    assert report.review_counts[2] == 2 and report.problem_count == 2
    assert report.conflicts == () and not db.personal_frames


def test_protected_fields_and_parser_error_share_one_stable_row_cursor_namespace(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    payload = ('path\ttitle\trating\tfavorite\tplay_count_enhanced\n'
        + db.files[21] + '\tTrack\t4\t1\tbad\n').encode()
    report = direct_preflight(db, payload, after=0, problem_after=0)
    assert identities(report.problem_items) == [
        (32, 1, 'invalid_count', 'play_count_enhanced'),
        (33, 1, 'protected_rating', 'rating'),
        (34, 1, 'protected_favorite', 'favorite')]
    assert report.problem_count == 3 and report.conflict_count == 2
    assert report.review_counts[3:5] == (1, 1)
    assert not db.personal_frames


def test_empty_and_exhausted_page_keep_whole_file_count(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 1, rating='2', favorite='0')
    empty = direct_preflight(db, payload, problem_after=0)
    assert empty.problem_count == empty.problem_remaining == 0
    assert empty.problem_items == () and empty.problem_next is None
    payload = diagnostic_payload(1)
    for cursor in (34, 35, 3200031):
        final = direct_preflight(db, payload, problem_after=cursor)
        assert final.problem_count == 3 and final.problem_remaining == 0
        assert final.problem_after == cursor and final.problem_items == ()
        assert final.problem_next is None
    middle = direct_preflight(db, payload, problem_after=32)
    assert identities(middle.problem_items) == expected_diagnostics(1)[1:]
    assert middle.problem_count == 3 and middle.problem_remaining == 0


@pytest.mark.parametrize('cursor', [False, -1, 3200032, '0', 0.0])
def test_invalid_diagnostic_cursor_fails_before_native_reads(monkeypatch, cursor):
    db = install(monkeypatch)
    with pytest.raises(p.gate.PrepareInvalid):
        direct_preflight(db, matched_payload(db, 1), problem_after=cursor)
    assert not db.personal_reads and not db.personal_frames


def test_diagnostic_labels_only_use_bounded_source_identity(monkeypatch):
    db = install(monkeypatch)
    title = '<img src=x>' + '\U0001f600' * 50
    artist = 'A\u202e' + '\u00e9' * 60
    album = 'B\x01' + '\u00e9' * 60
    report = direct_preflight(db, diagnostic_payload(1, title=title, artist=artist, album=album),
        problem_after=0)
    for item in report.problem_items:
        for actual, raw, limit in ((item.source_artist, artist, 48),
                (item.source_title, title, 96), (item.source_album, album, 48)):
            assert actual == p._bounded_personal_label(raw, limit)
            assert len(actual.encode()) <= limit
        assert item.source_title.startswith('<img src=x>')
        assert '/unknown' not in repr(item)
    assert not db.personal_frames


def test_details_disabled_does_not_invoke_optional_classifier_or_labels(monkeypatch):
    db = install(monkeypatch)
    payload = diagnostic_payload(3)
    real, calls = p._diagnostic_row_problems, []
    def observed(*args, **kwargs):
        calls.append(True)
        return real(*args, **kwargs)
    monkeypatch.setattr(p, '_diagnostic_row_problems', observed)
    direct_preflight(db, payload)
    assert calls == []
    detailed = direct_preflight(db, payload, problem_after=0)
    assert calls == [True] * 3 and detailed.problem_count == 9
