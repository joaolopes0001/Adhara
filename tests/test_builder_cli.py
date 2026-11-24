"""Real CLI use on fresh filesystems, with independently written oracles."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPOSITORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY))
from tests.create_builder_lab import create_lab
from tests.create_audit_lab import fingerprint


class BuilderLabTests(unittest.TestCase):
    def test_new_destination_controls_outside_root_and_no_automatic_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='aae-builder-generator-') as folder:
            lab = create_lab(Path(folder) / 'lab')
            root = Path(lab['root'])
            self.assertTrue((root / 'noise/rascunho.md').exists())
            self.assertFalse((root / 'suite.json').exists())
            before = fingerprint(Path(lab['lab']))
            with self.assertRaises(FileExistsError):
                create_lab(lab['lab'])
            self.assertEqual(before, fingerprint(Path(lab['lab'])))
            linked = Path(folder) / 'linked'
            linked.symlink_to(lab['lab'], target_is_directory=True)
            with self.assertRaises(OSError):
                create_lab(linked / 'other')
            self.assertFalse((Path(lab['lab']) / 'other').exists())

    def test_protected_path_is_refused_before_any_access(self):
        with tempfile.TemporaryDirectory(prefix='aae-builder-protected-') as folder:
            protected = Path(folder) / 'protected'
            protected.mkdir()
            with patch.dict(os.environ, {'AAE_PROTECTED_PATHS': str(protected)}):
                with self.assertRaisesRegex(ValueError, 'AAE_PROTECTED_PATHS'):
                    create_lab(protected / 'new-builder-lab')
            self.assertEqual(list(protected.iterdir()), [])


class BuilderCLIUsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-builder-use-')
        self.folder = Path(self.temp.name)
        self.lab = create_lab(self.folder / 'lab')
        self.root = Path(self.lab['root'])

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args, code=0):
        result = subprocess.run([sys.executable, '-m', 'server.cli', *map(str, args)],
                                cwd=REPOSITORY, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        try:
            return json.loads(result.stdout)
        except ValueError:
            self.fail(f'CLI não produziu JSON: {result.stdout!r}; stderr={result.stderr!r}')

    def save(self, name, value):
        path = self.folder / name
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def test_audit_exposes_broken_repeated_links_and_directed_hop_limit(self):
        audit = self.cli('audit', '--root', self.root, '--suite', self.lab['suite'])
        codes = {finding['code'] for finding in audit['findings']}
        self.assertIn('broken', codes)
        self.assertFalse(any(code.startswith('scanner-') for code in codes))
        # Repetition is a structural signal counted in metrics, not a finding.
        self.assertNotIn('repeated-reference', codes)
        self.assertGreaterEqual(audit['metrics']['structure']['repeatedReferences'], 1)
        self.assertTrue(audit['paths'])
        self.assertTrue(all(path['found'] and path['hops'] == 1 for path in audit['paths']))
        suite = json.loads(Path(self.lab['suite']).read_text())
        suite['scenarios'][0]['maxHops'] = 0
        failed = self.cli('audit', '--root', self.root, '--suite', self.save('no-hop.json', suite), code=1)
        self.assertIn('hop-budget-exceeded', {finding['code'] for finding in failed['findings']})

    def test_suite_paths_cannot_escape_or_accept_ambiguous_spelling(self):
        original = json.loads(Path(self.lab['suite']).read_text())
        for path in ('../outside.md', '/etc/passwd', 'core/../core/contrato.md', 'core//contrato.md'):
            with self.subTest(path=path):
                suite = copy.deepcopy(original)
                suite['scenarios'][0]['required'][0]['path'] = path
                suite_file = self.save('invalid-suite.json', suite)
                self.cli('audit', '--root', self.root, '--suite', suite_file, code=2)

    def test_cli_json_input_rejects_duplicate_keys_and_nonfinite_numbers(self):
        for data in ('{"version":1,"version":1}', '{"version":NaN}'):
            with self.subTest(data=data):
                path = self.folder / 'bad.json'
                path.write_text(data)
                self.cli('audit', '--root', self.root, '--suite', path, code=2)

    def test_symlink_input_and_inventory_remain_incomplete_without_reading_target(self):
        outside = self.folder / 'outside-secret.txt'
        outside.write_text('SENTINELA_SINTETICA_FORA_DA_RAIZ')
        (self.root / 'linked.txt').symlink_to(outside)
        inventory = self.cli('inventory', '--root', self.root, code=3)
        self.assertTrue(inventory['partial'])
        self.assertNotIn('linked.txt', {record['path'] for record in inventory['files']})
        self.assertNotIn('SENTINELA_SINTETICA_FORA_DA_RAIZ', json.dumps(inventory))
        linked_suite = self.folder / 'linked-suite.json'
        linked_suite.symlink_to(self.lab['suite'])
        self.cli('audit', '--root', self.root, '--suite', linked_suite, code=2)


if __name__ == '__main__':
    unittest.main()
