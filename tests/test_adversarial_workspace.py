"""Adversarial storage/HTTP checks: every filesystem and server is disposable."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from main import make_handler
from workspace import Workspace, blueprint, create_directory


def fingerprint(root):
    result = {}
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        data = os.readlink(path) if path.is_symlink() else hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        result[str(path.relative_to(root))] = (info.st_mode, info.st_size, info.st_mtime_ns, data)
    return result


class StorageFixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-adversarial-storage-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.project = self.base / 'fictional-agent'
        self.project.mkdir()
        self.entry = self.project / 'AGENTS.md'
        self.entry.write_text('# Fixture\n[Policy](policy.md)\n', encoding='utf-8')
        (self.project / 'policy.md').write_text('# Policy\n', encoding='utf-8')
        self.ws = Workspace(self.base / 'state')
        self.payload = {'parent': str(self.base), 'name': 'created-agent',
                        'primitives': [{'name': 'worker', 'type': 'agent'}, {'name': 'rules', 'type': 'policy'}],
                        'relationships': [{'source': 'worker', 'target': 'rules', 'type': 'reads'}]}


class AdversarialWorkspaceTests(StorageFixture, unittest.TestCase):
    def test_full_lifecycle_preserves_source_tree_bytes_and_metadata(self):
        before = fingerprint(self.project)
        self.ws.open(str(self.project))
        self.assertIn('# Fixture', self.ws.content(str(self.entry))['text'])
        self.ws.note(str(self.entry), 'Audit annotation')
        self.ws.refresh()
        self.ws.close(str(self.project))
        restored = Workspace(self.base / 'state')
        self.assertEqual(restored.snapshot()['notes'][str(self.entry)], 'Audit annotation')
        restored.forget(str(self.project))
        self.assertEqual(before, fingerprint(self.project))

    def test_preview_never_creates_destination_and_matches_written_files(self):
        before = fingerprint(self.project)
        preview = blueprint(self.payload)
        destination = self.base / self.payload['name']
        self.assertFalse(destination.exists())
        self.assertEqual(create_directory(self.payload), str(destination))
        self.assertEqual(destination.stat().st_mode & 0o077, 0)
        written = {str(p.relative_to(destination)): p.read_text() for p in destination.rglob('*') if p.is_file()}
        self.assertEqual(written, preview)
        self.assertEqual(before, fingerprint(self.project))

    def test_existing_file_directory_and_dangling_symlink_are_never_replaced(self):
        for kind in ['file', 'directory', 'symlink']:
            with self.subTest(kind=kind):
                destination = self.base / kind
                if kind == 'file':
                    destination.write_text('Preserve')
                elif kind == 'directory':
                    destination.mkdir()
                else:
                    destination.symlink_to(self.base / 'absent')
                before = destination.lstat()
                with self.assertRaises(FileExistsError):
                    create_directory({**self.payload, 'name': kind})
                self.assertEqual(destination.lstat(), before)

    def test_protected_alias_and_state_location_are_rejected_without_writes(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.project, target_is_directory=True)
        before = fingerprint(self.project)
        with patch.dict(os.environ, {'AAE_PROTECTED_PATHS': str(self.project)}):
            for parent in [self.project, alias]:
                with self.subTest(parent=parent), self.assertRaises(ValueError):
                    create_directory({**self.payload, 'parent': str(parent)})
                with self.subTest(state=parent), self.assertRaises(ValueError):
                    Workspace(parent / 'state')
        self.assertEqual(before, fingerprint(self.project))

    def test_partial_creation_failure_rolls_back_only_its_new_directory(self):
        before = fingerprint(self.project)
        real_open = os.open
        def fail_last_file(path, flags, *args, **kwargs):
            if path == 'CLAUDE.md':
                raise OSError('Synthetic disk failure')
            return real_open(path, flags, *args, **kwargs)
        with patch('workspace.os.open', side_effect=fail_last_file), self.assertRaises(OSError):
            create_directory(self.payload)
        self.assertFalse((self.base / self.payload['name']).exists())
        self.assertEqual(before, fingerprint(self.project))

    def test_creation_rejects_subdirectory_swapped_for_external_symlink(self):
        outside = self.base / 'outside'
        outside.mkdir()
        before = fingerprint(outside)
        destination = self.base / self.payload['name']
        real_open = os.open
        swapped = False
        def swap_then_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if path == 'agent' and not swapped:
                swapped = True
                (destination / 'agent').rmdir()
                (destination / 'agent').symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)
        with patch('workspace.os.open', side_effect=swap_then_open), self.assertRaises(OSError):
            create_directory(self.payload)
        self.assertTrue(swapped)
        self.assertEqual(before, fingerprint(outside))
        # An unexpected entry is left for inspection, never recursively removed.
        self.assertTrue((destination / 'agent').is_symlink())

    def test_rollback_preserves_concurrent_replacement_directory(self):
        destination = self.base / self.payload['name']
        moved = self.base / 'owned-but-moved'
        real_open = os.open
        def swap_then_fail(path, flags, *args, **kwargs):
            if path == 'worker.md':
                destination.rename(moved)
                destination.mkdir()
                (destination / 'keep.txt').write_text('Concurrent owner')
                raise OSError('Synthetic concurrent replacement')
            return real_open(path, flags, *args, **kwargs)
        with patch('workspace.os.open', side_effect=swap_then_fail), self.assertRaises(OSError):
            create_directory(self.payload)
        self.assertEqual((destination / 'keep.txt').read_text(), 'Concurrent owner')
        self.assertTrue(moved.is_dir())

    def test_creation_rejects_parent_swapped_after_validation(self):
        parent = self.base / 'creation-parent'
        parent.mkdir()
        outside = self.base / 'outside'
        outside.mkdir()
        before = fingerprint(outside)
        real_open = os.open
        swapped = False
        def swap_then_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if path == parent.name and not swapped:
                swapped = True
                parent.rename(self.base / 'original-parent')
                parent.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)
        with patch('workspace.os.open', side_effect=swap_then_open), self.assertRaises(OSError):
            create_directory({**self.payload, 'parent': str(parent)})
        self.assertTrue(swapped)
        self.assertEqual(before, fingerprint(outside))

    def test_pinned_subdirectory_cannot_redirect_a_later_file_write(self):
        destination = self.base / self.payload['name']
        outside = self.base / 'outside'
        outside.mkdir()
        before = fingerprint(outside)
        moved = self.base / 'original-agent-directory'
        real_open = os.open
        def swap_then_open(path, flags, *args, **kwargs):
            if path == 'worker.md':
                (destination / 'agent').rename(moved)
                (destination / 'agent').symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)
        with patch('workspace.os.open', side_effect=swap_then_open), self.assertRaises(ValueError):
            create_directory(self.payload)
        self.assertEqual(before, fingerprint(outside))
        self.assertTrue((destination / 'agent').is_symlink())
        self.assertFalse((moved / 'worker.md').exists())

    def test_rollback_cannot_delete_nonempty_replacement_after_identity_check(self):
        destination = self.base / self.payload['name']
        moved = self.base / 'original-created-agent'
        real_open, real_rmdir = os.open, os.rmdir
        swapped = False
        def fail_last_file(path, flags, *args, **kwargs):
            if path == 'CLAUDE.md':
                raise OSError('Synthetic write failure')
            return real_open(path, flags, *args, **kwargs)
        def swap_then_rmdir(path, *args, **kwargs):
            nonlocal swapped
            if path == destination.name and kwargs.get('dir_fd') is not None:
                swapped = True
                destination.rename(moved)
                destination.mkdir()
                (destination / 'keep.txt').write_text('Concurrent owner')
            return real_rmdir(path, *args, **kwargs)
        with patch('workspace.os.open', side_effect=fail_last_file), patch('workspace.os.rmdir', side_effect=swap_then_rmdir):
            with self.assertRaises(OSError):
                create_directory(self.payload)
        self.assertTrue(swapped)
        self.assertEqual((destination / 'keep.txt').read_text(), 'Concurrent owner')
        self.assertTrue(moved.is_dir())

    def test_creation_rejects_nonempty_replacement_before_first_stat(self):
        destination = self.base / self.payload['name']
        other = self.base / 'other-owner'
        other.mkdir()
        (other / 'keep.txt').write_text('Concurrent owner')
        real_stat = os.stat
        swapped = False
        def swap_then_stat(path, *args, **kwargs):
            nonlocal swapped
            if path == destination.name and kwargs.get('dir_fd') is not None and not swapped:
                swapped = True
                destination.rename(self.base / 'original-created-agent')
                other.rename(destination)
            return real_stat(path, *args, **kwargs)
        with patch('workspace.os.stat', side_effect=swap_then_stat), self.assertRaises(ValueError):
            create_directory(self.payload)
        self.assertTrue(swapped)
        self.assertEqual([p.name for p in destination.iterdir()], ['keep.txt'])
        self.assertEqual((destination / 'keep.txt').read_text(), 'Concurrent owner')

    def test_creation_reports_parent_rename_instead_of_success_at_absent_path(self):
        parent = self.base / 'creation-parent'
        parent.mkdir()
        moved = self.base / 'moved-parent'
        real_mkdir = os.mkdir
        swapped = False
        def swap_then_mkdir(path, *args, **kwargs):
            nonlocal swapped
            if path == self.payload['name'] and kwargs.get('dir_fd') is not None and not swapped:
                swapped = True
                parent.rename(moved)
                parent.mkdir()
            return real_mkdir(path, *args, **kwargs)
        with patch('workspace.os.mkdir', side_effect=swap_then_mkdir), self.assertRaises(ValueError):
            create_directory({**self.payload, 'parent': str(parent)})
        self.assertTrue(swapped)
        self.assertFalse((parent / self.payload['name']).exists())
        self.assertFalse((moved / self.payload['name']).exists())

    def test_invalid_notes_and_failed_disk_commit_leave_disk_and_model_unchanged(self):
        self.ws.open(str(self.project))
        before = self.ws.snapshot()
        saved = self.ws.state_file.read_bytes()
        for node, body in [(str(self.entry), 'x' * 20001), (str(self.entry), {}), ('/not-in-workspace', 'x')]:
            with self.subTest(node=node, body_type=type(body).__name__), self.assertRaises(ValueError):
                self.ws.note(node, body)
        with patch('workspace.os.replace', side_effect=OSError('Synthetic disk failure')):
            with self.assertRaises(OSError):
                self.ws.close(str(self.project))
        self.assertEqual(self.ws.snapshot(), before)
        self.assertEqual(self.ws.state_file.read_bytes(), saved)
        self.assertFalse(list(self.ws.state_dir.glob('.workspace-*')))


class AdversarialHTTPTests(StorageFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.ws.open(str(self.project))
        static = self.base / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<!doctype html><title>Fixture</title>')
        (static / 'escape').symlink_to(self.entry)
        handler = make_handler(self.ws, static, 'synthetic-adversarial-token')
        handler.log_message = lambda *args: None
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, method, route, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request(method, route, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_rejected_requests_cannot_mutate_workspace_or_source(self):
        before = fingerprint(self.project)
        state = self.ws.state_file.read_bytes()
        good = {'X-AAE-Token': 'synthetic-adversarial-token', 'Content-Type': 'application/json'}
        cases = [({}, b'{}', 403), ({**good, 'Origin': 'https://outside.invalid'}, b'{}', 403),
                 ({**good, 'Host': 'outside.invalid'}, b'{}', 403),
                 ({**good, 'Sec-Fetch-Site': 'cross-site'}, b'{}', 403),
                 ({**good, 'Content-Type': 'text/plain'}, b'{}', 400),
                 (good, b'[]', 400), (good, b'{broken', 400),
                 (good, b'{"padding":"' + b'x' * 256001 + b'"}', 400)]
        for headers, body, expected in cases:
            with self.subTest(headers=headers, body_length=len(body)):
                status, _, data = self.request('POST', '/api/create', body, headers)
                self.assertEqual(status, expected)
                self.assertIn('error', json.loads(data))
        self.assertEqual(fingerprint(self.project), before)
        self.assertEqual(self.ws.state_file.read_bytes(), state)
        self.assertEqual(self.request('GET', '/api/workspace', headers=good)[0], 200)

    def test_static_traversal_symlink_and_cross_origin_session_are_denied(self):
        for route in ['/../fictional-agent/AGENTS.md', '/escape']:
            with self.subTest(route=route):
                status, _, data = self.request('GET', route)
                self.assertEqual(status, 403)
                self.assertNotIn(b'# Fixture', data)
        status, headers, _ = self.request('GET', '/')
        self.assertEqual(status, 200)
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        status, _, data = self.request('GET', '/api/session', headers={'Origin': 'https://outside.invalid'})
        self.assertEqual(status, 403)
        self.assertNotIn(b'synthetic-adversarial-token', data)


if __name__ == '__main__':
    unittest.main()
