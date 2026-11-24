"""Behaviour the server and the CLI need to be the same on every supported Python (3.10+).

`Path.resolve` changed in Python 3.13: before it, a symlink loop raised `RuntimeError`
(also in non-strict mode, through an extra `stat`); from 3.13 on it is
`os.path.realpath(path, strict=strict)`, so a loop raises `OSError` (ELOOP) in strict mode and
is resolved "as far as possible" otherwise. Every caller (route, CLI, protected paths, editing)
handles `OSError`; a `RuntimeError` there would be a 500 or a different message.

`patch()` gives `Path.resolve` the 3.13 definition. It is applied on import below Python 3.13,
where it is the only difference; any other `RuntimeError` is left as it was. Remove this module
once the minimum version is 3.13.
"""
from __future__ import annotations

import os
import pathlib
import sys


def _resolve(self, strict=False):
    """`Path.resolve` as Python 3.13 defines it on POSIX."""
    return type(self)(os.path.realpath(self, strict=strict))


def patch(cls=pathlib.Path) -> None:
    """Make `cls.resolve` (and its subclasses') behave as on Python 3.13+."""
    cls.resolve = _resolve


if sys.version_info < (3, 13):
    patch()
