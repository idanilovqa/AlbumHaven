"""Start Album Haven with existing mkcert files, without shell SSL variables."""

import argparse
import logging
import os
from pathlib import Path
import ssl
import sys


GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS = 5
_WINDOWS_PROACTOR_CONNECTION_LOST = (
    "Exception in callback _ProactorBasePipeTransport._call_connection_lost"
)


class _WindowsProactorConnectionResetFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        error = record.exc_info[1] if record.exc_info else None
        return not (
            isinstance(error, ConnectionResetError)
            and getattr(error, "winerror", None) == 10054
            and record.getMessage().startswith(_WINDOWS_PROACTOR_CONNECTION_LOST)
        )


def build_https_options(data_dir: Path, port: int) -> dict[str, object]:
    if not 1 <= port <= 65535:
        raise ValueError("MUSIC_APP_PORT must be a port between 1 and 65535.")
    directory = Path(data_dir).expanduser().resolve() / "tls"
    certificate = directory / "trusted-server.pem"
    key = directory / "trusted-server-key.pem"
    for path in (certificate, key):
        if not path.is_file():
            raise ValueError(
                f"Missing HTTPS file: {path}. "
                "Create the trusted certificate pair first; see docs/start-https.md."
            )
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(
            str(certificate), str(key), password=""
        )
    except (OSError, ValueError) as exc:
        raise ValueError(
            "The trusted HTTPS certificate/key pair cannot be loaded. "
            "Check that the files are readable, match, and have an unencrypted key. "
            "No certificate files were changed."
        ) from exc
    return {
        "host": "0.0.0.0", "port": port, "proxy_headers": False,
        "ssl_certfile": str(certificate), "ssl_keyfile": str(key),
        "ssl_keyfile_password": "",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check certificate paths/key pair without starting the server.")
    args = parser.parse_args(argv)
    try:
        # Config loads the repository's .env, independent of the working directory.
        from config import Config

        if os.environ.get("ALBUM_HAVEN_TRUSTED_PROXIES", "").strip():
            raise ValueError(
                "This launcher serves HTTPS directly. Unset "
                "ALBUM_HAVEN_TRUSTED_PROXIES; use the regular proxy deployment "
                "launcher when running behind a reverse proxy."
            )
        port = int(os.environ.get("MUSIC_APP_PORT", "5000").strip() or "5000")
        options = build_https_options(Config.DATA_DIR, port)
    except (OSError, ValueError) as exc:
        print(f"HTTPS startup failed: {exc}", file=sys.stderr)
        return 1
    if args.check:
        print("HTTPS certificate files found; certificate and private key match.")
        print("This check does not verify browser trust or certificate expiry/hostnames.")
        return 0
    print(f"Album Haven HTTPS: https://localhost:{port}/login", flush=True)
    print("Using existing trusted-server.pem and trusted-server-key.pem. Press Ctrl+C to stop.", flush=True)
    import uvicorn

    asyncio_logger = logging.getLogger("asyncio")
    connection_reset_filter = _WindowsProactorConnectionResetFilter()
    if sys.platform == "win32":
        asyncio_logger.addFilter(connection_reset_filter)
    try:
        uvicorn.run(
            "music_app:create_asgi_app",
            factory=True,
            timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS,
            **options,
        )
    finally:
        if sys.platform == "win32":
            asyncio_logger.removeFilter(connection_reset_filter)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
