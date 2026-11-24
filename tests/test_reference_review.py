"""Review of the persistent reference: what a real root produces must load back, and the delta must say why it differs."""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import audit as audit_report
import delta as readings
from workspace import Workspace
from tests.server_pack import portuguese


class ReferenceReviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-reference-review-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'pacote'
        self.state = self.base / 'state'

    def files(self, files):
        for name, text in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')

    def saved(self):
        return self.state / 'references' / (hashlib.sha256(str(self.root).encode()).hexdigest() + '.json.gz')

    def test_manifest_relationship_with_outside_source_and_non_text_type_survives_a_restart(self):
        # A declared relationship names a source outside the root, the next one a numeric type
        # (refused with a manifest finding, never an edge): the reading must load back.
        manifest = {'version': 1, 'relationships': [{'source': '../fora.md', 'target': 'a.md', 'type': 'reads'},
                                                    {'source': '.', 'target': 'a.md', 'type': 5}]}
        self.files({'AGENTS.md': '# A\n[m](agent-architecture.json)\n[a](a.md)\n', 'a.md': '# a\n',
                    'agent-architecture.json': json.dumps(manifest)})
        opened = Workspace(self.state).open(str(self.root))
        self.assertEqual([issue['message'] for issue in opened['issues'] if issue['code'] == 'manifest'],
                         ['Invalid manifest: Relationship with an invalid type: it must be text.'])
        declared = [item for item in json.loads(gzip.decompress(self.saved().read_bytes()))['reference']['relations'] if item['kind'] == 'declared']
        self.assertEqual([(item['source'], item['raw']) for item in declared], [(str(self.base / 'fora.md'), 'reads')])
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual(delta['warnings'], [])
        self.assertEqual(delta['roots'][0]['referenceOrigin'], 'persisted')
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertEqual(delta['findings']['totals'], {'new': 0, 'resolved': 0})

    def test_scope_declared_between_readings_names_its_source_like_compare_audit(self):
        self.files({'AGENTS.md': '# A\n[w](work/x.md)\n[m](agent-architecture.json)\n', 'agent-architecture.json': '{"version": 1}'})
        before = audit_report.run([str(self.root)])
        workspace = Workspace(self.state)
        workspace.open(str(self.root))
        self.files({'agent-architecture.json': json.dumps({'version': 1, 'scope': {'version': 1, 'runtimeWorkspace': ['work/**']}})})
        after = audit_report.run([str(self.root)])
        expected = audit_report.compare_audits(before, after)['findings']
        for delta in (workspace.refresh()['delta'], Workspace(self.state).snapshot()['delta']):
            context = delta['findings']['context']
            self.assertEqual([item['scopeSource'] for item in context], [{'before': None, 'after': 'manifest'}])
            self.assertEqual([item['message'] for item in context], [item['message'] for item in expected])
            self.assertEqual([item['code'] for item in delta['findings']['new']], ['declared-external'])

    def test_reference_saved_by_other_reading_rules_is_kept_with_a_warning(self):
        self.files({'AGENTS.md': '# A\n[a](a.md)\n', 'a.md': '# a\n'})
        Workspace(self.state).open(str(self.root))
        document = json.loads(gzip.decompress(self.saved().read_bytes()))
        self.assertEqual(document['reference']['reader'], readings.READER)
        self.assertEqual(Workspace(self.state).snapshot()['delta']['warnings'], [])
        for reader in ('0' * 16, None):
            if reader is None:
                del document['reference']['reader']
            else:
                document['reference']['reader'] = reader
            self.saved().write_bytes(gzip.compress(json.dumps(document).encode()))
            workspace = Workspace(self.state)
            delta = workspace.snapshot()['delta']
            # The saved reference still holds: file hashes compare the disk; the warning explains relations and findings.
            self.assertEqual(delta['roots'][0]['referenceOrigin'], 'persisted')
            self.assertEqual([item['code'] for item in delta['warnings']], ['reference-reader-changed'])
            self.assertIn('another version of the app', delta['warnings'][0]['message'])
        # Adopting the current reading saves it with this reader: the warning goes away, also after a restart.
        self.assertEqual(workspace.adopt_reference()['delta']['warnings'], [])
        self.assertEqual(Workspace(self.state).snapshot()['delta']['warnings'], [])

    def test_baselines_of_several_projects_read_by_another_version_are_said_once_with_their_count(self):
        roots = [str(self.base / name) for name in ('a', 'b', 'c', 'd')]
        saved = {root: self.state / 'references' / (hashlib.sha256(root.encode()).hexdigest() + '.json.gz') for root in roots}
        workspace = Workspace(self.state)
        for root in roots:
            Path(root).mkdir()
            Path(root, 'AGENTS.md').write_text('# A\n', encoding='utf-8')
            workspace.open(root)
        workspace.adopt_reference()
        a, b, c, d = roots
        for root in (a, b, d):  # c keeps a baseline of this version
            document = json.loads(gzip.decompress(saved[root].read_bytes()))
            document['reference']['reader'] = '0' * 16
            saved[root].write_bytes(gzip.compress(json.dumps(document).encode()))
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual([(item['root'], item.get('roots'), item['code']) for item in delta['warnings']], [(a, [a, b, d], 'reference-reader-changed')])
        message = delta['warnings'][0]['message']
        self.assertEqual(message.split(':')[0], 'The saved baselines of 3 projects were read by another version of the app')
        self.assertTrue(message.endswith('To compare only scans of this version, use “Update baseline”.'))
        self.assertEqual(portuguese(message).split(':')[0], 'As referências salvas de 3 projetos foram lidas por outra versão do aplicativo')
        self.assertTrue(portuguese(message).endswith('Para comparar só leituras desta versão, use “Atualizar referência”.'))
        # One project: the sentence about one baseline, which the screen names after its project like any warning of one root.
        for root in (a, d):
            saved[root].unlink()
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual([(item['root'], item.get('roots'), item['code']) for item in delta['warnings']], [(b, [b], 'reference-reader-changed')])
        self.assertEqual(delta['warnings'][0]['message'], readings.READER_CHANGED)
        self.assertTrue(portuguese(delta['warnings'][0]['message']).startswith('A referência salva foi lida por outra versão do aplicativo: '))
        self.assertTrue(portuguese(delta['warnings'][0]['message']).endswith('use “Atualizar referência”.'))

    def test_a_malformed_reader_is_ignored_like_any_invalid_field(self):
        self.files({'AGENTS.md': '# A\n'})
        Workspace(self.state).open(str(self.root))
        document = json.loads(gzip.decompress(self.saved().read_bytes()))
        document['reference']['reader'] = '<script>'
        self.saved().write_bytes(gzip.compress(json.dumps(document).encode()))
        self.assertEqual([item['code'] for item in Workspace(self.state).snapshot()['delta']['warnings']], ['reference-ignored'])


if __name__ == '__main__':
    unittest.main()
