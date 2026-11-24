"""Audit report v2, stable finding identity and compare-audit, on disposable trees only."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import audit, cli, suite_contract

FILES = {
    'AGENTS.md': '# Entrada\n[Guia](docs/guia.md)\n[Ausente](docs/ausente.md)\n`politica.md`\n`dup.md`\n[Trabalho](drafts/memo.md)\n',
    'docs/guia.md': '# Guia\nPasso único.\n[Política](../regras/politica.md)\n',
    'regras/politica.md': '# Política\nResponder em português.\nCitar a origem.\n',
    'x/dup.md': '# Cópia X\n',
    'y/dup.md': '# Cópia Y\n',
    'orfao.md': '# Órfão\n',
}


class AuditReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-audit-v2-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.root = self.make('agent', FILES)

    def make(self, name, files):
        root = self.folder / name
        for path, text in files.items():
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_text(text, encoding='utf-8')
        return root

    def save(self, name, value):
        path = self.folder / name
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        return str(path)

    def invoke(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli.main([str(argument) for argument in arguments])
        return code, json.loads(output.getvalue())

    def audit(self, *arguments, root=None, code=None):
        result = self.invoke('audit', '--root', root or self.root, *arguments)
        if code is not None:
            self.assertEqual(result[0], code, result[1])
        return result[1]

    def by_code(self, report, code):
        return [finding for finding in report['findings'] if finding['code'] == code]

    def test_interface_lists_the_by_name_modes_of_the_audit(self):
        import re
        source = (Path(__file__).resolve().parents[1] / 'src' / 'AuditPanel.tsx').read_text(encoding='utf-8')
        listed = re.search(r'byNameModes = new Set\(\[([^\]]*)\]\)', source)[1]
        self.assertEqual(sorted(re.findall(r"'([^']+)'", listed)), sorted(audit.BY_NAME))

    def test_shape_relative_paths_and_no_duplicate_issue_list(self):
        report = self.audit(code=0)
        self.assertEqual((report['version'], report['kind'], report['status']), (2, 'audit', 'pass'))
        self.assertNotIn('issues', report)
        self.assertEqual(list(report)[:5], ['version', 'kind', 'status', 'roots', 'summary'])
        self.assertEqual(list(report)[-2:], ['paths', 'findings'])
        # The absolute root appears exactly once: roots[0].path.
        self.assertEqual(json.dumps(report, ensure_ascii=False).count(str(self.root)), 1)
        self.assertEqual(report['roots'], [{'path': str(self.root), 'name': 'agent', 'parent': None, 'level': 0, 'entries': ['AGENTS.md']}])
        self.assertFalse(any(finding['code'].startswith('scanner-') or 'root' in finding for finding in report['findings']))
        broken = self.by_code(report, 'broken')
        self.assertEqual([(f['path'], f['line'], f['target'], f['severity']) for f in broken],
                         [('AGENTS.md', 3, 'docs/ausente.md', 'warning'), ('AGENTS.md', 6, 'drafts/memo.md', 'warning')])
        ambiguous = self.by_code(report, 'ambiguous')[0]
        self.assertEqual(ambiguous['candidates'], ['x/dup.md', 'y/dup.md'])
        # Written as a bare name, the ambiguity is info (a warning only when written with a folder).
        self.assertEqual((ambiguous['form'], ambiguous['severity']), ('name', 'info'))
        resolved = self.by_code(report, 'basename-resolved')[0]
        self.assertEqual((resolved['severity'], resolved['target'], resolved['resolvedTo']), ('info', 'politica.md', 'regras/politica.md'))
        self.assertEqual({(f['path'], f['class']) for f in self.by_code(report, 'unreachable')},
                         {('orfao.md', 'orphan'), ('x/dup.md', 'orphan'), ('y/dup.md', 'orphan')})
        self.assertEqual([f['severity'] for f in report['findings']], sorted((f['severity'] for f in report['findings']), key=audit.SEVERITY_RANK.get))
        self.assertTrue(all(list(f)[:4] == ['id', 'code', 'severity', 'message'] for f in report['findings']))
        summary = report['summary']
        self.assertEqual(summary['bySeverity'], {'error': 0, 'incomplete': 0, 'warning': 2, 'info': 5})
        self.assertEqual(summary['byCode']['unreachable'], 3)
        # Info findings (the bare-name ambiguity included) are counted in byCode but never concentrate sources or targets.
        self.assertEqual(summary['topSources'], [{'path': 'AGENTS.md', 'count': 2, 'byCode': {'broken': 2}}])
        self.assertEqual({t['target'] for t in summary['topTargets']}, {'docs/ausente.md', 'drafts/memo.md'})
        self.assertEqual(report['metrics']['structure']['maxFanout'], {'path': 'AGENTS.md', 'count': 4})
        self.assertEqual(report['metrics']['reachability']['starts'], [{'path': 'AGENTS.md', 'source': 'convention'}])

    def test_ids_are_stable_across_copies_and_line_insertions(self):
        original = self.audit()
        copy_root = self.folder / 'elsewhere' / 'nested' / 'copy'
        shutil.copytree(self.root, copy_root)
        copied = self.audit(root=copy_root)
        self.assertEqual([f['id'] for f in original['findings']], [f['id'] for f in copied['findings']])
        self.assertEqual(len({f['id'] for f in original['findings']}), len(original['findings']))
        entry = copy_root / 'AGENTS.md'
        entry.write_text('<!-- linha nova no topo -->\n' + entry.read_text(encoding='utf-8'), encoding='utf-8')
        shifted = self.audit(root=copy_root)
        self.assertEqual({f['id'] for f in shifted['findings']}, {f['id'] for f in original['findings']})
        self.assertEqual([f['line'] for f in self.by_code(shifted, 'broken')], [4, 7])
        # Two references to the same missing target keep distinct ordinals, in line order.
        entry.write_text(entry.read_text(encoding='utf-8') + '[De novo](docs/ausente.md)\n', encoding='utf-8')
        twice = self.audit(root=copy_root)
        ids = [f['id'] for f in self.by_code(twice, 'broken') if f['target'] == 'docs/ausente.md']
        self.assertEqual(len(set(ids)), 2)
        self.assertIn(ids[0], {f['id'] for f in original['findings']})

    def test_summary_code_source_and_top_views(self):
        full = self.audit()
        summary = self.audit('--summary')
        self.assertNotIn('findings', summary)
        self.assertNotIn('paths', summary)
        self.assertEqual(summary['findingsOmitted'], len(full['findings']))
        self.assertEqual(summary['summary'], full['summary'])
        self.assertLess(len(json.dumps(summary)), len(json.dumps(full)))
        filtered = self.audit('--code', 'broken,ambiguous', '--code', 'broken')
        self.assertEqual({f['code'] for f in filtered['findings']}, {'broken', 'ambiguous'})
        self.assertEqual(filtered['filter'], {'codes': ['broken', 'ambiguous'], 'sources': [], 'matched': 3})
        self.assertEqual(filtered['summary'], full['summary'])
        sourced = self.audit('--source', 'x/**', '--source', '*.md')
        self.assertEqual({f['path'] for f in sourced['findings']}, {'AGENTS.md', 'orfao.md', 'x/dup.md'})
        both = self.audit('--code', 'unreachable', '--source', '*.md', '--summary')
        self.assertEqual((both['filter']['matched'], both['findingsOmitted']), (1, 1))
        self.assertEqual(len(self.audit('--top', '1')['summary']['topTargets']), 1)
        for bad in (['--top', '0'], ['--top', '101'], ['--code', 'scanner-broken'], ['--source', '/abs'], ['--source', 'a/../b'], ['--fail-on', 'nada']):
            with self.subTest(bad=bad):
                code, error = self.invoke('audit', '--root', self.root, *bad)
                self.assertEqual((code, error['status']), (2, 'error'))
        _, error = self.invoke('audit', '--root', self.root, '--code', 'brokn')
        self.assertIn('broken', error['findings'][0]['message'])

    def test_fail_on_gate_uses_the_whole_set_and_info_never_changes_status(self):
        self.assertEqual(self.audit('--fail-on', 'broken', code=1)['gate'], {'failOn': ['broken'], 'matched': {'broken': 2}})
        report = self.audit('--fail-on', 'any', code=1)
        # The bare-name ambiguity is info in an absolute audit: `any` leaves it out, an explicit code does not.
        self.assertEqual(report['gate']['matched'], {'broken': 2})
        self.assertEqual(self.audit('--fail-on', 'ambiguous', code=1)['gate']['matched'], {'ambiguous': 1})
        # Combining any with an explicit code never counts a finding twice.
        self.assertEqual(self.audit('--fail-on', 'broken,any', code=1)['gate']['matched'], {'broken': 2})
        # The filter narrows the list, never the gate.
        filtered = self.audit('--code', 'unreachable', '--fail-on', 'broken', code=1)
        self.assertEqual({f['code'] for f in filtered['findings']}, {'unreachable'})
        self.assertEqual(filtered['status'], 'fail')
        self.assertEqual(self.audit('--fail-on', 'hop-budget-exceeded', code=0)['gate']['matched'], {'hop-budget-exceeded': 0})
        clean = self.make('clean', {'AGENTS.md': '# Entrada\n`politica.md`\n', 'regras/politica.md': '# P\n', 'solto.md': '# Solto\n'})
        info_only = self.audit(root=clean, code=0)
        self.assertEqual(info_only['summary']['bySeverity'], {'error': 0, 'incomplete': 0, 'warning': 0, 'info': 2})
        self.assertEqual(self.audit('--fail-on', 'any', root=clean, code=0)['gate']['matched'], {})
        self.assertEqual(self.audit('--fail-on', 'unreachable', root=clean, code=1)['gate']['matched'], {'unreachable': 1})

    def test_scope_flag_absorbs_counts_and_reports_dead_patterns(self):
        scope = {'version': 1, 'runtimeWorkspace': ['drafts/'], 'localFiles': ['config/*.local.json'], 'entries': ['orfao.md']}
        report = self.audit('--scope', self.save('scope.json', scope), code=0)
        self.assertEqual([f['target'] for f in self.by_code(report, 'broken')], ['docs/ausente.md'])
        declared = self.by_code(report, 'declared-external')
        self.assertEqual([(f['severity'], f['path'], f['line'], f['target'], f['scopeKind'], f['pattern']) for f in declared],
                         [('info', 'AGENTS.md', 6, 'drafts/memo.md', 'runtimeWorkspace', 'drafts/')])
        self.assertEqual(report['scope'], {'source': 'flag', 'patterns': [
            {'kind': 'runtimeWorkspace', 'pattern': 'drafts/', 'references': 1, 'files': 0},
            {'kind': 'localFiles', 'pattern': 'config/*.local.json', 'references': 0, 'files': 0},
            {'kind': 'entries', 'pattern': 'orfao.md', 'references': 0, 'files': 1}]})
        dead = self.by_code(report, 'scope-unused-pattern')
        self.assertEqual([(f['path'], f['pattern'], f['scopeKind'], f['severity']) for f in dead], [('.', 'config/*.local.json', 'localFiles', 'warning')])
        self.assertNotIn('orfao.md', {f['path'] for f in self.by_code(report, 'unreachable')})
        self.assertIn({'path': 'orfao.md', 'source': 'declared-entry'}, report['metrics']['reachability']['starts'])
        self.assertEqual(report['scopeHash'], suite_contract._hash({'source': 'flag', 'declaration': evaluation_scope(scope)}))
        self.assertIsNone(self.audit()['scopeHash'])
        for invalid in ({'version': 2}, {'version': 1, 'runtimeWorkspace': ['/abs/']}, {'version': 1, 'extra': []}):
            with self.subTest(invalid=invalid):
                self.audit('--scope', self.save('invalid.json', invalid), code=2)

    def test_embedded_scope_and_referenced_ancestor_are_relative(self):
        root = self.make('embutido', {
            'AGENTS.md': '# Entrada\n[Pasta](refs/)\n`run/x.md`\n',
            'refs/a.md': '# Sem link direto\n',
            'agent-architecture.json': json.dumps({'scope': {'version': 1, 'runtimeWorkspace': ['run/'], 'entries': ['nada/*.md']}}),
        })
        report = self.audit(root=root, code=0)
        self.assertEqual(report['scope'], {'source': 'manifest', 'patterns': [
            {'kind': 'runtimeWorkspace', 'pattern': 'run/', 'references': 1, 'files': 0},
            {'kind': 'entries', 'pattern': 'nada/*.md', 'references': 0, 'files': 0}]})
        # The embedded declaration is the effective scope: hashed by root index, never by absolute path.
        embedded = {'version': 1, 'runtimeWorkspace': ['run/'], 'localFiles': [], 'entries': ['nada/*.md'], 'implicitLoads': []}
        self.assertEqual(report['scopeHash'], suite_contract._hash({'source': 'manifest', 'roots': [[0, embedded]]}))
        dead = self.by_code(report, 'scope-unused-pattern')
        self.assertEqual([(f['path'], f['pattern']) for f in dead], [('agent-architecture.json', 'nada/*.md')])
        unreachable = self.by_code(report, 'unreachable')
        self.assertEqual([(f['path'], f['class'], f['referencedAncestor']) for f in unreachable], [('refs/a.md', 'orphan', 'refs')])
        self.assertEqual(json.dumps(report, ensure_ascii=False).count(str(root)), 1)

    def test_trailing_slash_scope_absorbs_the_directory_reference_itself(self):
        root = self.make('dirs', {'AGENTS.md': '# Entrada\n[Pasta](drafts/)\n[Sem barra](drafts)\n[Arquivo](drafts/a.md)\n'})
        report = self.audit('--scope', self.save('dir-scope.json', {'version': 1, 'runtimeWorkspace': ['drafts/']}), root=root, code=0)
        self.assertFalse(self.by_code(report, 'broken'))
        self.assertEqual([f['line'] for f in self.by_code(report, 'declared-external')], [2, 3, 4])
        self.assertEqual(report['scope']['patterns'][0]['references'], 3)

    def test_mass_matches_file_sizes(self):
        nested = self.root / 'sub' / 'CLAUDE.md'
        nested.parent.mkdir()
        nested.write_text('# Entrada aninhada, fora da soma do sempre-carregado\n', encoding='utf-8')
        report = self.audit()
        mass = report['metrics']['mass']
        size = lambda relative: os.path.getsize(self.root / relative)
        self.assertEqual(mass['entries'], [{'path': 'AGENTS.md', 'bytes': size('AGENTS.md'), 'source': 'convention'},
                                           {'path': 'sub/CLAUDE.md', 'bytes': size('sub/CLAUDE.md'), 'source': 'convention'}])
        self.assertEqual(mass['alwaysLoaded'], {'bytes': size('AGENTS.md'), 'basis': 'root-level-entries', 'files': [{'path': 'AGENTS.md', 'bytes': size('AGENTS.md'), 'source': 'convention'}]})
        self.assertEqual(mass['reachableByHops'], [{'hops': 0, 'files': 2, 'bytes': size('AGENTS.md') + size('sub/CLAUDE.md')},
                                                   {'hops': 1, 'files': 2, 'bytes': size('docs/guia.md') + size('regras/politica.md')}])
        self.assertEqual(mass['documentsBytes'], sum(size(path) for path in [*FILES, 'sub/CLAUDE.md']))

    def suite(self, **scenario):
        return {'version': 1, 'entry': 'AGENTS.md', 'scenarios': [
            {'id': 'normal', 'required': [{'path': 'regras/politica.md', 'startLine': 2, 'endLine': 3}], **scenario}]}

    def test_suite_findings_paths_and_content_identity_in_audit(self):
        suite_file = self.save('suite.json', self.suite(maxHops=2))
        report = self.audit('--suite', suite_file, code=0)
        self.assertEqual([f['scenarioId'] for f in self.by_code(report, 'requirement-unbound')], ['normal'])
        self.assertEqual(report['suiteHash'], suite_contract._hash(suite_contract.validate_suite(self.suite(maxHops=2))))
        self.assertIsNone(report['contractHash'])
        path = report['paths'][0]
        self.assertEqual((path['scenarioId'], path['found'], path['hops'], path['stepsComplete']), ('normal', True, 1, True))
        self.assertEqual(path['steps'], [{'source': 'AGENTS.md', 'line': 4, 'kind': 'path', 'raw': 'politica.md', 'evidence': '`politica.md`',
                                          'target': 'regras/politica.md', 'resolvedBy': 'basename', 'origin': 'AGENTS.md'}])
        # Budgets of the always-loaded entry and hops fail with numbers.
        size = os.path.getsize(self.root / 'AGENTS.md')
        failed = self.audit('--suite', self.save('budget.json', self.suite(maxHops=0, maxAlwaysLoadedBytes=size - 1)), code=1)
        exceeded = self.by_code(failed, 'always-loaded-budget-exceeded')[0]
        self.assertEqual((exceeded['severity'], exceeded['path'], exceeded['actual'], exceeded['maximum']), ('error', 'AGENTS.md', size, size - 1))
        self.assertEqual(self.by_code(failed, 'hop-budget-exceeded')[0]['actual'], 1)
        self.assertEqual(failed['metrics']['mass']['alwaysLoaded']['basis'], 'suite-entry')
        # A frozen suite detects a shifted excerpt and names the new range.
        code, frozen = self.invoke('freeze', '--root', self.root, '--suite', suite_file)
        self.assertEqual(code, 0)
        frozen_file = self.save('frozen.json', frozen)
        self.assertEqual(self.audit('--suite', frozen_file, code=0)['contractHash'], frozen['contractHash'])
        policy = self.root / 'regras/politica.md'
        policy.write_text('<!-- revisado -->\n' + policy.read_text(encoding='utf-8'), encoding='utf-8')
        stale = self.audit('--suite', frozen_file, code=3)
        finding = self.by_code(stale, 'requirement-stale')[0]
        self.assertEqual((finding['scenarioId'], finding['path'], finding['startLine'], finding['endLine'], finding['relocated']),
                         ('normal', 'regras/politica.md', 2, 3, [{'path': 'regras/politica.md', 'startLine': 3, 'endLine': 4}]))

    def test_missing_requirement_is_one_finding_and_snapshot_failure_degrades(self):
        suite = self.suite()
        suite['scenarios'][0]['required'].append({'path': 'nada.md', 'startLine': 1, 'endLine': 1})
        suite['scenarios'][0]['required'].append({'path': 'docs/guia.md', 'startLine': 1, 'endLine': 9})
        report = self.audit('--suite', self.save('missing.json', suite), code=1)
        missing = [f for f in report['findings'] if f.get('path') == 'nada.md']
        self.assertEqual([(f['code'], f['severity'], f['available']) for f in missing], [('required-unreachable', 'error', False)])
        short = [f for f in report['findings'] if f.get('path') == 'docs/guia.md']
        self.assertEqual([(f['code'], f['severity']) for f in short], [('requirement-unavailable', 'incomplete')])
        # An entry the snapshot cannot hold (above 256 KiB) never aborts the structural audit.
        entry = self.root / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8') + ('x' * 100 + '\n') * 2700, encoding='utf-8')
        degraded = self.audit('--suite', self.save('suite.json', self.suite()), code=3)
        unavailable = self.by_code(degraded, 'suite-snapshot-unavailable')
        self.assertEqual((len(unavailable), unavailable[0]['severity']), (1, 'incomplete'))
        self.assertTrue(degraded['paths'][0]['found'])
        self.assertEqual(len(self.by_code(degraded, 'broken')), 2)
        # A missing entry is reported once, by the structural check.
        absent = self.audit('--suite', self.save('absent.json', {**self.suite(), 'entry': 'NAO.md'}), code=1)
        self.assertEqual([(f['code'], f['path']) for f in absent['findings'] if f['code'] in {'entry-unavailable', 'suite-snapshot-unavailable'}],
                         [('entry-unavailable', 'NAO.md')])

    def test_multiple_roots_use_indexes_and_relative_messages(self):
        empty = self.make('vazio', {'nota.md': '# Nota\n'})
        child = self.root / 'docs'
        report = self.audit('--root', empty, '--root', child, '--suite', self.save('suite.json', self.suite()))
        self.assertEqual([(r['name'], r['parent'], r['level']) for r in report['roots']], [('agent', None, 0), ('vazio', None, 0), ('docs', 0, 1)])
        text = json.dumps({key: value for key, value in report.items() if key != 'roots'}, ensure_ascii=False)
        for root in (self.root, empty, child):
            self.assertNotIn(str(root), text)
        no_entry = [f for f in report['findings'] if f['code'] == 'no-entry']
        self.assertEqual({(f['root'], f['path']) for f in no_entry}, {(1, '.'), (2, '.')})
        self.assertEqual({f['message'] for f in no_entry}, {'No AGENTS.md or CLAUDE.md in vazio.', 'No AGENTS.md or CLAUDE.md in docs.'})
        guide = [f for f in report['findings'] if f.get('target') == '../regras/politica.md']
        self.assertFalse(guide)
        self.assertEqual({p['root'] for p in report['paths']}, {0, 1, 2})
        self.assertTrue(all('root' in f for f in report['findings'] if 'path' in f))
        self.assertEqual(self.audit('--root', empty)['roots'][0]['parent'], None)

    def test_compare_audit_new_resolved_persisting_gate_and_identical_copy(self):
        before_file = self.save('before.json', self.audit())
        clone = self.folder / 'clone'
        shutil.copytree(self.root, clone)
        code, same = self.invoke('compare-audit', '--before', before_file, '--after', self.save('clone.json', self.audit(root=clone)))
        self.assertEqual((code, same['status'], same['new'], same['resolved'], same['findings']), (0, 'pass', [], [], []))
        self.assertEqual(same['persisting'], len(json.loads(Path(before_file).read_text())['findings']))
        entry = clone / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8').replace('[Ausente](docs/ausente.md)\n', '[Novo](docs/novo.md)\n'), encoding='utf-8')
        after_file = self.save('after.json', self.audit(root=clone))
        code, delta = self.invoke('compare-audit', '--before', before_file, '--after', after_file)
        self.assertEqual((code, delta['kind'], delta['version']), (0, 'audit-comparison', 1))
        self.assertEqual([(f['code'], f['target']) for f in delta['new']], [('broken', 'docs/novo.md')])
        self.assertEqual([(f['code'], f['target']) for f in delta['resolved']], [('broken', 'docs/ausente.md')])
        self.assertEqual(delta['byCode']['broken'], {'new': 1, 'resolved': 1, 'persisting': 1})
        code, gated = self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'broken')
        self.assertEqual((code, gated['gate']), (1, {'failOn': ['broken'], 'matched': {'broken': 1}}))
        self.assertEqual(self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'any')[0], 1)
        self.assertEqual(self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'unreachable')[0], 0)
        self.assertEqual(self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'nada')[0], 2)

    def test_compare_audit_context_partial_and_refusals(self):
        before = self.audit()
        before_file = self.save('before.json', before)
        scoped = self.audit('--scope', self.save('scope.json', {'version': 1, 'runtimeWorkspace': ['drafts/']}))
        code, context = self.invoke('compare-audit', '--before', before_file, '--after', self.save('scoped.json', scoped))
        self.assertEqual(code, 0)
        self.assertEqual([(f['code'], f['severity'], f['differs']) for f in context['findings']], [('audit-context-differs', 'warning', ['scopeHash'])])
        self.assertEqual([(f['code'], f['target']) for f in context['resolved']], [('broken', 'drafts/memo.md')])
        self.assertEqual([f['code'] for f in context['new']], ['declared-external'])
        filtered_file = self.save('filtered.json', self.audit('--code', 'broken'))
        self.assertEqual(self.invoke('compare-audit', '--before', filtered_file, '--after', filtered_file)[0], 0)
        (self.root / 'grande.md').write_bytes(b'x' * (1024 * 1024 + 1))
        partial = self.audit(code=3)
        code, incomplete = self.invoke('compare-audit', '--before', before_file, '--after', self.save('partial.json', partial))
        self.assertEqual((code, incomplete['status']), (3, 'inconclusive'))
        self.assertEqual([(f['code'], f['sides']) for f in incomplete['findings']], [('comparison-incomplete', ['after'])])
        code, gated = self.invoke('compare-audit', '--before', before_file, '--after', self.save('partial.json', partial), '--fail-on', 'limit')
        self.assertEqual((code, gated['status']), (1, 'fail'))
        refused = {
            'summary': self.audit('--summary'),
            'v1': {**before, 'version': 1},
            'other-kind': {**before, 'kind': 'evaluation'},
            'bad-id': {**before, 'findings': [{**before['findings'][0], 'id': 'X'}]},
            'duplicate-id': {**before, 'findings': before['findings'][:1] * 2},
            'roots': {**before, 'roots': before['roots'] * 2},
            'filtered': self.audit('--code', 'broken'),
        }
        for label, report in refused.items():
            with self.subTest(label=label):
                code, error = self.invoke('compare-audit', '--before', before_file, '--after', self.save('refused.json', report))
                self.assertEqual((code, error['status']), (2, 'error'))
        # compare is not a command of this CLI: the error lists compare-audit among the valid ones.
        code, error = self.invoke('compare', '--before', before_file, '--after', before_file)
        self.assertEqual(code, 2)
        self.assertIn('compare-audit', error['findings'][0]['message'])

    def test_compare_audit_treats_a_relocated_suite_of_the_same_contract_as_the_same_context(self):
        code, frozen = self.invoke('freeze', '--root', self.root, '--suite', self.save('suite.json', self.suite()))
        self.assertEqual(code, 0)
        frozen_file = self.save('frozen.json', frozen)
        before_file = self.save('before.json', self.audit('--suite', frozen_file, code=0))
        policy = self.root / 'regras/politica.md'
        policy.write_text('<!-- revisado -->\n' + policy.read_text(encoding='utf-8'), encoding='utf-8')
        code, relocated = self.invoke('freeze', '--root', self.root, '--suite', frozen_file, '--relocate')
        self.assertEqual((code, relocated['contractHash']), (0, frozen['contractHash']))
        self.assertNotEqual(relocated['suiteHash'], frozen['suiteHash'])
        after_file = self.save('after.json', self.audit('--suite', self.save('relocated.json', relocated), code=0))
        code, delta = self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'any')
        self.assertEqual((code, delta['findings']), (0, []))
        # Rebinding changes the oracle itself, so the context does differ.
        policy.write_text(policy.read_text(encoding='utf-8').replace('Citar a origem.', 'Citar a fonte.'), encoding='utf-8')
        code, rebound = self.invoke('freeze', '--root', self.root, '--suite', self.save('relocated.json', relocated), '--rebind')
        self.assertEqual(code, 0)
        rebound_file = self.save('rebound-audit.json', self.audit('--suite', self.save('rebound.json', rebound), code=0))
        code, changed = self.invoke('compare-audit', '--before', before_file, '--after', rebound_file)
        self.assertEqual((code, [f['differs'] for f in changed['findings']]), (0, [['suiteHash', 'contractHash']]))

    def test_compare_audit_reports_hop_changes_per_requirement(self):
        suite_file = self.save('suite.json', self.suite())
        before_file = self.save('before.json', self.audit('--suite', suite_file))
        entry = self.root / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8').replace('`politica.md`\n', ''), encoding='utf-8')
        after = self.audit('--suite', suite_file)
        code, delta = self.invoke('compare-audit', '--before', before_file, '--after', self.save('after.json', after))
        self.assertEqual(code, 0)
        self.assertEqual(delta['hops'], [{'scenarioId': 'normal', 'requirement': {'path': 'regras/politica.md', 'startLine': 2, 'endLine': 3}, 'before': 1, 'after': 2}])
        self.assertEqual(self.invoke('compare-audit', '--before', before_file, '--after', before_file)[1]['hops'], [])

    def test_effective_scope_change_is_flagged_and_gateable_in_the_delta(self):
        # Regression: an embedded catch-all scope written by a builder "resolved" every
        # broken/unreachable finding and compare-audit --fail-on any passed in silence.
        before_file = self.save('before.json', self.audit())
        dodge = self.folder / 'dodge'
        shutil.copytree(self.root, dodge)
        (dodge / 'agent-architecture.json').write_text(json.dumps({'scope': {'version': 1, 'runtimeWorkspace': ['**'], 'entries': ['**']}}), encoding='utf-8')
        after = self.audit(root=dodge, code=0)
        self.assertEqual(after['scope']['source'], 'manifest')
        self.assertIsNotNone(after['scopeHash'])
        after_file = self.save('dodge.json', after)
        code, delta = self.invoke('compare-audit', '--before', before_file, '--after', after_file)
        self.assertEqual((code, delta['status']), (0, 'pass'))
        context = delta['findings'][0]
        self.assertEqual((context['code'], context['severity'], context['differs'], context['scopeSource']),
                         ('audit-context-differs', 'warning', ['scopeHash'], {'before': None, 'after': 'manifest'}))
        self.assertIn('artifact of the scope declaration', context['message'])
        self.assertEqual({code for code, counts in delta['byCode'].items() if counts['resolved']}, {'broken', 'unreachable'})
        code, gated = self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'any')
        self.assertEqual((code, gated['status'], gated['gate']['matched']), (1, 'fail', {'audit-context-differs': 1}))
        code, explicit = self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'audit-context-differs')
        self.assertEqual((code, explicit['gate']), (1, {'failOn': ['audit-context-differs'], 'matched': {'audit-context-differs': 1}}))
        self.assertEqual(self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'broken')[0], 0)
        # The meta-finding code belongs to compare-audit only.
        code, error = self.invoke('audit', '--root', self.root, '--fail-on', 'audit-context-differs')
        self.assertEqual(code, 2)
        self.assertNotIn('audit-context-differs', error['findings'][0]['message'].split('Valid codes:')[1])
        _, error = self.invoke('compare-audit', '--before', before_file, '--after', after_file, '--fail-on', 'nada')
        self.assertIn('audit-context-differs', error['findings'][0]['message'].split('Valid codes:')[1])
        # Legitimate: the same embedded scope on both sides, in different directories.
        twin = self.folder / 'twin'
        shutil.copytree(dodge, twin)
        twin_report = self.audit(root=twin)
        self.assertEqual(twin_report['scopeHash'], after['scopeHash'])
        code, same = self.invoke('compare-audit', '--before', after_file, '--after', self.save('twin.json', twin_report), '--fail-on', 'any')
        self.assertEqual((code, same['status'], same['findings'], same['new'], same['resolved']), (0, 'pass', [], [], []))
        # Source is part of the effective scope; an empty declaration is still a declaration.
        flag = self.audit('--scope', self.save('same.json', {'version': 1, 'runtimeWorkspace': ['**'], 'entries': ['**']}))
        self.assertNotEqual(flag['scopeHash'], after['scopeHash'])
        (twin / 'agent-architecture.json').write_text(json.dumps({'scope': {'version': 1}}), encoding='utf-8')
        self.assertIsNotNone(self.audit(root=twin)['scopeHash'])
        self.assertIsNone(self.audit()['scopeHash'])

    def test_summary_caps_lists_that_grow_with_the_tree(self):
        files = {'AGENTS.md': '# Raiz\n[Elo](chain/c0000.md)\n',
                 'agent-architecture.json': json.dumps({'scope': {'version': 1, 'implicitLoads': [f'pkg{i:03d}/AGENTS.md' for i in range(30)]}})}
        files.update({f'pkg{i:03d}/AGENTS.md': f'# Pacote {i}\n' + 'x' * (i % 50) + '\n' for i in range(300)})
        files.update({f'chain/c{i:04d}.md': f'# Elo {i}\n' + (f'[n](c{i + 1:04d}.md)\n' if i < 1999 else '') for i in range(2000)})
        root = self.make('grande', files)
        full = self.audit(root=root)
        summary = self.audit('--summary', root=root, code=0)
        self.assertLessEqual(len(json.dumps(summary, ensure_ascii=False).encode('utf-8')), 20000)
        mass, reach = summary['metrics']['mass'], summary['metrics']['reachability']
        full_mass, full_reach = full['metrics']['mass'], full['metrics']['reachability']
        self.assertEqual((summary['roots'][0]['entriesTotal'], summary['roots'][0]['entries']), (301, full['roots'][0]['entries'][:10]))
        self.assertEqual((reach['startsTotal'], reach['starts']), (len(full_reach['starts']), full_reach['starts'][:10]))
        largest = sorted(full_mass['entries'], key=lambda item: -item['bytes'])[:10]
        self.assertEqual((mass['entriesTotal'], mass['entries']), (301, largest))
        self.assertEqual(mass['entries'][0], {'path': 'pkg149/AGENTS.md', 'bytes': len('# Pacote 149\n') + 49 + 1, 'source': 'convention'})
        self.assertEqual(reach['startsTotal'], 301)
        self.assertEqual((mass['reachableByHopsTotal'], mass['reachableByHops']), (len(full_mass['reachableByHops']), full_mass['reachableByHops'][:10]))
        self.assertEqual(mass['reachableByHopsTotal'], 2001)
        self.assertEqual((mass['alwaysLoaded']['filesTotal'], mass['alwaysLoaded']['bytes']), (1, full_mass['alwaysLoaded']['bytes']))
        self.assertEqual((summary['scope']['patternsTotal'], summary['scope']['patterns']), (30, full['scope']['patterns'][:10]))
        # Totals sit next to their list; other metrics and the detail mode are unchanged.
        self.assertEqual(list(mass)[:2], ['entries', 'entriesTotal'])
        self.assertEqual(summary['metrics']['mass']['documentsBytes'], full_mass['documentsBytes'])
        self.assertEqual(summary['summary'], full['summary'])
        text = json.dumps({key: value for key, value in full.items() if key not in {'findings', 'paths'}})
        self.assertNotIn('Total"', text)
        self.assertEqual(len(full['roots'][0]['entries']), 301)
        three = self.audit('--summary', '--top', '3', root=root)
        self.assertEqual([len(three['roots'][0]['entries']), len(three['metrics']['mass']['reachableByHops']), len(three['scope']['patterns'])], [3, 3, 3])

    def test_always_loaded_budget_uses_inventory_size_without_snapshot(self):
        entry = self.root / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8') + ('x' * 100 + '\n') * 2700, encoding='utf-8')
        size = os.path.getsize(entry)
        self.assertGreater(size, 256 * 1024)
        suite = self.suite(maxAlwaysLoadedBytes=4096)
        suite['scenarios'].append({'id': 'folga', 'required': [], 'maxAlwaysLoadedBytes': size})
        report = self.audit('--suite', self.save('suite.json', suite), code=1)
        exceeded = self.by_code(report, 'always-loaded-budget-exceeded')
        self.assertEqual([(f['severity'], f['path'], f['scenarioId'], f['actual'], f['maximum']) for f in exceeded],
                         [('error', 'AGENTS.md', 'normal', size, 4096)])
        self.assertEqual(len(self.by_code(report, 'suite-snapshot-unavailable')), 1)
        # Same id as the snapshot-measured finding, so compare-audit matches them.
        small = self.make('pequeno', {**FILES, 'AGENTS.md': FILES['AGENTS.md'] + 'x' * 5000 + '\n'})
        measured = self.by_code(self.audit('--suite', self.save('suite.json', suite), root=small, code=1), 'always-loaded-budget-exceeded')
        self.assertEqual([f['id'] for f in measured], [exceeded[0]['id']])
        self.assertFalse(self.by_code(self.audit('--suite', self.save('loose.json', self.suite(maxAlwaysLoadedBytes=size)), code=3), 'always-loaded-budget-exceeded'))

    def test_version_and_schema_teach_the_audit_flow(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            cli.main(['--version'])
        self.assertEqual(output.getvalue().strip(), 'aae 3 (CLI contract v3: audit v2, schema v2; other reports v1)')
        schema = cli.schema_contract()
        self.assertEqual((schema['reportVersions']['schema'], schema['reportVersions']['audit'], schema['reportVersions']['compare-audit'],
                          schema['reportVersions']['freeze']), (2, 2, 1, 1))
        self.assertEqual(set(schema['auditContract']['codes']), set(audit.CODES))
        self.assertEqual(set(schema['workflow']), {'audit', 'overhaul'})
        self.assertIn('--summary', schema['workflow']['audit'][0])
        self.assertIn('freeze', schema['workflow']['overhaul'][0])
        self.assertIn('compare-audit', ' '.join(schema['workflow']['overhaul']))
        evaluation_scope(schema['scopeContract']['example'])
        flags = {flag['flag']: flag for flag in schema['commands']['audit']}
        self.assertEqual(set(flags), {'--root', '--suite', '--scope', '--summary', '--code', '--source', '--top', '--fail-on'})
        self.assertFalse(flags['--summary']['takesValue'])
        self.assertTrue(flags['--fail-on']['repeatable'] and flags['--code']['repeatable'] and flags['--source']['repeatable'])
        self.assertEqual({flag['flag'] for flag in schema['commands']['compare-audit']}, {'--before', '--after', '--fail-on'})
        # The whole schema stays within one reply of an agent's tool (32,000 characters).
        self.assertLess(len(json.dumps(schema, ensure_ascii=False)), 32000)
        text = json.dumps(schema, ensure_ascii=False).lower()
        self.assertNotIn('inaccessible to the agent', text)


def evaluation_scope(value):
    from server.scope import validate_scope
    return validate_scope(copy.deepcopy(value))


if __name__ == '__main__':
    unittest.main()
