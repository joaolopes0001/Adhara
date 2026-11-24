"""A folder the reader did not list whole never says it is complete, even past the index limit.

Past the inventory limit the walk goes on with names only, up to its own limit (MAX_LOOKUP).
When that one runs out too, the walk stops in the middle of a folder: that folder, and every
folder of a later root cut the same way, must come out `partial` or `unread`, with `omitted`
counting what is known to be left out (a minimum: what lies below an unlisted name is unknown).
Changes (`server/delta.py`) trusts `listing` to affirm a removal, so a folder that says
`complete` without having been listed whole makes files still on disk come out as removed.

Disposable trees only, limits lowered by monkeypatch, and an oracle that walks the disk.
"""
import contextlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import delta, scanner


def scan(roots, limit, lookup):
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(scanner, 'MAX_FILES', limit))
        stack.enter_context(mock.patch.object(scanner, 'MAX_LOOKUP', lookup))
        return scanner.scan([str(root) for root in roots])


def children(folder):
    """What the reader lists in a folder: excluded folder names (even as links) are left out."""
    found = []
    with os.scandir(folder) as handle:
        for entry in handle:
            if entry.is_dir() and entry.name in scanner.EXCLUDED:
                continue
            found.append(entry)
    return found


def below(folder):
    """Every element below a folder on disk, without following links."""
    out = []
    for entry in children(folder):
        out.append(entry.path)
        if entry.is_dir(follow_symlinks=False):
            out += below(entry.path)
    return out


def on_disk(roots):
    found = set()
    for root in roots:
        found.update(below(str(root)))
    return found


def write(path, text='# x\n'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


class CutListingCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aae-cut-listing-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def flat(self, name, count):
        root = self.base / name
        root.mkdir(parents=True)
        for index in range(count):
            write(root / f'f{index:02}.md')
        return root

    def honest(self, model, roots):
        """Every inventoried folder: `complete` only when each element on disk is in the model, and `omitted`
        never above what is out (equal to it when the names-only index did not stop)."""
        ids = {node['id'] for node in model['nodes']}
        bounded = not model['stats']['inventory']['lookupComplete']
        folders = [node for node in model['nodes'] if node['kind'] == 'directory' and node['status'] == 'resolved']
        self.assertTrue(folders)
        for node in folders:
            folder = node['id']
            missing = sorted(entry.path for entry in children(folder) if entry.path not in ids)
            out = sum(1 for path in below(folder) if path not in ids)
            with self.subTest(folder=folder):
                if missing:
                    self.assertIn(node['listing'], ('partial', 'unread'), f'{len(missing)} on disk, outside the model: {missing[:3]}')
                if node['listing'] == 'partial':
                    self.assertGreaterEqual(node['omitted'], 1)
                self.assertLessEqual(node['omitted'], out)
                if not bounded:
                    self.assertEqual(node['omitted'], out)
                    self.assertEqual(node['listing'] == 'complete', not missing)
        total = sum(1 for path in on_disk(roots) if path not in ids)
        self.assertLessEqual(model['stats']['inventory']['omitted'], total)
        if not bounded:
            self.assertEqual(model['stats']['inventory']['omitted'], total)


class CutFolderListing(CutListingCase):
    def test_the_second_root_cut_after_the_index_ran_out_is_partial(self):
        roots = [self.flat('a', 61), self.flat('b', 61)]
        model = scan(roots, 40, 5)
        nodes = {node['id']: node for node in model['nodes']}
        listed = [sum(1 for key in nodes if os.path.dirname(key) == str(root)) for root in roots]
        self.assertEqual(listed, [19, 19])
        # 61 on disk, 19 inventoried: the first root also had 5 names in the index, the second none.
        self.assertEqual([(nodes[str(root)]['listing'], nodes[str(root)]['omitted']) for root in roots], [('partial', 42), ('partial', 42)])
        inventory = model['stats']['inventory']
        self.assertEqual((inventory['complete'], inventory['lookupComplete'], inventory['omitted'], inventory['omittedFiles']), (False, False, 84, 84))
        limits = [issue['message'] for issue in model['issues'] if issue['code'] == 'limit']
        self.assertEqual(len(limits), 2)
        self.assertTrue(all('items left out of the inventory: at least 42.' in message for message in limits), limits)
        self.honest(model, roots)

    def test_one_root_and_several_with_the_index_at_0_5_and_40(self):
        for lookup in (0, 5, 40):
            for count in (1, 2, 3):
                with self.subTest(lookup=lookup, roots=count):
                    shutil.rmtree(self.base)
                    self.base.mkdir()
                    roots = [self.flat(f'r{index}', 101) for index in range(count)]
                    model = scan(roots, 40, lookup)
                    self.assertFalse(model['stats']['inventory']['lookupComplete'])
                    for root in roots:
                        node = next(node for node in model['nodes'] if node['id'] == str(root))
                        self.assertEqual(node['listing'], 'partial')
                    self.honest(model, roots)

    def test_the_cut_folder_first_in_the_middle_and_last_in_the_order_of_reading(self):
        # Three sibling folders of 10 files; the budget is spent on the level above, so the cut
        # lands inside the first, the second or the third folder of the level.
        for position, limit in (('first', 6), ('middle', 15), ('last', 25)):
            with self.subTest(position=position):
                shutil.rmtree(self.base)
                self.base.mkdir()
                root = self.base / 'agent'
                for folder in ('a', 'b', 'c'):
                    for index in range(10):
                        write(root / folder / f'{index}.md')
                model = scan([root], limit, 0)
                nodes = {node['id']: node for node in model['nodes']}
                states = {folder: nodes[str(root / folder)]['listing'] for folder in ('a', 'b', 'c')}
                cut = {'first': 'a', 'middle': 'b', 'last': 'c'}[position]
                self.assertEqual(states[cut], 'partial', states)
                self.assertTrue(all(state == 'unread' for folder, state in states.items() if folder > cut), states)
                self.assertTrue(all(state == 'complete' for folder, state in states.items() if folder < cut), states)
                self.assertEqual(nodes[str(root)]['listing'], 'complete')  # its direct children are all inventoried
                self.assertGreaterEqual(nodes[str(root)]['omitted'], nodes[str(root / cut)]['omitted'])
                self.honest(model, [root])

    def test_a_folder_seen_only_by_name_and_cut_counts_what_it_left_out(self):
        root = self.base / 'agent'
        for index in range(5):
            write(root / f'{index}.md')
        for index in range(8):
            write(root / 'z' / f'{index}.md')
        model = scan([root], 4, 3)  # 3 inventoried, 2 names + `z` exhaust the index, `z` is cut while listed by name
        node = next(node for node in model['nodes'] if node['id'] == str(root))
        self.assertEqual(node['listing'], 'partial')
        self.assertEqual(node['omitted'], 3 + 8)  # the two names and `z` in the index, and the eight names of `z`, none recorded
        self.honest(model, [root])

    def test_nested_roots_in_both_orders(self):
        outer = self.base / 'outer'
        for index in range(12):
            write(outer / f'{index:02}.md')
        for index in range(12):
            write(outer / 'inner' / f'{index:02}.md')
        for index in range(12):
            write(outer / 'inner' / 'deep' / f'{index:02}.md')
        inner = outer / 'inner'
        for roots in ([outer, inner], [inner, outer]):
            for limit, lookup in ((10, 0), (10, 5), (20, 5), (30, 12), (40, 40)):
                with self.subTest(roots=[root.name for root in roots], limit=limit, lookup=lookup):
                    model = scan(roots, limit, lookup)
                    self.honest(model, roots)

    def test_a_nested_root_seen_first_by_name_is_not_also_counted_out(self):
        outer = self.base / 'outer'
        for index in range(6):
            write(outer / f'{index}.md')
        write(outer / 'zz' / 'x.md')
        inner = outer / 'zz'
        # Three elements per root: the outer one keeps itself, 0.md and 1.md, and sees `zz` only by name.
        model = scan([outer, inner], 6, 10 ** 6)
        nodes = {node['id']: node for node in model['nodes']}
        self.assertIn(str(inner / 'x.md'), nodes)
        self.assertEqual((nodes[str(outer)]['listing'], nodes[str(outer)]['omitted']), ('partial', 4))  # 2.md to 5.md, not `zz`
        self.assertEqual(model['stats']['inventory']['omitted'], 4)
        self.honest(model, [outer, inner])

    def test_control_a_tree_within_the_index_keeps_its_listing_and_counts(self):
        roots = [self.flat('a', 61), self.flat('b', 61)]
        model = scan(roots, 40, 1000)
        nodes = {node['id']: node for node in model['nodes']}
        self.assertTrue(model['stats']['inventory']['lookupComplete'])
        self.assertEqual([(nodes[str(root)]['listing'], nodes[str(root)]['omitted']) for root in roots], [('partial', 42), ('partial', 42)])
        self.assertEqual(model['stats']['inventory']['omitted'], 84)
        self.honest(model, roots)


def removed_on_disk(change, present):
    return sorted(item['path'] for item in change['files']['removed'] if item['path'] in present)


class CutListingAndChanges(CutListingCase):
    def test_with_the_index_exhausted_and_two_projects_no_file_on_disk_is_removed(self):
        roots = [self.flat('a', 61), self.flat('b', 61)]
        present = on_disk(roots)
        whole = scan(roots, 1000, 1000)
        for lookup in (0, 5, 40):
            with self.subTest(lookup=lookup):
                cut = scan(roots, 40, lookup)
                change = delta.compare(delta.read(whole, 'antes'), delta.read(cut, 'depois'), cut)
                self.assertEqual(removed_on_disk(change, present), [])
                self.assertEqual(change['files']['totals']['removed'], 0)
                self.assertGreater(change['files']['uncompared'], 0)
                # And the other way: the cut reading as reference does not make the whole one add files.
                back = delta.compare(delta.read(cut, 'antes'), delta.read(whole, 'depois'), whole)
                self.assertEqual(back['files']['totals']['added'], 0)

    def test_fuzz_no_false_removal_nor_addition_and_every_listing_is_honest(self):
        rng = random.Random(60)
        falses, pairs = [], 120
        for pair in range(pairs):
            shutil.rmtree(self.base)
            self.base.mkdir()
            roots = self.tree(rng)
            limits = [(rng.randint(2, 70), rng.choice((0, 5, 40, rng.randint(0, 60), 10 ** 6))) for _ in range(2)]
            before = on_disk(roots)
            first = scan(roots, *limits[0])
            with self.subTest(pair=pair, reading='first', limits=limits[0]):
                self.honest(first, roots)
            self.mutate(rng, roots)
            after = on_disk(roots)
            second = scan(roots, *limits[1])
            with self.subTest(pair=pair, reading='second', limits=limits[1]):
                self.honest(second, roots)
            change = delta.compare(delta.read(first, 'antes'), delta.read(second, 'depois'), second)
            removed = [item['path'] for item in change['files']['removed'] if item['path'] in after]
            added = [item['path'] for item in change['files']['added'] if item['path'] in before]
            if removed or added:
                falses.append((pair, limits, len(removed), len(added), (removed + added)[:2]))
        self.assertEqual(falses, [], f'{len(falses)} of {pairs} pairs with a file on disk removed or one already there added')

    def tree(self, rng):
        """One to three roots, one of them sometimes nested in another; folders up to three levels."""
        count = rng.randint(1, 3)
        roots = []
        for index in range(count):
            if roots and rng.random() < 0.3:
                root = rng.choice(roots) / f'n{index}'
            else:
                root = self.base / f'r{index}'
            root.mkdir(parents=True, exist_ok=True)
            roots.append(root)
            self.fill(rng, root, 0)
        return roots

    def fill(self, rng, folder, depth):
        for index in range(rng.randint(0, 9)):
            write(folder / f'f{index}.md')
        if rng.random() < 0.15:
            os.symlink('f0.md', folder / 'ligacao.md')
        if rng.random() < 0.1:
            write(folder / 'node_modules' / 'x.md')
        if depth < 3:
            for index in range(rng.randint(0, 3)):
                sub = folder / f'd{index}'
                sub.mkdir(exist_ok=True)
                self.fill(rng, sub, depth + 1)

    def mutate(self, rng, roots):
        files = sorted(path for path in on_disk(roots) if os.path.isfile(path) and not os.path.islink(path))
        for path in rng.sample(files, min(len(files), rng.randint(0, 4))):
            os.unlink(path)
        folders = sorted({str(root) for root in roots} | {path for path in on_disk(roots) if os.path.isdir(path) and not os.path.islink(path)})
        for index in range(rng.randint(0, 4)):
            write(Path(rng.choice(folders)) / f'novo{index}.md')


def illegible(folder, name=b'n\xff.md', directory=False):
    """A name that is not valid UTF-8 in `folder` (bytes on disk); its path as `os.scandir` gives it."""
    path = os.fsencode(str(folder)) + b'/' + name
    if directory:
        os.makedirs(path)
    else:
        with open(path, 'w') as stream:
            stream.write('# x\n')
    return os.fsdecode(path)


class IllegibleNameListing(CutListingCase):
    """A name that is not valid UTF-8 cannot enter the model (ids and JSON are UTF-8). Its folder was
    listed, but the model does not hold everything in it: the folder is `partial` (or `unread` when the
    name is all it has), the name counts in `omitted` of the folder and the folders above it, and the
    `unreadable` observation on the folder says which name. A folder with such a name counts as one
    element: what lies inside it is neither listed nor counted."""

    tree, fill = CutListingAndChanges.tree, CutListingAndChanges.fill

    def listings(self, model):
        return {node['relative']: (node['listing'], node['omitted']) for node in model['nodes']
                if node['kind'] == 'directory' and node['status'] == 'resolved'}

    def test_a_file_at_the_root_and_in_a_subfolder(self):
        root = self.flat('agent', 3)
        for index in range(2):
            write(root / 'a' / f'{index}.md')
        illegible(root)
        illegible(root / 'a', b'm\xfe.md')
        model = scan([root], 1000, 1000)
        self.assertEqual(self.listings(model), {'.': ('partial', 2), 'a': ('partial', 1)})
        inventory = model['stats']['inventory']
        self.assertEqual((inventory['complete'], inventory['lookupComplete'], inventory['omitted'], inventory['omittedFiles']), (True, True, 2, 2))
        self.assertEqual([(item['name'], item['inventoried'], item['onDisk']) for item in inventory['byTopLevel']], [('a', 2, 3)])
        unreadable = sorted((issue['node'], issue['message']) for issue in model['issues'] if issue['code'] == 'unreadable')
        self.assertEqual(unreadable, [(str(root), 'A name that is not valid UTF-8, left out of the scan: n\\xff.md'),
                                      (str(root / 'a'), 'A name that is not valid UTF-8, left out of the scan: m\\xfe.md')])
        self.assertFalse([issue for issue in model['issues'] if issue['code'] == 'limit'])
        json.dumps(model, ensure_ascii=False).encode('utf-8')  # the model stays valid UTF-8
        self.honest(model, [root])

    def test_a_folder_at_the_root_and_in_a_subfolder(self):
        root = self.flat('agent', 2)
        write(root / 'a' / 'x.md')
        illegible(root, b'zz\xff', directory=True)
        inner = illegible(root / 'a', b'sub\xff', directory=True)
        with open(os.fsencode(inner) + b'/dentro.md', 'w') as stream:
            stream.write('# x\n')
        model = scan([root], 1000, 1000)
        # Each folder with such a name counts as one element; `dentro.md`, inside one, is not counted.
        self.assertEqual(self.listings(model), {'.': ('partial', 2), 'a': ('partial', 1)})
        inventory = model['stats']['inventory']
        self.assertEqual((inventory['omitted'], inventory['omittedFiles'], inventory['lookupComplete']), (2, 0, True))

    def test_a_folder_whose_only_name_is_illegible_is_unread(self):
        root = self.flat('agent', 2)
        (root / 'so').mkdir()
        illegible(root / 'so')
        model = scan([root], 1000, 1000)
        # The folder is not `complete` with 0 left out, shown as an empty folder.
        self.assertEqual(self.listings(model), {'.': ('complete', 1), 'so': ('unread', 1)})
        self.honest(model, [root])

    def test_control_without_illegible_names_nothing_changes(self):
        root = self.flat('agent', 3)
        write(root / 'a' / 'x.md')
        model = scan([root], 1000, 1000)
        self.assertEqual(self.listings(model), {'.': ('complete', 0), 'a': ('complete', 0)})
        self.assertEqual(model['stats']['inventory']['omitted'], 0)

    def test_with_the_inventory_limit_lowered(self):
        root = self.base / 'agent'
        for folder in ('a', 'b', 'c'):
            for index in range(6):
                write(root / folder / f'{index}.md')
        for folder in ('a', 'c'):
            illegible(root / folder)
        # Inventory cut inside `a` or before it, the index whole, nearly spent or exhausted.
        for limit in (3, 6, 9, 12, 30):
            for lookup in (0, 4, 9, 1000):
                with self.subTest(limit=limit, lookup=lookup):
                    model = scan([root], limit, lookup)
                    listings = self.listings(model)
                    self.assertNotEqual(listings.get('c', ('partial',))[0], 'complete')
                    self.assertNotEqual(listings.get('a', ('partial',))[0], 'complete')
                    self.assertEqual(listings['.'][1], model['stats']['inventory']['omitted'])
                    if model['stats']['inventory']['lookupComplete']:
                        self.assertEqual(model['stats']['inventory']['omitted'], 23 - (len(model['nodes']) - 1))  # 3 folders, 18 files, 2 illegible names
                    self.honest(model, [root])

    def test_nested_roots_in_both_orders_count_the_name_once(self):
        outer = self.flat('outer', 2)
        inner = outer / 'inner'
        write(inner / 'x.md')
        illegible(inner)
        for roots in ([outer, inner], [inner, outer]):
            with self.subTest(roots=[root.name for root in roots]):
                model = scan(roots, 1000, 1000)
                nodes = {node['id']: node for node in model['nodes']}
                self.assertEqual((nodes[str(outer)]['listing'], nodes[str(outer)]['omitted']), ('complete', 1))
                self.assertEqual((nodes[str(inner)]['listing'], nodes[str(inner)]['omitted']), ('partial', 1))
                self.assertEqual(model['stats']['inventory']['omitted'], 1)
                self.honest(model, roots)

    def test_fuzz_every_listing_is_honest_with_illegible_files(self):
        rng = random.Random(78)
        for case in range(80):
            shutil.rmtree(self.base)
            self.base.mkdir()
            roots = self.tree(rng)
            folders = sorted({str(root) for root in roots} | {path for path in on_disk(roots) if os.path.isdir(path) and not os.path.islink(path)})
            for index, folder in enumerate(rng.sample(folders, min(len(folders), rng.randint(1, 3)))):
                illegible(folder, f'q{index}'.encode() + b'\xff.md')
            limits = (rng.randint(2, 70), rng.choice((0, 5, 40, 10 ** 6)))
            with self.subTest(case=case, limits=limits):
                self.honest(scan(roots, *limits), roots)


class LeftOutCause(CutListingCase):
    """Each folder that is not `complete` says why (`leftOutBy`): what happened in that folder, never a fact
    of the whole reading. The `limit` observation counts only what the limit left out."""

    def causes(self, model):
        return {node['relative']: (node['listing'], node.get('leftOutBy')) for node in model['nodes']
                if node['kind'] == 'directory' and node['status'] == 'resolved'}

    def limit_message(self, model):
        return next(issue['message'] for issue in model['issues'] if issue['code'] == 'limit' and 'Inventory limit' in issue['message'])

    def limit_cuts_only_the_large_folder(self):
        """`a` has `x.md` and an illegible name; `b` has 30 files; with MAX_FILES=10 the limit cuts only `b`."""
        root = self.base / 'agent'
        write(root / 'a' / 'x.md')
        illegible(root / 'a')
        for index in range(30):
            write(root / 'b' / f'f{index:02}.md')
        return root

    def test_an_illegible_name_with_the_limit_cutting_another_folder(self):
        root = self.limit_cuts_only_the_large_folder()
        model = scan([root], 10, 1000)
        self.assertFalse(model['stats']['inventory']['complete'])
        causes = self.causes(model)
        self.assertEqual(causes['a'], ('partial', ['unreadable']))
        self.assertEqual(causes['b'], ('partial', ['limit']))
        self.assertEqual(causes['.'], ('complete', None))

    def test_both_causes_in_the_same_folder(self):
        root = self.base / 'agent'
        for index in range(30):
            write(root / 'b' / f'f{index:02}.md')
        illegible(root / 'b')
        self.assertEqual(self.causes(scan([root], 10, 1000))['b'], ('partial', ['limit', 'unreadable']))

    def test_a_folder_that_cannot_be_listed(self):
        if os.geteuid() == 0:
            self.skipTest('root lists any folder')
        root = self.base / 'agent'
        write(root / 'fechada' / 'x.md')
        for index in range(30):
            write(root / 'b' / f'f{index:02}.md')
        os.chmod(root / 'fechada', 0)
        self.addCleanup(os.chmod, root / 'fechada', 0o755)
        for limit, expected in ((1000, ('unread', ['unreadable'])), (10, ('unread', ['unreadable']))):
            with self.subTest(limit=limit):
                self.assertEqual(self.causes(scan([root], limit, 1000))['fechada'], expected)

    def test_a_folder_never_listed_because_the_index_ran_out_is_cut_by_the_limit(self):
        root = self.base / 'agent'
        for folder in ('a', 'b', 'c'):
            for index in range(10):
                write(root / folder / f'{index}.md')
        causes = self.causes(scan([root], 6, 0))
        self.assertEqual(causes['c'], ('unread', ['limit']))

    def test_the_limit_observation_counts_only_what_the_limit_left_out(self):
        root = self.limit_cuts_only_the_large_folder()
        with_name = self.limit_message(scan([root], 10, 1000))
        os.unlink(os.fsencode(str(root / 'a')) + b'/n\xff.md')
        without = self.limit_message(scan([root], 10, 1000))
        # The same words with and without the illegible name: 1 folder and 24 elements, all in `b`.
        self.assertEqual(with_name, without)
        self.assertIn('folders read in part: 1; folders not read: 0; items left out of the inventory: 24.', with_name)

    def test_a_folder_of_illegible_name_makes_the_count_a_minimum(self):
        root = self.flat('agent', 2)
        write(root / 'a' / 'x.md')
        inner = illegible(root / 'a', b'dados\xff', directory=True)
        for index in range(5):
            with open(os.fsencode(inner) + f'/{index}.md'.encode(), 'w') as stream:
                stream.write('# x\n')
        nodes = {node['relative']: node for node in scan([root], 1000, 1000)['nodes']}
        self.assertEqual((nodes['a']['omitted'], nodes['a'].get('omittedMinimum')), (1, True))
        self.assertEqual((nodes['.']['omitted'], nodes['.'].get('omittedMinimum')), (1, True))
        # Control: an illegible file is counted exactly.
        shutil.rmtree(inner)
        illegible(root / 'a')
        nodes = {node['relative']: node for node in scan([root], 1000, 1000)['nodes']}
        self.assertEqual((nodes['a']['omitted'], nodes['a'].get('omittedMinimum')), (1, None))


class IllegibleNameAndChanges(CutListingCase):
    """Changes trusts `listing`: with an illegible name, no file on disk comes out as removed or added."""

    def test_an_illegible_name_added_or_removed_between_readings(self):
        root = self.flat('agent', 3)
        write(root / 'a' / 'x.md')
        present = on_disk([root])
        whole = scan([root], 1000, 1000)
        name = illegible(root / 'a')
        with_name = scan([root], 1000, 1000)
        for before, after in ((whole, with_name), (with_name, whole)):
            change = delta.compare(delta.read(before, 'antes'), delta.read(after, 'depois'), after)
            self.assertEqual(removed_on_disk(change, present), [])
            self.assertEqual((change['files']['totals']['added'], change['files']['totals']['removed']), (0, 0))
            self.assertNotIn(name, [item['path'] for item in change['files']['added'] + change['files']['removed']])

    def test_a_real_removal_elsewhere_is_still_removed_and_in_the_same_folder_not_compared(self):
        root = self.flat('agent', 3)
        write(root / 'a' / 'x.md')
        write(root / 'b' / 'y.md')
        illegible(root / 'a')
        before = scan([root], 1000, 1000)
        os.unlink(root / 'b' / 'y.md')
        os.unlink(root / 'a' / 'x.md')
        after = scan([root], 1000, 1000)
        change = delta.compare(delta.read(before, 'antes'), delta.read(after, 'depois'), after)
        self.assertEqual([item['relative'] for item in change['files']['removed']], ['b/y.md'])
        # `a` is listed in part: an absence there is not affirmed.
        self.assertEqual(change['files']['uncompared'], 1)


if __name__ == '__main__':
    unittest.main()
