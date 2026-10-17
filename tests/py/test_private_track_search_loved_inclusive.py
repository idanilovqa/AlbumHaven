"""Pure query contracts for inclusive Loved search, using real service imports.

These cases exercise already-loaded sources; they do not prove route authorization,
database scoping, or application startup. No configuration or import substitution.
"""
from types import SimpleNamespace
import unittest

from music_app.services.private_track_search import filter_private_track_sources
from music_app.services.track_preferences import (
    track_preference_matches_favorite_song_projection,
)


def tracks(source_type=dict):
    return [
        source_type(title="Ordinary", genre=["Rock"],
                    track_preference_overlay={"love_tier": "off"}),
        source_type(title="Beloved", genre=["Rock"],
                    track_preference_overlay={"love_tier": "loved"}),
        source_type(title="Repeat", genre=["Rock"],
                    track_preference_overlay={"love_tier": "obsessed"}),
        source_type(title="Other", genre=["Jazz"],
                    track_preference_overlay={"love_tier": "obsessed"}),
    ]


class InclusiveLovedSearchTests(unittest.TestCase):
    def test_off_matches_only_off_within_surface_membership(self):
        for source_type in (dict, SimpleNamespace):
            rows = tracks(source_type)
            for surface, expected in (("playlist_detail", rows[:1]), ("favorite_songs", [])):
                with self.subTest(source_type=source_type, surface=surface):
                    result = filter_private_track_sources(
                        rows, query="love:off", surface=surface, authorized_private=True,
                    )
                    self.assertEqual(result["matched_sources"], expected)
                    self.assertEqual(result["unsupported_filters"], [])

    def test_negated_off_matches_both_positive_tiers(self):
        for source_type in (dict, SimpleNamespace):
            rows = tracks(source_type)
            for surface in ("playlist_detail", "favorite_songs"):
                with self.subTest(source_type=source_type, surface=surface):
                    result = filter_private_track_sources(
                        rows, query="-love:off", surface=surface, authorized_private=True,
                    )
                    self.assertEqual(result["matched_sources"], rows[1:])
                    self.assertEqual(result["unsupported_filters"], [])

    def test_loved_matches_loved_and_obsessed_but_not_off(self):
        for source_type in (dict, SimpleNamespace):
            rows = tracks(source_type)
            for surface in ("playlist_detail", "favorite_songs"):
                for query in (":loved", "love:loved"):
                    with self.subTest(source_type=source_type, surface=surface, query=query):
                        result = filter_private_track_sources(
                            rows, query=query, surface=surface, authorized_private=True,
                        )
                        self.assertEqual(result["matched_sources"], rows[1:])
                        self.assertEqual(result["unsupported_filters"], [])

    def test_obsessed_matches_only_obsessed(self):
        for source_type in (dict, SimpleNamespace):
            rows = tracks(source_type)
            for surface in ("playlist_detail", "favorite_songs"):
                for query in (":obsessed", "love:obsessed"):
                    with self.subTest(source_type=source_type, surface=surface, query=query):
                        result = filter_private_track_sources(
                            rows, query=query, surface=surface, authorized_private=True,
                        )
                        self.assertEqual(result["matched_sources"], rows[2:])
                        self.assertEqual(result["unsupported_filters"], [])

    def test_negated_loved_excludes_both_positive_tiers(self):
        for source_type in (dict, SimpleNamespace):
            rows = tracks(source_type)
            for surface, expected in (("playlist_detail", rows[:1]), ("favorite_songs", [])):
                for query in ("-:loved", "-love:loved"):
                    with self.subTest(source_type=source_type, surface=surface, query=query):
                        result = filter_private_track_sources(
                            rows, query=query, surface=surface, authorized_private=True,
                        )
                        self.assertEqual(result["matched_sources"], expected)
                        self.assertEqual(result["unsupported_filters"], [])

    def test_negated_obsessed_still_permits_loved(self):
        for source_type in (dict, SimpleNamespace):
            rows = tracks(source_type)
            for surface, expected in (("playlist_detail", rows[:2]), ("favorite_songs", rows[1:2])):
                for query in ("-:obsessed", "-love:obsessed"):
                    with self.subTest(source_type=source_type, surface=surface, query=query):
                        result = filter_private_track_sources(
                            rows, query=query, surface=surface, authorized_private=True,
                        )
                        self.assertEqual(result["matched_sources"], expected)
                        self.assertEqual(result["unsupported_filters"], [])

    def test_same_field_positive_filters_are_or(self):
        rows = tracks()
        for query in (":loved love:off", "love:loved love:off"):
            with self.subTest(query=query):
                result = filter_private_track_sources(
                    rows, query=query, surface="playlist_detail", authorized_private=True,
                )
                self.assertEqual(result["matched_sources"], rows)
                self.assertEqual(result["unsupported_filters"], [])

    def test_other_fields_and_negations_constrain_inclusive_loved(self):
        rows = tracks()
        for surface in ("playlist_detail", "favorite_songs"):
            for query, expected in (
                (":loved genre:Rock", rows[1:3]),
                ("love:loved genre:Rock", rows[1:3]),
                (":loved -:obsessed genre:Rock", rows[1:2]),
                ("love:loved -love:obsessed genre:Rock", rows[1:2]),
            ):
                with self.subTest(surface=surface, query=query):
                    result = filter_private_track_sources(
                        rows, query=query, surface=surface, authorized_private=True,
                    )
                    self.assertEqual(result["matched_sources"], expected)
                    self.assertEqual(result["unsupported_filters"], [])

    def test_unauthorized_private_filters_fail_closed_with_explicit_feedback(self):
        for surface in ("playlist_detail", "favorite_songs"):
            for token, value in (
                (":loved", "loved"), ("love:loved", "loved"),
                (":obsessed", "obsessed"), ("love:obsessed", "obsessed"),
            ):
                for prefix in ("", "-"):
                    query = f"{prefix}{token} genre:Rock"
                    with self.subTest(surface=surface, query=query):
                        result = filter_private_track_sources(
                            tracks(), query=query, surface=surface, authorized_private=False,
                        )
                        self.assertEqual(result["matched_sources"], [])
                        self.assertEqual(result["unsupported_filters"], [{
                            "token": token, "field": "love", "value": value,
                            "reason": "unauthorized_private_filter",
                        }])

    def test_missing_or_stripped_private_data_cannot_match_positive_love(self):
        unavailable = [
            {"title": "Loved obsessed"},
            {"track_preference_overlay": None},
            {"track_preference_overlay": {}},
            {"track_preference_overlay": {"love_tier": None}},
            {"track_preference_overlay": {"love_tier": "unknown"}},
            {"track_preference": {"love_tier": "off"},
             "track_preference_state": "unavailable", "can_edit_preferences": False},
        ]
        for source_type in (dict, SimpleNamespace):
            rows = [source_type(**row) for row in unavailable]
            for surface in ("playlist_detail", "favorite_songs"):
                for query in (":loved", "love:loved", ":obsessed", "love:obsessed"):
                    with self.subTest(source_type=source_type, surface=surface, query=query):
                        result = filter_private_track_sources(
                            rows, query=query, surface=surface, authorized_private=True,
                        )
                        self.assertEqual(result["matched_sources"], [])
                        self.assertEqual(result["unsupported_filters"], [])

    def test_shared_projection_helper_retains_exact_tier_filters(self):
        # Search inclusion must not widen the independent exact-tier projection API.
        for tier, expected_loved, expected_obsessed, expected_favorite in (
            ("off", False, False, False),
            ("loved", True, False, True),
            ("obsessed", False, True, True),
        ):
            with self.subTest(tier=tier):
                overlay = {"love_tier": tier}
                self.assertIs(track_preference_matches_favorite_song_projection(
                    overlay, love_tier="loved",
                ), expected_loved)
                self.assertIs(track_preference_matches_favorite_song_projection(
                    overlay, love_tier="obsessed",
                ), expected_obsessed)
                self.assertIs(track_preference_matches_favorite_song_projection(
                    overlay,
                ), expected_favorite)
