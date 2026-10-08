import hashlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

SUPPORT = Path(__file__).resolve().parents[1] / 'e2e' / 'support'
sys.path.insert(0, str(SUPPORT))
from mobileLayoutFixture import restore_mobile_demo_covers


class GeneratedCoverRestorationTest(unittest.TestCase):
    def test_restores_selected_generated_art_and_revision_idempotently(self):
        with TemporaryDirectory() as directory:
            cover = Path(directory) / 'cover.jpg'
            alternate = cover.with_name('cover-alternate.jpg')
            cover.write_bytes(b'original generated image')
            alternate.write_bytes(b'alternate generated image')
            revision = hashlib.sha256(alternate.read_bytes()).hexdigest()
            inventory = {'track': {'cover_path': str(cover)}}
            for _ in range(2):
                restore_mobile_demo_covers(inventory, {str(cover): revision})
                self.assertEqual(cover.read_bytes(), alternate.read_bytes())
                self.assertEqual(inventory['track']['cover_revision'], revision)
                self.assertEqual(inventory['track']['cover_selection_origin'], 'user')

    def test_unknown_artwork_never_replaces_saved_selection(self):
        with TemporaryDirectory() as directory:
            cover = Path(directory) / 'cover.jpg'
            cover.write_bytes(b'generated image')
            inventory = {'track': {'cover_path': str(cover)}}
            with self.assertRaisesRegex(ValueError, 'cannot be regenerated'):
                restore_mobile_demo_covers(inventory, {str(cover): 'unknown'})
            self.assertEqual(inventory['track'], {'cover_path': str(cover)})
            self.assertEqual(cover.read_bytes(), b'generated image')
            with self.assertRaisesRegex(ValueError, 'outside'):
                restore_mobile_demo_covers(inventory, {str(cover.with_name('other.jpg')): 'unknown'})


if __name__ == '__main__':
    unittest.main()
