"""Scanner, scope matcher and compare-audit behaviour on hostile or unusual input, on disposable trees only."""
import contextlib
import errno
import functools
import io
import json
from pathlib import Path
import random
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import cli, scanner, scope

FILES = {
    'AGENTS.md': '# Entrada\n[Skill](skills/a/SKILL.md)\n[Ausente](docs/ausente.md)\n`politica.md`\n`dup.md`\n',
    'skills/a/SKILL.md': '# Skill\n[Ref](references/ref.md)\n`AGENTS.md`\n',
    'skills/a/references/ref.md': '# Ref\n',
    'regras/politica.md': '# Política\n',
    'x/dup.md': '# X\n',
    'y/dup.md': '# Y\n',
    'orfao.md': '# Órfão\n',
}


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


def signature(report):
    return sorted((f['id'], f['code'], f.get('path'), str(f.get('target'))) for f in report['findings'])


class ExcludedAncestorTests(unittest.TestCase):
    """EXCLUDED names apply below the opened root, never to the directories that contain it."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-review-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def test_root_below_an_excluded_ancestor_keeps_every_finding_and_id(self):
        plain = make(self.folder / 'plain' / 'agent', FILES)
        reports = [invoke('audit', '--root', plain)[1]]
        for ancestor in ('build', 'dist', 'node_modules', '.cache', 'venv', 'coverage', 'target'):
            with self.subTest(ancestor=ancestor):
                copy = self.folder / 'x' / ancestor / 'deep' / 'agent'
                shutil.copytree(plain, copy)
                reports.append(invoke('audit', '--root', copy)[1])
                self.assertEqual(signature(reports[-1]), signature(reports[0]))
                self.assertEqual(reports[-1]['metrics']['resolution'], reports[0]['metrics']['resolution'])
        codes = {f['code'] for f in reports[0]['findings']}
        self.assertTrue({'broken', 'ambiguous', 'basename-resolved'} <= codes, codes)

    def test_root_named_like_an_excluded_directory_is_scanned_as_opened(self):
        plain = make(self.folder / 'agent', FILES)
        named = self.folder / 'outro' / 'build'
        shutil.copytree(plain, named)
        self.assertEqual(signature(invoke('audit', '--root', named)[1]), signature(invoke('audit', '--root', plain)[1]))

    def test_excluded_directories_below_the_root_still_stay_unscanned(self):
        root = make(self.folder / 'build' / 'agent', {'AGENTS.md': '[Gerado](dist/saida.md)\n[Pacote](node_modules/x/README.md)\n'})
        (root / 'dist').mkdir()
        (root / 'dist' / 'saida.md').write_text('gerado\n', encoding='utf-8')
        model = scanner.scan([str(root)])
        status = {Path(node['id']).relative_to(root).as_posix(): node['status'] for node in model['nodes'] if node['kind'] == 'unresolved'}
        self.assertEqual(status, {'dist/saida.md': 'unscanned', 'node_modules/x/README.md': 'unscanned'})
        self.assertFalse([i for i in model['issues'] if i['code'] == 'broken'])

    def test_explicit_child_root_below_an_excluded_directory_of_its_parent_is_complete(self):
        parent = make(self.folder / 'pai', {'AGENTS.md': '# Pai\n'})
        child = make(parent / 'build' / 'filho', {'AGENTS.md': '[Ausente](ausente.md)\n'})
        model = scanner.scan([str(parent), str(child)])
        broken = [i for i in model['issues'] if i['code'] == 'broken']
        self.assertEqual([(i['node'], i['target']) for i in broken], [(str(child / 'AGENTS.md'), 'ausente.md')])

    def test_memory_kind_ignores_directories_above_the_root(self):
        plain = make(self.folder / 'plain' / 'agent', FILES)
        copy = self.folder / 'memory' / 'agent'
        shutil.copytree(plain, copy)
        kinds = [{Path(n['id']).relative_to(root).as_posix(): n['kind'] for n in scanner.scan([str(root)])['nodes'] if n['status'] == 'resolved'}
                 for root in (plain, copy)]
        self.assertEqual(kinds[0], kinds[1])
        self.assertEqual(kinds[0]['orfao.md'], 'file')


class ResolutionCacheTests(unittest.TestCase):
    def test_file_uri_and_bare_path_resolve_independently_of_order(self):
        with tempfile.TemporaryDirectory(prefix='aae-review-cache-') as folder:
            root = make(Path(folder) / 'agent', {'outra/docs/x.md': '# X\n', 'AGENTS.md': ''})
            outcomes = []
            for text in ('[u](file:docs/x.md)\n[b](docs/x.md)\n', '[b](docs/x.md)\n[u](file:docs/x.md)\n'):
                (root / 'AGENTS.md').write_text(text, encoding='utf-8')
                model = scanner.scan([str(root)])
                edges = {e['raw']: e['resolvedBy'] for e in model['edges'] if e['kind'] != 'scope'}
                broken = sorted(i['target'] for i in model['issues'] if i['code'] == 'broken')
                outcomes.append((edges, broken))
            # The URI is anchored (file-relative only); the bare path descends the cascade.
            self.assertEqual(outcomes[0], ({'file:docs/x.md': None, 'docs/x.md': 'suffix'}, ['file:docs/x.md']))
            self.assertEqual(outcomes[1], outcomes[0])


class HostileReferenceTests(unittest.TestCase):
    def test_wiki_link_to_the_filesystem_root_does_not_abort_the_scan(self):
        with tempfile.TemporaryDirectory(prefix='aae-review-wiki-') as folder:
            root = make(Path(folder) / 'agent', {'AGENTS.md': '# E\n[[/]]\n[[//]]\n[[///?x/]]\n[Ausente](ausente.md)\n'})
            code, report = invoke('audit', '--root', root)
            self.assertEqual((code, report['kind']), (0, 'audit'), report)
            self.assertEqual([(f['code'], f['target']) for f in report['findings'] if f['code'] == 'broken'], [('broken', 'ausente.md')])


    def test_reference_with_a_name_above_255_bytes_is_broken_not_an_aborted_scan(self):
        # Python 3.10/3.11 Path.exists()/is_symlink() raise ENAMETOOLONG; emulate them here.
        def strict(original):
            def check(path):
                if any(len(part.encode()) > 255 for part in path.parts):
                    raise OSError(errno.ENAMETOOLONG, 'File name too long')
                return original(path)
            return check
        with tempfile.TemporaryDirectory(prefix='aae-review-long-') as folder:
            long_name = 'a' * 300 + '.md'
            root = make(Path(folder) / 'agent', {'AGENTS.md': f'# E\n[Longo]({long_name})\n[Fundo](sub/{"b" * 300}/c.md)\n'})
            with mock.patch.object(Path, 'exists', strict(Path.exists)), mock.patch.object(Path, 'is_symlink', strict(Path.is_symlink)):
                code, report = invoke('audit', '--root', root)
            self.assertEqual((code, report['kind']), (0, 'audit'), report)
            self.assertEqual(sorted(len(f['target']) for f in report['findings'] if f['code'] == 'broken'), [303, 309])


    def test_long_hostile_lines_are_scanned_in_linear_time(self):
        lines = ['[' * 200000, '[[' * 100000, '[a](<' * 40000, '[a](x "' * 30000, "[a](x '" * 30000, '[a][' * 60000]
        started = time.monotonic()
        for line in lines:
            self.assertEqual(list(scanner.references(line + '\n', '.md')), [])
        self.assertLess(time.monotonic() - started, 3)

    def test_hostile_frontmatter_headers_are_read_in_linear_time(self):
        # Headers at the size limit: escapes, doubled quotes, nested and unclosed flow,
        # padding before a quote, colons and comment markers; none may raise or stall.
        size = scanner.FRONTMATTER_MAX_BYTES - 64
        headers = ['a: "' + '\\"' * (size // 2), "a: '" + "''" * (size // 2), 'a: ' + '[' * size, 'a: [' + "''," * (size // 3),
                   'a: [' + ' ' * size + "'", ':' * size, 'name: ' + ' ' * size + '[x', 'name: ' + ' #' * (size // 2),
                   'a: "\n' * 190, ('k: [' + '"\\\\' * 50 + '\n') * 150, 'name: "' + 'é' * (size // 2)]
        started = time.monotonic()
        for _ in range(100):
            for header in headers:
                self.assertIsNone(scanner.declared_name('---\n' + header + '\n---\n'))
            self.assertEqual(scanner.declared_name('---\nname:' + ' ' * size + 'x  \n---\n'), 'x')
        self.assertLess(time.monotonic() - started, 5)

    def test_declared_name_index_is_linear_in_twenty_thousand_inventoried_elements(self):
        # One folder per file defeats the per-folder resolution cache: every wikilink is
        # resolved against the same declared name, with ~10,000 declarers.
        with tempfile.TemporaryDirectory(prefix='aae-review-names-') as folder:
            root = Path(folder) / 'agent'
            make(root, {'AGENTS.md': '[[x]]\n'})
            for index in range(scanner.MAX_FILES // 2 - 2):
                make(root / f'd{index}', {'f.md': '---\nname: x\n---\n[[x]]\n'})
            started = time.monotonic()
            model = scanner.scan([str(root)])
            self.assertLess(time.monotonic() - started, 15)
        ambiguous = [issue for issue in model['issues'] if issue['code'] == 'ambiguous']
        self.assertEqual(len(ambiguous), scanner.MAX_FILES // 2 - 1)
        self.assertEqual({len(issue['candidates']) for issue in ambiguous}, {scanner.MAX_CANDIDATES})

    def test_link_forms_still_extracted(self):
        text = ('[a](<docs/my doc.md>) [b](b.md "Título") [c](c.md \'ti "x" tle\') [d [e](e.md) [[f|g]] '
                '[![badge](img.png)](link.md) [h][ref]\n[ref]: ref.md\n')
        found = [raw for raw, *_ in scanner.references(text, '.md')]
        self.assertEqual(found, ['docs/my doc.md', 'b.md', 'c.md', 'e.md', 'img.png', 'ref.md', 'f', 'ref.md'])


class CompareAuditInputTests(unittest.TestCase):
    def test_unhashable_status_or_severity_is_an_input_error_with_json(self):
        with tempfile.TemporaryDirectory(prefix='aae-review-compare-') as folder:
            folder = Path(folder)
            root = make(folder / 'agent', FILES)
            report = invoke('audit', '--root', root)[1]
            self.assertTrue(report['findings'])
            for field, value in (('status', []), ('status', {}), ('severity', ['warning']), ('severity', {})):
                with self.subTest(field=field, value=value):
                    broken = json.loads(json.dumps(report))
                    if field == 'status':
                        broken['status'] = value
                    else:
                        broken['findings'][0]['severity'] = value
                    before, after = folder / 'antes.json', folder / 'depois.json'
                    before.write_text(json.dumps(broken), encoding='utf-8')
                    after.write_text(json.dumps(report), encoding='utf-8')
                    code, result = invoke('compare-audit', '--before', before, '--after', after)
                    self.assertEqual((code, result['kind'], result['findings'][0]['code']), (2, 'error', 'invalid-input'))


def reference_match(pattern, relative):
    """Slow, obviously correct glob semantics of server/scope.py, for comparison."""
    directory = pattern.endswith('/')
    pattern_segments = (pattern[:-1] if directory else pattern).split('/')
    segments = relative.split('/')

    def segment_match(glob, name):
        @functools.lru_cache(None)
        def match(i, j):
            if i == len(glob):
                return j == len(name)
            if glob[i] == '*':
                return any(match(i + 1, k) for k in range(j, len(name) + 1))
            return j < len(name) and glob[i] in {'?', name[j]} and match(i + 1, j + 1)
        return match(0, 0)

    @functools.lru_cache(None)
    def match(i, j):
        if i == len(pattern_segments):
            return j == len(segments) or (directory and j <= len(segments))
        if pattern_segments[i] == '**':
            lowest = j + 1 if i == len(pattern_segments) - 1 else j
            return any(match(i + 1, k) for k in range(lowest, len(segments) + 1))
        return j < len(segments) and segment_match(pattern_segments[i], segments[j]) and match(i + 1, j + 1)
    return match(0, 0)


class ScopeMatcherTests(unittest.TestCase):
    """Scope patterns come from --scope, --source and from agent-architecture.json inside inspected trees."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-review-scope-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'agent'

    def test_matcher_agrees_with_reference_semantics(self):
        generator = random.Random(20261002)

        def segment(wild=True):
            return ''.join(generator.choice('ab*?' if wild else 'ab') for _ in range(generator.randint(1, 4)))
        checked = 0
        while checked < 6000:
            pattern = '/'.join('**' if generator.random() < 0.25 else segment() for _ in range(generator.randint(1, 4)))
            pattern += '/' if generator.random() < 0.3 else ''
            try:
                scope._pattern(pattern, 'teste')
            except ValueError:
                continue
            for _ in range(6):
                relative = '/'.join(segment(False) for _ in range(generator.randint(1, 5)))
                self.assertEqual(scope.matches(pattern, relative), reference_match(pattern, relative), (pattern, relative))
                checked += 1

    def test_pathological_patterns_stay_linear(self):
        cases = [('*a' * 40 + '*c', 'a' * 255 + 'b'), ('**/' * 60 + 'x', '/'.join(['a'] * 3000)),
                 ('**/a*a*a*a*a*a*b/**/c', '/'.join(['a' * 200] * 200))]
        started = time.monotonic()
        for pattern, relative in cases:
            self.assertFalse(scope.matches(pattern, relative))
        self.assertLess(time.monotonic() - started, 2)

    def test_invalid_embedded_scope_echoes_a_bounded_sample_of_its_keys(self):
        keys = {f'campo-{index}-' + 'x' * 500: [] for index in range(2000)}
        make(self.root, {'AGENTS.md': '# E\n', 'agent-architecture.json': json.dumps({'scope': {'version': 1, **keys}})})
        manifest = [i for i in scanner.scan([str(self.root)])['issues'] if i['code'] == 'manifest']
        self.assertEqual(len(manifest), 1)
        self.assertLess(len(manifest[0]['message']), 600)
        self.assertIn('and 1995 more', manifest[0]['message'])

    def test_embedded_scope_in_an_inspected_tree_cannot_stall_the_scan(self):
        hostile = '*a' * 20 + '*c'
        make(self.root, {'AGENTS.md': '[Longo](' + 'a' * 200 + 'b.md)\n',
                         'a' * 200 + 'x.md': '# arquivo\n',
                         'agent-architecture.json': json.dumps({'scope': {'version': 1, 'runtimeWorkspace': [hostile], 'entries': [hostile]}})})
        started = time.monotonic()
        model = scanner.scan([str(self.root)])
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual([i['target'] for i in model['issues'] if i['code'] == 'broken'], ['a' * 200 + 'b.md'])
        started = time.monotonic()
        code, report = invoke('audit', '--root', self.root, '--source', hostile)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual((code, report['filter']['matched']), (0, 0))


if __name__ == '__main__':
    unittest.main()
