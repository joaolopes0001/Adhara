"""CLI boundary: structured errors, the launcher, the installed copy and the read-only command set."""
import argparse
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tests.create_builder_lab import create_lab
from scripts import install
from server import cli


class CLIContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-cli-contract-')
        self.folder = Path(self.temp.name)
        self.lab = create_lab(self.folder / 'lab')
        self.base = ['--root', self.lab['root'], '--suite', self.lab['suite']]

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli.main(arguments)
        return code, json.loads(output.getvalue())

    def write(self, name, value):
        path = self.folder / name
        path.write_text(json.dumps(value))
        return str(path)

    def test_invalid_json_arguments_and_special_files_return_structured_errors(self):
        for arguments in [[], ['missing-command'], ['audit']]:
            self.assertEqual(self.invoke(arguments)[0], 2)
        path = self.folder / 'bad.json'
        for text in ['{"x":1,"x":2}', 'NaN', '{"secret": invalid}', '[' * 2000]:
            path.write_text(text)
            code, report = self.invoke(['audit', '--root', self.lab['root'], '--suite', str(path)])
            self.assertEqual(code, 2)
            self.assertNotIn('secret', json.dumps(report))
        link = self.folder / 'linked.json'
        link.symlink_to(self.lab['suite'])
        self.assertEqual(self.invoke(['audit', '--root', self.lab['root'], '--suite', str(link)])[0], 2)

    def test_launcher_preserves_callers_relative_paths_outside_repository(self):
        launcher = Path(__file__).resolve().parents[1] / 'scripts/aae.py'
        result = subprocess.run([sys.executable, str(launcher), 'audit', '--root', 'lab/atlas', '--suite', 'lab/suite.json'],
                                cwd=self.folder, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual((report['kind'], report['roots'][0]['path']), ('audit', str(self.folder / 'lab/atlas')))

    def test_installer_adds_headless_launcher_and_preserves_existing_state(self):
        # Use only a new synthetic installation; never modify the personal install.
        source = self.folder / 'source'
        repository = Path(__file__).resolve().parents[1]
        (source / 'dist').mkdir(parents=True)
        (source / 'dist/index.html').write_text('<!doctype html><title>Synthetic</title>')
        (source / 'scripts').mkdir()
        (source / 'public').mkdir()
        (source / 'public/icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        for name in ('launch.py', 'aae.py'):
            shutil.copy2(repository / 'scripts' / name, source / 'scripts' / name)
        shutil.copytree(repository / 'server', source / 'server', ignore=shutil.ignore_patterns('__pycache__'))
        dest, apps, binary = [self.folder / name for name in ('installed', 'applications', 'bin')]
        (dest / 'state').mkdir(parents=True)
        state = dest / 'state/workspace.json'
        state.write_text('{"synthetic":true}')
        protected_list = dest / 'state/protected-paths.txt'
        protected_list.write_text('# synthetic\n')
        # Leftovers of an older installation must not survive an update.
        stale = [dest / 'dist/assets/index-old.css', dest / 'server/obsolete.py']
        for path in stale:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('old build')
        with patch.multiple(install, SOURCE=source, DEST=dest, APPLICATIONS=apps, BIN=binary), \
                patch.object(install.shutil, 'which', return_value=None), \
                contextlib.redirect_stdout(io.StringIO()):
            install.main([])
        self.assertEqual(state.read_text(), '{"synthetic":true}')
        self.assertEqual(protected_list.read_text(), '# synthetic\n')
        self.assertEqual([path for path in stale if path.exists()], [])
        self.assertTrue((dest / 'dist/index.html').is_file())
        self.assertTrue((dest / 'server/main.py').is_file())
        self.assertEqual(sorted(path.name for path in dest.iterdir()), ['aae.py', 'dist', 'icon.svg', 'launch.py', 'server', 'state'])
        self.assertTrue(os.access(binary / 'aae', os.X_OK))
        result = subprocess.run([str(binary / 'aae'), 'audit', '--root', 'lab/atlas', '--suite', 'lab/suite.json'],
                                cwd=self.folder, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(state.read_text(), '{"synthetic":true}')


class CLIStaysReadOnlyTests(unittest.TestCase):
    """Editing belongs to the app, behind a grant the user gives per project: the CLI gains no command that writes."""

    COMMANDS = {'protected', 'schema', 'audit', 'compare-audit', 'freeze', 'inventory'}
    # These commands are not part of this CLI.
    REMOVED = ('experiment', 'preview', 'replay', 'summarize', 'compare', 'compare-inventory')

    def test_the_commands_are_the_same(self):
        commands = next(action for action in cli.parser()._actions if isinstance(action, argparse._SubParsersAction))
        self.assertEqual(set(commands.choices), self.COMMANDS)

    def test_the_cli_never_loads_the_write_core(self):
        source = Path(cli.__file__).read_text(encoding='utf-8')
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module or '')
                imported.update(alias.name for alias in node.names)
        self.assertFalse({name for name in imported if 'editing' in name}, imported)
        # Nor through what it imports.
        root = Path(cli.__file__).resolve().parents[1]
        loaded = subprocess.run([sys.executable, '-I', '-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import server.cli; '
                                 'print(sorted(name for name in sys.modules if "editing" in name))', str(root)],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(loaded.returncode, 0, loaded.stderr)
        self.assertEqual(loaded.stdout.strip(), '[]')

    def test_removed_commands_are_invalid_input(self):
        for name in self.REMOVED:
            with self.subTest(command=name):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    code = cli.main([name, '--root', '/nonexistent'])
                report = json.loads(output.getvalue())
                self.assertEqual((code, report['kind'], report['findings'][0]['code']), (2, 'error', 'invalid-input'))
                self.assertIn(f"invalid choice: '{name}'", report['findings'][0]['message'])

    def test_the_cli_never_loads_the_modules_of_removed_commands(self):
        root = Path(cli.__file__).resolve().parents[1]
        loaded = subprocess.run([sys.executable, '-I', '-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import server.cli; '
                                 'print(sorted(name for name in sys.modules if name.rsplit(".", 1)[-1] in {"evaluation", "benchmark", "experiment"}))', str(root)],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(loaded.returncode, 0, loaded.stderr)
        self.assertEqual(loaded.stdout.strip(), '[]')


if __name__ == '__main__':
    unittest.main()
