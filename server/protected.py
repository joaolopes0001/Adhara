"""Protected paths: AAE_PROTECTED_PATHS and protected-paths.txt; standard library only.

Three sources add up:

* the variable AAE_PROTECTED_PATHS (absolute paths separated by ``os.pathsep``);
* ``protected-paths.txt`` in the default state directory (``default_state_dir()``);
* ``protected-paths.txt`` in the state directory set by ``configure_state_dir`` (the
  server calls it with ``--state-dir``), when it is another directory.

So the development server, the tests and the CLI respect the personal file, and a menu
shortcut (which inherits no shell variables) protects too.

The file has one path per line (UTF-8). Empty lines and lines that *start* with ``#``
are ignored; there is no comment at the end of a path line. Spaces at the ends are
removed and ``~`` is expanded.

Fail closed: what the user wrote and protects nothing is an error, never dropped. Each
entry, from any source, must be absolute and exist as written (a broken link counts); a
name that exists is valid with any character. An entry that does not exist (a typo, a
comment at the end of the line, two paths, a glob, quotes, an invisible character, an
unmounted disk, a deleted folder) is an error, and the message points at the suspect
character as the likely cause.
A file that exists and is not a readable regular file (permission, directory, FIFO,
device, broken link, bytes that are not UTF-8, more than 1 MiB) is an error too. On any
error ``ValueError`` names the source and the line, and the operation that asked is
refused until it is fixed. An absent file contributes nothing.

Each entry and each path asked about are compared in the absolute lexical form and in
the resolved one (symlinks followed), so an alias through a symlink is refused too.
Known limits: aliases through a bind mount and file systems that do not tell upper from
lower case are not detected. The configuration is read again on each operation:
``protected_paths()`` reads once and ``contains()`` compares without reading, for loops.
"""
from __future__ import annotations

import os
import re
import stat
import unicodedata
from pathlib import Path
from typing import NamedTuple

try:
    from . import compat  # noqa: F401 - Path.resolve as on 3.13+; every entry point (server, CLI) loads this module.
    from .scanner import InvalidInput
    from .texts import say
except ImportError:
    import compat  # noqa: F401
    from scanner import InvalidInput
    from texts import say

ENVIRONMENT = 'AAE_PROTECTED_PATHS'
STATE_FILE = 'protected-paths.txt'
MAX_FILE_BYTES = 1024 * 1024
MESSAGE = say('This path is protected by {environment} or by {file}.', environment=ENVIRONMENT, file=STATE_FILE)
FORBIDDEN = set('"\'`“”‘’\\*?[')
INLINE_COMMENT = re.compile(r'\s#')

_state_dir: Path | None = None


class Source(NamedTuple):
    name: str
    entries: list[Path]
    present: bool


def default_state_dir() -> Path:
    """Default state directory of the installed app (the only place that defines it)."""
    return Path.home() / '.local/share/agent-architecture-explorer/state'


def configure_state_dir(path) -> None:
    """Set the state directory of the process (resolved, independent of the cwd); ``None`` clears it."""
    global _state_dir
    _state_dir = None if path is None else Path(path).expanduser().resolve()


def _suspect(written: str, separator: bool) -> str:
    """Only explains the message: what in an entry that does not exist is probably the cause."""
    for c in written:
        if unicodedata.category(c).startswith('C'):
            return say('a control or invisible character (U+{code})', code=f'{ord(c):04X}')
        if c in FORBIDDEN:
            return say('the character {character} (quotes, glob or backslash)', character=repr(c))
        if separator and c == os.pathsep:
            return say('the character {character} (two paths on the same line?)', character=repr(c))
    return say('a # after a space (a comment only on a line of its own)') if INLINE_COMMENT.search(written) else ''


def _entry(raw: str, origin: str, separator: bool) -> Path:
    written = raw.strip()
    try:
        entry = Path(written).expanduser()
    except RuntimeError as exc:
        raise InvalidInput(say('{origin} has a ~ that could not be expanded.', origin=origin)) from exc
    if not entry.is_absolute():
        hint = _suspect(written, separator)
        raise InvalidInput(say('{origin} takes only absolute paths; fix the relative entry (likely cause: {hint}).', origin=origin, hint=hint) if hint else
                           say('{origin} takes only absolute paths; fix the relative entry.', origin=origin))
    if not os.path.lexists(entry):  # A path that exists as written is valid, whatever the character.
        hint = _suspect(written, separator)
        raise InvalidInput(say('{origin}: the path {entry} does not exist; likely cause: {hint}. Fix the line or comment it out with # at the start.',
                                origin=origin, entry=entry, hint=hint) if hint else
                           say('{origin}: the path {entry} does not exist. Fix the line or comment it out with # at the start.', origin=origin, entry=entry))
    return entry


def _read(path: Path) -> str | None:
    """Text of the file, ``None`` if absent; anything else that is not a readable regular file is an error."""
    origin = say('{file} ({path})', file=STATE_FILE, path=path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0))
    except FileNotFoundError:
        if os.path.lexists(path):  # A broken link: the user put something there.
            raise InvalidInput(say('Could not read {origin}: the link is broken.', origin=origin)) from None
        return None
    except OSError as exc:
        raise InvalidInput(say('Could not read {origin}: {cause}.', origin=origin, cause=exc.strerror or type(exc).__name__)) from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise InvalidInput(say('{origin} must be a regular text file (not a directory, FIFO or device).', origin=origin))
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(MAX_FILE_BYTES + 1)
    except OSError as exc:
        raise InvalidInput(say('Could not read {origin}: {cause}.', origin=origin, cause=exc.strerror or type(exc).__name__)) from exc
    finally:
        os.close(fd)
    if len(raw) > MAX_FILE_BYTES:
        raise InvalidInput(say('{origin} is too large to be read (limit of 1 MiB).', origin=origin))
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise InvalidInput(say('{origin} is not valid UTF-8 text.', origin=origin)) from exc


def _state_files() -> list[Path]:
    try:
        directories = [default_state_dir().resolve()]
    except RuntimeError as exc:
        raise InvalidInput(say('Could not determine the default state directory.')) from exc
    if _state_dir is not None and _state_dir not in directories:
        directories.append(_state_dir)
    return [directory / STATE_FILE for directory in directories]


def sources(environ=None) -> list[Source]:
    """The variable and each state file, with the entries validated (``ValueError`` if something is broken)."""
    value = (os.environ if environ is None else environ).get(ENVIRONMENT, '')
    raws = [raw for raw in value.split(os.pathsep) if raw.strip()]
    result = [Source(ENVIRONMENT, [_entry(raw, say('{source} (entry {number})', source=ENVIRONMENT, number=number), False) for number, raw in enumerate(raws, 1)],
                     bool(raws))]
    for path in _state_files():
        content = _read(path)
        entries = []
        for number, line in enumerate((content or '').splitlines(), 1):
            if line.strip() and not line.strip().startswith('#'):
                entries.append(_entry(line, say('{file} ({path}, line {number})', file=STATE_FILE, path=path, number=number), True))
        result.append(Source(str(path), entries, content is not None))
    return result


def _forms(path: Path) -> set[Path]:
    forms = {Path(os.path.normpath(path))}
    try:
        forms.add(path.resolve())
    except (OSError, RuntimeError):
        pass  # A symlink loop or a read failure: the lexical form still counts.
    return forms


def protected_paths(environ=None) -> frozenset[Path]:
    """Every protected path, in the lexical and the resolved form; reads the configuration once."""
    return frozenset(form for source in sources(environ) for entry in source.entries for form in _forms(entry))


def contains(protected, path) -> bool:
    """Whether ``path`` is one of ``protected`` or lies inside one (without reading the configuration again)."""
    if not protected:
        return False
    candidate = Path(os.path.abspath(Path(path)))
    return any(form in protected or not protected.isdisjoint(form.parents) for form in _forms(candidate))


def is_protected(path, environ=None) -> bool:
    """Whether ``path`` is a protected path or lies inside one."""
    return contains(protected_paths(environ), path)


def describe(environ=None) -> list[str]:
    """Log lines with the sources read and the number of entries of each."""
    return [f'{source.name}: ' + (f'{len(source.entries)} {"entry" if len(source.entries) == 1 else "entries"}' if source.present else 'absent')
            for source in sources(environ)]
