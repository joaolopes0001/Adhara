#!/usr/bin/env python3
"""Launch the installed app, reusing its loopback server between windows."""
import fcntl
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

APP_DIR = Path(__file__).resolve().parent
STATE = APP_DIR / 'state'
# The server's code: next to this file once installed, one level up in the repository.
sys.path.insert(0, str(APP_DIR / 'server' if (APP_DIR / 'server').is_dir() else APP_DIR.parent / 'server'))
from peer import LISTEN, TABLES, peer_uid, read_table  # noqa: E402


class Refusing(RuntimeError):
    """The app's server answers on the port and refuses this user's own connection, with its reason."""


def own_listener(port):
    """True if the socket listening on 127.0.0.1:`port` belongs to this user; False if it does not, or if
    nothing listens on that address (a listener on every address is never the app's); None if the kernel's
    socket table cannot be read (the same table the server reads; see server/peer.py)."""
    try:
        read_table(TABLES[0][0])
        return peer_uid(('127.0.0.1', port), ('0.0.0.0', 0), states=LISTEN) == os.geteuid()
    except (OSError, ValueError):
        return None


def server_alive(port):
    """True if this user's server answers on `port`. A port held by another user's program is not the server,
    whatever it answers. A server that refuses the connection (it could not confirm who connected) raises
    `Refusing`, so that no second server is started next to it."""
    owned = own_listener(port)
    if owned is False:
        return False  # Not asked anything: it could hold the answer back as long as it wanted.
    try:
        with urlopen(f'http://127.0.0.1:{port}/api/session', timeout=1) as response:
            return json.load(response).get('product') == 'agent-architecture-explorer' and owned is True
    except HTTPError as exc:
        try:
            reason = json.load(exc).get('error')
        except Exception:
            return False
        finally:
            exc.close()
        if exc.code == 403 and isinstance(reason, str) and reason.startswith('Connection refused'):
            raise Refusing(f'The server is running and refuses the connection. {reason} See {STATE / "server.log"}.') from None
        return False
    except Exception:
        return False


def last_log_line(path, start=0):
    """Last non-empty log line from ``start`` on (the current run): the server's exit message."""
    try:
        with path.open('rb') as log:
            log.seek(0, 2)
            log.seek(max(start, log.tell() - 4096))
            lines = log.read().decode('utf-8', 'replace').splitlines()
    except OSError:
        return ''
    return next((line.strip() for line in reversed(lines) if line.strip()), '')


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'launch.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        runtime = STATE / 'server.json'
        try:
            port = json.loads(runtime.read_text())['port']
        except (OSError, ValueError, KeyError):
            port = 47831
        if not server_alive(port):
            with socket.socket() as sock:
                try:
                    sock.bind(('127.0.0.1', port))
                except OSError:
                    sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            with (STATE / 'server.log').open('a') as log:
                started = log.tell()
                process = subprocess.Popen([sys.executable, str(APP_DIR / 'server/main.py'), '--port', str(port), '--state-dir', str(STATE), '--static-dir', str(APP_DIR / 'dist')], stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
            # Large restored workspaces may need a few seconds to scan.
            for _ in range(240):
                try:
                    if server_alive(port):
                        break
                except Refusing:
                    process.terminate()  # It would refuse every window: do not leave it running.
                    raise
                if process.poll() is not None:
                    reason = last_log_line(STATE / 'server.log', started)
                    raise RuntimeError(f'Failed to start. {reason + " " if reason else ""}See {STATE / "server.log"}.')
                time.sleep(.25)
            else:
                raise RuntimeError(f'The server is still starting. See {STATE / "server.log"} and try opening again.')
            runtime.write_text(json.dumps({'port': port, 'pid': process.pid}))
        url = f'http://127.0.0.1:{port}'
    if '--print-url' in sys.argv:
        print(url)
        return
    browser = next((shutil.which(name) for name in ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'] if shutil.which(name)), None)
    if browser:
        subprocess.Popen([browser, f'--app={url}', f'--user-data-dir={STATE / "browser"}', '--class=agent-architecture-explorer', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1500,960'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    else:
        subprocess.Popen(['xdg-open', url], start_new_session=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        if shutil.which('notify-send'):
            subprocess.run(['notify-send', 'Agent Architecture Explorer', str(exc)], check=False)
        sys.exit(1)
