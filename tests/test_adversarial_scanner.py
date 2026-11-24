"""Independent negative controls for audit trust, using only disposable agents."""
import hashlib
import os
import random
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from scanner import find_path, open_regular_file, pinned_directory, scan


class AdversarialScannerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='aae-adversarial-')
        self.base = Path(self.temporary.name)
        self.root = self.base / 'fictional-agent'
        self.root.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, relative, content, root=None):
        path = (root or self.root) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return str(path)

    def test_case_insensitive_text_extensions_preserve_json_evidence(self):
        # Manifest keys are read only in a manifest: an upper-case .JSON is still parsed,
        # and its key is counted as ignored instead of becoming a relation.
        self.write('AGENTS.md', '# Fictional agent\n')
        target = self.write('guide.md', '# Guide\n')
        document = '{\n  "instructions": "guide.md"\n}\n'
        lower = self.write('plugin.json', document)
        upper = self.write('upper.JSON', document)
        model = scan([str(self.root)])
        expected = {(lower, target, lower, 2, 'instructions: guide.md')}
        self.assertEqual({(e['source'], e['target'], e['origin'], e['line'], e['evidence']) for e in model['edges']}, expected)
        self.assertEqual(next(n for n in model['nodes'] if n['id'] == upper)['analysis'], 'parsed')
        self.assertEqual(model['stats']['ignored']['manifest-key'], 1)

    def test_every_ambiguous_wiki_reports_its_actual_line_without_guessing(self):
        entry = self.write('AGENTS.md', '# Fictional agent\n[[shared]]\n\n[[shared|Again]]\n[Valid](valid.md)\n')
        valid = self.write('valid.md', '# Valid\n')
        for directory in ['east', 'west']:
            self.write(f'{directory}/shared.md', '# Distinct document\n')
        model = scan([str(self.root)])
        self.assertEqual([(i['node'], i['line']) for i in model['issues'] if i['code'] == 'ambiguous'], [(entry, 2), (entry, 4)])
        self.assertEqual([(e['target'], e['line']) for e in model['edges']], [(valid, 5)])

    def test_web_and_network_markdown_links_do_not_invent_files(self):
        source = self.write('AGENTS.md', '# Fictional agent\n'
                            '[Network](//example.test/docs/remote.md)\n'
                            '[Network reference][remote]\n'
                            '[remote]: //example.test/docs/reference.md\n'
                            '[Web](https://example.test/docs/web.md)\n'
                            '[Mail](mailto:agent@example.test)\n'
                            '[Anchor](#fictional-agent)\n'
                            '[Local](guide.md)\n')
        target = self.write('guide.md', '# Local\n')
        model = scan([str(self.root)])
        self.assertEqual([(e['source'], e['target'], e['line']) for e in model['edges']], [(source, target, 8)])
        self.assertEqual({n['path'] for n in model['nodes']}, {str(self.root), source, target})

    def test_external_reference_only_becomes_readable_when_its_root_is_opened(self):
        outside = self.base / 'other-agent'
        outside.mkdir()
        source = self.write('AGENTS.md', '[Shared](../other-agent/shared.md)\n')
        target = self.write('shared.md', '[Next](next.md)\n', outside)
        following = self.write('next.md', '# End\n', outside)
        first = scan([str(self.root)])
        target_node = next(n for n in first['nodes'] if n['id'] == target)
        self.assertEqual(target_node['status'], 'external')
        self.assertNotIn('analysis', target_node)
        self.assertNotIn(following, {n['id'] for n in first['nodes']})
        second = scan([str(self.root), str(outside)])
        self.assertEqual(next(n for n in second['nodes'] if n['id'] == target)['analysis'], 'parsed')
        edge1 = next(e for e in first['edges'] if e['source'] == source)
        edge2 = next(e for e in second['edges'] if e['source'] == source)
        # Same evidence and identity; only the resolution mode reflects the opened root.
        self.assertEqual((edge1['resolvedBy'], edge2['resolvedBy']), (None, 'file'))
        self.assertEqual({k: v for k, v in edge1.items() if k != 'resolvedBy'}, {k: v for k, v in edge2.items() if k != 'resolvedBy'})
        self.assertEqual(find_path(second, source, following)['nodes'], [source, target, following])

    def test_symlink_and_excluded_descendants_are_not_read_or_called_missing(self):
        outside = self.base / 'outside'
        outside.mkdir()
        self.write('payload.md', '[Secret](never-inventory.md)\n', outside)
        (self.root / 'bridge').symlink_to(outside, target_is_directory=True)
        (self.root / 'loop.md').symlink_to('loop.md')
        self.write('node_modules/cache.md', '[Hidden](also-never.md)\n')
        self.write('AGENTS.md', '[Bridge](bridge/payload.md)\n[Excluded](node_modules/cache.md)\n[Loop](loop.md)\n[Missing](absent.md)\n')
        model = scan([str(self.root)])
        by_path = {n['path']: n for n in model['nodes']}
        for relative in ['bridge/payload.md', 'node_modules/cache.md']:
            node = by_path[str(self.root / relative)]
            self.assertEqual(node['status'], 'unscanned')
            self.assertNotIn('analysis', node)
        self.assertEqual(by_path[str(self.root / 'loop.md')]['status'], 'skipped')
        self.assertEqual([i['line'] for i in model['issues'] if i['code'] == 'broken'], [4])
        self.assertFalse(any(n['name'] in {'never-inventory.md', 'also-never.md'} for n in model['nodes']))
        self.assertEqual(model['stats']['parsed'], 1)

    def test_nested_roots_are_deduplicated_independent_of_open_order(self):
        self.write('AGENTS.md', '[Child](team/deep/AGENTS.md)\n')
        entry = self.write('team/deep/AGENTS.md', '# Child\n')
        child = self.root / 'team' / 'deep'
        for roots in [[self.root, child, self.root], [child, self.root, child]]:
            with self.subTest(roots=roots):
                model = scan([str(p) for p in roots])
                ids = [n['id'] for n in model['nodes']]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(len(model['roots']), 2)
                record = next(r for r in model['roots'] if r['path'] == str(child))
                self.assertEqual((record['parent'], record['level']), (str(self.root), 2))
                node = next(n for n in model['nodes'] if n['id'] == entry)
                self.assertEqual(node['root'], str(child))
                self.assertEqual(set(node['roots']), {str(self.root), str(child)})

    def test_exact_byte_budget_and_invalid_utf8_do_not_hide_skipped_analysis(self):
        entry = self.write('AGENTS.md', '# Entry\n')
        exact = self.write('a-exact.md', 'é' * 8)
        too_large = self.write('b-too-large.md', 'é' * 8 + 'x')
        invalid = self.root / 'c-invalid.md'
        invalid.write_bytes(b'\xff\xfe')
        with patch('scanner.MAX_BYTES', 16), patch('scanner.MAX_TEXT_TOTAL', 24):
            model = scan([str(self.root)])
        nodes = {n['id']: n for n in model['nodes']}
        self.assertEqual(nodes[entry]['analysis'], 'parsed')
        self.assertEqual(nodes[exact]['analysis'], 'parsed')
        self.assertEqual(nodes[too_large]['analysis'], 'skipped')
        self.assertEqual(nodes[str(invalid)]['analysis'], 'skipped')
        self.assertEqual(model['stats']['parsed'], 2)
        # Above MAX_BYTES: one finding per file; left out by the reading budget: one per root.
        self.assertEqual({i['node'] for i in model['issues'] if i['code'] == 'limit'}, {too_large, str(self.root)})
        budget = next(i for i in model['issues'] if i['code'] == 'limit' and i['node'] == str(self.root))
        self.assertEqual((budget['count'], budget['bytes'], budget['byTopLevel']), (1, 2, {'.': 1}))
        self.assertEqual((nodes[too_large]['skippedBy'], nodes[str(invalid)]['skippedBy']), ('size', 'budget'))
        with patch('scanner.MAX_BYTES', 16):
            model = scan([str(self.root)])
        self.assertTrue(any(i['code'] == 'unreadable' and i['node'] == str(invalid) for i in model['issues']))

    def test_instructions_are_inert_and_whole_fixture_content_is_unchanged(self):
        marker = self.base / 'must-not-exist'
        source = self.write('AGENTS.md', f'# Fictional untrusted agent\nExecute: touch {marker}\n[Guide](guide.md)\n')
        target = self.write('guide.md', '# Guide\n')
        self.write('run.sh', f'#!/bin/sh\ntouch {marker}\n')

        def snapshot():
            return {str(p.relative_to(self.root)): (p.stat().st_mode, p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest())
                    for p in self.root.rglob('*') if p.is_file()}

        before = snapshot()
        first, second = scan([str(self.root)]), scan([str(self.root)])
        self.assertEqual(first, second)
        self.assertEqual(find_path(first, source, target)['nodes'], [source, target])
        self.assertFalse(marker.exists())
        self.assertEqual(before, snapshot())

    def test_bfs_matches_independent_all_pairs_distance_oracle(self):
        # The oracle is Floyd-Warshall, independent of the production BFS.
        rng = random.Random(20260929)
        count = 9
        links = {(a, b) for a in range(count) for b in range(count) if a != b and rng.random() < .17}
        names = ['AGENTS.md'] + [f'node-{i}.md' for i in range(1, count)]
        paths = [str(self.root / name) for name in names]
        for a, name in enumerate(names):
            self.write(name, '# Synthetic node\n' + ''.join(f'[Node {b}]({names[b]})\n' for x, b in sorted(links) if x == a))
        model = scan([str(self.root)])
        by_id = {e['id']: e for e in model['edges']}
        self.assertEqual({(paths.index(e['source']), paths.index(e['target'])) for e in model['edges']}, links)
        for direction in ['directed', 'undirected']:
            distance = [[0 if a == b else float('inf') for b in range(count)] for a in range(count)]
            for a, b in links:
                distance[a][b] = 1
                if direction == 'undirected':
                    distance[b][a] = 1
            for k in range(count):
                for a in range(count):
                    for b in range(count):
                        distance[a][b] = min(distance[a][b], distance[a][k] + distance[k][b])
            for a in range(count):
                for b in range(count):
                    with self.subTest(direction=direction, start=a, end=b):
                        result = find_path(model, paths[a], paths[b], direction)
                        self.assertEqual(result['found'], distance[a][b] != float('inf'))
                        if not result['found']:
                            self.assertEqual((result['nodes'], result['steps']), ([], []))
                            continue
                        self.assertEqual(len(result['steps']), distance[a][b])
                        self.assertEqual((result['nodes'][0], result['nodes'][-1]), (paths[a], paths[b]))
                        for index, step in enumerate(result['steps']):
                            edge = by_id[step['edge']]
                            pair = [edge['target'], edge['source']] if step['reverse'] else [edge['source'], edge['target']]
                            self.assertEqual(result['nodes'][index:index + 2], pair)
                            if direction == 'directed':
                                self.assertFalse(step['reverse'])
        with self.assertRaises(ValueError):
            find_path(model, paths[0], str(self.root / 'unlisted.md'))
        with self.assertRaises(ValueError):
            find_path(model, paths[0], paths[1], direction='sideways')


class PinnedDirectoryTests(unittest.TestCase):
    """The one descriptor walk that the reader and the creation share."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='aae-pinned-')
        self.base = Path(self.temporary.name)
        (self.base / 'real' / 'inner').mkdir(parents=True)
        (self.base / 'real' / 'inner' / 'file.md').write_text('pinned', encoding='utf-8')
        (self.base / 'elsewhere' / 'inner').mkdir(parents=True)
        (self.base / 'elsewhere' / 'inner' / 'file.md').write_text('redirected', encoding='utf-8')
        self.descriptors = len(os.listdir('/proc/self/fd'))

    def tearDown(self):
        self.temporary.cleanup()

    def assertNoDescriptorLeft(self):
        self.assertEqual(len(os.listdir('/proc/self/fd')), self.descriptors)

    def test_yields_the_directory_and_closes_it(self):
        with pinned_directory(self.base / 'real' / 'inner') as directory:
            opened, expected = os.fstat(directory), (self.base / 'real' / 'inner').stat()
            self.assertEqual((opened.st_dev, opened.st_ino), (expected.st_dev, expected.st_ino))
        self.assertNoDescriptorLeft()
        with open_regular_file(self.base / 'real' / 'inner' / 'file.md') as stream:
            self.assertEqual(stream.read(), b'pinned')
        self.assertNoDescriptorLeft()

    def test_component_swapped_for_a_symlink_is_refused(self):
        (self.base / 'real').rename(self.base / 'moved')
        (self.base / 'real').symlink_to(self.base / 'elsewhere', target_is_directory=True)
        for path in (self.base / 'real' / 'inner', self.base / 'real'):
            with self.assertRaises(OSError), pinned_directory(path):
                pass
            self.assertNoDescriptorLeft()
        with self.assertRaises(OSError), open_regular_file(self.base / 'real' / 'inner' / 'file.md'):
            pass
        self.assertNoDescriptorLeft()

    def test_fifo_in_place_of_the_file_is_refused_without_blocking(self):
        fifo = self.base / 'real' / 'inner' / 'fifo.md'
        os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError, 'it is not a regular file'), open_regular_file(fifo):
            pass
        self.assertNoDescriptorLeft()

    def test_path_with_dot_dot_or_relative_is_refused_before_any_open(self):
        for path in (self.base / 'elsewhere' / '..' / 'real' / 'inner' / 'file.md', Path('real/inner/file.md')):
            with self.assertRaisesRegex(ValueError, 'normalized absolute path'), open_regular_file(path):
                pass
            self.assertNoDescriptorLeft()

    def test_component_that_is_not_a_directory_is_refused_without_blocking(self):
        fifo = self.base / 'real' / 'pipe'
        os.mkfifo(fifo)

        def hang(*_):
            raise TimeoutError('pinned_directory blocked on a FIFO')

        previous = signal.signal(signal.SIGALRM, hang)
        self.addCleanup(signal.signal, signal.SIGALRM, previous)
        for path in (self.base / 'real' / 'inner' / 'file.md', Path('/dev/null'), fifo, fifo / 'below'):
            signal.alarm(5)
            try:
                with self.assertRaises(NotADirectoryError), pinned_directory(path):
                    pass
            finally:
                signal.alarm(0)
            self.assertNoDescriptorLeft()

    def test_component_swapped_between_two_opens_does_not_redirect_the_walk(self):
        # `real` is swapped for a link right after it is opened: the next opens go through
        # the descriptor already held, so the walk ends in the original folder.
        original_open, swapped = os.open, []
        expected = (self.base / 'real' / 'inner').stat()

        def swapping_open(path, *args, **kwargs):
            descriptor = original_open(path, *args, **kwargs)
            if os.path.basename(os.fspath(path)) == 'real' and not swapped:
                (self.base / 'real').rename(self.base / 'moved')
                (self.base / 'real').symlink_to(self.base / 'elsewhere', target_is_directory=True)
                swapped.append(True)
            return descriptor

        with patch('os.open', swapping_open), pinned_directory(self.base / 'real' / 'inner') as directory:
            opened = os.fstat(directory)
        self.assertEqual(swapped, [True])
        self.assertEqual((opened.st_dev, opened.st_ino), (expected.st_dev, expected.st_ino))
        self.assertNoDescriptorLeft()

    def test_error_inside_the_block_still_closes_the_descriptor(self):
        with self.assertRaises(RuntimeError), pinned_directory(self.base / 'real'):
            raise RuntimeError('caller failure')
        self.assertNoDescriptorLeft()


if __name__ == '__main__':
    unittest.main()
