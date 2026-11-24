"""AAE_PROTECTED_PATHS and protected-paths.txt: configuration, aliases and refusals without writing, on temporary files only."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'server'))
sys.path.insert(0, str(REPO))
import doc_snapshot
from scripts import launch
import main as server_main
import protected
from protected import ENVIRONMENT, STATE_FILE, configure_state_dir, default_state_dir, is_protected, protected_paths
from scanner import scan
from workspace import Workspace, create_directory
from tests.server_pack import portuguese


def tree(root):
    return sorted(str(path.relative_to(root)) for path in root.rglob('*'))


class Fixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-protected-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.protected = self.base / 'protected'
        self.protected.mkdir()
        (self.protected / 'AGENTS.md').write_text('# Protegido\n', encoding='utf-8')
        self.other = self.base / 'other'
        self.other.mkdir()
        # Hermetic: the state comes from a temporary directory, never from the user's default one.
        self.state = self.base / 'state'
        self.state.mkdir()
        configure_state_dir(self.state)
        self.addCleanup(configure_state_dir, None)

    def configure(self, value):
        return patch.dict(os.environ, {ENVIRONMENT: value})

    def listing(self, *lines, state=None):
        target = (state or self.state) / STATE_FILE
        target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        return target

    def unconfigured(self):
        environment = {key: value for key, value in os.environ.items() if key != ENVIRONMENT}
        return patch.dict(os.environ, environment, clear=True)


class ProtectedPathsTests(Fixture, unittest.TestCase):
    def test_absent_or_blank_variable_protects_nothing(self):
        with self.unconfigured():
            self.assertEqual(protected_paths(), frozenset())
            self.assertFalse(is_protected(self.protected))
        for value in ['', os.pathsep, f' {os.pathsep}  {os.pathsep}']:
            with self.subTest(value=value), self.configure(value):
                self.assertEqual(protected_paths(), frozenset())
                self.assertFalse(is_protected(self.protected / 'AGENTS.md'))

    def test_several_entries_and_empty_entries_between_them(self):
        second = self.base / 'second'
        second.mkdir()
        value = os.pathsep.join(['', str(self.protected), '', str(second), ''])
        with self.configure(value):
            for path in [self.protected, self.protected / 'AGENTS.md', second, second / 'new' / 'deep']:
                with self.subTest(path=path):
                    self.assertTrue(is_protected(path))
            for path in [self.other, self.base, self.base / 'protected-sibling', self.base / 'second2']:
                with self.subTest(path=path):
                    self.assertFalse(is_protected(path))

    def test_tilde_is_expanded_from_the_home_directory(self):
        with patch.dict(os.environ, {'HOME': str(self.base), ENVIRONMENT: '~/protected'}):
            self.assertIn(self.protected, protected_paths())
            self.assertTrue(is_protected(self.protected / 'new'))
            self.assertFalse(is_protected(self.other))

    def test_symlink_alias_into_a_protected_path_is_protected(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.protected, target_is_directory=True)
        with self.configure(str(self.protected)):
            self.assertTrue(is_protected(alias))
            self.assertTrue(is_protected(alias / 'AGENTS.md'))
            self.assertTrue(is_protected(alias / 'missing' / 'new'))
        # A protected entry that is itself a link also protects its real target.
        with self.configure(str(alias)):
            self.assertTrue(is_protected(self.protected / 'AGENTS.md'))
            self.assertTrue(is_protected(alias / 'AGENTS.md'))
            self.assertFalse(is_protected(self.other))

    def test_relative_entry_fails_closed_without_writing(self):
        for value in ['relativo', os.pathsep.join([str(self.other), 'relativo/pasta'])]:
            with self.subTest(value=value), self.configure(value):
                with self.assertRaisesRegex(ValueError, 'absolute'):
                    protected_paths()
                with self.assertRaisesRegex(ValueError, 'absolute'):
                    is_protected(self.other)
                with self.assertRaisesRegex(ValueError, 'absolute'):
                    Workspace(self.other / 'state')
                with self.assertRaisesRegex(ValueError, 'absolute'):
                    create_directory({'parent': str(self.other), 'name': 'new-agent',
                                      'primitives': [{'name': 'worker', 'type': 'agent'}]})
                self.assertEqual(tree(self.other), [])


class ProtectedOperationsTests(Fixture, unittest.TestCase):
    payload = {'name': 'new-agent', 'primitives': [{'name': 'worker', 'type': 'agent'}]}

    def test_creation_and_state_inside_protected_path_are_refused_without_writes(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.protected, target_is_directory=True)
        before = tree(self.protected)
        with self.configure(str(self.protected)):
            for parent in [self.protected, alias]:
                with self.subTest(parent=parent):
                    with self.assertRaisesRegex(ValueError, ENVIRONMENT):
                        create_directory({**self.payload, 'parent': str(parent)})
                    with self.assertRaisesRegex(ValueError, ENVIRONMENT):
                        Workspace(parent / 'state')
            # The destination itself may be the protected path.
            (self.other / 'new-agent').mkdir()
            with self.configure(str(self.other / 'new-agent')), self.assertRaisesRegex(ValueError, 'protected by'):
                create_directory({**self.payload, 'parent': str(self.other)})
        self.assertEqual(tree(self.protected), before)
        self.assertEqual(tree(self.other), ['new-agent'])

    def test_without_the_variable_creation_in_a_new_destination_works(self):
        with self.unconfigured():
            created = Path(create_directory({**self.payload, 'parent': str(self.protected)}))
            Workspace(self.other / 'state')
        self.assertEqual(created, self.protected / 'new-agent')
        self.assertTrue((created / 'AGENTS.md').is_file())
        self.assertTrue((self.other / 'state').is_dir())

    def test_snapshot_refuses_protected_root_and_omits_protected_files(self):
        root = self.base / 'project'
        (root / 'private').mkdir(parents=True)
        (root / 'AGENTS.md').write_text('# Agent\n[Rules](rules.md)\n[Private](private/notes.md)\n')
        (root / 'rules.md').write_text('# Rules\n')
        (root / 'private' / 'notes.md').write_text('# Private\n')
        model = scan([str(root)])
        payload = {'root': str(root), 'entry': str(root / 'AGENTS.md')}
        with self.configure(str(root)), self.assertRaisesRegex(ValueError, ENVIRONMENT):
            doc_snapshot.build_snapshot(model, payload)
        with self.configure(str(root / 'private')):
            snapshot = doc_snapshot.build_snapshot(model, payload)
        self.assertIn('rules.md', snapshot['documents'])
        self.assertNotIn('private/notes.md', snapshot['documents'])
        with self.unconfigured():
            self.assertIn('private/notes.md', doc_snapshot.build_snapshot(model, payload)['documents'])


class StateFileTests(Fixture, unittest.TestCase):
    payload = {'name': 'new-agent', 'primitives': [{'name': 'worker', 'type': 'agent'}]}

    def test_missing_file_contributes_nothing(self):
        with self.unconfigured():
            self.assertEqual(protected_paths(), frozenset())
            self.assertFalse(is_protected(self.protected))

    def test_comments_blank_lines_and_surrounding_whitespace(self):
        second = self.base / 'second'
        second.mkdir()
        self.listing('# comentário', '', '   ', f'   {self.protected}   ', f'  # {self.other}', f'\t{second}\t')
        with self.unconfigured():
            self.assertTrue(is_protected(self.protected / 'AGENTS.md'))
            self.assertTrue(is_protected(second / 'x'))
            self.assertFalse(is_protected(self.other), 'linha comentada não protege')
            self.assertFalse(is_protected(self.base))  # Control: a path not listed stays allowed.

    def test_byte_order_mark_and_crlf_are_tolerated(self):
        (self.state / STATE_FILE).write_bytes(b'\xef\xbb\xbf' + f'{self.protected}\r\n'.encode())
        with self.unconfigured():
            self.assertTrue(is_protected(self.protected / 'AGENTS.md'))

    def test_tilde_is_expanded(self):
        self.listing('~/protected')
        with patch.dict(os.environ, {'HOME': str(self.base)}):
            self.assertIn(self.protected, protected_paths({}))
            self.assertTrue(is_protected(self.protected / 'new', {}))
            self.assertFalse(is_protected(self.other, {}))

    def test_relative_entry_fails_closed_naming_the_file_and_line(self):
        self.listing(str(self.other), 'relativo/pasta')
        with self.unconfigured():
            for call in (protected_paths, lambda: is_protected(self.other)):
                with self.assertRaisesRegex(ValueError, rf'{STATE_FILE}.*line 2.*absolute'):
                    call()
            with self.assertRaisesRegex(ValueError, 'absolute'):
                create_directory({**self.payload, 'parent': str(self.other)})
        self.assertEqual(tree(self.other), [])

    def test_unreadable_file_fails_closed(self):
        target = self.listing(str(self.protected))
        target.chmod(0)
        self.addCleanup(target.chmod, 0o600)
        if os.access(target, os.R_OK):
            self.skipTest('o usuário atual ignora permissões de arquivo')
        with self.unconfigured(), self.assertRaisesRegex(ValueError, STATE_FILE):
            is_protected(self.other)

    def test_directory_in_place_of_the_file_fails_closed(self):
        (self.state / STATE_FILE).mkdir()
        with self.unconfigured(), self.assertRaisesRegex(ValueError, STATE_FILE):
            is_protected(self.other)
        with self.unconfigured(), self.assertRaisesRegex(ValueError, STATE_FILE):
            create_directory({**self.payload, 'parent': str(self.other)})
        self.assertEqual(tree(self.other), [])

    def test_broken_symlink_in_place_of_the_file_fails_closed(self):
        (self.state / STATE_FILE).symlink_to(self.base / 'nao-existe')
        with self.unconfigured(), self.assertRaisesRegex(ValueError, STATE_FILE):
            is_protected(self.other)

    def test_undecodable_and_null_bytes_fail_closed(self):
        for content in [b'\xff\xfe\x00/tmp\n', b'/tmp/ok\n\xc3\x28\n', b'/tmp/a\x00b\n']:
            with self.subTest(content=content):
                (self.state / STATE_FILE).write_bytes(content)
                with self.unconfigured(), self.assertRaisesRegex(ValueError, STATE_FILE):
                    is_protected(self.other)

    def test_oversized_file_fails_closed(self):
        (self.state / STATE_FILE).write_bytes(b'#' * (protected.MAX_FILE_BYTES + 1))
        with self.unconfigured(), self.assertRaisesRegex(ValueError, STATE_FILE):
            is_protected(self.other)

    def test_union_with_the_environment_variable(self):
        self.listing(str(self.protected))
        with self.configure(str(self.other)):
            self.assertTrue(is_protected(self.protected / 'AGENTS.md'))
            self.assertTrue(is_protected(self.other / 'x'))
            self.assertFalse(is_protected(self.base / 'free'))
        with self.configure('relativo'), self.assertRaisesRegex(ValueError, ENVIRONMENT):
            is_protected(self.protected)

    def test_symlink_alias_into_a_listed_path_is_protected(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.protected, target_is_directory=True)
        self.listing(str(self.protected))
        with self.unconfigured():
            for path in [alias, alias / 'AGENTS.md', alias / 'missing' / 'new']:
                with self.subTest(path=path):
                    self.assertTrue(is_protected(path))
        self.listing(str(alias))  # An entry that is a link also protects the real target.
        with self.unconfigured():
            self.assertTrue(is_protected(self.protected / 'AGENTS.md'))
            self.assertFalse(is_protected(self.other))

    def test_edit_takes_effect_without_restart(self):
        with self.unconfigured():
            self.assertFalse(is_protected(self.protected))
            self.listing(str(self.protected))
            self.assertTrue(is_protected(self.protected))
            self.listing('# nada')
            self.assertFalse(is_protected(self.protected))
            (self.state / STATE_FILE).write_text('relativo\n')  # Breaking the file while running refuses, never allows.
            with self.assertRaises(ValueError):
                is_protected(self.protected)
            (self.state / STATE_FILE).unlink()
            self.assertFalse(is_protected(self.protected))

    def default_state(self):
        """The default state directory is inside the temporary HOME of the suite (never the real one)."""
        directory = self.base / 'home' / '.local/share/agent-architecture-explorer/state'
        directory.mkdir(parents=True)
        return directory

    def test_three_sources_are_summed_and_the_default_is_one_definition(self):
        home = self.base / 'home'
        other_state = self.base / 'other-state'
        other_state.mkdir()
        default = self.default_state()
        configured_target, default_target, env_target = (self.base / name for name in ('c', 'd', 'e'))
        for target in (configured_target, default_target, env_target):
            target.mkdir()
        self.listing(str(configured_target))
        self.listing(str(default_target), state=default)
        self.listing(str(self.protected), state=other_state)
        with patch.dict(os.environ, {'HOME': str(home), ENVIRONMENT: str(env_target)}):
            for target in (configured_target, default_target, env_target):
                with self.subTest(target=target):
                    self.assertTrue(is_protected(target / 'x'))
            self.assertFalse(is_protected(self.protected), 'o arquivo de um estado não configurado não vale')
            self.assertFalse(is_protected(self.other))  # Control: not listed.
            configure_state_dir(other_state)
            self.assertTrue(is_protected(self.protected))
            self.assertTrue(is_protected(default_target), 'o arquivo do estado padrão vale sempre')
            self.assertFalse(is_protected(configured_target), 'o estado anterior deixou de ser o configurado')
            sources = {source.name: len(source.entries) for source in protected.sources()}
            self.assertEqual(sources[ENVIRONMENT], 1)
            self.assertEqual(sources[str(default / STATE_FILE)], 1)
            self.assertEqual(sources[str(other_state / STATE_FILE)], 1)
            self.assertEqual(default_state_dir(), home / '.local/share/agent-architecture-explorer/state')
        self.assertEqual(server_main.default_state_dir, default_state_dir)

    def test_broken_default_file_stops_even_with_another_state_configured(self):
        default = self.default_state()
        (default / STATE_FILE).write_text('relativo\n')
        with patch.dict(os.environ, {'HOME': str(self.base / 'home')}), self.assertRaisesRegex(ValueError, 'line 1'):
            is_protected(self.other)

    def test_configure_state_dir_resolves_against_the_current_directory_once(self):
        previous = os.getcwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.base)
        configure_state_dir('state')
        os.chdir(self.other)
        self.listing(str(self.protected))
        self.assertTrue(is_protected(self.protected))

    def test_workspace_and_creation_refuse_paths_listed_in_its_state_file(self):
        (self.other / 'new-agent').mkdir()
        (self.base / 'state-refused').mkdir()
        self.listing(str(self.protected), str(self.other / 'new-agent'), str(self.base / 'state-refused'))
        before = tree(self.protected)
        with self.unconfigured():
            with self.assertRaisesRegex(ValueError, STATE_FILE):
                Workspace(self.protected / 'state')
            with self.assertRaisesRegex(ValueError, STATE_FILE):
                Workspace(self.base / 'state-refused')
            with self.assertRaisesRegex(ValueError, STATE_FILE):
                create_directory({**self.payload, 'parent': str(self.protected)})
            with self.assertRaisesRegex(ValueError, STATE_FILE):  # The destination itself is listed.
                create_directory({**self.payload, 'parent': str(self.other)})
            # Control: a parent not listed stays allowed.
            free = self.base / 'free'
            free.mkdir()
            created = Path(create_directory({**self.payload, 'parent': str(free)}))
            Workspace(self.base / 'state-ok')
        self.assertTrue((created / 'AGENTS.md').is_file())
        self.assertEqual(tree(self.protected), before)
        self.assertEqual(tree(self.other), ['new-agent'])
        self.assertEqual(tree(self.base / 'state-refused'), [])

    def test_snapshot_refuses_root_and_omits_files_listed_in_the_state_file(self):
        root = self.base / 'project'
        (root / 'private').mkdir(parents=True)
        (root / 'AGENTS.md').write_text('# Agent\n[Rules](rules.md)\n[Private](private/notes.md)\n')
        (root / 'rules.md').write_text('# Rules\n')
        (root / 'private' / 'notes.md').write_text('# Private\n')
        model = scan([str(root)])
        payload = {'root': str(root), 'entry': str(root / 'AGENTS.md')}
        with self.unconfigured():
            self.listing(str(root))
            with self.assertRaisesRegex(ValueError, STATE_FILE):
                doc_snapshot.build_snapshot(model, payload)
            self.listing(str(root / 'private'))
            documents = doc_snapshot.build_snapshot(model, payload)['documents']
            self.assertIn('rules.md', documents)
            self.assertNotIn('private/notes.md', documents)
            self.listing('relativo')  # A broken file: the snapshot is refused.
            with self.assertRaisesRegex(ValueError, STATE_FILE):
                doc_snapshot.build_snapshot(model, payload)

    def test_startup_failure_is_a_clean_system_exit(self):
        broken = self.base / 'broken-state'
        broken.mkdir()
        (broken / STATE_FILE).write_text('relativo\n')
        with self.unconfigured(), patch.object(sys, 'argv', ['main.py', '--state-dir', str(broken), '--port', '0']):
            with self.assertRaises(SystemExit) as caught:
                server_main.main()
        self.assertIsInstance(caught.exception.code, str)
        self.assertIn(STATE_FILE, caught.exception.code)
        self.assertIn('did not start', caught.exception.code)
        # The same holds when the state itself is listed in the file.
        listed = self.base / 'listed-state'
        listed.mkdir()
        (listed / STATE_FILE).write_text(f'{listed}\n')
        with self.unconfigured(), patch.object(sys, 'argv', ['main.py', '--state-dir', str(listed), '--port', '0']):
            with self.assertRaisesRegex(SystemExit, STATE_FILE):
                server_main.main()

    def test_re_reading_is_cheap_for_the_snapshot_loop(self):
        entries = [self.base / f'entry-{index}' for index in range(20)]
        for entry in entries:
            entry.mkdir()
        self.listing(*map(str, entries))
        candidate = self.other / 'deep' / 'file.md'
        with self.unconfigured():
            start = time.perf_counter()
            for _ in range(200):
                is_protected(candidate)
            elapsed = time.perf_counter() - start
        self.assertLess(elapsed, 5.0, f'200 consultas levaram {elapsed:.3f}s')


class EntryValidationTests(Fixture, unittest.TestCase):
    """A line that looks like a path and protects nothing is an error, never silently dropped."""

    def check_refused(self, content, pattern, was=None):
        """The file with `content` is refused with a sentence that matches `pattern`; `was`: what the sentence
        matched when the server wrote Portuguese, which a Portuguese interface still shows."""
        (self.state / STATE_FILE).write_bytes(content if isinstance(content, bytes) else content.encode())
        with self.assertRaisesRegex(ValueError, pattern) as caught:
            is_protected(self.other)
        if was is not None:
            self.assertRegex(portuguese(caught.exception.args[0]), was)

    def test_file_lines_that_would_protect_nothing_are_refused(self):
        secret = self.protected
        cases = {
            'comentário no fim da linha': f'{secret}   # privado\n',
            'comentário após tab': f'{secret}\t# privado\n',
            'sintaxe da variável a:b': f'{secret}:{self.other}\n',
            'glob /*': f'{secret}/*\n',
            'glob /**': f'{secret}/**\n',
            'glob ?': f'{secret}/?\n',
            'glob [': f'{secret}/[a]\n',
            'aspas duplas': f'"{secret}"\n',
            'aspas simples': f"'{secret}'\n",
            'barra invertida': f'{secret}\\ x\n',
            'espaço de largura zero no fim': f'{secret}\u200b\n',
            'caractere de controle': f'{secret}\x07\n',
            'caminho que não existe': f'{self.base}/nao-existe\n',
            'erro de digitação': f'{self.base}/protectd\n',
            'dois caminhos na linha': f'{secret} {self.other}\n',
        }
        for label, content in cases.items():
            with self.subTest(label):
                self.check_refused(content, rf'{STATE_FILE}.*line 1', rf'{STATE_FILE}.*linha 1')

    def test_the_error_points_at_the_suspect_character(self):
        for content, hint, was in [(f'{self.protected}  # nota\n', '# after a space', '# após espaço'),
                                   (f'{self.protected}:{self.other}\n', 'two paths', 'dois caminhos'),
                                   (f'{self.protected}/*\n', 'glob', 'glob'), (f'{self.protected}\u200b\n', 'U+200B', 'U+200B'),
                                   (f'"{self.protected}"\n', 'quotes', 'aspas')]:
            with self.subTest(hint=hint):
                self.check_refused(content, f'likely cause: .*{re.escape(hint)}', f'provável causa: .*{re.escape(was)}')
        # No suspect character: no hint.
        self.check_refused(f'{self.base}/protectd\n', 'does not exist\\. Fix', 'não existe\\. Corrija')

    def test_existing_names_with_unusual_characters_are_protected(self):
        names = ["Olho d'água", '[2024] Projeto', 'Projeto #2', 'smb-share:server=nas,share=docs', 'família \U0001F468\u200d\U0001F469\u200d\U0001F467']
        for name in names:
            directory = self.base / name
            directory.mkdir()
            (directory / 'AGENTS.md').write_text('# x\n')
            with self.subTest(name=name, source='arquivo'):
                (self.state / STATE_FILE).write_text(f'{directory}\n', encoding='utf-8')
                self.assertTrue(is_protected(directory / 'AGENTS.md'))
                self.assertFalse(is_protected(self.other))  # Control: not listed.
            if os.pathsep not in name:
                with self.subTest(name=name, source='variável'), self.configure(str(directory)):
                    (self.state / STATE_FILE).unlink()
                    self.assertTrue(is_protected(directory / 'AGENTS.md'))

    def test_the_error_names_the_line_number(self):
        self.check_refused(f'{self.protected}\n\n# ok\n{self.base}/falta\n', 'line 4', 'linha 4')

    def test_hash_inside_a_name_without_a_space_before_is_a_valid_path(self):
        odd = self.base / 'projeto#1'
        odd.mkdir()
        (self.state / STATE_FILE).write_text(f'{odd}\n')
        self.assertTrue(is_protected(odd / 'x'))
        self.assertFalse(is_protected(self.other))  # Control.

    def test_broken_symlink_entry_counts_as_existing(self):
        dangling = self.base / 'dangling'
        dangling.symlink_to(self.base / 'ninguem')
        (self.state / STATE_FILE).write_text(f'{dangling}\n')
        self.assertTrue(is_protected(dangling))

    def test_the_variable_has_the_same_rules_with_the_source_named(self):
        for value in [str(self.base / 'nao-existe'), f'"{self.protected}"', f'{self.protected}/*', f'{self.protected}\u200b',
                      f'{self.protected} # c', f'{self.protected}{os.pathsep}{self.base}/falta']:
            with self.subTest(value=value), self.configure(value), self.assertRaisesRegex(ValueError, ENVIRONMENT):
                is_protected(self.other)

    def test_fifo_device_and_broken_link_in_place_of_the_file_fail_without_blocking(self):
        target = self.state / STATE_FILE
        os.mkfifo(target)
        code = ('import sys; sys.path.insert(0, sys.argv[1]); import protected; protected.configure_state_dir(sys.argv[2]); '
                'protected.is_protected(sys.argv[3])')
        for label, prepare in [('fifo', lambda: None), ('dispositivo', lambda: (target.unlink(), target.symlink_to('/dev/null')))]:
            prepare()
            with self.subTest(label):
                result = subprocess.run([sys.executable, '-I', '-c', code, str(REPO / 'server'), str(self.state), str(self.other)],
                                        capture_output=True, text=True, timeout=10, env={'HOME': str(self.base)})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('regular text file', result.stderr)
        target.unlink()
        real = self.base / 'real.txt'
        real.write_text(f'{self.protected}\n')
        target.symlink_to(real)  # A link to a regular file still counts.
        self.assertTrue(is_protected(self.protected / 'AGENTS.md'))


class ProtectionIntegrationTests(Fixture, unittest.TestCase):
    payload = {'name': 'new-agent', 'primitives': [{'name': 'worker', 'type': 'agent'}]}

    def project(self):
        root = self.base / 'project'
        (root / 'private').mkdir(parents=True)
        (root / 'AGENTS.md').write_text('# Agent\n[Rules](rules.md)\n[Private](private/notes.md)\n')
        (root / 'rules.md').write_text('# Rules\n')
        (root / 'private' / 'notes.md').write_text('# Private\n')
        return root

    def test_workspace_does_not_write_when_the_state_becomes_protected_or_the_file_breaks(self):
        root = self.base / 'root'
        root.mkdir()
        (root / 'AGENTS.md').write_text('# a\n')
        with self.unconfigured():
            workspace = Workspace(self.state)
            workspace.open(str(root))
            note = str(root / 'AGENTS.md')
            workspace.note(note, 'antes')  # Control: saves normally.
            saved = (self.state / 'workspace.json').read_text()
            for content in [f'{self.state}\n', 'relativo\n']:
                with self.subTest(content=content):
                    self.listing(content.strip())
                    with self.assertRaises(ValueError):
                        workspace.note(note, 'depois')
                    self.assertEqual((self.state / 'workspace.json').read_text(), saved)
                    with self.assertRaises(ValueError):
                        workspace.save()
            self.listing('# nada')
            workspace.note(note, 'de novo')

    def test_cli_protected_lists_effective_entries_and_fails_when_broken(self):
        home = self.base / 'home'
        default = home / '.local/share/agent-architecture-explorer/state'
        default.mkdir(parents=True)
        (default / STATE_FILE).write_text(f'# pessoal\n{self.protected}\n')
        base_env = {'HOME': str(home), 'PATH': os.environ.get('PATH', '')}

        def run(**extra):
            result = subprocess.run([sys.executable, '-B', '-m', 'server.cli', 'protected'], cwd=REPO, capture_output=True,
                                    text=True, timeout=20, env={**base_env, **extra})
            return result.returncode, json.loads(result.stdout)

        code, report = run(AAE_PROTECTED_PATHS=str(self.other))
        self.assertEqual((code, report['kind'], report['status']), (0, 'protected', 'pass'))
        self.assertEqual({(entry['path'], entry['source']) for entry in report['entries']},
                         {(str(self.other), ENVIRONMENT), (str(self.protected), str(default / STATE_FILE))})
        self.assertEqual([source['entries'] for source in report['sources']], [1, 1])
        code, report = run()  # Control: without the variable, only the file.
        self.assertEqual((code, [entry['path'] for entry in report['entries']]), (0, [str(self.protected)]))
        (default / STATE_FILE).write_text(f'{self.protected}\nnao-existe\n')
        code, report = run()
        self.assertEqual((code, report['kind'], report['status']), (2, 'error', 'error'))
        self.assertRegex(report['findings'][0]['message'], 'line 2')
        code, report = run(AAE_PROTECTED_PATHS=f'{self.base}/falta')
        self.assertEqual(code, 2)

    def test_server_logs_the_sources_read_and_their_entry_counts(self):
        home = self.base / 'home'
        home.mkdir()
        (self.state / STATE_FILE).write_text(f'{self.protected}\n{self.other}\n')
        static = self.base / 'static'
        static.mkdir()
        env = {'HOME': str(home), 'PATH': os.environ.get('PATH', '')}
        process = subprocess.Popen([sys.executable, '-I', str(REPO / 'server/main.py'), '--port', '0', '--state-dir', str(self.state),
                                    '--static-dir', str(static)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        try:
            self.assertIn('http://127.0.0.1:', process.stdout.readline())
            line = process.stdout.readline()
        finally:
            process.terminate()
            process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
        self.assertIn('Protected paths:', line)
        self.assertIn(f'{self.state / STATE_FILE}: 2 entries', line)
        self.assertIn(f'{ENVIRONMENT}: absent', line)

    def test_launcher_ignores_lines_of_a_previous_run(self):
        log = self.base / 'server.log'
        log.write_text('Agent Architecture Explorer did not start: an earlier run.\n')
        with log.open('a') as handle:
            start = handle.tell()
            handle.write('nova linha\n\n')
        self.assertEqual(start, len('Agent Architecture Explorer did not start: an earlier run.\n'.encode()))
        self.assertEqual(launch.last_log_line(log, start), 'nova linha')
        with log.open('a') as handle:  # A run without output: nothing of the previous one shows.
            start = handle.tell()
        self.assertEqual(launch.last_log_line(log, start), '')

    def test_state_directory_reached_through_a_symlink_is_listed_once(self):
        real = self.base / 'real-home'
        (real / '.local/share/agent-architecture-explorer/state').mkdir(parents=True)
        (self.base / 'link-home').symlink_to(real, target_is_directory=True)
        configure_state_dir(real / '.local/share/agent-architecture-explorer/state')
        with patch.dict(os.environ, {'HOME': str(self.base / 'link-home')}):
            names = [source.name for source in protected.sources({})]
        self.assertEqual(len(names), 2, names)  # The variable and a single file.

    def test_launcher_reports_the_last_non_empty_log_line(self):
        log = self.base / 'server.log'
        log.write_text('old\nAgent Architecture Explorer did not start: protected-paths.txt (line 2): the path x does not exist.\n\n  \n')
        self.assertIn('line 2', launch.last_log_line(log))
        self.assertEqual(launch.last_log_line(self.base / 'ausente.log'), '')

    def test_creation_reads_the_configuration_once_per_operation(self):
        self.listing(str(self.protected))
        with self.unconfigured(), patch.object(protected, 'sources', wraps=protected.sources) as read:
            self.assertEqual(Path(create_directory({**self.payload, 'parent': str(self.other)})).name, 'new-agent')
        self.assertEqual(read.call_count, 1)


if __name__ == '__main__':
    unittest.main()
