#!/usr/bin/env python3
"""Headless launcher usable from the checkout and installed copy."""
import sys
from pathlib import Path

folder = Path(__file__).resolve().parent
sys.path.insert(0, str(folder if (folder / 'server').is_dir() else folder.parent))
sys.dont_write_bytecode = True

from server.cli import main

if __name__ == '__main__':
    raise SystemExit(main())
