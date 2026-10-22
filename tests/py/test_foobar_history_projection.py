"""Independent synthetic contracts for the pure Foobar history projection.

Authored against accepted contract R2, without an implementation or execution.
No database, app, provider, parser, preview, filesystem fixture, or user data.
These tests concern one normalized Foobar observation, never a merged history.
"""

from dataclasses import FrozenInstanceError, fields, is_dataclass, replace
from itertools import permutations
import unittest

from music_app.services.foobar_history_projection import (
    HistoryDisplayRow,
    HistoryInput,
    HistoryProjection,
    HistoryProjectionError,
    NormalizedBoundary,
    NormalizedEvent,
    project_foobar_history,
)


MIN_KEY = -(2**63)
MAX_KEY = 2**63 - 1
MIN_SECOND = -9223372036854775000
MAX_SECOND = 9223372036854775000
MODES = ("grouped", "individual")


def boundary(label="synthetic boundary", key=0, precision="millisecond"):
    return NormalizedBoundary(label, key, precision)


def event(ref="event-1", key=0, precision="millisecond"):
    return NormalizedEvent(ref, boundary("synthetic event", key, precision))


def history(total=0, *, first=None, last=None, events=(), coverage="none",
            first_relation="not_applicable", observation_ref="observation-1",
            revision="revision-1", track_ref="track-1", source_kind="foobar_local"):
    return HistoryInput(observation_ref, revision, track_ref, source_kind, total,
                        first, last, events, coverage, first_relation)


class StringChild(str):
    pass


class IntChild(int):
    pass


class TupleChild(tuple):
    pass


class Poison:
    """Wrong-type inputs must not be coerced or traversed."""

    def __iter__(self):
        raise AssertionError("unexpected iteration")

    def __len__(self):
        raise AssertionError("unexpected length")

    def __str__(self):
        raise AssertionError("unexpected string coercion")

    def __eq__(self, other):
        raise AssertionError("unexpected equality")

    def __int__(self):
        raise AssertionError("unexpected integer coercion")


def child_of(value):
    child_type = type("RecordChild", (type(value),), {})
    return child_type(*(getattr(value, field.name) for field in fields(value)))


class FoobarHistoryProjectionTests(unittest.TestCase):
    def assert_projection(self, value, mode, expected):
        """Expected rows are literal (kind, weight, anchor, discriminator) tuples."""
        result = project_foobar_history(value, mode=mode)
        self.assertIs(type(result), HistoryProjection)
        self.assertEqual(
            (result.version, result.status, result.reason, result.mode,
             result.observation_ref, result.revision, result.track_ref, result.total),
            ("foobar_history_projection_v1", "ready", None, mode,
             value.observation_ref, value.revision, value.track_ref, value.total),
        )
        self.assertIs(type(result.total), int)
        self.assertIs(type(result.rows), tuple)
        self.assertEqual(len(result.rows), len(expected))
        self.assertEqual(sum(row.weight for row in result.rows), value.total)
        keys = []
        for row, (kind, weight, anchor, discriminator) in zip(result.rows, expected):
            with self.subTest(kind=kind, discriminator=discriminator):
                self.assertIs(type(row), HistoryDisplayRow)
                self.assertEqual((row.kind, row.weight, row.anchor), (kind, weight, anchor))
                self.assertIs(type(row.weight), int)
                self.assertGreater(row.weight, 0)
                self.assertIs(row.show_count, weight > 1)
                self.assertIs(row.unknown_dates, kind != "dated_event")
                self.assertEqual(
                    (row.interval_start, row.interval_end),
                    (None, None) if kind == "dated_event" else (value.first, value.last),
                )
                self.assertIs(type(row.row_key), tuple)
                self.assertEqual(row.row_key, (
                    value.observation_ref, value.revision, value.track_ref,
                    mode, kind, discriminator,
                ))
                keys.append(row.row_key)
        self.assertEqual(len(keys), len(set(keys)))
        return result

    def assert_reconciliation(self, value, reason, modes=MODES):
        for mode in modes:
            with self.subTest(mode=mode, reason=reason):
                result = project_foobar_history(value, mode=mode)
                self.assertIs(type(result), HistoryProjection)
                self.assertEqual(
                    (result.version, result.status, result.reason, result.mode,
                     result.observation_ref, result.revision, result.track_ref, result.total),
                    ("foobar_history_projection_v1", "needs_reconciliation", reason,
                     mode, value.observation_ref, value.revision, value.track_ref, value.total),
                )
                self.assertIs(type(result.total), int)
                self.assertIs(type(result.rows), tuple)
                self.assertEqual(result.rows, ())

    def assert_invalid(self, value, mode="grouped"):
        with self.assertRaises(HistoryProjectionError) as raised:
            project_foobar_history(value, mode=mode)
        self.assertIs(type(raised.exception), HistoryProjectionError)
        self.assertIsInstance(raised.exception, ValueError)
        self.assertEqual(raised.exception.code, "invalid_history_projection_input")
        self.assertIs(type(str(raised.exception)), str)
        self.assertTrue(str(raised.exception))
        # No message wording was prescribed. Compare to another invalid input,
        # without making one test depend on another test's execution or state.
        with self.assertRaises(HistoryProjectionError) as baseline:
            project_foobar_history(None, mode="grouped")
        self.assertEqual(str(raised.exception), str(baseline.exception))
        return str(raised.exception)

    def test_dto_fields_are_frozen_slots_and_contain_no_invented_facts(self):
        value = history(2, first=boundary(), first_relation="additional")
        result = project_foobar_history(value, mode="individual")
        examples = (
            (value, ("observation_ref", "revision", "track_ref", "source_kind", "total",
                     "first", "last", "events", "coverage", "first_relation")),
            (boundary(), ("label", "order_key", "precision")),
            (event(), ("event_ref", "at")),
            (result, ("version", "status", "reason", "mode", "observation_ref", "revision",
                      "track_ref", "total", "rows")),
            (result.rows[0], ("row_key", "kind", "weight", "anchor", "show_count",
                              "unknown_dates", "interval_start", "interval_end")),
        )
        for item, names in examples:
            with self.subTest(dto=type(item).__name__):
                self.assertTrue(is_dataclass(item))
                self.assertEqual(tuple(field.name for field in fields(item)), names)
                self.assertFalse(hasattr(item, "__dict__"))
                with self.assertRaises(FrozenInstanceError):
                    setattr(item, names[0], getattr(item, names[0]))

    def test_zero_has_no_rows_in_either_mode(self):
        for mode in MODES:
            self.assert_projection(history(), mode, ())

    def test_grouped_is_one_total_at_last_for_one_two_and_large_counts(self):
        first, last = boundary("first", -1000), boundary("last", 1000)
        for total in (1, 2, 31, MAX_KEY):
            # Equal boundaries make N=1 consistent without changing the grouped oracle.
            start = last if total == 1 else first
            value = history(total, first=start, last=last, first_relation="additional")
            self.assert_projection(value, "grouped", (("grouped_aggregate", total, last, ""),))

    def test_grouped_missing_boundaries_are_retained_without_anchor_substitution(self):
        first, last = boundary("first", 0), boundary("last", 1000)
        for start, end in ((first, last), (first, None), (None, last), (None, None)):
            value = history(4, first=start, last=end,
                            first_relation="additional" if start else "not_applicable")
            self.assert_projection(value, "grouped", (("grouped_aggregate", 4, end, ""),))

    def test_individual_confirmed_first_one_and_remainder(self):
        first, last = boundary("first", 0), boundary("last", 1000)
        for total in (2, 31, MAX_KEY):
            value = history(total, first=first, last=last, first_relation="additional")
            self.assert_projection(value, "individual", (
                ("unknown_dates_bucket", total - 1, last, ""),
                ("first_boundary", 1, first, ""),
            ))

    def test_individual_missing_first_is_one_whole_unknown_bucket(self):
        for last in (None, boundary("last", 1000)):
            self.assert_projection(history(4, last=last), "individual", (
                ("unknown_dates_bucket", 4, last, ""),
            ))

    def test_individual_missing_last_does_not_reuse_first_as_bucket_anchor(self):
        first = boundary("first", 1000)
        self.assert_projection(history(2, first=first, first_relation="additional"), "individual", (
            ("first_boundary", 1, first, ""),
            ("unknown_dates_bucket", 1, None, ""),
        ))

    def test_single_count_has_exactly_one_hidden_count_boundary_or_unknown_row(self):
        first, last = boundary("first", 0), boundary("last", 0)
        cases = (
            (first, last, "first_boundary", first),
            (first, None, "first_boundary", first),
            (None, last, "first_boundary", last),
            (None, None, "unknown_dates_bucket", None),
        )
        for start, end, kind, anchor in cases:
            value = history(1, first=start, last=end,
                            first_relation="additional" if start else "not_applicable")
            self.assert_projection(value, "individual", ((kind, 1, anchor, ""),))

    def test_single_count_noncomparable_boundaries_keep_first_and_both_endpoints(self):
        first, last = boundary("first day", 0, "day"), boundary("last second", 1000, "second")
        self.assert_projection(history(1, first=first, last=last, first_relation="additional"),
                               "individual", (("first_boundary", 1, first, ""),))

    def test_equal_boundaries_keep_two_distinct_rows_first_before_bucket(self):
        for precision in ("millisecond", "second", "day", "unknown"):
            first, last = boundary("first", 0, precision), boundary("last", 0, precision)
            self.assert_projection(history(3, first=first, last=last, first_relation="additional"),
                                   "individual", (
                                       ("first_boundary", 1, first, ""),
                                       ("unknown_dates_bucket", 2, last, ""),
                                   ))

    def test_null_keys_are_retained_and_kind_order_resolves_unknown_anchors(self):
        first, last = boundary("first", None, "second"), boundary("last", None, "day")
        self.assert_projection(history(2, first=first, last=last, first_relation="additional"),
                               "individual", (
                                   ("first_boundary", 1, first, ""),
                                   ("unknown_dates_bucket", 1, last, ""),
                               ))

    def test_partial_events_included_do_not_double_count_first(self):
        first, last, exact = boundary("first", 0), boundary("last", 2000), event("e", 1000)
        value = history(3, first=first, last=last, events=(exact,),
                        coverage="within_total", first_relation="included")
        self.assert_projection(value, "individual", (
            ("unknown_dates_bucket", 2, last, ""), ("dated_event", 1, exact.at, "e"),
        ))
        self.assert_projection(value, "grouped", (("grouped_aggregate", 3, last, ""),))

    def test_partial_events_additional_first_consumes_exactly_one_remainder_member(self):
        first, last, exact = boundary("first", 0), boundary("last", 2000), event("e", 1000)
        for total, bucket in ((2, ()), (3, (("unknown_dates_bucket", 1, last, ""),))):
            value = history(total, first=first, last=last, events=(exact,),
                            coverage="within_total", first_relation="additional")
            self.assert_projection(value, "individual", bucket + (
                ("dated_event", 1, exact.at, "e"), ("first_boundary", 1, first, ""),
            ))

    def test_partial_events_without_first_keep_only_events_and_remaining_bucket(self):
        exact = event("e", 0)
        value = history(2, events=(exact,), coverage="within_total")
        self.assert_projection(value, "individual", (
            ("dated_event", 1, exact.at, "e"), ("unknown_dates_bucket", 1, None, ""),
        ))

    def test_unknown_first_overlap_blocks_only_individual_when_remainder_exists(self):
        first, last, exact = boundary("first", 0), boundary("last", 2000), event("e", 1000)
        value = history(3, first=first, last=last, events=(exact,),
                        coverage="within_total", first_relation="unknown")
        self.assert_reconciliation(value, "first_boundary_overlap_unknown", ("individual",))
        self.assert_projection(value, "grouped", (("grouped_aggregate", 3, last, ""),))

    def test_full_event_coverage_membership_matrix_in_both_modes(self):
        first = boundary("boundary annotation", 0)
        for total in (1, 3):
            exact = tuple(event("e" + str(index), 0) for index in range(total))
            for relation in ("included", "unknown", "additional"):
                value = history(total, first=first, last=first, events=exact,
                                coverage="within_total", first_relation=relation)
                with self.subTest(total=total, relation=relation):
                    if relation == "additional":
                        self.assert_reconciliation(value, "first_boundary_exceeds_total")
                    else:
                        self.assert_projection(value, "grouped", (
                            ("grouped_aggregate", total, first, ""),
                        ))
                        self.assert_projection(value, "individual", tuple(
                            ("dated_event", 1, item.at, item.event_ref) for item in exact
                        ))

    def test_full_event_coverage_without_boundaries_has_no_bucket(self):
        exact = event("e", 0)
        self.assert_projection(history(1, events=(exact,), coverage="within_total"),
                               "individual", (("dated_event", 1, exact.at, "e"),))

    def test_same_label_or_timestamp_is_not_membership_evidence(self):
        first = boundary("same label", 0)
        exact = NormalizedEvent("e", first)
        for relation in ("included", "additional", "unknown"):
            value = history(2, first=first, last=first, events=(exact,),
                            coverage="within_total", first_relation=relation)
            if relation == "included":
                expected = (("dated_event", 1, first, "e"),
                            ("unknown_dates_bucket", 1, first, ""))
                self.assert_projection(value, "individual", expected)
            elif relation == "additional":
                expected = (("first_boundary", 1, first, ""), ("dated_event", 1, first, "e"))
                self.assert_projection(value, "individual", expected)
            else:
                self.assert_reconciliation(value, "first_boundary_overlap_unknown", ("individual",))

    def test_same_time_distinct_refs_preserve_multiplicity_and_lexicographic_order(self):
        exact = (event("z", 0), event("a", 0), event("m", 0))
        value = history(3, events=exact, coverage="within_total")
        self.assert_projection(value, "individual", (
            ("dated_event", 1, exact[1].at, "a"),
            ("dated_event", 1, exact[2].at, "m"),
            ("dated_event", 1, exact[0].at, "z"),
        ))

    def test_event_permutations_produce_identical_values_in_both_modes(self):
        first, last = boundary("first", 0), boundary("last", 3000)
        exact = (event("z", 1000), event("a", 1000), event("b", 2000))
        value = history(5, first=first, last=last, events=exact,
                        coverage="within_total", first_relation="additional")
        expected = (
            ("unknown_dates_bucket", 1, last, ""),
            ("dated_event", 1, exact[2].at, "b"),
            ("dated_event", 1, exact[1].at, "a"),
            ("dated_event", 1, exact[0].at, "z"),
            ("first_boundary", 1, first, ""),
        )
        baseline = self.assert_projection(value, "individual", expected)
        grouped = self.assert_projection(value, "grouped", (("grouped_aggregate", 5, last, ""),))
        for ordering in permutations(exact):
            variant = replace(value, events=ordering)
            self.assertEqual(project_foobar_history(variant, mode="individual"), baseline)
            self.assertEqual(project_foobar_history(variant, mode="grouped"), grouped)
        self.assertEqual(value.events, exact)

    def test_equal_anchor_order_is_first_then_events_then_bucket(self):
        first, last = boundary("first", 0), boundary("last", 0)
        exact = (event("z", 0), event("a", 0))
        value = history(4, first=first, last=last, events=exact,
                        coverage="within_total", first_relation="additional")
        self.assert_projection(value, "individual", (
            ("first_boundary", 1, first, ""),
            ("dated_event", 1, exact[1].at, "a"),
            ("dated_event", 1, exact[0].at, "z"),
            ("unknown_dates_bucket", 1, last, ""),
        ))

    def test_known_anchors_precede_null_anchors_even_at_minimum_key(self):
        first, last, exact = boundary("first", None), boundary("last", None), event("e", MIN_KEY)
        value = history(3, first=first, last=last, events=(exact,),
                        coverage="within_total", first_relation="additional")
        self.assert_projection(value, "individual", (
            ("dated_event", 1, exact.at, "e"),
            ("first_boundary", 1, first, ""),
            ("unknown_dates_bucket", 1, last, ""),
        ))

    def test_display_sorting_uses_coarse_and_unknown_nonnull_keys(self):
        for precision in ("day", "unknown"):
            first, last, exact = boundary("first", MAX_KEY, precision), boundary("last", MIN_KEY), event("e", 0)
            value = history(3, first=first, last=last, events=(exact,),
                            coverage="within_total", first_relation="additional")
            self.assert_projection(value, "individual", (
                ("first_boundary", 1, first, ""),
                ("dated_event", 1, exact.at, "e"),
                ("unknown_dates_bucket", 1, last, ""),
            ))

    def test_source_track_revision_and_mode_namespace_keys_without_delimiters(self):
        first = boundary("first", 0)
        exact = event("same:event|ref", 0)
        base = history(3, first=first, last=first, events=(exact,),
                       coverage="within_total", first_relation="additional")
        variants = (
            base,
            replace(base, observation_ref="observation-2"),
            replace(base, revision="revision-2"),
            # A second track in one snapshot, not a canonical remap of this track.
            replace(base, track_ref="track-2"),
            replace(base, observation_ref="a|b", revision="c"),
            replace(base, observation_ref="a", revision="b|c"),
        )
        seen = set()
        for value in variants:
            for mode in MODES:
                expected = (("grouped_aggregate", 3, first, ""),) if mode == "grouped" else (
                    ("first_boundary", 1, first, ""),
                    ("dated_event", 1, exact.at, "same:event|ref"),
                    ("unknown_dates_bucket", 1, first, ""),
                )
                result = self.assert_projection(value, mode, expected)
                keys = {row.row_key for row in result.rows}
                self.assertTrue(seen.isdisjoint(keys))
                seen.update(keys)

    def test_canonical_remap_with_revision_change_does_not_mutate_old_snapshot(self):
        old = history(2, track_ref="unresolved-source-1")
        old_result = project_foobar_history(old, mode="individual")
        old_keys = tuple(row.row_key for row in old_result.rows)
        new = replace(old, revision="revision-2", track_ref="canonical-track-1")
        new_result = project_foobar_history(new, mode="individual")
        self.assertEqual(tuple(row.row_key for row in old_result.rows), old_keys)
        self.assertTrue(set(old_keys).isdisjoint(row.row_key for row in new_result.rows))
        self.assertEqual(old_result.total, new_result.total)
        self.assertEqual(old_result.track_ref, "unresolved-source-1")
        self.assertEqual(new_result.track_ref, "canonical-track-1")
        # Retention/expiry of cursors and enforcement of revision changes belong to the owner.

    def test_exact_event_outside_bounds_is_not_reinterpreted_by_this_projection(self):
        first, last, exact = boundary("first", 0), boundary("last", 1000), event("e", 2000)
        value = history(2, first=first, last=last, events=(exact,),
                        coverage="within_total", first_relation="included")
        self.assert_projection(value, "individual", (
            ("dated_event", 1, exact.at, "e"), ("unknown_dates_bucket", 1, last, ""),
        ))

    def test_reconciliation_precedence_is_shared_before_mode_selection(self):
        early, late = boundary("early", 0), boundary("late", 1000)
        exact = event("e", 0)
        cases = (
            (history(0, first=late, last=early, events=(exact,), coverage="unreconciled",
                     first_relation="additional"), "events_exceed_total"),
            (history(1, first=late, last=early, events=(exact,), coverage="unreconciled",
                     first_relation="additional"), "event_coverage_unknown"),
            (history(1, first=late, last=early, events=(exact,), coverage="within_total",
                     first_relation="additional"), "first_boundary_exceeds_total"),
            (history(0, first=late, last=early, first_relation="additional"), "boundary_order_conflict"),
            (history(1, first=late, last=early, first_relation="additional"), "boundary_order_conflict"),
            (history(0, first=early, last=late, first_relation="additional"), "zero_count_with_boundaries"),
            (history(1, first=early, last=late, first_relation="additional"), "single_count_boundary_conflict"),
        )
        for value, reason in cases:
            self.assert_reconciliation(value, reason)

    def test_zero_with_any_boundary_requires_reconciliation(self):
        for first, last in ((boundary(), None), (None, boundary()), (boundary(), boundary())):
            value = history(0, first=first, last=last,
                            first_relation="additional" if first else "not_applicable")
            self.assert_reconciliation(value, "zero_count_with_boundaries")

    def test_unreconciled_events_are_not_hidden_by_grouped_total(self):
        value = history(10, events=(event(),), coverage="unreconciled")
        self.assert_reconciliation(value, "event_coverage_unknown")

    def test_event_count_exceeds_total_without_silently_dropping_evidence(self):
        exact = (event("a"), event("b"))
        value = history(1, events=exact, coverage="within_total")
        self.assert_reconciliation(value, "events_exceed_total")
        self.assertEqual(value.events, exact)

    def test_safe_comparability_uses_intervals_not_raw_anchor_inequality(self):
        # Literal expectations for N=1; N=2 keeps only a proven reversed-order conflict.
        cases = (
            ("second", 0, "millisecond", 500, None),
            ("millisecond", 500, "second", 0, None),
            ("second", 1000, "millisecond", 999, "boundary_order_conflict"),
            ("millisecond", 999, "second", 1000, "single_count_boundary_conflict"),
            ("second", 0, "second", 0, None),
            ("millisecond", 1, "millisecond", 1, None),
            ("second", 0, "second", 1000, "single_count_boundary_conflict"),
            ("second", 1000, "second", 0, "boundary_order_conflict"),
            ("millisecond", 0, "millisecond", 1, "single_count_boundary_conflict"),
            ("millisecond", 1, "millisecond", 0, "boundary_order_conflict"),
            ("second", -1000, "millisecond", -1, None),
            ("millisecond", -1, "second", -1000, None),
            ("second", -1000, "millisecond", -1001, "boundary_order_conflict"),
            ("millisecond", -1001, "second", -1000, "single_count_boundary_conflict"),
            ("second", MAX_SECOND, "millisecond", MAX_KEY, None),
            ("millisecond", MAX_KEY, "second", MAX_SECOND, None),
            ("second", MIN_SECOND, "millisecond", MIN_KEY, "boundary_order_conflict"),
            ("millisecond", MIN_KEY, "second", MIN_SECOND, "single_count_boundary_conflict"),
            ("millisecond", MIN_KEY, "millisecond", MAX_KEY, "single_count_boundary_conflict"),
            ("millisecond", MAX_KEY, "millisecond", MIN_KEY, "boundary_order_conflict"),
        )
        for fp, fk, lp, lk, single_reason in cases:
            for total in (1, 2):
                first, last = boundary("first", fk, fp), boundary("last", lk, lp)
                value = history(total, first=first, last=last, first_relation="additional")
                reason = single_reason
                if total == 2 and reason == "single_count_boundary_conflict":
                    reason = None
                with self.subTest(first=(fp, fk), last=(lp, lk), total=total):
                    if reason:
                        self.assert_reconciliation(value, reason)
                    else:
                        self.assert_projection(value, "grouped", (("grouped_aggregate", total, last, ""),))
                        expected = (("first_boundary", 1, first, ""),)
                        if total == 2:
                            bucket = ("unknown_dates_bucket", 1, last, "")
                            expected = (bucket,) + expected if lk > fk else expected + (bucket,)
                        self.assert_projection(value, "individual", expected)

    def test_coarse_unknown_or_null_boundaries_never_imply_semantic_conflict(self):
        cases = (
            ("day", 0, "second", 43200000),
            ("second", 43200000, "day", 0),
            ("day", MAX_KEY, "millisecond", MIN_KEY),
            ("millisecond", MAX_KEY, "day", MIN_KEY),
            ("day", MAX_KEY, "day", MIN_KEY),
            ("unknown", MAX_KEY, "millisecond", MIN_KEY),
            ("second", MAX_SECOND, "unknown", MIN_KEY),
            ("unknown", MAX_KEY, "unknown", MIN_KEY),
            ("second", None, "millisecond", MIN_KEY),
            ("millisecond", MAX_KEY, "second", None),
        )
        for fp, fk, lp, lk in cases:
            first, last = boundary("first", fk, fp), boundary("last", lk, lp)
            value = history(1, first=first, last=last, first_relation="additional")
            with self.subTest(first=(fp, fk), last=(lp, lk)):
                self.assert_projection(value, "grouped", (("grouped_aggregate", 1, last, ""),))
                self.assert_projection(value, "individual", (("first_boundary", 1, first, ""),))

    def test_labels_and_precision_are_preserved_without_timestamp_parsing(self):
        first = boundary("not an export date; synthetic \u2603", None, "unknown")
        last = boundary("opaque day label", 5000, "day")
        value = history(2, first=first, last=last, first_relation="additional")
        self.assert_projection(value, "individual", (
            ("unknown_dates_bucket", 1, last, ""), ("first_boundary", 1, first, ""),
        ))

    def test_second_alignment_is_required_for_boundaries_and_events(self):
        for key in (1, -1, 999, -999, MIN_KEY, MAX_KEY):
            bad = boundary("misaligned", key, "second")
            for value in (
                history(1, first=bad, first_relation="additional"),
                history(1, last=bad),
                history(1, events=(NormalizedEvent("e", bad),), coverage="within_total"),
            ):
                for mode in MODES:
                    self.assert_invalid(value, mode)

    def test_event_precision_requires_exact_nonnull_second_or_millisecond(self):
        for precision, key in (("day", 0), ("unknown", 0), ("millisecond", None), ("second", None)):
            value = history(1, events=(NormalizedEvent("e", boundary("bad event", key, precision)),),
                            coverage="within_total")
            self.assert_invalid(value)

    def test_aligned_second_event_extrema_and_millisecond_extrema_are_accepted(self):
        exact = (event("a", MIN_KEY), event("b", MIN_SECOND, "second"),
                 event("c", MAX_SECOND, "second"), event("d", MAX_KEY))
        self.assert_projection(history(4, events=exact, coverage="within_total"), "individual", (
            ("dated_event", 1, exact[3].at, "d"),
            ("dated_event", 1, exact[2].at, "c"),
            ("dated_event", 1, exact[1].at, "b"),
            ("dated_event", 1, exact[0].at, "a"),
        ))

    def test_exact_10000_event_bound_is_preserved_without_truncation(self):
        exact = tuple(event("event-" + str(index).zfill(5), index) for index in range(10000))
        value = history(10000, events=exact, coverage="within_total")
        expected = tuple(("dated_event", 1, item.at, item.event_ref) for item in reversed(exact))
        self.assert_projection(value, "individual", expected)
        self.assert_projection(value, "grouped", (("grouped_aggregate", 10000, None, ""),))

    def test_10001_events_are_structurally_rejected_in_both_modes(self):
        exact = tuple(event("event-" + str(index), index) for index in range(10001))
        value = history(10001, events=exact, coverage="within_total")
        for mode in MODES:
            self.assert_invalid(value, mode)

    def test_duplicate_event_refs_are_invalid_even_at_different_timestamps(self):
        for second_key in (0, 1000):
            value = history(2, events=(event("duplicate", 0), event("duplicate", second_key)),
                            coverage="within_total")
            for mode in MODES:
                self.assert_invalid(value, mode)

    def test_source_kind_rejects_lastfm_inapp_mixed_and_unproven_enhanced_origin(self):
        for origin in ("lastfm", "in_app", "foobar+lastfm", "play_count_enhanced", "", None,
                       StringChild("foobar_local"), Poison()):
            for mode in MODES:
                self.assert_invalid(history(1, source_kind=origin), mode)
        # A distinct local stream must have a distinct observation_ref (caller invariant).
        first = project_foobar_history(history(1, observation_ref="local-stream-a"), mode="grouped")
        second = project_foobar_history(history(1, observation_ref="local-stream-b"), mode="grouped")
        self.assertNotEqual(first.rows[0].row_key, second.rows[0].row_key)
        self.assertEqual((first.total, second.total), (1, 1))

    def test_history_total_is_exact_nonnegative_signed_64_bit_integer(self):
        for total in (-1, MAX_KEY + 1, True, False, 1.0, "1", None, IntChild(1), Poison()):
            for mode in MODES:
                self.assert_invalid(history(total), mode)

    def test_order_key_is_exact_signed_64_bit_or_none(self):
        for key in (MIN_KEY - 1, MAX_KEY + 1, True, False, 1.0, "1", IntChild(1), Poison()):
            for field in ("first", "last"):
                value = history(1, **{field: boundary("invalid key", key)},
                                first_relation="additional" if field == "first" else "not_applicable")
                self.assert_invalid(value)

    def test_reference_and_label_utf8_bounds_are_bytes_not_characters(self):
        for text in ("x" * 128, "\u00e9" * 64, "\U0001f3b5" * 32):
            first = boundary(text, 0)
            exact = NormalizedEvent(text, first)
            value = history(1, first=first, last=first, events=(exact,), coverage="within_total",
                            first_relation="included", observation_ref=text, revision=text, track_ref=text)
            self.assert_projection(value, "individual", (("dated_event", 1, first, text),))
        bad_values = ("", "x" * 129, "\u00e9" * 65, "\U0001f3b5" * 33, "x" * 100000,
                      "\ud800", "prefix\udfff", b"bytes", None, StringChild("valid"), Poison())
        for text in bad_values:
            for name in ("observation_ref", "revision", "track_ref"):
                self.assert_invalid(replace(history(1), **{name: text}))
            self.assert_invalid(history(1, first=boundary(text), first_relation="additional"))
            self.assert_invalid(history(1, events=(NormalizedEvent(text, boundary()),), coverage="within_total"))

    def test_nonempty_references_and_labels_are_not_stripped_or_reparsed(self):
        text = " synthetic | : \t \x00 "
        first = boundary(text, None, "unknown")
        value = history(1, first=first, first_relation="additional",
                        observation_ref=text, revision=text, track_ref=text)
        self.assert_projection(value, "individual", (("first_boundary", 1, first, ""),))
        self.assert_projection(history(1, observation_ref=" ", revision=" ", track_ref=" "),
                               "grouped", (("grouped_aggregate", 1, None, ""),))

    def test_precision_coverage_relation_and_mode_use_strict_enumerations(self):
        for precision in ("minute", "", None, StringChild("day"), Poison()):
            self.assert_invalid(history(1, last=boundary("last", 0, precision)))
        for coverage in ("all", "", None, StringChild("none"), Poison()):
            self.assert_invalid(history(coverage=coverage))
        for relation in ("same_date", "", None, StringChild("not_applicable"), Poison()):
            self.assert_invalid(history(first_relation=relation))
        for mode in ("all", "", None, 1, StringChild("grouped"), Poison()):
            self.assert_invalid(history(), mode)

    def test_events_container_and_nested_records_require_exact_types(self):
        for events in ([], [event()], TupleChild((event(),)), iter((event(),)), None, Poison()):
            self.assert_invalid(history(1, events=events, coverage="within_total"))
        for value in (None, {}, Poison(), child_of(history())):
            self.assert_invalid(value)
        for first in ({}, Poison(), child_of(boundary())):
            self.assert_invalid(history(1, first=first, first_relation="additional"))
        for last in ({}, Poison(), child_of(boundary())):
            self.assert_invalid(history(1, last=last))
        for item in ({}, None, Poison(), child_of(event())):
            self.assert_invalid(history(1, events=(item,), coverage="within_total"))
        for at in ({}, None, Poison(), child_of(boundary())):
            self.assert_invalid(history(1, events=(NormalizedEvent("e", at),), coverage="within_total"))

    def test_coverage_and_first_relation_cross_field_shape_is_validated(self):
        first, exact = boundary(), event()
        invalid = (
            history(1, coverage="within_total"),
            history(1, coverage="unreconciled"),
            history(1, events=(exact,), coverage="none"),
            history(1, first_relation="additional"),
            history(1, first_relation="included"),
            history(1, first_relation="unknown"),
            history(1, first=first, first_relation="not_applicable"),
            history(1, first=first, first_relation="included"),
            history(1, first=first, first_relation="unknown"),
            history(2, events=(exact,), coverage="within_total", first_relation="included"),
            history(2, events=(exact,), coverage="within_total", first_relation="additional"),
            history(2, events=(exact,), coverage="within_total", first_relation="unknown"),
            history(2, first=first, events=(exact,), coverage="within_total", first_relation="not_applicable"),
        )
        for value in invalid:
            for mode in MODES:
                self.assert_invalid(value, mode)

    def test_structural_invalidity_precedes_semantic_reconciliation(self):
        value = history(0, first=boundary("first", 1000), last=boundary("last", 0),
                        events=(event(),), coverage="unreconciled", first_relation="additional",
                        source_kind="lastfm")
        for mode in MODES:
            self.assert_invalid(value, mode)
        duplicate = history(0, events=(event("duplicate"), event("duplicate")), coverage="unreconciled")
        self.assert_invalid(duplicate)

    def test_invalid_input_error_message_is_fixed_and_does_not_echo_source_text(self):
        sentinel = "SYNTHETIC-PRIVATE-MARKER"
        cases = (
            None,
            history(-1, observation_ref=sentinel),
            history(1, source_kind=sentinel),
            history(1, track_ref=sentinel * 20),
            history(1, last=boundary(sentinel, MAX_KEY + 1)),
            history(1, events=(event(sentinel), event(sentinel)), coverage="within_total"),
        )
        messages = {self.assert_invalid(value, mode) for value in cases for mode in MODES}
        self.assertEqual(len(messages), 1)
        self.assertNotIn(sentinel, next(iter(messages)))

    def test_ordinary_python_argument_errors_remain_type_errors(self):
        value = history()
        calls = (
            lambda: project_foobar_history(),
            lambda: project_foobar_history(value),
            lambda: project_foobar_history(value, "grouped"),
            lambda: project_foobar_history(value, mode="grouped", extra=True),
            lambda: project_foobar_history(value, value, mode="grouped"),
        )
        for call in calls:
            with self.assertRaises(TypeError):
                call()
