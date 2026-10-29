"""Direct unittest entry point; no application bootstrap, database or network."""
import unittest
from music_app.services.listening_goal_metadata_rules import (
    broad_parents, normalize_genre_label, popularity_proxy, usual_genres,
    RULES_VERSION, POPULARITY_VERSION, TASTE_VERSION,
)


def observation(track, count, entity=None, provider='cached'):
    return dict(track_ref=track, count=count, entity_ref=entity or track, provider=provider)


class MetadataRulesTests(unittest.TestCase):
    def test_exact_unicode_aliases_without_substring_guessing(self):
        self.assertEqual(normalize_genre_label('  ＰＲＯＧＲＥＳＳＩＶＥ\u00a0ＲＯＣＫ\t'), 'progressive rock')
        self.assertEqual(broad_parents(['PROG ROCK', 'progressive metal', 'folk']),
                         frozenset({'progressive rock', 'metal', 'world/folk'}))
        self.assertEqual(broad_parents(['not progressive rock', 'folkish', 'unknown', '']), frozenset())
        self.assertEqual(broad_parents('Other'), frozenset({'other'}))
        self.assertEqual(broad_parents('rock/metal'), frozenset())

    def test_union_deduplicates_and_progressive_metal_is_not_prog_rock(self):
        self.assertEqual(broad_parents(['prog metal', 'METAL', 'heavy metal']), frozenset({'metal'}))
        self.assertEqual(broad_parents(['folk', 'world', 'world / folk']), frozenset({'world/folk'}))
        with self.assertRaises(TypeError): normalize_genre_label(None)
        self.assertEqual(len({RULES_VERSION, POPULARITY_VERSION, TASTE_VERSION}), 3)

    def test_popularity_requires_half_distinct_tracks_and_valid_counts(self):
        tracks = ['a', 'b', 'c', 'd', 'd']
        self.assertIsNone(popularity_proxy(tracks, [observation('a', 3)]))
        self.assertEqual(popularity_proxy(tracks, [observation('a', 0), observation('b', 10)]), 5)
        for invalid in (-1, True, '4', 3.0, float('nan'), None):
            self.assertIsNone(popularity_proxy(['a'], [observation('a', invalid)]))
        self.assertIsNone(popularity_proxy([], []))
        self.assertIsNone(popularity_proxy(['a'], [observation('outside', 100)]))
        self.assertIsNone(popularity_proxy(['a'], [observation('a', 100, provider=' ')]))

    def test_popularity_dedupes_entity_not_only_rows(self):
        rows = [observation('a', 10, 'same'), observation('b', 10, 'same'),
                observation('c', 100, 'different'), observation('a', 10, 'same')]
        self.assertEqual(popularity_proxy(['a', 'b', 'c', 'd'], rows), 55)
        self.assertIsNone(popularity_proxy(['a', 'b'],
            [observation('a', 10, 'same'), observation('b', 20, 'same')]))
        # Conflict remains excluded even if a later row repeats the first value.
        self.assertIsNone(popularity_proxy(['a'], [observation('a', n) for n in (10, 20, 10)]))

    def test_popularity_does_not_conflate_provider_entities(self):
        self.assertEqual(popularity_proxy(['a'],
            [observation('a', 10, '1', 'one'), observation('a', 30, '1', 'two')]), 20)
        self.assertIsNone(popularity_proxy(['a', 'b'],
            [observation('a', 10**1000), observation('b', 10**1000)]))

    def test_taste_needs_five_mapped_distinct_albums(self):
        self.assertIsNone(usual_genres({str(i): ['rock'] for i in range(4)}))
        self.assertIsNone(usual_genres({**{str(i): ['rock'] for i in range(4)}, '5': ['unknown']}))
        self.assertEqual(usual_genres({str(i): ['rock', 'ROCK'] for i in range(5)}), frozenset({'rock'}))

    def test_taste_uses_multi_parent_incidences_and_includes_cutoff_ties(self):
        albums = {str(i): ['rock'] for i in range(4)}
        albums['5'] = ['jazz']
        self.assertEqual(usual_genres(albums), frozenset({'rock'}))
        albums['5'] = ['jazz', 'metal']
        # Rock=4, jazz=1, metal=1; cutoff needs one tied member, so both included.
        self.assertEqual(usual_genres(albums), frozenset({'rock', 'jazz', 'metal'}))
        self.assertEqual(usual_genres({str(i): ['rock', 'jazz'] for i in range(5)}), frozenset({'rock', 'jazz'}))

    def test_taste_rejects_unsafe_thresholds(self):
        for kwargs in ({'minimum_albums': 4}, {'minimum_albums': True}, {'coverage': 0},
                       {'coverage': float('nan')}, {'coverage': True}, {'coverage': 2}):
            with self.assertRaises(ValueError): usual_genres({}, **kwargs)


if __name__ == '__main__':
    unittest.main()
