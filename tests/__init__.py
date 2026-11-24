"""Isolate the suite from the user's real state and configuration.

``HOME`` points to an empty temporary directory for the whole process (and its
subprocesses), so the default state directory and its ``protected-paths.txt``
are never read, and ``AAE_PROTECTED_PATHS`` is removed from the environment. This holds when
the suite runs through ``discover -s tests -t .`` (``npm test``); always run it through ``npm test``.
"""
import atexit
import os
import shutil
import tempfile

_home = tempfile.mkdtemp(prefix='aae-tests-home-')
atexit.register(shutil.rmtree, _home, ignore_errors=True)
os.environ['HOME'] = _home
os.environ.pop('AAE_PROTECTED_PATHS', None)
