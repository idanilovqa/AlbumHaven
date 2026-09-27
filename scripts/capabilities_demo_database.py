"""Validate the separately provisioned capabilities demo database.

Render's free database slot may belong to the mobile demo. This deployment
therefore requires its OWN Neon project and direct TLS database connection.
No database is automatically created, replaced, or borrowed from another app.
"""
from __future__ import annotations

import os
from urllib.parse import parse_qs, urlsplit


def validate_database_url(value: str, expected_host: str) -> str:
    try:
        url = urlsplit(value)
        query = parse_qs(url.query, keep_blank_values=True)
        valid = (
            url.scheme in {'postgres', 'postgresql'} and url.hostname == expected_host
            and bool(expected_host) and expected_host.endswith('.neon.tech')
            and '-pooler.' not in expected_host
            and url.port in {None, 5432} and bool(url.username) and bool(url.password)
            and url.path == '/neondb' and not url.fragment
            and set(query) <= {'sslmode', 'channel_binding'}
            and query.get('sslmode') in [['require'], ['verify-full']]
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError('Use the dedicated capabilities Neon neondb direct TLS URL and matching host; pooled, mobile and other databases are refused.')
    return value


def read_database_configuration() -> dict[str, str]:
    value = os.environ.get('ALBUM_HAVEN_CAPS_DATABASE_URL', '')
    host = os.environ.get('ALBUM_HAVEN_CAPS_DATABASE_HOST', '')
    if not value or not host:
        raise ValueError('Set ALBUM_HAVEN_CAPS_DATABASE_URL and ALBUM_HAVEN_CAPS_DATABASE_HOST for a new, separate Neon project before deploying.')
    return {'connection_string': validate_database_url(value, host)}


if __name__ == '__main__':
    try:
        read_database_configuration()
        print('Separate capabilities database configuration validated; credentials not logged.', flush=True)
    except ValueError as exc:
        print(str(exc), flush=True)
        raise SystemExit(1)
