"""Startup-only HTTPS for local testing; never installs certificate trust."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
import ipaddress
import os
from pathlib import Path
import ssl
import tempfile
from urllib.parse import urlsplit

from music_app.services.auth_config import validate_public_base_url


def local_https_options(
    environ: Mapping[str, str], *, data_dir: Path, port: int
) -> dict[str, object]:
    """Prepare local key material and return options for the direct ASGI server."""
    mode = environ.get("MUSIC_APP_TLS_MODE", "off").strip().lower()
    if mode == "off":
        return {}
    if mode != "local":
        raise ValueError("MUSIC_APP_TLS_MODE must be 'off' or 'local'.")

    url = urlsplit(validate_public_base_url(environ.get("ALBUM_HAVEN_PUBLIC_BASE_URL", "")))
    if url.path or (url.port or 443) != port:
        raise ValueError(
            "Local HTTPS requires ALBUM_HAVEN_PUBLIC_BASE_URL to have no path "
            "and to use MUSIC_APP_PORT (5000 by default)."
        )
    if environ.get("ALBUM_HAVEN_TRUSTED_PROXIES", "").strip():
        raise ValueError(
            "Local HTTPS serves devices directly; unset ALBUM_HAVEN_TRUSTED_PROXIES. "
            "For an HTTPS reverse proxy, use MUSIC_APP_TLS_MODE=off."
        )

    # Import only in local mode: existing HTTP/proxy startup needs no TLS tooling.
    from cryptography import x509

    try:
        identity = x509.IPAddress(ipaddress.ip_address(url.hostname))
    except ValueError:
        identity = x509.DNSName(url.hostname)
    names = x509.SubjectAlternativeName([identity])
    now = datetime.now(timezone.utc)
    directory = Path(data_dir) / "tls"
    pem_path = directory / "local-server.pem"
    options = {
        "ssl_certfile": str(pem_path),
        "proxy_headers": False,
        "host": "::" if isinstance(identity, x509.IPAddress) and identity.value.version == 6 else "0.0.0.0",
    }
    if pem_path.exists():
        try:
            cert = x509.load_pem_x509_certificate(pem_path.read_bytes())
            # Also verifies that the private key is present and matches the cert.
            ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(str(pem_path), password="")
            existing_names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        except (ValueError, ssl.SSLError, x509.ExtensionNotFound) as exc:
            raise ValueError(
                "Local HTTPS certificate is invalid. Remove tls/local-server.pem "
                "from the app data directory and restart to generate a new certificate."
            ) from exc
        if (existing_names == names
                and cert.not_valid_before_utc <= now
                and cert.not_valid_after_utc > now + timedelta(days=7)):
            return options

    pem = _create_server_pem(names, now)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # On Windows the app-data directory's ACL governs access. On POSIX keep
    # private key material owner-only, independent of the process umask.
    if os.name != "nt":
        directory.chmod(0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".local-server-", suffix=".pem", dir=directory)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(pem)
            destination.flush()
            os.fsync(destination.fileno())
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(str(temporary_path), password="")
        os.replace(temporary_path, pem_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return options


def _create_server_pem(names, now: datetime) -> bytes:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Album Haven local testing")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=90))
        .add_extension(names, critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=False, key_encipherment=True,
            data_encipherment=False, key_agreement=False, key_cert_sign=False,
            crl_sign=False, encipher_only=False, decipher_only=False,
        ), critical=True)
        .sign(key, hashes.SHA256())
    )
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ) + certificate.public_bytes(serialization.Encoding.PEM)
