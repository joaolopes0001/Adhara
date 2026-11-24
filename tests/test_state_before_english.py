"""An app state saved while the server wrote its sentences in Portuguese is read by this server without loss.

`state_before_english.json` is what the earlier server wrote for the synthetic projects
`build` makes: `workspace.json` (notes, observations marked as expected) and the saved baseline of each
project, with the observations of that reading as the interface received them. The paths in it are written
from a placeholder base, so the test puts the same trees and that state in a temporary folder and reads
them with the server of this repository.

The sentences of the reader are in English now, and the id the reader gives an observation is made of its
sentence, so every such id changed. Nothing the app saves holds that id: a note is kept by the path of its
file, a mark by the key of the observation (code, file, destination, ordinal), a baseline by the ids of
`aae audit` and the relations as written. These tests state it on a state of the earlier server: no mark is
orphaned, no note is detached, and Changes reports only what really changed on disk.

The fixtures are frozen recordings of the format saved before the server wrote in English;
they are not regenerated.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'state_before_english.json'
BASE = '/aae-state-before-english'  # the placeholder of the temporary base in the recorded paths
NOTE = 'Anotação feita antes do inglês: conferir o contrato.'
REASON = 'esperada antes do inglês'


def build(base):
    """Two projects under `base` (a repository: `.git` above them) whose reading has observations of many
    kinds, signals and relations. Returns their paths, `projeto` first."""
    base = Path(base)

    def write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    (base / '.git').mkdir(parents=True)
    write(base / 'compartilhado' / 'acima.md', '# Acima\n')
    project = base / 'projeto'
    write(project / 'AGENTS.md', '\n'.join([
        '# Projeto',
        '[quebrado](docs/falta.md), `fantasma.md` e [[wiki-falta]]',
        '[ambíguo](comum.md)',
        '[repetido](docs/b.md) e [de novo](docs/b.md)',
        '[mais uma](docs/b.md)',
        '`compartilhado/acima.md` fica acima do projeto',
        '[uri](file://%zz) e [link](atalho.md) e [latin](docs/latin.md)',
        '[manifesto](pacote/agent-architecture.json) e [skill](.claude/skills/uma/SKILL.md)',
        *[f'[destino {index}](leque/d{index}.md)' for index in range(13)], '']))
    write(project / 'docs' / 'b.md', '[volta](../AGENTS.md)\n[c](c.md)\n')
    write(project / 'docs' / 'c.md', '[b](b.md)\n')
    (project / 'docs' / 'latin.md').write_bytes(b'caf\xe9\n')
    write(project / 'x' / 'comum.md', 'x\n')
    write(project / 'y' / 'comum.md', 'y\n')
    write(project / 'ilha' / 'i1.md', '[i2](i2.md)\n')
    write(project / 'ilha' / 'i2.md', '[i1](i1.md)\n')
    write(project / 'solto.md', 'solto\n')
    for index in range(13):
        write(project / 'leque' / f'd{index}.md', 'x\n')
    os.symlink('docs/b.md', project / 'atalho.md')
    write(project / '.claude' / 'skills' / 'uma' / 'SKILL.md', '---\nname: uma\n---\n`apoio.md`\n')
    write(project / '.claude' / 'skills' / 'uma' / 'fundo' / 'apoio.md', 'apoio\n')
    write(project / 'pacote' / 'a.md', '[b](b.md)\n')
    write(project / 'pacote' / 'b.md', 'b\n')
    write(project / 'pacote' / 'agent-architecture.json', json.dumps({
        'linkedRelationships': True, 'objects': [{'path': 'a.md'}, {'path': 'b.md'}],
        'relationships': [{'source': 'b.md', 'target': 'a.md'}]}))
    write(project / 'ruim' / 'agent-architecture.json', '{"objects": 3}')
    write(project / 'ruim' / 'nota.md', '[m](agent-architecture.json)\n')
    neighbour = base / 'vizinho'
    write(neighbour / 'AGENTS.md', '# Vizinho\n[nota](nota.md) e [falta](sumiu.md)\n')
    write(neighbour / 'nota.md', 'nota\n')
    write(neighbour / 'agent-architecture.json', json.dumps({'scope': {'version': 1, 'runtimeWorkspace': ['nunca/']}}))
    return [str(project), str(neighbour)]


def observations(snapshot, base):
    """The observations and signals of a snapshot, as the interface received them, with paths from the placeholder."""
    return [{'kind': kind, 'id': item['id'], 'key': item.get('key'), 'code': item['code'], 'message': item['message'].replace(base, BASE),
             'node': item['node'].replace(base, BASE) if item.get('node') else None, 'line': item.get('line'), 'target': item.get('target')}
            for kind in ('issues', 'signals') for item in snapshot[kind]]


def record(server):
    """The state the server at `server` (a folder with the earlier `server/`) writes for the projects of `build`."""
    with tempfile.TemporaryDirectory(prefix='aae-record-') as temporary:
        home = Path(temporary) / 'home'
        home.mkdir()
        os.environ['HOME'] = str(home)
        os.environ.pop('AAE_PROTECTED_PATHS', None)
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(Path(server) / 'server'))
        import delta
        from workspace import Workspace
        base = str(Path(temporary).resolve() / 'base')
        roots = build(base)
        state = Path(base).parent / 'state'
        delta.now = lambda: '2026-11-17T10:00:00-03:00'
        workspace = Workspace(state)
        for root in roots:
            workspace.open(root)
        snapshot = workspace.snapshot()
        for item in snapshot['issues'] + snapshot['signals']:
            owner = max((root for root in roots if item.get('node') and (item['node'] == root or item['node'].startswith(root + '/'))), key=len, default=None)
            if owner and item.get('key'):
                workspace.expect(owner, item['key'], True, REASON)
        for name in ('AGENTS.md', 'docs/b.md'):
            workspace.note(f'{roots[0]}/{name}', NOTE)
        # The baseline of the readings of both projects together, as "Atualizar referência" saves it.
        workspace.adopt_reference()
        references = {}
        for root in roots:
            saved = state / 'references' / (hashlib.sha256(root.encode()).hexdigest() + '.json.gz')
            references[root.replace(base, BASE)] = json.loads(gzip.decompress(saved.read_bytes()).decode().replace(base, BASE))
        recorded = {'workspace': json.loads((state / 'workspace.json').read_text(encoding='utf-8').replace(base, BASE)),
                    'references': references, 'observations': observations(workspace.snapshot(), base)}
    json.dump(recorded, sys.stdout, ensure_ascii=False, indent=1, sort_keys=True)
    sys.stdout.write('\n')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--record':
        raise SystemExit('usage: test_state_before_english.py --record FOLDER')
    record(sys.argv[2])
    raise SystemExit(0)

sys.path.insert(0, str(HERE.parent / 'server'))
import delta as readings  # noqa: E402
import texts  # noqa: E402
from workspace import Workspace  # noqa: E402


class StateBeforeEnglishTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-before-english-')
        self.addCleanup(temporary.cleanup)
        self.base = str(Path(temporary.name).resolve() / 'base')
        self.roots = build(self.base)
        self.project, self.neighbour = self.roots
        self.state = Path(self.base).parent / 'state'
        self.recorded = json.loads(FIXTURE.read_text(encoding='utf-8'))
        self.put(self.state, self.roots)

    def here(self, value):
        """A recorded value with its paths in the temporary base of this test."""
        return json.loads(json.dumps(value).replace(BASE, self.base))

    def put(self, state, roots):
        """The recorded state in `state`: workspace.json and the saved baseline of each of `roots`."""
        (state / 'references').mkdir(parents=True)
        (state / 'workspace.json').write_text(json.dumps(self.here(self.recorded['workspace'])), encoding='utf-8')
        for root in roots:
            document = self.here(self.recorded['references'][root.replace(self.base, BASE)])
            name = hashlib.sha256(root.encode()).hexdigest() + '.json.gz'
            (state / 'references' / name).write_bytes(gzip.compress(json.dumps(document).encode()))

    def before(self):
        return self.here(self.recorded['observations'])

    @staticmethod
    def now(snapshot):
        return [*snapshot['issues'], *snapshot['signals']]

    @staticmethod
    def place(item):
        return (item['code'], item['node'], item.get('line'), item.get('target'))

    def test_the_recorded_state_is_of_the_portuguese_server_and_holds_no_reader_id(self):
        before = self.before()
        codes = {item['code'] for item in before}
        # The state was written by the earlier server: its sentences are the Portuguese ones.
        self.assertIn('Destino não encontrado: docs/falta.md', [item['message'] for item in before])
        self.assertGreaterEqual(codes, {'broken', 'unresolved-name', 'ambiguous', 'outside-root', 'unreadable', 'symlink', 'manifest',
                                        'manifest-mismatch', 'unreachable', 'scope-unused-pattern', 'repeated-reference', 'cycle', 'high-fanout'})
        saved = json.dumps([self.recorded['workspace'], self.recorded['references']], ensure_ascii=False)
        self.assertTrue('Destino não encontrado: docs/falta.md' in saved)  # the baseline keeps the sentence of each finding
        # The id the reader gives an observation (made of its sentence) is in nothing the app saved.
        self.assertEqual([item['id'] for item in before if item['id'] in saved], [])
        # What it does hold: the key of each marked observation and the notes by path.
        marked = {key for marks in self.recorded['workspace']['expected'].values() for key in marks}
        self.assertEqual(marked, {item['key'] for item in before if item['key']})
        self.assertEqual(len(marked), len([item for item in before if item['key']]))

    def test_every_observation_keeps_its_place_and_its_key_and_only_the_reader_id_and_the_sentence_change(self):
        snapshot = Workspace(self.state).snapshot()
        before, now = self.before(), self.now(snapshot)
        self.assertEqual([self.place(item) for item in now], [self.place(item) for item in before])
        self.assertEqual([item.get('key') for item in now], [item['key'] for item in before])
        # The sentences are other (English), and so is every id made of them.
        self.assertTrue(all(new['message'] != old['message'] and new['id'] != old['id'] for new, old in zip(now, before)))

    def test_no_mark_is_orphaned_and_no_note_is_detached(self):
        workspace = Workspace(self.state)
        snapshot = workspace.snapshot()
        self.assertEqual(snapshot['restoreErrors'], [])
        keys = {}
        for item in self.now(snapshot):
            if item.get('key'):
                owner = max((root for root in self.roots if item['node'] == root or item['node'].startswith(root + '/')), key=len)
                keys.setdefault(owner, set()).add(item['key'])
        expected = snapshot['expected']
        self.assertEqual(set(expected), set(self.roots))
        for root in self.roots:
            # Every mark of the earlier state is the mark of an observation of this reading, and none is missing.
            self.assertEqual(set(expected[root]), keys[root])
            self.assertTrue(all(mark['reason'] == REASON for mark in expected[root].values()))
        self.assertEqual(sum(len(marks) for marks in expected.values()), len([item for item in self.before() if item['key']]))
        nodes = {node['id'] for node in snapshot['nodes']}
        self.assertEqual(snapshot['notes'], {f'{self.project}/AGENTS.md': NOTE, f'{self.project}/docs/b.md': NOTE})
        self.assertLessEqual(set(snapshot['notes']), nodes)
        self.assertEqual({case['path']: case['notes'] for case in snapshot['savedCases']}, {self.project: 2, self.neighbour: 0})

    def test_changes_reports_nothing_against_the_baseline_of_the_earlier_server(self):
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual([(root['path'], root['referenceOrigin'], root['context']) for root in delta['roots']],
                         [(self.project, 'persisted', 'same'), (self.neighbour, 'persisted', 'same')])
        self.assertEqual(delta['files']['totals'], {'added': 0, 'removed': 0, 'changed': 0})
        # One file is compared by nothing: the symbolic link, which has neither hash nor size in either reading.
        self.assertEqual((delta['files']['unverified'], delta['files']['uncompared']), (1, 0))
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertEqual((delta['relations']['uncompared'], delta['relations']['unanalysed']), (0, 0))
        findings = delta['findings']
        self.assertEqual((findings['totals'], findings['uncompared'], findings['unanalysed']), ({'new': 0, 'resolved': 0}, 0, 0))
        # The project has a file that cannot be read, in both readings: the comparison says it is partial, as before.
        self.assertEqual((findings['status'], [(note['code'], note['root'], note['sides']) for note in findings['context']]),
                         ('inconclusive', [('comparison-incomplete', self.project, ['before', 'after'])]))
        self.assertNotIn('error', findings)
        # Every finding of the baseline is found again: the ids of `aae audit` have no sentence in them.
        stored = sum(len(reference['reference']['audit']['findings']) for reference in self.recorded['references'].values())
        self.assertEqual(findings['persisting'], stored)
        self.assertEqual(stored, 20)
        # The only warning is the one any change of the reader gives, said once for both projects.
        self.assertEqual([(warning['roots'], warning['code']) for warning in delta['warnings']],
                         [([self.project, self.neighbour], 'reference-reader-changed')])

    def test_a_real_change_is_the_only_one_reported_against_the_earlier_baseline(self):
        workspace = Workspace(self.state)
        entry = Path(self.project) / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8').replace('[quebrado](docs/falta.md)', '[consertado](docs/b.md)') + '[novo](docs/outra-falta.md)\n', encoding='utf-8')
        delta = workspace.refresh()['delta']
        self.assertEqual(delta['files']['totals'], {'added': 0, 'removed': 0, 'changed': 1})
        self.assertEqual([(item['raw'], item['line']) for item in delta['relations']['added']], [('docs/b.md', 2), ('docs/outra-falta.md', 22)])
        self.assertEqual([(item['raw'], item['line']) for item in delta['relations']['removed']], [('docs/falta.md', 2)])
        new, resolved = delta['findings']['new'], delta['findings']['resolved']
        self.assertEqual([(item['code'], item['target']) for item in new], [('broken', 'docs/outra-falta.md')])
        self.assertEqual([(item['code'], item['target']) for item in resolved], [('broken', 'docs/falta.md')])
        # The new finding has the English sentence and its phrase; the resolved one is as the earlier server
        # saved it, in Portuguese and without a phrase, and says so (`earlier`): the interface never reads its
        # message, shown as it came in Portuguese only (tests/ui/server-text.spec.ts).
        self.assertEqual((new[0]['message'], new[0]['messagePhrase']),
                         ('Target not found: docs/outra-falta.md', {'phrase': 'Target not found: {raw}', 'params': {'raw': 'docs/outra-falta.md'}}))
        self.assertNotIn('earlier', new[0])
        self.assertEqual((resolved[0]['message'], resolved[0]['earlier']), ('Destino não encontrado: docs/falta.md', True))
        self.assertNotIn('messagePhrase', resolved[0])

    def test_a_state_with_marks_and_baselines_of_both_servers_is_read_without_loss(self):
        # The baseline of the neighbour is not there: this server makes and saves one, next to the earlier one.
        os.unlink(self.state / 'references' / (hashlib.sha256(self.neighbour.encode()).hexdigest() + '.json.gz'))
        workspace = Workspace(self.state)
        snapshot = workspace.snapshot()
        self.assertEqual([(root['path'], root['referenceOrigin'], root['referenceSaved']) for root in snapshot['delta']['roots']],
                         [(self.project, 'persisted', True), (self.neighbour, 'first-reading', True)])
        # A mark is taken off and put back by this server, and a new observation is marked by it.
        old = snapshot['expected']
        entry = Path(self.neighbour) / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8') + '[outra](tambem-sumiu.md)\n', encoding='utf-8')
        snapshot = workspace.refresh()
        added = next(item for item in snapshot['issues'] if item.get('target') == 'tambem-sumiu.md')
        again = next(item for item in snapshot['issues'] if item.get('target') == 'docs/falta.md')
        workspace.expect(self.neighbour, added['key'], True, 'marked in English')
        workspace.expect(self.project, again['key'], False)
        workspace.expect(self.project, again['key'], True, 'marked again')
        workspace.note(f'{self.neighbour}/nota.md', 'a note of this server')
        workspace.adopt_reference()  # the baselines of both projects are of this server now, with phrases

        restarted = Workspace(self.state)
        snapshot = restarted.snapshot()
        self.assertEqual(snapshot['restoreErrors'], [])
        expected = snapshot['expected']
        self.assertEqual(set(expected[self.project]), set(old[self.project]))
        self.assertEqual(set(expected[self.neighbour]), set(old[self.neighbour]) | {added['key']})
        reasons = {mark['reason'] for marks in expected.values() for mark in marks.values()}
        self.assertEqual(reasons, {REASON, 'marked in English', 'marked again'})
        live = {item['key'] for item in self.now(snapshot) if item.get('key')}
        self.assertEqual({key for marks in expected.values() for key in marks} - live, set())
        self.assertEqual(snapshot['notes'], {f'{self.project}/AGENTS.md': NOTE, f'{self.project}/docs/b.md': NOTE, f'{self.neighbour}/nota.md': 'a note of this server'})
        delta = snapshot['delta']
        self.assertEqual((delta['files']['totals'], delta['relations']['totals'], delta['findings']['totals'], delta['warnings']),
                         ({'added': 0, 'removed': 0, 'changed': 0}, {'added': 0, 'removed': 0}, {'new': 0, 'resolved': 0}, []))

    def test_a_baseline_of_this_server_keeps_the_phrase_of_each_message_made_with_parameters(self):
        workspace = Workspace(self.state)
        workspace.adopt_reference()
        saved = self.state / 'references' / (hashlib.sha256(self.project.encode()).hexdigest() + '.json.gz')
        reference = json.loads(gzip.decompress(saved.read_bytes()))['reference']
        # It says that its messages are sentences of this server: none of its findings is `earlier`.
        self.assertIs(reference[readings.PHRASES], True)
        findings = reference['audit']['findings']
        broken = next(item for item in findings if item.get('target') == 'docs/falta.md')
        self.assertEqual((broken['message'], json.loads(broken[readings.PHRASE])), ('Target not found: docs/falta.md', {'phrase': 'Target not found: {raw}', 'params': {'raw': 'docs/falta.md'}}))
        self.assertTrue(all(type(item['message']) is str for item in findings))
        # A finding stays a flat record of scalars (the phrase is JSON text): the rule by which a server of an
        # earlier version validates a saved baseline, so going back to it keeps the baseline.
        self.assertTrue(all(readings._detail(value) for item in findings for value in item.values()))
        self.assertTrue(all(type(item.get(readings.PHRASE, '')) is str for item in findings))
        # Read back, a resolved finding still has its phrase: the interface words it in its language.
        entry = Path(self.project) / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8').replace('[quebrado](docs/falta.md)', 'nada'), encoding='utf-8')
        resolved = Workspace(self.state).snapshot()['delta']['findings']['resolved']
        self.assertEqual([(item['message'], item.get('messagePhrase')) for item in resolved if item['code'] == 'broken'],
                         [('Target not found: docs/falta.md', {'phrase': 'Target not found: {raw}', 'params': {'raw': 'docs/falta.md'}})])
        self.assertFalse(any(texts.is_text(value) for item in resolved for value in item.values()))
        self.assertFalse(any('earlier' in item for item in resolved))

    def test_only_a_baseline_that_says_so_has_messages_of_this_server(self):
        # `phrases` is true or the baseline is of an earlier server: anything else in its place, and its resolved
        # findings are `earlier`, whose message the interface never reads.
        workspace = Workspace(self.state)
        workspace.adopt_reference()
        saved = self.state / 'references' / (hashlib.sha256(self.project.encode()).hexdigest() + '.json.gz')
        document = json.loads(gzip.decompress(saved.read_bytes()))
        entry = Path(self.project) / 'AGENTS.md'
        entry.write_text(entry.read_text(encoding='utf-8').replace('[quebrado](docs/falta.md)', 'nada'), encoding='utf-8')
        for value, earlier in ((True, False), (1, True), ('true', True), (None, True)):
            with self.subTest(value=value):
                document['reference'][readings.PHRASES] = value
                saved.write_bytes(gzip.compress(json.dumps(document).encode()))
                delta = Workspace(self.state).snapshot()['delta']
                self.assertEqual(delta['roots'][0]['referenceOrigin'], 'persisted')
                resolved = [item for item in delta['findings']['resolved'] if item.get('target') == 'docs/falta.md']
                self.assertEqual([item.get('earlier', False) for item in resolved], [earlier])

    def test_a_phrase_tampered_with_in_a_saved_baseline_is_dropped_and_the_message_shows_as_saved(self):
        workspace = Workspace(self.state)
        workspace.adopt_reference()
        saved = self.state / 'references' / (hashlib.sha256(self.project.encode()).hexdigest() + '.json.gz')
        document = json.loads(gzip.decompress(saved.read_bytes()))
        findings = [item for item in document['reference']['audit']['findings'] if item['code'] in ('broken', 'unresolved-name')]
        self.assertEqual(len(findings), 3)
        for item, text in zip(findings, ('not json', '{"phrase": 5}', json.dumps({'phrase': 'x' * 9000}))):
            item[readings.PHRASE] = text
        saved.write_bytes(gzip.compress(json.dumps(document).encode()))
        entry = Path(self.project) / 'AGENTS.md'
        entry.write_text('# Projeto\n', encoding='utf-8')
        delta = Workspace(self.state).snapshot()['delta']
        self.assertEqual(delta['roots'][0]['referenceOrigin'], 'persisted')
        resolved = [item for item in delta['findings']['resolved'] if item['code'] in ('broken', 'unresolved-name')]
        self.assertEqual(len(resolved), 3)
        self.assertTrue(all(readings.PHRASE not in item and re.match(r'Target not found: |A name written without a folder ', item['message']) for item in resolved))
        # Control: a finding whose phrase was left alone still has it.
        self.assertTrue(any(readings.PHRASE in item for item in delta['findings']['resolved']))



class FindingsBeforeEnglishTests(unittest.TestCase):
    """The findings a baseline of the earlier server keeps (tests/findings_before_english.py), found again now."""

    def test_each_finding_of_a_baseline_of_the_earlier_server_is_found_again_by_its_id(self):
        from tests import findings_before_english
        from tests.server_pack import portuguese
        pairs = findings_before_english.pairs()
        self.assertEqual(len(pairs), 110)
        self.assertEqual([pair['before']['id'] for pair in pairs if pair['now'] is None], [])
        self.assertGreaterEqual({pair['before']['code'] for pair in pairs}, {
            'limit', 'unreadable', 'manifest', 'manifest-unchecked', 'analysis-partial', 'unverified', 'ambiguous', 'scope-unused-pattern'})
        # Saved in Portuguese, without a phrase; said now in English, with its phrase when it has parameters, and the
        # Portuguese pack gives back, word for word, what the earlier server saved.
        self.assertEqual([pair['before']['message'] for pair in pairs if 'messagePhrase' in pair['before'] or pair['before']['message'] == pair['now']['message']], [])
        self.assertEqual([(pair['before']['message'], pair['now']['message']) for pair in pairs
                          if portuguese(pair['now']['message'], pair['now'].get('messagePhrase')) != pair['before']['message']], [])
