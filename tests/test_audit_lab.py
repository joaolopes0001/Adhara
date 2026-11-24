"""Adversarial audit against authored expectations, not scanner-derived goldens."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from tests.create_audit_lab import create_lab, fingerprint
from scanner import find_path, scan
from workspace import Workspace


class AuditLabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-lab-test-')
        self.parent = Path(self.temp.name)
        self.lab = create_lab(self.parent / 'lab')
        self.oracle = json.loads((self.lab / 'oracle.json').read_text())
        self.baseline = json.loads((self.lab / 'baseline.json').read_text())

    def tearDown(self):
        self.temp.cleanup()

    def absolute(self, path):
        return str(self.lab / path)

    def assert_unchanged(self):
        self.assertEqual(fingerprint(self.lab), self.baseline)
        for path in self.oracle['must_remain_absent']:
            self.assertFalse(os.path.lexists(self.lab / path), path)

    def test_manual_oracle_edges_paths_negatives_and_integral_read_only(self):
        model = scan([self.absolute(self.oracle['roots']['primary'])])
        for expected in self.oracle['expected_edges']:
            translated = {key: self.absolute(value) if key in {'source', 'target', 'origin'} else value
                          for key, value in expected.items()}
            matches = [edge for edge in model['edges'] if all(edge[key] == value for key, value in translated.items())]
            self.assertEqual(len(matches), 1, expected)
            self.assertEqual(matches[0]['confidence'], 'deterministic')
        for expected in self.oracle['paths']:
            with self.subTest(path=expected):
                result = find_path(model, self.absolute(expected['start']), self.absolute(expected['end']),
                                   expected['direction'], expected['conventions'])
                self.assertEqual(result['found'], expected['found'])
                self.assertEqual(result['nodes'], list(map(self.absolute, expected['nodes'])))
                self.assertEqual([step['reverse'] for step in result['steps']], expected['reverse'])
        for group in ('issues', 'signals'):
            for expected in self.oracle[group]:
                translated = {key: self.absolute(value) if key == 'node' else value for key, value in expected.items()}
                self.assertTrue(any(all(item[key] == value for key, value in translated.items()) for item in model[group]), expected)
        self.assertFalse({item['code'] for item in model['issues']} & {item['code'] for item in self.oracle['signals']})
        nodes = {node['path']: node for node in model['nodes']}
        for path, status in self.oracle['primary_statuses'].items():
            self.assertEqual(nodes[self.absolute(path)]['status'], status, path)
        for path in self.oracle['forbidden_nodes']:
            self.assertNotIn(self.absolute(path), nodes)
        for forbidden in self.oracle['forbidden_edges']:
            self.assertFalse(any(edge['source'] == self.absolute(forbidden['source']) and
                                 edge['target'] == self.absolute(forbidden['target']) for edge in model['edges']))
        for prefix in self.oracle['forbidden_source_prefixes']:
            self.assertFalse(any(edge['source'].startswith(self.absolute(prefix)) for edge in model['edges']), prefix)
        # These lines are web/anchor/prose, and no explicit or inferred edge is allowed.
        self.assertFalse(any(edge['source'] == self.absolute('aurora/AGENTS.md') and edge['line'] in {13, 14, 15}
                             for edge in model['edges']))
        self.assertTrue(any(obj['type'] == 'skill' and obj['node'] == self.absolute('aurora/skills/triagem/SKILL.md')
                            for obj in model['objects']))
        self.assertEqual(nodes[self.absolute('aurora/memory/decisoes.md')]['kind'], 'memory')
        self.assertEqual(nodes[self.absolute('aurora/limites/grande.md')]['analysis'], 'skipped')
        # Repeatability is full-model equality, including deterministic evidence IDs.
        self.assertEqual(scan([self.absolute('aurora')]), model)
        self.assert_unchanged()

    def test_multiple_roots_deduplication_external_resolution_and_no_entry(self):
        roots = self.oracle['roots']
        model = scan([self.absolute(roots[key]) for key in ('primary', 'child', 'sibling', 'no_entry', 'primary')])
        self.assertEqual(len(model['roots']), 4)
        self.assertEqual(len(model['nodes']), len({node['id'] for node in model['nodes']}))
        child_root = next(root for root in model['roots'] if root['path'] == self.absolute(roots['child']))
        self.assertEqual(child_root['parent'], self.absolute('aurora'))
        self.assertEqual(child_root['level'], 2)
        child = next(node for node in model['nodes'] if node['path'] == self.absolute('aurora/equipes/pesquisa/AGENTS.md'))
        self.assertEqual(child['root'], self.absolute(roots['child']))
        self.assertEqual(set(child['roots']), {self.absolute(roots['primary']), self.absolute(roots['child'])})
        external = next(node for node in model['nodes'] if node['path'] == self.absolute('compartilhado/contrato.md'))
        self.assertEqual(external['status'], 'resolved')
        self.assertEqual(external['analysis'], 'parsed')
        self.assertTrue(any(issue['code'] == 'no-entry' and issue['node'] == self.absolute(roots['no_entry']) for issue in model['issues']))
        isolated = self.absolute('sem-entrada/isolado.md')
        self.assertFalse(find_path(model, self.absolute('aurora/AGENTS.md'), isolated, 'undirected')['found'])
        self.assert_unchanged()

    def test_workspace_reads_and_notes_stay_outside_sources(self):
        workspace = Workspace(self.parent / 'state')
        workspace.open(self.absolute('aurora'))
        entry = self.absolute('aurora/AGENTS.md')
        workspace.content(entry)
        workspace.content(self.absolute('aurora/hostil.md'))
        for forbidden in ('aurora/atalho.md', 'aurora/atalho-pasta/segredo-sintetico.md', 'sentinelas/segredo-sintetico.md', 'compartilhado/contrato.md'):
            with self.subTest(path=forbidden), self.assertRaises(ValueError):
                workspace.content(self.absolute(forbidden))
        workspace.note(entry, 'Anotação sintética fora das raízes.')
        restored = Workspace(self.parent / 'state')
        self.assertEqual(restored.snapshot()['notes'][entry], 'Anotação sintética fora das raízes.')
        self.assert_unchanged()

    def test_generator_refuses_existing_files_directories_links_and_invalid_parents(self):
        existing_file = self.parent / 'existing.txt'
        existing_file.write_text('PRESERVAR')
        empty = self.parent / 'empty'
        empty.mkdir()
        link = self.parent / 'link'
        link.symlink_to(empty, target_is_directory=True)
        dangling = self.parent / 'dangling'
        dangling.symlink_to(self.parent / 'missing')
        forbidden = (self.lab, existing_file, empty, link, dangling, link / 'new',
                     self.parent / 'missing' / 'new', existing_file / 'new', self.parent / '..' / 'unsafe')
        for destination in forbidden:
            with self.subTest(destination=destination), self.assertRaises((OSError, ValueError)):
                create_lab(destination)
        self.assertEqual(existing_file.read_text(), 'PRESERVAR')
        self.assertEqual(list(empty.iterdir()), [])
        self.assert_unchanged()

    def test_protected_path_guard_uses_only_a_synthetic_configuration(self):
        synthetic = self.parent / 'synthetic-protected'
        synthetic.mkdir()  # An entry must exist to count.
        with patch.dict(os.environ, {'AAE_PROTECTED_PATHS': str(synthetic)}):
            for path in (synthetic, synthetic / 'new'):
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'protected by'):
                    create_lab(path)
        self.assertEqual(list(synthetic.iterdir()), [])

    def test_fixture_content_is_reproducible_without_scanner(self):
        second = create_lab(self.parent / 'second')
        before, after = fingerprint(self.lab), fingerprint(second)
        # Time metadata belongs to integrity checking, not reproducible content.
        def stable(rows):
            return {path: {key: value for key, value in row.items() if key != 'mtime_ns'} for path, row in rows.items()}
        self.assertEqual(stable(before), stable(after))
        self.assertEqual((self.lab / 'oracle.json').read_bytes(), (second / 'oracle.json').read_bytes())
        self.assert_unchanged()


if __name__ == '__main__':
    unittest.main()
