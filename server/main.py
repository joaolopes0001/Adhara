#!/usr/bin/env python3
"""Loopback-only local application server. Python standard library only."""
import argparse
import errno
import json
import mimetypes
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).parent))
import compat  # noqa: F401 - first: Path.resolve as on Python 3.13+ (a symlink loop is OSError ELOOP)
from scanner import MAX_ROOTS, ReaderError, find_path
from workspace import StateWriteError, Workspace, blueprint, create_directory
from editing import EDITABLE, MAX_BYTES as EDIT_MAX_BYTES, Refusal
from protected import configure_state_dir, default_state_dir, describe
from peer import peer_uid
from texts import of, say, spelled

BODY_LIMIT = 256000
# Only a save carries a document. 256 KiB of text escaped as JSON (`\u0001` is six bytes for one) still fits; the core
# measures the text again after decoding.
SAVE_ROUTE = '/api/edit/save'
SAVE_BODY_LIMIT = 2 * 1024 * 1024

# System errors reach the interface in the server's own words, without the raw text or the path it names.
SYSTEM_ERRORS = {
    errno.ENOENT: say('The path given does not exist.'),
    errno.EEXIST: say('A file or folder with that name already exists. Choose another name.'),
    errno.EACCES: say('No permission to access the path given.'),
    errno.EPERM: say('No permission to access the path given.'),
    errno.ENOTDIR: say('The path given is not a folder (or goes through a file).'),
    errno.ENOSPC: say('There is no free space on the disk.'),
    errno.EROFS: say('The file system is read-only.'),
    errno.ENAMETOOLONG: say('A name of the path, or the whole path, is too long.'),
    errno.ELOOP: say('The path goes through a loop of symbolic links (or through a link that cannot be followed).'),
}
GENERIC_ERROR = say('The operation could not be completed. The technical detail was recorded in the server log.')
# Connections from a process of another system user are refused, and so are those whose user cannot be determined.
OTHER_USER = say('Connection refused: the program that connected belongs to another system user.')
UNKNOWN_USER = say('Connection refused: it could not be confirmed that the program that connected belongs to the same system user.')
NO_TEXT = frozenset({'nodes', 'edges', 'objects'})
# A refused connection is the one input that comes from another system user: what it sends is read and thrown
# away, for a few seconds at most, and the log takes a few refusal lines a minute, never a line with what it sent.
REFUSED_TIMEOUT = 5
REFUSED_BYTES = 65536
ROUTE_IN_LOG = 200
REFUSAL_LINES = 5
REFUSAL_WINDOW = 60


def peer_refusal(connection, client):
    """(message for the client, line for the log) if the connection must be refused, else None.

    The process at the other end must run as the same system user as the server (`peer.peer_uid`). Asked once per
    connection, before any byte of the request is read; the log line has the reason and the peer's UID, nothing
    the client sent.
    """
    try:
        uid = peer_uid(client, connection.getsockname())
        # Still connected after the table was read: this socket held its pair of addresses the whole time, so
        # the line read is its own peer. Without this, a connection reset by its client (the request stays
        # readable) would be given to whoever connected next from the same port.
        connection.getpeername()
    except (OSError, ValueError):
        uid = None
    if uid == os.geteuid():
        return None
    if uid is None:
        return UNKNOWN_USER, 'Connection refused: the system user of the program that connected is unknown.'
    return OTHER_USER, f'Connection refused: the program that connected runs as uid {uid}, not as uid {os.geteuid()} of the server.'


class RefusalLines:
    """Which lines the log takes for refused connections: `REFUSAL_LINES` each `REFUSAL_WINDOW` seconds, and
    the number left out, written with the first refusal after the window.

    A program of another user connects as often as it wants; it must not grow the owner's log as it wants.
    """

    def __init__(self, clock=time.monotonic):
        self.clock, self.lock, self.start, self.seen = clock, threading.Lock(), None, 0

    def take(self, line):
        """The lines to write for one more refusal described by `line`: none, it, or the count and it."""
        with self.lock:
            now, lines = self.clock(), []
            if self.start is None or now - self.start >= REFUSAL_WINDOW:
                if self.seen > REFUSAL_LINES:
                    lines.append(f'Connections refused and not logged since the last such line: {self.seen - REFUSAL_LINES}.')
                self.start, self.seen = now, 0
            self.seen += 1
            if self.seen <= REFUSAL_LINES:
                lines.append(line)
            return lines


def log_detail(exc):
    """What the server log may say about an exception: its class and, for a system error, the errno with the
    system's own text for it; for any other, the file:line of the server's code that raised it. Never the
    exception's message, which can carry paths or values from the request."""
    code = getattr(exc, 'errno', None)
    if not isinstance(code, int):
        return f'{type(exc).__name__} in {ReaderError(exc).where}'
    return f'{type(exc).__name__} [Errno {code}] {os.strerror(code)}'


def public_error(exc, body=None):
    """(message for the interface, technical detail for the server log or None).

    Input errors are raised as ValueError with their text (`texts.say`) and pass through. A
    failed write of the app state says so and names the state directory (the app's own, never
    an inspected path). A KeyError for a field absent from the request body names the field.
    Anything else gets a message of this module; the detail logged is `log_detail`.
    """
    if isinstance(exc, StateWriteError):
        return exc.message, log_detail(exc.__cause__ or exc)
    if isinstance(exc, OSError):
        return SYSTEM_ERRORS.get(exc.errno, GENERIC_ERROR), log_detail(exc)
    if isinstance(exc, KeyError) and isinstance(body, dict) and exc.args and exc.args[0] not in body:
        return say('Required field missing: {field}.', field=exc.args[0]), None
    if isinstance(exc, ValueError) and not isinstance(exc, UnicodeError):
        return of(exc), None
    if isinstance(exc, (TypeError, UnicodeError)):
        return say('Invalid request: a field has an unexpected type or format.'), log_detail(exc)
    return GENERIC_ERROR, log_detail(exc)


def make_handler(workspace, static_dir, token):
    refusals = RefusalLines()

    class Handler(BaseHTTPRequestHandler):
        def handle(self):
            """Nothing that escapes a request reaches the log as a traceback.

            The default `handle_error` prints the whole chain, whose messages can carry what the client sent (a
            path, an item of a list). Here it is one line: method, route and `log_detail`.
            """
            try:
                self.refusal = peer_refusal(self.connection, self.client_address)
                if self.refusal:
                    for line in refusals.take(self.refusal[1]):
                        super().log_message('%s', line)
                    self.refuse()
                    return
                super().handle()
            except Exception as exc:
                self.close_connection = True
                self.record('Connection failed: "%s %s" %s', getattr(self, 'command', None) or '-',
                            self.route(), log_detail(exc))

        def refuse(self):
            """Answer 403 to a refused connection without parsing what it sent.

            Its bytes are read until the end of the headers, `REFUSED_BYTES` or `REFUSED_TIMEOUT` seconds for
            the whole connection, whichever comes first, and thrown away: a client that sends slowly, or
            nothing, does not keep the connection. Before Host, token and body: another system user gets
            nothing, not even the token.
            """
            self.close_connection = True
            self.command, self.path, self.request_version, self.requestline = None, '', 'HTTP/1.0', ''
            deadline, tail, total = time.monotonic() + REFUSED_TIMEOUT, b'', 0
            try:
                while total < REFUSED_BYTES and b'\r\n\r\n' not in tail and b'\n\n' not in tail:
                    self.connection.settimeout(max(deadline - time.monotonic(), 0.001))
                    chunk = self.connection.recv(8192)
                    if not chunk:
                        break
                    total += len(chunk)
                    tail = tail[-3:] + chunk
                self.connection.settimeout(1)
                self.send_data({'error': self.refusal[0]}, 403)
            except OSError:
                pass

        def record(self, fmt, *args):
            """A log line about a request. Nothing for a refused connection: its method and route were written
            by a program of another user, and its refusal already has a line (`RefusalLines`)."""
            if not getattr(self, 'refusal', None):
                super().log_message(fmt, *args)

        def route(self):
            """The request path without query or fragment: never a value the client sent in them. For the log:
            cut at `ROUTE_IN_LOG` characters, and absent for a request refused by its origin, whose path was
            written by another site."""
            if getattr(self, 'foreign', False):
                return '-'
            route = (getattr(self, 'path', '') or '').split('?', 1)[0].split('#', 1)[0]
            return route if len(route) <= ROUTE_IN_LOG else route[:ROUTE_IN_LOG] + '…'

        def log_message(self, fmt, *args):
            # Request targets can contain local paths and arbitrary query values.
            # Keep route/status diagnostics without queries, headers or bodies.
            if fmt == '"%s" %s %s' and len(args) == 3:
                self.record('"%s %s" %s %s', self.command, self.route(), args[1], args[2])
            else:
                # Base-handler parse errors can interpolate an untrusted request.
                self.record('Invalid HTTP request.')

        def explain(self, exc, body=None):
            """Message for the interface; the technical detail goes only to the server log."""
            message, detail = public_error(exc, body)
            if detail:
                self.record('Failure in "%s %s": %s', self.command, self.route(), detail)
            return message

        def internal_error(self, exc):
            """500 for a defect: the type and where it was raised go to stderr, never a document's content."""
            failure = exc if isinstance(exc, ReaderError) else ReaderError(exc)
            print(f'aae: internal-error: {failure.kind} in {failure.where} ({self.route()})', file=sys.stderr, flush=True)
            self.send_data({'error': say('Internal failure of the reader ({kind}); the scan was not completed. '
                                         'The folder was not changed; reopen the app and, if it persists, report the error.', kind=failure.kind)}, 500)

        def send_data(self, data, status=200, content_type='application/json; charset=utf-8'):
            """Answer the request. To a client that went away, nothing, and to the log, one line.

            Without this, the failed write would be answered again as an error and end in a traceback
            carrying the exception being answered, whose message can hold what the client sent.
            """
            try:
                self.write_response(data, status, content_type)
            except ConnectionError:
                self.close_connection = True
                self.record('Client disconnected before the answer: "%s %s" %s', self.command, self.route(), status)

        def write_response(self, data, status, content_type):
            if not isinstance(data, bytes):
                data = spelled(data, NO_TEXT)
                text = json.dumps(data, ensure_ascii=False)
                try:
                    data = text.encode()
                except UnicodeEncodeError:
                    data = json.dumps(data).encode()  # a name that is not UTF-8 travels escaped
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)

        def guard(self, auth=True):
            host = self.headers.get('Host', '')
            valid = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
            # Vite development proxy forwards its own Host; explicit opt-in only.
            if os.environ.get('AAE_DEV') == '1':
                valid.update({'127.0.0.1:5173', 'localhost:5173'})
            origin = self.headers.get('Origin')
            if host not in valid or (origin and origin not in {f'http://{h}' for h in valid}) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                self.foreign = True
                self.send_data({'error': say('Unauthorized origin.')}, 403)
                return False
            if auth and not secrets.compare_digest(self.headers.get('X-AAE-Token', '').encode('utf-8'), token.encode('utf-8')):
                # `code` lets the client ask /api/session again and repeat the request once.
                self.send_data({'error': say('Invalid session. Reopen the app.'), 'code': 'session'}, 403)
                return False
            return True

        def target(self):
            """The request target, split; None, answered 400, for one that cannot be split."""
            try:
                return urlsplit(self.path)
            except ValueError:
                self.send_data({'error': say('Invalid path.')}, 400)
                return None

        def do_GET(self):
            route = self.target()
            if route is None or not self.guard(auth=route.path.startswith('/api/') and route.path != '/api/session'):
                return
            try:
                if route.path == '/api/session':
                    self.send_data({'token': token, 'home': str(Path.home()), 'defaultParent': str(Path.home()), 'version': '1.0.0', 'product': 'agent-architecture-explorer',
                                    'edit': {'extensions': sorted(EDITABLE), 'maxBytes': EDIT_MAX_BYTES}})
                elif route.path == '/api/workspace':
                    with workspace.lock:
                        self.send_data(workspace.snapshot())
                elif route.path == '/api/content':
                    with workspace.lock:
                        self.send_data(workspace.content(parse_qs(route.query).get('path', [''])[0]))
                elif route.path == '/api/directories':
                    path = Path(workspace._path(parse_qs(route.query).get('path', [str(Path.home())])[0], strict=True))
                    if not path.is_dir():
                        raise ValueError(say('Give a folder.'))
                    entries = sorted([{'name': p.name, 'path': str(p)} for p in path.iterdir() if p.is_dir() and not p.is_symlink()], key=lambda x: x['name'].lower())
                    self.send_data({'path': str(path), 'parent': str(path.parent), 'directories': entries})
                elif route.path.startswith('/api/'):
                    self.send_data({'error': say('Route not found.')}, 404)
                else:
                    target = (static_dir / route.path.lstrip('/')).resolve()
                    if not target.is_relative_to(static_dir.resolve()):
                        self.send_data({'error': say('Invalid path.')}, 403)
                        return
                    if not target.is_file():
                        target = static_dir / 'index.html'
                    self.send_data(target.read_bytes(), content_type=mimetypes.guess_type(str(target))[0] or 'application/octet-stream')
            except ReaderError as exc:
                self.internal_error(exc)
            except (OSError, ValueError, KeyError) as exc:
                self.send_data({'error': self.explain(exc)}, 400)
            except Exception as exc:  # a defect answers 500, never a dropped connection
                self.internal_error(exc)

        def do_POST(self):
            target = self.target()
            if target is None or not self.guard():
                return
            body = None
            route = target.path  # Before the size: the limit depends on the route.
            try:
                try:
                    length = int(self.headers.get('Content-Length', 0))
                except ValueError as exc:
                    raise ValueError(say('Invalid Content-Length header.')) from exc
                limit = SAVE_BODY_LIMIT if route == SAVE_ROUTE else BODY_LIMIT
                if route == SAVE_ROUTE and length > limit:
                    raise Refusal('too-large')  # The body is not read.
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or not 0 < length <= limit:
                    raise ValueError(say('Invalid or too large JSON request.'))
                try:
                    text = self.rfile.read(length).decode('utf-8')
                except UnicodeDecodeError as exc:
                    raise ValueError(say('The request body is not UTF-8.')) from exc
                try:
                    body = json.loads(text)
                except RecursionError as exc:
                    raise ValueError(say('The JSON request exceeded the depth limit.')) from exc
                except ValueError as exc:
                    raise ValueError(say('The request body is not valid JSON.')) from exc
                if not isinstance(body, dict):
                    raise ValueError(say('JSON object expected.'))
                if route == SAVE_ROUTE:
                    # Outside the workspace lock: the save takes it for each attempt and releases it while another
                    # program holds the folder lock (Workspace.edit_save). A missing or mistyped field reaches the
                    # core, which refuses it with a code.
                    self.send_data(workspace.edit_save(body.get('path'), body.get('baseSha256'), body.get('text')))
                    return
                with workspace.lock:
                    if route == '/api/open':
                        result = workspace.open(body['path'], replace=body.get('replace', False))
                    elif route == '/api/close':
                        result = workspace.close(body['path'])
                    elif route == '/api/forget':
                        result = workspace.forget(body['path'], notes=body.get('notes', False), close=body.get('close', False))
                    elif route == '/api/refresh':
                        result = workspace.refresh()
                    elif route == '/api/reorder':
                        result = workspace.reorder(body.get('order'))
                    elif route == '/api/reference':
                        result = workspace.adopt_reference()
                    elif route == '/api/note':
                        result = workspace.note(body['node'], body['body'])
                    elif route == '/api/expected':
                        result = workspace.expect(body.get('root'), body.get('key'), body.get('expected', True), body.get('reason', ''))
                    # Editing: a missing or mistyped field reaches the core, which refuses it with a code.
                    elif route == '/api/edit/enable':
                        result = workspace.enable_editing(body.get('root'))
                    elif route == '/api/edit/disable':
                        result = workspace.disable_editing(body.get('root'))
                    elif route == '/api/edit/read':
                        result = workspace.edit_read(body.get('path'))
                    elif route == '/api/trace':
                        conventions = body.get('conventions', False)
                        if not isinstance(conventions, bool):
                            raise ValueError(say('The option to include conventions must be a boolean.'))
                        result = find_path(workspace.model, body['start'], body['end'], body.get('direction', 'directed'), conventions)
                    elif route == '/api/blueprint':
                        result = {'files': blueprint(body)}
                    elif route == '/api/create':
                        if len(workspace.model['roots']) >= MAX_ROOTS:
                            raise ValueError(say('Close a folder before creating another (limit of {max}).', max=MAX_ROOTS))
                        path = create_directory(body)
                        try:
                            result = workspace.open(path)
                        except (OSError, ValueError, KeyError, TypeError) as exc:
                            raise ValueError(say('Folder created at {path}, but the project could not be opened or saved. '
                                                 'The files were kept. Use “Add folder” to open that path '
                                                 'after solving the error: {error}', path=path, error=self.explain(exc))) from exc
                    else:
                        self.send_data({'error': say('Route not found.')}, 404)
                        return
                    self.send_data(result)
            except Refusal as exc:
                # Before the generic ValueError branch, and with the core's message as it is: in particular,
                # `unconfirmed` (outcome unknown) must never be turned into "nothing was saved".
                self.send_data({'error': of(exc), 'code': exc.code}, exc.status)
            except ReaderError as exc:
                self.internal_error(exc)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                self.send_data({'error': self.explain(exc, body)}, 400)
            except Exception as exc:  # a defect answers 500, never a dropped connection
                self.internal_error(exc)
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=47831)
    parser.add_argument('--state-dir', default=str(default_state_dir()))
    parser.add_argument('--static-dir', default=str(Path(__file__).resolve().parents[1] / 'dist'))
    args = parser.parse_args()
    configure_state_dir(args.state_dir)
    try:
        workspace = Workspace(args.state_dir)
    except ValueError as exc:
        raise SystemExit(f'Agent Architecture Explorer did not start: {exc}') from None
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(workspace, Path(args.static_dir), secrets.token_urlsafe(32)))
    print(f'Agent Architecture Explorer: http://127.0.0.1:{server.server_port}', flush=True)
    try:
        print('Protected paths: ' + '; '.join(describe()), flush=True)
    except ValueError:
        pass  # Broken after the start: each protected operation already refuses it.
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
