"""Typed activity hydration through the normal production domain import."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone, tzinfo
import unittest
from zoneinfo import ZoneInfo

from music_app.services.album_top_activity import (
    ActivityError, new_activity, progress_allowed, restore_activity, set_activity,
)


class NoOffset(tzinfo):
    def utcoffset(self, dt):
        return None


class AlbumTopActivityRestorationTests(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
        self.pause = self.start + timedelta(hours=1)
        self.resume = self.start + timedelta(hours=2)
        self.payload = {
            'active': True, 'revision': 2,
            'transitions': [
                {'revision': 0, 'occurred_at': self.start},
                {'revision': 1, 'occurred_at': self.pause},
                {'revision': 2, 'occurred_at': self.resume},
            ],
        }

    def test_restored_baseline_matches_new_activity(self):
        payload = {'active': True, 'revision': 0,
                   'transitions': [{'revision': 0, 'occurred_at': self.start}]}
        restored = restore_activity(payload)
        original = new_activity(self.start)
        self.assertIs(restored.active, True)
        self.assertEqual(restored.revision, 0)
        for instant in (self.start - timedelta(microseconds=1), self.start, self.resume):
            with self.subTest(instant=instant):
                self.assertIs(progress_allowed(restored, instant), progress_allowed(original, instant))

    def test_restored_paused_state_blocks_historical_credit(self):
        self.payload['active'] = False
        self.payload['revision'] = 1
        self.payload['transitions'].pop()
        restored = restore_activity(self.payload)
        self.assertIs(restored.active, False)
        self.assertEqual(restored.revision, 1)
        for instant in (self.start, self.pause, self.resume):
            with self.subTest(instant=instant):
                self.assertFalse(progress_allowed(restored, instant))
        resumed = set_activity(restored, True, self.resume)
        self.assertTrue(progress_allowed(resumed, self.start))
        self.assertFalse(progress_allowed(resumed, self.pause))
        self.assertTrue(progress_allowed(resumed, self.resume))

    def test_restoration_preserves_half_open_intervals(self):
        restored = restore_activity(self.payload)
        self.assertIs(restored.active, True)
        self.assertEqual(restored.revision, 2)
        for instant, expected in (
            (self.start - timedelta(microseconds=1), False),
            (self.start, True),
            (self.pause - timedelta(microseconds=1), True),
            (self.pause, False),
            (self.resume - timedelta(microseconds=1), False),
            (self.resume, True),
        ):
            with self.subTest(instant=instant):
                self.assertIs(progress_allowed(restored, instant), expected)

    def test_same_instant_rows_preserve_order(self):
        self.payload['transitions'][1]['occurred_at'] = self.start
        self.payload['transitions'][2]['occurred_at'] = self.start
        restored = restore_activity(self.payload)
        self.assertTrue(progress_allowed(restored, self.start))
        self.assertFalse(progress_allowed(restored, self.start - timedelta(microseconds=1)))
        self.assertEqual(restored.revision, 2)
        paused = set_activity(restored, False, self.start)
        self.assertFalse(paused.active)
        self.assertEqual(paused.revision, 3)

    def test_restoration_normalizes_mixed_timezone_offsets(self):
        self.payload['transitions'][0]['occurred_at'] = self.start.astimezone(timezone(timedelta(hours=9)))
        self.payload['transitions'][1]['occurred_at'] = self.pause.astimezone(timezone(timedelta(hours=-6)))
        restored = restore_activity(self.payload)
        self.assertTrue(progress_allowed(restored, self.start))
        self.assertFalse(progress_allowed(restored, self.pause))
        self.assertTrue(progress_allowed(restored, self.resume))

    def test_dst_fold_orders_instants_and_rejects_reversal(self):
        zone = ZoneInfo('America/New_York')
        first = datetime(2026, 11, 1, 1, 30, tzinfo=zone, fold=0)
        second = datetime(2026, 11, 1, 1, 30, tzinfo=zone, fold=1)
        self.payload['transitions'][0]['occurred_at'] = datetime(2026, 11, 1, 0, 30, tzinfo=zone)
        self.payload['transitions'][1]['occurred_at'] = first
        self.payload['transitions'][2]['occurred_at'] = second
        restored = restore_activity(self.payload)
        self.assertFalse(progress_allowed(restored, first))
        self.assertFalse(progress_allowed(restored, datetime(2026, 11, 1, 6, tzinfo=timezone.utc)))
        self.assertTrue(progress_allowed(restored, second))
        self.payload['transitions'][1]['occurred_at'] = second
        self.payload['transitions'][2]['occurred_at'] = first
        with self.assertRaises(ActivityError):
            restore_activity(self.payload)

    def test_fractional_boundary_is_exact(self):
        instant = self.resume.replace(microsecond=123456)
        self.payload['transitions'][2]['occurred_at'] = instant
        restored = restore_activity(self.payload)
        self.assertFalse(progress_allowed(restored, instant - timedelta(microseconds=1)))
        self.assertTrue(progress_allowed(restored, instant))

    def test_restoration_does_not_alias_or_mutate_input(self):
        original = deepcopy(self.payload)
        restored = restore_activity(self.payload)
        self.assertEqual(self.payload, original)
        self.payload['transitions'][0]['occurred_at'] = self.resume
        self.payload['transitions'].clear()
        self.payload['active'] = False
        self.payload['revision'] = 99
        self.assertIs(restored.active, True)
        self.assertEqual(restored.revision, 2)
        self.assertTrue(progress_allowed(restored, self.start))
        self.assertFalse(progress_allowed(restored, self.pause))
        self.assertTrue(progress_allowed(restored, self.resume))

    def test_restored_state_remains_immutable(self):
        restored = restore_activity(self.payload)
        for field, value in (('active', False), ('revision', 99)):
            with self.subTest(field=field), self.assertRaises((AttributeError, TypeError)):
                setattr(restored, field, value)
        self.assertTrue(restored.active)
        self.assertEqual(restored.revision, 2)

    def test_noop_does_not_advance_restored_last_transition(self):
        restored = restore_activity(self.payload)
        unchanged = set_activity(restored, True, self.resume + timedelta(hours=2))
        next_state = set_activity(unchanged, False, self.resume + timedelta(hours=1))
        for state in (restored, unchanged):
            self.assertTrue(state.active)
            self.assertEqual(state.revision, 2)
            self.assertTrue(progress_allowed(state, self.start))
            self.assertFalse(progress_allowed(state, self.pause))
            self.assertTrue(progress_allowed(state, self.resume))
        self.assertEqual(next_state.revision, 3)
        self.assertFalse(next_state.active)
        for active in (True, False):
            with self.subTest(active=active), self.assertRaises(ActivityError):
                set_activity(restored, active, self.pause)

    def test_rejects_wrong_outer_and_history_shapes(self):
        for value in (None, [], (), 'state', 0, {}, {**self.payload, 'unexpected': 0}):
            with self.subTest(value=value), self.assertRaises(ActivityError):
                restore_activity(value)
        for key in self.payload:
            value = deepcopy(self.payload)
            del value[key]
            with self.subTest(missing=key), self.assertRaises(ActivityError):
                restore_activity(value)
        for value in ([], None, (), {}, 'history', tuple(self.payload['transitions'])):
            payload = deepcopy(self.payload)
            payload['transitions'] = value
            with self.subTest(history=value), self.assertRaises(ActivityError):
                restore_activity(payload)

    def test_rejects_wrong_transition_row_shape(self):
        for value in (None, [], (), 'row', 0, {}, {'revision': 0},
                      {'occurred_at': self.start},
                      {**self.payload['transitions'][0], 'active': True}):
            payload = deepcopy(self.payload)
            payload['transitions'][0] = value
            with self.subTest(value=value), self.assertRaises(ActivityError):
                restore_activity(payload)

    def test_rejects_nonstrict_boolean_projection(self):
        for value in (0, 1, None, 'true', [], {}):
            payload = deepcopy(self.payload)
            payload['active'] = value
            with self.subTest(value=value), self.assertRaises(ActivityError):
                restore_activity(payload)

    def test_rejects_revision_gaps_duplicates_and_coercion(self):
        for field in ('projection', 'baseline', 'transition'):
            for value in (-1, True, False, None, '0', 0.0, 99):
                payload = deepcopy(self.payload)
                if field == 'projection':
                    payload['revision'] = value
                else:
                    payload['transitions'][0 if field == 'baseline' else 1]['revision'] = value
                with self.subTest(field=field, value=value), self.assertRaises(ActivityError):
                    restore_activity(payload)
        for revisions in ((1, 2, 3), (0, 0, 2), (0, 2, 3), (0, 2, 1)):
            payload = deepcopy(self.payload)
            for row, revision in zip(payload['transitions'], revisions):
                row['revision'] = revision
            with self.subTest(revisions=revisions), self.assertRaises(ActivityError):
                restore_activity(payload)

    def test_rejects_inconsistent_current_projection(self):
        for field, value in (('active', False), ('revision', 0), ('revision', 1), ('revision', 3)):
            payload = deepcopy(self.payload)
            payload[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ActivityError):
                restore_activity(payload)

    def test_rejects_nonaware_or_nondatetime_occurrences(self):
        for value in (None, 0, '2026-10-14T12:00:00+00:00',
                      self.start.replace(tzinfo=None), self.start.replace(tzinfo=NoOffset())):
            payload = deepcopy(self.payload)
            payload['transitions'][0]['occurred_at'] = value
            with self.subTest(value=value), self.assertRaises(ActivityError):
                restore_activity(payload)

    def test_rejects_decreasing_instants_without_mutating_input(self):
        self.payload['transitions'][2]['occurred_at'] = self.start
        original = deepcopy(self.payload)
        with self.assertRaises(ActivityError):
            restore_activity(self.payload)
        self.assertEqual(self.payload, original)


if __name__ == '__main__':
    unittest.main()
