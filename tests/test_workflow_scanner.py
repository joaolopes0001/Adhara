"""Production-like document maintenance using a disposable fictional agent."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from scanner import find_path, scan


class WorkflowScannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-workflow-scanner-')
        self.root = Path(self.temp.name) / 'atlas-agent'
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return str(path)

    def test_retired_explicit_wiki_path_never_redirects_to_same_basename(self):
        entry = self.write('AGENTS.md', '# Atlas agent\n[[retired/runbook]]\n[[./runbook]]\n')
        decoy = self.write('operations/runbook.md', '# Current operations\n')
        model = scan([str(self.root)])
        self.assertFalse(find_path(model, entry, decoy)['found'])
        self.assertEqual({e['target'] for e in model['edges']},
                         {str(self.root / 'retired/runbook'), str(self.root / 'runbook')})
        self.assertEqual([i['line'] for i in model['issues'] if i['code'] == 'broken'], [2, 3])
        # Repair the exact requested locations, then remove one during maintenance.
        intended = self.write('retired/runbook.md', '# Retired procedure\n')
        local = self.write('runbook.md', '# Local procedure\n')
        repaired = scan([str(self.root)])
        self.assertEqual({e['target'] for e in repaired['edges']}, {intended, local})
        self.assertFalse(any(i['code'] in {'broken', 'ambiguous'} for i in repaired['issues']))
        Path(intended).unlink()
        removed = scan([str(self.root)])
        self.assertFalse(find_path(removed, entry, decoy)['found'])
        self.assertEqual([i['line'] for i in removed['issues'] if i['code'] == 'broken'], [2])

    def test_opening_child_root_keeps_parent_wiki_candidates_and_ambiguity(self):
        entry = self.write('AGENTS.md', '# Atlas agent\n[[runbook]]\n')
        target = self.write('operations/runbook.md', '# Operations\n')
        self.write('operations/AGENTS.md', '# Operations agent\n')
        child = self.root / 'operations'
        original = scan([str(self.root)])
        expected = next(e for e in original['edges'] if e['kind'] == 'wiki')
        for roots in [[self.root, child], [child, self.root]]:
            with self.subTest(roots=roots):
                model = scan([str(p) for p in roots])
                self.assertEqual([e for e in model['edges'] if e['kind'] == 'wiki'], [expected])
                self.assertEqual(find_path(model, entry, target)['nodes'], [entry, target])
        self.write('compliance/runbook.md', '# Different runbook\n')
        for roots in [[self.root], [self.root, child], [child, self.root]]:
            with self.subTest(ambiguous_roots=roots):
                model = scan([str(p) for p in roots])
                self.assertFalse(any(e['kind'] == 'wiki' for e in model['edges']))
                self.assertEqual([(i['node'], i['line']) for i in model['issues'] if i['code'] == 'ambiguous'], [(entry, 2)])

    def test_unresolved_markdown_node_does_not_override_later_wiki_resolution(self):
        target = self.write('operations/runbook.md', '# Operations\n')
        documents = ['[Missing literal](runbook)\n[[runbook]]\n', '[[runbook]]\n[Missing literal](runbook)\n']
        for index, document in enumerate(documents):
            with self.subTest(document=document):
                entry = self.write('AGENTS.md', document)
                model = scan([str(self.root)])
                self.assertEqual({(e['kind'], e['target']) for e in model['edges']},
                                 {('markdown', str(self.root / 'runbook')), ('wiki', target)})
                # A link to a word without extension is reported as a name, not a broken path.
                self.assertEqual([i['line'] for i in model['issues'] if i['code'] == 'unresolved-name'], [index + 1])
                self.assertFalse([i for i in model['issues'] if i['code'] == 'broken'])
                self.assertEqual(find_path(model, entry, target)['nodes'], [entry, target])

    def test_unresolved_markdown_node_is_not_a_wiki_extension_candidate(self):
        # A missing .md node is also not an inventoried Markdown candidate.
        self.write('AGENTS.md', '[Missing extension](ghost.md)\n[[ghost]]\n')
        model = scan([str(self.root)])
        self.assertEqual([(e['kind'], e['target']) for e in model['edges']],
                         [('markdown', str(self.root / 'ghost.md')), ('wiki', str(self.root / 'ghost'))])
        self.assertEqual([i['line'] for i in model['issues'] if i['code'] == 'broken'], [1, 2])

    def test_wiki_search_stays_inside_own_scope_and_separate_roots_do_not_pollute_it(self):
        source = self.write('operations/AGENTS.md', '[[runbook]]\n[[outside-only]]\n')
        target = self.write('operations/manuals/runbook.md', '# Operations\n')
        decoy = self.write('compliance/runbook.md', '# Compliance\n')
        outside = self.temp.name + '/separate-agent'
        Path(outside).mkdir()
        (Path(outside) / 'runbook.md').write_text('# Unrelated runbook\n')
        (Path(outside) / 'outside-only.md').write_text('# Outside-only\n')
        model = scan([str(self.root), str(self.root / 'operations'), outside])
        edges = [e for e in model['edges'] if e['source'] == source]
        self.assertEqual([e['target'] for e in edges], [target, str(self.root / 'operations/outside-only')])
        self.assertFalse(find_path(model, source, decoy)['found'])
        self.assertFalse(any(i['code'] == 'ambiguous' for i in model['issues']))
        self.assertEqual([i['line'] for i in model['issues'] if i['code'] == 'broken'], [2])

    def test_explicit_wiki_paths_resolve_exact_relative_and_absolute_targets(self):
        target = self.write('operations/runbook.md', '# Operations\n')
        self.write('compliance/runbook.md', '# Same basename, different procedure\n')
        source = self.write('AGENTS.md', f'[[operations/runbook]]\n[[operations%2Frunbook]]\n[[{target[:-3]}]]\n')
        model = scan([str(self.root)])
        self.assertEqual([(e['source'], e['target'], e['line']) for e in model['edges']],
                         [(source, target, line) for line in [1, 2, 3]])
        self.assertFalse(any(i['code'] in {'broken', 'ambiguous'} for i in model['issues']))


if __name__ == '__main__':
    unittest.main()
