"""Synthetic-only filesystem acceptance; no real music and no app database."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

MODULE = Path(__file__).parents[2] / 'music_app/services/duplicate_folder_files.py'
spec = importlib.util.spec_from_file_location('duplicate_folder_files_under_test', MODULE)
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class DuplicateFolderFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='albumhaven-duplicate-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.track = self.source / '1.flac'
        self.track.write_bytes(b'synthetic audio fixture, not decoded')
        self.trash = self.root / 'trash'
        self.trash.mkdir()
        self.destination = self.trash / 'operation'

    def move(self, source, destination):
        info = Path(source).stat() if Path(source).exists() else self.source.stat()
        return files.move_no_replace(source, destination, expected_identity=(info.st_dev, info.st_ino))

    def snapshot(self, source=None):
        source = source or self.source
        return files.snapshot(source, expected_music=[source / '1.flac'], music_extensions={'.flac'})

    def test_preview_counts_sidecars(self):
        (self.source / 'cover.jpg').write_bytes(b'fixture')
        self.assertEqual(self.snapshot()['file_count'], 2)

    def test_unknown_music_is_rejected(self):
        (self.source / 'other.flac').write_bytes(b'fixture')
        with self.assertRaisesRegex(files.DuplicateFolderError, 'mixed_folder_content'):
            self.snapshot()

    def test_missing_expected_music_is_rejected(self):
        self.track.rename(self.source / 'other.txt')
        with self.assertRaisesRegex(files.DuplicateFolderError, 'source_changed'):
            self.snapshot()

    def test_empty_source_is_rejected(self):
        with self.assertRaisesRegex(files.DuplicateFolderError, 'empty_source'):
            files.snapshot(self.source, expected_music=[], music_extensions={'.flac'})

    def test_changed_file_changes_preview(self):
        initial = self.snapshot()['digest']
        self.track.write_bytes(b'changed fixture')
        self.assertNotEqual(self.snapshot()['digest'], initial)

    def test_new_sidecar_changes_preview(self):
        initial = self.snapshot()['digest']
        (self.source / 'new.txt').write_text('new')
        self.assertNotEqual(self.snapshot()['digest'], initial)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux native rename test')
    def test_roundtrip_preserves_files_and_identity(self):
        initial = self.snapshot()
        inode = self.track.stat().st_ino
        self.move(self.source, self.destination)
        self.assertFalse(self.source.exists())
        self.assertEqual(self.snapshot(self.destination), initial)
        self.move(self.destination, self.source)
        self.assertEqual(self.snapshot(), initial)
        self.assertEqual(self.track.stat().st_ino, inode)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux native rename test')
    def test_occupied_destination_is_untouched(self):
        self.destination.mkdir()
        marker = self.destination / 'keep.txt'
        marker.write_text('keep')
        with self.assertRaisesRegex(files.DuplicateFolderError, 'destination_occupied'):
            self.move(self.source, self.destination)
        self.assertTrue(self.track.exists())
        self.assertEqual(marker.read_text(), 'keep')

    def test_nested_destination_rejected(self):
        with self.assertRaisesRegex(files.DuplicateFolderError, 'overlapping_folders'):
            self.move(self.source, self.source / 'trash')
        self.assertTrue(self.track.exists())

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX link fixture')
    def test_symlink_content_rejected(self):
        (self.source / 'shortcut').symlink_to(self.trash, target_is_directory=True)
        with self.assertRaisesRegex(files.DuplicateFolderError, 'linked_folder_content'):
            self.snapshot()

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX link fixture')
    def test_hardlinked_content_rejected(self):
        os.link(self.track, self.root / 'alias.flac')
        with self.assertRaisesRegex(files.DuplicateFolderError, 'linked_folder_content'):
            self.snapshot()

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX link fixture')
    def test_symlink_destination_ancestor_rejected(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.trash, target_is_directory=True)
        with self.assertRaises(OSError):
            self.move(self.source, alias / 'operation')
        self.assertTrue(self.track.exists())
        self.assertFalse(self.destination.exists())

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX special-file fixture')
    def test_special_content_rejected(self):
        os.mkfifo(self.source / 'pipe')
        with self.assertRaisesRegex(files.DuplicateFolderError, 'special_folder_content'):
            self.snapshot()

    def test_replaced_source_identity_rejected(self):
        with self.assertRaisesRegex(files.DuplicateFolderError, 'source_changed'):
            files.move_no_replace(self.source, self.destination, expected_identity=(0, 0))
        self.assertTrue(self.track.exists())
        self.assertFalse(self.destination.exists())

    def test_snapshot_rejects_symlink_parent(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(OSError):
            self.snapshot(alias)

    def test_relative_path_rejected(self):
        with self.assertRaisesRegex(files.DuplicateFolderError, 'invalid_folder'):
            files.move_no_replace('source', self.destination, expected_identity=(0, 0))


if __name__ == '__main__':
    unittest.main()


def test_snapshot_rejects_serialized_metadata_over_budget(tmp_path, monkeypatch):
    import pytest
    folder = tmp_path / 'album'; folder.mkdir()
    track = folder / ('x' * 200 + '.flac'); track.write_bytes(b'synthetic')
    monkeypatch.setattr(files, 'MAX_SNAPSHOT_BYTES', 128)
    with pytest.raises(files.DuplicateFolderError, match='snapshot_metadata_too_large'):
        files.snapshot(folder, expected_music=[str(track)], music_extensions={'.flac'})
    assert track.exists()
