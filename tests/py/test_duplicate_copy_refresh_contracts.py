"""Read contracts for already refreshed, synthetic inventory snapshots.

These tests do not delete copies or establish deletion eligibility, atomicity,
watcher invalidation, stale-row retirement, or recovery behavior. Broad duplicate
review grouping is not proof that alternate encodes are safe to delete.
"""
from copy import deepcopy
from itertools import permutations
import os
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


CATEGORIES = ("main_library", "hoard", "new_arrivals")
ALBUM_KEY = "refresh-artist::refresh-release"


def inventory_rows(categories, *, album_key=ALBUM_KEY, title="Refresh Release", unequal=False):
    """Complete input rows for a read, with no media or database side effects."""
    rows = []
    for category in categories:
        root_id = CATEGORIES.index(category) + 1
        # Overlapping unequal coverage, not a strict subset rejected by membership.
        numbers = (1, 3, 4) if unequal and category == "new_arrivals" else (1, 2)
        extension = "mp3" if unequal and category == "hoard" else "flac"
        for number in numbers:
            path = f"/synthetic-refresh/{category}/{title}/{number:02}.{extension}"
            entry = {
                "path": path, "album": title, "album_artist": "Refresh Artist",
                "artist": "Refresh Artist", "title": f"Song {number}",
                "year": 2024, "track_number": number, "disc_number": 1,
                "duration_seconds": 120, "library_root_id": root_id,
                "library_root_category": category,
            }
            rows.append({
                "album_key": album_key, "album_title": title,
                "artist_name": "Refresh Artist", "album_release_year": 2024,
                "album_metadata": {"album_artist": "Refresh Artist"},
                "track_key": f"{album_key}::track-{number}",
                "track_title": f"Song {number}", "track_number": number,
                "disc_number": 1, "duration_seconds": 120,
                "file_private_path": path, "file_entry": entry,
                "file_library_root_id": root_id,
                "file_library_root_category": category,
                "file_scan_cache_stale": False,
            })
    return rows


class DuplicateCopyRefreshContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = TemporaryDirectory(prefix="albumhaven-copy-refresh-")
        cls.addClassCleanup(temporary.cleanup)
        environment = patch.dict(os.environ, {"MUSIC_APP_DATA_DIR": temporary.name})
        environment.start()
        cls.addClassCleanup(environment.stop)
        from music_app.services import library_browse_postgres
        cls.owner = library_browse_postgres

    def assert_track_references(self, tracks, rows):
        self.assertEqual(
            {(track["path"], track["key"], track["track_ref"]) for track in tracks},
            {(row["file_private_path"], row["track_key"], row["track_key"]) for row in rows},
        )
        self.assertEqual(len(tracks), len(rows))

    def test_each_category_removal_order_refreshes_three_two_one_without_losing_survivors(self):
        for removal_order in permutations(CATEGORIES):
            for removed_count in range(3):
                remaining = removal_order[removed_count:]
                with self.subTest(removed=removal_order[:removed_count], remaining=remaining):
                    rows = inventory_rows(remaining)
                    before = deepcopy(rows)
                    duplicate = self.owner._duplicate_sources_from_rows(rows)[ALBUM_KEY]
                    self.assertEqual(duplicate["has_duplicate_files"], len(remaining) > 1)
                    self.assertEqual(len(duplicate["duplicate_sources"]), len(remaining) if len(remaining) > 1 else 0)
                    provenance = duplicate["_root_provenance_by_year"][2024]
                    self.assertEqual(set(provenance["categories"]), set(remaining))
                    self.assertEqual(set(provenance["root_ids"]), {str(CATEGORIES.index(category) + 1) for category in remaining})
                    if len(remaining) > 1:
                        self.assert_track_references(
                            [track for source in duplicate["duplicate_sources"] for track in source["tracks"]], rows,
                        )
                    albums = self.owner._problematic_album_projection_payloads(rows)
                    self.assertEqual(len(albums), 1)
                    album = albums[0]
                    self.assertEqual(album["key"], ALBUM_KEY)
                    self.assert_track_references(album["tracks"], rows)
                    self.assertEqual(album["has_duplicate_files"], len(remaining) > 1)
                    self.assertNotEqual(album.get("inventory_status"), "missing")
                    self.assertEqual(self.owner._missing_album_projection_payloads(rows), [])
                    summary = self.owner._problematic_album_summary_payload(album)
                    detail = self.owner._problematic_album_detail_payload(album)
                    for payload in (summary, detail):
                        self.assertIsNotNone(payload)
                        self.assertEqual("Duplicate files" in payload["problem_reasons"], len(remaining) > 1)
                        self.assertIn("Missing cover art", payload["problem_reasons"])
                        self.assertNotIn("Album not found", payload["problem_reasons"])
                    self.assertEqual(detail["has_duplicate_files"], len(remaining) > 1)
                    self.assertEqual(len(detail["duplicate_sources"]), len(remaining) if len(remaining) > 1 else 0)
                    self.assert_track_references(detail["tracks"], rows)
                    self.assertEqual(rows, before)

    def test_distinct_persisted_album_and_track_identities_survive_refreshed_snapshots(self):
        for removal_order in permutations(CATEGORIES):
            for removed_count in range(3):
                remaining = removal_order[removed_count:]
                with self.subTest(remaining=remaining):
                    rows = []
                    for category in remaining:
                        # Separate persisted records share release tags, not IDs.
                        rows.extend(inventory_rows((category,), album_key=f"{ALBUM_KEY}::{category}"))
                    before = deepcopy(rows)
                    expected_keys = {row["album_key"] for row in rows}
                    duplicates = self.owner._duplicate_sources_from_rows(rows)
                    albums = self.owner._problematic_album_projection_payloads(rows)
                    self.assertEqual(set(duplicates), expected_keys)
                    self.assertEqual({album["key"] for album in albums}, expected_keys)
                    for album in albums:
                        key = album["key"]
                        own_rows = [row for row in rows if row["album_key"] == key]
                        self.assertEqual(album["album_ref"], key)
                        self.assert_track_references(album["tracks"], own_rows)
                        self.assertEqual(album["has_duplicate_files"], len(remaining) > 1)
                        duplicate = duplicates[key]
                        self.assertEqual(duplicate["has_duplicate_files"], len(remaining) > 1)
                        self.assertEqual(set(duplicate["_root_provenance_by_year"][2024]["categories"]), set(remaining))
                        detail = self.owner._problematic_album_detail_payload(album)
                        self.assertEqual(detail["album_ref"], key)
                        self.assert_track_references(detail["tracks"], own_rows)
                        self.assertEqual("Duplicate files" in detail["problem_reasons"], len(remaining) > 1)
                        if len(remaining) > 1:
                            self.assertEqual(set(detail["root_provenance"]["categories"]), set(remaining))
                            self.assertEqual(set(detail["root_provenance"]["root_ids"]), {str(CATEGORIES.index(category) + 1) for category in remaining})
                            for sources in (duplicate["duplicate_sources"], detail["duplicate_sources"]):
                                self.assertEqual(len(sources), len(remaining))
                                self.assert_track_references([track for source in sources for track in source["tracks"]], rows)
                        else:
                            self.assertEqual(duplicate["duplicate_sources"], [])
                            self.assertEqual(detail["duplicate_sources"], [])
                    self.assertEqual(rows, before)

    def test_last_copy_clears_only_its_duplicate_reason_not_another_album(self):
        other_key = "refresh-artist::another-release"
        other_rows = inventory_rows(("main_library", "hoard"), album_key=other_key, title="Another Release")
        for categories in (CATEGORIES, ("hoard", "new_arrivals"), ("new_arrivals",)):
            with self.subTest(categories=categories):
                rows = inventory_rows(categories) + other_rows
                albums = self.owner._problematic_album_projection_payloads(rows)
                summaries = {album["key"]: self.owner._problematic_album_summary_payload(album) for album in albums}
                self.assertEqual(set(summaries), {ALBUM_KEY, other_key})
                duplicate_keys = {key for key, summary in summaries.items() if "Duplicate files" in summary["problem_reasons"]}
                self.assertEqual(duplicate_keys, {ALBUM_KEY, other_key} if len(categories) > 1 else {other_key})
                self.assertIn("Missing cover art", summaries[ALBUM_KEY]["problem_reasons"])
        # With no other duplicate album, no duplicate reason remains for a UI
        # category to contain. Rendering/removing that category is a separate gate.
        album = self.owner._problematic_album_projection_payloads(inventory_rows(("main_library",)))[0]
        self.assertNotIn("Duplicate files", self.owner._problematic_album_summary_payload(album)["problem_reasons"])

    def test_review_preserves_alternate_encodes_and_unequal_coverage(self):
        rows = inventory_rows(CATEGORIES, unequal=True)
        before = deepcopy(rows)
        duplicate = self.owner._duplicate_sources_from_rows(rows)[ALBUM_KEY]
        self.assertTrue(duplicate["has_duplicate_files"])
        sources = {source["folder_path"].split("/")[-2]: source for source in duplicate["duplicate_sources"]}
        self.assertEqual(set(sources), set(CATEGORIES))
        self.assertEqual({category: source["track_count"] for category, source in sources.items()}, {"main_library": 2, "hoard": 2, "new_arrivals": 3})
        for category, source in sources.items():
            expected = [row for row in rows if row["file_library_root_category"] == category]
            self.assert_track_references(source["tracks"], expected)
        self.assertTrue(all(track["path"].endswith(".mp3") for track in sources["hoard"]["tracks"]))
        self.assertTrue(all(track["path"].endswith(".flac") for track in sources["main_library"]["tracks"]))
        self.assertEqual(rows, before)

    def test_strict_subset_membership_classification_does_not_remove_inventory_rows(self):
        from music_app.services.album_local_membership import rejected_local_album_paths

        rows = [row for row in inventory_rows(CATEGORIES)
                if row["file_library_root_category"] != "new_arrivals" or row["track_number"] == 1]
        before = deepcopy(rows)
        subset_paths = {row["file_private_path"] for row in rows if row["file_library_root_category"] == "new_arrivals"}
        self.assertEqual(
            rejected_local_album_paths([row["file_entry"] for row in rows]),
            {path: "Duplicate track outside album folder" for path in subset_paths},
        )
        duplicate = self.owner._duplicate_sources_from_rows(rows)[ALBUM_KEY]
        self.assertEqual(len(duplicate["duplicate_sources"]), 2)
        self.assert_track_references(
            [track for source in duplicate["duplicate_sources"] for track in source["tracks"]],
            [row for row in rows if row["file_library_root_category"] != "new_arrivals"],
        )
        album = self.owner._problematic_album_projection_payloads(rows)[0]
        self.assert_track_references(album["tracks"], rows)
        self.assertEqual(rows, before)

    def test_independent_missing_album_is_not_suppressed_by_surviving_duplicate(self):
        missing_key = "refresh-artist::unrelated-missing"
        missing_rows = inventory_rows(("main_library",), album_key=missing_key, title="Unrelated Missing")
        for row in missing_rows:
            row["file_scan_cache_stale"] = True
        repository = self.owner.PostgresLibraryBrowseRepository({}, connect=lambda _: self.fail("Database access forbidden"))
        with patch.object(repository, "_load_relation_alias_maps", return_value={}):
            payload = repository._build_problematic_files_payload_from_rows(
                connection=None, rows=inventory_rows(("main_library", "hoard")), missing_rows=missing_rows,
            )
        items = {item["key"]: item for item in payload["items"]}
        self.assertEqual(set(items), {ALBUM_KEY, missing_key})
        self.assertIn("Duplicate files", items[ALBUM_KEY]["problem_reasons"])
        self.assertNotIn("Album not found", items[ALBUM_KEY]["problem_reasons"])
        self.assertEqual(items[missing_key]["problem_reasons"], ["Album not found"])
        self.assertEqual(items[missing_key]["inventory_status"], "missing")
        self.assertEqual(items[missing_key]["track_paths"], [])


if __name__ == "__main__":
    unittest.main()
