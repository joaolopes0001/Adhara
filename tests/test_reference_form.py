"""The written form of a reference separates broken paths from unresolved names.

Disposable trees only. A missing destination stays `broken` when the reference has the
form of a path (a `/`, an anchor) or a syntax that always names a file (wikilink, @import,
manifest, Markdown link to a name with an extension); a bare name in backticks/prose, or
a Markdown link to a word without extension, becomes `unresolved-name` (info).
"""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import audit, cli, scanner

ROOT_FILES = {
    'AGENTS.md': ('# Entrada\n'
                  '`fantasma.md`\n'                    # 2 path, bare name with extension
                  '[Link](url)\n'                      # 3 markdown, bare word
                  '[Ref][definir]\n'                   # 4 markdown-reference, bare word
                  '[definir]: DEFINIR\n'               # 5 the definition itself
                  '[Irmão](irmao.md)\n'                # 6 markdown, bare name with extension
                  '[Ref2][irmao]\n'                    # 7 markdown-reference with extension
                  '[irmao]: irmao-ref.md\n'            # 8
                  '[[fantasma-wiki]]\n'                # 9 wiki
                  '@fantasma-import.md\n'              # 10 import
                  '`docs/fantasma.md`\n'               # 11 path with /
                  '[Pasta](docs/sem-extensao)\n'       # 12 markdown with /, no extension
                  '`./ancorado.md`\n'                  # 13 anchored
                  '[Aqui](./url)\n'                    # 14 anchored word
                  '[Arquivo](file:fantasma-uri.md)\n'  # 15 file: URI
                  'Veja ./prosa.md no texto.\n'        # 16 anchored path in prose
                  '`~/fantasma-home.md`\n'             # 17 home-anchored (HOME is the root below)
                  '[Sub](sub/doc.md)\n'),              # 18
    'agent-architecture.json': json.dumps({'objects': [{'name': 'x', 'path': 'fantasma-manifesto.md'}],
                                           'relationships': [{'source': 'AGENTS.md', 'target': 'fantasma-rel.md'}]}, indent=1),
    'sub/doc.md': ('# Ids de teste\n'
                   '`tests/test_x.py::TestA::t_b`\n'     # 2 unanchored, exists from the root
                   '`tests/test_y.py::TestA::t_b`\n'     # 3 unanchored, missing, has /
                   '`../host/test_z.py::t_c`\n'          # 4 anchored, exists
                   '`../host/test_w.py::t_c`\n'          # 5 anchored, missing
                   '`app.py::main`\n'                    # 6 bare, missing
                   '`test_x.py::TestA`\n'                # 7 bare, unique basename
                   '[Teste](../tests/test_x.py::TestA::t_b)\n'  # 8 Markdown, anchored, exists
                   '`tests/test_x.py:: TestA`\n'),       # 9 not a test id: whitespace
    'tests/test_x.py': 'def test(): pass\n',
    'host/test_z.py': 'def t_c(): pass\n',
}


def make(root, files):
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    return root


def invoke(*arguments):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = cli.main([str(argument) for argument in arguments])
    return code, json.loads(output.getvalue())


class ReferenceFormTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-form-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.root = make(self.folder / 'agent', ROOT_FILES)

    def scan(self, root=None, scope=None):
        with mock.patch.dict(os.environ, {'HOME': str(root or self.root)}):
            return scanner.scan([str(root or self.root)], scope)

    def issues(self, model, code, node=None):
        return [(i['line'], i['target']) for i in model['issues'] if i['code'] == code and (node is None or i['node'] == node)]

    def test_rule_table_by_syntax_and_written_form(self):
        model = self.scan()
        entry, manifest = str(self.root / 'AGENTS.md'), str(self.root / 'agent-architecture.json')
        self.assertEqual(self.issues(model, 'unresolved-name', entry), [(2, 'fantasma.md'), (3, 'url'), (4, 'DEFINIR'), (5, 'DEFINIR')])
        self.assertEqual(self.issues(model, 'broken', entry), [
            (6, 'irmao.md'), (7, 'irmao-ref.md'), (8, 'irmao-ref.md'), (9, 'fantasma-wiki'), (10, 'fantasma-import.md'),
            (11, 'docs/fantasma.md'), (12, 'docs/sem-extensao'), (13, './ancorado.md'), (14, './url'),
            (15, 'file:fantasma-uri.md'), (16, './prosa.md'), (17, '~/fantasma-home.md')])
        # Manifest values stay broken, also when written as a bare name; the declared
        # relationship repeats the JSON value and adds no finding of its own.
        self.assertEqual([target for _, target in self.issues(model, 'broken', manifest)], ['fantasma-manifesto.md', 'fantasma-rel.md'])
        self.assertTrue(any(e['kind'] == 'declared' and e['target'] == str(self.root / 'fantasma-rel.md') for e in model['edges']))
        # Same fields as broken (with evidence, syntax and form); the message does not claim what the name is.
        issue = next(i for i in model['issues'] if i['code'] == 'unresolved-name')
        self.assertEqual(set(issue), {'id', 'code', 'message', 'node', 'line', 'target', 'evidence', 'syntax', 'form'})
        self.assertEqual((issue['syntax'], issue['form']), ('path', 'name'))
        broken = next(i for i in model['issues'] if i['code'] == 'broken')
        self.assertEqual(set(broken), set(issue))
        self.assertIn('A name written without a folder matches no inventoried file: fantasma.md.', issue['message'])
        # The placeholder still exists as a missing destination.
        statuses = {n['id']: n['status'] for n in model['nodes']}
        self.assertEqual((statuses[str(self.root / 'fantasma.md')], statuses[str(self.root / 'url')]), ('missing', 'missing'))

    def test_unresolved_names_are_counted_by_edge_inside_unresolved(self):
        model = self.scan()
        resolution = model['stats']['resolution']
        names = [e for e in model['edges'] if e['source'] == str(self.root / 'AGENTS.md') and e['raw'] in {'fantasma.md', 'url', 'DEFINIR'}]
        self.assertEqual(len(names), 4)
        # sub/doc.md adds app.py::main: five name edges, all unresolved.
        self.assertEqual(resolution['unresolvedNames'], 5)
        self.assertEqual(resolution['unresolved'], sum(1 for e in model['edges'] if e['kind'] != 'scope' and e['resolvedBy'] is None))
        self.assertGreater(resolution['unresolved'], resolution['unresolvedNames'])
        # Two names on one line share one edge: issues are per reference, the count per edge.
        root = make(self.folder / 'same-line', {'AGENTS.md': '`a.py::x` e `a.py::y`\n'})
        repeated = self.scan(root)
        self.assertEqual(self.issues(repeated, 'unresolved-name'), [(1, 'a.py::x'), (1, 'a.py::y')])
        self.assertEqual(repeated['stats']['resolution']['unresolvedNames'], 1)

    def test_scope_and_cascade_take_precedence_over_unresolved_name(self):
        root = make(self.folder / 'precedence', {
            'AGENTS.md': '`saida.md`\n[Link](url)\n`unico.md`\n`dup.md`\n`resto.md`\n',
            'docs/unico.md': '# Único\n', 'x/dup.md': '# X\n', 'y/dup.md': '# Y\n'})
        model = self.scan(root, {'version': 1, 'runtimeWorkspace': ['saida.md'], 'localFiles': ['url']})
        declared = {e['raw']: e['declared'] for e in model['edges'] if e.get('declared')}
        self.assertEqual(declared, {'saida.md': {'kind': 'runtimeWorkspace', 'pattern': 'saida.md'}, 'url': {'kind': 'localFiles', 'pattern': 'url'}})
        self.assertEqual({n['id']: n['status'] for n in model['nodes']}[str(root / 'saida.md')], 'declared')
        self.assertEqual(next(e for e in model['edges'] if e['raw'] == 'unico.md')['resolvedBy'], 'basename')
        self.assertEqual(self.issues(model, 'ambiguous'), [(4, 'dup.md')])
        self.assertEqual(self.issues(model, 'unresolved-name'), [(5, 'resto.md')])
        self.assertEqual(model['stats']['resolution']['unresolvedNames'], 1)
        self.assertFalse(self.issues(model, 'broken'))
        report = audit.audit(model)
        self.assertEqual(report['summary']['byCode'], {'declared-external': 2, 'unreachable': 2, 'ambiguous': 1, 'basename-resolved': 1, 'unresolved-name': 1})

    def test_test_id_suffix_is_dropped_before_resolving_in_every_form(self):
        model = self.scan()
        doc = str(self.root / 'sub/doc.md')
        edges = {e['raw']: e for e in model['edges'] if e['source'] == doc}
        expected = {'tests/test_x.py::TestA::t_b': ('tests/test_x.py', 'root'),
                    '../host/test_z.py::t_c': ('host/test_z.py', 'file'),
                    'test_x.py::TestA': ('tests/test_x.py', 'basename'),
                    '../tests/test_x.py::TestA::t_b': ('tests/test_x.py', 'file')}
        for raw, (target, mode) in expected.items():
            with self.subTest(raw=raw):
                self.assertEqual((edges[raw]['target'], edges[raw]['resolvedBy']), (str(self.root / target), mode))
        # Missing targets keep the reference as written, and its form decides the code.
        self.assertEqual(self.issues(model, 'broken', doc), [(3, 'tests/test_y.py::TestA::t_b'), (5, '../host/test_w.py::t_c')])
        self.assertEqual(self.issues(model, 'unresolved-name', doc), [(6, 'app.py::main')])
        self.assertEqual(edges['app.py::main']['target'], str(self.root / 'sub/app.py'))
        self.assertEqual(edges['../host/test_w.py::t_c']['target'], str(self.root / 'host/test_w.py'))
        self.assertEqual(edges['tests/test_x.py::TestA::t_b']['evidence'], '`tests/test_x.py::TestA::t_b`')
        self.assertNotIn('tests/test_x.py:: TestA', edges)

    def test_extractor_recognizes_unanchored_test_ids_and_stays_linear(self):
        found = [(raw, kind) for raw, kind, *_ in scanner.references('`dir/arquivo.py::id`\n`arquivo.py::Classe::t[a-b]`\n`dir/arquivo.py:: id`\n', '.md')]
        self.assertEqual(found, [('dir/arquivo.py::id', 'path'), ('arquivo.py::Classe::t[a-b]', 'path')])
        started = time.monotonic()
        for line in ('`' + 'a.md#' * 40000 + ' x`', '`' + 'a.md::' * 40000 + ' x`'):
            self.assertEqual(list(scanner.references(line + '\n', '.md')), [])
        self.assertLess(time.monotonic() - started, 3)

    def test_audit_reports_info_that_never_changes_status_and_can_gate(self):
        root = make(self.folder / 'names', {'AGENTS.md': '# Entrada\n`fantasma.md`\n[Link](url)\n'})
        code, report = invoke('audit', '--root', root)
        self.assertEqual((code, report['status']), (0, 'pass'))
        names = [f for f in report['findings'] if f['code'] == 'unresolved-name']
        self.assertEqual([(f['severity'], f['path'], f['line'], f['target']) for f in names],
                         [('info', 'AGENTS.md', 2, 'fantasma.md'), ('info', 'AGENTS.md', 3, 'url')])
        self.assertEqual(report['summary']['byCode'], {'unresolved-name': 2})
        self.assertEqual((report['summary']['bySeverity']['info'], report['summary']['topTargets'], report['summary']['topSources']), (2, [], []))
        self.assertEqual(report['metrics']['resolution']['unresolvedNames'], 2)
        code, filtered = invoke('audit', '--root', root, '--code', 'unresolved-name')
        self.assertEqual((code, filtered['filter']['matched']), (0, 2))
        code, gated = invoke('audit', '--root', root, '--fail-on', 'unresolved-name')
        self.assertEqual((code, gated['status'], gated['gate']), (1, 'fail', {'failOn': ['unresolved-name'], 'matched': {'unresolved-name': 2}}))
        code, any_ = invoke('audit', '--root', root, '--fail-on', 'any')
        self.assertEqual((code, any_['gate']['matched']), (0, {}))
        schema = cli.schema_contract()
        self.assertTrue(schema['auditContract']['codes']['unresolved-name'].startswith('info: '))
        self.assertIn('unresolvedNames', schema['auditContract']['metrics'])

    def test_compare_audit_against_the_previous_rule_shows_only_the_code_swap(self):
        # The previous rule reported every missing destination as broken: NAME_FORMS empty.
        root = make(self.folder / 'delta', {
            'AGENTS.md': '# Entrada\n`irmao.md`\n[Irmão](irmao.md)\n`docs/ausente.md`\n[Link](url)\n[Doc](docs/a.md)\n',
            'docs/a.md': '# A\n`politica.md`\n', 'regras/politica.md': '# P\n', 'orfao.md': '# Órfão\n'})
        with mock.patch.object(scanner, 'NAME_FORMS', {}):
            before = invoke('audit', '--root', root)[1]
        after = invoke('audit', '--root', root)[1]
        self.assertFalse([f for f in before['findings'] if f['code'] == 'unresolved-name'])
        files = [str(self.folder / name) for name in ('before.json', 'after.json')]
        for path, report in zip(files, (before, after)):
            Path(path).write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
        code, delta = invoke('compare-audit', '--before', files[0], '--after', files[1])
        self.assertEqual((code, delta['status'], delta['findings']), (0, 'pass', []))
        self.assertEqual({code: counts for code, counts in delta['byCode'].items() if counts['new'] or counts['resolved']},
                         {'broken': {'new': 0, 'resolved': 2, 'persisting': 2}, 'unresolved-name': {'new': 2, 'resolved': 0, 'persisting': 0}})
        self.assertEqual(sorted(f['target'] for f in delta['new']), sorted(f['target'] for f in delta['resolved']))
        self.assertEqual(sorted(f['target'] for f in delta['new']), ['irmao.md', 'url'])
        # Every finding whose code did not change keeps an id of the previous report.
        unchanged = {f['id'] for f in after['findings'] if f['code'] != 'unresolved-name'}
        self.assertLessEqual(unchanged, {f['id'] for f in before['findings']})
        self.assertEqual(len(unchanged) + 2, len(before['findings']))
        code, gated = invoke('compare-audit', '--before', files[0], '--after', files[1], '--fail-on', 'unresolved-name')
        self.assertEqual((code, gated['gate']), (1, {'failOn': ['unresolved-name'], 'matched': {'unresolved-name': 2}}))
        self.assertEqual(invoke('compare-audit', '--before', files[0], '--after', files[1], '--fail-on', 'any')[0], 0)


if __name__ == '__main__':
    unittest.main()
