"""The server refuses connections from a process of another system user (server/peer.py, server/main.py).

The table tests use synthetic text; the connection tests use real loopback sockets of this process; the
integration test runs a client as another kernel UID (a user namespace mapped to the /etc/subuid range, no
privilege) and as the same user inside a user namespace, and is skipped, with the reason, where the system does
not allow it. Every file lives in temporaries.
"""
import http.client
import io
import json
import os
import pwd
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import main
import peer
from main import OTHER_USER, UNKNOWN_USER, make_handler
from scripts import launch
from workspace import Workspace

HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
HEADER6 = ('  sl  local_address                         remote_address                        st tx_queue rx_queue tr '
           'tm->when retrnsmt   uid  timeout inode\n')


def word(text):
    """A 32-bit word of an address as the kernel prints it on this machine (native byte order)."""
    return '%08X' % struct.unpack('=I', bytes.fromhex(text))[0]


LOOP4 = word('7f000001')  # 127.0.0.1
MAPPED = word('00000000') * 2 + word('0000ffff') + LOOP4  # ::ffff:127.0.0.1
LOOP6 = word('00000000') * 3 + word('00000001')  # ::1


def line(local, remote, uid, state='01', number=0, inode=None):
    return (f'{number:4d}: {local} {remote} {state} 00000000:00000000 00:00000000 00000000 {uid:5d}        0 '
            f'{4242 + number if inode is None else inode} 1 0000000000000000 20 4 30 10 -1\n')


class TableTests(unittest.TestCase):
    def test_kernel_addresses(self):
        self.assertEqual(peer.kernel_address('127.0.0.1', 0x9C40, 4), f'{LOOP4}:9C40')
        self.assertEqual(peer.kernel_address('127.0.0.1', 80, 6), f'{MAPPED}:0050')
        self.assertEqual(peer.kernel_address('::ffff:127.0.0.1', 80, 4), f'{LOOP4}:0050')
        self.assertEqual(peer.kernel_address('::ffff:127.0.0.1', 80, 6), f'{MAPPED}:0050')
        self.assertEqual(peer.kernel_address('::1', 443, 6), f'{LOOP6}:01BB')
        self.assertIsNone(peer.kernel_address('::1', 443, 4))
        if sys.byteorder == 'little':
            self.assertEqual(LOOP4, '0100007F')  # the form documented by the kernel for x86 and arm64

    def test_ipv4_client_line_and_not_the_server_line(self):
        client, server = f'{LOOP4}:9C40', f'{LOOP4}:1F90'
        table = HEADER + line(server, '00000000:0000', 1000, state='0A') + line(server, client, 1000, number=1) \
            + line(client, server, 2001, number=2)
        self.assertEqual(peer.owners(table, client, server), [2001])

    def test_ipv6_and_mapped(self):
        client, server = f'{LOOP6}:C350', f'{LOOP6}:1F90'
        self.assertEqual(peer.owners(HEADER6 + line(client, server, 1000), client, server), [1000])
        client, server = f'{MAPPED}:C350', f'{MAPPED}:1F90'
        self.assertEqual(peer.owners(HEADER6 + line(client, server, 3003), client, server), [3003])

    def test_absent_malformed_time_wait_and_header(self):
        client, server = f'{LOOP4}:9C40', f'{LOOP4}:1F90'
        self.assertEqual(peer.owners(HEADER, client, server), [])
        self.assertEqual(peer.owners('', client, server), [])
        self.assertEqual(peer.owners(HEADER + line(client, f'{LOOP4}:1F91', 1000), client, server), [])
        self.assertEqual(peer.owners(HEADER + line(client, server, 0, state='06'), client, server), [])
        # A socket its process closed has no inode and UID 0, whoever created it; one still connecting, or in
        # any state a connected client cannot be in before the answer, names no owner either.
        self.assertEqual(peer.owners(HEADER + line(client, server, 0, state='05', inode=0), client, server), [])
        self.assertEqual(peer.owners(HEADER + line(client, server, 1000, inode=0), client, server), [])
        for state in ('02', '03', '07', '08', '09', '0A', '0B'):
            self.assertEqual(peer.owners(HEADER + line(client, server, 1000, state=state), client, server), [], state)
        for state in ('01', '04', '05'):
            self.assertEqual(peer.owners(HEADER + line(client, server, 1000, state=state), client, server), [1000], state)
        listening = HEADER + line(client, '00000000:0000', 1000, state='0A')
        self.assertEqual(peer.owners(listening, client, '00000000:0000', peer.LISTEN), [1000])
        self.assertEqual(peer.owners(listening, client, '00000000:0000'), [])
        malformed = [f'   0: {client} {server} 01\n', f'   0: {client} {server} 01 0:0 0:0 0 1000 0\n',
                     f'   0: {client} {server} 01 0:0 0:0 0 1000 0 inode\n', f'   0: {client} {server} 01 0:0 0:0 0 uid 0 1\n',
                     f'garbage {client} {server} 01 0:0 0:0 0 1000 0 1\n', f'   0: {client} {server}']
        for text in malformed:
            with self.subTest(text=text):
                self.assertEqual(peer.owners(HEADER + text, client, server), [])

    def test_peer_uid_needs_exactly_one_owner(self):
        base = Path(tempfile.mkdtemp(prefix='aae-peer-table-'))
        self.addCleanup(shutil.rmtree, base)
        client, server = ('127.0.0.1', 0x9C40), ('127.0.0.1', 0x1F90)
        a, b = f'{LOOP4}:9C40', f'{LOOP4}:1F90'

        def tables(four, six=HEADER6):
            (base / 'tcp').write_text(four)
            (base / 'tcp6').write_text(six)
            return ((str(base / 'tcp'), 4), (str(base / 'tcp6'), 6))
        self.assertEqual(peer.peer_uid(client, server, tables(HEADER + line(a, b, 1234))), 1234)
        self.assertIsNone(peer.peer_uid(client, server, tables(HEADER)))
        self.assertIsNone(peer.peer_uid(client, server, tables(HEADER + line(a, b, 1234) + line(a, b, 99, number=1))))
        mapped = HEADER6 + line(f'{MAPPED}:9C40', f'{MAPPED}:1F90', 4321)
        self.assertEqual(peer.peer_uid(client, server, tables(HEADER, mapped)), 4321)
        self.assertIsNone(peer.peer_uid(client, server, ((str(base / 'absent'), 4), (str(base / 'absent6'), 6))))
        # In a user namespace that leaves users out, they all read as one UID: it names nobody.
        self.assertIsNone(peer.peer_uid(client, server, tables(HEADER + line(a, b, 65534)), unmapped=lambda: 65534))
        self.assertEqual(peer.peer_uid(client, server, tables(HEADER + line(a, b, 1234)), unmapped=lambda: 65534), 1234)
        self.assertEqual(peer.peer_uid(client, server, tables(HEADER + line(a, b, 65534)), unmapped=lambda: None), 65534)

    def test_the_uid_of_unmapped_users(self):
        base = Path(tempfile.mkdtemp(prefix='aae-peer-map-'))
        self.addCleanup(shutil.rmtree, base)
        (base / 'overflow').write_text('65533\n')

        def unmapped(text):
            (base / 'map').write_text(text)
            return peer.unmapped_uid(str(base / 'map'), str(base / 'overflow'))
        self.assertIsNone(unmapped('         0          0 4294967295\n'))  # the initial namespace
        self.assertEqual(unmapped('         0       1000          1\n'), 65533)
        self.assertEqual(unmapped('         0       1000          1\n         1     100000      65536\n'), 65533)
        self.assertEqual(unmapped(''), 65533)  # started in a namespace without a mapping: the server's own UID
        self.assertEqual(unmapped('garbage\n'), 65534)
        self.assertEqual(peer.unmapped_uid(str(base / 'absent'), str(base / 'overflow')), 65534)
        self.assertEqual(peer.unmapped_uid(str(base / 'map'), str(base / 'absent')), 65534)


class RealConnectionTests(unittest.TestCase):
    def listen(self):
        server = socket.socket()
        server.bind(('127.0.0.1', 0))
        server.listen(4)
        self.addCleanup(server.close)
        return server

    def test_own_ipv4_connection(self):
        server = self.listen()
        client = socket.create_connection(server.getsockname())
        self.addCleanup(client.close)
        accepted, address = server.accept()
        self.addCleanup(accepted.close)
        self.assertEqual(peer.peer_uid(address, accepted.getsockname()), os.geteuid())

    def test_own_ipv6_socket_connected_through_the_mapped_address(self):
        if not socket.has_ipv6:
            self.skipTest('sem IPv6 neste Python')
        server = self.listen()
        client = socket.socket(socket.AF_INET6)
        self.addCleanup(client.close)
        try:
            client.connect(('::ffff:127.0.0.1', server.getsockname()[1]))
        except OSError as exc:
            self.skipTest(f'conexão IPv6 a um endereço mapeado indisponível: {exc}')
        accepted, address = server.accept()
        self.addCleanup(accepted.close)
        self.assertEqual(address[0], '127.0.0.1')  # the server sees IPv4; the client socket is in tcp6
        self.assertEqual(peer.peer_uid(address, accepted.getsockname()), os.geteuid())

    def test_a_peer_that_reset_is_undetermined(self):
        server = self.listen()
        client = socket.create_connection(server.getsockname())
        accepted, address = server.accept()
        self.addCleanup(accepted.close)
        client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        client.close()
        self.assertIsNone(peer.peer_uid(address, accepted.getsockname()))

    def test_a_peer_that_closed_is_undetermined_and_one_that_only_stopped_sending_is_known(self):
        server = self.listen()
        client = socket.create_connection(server.getsockname())
        self.addCleanup(client.close)
        accepted, address = server.accept()
        self.addCleanup(accepted.close)
        client.shutdown(socket.SHUT_WR)
        self.assertEqual(accepted.recv(1), b'')  # the FIN arrived
        self.assertEqual(peer.peer_uid(address, accepted.getsockname()), os.geteuid())
        client.close()  # the kernel keeps the socket, without a process: UID 0 in the table, for any user
        self.assertIsNone(peer.peer_uid(address, accepted.getsockname()))

    def test_a_dead_connection_is_not_given_to_whoever_connects_next_from_the_same_port(self):
        # A client sends its request and resets: the request stays readable and the pair of addresses is free.
        # Another program (here this process, standing for the server's user) connects from the same port
        # before the refusal is decided. The first connection must not pass as that user's.
        server = self.listen()
        first = socket.socket()
        first.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        first.bind(('127.0.0.1', 0))
        port = first.getsockname()[1]
        first.connect(server.getsockname())
        first.sendall(b'GET /api/session HTTP/1.0\r\n\r\n')
        accepted, address = server.accept()
        self.addCleanup(accepted.close)
        first.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        first.close()
        second = socket.socket()
        self.addCleanup(second.close)
        second.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        second.bind(('127.0.0.1', port))
        second.connect(server.getsockname())
        self.assertEqual(peer.peer_uid(address, accepted.getsockname()), os.geteuid())  # the table alone is fooled
        refusal = main.peer_refusal(accepted, address)
        self.assertIsNotNone(refusal)
        self.assertEqual(refusal[0], UNKNOWN_USER)

    def test_the_owner_of_a_listening_port(self):
        server = self.listen()
        port = server.getsockname()[1]
        self.assertEqual(peer.peer_uid(('127.0.0.1', port), ('0.0.0.0', 0), states=peer.LISTEN), os.geteuid())
        self.assertIs(launch.own_listener(port), True)
        with patch.object(launch, 'peer_uid', return_value=os.geteuid() + 1):
            self.assertIs(launch.own_listener(port), False)
        with patch.object(launch, 'read_table', side_effect=OSError(2, 'no table')):
            self.assertIsNone(launch.own_listener(port))
        server.close()
        self.assertIs(launch.own_listener(port), False)
        everywhere = socket.socket()  # a listener on every address is not the app's, whoever owns it
        self.addCleanup(everywhere.close)
        everywhere.bind(('0.0.0.0', 0))
        everywhere.listen(1)
        self.assertIs(launch.own_listener(everywhere.getsockname()[1]), False)


class ServerFixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aae-peer-http-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'project'
        self.root.mkdir()
        (self.root / 'AGENTS.md').write_text('# Synthetic\n', encoding='utf-8')
        self.ws = Workspace(self.base / 'state')
        static = self.base / 'static'
        static.mkdir()
        (static / 'index.html').write_text('<title>Synthetic</title>', encoding='utf-8')
        self.log = io.StringIO()
        stderr = patch('sys.stderr', new=self.log)
        stderr.start()
        self.addCleanup(stderr.stop)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.ws, static, 'peer-token'))
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_port

    def request(self, method, route, body=None, token='peer-token'):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        headers = {'X-AAE-Token': token}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        try:
            connection.request(method, route, body, headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()


ROUTES = [('GET', '/api/session', None), ('GET', '/', None), ('GET', '/index.html', None), ('GET', '/api/workspace', None),
          ('GET', '/api/directories?path=/', None), ('GET', '/api/content?path=/etc/hostname', None),
          ('POST', '/api/open', '{"path": "/"}'), ('POST', '/api/edit/save', '{"path": "/x.md"}'),
          ('POST', '/api/create', '{"parent": "/tmp"}')]


class RefusalTests(ServerFixture, unittest.TestCase):
    def test_another_user_gets_a_403_on_every_route_and_nothing_runs(self):
        marker = 'mk-peer-' + os.urandom(6).hex()
        with patch.object(main, 'peer_uid', return_value=os.geteuid() + 1), \
                patch.object(self.ws, 'open', side_effect=AssertionError('a route ran')), \
                patch.object(self.ws, 'snapshot', side_effect=AssertionError('a route ran')):
            for method, route, body in ROUTES:
                with self.subTest(route=route):
                    status, payload = self.request(method, route + ('&' if '?' in route else '?') + marker,
                                                   body and body.replace('}', f', "{marker}": 1}}'))
                    self.assertEqual((status, json.loads(payload)), (403, {'error': OTHER_USER}))
        log = self.log.getvalue()
        # The log takes a few refusal lines a minute and nothing the refused program sent: no method, no route.
        self.assertGreater(len(ROUTES), main.REFUSAL_LINES)
        self.assertEqual(log.count(f'runs as uid {os.geteuid() + 1}, not as uid {os.geteuid()}'), main.REFUSAL_LINES)
        self.assertEqual(len(log.splitlines()), main.REFUSAL_LINES)
        self.assertNotIn(marker, log)
        self.assertNotIn('/api/', log)
        self.assertNotIn('Traceback', log)

    def test_nothing_a_refused_program_sent_reaches_the_log(self):
        marker = 'mk-peer-' + os.urandom(6).hex()
        requests = [f'GET /{marker} HTTP/1.0\r\n\r\n', f'{marker} / HTTP/1.0\r\n\r\n', f'GET / HTTP/{marker}\r\n\r\n',
                    f'{marker}\r\n\r\n', 'GET /' + marker * 6000 + ' HTTP/1.0\r\n\r\n', f'GET / HTTP/1.0\r\n{marker}: {marker}\r\n\r\n',
                    f'POST /api/open HTTP/1.0\r\nContent-Length: {marker}\r\n\r\n']
        with patch.object(main, 'peer_uid', return_value=os.geteuid() + 1):
            for text in requests:
                with socket.create_connection(('127.0.0.1', self.port), timeout=10) as client:
                    client.sendall(text.encode())
                    while client.recv(65536):
                        pass
            with socket.create_connection(('127.0.0.1', self.port), timeout=10) as client:  # resets before the answer
                client.sendall(f'GET /{marker} HTTP/1.0\r\n\r\n'.encode())
                client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        self.server.shutdown()
        self.server.server_close()  # waits for the request threads
        log = self.log.getvalue()
        self.assertNotIn(marker, log)
        self.assertEqual([entry.split('] ', 1)[1].split(':')[0] for entry in log.splitlines()],
                         ['Connection refused'] * main.REFUSAL_LINES)

    def test_refusal_lines_are_limited_and_the_rest_counted(self):
        now = [0.0]
        lines = main.RefusalLines(clock=lambda: now[0])
        written = [entry for _ in range(main.REFUSAL_LINES + 37) for entry in lines.take('refused')]
        self.assertEqual(written, ['refused'] * main.REFUSAL_LINES)
        now[0] = main.REFUSAL_WINDOW + 1
        self.assertEqual(lines.take('refused'), ['Connections refused and not logged since the last such line: 37.', 'refused'])
        now[0] += main.REFUSAL_WINDOW + 1
        self.assertEqual(lines.take('refused'), ['refused'])

    def test_a_refused_connection_that_sends_nothing_is_closed(self):
        with patch.object(main, 'peer_uid', return_value=os.geteuid() + 1), patch.object(main, 'REFUSED_TIMEOUT', 0.3):
            with socket.create_connection(('127.0.0.1', self.port), timeout=10) as client:
                started = time.monotonic()
                self.assertEqual(client.recv(1), b'')
                self.assertLess(time.monotonic() - started, 5)
        self.assertNotIn('Invalid HTTP request', self.log.getvalue())

    def test_a_refused_connection_that_sends_slowly_is_closed_at_the_same_time(self):
        with patch.object(main, 'peer_uid', return_value=os.geteuid() + 1), patch.object(main, 'REFUSED_TIMEOUT', 0.5):
            with socket.create_connection(('127.0.0.1', self.port), timeout=10) as client:
                started = time.monotonic()
                client.settimeout(0.2)
                while time.monotonic() - started < 5:  # one byte at a time, each well within the timeout
                    try:
                        client.sendall(b'G')
                        if not client.recv(4096):
                            break
                    except TimeoutError:
                        continue
                    except OSError:
                        break  # closed with bytes unread: the answer may be lost, the connection is gone
                self.assertLess(time.monotonic() - started, 3)

    def test_a_target_that_cannot_be_split_is_answered(self):
        with socket.create_connection(('127.0.0.1', self.port), timeout=10) as client:
            client.sendall(b'GET http://[x HTTP/1.0\r\n\r\n')
            self.assertTrue(client.recv(4096).startswith(b'HTTP/1.0 400 '))

    def test_a_request_refused_by_its_origin_leaves_no_path_in_the_log_and_a_long_route_is_cut(self):
        marker = 'mk-site-' + os.urandom(6).hex()
        for headers in ({'Sec-Fetch-Site': 'cross-site'}, {'Origin': 'http://example.invalid'}, {'Host': 'example.invalid'}):
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
            self.addCleanup(connection.close)
            connection.request('GET', f'/{marker}', headers=headers)
            self.assertEqual(connection.getresponse().status, 403)
        self.request('GET', '/' + 'a' * 5000)
        log = self.log.getvalue()
        self.assertNotIn(marker, log)
        self.assertEqual(log.count('"GET -" 403'), 3)
        self.assertLess(max(map(len, log.splitlines())), main.ROUTE_IN_LOG + 100)

    def test_an_undetermined_user_is_refused(self):
        for failure in ({'return_value': None}, {'side_effect': OSError(2, 'no table')}):
            with self.subTest(failure=failure), patch.object(main, 'peer_uid', **failure):
                status, payload = self.request('GET', '/api/session')
                self.assertEqual((status, json.loads(payload)), (403, {'error': UNKNOWN_USER}))
        self.assertIn('the system user of the program that connected is unknown', self.log.getvalue())

    def test_a_refused_body_is_not_read(self):
        # The refusal is answered from the headers: the body is never read and no route runs.
        with patch.object(main, 'peer_uid', return_value=os.geteuid() + 1):
            status, payload = self.request('POST', '/api/create', json.dumps({'parent': str(self.base), 'name': 'x',
                                                                             'pad': 'y' * 1000}))
        self.assertEqual(status, 403)
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), ['project', 'state', 'static'])

    def test_the_same_user_is_served(self):
        status, payload = self.request('GET', '/api/session')
        self.assertEqual(status, 200)
        self.assertIn('token', json.loads(payload))
        self.assertNotIn('Connection refused', self.log.getvalue())


class LauncherTests(ServerFixture, unittest.TestCase):
    """The launcher trusts a port only when this user's program listens on it (scripts/launch.py)."""

    def test_this_users_server_is_alive(self):
        self.assertIs(launch.server_alive(self.port), True)

    def test_a_port_held_by_another_user_is_not_the_server_whatever_it_answers(self):
        with patch.object(launch, 'peer_uid', return_value=os.geteuid() + 1):
            self.assertIs(launch.server_alive(self.port), False)
        with patch.object(launch, 'read_table', side_effect=OSError(2, 'no table')):  # cannot tell: not trusted
            self.assertIs(launch.server_alive(self.port), False)
        with patch.object(launch, 'peer_uid', return_value=os.geteuid() + 1), \
                patch.object(launch, 'urlopen', side_effect=AssertionError('asked')):  # and it is not even asked
            self.assertIs(launch.server_alive(self.port), False)

    def test_a_server_that_refuses_this_user_is_reported_and_not_replaced(self):
        with patch.object(main, 'peer_uid', return_value=None):
            with self.assertRaises(launch.Refusing) as caught:
                launch.server_alive(self.port)
            self.assertIn(UNKNOWN_USER, str(caught.exception))
            with patch.object(launch, 'read_table', side_effect=OSError(2, 'no table')):  # no table for the launcher either
                with self.assertRaises(launch.Refusing):
                    launch.server_alive(self.port)
            with patch.object(launch, 'peer_uid', return_value=os.geteuid() + 1):  # another user's refusal is not ours
                self.assertIs(launch.server_alive(self.port), False)

    def test_nothing_listening_is_not_alive(self):
        self.server.shutdown()
        self.server.server_close()
        self.assertIs(launch.server_alive(self.port), False)


CLIENT = ('import http.client, sys\n'
          'c = http.client.HTTPConnection("127.0.0.1", int(sys.argv[1]), timeout=10)\n'
          'c.request("GET", "/api/session")\n'
          'r = c.getresponse()\n'
          'print(r.status, r.read().decode())\n')


class OtherKernelUserTests(ServerFixture, unittest.TestCase):
    """Real processes: another kernel UID is refused; the same user inside a user namespace is served."""

    def run_as(self, prefix):
        python = '/usr/bin/python3'
        command = prefix + ['env', '-i', 'PATH=/usr/bin:/bin', python, '-I', '-c', CLIENT, str(self.port)]
        return subprocess.run(command, capture_output=True, text=True, cwd='/', timeout=60)

    def other_user(self):
        missing = [tool for tool in ('unshare', 'setpriv', 'newuidmap', 'newgidmap') if not shutil.which(tool)]
        if missing or not os.path.exists('/usr/bin/python3'):
            self.skipTest(f'sem {", ".join(missing) or "/usr/bin/python3"} para rodar um cliente com outro UID')
        uid, gid = os.getuid(), os.getgid()
        ranges = {}
        for name, own in (('/etc/subuid', uid), ('/etc/subgid', gid)):
            try:
                rows = [row.split(':') for row in Path(name).read_text().split()]
            except OSError:
                rows = []
            user = pwd.getpwuid(uid).pw_name
            found = [row for row in rows if len(row) == 3 and row[0] in (user, str(uid))]
            if not found:
                self.skipTest(f'{name} não tem faixa para este usuário: sem como criar outro UID sem privilégio')
            ranges[name] = found[0]
        sub_uid, sub_gid = ranges['/etc/subuid'][1], ranges['/etc/subgid'][1]
        prefix = ['unshare', '--user', f'--map-users=0:{uid}:1', f'--map-users=1:{sub_uid}:1',
                  f'--map-groups=0:{gid}:1', f'--map-groups=1:{sub_gid}:1', '--',
                  'setpriv', '--reuid=1', '--regid=1', '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--']
        probe = subprocess.run(prefix + ['cat', '/proc/self/status'], capture_output=True, text=True, timeout=30)
        if probe.returncode:
            self.skipTest(f'namespace de usuário indisponível: {probe.stderr.strip()[:200]}')
        return prefix, int(sub_uid)

    def test_another_kernel_uid_is_refused_and_the_same_user_in_a_namespace_is_served(self):
        prefix, other = self.other_user()
        refused = self.run_as(prefix)
        self.assertEqual(refused.returncode, 0, refused.stderr)
        status, _, text = refused.stdout.strip().partition(' ')
        self.assertEqual((status, json.loads(text)), ('403', {'error': OTHER_USER}))
        self.assertIn(f'runs as uid {other}, not as uid {os.geteuid()}', self.log.getvalue())
        same = self.run_as(['unshare', '--user', '--map-root-user', '--'])
        self.assertEqual(same.returncode, 0, same.stderr)
        status, _, text = same.stdout.strip().partition(' ')
        self.assertEqual(status, '200')
        self.assertIn('token', json.loads(text))


if __name__ == '__main__':
    unittest.main()
