#!/usr/bin/env python3
"""Install built app for the current Linux user, preserving existing app state."""
import argparse
import shutil
import subprocess
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
DEST = Path.home() / '.local/share/agent-architecture-explorer'
APPLICATIONS = Path.home() / '.local/share/applications'
BIN = Path.home() / '.local/bin'


def replace_tree(source, target, **options):
    """Replace ``target`` with a fresh copy of ``source``, so files from older builds do not linger."""
    staging, previous = target.with_name(target.name + '.new'), target.with_name(target.name + '.old')
    for leftover in (staging, previous):
        shutil.rmtree(leftover, ignore_errors=True)
    shutil.copytree(source, staging, **options)
    if target.exists():
        target.rename(previous)
    staging.rename(target)
    shutil.rmtree(previous, ignore_errors=True)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Install the built app for the current Linux user under ~/.local/share/agent-architecture-explorer, '
                    'with the launcher and the aae command in ~/.local/bin and a menu entry. Run npm run build first. '
                    'Existing app state is preserved. Takes no arguments.')
    return parser.parse_args(argv)


def main(argv=None):
    parse_args(argv)
    if not (SOURCE / 'dist/index.html').is_file():
        raise SystemExit('Run npm run build before installing.')
    for directory in (DEST, APPLICATIONS, BIN):
        directory.mkdir(parents=True, exist_ok=True)
    # state/ is never touched: only the build output and the server code are replaced.
    replace_tree(SOURCE / 'dist', DEST / 'dist')
    replace_tree(SOURCE / 'server', DEST / 'server', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy2(SOURCE / 'scripts/launch.py', DEST / 'launch.py')
    shutil.copy2(SOURCE / 'scripts/aae.py', DEST / 'aae.py')
    shutil.copy2(SOURCE / 'public/icon.svg', DEST / 'icon.svg')
    launcher = BIN / 'agent-architecture-explorer'
    launcher.write_text('#!/bin/sh\nexec /usr/bin/python3 ' + "'" + str(DEST / 'launch.py').replace("'", "'\\''") + "' \"$@\"\n")
    launcher.chmod(0o755)
    # A separate headless entry point never launches the desktop or personal state.
    cli = BIN / 'aae'
    quoted_cli = "'" + str(DEST / 'aae.py').replace("'", "'\\''") + "'"
    cli.write_text('#!/bin/sh\nexec /usr/bin/python3 -B ' + quoted_cli + ' "$@"\n')
    cli.chmod(0o755)
    desktop = APPLICATIONS / 'agent-architecture-explorer.desktop'
    desktop.write_text('[Desktop Entry]\nVersion=1.0\nType=Application\nName=Agent Architecture Explorer\nComment=Explore references, memory and files of AI agents\nComment[pt_BR]=Explore referências, memórias e arquivos de agentes de IA\nExec="' + str(launcher) + '"\nIcon=' + str(DEST / 'icon.svg') + '\nTerminal=false\nCategories=Development;\nKeywords=agent;architecture;memory;graph;\nKeywords[pt_BR]=agentes;arquitetura;memória;grafo;\nStartupWMClass=agent-architecture-explorer\nStartupNotify=true\n')
    desktop.chmod(0o644)
    if shutil.which('desktop-file-validate'):
        subprocess.run(['desktop-file-validate', str(desktop)], check=True)
    if shutil.which('update-desktop-database'):
        subprocess.run(['update-desktop-database', str(APPLICATIONS)], check=True)
    print(f'Installed: {DEST}\nMenu: {desktop}\nCommand: {launcher}\nCLI: {cli}')


if __name__ == '__main__':
    main()
