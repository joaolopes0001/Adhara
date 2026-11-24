"""The document snapshot of one root: bounded, read-only and never following links."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import doc_snapshot
from server.scanner import scan


class DocSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'project'
        self.root.mkdir()
        (self.root / 'AGENTS.md').write_text('# Agent\n[Rules](rules.md)\n')
        (self.root / 'rules.md').write_text('# Rules\nSecond line\nThird line\n')
        self.model = scan([str(self.root)])
        self.payload = {'root': str(self.root), 'entry': str(self.root / 'AGENTS.md')}

    def test_protected_root_symlink_hardlink_and_sensitive_files_are_excluded(self):
        with patch.dict(os.environ, {'AAE_PROTECTED_PATHS': str(self.root)}):
            with self.assertRaisesRegex(ValueError, 'AAE_PROTECTED_PATHS'):
                doc_snapshot.build_snapshot(self.model, self.payload)
        secret = Path(self.temp.name) / 'outside.md'
        secret.write_text('DO NOT READ')
        (self.root / 'rules.md').unlink()
        (self.root / 'rules.md').symlink_to(secret)
        snapshot = doc_snapshot.build_snapshot(self.model, self.payload)
        self.assertNotIn('rules.md', snapshot['documents'])
        (self.root / 'hard.md').hardlink_to(secret)
        (self.root / 'auth.json').write_text('{"access_token":"not-a-real-token"}')
        snapshot = doc_snapshot.build_snapshot(scan([str(self.root)]), self.payload)
        self.assertNotIn('hard.md', snapshot['documents'])
        self.assertNotIn('auth.json', snapshot['documents'])
        self.assertEqual(secret.read_text(), 'DO NOT READ')

    def test_reader_rejects_symlink_in_any_ancestor_of_reviewed_root(self):
        container = Path(self.temp.name) / 'container'
        nested = container / 'nested'
        nested.mkdir(parents=True)
        (nested / 'AGENTS.md').write_text('Reviewed')
        outside = Path(self.temp.name) / 'outside'
        (outside / 'nested').mkdir(parents=True)
        (outside / 'nested' / 'AGENTS.md').write_text('Unreviewed')
        # Simulate replacement after root validation, before snapshot read.
        container.rename(Path(self.temp.name) / 'original-container')
        container.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            doc_snapshot._read_document(nested, 'AGENTS.md')

    def test_canary_cannot_shadow_existing_unparsed_or_excluded_file(self):
        (self.root / 'secret.bin').write_bytes(b'\x00')
        (self.root / 'auth.json').write_text('{}')
        for name in ['rules.md', 'secret.bin', 'auth.json', '../escape.md', '/absolute.md', 'a/../b.md']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                doc_snapshot.build_snapshot(scan([str(self.root)]), {**self.payload, 'canaries': [name]})
        with patch.object(doc_snapshot, 'MAX_FILES', 2):
            snapshot = doc_snapshot.build_snapshot(self.model, {**self.payload, 'canaries': ['canary.md']})
        self.assertEqual(set(snapshot['documents']), {'AGENTS.md', 'canary.md'})
        with patch.object(doc_snapshot, 'MAX_TOTAL_BYTES', 60):
            with self.assertRaises(ValueError):
                doc_snapshot.build_snapshot(self.model, {**self.payload, 'canaries': ['canary.md']})

    def test_multiple_roots_do_not_expand_snapshot(self):
        sibling = Path(self.temp.name) / 'second'
        sibling.mkdir()
        (sibling / 'AGENTS.md').write_text('Other\n')
        suite = {'version': 1, 'entry': 'AGENTS.md', 'scenarios': []}
        model, snapshot = doc_snapshot.prepare([str(self.root), str(sibling)], suite)
        self.assertEqual(len(model['roots']), 2)
        self.assertTrue(all(str(self.root) in doc['node'] for doc in snapshot['documents'].values()))
        for value in ['../AGENTS.md', '/AGENTS.md', './AGENTS.md', 'a//b', '']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                doc_snapshot.prepare([str(self.root)], {'entry': value})

    def test_prepare_records_scanner_omissions(self):
        suite = {'version': 1, 'entry': 'AGENTS.md', 'scenarios': []}
        _, complete = doc_snapshot.prepare([str(self.root)], suite)
        self.assertEqual((complete['scanPartial'], complete['scanIssues']), (False, []))
        self.assertNotIn('entryInjected', doc_snapshot.prepare([str(self.root)], {**suite, 'entryInjected': True})[1])
        (self.root / 'large.md').write_text('x' * (1024 * 1024 + 1))
        (self.root / 'AGENTS.md').write_text('# Agent\n[Rules](rules.md)\n[Large](large.md)\n')
        _, partial = doc_snapshot.prepare([str(self.root)], suite)
        self.assertTrue(partial['scanPartial'])
        self.assertTrue(partial['scanIssues'])
        self.assertTrue(all(set(issue) == {'code', 'node'} for issue in partial['scanIssues']))


class ReadDocumentWalkTests(unittest.TestCase):
    """The walk of `_read_document` from `/`, and the descriptor it opens for the last component."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        (self.base / 'inner' / 'folder.md').mkdir(parents=True)
        (self.base / 'inner' / 'file.md').write_text('read from the root\n')

    def test_relative_root_is_read_from_slash_dropping_its_first_part(self):
        # Callers pass an absolute root. A relative one is never resolved against the cwd:
        # its first part counts as the anchor, and every folder of the relative path is walked.
        below_slash = str(self.base / 'inner' / 'file.md').lstrip('/')
        for root in ('', '.', 'ignored'):
            self.assertEqual(doc_snapshot._read_document(root, below_slash), 'read from the root\n')
            with self.assertRaises(FileNotFoundError):
                doc_snapshot._read_document(root, 'missing-first/' + below_slash)

    def test_folder_in_place_of_the_file_leaves_no_descriptor(self):
        before = len(os.listdir('/proc/self/fd'))
        for _ in range(20):
            with self.assertRaises(IsADirectoryError):
                doc_snapshot._read_document(str(self.base), 'inner/folder.md')
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)


if __name__ == '__main__':
    unittest.main()
