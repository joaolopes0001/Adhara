"""Content editing of existing Markdown documents: the write core, without routes or permission.

`read_for_edit` and `save` follow one numbered sequence (the step numbers in the
comments). Before touching the disk: the path must be a resolved file node of the
current reading, strictly below an opened root and outside the folders that root does
not read; a file named like the protection list is never editable; only Markdown is.
Protection is checked by path and by identity: `(st_dev, st_ino)` of every folder
pinned from `/` and of the file are compared with the protected entries and the state
directories, so a bind mount of a protected entry itself, or of a state directory, is
refused too. An entry that cannot be consulted refuses every edit, except the missing
destination of an entry that is a dangling link, which is compared by path only.
Known limit: a bind mount of a *subfolder* of a protected entry, mounted
inside an opened root, matches no identity and is not detected (that would take the
mount table). Each folder is opened by descriptor without following links. The file
must be regular, single-named, owned by this user and writable by its owner, up to
256 KiB of strict UTF-8 with one kind of line break; the text travels with `\\n` and no
BOM, and both are restored from the bytes on disk.

`save` holds an exclusive `flock` on the pinned folder, so two app instances never
save there at once. It tries once: a folder held by anyone raises `FolderBusy`, and the
caller retries, if it wants, after releasing the workspace lock. On a filesystem where a
folder cannot be locked (NFS, for one), saving is refused and the message says why,
rather than going on without the lock. `read_for_edit` tries a shared lock without
waiting, so that such a folder is refused when the editor opens, not only when saving;
a folder held by a save does not refuse it.
It refuses when the bytes on disk no longer have the hash the caller read (there is
no force mode), and a text that starts with U+FEFF. It replaces the file atomically: a
temporary in the same folder with the group, extended attributes (POSIX ACLs included),
setgid bit and mode of the original, fsync, a second check of the file (stat fields and
bytes) and of the folder by path, rename, and then a check that the file at the name is
the temporary written here, with its bytes. Known limit: between those last checks and
the rename there is a window of a few system calls in which a write by another program,
or a moved folder, is not seen; the rename always goes into the pinned folder.

Every `Refusal` but one guarantees the document was left as it was; when a temporary
could not be removed, the message names it. The exception is `unconfirmed` (409): the
outcome is unknown and the caller must read the file again. It comes when the rename
reported an error and neither the document nor the temporary holds what was written
(another program removed the temporary, say), and when, after the rename, the file at
the name is not what was written (another program swapped or changed the temporary, or
the name, in the meantime). Otherwise, after a rename that is known to have happened,
nothing is a refusal: a failed fsync of the folder, or a rename that happened but
reported an error, becomes `durable: False`.

`read_for_edit` and `save` take `root`, the opened root under which the caller says
editing applies, and check only its containment. The permission is decided around
them: `grant` checks a root before editing is enabled on it and returns the identity
the grant records; `granting_root` chooses, for a path, the root whose grant applies
(the most specific opened root that contains it, which needs a grant of its own, for the
same folder that was there when the grant was given, never `/`, the home folder or a
folder above it); `honored` says which grants of the opened roots are not refused now.
`state_dirs` are the app state directories (configured and default). Callers hold the
workspace lock. The reader modules are imported, never changed.
"""
from __future__ import annotations

import errno
import fcntl
import hashlib
import os
import re
import secrets
import stat
from pathlib import Path

try:
    from .protected import (MESSAGE as PROTECTED_MESSAGE, STATE_FILE, _forms as protected_forms, contains,
                            protected_paths, sources as protected_sources)
    from .scanner import EXCLUDED, account_home, below, within
    from .texts import of, say
except ImportError:
    from protected import (MESSAGE as PROTECTED_MESSAGE, STATE_FILE, _forms as protected_forms, contains,
                           protected_paths, sources as protected_sources)
    from scanner import EXCLUDED, account_home, below, within
    from texts import of, say

EDITABLE = frozenset({'.md', '.markdown'})  # Editable types: the one product choice in the core.
MAX_BYTES = 256 * 1024
# Never editable, in any folder and whatever EDITABLE holds; compared without case.
RESERVED_NAMES = frozenset({STATE_FILE.casefold()})
BOM = b'\xef\xbb\xbf'
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
TEMPORARY = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
NOT_FILES = frozenset({'directory', 'symlink', 'unresolved'})
SHA256 = re.compile(r'[0-9a-f]{64}')
KEPT_MODE = 0o2777  # Permission bits and setgid; setuid and sticky are dropped.
# Retries of `Workspace.edit_save` while the folder lock is held: 50, 100, 200, 250, 250… ms, 5 s in all.
LOCK_WAIT = 5.0
LOCK_RETRY = 0.05
LOCK_RETRY_MAX = 0.25
NO_ATTRIBUTES = frozenset({errno.ENOTSUP, errno.EOPNOTSUPP})  # A filesystem without extended attributes.

STATUS = {'edit-not-granted': 403, 'protected': 403, 'app-state': 403, 'conflict': 409, 'missing': 409,
          'folder-changed': 409, 'unconfirmed': 409, 'too-large': 413}
# Flock errors of a filesystem that cannot lock a folder (NFS emulates flock with POSIX locks).
NO_FOLDER_LOCK = frozenset({errno.ENOLCK, errno.EOPNOTSUPP, errno.ENOTSUP, errno.EBADF, errno.EINVAL})
NO_LOCK = say('The file system of this folder does not allow reserving it (flock), and without that two saves could '
              'overlap; editing is not available here. Nothing was saved.')
# Who holds the lock is not known: another program, or a save of another instance of the app.
BUSY = say('The folder of the document is reserved (flock) by another program or by another save. Try again. Nothing was saved.')
# After a rename that happened: what is at the document's name could not be confirmed as this save's file. Only
# that is known (the bytes may even be the ones sent), so the message says no more.
LANDING_UNCONFIRMED = say('The file was replaced, but it could not be confirmed that the file now in the place of the document '
                          'is the one of this save. Read the file again and check the content before saving again.')
# Added by `grant` to a refusal because the root itself is protected.
PROTECTED_TRADE = say('The protection applies to you here in the app too. Taking off the list the entry that protects this project '
                      'allows editing, and also creation and state of any program in that path.')
WIDE = say('Editing cannot be turned on in the system root, the home folder or a folder above it: it would reach '
           'the documents and agent settings of every project. Open the project folder and turn editing on there.')
CHANGED = say('The folder at this path is not the same as when editing was turned on in it. If this is the right project, '
              'turn editing on again.')
MESSAGES = {
    'edit-not-granted': say('Editing is not on in the open project that contains this file.'),
    'not-in-workspace': say('This path is not a file of the current scan of this project. Rescan the projects.'),
    'app-state': say('Files of the app state are not editable.'),
    'protected': say('{protected} Editing respects that list too.', protected=PROTECTED_MESSAGE),
    'not-editable-type': say('The app edits only Markdown documents (.md and .markdown).'),
    'not-regular': say('On disk, this path is not a regular file or goes through a symbolic link. Rescan the projects.'),
    'hardlink': say('The file has more than one name (a hard link); saving would split the names.'),
    'other-owner': say('The file belongs to another user.'),
    'other-group': say('The system did not let the app keep the group of the file. Nothing was saved.'),
    'read-only-file': say('The file has no write permission.'),
    'binary': say('The file has a null byte: it looks binary.'),
    'not-utf8': say('The file is not valid UTF-8 text.'),
    'mixed-eol': say('The file mixes line breaks or has a lone carriage return.'),
    'invalid-text': say('The text sent cannot be saved.'),
    'too-large': say('The file, or the new text, is larger than 256 KiB.'),
    'conflict': say('The file changed on disk after it was opened for editing. Nothing was saved.'),
    'missing': say('The file, or a folder of its path, no longer exists on disk.'),
    'folder-changed': say('The folder of the file was moved or replaced during the save. Nothing was saved.'),
    'write-failed': say('Could not save the file. Nothing was saved.'),
    'unconfirmed': say('Could not confirm whether the file was replaced. Read the file again before saving again.'),
}


class Refusal(ValueError):
    """An edit refused: stable `code`, HTTP `status` and a message (`texts.say`).

    The document was left as it was, for every code but `unconfirmed`, whose outcome is unknown.
    """

    def __init__(self, code, message=None):
        self.code, self.status = code, STATUS.get(code, 400)
        super().__init__(message or MESSAGES[code])


class FolderBusy(Refusal):
    """`write-failed` because the folder lock is held now: nothing was done, and the caller may try again."""

    def __init__(self):
        super().__init__('write-failed', BUSY)


def _cause(exc):
    return exc.strerror or type(exc).__name__


def _failed(exc, action=None):
    """`write-failed` saying the real cause: a missing permission is named as such. `action`: what failed, to save the file when not given."""
    action = action or say('save the file')
    if isinstance(exc, PermissionError):
        return Refusal('write-failed', say('No permission to {action}. Nothing was saved.', action=action))
    return Refusal('write-failed', say('Could not {action} ({cause}). Nothing was saved.', action=action, cause=_cause(exc)))


def _close(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def _available(root):
    """Same rule as `Workspace._available`: an existing directory whose path has no link."""
    try:
        candidate = Path(root)
        return candidate.is_dir() and candidate.resolve(strict=True) == candidate
    except (OSError, RuntimeError):
        return False


def _opened(model, root):
    return isinstance(root, str) and root in {item['path'] for item in model['roots']}


def _target(model, root, path):
    """Steps 1 to 7, without touching the disk: an editable file node strictly below an opened root."""
    if not isinstance(path, str) or not os.path.isabs(path) or '\x00' in path or os.path.normpath(path) != path:  # 1
        raise Refusal('not-in-workspace')
    if not _opened(model, root):  # 2
        raise Refusal('not-in-workspace', say('The project is not open. Rescan the projects.'))
    relative = below(path, root)  # 3
    if relative is None:
        raise Refusal('not-in-workspace')
    if not any(node['id'] == path and node['status'] == 'resolved' and node['kind'] not in NOT_FILES
               for node in model['nodes']):  # 4
        raise Refusal('not-in-workspace')
    if any(part in EXCLUDED for part in relative.split('/')):  # 5
        raise Refusal('not-in-workspace', say('The file is in a folder this project does not read.'))
    name = os.path.basename(path)
    if name.casefold() in RESERVED_NAMES:  # 6: before the type, so it holds whatever EDITABLE is
        raise Refusal('app-state', say('A file named {file} is never editable by the app, in any folder.', file=STATE_FILE))
    if Path(name).suffix.lower() not in EDITABLE:  # 7
        raise Refusal('not-editable-type')
    return name


def _check_text(base_sha256, text):
    """Step 8 (save only): a well-formed base hash and a text that encodes as it will be written."""
    if not isinstance(base_sha256, str) or not SHA256.fullmatch(base_sha256):
        raise Refusal('invalid-text', say('The base hash sent is invalid.'))
    if not isinstance(text, str) or '\r' in text or '\x00' in text:
        raise Refusal('invalid-text', say('The text sent must be text with \\n line breaks and without a null byte.'))
    try:
        encoded = text.encode('utf-8')
    except UnicodeEncodeError:
        raise Refusal('invalid-text', say('The text sent has a character that does not exist in UTF-8.')) from None
    if len(encoded) > MAX_BYTES:
        raise Refusal('too-large')


def _state_forms(state_dirs):
    forms = set()
    for directory in state_dirs:
        forms.add(Path(os.path.abspath(directory)))
        try:
            forms.add(Path(directory).resolve())
        except (OSError, RuntimeError):
            pass  # The lexical form still counts; the identity covers the rest.
    return forms


def _unconsultable(form):
    """The fail-closed refusal for a protected `form` that cannot be consulted, naming the entry as it was written.

    A form is the written entry normalized or resolved (`protected._forms`): `a/link/../b` is
    also compared as `a/b`, which may not exist. The configuration is read again only to
    find the entry and its source; if that fails, the form is named.
    """
    try:
        written = next(((entry, source.name) for source in protected_sources() for entry in source.entries
                        if form in protected_forms(entry)), None)
    except ValueError:
        written = None
    if written is None:
        return Refusal('protected', say('Could not consult the protected entry {entry}. '
                                        'Editing stays refused until it exists again or leaves the list.', entry=form))
    entry, source = written
    if str(entry) == str(form):
        return Refusal('protected', say('Could not consult the protected entry {entry}, from {source}. '
                                        'Editing stays refused until it exists again or leaves the list.', entry=entry, source=source))
    return Refusal('protected', say('Could not consult the protected entry {entry}, from {source}: the form {form}, '
                                    'which the comparison also uses, does not exist or cannot be consulted. Editing stays '
                                    'refused until the entry is fixed or leaves the list.', entry=entry, source=source, form=form))


def _guarded(target, state_dirs):
    """Steps 9 to 11: refuse `target` by path; then the identities to refuse, `(st_dev, st_ino) -> code`."""
    try:
        protected = protected_paths()  # 9: one reading of the configuration
    except ValueError as exc:
        raise Refusal('protected', say('{problem} Editing stays refused until the configuration is fixed.', problem=of(exc))) from None
    if contains(protected, target):  # 10
        raise Refusal('protected')
    states = _state_forms(state_dirs)
    if any(within(Path(target), state) for state in states):
        raise Refusal('app-state')
    # An entry that is a dangling link brings its destination as a second form (`protected._forms`), and that
    # destination does not exist: it has no identity to compare. Only that form is skipped; the path comparison
    # above still covers it, and any other entry that cannot be consulted still refuses everything.
    dangling = set()
    for entry in protected:
        if os.path.islink(entry):
            try:
                dangling.add(Path(entry).resolve())  # The same form `protected._forms` computed.
            except (OSError, RuntimeError):
                pass
    identities = {}
    for entry in protected:  # 11: fails closed on an entry that cannot be consulted
        try:
            info = os.stat(entry)
        except OSError as first:
            try:
                info = os.lstat(entry)
            except OSError as second:
                if isinstance(first, FileNotFoundError) and isinstance(second, FileNotFoundError) and entry in dangling:
                    continue
                raise _unconsultable(entry) from None
        identities[(info.st_dev, info.st_ino)] = 'protected'
    for state in states:
        try:
            info = os.stat(state)
        except (FileNotFoundError, NotADirectoryError):
            continue  # A state directory that does not exist has nothing to compare.
        except OSError:
            raise Refusal('app-state', say('Could not consult the state directory of the app.')) from None
        identities.setdefault((info.st_dev, info.st_ino), 'app-state')
    return identities


def _pin(components, identities):
    """Step 12: descriptor and identity of the last folder of `components`, opened from `/` without links.

    Every folder opened on the way, `/` included, is compared with the guarded identities.
    """
    try:
        fd = os.open('/', DIRECTORY)
    except OSError:
        raise Refusal('not-regular') from None
    try:
        for part in (None, *components):
            if part is not None:
                child = os.open(part, DIRECTORY, dir_fd=fd)
                fd, previous = child, fd
                os.close(previous)
            info = os.fstat(fd)
            code = identities.get((info.st_dev, info.st_ino))
            if code:
                raise Refusal(code)
    except FileNotFoundError:
        _close(fd)
        raise Refusal('missing') from None
    except PermissionError:
        _close(fd)
        raise Refusal('not-regular', say('No permission to enter a folder of the path of the file.')) from None
    except OSError:
        _close(fd)
        raise Refusal('not-regular') from None
    except BaseException:
        _close(fd)
        raise
    return fd, (info.st_dev, info.st_ino)


def _lock(parent_fd):
    """Step 12a (save only): one save per folder at a time, also across app instances.

    The workspace lock is per process. One attempt, never a wait: a lock held by any other
    program raises `FolderBusy`, and the caller, which holds the workspace lock, decides
    whether to try again after releasing it (`Workspace.edit_save`).
    """
    try:
        fcntl.flock(parent_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # Released when parent_fd is closed.
    except BlockingIOError:
        raise FolderBusy() from None
    except OSError as exc:
        if exc.errno in NO_FOLDER_LOCK:  # Refused, never saved without the lock.
            raise Refusal('write-failed', NO_LOCK) from None
        raise _failed(exc, say('reserve the folder of the document')) from None


def _probe_lock(parent_fd):
    """Read only: refuse at once where a save could never lock the folder, instead of when saving.

    A shared lock, without waiting, released at once. A folder held by a save now does
    not refuse the read; any other error is left for the save, which names its cause.
    """
    try:
        fcntl.flock(parent_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    except OSError as exc:
        if exc.errno in NO_FOLDER_LOCK:
            raise Refusal('write-failed', NO_LOCK) from None
        return
    try:
        fcntl.flock(parent_fd, fcntl.LOCK_UN)
    except OSError:
        pass  # Closing the descriptor releases it anyway.


def _attributes(fd):
    """Extended attributes of an open file, POSIX ACLs included; none where the filesystem has none."""
    try:
        names = os.listxattr(fd)
    except OSError as exc:
        if exc.errno in NO_ATTRIBUTES:
            return {}
        raise
    return {name: os.getxattr(fd, name) for name in names}


def _read(parent_fd, name, identities, attributes=False):
    """Steps 13 and 14: the bytes, the `fstat` and (for `save`) the extended attributes of the file."""
    try:
        fd = os.open(name, READ, dir_fd=parent_fd)
    except FileNotFoundError:
        raise Refusal('missing') from None
    except PermissionError:
        raise Refusal('not-regular', say('No permission to open the file: read permission on it '
                                         'or access to its folder is missing.')) from None
    except OSError:
        raise Refusal('not-regular') from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise Refusal('not-regular')
        code = identities.get((info.st_dev, info.st_ino))
        if code:
            raise Refusal(code)
        if info.st_nlink != 1:
            raise Refusal('hardlink')
        if info.st_uid != os.geteuid():
            raise Refusal('other-owner')
        if not info.st_mode & stat.S_IWUSR:
            raise Refusal('read-only-file')
        if info.st_size > MAX_BYTES:
            raise Refusal('too-large')
        data = _bytes(fd)
        if attributes:
            try:
                attributes = _attributes(fd)
            except OSError as exc:
                raise _failed(exc, say('read the extended attributes of the file')) from None
    except OSError as exc:
        raise Refusal('not-regular', say('Could not read the file ({cause}).', cause=_cause(exc))) from None
    finally:
        _close(fd)
    if len(data) > MAX_BYTES:
        raise Refusal('too-large')
    return data, info, attributes


def _bytes(fd):
    """Up to MAX_BYTES + 1 bytes of an open file: one more than the limit says it is too large."""
    data = bytearray()
    while len(data) <= MAX_BYTES:
        chunk = os.read(fd, MAX_BYTES + 1 - len(data))
        if not chunk:
            break
        data += chunk
    return bytes(data)


def _describe(data):
    """Step 15: (text with `\\n`, 'lf' or 'crlf', bom) of the bytes on disk."""
    bom = data.startswith(BOM)
    body = data[len(BOM):] if bom else data
    if b'\x00' in body:
        raise Refusal('binary')
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError:
        raise Refusal('not-utf8') from None
    crlf, lf, cr = text.count('\r\n'), text.count('\n'), text.count('\r')
    if cr and not crlf == lf == cr:
        raise Refusal('mixed-eol')
    return text.replace('\r\n', '\n'), 'crlf' if crlf else 'lf', bom


def _same_file(before, after):
    # Stricter than inode, size and mtime: ctime, links, mode and owner catch a chmod or a new name too.
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_nlink', 'st_uid', 'st_gid')
    return all(getattr(before, field) == getattr(after, field) for field in fields)


def _still_the_same(parent_fd, name, info, digest):
    """Step 20: the file is still the one read, by its stat fields and by its bytes.

    The bytes are read again because a write through a shared mapping moves neither
    mtime nor ctime, and two writes in the same clock tick leave them equal.
    """
    try:
        fd = os.open(name, READ, dir_fd=parent_fd)
    except FileNotFoundError:
        raise Refusal('missing') from None
    except OSError as exc:
        if exc.errno == errno.ELOOP:  # Swapped for a link.
            raise Refusal('conflict') from None
        raise _failed(exc, say('check the file')) from None
    try:
        again = os.fstat(fd)
        if not _same_file(info, again):
            raise Refusal('conflict')
        data = _bytes(fd)
    except OSError as exc:
        raise _failed(exc, say('check the file')) from None
    finally:
        _close(fd)
    if hashlib.sha256(data).hexdigest() != digest:
        raise Refusal('conflict')


def _landed(parent_fd, name, written, digest):
    """Step 22a: after the rename, whether the file at `name` is the temporary written here, single-named, with these bytes.

    Another program may rename its own file over the temporary, write into it, give it a
    second name (which would keep changing the document from elsewhere), or put a link or
    something else at the name right after: the answer must describe what is on disk. It
    describes it at this instant; a change after this check is not seen here.
    """
    try:
        fd = os.open(name, READ, dir_fd=parent_fd)
    except OSError:
        return False  # A link (ELOOP), a name that is gone, or one that cannot be opened.
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != written or info.st_nlink != 1:
            return False
        return hashlib.sha256(_bytes(fd)).hexdigest() == digest
    except OSError:
        return False
    finally:
        _close(fd)


def _identity_at(parent_fd, entry):
    try:
        info = os.stat(entry, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return None
    return info.st_dev, info.st_ino


def _synced(fd):
    try:
        os.fsync(fd)
    except OSError:
        return False
    return True


def read_for_edit(model, root, path, state_dirs):
    """Text of an editable document, with the hash of its bytes: `{path, text, sha256, bytes, eol, bom}`."""
    name = _target(model, root, path)
    identities = _guarded(path, state_dirs)
    parent_fd, _ = _pin(Path(path).parts[1:-1], identities)
    try:
        _probe_lock(parent_fd)
        data, _, _ = _read(parent_fd, name, identities)
    finally:
        _close(parent_fd)
    text, eol, bom = _describe(data)
    return {'path': path, 'text': text, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'eol': eol, 'bom': bom}


def save(model, root, path, base_sha256, text, state_dirs):
    """Replace the document with `text` if its bytes still hash to `base_sha256`.

    Returns `{path, sha256, bytes, previousSha256, unchanged, durable}`; raises `Refusal`
    with the document as it was, except `unconfirmed` (outcome unknown: read it again).
    """
    name = _target(model, root, path)
    _check_text(base_sha256, text)
    identities = _guarded(path, state_dirs)
    parent_fd, parent_id = _pin(Path(path).parts[1:-1], identities)
    temporary, replaced = None, False
    try:
        _lock(parent_fd)  # 12a
        data, info, attributes = _read(parent_fd, name, identities, attributes=True)
        current, eol, bom = _describe(data)
        previous = hashlib.sha256(data).hexdigest()
        if previous != base_sha256:  # 16
            raise Refusal('conflict')
        # The text travels without BOM, and the BOM of the file is the one on disk: a leading U+FEFF would put a
        # permanent, invisible one in a file without it. A file whose text itself starts with U+FEFF keeps it.
        if text.startswith('﻿') and not current.startswith('﻿'):
            raise Refusal('invalid-text', say('The text sent starts with a BOM (U+FEFF); the text always goes without it, and the '
                                              'BOM of the file is the one on disk.'))
        new = (BOM if bom else b'') + (text.replace('\n', '\r\n') if eol == 'crlf' else text).encode('utf-8')  # 17
        if len(new) > MAX_BYTES:
            raise Refusal('too-large')
        if new == data:  # Nothing to write; `durable` still says whether the folder is on disk.
            return {'path': path, 'sha256': previous, 'bytes': len(data), 'previousSha256': previous,
                    'unchanged': True, 'durable': _synced(parent_fd)}
        candidate = f'.aae-edit-{secrets.token_hex(8)}.tmp'  # 18: short, so a 255-byte name still fits
        try:
            fd = os.open(candidate, TEMPORARY, 0o600, dir_fd=parent_fd)
        except PermissionError:
            raise Refusal('write-failed', say('No write permission in the folder of the document. Nothing was saved.')) from None
        except OSError as exc:
            raise _failed(exc) from None
        temporary = candidate  # From here on it is removed on any refusal, unless the rename happened.
        written = _fill(fd, new, info, attributes)  # 19
        _still_the_same(parent_fd, name, info, previous)  # 20
        folder = Path(path).parent  # 21: the pinned folder is still the one at this path, with no link
        try:
            by_path = os.stat(folder, follow_symlinks=False)
            moved = (by_path.st_dev, by_path.st_ino) != parent_id or folder.resolve(strict=True) != folder
        except (OSError, RuntimeError):
            moved = True
        if moved:
            raise Refusal('folder-changed')
        # Known limit: a write to the document by another program after step 20, or a folder move after step 21,
        # is not seen before this rename (the write is lost; the rename goes into the pinned folder). A change to
        # the temporary, or at the name right after the rename, is caught by step 22a.
        digest = hashlib.sha256(new).hexdigest()
        try:  # 22
            os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        except OSError as exc:
            if _identity_at(parent_fd, name) == written:
                # The rename happened and still reported an error (a lost reply on a network filesystem).
                replaced = True
                if not _landed(parent_fd, name, written, digest):  # 22a
                    raise Refusal('unconfirmed', LANDING_UNCONFIRMED) from None
                return {'path': path, 'sha256': digest, 'bytes': len(new),
                        'previousSha256': previous, 'unchanged': False, 'durable': False}
            if _identity_at(parent_fd, temporary) != written:
                # Neither name holds the temporary: the outcome is unknown, and a name that may not be ours stays.
                left, temporary = temporary, None
                raise Refusal('unconfirmed', say('Could not confirm whether the file was replaced ({cause}). '
                                                 'Read the file again before saving again. The temporary file of this save '
                                                 'was named {temporary}; if it is still in the folder, it was not deleted.',
                                                 cause=_cause(exc), temporary=left)) from None
            raise _failed(exc) from None
        replaced = True
        landed = _landed(parent_fd, name, written, digest)  # 22a
        durable = _synced(parent_fd)  # 23
        if not landed:  # After the rename the only refusal: the outcome is unknown, never "nothing was saved".
            raise Refusal('unconfirmed', LANDING_UNCONFIRMED)
        return {'path': path, 'sha256': digest, 'bytes': len(new),  # 24
                'previousSha256': previous, 'unchanged': False, 'durable': durable}
    except BaseException as exc:
        if temporary is not None and not replaced:
            left = _remove(parent_fd, temporary)
            if left and isinstance(exc, Refusal):
                raise Refusal(exc.code, say('{refusal} The temporary file {temporary} was left in the folder of the document, '
                                            'with the new text; it can be deleted.', refusal=of(exc), temporary=left)) from None
        raise
    finally:
        _close(parent_fd)  # Also releases the flock.


def _remove(parent_fd, temporary):
    """None once the temporary is gone; else its name."""
    try:
        os.unlink(temporary, dir_fd=parent_fd)
    except FileNotFoundError:
        return None
    except OSError:
        return temporary
    return None


def _fill(fd, data, info, attributes):
    """Step 19: write, then give the temporary the group, attributes and mode of the original, check, fsync.

    Returns the identity of the temporary; the descriptor is closed.
    """
    mode = stat.S_IMODE(info.st_mode) & KEPT_MODE
    try:
        try:
            view = memoryview(data)
            while view:
                count = os.write(fd, view)
                if not count:
                    raise OSError('nothing written')
                view = view[count:]
        except OSError as exc:
            raise _failed(exc) from None
        try:
            os.fchown(fd, -1, info.st_gid)
        except OSError as exc:
            if exc.errno == errno.EPERM:
                raise Refusal('other-group') from None
            raise _failed(exc) from None
        try:
            current = _attributes(fd)
            # An ACL inherited from the folder's default ACL would give access the original did not.
            for key in current.keys() - attributes.keys():
                os.removexattr(fd, key)
            for key, value in attributes.items():
                if current.get(key) != value:
                    os.setxattr(fd, key, value)
            os.fchmod(fd, mode)  # After the ACL, so that the mode is exactly the original one.
            kept = os.fstat(fd)
            same = stat.S_IMODE(kept.st_mode) == mode and _attributes(fd) == attributes
        except OSError as exc:
            raise _failed(exc, say('keep the mode and the attributes of the file')) from None
        if kept.st_gid != info.st_gid:
            raise Refusal('other-group')
        if not same:
            raise Refusal('write-failed', say('The system did not keep the mode or the extended attributes of the file. Nothing was saved.'))
        try:
            os.fsync(fd)
        except OSError as exc:
            raise _failed(exc) from None
    except BaseException:
        _close(fd)
        raise
    try:
        os.close(fd)
    except OSError as exc:
        raise _failed(exc) from None
    return kept.st_dev, kept.st_ino


def _identity(path):
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    return info.st_dev, info.st_ino


def _too_wide(root, identity):
    """Whether `root` is `/`, a home folder or a folder above one, by path or by identity.

    Both `$HOME` and the account's own folder count: HOME is often redirected (an isolated
    instance), and the account's folder holds the agent settings of every project.
    """
    paths = {Path('/')}
    for find in (Path.home, account_home):
        try:
            found = find()
        except (RuntimeError, KeyError, OSError):
            continue
        if not found:
            continue
        forms = {Path(os.path.abspath(found))}
        try:
            forms.add(Path(found).resolve())
        except (OSError, RuntimeError):
            pass
        for form in forms:
            paths.add(form)
            paths.update(form.parents)
    if Path(root) in paths:
        return True
    return identity is not None and identity in {_identity(path) for path in paths}


def _checked_root(model, root, state_dirs):
    """`check_root`, returning the identity of the root as pinned from `/`."""
    if not _opened(model, root) or not _available(root):
        raise Refusal('not-in-workspace', say('The project is not open or not available. Rescan the projects.'))
    if _too_wide(root, _identity(root)):
        raise Refusal('edit-not-granted', WIDE)
    identities = _guarded(root, state_dirs)
    fd, identity = _pin(Path(root).parts[1:], identities)
    _close(fd)
    return identity


def check_root(model, root, state_dirs):
    """Whether editing may be granted on `root`: opened, available, not too wide, not protected and not app state.

    Too wide is `/`, the home folder or a folder above it. Every folder of its path, the
    root included, is compared by identity too. A root that only contains a protected
    folder or a state directory passes: its files are refused one by one. Raises
    `Refusal`; returns None.
    """
    _checked_root(model, root, state_dirs)


def grant(model, root, state_dirs):
    """What enabling editing on `root` records, `{dev, ino}`: `check_root`, then the identity of the folder checked.

    A refusal because the root itself is protected also says what taking it off the list would allow.
    """
    try:
        dev, ino = _checked_root(model, root, state_dirs)
    except Refusal as exc:
        if exc.code == 'protected' and str(exc) == MESSAGES['protected']:
            raise Refusal('protected', say('{refusal} {trade}', refusal=of(exc), trade=PROTECTED_TRADE)) from None
        raise
    return {'dev': dev, 'ino': ino}


def _grant_problem(root, record):
    """None while the grant `record` of `root` holds; else why it does not."""
    identity = _identity(root)
    if identity is None:
        return say('The folder of this project no longer exists at this path. Rescan the projects.')
    if identity != (record['dev'], record['ino']):
        return CHANGED  # Another folder at the same path (a new clone, say) never inherits the grant.
    if _too_wide(root, identity):
        return WIDE
    return None


def granting_root(model, editing, path):
    """The opened root whose grant in `editing` ({root: {at, dev, ino}}) applies to `path`; else `edit-not-granted`.

    The most specific opened root that contains `path` decides, and it needs a grant of
    its own: the grant of an outer root never reaches a project opened inside it. The
    containment is lexical; the core checks the rest with this root. A path that cannot be
    a file of an opened root (not absolute and normalized, with `//` at the start, an
    opened root itself, or under no opened root) is `not-in-workspace`, never an offer
    to enable editing.
    """
    if (not isinstance(path, str) or not os.path.isabs(path) or '\x00' in path or path.startswith('//')
            or os.path.normpath(path) != path):
        raise Refusal('not-in-workspace')
    if any(item['path'] == path for item in model['roots']):
        raise Refusal('not-in-workspace')
    containing = [item['path'] for item in model['roots'] if below(path, item['path']) is not None]
    if not containing:
        raise Refusal('not-in-workspace')
    root = max(containing, key=len)
    if root not in editing:
        outer = [item for item in containing if item != root and item in editing]
        message = None
        if outer:
            message = say('This file belongs to the open project {root}, which does not have editing on; editing turned on in '
                          '{outer} does not apply to a project opened inside it.', root=root, outer=max(outer, key=len))
        raise Refusal('edit-not-granted', message)
    problem = _grant_problem(root, editing[root])
    if problem:
        raise Refusal('edit-not-granted', problem)
    return root


def honored(model, editing, state_dirs):
    """The grants of the opened roots whose editing is not refused now: `{root: {at}}`.

    A grant shows only while its root would still be granted (`check_root`: available, not
    too wide, not protected by path or identity, not app state, with a protection list that
    is not broken) and is still the same folder. A root that only contains a protected
    folder still shows; those files are refused one by one.
    """
    shown = {}
    for item in model['roots']:
        record = editing.get(item['path'])
        if record is None:
            continue
        try:
            identity = _checked_root(model, item['path'], state_dirs)
        except Refusal:
            continue
        if identity == (record['dev'], record['ino']):
            shown[item['path']] = {'at': record['at']}
    return shown
