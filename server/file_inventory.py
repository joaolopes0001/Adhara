"""Inventory of regular files under the roots: hashes and sizes, never content."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat

try:
    from .doc_snapshot import _roots
    from .scanner import InvalidInput, open_regular_file, pinned_directory
except ImportError:
    from doc_snapshot import _roots
    from scanner import InvalidInput, open_regular_file, pinned_directory

INVENTORY_MAX_ENTRIES = 20000
INVENTORY_MAX_FILE_BYTES = 16 * 1024 * 1024
INVENTORY_MAX_BYTES = 128 * 1024 * 1024


def capture_inventory(roots):
    """Hash regular files with bounded reads; never execute scripts or follow links.

    Root indices retain identity across copies. Overlapping roots are assigned to
    the first matching root; order is therefore part of the comparison contract.
    """
    roots = _roots(roots)
    files, omitted, seen = [], [], set()
    consumed = visited = 0
    for index, root in enumerate(roots):
        try:
            with pinned_directory(root) as root_descriptor:
                initial = os.fstat(root_descriptor)
                walked = False
                # Walk relative to the pinned root, including when ancestors change.
                for folder, dirs, names, descriptor in os.fwalk('.', dir_fd=root_descriptor, follow_symlinks=False,
                                                               onerror=lambda exc: omitted.append({'root': index, 'reason': 'unreadable'})):
                    walked = True
                    dirs.sort()
                    for name in sorted(dirs + names):
                        absolute = str(Path(root) / folder / name)
                        if absolute in seen:
                            continue
                        seen.add(absolute)
                        visited += 1
                        relative = Path(absolute).relative_to(root).as_posix()
                        if visited > INVENTORY_MAX_ENTRIES:
                            omitted.append({'root': index, 'reason': 'entry-limit'})
                            break
                        try:
                            info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                            if stat.S_ISDIR(info.st_mode):
                                continue
                            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                                omitted.append({'root': index, 'path': relative, 'reason': 'nonregular-or-link'})
                                continue
                            if info.st_size > INVENTORY_MAX_FILE_BYTES or consumed + info.st_size > INVENTORY_MAX_BYTES:
                                omitted.append({'root': index, 'path': relative, 'reason': 'byte-limit'})
                                continue
                            with open_regular_file(absolute) as stream:
                                before = os.fstat(stream.fileno())
                                if before.st_nlink != 1:
                                    raise InvalidInput('Hard link.')
                                budget = min(INVENTORY_MAX_FILE_BYTES, INVENTORY_MAX_BYTES - consumed)
                                data = stream.read(budget + 1)
                                after = os.fstat(stream.fileno())
                            consumed += len(data)
                            signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
                            if (len(data) > budget or len(data) != before.st_size
                                    or signature(info) != signature(before) or signature(before) != signature(after) or after.st_nlink != 1):
                                omitted.append({'root': index, 'path': relative, 'reason': 'changed-or-limit'})
                                continue
                            files.append({'root': index, 'path': relative, 'bytes': len(data),
                                          'sha256': hashlib.sha256(data).hexdigest()})
                        except (OSError, ValueError):
                            omitted.append({'root': index, 'path': relative, 'reason': 'unreadable-or-changed'})
                    if visited > INVENTORY_MAX_ENTRIES:
                        break
                current = os.stat(root, follow_symlinks=False)
                if not walked or (initial.st_dev, initial.st_ino) != (current.st_dev, current.st_ino) or not stat.S_ISDIR(current.st_mode):
                    omitted.append({'root': index, 'reason': 'root-changed'})
        except (OSError, RecursionError):
            omitted.append({'root': index, 'reason': 'unreadable-or-depth-limit'})
        if visited > INVENTORY_MAX_ENTRIES:
            break
    return {'version': 1, 'roots': roots, 'files': sorted(files, key=lambda item: (item['root'], item['path'])),
            'partial': bool(omitted), 'omitted': omitted, 'bytes': sum(f['bytes'] for f in files)}
