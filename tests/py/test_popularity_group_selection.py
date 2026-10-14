"""Independent coverage for opt-in grouping and source ties, preserving old defaults."""
from dataclasses import replace
from datetime import datetime, timezone
import unittest

from music_app.services import popularity_snapshots as popularity


NOW = datetime(2026, 10, 13, tzinfo=timezone.utc)


def track(track_id=1, **changes):
    return popularity.LocalTrackEvidence(**({
        "track_id": track_id, "mapping_revision": "mapping:one", "provider": "lastfm",
        "source_entity_id": f"lastfm:{track_id}",
        "canonical_recording_id": f"recording:{track_id}", "recording_evidence": "verified",
        "canonical_artist_id": "artist:one", "artist_evidence": "verified",
    } | changes))


def snapshot(item, count=10):
    observation = popularity.PopularityObservation(
        "lastfm", "overall_scrobbles", item.source_entity_id, "provider:v1", NOW, NOW, count, "resolved")
    return popularity.CachedPopularity(item.track_id, item.mapping_revision, observation)


def select(items, **options):
    return popularity.select_local_popular_tracks(items, **({
        "is_local_readable": lambda item: True, "matches_filter": lambda item: True,
        "read_snapshot": lambda item: snapshot(item),
    } | options))


def ids(result):
    return tuple(item.track_id for item in result.tracks)


def forbidden(*args):
    raise AssertionError("Rejected candidate reached metadata callback")


class SelectorDefaultCompatibilityTests(unittest.TestCase):
    def test_old_default_ties_still_sort_by_canonical_identity(self):
        items = [track(2), track(10), track(1)]
        result = select(items)
        self.assertEqual(ids(result), (1, 10, 2))
        self.assertEqual(result.total, 3)
        self.assertEqual(result.diagnostics, ())
        explicit = select(items, max_per_group=None, group_identity=None, tie_breaker=None)
        self.assertEqual(explicit, result)

    def test_old_default_representative_still_prefers_complete_canonical_evidence(self):
        partial = track(1, source_entity_id="lastfm:shared", canonical_recording_id=None,
                        recording_evidence=None, canonical_artist_id=None, artist_evidence=None)
        complete = track(2, source_entity_id="lastfm:shared")
        self.assertEqual(ids(select([partial, complete])), (2,))
        self.assertEqual(ids(select([partial, complete], max_per_artist=1)), (2,))

    def test_old_artist_cap_pagination_total_and_missing_artist_contract(self):
        items = [track(1), track(2), track(3, canonical_artist_id="artist:two"),
                 track(4, canonical_artist_id=None, artist_evidence=None)]
        result = select(items, max_per_artist=1, offset=1, limit=1,
                        read_snapshot=lambda item: snapshot(item, {1: 10, 2: 30, 3: 20, 4: 100}[item.track_id]))
        self.assertEqual(ids(result), (3,))
        self.assertEqual(result.total, 2)
        self.assertEqual(result.diagnostics, ((4, "missing_canonical_artist"),))
        self.assertEqual(ids(select([items[3]])), (4,))

    def test_new_tie_breaker_is_opt_in_even_without_group_cap(self):
        items = [track(1), track(2)]
        self.assertEqual(ids(select(items)), (1, 2))
        self.assertEqual(ids(select(items, tie_breaker=lambda item: (-item.track_id,))), (2, 1))


class GenericGroupSelectionTests(unittest.TestCase):
    def test_group_cap_uses_supplied_group_instead_of_canonical_artist(self):
        items = [track(i) for i in (1, 2, 3)]
        groups = {1: "album:a", 2: "album:a", 3: "album:b"}
        counts = {1: 10, 2: 30, 3: 20}
        result = select(items, max_per_group=1, group_identity=lambda item: groups[item.track_id],
                        read_snapshot=lambda item: snapshot(item, counts[item.track_id]))
        self.assertEqual(ids(result), (2, 3))
        self.assertEqual(result.total, 2)
        self.assertEqual(result.diagnostics, ())

    def test_group_quota_does_not_require_canonical_artist_evidence(self):
        item = track(canonical_artist_id=None, artist_evidence=None)
        result = select([item], max_per_group=1, group_identity=lambda item: "authoritative:album")
        self.assertEqual(ids(result), (1,))
        self.assertEqual(result.diagnostics, ())

    def test_group_total_is_after_dedupe_and_quota_before_pagination(self):
        first = track(1)
        duplicate = track(2, canonical_recording_id=first.canonical_recording_id)
        items = [first, duplicate, track(3), track(4), track(5)]
        groups = {1: "group:a", 2: "group:a", 3: "group:a", 4: "group:b", 5: "group:b"}
        result = select(items, max_per_group=2, group_identity=lambda item: groups[item.track_id],
                        offset=1, limit=2)
        self.assertEqual(ids(result), (3, 4))
        self.assertEqual(result.total, 4)
        beyond = select(items, max_per_group=2, group_identity=lambda item: groups[item.track_id],
                        offset=100, limit=1)
        self.assertEqual(ids(beyond), ())
        self.assertEqual(beyond.total, 4)

    def test_source_tie_selects_duplicate_representative_and_equal_count_order(self):
        first = track(1)
        early = track(2, canonical_recording_id=first.canonical_recording_id)
        third = track(3)
        order = {1: (3, 1, 1), 2: (0, 1, 1), 3: (1, 1, 1)}
        result = select([first, third, early], max_per_group=3, group_identity=lambda item: "group:a",
                        tie_breaker=lambda item: order[item.track_id])
        self.assertEqual(ids(result), (2, 3))

    def test_missing_group_is_reported_for_every_missing_copy(self):
        items = [track(2, canonical_recording_id="recording:1"), track(1)]
        result = select(items, max_per_group=1, group_identity=lambda item: None)
        self.assertEqual(ids(result), ())
        self.assertEqual(result.total, 0)
        self.assertEqual(result.diagnostics, ((1, "missing_group_identity"), (2, "missing_group_identity")))

    def test_missing_group_copy_is_not_silently_hidden_by_valid_duplicate(self):
        items = [track(1), track(2, canonical_recording_id="recording:1")]
        result = select(items, max_per_group=1,
                        group_identity=lambda item: None if item.track_id == 1 else "group:a")
        self.assertEqual(ids(result), (2,))
        self.assertEqual(result.diagnostics, ((1, "missing_group_identity"),))

    def test_denied_or_filtered_rows_never_reach_group_ties_cache_or_diagnostics(self):
        denied = object()
        filtered = track(2)
        calls = []

        def admit(item):
            calls.append("admission")
            return item is not denied

        def predicate(item):
            self.assertIs(item, filtered)
            calls.append("filter")
            return False

        result = select([denied, filtered], is_local_readable=admit, matches_filter=predicate,
                        read_snapshot=forbidden, max_per_group=1,
                        group_identity=forbidden, tie_breaker=forbidden)
        self.assertEqual((result.tracks, result.total, result.diagnostics), ((), 0, ()))
        self.assertEqual(calls, ["admission", "admission", "filter"])

    def test_unknown_snapshot_never_reaches_group_or_tie_callbacks(self):
        result = select([track()], read_snapshot=lambda item: None, max_per_group=1,
                        group_identity=forbidden, tie_breaker=forbidden)
        self.assertEqual(ids(result), ())
        self.assertEqual(result.diagnostics, ((1, "missing_global_metric"),))

    def test_invalid_options_fail_before_any_candidate_iteration(self):
        def candidates():
            forbidden()
            yield track()

        invalid = [{"max_per_group": 1}, {"group_identity": lambda item: "group:a"},
                   {"max_per_artist": 1, "max_per_group": 1, "group_identity": lambda item: "group:a"}]
        invalid += [{"max_per_group": value, "group_identity": lambda item: "group:a"}
                    for value in (0, -1, True, False, 1.0, "1", [], {})]
        invalid += [{"offset": -1}, {"offset": True}, {"limit": 0}, {"limit": 1.0},
                    {"max_per_artist": True}, {"max_per_artist": 0}]
        for options in invalid:
            with self.subTest(options=options), self.assertRaises(ValueError):
                select(candidates(), **options)

    def test_invalid_group_values_are_not_labels_or_implicit_unknowns(self):
        for value in ("", " ", 0, True, 1.0, [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                select([track()], max_per_group=1, group_identity=lambda item: value)

    def test_group_and_tie_callback_failures_propagate_unchanged(self):
        for failing_callback in ("group_identity", "tie_breaker"):
            error = RuntimeError(f"{failing_callback} failed")

            def fail(item):
                raise error

            options = {"max_per_group": 1, "group_identity": lambda item: "group:a",
                       "tie_breaker": lambda item: (item.track_id,)}
            options[failing_callback] = fail
            with self.subTest(callback=failing_callback), self.assertRaises(RuntimeError) as raised:
                select([track()], **options)
            self.assertIs(raised.exception, error)

    def test_selection_does_not_mutate_inputs(self):
        items = [track(3), track(1), track(2)]
        before = tuple(items)
        result = select(items, max_per_group=2, group_identity=lambda item: "group:a",
                        tie_breaker=lambda item: (item.track_id,))
        self.assertEqual(ids(result), (1, 2))
        self.assertEqual(tuple(items), before)
        self.assertIs(result.tracks[0], items[1])


if __name__ == "__main__":
    unittest.main()
