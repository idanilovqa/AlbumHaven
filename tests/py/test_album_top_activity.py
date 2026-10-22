"""Activity timeline behavior; ordinary production import, no storage fixtures."""
from datetime import datetime, timedelta, timezone
import unittest
from zoneinfo import ZoneInfo

from music_app.services.album_top_activity import (
    ActivityError, new_activity, progress_allowed, set_activity,
)


class AlbumTopActivityTests(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
        self.pause = self.start + timedelta(hours=1)
        self.resume = self.start + timedelta(hours=2)
        self.initial = new_activity(self.start)

    def test_default_is_active_with_zero_revision(self):
        self.assertTrue(self.initial.active)
        self.assertEqual(self.initial.revision, 0)
        self.assertTrue(progress_allowed(self.initial, self.start))

    def test_before_recorded_timeline_is_not_invented(self):
        self.assertFalse(progress_allowed(self.initial, self.start - timedelta(microseconds=1)))

    def test_pause_blocks_new_credit_without_mutating_previous_state(self):
        paused = set_activity(self.initial, False, self.pause)
        self.assertFalse(paused.active)
        self.assertEqual(paused.revision, 1)
        self.assertTrue(self.initial.active)
        self.assertEqual(self.initial.revision, 0)
        self.assertFalse(progress_allowed(paused, self.start))
        self.assertFalse(progress_allowed(paused, self.pause))

    def test_reactivation_excludes_every_paused_occurrence(self):
        paused = set_activity(self.initial, False, self.pause)
        active = set_activity(paused, True, self.resume)
        self.assertEqual(active.revision, 2)
        self.assertTrue(progress_allowed(active, self.pause - timedelta(microseconds=1)))
        self.assertFalse(progress_allowed(active, self.pause))
        self.assertFalse(progress_allowed(active, self.resume - timedelta(microseconds=1)))
        self.assertTrue(progress_allowed(active, self.resume))

    def test_same_value_is_idempotent(self):
        unchanged = set_activity(self.initial, True, self.pause)
        self.assertEqual(unchanged.revision, 0)
        paused = set_activity(self.initial, False, self.pause)
        unchanged_pause = set_activity(paused, False, self.resume)
        self.assertEqual(unchanged_pause.revision, 1)
        self.assertFalse(unchanged_pause.active)

    def test_multiple_pauses_preserve_all_exclusions(self):
        state = set_activity(self.initial, False, self.pause)
        state = set_activity(state, True, self.resume)
        second_pause = self.resume + timedelta(hours=1)
        state = set_activity(state, False, second_pause)
        state = set_activity(state, True, second_pause + timedelta(hours=1))
        self.assertEqual(state.revision, 4)
        self.assertFalse(progress_allowed(state, self.pause))
        self.assertTrue(progress_allowed(state, self.resume))
        self.assertFalse(progress_allowed(state, second_pause))

    def test_same_instant_pause_resume_has_no_phantom_gap(self):
        state = set_activity(self.initial, False, self.pause)
        state = set_activity(state, True, self.pause)
        self.assertTrue(progress_allowed(state, self.pause))
        self.assertEqual(state.revision, 2)

    def test_timelines_are_independent(self):
        other = new_activity(self.start)
        paused = set_activity(self.initial, False, self.pause)
        self.assertFalse(progress_allowed(paused, self.pause))
        self.assertTrue(progress_allowed(other, self.pause))
        self.assertEqual(other.revision, 0)

    def test_same_instant_in_other_timezone_is_same_boundary(self):
        offset = timezone(timedelta(hours=-6))
        state = set_activity(self.initial, False, self.pause.astimezone(offset))
        state = set_activity(state, True, self.resume.astimezone(offset))
        self.assertFalse(progress_allowed(state, self.pause))
        self.assertTrue(progress_allowed(state, self.resume))

    def test_backdated_transition_or_noop_is_rejected(self):
        state = set_activity(self.initial, False, self.pause)
        for active in (True, False):
            with self.subTest(active=active), self.assertRaises(ActivityError):
                set_activity(state, active, self.start)

    def test_active_requires_boolean(self):
        for value in (0, 1, None, "true", [], {}):
            with self.subTest(value=value), self.assertRaises(ActivityError):
                set_activity(self.initial, value, self.pause)

    def test_aware_instants_are_required_at_every_boundary(self):
        for value in (self.start.replace(tzinfo=None), None, "2026-10-14", 0):
            with self.subTest(value=value):
                with self.assertRaises(ActivityError):
                    new_activity(value)
                with self.assertRaises(ActivityError):
                    set_activity(self.initial, False, value)
                with self.assertRaises(ActivityError):
                    progress_allowed(self.initial, value)

    def test_exposed_state_cannot_be_mutated(self):
        for field, value in (("active", False), ("revision", 99)):
            with self.subTest(field=field), self.assertRaises((AttributeError, TypeError)):
                setattr(self.initial, field, value)
        self.assertTrue(self.initial.active)
        self.assertEqual(self.initial.revision, 0)


    def test_noop_preserves_prior_timeline(self):
        state = set_activity(self.initial, False, self.pause)
        state = set_activity(state, True, self.resume)
        unchanged = set_activity(state, True, self.resume + timedelta(hours=1))
        self.assertEqual(unchanged.revision, state.revision)
        for occurrence in (self.start, self.pause, self.resume):
            with self.subTest(occurrence=occurrence):
                self.assertEqual(progress_allowed(unchanged, occurrence),
                                 progress_allowed(state, occurrence))

    def test_dst_fold_uses_instants_not_repeated_wall_time(self):
        zone = ZoneInfo("America/New_York")
        start = datetime(2026, 11, 1, 0, 30, tzinfo=zone)
        pause = datetime(2026, 11, 1, 1, 30, tzinfo=zone, fold=0)
        resume = datetime(2026, 11, 1, 1, 30, tzinfo=zone, fold=1)
        state = set_activity(new_activity(start), False, pause)
        state = set_activity(state, True, resume)
        self.assertFalse(progress_allowed(state, pause))
        self.assertFalse(progress_allowed(state, datetime(2026, 11, 1, 6, tzinfo=timezone.utc)))
        self.assertTrue(progress_allowed(state, resume))
        self.assertEqual(state.revision, 2)

if __name__ == "__main__":
    unittest.main()
