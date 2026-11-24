"""Immutable document snapshot of one root: the bytes a suite is checked against.

Bounded and read-only: protected paths are refused, and no document is executed.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import stat

try:
    from .protected import MESSAGE as PROTECTED_MESSAGE, contains, protected_paths
    from .scanner import MAX_ROOTS, InvalidInput, pinned_directory, scan, within
except ImportError:
    from protected import MESSAGE as PROTECTED_MESSAGE, contains, protected_paths
    from scanner import MAX_ROOTS, InvalidInput, pinned_directory, scan, within

MAX_FILES = 200
MAX_FILE_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024


def policy_excluded_path(relative):
    """Explicit snapshot policy, distinct from a failed or truncated read."""
    path = PurePosixPath(relative)
    return (any(part.startswith('.env') or part in {'.git', '.codex', '.ssh', '.aws', '.config'} for part in path.parts)
            or path.name.lower() in {'auth.json', 'credentials.json', 'secrets.json', 'tokens.json'})


def document_lines(text):
    """Line model of suite ranges and of their contentHash."""
    return text.splitlines(keepends=True)


def excerpt_bytes(lines, start, end):
    """UTF-8 bytes of lines start..end (1-based, inclusive, terminators kept)."""
    return ''.join(lines[start - 1:end]).encode('utf-8')


def excerpt_sha256(lines, start, end):
    """The project's single excerpt hash: a requirement's contentHash."""
    return hashlib.sha256(excerpt_bytes(lines, start, end)).hexdigest()


def _read_document(root, relative):
    """Open each path component without following symlinks, then bounded read."""
    parts = PurePosixPath(relative).parts
    if not parts or any(part in {'', '.', '..'} for part in parts) or relative.startswith('/'):
        raise InvalidInput('Path outside the snapshot.')
    # From `/`, without the root's first part (its anchor): callers pass an absolute root, and nothing is read from the cwd.
    with pinned_directory(Path('/', *Path(root).parts[1:], *parts[:-1])) as directory:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            stream = os.fdopen(fd, 'rb')
        except BaseException:
            os.close(fd)  # fdopen refuses a directory without closing the descriptor it was given
            raise
        with stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                raise InvalidInput('Only regular files, without hard links, can take part.')
            data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES or b'\x00' in data:
        raise InvalidInput('Binary file, or one above the snapshot limit.')
    return data.decode('utf-8')


def build_snapshot(model, payload):
    root_value, entry_value = payload.get('root'), payload.get('entry')
    if not isinstance(root_value, str) or not isinstance(entry_value, str):
        raise InvalidInput('Select a directory and an entry file.')
    root = Path(root_value)
    roots = {record['path'] for record in model['roots']}
    directories = {node['id'] for node in model['nodes'] if node['kind'] == 'directory' and node['status'] == 'resolved'}
    if str(root) not in roots | directories or not root.is_absolute() or root.resolve() != root:
        raise InvalidInput('Directory missing or changed. Rescan the workspace.')
    protected = protected_paths()  # One reading of the configuration for the directory and all the files.
    if contains(protected, root):
        raise InvalidInput(f'{PROTECTED_MESSAGE} It cannot enter a snapshot; open a copy.')
    entry = Path(entry_value)
    if not within(entry, root):
        raise InvalidInput('The entry must be in the selected directory.')
    canaries = payload.get('canaries', [])
    if not isinstance(canaries, list) or len(canaries) > 10:
        raise InvalidInput('Use up to 10 paths of virtual canaries.')
    documents, omitted, total, excluded_policy = {}, 0, 0, []
    candidates = sorted(model['nodes'], key=lambda node: (node['id'] != entry_value, node['kind'] != 'entry', node['id']))
    for node in candidates:
        path = Path(node['id'])
        if not within(path, root) or node.get('analysis') != 'parsed' or node['status'] != 'resolved':
            continue
        relative = path.relative_to(root).as_posix()
        if policy_excluded_path(relative):
            omitted += 1
            excluded_policy.append({'path': relative, 'reason': 'sensitive-path'})
            continue
        if len(documents) >= MAX_FILES - len(canaries) or contains(protected, path):
            omitted += 1
            continue
        try:
            text = _read_document(root, relative)
        except (OSError, ValueError, UnicodeError):
            omitted += 1
            continue
        encoded = text.encode('utf-8')
        if total + len(encoded) > MAX_TOTAL_BYTES:
            omitted += 1
            continue
        total += len(encoded)
        documents[relative] = {'text': text, 'node': node['id'], 'bytes': len(encoded),
                               'sha256': hashlib.sha256(encoded).hexdigest(), 'canary': False}
    entry_relative = entry.relative_to(root).as_posix()
    if entry_relative not in documents:
        raise InvalidInput('The entry is not an analyzed text available to the snapshot.')
    physical_paths = {node['id'] for node in model['nodes']}
    for name in canaries:
        if not isinstance(name, str) or not 1 <= len(name) <= 160 or '\\' in name or any(ord(c) < 32 for c in name):
            raise InvalidInput('Invalid canary path.')
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or path.as_posix() != name or name in documents or str(root / name) in physical_paths or os.path.lexists(root / name):
            raise InvalidInput('Canaries need new relative paths, without overwriting files.')
        text = '# Canário de navegação\n\nDocumento artificial do experimento. Não contém instruções operacionais.\n'
        encoded = text.encode()
        if total + len(encoded) > MAX_TOTAL_BYTES:
            raise InvalidInput('The canaries exceed the text budget of the snapshot.')
        total += len(encoded)
        documents[name] = {'text': text, 'node': None, 'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest(), 'canary': True}
    return {'root': str(root), 'entry': entry_relative, 'documents': documents, 'omitted': omitted,
            'excludedPolicy': excluded_policy, 'bytes': total}


def _relative(value):
    if (not isinstance(value, str) or not value or '\\' in value
            or any(ord(c) < 32 for c in value)):
        raise InvalidInput('Use a normalized relative path.')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or path.as_posix() != value or value == '.':
        raise InvalidInput('Use a normalized relative path.')
    return value


def _roots(values):
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_ROOTS or any(not isinstance(p, str) for p in values):
        raise InvalidInput(f'Give 1 to {MAX_ROOTS} directories.')
    roots = list(dict.fromkeys(str(Path(value).expanduser().absolute()) for value in values))
    for root in roots:
        path = Path(root)
        if path.resolve(strict=True) != path or not path.is_dir():
            raise InvalidInput('Roots must be real directories, without symbolic links.')
    return roots


def prepare(roots, suite):
    """Scan all roots; the document snapshot is of the first one only."""
    roots = _roots(roots)
    if not isinstance(suite, dict):
        raise InvalidInput('The suite must be an object.')
    entry = _relative(suite.get('entry'))
    model = scan(roots)
    snapshot = build_snapshot(model, {'root': roots[0], 'entry': str(Path(roots[0]) / entry)})
    incomplete = [issue for issue in model['issues'] if issue['code'] in {'limit', 'unreadable'}]
    snapshot['scanPartial'] = bool(incomplete)
    snapshot['scanIssues'] = [{'code': issue['code'], 'node': issue.get('node')} for issue in incomplete]
    return model, snapshot
