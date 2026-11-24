"""Alterações under the inventory limit: a file missing from a reading that did not list its folder is not compared.

The limit is shared among the opened roots, so opening a second project can leave part of the first out of the
inventory. The comparison only says "removed" or "added" when the reading where the file is missing listed its
folder completely; otherwise the file is counted as not compared. The same holds for relations and findings whose
origin file was left out of one of the readings. Disposable trees only, with low limits by monkeypatch.
"""
import gzip
import itertools
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import delta as readings
import scanner
from workspace import Workspace

LIMIT = 40  # one root alone fits; two roots get 20 elements each
FOLDER = 30  # files of the big folder z/, beyond the share of one root out of two
NO_CHANGE = {'added': 0, 'removed': 0, 'changed': 0}


def clock():
    counter = itertools.count()
    return lambda: f'2026-10-02T14:{next(counter):02d}:00-03:00'


class ChangesUnderLimitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-changes-limit-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'grande'
        files = {'AGENTS.md': '# Grande\n[Último](z/f29.md)\n[Guia](a/guia.md)\n',
                 'a/guia.md': '# Guia\n', 'a/passo.md': '# Passo\n', 'a/fim.md': '# Fim\n'}
        files.update({f'z/f{index:02d}.md': f'# Nota {index}\n' for index in range(FOLDER)})
        # Past the share of the root when another one is open: its relation and its broken mention.
        files['z/f29.md'] = '# Nota 29\n[Guia](../a/guia.md)\n[Ausente](ausente.md)\n'
        self.write(self.root, files)
        self.other = self.write(self.base / 'pequeno', {'AGENTS.md': '# Pequeno\n'})
        patches = (patch.object(readings, 'now', clock()), patch.object(scanner, 'MAX_FILES', LIMIT))
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.state = self.base / 'state'
        self.ws = Workspace(self.state)

    @staticmethod
    def write(root, files):
        for relative, text in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        return root

    def listed(self):
        """Files of the big root in the current inventory."""
        prefix = str(self.root) + '/'
        return {node['id'] for node in self.ws.model['nodes']
                if node['id'].startswith(prefix) and node['kind'] not in readings.NOT_FILES and node['status'] in {'resolved', 'skipped'}}

    def uncompared(self, delta):
        return (delta['files']['uncompared'], delta['relations']['uncompared'], delta['findings']['uncompared'])

    def test_opening_a_second_root_does_not_report_the_files_left_out_as_removed(self):
        first = self.ws.open(str(self.root))['delta']
        self.assertEqual(first['files']['totals'], NO_CHANGE)
        self.assertEqual(len(self.listed()), FOLDER + 4)  # the whole root fits alone
        delta = self.ws.open(str(self.other))['delta']
        left_out = FOLDER + 4 - len(self.listed())
        self.assertGreater(left_out, 0)
        self.assertTrue((self.root / 'z' / 'f29.md').is_file())  # still on disk
        self.assertEqual(delta['files']['totals'], NO_CHANGE)
        self.assertEqual(delta['files']['removed'], [])
        # The reference was read with the root alone: relations and findings are not compared at all in this
        # context, so none counts among those left out of the inventory.
        self.assertEqual(delta['roots'][0]['context'], 'changed')
        self.assertEqual(self.uncompared(delta), (left_out, 0, 0))
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertNotIn('broken', [item['code'] for item in delta['findings']['resolved']])

    def test_in_the_same_context_what_one_reading_left_out_of_the_inventory_is_not_compared(self):
        # Baseline with both roots open, so z/ was cut; then files are deleted from z/ and it fits in the same
        # context: z/f29.md is in the current reading only, in a folder the baseline did not list whole.
        self.ws.open(str(self.root))
        self.ws.open(str(self.other))
        self.assertNotIn(str(self.root / 'z' / 'f29.md'), self.listed())
        self.ws.adopt_reference()
        for index in range(20):
            (self.root / 'z' / f'f{index:02d}.md').unlink()
        delta = self.ws.refresh()['delta']
        self.assertIn(str(self.root / 'z' / 'f29.md'), self.listed())
        self.assertEqual([item['context'] for item in delta['roots']], ['same', 'same'])
        # The two relations of z/f29.md and its findings are neither added nor new: counted as not compared.
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertEqual(delta['relations']['uncompared'], 2)
        self.assertGreater(delta['findings']['uncompared'], 0)
        self.assertNotIn('broken', [item['code'] for item in delta['findings']['new']])
        self.assertGreater(delta['files']['uncompared'], 0)
        self.assertNotIn(str(self.root / 'z' / 'f29.md'), [item['path'] for item in delta['files']['added']])

    def test_a_file_deleted_from_a_folder_listed_in_both_readings_is_still_removed(self):
        self.ws.open(str(self.root))
        (self.root / 'a' / 'fim.md').unlink()
        (self.root / 'a' / 'novo.md').write_text('# Novo\n', encoding='utf-8')
        delta = self.ws.open(str(self.other))['delta']
        self.assertEqual([item['relative'] for item in delta['files']['removed']], ['a/fim.md'])
        self.assertEqual([item['relative'] for item in delta['files']['added']], ['a/novo.md'])
        self.assertGreater(delta['files']['uncompared'], 0)

    def test_a_file_deleted_from_a_folder_the_current_reading_did_not_list_is_not_compared(self):
        self.ws.open(str(self.root))
        (self.root / 'z' / 'f28.md').unlink()
        delta = self.ws.open(str(self.other))['delta']
        self.assertNotIn(str(self.root / 'z' / 'f00.md'), [item['path'] for item in delta['files']['removed']])
        self.assertEqual(delta['files']['totals'], NO_CHANGE)
        # The reading cannot tell a deleted file from one left out: every reference file missing is not compared.
        self.assertEqual(delta['files']['uncompared'], FOLDER + 4 - len(self.listed()))

    def test_a_reference_taken_under_the_limit_does_not_report_the_rest_as_added(self):
        self.ws.open(str(self.root))
        self.ws.open(str(self.other))
        self.ws.adopt_reference()
        self.ws.close(str(self.other))
        delta = self.ws.delta
        self.assertEqual(len(self.listed()), FOLDER + 4)
        self.assertEqual(delta['files']['totals'], NO_CHANGE)
        self.assertGreater(delta['files']['uncompared'], 0)
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
        self.assertNotIn('broken', [item['code'] for item in delta['findings']['new']])

    def test_two_complete_readings_compare_nothing_less(self):
        self.ws.open(str(self.root))
        (self.root / 'z' / 'f28.md').unlink()
        (self.root / 'z' / 'f29.md').write_text('# Nota 29\n', encoding='utf-8')
        delta = self.ws.refresh()['delta']
        self.assertEqual(self.uncompared(delta), (0, 0, 0))
        self.assertEqual([item['relative'] for item in delta['files']['removed']], ['z/f28.md'])
        self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 2})
        self.assertIn('broken', [item['code'] for item in delta['findings']['resolved']])

    def test_the_folders_not_listed_are_saved_and_loaded_after_a_restart(self):
        self.ws.open(str(self.root))
        self.ws.open(str(self.other))
        self.ws.adopt_reference()
        saved = self.state / 'references' / readings.ReferenceStore.name(str(self.root))
        document = json.loads(gzip.decompress(saved.read_bytes()))
        self.assertIn('z', document['reference']['unlisted'])
        loaded, problem = readings.ReferenceStore(self.state).load(str(self.root))
        self.assertIsNone(problem)
        self.assertEqual((loaded['unlisted'], loaded['listed']), (document['reference']['unlisted'], document['reference']['listed']))
        # The next server process, with the big root alone, still does not report the rest as added.
        self.ws.close(str(self.other))
        workspace = Workspace(self.state)
        delta = workspace.open(str(self.root))['delta']
        self.assertEqual(delta['roots'][0]['referenceOrigin'], 'persisted')
        self.assertEqual(delta['files']['totals'], NO_CHANGE)
        self.assertGreater(delta['files']['uncompared'], 0)

    def test_a_reference_saved_without_the_field_loads_and_counts_as_completely_listed(self):
        self.ws.open(str(self.root))
        self.ws.open(str(self.other))
        self.ws.adopt_reference()
        saved = self.state / 'references' / readings.ReferenceStore.name(str(self.root))
        document = json.loads(gzip.decompress(saved.read_bytes()))
        del document['reference']['unlisted'], document['reference']['listed']
        saved.write_bytes(gzip.compress(json.dumps(document).encode()))
        loaded, problem = readings.ReferenceStore(self.state).load(str(self.root))
        self.assertIsNone(problem)
        self.assertEqual((loaded['unlisted'], loaded['listed']), ([], []))
        self.ws.close(str(self.other))
        workspace = Workspace(self.state)
        delta = workspace.open(str(self.root))['delta']
        # A reference without `unlisted`: the files it did not list appear as added.
        self.assertGreater(delta['files']['totals']['added'], 0)
        self.assertEqual(delta['files']['uncompared'], 0)

    def test_the_new_fields_are_validated_strictly(self):
        self.ws.open(str(self.root))
        self.ws.open(str(self.other))
        self.ws.adopt_reference()
        store = readings.ReferenceStore(self.state)
        saved = self.state / 'references' / readings.ReferenceStore.name(str(self.root))
        document = json.loads(gzip.decompress(saved.read_bytes()))
        self.assertEqual((document['reference']['unlisted'], document['reference']['listed']), (['z'], ['.', 'a']))
        def load(**fields):
            changed = {**document, 'reference': {**document['reference'], **fields}}
            saved.write_bytes(gzip.compress(json.dumps(changed).encode()))
            return store.load(str(self.root))
        for field in ('unlisted', 'listed'):
            for value in ('z', None, 3, ['../fora'], ['/abs'], ['a//b'], ['a/./b'], ['z', 'z'], ['b', 'a'], [5], ['a\x00b'], [{'z': 1}]):
                with self.subTest(field=field, value=value):
                    self.assertEqual(load(**{field: value}), (None, readings.INVALID))
        # The split, as `read` writes it: the root on one side, no folder on both.
        for unlisted, listed in ((['z'], ['a']), (['a', 'z'], ['.', 'a']), (['.', 'z'], ['.'])):
            with self.subTest(unlisted=unlisted, listed=listed):
                self.assertEqual(load(unlisted=unlisted, listed=listed), (None, readings.INVALID))
        for unlisted, listed in (([], []), (['.'], []), (['z'], ['.', 'a']), (['.', 'a', 'z'], []), ([], ['.', 'a'])):
            with self.subTest(unlisted=unlisted, listed=listed):
                loaded, problem = load(unlisted=unlisted, listed=listed)
                self.assertIsNone(problem)
                self.assertEqual((loaded['unlisted'], loaded['listed']), (unlisted, listed))

    def test_everything_saved_under_the_limit_loads_and_compares_empty(self):
        model = scanner.scan([str(self.root), str(self.other)])
        current = readings.read(model, readings.now())
        self.assertEqual((current[str(self.root)]['unlisted'], current[str(self.root)]['listed']), (['z'], ['.', 'a']))
        # Nothing unlisted: every absence is checked, and the listed folders are not kept.
        self.assertEqual((current[str(self.other)]['unlisted'], current[str(self.other)]['listed']), ([], []))
        self.state.mkdir(exist_ok=True)
        store = readings.ReferenceStore(self.state)
        for root, compact in current.items():
            with self.subTest(root=Path(root).name):
                self.assertIsNone(store.save(root, compact))
                loaded, problem = store.load(root)
                self.assertIsNone(problem)
                delta = readings.compare({root: loaded}, {root: compact}, model)
                self.assertEqual(delta['files']['totals'], NO_CHANGE)
                self.assertEqual(delta['relations']['totals'], {'added': 0, 'removed': 0})
                self.assertEqual(self.uncompared(delta), (0, 0, 0))



class FoldersOfTheReadingTests(unittest.TestCase):
    """The folder of a missing file decides, as the reading inventoried it: an empty folder listed whole affirms the
    absence; a folder left out of the inventory does not, even when a nested root inventoried a folder below it."""

    TOP = {f't{index:02d}.md': f'# T{index}\n' for index in range(30)}

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-changes-folders-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        patches = (patch.object(readings, 'now', clock()), patch.object(scanner, 'MAX_FILES', LIMIT))
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.ws = Workspace(self.base / 'state')
        self.other = ChangesUnderLimitTests.write(self.base / 'pequeno', {'AGENTS.md': '# Pequeno\n'})

    def project(self, files):
        return ChangesUnderLimitTests.write(self.base / 'grande', {'AGENTS.md': '# Grande\n', **files})

    @staticmethod
    def relative(delta, group):
        return sorted(item['relative'] for item in delta['files'][group])

    def nested_tree(self):
        root = self.project({**self.TOP, 'zz/outro.md': '# O\n', 'zz/mais.md': '# M\n', 'zz/y/f.md': '# F\n', 'zz/y/g.md': '# G\n'})
        return root, root / 'zz' / 'y'

    def test_a_nested_root_below_a_folder_left_out_does_not_make_its_siblings_removed(self):
        root, nested = self.nested_tree()
        self.assertEqual(self.ws.open(str(root))['delta']['files']['uncompared'], 0)
        delta = self.ws.open(str(nested))['delta']
        current = self.ws.current[str(root)]
        # zz/ was not inventoried by the outer root: only zz/y, by the nested one.
        self.assertNotIn('zz', current['unlisted'] + current['listed'])
        self.assertIn('zz/y', current['listed'])
        self.assertEqual((self.relative(delta, 'removed'), self.relative(delta, 'added')), ([], []))
        self.assertTrue((root / 'zz' / 'outro.md').is_file())
        self.assertEqual(delta['files']['uncompared'], sum(1 for _ in root.rglob('*.md')) - len(current['files']))

    def test_closing_a_nested_root_does_not_make_the_siblings_left_out_added(self):
        root, nested = self.nested_tree()
        self.ws.open(str(root))
        self.ws.open(str(nested))
        self.ws.adopt_reference()
        delta = self.ws.close(str(nested))['delta']
        self.assertEqual((self.relative(delta, 'removed'), self.relative(delta, 'added')), ([], []))
        self.assertGreater(delta['files']['uncompared'], 0)

    def test_the_last_file_deleted_from_a_folder_listed_whole_is_removed(self):
        root = self.project({'a/unico.md': '# U\n', **self.TOP})
        self.ws.open(str(root))
        (root / 'a' / 'unico.md').unlink()
        delta = self.ws.open(str(self.other))['delta']
        current = self.ws.current[str(root)]
        self.assertIn('.', current['unlisted'])  # the root itself is cut
        self.assertIn('a', current['listed'])  # a/, now empty, was listed whole
        self.assertEqual(self.relative(delta, 'removed'), ['a/unico.md'])
        self.assertGreater(delta['files']['uncompared'], 0)

    def test_the_last_file_deleted_below_a_cut_folder_is_removed(self):
        root = self.project({'big/a/unico.md': '# U\n', **{f'big/f{index:02d}.md': '# F\n' for index in range(30)}})
        self.ws.open(str(root))
        (root / 'big' / 'a' / 'unico.md').unlink()
        delta = self.ws.open(str(self.other))['delta']
        self.assertIn('big', self.ws.current[str(root)]['unlisted'])
        self.assertEqual(self.relative(delta, 'removed'), ['big/a/unico.md'])

    def test_the_first_file_created_in_a_folder_listed_empty_is_added(self):
        root = self.project(dict(self.TOP))
        (root / 'a').mkdir()
        self.ws.open(str(root))
        self.ws.open(str(self.other))
        self.ws.adopt_reference()
        self.assertIn('a', self.ws.references[str(root)]['listed'])
        (root / 'a' / 'novo.md').write_text('# N\n', encoding='utf-8')
        delta = self.ws.close(str(self.other))['delta']
        self.assertEqual(self.relative(delta, 'added'), ['a/novo.md'])
        self.assertEqual(self.relative(delta, 'removed'), [])
        self.assertGreater(delta['files']['uncompared'], 0)

    def test_a_folder_named_with_the_prefix_of_a_cut_one_is_its_own_folder(self):
        # In name order docs/ comes before docs-old/: the limit cuts docs-old/ and leaves docs/ listed whole.
        root = self.project({'docs/d.md': '# D\n', **{f'docs-old/f{index:02d}.md': '# F\n' for index in range(30)}})
        self.ws.open(str(root))
        (root / 'docs-old' / 'f29.md').unlink()
        (root / 'docs' / 'd.md').unlink()
        delta = self.ws.open(str(self.other))['delta']
        current = self.ws.current[str(root)]
        self.assertIn('docs', current['listed'])
        self.assertIn('docs-old', current['unlisted'])
        self.assertEqual(self.relative(delta, 'removed'), ['docs/d.md'])
        self.assertEqual(delta['files']['uncompared'], 30 - len([path for path in current['files'] if path.startswith('docs-old/')]))

    @unittest.skipIf(os.geteuid() == 0, 'permissions do not hold for root')
    def test_a_folder_gone_next_to_an_unreadable_one_with_its_name_as_prefix_is_removed(self):
        root = self.project({'a/b/x.md': '# X\n', 'a/bc/y.md': '# Y\n', 'a/guia.md': '# G\n'})
        self.ws.open(str(root))
        (root / 'a' / 'bc' / 'y.md').unlink()
        (root / 'a' / 'bc').rmdir()
        (root / 'a' / 'b').chmod(0)
        self.addCleanup((root / 'a' / 'b').chmod, 0o755)
        delta = self.ws.refresh()['delta']
        current = self.ws.current[str(root)]
        self.assertEqual(current['unlisted'], ['a/b'])
        self.assertNotIn('a/bc', current['listed'])
        # a/bc/ no longer exists and a/ was listed whole: removed; a/b/ could not be listed: not compared.
        self.assertEqual(self.relative(delta, 'removed'), ['a/bc/y.md'])
        self.assertEqual(delta['files']['uncompared'], 1)

if __name__ == '__main__':
    unittest.main()
