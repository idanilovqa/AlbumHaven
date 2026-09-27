"""Provision only a NEW claimable demo database; never use another deployment.

The encrypted receipt lets an operator transfer the new URL into Render's
secret environment without printing database credentials or the claim token.
This module runs at deployment build time, not inside the application.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / '.capabilities-demo-database.enc'


def validate_database_url(value: str, expected_host: str) -> str:
    try:
        url = urlsplit(value)
        query = parse_qs(url.query, keep_blank_values=True)
        valid = (
            url.scheme in {'postgres', 'postgresql'} and url.hostname == expected_host
            and bool(expected_host) and expected_host.endswith('.neon.tech')
            and url.port in {None, 5432} and bool(url.username) and bool(url.password)
            and url.path == '/neondb' and not url.fragment
            and set(query) <= {'sslmode', 'channel_binding'}
            and query.get('sslmode') in [['require'], ['verify-full']]
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError('Expected the dedicated capabilities Neon database with TLS; refusing other hosts or databases.')
    return value


def read_database_configuration() -> dict[str, str]:
    explicit = os.environ.get('ALBUM_HAVEN_CAPS_DATABASE_URL', '')
    if explicit:
        host = os.environ.get('ALBUM_HAVEN_CAPS_DATABASE_HOST', '')
        return {'connection_string': validate_database_url(explicit, host)}
    from cryptography.fernet import Fernet
    key = os.environ.get('ALBUM_HAVEN_CAPS_BOOTSTRAP_KEY', '')
    if not key or not RECEIPT.is_file():
        raise ValueError('A dedicated capabilities database has not been configured.')
    payload = json.loads(Fernet(key.encode()).decrypt(RECEIPT.read_bytes()))
    value = payload['connection_string']
    validate_database_url(value, urlsplit(value).hostname or '')
    return payload


def provision() -> None:
    if os.environ.get('ALBUM_HAVEN_CAPS_DATABASE_URL'):
        read_database_configuration()
        print('Capabilities database: using the explicitly configured dedicated database.', flush=True)
        return
    if os.environ.get('ALBUM_HAVEN_CAPS_CREATE_CLAIMABLE') != '1':
        raise ValueError('Explicit claimable-database provisioning consent is required.')
    from cryptography.fernet import Fernet
    key = os.environ['ALBUM_HAVEN_CAPS_BOOTSTRAP_KEY'].encode()
    cipher = Fernet(key)
    cache = Path.home() / '.cache' / 'albumhaven-capabilities' / hashlib.sha256(key).hexdigest()
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.is_file():
        envelope = cache.read_bytes()
        cipher.decrypt(envelope)
    else:
        request = Request('https://neon.new/api/v1/database',
            data=json.dumps({'ref': 'albumhaven-capabilities-demo'}).encode(),
            headers={'Content-Type': 'application/json', 'User-Agent': 'AlbumHavenCapabilitiesDemo/1.0'},
            method='POST')
        with urlopen(request, timeout=90) as response:
            payload = json.loads(response.read(65536))
        value = payload['connection_string']
        validate_database_url(value, urlsplit(value).hostname or '')
        receipt = {key: payload[key] for key in ('connection_string', 'claim_url', 'expires_at', 'neon_project_id') if key in payload}
        if not receipt.get('claim_url') or not receipt.get('expires_at'):
            raise ValueError('The provider did not return a claim URL and expiration.')
        envelope = cipher.encrypt(json.dumps(receipt).encode())
        cache.write_bytes(envelope)
        cache.chmod(0o600)
    RECEIPT.write_bytes(envelope)
    RECEIPT.chmod(0o600)
    print('CAPS_DEMO_ENCRYPTED_RECEIPT=' + envelope.decode(), flush=True)
    print('Capabilities database provisioned separately. Claim it before the 72-hour expiration.', flush=True)


if __name__ == '__main__':
    try:
        provision()
    except Exception as exc:
        print(f'Capabilities database provisioning failed ({type(exc).__name__}, HTTP {getattr(exc, "code", "n/a")}). No credentials logged.', flush=True)
        raise SystemExit(1)
