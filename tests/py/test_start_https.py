"""Trusted HTTPS launcher checks use temporary keys and never start the app."""

from datetime import datetime, timedelta, timezone
import importlib
from pathlib import Path
import ssl

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
import pytest


@pytest.fixture
def certificate_dir(tmp_path):
    directory = tmp_path / "data with spaces" / "tls"
    directory.mkdir(parents=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), False)
            .sign(key, hashes.SHA256()))
    (directory / "trusted-server.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (directory / "trusted-server-key.pem").write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    return directory


def test_resolves_certificate_paths_without_shell_variable(certificate_dir, monkeypatch, tmp_path):
    module = importlib.import_module("start_https")
    monkeypatch.chdir(tmp_path)
    options = module.build_https_options(certificate_dir.parent, 5000)
    assert options == {
        "host": "0.0.0.0", "port": 5000, "proxy_headers": False,
        "ssl_certfile": str(certificate_dir / "trusted-server.pem"),
        "ssl_keyfile": str(certificate_dir / "trusted-server-key.pem"),
        "ssl_keyfile_password": "",
    }
    ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(
        options["ssl_certfile"], options["ssl_keyfile"], password="")


@pytest.mark.parametrize("missing", ["trusted-server.pem", "trusted-server-key.pem"])
def test_missing_file_is_actionable_without_regeneration(certificate_dir, missing):
    module = importlib.import_module("start_https")
    (certificate_dir / missing).unlink()
    before = sorted(path.name for path in certificate_dir.iterdir())
    with pytest.raises(ValueError, match=missing):
        module.build_https_options(certificate_dir.parent, 5000)
    assert sorted(path.name for path in certificate_dir.iterdir()) == before


def test_invalid_key_fails_without_overwriting(certificate_dir):
    module = importlib.import_module("start_https")
    key_path = certificate_dir / "trusted-server-key.pem"
    key_path.write_text("not a private key", encoding="utf-8")
    with pytest.raises(ValueError, match="cannot be loaded"):
        module.build_https_options(certificate_dir.parent, 5000)
    assert key_path.read_text() == "not a private key"


@pytest.mark.parametrize("port", [0, 65536])
def test_invalid_port_rejected(certificate_dir, port):
    module = importlib.import_module("start_https")
    with pytest.raises(ValueError, match="port"):
        module.build_https_options(certificate_dir.parent, port)


@pytest.mark.parametrize("check_only", [False, True])
def test_main_loads_config_and_launches_only_when_requested(certificate_dir, monkeypatch, check_only):
    module = importlib.import_module("start_https")
    from config import Config
    import uvicorn
    monkeypatch.setattr(Config, "DATA_DIR", certificate_dir.parent)
    monkeypatch.setenv("MUSIC_APP_PORT", "5443")
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    assert module.main(["--check"] if check_only else []) == 0
    assert len(calls) == (0 if check_only else 1)
    if calls:
        assert calls[0][0] == ("music_app:create_asgi_app",)
        assert calls[0][1]["factory"] is True
        assert calls[0][1]["port"] == 5443
        assert calls[0][1]["proxy_headers"] is False


def test_main_missing_certificate_returns_clean_error(tmp_path, monkeypatch, capsys):
    module = importlib.import_module("start_https")
    from config import Config
    monkeypatch.setattr(Config, "DATA_DIR", tmp_path)
    assert module.main(["--check"]) == 1
    assert "HTTPS startup failed:" in capsys.readouterr().err


def test_direct_launcher_rejects_proxy_trust_before_starting(certificate_dir, monkeypatch, capsys):
    module = importlib.import_module("start_https")
    from config import Config
    import uvicorn
    monkeypatch.setattr(Config, "DATA_DIR", certificate_dir.parent)
    monkeypatch.setenv("ALBUM_HAVEN_TRUSTED_PROXIES", "127.0.0.1")
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs)))
    assert module.main([]) == 1
    assert "ALBUM_HAVEN_TRUSTED_PROXIES" in capsys.readouterr().err
    assert calls == []
