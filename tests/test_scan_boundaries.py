"""Read boundaries with disposable files, including changes after inventory."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SERVER = Path(__file__).resolve().parents[1] / 'server'
sys.path.insert(0, str(SERVER))
from scanner import scan
from workspace import Workspace


class ReadBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        self.entry = self.root / 'AGENTS.md'
        self.entry.write_text('# Entry\n', encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def run_isolated(self, script):
        # A future blocking-read regression fails by timeout instead of hanging
        # the test process. subprocess.run kills only this owned child on timeout.
        return subprocess.run([sys.executable, '-c', f'import sys; sys.path.insert(0, {str(SERVER)!r});\n' + script],
                              check=True, capture_output=True, text=True, timeout=5).stdout

    def test_scanner_lists_fifo_without_reading_or_blocking(self):
        fifo = self.root / 'pipe.md'
        os.mkfifo(fifo)
        output = self.run_isolated(f'from scanner import scan; import json; print(json.dumps(scan([{str(self.root)!r}])))')
        model = json.loads(output)
        node = next(node for node in model['nodes'] if node['id'] == str(fifo))
        self.assertEqual(node['analysis'], 'skipped')
        self.assertTrue(any(issue['code'] == 'unreadable' and issue['node'] == str(fifo) for issue in model['issues']))
        self.assertEqual(model['stats']['parsed'], 1)

    def test_safe_reader_preserves_crlf_and_cr_evidence_line_numbers(self):
        target = self.root / 'target.md'
        target.write_text('# Target', encoding='utf-8')
        self.entry.write_bytes(b'# Entry\r\n[First](target.md)\r[Second](target.md)\r')
        model = scan([str(self.root)])
        self.assertEqual([edge['line'] for edge in model['edges']], [2, 3])
        node = next(node for node in model['nodes'] if node['id'] == str(self.entry))
        self.assertEqual(node['lines'], 4)

    def test_preview_rejects_regular_file_replaced_with_fifo(self):
        output = self.run_isolated(f'''
import os
from pathlib import Path
from workspace import Workspace
workspace = Workspace({str(self.base / 'state')!r})
workspace.open({str(self.root)!r})
path = Path({str(self.entry)!r})
path.unlink()
os.mkfifo(path)
try:
    workspace.content(str(path))
except ValueError as error:
    print(str(error))
else:
    raise AssertionError('FIFO accepted as preview')
''')
        self.assertIn('it is not a regular file', output)

    def test_preview_rejects_final_symlink_swap_after_path_validation(self):
        workspace = Workspace(self.base / 'state')
        workspace.open(str(self.root))
        outside = self.base / 'outside.md'
        outside.write_text('Outside fixture', encoding='utf-8')
        real_open = os.open
        swapped = False

        def swap_then_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if not swapped:
                swapped = True
                self.entry.unlink()
                self.entry.symlink_to(outside)
            return real_open(path, flags, *args, **kwargs)

        with patch('scanner.os.open', side_effect=swap_then_open):
            with self.assertRaises((OSError, ValueError)):
                workspace.content(str(self.entry))
        self.assertTrue(swapped)

    def test_preview_rejects_ancestor_symlink_swap_after_path_validation(self):
        inside = self.root / 'inside'
        inside.mkdir()
        document = inside / 'guide.md'
        document.write_text('# Local', encoding='utf-8')
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'guide.md').write_text('Outside fixture', encoding='utf-8')
        workspace = Workspace(self.base / 'state')
        workspace.open(str(self.root))
        real_open = os.open
        swapped = False

        def swap_then_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if not swapped:
                swapped = True
                inside.rename(self.root / 'original-inside')
                inside.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)

        with patch('scanner.os.open', side_effect=swap_then_open):
            with self.assertRaises((OSError, ValueError)):
                workspace.content(str(document))
        self.assertTrue(swapped)

    def test_scanner_rejects_file_that_grows_beyond_limit_after_stat(self):
        real_fstat = os.fstat
        expanded = False
        file_stats = 0

        def stat_then_grow(descriptor):
            nonlocal expanded, file_stats
            result = real_fstat(descriptor)
            if result.st_ino == self.entry.stat().st_ino:
                file_stats += 1
                if file_stats == 2:
                    expanded = True
                    self.entry.write_text('x' * 200, encoding='utf-8')
            return result

        with patch('scanner.MAX_BYTES', 100), patch('scanner.os.fstat', side_effect=stat_then_grow):
            model = scan([str(self.root)])
        self.assertTrue(expanded)
        node = next(node for node in model['nodes'] if node['id'] == str(self.entry))
        self.assertEqual(node['analysis'], 'skipped')
        self.assertTrue(any(issue['code'] == 'limit' and issue['node'] == str(self.entry) for issue in model['issues']))


if __name__ == '__main__':
    unittest.main()
