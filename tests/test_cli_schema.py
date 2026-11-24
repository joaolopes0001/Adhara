"""The discovery contract must be executable by a builder without guessing fields."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from server import cli, suite_contract

REPO = Path(__file__).resolve().parents[1]


class CliSchemaTests(unittest.TestCase):
    def command(self, *arguments):
        result = subprocess.run([sys.executable, '-B', str(REPO / 'scripts/aae.py'), *arguments], cwd=REPO,
                                capture_output=True, text=True, timeout=10)
        return result.returncode, json.loads(result.stdout)

    def test_schema_is_pure_json_and_examples_roundtrip(self):
        code, schema = self.command('schema')
        self.assertEqual(code, 0)
        self.assertEqual((schema['kind'], schema['version'], schema['cliVersion']), ('schema', 2, cli.VERSION))
        self.assertEqual(schema['reportVersions'], cli.REPORT_VERSIONS)
        self.assertEqual(schema['exitCodes'], cli.EXIT_CODES)
        self.assertEqual(set(schema['comparisonContract']), {'compare-audit', 'contractHash'})
        self.assertEqual(set(schema['workflow']), {'audit', 'overhaul'})
        self.assertEqual([step.split('.')[0] for step in schema['workflow']['overhaul']], ['1', '2', '3', '4'])
        self.assertNotIn('actionsContract', schema)
        self.assertEqual(set(schema['examples']), {'files', 'suite', 'frozenRequirement', 'cli'})
        # Every documented invocation names a command the CLI has.
        self.assertEqual({line.split()[1] for line in schema['examples']['cli']} - set(schema['commands']), set())
        examples = schema['examples']
        suite_contract.validate_suite(examples['suite'])
        with tempfile.TemporaryDirectory(prefix='aae-schema-') as temporary:
            folder = Path(temporary)
            root, suite_dir = folder / 'root', folder / 'suite_dir'
            root.mkdir()
            suite_dir.mkdir()
            for name, text in examples['files'].items():
                (root / name).write_text(text)
            suite = suite_dir / 'suite.json'
            suite.write_text(json.dumps(examples['suite']))
            code, audit = self.command('audit', '--root', str(root), '--suite', str(suite))
            self.assertEqual((code, audit['status']), (0, 'pass'))
            self.assertIn('requirement-unbound', {f['code'] for f in audit['findings']})
            # The documented freeze example produces a suite the audit accepts, bound to the content.
            code, frozen = self.command('freeze', '--root', str(root), '--suite', str(suite))
            self.assertEqual((code, frozen['status']), (0, 'pass'))
            self.assertEqual(frozen['suite']['scenarios'][0]['required'][0], examples['frozenRequirement'])
            (suite_dir / 'frozen.json').write_text(json.dumps(frozen))
            code, audit = self.command('audit', '--root', str(root), '--suite', str(suite_dir / 'frozen.json'))
            self.assertEqual((code, audit['status'], audit['contractHash']), (0, 'pass', frozen['contractHash']))
            self.assertNotIn('requirement-unbound', {f['code'] for f in audit['findings']})

    def test_command_flags_match_parser_and_repeat_contract(self):
        schema = cli.schema_contract()
        self.assertEqual(set(schema['commands']), {'protected', 'schema', 'audit', 'compare-audit', 'freeze', 'inventory'})
        self.assertEqual(set(schema['commands']), set(cli.REPORT_VERSIONS) - {'error'})
        roots = next(flag for flag in schema['commands']['audit'] if flag['flag'] == '--root')
        self.assertTrue(roots['required'])
        self.assertTrue(roots['repeatable'])
        summary = next(flag for flag in schema['commands']['audit'] if flag['flag'] == '--summary')
        self.assertFalse(summary['takesValue'])
        freeze = {flag['flag']: flag for flag in schema['commands']['freeze']}
        self.assertEqual(set(freeze), {'--root', '--suite', '--relocate', '--rebind'})
        self.assertFalse(freeze['--relocate']['takesValue'] or freeze['--rebind']['takesValue'])
        for field in ('entryInjected', 'maxAlwaysLoadedBytes', 'contentHash', 'suiteInput', 'identity'):
            self.assertIn(field, schema['suiteContract'])
        self.assertIn('contractHash', schema['comparisonContract'])
        suite_contract.validate_suite({**schema['examples']['suite'], 'scenarios': [
            {**schema['examples']['suite']['scenarios'][0], 'required': [schema['examples']['frozenRequirement']]}]})

    def test_schema_texts_frame_always_loaded_as_cost_not_quality(self):
        text = json.dumps(cli.schema_contract(), ensure_ascii=False).lower()
        for claim in ('adher', 'complian', 'agent quality', 'degrad'):
            self.assertNotIn(claim, text)


if __name__ == '__main__':
    unittest.main()
