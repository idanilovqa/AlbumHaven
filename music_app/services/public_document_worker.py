"""Standalone credential-free public document transport. Standard library only.

Executed with -I -S -B; never imports the application or its configuration.
This is process isolation for lifetime ownership, not an OS security sandbox.
"""
import base64
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
from urllib.parse import urlsplit, urlunsplit, urljoin

BODY_LIMIT = 512 * 1024
WIRE_LIMIT = 1024 * 1024
HEADER_LIMIT = 64 * 1024
OUTPUT_LIMIT = 768 * 1024
URL_LIMIT = 4096
_V4 = tuple(ipaddress.ip_network(value) for value in (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
    '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    '224.0.0.0/4', '240.0.0.0/4', '168.63.129.16/32'))
_V6 = tuple(ipaddress.ip_network(value) for value in (
    '2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20'))
_GLOBAL6 = ipaddress.ip_network('2000::/3')
_TOKEN = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_CRITICAL = {b'content-length', b'transfer-encoding', b'content-encoding', b'content-type', b'location'}
_TRAILER_FORBIDDEN = _CRITICAL | {b'host', b'trailer'}


class DocumentError(ValueError):
    pass


def public_address(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise DocumentError('invalid_address') from None
    if '%' in str(value) or not address.is_global:
        raise DocumentError('forbidden_address')
    if address.version == 4:
        denied = any(address in network for network in _V4)
    else:
        denied = (address not in _GLOBAL6 or any(address in network for network in _V6)
                  or address.ipv4_mapped is not None or address.sixtofour is not None
                  or address.teredo is not None)
    if denied:
        raise DocumentError('forbidden_address')
    return address


def validate_url_spelling(value):
    if type(value) is not str:
        raise DocumentError('invalid_url')
    try:
        if not 1 <= len(value.encode('utf-8')) <= URL_LIMIT:
            raise DocumentError('invalid_url')
        if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value) or '\\' in value:
            raise DocumentError('invalid_url')
        if re.search(r'%(?![0-9A-Fa-f]{2})', value):
            raise DocumentError('invalid_url')
    except UnicodeError:
        raise DocumentError('invalid_url') from None
    return value


def normalize_url(value):
    validate_url_spelling(value)
    try:
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.netloc or '@' in parts.netloc:
            raise DocumentError('invalid_url')
        # urlsplit is a splitter, not authority admission. Reject trailing
        # bracket junk, extra colons, nondecimal/empty/alternate port spellings.
        if parts.netloc.startswith('['):
            if re.fullmatch(r'\[[0-9a-fA-F:.]+\](?::(?:80|443))?', parts.netloc) is None:
                raise DocumentError('invalid_url')
        elif ('[' in parts.netloc or ']' in parts.netloc
              or re.fullmatch(r'[^:]+(?::(?:80|443))?', parts.netloc) is None):
            raise DocumentError('invalid_url')
        host = parts.hostname
        if parts.netloc.endswith(':'):
            raise DocumentError('invalid_url')
        port = parts.port if parts.port is not None else (443 if parts.scheme == 'https' else 80)
        if port != (443 if parts.scheme == 'https' else 80) or not host or '%' in host:
            raise DocumentError('invalid_url')
        try:
            numeric = ipaddress.ip_address(host)
        except ValueError:
            numeric = None
        if numeric is not None:
            if numeric.version == 4 and host != str(numeric):
                raise DocumentError('invalid_url')
            if numeric.version == 6 and not parts.netloc.startswith('['):
                raise DocumentError('invalid_url')
            public_address(host)
            host = str(numeric)
        else:
            host = host.encode('idna').decode('ascii').lower().removesuffix('.')
            labels = host.split('.')
            if (len(host) > 253 or len(labels) < 2 or labels[-1].isdigit()
                    or all(re.fullmatch(r'(?:0x[0-9a-f]+|[0-9]+)', label) for label in labels)
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                           for label in labels)):
                raise DocumentError('invalid_url')
        authority = '[' + host + ']' if ':' in host else host
        path = parts.path or '/'
        # The HTTP request target is ASCII; preserve already encoded bytes.
        target = path + ('?' + parts.query if parts.query else '')
        target.encode('ascii')
        return urlunsplit((parts.scheme, authority, path, parts.query, '')), host, port, target
    except (ValueError, UnicodeError):
        raise DocumentError('invalid_url') from None


def addresses(host, port, resolver=socket.getaddrinfo):
    raw = resolver(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM, socket.IPPROTO_TCP)
    if not 1 <= len(raw) <= 16:
        raise DocumentError('invalid_dns')
    result, seen = [], set()
    for family, kind, protocol, _, endpoint in raw:
        if (family not in (socket.AF_INET, socket.AF_INET6) or kind != socket.SOCK_STREAM
                or protocol != socket.IPPROTO_TCP or len(endpoint) != (2 if family == socket.AF_INET else 4)
                or endpoint[1] != port or (family == socket.AF_INET6 and endpoint[2:] != (0, 0))):
            raise DocumentError('invalid_dns')
        address = public_address(endpoint[0])
        if address.version != (4 if family == socket.AF_INET else 6):
            raise DocumentError('invalid_dns')
        key = family, address.packed, port
        if key not in seen:
            seen.add(key)
            result.append((family, (str(address), port) if family == socket.AF_INET else (str(address), port, 0, 0)))
    return result


def peer_matches(sock, family, endpoint):
    peer = sock.getpeername()
    if (len(peer) != len(endpoint) or peer[1:] != endpoint[1:]
            or ipaddress.ip_address(peer[0]).packed != ipaddress.ip_address(endpoint[0]).packed
            or sock.family != family):
        raise DocumentError('peer_changed')


class Reader:
    def __init__(self, sock, deadline, budget, clock=time.monotonic):
        self.sock, self.deadline, self.budget, self.clock = sock, deadline, budget, clock
        self.buffer = bytearray()

    def receive(self, maximum=8192):
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise DocumentError('deadline')
        self.sock.settimeout(remaining)
        chunk = self.sock.recv(min(maximum, 8192, WIRE_LIMIT - self.budget['wire'] + 1))
        self.budget['wire'] += len(chunk)
        if self.budget['wire'] > WIRE_LIMIT:
            raise DocumentError('wire_limit')
        return chunk

    def line(self, limit=8192):
        while True:
            index = self.buffer.find(b'\n')
            if index >= 0:
                if index + 1 > limit or index == 0 or self.buffer[index - 1] != 13:
                    raise DocumentError('framing')
                value = bytes(self.buffer[:index - 1])
                del self.buffer[:index + 1]
                self.budget['headers'] += index + 1
                if self.budget['headers'] > HEADER_LIMIT:
                    raise DocumentError('header_limit')
                return value
            if len(self.buffer) >= limit:
                raise DocumentError('line_limit')
            chunk = self.receive(limit - len(self.buffer))
            if not chunk:
                raise DocumentError('truncated')
            self.buffer.extend(chunk)

    def exact(self, count):
        result = bytearray()
        while count:
            if self.buffer:
                n = min(count, len(self.buffer))
                result.extend(self.buffer[:n]); del self.buffer[:n]
            else:
                chunk = self.receive(min(count, 8192))
                if not chunk:
                    raise DocumentError('truncated')
                n = len(chunk); result.extend(chunk)
            count -= n
        return bytes(result)


def headers(reader, *, trailers=False):
    result = {}
    start = reader.budget['headers']
    maximum = 32 if trailers else 100
    for _ in range(maximum + 1):
        line = reader.line()
        if trailers and reader.budget['headers'] - start > 8192:
            raise DocumentError('trailer_limit')
        if not line:
            return result
        if _ == maximum or b':' not in line:
            raise DocumentError('headers')
        key, value = line.split(b':', 1)
        if not _TOKEN.fullmatch(key) or any(c < 32 and c != 9 or c == 127 for c in value):
            raise DocumentError('headers')
        key, value = key.lower(), value.strip(b' \t')
        if (key in result and key in _CRITICAL) or (trailers and key in _TRAILER_FORBIDDEN):
            raise DocumentError('headers')
        result[key] = value
    raise DocumentError('headers')


def response(reader):
    status = reader.line()
    match = re.fullmatch(rb'HTTP/1\.[01] ([0-9]{3}) [\x20-\x7e]*', status)
    if match is None:
        raise DocumentError('status')
    code = int(match[1])
    if code not in (200, 301, 302, 303, 307, 308):
        raise DocumentError('status')
    fields = headers(reader)
    length, transfer = fields.get(b'content-length'), fields.get(b'transfer-encoding')
    if length is not None and (transfer is not None or not re.fullmatch(rb'[0-9]{1,7}', length)):
        raise DocumentError('framing')
    if transfer is not None and transfer.lower() != b'chunked':
        raise DocumentError('framing')
    if fields.get(b'content-encoding', b'identity').lower() != b'identity':
        raise DocumentError('encoding')
    if code != 200:
        location = fields.get(b'location')
        if not location:
            raise DocumentError('redirect')
        try:
            return code, location.decode('utf-8'), None, None
        except UnicodeError:
            raise DocumentError('redirect') from None
    mime = fields.get(b'content-type', b'')
    match = re.fullmatch(rb'(text/html|text/plain)(?:;[ \t]*charset=(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+)))?', mime, re.I)
    if match is None:
        raise DocumentError('content_type')
    charset = (match[2] or match[3] or b'utf-8').decode('ascii').lower()
    if charset not in ('utf-8', 'utf8', 'us-ascii', 'ascii', 'iso-8859-1', 'windows-1252'):
        raise DocumentError('charset')
    body = bytearray()
    if transfer is not None:
        for index in range(4097):
            size_line = reader.line(128)
            if not re.fullmatch(rb'[0-9A-Fa-f]{1,8}', size_line):
                raise DocumentError('chunk')
            size = int(size_line, 16)
            if size == 0:
                headers(reader, trailers=True)
                break
            if index == 4096 or size > BODY_LIMIT - len(body):
                raise DocumentError('body_limit')
            body.extend(reader.exact(size))
            if reader.exact(2) != b'\r\n':
                raise DocumentError('chunk')
    elif length is not None:
        count = int(length)
        if count > BODY_LIMIT:
            raise DocumentError('body_limit')
        body.extend(reader.exact(count))
    else:
        body.extend(reader.buffer); reader.buffer.clear()
        while len(body) <= BODY_LIMIT:
            chunk = reader.receive(min(8192, BODY_LIMIT - len(body) + 1))
            if not chunk:
                break
            body.extend(chunk)
        if len(body) > BODY_LIMIT:
            raise DocumentError('body_limit')
    try:
        bytes(body).decode(charset, errors='strict')
    except UnicodeError:
        raise DocumentError('charset') from None
    return code, match[1].decode('ascii').lower(), charset, bytes(body)


def acquire(url, excluded_hosts=(), *, deadline, resolver=socket.getaddrinfo,
            socket_factory=socket.socket, clock=time.monotonic, tls_factory=ssl.create_default_context):
    budget, chain, visited = {'wire': 0, 'headers': 0}, [], set()
    current = url
    for hop in range(6):
        transport, host, port, target = normalize_url(current)
        if transport in visited or host in excluded_hosts:
            raise DocumentError('forbidden_destination')
        visited.add(transport)
        candidates = addresses(host, port, resolver)
        # Deny all current trusted self-origin addresses, not only host spelling.
        exclusions = set()
        for own_host in excluded_hosts:
            own_answers = resolver(own_host, port, socket.AF_UNSPEC, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            if not 1 <= len(own_answers) <= 16:
                raise DocumentError('self_origin_unavailable')
            for own_family, kind, protocol, _, own_endpoint in own_answers:
                if own_family not in (socket.AF_INET, socket.AF_INET6):
                    raise DocumentError('self_origin_unavailable')
                exclusions.add(ipaddress.ip_address(own_endpoint[0]).packed)
        if any(ipaddress.ip_address(endpoint[0]).packed in exclusions for _, endpoint in candidates):
            raise DocumentError('forbidden_destination')
        sock = None
        try:
            family, endpoint = candidates[0]  # no implicit DNS/reconnect fallback
            remaining = deadline - clock()
            if remaining <= 0:
                raise DocumentError('deadline')
            sock = socket_factory(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            sock.settimeout(remaining)
            sock.connect(endpoint)
            peer_matches(sock, family, endpoint)
            if transport.startswith('https:'):
                context = tls_factory()
                context.set_alpn_protocols(['http/1.1'])
                sock = context.wrap_socket(sock, server_hostname=host)
                peer_matches(sock, family, endpoint)
            remaining = deadline - clock()
            if remaining <= 0:
                raise DocumentError('deadline')
            sock.settimeout(remaining)
            authority = '[' + host + ']' if ':' in host else host
            request = ('GET ' + target + ' HTTP/1.1\r\nHost: ' + authority + '\r\n'
                       'User-Agent: AlbumHaven-Source/1\r\nAccept: text/html,text/plain\r\n'
                       'Accept-Encoding: identity\r\nConnection: close\r\n\r\n').encode('ascii')
            sock.sendall(request)
            code, value, charset, body = response(Reader(sock, deadline, budget, clock))
            chain.append(current)
            if code == 200:
                if clock() >= deadline:
                    raise DocumentError('deadline')
                return {'final_url': transport, 'redirect_chain': chain, 'mime': value,
                        'charset': charset, 'body': base64.b64encode(body).decode('ascii')}
            if hop == 5:
                raise DocumentError('redirect_limit')
            validate_url_spelling(value)  # urljoin can discard raw HTAB/control characters
            following = urljoin(transport, value)
            next_transport, _, _, _ = normalize_url(following)
            if transport.startswith('https:') and not next_transport.startswith('https:'):
                raise DocumentError('downgrade')
            current = following
        finally:
            if sock is not None:
                sock.close()
    raise DocumentError('redirect_limit')


def main():
    # Watchdog installation precedes any parsing or network work.
    end = time.monotonic() + 30
    def deadline_watch():
        time.sleep(max(0, end - time.monotonic()))
        os._exit(2)
    threading.Thread(target=deadline_watch, daemon=True).start()
    raw = sys.stdin.buffer.readline(32769)
    if len(raw) > 32768 or not raw.endswith(b'\n'):
        return 2
    def parent_watch():
        sys.stdin.buffer.read(1)
        os._exit(2)
    threading.Thread(target=parent_watch, daemon=True).start()
    try:
        command = json.loads(raw)
        if (type(command) is not dict or set(command) != {'url', 'excluded_hosts', 'seconds'}
                or type(command['seconds']) not in (int, float) or not 0 < command['seconds'] <= 30
                or type(command['excluded_hosts']) is not list or len(command['excluded_hosts']) > 16):
            return 2
        value = acquire(command['url'], command['excluded_hosts'],
                        deadline=min(end, time.monotonic() + command['seconds']))
        output = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(output) > OUTPUT_LIMIT:
            return 2
        sys.stdout.buffer.write(output); sys.stdout.buffer.flush()
        return 0
    except Exception:
        return 2  # no exception URL/body/credentials on stderr


if __name__ == '__main__':
    # The liveness reader deliberately blocks until parent death/cancellation.
    # Output is already explicitly flushed. Do not run interpreter teardown
    # while that daemon owns the buffered stdin lock.
    os._exit(main())
