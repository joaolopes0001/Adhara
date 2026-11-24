"""Corrections of the reader: `./` mentions that do not retreat, destinations through excluded
folders, repeated reference labels, bounded evidence of manifest keys, the entries left out in
the interface model, a manifest nested too deep and `no-entry` with a declared scope.

Disposable trees only, with low limits by monkeypatch. Each case has its negative control
next to it: the similar case that must not change.
"""
import contextlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from server import audit, scanner
from workspace import ENTRIES_OMITTED_SHOWN, Workspace, interface_stats

REFERENCE_CODES = {'broken', 'unresolved-name', 'unverified', 'outside-root', 'ambiguous'}


class Case(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='aae-corrections-')
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / 'agent'
        self.root.mkdir()

    def make(self, files, links=()):
        for relative, text in files.items():
            path = self.root / relative
            if relative.endswith('/'):
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        for relative, destination in links:
            os.symlink(destination, self.root / relative)

    def scan(self, files=None, limit=None, lookup=None, links=()):
        if files:
            self.make(files, links)
        patches = [mock.patch.object(scanner, name, value) for name, value in
                   (('MAX_FILES', limit), ('MAX_LOOKUP', lookup)) if value is not None]
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            return scanner.scan([str(self.root)])

    def findings(self, model):
        """{target: code} of the reference findings."""
        return {i['target']: i['code'] for i in model['issues'] if i['code'] in REFERENCE_CODES}

    def marker(self, model, relative):
        return next(n['status'] for n in model['nodes'] if n['path'] == str(self.root / relative))


class DotMentionThatDoesNotRetreat(Case):
    """A `./x` mention whose first folder is next to the file is anchored: absent, it is broken."""

    PAD = {f'zpad/f{i}.txt': 'x\n' for i in range(8)}

    def test_local_folder_is_broken_even_when_the_lookup_index_overflowed(self):
        model = self.scan({'AGENTS.md': 'Rode `./scripts/falta.sh`.\n\n[l](./scripts/falta2.sh)\n', 'scripts/ok.sh': 'echo\n', **self.PAD},
                          limit=5, lookup=2)
        self.assertFalse(model['stats']['inventory']['lookupComplete'])
        self.assertEqual(self.findings(model), {'./scripts/falta.sh': 'broken', './scripts/falta2.sh': 'broken'})
        self.assertEqual(self.marker(model, 'scripts/falta.sh'), 'missing')

    def test_a_mention_that_retreats_still_depends_on_the_index(self):
        # Control: written in a subfolder without a local `outra/`, the mention retreats to the root.
        model = self.scan({'a/nota.md': 'Rode `./outra/falta.sh` e `./falta.md`.\n', 'AGENTS.md': '[n](a/nota.md)\n', **self.PAD},
                          limit=6, lookup=2)
        self.assertFalse(model['stats']['inventory']['lookupComplete'])
        self.assertEqual(self.findings(model), {'./outra/falta.sh': 'unverified', './falta.md': 'unverified'})

    def test_written_in_the_root_itself_the_mention_was_checked_on_disk(self):
        model = self.scan({'AGENTS.md': 'Recua: `./falta3.sh`.\n', **self.PAD}, limit=5, lookup=2)
        self.assertFalse(model['stats']['inventory']['lookupComplete'])
        self.assertEqual(self.findings(model), {'./falta3.sh': 'broken'})

    def test_local_folder_is_not_found_above_the_root(self):
        (self.base / '.git').mkdir()
        (self.base / 'scripts').mkdir()
        (self.base / 'scripts' / 'falta.sh').write_text('echo\n')
        (self.base / 'irma.md').write_text('# x\n')
        model = self.scan({'AGENTS.md': 'Rode `./scripts/falta.sh`.\n\nIrmã: `./irma.md`.\n', 'scripts/ok.sh': 'echo\n'})
        # Control: without a local folder, the mention is still found in the repository above.
        self.assertEqual(self.findings(model), {'./scripts/falta.sh': 'broken', './irma.md': 'outside-root'})

    def test_root_dot_resolution_is_unchanged(self):
        model = self.scan({'AGENTS.md': '[n](sub/nota.md)\n', 'sub/nota.md': 'Raiz: `./achado.md`. Local: `./scripts/x.sh`.\n',
                           'achado.md': '# a\n', 'scripts/x.sh': 'echo\n'})
        modes = {e['raw']: e['resolvedBy'] for e in model['edges'] if e['kind'] == 'path'}
        self.assertEqual(modes, {'./achado.md': 'root-dot', './scripts/x.sh': 'root-dot'})
        self.assertEqual(self.findings(model), {})


class ThroughUnreadFolder(Case):
    """A path through a folder the reader does not read (excluded, a symbolic link, not searchable) is
    `unscanned`: its existence is not checked. The same from the root's file and from a subfolder."""

    def test_excluded_folder_is_unscanned_from_the_root_and_from_a_subfolder(self):
        cited = 'Confira `dist/index.js`, [b](build/nao.md) e [[build/nota]].\n'
        model = self.scan({'AGENTS.md': '[g](docs/guia.md)\n' + cited, 'docs/guia.md': cited, 'dist/index.js': 'x\n', 'build/nota.md': '# n\n'})
        self.assertEqual(self.findings(model), {})
        for relative in ('dist/index.js', 'build/nao.md', 'build/nota'):
            self.assertEqual(self.marker(model, relative), 'unscanned')
        # Control: a missing destination outside any unread folder, cited from the subfolder, stays broken.
        (self.root / 'docs' / 'guia.md').write_text(cited + '[c](docs/falta.md)\n')
        self.assertEqual(self.findings(self.scan()), {'docs/falta.md': 'broken'})

    def test_symbolic_link_step_from_a_subfolder_is_unscanned(self):
        model = self.scan({'AGENTS.md': '[g](docs/guia.md)\n[l](atalho/x.md)\n', 'docs/guia.md': '[a](atalho/x.md) `./atalho/y.md`\n', 'real/x.md': '# x\n'},
                          links=(('atalho', 'real'),))
        self.assertEqual(self.findings(model), {})
        self.assertEqual(self.marker(model, 'atalho/x.md'), 'unscanned')
        self.assertEqual(self.marker(model, 'atalho/y.md'), 'unscanned')
        # Control: the same names without the link, missing, are broken from the subfolder too.
        (self.root / 'atalho').unlink()
        self.assertEqual(self.findings(self.scan()), {'atalho/x.md': 'broken', './atalho/y.md': 'broken'})

    def test_skill_step_through_an_excluded_folder_is_unscanned(self):
        model = self.scan({'AGENTS.md': '[s](skills/x/SKILL.md)\n', 'skills/x/SKILL.md': '[r](refs/a.md)\n',
                           'skills/x/refs/a.md': 'Veja `build/out.json` e `docs/falta.json`.\n', 'skills/x/build/out.json': '{}\n'})
        self.assertEqual(self.findings(model), {'docs/falta.json': 'broken'})

    @unittest.skipIf(os.geteuid() == 0, 'root ignores folder permissions')
    def test_a_folder_that_cannot_be_searched_is_not_absence(self):
        cited = '[a](priv/x.md) [b](docs/priv/y.md)\n'
        self.make({'AGENTS.md': '[g](docs/guia.md)\n' + cited, 'docs/guia.md': cited, 'priv/x.md': '# x\n', 'docs/priv/y.md': '# y\n'})
        for folder in (self.root / 'priv', self.root / 'docs' / 'priv'):
            folder.chmod(0)
            self.addCleanup(folder.chmod, 0o700)
        model = self.scan()
        self.assertEqual(self.findings(model), {})
        self.assertEqual(self.marker(model, 'priv/x.md'), 'unscanned')
        # Control: a missing file in a readable folder next to it stays broken.
        (self.root / 'docs' / 'guia.md').write_text(cited + '[c](docs/falta.md)\n')
        self.assertEqual(self.findings(self.scan()), {'docs/falta.md': 'broken'})

    @unittest.skipIf(os.geteuid() == 0, 'root ignores folder permissions')
    def test_a_folder_listed_whole_without_search_still_tells_absence(self):
        cited = '[a](scripts/existe.sh) [b](scripts/falta.sh) `./scripts/falta2.sh`\n'
        self.make({'AGENTS.md': '[g](docs/guia.md)\n' + cited, 'docs/guia.md': '[c](scripts/falta3.sh)\n', 'scripts/existe.sh': 'echo\n'})
        folder = self.root / 'scripts'
        folder.chmod(0o644)
        self.addCleanup(folder.chmod, 0o700)
        model = self.scan()
        self.assertEqual(self.findings(model), {'scripts/falta.sh': 'broken', './scripts/falta2.sh': 'broken', 'scripts/falta3.sh': 'broken'})
        # Control: the listed file resolves to its inventoried node.
        self.assertIn(str(folder / 'existe.sh'), {e['target'] for e in model['edges']})

    def test_a_root_opened_inside_an_excluded_folder_is_read_normally(self):
        self.root = self.root / 'build' / 'pkg'
        self.root.mkdir(parents=True)
        model = self.scan({'AGENTS.md': '[a](a.md) [f](falta.md)\n', 'a.md': '# a\n'})
        self.assertEqual(self.findings(model), {'falta.md': 'broken'})


class RepeatedReferenceLabel(Case):
    """The first definition of a label wins (CommonMark); a definition line names only its own destination."""

    def edges(self, model):
        return sorted((e['line'], os.path.relpath(e['target'], self.root)) for e in model['edges'] if e['kind'] == 'markdown-reference')

    def test_first_definition_wins_and_each_definition_line_keeps_its_destination(self):
        model = self.scan({'AGENTS.md': 'Use [texto][Rotulo   um].\n\n[rotulo um]: docs/primeiro.md\n[ROTULO UM]: docs/segundo.md\n',
                           'docs/primeiro.md': '# 1\n', 'docs/segundo.md': '# 2\n'})
        self.assertEqual(self.edges(model), [(1, 'docs/primeiro.md'), (3, 'docs/primeiro.md'), (4, 'docs/segundo.md')])

    def test_a_missing_second_definition_is_reported_on_its_own_line(self):
        model = self.scan({'AGENTS.md': '[x][a]\n\n[a]: existe.md\n[A]: falta.md\n', 'existe.md': '# x\n'})
        self.assertEqual([(i['code'], i['line'], i['target']) for i in model['issues'] if i['code'] in REFERENCE_CODES],
                         [('broken', 4, 'falta.md')])

    def test_a_definition_in_a_fenced_block_defines_nothing_in_either_order(self):
        for text in ('Consulte [o guia][guia].\n\n```markdown\n[guia]: exemplo.md\n```\n\n[guia]: docs/guia.md\n',
                     'Consulte [o guia][guia].\n\n[guia]: docs/guia.md\n\n```markdown\n[guia]: exemplo.md\n```\n'):
            with self.subTest(text=text):
                (self.root / 'AGENTS.md').unlink(missing_ok=True)
                model = self.scan({'AGENTS.md': text, 'docs/guia.md': '# g\n'})
                self.assertEqual(self.findings(model), {})
                self.assertIn((1, 'docs/guia.md'), self.edges(model))

    def test_prose_shaped_like_a_definition_is_not_one(self):
        model = self.scan({'AGENTS.md': '[guia]: leia antes de começar.\n\nConsulte [o guia][guia].\n\n[guia]: docs/guia.md "Guia"\n', 'docs/guia.md': '# g\n'})
        self.assertEqual(self.findings(model), {})
        self.assertEqual(self.edges(model), [(1, 'docs/guia.md'), (3, 'docs/guia.md'), (5, 'docs/guia.md')])

    def test_titles_with_escapes_or_on_the_next_line_still_define(self):
        text = ('Veja [um][r1], [dois][r2] e [tres][r3].\n\n[r1]: falta1.md "Um \\"guia\\" novo"\n'
                '[r2]: falta2.md "Titulo\ncontinua"\n[r3]: falta3.md (nota \\(interna\\))\n')
        model = self.scan({'AGENTS.md': text})
        found = sorted((i['line'], i['target']) for i in model['issues'] if i['code'] == 'broken')
        self.assertEqual(found, [(1, 'falta1.md'), (1, 'falta2.md'), (1, 'falta3.md'), (3, 'falta1.md'), (4, 'falta2.md'), (6, 'falta3.md')])

    def test_evidence_of_a_long_definition_holds_its_destination(self):
        model = self.scan({'AGENTS.md': 'Veja [o guia][r].\n\n[r]: falta.md "' + 'titulo longo ' * 50 + '"\n'})
        evidence = next(i['evidence'] for i in model['issues'] if i['code'] == 'broken' and i['line'] == 3)
        self.assertLessEqual(len(evidence), scanner.EXCERPT)
        self.assertIn('falta.md', evidence)

    def test_titles_and_case_folding(self):
        model = self.scan({'AGENTS.md': "[a][SS] [b][t1] [c][t2]\n\n[ß]: a.md\n[t1]: b.md 'Título'\n[t2]: <c d.md> (Título)\n",
                           'a.md': '', 'b.md': '', 'c d.md': ''})
        self.assertEqual(self.findings(model), {})
        self.assertEqual(sorted(t for line, t in self.edges(model) if line == 1), ['a.md', 'b.md', 'c d.md'])

    def test_distinct_labels_stay_distinct(self):
        # Control: different words are different labels.
        model = self.scan({'AGENTS.md': '[x][um dois]\n\n[um dois]: a.md\n[um tres]: b.md\n', 'a.md': '', 'b.md': ''})
        self.assertEqual(self.edges(model), [(1, 'a.md'), (3, 'a.md'), (4, 'b.md')])


class ManifestKeyEvidence(Case):
    def test_evidence_of_a_long_manifest_value_is_a_window(self):
        value = 'skills/' + 'x' * 600 + '.md'
        model = self.scan({'AGENTS.md': '# e\n', 'plugin.json': json.dumps({'skills': value, 'instructions': 'falta.md'})})
        evidence = {i['target']: i['evidence'] for i in model['issues'] if i['code'] == 'broken'}
        self.assertLessEqual(len(evidence[value]), scanner.EXCERPT)
        self.assertTrue(evidence[value].startswith('…'))
        # Control: a short value keeps the whole `key: value`.
        self.assertEqual(evidence['falta.md'], 'instructions: falta.md')


class EntriesOmittedInTheInterfaceModel(Case):
    def test_interface_gets_the_count_and_a_prefix_cli_keeps_every_path(self):
        model = self.scan({'AGENTS.md': '# e\n', **{f'a/f{i}.md': '' for i in range(8)}, **{f'z/p{i:02d}/AGENTS.md': '# e\n' for i in range(25)}}, limit=6)
        workspace = Workspace(self.base / 'state')
        workspace.model = model
        omitted = workspace.snapshot()['stats']['inventory']['entriesOmitted']
        self.assertEqual(omitted['count'], 25)
        self.assertEqual(omitted['paths'], [str(self.root / f'z/p{i:02d}/AGENTS.md') for i in range(ENTRIES_OMITTED_SHOWN)])
        self.assertEqual(len(model['stats']['inventory']['entriesOmitted']['paths']), 25)
        self.assertEqual(audit.audit(model)['metrics']['inventory']['entriesOmitted']['count'], 25)
        self.assertEqual(len(audit.audit(model)['metrics']['inventory']['entriesOmitted']['paths']), 25)

    def test_short_lists_are_untouched(self):
        stats = {'inventory': {'entriesOmitted': {'count': 2, 'paths': ['a', 'b']}}}
        self.assertIs(interface_stats(stats), stats)


class DeepManifest(Case):
    def test_a_manifest_past_the_parser_depth_is_partial_with_one_limit(self):
        deep = '[' * 3000 + ']' * 3000
        model = self.scan({'AGENTS.md': '# e\n', 'agent-architecture.json': '{"version": 1, "objects": ' + deep + '}'})
        limits = [i for i in model['issues'] if i['code'] == 'limit']
        self.assertEqual([(os.path.basename(i['node']), i['message']) for i in limits],
                         [('agent-architecture.json', 'Partial analysis: the JSON exceeded the depth limit of the parser.')])
        self.assertEqual(self.marker(model, 'agent-architecture.json'), 'resolved')
        node = next(n for n in model['nodes'] if n['path'] == str(self.root / 'agent-architecture.json'))
        self.assertEqual(node['analysis'], 'partial')


class NoEntryWithDeclaredScope(Case):
    def scope(self, **lists):
        return json.dumps({'version': 1, 'scope': {'version': 1, **lists}})

    def no_entry(self, model):
        return [i for i in model['issues'] if i['code'] == 'no-entry']

    def test_declared_entries_start_the_reading_without_no_entry(self):
        model = self.scan({'.claude/agents/a.md': '# a\n', 'agent-architecture.json': self.scope(entries=['.claude/agents/*.md'])})
        self.assertEqual(self.no_entry(model), [])
        self.assertIsNotNone(model['stats']['reachability'])

    def test_implicit_loads_start_the_reading_too(self):
        model = self.scan({'skills/x/SKILL.md': '# x\n', 'agent-architecture.json': self.scope(implicitLoads=['**/SKILL.md'])})
        self.assertEqual(self.no_entry(model), [])

    def test_a_scope_without_starting_points_keeps_no_entry(self):
        # Control: nothing starts the reading.
        model = self.scan({'leia.md': '# a\n', 'agent-architecture.json': self.scope(runtimeWorkspace=['work/'], entries=['nada/*.md'])})
        self.assertEqual(len(self.no_entry(model)), 1)
        self.assertIsNone(model['stats']['reachability'])


if __name__ == '__main__':
    unittest.main()
