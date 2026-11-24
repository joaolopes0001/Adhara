"""Write core of document editing (server/editing.py): every filesystem is a disposable temporary.

Each refusal checks the stable code and that the whole temporary tree is identical
afterwards: bytes, inode, mode, owner, group and mtime of every file, mode and listing of
every folder (a folder's own mtime moves when a temporary is created and removed), and
no `.aae-edit-*` leftover anywhere.
"""
import contextlib
import errno
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'server'))
import editing
from editing import BOM, MAX_BYTES, Refusal, check_root, read_for_edit, save
from protected import ENVIRONMENT, STATE_FILE, configure_state_dir, default_state_dir
from scanner import scan
from workspace import Workspace


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(base):
    result, pending = {}, [Path(base)]
    while pending:
        folder = pending.pop()
        info = folder.lstat()
        names = tuple(sorted(os.listdir(folder)))
        result[str(folder)] = ('folder', stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, names)
        for name in names:
            path = folder / name
            try:
                info = path.lstat()
            except PermissionError:  # A folder without search permission, on purpose.
                result[str(path)] = ('unreachable',)
                continue
            if stat.S_ISDIR(info.st_mode):
                pending.append(path)
            elif stat.S_ISREG(info.st_mode):
                try:
                    digest = sha(path.read_bytes())
                except PermissionError:  # A file without read permission, on purpose.
                    digest = 'unreadable'
                result[str(path)] = ('file', info.st_mode, info.st_uid, info.st_gid, info.st_ino, info.st_nlink,
                                     info.st_size, info.st_mtime_ns, digest)
            else:  # Links and FIFOs are never opened here.
                result[str(path)] = ('other', info.st_mode, os.readlink(path) if stat.S_ISLNK(info.st_mode) else None)
    return result


def leftovers(base):
    return [os.path.join(folder, name) for folder, dirs, files in os.walk(base)
            for name in dirs + files if name.startswith('.aae-edit-')]


def failing(error=errno.EIO):
    return OSError(error, os.strerror(error))


CURRENT = object()  # The hash of the bytes on disk right before the call.


class Fixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-editing-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'project'
        (self.root / 'docs').mkdir(parents=True)
        (self.root / 'node_modules' / 'pkg').mkdir(parents=True)
        (self.root / 'node_modules' / 'pkg' / 'x.md').write_text('# Dependency\n')
        (self.root / '.git').mkdir()
        (self.root / '.git' / 'x.md').write_text('# Git\n')
        (self.base / 'outside.md').write_text('# Outside\n')
        self.doc = self.root / 'docs' / 'guide.md'
        self.doc.write_bytes(b'# Guide\n\nText.\n')
        (self.root / 'AGENTS.md').write_text('# Agents\n[Guide](docs/guide.md)\n[Absent](absent.md)\n'
                                             '[Outside](../outside.md)\n[Dependency](node_modules/pkg/x.md)\n')
        # Hermetic: no protected entry from the environment, HOME and both state directories temporary.
        self.home = self.base / 'home'
        self.home.mkdir()
        environment = {key: value for key, value in os.environ.items() if key != ENVIRONMENT}
        environment['HOME'] = str(self.home)
        variables = patch.dict(os.environ, environment, clear=True)
        variables.start()
        self.addCleanup(variables.stop)
        self.state = self.base / 'state'
        self.state.mkdir()
        configure_state_dir(self.state)
        self.addCleanup(configure_state_dir, None)
        self.states = [self.state, default_state_dir().resolve()]

    def protect(self, *paths):
        return patch.dict(os.environ, {ENVIRONMENT: os.pathsep.join(map(str, paths))})

    def model(self, *roots):
        return scan([str(root) for root in roots or [self.root]])

    def read(self, path=None, root=None, model=None, states=None):
        return read_for_edit(model or self.model(), str(root or self.root), str(path or self.doc),
                             self.states if states is None else states)

    def save(self, text, path=None, base=CURRENT, root=None, model=None, states=None):
        path = Path(path or self.doc)
        base = sha(path.read_bytes()) if base is CURRENT else base
        return save(model or self.model(), str(root or self.root), str(path), base, text,
                    self.states if states is None else states)

    def assertRefused(self, code, call, *contexts):
        """`call` refuses with `code` and the whole tree stays as it was; `contexts` wrap only the call."""
        before = fingerprint(self.base)
        with self.assertRaises(Refusal) as caught:
            with contextlib.ExitStack() as stack:
                for context in contexts:
                    stack.enter_context(context)
                call()
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        self.assertEqual(caught.exception.status, editing.STATUS.get(code, 400))
        self.assertTrue(str(caught.exception))
        self.assertEqual(leftovers(self.base), [])
        self.assertEqual(fingerprint(self.base), before)
        return caught.exception

    def assertReadAndSaveRefused(self, code, path=None, **options):
        model = options.pop('model', None) or self.model(*options.pop('roots', ()))
        self.assertRefused(code, lambda: self.read(path, model=model, **options))
        self.assertRefused(code, lambda: self.save('# Changed\n', path, base='0' * 64, model=model, **options))

    def after_step_19(self, action):
        """Run `action` once while the temporary is synced: the end of step 19, right before the checks of 20 and 21."""
        real_fsync, real_fstat = os.fsync, os.fstat
        done = []
        def fsync(fd):
            if not done and stat.S_ISREG(real_fstat(fd).st_mode):
                done.append(True)
                action()
            return real_fsync(fd)
        return patch('editing.os.fsync', side_effect=fsync)

    def save_refused_after_step_19(self, code, action, text='# Mine\n'):
        read = self.read()
        with self.after_step_19(action), self.assertRaises(Refusal) as caught:
            self.save(text, base=read['sha256'])
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        self.assertEqual(leftovers(self.base), [])
        return caught.exception

    def within_seconds(self, call, seconds=10):
        """Run `call` in a thread: a FIFO opened without O_NONBLOCK would hang the test, not the suite."""
        outcome = {}
        def run():
            try:
                outcome['value'] = call()
            except BaseException as exc:  # noqa: BLE001 - re-raised in the test thread
                outcome['error'] = exc
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(seconds)
        self.assertFalse(worker.is_alive(), 'a chamada travou')
        if 'error' in outcome:
            raise outcome['error']
        return outcome['value']


class ReadAndSaveTests(Fixture, unittest.TestCase):
    def test_read_returns_text_hash_size_and_line_breaks_of_the_disk(self):
        result = self.read()
        self.assertEqual(result, {'path': str(self.doc), 'text': '# Guide\n\nText.\n', 'sha256': sha(self.doc.read_bytes()),
                                  'bytes': 15, 'eol': 'lf', 'bom': False})
        node = next(node for node in self.model()['nodes'] if node['id'] == str(self.doc))
        self.assertEqual(result['sha256'], node['sha256'])
        raw = BOM + b'# T\r\nline\r\n'
        self.doc.write_bytes(raw)
        self.assertEqual(self.read(), {'path': str(self.doc), 'text': '# T\nline\n', 'sha256': sha(raw), 'bytes': len(raw),
                                       'eol': 'crlf', 'bom': True})

    def test_save_replaces_atomically_and_keeps_the_mode(self):
        os.chmod(self.doc, 0o640)
        before = self.doc.read_bytes()
        inode = self.doc.stat().st_ino
        result = self.save('# Guide\n\nNew text.\n')
        self.assertEqual(self.doc.read_bytes(), b'# Guide\n\nNew text.\n')
        self.assertEqual(result, {'path': str(self.doc), 'sha256': sha(b'# Guide\n\nNew text.\n'), 'bytes': 19,
                                  'previousSha256': sha(before), 'unchanged': False, 'durable': True})
        self.assertEqual(stat.S_IMODE(self.doc.stat().st_mode), 0o640)
        self.assertNotEqual(self.doc.stat().st_ino, inode)
        self.assertEqual(sorted(os.listdir(self.doc.parent)), ['guide.md'])
        self.assertEqual(leftovers(self.base), [])

    def test_save_keeps_a_supplementary_group(self):
        groups = [group for group in os.getgroups() if group != os.getegid()]
        if not groups:
            self.skipTest('o usuário não tem grupo suplementar; a preservação do grupo não foi exercitada')
        try:
            os.chown(self.doc, -1, groups[0])
        except OSError as exc:
            self.skipTest(f'o sistema não deixou trocar o grupo do arquivo de teste ({exc.strerror})')
        os.chmod(self.doc, 0o664)
        self.save('# Group\n')
        info = self.doc.stat()
        self.assertEqual((info.st_gid, stat.S_IMODE(info.st_mode)), (groups[0], 0o664))

    def test_crlf_bom_and_missing_final_newline_survive_a_change(self):
        self.doc.write_bytes(BOM + b'# T\r\nfirst\r\nlast')
        read = self.read()
        self.assertEqual((read['text'], read['eol'], read['bom']), ('# T\nfirst\nlast', 'crlf', True))
        self.save(read['text'].replace('first', 'second'), base=read['sha256'])
        self.assertEqual(self.doc.read_bytes(), BOM + b'# T\r\nsecond\r\nlast')

    def test_identical_text_is_unchanged_and_not_rewritten(self):
        before = self.doc.stat()
        result = self.save('# Guide\n\nText.\n')
        after = self.doc.stat()
        self.assertTrue(result['unchanged'])
        self.assertEqual(result['sha256'], result['previousSha256'])
        self.assertEqual((after.st_ino, after.st_mtime_ns, after.st_ctime_ns), (before.st_ino, before.st_mtime_ns, before.st_ctime_ns))

    def test_round_trip_without_changes_keeps_every_byte(self):
        exact = b'0123456789abcde\n' * (MAX_BYTES // 16)
        self.assertEqual(len(exact), 256 * 1024)
        for label, raw in [('empty', b''), ('bom only', BOM), ('crlf without final newline', b'# T\r\nlast'),
                           ('256 KiB', exact), ('bom and crlf', BOM + b'a\r\n\r\n'), ('unicode', '# Ação ✓   𝄞\n'.encode())]:
            with self.subTest(label):
                self.doc.write_bytes(raw)
                read = self.read()
                result = self.save(read['text'], base=read['sha256'])
                self.assertTrue(result['unchanged'])
                self.assertEqual(self.doc.read_bytes(), raw)
                self.assertEqual((result['sha256'], result['bytes']), (sha(raw), len(raw)))

    def test_a_file_of_exactly_256_kib_is_saved_and_one_more_byte_is_refused(self):
        exact = b'0123456789abcde\n' * (MAX_BYTES // 16)
        self.doc.write_bytes(exact)
        changed = 'X' + exact.decode()[1:]
        self.assertEqual(self.save(changed)['bytes'], MAX_BYTES)
        self.assertRefused('too-large', lambda: self.save(changed + 'y'))
        self.assertEqual(self.doc.read_bytes(), b'X' + exact[1:])

    def test_markdown_suffixes_and_uppercase_are_editable(self):
        for name in ['README.MD', 'notes.markdown', 'Guide.Markdown']:
            with self.subTest(name):
                path = self.root / name
                path.write_text('# Before\n')
                self.save('# After\n', path)
                self.assertEqual(path.read_text(), '# After\n')

    def test_unusual_names_are_saved_without_leftovers(self):
        for name in ['with space.md', 'hash#[brackets].md', 'ação.md', 'line\nbreak.md', 'n' * 251 + '.md']:
            with self.subTest(name=name[:20]):
                path = self.root / 'docs' / name
                path.write_text('# Before\n')
                self.save('# After\n', path)
                self.assertEqual(path.read_text(), '# After\n')
                self.assertEqual(leftovers(self.base), [])

    def test_saved_hash_matches_the_node_and_changes_list_the_file_after_rereading(self):
        workspace = Workspace(self.base / 'workspace-state')
        workspace.open(str(self.root))
        read = self.read(model=workspace.model)
        result = self.save(read['text'] + 'More.\n', base=read['sha256'], model=workspace.model)
        snapshot = workspace.refresh()
        node = next(node for node in snapshot['nodes'] if node['id'] == str(self.doc))
        self.assertEqual(node['sha256'], result['sha256'])
        self.assertIn(str(self.doc), [item['path'] for item in snapshot['delta']['files']['changed']])


class ContainmentTests(Fixture, unittest.TestCase):
    def test_traversal_relative_and_malformed_paths(self):
        for path in [f'{self.root}/docs/../AGENTS.md', 'docs/guide.md', f'{self.doc}\x00', f'{self.root}//docs/guide.md',
                     f'{self.root}/./docs/guide.md', f'{self.doc}/', None, 3]:
            with self.subTest(path=path):
                model = self.model()
                self.assertRefused('not-in-workspace', lambda: read_for_edit(model, str(self.root), path, self.states))
                self.assertRefused('not-in-workspace', lambda: save(model, str(self.root), path, '0' * 64, 'x\n', self.states))

    def test_node_that_is_not_normalized_is_refused_before_the_model(self):
        # The scanner never produces one; the shape check holds even if a model did.
        model = self.model()
        node = next(node for node in model['nodes'] if node['id'] == str(self.doc))
        crooked = f'{self.root}/docs/../docs/guide.md'
        model = {**model, 'nodes': [*model['nodes'], {**node, 'id': crooked, 'path': crooked}]}
        self.assertRefused('not-in-workspace', lambda: read_for_edit(model, str(self.root), crooked, self.states))
        self.assertRefused('not-in-workspace', lambda: save(model, str(self.root), crooked, '0' * 64, 'x\n', self.states))

    def test_absolute_path_outside_the_informed_root(self):
        other = self.base / 'other'
        other.mkdir()
        (other / 'doc.md').write_text('# Other\n')
        both = self.model(self.root, other)
        self.assertReadAndSaveRefused('not-in-workspace', self.base / 'outside.md')
        self.assertReadAndSaveRefused('not-in-workspace', other / 'doc.md', model=both)
        self.assertEqual(self.read(other / 'doc.md', root=other, model=both)['text'], '# Other\n')

    def test_root_that_is_not_open(self):
        self.assertReadAndSaveRefused('not-in-workspace', root=self.base)
        self.assertReadAndSaveRefused('not-in-workspace', root=self.root / 'docs')

    def test_directory_and_reference_markers(self):
        model = self.model()
        statuses = {node['id']: (node['kind'], node['status']) for node in model['nodes']}
        markers = {str(self.root / 'absent.md'): 'missing', str(self.base / 'outside.md'): 'external',
                   str(self.root / 'node_modules' / 'pkg' / 'x.md'): 'unscanned'}
        self.assertEqual({path: statuses[path] for path in markers}, {path: ('unresolved', status) for path, status in markers.items()})
        for path in [self.root / 'docs', *markers]:
            with self.subTest(path=path):
                self.assertReadAndSaveRefused('not-in-workspace', path, model=model)
        # A node is editable only while `resolved`: a declared placeholder never is.
        declared = {**model, 'nodes': [{**node, 'status': 'declared'} if node['id'] == str(self.doc) else node for node in model['nodes']]}
        self.assertReadAndSaveRefused('not-in-workspace', model=declared)

    def test_file_created_after_the_reading(self):
        model = self.model()
        (self.root / 'new.md').write_text('# New\n')
        self.assertReadAndSaveRefused('not-in-workspace', self.root / 'new.md', model=model)

    def test_files_in_excluded_folders(self):
        for path in [self.root / 'node_modules' / 'pkg' / 'x.md', self.root / '.git' / 'x.md']:
            with self.subTest(path=path):
                self.assertReadAndSaveRefused('not-in-workspace', path)

    def test_nested_root_inside_an_excluded_folder_of_the_outer_root(self):
        nested = self.root / 'build' / 'pkg'
        nested.mkdir(parents=True)
        (nested / 'x.md').write_text('# Nested\n')
        model = self.model(self.root, nested)
        node = next(node for node in model['nodes'] if node['id'] == str(nested / 'x.md'))
        self.assertEqual(sorted(node['roots']), sorted([str(self.root), str(nested)]))
        # The outer root does not read build/: its editing never reaches the nested file.
        self.assertReadAndSaveRefused('not-in-workspace', nested / 'x.md', model=model)
        self.assertEqual(self.read(nested / 'x.md', root=nested, model=model)['text'], '# Nested\n')

    def test_file_that_is_a_symbolic_link(self):
        (self.root / 'link.md').symlink_to(self.doc)
        self.assertReadAndSaveRefused('not-in-workspace', self.root / 'link.md')

    def test_file_swapped_for_a_link_after_the_reading(self):
        model = self.model()
        self.doc.unlink()
        self.doc.symlink_to(self.base / 'outside.md')
        self.assertReadAndSaveRefused('not-regular', model=model)
        self.assertEqual((self.base / 'outside.md').read_text(), '# Outside\n')

    def test_folder_swapped_for_a_link_after_the_reading(self):
        model = self.model()
        decoy = self.base / 'decoy'
        decoy.mkdir()
        (decoy / 'guide.md').write_text('# Decoy\n')
        (self.root / 'docs').rename(self.root / 'docs-real')
        (self.root / 'docs').symlink_to(decoy, target_is_directory=True)
        self.assertReadAndSaveRefused('not-regular', model=model)
        self.assertRefused('not-regular', lambda: self.save('# Changed\n', model=model))  # with the decoy's own hash
        self.assertEqual((decoy / 'guide.md').read_text(), '# Decoy\n')

    def test_root_swapped_for_a_link_after_the_reading(self):
        model = self.model()
        decoy = self.base / 'decoy'
        (decoy / 'docs').mkdir(parents=True)
        (decoy / 'docs' / 'guide.md').write_text('# Decoy\n')
        self.root.rename(self.base / 'project-real')
        self.root.symlink_to(decoy, target_is_directory=True)
        self.assertReadAndSaveRefused('not-regular', model=model)
        self.assertRefused('not-in-workspace', lambda: check_root(model, str(self.root), self.states))
        self.assertEqual((decoy / 'docs' / 'guide.md').read_text(), '# Decoy\n')

    def test_hardlink(self):
        os.link(self.doc, self.base / 'second-name.md')
        self.assertReadAndSaveRefused('hardlink')
        self.assertRefused('hardlink', lambda: self.save('# Changed\n'))

    def test_file_of_another_owner_simulated(self):
        real_fstat = os.fstat

        class Foreign:
            def __init__(self, info):
                self.info = info

            def __getattr__(self, name):
                return getattr(self.info, name)

            st_uid = property(lambda self: self.info.st_uid + 1)

        def fstat(fd):
            info = real_fstat(fd)
            return Foreign(info) if stat.S_ISREG(info.st_mode) else info
        foreign = patch('editing.os.fstat', side_effect=fstat)
        self.assertRefused('other-owner', lambda: self.read(), foreign)
        self.assertRefused('other-owner', lambda: self.save('# Changed\n'), patch('editing.os.fstat', side_effect=fstat))

    def test_file_without_the_write_bit(self):
        os.chmod(self.doc, 0o444)
        self.assertRefused('read-only-file', lambda: self.read())
        self.assertRefused('read-only-file', lambda: self.save('# Changed\n'))

    def test_missing_permission_is_named_as_such(self):
        if os.geteuid() == 0:
            self.skipTest('como root, as permissões não impedem a leitura')
        os.chmod(self.doc, 0o200)  # The owner may write but not read.
        self.addCleanup(os.chmod, self.doc, 0o644)
        error = self.assertRefused('not-regular', lambda: self.read())
        self.assertIn('permission', str(error))
        self.assertNotIn('link', str(error))
        os.chmod(self.doc, 0o644)
        model = self.model()
        for folder in [self.doc.parent, self.root]:  # The file's own folder, then one above it.
            with self.subTest(folder=folder.name):
                os.chmod(folder, 0o600)  # No search permission.
                self.addCleanup(os.chmod, folder, 0o755)
                error = self.assertRefused('not-regular', lambda: self.save('# Changed\n', base='0' * 64, model=model))
                self.assertIn('permission', str(error))
                self.assertNotIn('link', str(error))
                os.chmod(folder, 0o755)

    def test_folder_without_write_permission(self):
        if os.geteuid() == 0:
            self.skipTest('como root, a permissão da pasta não impede criar o temporário')
        folder = self.doc.parent
        os.chmod(folder, 0o555)
        self.addCleanup(os.chmod, folder, 0o755)
        self.assertEqual(self.read()['text'], '# Guide\n\nText.\n')
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'))


class ProtectionTests(Fixture, unittest.TestCase):
    def test_protected_root_file_and_subfolder(self):
        with self.protect(self.root):
            self.assertReadAndSaveRefused('protected')
            self.assertRefused('protected', lambda: self.save('# Changed\n'))
            self.assertRefused('protected', lambda: check_root(self.model(), str(self.root), self.states))
        with self.protect(self.doc):
            self.assertReadAndSaveRefused('protected')
        with self.protect(self.root / 'docs'):
            self.assertReadAndSaveRefused('protected')
            self.assertRefused('protected', lambda: self.save('# Changed\n'))
            # The rest of the root stays editable, and editing can be granted on the root.
            self.save('# Agents\n', self.root / 'AGENTS.md')
            self.assertIsNone(check_root(self.model(), str(self.root), self.states))

    def test_broken_protection_configuration_fails_closed(self):
        with self.protect('relative/path'):
            error = self.assertRefused('protected', lambda: self.read())
            self.assertIn('absolute', str(error))
            self.assertRefused('protected', lambda: self.save('# Changed\n'))
            self.assertRefused('protected', lambda: check_root(self.model(), str(self.root), self.states))
        (self.state / STATE_FILE).write_text(f'{self.base}/does-not-exist\n')
        self.assertReadAndSaveRefused('protected')

    def test_protected_entry_that_is_a_link_to_the_folder(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.root / 'docs', target_is_directory=True)
        with self.protect(alias):
            self.assertRefused('protected', lambda: self.save('# Changed\n'))

    def test_another_name_of_the_file_is_protected_by_identity(self):
        # A second name of the same inode outside the project: no path comparison can see it.
        other = self.base / 'protected-name.md'
        os.link(self.doc, other)
        with self.protect(other):
            self.assertRefused('protected', lambda: self.save('# Changed\n'))

    def test_folder_alias_by_identity_simulated(self):
        """What a bind mount does: an entry at another path with the identity of a pinned folder."""
        mirror = self.base / 'mirror'
        mirror.mkdir()
        real_stat = os.stat
        def aliased(path, *args, **kwargs):
            if os.fspath(path) == str(mirror) and not args and not kwargs:
                return real_stat(self.root / 'docs')
            return real_stat(path, *args, **kwargs)
        with self.protect(mirror):
            self.assertRefused('protected', lambda: self.read(), patch('editing.os.stat', side_effect=aliased))
            self.assertRefused('protected', lambda: self.save('# Changed\n'), patch('editing.os.stat', side_effect=aliased))
            # The same for the root itself, at the grant.
            def root_alias(path, *args, **kwargs):
                if os.fspath(path) == str(mirror) and not args and not kwargs:
                    return real_stat(self.root)
                return real_stat(path, *args, **kwargs)
            model = self.model()
            self.assertRefused('protected', lambda: check_root(model, str(self.root), self.states),
                               patch('editing.os.stat', side_effect=root_alias))
            self.assertIsNone(check_root(model, str(self.root), self.states))

    def test_every_pinned_folder_is_compared_not_only_the_last(self):
        """A bind mount of the protected folder itself, with the file in a subfolder of it (simulated)."""
        (self.root / 'docs' / 'sub').mkdir()
        deep = self.root / 'docs' / 'sub' / 'note.md'
        deep.write_text('# Deep\n')
        mirror = self.base / 'mirror'
        mirror.mkdir()
        real_stat = os.stat
        def aliased(path, *args, **kwargs):
            if os.fspath(path) == str(mirror) and not args and not kwargs:
                return real_stat(self.root / 'docs')
            return real_stat(path, *args, **kwargs)
        with self.protect(mirror):
            self.assertRefused('protected', lambda: self.save('# Changed\n', deep), patch('editing.os.stat', side_effect=aliased))
        # The same for a state directory: its identity is compared too.
        self.assertRefused('app-state', lambda: self.save('# Changed\n', deep, states=[mirror]),
                           patch('editing.os.stat', side_effect=aliased))

    def test_comparison_by_path_holds_without_a_stable_identity(self):
        """A filesystem whose inode numbers are not stable: the path rules refuse on their own."""
        folder = self.root / 'docs'
        unrelated = os.stat(self.base / 'outside.md')
        real_stat = os.stat
        def unstable(path, *args, **kwargs):
            if os.fspath(path) == str(folder) and not args and not kwargs:
                return unrelated
            return real_stat(path, *args, **kwargs)
        with self.protect(folder):
            self.assertRefused('protected', lambda: self.save('# Changed\n'), patch('editing.os.stat', side_effect=unstable))
        self.assertRefused('app-state', lambda: self.save('# Changed\n', states=[folder]),
                           patch('editing.os.stat', side_effect=unstable))

    def test_protected_entry_that_cannot_be_consulted_fails_closed(self):
        # The configuration is read first (step 9); the entry then vanishes or denies access (step 11).
        vanished = self.base / 'vanished'
        error = self.assertRefused('protected', lambda: self.save('# Changed\n'),
                                   patch('editing.protected_paths', return_value=frozenset({vanished})))
        self.assertIn('consult', str(error))
        guarded = self.base / 'guarded'
        guarded.mkdir()
        real_stat, real_lstat = os.stat, os.lstat
        def denied(real):
            def call(path, *args, **kwargs):
                if os.fspath(path) == str(guarded):
                    raise failing(errno.EACCES)
                return real(path, *args, **kwargs)
            return call
        self.assertRefused('protected', lambda: self.save('# Changed\n'),
                           patch('editing.protected_paths', return_value=frozenset({guarded})),
                           patch('editing.os.stat', side_effect=denied(real_stat)),
                           patch('editing.os.lstat', side_effect=denied(real_lstat)))

    def test_a_dangling_link_entry_leaves_other_projects_editable(self):
        """The destination of a dangling link entry has no identity: only that form is skipped, by path it still counts."""
        disk = self.base / 'unmounted-disk'
        dangling = self.base / 'dangling'
        dangling.symlink_to(disk)
        with self.protect(dangling):
            self.assertEqual(self.read()['text'], '# Guide\n\nText.\n')
            self.assertFalse(self.save('# Changed\n')['unchanged'])
            self.assertIsNone(check_root(self.model(), str(self.root), self.states))
            # Once the destination exists it is compared by identity again: here, another name of the document.
            os.link(self.doc, disk)
            self.assertRefused('protected', lambda: self.save('# Again\n'))
            self.assertRefused('protected', lambda: self.read())
            os.unlink(disk)
            # By path, the missing destination always counted: a root opened at that path is refused.
            disk.mkdir()
            (disk / 'notes.md').write_text('# Disk\n')
            self.assertRefused('protected', lambda: check_root(self.model(disk), str(disk), self.states))

    def test_only_a_missing_destination_of_a_dangling_link_is_skipped(self):
        """The destination of a dangling link that cannot be consulted for another reason still refuses everything."""
        disk = self.base / 'unmounted-disk'
        dangling = self.base / 'dangling'
        dangling.symlink_to(disk)
        real_stat, real_lstat = os.stat, os.lstat
        def denied(real):
            def call(path, *args, **kwargs):
                if os.fspath(path) == str(disk):
                    raise failing(errno.EACCES)
                return real(path, *args, **kwargs)
            return call
        with self.protect(dangling):
            error = self.assertRefused('protected', lambda: self.save('# Changed\n'),
                                       patch('editing.os.stat', side_effect=denied(real_stat)),
                                       patch('editing.os.lstat', side_effect=denied(real_lstat)))
            self.assertIn('consult', str(error))
        # A missing entry that is the destination of no link in the list (it vanished after being read) refuses too.
        self.assertRefused('protected', lambda: self.save('# Changed\n'),
                           patch('editing.protected_paths', return_value=frozenset({disk})))

    def test_an_entry_that_fails_closed_is_named_as_it_was_written(self):
        """`links/via/../alvo`, with `via` a link, exists as written; its normalized form does not."""
        (self.base / 'deep' / 'a').mkdir(parents=True)
        (self.base / 'deep' / 'alvo').mkdir()
        (self.base / 'links').mkdir()
        (self.base / 'links' / 'via').symlink_to(self.base / 'deep' / 'a', target_is_directory=True)
        written = f'{self.base}/links/via/../alvo'
        with self.protect(written):
            error = str(self.assertRefused('protected', lambda: self.save('# Changed\n')))
        self.assertIn(f'protected entry {written}, from {ENVIRONMENT}', error)
        self.assertIn(f'the form {self.base}/links/alvo', error)
        # The same line in the list of the state directory names that file.
        (self.state / STATE_FILE).write_text(f'{written}\n')
        error = str(self.assertRefused('protected', lambda: self.read()))
        self.assertIn(f'protected entry {written}, from {self.state / STATE_FILE}', error)
        # A link to a folder that cannot be consulted: the link is named, not its destination.
        if os.geteuid() != 0:
            (self.state / STATE_FILE).unlink()
            closed = self.base / 'closed'
            (closed / 'inside').mkdir(parents=True)
            link = self.base / 'links' / 'to-closed'
            link.symlink_to(closed / 'inside', target_is_directory=True)
            os.chmod(closed, 0o600)  # No search permission.
            self.addCleanup(os.chmod, closed, 0o755)
            with self.protect(link):
                error = str(self.assertRefused('protected', lambda: self.save('# Changed\n')))
            os.chmod(closed, 0o755)
            self.assertIn(f'protected entry {link}, from {ENVIRONMENT}: the form {closed}/inside', error)

    BIND = (
        'import hashlib, subprocess, sys\n'
        'sys.path.insert(0, sys.argv[1])\n'
        'import editing\n'
        'from scanner import scan\n'
        'source, guarded, alias, mode = sys.argv[2:6]\n'
        "if subprocess.run(['mount', '--bind', source, alias]).returncode:\n"
        "    print('no-mount'); sys.exit(0)\n"
        "target = alias + '/note.md'\n"
        'model = scan([alias])\n'
        "states = [guarded] if mode == 'state' else []\n"
        'base = hashlib.sha256(open(target, "rb").read()).hexdigest()\n'
        'codes = []\n'
        'for call in (lambda: editing.read_for_edit(model, alias, target, states),\n'
        "             lambda: editing.save(model, alias, target, base, '# Changed through the alias\\n', states),\n"
        '             lambda: editing.check_root(model, alias, states)):\n'
        '    try:\n'
        '        call(); codes.append("accepted")\n'
        '    except editing.Refusal as exc:\n'
        '        codes.append(exc.code)\n'
        "print(' '.join(codes))\n")

    def bind_mounted(self, source, guarded, mode):
        """Codes of read, save and grant on a bind mount of `source` at a new root, in `unshare -rm`."""
        if not shutil.which('unshare') or not shutil.which('mount'):
            self.skipTest('unshare ou mount ausente')
        probe = subprocess.run(['unshare', '-rm', 'true'], capture_output=True, timeout=30)
        if probe.returncode:
            self.skipTest('o sistema não permite um namespace de montagem sem privilégio (unshare -rm)')
        alias = self.base / 'alias'
        alias.mkdir(exist_ok=True)
        variables = {ENVIRONMENT: str(guarded)} if mode == 'protected' else {}
        run = subprocess.run(['unshare', '-rm', sys.executable, '-I', '-c', self.BIND, str(REPO / 'server'), str(source),
                              str(guarded), str(alias), mode], capture_output=True, text=True, timeout=60,
                             env={**os.environ, **variables})
        self.assertEqual(run.returncode, 0, run.stderr)
        if run.stdout.strip() == 'no-mount':
            self.skipTest('mount --bind recusado dentro do namespace')
        return run.stdout.split()

    def test_bind_mount_alias_of_a_protected_folder_and_of_the_state(self):
        guarded = self.base / 'guarded'
        guarded.mkdir()
        (guarded / 'note.md').write_text('# Secret\n')
        (self.base / 'alias').mkdir()
        before = fingerprint(self.base)
        for mode, code in [('protected', 'protected'), ('state', 'app-state')]:
            with self.subTest(mode):
                self.assertEqual(self.bind_mounted(guarded, guarded, mode), [code, code, code])
        self.assertEqual(fingerprint(self.base), before)

    def test_known_limit_bind_mount_of_a_protected_subfolder_is_not_detected(self):
        """Known limit, not a protection: a subfolder of a protected entry, bind-mounted as a root.

        Its identity matches no protected entry and its `..` does not lead there; detecting
        it would take the mount table. If this test starts failing, the limit is gone:
        update the module docstring and this test.
        """
        guarded = self.base / 'guarded'
        (guarded / 'sub').mkdir(parents=True)
        note = guarded / 'sub' / 'note.md'
        for mode in ['protected', 'state']:
            with self.subTest(mode):
                note.write_text('# Secret\n')
                self.assertEqual(self.bind_mounted(guarded / 'sub', guarded, mode), ['accepted', 'accepted', 'accepted'])
                self.assertEqual(note.read_text(), '# Changed through the alias\n')

    def test_files_in_the_state_directories(self):
        configured = self.root / 'app-state'
        configured.mkdir()
        (configured / 'notes.md').write_text('# Notes\n')
        default = default_state_dir()
        default.mkdir(parents=True)
        (default / 'notes.md').write_text('# Default\n')
        outer = default.parent
        states = [configured, default.resolve()]
        for root, path in [(self.root, configured / 'notes.md'), (outer, default / 'notes.md')]:
            with self.subTest(path=path):
                self.assertReadAndSaveRefused('app-state', path, root=root, roots=[root], states=states)
        # A root inside a state directory cannot be granted; one that holds it can, file by file.
        self.assertRefused('app-state', lambda: check_root(self.model(configured), str(configured), states))
        self.assertIsNone(check_root(self.model(), str(self.root), states))
        # A state directory given through a link is recognized too.
        link = self.base / 'state-link'
        link.symlink_to(configured, target_is_directory=True)
        self.assertReadAndSaveRefused('app-state', configured / 'notes.md', states=[link])

    def test_a_file_named_like_the_protection_list_in_any_folder(self):
        folder = self.root / 'sub'
        folder.mkdir()
        for name in [STATE_FILE, 'Protected-Paths.TXT']:
            (folder / name).write_text(f'{self.base}\n')
        (folder / 'notes.txt').write_text('# Notes\n')
        for name in [STATE_FILE, 'Protected-Paths.TXT']:
            with self.subTest(name):
                self.assertReadAndSaveRefused('app-state', folder / name)
        self.assertReadAndSaveRefused('not-editable-type', folder / 'notes.txt')
        # Whatever the editable types become, the name rule comes first.
        with patch.object(editing, 'EDITABLE', frozenset({'.md', '.markdown', '.txt'})):
            self.assertEqual(self.read(folder / 'notes.txt')['text'], '# Notes\n')
            self.assertReadAndSaveRefused('app-state', folder / STATE_FILE)
            self.assertRefused('app-state', lambda: self.save('', folder / STATE_FILE))


class ContentTests(Fixture, unittest.TestCase):
    def test_types_that_are_not_editable(self):
        for name in ['notes.txt', 'data.json', 'tool.py', 'Makefile', 'config.yaml', '.md']:
            with self.subTest(name):
                (self.root / name).write_text('# x\n')
                self.assertReadAndSaveRefused('not-editable-type', self.root / name)

    def test_file_above_the_limit_on_disk(self):
        self.doc.write_bytes(b'x' * (MAX_BYTES + 1))
        self.assertReadAndSaveRefused('too-large')
        self.assertRefused('too-large', lambda: self.save('x\n'))

    def test_new_text_above_the_limit_before_and_after_restoring_crlf(self):
        self.assertRefused('too-large', lambda: self.save('x' * (MAX_BYTES + 1)))
        self.doc.write_bytes(b'# T\r\n')
        text = 'x' * (MAX_BYTES - 10) + '\n' * 10
        self.assertEqual(len(text.encode()), MAX_BYTES)
        self.assertRefused('too-large', lambda: self.save(text))
        self.doc.write_bytes(BOM + b'# T\n')
        self.assertRefused('too-large', lambda: self.save('x' * (MAX_BYTES - 2)))
        # The text is judged before the disk is touched: a deleted file still answers too-large.
        model = self.model()
        self.doc.unlink()
        self.assertRefused('too-large', lambda: self.save('x' * (MAX_BYTES + 1), base='0' * 64, model=model))

    def test_binary_and_invalid_utf8_on_disk(self):
        for raw, code in [(b'# a\x00b\n', 'binary'), (BOM + b'\x00', 'binary'), (b'# \xff\n', 'not-utf8'),
                          (b'\xed\xa0\x80\n', 'not-utf8'), (b'\xef\xbb', 'not-utf8')]:
            with self.subTest(raw=raw):
                self.doc.write_bytes(raw)
                self.assertReadAndSaveRefused(code)
                self.assertRefused(code, lambda: self.save('# Changed\n'))

    def test_mixed_line_breaks_and_lone_carriage_return(self):
        for raw in [b'a\r\nb\nc\n', b'a\rb\r', b'a\r\nb\r', b'a\n\r']:
            with self.subTest(raw=raw):
                self.doc.write_bytes(raw)
                self.assertReadAndSaveRefused('mixed-eol')

    def test_invalid_text_and_base_hash(self):
        base = sha(self.doc.read_bytes())
        for text in ['a\rb', 'a\r\nb', 'a\x00b', '\ud800', None, b'bytes', 3]:
            with self.subTest(text=text):
                self.assertRefused('invalid-text', lambda: self.save(text, base=base))
        for wrong in [base.upper(), base[:-1], base + '0', base + '\n', None, 64, '']:
            with self.subTest(base=wrong):
                self.assertRefused('invalid-text', lambda: self.save('# Changed\n', base=wrong))

    def test_a_text_that_starts_with_a_bom_is_refused(self):
        """The text travels without BOM, and the file keeps the BOM it has on disk."""
        for raw in [b'# Guide\n', BOM + b'# Guide\n', BOM + b'# T\r\nx\r\n']:
            with self.subTest(raw=raw):
                self.doc.write_bytes(raw)
                error = self.assertRefused('invalid-text', lambda: self.save('﻿# Guide\n'))
                self.assertIn('BOM', str(error))
        # U+FEFF elsewhere is text like any other.
        self.doc.write_bytes(b'# Guide\n')
        self.save('# a\n﻿b\n')
        self.assertEqual(self.doc.read_bytes(), '# a\n﻿b\n'.encode())
        # A file whose text itself starts with U+FEFF (two BOMs on disk) keeps its round trip.
        self.doc.write_bytes(BOM + BOM + b'x\n')
        read = self.read()
        self.assertEqual((read['text'], read['bom']), ('﻿x\n', True))
        self.assertTrue(self.save(read['text'], base=read['sha256'])['unchanged'])
        self.save('﻿y\n')
        self.assertEqual(self.doc.read_bytes(), BOM + BOM + b'y\n')


class ConflictTests(Fixture, unittest.TestCase):
    def test_file_changed_after_it_was_read(self):
        read = self.read()
        self.doc.write_text('# Changed by another program\n')
        self.assertRefused('conflict', lambda: self.save('# Mine\n', base=read['sha256']))
        self.assertEqual(self.doc.read_text(), '# Changed by another program\n')

    def test_file_or_folder_deleted_after_it_was_read(self):
        model = self.model()
        read = self.read(model=model)
        self.doc.unlink()
        self.assertRefused('missing', lambda: self.save('# Mine\n', base=read['sha256'], model=model))
        self.assertRefused('missing', lambda: self.read(model=model))
        self.assertFalse(self.doc.exists())
        shutil.rmtree(self.root / 'docs')
        self.assertRefused('missing', lambda: self.save('# Mine\n', base=read['sha256'], model=model))

    def test_file_replaced_by_a_directory_or_a_fifo(self):
        model = self.model()
        read = self.read(model=model)
        self.doc.unlink()
        self.doc.mkdir()
        self.assertRefused('not-regular', lambda: self.save('# Mine\n', base=read['sha256'], model=model))
        self.doc.rmdir()
        os.mkfifo(self.doc)
        self.assertRefused('not-regular', lambda: self.within_seconds(lambda: self.read(model=model)))
        self.assertRefused('not-regular', lambda: self.within_seconds(lambda: self.save('# Mine\n', base=read['sha256'], model=model)))

    def test_file_changed_between_the_first_check_and_the_rename(self):
        def append():
            with open(self.doc, 'a') as stream:
                stream.write('Appended by another program.\n')
        self.save_refused_after_step_19('conflict', append)
        self.assertEqual(self.doc.read_text(), '# Guide\n\nText.\nAppended by another program.\n')

    def test_same_size_rewrite_between_the_checks(self):
        def rewrite():
            with open(self.doc, 'r+b') as stream:
                stream.write(b'# Other')
        self.save_refused_after_step_19('conflict', rewrite)
        self.assertEqual(self.doc.read_bytes(), b'# Other\n\nText.\n')

    def test_file_touched_between_the_checks_with_the_same_bytes(self):
        # Same bytes and size: only mtime and ctime tell that another program wrote it.
        def touch():
            info = self.doc.stat()
            os.utime(self.doc, ns=(info.st_atime_ns, info.st_mtime_ns + 10**9))
        self.save_refused_after_step_19('conflict', touch)
        self.assertEqual(self.doc.read_bytes(), b'# Guide\n\nText.\n')

    def test_write_through_a_shared_mapping_between_the_checks(self):
        """A write through mmap on an already dirty page moves neither mtime nor ctime: the bytes tell."""
        import mmap
        self.doc.write_bytes(b'A' * 4096)
        fd = os.open(self.doc, os.O_RDWR)
        self.addCleanup(os.close, fd)
        mapping = mmap.mmap(fd, 4096)
        self.addCleanup(mapping.close)
        mapping[0:1] = b'B'
        mapping.flush()
        mapping[1:2] = b'B'  # The page is dirty from here on.
        def write():
            mapping[2:3] = b'Z'
        self.save_refused_after_step_19('conflict', write)
        self.assertEqual(self.doc.read_bytes()[:4], b'BBZA')

    def test_mode_or_second_name_changed_between_the_checks(self):
        for change in [lambda: os.chmod(self.doc, 0o600), lambda: os.link(self.doc, self.base / 'late-name.md')]:
            with self.subTest(change=change):
                inode = self.doc.stat().st_ino
                self.save_refused_after_step_19('conflict', change)
                self.assertEqual((self.doc.read_text(), self.doc.stat().st_ino), ('# Guide\n\nText.\n', inode))
                os.chmod(self.doc, 0o644)
                (self.base / 'late-name.md').unlink(missing_ok=True)

    def test_ancestor_swapped_for_a_link_before_the_folder_check(self):
        # The folder keeps its identity through the link; only resolve() sees the path changed.
        real = self.base / 'project-real'
        def swap():
            self.root.rename(real)
            self.root.symlink_to(real, target_is_directory=True)
        self.save_refused_after_step_19('folder-changed', swap)
        self.assertEqual((real / 'docs' / 'guide.md').read_text(), '# Guide\n\nText.\n')

    def test_folder_swapped_after_the_last_check_goes_to_the_pinned_folder(self):
        """Known limit (window between step 21 and the rename): the rename still goes into the pinned folder."""
        import pathlib
        folder = self.root / 'docs'
        pinned = self.base / 'pinned-docs'
        real_resolve = pathlib.Path.resolve
        def resolve(path, *args, **kwargs):
            result = real_resolve(path, *args, **kwargs)
            if str(path) == str(folder) and not pinned.exists():  # Step 21, the last call before the rename.
                folder.rename(pinned)
                folder.mkdir()
                (folder / 'guide.md').write_text('# Decoy\n')
            return result
        read = self.read()
        with patch.object(pathlib.Path, 'resolve', resolve):
            result = self.save('# Mine\n', base=read['sha256'])
        self.assertFalse(result['unchanged'])
        self.assertEqual((pinned / 'guide.md').read_text(), '# Mine\n')
        self.assertEqual((folder / 'guide.md').read_text(), '# Decoy\n')
        self.assertEqual(leftovers(self.base), [])

    def test_folder_moved_after_it_was_pinned(self):
        elsewhere = self.base / 'elsewhere'
        elsewhere.mkdir()
        folder = self.root / 'docs'
        for replacement in [None, 'directory', 'link']:
            with self.subTest(replacement=replacement):
                moved = elsewhere / 'docs'
                def move():
                    folder.rename(moved)
                    if replacement == 'directory':
                        folder.mkdir()
                    elif replacement == 'link':
                        folder.symlink_to(moved, target_is_directory=True)
                error = self.save_refused_after_step_19('folder-changed', move, '# Moved away\n')
                self.assertEqual(error.status, 409)
                # Nothing written where the folder went, and no temporary left there.
                self.assertEqual(sorted(os.listdir(moved)), ['guide.md'])
                self.assertEqual((moved / 'guide.md').read_text(), '# Guide\n\nText.\n')
                self.assertEqual(leftovers(self.base), [])
                if folder.is_symlink():
                    folder.unlink()
                elif folder.exists():
                    folder.rmdir()
                moved.rename(folder)


class FailureTests(Fixture, unittest.TestCase):
    def fsync_failing_on(self, kind):
        real_fsync, real_fstat = os.fsync, os.fstat
        def fsync(fd):
            if stat.S_ISDIR(real_fstat(fd).st_mode) == (kind == 'folder'):
                raise failing()
            return real_fsync(fd)
        return patch('editing.os.fsync', side_effect=fsync)

    def test_disk_full_while_writing_the_temporary(self):
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                           patch('editing.os.write', side_effect=failing(errno.ENOSPC)))

    def test_group_that_the_system_does_not_keep(self):
        self.assertRefused('other-group', lambda: self.save('# Changed\n'),
                           patch('editing.os.fchown', side_effect=failing(errno.EPERM)))

    def test_mode_that_the_system_does_not_set(self):
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                           patch('editing.os.fchmod', side_effect=failing(errno.EPERM)))

    def test_fsync_of_the_temporary_fails(self):
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'), self.fsync_failing_on('file'))

    def test_rename_fails(self):
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                           patch('editing.os.replace', side_effect=failing(errno.EXDEV)))

    def test_creating_the_temporary_fails(self):
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                           patch('editing.os.open', side_effect=self.refuse_temporary()))

    def refuse_temporary(self):
        real_open = os.open
        def call(path, flags, *args, **kwargs):
            if os.path.basename(str(path)).startswith('.aae-edit-'):
                raise failing(errno.ENOSPC)
            return real_open(path, flags, *args, **kwargs)
        return call

    def test_an_existing_entry_with_the_temporary_name_is_never_removed(self):
        squatter = self.doc.parent / f'.aae-edit-{"0" * 16}.tmp'
        squatter.write_text('not ours\n')
        before = fingerprint(self.base)
        with patch('editing.secrets.token_hex', return_value='0' * 16), self.assertRaises(Refusal) as caught:
            self.save('# Changed\n')
        self.assertEqual(caught.exception.code, 'write-failed')
        self.assertEqual(fingerprint(self.base), before)

    def test_fsync_of_the_folder_fails_after_the_rename(self):
        with self.fsync_failing_on('folder'):
            result = self.save('# Changed\n')
        self.assertEqual((result['unchanged'], result['durable']), (False, False))
        self.assertEqual(self.doc.read_bytes(), b'# Changed\n')
        self.assertEqual(result['sha256'], sha(b'# Changed\n'))
        self.assertEqual(leftovers(self.base), [])

    def test_group_failure_other_than_a_permission_is_a_write_failure(self):
        error = self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                                   patch('editing.os.fchown', side_effect=failing(errno.EIO)))
        self.assertNotIn('group', str(error))

    def test_unchanged_text_reports_whether_the_folder_is_on_disk(self):
        with self.fsync_failing_on('folder'):
            self.assertFalse(self.save('# Changed\n')['durable'])
        with self.fsync_failing_on('folder'):
            self.assertEqual({key: value for key, value in self.save('# Changed\n').items() if key in ('unchanged', 'durable')},
                             {'unchanged': True, 'durable': False})
        real_fsync = os.fsync
        synced = []
        def counting(fd):
            synced.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            return real_fsync(fd)
        with patch('editing.os.fsync', side_effect=counting):
            result = self.save('# Changed\n')
        self.assertEqual((result['unchanged'], result['durable'], synced), (True, True, [True]))

    def test_rename_that_happened_but_reported_an_error_is_a_success(self):
        real_replace = os.replace
        def replace_then_fail(*args, **kwargs):
            real_replace(*args, **kwargs)
            raise failing(errno.ENOENT)  # A lost reply on a network filesystem.
        with patch('editing.os.replace', side_effect=replace_then_fail):
            result = self.save('# Changed\n')
        self.assertEqual((result['unchanged'], result['durable']), (False, False))
        self.assertEqual(self.doc.read_bytes(), b'# Changed\n')
        self.assertEqual(leftovers(self.base), [])

    def test_rename_with_an_unknown_outcome_never_claims_nothing_was_written(self):
        real_unlink = os.unlink
        squatter = []
        def replace_lost(source, target, *, src_dir_fd, dst_dir_fd):
            # The temporary vanished and another file took its name: neither name holds what was written.
            real_unlink(source, dir_fd=src_dir_fd)
            descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=src_dir_fd)
            os.close(descriptor)
            squatter.append(self.doc.parent / source)
            raise failing()
        with patch('editing.os.replace', side_effect=replace_lost), self.assertRaises(Refusal) as caught:
            self.save('# Changed\n')
        self.assertEqual((caught.exception.code, caught.exception.status), ('unconfirmed', 409))
        self.assertNotIn('Nothing was saved', str(caught.exception))
        self.assertIn('confirm', str(caught.exception))
        self.assertTrue(squatter[0].exists(), 'a entry that may not be ours was removed')
        self.assertEqual(self.doc.read_bytes(), b'# Guide\n\nText.\n')

    def test_temporary_removed_by_another_program_before_the_rename_is_unconfirmed(self):
        """No injected error: a cleaner removes `.aae-edit-*` right before the rename."""
        import pathlib
        folder = self.doc.parent
        real_resolve = pathlib.Path.resolve
        removed = []
        def cleaner(path, *args, **kwargs):
            result = real_resolve(path, *args, **kwargs)
            if str(path) == str(folder):  # Step 21, the last call before the rename.
                for name in os.listdir(folder):
                    if name.startswith('.aae-edit-'):
                        os.unlink(folder / name)
                        removed.append(name)
            return result
        read = self.read()
        with patch.object(pathlib.Path, 'resolve', cleaner), self.assertRaises(Refusal) as caught:
            self.save('# Mine\n', base=read['sha256'])
        self.assertEqual((caught.exception.code, caught.exception.status), ('unconfirmed', 409))
        self.assertEqual(len(removed), 1)
        self.assertIn(removed[0], str(caught.exception))
        self.assertNotIn('Nothing was saved', str(caught.exception))
        self.assertEqual(self.doc.read_bytes(), b'# Guide\n\nText.\n')
        self.assertEqual(leftovers(self.base), [])
        # Every other code keeps the guarantee: only `unconfirmed` says the outcome is unknown.
        self.assertEqual({code for code, message in editing.MESSAGES.items() if 'Read the file again before' in message}, {'unconfirmed'})

    def test_a_temporary_that_could_not_be_removed_is_named(self):
        if os.geteuid() == 0:
            self.skipTest('como root, a permissão da pasta não impede o rename')
        import pathlib
        folder = self.doc.parent
        self.addCleanup(os.chmod, folder, 0o755)
        real_resolve = pathlib.Path.resolve
        def resolve(path, *args, **kwargs):
            result = real_resolve(path, *args, **kwargs)
            if str(path) == str(folder):  # Another program takes the write permission away right before the rename.
                os.chmod(folder, 0o555)
            return result
        with patch.object(pathlib.Path, 'resolve', resolve), self.assertRaises(Refusal) as caught:
            self.save('# Changed\n')
        os.chmod(folder, 0o755)
        left = leftovers(self.base)
        self.assertEqual(caught.exception.code, 'write-failed')
        self.assertEqual(len(left), 1)
        self.assertIn(os.path.basename(left[0]), str(caught.exception))
        self.assertIn('permission', str(caught.exception))
        self.assertEqual(self.doc.read_bytes(), b'# Guide\n\nText.\n')


class AfterTheRenameTests(Fixture, unittest.TestCase):
    """Step 22a: a success describes the bytes on disk; anything else at the name after the rename is `unconfirmed`."""

    def around_the_rename(self, before=None, after=None, error=None):
        """Patch the rename: `before(src, fd)` and `after(dst, fd)` run around the real one, then `error` is raised."""
        real_replace = os.replace
        def replace(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
            if before:
                before(src, src_dir_fd)
            real_replace(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
            if after:
                after(dst, dst_dir_fd)
            if error:
                raise error
        return patch('editing.os.replace', side_effect=replace)

    def assertUnconfirmed(self, context, disk):
        with context, self.assertRaises(Refusal) as caught:
            self.save('# Mine\n')
        self.assertEqual((caught.exception.code, caught.exception.status, str(caught.exception)),
                         ('unconfirmed', 409, editing.LANDING_UNCONFIRMED))
        self.assertNotIn('Nothing was saved', str(caught.exception))
        self.assertEqual(leftovers(self.base), [])
        if disk is not None:
            self.assertEqual(self.doc.read_bytes(), disk)

    @staticmethod
    def put(name, fd, data, flags=os.O_WRONLY | os.O_TRUNC):
        handle = os.open(name, flags, 0o644, dir_fd=fd)
        os.write(handle, data)
        os.close(handle)

    def test_a_temporary_swapped_for_another_file_before_the_rename(self):
        """Another program renames its own file over the temporary."""
        def swap(src, fd):
            self.put('decoy.part', fd, b'EVIL\n', os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            os.rename('decoy.part', src, src_dir_fd=fd, dst_dir_fd=fd)
        self.assertUnconfirmed(self.around_the_rename(before=swap), b'EVIL\n')

    def test_a_temporary_rewritten_in_place_before_the_rename(self):
        """Same inode, other bytes: the identity alone would not see it."""
        self.assertUnconfirmed(self.around_the_rename(before=lambda src, fd: self.put(src, fd, b'EVIL\n')), b'EVIL\n')

    def test_the_name_swapped_right_after_the_rename(self):
        for kind in ['symlink', 'fifo', 'other file']:
            with self.subTest(kind):
                self.doc.unlink(missing_ok=True)
                self.doc.write_bytes(b'# Guide\n')
                def swap(dst, fd):
                    os.unlink(dst, dir_fd=fd)
                    if kind == 'symlink':
                        os.symlink('elsewhere.md', dst, dir_fd=fd)
                    elif kind == 'fifo':
                        os.mkfifo(dst, dir_fd=fd)
                    else:
                        self.put(dst, fd, b'EVIL\n', os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                self.assertUnconfirmed(self.around_the_rename(after=swap), None)
                self.doc.unlink()
        self.doc.write_bytes(b'# Guide\n')

    def test_a_temporary_given_a_second_name_before_the_rename(self):
        """A hard link of the temporary, outside the project, would keep changing the document."""
        elsewhere = self.base / 'second-name.md'
        self.assertUnconfirmed(self.around_the_rename(before=lambda src, fd: os.link(src, elsewhere, src_dir_fd=fd)),
                               b'# Mine\n')
        self.assertEqual(self.doc.stat().st_nlink, 2)
        self.assertTrue(os.path.samefile(self.doc, elsewhere))

    def test_the_same_bytes_in_another_file_are_unconfirmed_without_saying_more(self):
        """The bytes are the ones sent, the file is not the one written; only that much is said."""
        def same(src, fd):
            self.put('decoy.part', fd, b'# Mine\n', os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            os.rename('decoy.part', src, src_dir_fd=fd, dst_dir_fd=fd)
        self.assertUnconfirmed(self.around_the_rename(before=same), b'# Mine\n')
        self.assertIn('it could not be confirmed', editing.LANDING_UNCONFIRMED)
        self.assertIn('check the content', editing.LANDING_UNCONFIRMED)
        self.assertNotIn('is not what', editing.LANDING_UNCONFIRMED)

    def test_a_rename_that_reported_an_error_with_other_bytes_at_the_name(self):
        """The branch where the rename happened and reported an error checks the bytes too."""
        self.assertUnconfirmed(self.around_the_rename(after=lambda dst, fd: self.put(dst, fd, b'EVIL\n'), error=failing()),
                               b'EVIL\n')

    def test_an_untouched_rename_is_still_a_success(self):
        result = self.save('# Mine\n')
        self.assertEqual((result['sha256'], result['durable']), (sha(b'# Mine\n'), True))
        with self.around_the_rename(error=failing()):
            result = self.save('# Again\n')
        self.assertEqual((result['sha256'], result['durable']), (sha(b'# Again\n'), False))
        self.assertEqual(self.doc.read_bytes(), b'# Again\n')


class MetadataTests(Fixture, unittest.TestCase):
    def attribute_or_skip(self, path, name, value):
        try:
            os.setxattr(path, name, value)
        except OSError as exc:
            self.skipTest(f'o sistema de arquivos dos temporários não aceita o atributo {name} ({exc.strerror})')

    def acl_or_skip(self, *arguments):
        if not shutil.which('setfacl'):
            self.skipTest('setfacl ausente')
        run = subprocess.run(['setfacl', *arguments], capture_output=True, text=True)
        if run.returncode:
            self.skipTest(f'o sistema de arquivos dos temporários não aceita ACL ({run.stderr.strip()})')

    def test_extended_attributes_and_acl_are_kept(self):
        self.attribute_or_skip(self.doc, 'user.origin', b'synthetic')
        self.acl_or_skip('-m', 'u:nobody:rw', str(self.doc))
        before = {name: os.getxattr(self.doc, name) for name in os.listxattr(self.doc)}
        mode = stat.S_IMODE(self.doc.stat().st_mode)
        self.assertIn('system.posix_acl_access', before)
        self.save('# Changed\n')
        after = {name: os.getxattr(self.doc, name) for name in os.listxattr(self.doc)}
        self.assertEqual((after, stat.S_IMODE(self.doc.stat().st_mode)), (before, mode))

    def test_acl_inherited_from_the_folder_is_not_added(self):
        # The original has no ACL; a temporary in a folder with a default ACL would get one.
        self.acl_or_skip('-d', '-m', 'u:nobody:rw', str(self.doc.parent))
        self.assertNotIn('system.posix_acl_access', os.listxattr(self.doc))
        mode = stat.S_IMODE(self.doc.stat().st_mode)
        self.save('# Changed\n')
        self.assertNotIn('system.posix_acl_access', os.listxattr(self.doc))
        self.assertEqual(stat.S_IMODE(self.doc.stat().st_mode), mode)

    def test_setgid_bit_is_kept(self):
        os.chmod(self.doc, 0o2664)
        if stat.S_IMODE(self.doc.stat().st_mode) != 0o2664:
            self.skipTest('o sistema não deixou pôr o bit setgid no arquivo de teste')
        self.save('# Changed\n')
        self.assertEqual(stat.S_IMODE(self.doc.stat().st_mode), 0o2664)

    def test_group_the_system_silently_did_not_keep(self):
        groups = [group for group in os.getgroups() if group != os.getegid()]
        if not groups:
            self.skipTest('o usuário não tem grupo suplementar; a conferência do grupo não foi exercitada')
        try:
            os.chown(self.doc, -1, groups[0])
        except OSError as exc:
            self.skipTest(f'o sistema não deixou trocar o grupo do arquivo de teste ({exc.strerror})')
        self.assertRefused('other-group', lambda: self.save('# Changed\n'), patch('editing.os.fchown'))

    def test_the_group_given_to_the_temporary_is_the_one_of_the_file(self):
        with patch('editing.os.fchown', wraps=os.fchown) as fchown:
            self.save('# Changed\n')
        self.assertEqual(fchown.call_args.args[1:], (-1, self.doc.stat().st_gid))

    def test_attribute_that_cannot_be_copied_is_a_refusal(self):
        self.attribute_or_skip(self.doc, 'user.origin', b'synthetic')
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                           patch('editing.os.setxattr', side_effect=failing(errno.ENOSPC)))

    def test_mode_or_attributes_the_system_did_not_keep_are_a_refusal(self):
        os.chmod(self.doc, 0o640)
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'), patch('editing.os.fchmod'))
        real_listxattr, real_getxattr = os.listxattr, os.getxattr
        calls = []
        def ghostly(fd):  # The third listing (the check of the temporary) shows an attribute the original lacks.
            calls.append(fd)
            try:
                names = real_listxattr(fd)
            except OSError:
                names = []
            return names + ['user.ghost'] if len(calls) == 3 else names
        def value(fd, name):
            return b'' if name == 'user.ghost' else real_getxattr(fd, name)
        self.assertRefused('write-failed', lambda: self.save('# Changed\n'), patch('editing.os.listxattr', side_effect=ghostly),
                           patch('editing.os.getxattr', side_effect=value))

    def test_filesystem_without_extended_attributes(self):
        with patch('editing.os.listxattr', side_effect=failing(errno.EOPNOTSUPP)):
            self.assertFalse(self.save('# Changed\n')['unchanged'])
        self.assertEqual(self.doc.read_bytes(), b'# Changed\n')


CHILD = '''
import sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import editing, os, stat
from scanner import scan
root, path, base, text, state = sys.argv[2:7]
real_fsync = os.fsync
def fsync(fd):
    if stat.S_ISREG(os.fstat(fd).st_mode):  # Inside the critical section: wait for the parent.
        print('inside', flush=True)
        sys.stdin.readline()
    return real_fsync(fd)
with patch('editing.os.fsync', side_effect=fsync):
    try:
        editing.save(scan([root]), root, path, base, text, [state])
        print('saved', flush=True)
    except editing.Refusal as exc:
        print(exc.code, flush=True)
'''


class LockTests(Fixture, unittest.TestCase):
    def test_two_app_processes_never_both_save_the_same_base(self):
        """The core tries the folder lock once: while another instance holds it, refused at once; then the base is stale."""
        before = self.doc.read_bytes()
        base = sha(before)
        child = subprocess.Popen([sys.executable, '-I', '-c', CHILD, str(REPO / 'server'), str(self.root), str(self.doc), base,
                                  '# Child\n', str(self.state)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.kill)
        self.assertEqual(self.within_seconds(child.stdout.readline).strip(), 'inside')
        started = time.monotonic()
        with self.assertRaises(editing.FolderBusy) as caught:
            self.save('# Parent\n', base=base)
        self.assertLess(time.monotonic() - started, 1.0, 'o núcleo esperou pela trava')
        self.assertEqual((caught.exception.code, str(caught.exception)), ('write-failed', editing.BUSY))
        self.assertEqual(self.doc.read_bytes(), before)
        child.stdin.write('go\n')
        child.stdin.flush()
        self.assertEqual(child.communicate(timeout=30)[0].strip(), 'saved')
        self.assertRefused('conflict', lambda: self.save('# Parent\n', base=base))
        self.assertEqual(self.doc.read_text(), '# Child\n')
        self.assertEqual(leftovers(self.base), [])

    def test_a_held_folder_is_refused_at_once_and_the_message_does_not_guess_who_holds_it(self):
        import fcntl
        held = os.open(self.doc.parent, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, held)
        fcntl.flock(held, fcntl.LOCK_EX)  # Any program: not necessarily the app.
        started = time.monotonic()
        error = self.assertRefused('write-failed', lambda: self.save('# Changed\n'))
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertIsInstance(error, editing.FolderBusy)
        self.assertEqual(str(error), editing.BUSY)
        self.assertIn('another program', str(error))
        fcntl.flock(held, fcntl.LOCK_UN)
        self.assertFalse(self.save('# Changed\n')['unchanged'])

    def test_temporary_is_created_in_the_pinned_folder(self):
        """The folder becomes a link to a decoy while the save waits for the lock: nothing may appear in the decoy."""
        import fcntl
        decoy = self.base / 'decoy'
        decoy.mkdir()
        folder = self.doc.parent
        real_flock = fcntl.flock
        def swap_then_lock(fd, operation):
            if not folder.is_symlink():
                folder.rename(self.root / 'docs-real')
                folder.symlink_to(decoy, target_is_directory=True)
            return real_flock(fd, operation)
        read = self.read()
        with patch('editing.fcntl.flock', side_effect=swap_then_lock), self.assertRaises(Refusal) as caught:
            self.save('# Mine\n', base=read['sha256'])
        self.assertEqual(caught.exception.code, 'folder-changed')
        self.assertEqual(os.listdir(decoy), [])
        self.assertEqual(sorted(os.listdir(self.root / 'docs-real')), ['guide.md'])
        self.assertEqual((self.root / 'docs-real' / 'guide.md').read_text(), '# Guide\n\nText.\n')

    def test_filesystem_that_cannot_lock_a_folder_refuses_with_the_reason(self):
        for error in [errno.ENOLCK, errno.EOPNOTSUPP, errno.EBADF, errno.EINVAL]:
            with self.subTest(error=errno.errorcode[error]):
                refusal = self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                                             patch('editing.fcntl.flock', side_effect=failing(error)))
                self.assertIn('file system', str(refusal))
                self.assertIn('flock', str(refusal))
        # Any other error keeps its cause, and is refused too.
        refusal = self.assertRefused('write-failed', lambda: self.save('# Changed\n'),
                                     patch('editing.fcntl.flock', side_effect=failing(errno.EIO)))
        self.assertIn('reserve the folder', str(refusal))

    def test_read_refuses_where_the_folder_cannot_be_locked(self):
        """The editor learns it when it opens, not when saving after typing."""
        for error in [errno.ENOLCK, errno.EOPNOTSUPP, errno.EBADF, errno.EINVAL]:
            with self.subTest(error=errno.errorcode[error]):
                refusal = self.assertRefused('write-failed', lambda: self.read(),
                                             patch('editing.fcntl.flock', side_effect=failing(error)))
                self.assertEqual(str(refusal), editing.NO_LOCK)
        # Any other error is left for the save, which names its cause.
        with patch('editing.fcntl.flock', side_effect=failing(errno.EIO)):
            self.assertEqual(self.read()['text'], '# Guide\n\nText.\n')

    def test_read_is_not_refused_by_a_busy_folder_and_keeps_no_lock(self):
        import fcntl
        held = os.open(self.doc.parent, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, held)
        fcntl.flock(held, fcntl.LOCK_EX)
        started = time.monotonic()
        self.assertEqual(self.read()['text'], '# Guide\n\nText.\n')
        self.assertLess(time.monotonic() - started, 1.0, 'a leitura esperou pela trava')
        fcntl.flock(held, fcntl.LOCK_UN)
        real_flock, seen = fcntl.flock, []
        def watch(fd, operation):
            seen.append(operation)
            return real_flock(fd, operation)
        with patch('editing.fcntl.flock', side_effect=watch):
            self.read()
        self.assertEqual(seen, [fcntl.LOCK_SH | fcntl.LOCK_NB, fcntl.LOCK_UN])
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)  # Nothing left held.


class CheckRootTests(Fixture, unittest.TestCase):
    def test_open_available_root_passes(self):
        self.assertIsNone(check_root(self.model(), str(self.root), self.states))

    def test_root_not_open_or_no_longer_available(self):
        model = self.model()
        for root in [str(self.base), str(self.root / 'docs'), None, f'{self.root}/']:
            with self.subTest(root=root):
                self.assertRefused('not-in-workspace', lambda: check_root(model, root, self.states))
        self.root.rename(self.base / 'moved-project')
        self.assertRefused('not-in-workspace', lambda: check_root(model, str(self.root), self.states))

    def test_root_inside_a_protected_folder(self):
        with self.protect(self.base):
            self.assertRefused('protected', lambda: check_root(self.model(), str(self.root), self.states))

    def test_system_root_home_folder_and_the_folders_above_it_are_too_wide(self):
        """HOME is the fixture's temporary one; `/` is never read: the model only names it."""
        error = self.assertRefused('edit-not-granted', lambda: check_root({'roots': [{'path': '/'}], 'nodes': []}, '/', self.states))
        self.assertEqual(str(error), editing.WIDE)
        (self.home / 'CLAUDE.md').write_text('# Home\n')
        for root in [self.home, self.base]:
            with self.subTest(root=root):
                model = self.model(root)
                error = self.assertRefused('edit-not-granted', lambda: check_root(model, str(root), self.states))
                self.assertIn('Open the project folder', str(error))
        # A project inside the home folder can be granted.
        inside = self.home / 'project'
        inside.mkdir()
        (inside / 'AGENTS.md').write_text('# Inside\n')
        self.assertIsNone(check_root(self.model(inside), str(inside), self.states))

    def test_the_account_home_counts_as_well_as_home(self):
        """An isolated instance redirects HOME; the account's own folder (simulated here) is still too wide."""
        account = self.base / 'account'
        (account / 'project').mkdir(parents=True)
        (account / 'project' / 'AGENTS.md').write_text('# Project\n')
        model = self.model(account)
        with patch('editing.account_home', return_value=str(account)):
            self.assertRefused('edit-not-granted', lambda: check_root(model, str(account), self.states))
            inside = self.model(account / 'project')
            self.assertIsNone(check_root(inside, str(account / 'project'), self.states))
        self.assertIsNone(check_root(model, str(account), self.states))

    def test_an_alias_of_the_home_folder_is_too_wide_by_identity(self):
        """What a bind mount of the home folder does: another path with its identity (simulated)."""
        mirror = self.base / 'mirror'
        mirror.mkdir()
        model = self.model(mirror)
        real_stat = os.stat
        def aliased(path, *args, **kwargs):
            if os.fspath(path) == str(mirror):
                return real_stat(self.home, *args, **kwargs)
            return real_stat(path, *args, **kwargs)
        self.assertRefused('edit-not-granted', lambda: check_root(model, str(mirror), self.states),
                           patch('editing.os.stat', side_effect=aliased))
        self.assertIsNone(check_root(model, str(mirror), self.states))


if __name__ == '__main__':
    unittest.main()
