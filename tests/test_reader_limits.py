"""Reader under limits and syntax that is not a reference.

Disposable trees only, with low limits by monkeypatch. Each rule has its negative
control next to it: the similar case that must not change. The base of every tree
holds a `.git`, so the probe above the opened root stops right there unless a
test builds its own ancestors.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import audit, cli, delta, scanner
from tests.server_pack import portuguese

CHECKOUT = Path(__file__).resolve().parents[1]


def make(root, files):
    for relative, text in files.items():
        path = Path(root) / relative
        if relative.endswith('/'):
            path.mkdir(parents=True, exist_ok=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    return Path(root)


class ReaderCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-limits-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        (self.base / '.git').mkdir()
        self.root = self.base / 'agent'
        self.root.mkdir()

    def scan(self, files=None, limit=None, lookup=None, text=None, roots=None):
        if files:
            make(self.root, files)
        patches = [mock.patch.object(scanner, name, value) for name, value in
                   (('MAX_FILES', limit), ('MAX_LOOKUP', lookup), ('MAX_TEXT_TOTAL', text)) if value is not None]
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            return scanner.scan([str(root) for root in (roots or [self.root])])

    def path(self, relative):
        return str(self.root / relative)

    def issues(self, model, code):
        return [(below(i['node'], self.root), i['line'], i.get('target')) for i in model['issues'] if i['code'] == code]

    def edge(self, model, source, raw):
        return next(e for e in model['edges'] if e['source'] == self.path(source) and e['raw'] == raw)

    def status(self, model, node):
        return next(n for n in model['nodes'] if n['id'] == node)['status']


def below(path, root):
    return os.path.relpath(path, root) if path else path


class InventoryByLevels(ReaderCase):
    """Breadth-first inventory; a complete one keeps the earlier set and order of nodes."""

    def test_a_deep_folder_no_longer_takes_the_budget_of_its_siblings(self):
        model = self.scan({'AGENTS.md': '# E\n', 'a/b/c/d/e/f.md': '# fundo\n', 'z/topo.md': '# topo\n'}, limit=6)
        ids = {node['id'] for node in model['nodes']}
        self.assertIn(self.path('z/topo.md'), ids)
        self.assertNotIn(self.path('a/b/c/d/e/f.md'), ids)
        # Depth-first, a/ would have taken every element before z/ was listed.

    def test_control_a_complete_inventory_keeps_the_depth_first_order(self):
        model = self.scan({'AGENTS.md': '# E\n', 'b.md': '# b\n', 'a/x.md': '# x\n', 'a/y/z.md': '# z\n', 'c/w.md': '# w\n', 'a-b/v.md': '# v\n'})
        expected = [str(self.root)]
        for folder, dirs, files in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if d not in scanner.EXCLUDED)
            expected += [os.path.join(folder, name) for name in sorted(dirs + files)]
        inventoried = [n['id'] for n in model['nodes'] if n['kind'] != 'unresolved']
        self.assertEqual(inventoried, expected)
        self.assertTrue(model['stats']['inventory']['complete'])


class LookupAndCascade(ReaderCase):
    """Past the budget, names only; the cascade consults the inventory and that index."""

    FILES = {'CLAUDE.md': 'Rode `scripts/run.sh` antes.\n',
             'docs/guia.md': 'Use `scripts/run.sh`.\n', 'docs/nome.md': 'Depois `run.sh`.\n', 'docs/outro.md': '# x\n',
             'scripts/run.sh': 'echo ok\n'}

    def test_a_destination_past_the_limit_is_unscanned_from_the_root_and_from_a_subfolder(self):
        model = self.scan(self.FILES, limit=7)
        self.assertFalse(model['stats']['inventory']['complete'])
        self.assertNotIn(self.path('scripts/run.sh'), {n['id'] for n in model['nodes'] if n['kind'] != 'unresolved'})
        modes = {raw_source: self.edge(model, *raw_source)['resolvedBy'] for raw_source in
                 [('CLAUDE.md', 'scripts/run.sh'), ('docs/guia.md', 'scripts/run.sh'), ('docs/nome.md', 'run.sh')]}
        self.assertEqual(modes, {('CLAUDE.md', 'scripts/run.sh'): None, ('docs/guia.md', 'scripts/run.sh'): 'root',
                                 ('docs/nome.md', 'run.sh'): 'basename'})
        self.assertEqual(self.status(model, self.path('scripts/run.sh')), 'unscanned')
        self.assertEqual(self.issues(model, 'broken') + self.issues(model, 'unresolved-name'), [])
        self.assertEqual(model['stats']['resolution']['unscanned'], 3)

    def test_control_absent_under_a_cut_inventory_is_still_broken(self):
        model = self.scan({**self.FILES, 'docs/guia.md': 'Use `scripts/falta.sh`.\n'}, limit=7)
        self.assertEqual(self.issues(model, 'broken'), [('docs/guia.md', 1, 'scripts/falta.sh')])

    def test_control_absent_under_a_complete_inventory_is_broken(self):
        model = self.scan({**self.FILES, 'docs/guia.md': 'Use `scripts/falta.sh`.\n'})
        self.assertEqual(self.issues(model, 'broken'), [('docs/guia.md', 1, 'scripts/falta.sh')])
        self.assertEqual(model['stats']['resolution']['unscanned'], 0)

    def test_ambiguity_lists_candidates_past_the_limit_with_the_total(self):
        model = self.scan({'AGENTS.md': '`comum.md`\n', 'a/comum.md': '# a\n', 'zz/fundo/comum.md': '# z\n'}, limit=5)
        ambiguous = next(i for i in model['issues'] if i['code'] == 'ambiguous')
        self.assertEqual([below(c, self.root) for c in ambiguous['candidates']], ['a/comum.md', 'zz/fundo/comum.md'])
        self.assertEqual(ambiguous['candidatesTotal'], 2)
        self.assertIn('1 beyond the inventory', ambiguous['message'])
        self.assertEqual(ambiguous['message'].params['hidden'], 1)  # the fact the interface reads
        self.assertIn('1 além do inventário', portuguese(ambiguous['message']))
        complete = self.scan()
        # Control: with every candidate inventoried the sentence says so, and has no `hidden`.
        whole = next(i for i in complete['issues'] if i['code'] == 'ambiguous')['message']
        self.assertEqual(whole, 'Ambiguous reference: comum.md (2 candidates in the inventory; none was chosen).')
        self.assertNotIn('hidden', whole.params)
        self.assertEqual(portuguese(whole), 'Referência ambígua: comum.md (2 candidatos no inventário; nenhum foi escolhido).')

    def test_two_readings_give_identical_json_with_or_without_the_limit(self):
        make(self.root, {**self.FILES, 'docs/falta.md': '[x](nada.md) `a/b.md` [[nota]]\n', 'memoria/n.md': '---\nname: nota\n---\n'})
        code = ('import json, sys; sys.path.insert(0, sys.argv[1]); from server import scanner; '
                'scanner.MAX_FILES = int(sys.argv[3]); print(json.dumps(scanner.scan([sys.argv[2]])))')
        for limit in ('20000', '7'):
            with self.subTest(limit=limit):
                outputs = {subprocess.run([sys.executable, '-B', '-c', code, str(CHECKOUT), str(self.root), limit], check=True, capture_output=True, text=True,
                                          env={**os.environ, 'PYTHONHASHSEED': seed}).stdout for seed in ('1', '2', '3')}
                self.assertEqual(len(outputs), 1)


class Unverified(ReaderCase):
    """Absence that cannot be affirmed is `unverified`, never `broken`."""

    def test_lookup_limit_makes_cascade_references_unverified(self):
        model = self.scan({'AGENTS.md': '`docs/falta.md`\n[[nota]]\n[Rel](./fora.md)\n', 'b/x.md': '# x\n', 'c/y.md': '# y\n', 'd/z.md': '# z\n'},
                          limit=3, lookup=2)
        self.assertFalse(model['stats']['inventory']['lookupComplete'])
        unverified = {i['target']: i for i in model['issues'] if i['code'] == 'unverified'}
        self.assertEqual(set(unverified), {'docs/falta.md', 'nota'})
        self.assertEqual({item['reason'] for item in unverified.values()}, {'lookup'})
        entry = self.path('AGENTS.md')
        self.assertEqual(unverified['docs/falta.md']['legacyId'], scanner.identity('broken', 'Target not found: docs/falta.md', entry, 1))
        self.assertEqual(self.status(model, self.path('docs/falta.md')), 'unverified')
        # Control: an anchored reference does not depend on the index and stays broken.
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 3, './fora.md')])
        self.assertIn('at least', next(i['message'] for i in model['issues'] if i['code'] == 'limit' and 'Inventory limit' in i['message']))

    def test_a_bare_wikilink_reads_the_headers_of_markdown_not_analysed(self):
        big = 'x' * 400 + '\n'
        files = {'AGENTS.md': '[[unica]]\n[[dupla]]\n[[nenhuma]]\n[[pasta/nenhuma]]\n',
                 'z/a.md': '---\nname: unica\n---\n' + big, 'z/b.md': '---\nname: dupla\n---\n' + big,
                 'z/c.md': '---\nname: dupla\n---\n' + big, 'z/sem.md': '# sem frontmatter\n' + big}
        model = self.scan(files, text=80)
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == self.path('z/a.md'))['analysis'], 'skipped')
        # One declarer: resolved by its frontmatter name; several: ambiguous; none: broken, now affirmed.
        edge = self.edge(model, 'AGENTS.md', 'unica')
        self.assertEqual((edge['target'], edge['resolvedBy']), (self.path('z/a.md'), 'frontmatter-name'))
        ambiguous = next(i for i in model['issues'] if i['code'] == 'ambiguous')
        self.assertEqual((ambiguous['target'], ambiguous['candidates']), ('dupla', [self.path('z/b.md'), self.path('z/c.md')]))
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 3, 'nenhuma'), ('AGENTS.md', 4, 'pasta/nenhuma')])
        self.assertFalse([i for i in model['issues'] if i['code'] == 'unverified'])
        # Past the inventory limit, the declarer is found by its header too: an unscanned destination.
        cut = self.scan(limit=3, text=80)
        edge = self.edge(cut, 'AGENTS.md', 'unica')
        self.assertEqual((edge['target'], edge['resolvedBy'], self.status(cut, edge['target'])), (self.path('z/a.md'), 'frontmatter-name', 'unscanned'))

    def test_control_an_unreadable_header_keeps_the_bare_wikilink_unverified(self):
        make(self.root, {'AGENTS.md': '[[nota]]\n[[pasta/nota]]\n'})
        os.mkfifo(self.root / 'especial.md')  # listed, never read: not a regular file
        model = self.scan()
        self.assertEqual([(i['target'], i['reason']) for i in model['issues'] if i['code'] == 'unverified'], [('nota', 'frontmatter')])
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 2, 'pasta/nota')])
        (self.root / 'especial.md').unlink()
        # Control: nothing left unread, the same wikilink is affirmed broken.
        self.assertEqual(self.issues(self.scan(), 'broken'), [('AGENTS.md', 1, 'nota'), ('AGENTS.md', 2, 'pasta/nota')])


class Listings(ReaderCase):
    """A folder not read is not shown as an empty folder."""

    FILES = {'CLAUDE.md': '# raiz\n', **{f'a/{i}.md': 'x\n' for i in range(5)}, 'vazia/': '', 'z/x.md': 'x\n', 'z/y.md': 'y\n'}

    def test_partial_unread_and_empty_folders_differ(self):
        model = self.scan(self.FILES, limit=9)
        folders = {below(n['id'], self.root): (n['listing'], n['omitted']) for n in model['nodes'] if n['kind'] == 'directory'}
        self.assertEqual(folders, {'.': ('complete', 3), 'a': ('partial', 1), 'vazia': ('complete', 0), 'z': ('unread', 2)})
        inventory = model['stats']['inventory']
        self.assertEqual({key: inventory[key] for key in ('complete', 'lookupComplete', 'omitted', 'omittedFiles')},
                         {'complete': False, 'lookupComplete': True, 'omitted': 3, 'omittedFiles': 3})
        self.assertEqual([(item['name'], item['inventoried'], item['onDisk']) for item in inventory['byTopLevel']],
                         [('a', 4, 5), ('vazia', 0, 0), ('z', 0, 2)])
        message = next(i['message'] for i in model['issues'] if i['code'] == 'limit')
        self.assertIn('folders read in part: 1; folders not read: 1; items left out of the inventory: 3.', message)
        self.assertIn('checked only for existence', message)
        # The numbers are also facts the interface reads, and the Portuguese of the sentence is what it was.
        self.assertEqual({name: message.params[name] for name in ('partial', 'unread', 'omitted', 'minimum')}, {'partial': 1, 'unread': 1, 'omitted': 3, 'minimum': False})
        self.assertIn('1 pasta(s) lida(s) em parte e 1 não lida(s), com 3 elemento(s) fora do inventário', portuguese(message))
        self.assertIn('conferidas só por existência', portuguese(message))

    def test_control_complete_inventory_lists_every_folder_complete(self):
        model = self.scan(self.FILES)
        self.assertEqual({n['listing'] for n in model['nodes'] if n['kind'] == 'directory'}, {'complete'})
        self.assertEqual(model['stats']['inventory'], {'complete': True, 'lookupComplete': True, 'omitted': 0, 'omittedFiles': 0, 'byTopLevel': [
            {'root': str(self.root), 'name': name, 'inventoried': count, 'onDisk': count} for name, count in (('a', 5), ('vazia', 0), ('z', 2))],
            'entriesOmitted': {'count': 0, 'paths': []}})
        self.assertFalse([i for i in model['issues'] if i['code'] == 'limit'])

    def test_audit_exposes_the_inventory_also_in_the_summary(self):
        make(self.root, self.FILES)
        output = io.StringIO()
        with mock.patch.object(scanner, 'MAX_FILES', 9), contextlib.redirect_stdout(output):
            cli.main(['audit', '--root', str(self.root), '--summary', '--top', '1'])
        report = json.loads(output.getvalue())
        inventory = report['metrics']['inventory']
        self.assertEqual((inventory['complete'], inventory['omitted'], inventory['byTopLevelTotal']), (False, 3, 3))
        self.assertEqual(inventory['byTopLevel'], [{'name': 'z', 'inventoried': 0, 'onDisk': 2}])
        self.assertNotIn('unanalyzed', report)


class TextBudget(ReaderCase):
    """Priority by kind and Markdown first; one budget finding per root, checkable against a list."""

    def test_budget_findings_are_one_per_root_and_match_the_unanalyzed_list(self):
        files = {'AGENTS.md': '# E\n', 'a.json': '{}\n', 'docs/z.md': '# z\n', 'logs/1.txt': 'x' * 50 + '\n', 'logs/2.txt': 'y' * 50 + '\n',
                 'big.md': 'g' * 300 + '\n'}
        with mock.patch.object(scanner, 'MAX_BYTES', 200):
            model = self.scan(files, text=8)
        nodes = {below(n['id'], self.root): n for n in model['nodes']}
        # Markdown before other text: docs/z.md (deeper) takes the budget a.json (shallower) would have taken.
        self.assertEqual({path for path, n in nodes.items() if n.get('analysis') == 'parsed'}, {'AGENTS.md', 'docs/z.md'})
        limits = [i for i in model['issues'] if i['code'] == 'limit']
        self.assertEqual(sorted(below(i['node'], self.root) for i in limits), ['.', 'big.md'])
        budget = next(i for i in limits if i['node'] == str(self.root))
        self.assertEqual((budget['count'], budget['bytes'], budget['byTopLevel']), (3, 105, {'.': 1, 'logs': 2}))
        self.assertTrue(all(n['analysis'] == 'skipped' for path, n in nodes.items() if path in {'a.json', 'logs/1.txt', 'logs/2.txt', 'big.md'}))
        with mock.patch.object(scanner, 'MAX_BYTES', 200), mock.patch.object(scanner, 'MAX_TEXT_TOTAL', 8):
            report = audit.audit(scanner.scan([str(self.root)]))
        listed = report['unanalyzed']
        self.assertEqual(sum(item['reason'] == 'budget' for item in listed), next(f['count'] for f in report['findings'] if f['code'] == 'limit' and 'count' in f))
        self.assertEqual({item['path']: item['reason'] for item in listed}, {'big.md': 'size', 'a.json': 'budget', 'logs/1.txt': 'budget', 'logs/2.txt': 'budget'})
        self.assertEqual(list(report)[-3:], ['unanalyzed', 'paths', 'findings'])

    def test_control_entry_comes_before_markdown_and_size_limit_stays_per_file(self):
        with mock.patch.object(scanner, 'MAX_BYTES', 10):
            model = self.scan({'AGENTS.md': '# E\n', 'a.md': '# a\n', 'b.md': '0123456789ABC\n'}, text=4)
        nodes = {below(n['id'], self.root): n for n in model['nodes']}
        self.assertEqual((nodes['AGENTS.md']['analysis'], nodes['a.md']['skippedBy'], nodes['b.md']['skippedBy']), ('parsed', 'budget', 'size'))
        self.assertEqual([i['message'] for i in model['issues'] if i['code'] == 'limit' and i['node'] == self.path('b.md')],
                         ['File listed, but not analyzed: text size limit.'])


class RelationCap(ReaderCase):
    """Relations cut by MAX_EDGES: reference findings stay complete, `unreachable` is not conclusive."""

    FILES = {'AGENTS.md': '[a](a.md)\n[falta](falta.md)\n`comum.md`\n', 'a.md': '[b](b.md)\n[falta2](falta2.md)\n', 'b.md': '# b\n',
             'x/comum.md': '# x\n', 'y/comum.md': '# y\n'}

    def test_reference_findings_stay_complete_and_unreachable_is_not_conclusive(self):
        make(self.root, self.FILES)
        whole = self.scan()
        with mock.patch.object(scanner, 'MAX_EDGES', 1):
            cut = self.scan()
        self.assertEqual(cut['stats']['relations'], {'complete': False, 'omitted': 3, 'max': 1})
        references = lambda model: sorted(i['id'] for i in model['issues'] if i['code'] not in {'limit', 'unreachable'})
        self.assertEqual(references(cut), references(whole))
        self.assertIn('broken', {i['code'] for i in cut['issues']})
        # b.md is reached only through a relation the cap left out: reported, but not as a fact.
        unreachable = {below(i['node'], self.root): i for i in cut['issues'] if i['code'] == 'unreachable'}
        self.assertFalse(unreachable['b.md']['conclusive'])
        self.assertIn('Not conclusive', unreachable['b.md']['message'])
        self.assertNotIn('b.md', {below(i['node'], self.root) for i in whole['issues'] if i['code'] == 'unreachable'})
        self.assertFalse(any('conclusive' in i for i in whole['issues']))
        report = audit.audit(cut)
        self.assertEqual((report['status'], report['metrics']['relations']['complete']), ('inconclusive', False))


class AmbiguousSeverity(ReaderCase):
    """A bare-name ambiguity is info in an absolute audit; a new one fails compare-audit --fail-on any."""

    def invoke(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli.main([str(argument) for argument in arguments])
        return code, json.loads(output.getvalue())

    def test_a_new_homonym_of_a_name_fails_compare_audit(self):
        make(self.root, {'AGENTS.md': '# E\nVeja `guia.md` e `ref/manual.md`.\n', 'docs/guia.md': '# guia\n', 'a/ref/manual.md': '# m\n'})
        _, before = self.invoke('audit', '--root', self.root)
        make(self.root, {'outro/guia.md': '# homônimo\n', 'b/ref/manual.md': '# homônimo com pasta\n'})
        code, after = self.invoke('audit', '--root', self.root, '--fail-on', 'any')
        severities = {f['target']: f['severity'] for f in after['findings'] if f['code'] == 'ambiguous'}
        self.assertEqual(severities, {'guia.md': 'info', 'ref/manual.md': 'warning'})
        self.assertEqual((code, after['gate']['matched']), (1, {'ambiguous': 1}))  # only the one written with a folder
        files = [self.base / 'antes.json', self.base / 'depois.json']
        for path, report in zip(files, (before, self.invoke('audit', '--root', self.root)[1])):
            path.write_text(json.dumps(report), encoding='utf-8')
        code, comparison = self.invoke('compare-audit', '--before', files[0], '--after', files[1], '--fail-on', 'any')
        self.assertEqual((code, comparison['status']), (1, 'fail'))
        self.assertEqual(sorted(f['target'] for f in comparison['new'] if f['code'] == 'ambiguous'), ['guia.md', 'ref/manual.md'])
        self.assertEqual(comparison['gate']['matched']['ambiguous'], 2)


class NotReferences(ReaderCase):
    """Syntax that is not a reference leaves no edge, placeholder or finding; each counted by reason."""

    def ignored(self, model):
        return {reason: count for reason, count in model['stats']['ignored'].items() if count}

    def test_variable_and_template_are_ignored_but_real_names_stay(self):
        model = self.scan({'AGENTS.md': ('`$DADOS/README.md`\n`registros/YYYY-MM-DD-tema.md`\n`YYYY-MM-DD.md` e `R-NNN.md` e `docs/XX-relatorio.md`\n'
                                         '`registros/2026-01-01-x.md`\n`docs/XX.md`\n'), 'docs/XX.md': '# existe\n'})
        self.assertEqual(self.ignored(model), {'variable': 1, 'template': 4})
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 4, 'registros/2026-01-01-x.md')])
        self.assertEqual(self.edge(model, 'AGENTS.md', 'docs/XX.md')['resolvedBy'], 'file')  # exists: kept
        self.assertFalse(any('$DADOS' in n['id'] or 'YYYY' in n['id'] for n in model['nodes']))

    def test_leading_elision_resolves_by_suffix_and_a_middle_one_is_ignored(self):
        model = self.scan({'AGENTS.md': 'Veja `…/a/b.py`, `.../a/b.py`, …/a/b.py e `x/…/b.py`.\n`x/a/c.py`\n', 'pkg/a/b.py': 'pass\n'})
        self.assertEqual([e['resolvedBy'] for e in model['edges'] if e['raw'] in {'…/a/b.py', '.../a/b.py'}], ['suffix'])
        self.assertEqual(self.ignored(model), {'elision': 1})
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 2, 'x/a/c.py')])

    def test_code_wikilinks_are_ignored_unless_they_resolve_and_note_names_are_not(self):
        text = ('if [[ -f "$X" ]]; then\ngrep "[[:space:]]" a\n[[…]]\n[[Minha nota (v2)]] [[nota, parte 2]]\n'
                '[[2026-11-10]] [[2026-11-11]] [[202611111230]]\n[[decisoes#^d1]] [[decisoes-velhas#^d2]]\n'
                '| [[guia\\|o guia]] | x |\n[[ nota ]] [[a=b]]\n')
        model = self.scan({'AGENTS.md': text, 'memoria/2026-11-10.md': '# dia\n', 'memoria/202611111230.md': '# id\n',
                           'decisoes.md': '# d\n', 'guia.md': '# g\n', 'nota.md': '# n\n', 'a=b.md': '# código que existe\n'})
        # Code-like text that does not resolve: ignored. Code-like text that resolves: a relation.
        self.assertEqual(self.ignored(model), {'code': 3})
        self.assertEqual(self.edge(model, 'AGENTS.md', 'a=b')['target'], self.path('a=b.md'))
        # Dates, numeric ids, block references, escaped table aliases and padded names are notes.
        targets = {e['raw']: below(e['target'], self.root) for e in model['edges'] if e['kind'] == 'wiki' and e['resolvedBy']}
        self.assertEqual(targets, {'2026-11-10': 'memoria/2026-11-10.md', '202611111230': 'memoria/202611111230.md', 'decisoes#^d1': 'decisoes.md',
                                   'guia': 'guia.md', 'nota': 'nota.md', 'a=b': 'a=b.md'})
        self.assertEqual([i[2] for i in self.issues(model, 'broken')], ['Minha nota (v2)', 'nota, parte 2', '2026-11-11', 'decisoes-velhas#^d2'])

    def test_manifest_keys_only_in_manifests(self):
        model = self.scan({'AGENTS.md': '# E\n', 'tsconfig.json': '{"compilerOptions": {"target": "ES2022"}, "x": "./falta.md"}\n',
                           'dados/lista.json': '[{"source": "fonte-a", "path": "modelos/carta.md"}]\n',
                           'plugin.json': '{"skills": "skills/ausente.md"}\n'})
        self.assertEqual(self.ignored(model), {'manifest-key': 3})
        # Control: a manifest keeps its keys; an inline ./path in any JSON is still a reference.
        self.assertEqual(sorted(self.issues(model, 'broken')), [('plugin.json', 1, 'skills/ausente.md'), ('tsconfig.json', 1, './falta.md')])

    def test_fenced_blocks_keep_shell_paths_and_drop_what_does_not_resolve_elsewhere(self):
        text = ('```sh\nbash ./scripts/x.sh\n[ver](ausente)\n```\n'
                '```python\nopen(\'./config.yaml\')\nprint(\'./docs/guia.md\')\n```\n'
                '~~~\ncat ./saida/relatorio.md\n~~~\n'
                'Fora: ./saida/relatorio.md\n')
        model = self.scan({'AGENTS.md': text, 'docs/guia.md': '# guia\n'})
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 2, './scripts/x.sh'), ('AGENTS.md', 10, './saida/relatorio.md'), ('AGENTS.md', 12, './saida/relatorio.md')])
        self.assertEqual(self.ignored(model), {'fenced': 2})
        self.assertEqual(self.edge(model, 'AGENTS.md', './docs/guia.md')['resolvedBy'], 'file')

    def test_line_addresses_name_their_file(self):
        model = self.scan({'AGENTS.md': '`docs/x.md:41` `docs/y.py:2,6-9` `docs/arquivo.md:41` `./z.md:41-42` `arquivo.md:41`\n',
                           'docs/x.md': '# x\n', 'docs/y.py': 'pass\n'})
        self.assertEqual(self.edge(model, 'AGENTS.md', 'docs/x.md:41')['target'], self.path('docs/x.md'))
        self.assertEqual(self.edge(model, 'AGENTS.md', 'docs/y.py:2,6-9')['target'], self.path('docs/y.py'))
        # Control: the file absent is still reported, with the reference as written; a bare name
        # follows the rule of the written form (unresolved-name), as without the line address.
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 1, 'docs/arquivo.md:41'), ('AGENTS.md', 1, './z.md:41-42')])
        self.assertEqual(self.issues(model, 'unresolved-name'), [('AGENTS.md', 1, 'arquivo.md:41')])

    def test_prose_paths_cut_by_a_glob_are_not_extracted(self):
        model = self.scan({'AGENTS.md': 'ls ./saida/*.md e ~/x/$Y e ./saida/<data>.md\nVeja ./saida/x.md.\n'
                                        'Nota ./docs/guia.md[1] e <td>./docs/celula.md</td>\n(ver ./docs/a.md), ./docs/b.md, (pasta ./docs/sub), ./docs/sub/,\n',
                           'docs/a.md': '# a\n', 'docs/b.md': '# b\n', 'docs/sub/c.md': '# c\n'})
        self.assertEqual(self.ignored(model), {'cut': 3})
        # A match that ends with an extension is a file, whatever follows it.
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 2, './saida/x.md'), ('AGENTS.md', 3, './docs/guia.md'), ('AGENTS.md', 3, './docs/celula.md')])
        # Control: parentheses and commas never cut a path.
        self.assertEqual({e['raw'] for e in model['edges'] if e['line'] == 4}, {'./docs/a.md', './docs/b.md', './docs/sub'})  # sub/ is the same relation

    def test_txt_is_data_except_explicit_links(self):
        model = self.scan({'AGENTS.md': '# E\n', 'logs/hashes.txt': 'f1ac5a0a  ./saida-1.txt\n`a.md` [[nota]] ~/x/y.md\n[link](falta.md)\n@importado.md\n'})
        self.assertEqual(self.ignored(model), {'txt': 4})
        self.assertEqual(sorted(self.issues(model, 'broken')), [('logs/hashes.txt', 3, 'falta.md'), ('logs/hashes.txt', 4, 'importado.md')])


class RootDot(ReaderCase):
    """A `./` mention in backticks or prose also tries the opened root (root-dot)."""

    def test_dot_mentions_fall_back_to_the_root_and_links_stay_strict(self):
        model = self.scan({'CLAUDE.md': '# raiz\n', 'y.md': '# y\n', 'vendor/R.md': '# r\n',
                           'notas/x/README.md': 'Base: `./vendor/R.md` e ./vendor/R.md.\n[y](./y.md)\n`./nao-existe.md`\n[sobe](../falta.md)\n'})
        self.assertEqual(self.edge(model, 'notas/x/README.md', './vendor/R.md')['resolvedBy'], 'root-dot')
        self.assertEqual(model['stats']['resolution']['root-dot'], 1)  # backticks and prose on one line: one relation
        self.assertEqual(self.issues(model, 'broken'), [('notas/x/README.md', 2, './y.md'), ('notas/x/README.md', 3, './nao-existe.md'),
                                                        ('notas/x/README.md', 4, '../falta.md')])


class OutsideRoot(unittest.TestCase):
    """A destination missing in the opened root but present elsewhere in its repository is `outside-root`.

    The probe runs only when an ancestor of the opened root, within three levels, has .git; it
    tests the ancestors up to that one, by existence only, never through a link or out of it.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-outside-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_a_package_with_its_own_repository_inside_a_project(self):
        project = make(self.base / 'projeto', {'.git/': '', 'memoria/x.md': '# x\n', 'acima.md': '# a\n',
                                               'pacote/.git/': '', 'pacote/skill.md': '`memoria/x.md`\n`acima.md`\n`memoria/falta.md`\n'})
        package = project / 'pacote'
        model = scanner.scan([str(package)])
        found = {i['target']: i for i in model['issues'] if i['code'] == 'outside-root'}
        self.assertEqual(set(found), {'memoria/x.md', 'acima.md'})
        self.assertEqual((found['memoria/x.md']['ancestor'], found['memoria/x.md']['levels']), (str(project), 1))
        source = str(package / 'skill.md')
        self.assertEqual(found['memoria/x.md']['legacyId'], scanner.identity('broken', 'Target not found: memoria/x.md', source, 1))
        self.assertEqual(found['acima.md']['legacyId'], scanner.identity('unresolved-name', scanner.LEGACY_MESSAGES['unresolved-name'].format(raw='acima.md'), source, 2))
        # The message says where: in the same repository, the ancestor by name, how far up and the path relative to the root.
        self.assertIn('in the same repository (that of projeto, with .git)', found['memoria/x.md']['message'])
        self.assertIn('in the ancestor projeto (.., 1 level above the open folder), at ../memoria/x.md', found['memoria/x.md']['message'])
        said = portuguese(found['memoria/x.md']['message'])
        self.assertIn('no mesmo repositório (o de projeto, com .git)', said)
        self.assertIn('no ancestral projeto (.., 1 nível acima do diretório aberto), em ../memoria/x.md', said)
        self.assertNotIn(str(self.base), found['memoria/x.md']['message'])
        roots = [root['path'] for root in model['roots']]
        for issue in found.values():
            shown = os.path.normpath(os.path.join(package, issue['message'].split(', at ')[1].split('. ')[0]))
            target = next(e['target'] for e in model['edges'] if e['line'] == issue['line'] and e['raw'] == issue['target'])
            self.assertEqual(shown, target)
            self.assertFalse([root for root in roots if shown == root or shown.startswith(root + '/')], shown)
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == str(project / 'memoria/x.md'))['status'], 'external')
        # Control: absent above too, still broken.
        self.assertEqual([i['target'] for i in model['issues'] if i['code'] == 'broken'], ['memoria/falta.md'])
        self.assertEqual(model['stats']['probe'], {'maxLevels': 3, 'ancestors': [
            {'root': str(package), 'levels': 1, 'stop': 'git', 'repository': '..', 'probes': 3}]})
        report = audit.audit(model, fail_on=['outside-root'])
        finding = next(f for f in report['findings'] if f['code'] == 'outside-root' and f['target'] == 'memoria/x.md')
        self.assertEqual((finding['severity'], finding['ancestor'], report['status']), ('warning', '..', 'fail'))
        self.assertNotIn(str(self.base), json.dumps(report['findings']))

    def test_without_a_repository_above_there_is_no_probe(self):
        # A repository kept in a personal folder: the folder above holds the user's own files.
        home = make(self.base / 'home', {'.claude/settings.json': '{}\n', 'docs/guia.md': '# g\n', 'README.md': '# r\n',
                                         'proj/.git/': '', 'proj/CLAUDE.md': '`.claude/settings.json` `docs/guia.md` `README.md`\n'})
        model = scanner.scan([str(home / 'proj')])
        self.assertEqual(model['stats']['probe']['ancestors'], [{'root': str(home / 'proj'), 'levels': 0, 'stop': 'none', 'repository': None, 'probes': 0}])
        self.assertEqual(sorted((i['code'], i['target']) for i in model['issues'] if i.get('target')),
                         [('broken', '.claude/settings.json'), ('broken', 'docs/guia.md'), ('unresolved-name', 'README.md')])

    def test_the_probe_stops_at_the_ancestor_with_git_and_within_three_levels(self):
        make(self.base, {'alvo.md': '# acima do repositório\n', 'g1/.git/': '', 'g1/x/perto.md': '# no repositório\n',
                         'n1/.git/': '', 'n1/x/longe.md': '# repositório a 4 níveis\n'})
        inside = make(self.base / 'g1/g2/raiz', {'a.md': '`alvo.md`\n`x/perto.md`\n'})
        model = scanner.scan([str(inside)])
        self.assertEqual(model['stats']['probe']['ancestors'][0]['levels'], 2)
        self.assertEqual(sorted((i['code'], i['target']) for i in model['issues'] if i.get('target')),
                         [('outside-root', 'x/perto.md'), ('unresolved-name', 'alvo.md')])
        far = make(self.base / 'n1/n2/n3/n4/raiz', {'a.md': '`x/longe.md`\n'})
        model = scanner.scan([str(far)])
        self.assertEqual(model['stats']['probe']['ancestors'][0]['stop'], 'none')
        self.assertEqual([(i['code'], i['target']) for i in model['issues'] if i.get('target')], [('broken', 'x/longe.md')])

    def test_a_dot_mention_that_climbs_never_reaches_the_probe(self):
        # Regression: `./` followed by enough `../` to leave the root would have made the
        # probe an existence oracle for any absolute path.
        up = '../' * 30
        deep = self.base / 'proj' / 'r' / '/'.join(f'd{i}' for i in range(30))
        make(self.base / 'proj', {'.git/': '', 'r/AGENTS.md': '# e\n'})
        make(deep, {'x.md': f'Ver `./{up}etc/passwd` e `./{up}etc/naoexiste-xyz`.\n'})
        model = scanner.scan([str(self.base / 'proj' / 'r')])
        self.assertFalse([i for i in model['issues'] if i['code'] == 'outside-root'])
        self.assertEqual(sorted(i['code'] for i in model['issues'] if i.get('target')), ['broken', 'broken'])
        self.assertFalse([n['id'] for n in model['nodes'] if '..' in n['id'].split('/')])
        # The reference of "Alterações" saved by this reader loads again (no `..` in a marker id).
        state = self.base / 'estado'
        state.mkdir()
        root = str(self.base / 'proj' / 'r')
        store = delta.ReferenceStore(state)
        self.assertIsNone(store.save(root, delta.read(model, '2026-11-11T00:00:00+00:00')[root]))
        reference, problem = store.load(root)
        self.assertIsNone(problem)
        self.assertIsNotNone(reference)

    def test_the_probe_never_follows_a_link(self):
        # Regression: a subfolder of someone else's repository, which plants `evil -> /`.
        repo = make(self.base / 'repo', {'.git/': '', 'r/AGENTS.md': '# e\n', 'r/x.md': '[a](evil/etc/passwd) [c](evil/nao/existe.md)\n',
                                         'real/y.md': '# y\n', 'r/y.md': '[y](link/y.md)\n'})
        os.symlink('/', repo / 'evil')
        os.symlink(repo / 'real', repo / 'link')
        model = scanner.scan([str(repo / 'r')])
        self.assertFalse([i for i in model['issues'] if i['code'] == 'outside-root'])
        self.assertEqual(sorted(i['target'] for i in model['issues'] if i['code'] == 'broken'), ['evil/etc/passwd', 'evil/nao/existe.md', 'link/y.md'])

    def test_a_reference_that_starts_with_the_root_name_resolves_from_the_root(self):
        package = make(self.base / 'pacote', {'.git/': '', 'a/b.md': '# b\n', 'y.md': '# y fora da pasta homônima\n', 'pacote/y.md': '# y\n',
                                              'docs/x.md': '`pacote/a/b.md`\n`pacote/a/falta.md`\n`pacote/y.md`\n', 'leia.md': 'Veja `pacote/a/b.md`.\n'})
        model = scanner.scan([str(package)])
        edges = {e['raw']: (e['target'], e['resolvedBy']) for e in model['edges'] if e['kind'] == 'path' and e['source'].endswith('/docs/x.md')}
        self.assertEqual(edges['pacote/a/b.md'], (str(package / 'a/b.md'), 'root'))
        # A top-level folder with the root's name is tried first, as from the root.
        self.assertEqual(edges['pacote/y.md'], (str(package / 'pacote/y.md'), 'root'))
        # Control: absent from the root too, still broken (never outside-root: the probe only looks above).
        self.assertEqual([(i['code'], i['target']) for i in model['issues'] if i.get('target')], [('broken', 'pacote/a/falta.md')])
        # Past the inventory limit, the same step finds it by existence.
        with mock.patch.object(scanner, 'MAX_FILES', 6):
            cut = scanner.scan([str(package)])
        edge = next(e for e in cut['edges'] if e['raw'] == 'pacote/a/b.md' and e['source'] == str(package / 'leia.md'))
        self.assertEqual((edge['resolvedBy'], next(n for n in cut['nodes'] if n['id'] == edge['target'])['status']), ('root', 'unscanned'))

    def test_the_probe_never_returns_a_path_inside_an_opened_root(self):
        make(self.base, {'.git/': '', 'B/x.md': '# em outra raiz aberta\n', 'A/a.md': '`B/x.md`\n'})
        model = scanner.scan([str(self.base / 'A'), str(self.base / 'B')])
        self.assertEqual([(i['code'], i['target']) for i in model['issues'] if i.get('target')], [('broken', 'B/x.md')])


class FindingDetails(ReaderCase):
    """Reference findings carry evidence, syntax and form; unchanged findings keep their ids."""

    # aae audit ids of this tree under the reader before the limit and syntax rules (none of its cases is touched by them).
    GOLDEN = {('ambiguous', 'AGENTS.md', 6, 'ambos'): '7a965b5343d568c1', ('ambiguous', 'AGENTS.md', 7, 'comum.md'): '8690ded01f50d331',
              ('broken', 'AGENTS.md', 3, 'docs/falta.md'): '8cc63c9e0c956582', ('broken', 'AGENTS.md', 4, 'docs/ausente.md'): '12ec51ffc25f6c1e',
              ('broken', 'AGENTS.md', 10, 'docs/falta.md'): '61a32700d338129c', ('broken', 'docs/guia.md', 3, '../docs/falta.md'): '764eea6432b96a57',
              ('declared-external', 'AGENTS.md', 9, 'runtime/saida.md'): '3b841e77d6e49455', ('invalid-reference', 'AGENTS.md', 8, 'file://[x'): 'd11202c36a804750',
              ('scope-unused-pattern', 'agent-architecture.json', None, None): '4f931023b128e3b4', ('symlink', 'link.md', None, None): '574011728d256622',
              ('unreachable', 'orfao.md', None, None): '13fbb9f7c9def6a5', ('unreachable', 'x/ambos.md', None, None): 'bae05fb32fce1287',
              ('unreachable', 'x/comum.md', None, None): '96cb985d77a650bb', ('unreachable', 'y/ambos.md', None, None): 'b3267eda58566b0a',
              ('unreachable', 'y/comum.md', None, None): '664c576abe5bd24d', ('unresolved-name', 'AGENTS.md', 5, 'fantasma.md'): 'f7896dbf41b6cb73'}
    FILES = {
        'AGENTS.md': ('# Entrada\n[Guia](docs/guia.md)\n[Falta](docs/falta.md)\n`docs/ausente.md`\n`fantasma.md`\n[[ambos]]\n`comum.md`\n'
                      '[Ruim](file://[x)\n[Escopo](runtime/saida.md)\n[Falta](docs/falta.md) de novo\n'),
        'docs/guia.md': '# Guia\n[Volta](../AGENTS.md)\n[Outra](../docs/falta.md)\n',
        'x/ambos.md': '# x\n', 'y/ambos.md': '# y\n', 'x/comum.md': '# x\n', 'y/comum.md': '# y\n', 'orfao.md': '# Órfão\n',
        'agent-architecture.json': '{"version": 1, "scope": {"version": 1, "runtimeWorkspace": ["runtime/"], "localFiles": ["nada/"]}}\n'}

    def test_ids_of_untouched_findings_are_those_of_the_earlier_reader(self):
        make(self.root, self.FILES)
        (self.root / 'link.md').symlink_to(self.root / 'docs/guia.md')
        model = self.scan()
        report = audit.audit(model)
        self.assertEqual({(f['code'], f.get('path'), f.get('line'), f.get('target')): f['id'] for f in report['findings']}, self.GOLDEN)
        earlier = {'broken': scanner.LEGACY_MESSAGES['broken'], 'unresolved-name': scanner.LEGACY_MESSAGES['unresolved-name']}
        for issue in model['issues']:
            with self.subTest(code=issue['code'], line=issue['line']):
                self.assertEqual(issue['id'], scanner.identity(issue['code'], issue['message'], issue['node'], issue['line']))
                if issue['code'] in earlier:
                    self.assertEqual(issue['message'], earlier[issue['code']].format(raw=issue['target']))

    def test_reference_findings_carry_evidence_syntax_and_form(self):
        make(self.root, self.FILES)
        model = self.scan()
        by_target = {i['target']: i for i in model['issues'] if i.get('target')}
        self.assertEqual({target: (i['syntax'], i['form']) for target, i in by_target.items()},
                         {'docs/falta.md': ('markdown', 'path'), 'docs/ausente.md': ('path', 'path'), 'fantasma.md': ('path', 'name'),
                          'ambos': ('wiki', 'word'), 'comum.md': ('path', 'name'), 'file://[x': ('markdown', 'path'), '../docs/falta.md': ('markdown', 'path')})
        self.assertEqual(by_target['docs/ausente.md']['evidence'], '`docs/ausente.md`')
        # The compact reading of "Alterações" keeps no excerpt; the summary does not grow with them.
        compact = delta.read(model, '2026-11-11T00:00:00+00:00')[str(self.root)]
        self.assertFalse(any('evidence' in finding for finding in compact['audit']['findings']))
        self.assertTrue(all('syntax' in finding for finding in compact['audit']['findings'] if finding['code'] == 'broken'))
        self.assertNotIn('findings', audit.audit(model, summary=True))

    def test_audit_legacy_id_matches_the_broken_id_of_the_same_reference(self):
        project = make(self.base / 'projeto', {'.git/': '', 'pacote/skill.md': '# s\n`memoria/x.md`\n'})
        broken = audit.audit(scanner.scan([str(project / 'pacote')]))
        make(project, {'memoria/x.md': '# x\n'})
        outside = audit.audit(scanner.scan([str(project / 'pacote')]))
        before = next(f for f in broken['findings'] if f['code'] == 'broken')
        after = next(f for f in outside['findings'] if f['code'] == 'outside-root')
        self.assertEqual(after['legacyId'], before['id'])
        self.assertNotEqual(after['id'], before['id'])

class HostileInput(ReaderCase):
    """Names that are not UTF-8, references that are too long and folders that cannot be listed never break a reading."""

    def cli(self, *arguments, limit=None):
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            if limit:
                stack.enter_context(mock.patch.object(scanner, 'MAX_FILES', limit))
            stack.enter_context(contextlib.redirect_stdout(output))
            code = cli.main([str(argument) for argument in arguments])
        return code, json.loads(output.getvalue())

    def test_a_name_that_is_not_utf8_is_unreadable_inventoried_or_past_the_limit(self):
        make(self.root, {'AGENTS.md': '# e\nVer `guia.md`.\n', **{f'a/f{i}.md': '' for i in range(12)}})
        os.makedirs(os.fsencode(self.root) + b'/zz\xff')
        with open(os.fsencode(self.root) + b'/ruim\xfe.md', 'w') as stream:
            stream.write('# inventariado\n')
        for limit in (None, 6):
            with self.subTest(limit=limit):
                model = self.scan(limit=limit)
                json.dumps(model, ensure_ascii=False).encode('utf-8')  # every string of the model is valid UTF-8
                messages = [i['message'] for i in model['issues'] if i['code'] == 'unreadable']
                self.assertTrue(any('ruim\\xfe.md' in message for message in messages), messages)
                self.assertFalse([n['id'] for n in model['nodes'] if 'ruim' in n['id'] or 'zz' in n['id']])
                code, report = self.cli('audit', '--root', self.root, '--summary', limit=limit)
                self.assertEqual((code, report['status']), (3, 'inconclusive'))

    def test_a_name_that_is_not_utf8_past_the_limit_leaves_the_index_incomplete(self):
        make(self.root, {'AGENTS.md': '# e\nVer `guia.md`.\n', **{f'a/f{i}.md': '' for i in range(12)}})
        folder = os.fsencode(self.root) + b'/zz/sub\xff'
        os.makedirs(folder)
        with open(folder + b'/guia.md', 'w') as stream:
            stream.write('# g\n')
        model = self.scan(limit=6)
        self.assertFalse(model['stats']['inventory']['lookupComplete'])
        self.assertEqual([(i['code'], i['target']) for i in model['issues'] if i.get('target')], [('unverified', 'guia.md')])

    def test_a_folder_that_cannot_be_listed_past_the_limit_leaves_the_index_incomplete(self):
        if os.geteuid() == 0:
            self.skipTest('root lists any folder')
        make(self.root, {'AGENTS.md': '# e\n', **{f'a/f{i}.md': '' for i in range(12)}, 'z/fechada/dentro.md': '# x\n'})
        os.chmod(self.root / 'z' / 'fechada', 0)
        self.addCleanup(os.chmod, self.root / 'z' / 'fechada', 0o755)
        model = self.scan(limit=6)
        self.assertFalse(model['stats']['inventory']['lookupComplete'])
        self.assertIn('at least', next(i['message'] for i in model['issues'] if i['code'] == 'limit'))
        # Control: inventoried in full, the same unreadable folder does not touch the index.
        self.assertTrue(self.scan()['stats']['inventory']['lookupComplete'])

    def test_a_reference_above_the_byte_limit_is_ignored_before_any_resolution(self):
        import time
        long_path = './a' * 100_000  # a written path of 300 KB in prose
        model_text = f'`{"b/" * 3000}x.md` [l]({"c/" * 3000}y.md) `x.md:{",".join(["1"] * 200_000)}`\nVer {long_path}/z.md e .../{"d/" * 3000}w.md\n'
        started = time.monotonic()
        model = self.scan({'AGENTS.md': model_text})
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(model['stats']['ignored']['too-long'], 5)
        self.assertFalse([i for i in model['issues'] if i.get('target')])
        # Control: a long but plausible path is still a reference.
        self.assertEqual(self.issues(self.scan({'AGENTS.md': f'`{"d/" * 100}x.md`\n'}), 'broken'), [('AGENTS.md', 1, f'{"d/" * 100}x.md')])

    def test_many_homonyms_past_the_limit_cost_one_lookup_per_reference(self):
        import time
        for index in range(30_000):
            folder = self.root / 'pkgs' / f'p{index}'
            folder.mkdir(parents=True)
            (folder / 'index.md').write_text('')
        make(self.root, {'AGENTS.md': '# e\n', 'cite.md': ''})
        started = time.monotonic()
        self.scan(limit=50)
        baseline = time.monotonic() - started
        refs = ''.join(f'[x](zz{i}/index.md)\n' for i in range(3000)) + ''.join(f'Ver `index.md` em {i}.\n' for i in range(3000))
        (self.root / 'cite.md').write_text(refs)
        for name in ('a', 'b', 'c'):
            make(self.root, {f'{name}/cite.md': 'Ver `index.md`.\n'})
        started = time.monotonic()
        model = self.scan(limit=50)
        cost = time.monotonic() - started - baseline
        self.assertEqual(sum(i['code'] == 'broken' for i in model['issues']), 3000)
        ambiguous = next(i for i in model['issues'] if i['code'] == 'ambiguous')
        self.assertEqual(ambiguous['candidatesTotal'], 30_000)
        self.assertLess(cost, max(2.0, baseline), (cost, baseline))


class HeaderBudget(ReaderCase):
    """Headers of Markdown not analysed are read by descriptor, block by block, within their own budget."""

    def test_headers_stop_at_the_first_block_and_at_the_budget(self):
        body = 'x' * 4000 + '\n'
        files = {'AGENTS.md': '[[declarado]]\n', **{f'z/sem{i}.md': body for i in range(3)},
                 'z/zz.md': '---\nname: declarado\n---\n' + body}
        reads = []
        real = os.read

        def counted(descriptor, size):
            data = real(descriptor, size)
            reads.append(len(data))
            return data
        with mock.patch.object(scanner.os, 'read', counted):
            model = self.scan(files, text=20)
        headers = model['stats']['headers']
        # Three files without frontmatter cost one first block each; the declarer stops at its closing line.
        self.assertEqual(sum(reads), headers['bytes'])
        self.assertLessEqual(headers['bytes'], 3 * scanner.HEADER_FIRST_BLOCK + 4096 + scanner.HEADER_FIRST_BLOCK)
        self.assertEqual((headers['files'], headers['complete']), (4, True))
        self.assertEqual(self.edge(model, 'AGENTS.md', 'declarado')['resolvedBy'], 'frontmatter-name')
        # Past the budget the header is not read, and the absence cannot be affirmed.
        with mock.patch.object(scanner, 'MAX_HEADER_BYTES', 3 * scanner.HEADER_FIRST_BLOCK):
            cut = self.scan(text=20)
        self.assertFalse(cut['stats']['headers']['complete'])
        self.assertLessEqual(cut['stats']['headers']['bytes'], 3 * scanner.HEADER_FIRST_BLOCK)
        self.assertEqual([(i['code'], i['reason']) for i in cut['issues'] if i['code'] == 'unverified'], [('unverified', 'frontmatter')])

    def test_an_analysed_declarer_and_a_hidden_one_are_ambiguous(self):
        files = {'AGENTS.md': '[[nota]]\n', 'a/atual.md': '---\nname: nota\n---\n', 'z/copia.md': '---\nname: nota\n---\n' + 'x' * 400 + '\n'}
        model = self.scan(files, text=50)
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == self.path('z/copia.md'))['analysis'], 'skipped')
        ambiguous = next(i for i in model['issues'] if i['code'] == 'ambiguous')
        self.assertEqual(ambiguous['candidates'], [self.path('a/atual.md'), self.path('z/copia.md')])
        # Control: a full reading says the same.
        self.assertEqual(next(i for i in self.scan()['issues'] if i['code'] == 'ambiguous')['candidates'], ambiguous['candidates'])


    def test_headers_read_to_their_end_at_the_exact_budget_are_complete(self):
        body = '---\ndescricao: ' + 'x' * 984 + '\n'  # 1,000 bytes, a header that never closes
        files = {'AGENTS.md': '[[nada-declarado]]\n', **{f'z/n{i}.md': body for i in range(3)}}
        for budget, complete, code in ((3000, True, 'broken'), (2999, False, 'unverified'), (3001, True, 'broken')):
            with self.subTest(budget=budget), mock.patch.object(scanner, 'MAX_HEADER_BYTES', budget):
                model = self.scan(files, text=20)
                headers = model['stats']['headers']
                self.assertEqual((headers['complete'], headers['bytes'] if complete else None), (complete, 3000 if complete else None))
                self.assertEqual([i['code'] for i in model['issues'] if i.get('target') == 'nada-declarado'], [code])
        # Control: at the exact budget, a declarer is still found.
        make(self.root, {'z/n2.md': '---\nname: nada-declarado\n---\n' + 'x' * 970 + '\n'})
        with mock.patch.object(scanner, 'MAX_HEADER_BYTES', 3000):
            model = self.scan(text=20)
        self.assertEqual(self.edge(model, 'AGENTS.md', 'nada-declarado')['resolvedBy'], 'frontmatter-name')


class ReviewControls(ReaderCase):
    """Controls of the rules where they could grow unseen (one per mutation of the rules that must be caught)."""

    def test_fences_close_with_any_indent_and_an_unclosed_one_silences_nothing(self):
        text = ('1. passo\n   ```sh-session\n   $ ./scripts/rodar.sh\n    ```\n'
                '```powershell\n& ./scripts/deploy.ps1\n```\n'
                '````python\nopen("./config.yaml")\n```\n'
                '## Regras\n[o guia](docs/guia-que-falta.md)\n')
        model = self.scan({'AGENTS.md': text})
        self.assertEqual(sorted(i[2] for i in self.issues(model, 'broken')),
                         ['./config.yaml', './scripts/deploy.ps1', './scripts/rodar.sh', 'docs/guia-que-falta.md'])
        self.assertEqual(scanner.fence_contexts(['```', 'a', '  ```']), ['fence', 'shell', 'fence'])
        self.assertEqual(scanner.fence_contexts(['````python', 'a', '```']), [None, None, None])

    def test_a_further_indented_fence_inside_a_block_does_not_close_it(self):
        text = ('```markdown\nExemplo:\n\n    ```bash\n    ./scripts/exemplo.sh\n    ```\n```\n\n'
                'Depois, veja [o guia](guia-que-falta.md) e `regras.md`.\n\n```bash\n./scripts/real.sh\n```\n')
        model = self.scan({'AGENTS.md': text})
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 9, 'guia-que-falta.md'), ('AGENTS.md', 12, './scripts/real.sh')])
        self.assertEqual(self.issues(model, 'unresolved-name'), [('AGENTS.md', 9, 'regras.md')])
        self.assertEqual(scanner.fence_contexts(['```', '    ```', '```']), ['fence', 'shell', 'fence'])
        self.assertEqual(scanner.fence_contexts(['```', 'a', '     ```']), [None, None, None])  # only a closer too indented: no block
        # Control: in a list, opening and closing indented alike still pair (up to the opening + 3).
        self.assertEqual(scanner.fence_contexts(['1. a', '   ```sh', '   x', '      ```']), [None, 'fence', 'shell', 'fence'])
        self.assertEqual(scanner.fence_contexts(['1. a', '   ```sh', '   x', '       ```']), [None, None, None, None])

    def test_shell_tests_and_quoted_key_lists_in_double_brackets_are_code(self):
        text = ("if [[ -d memoria ]]; then x; fi\n[[ ! -e saida ]] && y\nnomes = df[['nome', 'idade']]\n[[ -f x ]]\n"
                '[[nota-que-falta]] e [[-nota]]\n')
        model = self.scan({'AGENTS.md': text, '-f x.md': '# arquivo de nome estranho\n'})
        self.assertEqual(self.issues(model, 'broken'), [('AGENTS.md', 5, 'nota-que-falta'), ('AGENTS.md', 5, '-nota')])
        self.assertEqual(model['stats']['ignored']['code'], 3)
        # Soft: code-like text that resolves is still a relation.
        self.assertEqual(self.edge(model, 'AGENTS.md', '-f x')['target'], self.path('-f x.md'))

    def test_dot_never_recedes_for_parent_paths_nor_for_a_local_folder(self):
        model = self.scan({'CLAUDE.md': '# raiz\n', 'x.md': '# x\n', 'scripts/gerar.sh': 'echo\n',
                           'skills/relatorio/SKILL.md': '`../x.md` `./scripts/gerar.sh` `./x.md`\n', 'skills/relatorio/scripts/outro.sh': 'echo\n'})
        self.assertEqual(sorted(i[2] for i in self.issues(model, 'broken')), ['../x.md', './scripts/gerar.sh'])
        edge = self.edge(model, 'skills/relatorio/SKILL.md', './x.md')
        self.assertEqual(edge['resolvedBy'], 'root-dot')
        report = audit.audit(model)
        self.assertEqual([(f['code'], f['target']) for f in report['findings'] if f['code'] == 'root-dot-resolved'], [('root-dot-resolved', './x.md')])

    def test_a_variable_in_a_real_file_name_keeps_the_relation(self):
        model = self.scan({'AGENTS.md': '`docs/preco-$.md` `docs/$X/a.md`\n', 'docs/preco-$.md': '# p\n'})
        self.assertEqual(self.edge(model, 'AGENTS.md', 'docs/preco-$.md')['resolvedBy'], 'file')
        self.assertEqual(model['stats']['ignored']['variable'], 1)

    def test_a_port_is_not_a_line_address(self):
        model = self.scan({'AGENTS.md': '[a](servidor.local:8080) `x.toml:3` [b](host.com:443/x)\n'})
        self.assertEqual(self.issues(model, 'unresolved-name'), [('AGENTS.md', 1, 'x.toml:3')])
        self.assertFalse(self.issues(model, 'broken'))

    def test_the_index_never_answers_for_another_root(self):
        a, b = self.base / 'A', self.base / 'B'
        make(a, {'AGENTS.md': '[[nota]] `nota2.md` `sub/nota3.md`\n'})
        make(b, {'AGENTS.md': '# b\n', **{f'f{i}.md': '' for i in range(10)}, 'z/nota.md': '# n\n', 'z/nota2.md': '# n\n', 'z/sub/nota3.md': '# n\n'})
        model = self.scan(limit=8, roots=[a, b])
        found = sorted((i['code'], i['target']) for i in model['issues'] if i.get('target') and i['node'] == str(a / 'AGENTS.md'))
        self.assertEqual(found, [('broken', 'nota'), ('broken', 'sub/nota3.md'), ('unresolved-name', 'nota2.md')])

    def test_excluded_folders_stay_out_of_the_index_past_the_limit(self):
        model = self.scan({'AGENTS.md': '`so-aqui.md`\n', **{f'a/f{i}.md': '' for i in range(10)}, 'z/node_modules/pkg/so-aqui.md': '# x\n'}, limit=5)
        self.assertEqual(self.issues(model, 'unresolved-name'), [('AGENTS.md', 1, 'so-aqui.md')])
        self.assertEqual(model['stats']['resolution']['unscanned'], 0)


class EntriesAndPartialReading(ReaderCase):
    """Entries left out by the inventory are counted; `unreachable` is a fact only in a complete reading."""

    def test_an_entry_seen_only_by_name_is_counted_and_no_entry_is_not_affirmed(self):
        model = self.scan({'leia.md': '# x\n', **{f'dados/d{i}.md': '' for i in range(20)}, 'pkg/sub/AGENTS.md': '# e\n'}, limit=6)
        omitted = model['stats']['inventory']['entriesOmitted']
        self.assertEqual(omitted, {'count': 1, 'paths': [self.path('pkg/sub/AGENTS.md')]})
        self.assertFalse([i for i in model['issues'] if i['code'] == 'no-entry'])
        limit = next(i['message'] for i in model['issues'] if i['code'] == 'limit')
        self.assertIn('Entry or skill files (AGENTS.md, CLAUDE.md, SKILL.md) left out: 1, such as pkg/sub/AGENTS.md.', limit)
        self.assertIn('1 arquivo(s) de entrada ou de skill (AGENTS.md, CLAUDE.md, SKILL.md) ficaram fora, como pkg/sub/AGENTS.md', portuguese(limit))
        self.assertEqual(audit.audit(model)['metrics']['inventory']['entriesOmitted'], {'count': 1, 'paths': [{'path': 'pkg/sub/AGENTS.md'}]})
        # Control: no entry anywhere, affirmed.
        (self.root / 'pkg' / 'sub' / 'AGENTS.md').unlink()
        self.assertTrue([i for i in self.scan(limit=6)['issues'] if i['code'] == 'no-entry'])

    def test_every_entry_left_out_is_listed_and_only_the_summary_cuts_them(self):
        model = self.scan({'AGENTS.md': '# e\n', **{f'a/f{i}.md': '' for i in range(8)}, **{f'z/p{i:02d}/AGENTS.md': '# e\n' for i in range(25)}}, limit=6)
        expected = [self.path(f'z/p{i:02d}/AGENTS.md') for i in range(25)]
        self.assertEqual(model['stats']['inventory']['entriesOmitted'], {'count': 25, 'paths': expected})
        full = audit.audit(model)['metrics']['inventory']['entriesOmitted']
        self.assertEqual((full['count'], [item['path'] for item in full['paths']]), (25, [f'z/p{i:02d}/AGENTS.md' for i in range(25)]))
        summary = audit.audit(model, summary=True, top=3)['metrics']['inventory']['entriesOmitted']
        self.assertEqual(summary, {'count': 25, 'paths': [{'path': f'z/p{i:02d}/AGENTS.md'} for i in range(3)]})

    def test_unreachable_is_not_conclusive_when_a_text_was_not_analysed(self):
        files = {'AGENTS.md': '[i](docs/idx.md)\n', 'docs/idx.md': '[a](a.md) [b](b.md)\n' + 'x' * 100 + '\n', 'docs/a.md': '# a\n', 'docs/b.md': '# b\n'}
        model = self.scan(files, text=60)
        unreachable = [i for i in model['issues'] if i['code'] == 'unreachable']
        self.assertTrue(unreachable)
        self.assertTrue(all(i['conclusive'] is False and 'Not conclusive' in i['message'] for i in unreachable))
        # Control: complete, nothing unreached, and no field anywhere.
        complete = self.scan()
        self.assertFalse([i for i in complete['issues'] if i['code'] == 'unreachable' or 'conclusive' in i])


    def test_unreachable_is_not_conclusive_when_another_root_was_read_in_part(self):
        a = make(self.base / 'A', {'AGENTS.md': '# A\n', 'x.md': '# x\n'})
        b = make(self.base / 'B', {'AGENTS.md': '# B\nVer [hub](hub.md).\n', 'hub.md': 'Ver [x](../A/x.md).\n' + 'z' * 200 + '\n'})
        model = self.scan(text=40, roots=[a, b])
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == str(b / 'hub.md'))['analysis'], 'skipped')
        unreachable = next(i for i in model['issues'] if i['code'] == 'unreachable' and i['node'] == str(a / 'x.md'))
        self.assertIs(unreachable['conclusive'], False)
        self.assertIn('another root', unreachable['message'])
        self.assertEqual(unreachable['message'].params['partial'], 'other-root')  # the fact the interface reads
        self.assertIn('outra raiz', portuguese(unreachable['message']))
        # Control: with both roots read in full, the citing file reaches it.
        model = self.scan(roots=[a, b])
        self.assertFalse([i for i in model['issues'] if i['code'] == 'unreachable' and i['node'] == str(a / 'x.md')])


    def test_an_anchored_reference_is_never_unverified_even_with_the_index_exhausted(self):
        text = ('# a\nVer `../falta.md`, ../outra/falta.md e [l](../link-falta.md).\n'
                'Também [[pasta/nota-falta]], `nome-falta.md` e [[nota-falta]].\n')
        model = self.scan({'a/AGENTS.md': text, **{f'b/f{i}.md': '' for i in range(8)}}, limit=6, lookup=1)
        self.assertFalse(model['stats']['inventory']['lookupComplete'])
        codes = {i['target']: i['code'] for i in model['issues'] if i.get('target')}
        self.assertEqual({target: codes[target] for target in ('../falta.md', '../outra/falta.md', '../link-falta.md', 'pasta/nota-falta')},
                         dict.fromkeys(('../falta.md', '../outra/falta.md', '../link-falta.md', 'pasta/nota-falta'), 'broken'))
        # Control: what the cascade or the name search would find past the index stays unverified.
        self.assertEqual((codes['nome-falta.md'], codes['nota-falta']), ('unverified', 'unverified'))


class GatesAndComparison(ReaderCase):
    """`--fail-on broken` keeps outside-root; an old report against a new one shows reclassified findings."""

    # The aae audit of this tree by the reader before the limit and syntax rules: `memoria/x.md` was broken.
    OLD = {'version': 2, 'kind': 'audit', 'status': 'pass', 'roots': [{'path': '/antes/pacote', 'name': 'pacote'}],
           'metrics': {'partial': False}, 'scopeHash': None, 'suiteHash': None, 'contractHash': None,
           'findings': [{'id': 'a9d7a89da67b6f38', 'code': 'broken', 'severity': 'warning', 'message': 'Destino não encontrado: memoria/x.md',
                         'path': 'AGENTS.md', 'line': 2, 'target': 'memoria/x.md'},
                        {'id': '8cc63c9e0c956582', 'code': 'broken', 'severity': 'warning', 'message': 'Destino não encontrado: docs/falta.md',
                         'path': 'AGENTS.md', 'line': 3, 'target': 'docs/falta.md'}]}

    def tree(self):
        project = make(self.base / 'm2' / 'projeto', {'.git/': '', 'memoria/x.md': '# x\n',
                                                      'pacote/AGENTS.md': '# Pacote\n`memoria/x.md`\n[Falta](docs/falta.md)\n'})
        return project / 'pacote'

    def invoke(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli.main([str(argument) for argument in arguments])
        return code, json.loads(output.getvalue())

    def test_fail_on_broken_also_matches_outside_root(self):
        package = self.tree()
        code, report = self.invoke('audit', '--root', package, '--fail-on', 'broken')
        self.assertEqual((code, report['gate']['matched']), (1, {'broken': 2}))
        (package / 'docs').mkdir()
        (package / 'docs' / 'falta.md').write_text('# agora existe\n')
        code, report = self.invoke('audit', '--root', package, '--fail-on', 'broken')
        self.assertEqual((code, report['gate']['matched']), (1, {'broken': 1}))  # only the outside-root one is left
        self.assertEqual([f['code'] for f in report['findings'] if f.get('target') == 'memoria/x.md'], ['outside-root'])

    def test_an_old_report_against_a_new_one_reclassifies_instead_of_new_and_resolved(self):
        package = self.tree()
        _, new = self.invoke('audit', '--root', package)
        before, after = self.base / 'antes.json', self.base / 'depois.json'
        before.write_text(json.dumps(self.OLD), encoding='utf-8')
        after.write_text(json.dumps(new), encoding='utf-8')
        code, comparison = self.invoke('compare-audit', '--before', before, '--after', after, '--fail-on', 'any')
        self.assertEqual((code, comparison['status'], comparison['new'], comparison['resolved']), (0, 'pass', [], []))
        self.assertEqual([(f['code'], f['previousCode'], f['previousId']) for f in comparison['reclassified']],
                         [('outside-root', 'broken', 'a9d7a89da67b6f38')])
        self.assertEqual(comparison['persisting'], 2)  # docs/falta.md and the reclassified one


    def test_a_copied_legacy_id_is_new_and_resolved_never_reclassified(self):
        project = make(self.base / 'forja', {'AGENTS.md': '# e\n', 'a.md': '[f](docs/falta.md)\n', 'b.md': '# b\n'})
        _, before = self.invoke('audit', '--root', project)
        (project / 'docs').mkdir()
        (project / 'docs' / 'falta.md').write_text('# agora existe\n')
        (project / 'b.md').write_text('[g](docs/falta2.md)\n')
        _, after = self.invoke('audit', '--root', project)
        gone = next(f for f in before['findings'] if f.get('target') == 'docs/falta.md')
        forged = next(f for f in after['findings'] if f.get('target') == 'docs/falta2.md')
        forged['legacyId'] = gone['id']
        files = self.base / 'antes.json', self.base / 'depois.json'
        for path, report in zip(files, (before, after)):
            path.write_text(json.dumps(report), encoding='utf-8')
        code, comparison = self.invoke('compare-audit', '--before', files[0], '--after', files[1], '--fail-on', 'broken')
        self.assertEqual((code, comparison['reclassified']), (1, []))
        self.assertEqual([(f['code'], f.get('target')) for f in comparison['new'] if f.get('target')], [('broken', 'docs/falta2.md')])
        self.assertEqual([(f['code'], f.get('target')) for f in comparison['resolved'] if f.get('target')], [('broken', 'docs/falta.md')])
        # The same legacyId on an outside-root finding of another line or file is no match either;
        # control: in the same place, with the same written target, it is the reclassification.
        # And a transition this reader never produces (broken to broken) is no match in the same place.
        for code_now, place, expected in (('outside-root', (gone['path'], gone['line'] + 1), 1), ('outside-root', ('b.md', gone['line']), 1),
                                          ('broken', (gone['path'], gone['line']), 1), ('outside-root', (gone['path'], gone['line']), 0)):
            with self.subTest(code=code_now, place=place):
                forged.update(code=code_now, path=place[0], line=place[1], target=gone['target'])
                files[1].write_text(json.dumps(after), encoding='utf-8')
                code, comparison = self.invoke('compare-audit', '--before', files[0], '--after', files[1], '--fail-on', 'broken')
                self.assertEqual((code, len(comparison['reclassified'])), (expected, 1 - expected))


class ToolManifests(ReaderCase):
    """Keys of the manifests of other tools are read, without changing their kind."""

    def test_marketplace_and_gemini_extension_keys_are_read(self):
        model = self.scan({'AGENTS.md': '# e\n', '.claude-plugin/marketplace.json': '{"plugins": [{"source": "plugins/x"}]}\n',
                           'gemini-extension.json': '{"path": "ext/GEMINI.md"}\n', '.claude/settings.json': '{"instructions": "nada.md"}\n'})
        self.assertEqual(sorted(i[2] for i in self.issues(model, 'broken')), ['ext/GEMINI.md', 'plugins/x'])
        self.assertEqual(model['stats']['ignored']['manifest-key'], 1)
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == self.path('gemini-extension.json'))['kind'], 'file')




class FinalReview(ReaderCase):
    """Proofs of the last review (one test per item, with the control next to it)."""

    def cli_process(self, *arguments):
        done = subprocess.run([sys.executable, str(CHECKOUT / 'scripts' / 'aae.py'), *map(str, arguments)], capture_output=True, timeout=120)
        return done.returncode, json.loads(done.stdout.decode('utf-8')), done.stderr.decode('utf-8', 'replace')

    def serve(self, state):
        """A server of this checkout on a free port, with its own state; (url, server module, stop)."""
        import threading
        from http.server import ThreadingHTTPServer
        sys.path.insert(0, str(CHECKOUT / 'server'))
        self.addCleanup(sys.path.remove, str(CHECKOUT / 'server'))
        import main as app
        import workspace
        server = ThreadingHTTPServer(('127.0.0.1', 0), app.make_handler(workspace.Workspace(state), state, 'test-token'))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join()
        self.addCleanup(stop)
        return f'http://127.0.0.1:{server.server_port}', app

    def post(self, url, route, body):
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen
        request = Request(url + route, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'X-AAE-Token': 'test-token'})
        try:
            with urlopen(request, timeout=30) as answer:
                return answer.status, json.loads(answer.read().decode('utf-8'))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode('utf-8'))

    def surrogates(self):
        # JSON escapes of a lone surrogate, written as ASCII: the decoded value is not valid UTF-8.
        return make(self.root, {'AGENTS.md': '# e\n[[n\\udcff]] e `t\\udcff.md`\n',
                                '.claude-plugin/plugin.json': '{"name": "p", "skills": ["s\\udcff.md", "skills/ok/SKILL.md"]}\n',
                                'skills/ok/SKILL.md': '---\nname: "n\\udcff"\n---\n# T\\udcff\n',
                                'agent-architecture.json': '{"objects": [{"path": "o\\udcff.md"}, {"path": "AGENTS.md", "name": "n\\udcff", "type": "t\\udcff"}],'
                                                           ' "relationships": [{"source": "AGENTS.md", "target": "x\\udcff.md"},'
                                                           ' {"source": "AGENTS.md", "target": "skills/ok/SKILL.md", "type": "r\\udcff"}],'
                                                           ' "scope": {"version": 1, "localFiles": ["p\\udcff/**"]}}\n'})

    def test_a_lone_surrogate_in_a_json_value_is_an_invalid_reference_in_cli_and_server(self):
        self.surrogates()
        code, report, _ = self.cli_process('audit', '--root', self.root)
        self.assertIn(code, (0, 1), report)
        invalid = sorted(f['target'] for f in report['findings'] if f['code'] == 'invalid-reference')
        self.assertEqual(invalid, ['o\\udcff.md', 's\\udcff.md', 'x\\udcff.md'])  # escaped text, each value once
        model = scanner.scan([str(self.root)])
        json.dumps(model, ensure_ascii=False).encode('utf-8')  # every string of the model is valid UTF-8
        self.assertEqual(next(o for o in model['objects'] if o['node'] == self.path('AGENTS.md'))['name'], 'n\\udcff')
        self.assertEqual(self.edge(model, 'AGENTS.md', 'r\\udcff')['target'], self.path('skills/ok/SKILL.md'))
        self.assertTrue(any('UTF-8' in i['message'] for i in model['issues'] if i['code'] == 'manifest'))  # the scope is refused, not read
        # Text of Markdown is decoded strictly: `\udcff` there is six ASCII characters, never a surrogate.
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == self.path('skills/ok/SKILL.md'))['title'], 'T\\udcff')
        url, _ = self.serve(self.base / 'estado')
        status, answer = self.post(url, '/api/open', {'path': str(self.root)})
        self.assertEqual(status, 200, answer)
        self.assertEqual(sorted(i['target'] for i in answer['issues'] if i['code'] == 'invalid-reference'),
                         ['o\\udcff.md', 's\\udcff.md', 'x\\udcff.md'])

    def test_only_what_was_asked_is_invalid_input_and_a_reader_defect_is_internal_error(self):
        make(self.root, {'AGENTS.md': '# e\nVer `a.md`.\n'})
        for exception in (ValueError('defeito'), UnicodeEncodeError('utf-8', '\udcff', 0, 1, 'surrogates not allowed'), KeyError('x')):
            with self.subTest(exception=type(exception).__name__):
                output, errors = io.StringIO(), io.StringIO()
                with mock.patch.object(scanner, 'fence_contexts', side_effect=exception), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    code = cli.main(['audit', '--root', str(self.root)])
                report = json.loads(output.getvalue())
                self.assertEqual((code, report['status'], [f['code'] for f in report['findings']]), (2, 'error', ['internal-error']))
                line = errors.getvalue().strip()
                self.assertRegex(line, rf'^aae: internal-error: {type(exception).__name__} in scanner\.py:\d+$')
                self.assertNotIn('a.md', line + report['findings'][0]['message'])
        # Controls: what was asked stays invalid-input.
        for arguments in (['audit', '--root', str(self.root), '--top', '0'], ['audit', '--root', str(self.base / 'nada')], ['audit'],
                          ['compare-audit', '--before', str(self.root / 'AGENTS.md'), '--after', str(self.root / 'AGENTS.md')]):
            with self.subTest(arguments=arguments[:2]):
                output = io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                    code = cli.main(arguments)
                self.assertEqual((code, [f['code'] for f in json.loads(output.getvalue())['findings']]), (2, ['invalid-input']))
        # The server answers 500 in Portuguese and logs the type; a wrong path stays 400.
        url, app = self.serve(self.base / 'estado')
        errors = io.StringIO()
        with mock.patch.object(sys.modules['scanner'], 'fence_contexts', side_effect=ValueError('defeito')), contextlib.redirect_stderr(errors):
            status, answer = self.post(url, '/api/open', {'path': str(self.root)})
        self.assertEqual(status, 500)
        self.assertIn('Internal failure of the reader (ValueError)', answer['error'])
        self.assertRegex(errors.getvalue(), r'aae: internal-error: ValueError in scanner\.py:\d+ \(/api/open\)')
        self.assertEqual(self.post(url, '/api/open', {'path': str(self.base / 'nada')})[0], 400)

    def test_the_byte_ceiling_measures_the_address_not_the_anchor_or_the_query(self):
        long = 'x' * 4100
        model = self.scan({'AGENTS.md': f'[existe](docs/a.md#{long}) [falta](docs/falta.md#{long}) [q](docs/b.md?{long}) `docs/c.md:{"1," * 2000}1`\n',
                           'docs/a.md': '# a\n'})
        self.assertEqual(self.edge(model, 'AGENTS.md', f'docs/a.md#{long}')['target'], self.path('docs/a.md'))
        self.assertEqual(sorted(i[2][:12] for i in self.issues(model, 'broken')), ['docs/b.md?xx', 'docs/c.md:1,', 'docs/falta.m'])
        self.assertEqual(model['stats']['ignored']['too-long'], 0)
        self.assertFalse([i for i in model['issues'] if i['code'] == 'unreachable'])
        # Controls: an address above 4,096 bytes, or a written reference above 64 KiB, is still left out.
        model = self.scan({'AGENTS.md': f'[l](docs/{long}.md) [m](docs/a.md#{"y" * 70_000})\n'})
        self.assertEqual(model['stats']['ignored']['too-long'], 2)


    def test_the_probe_never_tests_the_home_folder_nor_above_it(self):
        home = make(self.base / 'casa', {'.git/HEAD': '', '.ssh/id_rsa': 'k\n', 'repo/.git/HEAD': '', 'repo/docs/x.md': '# x\n'})
        for opened in (home / 'proj', home / 'a' / 'b' / 'proj'):
            with self.subTest(levels=len(opened.relative_to(home).parts)):
                make(opened, {'AGENTS.md': '# e\n[k](.ssh/id_rsa)\n'})
                with mock.patch.dict(os.environ, {'HOME': str(home)}):
                    model = scanner.scan([str(opened)])
                self.assertEqual([i['code'] for i in model['issues'] if i.get('target') == '.ssh/id_rsa'], ['broken'])
                self.assertEqual({key: model['stats']['probe']['ancestors'][0][key] for key in ('levels', 'stop', 'probes')},
                                 {'levels': 0, 'stop': 'home', 'probes': 0})
        # Control: a repository inside the home folder is probed as before.
        make(home / 'repo' / 'pkg', {'AGENTS.md': '# e\nVer [x](docs/x.md).\n'})
        with mock.patch.dict(os.environ, {'HOME': str(home)}):
            model = scanner.scan([str(home / 'repo' / 'pkg')])
        self.assertEqual([i['code'] for i in model['issues'] if i.get('target') == 'docs/x.md'], ['outside-root'])
        self.assertEqual(model['stats']['probe']['ancestors'][0]['stop'], 'git')


    def test_evidence_of_a_long_line_is_a_window_that_holds_the_written_reference(self):
        filler = 'texto ' * 120  # 720 characters between references
        refs = ['[l](docs/falta-a.md)', '[[nota-que-falta]]', '`scripts/falta.sh`', 'Ver ./fora/falta.md', '@guia-falta.md', '[m](docs/b.md)']
        long_line = filler + filler.join(refs) + filler
        model = self.scan({'AGENTS.md': f'# e\n{long_line}\nCurta: [c](docs/c-falta.md)\n', 'docs/b.md': '# b\n'})
        findings = [i for i in model['issues'] if i.get('evidence') is not None]
        self.assertEqual(len(findings), 6)
        for item in findings:  # every reference finding: the excerpt holds the written target
            with self.subTest(target=item['target']):
                self.assertIn(item['target'], item['evidence'])
                self.assertLessEqual(len(item['evidence']), scanner.EXCERPT)
        long_ones = [i['evidence'] for i in findings if i['line'] == 2]
        self.assertTrue(all(text.startswith('…') and text.endswith('…') for text in long_ones), long_ones)
        edge = self.edge(model, 'AGENTS.md', 'docs/b.md')
        self.assertIn('docs/b.md', edge['evidence'])
        self.assertEqual(next(i for i in findings if i['line'] == 3)['evidence'], 'Curta: [c](docs/c-falta.md)')  # a short line is unchanged
        # The excerpt enters no id, and a reference saved with the earlier excerpt sees no change.
        with mock.patch.object(scanner, 'excerpt', lambda stripped, at, size: stripped[:500]):
            earlier = self.scan()
        self.assertEqual(sorted(i['id'] for i in earlier['issues']), sorted(i['id'] for i in model['issues']))
        self.assertEqual(sorted(e['id'] for e in earlier['edges']), sorted(e['id'] for e in model['edges']))
        self.assertNotIn('docs/b.md', self.edge(earlier, 'AGENTS.md', 'docs/b.md')['evidence'])
        change = delta.compare(delta.read(earlier, 'antes'), delta.read(model, 'depois'), model)
        self.assertEqual([change[group][key] for group, key in (('files', 'added'), ('files', 'removed'), ('files', 'changed'), ('relations', 'added'),
                                                                 ('relations', 'removed'), ('findings', 'new'), ('findings', 'resolved'))], [[]] * 7)

    def test_a_control_file_path_with_dot_dot_is_read_or_refused_as_input(self):
        make(self.root, {'AGENTS.md': '# e\n'})
        (self.base / 'sub').mkdir()
        os.symlink(self.base / 'sub', self.base / 'link')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            cli.main(['audit', '--root', str(self.root)])
        (self.base / 'antes.json').write_text(output.getvalue(), encoding='utf-8')

        def run(*arguments):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                code = cli.main([str(argument) for argument in arguments])
            return code, json.loads(out.getvalue())
        same = f'{self.base}/sub/../antes.json'
        code, report = run('compare-audit', '--before', same, '--after', self.base / 'antes.json')
        self.assertEqual((code, report['kind']), (0, 'audit-comparison'))  # `..` over a real folder: read
        for path, words in ((f'{self.base}/link/../antes.json', 'symbolic link'), (self.base / 'sub', 'regular file'),
                            (self.base / 'link' / 'nada.json', None)):
            with self.subTest(path=str(path)):
                code, report = run('compare-audit', '--before', path, '--after', self.base / 'antes.json')
                self.assertEqual((code, [f['code'] for f in report['findings']]), (2, ['invalid-input']))
                if words:
                    self.assertIn(words, report['findings'][0]['message'])

    def test_the_schema_names_what_a_consumer_reads_in_metrics_and_findings(self):
        contract = cli.schema_contract()['auditContract']
        for reason in scanner.IGNORED_REASONS:
            self.assertRegex(contract['extraction'], rf'(?<![\w-]){re.escape(reason)}(?![\w-])')
        self.assertIn('candidates (up to 20, stable order), candidatesTotal (total)', contract['fields'])
        self.assertIn('entriesOmitted {count, paths}', contract['fields'])
        self.assertIn('probes: distinct references probed', contract['metrics'])

    def test_the_account_home_stops_the_probe_even_with_home_redirected(self):
        account = make(self.base / 'conta', {'.git/HEAD': '', '.ssh/id_rsa': 'k\n'})  # a fake versioned account folder
        isolated = make(self.base / 'isolada', {'x': ''})
        for opened in (account / 'proj', account / 'a' / 'b' / 'proj'):
            make(opened, {'AGENTS.md': '# e\n[k](.ssh/id_rsa)\n'})
            for pw_dir, code, stop in ((str(account), 'broken', 'home'), (None, 'outside-root', 'git')):
                with self.subTest(levels=len(opened.relative_to(account).parts), account=bool(pw_dir)), \
                        mock.patch.dict(os.environ, {'HOME': str(isolated)}), mock.patch.object(scanner, 'account_home', return_value=pw_dir):
                    model = scanner.scan([str(opened)])
                    self.assertEqual([i['code'] for i in model['issues'] if i.get('target') == '.ssh/id_rsa'], [code])
                    self.assertEqual(model['stats']['probe']['ancestors'][0]['stop'], stop)


if __name__ == '__main__':
    unittest.main()
