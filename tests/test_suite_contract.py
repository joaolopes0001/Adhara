"""The suite contract: validation, and how the structural audit applies a suite."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import audit, doc_snapshot
from server.scanner import scan
from server.suite_contract import _completeness, validate_suite


class SuiteContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-suite-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'agent'
        self.root.mkdir()
        for path, text in {'AGENTS.md': '# Agent\n[Rules](rules.md)\n[Deploy](deploy.md)\n',
                           'rules.md': 'Header\nEssential α\nEssential β\nNoise\n',
                           'deploy.md': 'Deploy header\nDeploy details\n',
                           'decoy.md': 'Synthetic decoy\n'}.items():
            (self.root / path).write_text(text)
        self.model = scan([str(self.root)])
        self.suite = {'version': 1, 'entry': 'AGENTS.md', 'scenarios': [{'id': 'normal', 'triggers': [],
                      'required': [{'path': 'rules.md', 'startLine': 2, 'endLine': 3}],
                      'conditional': [{'path': 'deploy.md', 'startLine': 2, 'endLine': 2, 'trigger': 'deploy'}],
                      'forbidden': ['decoy.md'], 'maxReads': 5, 'maxBytes': 1000, 'maxHops': 1}]}

    def test_contract_rejects_traversal_unknown_fields_bools_and_contradictions(self):
        for path in ['../rules.md', '/etc/passwd', 'a/../rules.md', './rules.md', 'a//b', 'a\\b', '.', 'x\x00y']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate_suite({**self.suite, 'entry': path})
        for mutate in [lambda s: s.update(version=True), lambda s: s.update(unknown=3),
                       lambda s: s['scenarios'][0].update(maxReads=True),
                       lambda s: s['scenarios'][0]['required'][0].update(startLine=True),
                       lambda s: s['scenarios'][0]['forbidden'].append('rules.md'),
                       lambda s: s['scenarios'].append(copy.deepcopy(s['scenarios'][0]))]:
            suite = copy.deepcopy(self.suite)
            mutate(suite)
            with self.assertRaises(ValueError):
                validate_suite(suite)

    def test_audit_keeps_evidence_and_excludes_scope_edges(self):
        report = audit.audit(self.model, self.suite)
        self.assertEqual(report['status'], 'pass')
        self.assertEqual(report['paths'][0]['hops'], 1)
        self.assertEqual(report['paths'][0]['steps'][0]['line'], 2)
        # Audit v2 steps are relative to the root; the absolute root appears only in roots[].path.
        self.assertEqual((report['paths'][0]['steps'][0]['origin'], report['paths'][0]['steps'][0]['target']), ('AGENTS.md', 'rules.md'))
        for edge in self.model['edges']:
            edge['kind'] = 'scope'
        report = audit.audit(self.model, self.suite)
        self.assertEqual(report['status'], 'fail')
        self.assertFalse(report['paths'][0]['found'])
        self.model['issues'].append({'code': 'limit', 'message': 'Limite', 'node': None, 'line': None})
        self.assertEqual(audit.audit(self.model, self.suite)['status'], 'inconclusive')

    def test_audit_minimal_hops_and_missing_entry(self):
        self.suite['scenarios'][0]['maxHops'] = 0
        self.assertEqual(audit.audit(self.model, self.suite)['status'], 'fail')
        self.suite['entry'] = 'missing.md'
        report = audit.audit(self.model, self.suite)
        self.assertIn('entry-unavailable', [f['code'] for f in report['findings']])

    def test_audit_omits_entire_path_evidence_when_global_budget_is_exhausted(self):
        with patch.object(audit, 'MAX_PATH_STEPS', 0):
            report = audit.audit(self.model, self.suite)
        self.assertEqual(report['status'], 'inconclusive')
        self.assertTrue(report['paths'][0]['found'])
        self.assertEqual(report['paths'][0]['hops'], 1)
        self.assertEqual(report['paths'][0]['steps'], [])
        self.assertFalse(report['paths'][0]['stepsComplete'])
        self.assertIn('path-evidence-limit', [f['code'] for f in report['findings']])

    def codes(self, report):
        return [finding['code'] for finding in report['findings']]

    def test_audit_suite_reports_policy_exclusion_and_snapshot_loss(self):
        clean = audit.run([str(self.root)], self.suite)
        self.assertEqual(clean['status'], 'pass')
        self.assertFalse({'policy-excluded', 'snapshot-partial'} & set(self.codes(clean)))
        # A file under the read policy (.codex) is excluded explicitly: a warning, and the audit still passes.
        (self.root / '.codex').mkdir()
        (self.root / '.codex/config.toml').write_text('synthetic = true\n')
        excluded = audit.run([str(self.root)], self.suite)
        self.assertEqual(excluded['status'], 'pass')
        self.assertEqual([(f['severity'], f['count']) for f in excluded['findings'] if f['code'] == 'policy-excluded'], [('warning', 1)])
        self.assertNotIn('snapshot-partial', self.codes(excluded))
        # A permitted document the snapshot could not hold is loss, not policy: the audit is inconclusive.
        (self.root / 'large.md').write_text('x' * (300 * 1024))
        partial = audit.run([str(self.root)], self.suite)
        self.assertEqual(partial['status'], 'inconclusive')
        self.assertEqual([(f['severity'], f['count']) for f in partial['findings'] if f['code'] == 'snapshot-partial'], [('incomplete', 1)])
        self.assertIn('policy-excluded', self.codes(partial))

    def test_forged_policy_exclusions_never_hide_loss(self):
        documents = {'rules.md': {'text': 'x\n'}}
        honest = {'documents': documents, 'omitted': 1, 'excludedPolicy': [{'path': '.codex/config.toml', 'reason': 'sensitive-path'}]}
        self.assertEqual(_completeness(honest), ([{'code': 'policy-excluded', 'severity': 'warning', 'message': _completeness(honest)[0][0]['message'], 'count': 1}], False))
        for path in ['missing.md', '.codex/../missing.md', 'rules.md']:
            with self.subTest(path=path):
                forged = {**honest, 'excludedPolicy': [{'path': path, 'reason': 'sensitive-path'}]}
                findings, partial = _completeness(forged)
                self.assertEqual(([f['code'] for f in findings], partial), (['snapshot-partial'], True))
        # An exclusion that no omission accounts for is not reported; a malformed list counts the omission as loss.
        self.assertEqual(_completeness({**honest, 'omitted': 0}), ([], False))
        findings, partial = _completeness({**honest, 'excludedPolicy': ['.codex/config.toml']})
        self.assertEqual(([f['code'] for f in findings], partial), (['snapshot-partial'], True))
        findings, partial = _completeness({'documents': documents, 'scanPartial': True})
        self.assertEqual(([f['code'] for f in findings], partial), (['scan-partial'], True))
        with self.assertRaises(ValueError):
            _completeness({'documents': documents, 'omitted': -1})

    def test_structural_path_output_budget_is_explicit_and_never_passes(self):
        suite = {'version': 1, 'entry': 'AGENTS.md', 'scenarios': [
            {'id': 'base', 'required': [{'path': 'base.md', 'startLine': 1, 'endLine': 1}]}]}
        (self.root / 'base.md').write_text('Base necessária\n')
        for index in range(8):
            next_path = f'route-{index + 1}.md' if index < 7 else 'base.md'
            (self.root / f'route-{index}.md').write_text(f'[Próximo]({next_path})\n')
        (self.root / 'AGENTS.md').write_text('[Rota](route-0.md)\n')
        model, _ = doc_snapshot.prepare([str(self.root)], suite)
        with patch.object(audit, 'MAX_PATH_STEPS', 5):
            report = audit.audit(model, suite)
        self.assertEqual(report['status'], 'inconclusive')
        self.assertTrue(report['paths'][0]['found'])
        self.assertFalse(report['paths'][0]['stepsComplete'])
        self.assertEqual(report['paths'][0]['steps'], [])
        self.assertEqual(report['paths'][0]['hops'], 9)


if __name__ == '__main__':
    unittest.main()
