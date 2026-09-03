"""Direct TLS startup contracts; no database or private library is needed."""

from datetime import datetime, timedelta, timezone
import importlib
import ipaddress
from pathlib import Path
import socket
import ssl
from concurrent.futures import ThreadPoolExecutor

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
import pytest


def _options(tmp_path, *, host="10.0.0.164", **overrides):
    module = importlib.import_module("music_app.server_tls")
    env = {
        "MUSIC_APP_TLS_MODE": "local",
        "ALBUM_HAVEN_PUBLIC_BASE_URL": f"https://{host}:5000",
        **overrides,
    }
    return module.local_https_options(env, data_dir=tmp_path, port=5000)


def _certificate(options):
    return x509.load_pem_x509_certificate(Path(options["ssl_certfile"]).read_bytes())


@pytest.mark.parametrize("env", [{}, {"MUSIC_APP_TLS_MODE": "off"}])
def test_http_mode_does_not_create_certificate_files(tmp_path, env):
    module = importlib.import_module("music_app.server_tls")
    assert module.local_https_options(env, data_dir=tmp_path, port=5000) == {}
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("host", ["10.0.0.164", "albumhaven.home.arpa", "[::1]"])
def test_certificate_covers_configured_host_and_matching_private_key(tmp_path, host):
    options = _options(tmp_path, host=host)
    cert = _certificate(options)
    pem = Path(options["ssl_certfile"]).read_bytes()
    key = serialization.load_pem_private_key(pem, password=None)
    assert cert.public_key().public_numbers() == key.public_key().public_numbers()
    sans = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    try:
        expected = x509.IPAddress(ipaddress.ip_address(host.strip("[]")))
    except ValueError:
        expected = x509.DNSName(host)
    assert list(sans) == [expected]
    assert cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca is False
    assert cert.not_valid_after_utc > datetime.now(timezone.utc) + timedelta(days=80)
    assert options["proxy_headers"] is False
    assert options["host"] == ("::" if host == "[::1]" else "0.0.0.0")
    ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(options["ssl_certfile"])


def test_restart_reuses_certificate_and_key_without_rewriting(tmp_path):
    first = _options(tmp_path)
    path = Path(first["ssl_certfile"])
    original = path.read_bytes(), path.stat().st_mtime_ns
    assert _options(tmp_path) == first
    assert (path.read_bytes(), path.stat().st_mtime_ns) == original


def test_changed_lan_address_renews_certificate(tmp_path):
    old_cert = _certificate(_options(tmp_path))
    new_cert = _certificate(_options(tmp_path, host="10.0.0.165"))
    assert old_cert.serial_number != new_cert.serial_number
    assert new_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value == (
        x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("10.0.0.165"))])
    )


def test_near_expiry_certificate_is_renewed_on_startup(tmp_path):
    options = _options(tmp_path)
    path = Path(options["ssl_certfile"])
    cert = _certificate(options)
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    now = datetime.now(timezone.utc)
    builder = (x509.CertificateBuilder().subject_name(cert.subject)
               .issuer_name(cert.issuer).public_key(key.public_key())
               .serial_number(cert.serial_number)
               .not_valid_before(now - timedelta(days=1))
               .not_valid_after(now + timedelta(days=1)))
    for extension in cert.extensions:
        builder = builder.add_extension(extension.value, extension.critical)
    near_expiry = builder.sign(key, hashes.SHA256())
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                      serialization.PrivateFormat.PKCS8,
                                      serialization.NoEncryption())
                     + near_expiry.public_bytes(serialization.Encoding.PEM))
    assert _certificate(_options(tmp_path)).serial_number != cert.serial_number


@pytest.mark.parametrize("overrides", [
    {"MUSIC_APP_TLS_MODE": "typo"},
    {"ALBUM_HAVEN_PUBLIC_BASE_URL": "http://10.0.0.164:5000"},
    {"ALBUM_HAVEN_PUBLIC_BASE_URL": "https://10.0.0.164:5001"},
    {"ALBUM_HAVEN_PUBLIC_BASE_URL": "https://10.0.0.164:5000/app"},
    {"ALBUM_HAVEN_PUBLIC_BASE_URL": "https://user:secret@10.0.0.164:5000"},
    {"ALBUM_HAVEN_TRUSTED_PROXIES": "127.0.0.1"},
])
def test_bad_local_tls_configuration_fails_before_writing(tmp_path, overrides):
    with pytest.raises(ValueError):
        _options(tmp_path, **overrides)
    assert list(tmp_path.iterdir()) == []


def test_corrupt_existing_certificate_fails_without_overwriting(tmp_path):
    path = Path(_options(tmp_path)["ssl_certfile"])
    path.write_bytes(b"corrupt certificate")
    with pytest.raises(ValueError, match="certificate"):
        _options(tmp_path)
    assert path.read_bytes() == b"corrupt certificate"


def test_encrypted_private_key_fails_without_prompt_or_overwrite(tmp_path, monkeypatch):
    options = _options(tmp_path)
    path = Path(options["ssl_certfile"])
    original = path.read_bytes()
    key = serialization.load_pem_private_key(original, password=None)
    encrypted = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                 serialization.BestAvailableEncryption(b"test-only-password"))
    encrypted += _certificate(options).public_bytes(serialization.Encoding.PEM)
    path.write_bytes(encrypted)
    real_load = ssl.SSLContext.load_cert_chain

    def require_noninteractive_load(context, certfile, keyfile=None, password=None):
        assert password is not None, "An encrypted PEM must never trigger OpenSSL's password prompt"
        return real_load(context, certfile, keyfile, password)

    monkeypatch.setattr(ssl.SSLContext, "load_cert_chain", require_noninteractive_load)
    with pytest.raises(ValueError, match="certificate"):
        _options(tmp_path)
    assert path.read_bytes() == encrypted


def test_failed_atomic_replacement_preserves_previous_certificate(tmp_path, monkeypatch):
    path = Path(_options(tmp_path)["ssl_certfile"])
    original = path.read_bytes()
    module = importlib.import_module("music_app.server_tls")

    def denied(*args):
        raise PermissionError("test write denied")

    monkeypatch.setattr(module.os, "replace", denied)
    with pytest.raises(OSError):
        _options(tmp_path, host="10.0.0.165")
    assert path.read_bytes() == original
    assert list(path.parent.iterdir()) == [path]


def test_generated_certificate_supports_real_verified_tls_handshake(tmp_path):
    options = _options(tmp_path)
    cert = _certificate(options)
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(options["ssl_certfile"])
    client_context = ssl.create_default_context()
    client_context.load_verify_locations(cadata=cert.public_bytes(serialization.Encoding.PEM).decode())
    server_socket, client_socket = socket.socketpair()
    server_socket.settimeout(5)
    client_socket.settimeout(5)

    def serve():
        with server_socket, server_context.wrap_socket(server_socket, server_side=True) as connection:
            assert connection.recv(4) == b"ping"
            connection.sendall(b"pong")

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(serve)
        with client_socket, client_context.wrap_socket(client_socket, server_hostname="10.0.0.164") as connection:
            connection.sendall(b"ping")
            assert connection.recv(4) == b"pong"
        future.result(timeout=5)


@pytest.mark.parametrize("reload", [False, True])
@pytest.mark.parametrize("host, bind", [("10.0.0.164", "0.0.0.0"), ("[::1]", "::")])
def test_normal_launcher_serves_https_on_requested_port(tmp_path, monkeypatch, reload, host, bind):
    import app
    import config
    import uvicorn

    calls = []
    monkeypatch.setenv("MUSIC_APP_TLS_MODE", "local")
    monkeypatch.setenv("ALBUM_HAVEN_PUBLIC_BASE_URL", f"https://{host}:5000")
    monkeypatch.delenv("ALBUM_HAVEN_TRUSTED_PROXIES", raising=False)
    monkeypatch.setattr(config.Config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(uvicorn, "run", lambda target, **kwargs: calls.append((target, kwargs)))
    app._run_asgi_server(port=5000, reload=reload)
    target, options = calls[0]
    assert target == "music_app:create_asgi_app"
    assert options["port"] == 5000
    assert options["host"] == bind
    assert options["factory"] is True
    assert options["reload"] is reload
    assert options["proxy_headers"] is False
    assert Path(options["ssl_certfile"]).is_file()
