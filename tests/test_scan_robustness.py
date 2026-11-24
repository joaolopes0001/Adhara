"""Malformed document data must be audited without aborting the inventory."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from scanner import scan


class ScanRobustnessTests(unittest.TestCase):
    def test_deep_json_is_partial_and_other_references_keep_evidence(self):
        for filename in ['data.json', 'agent-architecture.json']:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                deep = root / filename
                deep.write_text('[' * 1100 + '0' + ']' * 1100)
                entry = root / 'AGENTS.md'
                entry.write_text('# Entry\n[Good](ok.md)\n')
                target = root / 'ok.md'
                target.write_text('# Good\n')
                model = scan([str(root)])
                node = next(node for node in model['nodes'] if node['id'] == str(deep))
                self.assertEqual(node['analysis'], 'partial')
                self.assertTrue(any(issue['code'] == 'limit' and issue['node'] == str(deep) for issue in model['issues']))
                edge = next(edge for edge in model['edges'] if edge['target'] == str(target))
                self.assertEqual((edge['origin'], edge['line'], edge['evidence']), (str(entry), 2, '[Good](ok.md)'))

    def test_invalid_home_and_nul_targets_are_audited_without_invalid_nodes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entry = root / 'AGENTS.md'
            entry.write_text('[bad](~aae-nonexistent-user/file.md)\n[nul](bad%00.md)\n[good](ok.md)\n')
            target = root / 'ok.md'
            target.write_text('# Good\n')
            before = {str(path): (path.stat().st_mtime_ns, path.read_bytes()) for path in root.iterdir()}
            model = scan([str(root)])
            issues = [issue for issue in model['issues'] if issue['code'] == 'invalid-reference']
            self.assertEqual({issue['line'] for issue in issues}, {1, 2})
            self.assertTrue(all(issue['node'] == str(entry) for issue in issues))
            self.assertFalse(any('\x00' in node['path'] or '~aae-nonexistent-user' in node['path'] for node in model['nodes']))
            self.assertTrue(any(edge['target'] == str(target) and edge['line'] == 3 for edge in model['edges']))
            self.assertEqual(before, {str(path): (path.stat().st_mtime_ns, path.read_bytes()) for path in root.iterdir()})


if __name__ == '__main__':
    unittest.main()
