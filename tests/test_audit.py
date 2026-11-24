"""Adversarial scanner cases with disposable architectures and exact evidence."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from scanner import MAX_EDGES, find_path, references, scan, structural_observations

CAP = 50000


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return str(path)

    def test_bare_urls_do_not_invent_local_paths(self):
        source = self.write('AGENTS.md', 'https://example.com/docs/a.md\nftp://example.org/help/start\nSee https://host/path/file.md and ./real.md\n[Web](https://example.com/docs/a.md)\n')
        target = self.write('real.md', '# Real')
        model = scan([str(self.root)])
        self.assertEqual([(edge['source'], edge['target']) for edge in model['edges']], [(source, target)])
        self.assertFalse(model['issues'])

    def test_json_evidence_uses_each_value_location_including_escaped_names(self):
        document = json.dumps({'description': 'same.md', 'objects': [{'path': 'same.md'}, {'path': 'same.md'}], 'instructions': ['café.md', 'same.md']}, indent=2)
        refs = [item for item in references(document, '.json') if item[1] == 'manifest']
        expected = [index for index, line in enumerate(document.splitlines(), 1) if '"path"' in line or 'caf' in line or line.strip() == '"same.md"']
        self.assertEqual([item[2] for item in refs], expected)
        self.assertEqual([item[0] for item in refs], ['same.md', 'same.md', 'café.md', 'same.md'])

    def test_declared_relations_preserve_each_manifest_type_and_source_line(self):
        a = self.write('a.md', '# A')
        b = self.write('b.md', '# B')
        manifest = {'relationships': [{'source': '../a.md', 'target': '../b.md', 'type': 'reads'}, {'source': '../a.md', 'target': '../b.md', 'type': 'uses'}]}
        document = json.dumps(manifest, indent=2)
        origins = [self.write(f'{folder}/agent-architecture.json', document) for folder in ['one', 'two']]
        model = scan([str(self.root)])
        edges = [edge for edge in model['edges'] if edge['kind'] == 'declared']
        self.assertEqual(len(edges), 4)
        self.assertEqual(len({edge['id'] for edge in edges}), 4)
        lines = [index for index, line in enumerate(document.splitlines(), 1) if '"source"' in line]
        self.assertEqual({(edge['origin'], edge['raw'], edge['line']) for edge in edges}, {(origin, kind, line) for origin in origins for kind, line in zip(['reads', 'uses'], lines)})
        self.assertEqual(find_path(model, a, b)['nodes'], [a, b])
        compact = self.write('agent-architecture.json', json.dumps({'relationships': [{'source': 'a.md', 'target': 'b.md', 'type': 'reads'}, {'source': 'a.md', 'target': 'b.md', 'type': 'uses'}]}))
        compact_edges = [edge for edge in scan([str(self.root)])['edges'] if edge['kind'] == 'declared' and edge['origin'] == compact]
        self.assertEqual({edge['raw'] for edge in compact_edges}, {'reads', 'uses'})

    def test_scope_preserves_both_instruction_files_at_nearest_parent(self):
        far = self.write('AGENTS.md', '# Root')
        parents = {self.write(f'child/{name}', '# Parent') for name in ['AGENTS.md', 'CLAUDE.md']}
        child = self.write('child/deeper/AGENTS.md', '# Child')
        model = scan([str(self.root)])
        self.assertEqual({edge['source'] for edge in model['edges'] if edge['target'] == child and edge['kind'] == 'scope'}, parents)
        self.assertFalse(any(item['code'] == 'cycle' for item in model['issues'] + model['signals']))
        self.assertFalse(find_path(model, far, child)['found'])
        self.assertTrue(find_path(model, far, child, conventions=True)['found'])

    def test_cycles_repetitions_and_fanout_are_structural_with_provenance(self):
        a = self.write('AGENTS.md', '[B](b.md)\n[B again](b.md)\n' + '\n'.join(f'[D{i}](d{i}.md)' for i in range(12)))
        b = self.write('b.md', '[Return](AGENTS.md)')
        for i in range(12):
            self.write(f'd{i}.md', '# Document')
        before = {str(path): (path.stat().st_size, path.stat().st_mtime_ns) for path in self.root.rglob('*')}
        model = scan([str(self.root)])
        # Structural observations are signals: none of them is reported as an issue.
        self.assertFalse(model['issues'])
        observations = {signal['code']: signal for signal in model['signals']}
        self.assertEqual(set(observations), {'cycle', 'repeated-reference', 'high-fanout'})
        self.assertEqual(model['stats']['structure'], {'cycles': 1, 'selfReferences': 0, 'repeatedReferences': 1, 'highFanout': 1,
                                                       'fanoutThreshold': 12, 'maxFanout': {'node': a, 'count': 13}})
        self.assertEqual(observations['repeated-reference']['node'], a)
        self.assertEqual(observations['repeated-reference']['line'], 1)
        self.assertIn('2 evidence locations', observations['repeated-reference']['message'])
        self.assertIn('13 distinct explicit targets', observations['high-fanout']['message'])
        self.assertIn('2 files', observations['cycle']['message'])
        self.assertEqual(find_path(model, a, b)['nodes'], [a, b])
        self.assertEqual(before, {str(path): (path.stat().st_size, path.stat().st_mtime_ns) for path in self.root.rglob('*')})

    def test_acyclic_diamond_is_not_a_cycle_and_self_reference_is(self):
        self.write('AGENTS.md', '[B](b.md)\n[C](c.md)')
        self.write('b.md', '[D](d.md)')
        self.write('c.md', '[D](d.md)')
        self.write('d.md', '# End')
        model = scan([str(self.root)])
        self.assertFalse(any(signal['code'] == 'cycle' for signal in model['signals']))
        self.assertEqual(model['stats']['structure']['cycles'], 0)
        self.write('d.md', '[Self](d.md)')
        model = scan([str(self.root)])
        # A file citing its own name is counted, never signalled as a cycle.
        self.assertFalse(any(item['code'] == 'cycle' for item in model['issues'] + model['signals']))
        self.assertEqual((model['stats']['structure']['cycles'], model['stats']['structure']['selfReferences']), (0, 1))

    def test_long_cycle_does_not_use_python_recursion(self):
        count = 3000
        edges = [{'source': str(index), 'target': str((index + 1) % count), 'kind': 'markdown', 'origin': str(index), 'line': 1} for index in range(count)]
        issues = []
        structural_observations(edges, lambda *args, **details: issues.append(args))
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0][0], 'cycle')
        self.assertIn('3000 files', issues[0][1])

    def test_directory_symlinks_share_inventory_budget_with_other_roots(self):
        first = self.root / 'first'
        second = self.root / 'second'
        first.mkdir()
        second.mkdir()
        entry = self.write('second/AGENTS.md', '# Available')
        for index in range(9):
            (first / f'link{index}').symlink_to(second, target_is_directory=True)
        with patch('scanner.MAX_FILES', 8):
            model = scan([str(first), str(second)])
        self.assertIn(entry, {node['id'] for node in model['nodes']})
        self.assertLessEqual(len(model['nodes']), 8)
        self.assertEqual(len([node for node in model['nodes'] if node['kind'] == 'symlink']), 3)
        self.assertTrue(any(issue['code'] == 'limit' and issue['node'] == str(first) for issue in model['issues']))

    def test_invalid_file_uri_is_a_local_observation_and_does_not_drop_other_edges(self):
        source = self.write('AGENTS.md', '# Entry\n[Invalid](file://[bad/path.md)\n[Valid](target.md)\n')
        target = self.write('target.md', '# Target')
        model = scan([str(self.root)])
        invalid = [issue for issue in model['issues'] if issue['code'] == 'invalid-reference']
        self.assertEqual([(issue['node'], issue['line']) for issue in invalid], [(source, 2)])
        self.assertEqual([(edge['source'], edge['target'], edge['line']) for edge in model['edges']], [(source, target, 3)])

    def test_fifty_thousand_json_references_keep_lines_and_obey_relation_limit(self):
        # The cap (MAX_EDGES, 100,000) is lowered to 50,000 here: one manifest under MAX_BYTES holds that many.
        self.assertGreaterEqual(MAX_EDGES, 50000)
        self.write('AGENTS.md', '# Entry')
        target = self.write('target.md', '# Target')
        document = json.dumps({'instructions': ['target.md'] * (CAP + 1)}, indent=0)
        self.assertLess(len(document.encode()), 1024 * 1024)
        source = self.write('manifest.json', document)
        with patch('scanner.MAX_EDGES', CAP):
            model = scan([str(self.root)])
        edges = model['edges']
        self.assertEqual(len(edges), CAP)
        self.assertTrue(all(edge['source'] == source and edge['target'] == target and edge['origin'] == source for edge in edges))
        self.assertEqual(edges[0]['line'], 3)
        self.assertEqual(edges[-1]['line'], CAP + 2)
        self.assertEqual(len({edge['id'] for edge in edges}), CAP)
        self.assertTrue(any(issue['code'] == 'limit' and 'relations' in issue['message'] for issue in model['issues']))
        self.assertEqual(model['stats']['relations'], {'complete': False, 'omitted': 1, 'max': CAP})
        self.assertEqual(len(model['nodes']), 4)

    def test_many_entry_directories_keep_nearest_scope_without_sibling_links(self):
        root = self.write('AGENTS.md', '# Root')
        for index in range(500):
            self.write(f'agent-{index}/AGENTS.md', '# Agent')
        nearer = self.write('agent-0/CLAUDE.md', '# Additional parent')
        child = self.write('agent-0/deep/nested/AGENTS.md', '# Child')
        model = scan([str(self.root)])
        scope = [edge for edge in model['edges'] if edge['kind'] == 'scope']
        self.assertEqual(len(scope), 503)
        self.assertEqual({edge['source'] for edge in scope if edge['target'] == child}, {nearer, str(self.root / 'agent-0/AGENTS.md')})
        self.assertTrue(all(edge['source'] == root for edge in scope if edge['target'] != child))


if __name__ == '__main__':
    unittest.main()
