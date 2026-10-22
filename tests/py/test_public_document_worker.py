"""No-network adversarial tests of the actual destination/framing owner."""
import ipaddress
import socket
import pytest
from music_app.services import public_document_worker as worker


class Socket:
    family = socket.AF_INET
    def __init__(self, body=b'', peer=('8.8.8.8', 80)):
        self.body, self.peer, self.sent, self.closed = body, peer, [], False
        self.requests = []
    def settimeout(self, value):
        assert value > 0
    def recv(self, count):
        self.requests.append(count)
        result, self.body = self.body[:count], self.body[count:]
        return result
    def connect(self, endpoint):
        assert endpoint == self.peer
    def getpeername(self):
        return self.peer
    def sendall(self, value):
        self.sent.append(value)
    def close(self):
        self.closed = True


def read(raw):
    sock = Socket(raw)
    return worker.response(worker.Reader(sock, 30, {'wire': 0, 'headers': 0}, lambda: 0)), sock


@pytest.mark.parametrize('url', [
    'file:///etc/passwd', '//example.org/a', 'ftp://example.org/a',
    'http://user:pass@example.org', 'http://@example.org', 'http://example.org:0/',
    'http://example.org:/', 'http://example.org:8080/', 'http://example.org/\r\nx',
    'http://example.org\\@127.0.0.1', 'http://example.org/%q0',
    'http://127.1', 'http://2130706433', 'http://0177.0.0.1', 'http://0x7f000001',
    'http://[fe80::1%25eth0]/', 'http://localhost/', 'http://exa_mple.org/',
    'http://0x8.0x8.0x8.0x8/', 'http://8.0x8.8.0x8/',
    'http://[2606:4700::1111]suffix/', 'http://[2606:4700::1111]:/',
    'http://[2606:4700::1111]:080/', 'http://example.org:080/',
    'http://example.org:80:80/', 'http://example.org]/',
])
def test_rejects_ambiguous_or_nonpublic_urls(url):
    with pytest.raises(worker.DocumentError):
        worker.normalize_url(url)


def test_fragment_is_private_identity_only_and_query_bytes_are_preserved():
    result = worker.normalize_url('https://Example.org/a%2Fb?q=%23x#section')
    assert result == ('https://example.org/a%2Fb?q=%23x', 'example.org', 443, '/a%2Fb?q=%23x')


@pytest.mark.parametrize('network', (*worker._V4, *worker._V6))
def test_every_explicit_forbidden_network_boundary(network):
    for address in (network.network_address, network.broadcast_address):
        with pytest.raises(worker.DocumentError):
            worker.public_address(str(address))


@pytest.mark.parametrize('address', ['::', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808',
    '64:ff9b:1::1', '100::1', 'fc00::1', 'fe80::1', 'ff02::1', '5f00::1'])
def test_non_global_ipv6_space_and_translation_never_admitted(address):
    with pytest.raises(worker.DocumentError):
        worker.public_address(address)


def test_public_address_and_mixed_dns_rejection_before_connect():
    assert str(worker.public_address('8.8.8.8')) == '8.8.8.8'
    assert str(worker.public_address('2606:4700:4700::1111')) == '2606:4700:4700::1111'
    def resolver(*args):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (ip, 80))
                for ip in ('8.8.8.8', '127.0.0.1')]
    with pytest.raises(worker.DocumentError):
        worker.addresses('example.org', 80, resolver)


def test_raw_dns_answer_cap_precedes_deduplication_and_scope_is_zero():
    row = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 80))
    with pytest.raises(worker.DocumentError):
        worker.addresses('example.org', 80, lambda *a: [row] * 17)
    assert len(worker.addresses('example.org', 80, lambda *a: [row] * 16)) == 1
    with pytest.raises(worker.DocumentError):
        worker.addresses('example.org', 80, lambda *a: [
            (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('2606:4700::1', 80, 0, 2))])


@pytest.mark.parametrize('raw', [
    b'HTTP/1.1 103 Early Hints\r\n\r\n', b'HTTP/1.1 101 Upgrade\r\n\r\n',
    b'HTTP/1.1 200 OK\nContent-Type: text/plain\n\n',
    b'HTTP/1.1 200 OK\r\n Content-Type: text/plain\r\n\r\n',
    b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx',
    b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
    b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip\r\n\r\n',
    b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\na',
    b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n1;x=y\r\na\r\n0\r\n\r\n',
    b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nContent-Length: 0\r\n\r\n',
])
def test_strict_framing_rejects_ambiguous_or_unsupported_response(raw):
    with pytest.raises(worker.DocumentError):
        read(raw)


@pytest.mark.parametrize('framing,body', [
    (b'Content-Length: 3\r\n', b'abc'), (b'', b'abc'),
    (b'Transfer-Encoding: chunked\r\n', b'1\r\na\r\n2\r\nbc\r\n0\r\nX-Note: ok\r\n\r\n')])
def test_supported_body_modes_are_bounded_and_complete(framing, body):
    result, sock = read(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n' + framing + b'\r\n' + body)
    assert result == (200, 'text/plain', 'utf-8', b'abc')
    assert max(sock.requests) <= 8192


def test_exact_limit_and_sentinel_overrun():
    prefix = b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n'
    result, _ = read(prefix + b'a' * worker.BODY_LIMIT)
    assert len(result[3]) == worker.BODY_LIMIT
    with pytest.raises(worker.DocumentError):
        read(prefix + b'a' * (worker.BODY_LIMIT + 1))


def test_huge_chunk_is_rejected_before_body_allocation():
    with pytest.raises(worker.DocumentError):
        read(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\nFFFFFFFF\r\n')


def test_header_line_and_aggregate_budgets_are_enforced():
    with pytest.raises(worker.DocumentError):
        read(b'HTTP/1.1 200 OK\r\nX: ' + b'a' * 8192)
    with pytest.raises(worker.DocumentError):
        read(b'HTTP/1.1 200 OK\r\n' + (b'X: ' + b'a' * 7000 + b'\r\n') * 10 + b'\r\n')


def test_peer_mismatch_closes_before_request_and_never_resolves_again():
    calls = []
    def resolve(*args):
        calls.append(args)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 80))]
    sock = Socket()
    sock.getpeername = lambda: ('127.0.0.1', 80)
    with pytest.raises(worker.DocumentError):
        worker.acquire('http://example.org', deadline=30, resolver=resolve,
                       socket_factory=lambda *a: sock, clock=lambda: 0)
    assert len(calls) == 1 and not sock.sent and sock.closed


def test_redirect_to_private_does_not_connect_or_drain_error_body():
    sock = Socket(b'HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/x\r\n\r\n' + b'x' * 100000)
    created = []
    def factory(*args):
        created.append(sock); return sock
    resolver = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 80))]
    with pytest.raises(worker.DocumentError):
        worker.acquire('http://example.org', deadline=30, resolver=resolver, socket_factory=factory, clock=lambda: 0)
    assert len(created) == 1 and sock.closed and len(sock.body) > 90000


def test_fragment_only_redirect_is_a_loop_and_fixed_headers_have_no_credentials(monkeypatch):
    monkeypatch.setenv('HTTP_PROXY', 'http://user:secret@127.0.0.1')
    sock = Socket(b'HTTP/1.1 302 Found\r\nLocation: #next\r\nSet-Cookie: secret=1\r\n\r\n')
    resolver = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 80))]
    with pytest.raises(worker.DocumentError):
        worker.acquire('http://example.org/#first', deadline=30, resolver=resolver,
                       socket_factory=lambda *a: sock, clock=lambda: 0)
    sent = sock.sent[0]
    assert b'#first' not in sent and b'Cookie' not in sent and b'Authorization' not in sent
    assert b'Accept-Encoding: identity' in sent and b'Referer' not in sent


def test_trickle_cannot_refresh_total_deadline():
    now = [0]
    sock = Socket(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\na')
    original = sock.recv
    def trickle(count):
        now[0] += 1
        return original(1)
    sock.recv = trickle
    with pytest.raises(worker.DocumentError, match='deadline'):
        worker.response(worker.Reader(sock, 3, {'wire': 0, 'headers': 0}, lambda: now[0]))


def test_tls_uses_original_hostname_and_rechecks_peer_without_insecure_fallback():
    sock = Socket(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\na',
                  peer=('8.8.8.8', 443))
    calls = []
    class TLS:
        def set_alpn_protocols(self, values):
            calls.append(('alpn', values))
        def wrap_socket(self, original, *, server_hostname):
            calls.append(('hostname', server_hostname)); return original
    resolver = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 443))]
    result = worker.acquire('https://Example.org/a#frag', deadline=30, resolver=resolver,
        socket_factory=lambda *a: sock, tls_factory=TLS, clock=lambda: 0)
    assert calls == [('alpn', ['http/1.1']), ('hostname', 'example.org')]
    assert result['final_url'] == 'https://example.org/a' and result['redirect_chain'] == ['https://Example.org/a#frag']
    assert b'Host: example.org\r\n' in sock.sent[0] and sock.closed


def test_tls_failure_closes_without_sending_http():
    sock = Socket(peer=('8.8.8.8', 443))
    class TLS:
        def set_alpn_protocols(self, values): pass
        def wrap_socket(self, *args, **kwargs): raise OSError('certificate rejected')
    resolver = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 443))]
    with pytest.raises(OSError):
        worker.acquire('https://example.org', deadline=30, resolver=resolver,
            socket_factory=lambda *a: sock, tls_factory=TLS, clock=lambda: 0)
    assert sock.closed and not sock.sent


def test_trusted_self_origin_address_alias_is_rejected_before_connection():
    resolver = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 80))]
    with pytest.raises(worker.DocumentError, match='forbidden_destination'):
        worker.acquire('http://alias.example.org', ('app.example.org',), deadline=30, resolver=resolver,
            socket_factory=lambda *a: pytest.fail('no self-origin connect'), clock=lambda: 0)


def test_redirect_count_and_https_downgrade():
    made = []
    def factory(*args):
        sock = Socket(('HTTP/1.1 302 Found\r\nLocation: /hop' + str(len(made) + 1) + '\r\n\r\n').encode())
        made.append(sock); return sock
    resolver = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 80))]
    with pytest.raises(worker.DocumentError, match='redirect_limit'):
        worker.acquire('http://example.org', deadline=30, resolver=resolver, socket_factory=factory, clock=lambda: 0)
    assert len(made) == 6 and all(sock.closed for sock in made)
    sock = Socket(b'HTTP/1.1 302 Found\r\nLocation: http://example.org/plain\r\n\r\n', peer=('8.8.8.8', 443))
    class TLS:
        def set_alpn_protocols(self, values): pass
        def wrap_socket(self, value, **kwargs): return value
    with pytest.raises(worker.DocumentError, match='downgrade'):
        worker.acquire('https://example.org', deadline=30,
            resolver=lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 443))],
            socket_factory=lambda *a: sock, tls_factory=TLS, clock=lambda: 0)
    assert sock.closed


@pytest.mark.parametrize('header', [b'Content-Encoding: identity\r\nContent-Encoding: identity',
    b'Content-Type: text/plain\r\nContent-Type: text/plain', b'Location: /a\r\nLocation: /b',
    b'Transfer-Encoding: gzip', b'Content-Length: +1', b'Content-Length: 1,1'])
def test_duplicate_critical_headers_and_noncanonical_framing(header):
    mime = b'' if header.startswith(b'Content-Type:') else b'Content-Type: text/plain\r\n'
    with pytest.raises(worker.DocumentError) as error:
        read(b'HTTP/1.1 200 OK\r\n' + mime + header + b'\r\n\r\n')
    assert str(error.value) == ('headers' if header.count(b'\r\n') else 'framing')


def test_excessive_chunk_count_and_trailer_bytes_fail_closed():
    prefix = b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n'
    with pytest.raises(worker.DocumentError):
        read(prefix + b'1\r\na\r\n' * 4097 + b'0\r\n\r\n')
    with pytest.raises(worker.DocumentError):
        read(prefix + b'0\r\n' + (b'X: ' + b'a' * 4000 + b'\r\n') * 3 + b'\r\n')


@pytest.mark.parametrize('location', ['/a\tb', '/a b', '/bad%zz', '/a\\b'])
def test_raw_redirect_spelling_is_rejected_before_urljoin(location):
    sock = Socket(('HTTP/1.1 302 Found\r\nLocation: ' + location + '\r\n\r\n').encode())
    made = []
    def factory(*args):
        made.append(sock); return sock
    resolver = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 80))]
    with pytest.raises(worker.DocumentError, match='invalid_url'):
        worker.acquire('http://example.org', deadline=30, resolver=resolver, socket_factory=factory, clock=lambda: 0)
    assert len(made) == 1 and sock.closed


# Independent accepted-policy oracle: never derive cases from the implementation
# tables, so accidentally dropping a CIDR cannot remove its own regression.
_EXPECTED_V4 = tuple(ipaddress.ip_network(value) for value in (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
    '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    '224.0.0.0/4', '240.0.0.0/4', '168.63.129.16/32'))
_EXPECTED_V6 = tuple(ipaddress.ip_network(value) for value in (
    '2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20'))
_EXPECTED_GLOBAL6 = ipaddress.ip_network('2000::/3')


@pytest.mark.parametrize('network', (*_EXPECTED_V4, *_EXPECTED_V6, _EXPECTED_GLOBAL6))
def test_independent_policy_first_last_and_adjacent_addresses(network):
    # Adjacent addresses can belong to another exclusion. Compute that from the
    # independent full policy, including the approved supplemental stdlib test.
    for number in (int(network.network_address) - 1, int(network.network_address),
                   int(network.broadcast_address), int(network.broadcast_address) + 1):
        if not 0 <= number < 2 ** network.max_prefixlen:
            continue
        address = (ipaddress.IPv4Address if network.version == 4 else ipaddress.IPv6Address)(number)
        denied = _EXPECTED_V4 if address.version == 4 else _EXPECTED_V6
        allowed = (address.is_global and not any(address in item for item in denied)
                   and (address.version == 4 or address in _EXPECTED_GLOBAL6))
        if allowed:
            assert worker.public_address(str(address)) == address
        else:
            with pytest.raises(worker.DocumentError):
                worker.public_address(str(address))
