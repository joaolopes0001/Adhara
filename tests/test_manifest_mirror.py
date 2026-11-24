"""A manifest with `"linkedRelationships": true`: its relationships and the explicit links between its
objects are compared (`manifest-mismatch`), and the relationships of any manifest never count as
repeated references. Disposable trees only; each rule has its negative control next to it.
"""
import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / 'server'))
from server import cli  # noqa: E402
import audit  # noqa: E402
import delta as readings  # noqa: E402
from scanner import references, scan  # noqa: E402
from workspace import Workspace  # noqa: E402

ABSENT = object()  # the field is not written at all
CODE = 'manifest-mismatch'


def manifest(objects, relations, linked=True, **extra):
    """An agent-architecture.json as the creation writes it: one field per line (indent=2)."""
    data = {'version': 1, **extra}
    if linked is not ABSENT:
        data['linkedRelationships'] = linked
    data['objects'] = [{'name': Path(path).stem, 'type': 'document', 'path': path} for path in objects]
    data['relationships'] = [{'source': s, 'target': t, **({'type': v} if v else {})} for s, t, v in relations]
    return json.dumps(data, indent=2) + '\n'


def node(name, *relations):
    return f'# {name}\n\n## Relations\n\n' + ('\n'.join(relations) or 'None yet.') + '\n'


BASE = {
    'AGENTS.md': '# Entrada\n[Manifesto](agent-architecture.json)\n[a](a/a.md)\n[b](b/b.md)\n[c](c/c.md)\n',
    'a/a.md': node('a', '- reads: [b](../b/b.md)'),
    'b/b.md': node('b'),
    'c/c.md': node('c'),
    'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads')]),
}


class MirrorCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-mirror-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'pacote'

    def write(self, files, root=None):
        root = Path(root or self.root)
        for relative, text in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(text, bytes):
                path.write_bytes(text)
            else:
                path.write_text(text, encoding='utf-8')
        return root

    def tree(self, changes=None):
        """BASE with files replaced (a value of None leaves the file out); a file written before stays."""
        files = {**BASE, **(changes or {})}
        return self.write({key: value for key, value in files.items() if value is not None})

    def model(self, *roots):
        return scan([str(root) for root in roots or [self.root]])

    def mismatches(self, model):
        return [item for item in model['issues'] if item['code'] == CODE]

    def brief(self, model, root=None):
        root = Path(root or self.root)
        return [(os.path.relpath(item['node'], root), item['line'], item['target'], item['absent']) for item in self.mismatches(model)]

    def line_of(self, relative, text, root=None):
        lines = (Path(root or self.root) / relative).read_text(encoding='utf-8').splitlines()
        return next(index for index, line in enumerate(lines, 1) if text in line)


class VerifierTests(MirrorCase):
    def test_relation_without_link_is_reported_on_the_relationship_line(self):
        self.tree({'a/a.md': node('a')})
        model = self.model()
        (item,) = self.mismatches(model)
        manifest_path = str(self.root / 'agent-architecture.json')
        self.assertEqual(item['node'], manifest_path)
        self.assertEqual(item['line'], self.line_of('agent-architecture.json', '"source": "a/a.md"'))
        self.assertEqual((item['target'], item['absent']), ('a/a.md → b/b.md', 'link'))
        self.assertEqual((item['from'], item['to'], item['manifest']), (str(self.root / 'a/a.md'), str(self.root / 'b/b.md'), manifest_path))
        self.assertEqual(item['evidence'], 'a/a.md → b/b.md (reads)')
        # The evidence is the declared relation of that line: the interface opens it from the observation.
        declared = [edge for edge in model['edges'] if edge['kind'] == 'declared' and edge['line'] == item['line']]
        self.assertEqual([(edge['source'], edge['target']) for edge in declared], [(item['from'], item['to'])])
        # Nothing else in the reading: the observation is the only change.
        self.assertEqual([issue['code'] for issue in model['issues']], [CODE])

    def test_link_between_objects_without_relation_is_reported_on_the_link_line(self):
        self.tree({'c/c.md': node('c', '- references: [a](../a/a.md)')})
        model = self.model()
        (item,) = self.mismatches(model)
        self.assertEqual((item['node'], item['line']), (str(self.root / 'c/c.md'), self.line_of('c/c.md', '[a](../a/a.md)')))
        self.assertEqual((item['target'], item['absent'], item['syntax']), ('../a/a.md', 'relation', 'markdown'))
        self.assertEqual((item['from'], item['to']), (str(self.root / 'c/c.md'), str(self.root / 'a/a.md')))
        self.assertEqual(item['evidence'], '- references: [a](../a/a.md)')
        self.assertIn('../agent-architecture.json', item['message'])
        # The link is the edge of that line, matched by its written target.
        self.assertTrue(any(edge['origin'] == item['node'] and edge['line'] == item['line'] and edge['raw'] == item['target'] for edge in model['edges']))

    def test_only_the_boolean_true_turns_the_check_on(self):
        divergent = {'a/a.md': node('a'), 'c/c.md': node('c', '- references: [a](../a/a.md)')}
        self.tree(divergent)
        self.assertEqual(len(self.mismatches(self.model())), 2)
        reference = [item for item in self.model()['issues'] if item['code'] != CODE]
        for value in (ABSENT, False, 'true', 1, None, 'yes', [True], {'on': True}):
            with self.subTest(value=value):
                self.tree({**divergent, 'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads')], linked=value)})
                model = self.model()
                self.assertEqual(self.mismatches(model), [])
                # No other observation either: an odd value is no `manifest` finding.
                self.assertEqual([(i['code'], i['node'], i['line']) for i in model['issues']], [(i['code'], i['node'], i['line']) for i in reference])

    def test_the_verb_is_not_compared(self):
        self.tree({'a/a.md': node('a', '- references: [b](../b/b.md)')})
        self.assertEqual(self.mismatches(self.model()), [])
        self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', None)])})
        self.assertEqual(self.mismatches(self.model()), [])

    def test_links_to_files_that_are_not_objects_and_objects_without_relations(self):
        self.tree({'c/c.md': node('c', '- references: [entrada](../AGENTS.md)', '- references: [solto](../solto.md)'),
                   'solto.md': '# solto\n[a](a/a.md)\n'})
        self.assertEqual(self.mismatches(self.model()), [])
        # The entry links every object and is no object: nothing to compare there.
        self.assertTrue(any(edge['source'] == str(self.root / 'AGENTS.md') and edge['target'] == str(self.root / 'c/c.md') for edge in self.model()['edges']))

    def test_every_explicit_syntax_counts_and_a_fenced_link_does_not(self):
        for name, text in {
            'markdown': '[b](../b/b.md)',
            'reference link': '[b][ref]\n\n[ref]: ../b/b.md',
            'wikilink': '[[b]]',
            'path in backticks': 'Read `../b/b.md` first.',
            'path in prose': 'Read ../b/b.md first.',
            'import': '@../b/b.md',
        }.items():
            with self.subTest(syntax=name):
                self.tree({'a/a.md': node('a', text)})
                model = self.model()
                self.assertTrue(any(edge['source'] == str(self.root / 'a/a.md') and edge['target'] == str(self.root / 'b/b.md') for edge in model['edges']))
                self.assertEqual(self.mismatches(model), [])
        for fence in ('```\n[b](../b/b.md)\n```', '```md\n[b](../b/b.md)\n```', '~~~\n@../b/b.md\n~~~'):
            with self.subTest(fence=fence):
                self.tree({'a/a.md': node('a', fence)})
                model = self.model()
                # The reader keeps a resolved reference of a fenced block as a relation; the check does not count it.
                self.assertTrue(any(edge['source'] == str(self.root / 'a/a.md') and edge['target'] == str(self.root / 'b/b.md') for edge in model['edges']))
                self.assertEqual(self.brief(model), [('agent-architecture.json', self.line_of('agent-architecture.json', '"source": "a/a.md"'), 'a/a.md → b/b.md', 'link')])
        # A fenced link between two objects without a relation is an example, not a link.
        self.tree({'c/c.md': node('c', '```md\n- references: [a](../a/a.md)\n```')})
        self.assertEqual(self.mismatches(self.model()), [])

    def test_a_missing_relationship_path_stays_broken(self):
        for linked in (True, ABSENT):
            with self.subTest(linked=linked):
                self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'b/sumiu.md', 'reads')], linked=linked)})
                model = self.model()
                broken = [(i['line'], i['target'], i['syntax']) for i in model['issues'] if i['code'] == 'broken']
                self.assertEqual(broken, [(self.line_of('agent-architecture.json', 'sumiu'), 'b/sumiu.md', 'manifest')])
                # With the field, the relationship also has no link: both facts are reported.
                self.assertEqual([item['target'] for item in self.mismatches(model)], ['a/a.md → b/sumiu.md'] if linked is True else [])

    def test_the_field_only_adds_manifest_mismatch(self):
        files = {'a/a.md': node('a', '- reads: [b](../b/b.md)', '- uses: [c](../c/c.md)'), 'c/c.md': node('c', '- x: [a](../a/a.md)'),
                 'b/b.md': node('b', '[[falta]]', '`../nada/x.md`')}
        readings_ = {}
        for linked in (True, False, ABSENT):
            self.tree({**files, 'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('b/b.md', 'c/c.md', 'reads')], linked=linked)})
            readings_[linked] = self.model()
        on, off = readings_[True], readings_[False]
        self.assertEqual(sorted(i['target'] for i in self.mismatches(on)), ['../a/a.md', '../c/c.md', 'b/b.md → c/c.md'])
        # `false` keeps every line where it was: the reading is the same, value for value.
        self.assertEqual([i for i in on['issues'] if i['code'] != CODE], off['issues'])
        self.assertEqual(on['edges'], off['edges'])
        self.assertEqual(on['signals'], off['signals'])
        self.assertEqual(on['stats'], off['stats'])
        # Without the field the manifest has one line less; the rest is the same.
        def facts(model):
            return ([(i['code'], i['node'], i.get('target')) for i in model['issues'] if i['code'] != CODE],
                    [(e['source'], e['target'], e['kind'], e['raw']) for e in model['edges']], [s['code'] for s in model['signals']])
        self.assertEqual(facts(on), facts(readings_[ABSENT]))


class RepetitionTests(MirrorCase):
    def test_relationships_are_no_repeated_reference_with_or_without_the_field(self):
        for linked in (True, ABSENT):
            with self.subTest(linked=linked):
                self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'c/c.md', 'uses')], linked=linked),
                           'a/a.md': node('a', '- reads: [b](../b/b.md)', '- uses: [c](../c/c.md)')})
                model = self.model()
                self.assertEqual(model['signals'], [])
                self.assertEqual(model['stats']['structure']['repeatedReferences'], 0)
                # The relationships are still read: declared edges and the manifest's references to its ends.
                self.assertEqual(sum(edge['kind'] == 'declared' for edge in model['edges']), 2)
                self.assertEqual(sum(edge['kind'] == 'manifest' and edge['target'] == str(self.root / 'a/a.md') for edge in model['edges']), 3)

    def test_real_repetitions_stay_signals(self):
        # A node citing the same file on two lines, and an object listed twice in `objects`.
        self.tree({'a/a.md': node('a', '- reads: [b](../b/b.md)', 'Again: [b](../b/b.md)'),
                   'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads')])})
        model = self.model()
        repeated = sorted((os.path.relpath(s['node'], self.root), s['count']) for s in model['signals'] if s['code'] == 'repeated-reference')
        self.assertEqual(repeated, [('a/a.md', 2), ('agent-architecture.json', 2)])
        # The signal names its first counted location, never the declared relation.
        (signal,) = [s for s in model['signals'] if s['node'] == str(self.root / 'a/a.md')]
        self.assertEqual(signal['line'], self.line_of('a/a.md', '- reads:'))

    def test_a_cycle_keeps_the_anchor_of_the_main_reader(self):
        # Links a <-> b and the relationships a -> b and b -> a, without the field. The cycle keeps
        # its evidence where it always was, the first relation of the pair (the declared one, read first).
        for linked in (ABSENT, True):
            with self.subTest(linked=linked):
                self.tree({'a/a.md': node('a', '[b](../b/b.md)'), 'b/b.md': node('b', '[a](../a/a.md)'),
                           'agent-architecture.json': manifest(['a/a.md', 'b/b.md'], [('a/a.md', 'b/b.md', 'reads'), ('b/b.md', 'a/a.md', 'reads')], linked=linked)})
                model = self.model()
                (cycle,) = [s for s in model['signals'] if s['code'] == 'cycle']
                self.assertEqual((cycle['node'], cycle['line']), (str(self.root / 'agent-architecture.json'), self.line_of('agent-architecture.json', '"source": "a/a.md"')))
                self.assertEqual([s['code'] for s in model['signals']], ['cycle'])

    def test_a_compact_manifest_and_a_relationship_written_with_dots(self):
        compact = json.dumps({'linkedRelationships': True, 'objects': [{'path': 'a/a.md'}, {'path': 'b/b.md'}, {'path': 'c/c.md'}],
                              'relationships': [{'source': './a/a.md', 'target': './b/b.md'}, {'source': 'a/a.md', 'target': 'c/c.md'}]})
        self.tree({'agent-architecture.json': compact, 'a/a.md': node('a', '[b](../b/b.md)', '[c](../c/c.md)')})
        model = self.model()
        self.assertEqual(model['signals'], [])
        self.assertEqual(self.mismatches(model), [])


class NegativeTests(MirrorCase):
    def test_a_source_too_large_is_not_affirmed(self):
        self.tree({'a/a.md': '# a\n' + 'x' * (1024 * 1024 + 10) + '\n'})
        model = self.model()
        self.assertIn(('limit', str(self.root / 'a/a.md')), [(i['code'], i['node']) for i in model['issues']])
        self.assertEqual(self.mismatches(model), [])

    def test_a_source_past_the_inventory_is_not_affirmed(self):
        self.tree({'a/a.md': None, 'agent-architecture.json': manifest(['fundo/x/y/a.md', 'b/b.md'], [('fundo/x/y/a.md', 'b/b.md', 'reads')])})
        self.write({'fundo/x/y/a.md': node('a')})
        with patch('scanner.MAX_FILES', 9):
            model = self.model()
        nodes = {n['id']: n for n in model['nodes']}
        source = str(self.root / 'fundo/x/y/a.md')
        self.assertEqual(nodes[source]['status'], 'unscanned')
        self.assertEqual(nodes[str(self.root / 'agent-architecture.json')]['analysis'], 'parsed')
        self.assertEqual(self.mismatches(model), [])
        # The same tree read whole: the relationship has no link.
        self.assertEqual(len(self.mismatches(self.model())), 1)

    def test_a_source_in_a_folder_the_reader_does_not_read(self):
        self.write({'node_modules/a.md': node('a'), 'real/a.md': node('a')})
        (self.root / 'atalho').symlink_to(self.root / 'real', target_is_directory=True)
        for source in ('node_modules/a.md', 'atalho/a.md'):
            with self.subTest(source=source):
                self.tree({'agent-architecture.json': manifest([source, 'b/b.md'], [(source, 'b/b.md', 'reads')])})
                model = self.model()
                self.assertEqual({n['id']: n for n in model['nodes']}[str(self.root / source)]['status'], 'unscanned')
                self.assertEqual(self.mismatches(model), [])

    def test_an_ambiguous_link_silences_only_the_pairs_of_its_candidates(self):
        # An ambiguity whose candidates are not the destination of the relationship silences nothing.
        # Cases: a bare `README.md` with two homonyms, and a bare wikilink.
        for text in ('Veja `README.md`.', '[[guia]]', '[nota](nota.md)'):
            with self.subTest(text=text):
                self.tree({'a/a.md': node('a', text), 'x/README.md': '# x\n', 'y/README.md': '# y\n', 'x/guia.md': '# x\n',
                           'y/guia.md': '# y\n', 'x/nota.md': '# x\n', 'y/nota.md': '# y\n'})
                model = self.model()
                self.assertIn('ambiguous', [i['code'] for i in model['issues']])
                self.assertEqual([(i['target'], i['absent']) for i in self.mismatches(model)], [('a/a.md → b/b.md', 'link')])
        # The destination is one of the candidates: the link may be that one, nothing is affirmed.
        self.tree({'a/a.md': node('a', '[b](b.md)'), 'x/b.md': '# outro b\n'})
        model = self.model()
        (ambiguous,) = [i for i in model['issues'] if i['code'] == 'ambiguous']
        self.assertIn(str(self.root / 'b/b.md'), ambiguous['candidates'])
        self.assertEqual(self.mismatches(model), [])
        # More candidates than the reader lists: any of them may be the destination.
        self.tree({'a/a.md': node('a', '[n](n.md)'), **{f'h{i:02}/n.md': '# n\n' for i in range(25)}})
        model = self.model()
        (ambiguous,) = [i for i in model['issues'] if i['code'] == 'ambiguous']
        self.assertEqual((len(ambiguous['candidates']), ambiguous['candidatesTotal']), (20, 25))
        self.assertEqual(self.mismatches(model), [])
        # In a fenced block the same text is no link: the relationship has none.
        self.tree({'a/a.md': node('a', '```md\n[b](b.md)\n```')})
        self.assertEqual(len(self.mismatches(self.model())), 1)

    def test_a_link_or_an_end_through_a_symbolic_link_is_not_affirmed(self):
        # A link through a folder link, a link to a file link and a relationship through a folder link
        # are not followed by the reader, so the file behind them is not known.
        (self.root / 'linked').parent.mkdir(parents=True, exist_ok=True)
        self.write({'b/b.md': node('b')})
        (self.root / 'linked').symlink_to(self.root / 'b', target_is_directory=True)
        (self.root / 'b' / 'alias.md').symlink_to(self.root / 'b' / 'b.md')
        cases = {
            'link through a folder link': ({'a/a.md': node('a', '[b](../linked/b.md)')}, BASE['agent-architecture.json']),
            'link to a file link': ({'a/a.md': node('a', '[b](../b/alias.md)')}, BASE['agent-architecture.json']),
            'relationship through a folder link': ({}, manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'linked/b.md', 'reads')])),
        }
        reasons = {'link through a folder link': 'unresolved-link', 'link to a file link': 'unresolved-link',
                   'relationship through a folder link': 'unresolved-end'}
        for name, (files, declared) in cases.items():
            with self.subTest(case=name):
                self.tree({**files, 'agent-architecture.json': declared})
                model = self.model()
                self.assertIn('symlink', [i['code'] for i in model['issues']])
                self.assertEqual(self.mismatches(model), [])
                # What was not compared is said, on the relationship line, with why (info, no status change).
                (unchecked,) = [i for i in model['issues'] if i['code'] == 'manifest-unchecked']
                self.assertEqual((unchecked['reason'], unchecked['node'], unchecked['line']),
                                 (reasons[name], str(self.root / 'agent-architecture.json'), self.line_of('agent-architecture.json', '"source": "a/a.md"')))
        # Control: a link to a missing file is resolved (absent), so the relationship has no link.
        self.tree({'a/a.md': node('a', '[b](../sumiu/b.md)')})
        self.assertEqual([i['absent'] for i in self.mismatches(self.model())], ['link'])

    def test_a_link_into_a_folder_not_read_silences_only_what_may_be_there(self):
        # A link into node_modules, dist, build, .venv or .git (existing or not)
        # names a precise path that is no object, so the missing link a -> b is affirmed.
        for text in ('[b](../node_modules/b.md)', '[x](../node_modules/eslint/README.md)', 'Run `../node_modules/.bin/eslint`.',
                     'The build writes `../dist/cli.js`.', 'Output goes to `./build/report.md`.', '[v](../.venv/x.md)', '[g](../.git/x.md)'):
            with self.subTest(text=text):
                self.tree({'a/a.md': node('a', text)})
                model = self.model()
                self.assertEqual([(i['target'], i['absent']) for i in self.mismatches(model)], [('a/a.md → b/b.md', 'link')])
                self.assertEqual([i for i in model['issues'] if i['code'] == 'manifest-unchecked'], [])
        # When the destination is under that same folder, the link may be it: not compared, and said so.
        self.tree({'a/a.md': node('a', '[o](../node_modules/outro.md)'),
                   'agent-architecture.json': manifest(['a/a.md', 'b/b.md'], [('a/a.md', 'node_modules/b.md', 'reads')])})
        model = self.model()
        self.assertEqual(self.mismatches(model), [])
        self.assertEqual([i['reason'] for i in model['issues'] if i['code'] == 'manifest-unchecked'], ['unread-folder-link'])
        # A relationship to dist/cli.js is compared as written (a cites no such file) and silences nothing else.
        self.write({'dist/cli.js': 'x\n'})
        self.tree({'a/a.md': node('a', '- reads: [b](../b/b.md)', '- x: [c](../c/c.md)'),
                   'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'dist/cli.js', 'uses')])})
        self.assertEqual(sorted((i['target'], i['absent']) for i in self.mismatches(self.model())),
                         [('../c/c.md', 'relation'), ('a/a.md → dist/cli.js', 'link')])

    def test_ends_through_a_folder_link_silence_only_the_links_ending_so(self):
        # Both ends through a folder link (linked/a.md -> linked/b.md). The files behind them end
        # with a.md and b.md, so the real link c -> a without relationship is reported (c.md is no a.md).
        (self.root / 'linked').parent.mkdir(parents=True, exist_ok=True)
        self.tree({'c/c.md': node('c', '- x: [a](../a/a.md)')})
        (self.root / 'linked').symlink_to(self.root / 'a', target_is_directory=True)
        self.tree({'c/c.md': node('c', '- x: [a](../a/a.md)'),
                   'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('linked/a.md', 'linked/b.md', 'reads')])})
        model = self.model()
        self.assertEqual([(i['target'], i['absent']) for i in self.mismatches(model)], [('../a/a.md', 'relation')])
        (unchecked,) = [i for i in model['issues'] if i['code'] == 'manifest-unchecked']
        self.assertEqual((unchecked['reason'], unchecked['target']), ('unresolved-ends', 'linked/a.md → linked/b.md'))
        self.assertNotIn('from', unchecked)
        # A relationship a -> linked/x.md silences no link a -> c (c.md is no x.md).
        self.tree({'a/a.md': node('a', '- reads: [b](../b/b.md)', '- x: [c](../c/c.md)'),
                   'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'linked/x.md', 'reads')])})
        self.assertEqual([(i['target'], i['absent']) for i in self.mismatches(self.model())], [('../c/c.md', 'relation')])

    def test_a_relationship_written_through_a_folder_link_mirrors_the_real_link(self):
        # .claude/skills -> ../skills; the relationship names the skill through the link, the
        # real SKILL.md links the guide. No false "link without relationship"; the relationship is not compared.
        self.write({'skills/x/SKILL.md': '# x\n\n## Relations\n\n- reads: [guia](../../docs/guia.md)\n', 'docs/guia.md': '# guia\n',
                    'AGENTS.md': '# A\n[m](agent-architecture.json)\n[s](skills/x/SKILL.md)\n[g](docs/guia.md)\n',
                    'agent-architecture.json': manifest(['skills/x/SKILL.md', 'docs/guia.md'], [('.claude/skills/x/SKILL.md', 'docs/guia.md', 'reads')])},
                   self.base / 'mirrored')
        (self.base / 'mirrored/.claude').mkdir()
        (self.base / 'mirrored/.claude/skills').symlink_to('../skills', target_is_directory=True)
        model = self.model(self.base / 'mirrored')
        self.assertEqual(self.mismatches(model), [])
        (unchecked,) = [i for i in model['issues'] if i['code'] == 'manifest-unchecked']
        self.assertEqual((unchecked['reason'], unchecked['to']), ('unresolved-end', str(self.base / 'mirrored/docs/guia.md')))
        # Many relationships through the link, one per link of a chain: no warning.
        chain = {f'n/{i}.md': f'# {i}\n\n[{(i + 1) % 100}]({(i + 1) % 100}.md)\n' for i in range(100)}
        self.write({**chain, 'agent-architecture.json': manifest(list(chain), [(f'linked/{i}.md', f'n/{(i + 1) % 100}.md', 'reads') for i in range(100)])})
        (self.root / 'linked').symlink_to(self.root / 'n', target_is_directory=True)
        model = self.model()
        self.assertEqual(self.mismatches(model), [])
        self.assertEqual(sum(i['code'] == 'manifest-unchecked' for i in model['issues']), 100)

    def test_another_link_below_a_folder_link_makes_the_end_any_file(self):
        # Links through a folder link (linked -> nodes and nodes/b.md -> c.md, both ways) and a relationship (nodes/sub -> ../other):
        # the file behind the path may be another one, so nothing is affirmed, and the note says it.
        self.write({'nodes/a.md': '# a\n', 'nodes/c.md': '# c\n', 'other/b.md': '# b\n'}, self.base / 'q')
        q = self.base / 'q'
        (q / 'linked').symlink_to('nodes', target_is_directory=True)
        (q / 'nodes/b.md').symlink_to('c.md')
        (q / 'nodes/sub').symlink_to('../other', target_is_directory=True)
        cases = {
            'r5b': ('[b](../linked/b.md)', [('nodes/a.md', 'nodes/c.md', 'reads')], 'unresolved-link'),
            'r5c': ('[c](c.md)', [('nodes/a.md', 'linked/b.md', 'reads')], 'unresolved-end'),
            'r5d': ('[b](../linked/sub/b.md)', [('nodes/a.md', 'other/b.md', 'reads')], 'unresolved-link'),
        }
        for name, (text, relations, reason) in cases.items():
            with self.subTest(case=name):
                self.write({'nodes/a.md': node('a', text), 'AGENTS.md': '# A\n[m](agent-architecture.json)\n[a](nodes/a.md)\n',
                            'agent-architecture.json': manifest(['nodes/a.md', 'nodes/c.md', 'other/b.md'], relations)}, q)
                model = self.model(q)
                self.assertEqual(self.mismatches(model), [])
                self.assertEqual([i['reason'] for i in model['issues'] if i['code'] == 'manifest-unchecked'], [reason])
        # Control: a chain of folder links keeps the part below them; the real link a -> c is reported.
        self.write({'nodes/a.md': node('a', '[x](x.md)'), 'nodes/x.md': '# x\n',
                    'agent-architecture.json': manifest(['nodes/a.md', 'nodes/c.md', 'nodes/x.md'], [('nodes/a.md', 'linked/zz.md', 'reads')])}, q)
        model = self.model(q)
        self.assertEqual([(i['target'], i['absent']) for i in self.mismatches(model)], [('x.md', 'relation')])

    def test_relationships_through_a_folder_link_with_one_file_name_stay_linear(self):
        # Both ends through .claude/skills and every file named SKILL.md.
        import time
        files = {f'skills/s{i}/SKILL.md': f'# s{i}\n' + ''.join(f'[n](../s{(i + k) % 1500}/SKILL.md)\n' for k in range(2, 5)) for i in range(1500)}
        relations = [(f'.claude/skills/s{i}/SKILL.md', f'.claude/skills/s{(i + 1) % 1500}/SKILL.md', 'reads') for i in range(1500)]
        self.write({**files, 'AGENTS.md': '# A\n', 'agent-architecture.json': manifest(list(files), relations)}, self.base / 'skills-lab')
        (self.base / 'skills-lab/.claude').mkdir()
        (self.base / 'skills-lab/.claude/skills').symlink_to('../skills', target_is_directory=True)
        start = time.perf_counter()
        model = self.model(self.base / 'skills-lab')
        elapsed = time.perf_counter() - start
        self.assertEqual(len(self.mismatches(model)), 4500)  # no link s_i -> s_(i+1); every link s_i -> s_(i+2..4) undeclared
        self.assertEqual(sum(i['code'] == 'manifest-unchecked' for i in model['issues']), 1500)
        self.assertLess(elapsed, 20)

    def test_a_file_link_end_silences_the_links_sharing_the_other_end(self):
        # A relationship whose source is a link to a file (nothing known about it) silences the links to its
        # target, and only those; with both ends such links, every link of the manifest, with the note.
        (self.root / 'a/alias.md').parent.mkdir(parents=True, exist_ok=True)
        (self.root / 'a/alias.md').symlink_to(self.root / 'a' / 'a.md')
        links = {'a/a.md': node('a', '- reads: [b](../b/b.md)', '- x: [c](../c/c.md)'), 'c/c.md': node('c', '- x: [b](../b/b.md)')}
        self.tree({**links, 'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/alias.md', 'c/c.md', 'reads')])})
        model = self.model()
        self.assertEqual([(i['target'], i['absent']) for i in self.mismatches(model)], [('../b/b.md', 'relation')])
        self.assertEqual([i['reason'] for i in model['issues'] if i['code'] == 'manifest-unchecked'], ['unresolved-end'])
        (self.root / 'c/alias.md').parent.mkdir(parents=True, exist_ok=True)
        (self.root / 'c/alias.md').symlink_to(self.root / 'c' / 'c.md')
        self.tree({**links, 'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/alias.md', 'c/alias.md', 'reads')])})
        model = self.model()
        self.assertEqual(self.mismatches(model), [])
        self.assertEqual([i['reason'] for i in model['issues'] if i['code'] == 'manifest-unchecked'], ['unresolved-ends'])

    def test_notes_say_the_truth_once(self):
        # A relationship to an agent-architecture.json gets its note, with the reason.
        self.write({'sub/agent-architecture.json': manifest([], [])})
        for target in ('agent-architecture.json', 'sub/agent-architecture.json'):
            with self.subTest(target=target):
                self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md', target], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', target, 'reads')])})
                model = self.model()
                self.assertEqual(self.mismatches(model), [])
                self.assertEqual([(i['reason'], i['target']) for i in model['issues'] if i['code'] == 'manifest-unchecked'],
                                 [('manifest-end', f'a/a.md → {target}')])
        # A source that does not exist is already broken: no note about reading it.
        self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/zz.md', 'b/b.md', 'reads')])})
        model = self.model()
        self.assertEqual([i['code'] for i in model['issues']], ['broken'])
        # The same relationship written two ways gets one note.
        self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'https://x.y/z', 'reads'),
                                                                                       ('./a/a.md', 'https://x.y/z', 'uses')])})
        self.assertEqual([i['reason'] for i in self.model()['issues'] if i['code'] == 'manifest-unchecked'], ['not-a-file'])

    def test_a_nested_manifest_is_no_node_of_another(self):
        # The outer manifest lists the inner one as an object; its declarations are no links.
        self.write({'sub/agent-architecture.json': manifest(['nodes/x.md'], []), 'sub/nodes/x.md': '# x\n'})
        self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md', 'sub/agent-architecture.json', 'sub/nodes/x.md'],
                                                       [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'sub/agent-architecture.json', 'reads')])})
        self.assertEqual(self.mismatches(self.model()), [])

    def test_links_against_unresolved_relationships_stay_linear(self):
        import time
        (self.root / 'linked').parent.mkdir(parents=True, exist_ok=True)
        self.write({'b/b.md': node('b')})
        (self.root / 'linked').symlink_to(self.root / 'b', target_is_directory=True)
        objects, relations, files = [], [], {}
        for index in range(2000):
            files[f'n/{index}.md'] = f'# {index}\n[next](../n/{(index + 1) % 2000}.md)\n[x](../linked/{index}.md)\n'
            objects.append(f'n/{index}.md')
            relations.append((f'linked/s{index}.md', f'n/{index}.md', 'reads'))
        self.write({**files, 'agent-architecture.json': manifest(objects, relations)})
        start = time.perf_counter()
        model = self.model()
        elapsed = time.perf_counter() - start
        self.assertEqual(len(self.mismatches(model)), 2000)  # each link n -> n+1 has no relationship
        self.assertEqual(sum(i['code'] == 'manifest-unchecked' for i in model['issues']), 2000)
        self.assertLess(elapsed, 20)

    def test_a2b_a_relationship_with_an_unresolved_end_leaves_alone(self):
        # A link a -> c between objects without relationship is reported even when
        # another relationship has an end that is no reference (URL, template, glob, empty, anchor), or an
        # ambiguous end whose candidates are not c.
        links = node('a', '- reads: [b](../b/b.md)', '- x: [c](../c/c.md)')
        for end in ('https://example.com/x', 'nodes/<nome>.md', 'c/*.md', '', '#x', 'C:\\x.md', 'mailto:x@y', '$HOME/x.md', 'guia.md'):
            with self.subTest(end=end):
                self.tree({'a/a.md': links, 'x/guia.md': '# x\n', 'y/guia.md': '# y\n',
                           'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', end, 'reads')])})
                self.assertEqual([(i['target'], i['absent']) for i in self.mismatches(self.model())], [('../c/c.md', 'relation')])
        # An ambiguous end among whose candidates c is: the relationship may stand for a -> c, nothing is affirmed.
        self.tree({'a/a.md': links, 'x/c.md': '# outro c\n',
                   'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'c.md', 'reads')])})
        model = self.model()
        self.assertIn('ambiguous', [i['code'] for i in model['issues']])
        self.assertEqual(self.mismatches(model), [])

    def test_keys_of_another_tool_manifest_are_links_whatever_the_spelling(self):
        # Keys of other tools' manifests (.mcp.json key instructions; plugin.json skills, plain and with ./).
        for name, text, declared in (
                ('.mcp.json', '{"mcpServers": {}, "instructions": "docs/s.md"}', '.mcp.json'),
                ('plugin.json', '{"skills": ["skills/x/SKILL.md"]}', 'plugin.json'),
                ('plugin.json', '{"skills": ["./skills/x/SKILL.md"]}', 'plugin.json')):
            with self.subTest(text=text):
                target = 'docs/s.md' if 'instructions' in text else 'skills/x/SKILL.md'
                self.tree({name: text, target: '# t\n',
                           'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), (declared, target, 'uses')])})
                model = self.model()
                self.assertTrue(any(edge['source'] == str(self.root / name) and edge['target'] == str(self.root / target) for edge in model['edges']))
                self.assertEqual(self.mismatches(model), [])
                (self.root / name).unlink()
                (self.root / target).unlink()
        # The checking manifest's own values stay no links: a relationship from it is never reported.
        self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('agent-architecture.json', 'c/c.md', 'reads')])})
        self.assertEqual(self.mismatches(self.model()), [])

    def test_the_relation_cap_never_hides_a_link(self):
        filler = ''.join(f'[f{i}](f/{i}.md)\n' for i in range(40))
        self.tree({'AGENTS.md': BASE['AGENTS.md'] + filler})
        with patch('scanner.MAX_EDGES', 12):
            model = self.model()
        self.assertFalse(model['stats']['relations']['complete'])
        self.assertFalse(any(edge['source'] == str(self.root / 'a/a.md') for edge in model['edges']))
        self.assertEqual(self.mismatches(model), [])

    def test_duplicate_and_self_relations(self):
        declared = manifest(['a/a.md', 'b/b.md', 'c/c.md'], [
            ('a/a.md', 'b/b.md', 'reads'), ('a/a.md', 'b/b.md', 'uses'), ('./a/a.md', 'b/b.md', 'reads'), ('c/c.md', 'c/c.md', 'reads')])
        self.tree({'a/a.md': node('a'), 'agent-architecture.json': declared})
        self.assertEqual(self.brief(self.model()), [
            ('agent-architecture.json', self.line_of('agent-architecture.json', '"source": "a/a.md"'), 'a/a.md → b/b.md', 'link'),
            ('agent-architecture.json', self.line_of('agent-architecture.json', '"source": "c/c.md"'), 'c/c.md → c/c.md', 'link')])
        self.tree({'a/a.md': node('a', '[b](../b/b.md)'), 'c/c.md': node('c', '[eu](c.md)'), 'agent-architecture.json': declared})
        self.assertEqual(self.mismatches(self.model()), [])
        # A link of a file to itself, without the self relation, is no link between two objects.
        self.tree({'c/c.md': node('c', '[eu](c.md)', 'De novo: [[c]]')})
        model = self.model()
        self.assertEqual(model['stats']['structure']['selfReferences'], 1)
        self.assertEqual(self.mismatches(model), [])

    def test_nested_projects_each_compare_their_own_manifest(self):
        inner = self.root / 'interno'
        self.tree({'a/a.md': node('a', '- reads: [b](../b/b.md)', '- x: [c](../interno/c.md)')})
        self.write({'AGENTS.md': '# Interno\n[m](agent-architecture.json)\n[c](c.md)\n[d](d.md)\n',
                    'c.md': node('c', '- reads: [d](d.md)'), 'd.md': node('d', '- x: [c](c.md)'),
                    'agent-architecture.json': manifest(['c.md', 'd.md'], [('c.md', 'd.md', 'reads')])}, inner)
        expected = [(str(inner / 'd.md'), str(inner / 'agent-architecture.json'), 'c.md')]
        for roots in ([self.root], [inner], [self.root, inner], [inner, self.root]):
            with self.subTest(roots=[str(r.relative_to(self.base)) for r in roots]):
                found = [(i['node'], i['manifest'], i['target']) for i in self.mismatches(self.model(*roots))]
                self.assertEqual(found, expected)

    def test_a_thousand_relationships(self):
        files, objects, relations = {'AGENTS.md': '# Entrada\n[m](agent-architecture.json)\n'}, [], []
        for index in range(200):
            targets = [(index + step) % 200 for step in range(1, 6)]
            files[f'n/{index}.md'] = node(str(index), *(f'- reads: [{t}]({t}.md)' for t in targets))
            objects.append(f'n/{index}.md')
            relations += [(f'n/{index}.md', f'n/{t}.md', 'reads') for t in targets]
        files['agent-architecture.json'] = manifest(objects, relations)
        self.write(files)
        model = self.model()
        self.assertEqual(len(relations), 1000)
        self.assertEqual(self.mismatches(model), [])
        self.assertEqual([s for s in model['signals'] if s['code'] == 'repeated-reference'], [])
        # Half of the nodes lose one link and gain another that is not declared.
        for index in range(0, 200, 2):
            text = files[f'n/{index}.md'].replace(f'- reads: [{(index + 1) % 200}]({(index + 1) % 200}.md)', f'- x: [{(index + 7) % 200}]({(index + 7) % 200}.md)')
            self.write({f'n/{index}.md': text})
        found = self.mismatches(self.model())
        self.assertEqual(sum(i['absent'] == 'link' for i in found), 100)
        self.assertEqual(sum(i['absent'] == 'relation' for i in found), 100)

    def test_an_invalid_manifest_behaves_as_before(self):
        cases = {
            'broken json': '{"linkedRelationships": true, "objects": [\n',
            'relationships not a list': json.dumps({'linkedRelationships': True, 'objects': [{'path': 'a/a.md'}], 'relationships': {'source': 'a/a.md'}}),
            'entry without source': json.dumps({'linkedRelationships': True, 'objects': [{'path': 'a/a.md'}, {'path': 'b/b.md'}],
                                                'relationships': [{'source': 'a/a.md', 'target': 'b/b.md'}, {'target': 'b/b.md'}]}, indent=2),
            'root is a list': json.dumps([{'linkedRelationships': True}]),
            'object without path': json.dumps({'linkedRelationships': True, 'objects': [{'name': 'x'}], 'relationships': [{'source': 'a/a.md', 'target': 'b/b.md'}]}),
        }
        for name, text in cases.items():
            with self.subTest(case=name):
                self.tree({'a/a.md': node('a'), 'c/c.md': node('c', '[a](../a/a.md)'), 'agent-architecture.json': text})
                model = self.model()
                self.assertEqual(self.mismatches(model), [])
                self.assertEqual(sum(i['code'] == 'manifest' for i in model['issues']), 1)
                without = text.replace('"linkedRelationships": true, ', '').replace('"linkedRelationships": true', '"x": 0')
                self.tree({'agent-architecture.json': without})
                self.assertEqual([(i['code'], i['line']) for i in model['issues']], [(i['code'], i['line']) for i in self.model()['issues']])


class ExtractorTests(MirrorCase):
    """CommonMark links with a parenthesized title or an angle-bracket destination are extracted and compared."""

    def extracted(self, text, suffix='.md'):
        return [(raw, line) for raw, _, line, _ in references(text, suffix)]

    def test_a_title_in_parentheses(self):
        self.assertEqual(self.extracted('[b](b.md (título)) e [c](<c d.md> (t)) e [e](e.md "t")\n'), [('b.md', 1), ('c d.md', 1), ('e.md', 1)])
        # A title is never nested, and a pair inside the destination is still part of it.
        self.assertEqual(self.extracted('[b](x.md (a (b))) [g](guia_(v2).md)\n'), [('guia_(v2).md', 1)])
        self.tree({'a/a.md': node('a', '- reads: [b](../b/b.md (o nó b))')})
        self.assertEqual(self.mismatches(self.model()), [])

    def test_a_link_text_over_lines_is_not_extracted_and_the_check_does_not_affirm(self):
        # The reader keeps reading a link in one line (a text over several lines crossed block boundaries:
        # a table row, list items, a heading). No false link and no false broken.
        self.assertEqual(self.extracted('| [0, 10 | x |\n| 10+ | ver](notas.md) |\n- Intervalo [0, 1\n- detalhe](limites.md)\n'), [])
        wrapped = '- reads: [the long-term memory node that this agent reads before every\n  task](../b/b.md)'
        sibling = manifest(['a/a.md', 'a/b.md', 'c/c.md'], [('a/a.md', 'a/b.md', 'reads')])
        cases = {  # e9: text over two lines; f34: title on the next line; f33: destination on the next line
            'e9': (wrapped, BASE['agent-architecture.json']),
            'f34': ('- reads: [b](../b/b.md\n  "t")', BASE['agent-architecture.json']),
            'f33': ('- reads: [b](\n  b.md)', sibling),
        }
        for name, (text, declared) in cases.items():
            with self.subTest(case=name):
                self.assertEqual(self.extracted(text + '\n'), [])
                self.tree({'a/a.md': node('a', text), 'a/b.md': node('b'), 'agent-architecture.json': declared})
                model = self.model()
                self.assertFalse(any(edge['origin'] == str(self.root / 'a/a.md') for edge in model['edges']))
                # The source writes the destination where a link destination goes: not compared, and said so.
                self.assertEqual(self.mismatches(model), [])
                (unchecked,) = [i for i in model['issues'] if i['code'] == 'manifest-unchecked']
                self.assertEqual((unchecked['reason'], unchecked['line']),
                                 ('unextracted-link', self.line_of('agent-architecture.json', '"source": "a/a.md"')))
        # The same text inside a fenced block is an example: the missing link is affirmed.
        self.tree({'a/a.md': node('a', '```md\n' + wrapped + '\n```')})
        self.assertEqual([i['absent'] for i in self.mismatches(self.model())], ['link'])
        # Another path in that place does not count.
        self.tree({'a/a.md': node('a', '- reads: [c and\n  more](../c/c.md)')})
        self.assertEqual([i['absent'] for i in self.mismatches(self.model())], ['link'])

    def test_hostile_lines_stay_linear(self):
        import time
        for text in (('[' + 'a' * 100 + '\n') * 8 + '](' * 200000 + '\n', ('x\n' + '](x ((' * 50000 + '\n') * 10,
                     '[a](b ' + '(' * 200000 + '\n'):
            start = time.perf_counter()
            list(references(text, '.md'))
            self.assertLess(time.perf_counter() - start, 5)


class ContractTests(MirrorCase):
    def invoke(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli.main([str(argument) for argument in arguments])
        return code, json.loads(output.getvalue())

    def test_fail_on_the_new_code_and_on_any(self):
        self.tree()
        code, report = self.invoke('audit', '--root', self.root, '--fail-on', CODE)
        self.assertEqual((code, report['status'], report['gate']['matched']), (0, 'pass', {CODE: 0}))
        self.tree({'a/a.md': node('a')})
        code, report = self.invoke('audit', '--root', self.root, '--fail-on', CODE)
        self.assertEqual((code, report['status'], report['gate']['matched']), (1, 'fail', {CODE: 1}))
        # Like any other warning: no status change without the gate, and `any` takes it.
        code, report = self.invoke('audit', '--root', self.root)
        self.assertEqual((code, report['status']), (0, 'pass'))
        code, report = self.invoke('audit', '--root', self.root, '--fail-on', 'any')
        self.assertEqual((code, report['gate']['matched']), (1, {CODE: 1}))
        (finding,) = [item for item in report['findings'] if item['code'] == CODE]
        self.assertEqual({key: finding[key] for key in ('severity', 'path', 'target', 'absent', 'from', 'to', 'manifest')},
                         {'severity': 'warning', 'path': 'agent-architecture.json', 'target': 'a/a.md → b/b.md', 'absent': 'link',
                          'from': 'a/a.md', 'to': 'b/b.md', 'manifest': 'agent-architecture.json'})
        self.assertNotIn(str(self.root), json.dumps(finding))
        code, report = self.invoke('audit', '--root', self.root, '--code', CODE)
        self.assertEqual(report['filter']['matched'], 1)

    def test_paths_of_the_finding_are_never_absolute(self):
        self.write({'fora.md': '# fora\n'}, self.base)
        self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md', 'c/c.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', '../fora.md', 'reads')])})
        _, report = self.invoke('audit', '--root', self.root)
        (finding,) = [item for item in report['findings'] if item['code'] == CODE]
        self.assertEqual((finding['from'], finding['to']), ('a/a.md', '../fora.md'))
        self.assertNotIn(str(self.base), json.dumps(finding))
        # With two roots, a file of the other root is named relative to it, with its index.
        self.write({'AGENTS.md': '# V\n', 'i.md': '# i\n'}, self.base / 'vizinho')
        self.tree({'agent-architecture.json': manifest(['a/a.md', 'b/b.md'], [('a/a.md', 'b/b.md', 'reads'), ('a/a.md', '../vizinho/i.md', 'reads')])})
        _, report = self.invoke('audit', '--root', self.root, '--root', self.base / 'vizinho')
        (finding,) = [item for item in report['findings'] if item['code'] == CODE]
        self.assertEqual({key: finding.get(key) for key in ('root', 'path', 'from', 'to', 'toRoot', 'manifest')},
                         {'root': 0, 'path': 'agent-architecture.json', 'from': 'a/a.md', 'to': 'i.md', 'toRoot': 1, 'manifest': 'agent-architecture.json'})
        self.assertNotIn(str(self.base), json.dumps(finding))

    def test_schema_lists_the_code_and_versions_do_not_change(self):
        code, schema = self.invoke('schema')
        self.assertEqual(code, 0)
        self.assertTrue(schema['auditContract']['codes'][CODE].startswith('warning: '))
        self.assertEqual(schema['reportVersions']['audit'], 2)
        self.assertEqual(schema['cliVersion'], cli.VERSION)
        for field in ('absent', 'from', 'to', 'manifest'):
            self.assertIn(field, schema['auditContract']['codes'][CODE])
        self.assertEqual(audit.CODES[CODE][0], 'warning')
        # Contract text is never cut to fit a cap: the sentence stays whole.
        self.assertTrue(schema['auditContract']['codes']['suite-snapshot-unavailable'].endswith(
            'maxAlwaysLoadedBytes uses the size from the inventory, when known.'))
        self.assertIn(CODE, ' '.join(schema['changes']['audit v2: checkable manifest']))

    def test_marked_as_expected_keeps_its_key_when_lines_move(self):
        self.tree({'a/a.md': node('a'), 'c/c.md': node('c', '- references: [a](../a/a.md)')})
        workspace = Workspace(self.base / 'state')
        snapshot = workspace.open(str(self.root))
        keys = {item['absent']: item['key'] for item in snapshot['issues'] if item['code'] == CODE}
        self.assertEqual(set(keys), {'link', 'relation'})
        for key in keys.values():
            workspace.expect(str(self.root), key, True, 'intencional')
        # Lines inserted above both: the relationship and the link keep their keys, so the marks hold.
        text = (self.root / 'agent-architecture.json').read_text(encoding='utf-8')
        self.write({'agent-architecture.json': text.replace('{\n', '{\n  "about": "x",\n', 1),
                    'c/c.md': '# c\n\nLinha nova.\n\n## Relations\n\n- references: [a](../a/a.md)\n'})
        snapshot = workspace.refresh()
        again = {item['absent']: item['key'] for item in snapshot['issues'] if item['code'] == CODE}
        self.assertEqual(again, keys)
        self.assertEqual(set(snapshot['expected'][str(self.root)]), set(keys.values()))

    def test_a_reference_saved_by_the_previous_reader_warns_instead_of_listing_changes(self):
        self.tree()
        Workspace(self.base / 'state').open(str(self.root))
        saved = self.base / 'state' / 'references' / (hashlib.sha256(str(self.root).encode()).hexdigest() + '.json.gz')
        document = json.loads(gzip.decompress(saved.read_bytes()))
        self.assertEqual(document['reference']['reader'], readings.READER)
        document['reference']['reader'] = '0' * 16  # the fingerprint of other reading rules
        saved.write_bytes(gzip.compress(json.dumps(document).encode()))
        delta = Workspace(self.base / 'state').snapshot()['delta']
        self.assertEqual([item['code'] for item in delta['warnings']], ['reference-reader-changed'])
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertEqual(delta['findings']['totals'], {'new': 0, 'resolved': 0})


if __name__ == '__main__':
    unittest.main()
