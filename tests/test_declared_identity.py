"""Identity declared in a Markdown frontmatter, `path §section` mentions, the
always-loaded mass with declared entries and the count of real files. Disposable trees only."""
import contextlib
import io
import json
import os
from pathlib import Path
import random
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import cli
from server.scanner import EXCLUDED, FRONTMATTER_MAX_BYTES, FRONTMATTER_MAX_LINES, declared_name, references, scan

# The shape of the leaves of a graph memory: name and a long quoted description at the
# top level, and a nested metadata block whose keys must never count as identity.
LEAF = ('---\nname: {name}\ndescription: "Folha longa que cita name: outro-nome no meio do texto"\n'
        'metadata:\n  type: folha\n  hub: indice\n  tags: [memoria, grafo]\n  updated: 2026-10-01\n---\n# {title}\n')


def make(root, files):
    for relative, text in files.items():
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        (root / relative).write_text(text, encoding='utf-8')
    return root


def invoke(*arguments):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = cli.main([str(argument) for argument in arguments])
    return code, json.loads(output.getvalue())


class Tree(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-p012-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def tree(self, files, name='agent'):
        return make(self.folder / name, files)

    def audit(self, root, *arguments, code=0):
        result = invoke('audit', '--root', root, *arguments)
        self.assertEqual(result[0], code, result[1])
        return result[1]

    def save(self, name, value):
        path = self.folder / name
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    @staticmethod
    def edges(model, raw):
        return [edge for edge in model['edges'] if edge['raw'] == raw]

    @staticmethod
    def codes(report):
        return sorted(finding['code'] for finding in report['findings'])


class FrontmatterTests(unittest.TestCase):
    def test_valid_absent_unclosed_and_quoted_values(self):
        cases = [
            ('---\nname: folha-c-slug\n---\n# Folha C\n', 'folha-c-slug'),
            ('# Sem frontmatter\nname: x\n', None),
            ('Texto antes\n---\nname: x\n---\n', None),
            ('---\nname: x\n# sem linha de fechamento\n', None),
            ('---\nname: x\n', None),
            ('---\nname: "folha c slug"\n---\n', 'folha c slug'),
            ("---\nname: 'it''s'\n---\n", "it's"),
            ('---\nname:    folha-c   \n---\n', 'folha-c'),
            ('---\nname: "  folha c  "   # comentário\n---\n', 'folha c'),
            ('---\nname: folha-c # comentário\n---\n', 'folha-c'),
            ('---\nname: C#-notas\n---\n', 'C#-notas'),
            ('---\nname: "a\\"b"\n---\n', 'a"b'),
            ('---  \nname: espacos-no-delimitador\n---\t\n', 'espacos-no-delimitador'),
            ('﻿---\nname: com-bom\n---\n', 'com-bom'),
            ('---\nname: 2026\n---\n', '2026'),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(declared_name(text), expected)

    def test_list_object_block_empty_and_malformed_values_are_no_identity(self):
        for value in ['[a, b]', '{a: b}', '|', '>-', '', '~', 'null', '&ancora x', '*alias', '!!str x', 'a: b',
                      '"aberta', '"x" resto', "'x' resto", '"a\\nb"', '- item']:
            with self.subTest(value=value):
                self.assertIsNone(declared_name(f'---\nname: {value}\n---\n'))
        self.assertIsNone(declared_name('---\nname:\n  - a\n  - b\n---\n'))
        self.assertIsNone(declared_name('---\nname: |\n  bloco\n  multilinha\n---\n'))
        self.assertIsNone(declared_name('---\nname: [a,\n  b]\n---\n'))
        self.assertIsNone(declared_name('---\nname: "multi\n  linha"\n---\n'))
        self.assertIsNone(declared_name('---\nname:x\n---\n'), 'name:x sem espaço não é chave YAML')
        self.assertIsNone(declared_name('---\nname: a\nname: b\n---\n'), 'chave repetida')

    def test_only_a_top_level_key_counts(self):
        cases = [
            # A quoted description may contain the text `name:`.
            ('---\ndescription: "cita name: outro no meio"\n---\n', None),
            ('---\ndescription: "cita name: outro no meio"\nname: real\n---\n', 'real'),
            # ... also on a continuation line of a multiline quoted string, at column 0.
            ('---\ndescription: "começa aqui\nname: outro\ntermina aqui"\nname: real\n---\n', 'real'),
            ('---\ndescription: "começa aqui\nname: outro\ntermina aqui"\n---\n', None),
            ("---\ndescription: 'it''s\nname: outro\nfim'\nname: real\n---\n", 'real'),
            ('---\ndescription: "escapa a quebra \\\nname: outro\nfim"\nname: real\n---\n', 'real'),
            ('---\ntags: [a, "b,\nname: outro", c,\nname: outro2]\nname: real\n---\n', 'real'),
            # A nested block never declares the file's identity.
            ('---\nmetadata:\n  name: interno\n  type: folha\n---\n', None),
            ('---\nmetadata:\n  name: interno\nname: real\n---\n', 'real'),
            ('---\ndescription: texto plano\n  name: continuação indentada\n---\n', None),
            ('---\ndescription: >\n  bloco\nname: depois-do-bloco\n---\n', 'depois-do-bloco'),
            ('---\n# name: comentario\n---\n', None),
            # A value still open at the closing line leaves the header malformed.
            ('---\nname: real\ndescription: "aberta\n---\n', None),
            (LEAF.format(name='folha-c-slug', title='Folha C'), 'folha-c-slug'),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(declared_name(text), expected)

    def test_header_limits(self):
        body = lambda count: ''.join(f'k{index}: v\n' for index in range(count))
        # Delimiters included: 200 lines fit, 201 do not.
        self.assertEqual(declared_name('---\nname: x\n' + body(FRONTMATTER_MAX_LINES - 3) + '---\n'), 'x')
        self.assertIsNone(declared_name('---\nname: x\n' + body(FRONTMATTER_MAX_LINES - 2) + '---\n'))
        fill = FRONTMATTER_MAX_BYTES - len('---\nname: x\nk: \n---')
        self.assertEqual(declared_name('---\nname: x\nk: ' + 'v' * fill + '\n---\n'), 'x')
        self.assertIsNone(declared_name('---\nname: x\nk: ' + 'v' * (fill + 1) + '\n---\n'))
        # Bytes, not characters: two-byte characters reach the limit at half the length.
        self.assertIsNone(declared_name('---\nname: x\nk: ' + 'é' * (fill // 2 + 1) + '\n---\n'))

    def test_never_raises_on_random_headers(self):
        generator = random.Random(20261002)
        alphabet = ['name', ':', ' ', '\t', '"', "'", '\\', '[', ']', '{', '}', '#', ',', '\n', '---', '|', '>', '-', 'é', 'x', '﻿']
        for _ in range(4000):
            text = '---\n' + ''.join(generator.choice(alphabet) for _ in range(generator.randint(0, 60)))
            if generator.random() < 0.7:
                text += '\n---\n'
            result = declared_name(text)
            self.assertTrue(result is None or (isinstance(result, str) and result and '\n' not in result), text)


class WikiIdentityTests(Tree):
    def test_minimal_reproduction(self):
        root = self.tree({'AGENTS.md': 'Ver [[folha-c-slug]].\n', 'folha_c.md': '---\nname: folha-c-slug\n---\n# Folha C\n'})
        report = self.audit(root)
        self.assertEqual([f for f in report['findings'] if f['severity'] != 'info'], [])
        self.assertEqual(report['findings'], [])
        self.assertEqual(report['metrics']['resolution']['frontmatter-name'], 1)
        self.assertEqual(report['metrics']['reachability']['unreachable'], 0)
        model = scan([str(root)])
        edge, = self.edges(model, 'folha-c-slug')
        self.assertEqual((edge['target'], edge['resolvedBy'], edge['kind']), (str(root / 'folha_c.md'), 'frontmatter-name', 'wiki'))
        node = next(n for n in model['nodes'] if n['id'] == str(root / 'folha_c.md'))
        self.assertEqual((node['declaredName'], node['hops']), ('folha-c-slug', 1))

    def test_declared_name_wins_over_a_file_of_that_name_and_keeps_aliases(self):
        root = self.tree({'AGENTS.md': 'Ver [[x]] e [[x|rótulo]].\n[[indice]]\nSeção: [[x#Seção]]\n',
                          'x.md': '# Arquivo chamado x, sem identidade declarada\n',
                          'folhas/outra.md': LEAF.format(name='x', title='Outra'),
                          'indice.md': '# Índice sem frontmatter\n'})
        model = scan([str(root)])
        for raw in ('x', 'x#Seção'):
            edge, = self.edges(model, raw)
            self.assertEqual((edge['target'], edge['resolvedBy']), (str(root / 'folhas/outra.md'), 'frontmatter-name'))
        # The label is not part of the address: one edge per line and target, as before.
        self.assertEqual({edge['target'] for edge in model['edges'] if edge['line'] == 1}, {str(root / 'folhas/outra.md')})
        # A file without `name:` (index, README) still resolves by its file name only.
        edge, = self.edges(model, 'indice')
        self.assertEqual((edge['target'], edge['resolvedBy']), (str(root / 'indice.md'), 'file'))
        unreachable = [issue['node'] for issue in model['issues'] if issue['code'] == 'unreachable']
        self.assertEqual(unreachable, [str(root / 'x.md')])

    def test_two_declarers_are_ambiguous_with_candidates(self):
        root = self.tree({'AGENTS.md': 'Ver [[x]].\n', 'a.md': LEAF.format(name='x', title='A'),
                          'b/b.md': '---\nname: "x"\n---\n', 'x.md': '# Homônimo pelo nome de arquivo\n'})
        report = self.audit(root)
        ambiguous = [f for f in report['findings'] if f['code'] == 'ambiguous']
        self.assertEqual([(f['path'], f['line'], f['target'], f['candidates']) for f in ambiguous], [('AGENTS.md', 1, 'x', ['a.md', 'b/b.md'])])
        self.assertEqual(report['metrics']['resolution']['frontmatter-name'], 0)
        self.assertFalse([edge for edge in scan([str(root)])['edges'] if edge['raw'] == 'x'])

    def test_without_declarer_the_file_name_rules_are_unchanged(self):
        root = self.tree({'AGENTS.md': '[[guia]]\n[[ausente]]\n[[Folha]]\n[[nota-longa]]\n', 'docs/guia.md': '---\nname: outro-nome\n---\n',
                          'folha.md': '---\nname: folha\n---\n', 'notas.txt': '---\nname: guia\n---\n',
                          'longa.markdown': '---\nname: nota-longa\n---\n'})
        model = scan([str(root)])
        # Only Markdown declares identity: the .txt header is ignored, a .markdown one counts.
        edge, = self.edges(model, 'guia')
        self.assertEqual((edge['target'], edge['resolvedBy']), (str(root / 'docs/guia.md'), 'basename'))
        edge, = self.edges(model, 'nota-longa')
        self.assertEqual((edge['target'], edge['resolvedBy']), (str(root / 'longa.markdown'), 'frontmatter-name'))
        # Exact and case-sensitive: `Folha` is not the declared `folha`, nor the file folha.md.
        broken = sorted(issue['target'] for issue in model['issues'] if issue['code'] == 'broken')
        self.assertEqual(broken, ['Folha', 'ausente'])

    def test_directory_address_never_consults_the_frontmatter(self):
        root = self.tree({'AGENTS.md': '[[pasta/x]]\n[[pasta/y]]\n', 'outro.md': '---\nname: pasta/x\n---\n',
                          'pasta/z.md': '---\nname: y\n---\n', 'pasta/y.md': '# y\n'})
        model = scan([str(root)])
        self.assertEqual([issue['target'] for issue in model['issues'] if issue['code'] == 'broken'], ['pasta/x'])
        edge, = self.edges(model, 'pasta/y')
        self.assertEqual((edge['target'], edge['resolvedBy']), (str(root / 'pasta/y.md'), 'file'))

    def test_nested_roots_use_the_most_specific_root_of_the_source(self):
        parent = self.tree({'AGENTS.md': '[[x]]\n', 'g.md': '---\nname: x\n---\n',
                            'filho/AGENTS.md': '[[x]]\n', 'filho/f.md': '---\nname: x\n---\n'}, 'pai')
        child = parent / 'filho'
        model = scan([str(parent), str(child)])
        ambiguous = [(issue['node'], issue['candidates']) for issue in model['issues'] if issue['code'] == 'ambiguous']
        # The parent's scope still includes the child's files; the child sees only its own.
        self.assertEqual(ambiguous, [(str(parent / 'AGENTS.md'), [str(child / 'f.md'), str(parent / 'g.md')])])
        edge, = [edge for edge in model['edges'] if edge['source'] == str(child / 'AGENTS.md') and edge['kind'] == 'wiki']
        self.assertEqual((edge['target'], edge['resolvedBy']), (str(child / 'f.md'), 'frontmatter-name'))
        alone = scan([str(parent)])
        self.assertEqual(len([issue for issue in alone['issues'] if issue['code'] == 'ambiguous']), 2)

    def test_reachability_follows_the_declared_identity(self):
        root = self.tree({'CLAUDE.md': 'Memória: [[indice-memoria]]\n',
                          'memory/MEMORY.md': '---\nname: indice-memoria\n---\n- [[folha-a]]\n',
                          'memory/folha_a.md': LEAF.format(name='folha-a', title='A') + 'Ligada a [[folha-b]].\n',
                          'memory/folha_b.md': LEAF.format(name='folha-b', title='B'),
                          'memory/solta.md': LEAF.format(name='solta', title='Solta')})
        report = self.audit(root)
        self.assertEqual(report['metrics']['resolution']['frontmatter-name'], 3)
        self.assertEqual([(f['code'], f['path']) for f in report['findings']], [('unreachable', 'memory/solta.md')])
        hops = {node['relative']: node.get('hops') for node in scan([str(root)])['nodes']}
        self.assertEqual((hops['memory/MEMORY.md'], hops['memory/folha_a.md'], hops['memory/folha_b.md'], hops['memory/solta.md']), (1, 2, 3, None))


class SectionMentionTests(Tree):
    def extracted(self, text):
        return [(raw, source) for raw, source, *_ in references(text + '\n', '.md')]

    def test_path_followed_by_a_section_marker_is_the_reference(self):
        self.assertEqual(self.extracted('Ver `../x.md §3.2`, `./y.md §Y`, `docs/z.md §Y`, `w.md § 1` e `~/h.md §2`.'),
                         [('../x.md', 'path'), ('./y.md', 'path'), ('docs/z.md', 'path'), ('w.md', 'path'), ('~/h.md', 'path')])
        self.assertEqual(self.extracted('`../pasta/ §2`'), [('../pasta/', 'path')])

    def test_other_spans_with_spaces_are_not_references(self):
        for text in ('`python3 x.py --flag`', '`x.md Y`', '`pasta/ §2`', '`§ x.md`', '`docs/x §2`', '`a.md b.md §1`', '`make test §2`'):
            with self.subTest(text=text):
                self.assertEqual(self.extracted(text), [])

    def test_prose_path_never_starts_inside_a_path_token(self):
        self.assertEqual(self.extracted('Veja ../a/b.md hoje.'), [('../a/b.md', 'path')])
        self.assertEqual(self.extracted('ver x../a/b.md'), [])
        self.assertEqual(self.extracted('"Bash(./Projeto/scripts/t.sh)"'), [])
        self.assertEqual(self.extracted('Antes: `../x.md §Y`.'), [('../x.md', 'path')])

    def test_section_mention_resolves_from_the_source_folder(self):
        root = self.tree({'docs/sub/AGENTS.md': 'Regra em `../x.md §3.2` e `./irmao.md §Y`.\n', 'docs/x.md': '# X\n', 'docs/sub/irmao.md': '# I\n'})
        model = scan([str(root / 'docs')])
        found = sorted((edge['raw'], Path(edge['target']).relative_to(root).as_posix(), edge['resolvedBy']) for edge in model['edges'])
        self.assertEqual(found, [('../x.md', 'docs/x.md', 'file'), ('./irmao.md', 'docs/sub/irmao.md', 'file')])
        self.assertFalse([issue for issue in model['issues'] if issue['code'] in {'broken', 'unresolved-name'}])


class AlwaysLoadedTests(Tree):
    FILES = {'AGENTS.md': '# Entrada\n[Memória](memory/MEMORY.md)\n', 'CLAUDE.md': '# Outra entrada na raiz\n',
             'memory/MEMORY.md': '# Índice da memória\n' + 'linha\n' * 20, 'skills/a/SKILL.md': '# Skill carregada por gatilho\n',
             'sub/AGENTS.md': '# Entrada aninhada\n'}

    def setUp(self):
        super().setUp()
        self.root = self.tree(self.FILES)
        self.size = lambda relative: os.path.getsize(self.root / relative)

    def always(self, *arguments, code=0):
        return self.audit(self.root, *arguments, code=code)['metrics']['mass']['alwaysLoaded']

    def scope(self, **patterns):
        return self.save('scope.json', {'version': 1, **patterns})

    def test_without_suite_or_scope_only_root_level_conventions(self):
        always = self.always()
        self.assertEqual(always, {'bytes': self.size('AGENTS.md') + self.size('CLAUDE.md'), 'basis': 'root-level-entries',
                                  'files': [{'path': 'AGENTS.md', 'bytes': self.size('AGENTS.md'), 'source': 'convention'},
                                            {'path': 'CLAUDE.md', 'bytes': self.size('CLAUDE.md'), 'source': 'convention'}]})

    def test_declared_entries_sum_and_implicit_loads_do_not(self):
        always = self.always('--scope', self.scope(entries=['memory/MEMORY.md'], implicitLoads=['**/SKILL.md']))
        self.assertEqual(always['basis'], 'root-level-entries+declared-entries')
        self.assertEqual([(item['path'], item['source']) for item in always['files']],
                         [('AGENTS.md', 'convention'), ('CLAUDE.md', 'convention'), ('memory/MEMORY.md', 'declared-entry')])
        self.assertEqual(always['bytes'], sum(map(self.size, ['AGENTS.md', 'CLAUDE.md', 'memory/MEMORY.md'])))
        # entries and implicitLoads stay identical as starting points of the reachability.
        report = self.audit(self.root, '--scope', self.scope(entries=['skills/a/SKILL.md'], implicitLoads=['memory/MEMORY.md']))
        self.assertEqual([(item['path'], item['source']) for item in report['metrics']['mass']['alwaysLoaded']['files']][-1],
                         ('skills/a/SKILL.md', 'declared-entry'))
        self.assertNotIn('memory/MEMORY.md', [item['path'] for item in report['metrics']['mass']['alwaysLoaded']['files']])

    def test_a_convention_entry_also_declared_is_summed_once(self):
        always = self.always('--scope', self.scope(entries=['**/AGENTS.md']))
        self.assertEqual([(item['path'], item['source']) for item in always['files']],
                         [('AGENTS.md', 'convention'), ('CLAUDE.md', 'convention'), ('sub/AGENTS.md', 'declared-entry')])
        starts = scan([str(self.root)], {'version': 1, 'entries': ['**/AGENTS.md']})['stats']['reachability']['starts']
        self.assertIn({'node': str(self.root / 'sub/AGENTS.md'), 'source': 'convention', 'declared': 'declared-entry'}, starts)

    def test_suite_entry_plus_declared_entries_and_the_budget_stays_on_the_suite_entry(self):
        size = self.size('AGENTS.md')
        suite = lambda budget: self.save('suite.json', {'version': 1, 'entry': 'AGENTS.md', 'scenarios': [
            {'id': 'normal', 'required': [{'path': 'memory/MEMORY.md', 'startLine': 1, 'endLine': 1}], 'maxAlwaysLoadedBytes': budget}]})
        scope = self.scope(entries=['memory/MEMORY.md'])
        report = self.audit(self.root, '--suite', suite(size), '--scope', scope)
        always = report['metrics']['mass']['alwaysLoaded']
        self.assertEqual((always['basis'], [(item['path'], item['source']) for item in always['files']]),
                         ('suite-entry+declared-entries', [('AGENTS.md', 'suite-entry'), ('memory/MEMORY.md', 'declared-entry')]))
        self.assertGreater(always['bytes'], size)
        self.assertNotIn('always-loaded-budget-exceeded', self.codes(report))
        exceeded = [f for f in self.audit(self.root, '--suite', suite(size - 1), '--scope', scope, code=1)['findings']
                    if f['code'] == 'always-loaded-budget-exceeded']
        self.assertEqual([(f['path'], f['actual'], f['maximum']) for f in exceeded], [('AGENTS.md', size, size - 1)])
        plain = self.audit(self.root, '--suite', suite(size))['metrics']['mass']['alwaysLoaded']
        self.assertEqual(plain, {'bytes': size, 'basis': 'suite-entry', 'files': [{'path': 'AGENTS.md', 'bytes': size, 'source': 'suite-entry'}]})

    def test_summary_caps_the_parcels_and_keeps_the_sum(self):
        full = self.always('--scope', self.scope(entries=['memory/MEMORY.md', 'sub/AGENTS.md']))
        capped = self.always('--scope', self.scope(entries=['memory/MEMORY.md', 'sub/AGENTS.md']), '--summary', '--top', '1')
        self.assertEqual((capped['filesTotal'], capped['bytes'], capped['files']), (4, full['bytes'], [{'path': 'memory/MEMORY.md', 'bytes': self.size('memory/MEMORY.md'), 'source': 'declared-entry'}]))


class FileCountTests(Tree):
    def test_files_count_real_files_and_unresolved_targets_apart(self):
        root = self.tree({'AGENTS.md': '[A](ausente.md)\n[B](docs/falta.md)\n[[outra-ausente]]\n[Fora](../fora/x.md)\n[Gerado](dist/saida.md)\n`nome-solto.md`\n',
                          'docs/guia.md': '# Guia\n', 'dados/tabela.csv': 'a,b\n', 'imagem.png': 'x',
                          'node_modules/pacote/README.md': '# excluído\n', 'dist/saida.md': '# excluído\n'})
        (root / 'vazio').mkdir()
        os.symlink(root / 'docs/guia.md', root / 'atalho.md')
        os.symlink(root / 'docs', root / 'atalho-pasta')
        # `find ROOT -type f`, pruning the directories excluded by the policy.
        real = 0
        for folder, dirs, files in os.walk(root):
            dirs[:] = [name for name in dirs if name not in EXCLUDED]
            real += sum(not os.path.islink(os.path.join(folder, name)) for name in files)
        model = scan([str(root)])
        unresolved = [node for node in model['nodes'] if node['kind'] == 'unresolved']
        self.assertEqual((model['stats']['files'], real), (4, 4))
        self.assertEqual(model['stats']['unresolvedTargets'], len(unresolved))
        self.assertEqual(sorted(node['status'] for node in unresolved), ['external', 'missing', 'missing', 'missing', 'missing', 'unscanned'])
        report = self.audit(root)
        self.assertEqual((report['metrics']['files'], report['metrics']['unresolvedTargets']), (4, 6))
        self.assertEqual(list(report['metrics'])[:3], ['files', 'unresolvedTargets', 'parsed'])


if __name__ == '__main__':
    unittest.main()
