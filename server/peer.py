"""Which system user owns the other end of a loopback TCP connection. Linux only, no privilege, standard library.

The kernel lists every TCP socket of the network namespace in `/proc/net/tcp` (IPv4) and `/proc/net/tcp6`
(IPv6, including IPv4-mapped addresses of IPv6 sockets), readable by any user, with the UID that created the
socket, as seen from the reader's user namespace. For a connection the server accepted, the client's socket is
the line whose local end is the client's address and whose remote end is the server's.

`peer_uid` answers None whenever it cannot name exactly one owner (no line, a malformed one, a table that cannot
be read, two lines with different UIDs); the caller refuses in that case. Three kinds of line name no owner and
are skipped: one outside the states of a connected client that still waits for the answer (TIME_WAIT among
them, and a socket still connecting); one without an inode, which is a socket its process already closed (the
kernel prints UID 0 for it, whoever created it); and, in a user namespace that does not map every user, one with
the UID the kernel prints for all the users left out.
"""
from __future__ import annotations

import ipaddress
import os
import struct

TABLES = (('/proc/net/tcp', 4), ('/proc/net/tcp6', 6))
# ESTABLISHED, FIN_WAIT1 and FIN_WAIT2: the client connected and, at most, shut its sending side.
CONNECTED = frozenset({'01', '04', '05'})
LISTEN = frozenset({'0A'})
ATTEMPTS = 3  # The kernel hands the table out in pieces; a line can be missed while sockets come and go.


def kernel_address(host: str, port: int, version: int) -> str | None:
    """`host:port` as the kernel writes it in the table of `version` (4 or 6), or None if it cannot appear there.

    Each 32-bit word of the address is printed in the machine's byte order; the port, in hexadecimal. An IPv4
    address appears in the IPv6 table in its mapped form (`::ffff:a.b.c.d`), and a mapped address in the IPv4
    table as plain IPv4.
    """
    address = ipaddress.ip_address(host.split('%', 1)[0])
    if address.version == 6 and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if version == 4:
        if address.version != 4:
            return None
        packed = address.packed
    else:
        packed = address.packed if address.version == 6 else ipaddress.IPv6Address(f'::ffff:{address}').packed
    words = struct.unpack(f'={len(packed) // 4}I', packed)
    return ''.join(f'{word:08X}' for word in words) + f':{port:04X}'


def owners(table: str, local: str, remote: str, states=CONNECTED) -> list[int]:
    """UIDs of the sockets in `table` (text of /proc/net/tcp or tcp6) with these local and remote ends, in one
    of `states`, that a process still holds (see the module's text for the lines skipped)."""
    found = []
    needle = f' {local} {remote} '
    at = table.find(needle)
    while at >= 0:
        start = table.rfind('\n', 0, at) + 1
        end = table.find('\n', at)
        fields = table[start:end if end >= 0 else len(table)].split()
        at = table.find(needle, at + 1)
        # sl local remote st tx:rx tr:when retrnsmt uid timeout inode ...
        if len(fields) < 10 or not fields[0].endswith(':') or fields[1] != local or fields[2] != remote:
            continue
        if fields[3] not in states or not fields[7].isdigit() or not fields[9].isdigit() or int(fields[9]) == 0:
            continue
        found.append(int(fields[7]))
    return found


def read_table(path: str) -> str:
    """The whole table, read in large pieces (each read is one consistent pass over as many lines as fit)."""
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        chunks = []
        while chunk := os.read(descriptor, 1 << 20):
            chunks.append(chunk)
    finally:
        os.close(descriptor)
    return b''.join(chunks).decode('ascii', 'replace')


def unmapped_uid(uid_map: str = '/proc/self/uid_map', overflow: str = '/proc/sys/kernel/overflowuid') -> int | None:
    """The UID the kernel prints for every user this process's user namespace does not map, or None when the
    namespace maps them all (the initial one does).

    Read as that UID, a socket can belong to any of those users, the server's own included when it was started
    in a namespace without a mapping. When the map cannot be read, the usual value is assumed.
    """
    try:
        with open(uid_map, encoding='ascii') as handle:
            mapped = sum(int(line.split()[2]) for line in handle if line.strip())
        if mapped >= 0xFFFFFFFF:
            return None
        with open(overflow, encoding='ascii') as handle:
            return int(handle.read())
    except (OSError, ValueError, IndexError):
        return 65534


def peer_uid(client: tuple, server: tuple, tables=TABLES, unmapped=unmapped_uid, states=CONNECTED) -> int | None:
    """UID owning the socket at `client` connected to `server`, both (host, port, ...) as the server sees them.

    With `states=LISTEN`, `client` ('127.0.0.1', port) and `server` ('0.0.0.0', 0), the UID of the program
    listening on that port: what the launcher asks before trusting whoever answers there.
    """
    ambiguous = unmapped()
    for _ in range(ATTEMPTS):
        uids = set()
        for path, version in tables:
            local, remote = kernel_address(client[0], client[1], version), kernel_address(server[0], server[1], version)
            if local is None or remote is None:
                continue
            try:
                uids.update(owners(read_table(path), local, remote, states))
            except OSError:
                continue
        if uids:
            return uids.pop() if len(uids) == 1 and ambiguous not in uids else None
    return None
