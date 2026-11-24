"""Changes compares relations and findings only in the conditions of the reference.

The reading is joint: limits are shared among the opened roots, names resolve across them, and a nested root owns
its files. So the reference of each root keeps its context (the opened roots, in order), and relations and findings
of a root are compared only when the current reading has the same context; otherwise the root says they were not
compared, and why. Files are always compared. In the same context the comparison is the one of a joint reading,
including effects across opened roots. A file analysed in one reading only (text budget, size limit) has its
relations and findings not compared either. Disposable trees only; low limits by monkeypatch.
"""
from contextlib import nullcontext
import gzip
import itertools
import json
import os
from pathlib import Path
import random
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import delta as readings
import scanner
from workspace import Workspace

NO_FILES = {'added': 0, 'removed': 0, 'changed': 0}
NO_RELATIONS = {'added': 0, 'removed': 0}


def clock():
    counter = itertools.count()
    def now():
        tick = next(counter)
        return f'2026-10-02T{tick // 3600 % 24:02d}:{tick // 60 % 60:02d}:{tick % 60:02d}-03:00'
    return now


def write(base, files):
    for relative, text in files.items():
        path = base / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')


def affirmed(delta):
    """What a comparison affirms about relations and findings."""
    relations, findings = delta['relations'], delta['findings']
    return {'relations': {key: sorted((item['origin'], item['line'], item['raw']) for item in relations[key]) for key in ('added', 'removed')},
            'findings': {key: sorted((item['code'], item['node'] or '', str(item.get('target'))) for item in findings[key]) for key in ('new', 'resolved')}}


NOTHING = {'relations': {'added': [], 'removed': []}, 'findings': {'new': [], 'resolved': []}}


def contexts(delta):
    return {item['path']: item['context'] for item in delta['roots']}


def codes(delta, root):
    return sorted(item['code'] for item in delta['warnings'] if item['root'] == root)


class Case(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-changes-context-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        clock_patch = patch.object(readings, 'now', clock())
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        self.count = itertools.count()

    def tree(self, files):
        index = next(self.count)
        folder = self.base / f'tree{index}'
        write(folder, files)
        self.state = self.base / f'state{index}'
        return folder, Workspace(self.state)

    def limits(self, **values):
        for name, value in values.items():
            item = patch.object(scanner, name, value)
            item.start()
            self.addCleanup(item.stop)

    def assertNotCompared(self, delta, root, code='reference-context-changed'):
        self.assertEqual(contexts(delta)[root], 'changed' if code == 'reference-context-changed' else 'unknown')
        self.assertEqual(codes(delta, root), [code])


class AnotherRootOpened(Case):
    """Nothing changes on disk; the opened roots change. Nothing is affirmed about relations and findings."""

    NESTED = {
        'broken target in a nested root': {'a/AGENTS.md': '# A\n[P](node_modules/p/ausente.md)\n', 'a/node_modules/p/AGENTS.md': '# P\n'},
        'nested root reaches a document of the outer one': {
            'a/AGENTS.md': '# A\n', 'a/doc.md': '# Doc\n', 'a/node_modules/p/AGENTS.md': '# P\n[Doc](../../doc.md)\n'},
        'outer root without an entry': {'a/README.md': '# A\n', 'a/node_modules/p/AGENTS.md': '# P\n'},
        'outer root without an entry, with links': {
            'a/README.md': '# A\n[Doc](doc.md)\n', 'a/doc.md': '# Doc\n', 'a/node_modules/p/AGENTS.md': '# P\n'},
        'bare name resolved by search': {
            'a/AGENTS.md': '# A\nLeia `guia.md`.\n[[guia]]\n', 'a/docs/guia.md': '# Guia\n', 'a/node_modules/p/guia.md': '# Guia P\n',
            'a/node_modules/p/AGENTS.md': '# P\n[G](guia.md)\n'},
    }

    def steps(self, files, inner):
        """Open a, open `inner`, adopt, close `inner`, open it again: each step affirms nothing."""
        folder, ws = self.tree(files)
        a, nested = str(folder / 'a'), str(folder / inner)
        self.assertEqual(affirmed(ws.open(a)['delta']), NOTHING)
        delta = ws.open(nested)['delta']
        self.assertEqual(affirmed(delta), NOTHING)
        self.assertEqual(delta['files']['totals'], NO_FILES)
        self.assertNotCompared(delta, a)
        self.assertEqual(contexts(delta)[nested], 'same')
        ws.adopt_reference()
        delta = ws.close(nested)['delta']
        self.assertEqual(affirmed(delta), NOTHING)
        self.assertNotCompared(delta, a)
        # Back in the context of the reference: compared again, and empty.
        delta = ws.open(nested)['delta']
        self.assertEqual(affirmed(delta), NOTHING)
        self.assertEqual(set(contexts(delta).values()), {'same'})
        self.assertEqual(delta['warnings'], [])

    def test_a_nested_root_below_an_excluded_folder(self):
        for name, files in self.NESTED.items():
            with self.subTest(name):
                self.steps(files, 'a/node_modules/p')

    def test_a_nested_root_reached_by_the_outer_one_and_a_sibling(self):
        files = {'a/AGENTS.md': '# A\n[S](sub/AGENTS.md)\nLeia `guia.md`.\n', 'a/sub/AGENTS.md': '# S\n[G](guia.md)\n',
                 'a/sub/guia.md': '# G\n', 'b/AGENTS.md': '# B\n[A](../a/AGENTS.md)\n'}
        for inner in ('a/sub', 'b'):
            with self.subTest(inner):
                self.steps(files, inner)

    def test_shared_text_budget(self):
        self.limits(MAX_TEXT_TOTAL=100)
        files = {'a/AGENTS.md': '# A\n[D](docs/d.md)\n', 'a/docs/d.md': '# D\n[E](e.md)\nAAAA\n', 'a/docs/e.md': '# E\n',
                 'a/node_modules/p/AGENTS.md': '# P\n' + 'p' * 60 + '\n', 'b/AGENTS.md': '# B\n' + 'b' * 60 + '\n'}
        for inner in ('a/node_modules/p', 'b'):
            with self.subTest(inner):
                self.steps(files, inner)

    def test_shared_inventory_limit(self):
        self.limits(MAX_FILES=40)
        files = {'a/AGENTS.md': '# A\n[Z](z/f19.md)\n', **{f'a/z/f{index:02d}.md': '# F\n' for index in range(20)},
                 'a/sub/AGENTS.md': '# S\n', 'a/node_modules/p/AGENTS.md': '# P\n', 'b/AGENTS.md': '# B\n'}
        for inner in ('a/sub', 'a/node_modules/p', 'b'):
            with self.subTest(inner):
                self.steps(files, inner)

    def test_only_the_order_changes(self):
        self.limits(MAX_FILES=40)
        files = {'a/AGENTS.md': '# A\n[Z](z/f19.md)\n', **{f'a/z/f{index:02d}.md': '# F\n' for index in range(20)},
                 'b/AGENTS.md': '# B\n', **{f'b/y/g{index:02d}.md': '# G\n' for index in range(20)}}
        folder, ws = self.tree(files)
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        ws.open(b)
        ws.adopt_reference()
        delta = ws.reorder([b, a])['delta']
        self.assertEqual(affirmed(delta), NOTHING)
        self.assertEqual(contexts(delta), {a: 'changed', b: 'changed'})
        delta = ws.reorder([a, b])['delta']
        self.assertEqual(contexts(delta), {a: 'same', b: 'same'})
        self.assertEqual(affirmed(delta), NOTHING)

    def test_the_counts_say_nothing_was_compared(self):
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[X](x.md)\n', 'a/x.md': '# X\n', 'b/AGENTS.md': '# B\n'})
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        (folder / 'a' / 'AGENTS.md').write_text('# A\n', encoding='utf-8')
        delta = ws.open(b)['delta']
        # The file change shows; the relation it removed is not affirmed, and the delta says it was not compared.
        self.assertEqual([item['path'] for item in delta['files']['changed']], [str(folder / 'a' / 'AGENTS.md')])
        self.assertEqual(delta['relations']['totals'], NO_RELATIONS)
        self.assertEqual(delta['relations']['uncompared'], 0)
        self.assertEqual(delta['findings']['status'], 'inconclusive')
        self.assertNotCompared(delta, a)
        # Updating the baseline compares again, in the new context.
        delta = ws.adopt_reference()['delta']
        self.assertEqual(set(contexts(delta).values()), {'same'})
        self.assertEqual(delta['warnings'], [])


class SameContext(Case):
    """With the opened roots of the reference, in its order, the comparison is the one of the joint reading."""

    def test_a_real_change_shows_in_every_section(self):
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[X](x.md)\n', 'a/x.md': '# X\n', 'b/AGENTS.md': '# B\n'})
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        ws.open(b)
        ws.adopt_reference()
        (folder / 'a' / 'AGENTS.md').write_text('# A\n[X](x.md)\n[Y](y.md)\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        self.assertEqual([item['path'] for item in delta['files']['changed']], [str(folder / 'a' / 'AGENTS.md')])
        self.assertEqual(affirmed(delta)['relations']['added'], [(str(folder / 'a' / 'AGENTS.md'), 3, 'y.md')])
        self.assertEqual(affirmed(delta)['findings']['new'], [('broken', str(folder / 'a' / 'AGENTS.md'), 'y.md')])
        self.assertEqual(delta['warnings'], [])

    def test_an_effect_across_opened_roots_shows(self):
        # Deleting b/guia.md breaks the link of a/AGENTS.md, as the Audit of the same reading says.
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[G](../b/guia.md)\n', 'b/AGENTS.md': '# B\n[G](guia.md)\n', 'b/guia.md': '# G\n'})
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        ws.open(b)
        ws.adopt_reference()
        (folder / 'b' / 'guia.md').unlink()
        delta = ws.refresh()['delta']
        new = affirmed(delta)['findings']['new']
        self.assertIn(('broken', str(folder / 'a' / 'AGENTS.md'), '../b/guia.md'), new)
        self.assertEqual([item['path'] for item in delta['files']['removed']], [str(folder / 'b' / 'guia.md')])

    def test_a_nested_root_reached_by_the_outer_one_lists_a_line_once(self):
        # One written line in the nested root is one relation and one finding, as in the map and the Audit.
        files = {'a/AGENTS.md': '# A\n[S](sub/AGENTS.md)\n', 'a/docs/guia.md': '# G\n', 'a/sub/AGENTS.md': '# S\n'}
        folder, ws = self.tree(files)
        a, sub = str(folder / 'a'), str(folder / 'a' / 'sub')
        ws.open(a)
        ws.open(sub)
        ws.adopt_reference()
        (folder / 'a' / 'sub' / 'AGENTS.md').write_text('# S\nLeia `guia.md`.\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        self.assertEqual(delta['relations']['totals'], {'added': 1, 'removed': 0})
        self.assertEqual(delta['findings']['totals']['new'], 1)

    def test_a_restart_with_the_saved_references_compares(self):
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[X](x.md)\n', 'a/x.md': '# X\n', 'b/AGENTS.md': '# B\n'})
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        ws.open(b)
        ws.adopt_reference()
        restarted = Workspace(self.state).snapshot()['delta']
        self.assertEqual([item['referenceOrigin'] for item in restarted['roots']], ['persisted', 'persisted'])
        self.assertEqual(set(contexts(restarted).values()), {'same'})
        self.assertEqual(affirmed(restarted), NOTHING)
        (folder / 'a' / 'AGENTS.md').write_text('# A\n', encoding='utf-8')
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual(affirmed(delta)['relations']['removed'], [(str(folder / 'a' / 'AGENTS.md'), 2, 'x.md')])


class SavedContext(Case):
    """The context is saved with the reference; a missing or malformed one is unknown and never drops the reference."""

    def saved(self, root):
        path = self.state / readings.STORE / readings.ReferenceStore.name(root)
        return path, json.loads(gzip.decompress(path.read_bytes()))

    def rewrite(self, root, change):
        path, document = self.saved(root)
        change(document['reference'])
        path.write_bytes(gzip.compress(json.dumps(document).encode('ascii'), mtime=0))

    def test_the_saved_context_is_the_ordered_list_of_opened_roots(self):
        folder, ws = self.tree({'a/AGENTS.md': '# A\n', 'b/AGENTS.md': '# B\n'})
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(b)
        ws.open(a)
        self.assertEqual(self.saved(a)[1]['reference']['context'], [b, a])
        self.assertEqual(self.saved(b)[1]['reference']['context'], [b])

    def test_a_reference_of_an_earlier_version_compares_files_only_with_one_warning(self):
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[X](x.md)\n', 'a/x.md': '# X\n'})
        a = str(folder / 'a')
        ws.open(a)
        def earlier(reference):
            del reference['context']
            reference['reader'] = '0' * 16
        self.rewrite(a, earlier)
        (folder / 'a' / 'AGENTS.md').write_text('# A\n', encoding='utf-8')
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual(delta['roots'][0]['referenceOrigin'], 'persisted')
        self.assertEqual([item['path'] for item in delta['files']['changed']], [str(folder / 'a' / 'AGENTS.md')])
        self.assertEqual(affirmed(delta), NOTHING)
        # One warning, not two: the one about the rules of reading speaks only of what was not compared.
        self.assertNotCompared(delta, a, 'reference-context-unknown')

    def test_a_malformed_context_is_unknown_and_keeps_the_reference(self):
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[X](x.md)\n', 'a/x.md': '# X\n', 'b/AGENTS.md': '# B\n'})
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        values = {'not a list': a, 'empty': [], 'without the root': [b], 'relative': ['a'], 'not normalized': [a + '/../a'],
                  'repeated': [a, a], 'with a NUL': [a, b + '\x00'], 'not text': [a, 7], 'nested list': [a, [b]],
                  'too many': [a] + [f'{b}{index}' for index in range(scanner.MAX_ROOTS)], 'null': None}
        for name, value in values.items():
            with self.subTest(name):
                self.rewrite(a, lambda reference: reference.update(context=value))
                loaded, problem = readings.ReferenceStore(self.state).load(a)
                self.assertIsNone(problem)
                self.assertIsNone(loaded['context'])
                delta = Workspace(self.state).snapshot()['delta']
                self.assertNotCompared(delta, a, 'reference-context-unknown')
                self.assertEqual(affirmed(delta), NOTHING)

    def test_the_context_adds_little_to_the_saved_file(self):
        folder, ws = self.tree({**{f'a/d{index}.md': f'# D\n[N](d{index + 1}.md)\n' for index in range(50)}, 'b/AGENTS.md': '# B\n'})
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        ws.open(b)
        _, document = self.saved(b)
        stored = len(json.dumps(document['reference'], separators=(',', ':')))
        without = len(json.dumps({key: value for key, value in document['reference'].items() if key != 'context'}, separators=(',', ':')))
        self.assertLessEqual(stored - without, len(a) + len(b) + 20)


class AnalysedOnOneSide(Case):
    """A file analysed in one reading only: what it writes is missing from the other one, not from the disk."""

    FILES = {'a/AGENTS.md': '# A\n[D](docs/d.md)\n', 'a/docs/d.md': '# D\n[E](e.md)\n[X](ausente.md)\n', 'a/docs/e.md': '# E\n',
             'b/AGENTS.md': '# B\n', 'b/z.md': '# Z\n'}

    def test_another_root_grows_past_the_shared_text_budget(self):
        self.limits(MAX_TEXT_TOTAL=120)
        folder, ws = self.tree(self.FILES)
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        ws.open(b)
        ws.adopt_reference()
        (folder / 'b' / 'AGENTS.md').write_text('# B\n' + 'x' * 70 + '\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        self.assertIsNone(ws.current[a]['files']['docs/d.md']['sha256'])
        self.assertIn('[E](e.md)', (folder / 'a' / 'docs' / 'd.md').read_text(encoding='utf-8'))
        self.assertEqual(delta['relations']['totals'], NO_RELATIONS)
        self.assertEqual(delta['relations']['unanalysed'], 2)
        self.assertNotIn('broken', [item['code'] for item in delta['findings']['resolved']])
        self.assertEqual(delta['findings']['unanalysed'], 1)
        # The finding about the budget itself is a fact of the reading, and is new.
        self.assertIn('limit', [item['code'] for item in delta['findings']['new']])

    def test_one_root_whose_own_file_grows(self):
        self.limits(MAX_TEXT_TOTAL=120)
        folder, ws = self.tree(self.FILES)
        a = str(folder / 'a')
        ws.open(a)
        (folder / 'a' / 'AGENTS.md').write_text('# A\n[D](docs/d.md)\n' + 'x' * 85 + '\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        self.assertIsNone(ws.current[a]['files']['docs/d.md']['sha256'])
        self.assertEqual(delta['relations']['totals'], NO_RELATIONS)
        self.assertEqual(delta['relations']['unanalysed'], 2)
        # Back under the budget: analysed on both sides again, nothing to say.
        (folder / 'a' / 'AGENTS.md').write_text('# A\n[D](docs/d.md)\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        self.assertEqual(affirmed(delta), NOTHING)
        self.assertEqual(delta['relations']['unanalysed'], 0)

    def test_a_file_past_the_size_limit_keeps_its_limit_finding(self):
        self.limits(MAX_BYTES=60)
        folder, ws = self.tree(self.FILES)
        a = str(folder / 'a')
        ws.open(a)
        (folder / 'a' / 'docs' / 'd.md').write_text('# D\n[E](e.md)\n[X](ausente.md)\n' + 'y' * 60 + '\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        self.assertEqual([item['path'] for item in delta['files']['changed']], [str(folder / 'a' / 'docs' / 'd.md')])
        self.assertEqual(delta['relations']['totals'], NO_RELATIONS)
        self.assertEqual(delta['relations']['unanalysed'], 2)
        self.assertIn(('limit', str(folder / 'a' / 'docs' / 'd.md')), [(item['code'], item['node']) for item in delta['findings']['new']])

    def test_a_symbolic_link_that_becomes_a_file_is_a_real_change(self):
        # A link has neither hash nor size: it was never left out of the analysis, so its relations are compared.
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[D](doc.md)\n', 'a/doc.md': '# Doc\n'})
        a = str(folder / 'a')
        os.symlink('AGENTS.md', folder / 'a' / 'CLAUDE.md')
        ws.open(a)
        (folder / 'a' / 'CLAUDE.md').unlink()
        (folder / 'a' / 'CLAUDE.md').write_text('@AGENTS.md\n[Q](nada.md)\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        claude = str(folder / 'a' / 'CLAUDE.md')
        self.assertEqual(affirmed(delta)['relations']['added'], [(claude, 1, 'AGENTS.md'), (claude, 2, 'nada.md')])
        self.assertIn(('broken', claude, 'nada.md'), affirmed(delta)['findings']['new'])
        self.assertEqual((delta['relations']['unanalysed'], delta['findings']['unanalysed']), (0, 0))

    def test_a_file_that_becomes_a_symbolic_link_is_a_real_change(self):
        folder, ws = self.tree({'a/AGENTS.md': '# A\n[G](guia.md)\n', 'a/guia.md': '# Guia\n[D](doc.md)\n[Q](nada.md)\n', 'a/doc.md': '# Doc\n'})
        a = str(folder / 'a')
        ws.open(a)
        (folder / 'a' / 'guia.md').unlink()
        os.symlink('doc.md', folder / 'a' / 'guia.md')
        delta = ws.refresh()['delta']
        guide = str(folder / 'a' / 'guia.md')
        self.assertEqual(affirmed(delta)['relations']['removed'], [(guide, 2, 'doc.md'), (guide, 3, 'nada.md')])
        self.assertIn(('broken', guide, 'nada.md'), affirmed(delta)['findings']['resolved'])
        self.assertEqual((delta['relations']['unanalysed'], delta['findings']['unanalysed']), (0, 0))

    def test_a_real_removal_in_a_file_analysed_on_both_sides_still_shows(self):
        self.limits(MAX_TEXT_TOTAL=120)
        folder, ws = self.tree(self.FILES)
        a, b = str(folder / 'a'), str(folder / 'b')
        ws.open(a)
        ws.open(b)
        ws.adopt_reference()
        (folder / 'a' / 'docs' / 'd.md').write_text('# D\n[X](ausente.md)\n', encoding='utf-8')
        delta = ws.refresh()['delta']
        self.assertEqual(affirmed(delta)['relations']['removed'], [(str(folder / 'a' / 'docs' / 'd.md'), 2, 'e.md')])
        self.assertEqual(delta['relations']['unanalysed'], 0)


class Property(Case):
    """Random sequences of opening, closing, reordering, rereading, adopting and restarting, under low limits."""

    FILES = {'a/AGENTS.md': '# A\n[D](docs/d.md)\n[S](sub/AGENTS.md)\nLeia `guia.md`.\n[B](../b/AGENTS.md)\n',
             'a/docs/d.md': '# D\n[E](e.md)\n[X](ausente.md)\n', 'a/docs/e.md': '# E\n', 'a/docs/guia.md': '# G\n',
             'a/sub/AGENTS.md': '# S\n[G](guia.md)\n', 'a/sub/deep/AGENTS.md': '# Deep\n',
             'a/node_modules/p/AGENTS.md': '# P\n[D](../../docs/d.md)\n', 'b/AGENTS.md': '# B\n[A](../a/docs/e.md)\n',
             **{f'b/y/g{index:02d}.md': '# G\n' for index in range(8)}, 'c/README.md': '# C\n'}
    ROOTS = ('a', 'a/sub', 'a/sub/deep', 'a/node_modules/p', 'b', 'c')
    LIMITS = ({}, {'MAX_FILES': 24}, {'MAX_TEXT_TOTAL': 150}, {'MAX_FILES': 30, 'MAX_TEXT_TOTAL': 200}, {'MAX_LOOKUP': 4})
    MUTATIONS = (('a/docs/d.md', '# D\n[E](e.md)\n'), ('a/sub/AGENTS.md', '# S\n[G](guia.md)\n[N](novo.md)\n'),
                 ('b/AGENTS.md', '# B\n'), ('a/docs/guia.md', None), ('c/README.md', '# C\n[A](../a/AGENTS.md)\n' + 'c' * 80 + '\n'))

    @staticmethod
    def joint(references, current, model):
        """The joint comparison without the context rule and the analysis mark."""
        with patch.object(readings, '_context', lambda reference, compact: 'same'), \
                patch.object(readings, '_half_analysed', lambda reference, compact: lambda path: False):
            return readings.compare(references, current, model)

    def assertJoint(self, delta, ws, roots, note):
        """`delta` affirms what the joint comparison of `roots` affirms, less what comes from a file analysed in
        one reading only (the mark), and nothing else."""
        if not roots:
            self.assertEqual(affirmed(delta), NOTHING, note)
            return
        expected = affirmed(self.joint({root: ws.references[root] for root in roots}, {root: ws.current[root] for root in roots}, ws.model))
        half = set()
        for root in roots:
            old, new = ws.references[root]['files'], ws.current[root]['files']
            half.update(readings._absolute(path, root) for path in set(old) & set(new) if (old[path]['sha256'] is None) != (new[path]['sha256'] is None))
        actual = affirmed(delta)
        for group, lists in expected.items():
            for key, items in lists.items():
                self.assertLessEqual(set(actual[group][key]), set(items), note)
                for item in set(items) - set(actual[group][key]):
                    self.assertIn(item[0] if group == 'relations' else item[1], half, (note, item))
                    if group == 'findings':
                        self.assertNotIn(item[0], readings.ANALYSIS_CODES, (note, item))

    def run_sequence(self, rng, mutate):
        folder, ws = self.tree(self.FILES)
        roots = [str(folder / name) for name in self.ROOTS]
        ws.open(rng.choice(roots))
        for _ in range(14):
            opened = [item['path'] for item in ws.model['roots']]
            action = rng.choice(('open', 'open', 'close', 'reorder', 'refresh', 'adopt', 'restart', 'mutate' if mutate else 'refresh'))
            if action == 'open' and len(opened) < len(roots):
                ws.open(rng.choice([root for root in roots if root not in opened]))
            elif action == 'close' and len(opened) > 1:
                ws.close(rng.choice(opened))
            elif action == 'reorder' and len(opened) > 1:
                ws.reorder(rng.sample(opened, len(opened)))
            elif action == 'adopt':
                ws.adopt_reference()
            elif action == 'restart':
                ws = Workspace(self.state)
            elif action == 'mutate':
                relative, text = rng.choice(self.MUTATIONS)
                target = folder / relative
                if text is None:
                    if target.exists():
                        target.unlink()
                else:
                    write(folder, {relative: text})
                ws.refresh()
            else:
                ws.refresh()
            delta = ws.snapshot()['delta']
            state = contexts(delta)
            for root, compact in ws.current.items():
                expected = 'same' if ws.references[root].get('context') == compact['context'] else 'changed'
                self.assertEqual(state[root], expected)
                self.assertEqual(compact['context'], [item['path'] for item in ws.model['roots']])
            if not mutate:
                # The disk never changed since the first reading: anything affirmed would be false.
                self.assertEqual(affirmed(delta), NOTHING, (action, state))
                self.assertEqual(delta['files']['totals'], NO_FILES)
            else:
                # Only roots in the context of their reference speak, and they say what the joint comparison says.
                self.assertJoint(delta, ws, [root for root, value in state.items() if value == 'same'], (action, state))

    def test_nothing_is_affirmed_when_the_disk_does_not_change(self):
        rng = random.Random(80)
        for index in range(36):
            limits = self.LIMITS[index % len(self.LIMITS)]
            with self.subTest(sequence=index, limits=limits), patch.multiple(scanner, **limits) if limits else nullcontext():
                self.run_sequence(rng, mutate=False)

    def test_in_the_same_context_the_comparison_is_the_joint_one(self):
        rng = random.Random(81)
        for index in range(36):
            limits = self.LIMITS[index % len(self.LIMITS)]
            with self.subTest(sequence=index, limits=limits), patch.multiple(scanner, **limits) if limits else nullcontext():
                self.run_sequence(rng, mutate=True)


if __name__ == '__main__':
    unittest.main()
