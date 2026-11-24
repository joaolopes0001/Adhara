"""Resolution cascade, declared scope, reachability and mass with disposable agents."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from scanner import scan, validate_scope
from scope import matches


class ScannerModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-model-')
        self.base = Path(self.temp.name)
        self.root = self.base / 'agent'
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, relative, text, root=None):
        path = (root or self.root) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return str(path)

    def edge(self, model, source, raw):
        return next(e for e in model['edges'] if e['source'] == source and e['raw'] == raw)

    def codes(self, model, code):
        return [i for i in model['issues'] if i['code'] == code]

    def test_cascade_steps_and_order(self):
        entry = self.write('AGENTS.md', '[Skill](skills/x/SKILL.md)\n')
        skill = self.write('skills/x/SKILL.md', '`AGENTS.md`\n[Ref](references/a.md)\n`unique.md`\n`deep/two.md`\n')
        source = self.write('skills/x/references/a.md', '`references/b.md`\n`c.md`\n')
        in_skill = self.write('skills/x/references/b.md', '# B in skill\n')
        self.write('references/b.md', '# B at root, shadowed by the skill step\n')
        near = self.write('skills/x/references/c.md', '# C next to the source\n')
        self.write('skills/x/c.md', '# C at skill root, shadowed by the file step\n')
        unique = self.write('docs/very/unique.md', '# Unique basename\n')
        suffix = self.write('docs/deep/two.md', '# Unique suffix\n')
        self.write('docs/two.md', '# Same basename, different suffix\n')
        model = scan([str(self.root)])
        expected = {(skill, 'AGENTS.md'): (entry, 'root'), (skill, 'references/a.md'): (source, 'file'),
                    (skill, 'unique.md'): (unique, 'basename'), (skill, 'deep/two.md'): (suffix, 'suffix'),
                    (source, 'references/b.md'): (in_skill, 'skill'), (source, 'c.md'): (near, 'file')}
        for (origin, raw), (target, mode) in expected.items():
            with self.subTest(raw=raw):
                edge = self.edge(model, origin, raw)
                self.assertEqual((edge['target'], edge['resolvedBy']), (target, mode))
        self.assertFalse(self.codes(model, 'broken') + self.codes(model, 'ambiguous'))
        self.assertEqual(model['stats']['resolution'], {'file': 3, 'frontmatter-name': 0, 'skill': 1, 'root': 1, 'root-dot': 0, 'skill-basename': 0, 'skill-suffix': 0, 'basename': 1, 'suffix': 1,
                                                         'unresolved': 0, 'unresolvedNames': 0, 'unscanned': 0})

    def test_anchored_references_never_descend(self):
        # A `./` Markdown link stays strict; a `./` path mention tries only the opened root.
        entry = self.write('AGENTS.md', '[Skill](skills/x/SKILL.md)\n')
        skill = self.write('skills/x/SKILL.md', '[Dot](./AGENTS.md)\n[Up](../AGENTS.md)\n[Abs](/nowhere/AGENTS.md)\n`~/aae-never/AGENTS.md`\n[Parent](sub/../../AGENTS.md)\n`./AGENTS.md`\n')
        model = scan([str(self.root)])
        for raw in ('./AGENTS.md', '../AGENTS.md', 'sub/../../AGENTS.md'):
            with self.subTest(raw=raw):
                edge = next(e for e in model['edges'] if e['source'] == skill and e['raw'] == raw and e['kind'] == 'markdown')
                self.assertIsNone(edge['resolvedBy'])
                self.assertEqual(next(n for n in model['nodes'] if n['id'] == edge['target'])['status'], 'missing')
        self.assertEqual({i['target'] for i in self.codes(model, 'broken')}, {'./AGENTS.md', '../AGENTS.md', 'sub/../../AGENTS.md'})
        self.assertEqual([i['syntax'] for i in self.codes(model, 'broken') if i['target'] == './AGENTS.md'], ['markdown'])
        mention = next(e for e in model['edges'] if e['source'] == skill and e['kind'] == 'path' and e['raw'] == './AGENTS.md')
        self.assertEqual((mention['target'], mention['resolvedBy']), (entry, 'root-dot'))
        self.assertIsNone(self.edge(model, skill, '/nowhere/AGENTS.md')['resolvedBy'])

    def test_ambiguous_basename_lists_candidates_without_edge_and_suffix_respects_segments(self):
        source = self.write('AGENTS.md', '# Entry\n`criterios.md`\n`a/criterios.md`\n`b/c.md`\n')
        first = self.write('x/criterios.md', '# One\n')
        second = self.write('y/criterios.md', '# Two\n')
        self.write('ab/c.md', '# Not a segment-boundary suffix of b/c.md\n')
        model = scan([str(self.root)])
        ambiguous = self.codes(model, 'ambiguous')
        self.assertEqual([(i['node'], i['line'], i['target'], i['candidates']) for i in ambiguous], [(source, 2, 'criterios.md', [first, second])])
        self.assertIn('2 candidates', ambiguous[0]['message'])
        self.assertFalse(any(e['raw'] == 'criterios.md' for e in model['edges']))
        # No candidate at all reports the reference as missing and broken.
        self.assertEqual({i['target'] for i in self.codes(model, 'broken')}, {'a/criterios.md', 'b/c.md'})

    def test_candidate_list_is_bounded_and_sorted(self):
        self.write('AGENTS.md', '`shared.md`\n')
        for index in range(25):
            self.write(f'd{index:02d}/shared.md', '# Copy\n')
        issue = self.codes(scan([str(self.root)]), 'ambiguous')[0]
        self.assertEqual(issue['candidates'], sorted(issue['candidates']))
        self.assertEqual(len(issue['candidates']), 20)
        self.assertIn('25 candidates', issue['message'])

    def test_unscanned_file_step_does_not_descend(self):
        outside = self.base / 'outside'
        outside.mkdir()
        self.write('x.md', '# Outside payload\n', outside)
        self.write('AGENTS.md', '[Doc](sub/doc.md)\n')
        doc = self.write('sub/doc.md', '[Linked](link/x.md)\n[Excluded](node_modules/y.md)\n')
        (self.root / 'sub' / 'link').symlink_to(outside, target_is_directory=True)
        self.write('link/x.md', '# Root-relative decoy\n')
        self.write('sub/node_modules/y.md', '# Excluded\n')
        self.write('node_modules/y.md', '# Excluded decoy\n')
        model = scan([str(self.root)])
        for raw, target in (('link/x.md', self.root / 'sub/link/x.md'), ('node_modules/y.md', self.root / 'sub/node_modules/y.md')):
            with self.subTest(raw=raw):
                edge = self.edge(model, doc, raw)
                self.assertEqual((edge['target'], edge['resolvedBy']), (str(target), None))
                self.assertEqual(next(n for n in model['nodes'] if n['id'] == str(target))['status'], 'unscanned')
        self.assertFalse(self.codes(model, 'broken'))

    def test_wiki_keeps_rules_and_reports_resolution_mode(self):
        entry = self.write('AGENTS.md', '[[local]]\n[[remote]]\n[[same]]\n[[dir/remote]]\n')
        local = self.write('local.md', '# Local\n')
        remote = self.write('far/remote.md', '# Remote\n')
        self.write('a/same.md', '# A\n')
        self.write('b/same.md', '# B\n')
        model = scan([str(self.root)])
        self.assertEqual((self.edge(model, entry, 'local')['target'], self.edge(model, entry, 'local')['resolvedBy']), (local, 'file'))
        self.assertEqual((self.edge(model, entry, 'remote')['target'], self.edge(model, entry, 'remote')['resolvedBy']), (remote, 'basename'))
        ambiguous = self.codes(model, 'ambiguous')
        self.assertEqual([(i['line'], i['target'], len(i['candidates'])) for i in ambiguous], [(3, 'same', 2)])
        self.assertEqual(ambiguous[0]['message'], 'Ambiguous wiki reference: same')
        # Directory-qualified wiki addresses stay exact: no suffix fallback.
        self.assertEqual([i['target'] for i in self.codes(model, 'broken')], ['dir/remote'])

    def test_scope_validation_accepts_and_rejects(self):
        valid = {'version': 1, 'runtimeWorkspace': ['drafts/', 'inbox/**'], 'localFiles': ['config/*.local.json'],
                 'entries': ['.claude/agents/*.md'], 'implicitLoads': ['**/SKILL.md']}
        self.assertEqual(validate_scope(valid), valid)
        self.assertEqual(validate_scope({'version': 1}), {'version': 1, 'runtimeWorkspace': [], 'localFiles': [], 'entries': [], 'implicitLoads': []})
        invalid = [None, [], {}, {'version': 2}, {'version': True}, {'version': '1'}, {'version': 1, 'extra': []},
                   {'version': 1, 'entries': 'a.md'}, {'version': 1, 'entries': [1]}, {'version': 1, 'entries': ['']},
                   {'version': 1, 'entries': ['/abs.md']}, {'version': 1, 'entries': ['a/../b.md']}, {'version': 1, 'entries': ['a//b.md']},
                   {'version': 1, 'entries': ['./a.md']}, {'version': 1, 'entries': ['a\\b.md']}, {'version': 1, 'entries': ['a\nb']},
                   {'version': 1, 'entries': ['x' * 301]}, {'version': 1, 'entries': ['a.md', 'a.md']},
                   {'version': 1, 'entries': [f'{i}.md' for i in range(150)], 'localFiles': [f'{i}.json' for i in range(51)]}]
        for value in invalid:
            with self.subTest(value=str(value)[:60]), self.assertRaises(ValueError):
                validate_scope(value)
        with self.assertRaises(ValueError):
            scan([str(self.root)], {'version': 1, 'unknown': []})

    def test_pattern_semantics(self):
        cases = [('config/*.local.json', 'config/profile.local.json', True), ('config/*.local.json', 'config/a/profile.local.json', False),
                 ('*.md', 'a/b.md', False), ('?.md', 'a.md', True), ('?.md', 'ab.md', False), ('a?b', 'a/b', False),
                 ('**/SKILL.md', 'SKILL.md', True), ('**/SKILL.md', 'skills/x/SKILL.md', True), ('a/**/b.md', 'a/b.md', True),
                 ('a/**/b.md', 'a/x/y/b.md', True), ('drafts/', 'drafts/x/y.md', True), ('drafts/', 'drafts', True), ('drafts/', 'drafts_b', False),
                 ('drafts/', 'x/drafts', False), ('a/**/', 'a', False), ('a/**/', 'a/b', True),
                 ('dir/**', 'dir', False), ('dir/**', 'dir/a', True), ('**', 'a/b', True), ('Docs/a.md', 'docs/a.md', False),
                 ('a.b', 'axb', False), ('[x].md', '[x].md', True), ('[x].md', 'x.md', False)]
        for pattern, path, expected in cases:
            with self.subTest(pattern=pattern, path=path):
                self.assertEqual(matches(pattern, path), expected)

    def test_absorption_by_written_form_and_by_root_relative_path(self):
        self.write('AGENTS.md', '[Skill](skills/x/SKILL.md)\n`drafts/memo.md`\n')
        skill = self.write('skills/x/SKILL.md', '`drafts/memo.md`\n[Out](../../workspace/out.md)\n`config/profile.local.json`\n`ghost.md`\n')
        scope = {'version': 1, 'runtimeWorkspace': ['drafts/', 'workspace/**'], 'localFiles': ['config/*.local.json']}
        model = scan([str(self.root)], scope)
        written = self.edge(model, skill, 'drafts/memo.md')
        self.assertEqual(written['declared'], {'kind': 'runtimeWorkspace', 'pattern': 'drafts/'})
        self.assertIsNone(written['resolvedBy'])
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == written['target'])['status'], 'declared')
        relative = self.edge(model, skill, '../../workspace/out.md')
        self.assertEqual(relative['declared'], {'kind': 'runtimeWorkspace', 'pattern': 'workspace/**'})
        self.assertEqual(self.edge(model, skill, 'config/profile.local.json')['declared']['kind'], 'localFiles')
        self.assertFalse(self.codes(model, 'broken'))
        self.assertEqual([i['target'] for i in self.codes(model, 'unresolved-name')], ['ghost.md'])
        self.assertEqual(model['scope'], {'source': 'flag', 'patterns': [
            {'kind': 'runtimeWorkspace', 'pattern': 'drafts/', 'references': 2, 'files': 0},
            {'kind': 'runtimeWorkspace', 'pattern': 'workspace/**', 'references': 1, 'files': 0},
            {'kind': 'localFiles', 'pattern': 'config/*.local.json', 'references': 1, 'files': 0}]})
        self.assertFalse(self.codes(model, 'scope-unused-pattern'))
        self.assertEqual((model['stats']['resolution']['unresolved'], model['stats']['resolution']['unresolvedNames']), (5, 1))
        # Without the declaration the same references are reported again: nothing disappears silently.
        undeclared = scan([str(self.root)])
        self.assertEqual((len(self.codes(undeclared, 'broken')), len(self.codes(undeclared, 'unresolved-name'))), (4, 1))

    def test_trailing_slash_pattern_absorbs_the_directory_reference_itself(self):
        source = self.write('AGENTS.md', '[Pasta](drafts/)\n[Sem barra](drafts)\n[Dentro](drafts/a/b.md)\n[Vizinho](drafts_b/x.md)\n')
        model = scan([str(self.root)], {'version': 1, 'runtimeWorkspace': ['drafts/']})
        for raw in ('drafts/', 'drafts', 'drafts/a/b.md'):
            with self.subTest(raw=raw):
                edge = self.edge(model, source, raw)
                self.assertEqual(edge['declared'], {'kind': 'runtimeWorkspace', 'pattern': 'drafts/'})
                self.assertEqual(next(n for n in model['nodes'] if n['id'] == edge['target'])['status'], 'declared')
        self.assertEqual([i['target'] for i in self.codes(model, 'broken')], ['drafts_b/x.md'])
        self.assertEqual(model['scope']['patterns'][0]['references'], 3)
        # dir/** keeps excluding the directory itself.
        explicit = scan([str(self.root)], {'version': 1, 'runtimeWorkspace': ['drafts/**']})
        self.assertEqual({i['target'] for i in self.codes(explicit, 'broken')}, {'drafts/', 'drafts_b/x.md'})
        # A link without / nor extension that is not absorbed is a name, not a broken path.
        self.assertEqual([i['target'] for i in self.codes(explicit, 'unresolved-name')], ['drafts'])

    def test_shared_placeholder_stays_missing_when_any_reference_is_not_absorbed(self):
        # run/<name> declares out.md by its written form; <other> writes run/out.md, which is not absorbed.
        scope = {'version': 1, 'runtimeWorkspace': ['out.md']}
        for absorbed_name, other_name in (('AGENTS.md', 'other.md'), ('notes.md', 'AGENTS.md')):
            with self.subTest(absorbed_first=absorbed_name == 'AGENTS.md'), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                absorbed = self.write(f'run/{absorbed_name}', '`out.md`\n', root)
                other = self.write(other_name, '`run/out.md`\n', root)
                model = scan([str(root)], scope)
                self.assertEqual(self.edge(model, absorbed, 'out.md')['declared'], {'kind': 'runtimeWorkspace', 'pattern': 'out.md'})
                self.assertNotIn('declared', self.edge(model, other, 'run/out.md'))
                self.assertEqual(next(n for n in model['nodes'] if n['id'] == str(root / 'run/out.md'))['status'], 'missing')
                self.assertEqual([(i['node'], i['target']) for i in self.codes(model, 'broken')], [(other, 'run/out.md')])
                self.assertEqual(model['scope']['patterns'][0]['references'], 1)

    def test_ambiguous_reference_is_never_absorbed(self):
        self.write('AGENTS.md', '`dup.md`\n')
        self.write('x/dup.md', '# One\n')
        self.write('y/dup.md', '# Two\n')
        model = scan([str(self.root)], {'version': 1, 'runtimeWorkspace': ['**/dup.md']})
        self.assertEqual(len(self.codes(model, 'ambiguous')), 1)
        self.assertEqual(model['scope']['patterns'][0]['references'], 0)
        self.assertEqual(model['scope']['patterns'][0]['files'], 2)

    def test_dead_patterns_are_reported(self):
        self.write('AGENTS.md', '# Entry\n')
        model = scan([str(self.root)], {'version': 1, 'runtimeWorkspace': ['nada/'], 'entries': ['.claude/agents/*.md']})
        dead = self.codes(model, 'scope-unused-pattern')
        self.assertEqual([(i['node'], i['pattern'], i['scopeKind']) for i in dead], [(str(self.root), 'nada/', 'runtimeWorkspace'), (str(self.root), '.claude/agents/*.md', 'entries')])
        self.assertTrue(all('without effect' in i['message'] for i in dead))

    def test_flag_replaces_embedded_scope_and_invalid_embedded_is_ignored(self):
        self.write('AGENTS.md', '`a/x.md`\n`b/x.md`\n')
        manifest = self.write('agent-architecture.json', json.dumps({'scope': {'version': 1, 'runtimeWorkspace': ['a/']}}))
        embedded = scan([str(self.root)])
        self.assertEqual(embedded['scope'], {'source': 'manifest', 'patterns': [{'kind': 'runtimeWorkspace', 'pattern': 'a/', 'references': 1, 'files': 0, 'root': str(self.root)}]})
        self.assertEqual([i['target'] for i in self.codes(embedded, 'broken')], ['b/x.md'])
        flagged = scan([str(self.root)], {'version': 1, 'runtimeWorkspace': ['b/']})
        self.assertEqual(flagged['scope']['source'], 'flag')
        self.assertEqual([p['pattern'] for p in flagged['scope']['patterns']], ['b/'])
        self.assertEqual([i['target'] for i in self.codes(flagged, 'broken')], ['a/x.md'])
        Path(manifest).write_text(json.dumps({'scope': {'version': 1, 'runtimeWorkspace': '/a'}}))
        invalid = scan([str(self.root)])
        self.assertEqual(invalid['scope'], {'source': None, 'patterns': []})
        self.assertEqual([i['node'] for i in self.codes(invalid, 'manifest')], [manifest])
        self.assertEqual(len(self.codes(invalid, 'broken')), 2)
        # A nested manifest is not the root's declaration.
        Path(manifest).unlink()
        self.write('sub/agent-architecture.json', json.dumps({'scope': {'version': 1, 'runtimeWorkspace': ['a/']}}))
        self.assertIsNone(scan([str(self.root)])['scope']['source'])

    def test_manifest_relationship_type_must_be_text(self):
        self.write('AGENTS.md', '# Entry\n')
        for name in ('a.md', 'b.md', 'c.md'):
            self.write(name, f'# {name}\n')
        entry, a, b = (str(self.root / name) for name in ('AGENTS.md', 'a.md', 'b.md'))
        for invalid in (5, {'x': 1}, ['reads'], None, True):
            with self.subTest(type=invalid):
                manifest = self.write('agent-architecture.json', json.dumps({'version': 1, 'relationships': [
                    {'source': 'AGENTS.md', 'target': 'a.md'},
                    {'source': 'AGENTS.md', 'target': 'b.md', 'type': 'reads'},
                    {'source': 'AGENTS.md', 'target': 'c.md', 'type': invalid},
                    {'source': 'a.md', 'target': 'b.md', 'type': 'after'}]}))
                model = scan([str(self.root)])
                issues = self.codes(model, 'manifest')
                self.assertEqual([(i['node'], i['message']) for i in issues],
                                 [(manifest, 'Invalid manifest: Relationship with an invalid type: it must be text.')])
                # Existing policy for an invalid relationship: the ones before it are kept,
                # processing stops there (the later valid a.md -> b.md is not declared).
                declared = [(e['source'], e['target'], e['raw']) for e in model['edges'] if e['kind'] == 'declared']
                self.assertEqual(declared, [(entry, a, 'references'), (entry, b, 'reads')])
                self.assertTrue(all(isinstance(e['raw'], str) for e in model['edges']))
                json.dumps(model)

    def test_interface_lists_the_analysed_extensions_of_the_scanner(self):
        import re
        import scanner
        source = (Path(__file__).resolve().parents[1] / 'src' / 'types.ts').read_text(encoding='utf-8')
        listed = re.search(r'analyzedExtensions = \[([^\]]*)\]', source)[1]
        self.assertEqual(sorted(re.findall(r"'([^']+)'", listed)), sorted(scanner.TEXT))

    def test_flag_scope_counts_sum_across_roots(self):
        other = self.base / 'other'
        other.mkdir()
        self.write('AGENTS.md', '`run/a.md`\n')
        self.write('AGENTS.md', '`run/b.md`\n', other)
        self.write('run/kept.md', '# Present in runtime area\n', other)
        model = scan([str(self.root), str(other)], {'version': 1, 'runtimeWorkspace': ['run/']})
        self.assertEqual(model['scope']['patterns'], [{'kind': 'runtimeWorkspace', 'pattern': 'run/', 'references': 2, 'files': 1}])
        self.assertFalse(self.codes(model, 'broken'))
        self.assertFalse(self.codes(model, 'unreachable'))
        self.assertEqual(model['stats']['reachability']['exempt'], 1)

    def test_reachability_orphan_island_ancestor_exemption_and_hops(self):
        entry = self.write('AGENTS.md', '[Index](docs/index.md)\n[Folder](refs/)\n')
        index = self.write('docs/index.md', '[Leaf](leaf.md)\n')
        leaf = self.write('docs/leaf.md', '[Self](leaf.md)\n')
        orphan = self.write('refs/deep/orphan.md', '[Island](island.md)\n[Self](orphan.md)\n')
        island = self.write('refs/deep/island.md', '# Only cited by an orphan\n')
        self.write('runtime/log.md', '# Runtime area\n')
        self.write('config.json', '{}')
        model = scan([str(self.root)], {'version': 1, 'runtimeWorkspace': ['runtime/']})
        nodes = {n['id']: n for n in model['nodes']}
        self.assertEqual([nodes[n]['hops'] for n in (entry, index, leaf)], [0, 1, 2])
        self.assertEqual(nodes[str(self.root / 'refs')]['hops'], 1)
        self.assertNotIn('hops', nodes[orphan])
        issues = {i['node']: i for i in self.codes(model, 'unreachable')}
        self.assertEqual(set(issues), {orphan, island})
        self.assertEqual((issues[orphan]['class'], issues[orphan]['inbound'], issues[orphan]['line']), ('orphan', 0, None))
        self.assertEqual((issues[island]['class'], issues[island]['inbound']), ('island', 1))
        self.assertEqual(issues[orphan]['referencedAncestor'], str(self.root / 'refs'))
        self.assertNotEqual(issues[orphan]['message'], issues[island]['message'])
        for item in issues.values():
            self.assertIn('No path by explicit reference', item['message'])
            self.assertNotIn('inaccess', item['message'])
        self.assertEqual(model['stats']['reachability'], {
            'starts': [{'node': entry, 'source': 'convention'}], 'documents': 5, 'reachable': 3, 'unreachable': 2,
            'orphans': 1, 'islands': 1, 'exempt': 1, 'hops': {'max': 2, 'median': 1}})
        # Without the directory reference there is no referenced ancestor.
        self.write('AGENTS.md', '[Index](docs/index.md)\n')
        issue = next(i for i in self.codes(scan([str(self.root)]), 'unreachable') if i['node'] == orphan)
        self.assertNotIn('referencedAncestor', issue)

    def test_declared_entries_and_implicit_loads_start_reachability(self):
        agent = self.write('.claude/agents/reviewer.md', '[Guide](../../guides/review.md)\n')
        guide = self.write('guides/review.md', '# Guide\n')
        skill = self.write('skills/x/SKILL.md', '[Ref](references/a.md)\n')
        ref = self.write('skills/x/references/a.md', '# Ref\n')
        model = scan([str(self.root)])
        self.assertIsNone(model['stats']['reachability'])
        self.assertFalse(self.codes(model, 'unreachable'))
        self.assertTrue(self.codes(model, 'no-entry'))
        model = scan([str(self.root)], {'version': 1, 'entries': ['.claude/agents/*.md'], 'implicitLoads': ['**/SKILL.md']})
        self.assertEqual(model['stats']['reachability']['starts'], [{'node': agent, 'source': 'declared-entry'}, {'node': skill, 'source': 'implicit-load'}])
        self.assertFalse(self.codes(model, 'unreachable'))
        nodes = {n['id']: n for n in model['nodes']}
        self.assertEqual([nodes[n]['hops'] for n in (agent, guide, skill, ref)], [0, 1, 0, 1])
        self.assertEqual([p['files'] for p in model['scope']['patterns']], [1, 1])

    def test_bytes_match_raw_size_including_limit_skipped_documents(self):
        self.write('AGENTS.md', '# Entry\n[Big](big.md)\n')
        crlf = self.root / 'crlf.md'
        crlf.write_bytes(b'# Title\r\nline\r\n')
        big = self.write('big.md', 'x' * 64)
        self.write('image.png', 'not text')
        with patch('scanner.MAX_BYTES', 32):
            model = scan([str(self.root)])
        nodes = {n['id']: n for n in model['nodes']}
        self.assertEqual(nodes[str(crlf)]['bytes'], len(b'# Title\r\nline\r\n'))
        self.assertEqual(nodes[str(self.root / 'AGENTS.md')]['bytes'], os.path.getsize(self.root / 'AGENTS.md'))
        self.assertEqual((nodes[big]['analysis'], nodes[big]['bytes']), ('skipped', 64))
        self.assertNotIn('bytes', nodes[str(self.root / 'image.png')])

    def test_nested_roots_still_deduplicate_with_new_fields(self):
        self.write('AGENTS.md', '[Child](team/AGENTS.md)\n')
        child = self.write('team/AGENTS.md', '`notes.md`\n')
        notes = self.write('team/sub/notes.md', '# Notes\n')
        for roots in ([self.root, self.root / 'team'], [self.root / 'team', self.root]):
            with self.subTest(roots=roots):
                model = scan([str(p) for p in roots])
                ids = [n['id'] for n in model['nodes']]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual((self.edge(model, child, 'notes.md')['target'], self.edge(model, child, 'notes.md')['resolvedBy']), (notes, 'basename'))
                self.assertFalse(model['issues'])
                self.assertEqual(model['stats']['reachability']['documents'], 3)


if __name__ == '__main__':
    unittest.main()
