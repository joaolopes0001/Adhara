"""The server log never carries what the client sent in a request body (SPECS, "Segurança local").

Every POST route that reads a body gets a unique marker in valid and invalid fields, once answered
normally and once with the client resetting the connection before the answer is written. The log
(stderr of the server thread) must have one line per request and never the marker nor a traceback.
Everything lives in temporaries, with HOME pointing inside the fixture.
"""
import hashlib
import http.client
import io
import json
import os
import re
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from main import make_handler
from protected import ENVIRONMENT, configure_state_dir
from workspace import Workspace

TOKEN = 'log-scan-token'
GONE = 'Client disconnected before the answer'


class ServerLogTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-server-log-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        home = self.base / 'home'
        home.mkdir()
        environment = {key: value for key, value in os.environ.items() if key != ENVIRONMENT}
        variables = patch.dict(os.environ, {**environment, 'HOME': str(home)}, clear=True)
        variables.start()
        self.addCleanup(variables.stop)
        self.state = self.base / 'state'
        configure_state_dir(self.state)
        self.addCleanup(configure_state_dir, None)
        self.log = io.StringIO()
        stderr = patch('sys.stderr', new=self.log)
        stderr.start()
        self.addCleanup(stderr.stop)
        self.root = self.base / 'project'
        self.root.mkdir()
        self.entry = self.root / 'AGENTS.md'
        self.entry.write_text('# Agent\n[Guide](guide.md)\n', encoding='utf-8')
        self.guide = self.root / 'guide.md'
        self.guide.write_text('# Guide\n', encoding='utf-8')
        self.ws = Workspace(self.state)
        self.ws.open(str(self.root))
        static = self.base / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<title>Synthetic</title>', encoding='utf-8')
        self.handler = make_handler(self.ws, static, TOKEN)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.marker = 'mk' + uuid.uuid4().hex

    def raw_request(self, route, raw):
        return (f'POST {route} HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\nX-AAE-Token: {TOKEN}\r\n'
                f'Content-Type: application/json\r\nContent-Length: {len(raw)}\r\nConnection: close\r\n\r\n').encode() + raw

    def answered(self, route, raw):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        try:
            connection.request('POST', route, raw, {'X-AAE-Token': TOKEN, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def abandoned(self, route, raw):
        """The client resets the connection after the server has the answer and before it is written."""
        entered, go = threading.Event(), threading.Event()
        respond = self.handler.send_response

        def held(handler, *args):
            entered.set()
            go.wait(10)
            return respond(handler, *args)
        before = self.log.getvalue().count(GONE)
        with patch.object(self.handler, 'send_response', held):
            sock = socket.create_connection(('127.0.0.1', self.server.server_port), timeout=10)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
            sock.sendall(self.raw_request(route, raw))
            self.assertTrue(entered.wait(10), route)
            sock.close()
            time.sleep(0.05)
            go.set()
            deadline = time.monotonic() + 10
            while self.log.getvalue().count(GONE) == before and time.monotonic() < deadline:
                time.sleep(0.02)
        self.assertEqual(self.log.getvalue().count(GONE), before + 1, route)

    def cases(self):
        """(route, body) with the marker in fields the route accepts and in fields it refuses."""
        m, root, entry = self.marker, str(self.root), str(self.entry)
        primitives = [{'name': 'main', 'type': 'agent'}]
        sha = lambda: hashlib.sha256(self.guide.read_bytes()).hexdigest()  # noqa: E731
        return [
            ('/api/open', {'path': f'/{m}/absent'}),
            ('/api/open', {'path': str(self.root / m)}),
            ('/api/open', {'path': m}),
            ('/api/open', {'path': [m]}),
            ('/api/open', {'path': root, 'replace': m}),
            ('/api/close', {'path': f'/{m}'}),
            ('/api/close', {'path': {m: 1}}),
            ('/api/forget', {'path': f'/{m}', 'notes': m, 'close': m}),
            ('/api/refresh', {m: m}),
            ('/api/reorder', {'order': [m]}),
            ('/api/reorder', {'order': [f'/{m}/' + 'x' * 300]}),
            ('/api/reorder', {'order': [root, f'/{m}']}),
            ('/api/reorder', {'order': m}),
            ('/api/reorder', {'order': [root], m: m}),
            ('/api/reference', {m: m}),
            ('/api/note', {'node': f'/{m}', 'body': m}),
            ('/api/note', {'node': entry, 'body': m}),  # accepted: the note itself
            ('/api/note', {'node': entry, 'body': [m]}),
            ('/api/note', {'node': [m], 'body': m}),
            ('/api/expected', {'root': f'/{m}', 'key': m, 'reason': m}),
            ('/api/expected', {'root': root, 'key': m, 'reason': m}),
            ('/api/expected', {'root': root, 'key': [m], 'expected': m}),
            ('/api/edit/enable', {'root': f'/{m}'}),
            ('/api/edit/enable', {'root': root, m: m}),  # accepted
            ('/api/edit/read', {'path': str(self.root / f'{m}.md')}),
            ('/api/edit/read', {'path': str(self.guide), m: m}),  # accepted
            ('/api/edit/save', {'path': str(self.guide), 'baseSha256': m, 'text': m}),
            ('/api/edit/save', {'path': str(self.root / f'{m}.md'), 'baseSha256': '0' * 64, 'text': m}),
            ('/api/edit/save', lambda: {'path': str(self.guide), 'baseSha256': sha(), 'text': f'# {m}\n'}),  # accepted
            ('/api/edit/disable', {'root': f'/{m}'}),
            ('/api/trace', {'start': f'/{m}', 'end': f'/{m}'}),
            ('/api/trace', {'start': entry, 'end': str(self.guide), 'direction': m}),
            ('/api/trace', {'start': [m], 'end': {m: 1}}),
            ('/api/trace', {'start': entry, 'end': str(self.guide), 'conventions': m}),
            ('/api/blueprint', {'name': m, 'primitives': primitives}),  # accepted
            ('/api/blueprint', {'name': f'/{m}', 'primitives': [{'name': m, 'type': m}]}),
            ('/api/blueprint', {'name': 'x', 'primitives': primitives, 'relationships': [{'from': m, 'to': m, 'type': m}]}),
            ('/api/create', {'parent': f'/{m}', 'name': 'fresh', 'primitives': primitives}),
            ('/api/create', {'parent': str(self.base), 'name': m, 'primitives': primitives}),  # accepted, then exists
            ('/api/create', {'parent': [m], 'name': m, 'primitives': primitives}),
            ('/api/edit/disable', {'root': root, m: m}),  # accepted
            ('/api/open', f'{{"path": "{m}"'),  # not JSON
            ('/api/open', [m]),  # not an object
            ('/api/open', m.encode() + b'\xff\xfe'),  # not UTF-8
            ('/api/' + 'unknown', {'path': m}),
        ]

    def test_no_value_from_a_request_body_reaches_the_log(self):
        requests = 0
        for route, body in self.cases():
            for gone in (False, True):
                with self.subTest(route=route, body=body if not callable(body) else 'save', gone=gone):
                    value = body() if callable(body) else body
                    raw = value if isinstance(value, bytes) else (value if isinstance(value, str) else json.dumps(value)).encode()
                    if gone:
                        self.abandoned(route, raw)
                    else:
                        status, answer = self.answered(route, raw)
                        self.assertLess(status, 500, answer)
                    requests += 1
        log = self.log.getvalue()
        self.assertNotIn(self.marker, log)
        self.assertNotIn('Traceback', log)
        self.assertNotIn(str(self.base), log)
        # One line per request, each with method and route; the accepted save really wrote the marker.
        self.assertEqual(len(re.findall(r'\] "POST /api/[a-z/]+" \d{3} -$', log, re.MULTILINE)), requests)
        self.assertIn(self.marker, self.guide.read_text(encoding='utf-8'))

    def test_an_exception_that_escapes_a_request_is_one_line(self):
        """The safety net: whatever escapes the routes is logged as class and errno, never the message nor a traceback."""
        def broken(handler):
            raise RuntimeError(f'escaped with {self.marker}')
        with patch.object(self.handler, 'do_POST', broken):
            with self.assertRaises((http.client.RemoteDisconnected, ConnectionError)):
                self.answered('/api/open', json.dumps({'path': self.marker}).encode())
        deadline = time.monotonic() + 10
        while 'Connection failed' not in self.log.getvalue() and time.monotonic() < deadline:
            time.sleep(0.02)
        log = self.log.getvalue()
        # Where: the innermost frame of the server's own code, never the message.
        self.assertRegex(log, r'Connection failed: "POST /api/open" RuntimeError in main\.py:\d+\n')
        self.assertNotIn(self.marker, log)
        self.assertNotIn('Traceback', log)

    def test_a_defect_answered_as_a_type_error_can_be_traced_from_the_log(self):
        """A TypeError raised by the server's code answers 400 like a mistyped field; the log says where it was raised."""
        def broken():
            raise TypeError(f'can only concatenate with {self.marker}')
        with patch.object(self.ws, 'refresh', broken):
            status, _ = self.answered('/api/refresh', b'{}')
        self.assertEqual(status, 400)
        log = self.log.getvalue()
        self.assertRegex(log, r'Failure in "POST /api/refresh": TypeError in main\.py:\d+\n')
        self.assertNotIn(self.marker, log)


if __name__ == '__main__':
    unittest.main()
