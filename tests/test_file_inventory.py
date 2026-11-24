"""Inventory of regular files: hashes and sizes, bounded, never following links."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import file_inventory


class FileInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'architecture'
        self.root.mkdir()
        (self.root / 'AGENTS.md').write_text('# Entrada\n[Regras](rules.md)\n')
        (self.root / 'rules.md').write_text('# Regras\nObrigatória\nFinal\n')

    def test_inventory_refuses_links_and_special_files(self):
        outside = Path(self.temp.name) / 'outside'
        outside.write_bytes(b'secret')
        (self.root / 'symbolic').symlink_to(outside)
        os.link(outside, self.root / 'hard')
        os.mkfifo(self.root / 'pipe')
        inventory = file_inventory.capture_inventory([str(self.root)])
        self.assertTrue(inventory['partial'])
        self.assertFalse({'symbolic', 'hard', 'pipe'} & {f['path'] for f in inventory['files']})
        self.assertEqual({(o['path'], o['reason']) for o in inventory['omitted']},
                         {('symbolic', 'nonregular-or-link'), ('hard', 'nonregular-or-link'), ('pipe', 'nonregular-or-link')})
        alias = Path(self.temp.name) / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            file_inventory.capture_inventory([str(alias)])

    def test_inventory_limits_make_a_complete_tree_partial(self):
        # A root with regular files only: without a limit the inventory is complete, so each
        # limit below is what makes it partial.
        complete = file_inventory.capture_inventory([str(self.root)])
        self.assertEqual((complete['partial'], complete['omitted'], len(complete['files'])), (False, [], 2))
        self.assertEqual(complete['bytes'], sum(f['bytes'] for f in complete['files']))
        with patch.object(file_inventory, 'INVENTORY_MAX_ENTRIES', 1):
            limited = file_inventory.capture_inventory([str(self.root)])
        self.assertTrue(limited['partial'])
        self.assertIn('entry-limit', {o['reason'] for o in limited['omitted']})
        with patch.object(file_inventory, 'INVENTORY_MAX_FILE_BYTES', 1):
            limited = file_inventory.capture_inventory([str(self.root)])
        self.assertTrue(limited['partial'])
        self.assertEqual({o['reason'] for o in limited['omitted']}, {'byte-limit'})

    def test_inventory_real_deep_tree_retains_partial_evidence(self):
        current, created = self.root, []
        try:
            for _ in range(1050):
                current = current / 'd'
                current.mkdir()
                created.append(current)
            with patch.object(file_inventory, 'INVENTORY_MAX_ENTRIES', 500):
                inventory = file_inventory.capture_inventory([str(self.root)])
            self.assertTrue(inventory['partial'])
            self.assertTrue(any(record['path'] == 'AGENTS.md' for record in inventory['files']))
        finally:
            # shutil.rmtree itself is recursive; remove this adversarial fixture iteratively.
            for directory in reversed(created):
                directory.rmdir()

    def test_inventory_walk_depth_failure_is_partial(self):
        with patch.object(file_inventory.os, 'fwalk', side_effect=RecursionError('synthetic depth exhaustion')):
            result = file_inventory.capture_inventory([str(self.root)])
        self.assertTrue(result['partial'])

    def test_inventory_root_changed_to_symlink_never_claims_complete(self):
        original = file_inventory._roots
        moved = self.root.with_name('moved-original')
        def replace_after_validation(values):
            roots = original(values)
            self.root.rename(moved)
            self.root.symlink_to(moved, target_is_directory=True)
            return roots
        with patch.object(file_inventory, '_roots', side_effect=replace_after_validation):
            inventory = file_inventory.capture_inventory([str(self.root)])
        self.assertTrue(inventory['partial'])


if __name__ == '__main__':
    unittest.main()
