"""Content identity of requirements, freeze, always-loaded cost and contract identity.

Every fixture is a new temporary tree.
"""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import cli, doc_snapshot, suite_contract
from server.doc_snapshot import document_lines, excerpt_sha256

FILES = {
    'AGENTS.md': '# Entrada\nSempre responder em português.\n[SLA](shared/sla.md)\n[Contatos](contatos.md)\n[Ruído](noise.md)\n',
    'shared/sla.md': '# SLA\n\n| Item | Prazo |\n|---|---|\n| Resposta | 4 horas |\n| Severidade 1 | 1 hora |\n| Severidade 3 | 3 dias |\n',
    'contatos.md': '# Contatos\nRamal 7001 (24 horas).\nGerente: ramal 7002.\n',
    'noise.md': 'Texto sem relação com a tarefa.\n',
}
SLA = {'path': 'shared/sla.md', 'startLine': 5, 'endLine': 7}
CONTACTS = {'path': 'contatos.md', 'startLine': 2, 'endLine': 3, 'trigger': 'sev1'}


class SuiteIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-identity-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.root = self.make_root('root', FILES)
        self.suite = {'version': 1, 'entry': 'AGENTS.md', 'scenarios': [
            {'id': 'normal', 'triggers': [], 'required': [dict(SLA)], 'conditional': [dict(CONTACTS)], 'forbidden': ['noise.md'], 'maxReads': 6},
            {'id': 'sev1', 'triggers': ['sev1'], 'required': [dict(SLA)], 'conditional': [dict(CONTACTS)], 'forbidden': ['noise.md'], 'maxReads': 6}]}
        self.suite_file = self.save('suite.json', self.suite)

    def make_root(self, name, files):
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

    def freeze(self, suite_file=None, root=None, *flags):
        return self.invoke('freeze', '--root', root or self.root, '--suite', suite_file or self.suite_file, *flags)

    def audit(self, suite_file, root=None):
        return self.invoke('audit', '--root', root or self.root, '--suite', suite_file)

    def insert_top_line(self, relative, root=None):
        path = (root or self.root) / relative
        path.write_text('<!-- revisado pela coordenação -->\n' + path.read_text(encoding='utf-8'), encoding='utf-8')

    def codes(self, report):
        return [finding['code'] for finding in report['findings']]

    def test_freeze_binds_every_requirement_with_the_excerpt_hash(self):
        code, frozen = self.freeze()
        self.assertEqual((code, frozen['kind'], frozen['status']), (0, 'freeze', 'pass'))
        self.assertEqual([(c['scenarioId'], c['list'], c['index'], c['action']) for c in frozen['changes']],
                         [('normal', 'required', 0, 'bound'), ('normal', 'conditional', 0, 'bound'),
                          ('sev1', 'required', 0, 'bound'), ('sev1', 'conditional', 0, 'bound')])
        # The inactive conditional of "normal" is bound too, with the excerpt hash of the snapshot.
        normal = frozen['suite']['scenarios'][0]
        self.assertEqual(normal['conditional'][0]['contentHash'], excerpt_sha256(document_lines(FILES['contatos.md']), 2, 3))
        self.assertEqual(normal['required'][0]['contentHash'], excerpt_sha256(document_lines(FILES['shared/sla.md']), 5, 7))
        expected = hashlib.sha256('| Resposta | 4 horas |\n| Severidade 1 | 1 hora |\n| Severidade 3 | 3 dias |\n'.encode()).hexdigest()
        self.assertEqual(normal['required'][0]['contentHash'], expected)
        self.assertEqual(frozen['suiteHash'], suite_contract._hash(frozen['suite']))
        self.assertRegex(frozen['contractHash'], '^[0-9a-f]{64}$')
        # Verification: freezing the frozen report again changes nothing.
        code, verified = self.freeze(self.save('frozen.json', frozen))
        self.assertEqual((code, verified['status'], verified['changes']), (0, 'pass', []))
        self.assertEqual(verified['suiteHash'], frozen['suiteHash'])

    def test_inserted_top_line_is_never_approved_and_reports_the_new_range(self):
        _, frozen = self.freeze()
        frozen_file = self.save('frozen.json', frozen)
        self.assertEqual(self.audit(frozen_file)[0], 0)
        self.insert_top_line('shared/sla.md')
        # Legacy suites still pass, with an explicit warning.
        code, legacy = self.audit(self.suite_file)
        self.assertEqual(code, 0)
        self.assertEqual([(f['severity'], f['message'], f['scenarioId'], f['count']) for f in legacy['findings'] if f['code'] == 'requirement-unbound'],
                         [('warning', suite_contract.UNBOUND_MESSAGE, 'normal', 1), ('warning', suite_contract.UNBOUND_MESSAGE, 'sev1', 2)])
        code, report = self.audit(frozen_file)
        self.assertEqual((code, report['status']), (3, 'inconclusive'))
        stale = [f for f in report['findings'] if f['code'] == 'requirement-stale']
        self.assertEqual([f['scenarioId'] for f in stale], ['normal', 'sev1'])
        self.assertEqual((stale[0]['path'], stale[0]['startLine'], stale[0]['endLine']), ('shared/sla.md', 5, 7))
        self.assertEqual(stale[0]['relocated'], [{'path': 'shared/sla.md', 'startLine': 6, 'endLine': 8}])
        self.assertTrue(stale[0]['relocationComplete'])
        # The same identity check, without the CLI.
        _, snapshot = doc_snapshot.prepare([str(self.root)], self.suite)
        static = suite_contract.suite_static_findings(snapshot, frozen['suite'])
        self.assertEqual([(f['code'], f['scenarioId']) for f in static['findings']],
                         [('requirement-stale', 'normal'), ('requirement-stale', 'sev1')])
        self.assertEqual(static['alwaysLoadedBytes'], len(FILES['AGENTS.md'].encode()))

    def test_relocate_unique_ambiguous_and_absent(self):
        _, frozen = self.freeze()
        frozen_file = self.save('frozen.json', frozen)
        self.insert_top_line('shared/sla.md')
        code, relocated = self.freeze(frozen_file, None, '--relocate')
        self.assertEqual((code, relocated['status']), (0, 'pass'))
        self.assertEqual({(c['scenarioId'], c['action']) for c in relocated['changes']}, {('normal', 'relocated'), ('sev1', 'relocated')})
        self.assertEqual(relocated['changes'][0]['from'], SLA)
        self.assertEqual(relocated['changes'][0]['to'], {'path': 'shared/sla.md', 'startLine': 6, 'endLine': 8})
        self.assertEqual(relocated['contractHash'], frozen['contractHash'])
        self.assertNotEqual(relocated['suiteHash'], frozen['suiteHash'])
        code, audited = self.audit(self.save('relocated.json', relocated))
        self.assertEqual(code, 0)
        self.assertNotIn('requirement-stale', self.codes(audited))
        # Two identical places: ambiguity is never resolved by guessing.
        (self.root / 'copia.md').write_text(''.join(document_lines(FILES['shared/sla.md'])[4:7]))
        code, ambiguous = self.freeze(frozen_file, None, '--relocate')
        self.assertEqual((code, ambiguous['status'], ambiguous['changes']), (3, 'inconclusive', []))
        stale = [f for f in ambiguous['findings'] if f['code'] == 'requirement-stale']
        self.assertEqual({f['relocatedTotal'] for f in stale}, {2})
        self.assertEqual(stale[0]['relocated'], [{'path': 'copia.md', 'startLine': 1, 'endLine': 3}, {'path': 'shared/sla.md', 'startLine': 6, 'endLine': 8}])
        (self.root / 'copia.md').unlink()
        # Edited excerpt: no identical place remains.
        sla = self.root / 'shared/sla.md'
        sla.write_text(sla.read_text().replace('4 horas', '5 horas'))
        code, absent = self.freeze(frozen_file, None, '--relocate')
        self.assertEqual(code, 3)
        self.assertEqual({(f['relocated'] == [], f['relocatedTotal']) for f in absent['findings']}, {(True, 0)})

    def test_rebind_runs_after_relocate_and_only_on_remaining_stale(self):
        _, frozen = self.freeze()
        frozen_file = self.save('frozen.json', frozen)
        self.insert_top_line('shared/sla.md')
        contacts = self.root / 'contatos.md'
        contacts.write_text(contacts.read_text().replace('7002', '7003'))
        code, result = self.freeze(frozen_file, None, '--rebind', '--relocate')
        self.assertEqual((code, result['status'], result['findings']), (0, 'pass', []))
        actions = {(c['scenarioId'], c['list'], c['action']) for c in result['changes']}
        self.assertEqual(actions, {('normal', 'required', 'relocated'), ('sev1', 'required', 'relocated'),
                                   ('normal', 'conditional', 'rebound'), ('sev1', 'conditional', 'rebound')})
        rebound = next(c for c in result['changes'] if c['action'] == 'rebound')
        self.assertEqual(rebound['from'], {'contentHash': frozen['suite']['scenarios'][0]['conditional'][0]['contentHash']})
        self.assertEqual(rebound['to'], {'contentHash': excerpt_sha256(document_lines(contacts.read_text()), 2, 3)})
        self.assertNotEqual(result['contractHash'], frozen['contractHash'])
        code, only_rebind = self.freeze(frozen_file, None, '--rebind')
        self.assertEqual(code, 0)
        self.assertEqual({c['action'] for c in only_rebind['changes']}, {'rebound'})

    def test_freeze_report_is_accepted_as_suite_only_when_pass_and_consistent(self):
        _, frozen = self.freeze()
        frozen_file = self.save('frozen.json', frozen)
        self.assertEqual(self.audit(frozen_file)[0], 0)
        self.insert_top_line('shared/sla.md')
        code, stale = self.freeze(frozen_file)
        self.assertEqual((code, stale['status']), (3, 'inconclusive'))
        stale_file = self.save('stale-freeze.json', stale)
        for command in ('audit', 'freeze'):
            with self.subTest(command=command):
                code, error = self.invoke(command, '--root', self.root, '--suite', stale_file)
                self.assertEqual((code, error['status']), (2, 'error'))
        tampered = copy.deepcopy(frozen)
        tampered['suite']['scenarios'][0]['maxReads'] = 99
        self.assertEqual(self.audit(self.save('tampered.json', tampered))[0], 2)
        for change in ({'kind': 'audit'}, {'version': 2}, {'contractHash': None}):
            with self.subTest(change=change):
                self.assertEqual(self.audit(self.save('odd.json', {**frozen, **change}))[0], 2)

    def test_legacy_suite_hash_is_unchanged_and_new_fields_validate(self):
        normalized = {'version': 1, 'entry': 'AGENTS.md', 'scenarios': [
            {'id': s['id'], 'triggers': s['triggers'], 'required': s['required'], 'conditional': s['conditional'],
             'forbidden': s['forbidden'], 'maxReads': s['maxReads']} for s in self.suite['scenarios']]}
        legacy_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        code, report = self.audit(self.suite_file)
        self.assertEqual((code, report['suiteHash'], report['contractHash']), (0, legacy_hash, None))
        explicit = self.save('explicit.json', {**self.suite, 'entryInjected': False})
        self.assertEqual(self.audit(explicit)[1]['suiteHash'], legacy_hash)
        for mutate in [lambda s: s.update(entryInjected=1), lambda s: s['scenarios'][0].update(maxAlwaysLoadedBytes=-1),
                       lambda s: s['scenarios'][0].update(maxAlwaysLoadedBytes=True),
                       lambda s: s['scenarios'][0]['required'][0].update(contentHash='A' * 64),
                       lambda s: s['scenarios'][0]['required'][0].update(contentHash='a' * 63),
                       lambda s: s['scenarios'][0]['required'][0].update(contenthash='a' * 64)]:
            suite = copy.deepcopy(self.suite)
            mutate(suite)
            with self.assertRaises(ValueError):
                suite_contract.validate_suite(suite)

    def test_contract_hash_compares_revisions_that_only_moved_content(self):
        moved = dict(FILES)
        moved['AGENTS.md'] = FILES['AGENTS.md'].replace('contatos.md', 'contatos/criticos.md')
        moved['contatos/criticos.md'] = '# Contatos críticos\n\nUse somente em severidade 1.\n' + ''.join(document_lines(FILES['contatos.md'])[1:3])
        del moved['contatos.md']
        after_root = self.make_root('after', moved)
        after_suite = copy.deepcopy(self.suite)
        for scenario in after_suite['scenarios']:
            scenario['conditional'] = [{'path': 'contatos/criticos.md', 'startLine': 4, 'endLine': 5, 'trigger': 'sev1'}]
        after_file = self.save('after-suite.json', after_suite)
        # Unbound suites have no contract identity.
        self.assertIsNone(self.audit(self.suite_file)[1]['contractHash'])
        _, frozen_before = self.freeze()
        _, frozen_after = self.freeze(after_file, after_root)
        self.assertEqual(frozen_before['contractHash'], frozen_after['contractHash'])
        self.assertNotEqual(frozen_before['suiteHash'], frozen_after['suiteHash'])
        # Same content but another budget is another contract.
        other = copy.deepcopy(frozen_after['suite'])
        other['scenarios'][1]['maxReads'] = 7
        self.assertNotEqual(suite_contract.contract_hash(other), frozen_after['contractHash'])
        # The audits of both revisions carry the shared contract identity.
        audited_before = self.audit(self.save('fb.json', frozen_before))[1]
        audited_after = self.audit(self.save('fa.json', frozen_after), after_root)[1]
        self.assertEqual((audited_before['contractHash'], audited_after['contractHash']), (frozen_before['contractHash'],) * 2)

    def test_always_loaded_budget_uses_the_whole_entry(self):
        entry_bytes = len(FILES['AGENTS.md'].encode())
        suite = copy.deepcopy(self.suite)
        suite['scenarios'][0]['maxAlwaysLoadedBytes'] = entry_bytes - 1
        code, report = self.audit(self.save('budget.json', suite))
        self.assertEqual((code, report['status']), (1, 'fail'))
        exceeded = [f for f in report['findings'] if f['code'] == 'always-loaded-budget-exceeded']
        self.assertEqual([(f['actual'], f['maximum'], f['path']) for f in exceeded], [(entry_bytes, entry_bytes - 1, 'AGENTS.md')])
        self.assertEqual(exceeded[0]['message'], suite_contract.ALWAYS_LOADED_MESSAGE)
        suite['scenarios'][0]['maxAlwaysLoadedBytes'] = entry_bytes
        self.assertEqual(self.audit(self.save('budget.json', suite))[0], 0)
        # A snapshot without its entry never approves the always-loaded budget.
        _, snapshot = doc_snapshot.prepare([str(self.root)], self.suite)
        del snapshot['documents']['AGENTS.md']
        static = suite_contract.suite_static_findings(snapshot, suite)
        self.assertEqual((static['alwaysLoadedBytes'], self.codes(static)[-1]), (None, 'entry-unavailable'))

    def test_static_findings_cover_every_scenario(self):
        suite = copy.deepcopy(self.suite)
        for scenario in suite['scenarios']:
            scenario['maxAlwaysLoadedBytes'] = 10
        _, snapshot = doc_snapshot.prepare([str(self.root)], suite)
        result = suite_contract.suite_static_findings(snapshot, suite)
        self.assertEqual([(f['code'], f['scenarioId'], f.get('count')) for f in result['findings']],
                         [('requirement-unbound', 'normal', 1), ('always-loaded-budget-exceeded', 'normal', None),
                          ('requirement-unbound', 'sev1', 2), ('always-loaded-budget-exceeded', 'sev1', None)])
        suite['scenarios'][1]['required'].append({'path': 'contatos.md', 'startLine': 9, 'endLine': 9})
        result = suite_contract.suite_static_findings(snapshot, suite)
        self.assertIn(('requirement-unavailable', 'sev1'), [(f['code'], f['scenarioId']) for f in result['findings']])

    def test_relocation_is_blocked_by_partial_snapshot_budget_or_contradiction(self):
        _, frozen = self.freeze()
        frozen_file = self.save('frozen.json', frozen)
        self.insert_top_line('shared/sla.md')
        with patch.object(suite_contract, 'RELOCATION_MAX_WINDOWS', 0):
            code, limited = self.freeze(frozen_file, None, '--relocate')
        self.assertEqual((code, limited['changes']), (3, []))
        self.assertEqual({f['relocationComplete'] for f in limited['findings']}, {False})
        (self.root / 'large.md').write_text('x' * (300 * 1024))
        code, partial = self.freeze(frozen_file, None, '--relocate')
        self.assertEqual((code, partial['snapshotPartial'], partial['changes']), (3, True, []))
        self.assertEqual({(f['relocatedTotal'], f['relocationComplete']) for f in partial['findings']}, {(1, False)})
        (self.root / 'large.md').unlink()
        # The only identical place is forbidden: relocating would contradict the contract.
        sla = self.root / 'shared/sla.md'
        moved = document_lines(FILES['shared/sla.md'])[4:7]
        sla.write_text(''.join(document_lines(FILES['shared/sla.md'])[:4]))
        (self.root / 'noise.md').write_text(''.join(moved))
        code, rejected = self.freeze(frozen_file, None, '--relocate')
        self.assertEqual((code, rejected['changes']), (3, []))
        self.assertEqual({(f['code'], f.get('relocationRejected')) for f in rejected['findings']}, {('requirement-unavailable', 'contradiction')})

if __name__ == '__main__':
    unittest.main()
