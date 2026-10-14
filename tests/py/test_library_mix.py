"""Pure Library Mix contract tests; no database, app bootstrap, or provider I/O."""
from dataclasses import FrozenInstanceError, replace
from datetime import datetime, timezone
import unittest

from music_app.services import library_mix as mix
from music_app.services import popularity_snapshots as popularity


NOW = datetime(2026, 10, 13, tzinfo=timezone.utc)


def candidate(track_id=1, *, track_changes=None, **changes):
    track = popularity.LocalTrackEvidence(**({
        "track_id": track_id, "mapping_revision": "mapping:v1", "provider": "lastfm",
        "source_entity_id": f"lastfm:{track_id}",
        "canonical_recording_id": f"recording:{track_id}", "recording_evidence": "verified",
        "canonical_artist_id": "recording-artist:shared", "artist_evidence": "verified",
    } | (track_changes or {})))
    return mix.LibraryMixCandidate(**({
        "track": track, "album_ref": "album:one", "primary_artist_ref": "artist:one",
        "album_position": 0, "disc_number": 1, "track_number": track_id,
    } | changes))


def snapshot(item, count=10, **changes):
    observation = popularity.PopularityObservation(**({
        "provider": "lastfm", "metric": "overall_scrobbles",
        "source_entity_id": item.track.source_entity_id, "source_revision": "provider:v1",
        "observed_at": NOW, "imported_at": NOW, "count": count,
        "attribution_state": "resolved",
    } | changes))
    return popularity.CachedPopularity(item.track.track_id, item.track.mapping_revision, observation)


def recipe(**changes):
    return mix.normalize_library_mix_recipe({
        "selection_basis": "per_artist", "songs_per_group": 2, "auto_update": False,
    } | changes)


def build(items, snapshots, selected_recipe=None, **callbacks):
    return mix.build_library_mix(items, selected_recipe or recipe(), **({
        "is_local_readable": lambda item: True,
        "read_snapshot": lambda item: snapshots.get(item.track.track_id),
    } | callbacks))


def ids(result):
    return tuple(item.track.track_id for item in result.tracks)


def forbidden(*args):
    raise AssertionError("Disallowed metadata, iteration, or callback was observed")


class NeverIterate:
    def __iter__(self):
        forbidden()


class RecipeTests(unittest.TestCase):
    def test_valid_recipe_boundaries_and_exact_payload(self):
        for basis in ("per_artist", "per_album"):
            for count in (1, 5000):
                for dynamic in (False, True):
                    with self.subTest(basis=basis, count=count, dynamic=dynamic):
                        value = {"selection_basis": basis, "songs_per_group": count,
                                 "auto_update": dynamic}
                        normalized = mix.normalize_library_mix_recipe(value)
                        self.assertEqual(normalized.as_dict(), value | {"playback_order": "regular"})
                        self.assertEqual(mix.recipe_payload(normalized), {
                            "version": 1, "source": "whole_library", "provider": "lastfm",
                            "metric": "overall_scrobbles", **value, "playback_order": "regular",
                        })

    def test_extra_missing_and_nonobject_recipe_reject(self):
        good = recipe().as_dict()
        invalid = [None, [], (), "per_artist", True]
        invalid += [{key: value for key, value in good.items() if key != removed}
                    for removed in ("selection_basis", "songs_per_group", "auto_update")]
        invalid += [good | {key: value} for key, value in (
            ("source", "whole_library"), ("provider", "lastfm"), ("version", 1),
            ("metric", "overall_scrobbles"), ("songs_per_album", 2),
            ("artist_ids", ["artist:one"]), ("genre", "rock"),
        )]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                mix.normalize_library_mix_recipe(value)

    def test_recipe_fields_are_strict_and_not_coerced(self):
        values = {
            "selection_basis": [None, 1, True, [], {}, "artist", "Per_Artist", "per_album "],
            "songs_per_group": [None, True, False, 0, -1, 5001, 1.0, "2", [], {}],
            "auto_update": [None, 0, 1, "true", "false", [], {}],
            "playback_order": [None, True, 1, [], {}, "", "random", "unplayed", "Regular", "regular "],
        }
        for field, options in values.items():
            for value in options:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    recipe(**{field: value})

    def test_forged_or_unnormalized_recipe_rejects_before_source_observation(self):
        invalid = [recipe().as_dict(), None, object(),
                   mix.LibraryMixRecipe("per_artist", True, False),
                   mix.LibraryMixRecipe("per_artist", 1, 1),
                   mix.LibraryMixRecipe("invalid", 1, False),
                   mix.LibraryMixRecipe("per_artist", 1, False, "random")]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    mix.recipe_payload(value)
                with self.assertRaises(ValueError):
                    mix.build_library_mix(NeverIterate(), value,
                                          is_local_readable=forbidden, read_snapshot=forbidden)

    def test_recipe_and_candidate_are_frozen_and_payload_is_detached(self):
        value = recipe()
        with self.assertRaises(FrozenInstanceError):
            value.auto_update = True
        item = candidate()
        with self.assertRaises(FrozenInstanceError):
            item.album_ref = "album:other"
        payload = mix.recipe_payload(value)
        payload["songs_per_group"] = 999
        self.assertEqual(value.songs_per_group, 2)
        self.assertEqual(value.as_dict()["songs_per_group"], 2)


    def test_omitted_playback_order_and_legacy_constructor_default_to_regular(self):
        values = {"selection_basis": "per_album", "songs_per_group": 3, "auto_update": False}
        normalized = mix.normalize_library_mix_recipe(values)
        legacy_constructor = mix.LibraryMixRecipe("per_album", 3, False)
        self.assertEqual(normalized, legacy_constructor)
        self.assertEqual(normalized.playback_order, "regular")
        self.assertEqual(mix.recipe_payload(normalized)["playback_order"], "regular")
        self.assertEqual(values, {"selection_basis": "per_album", "songs_per_group": 3, "auto_update": False})

    def test_each_explicit_playback_order_roundtrips_in_variable_and_fixed_payloads(self):
        for mode in ("regular", "shuffle", "unplayed_first"):
            with self.subTest(mode=mode):
                value = recipe(playback_order=mode)
                expected = {"selection_basis": "per_artist", "songs_per_group": 2,
                            "auto_update": False, "playback_order": mode}
                self.assertEqual(value.as_dict(), expected)
                self.assertEqual(mix.recipe_payload(value), {
                    "version": 1, "source": "whole_library", "provider": "lastfm",
                    "metric": "overall_scrobbles", **expected,
                })
                self.assertEqual(mix.normalize_library_mix_recipe(value.as_dict()), value)

    def test_playback_order_is_an_immutable_saved_default(self):
        value = recipe(playback_order="shuffle")
        with self.assertRaises(FrozenInstanceError):
            value.playback_order = "regular"
        payload = mix.recipe_payload(value)
        payload["playback_order"] = "unplayed_first"
        self.assertEqual(value.playback_order, "shuffle")


class LibraryMixSelectionTests(unittest.TestCase):
    def test_per_artist_and_per_album_use_authoritative_group_refs(self):
        a = candidate(1, album_ref="album:a", primary_artist_ref="artist:primary", album_position=0)
        b = candidate(2, album_ref="album:b", primary_artist_ref="artist:primary", album_position=1)
        c = candidate(3, album_ref="album:b", primary_artist_ref="artist:other", album_position=1)
        items = [a, b, c]
        snapshots = {1: snapshot(a, 10), 2: snapshot(b, 30), 3: snapshot(c, 20)}
        self.assertEqual(ids(build(items, snapshots, recipe(songs_per_group=1))), (2, 3))
        self.assertEqual(ids(build(items, snapshots, recipe(selection_basis="per_album", songs_per_group=1))), (2, 1))
        # All canonical recording artists are identical: quota refs remain authoritative.
        self.assertEqual({item.track.canonical_artist_id for item in items}, {"recording-artist:shared"})

    def test_global_popularity_precedes_source_order_and_small_groups_stay_short(self):
        items = [candidate(1), candidate(2), candidate(3, primary_artist_ref="artist:short")]
        result = build(items, {1: snapshot(items[0], 0), 2: snapshot(items[1], 50),
                               3: snapshot(items[2], 10)}, recipe(songs_per_group=3))
        self.assertEqual(ids(result), (2, 3, 1))
        self.assertEqual(result.total, 3)
        self.assertEqual(result.diagnostics, ())

    def test_zero_unknown_ambiguous_and_mapping_mismatch_remain_distinct(self):
        items = [candidate(i, primary_artist_ref=f"artist:{i}") for i in range(1, 7)]
        snapshots = {
            1: snapshot(items[0], 0),
            3: snapshot(items[2], None, attribution_state="missing"),
            4: snapshot(items[3], 900, attribution_state="ambiguous"),
            5: replace(snapshot(items[4]), mapping_revision="mapping:stale"),
            6: replace(snapshot(items[5]), local_track_id=900),
        }
        result = build(list(reversed(items)), snapshots)
        self.assertEqual(ids(result), (1,))
        self.assertEqual(result.total, 1)
        self.assertEqual(result.diagnostics, (
            (2, "missing_global_metric"), (3, "missing_global_metric"),
            (4, "ambiguous_attribution"), (5, "mapping_mismatch"), (6, "mapping_mismatch"),
        ))

    def test_missing_selected_group_is_diagnostic_but_unused_group_may_be_missing(self):
        item = candidate(primary_artist_ref=None)
        result = build([item], {1: snapshot(item)})
        self.assertEqual(ids(result), ())
        self.assertEqual(result.diagnostics, ((1, "missing_group_identity"),))
        self.assertEqual(ids(build([item], {1: snapshot(item)}, recipe(selection_basis="per_album"))), (1,))
        item = candidate(album_ref=None)
        self.assertEqual(ids(build([item], {1: snapshot(item)})), (1,))
        result = build([item], {1: snapshot(item)}, recipe(selection_basis="per_album"))
        self.assertEqual(result.diagnostics, ((1, "missing_group_identity"),))

    def test_missing_group_copy_keeps_its_diagnostic_when_duplicate_is_eligible(self):
        missing = candidate(1, primary_artist_ref=None)
        valid = candidate(2, track_changes={"canonical_recording_id": missing.track.canonical_recording_id})
        result = build([missing, valid], {1: snapshot(missing), 2: snapshot(valid)})
        self.assertEqual(ids(result), (2,))
        self.assertEqual(result.total, 1)
        self.assertEqual(result.diagnostics, ((1, "missing_group_identity"),))

    def test_source_album_disc_track_order_and_unknown_positions_are_stable(self):
        items = [
            candidate(11, album_position=2, disc_number=1, track_number=1),
            candidate(12, album_position=0, disc_number=None, track_number=1),
            candidate(13, album_position=0, disc_number=1, track_number=None),
            candidate(14, album_position=0, disc_number=1, track_number=2),
            candidate(15, album_position=0, disc_number=1, track_number=1),
            candidate(16, album_position=0, disc_number=2, track_number=1),
            candidate(17, album_position=0, disc_number=1, track_number=1),
        ]
        snapshots = {item.track.track_id: snapshot(item) for item in items}
        expected = (15, 17, 14, 13, 16, 12, 11)
        for ordering in (items, list(reversed(items)), items[3:] + items[:3]):
            with self.subTest(order=[item.track.track_id for item in ordering]):
                self.assertEqual(ids(build(ordering, snapshots, recipe(songs_per_group=20))), expected)

    def test_earliest_source_copy_wins_over_id_and_richer_canonical_evidence(self):
        early = candidate(20, album_position=0, track_changes={
            "source_entity_id": "lastfm:shared", "canonical_recording_id": None,
            "recording_evidence": None, "canonical_artist_id": None, "artist_evidence": None,
        })
        late = candidate(1, album_position=1, track_changes={"source_entity_id": "lastfm:shared"})
        result = build([late, early], {1: snapshot(late), 20: snapshot(early)})
        self.assertEqual(ids(result), (20,))
        self.assertIs(result.tracks[0], early)
        self.assertIsNone(early.track.canonical_recording_id)

    def test_canonical_deduplication_happens_before_group_quota(self):
        first = candidate(1, album_ref="album:a", album_position=0)
        copy = candidate(2, album_ref="album:b", album_position=1,
                         track_changes={"canonical_recording_id": first.track.canonical_recording_id})
        additional = candidate(3, album_ref="album:a", album_position=0)
        other = candidate(4, album_ref="album:b", album_position=1)
        items = [copy, other, additional, first]
        snapshots = {1: snapshot(first, 100), 2: snapshot(copy, 100),
                     3: snapshot(additional, 90), 4: snapshot(other, 80)}
        result = build(items, snapshots, recipe(selection_basis="per_album", songs_per_group=2))
        self.assertEqual(ids(result), (1, 3, 4))
        self.assertEqual(result.total, 3)

    def test_duplicate_counts_are_never_added(self):
        a = candidate(1)
        duplicate = candidate(2, track_changes={"canonical_recording_id": a.track.canonical_recording_id})
        b = candidate(3)
        result = build([a, duplicate, b], {1: snapshot(a, 20), 2: snapshot(duplicate, 20), 3: snapshot(b, 30)})
        self.assertEqual(ids(result), (3, 1))

    def test_shared_provider_identity_with_conflicting_evidence_is_ambiguous(self):
        a = candidate(1, track_changes={"source_entity_id": "lastfm:shared"})
        b = candidate(2, track_changes={"source_entity_id": "lastfm:shared"})
        result = build([a, b], {1: snapshot(a), 2: snapshot(b)})
        self.assertEqual(ids(result), ())
        self.assertEqual(result.diagnostics, ((1, "ambiguous_attribution"), (2, "ambiguous_attribution")))

    def test_denied_objects_never_reach_validation_provider_or_diagnostics(self):
        denied = object()
        malformed = candidate(2, album_ref=[], track_changes={"mapping_revision": ""})
        allowed = candidate(3)
        calls = []

        def admit(item):
            calls.append(("admit", id(item)))
            return item is allowed

        def read(item):
            self.assertIs(item, allowed)
            self.assertIn(("admit", id(item)), calls)
            calls.append(("read", id(item)))
            return snapshot(item, 0)

        result = build([denied, malformed, allowed], {}, is_local_readable=admit, read_snapshot=read)
        self.assertEqual(ids(result), (3,))
        self.assertEqual(result.diagnostics, ())
        self.assertEqual(sum(call[0] == "read" for call in calls), 1)

    def test_policy_failure_propagates_without_fabricating_result(self):
        error = PermissionError("current actor was revoked")

        def revoked(item):
            raise error

        with self.assertRaises(PermissionError) as raised:
            build([candidate()], {}, is_local_readable=revoked, read_snapshot=forbidden)
        self.assertIs(raised.exception, error)

    def test_snapshot_failure_propagates_without_fabricating_zero_or_partial_result(self):
        first, second = candidate(1), candidate(2)
        error = RuntimeError("snapshot read failed")

        def read(item):
            if item is second:
                raise error
            return snapshot(item)

        with self.assertRaises(RuntimeError) as raised:
            build([first, second], {}, read_snapshot=read)
        self.assertIs(raised.exception, error)

    def test_malformed_admitted_candidate_rejects_before_provider_read(self):
        variants = [object(), replace(candidate(), track={})]
        for field, values in {
            "album_ref": ["", " ", 0, True, [], {}],
            "primary_artist_ref": ["", " ", 0, True, [], {}],
            "album_position": [-1, True, 0.0, None, "1"],
            "disc_number": [0, -1, True, 1.0, "1"],
            "track_number": [0, -1, True, 1.0, "1"],
        }.items():
            variants.extend(replace(candidate(), **{field: value}) for value in values)
        for item in variants:
            with self.subTest(item=item), self.assertRaises(ValueError):
                build([item], {}, read_snapshot=forbidden)

    def test_invalid_local_evidence_rejects_before_provider_read(self):
        for changes in ({"track_id": 0}, {"track_id": True}, {"mapping_revision": ""},
                        {"source_entity_id": None}, {"recording_evidence": None},
                        {"canonical_artist_id": None}, {"provider": ""}):
            item = candidate(track_changes=changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                build([item], {}, read_snapshot=forbidden)

    def test_unhashable_local_identity_is_a_normalized_validation_error(self):
        for invalid_id in ([], {}):
            item = candidate(track_changes={"track_id": invalid_id})
            with self.subTest(invalid_id=invalid_id), self.assertRaises(ValueError):
                build([item], {}, read_snapshot=forbidden)

    def test_conflicting_duplicate_local_id_rejects_before_provider_reads(self):
        original = candidate()
        for changed in (replace(original, album_ref="album:changed"),
                        replace(original, album_position=4),
                        replace(original, track=replace(original.track, mapping_revision="mapping:v2"))):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                build([original, changed], {}, read_snapshot=forbidden)

    def test_identical_duplicate_local_id_reads_snapshot_once(self):
        item = candidate()
        calls = []

        def read(row):
            calls.append(row)
            return snapshot(row)

        result = build([item, replace(item), item], {}, read_snapshot=read)
        self.assertEqual(ids(result), (1,))
        self.assertEqual(calls, [item])
        self.assertEqual(result.diagnostics, ())

    def test_wrong_metric_provider_or_malformed_counts_never_become_fallbacks(self):
        item = candidate()
        changes = [{"metric": value} for value in ("listeners", "weekly_scrobbles", "personal_play_count")]
        changes += [{"provider": "spotify"}, {"count": True}, {"count": -1},
                    {"count": 1.5}, {"count": "99"}, {"count": 2**53}, {"count": None}]
        for update in changes:
            with self.subTest(update=update), self.assertRaises(ValueError):
                build([item], {1: snapshot(item, **update)})
        with self.assertRaises(ValueError):
            build([item], {1: {"playcount": "1000", "userplaycount": "9000"}})

    def test_empty_and_all_unknown_inputs_are_explicit_empty_results(self):
        result = build([], {})
        self.assertEqual((result.tracks, result.total, result.diagnostics), ((), 0, ()))
        result = build([candidate(1), candidate(2)], {})
        self.assertEqual((result.tracks, result.total), ((), 0))
        self.assertEqual(result.diagnostics, ((1, "missing_global_metric"), (2, "missing_global_metric")))

    def test_exact_5000_selected_tracks_are_allowed(self):
        items = [candidate(i, primary_artist_ref=f"artist:{i}") for i in range(1, 5001)]
        result = build(items, {}, recipe(songs_per_group=1), read_snapshot=lambda item: snapshot(item, 0))
        self.assertEqual(result.total, 5000)
        self.assertEqual(len(result.tracks), 5000)
        self.assertEqual(ids(result), tuple(range(1, 5001)))

    def test_5001_selected_tracks_reject_instead_of_silently_truncating(self):
        items = (candidate(i, primary_artist_ref=f"artist:{i}") for i in range(1, 5002))
        with self.assertRaises(mix.LibraryMixTooLarge):
            build(items, {}, recipe(songs_per_group=1), read_snapshot=lambda item: snapshot(item))

    def test_capacity_applies_after_quota_not_to_raw_library_size(self):
        items = (candidate(i) for i in range(1, 5002))
        result = build(items, {}, recipe(songs_per_group=1), read_snapshot=lambda item: snapshot(item))
        self.assertEqual(ids(result), (1,))
        self.assertEqual(result.total, 1)

    def test_dynamic_build_recomputes_current_membership_and_order_without_append(self):
        a, b, c = candidate(1), candidate(2), candidate(3)
        dynamic = recipe(songs_per_group=1, auto_update=True)
        first = build([a, b], {1: snapshot(a, 100), 2: snapshot(b, 10)}, dynamic)
        second = build([a, b, c], {1: snapshot(a, 1), 2: snapshot(b, 50), 3: snapshot(c, 80)}, dynamic)
        third = build([a, b], {1: snapshot(a, 0), 2: snapshot(b, 50)}, dynamic,
                      is_local_readable=lambda item: item is a)
        self.assertEqual((ids(first), ids(second), ids(third)), ((1,), (3,), (1,)))
        self.assertEqual((first.total, second.total, third.total), (1, 1, 1))
        self.assertEqual(first.recipe, dynamic)
        self.assertEqual(first.tracks, (a,))


    def test_playback_modes_do_not_change_global_selection_rank_or_diagnostics(self):
        items = [candidate(i) for i in (1, 2, 3, 4)]
        snapshots = {1: snapshot(items[0], 0), 2: snapshot(items[1], 30), 3: snapshot(items[2], 20)}
        results = []
        for mode in ("regular", "shuffle", "unplayed_first"):
            result = build(items, snapshots, recipe(songs_per_group=2, playback_order=mode))
            self.assertEqual(result.recipe.playback_order, mode)
            results.append((ids(result), result.total, result.diagnostics))
        self.assertEqual(results, [((2, 3), 2, ((4, "missing_global_metric"),))] * 3)

    def test_auto_update_flag_does_not_change_current_snapshot_selection(self):
        items = [candidate(1), candidate(2), candidate(3)]
        snapshots = {1: snapshot(items[0], 0), 2: snapshot(items[1], 30), 3: snapshot(items[2], 20)}
        fixed = build(items, snapshots, recipe(auto_update=False, playback_order="unplayed_first"))
        dynamic = build(items, snapshots, recipe(auto_update=True, playback_order="unplayed_first"))
        self.assertEqual((fixed.tracks, fixed.total, fixed.diagnostics),
                         (dynamic.tracks, dynamic.total, dynamic.diagnostics))
        self.assertFalse(fixed.recipe.auto_update)
        self.assertTrue(dynamic.recipe.auto_update)


if __name__ == "__main__":
    unittest.main()
