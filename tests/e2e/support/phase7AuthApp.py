from __future__ import annotations

import argparse
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socketserver
import tempfile
import threading
from typing import Any, Callable

from isolatedLibraryApp import configure_isolated_environment
from isolatedPostgres import (
    IsolatedDatabaseOwnershipLock,
    prepare_isolated_database,
    reset_application_tables,
    resolve_isolated_database_urls,
    seed_bootstrap_owner_and_library,
)


OWNER_PASSWORD = "Phase Seven Owner Passphrase 2026!"


class CaptureState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._messages: list[bytes] = []
        self.delivery_gate = threading.Event()
        self.delivery_gate.set()
        self.reset_fixture: Callable[[], None] | None = None
        self.database_action: Callable[[str], None] | None = None
        self.database_state: Callable[[], dict[str, object]] | None = None

    def add(self, payload: bytes) -> None:
        if not self.delivery_gate.wait(timeout=30):
            raise TimeoutError("Fake SMTP delivery remained paused.")
        with self._lock:
            self._messages.append(payload)

    def clear(self) -> None:
        with self._lock:
            self._messages.clear()

    def payload(self) -> list[dict[str, object]]:
        with self._lock:
            messages = list(self._messages)
        result = []
        for raw in messages:
            message = BytesParser(policy=policy.default).parsebytes(raw)
            bodies = []
            if message.is_multipart():
                for part in message.walk():
                    if part.get_content_type() in {"text/plain", "text/html"}:
                        bodies.append(str(part.get_content()))
            else:
                bodies.append(str(message.get_content()))
            result.append(
                {
                    "to": str(message.get("To") or ""),
                    "subject": str(message.get("Subject") or ""),
                    "body": "\n".join(bodies),
                }
            )
        return result


class _SMTPHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self._write("220 Album Haven E2E SMTP")
        while True:
            raw = self.rfile.readline(65_537)
            if not raw:
                return
            command = raw.decode("ascii", errors="replace").rstrip("\r\n")
            verb = command.split(" ", 1)[0].upper()
            if verb in {"EHLO", "HELO"}:
                self._write("250-localhost")
                self._write("250 SIZE 65536")
            elif verb in {"MAIL", "RCPT", "RSET", "NOOP"}:
                self._write("250 OK")
            elif verb == "DATA":
                self._write("354 End data with <CR><LF>.<CR><LF>")
                lines: list[bytes] = []
                while True:
                    line = self.rfile.readline(65_537)
                    if not line or line in {b".\r\n", b".\n"}:
                        break
                    lines.append(line[1:] if line.startswith(b"..") else line)
                self.server.capture_state.add(b"".join(lines))
                self._write("250 Captured")
            elif verb == "QUIT":
                self._write("221 Bye")
                return
            else:
                self._write("502 Command not implemented")

    def _write(self, value: str) -> None:
        self.wfile.write(value.encode("ascii") + b"\r\n")
        self.wfile.flush()


class _SMTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], state: CaptureState):
        self.capture_state = state
        super().__init__(address, _SMTPHandler)


class _ControlHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/range/"):
            body = ("0" * 35 + ":1\r\n").encode("ascii")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/messages":
            self._json(200, {"messages": self.server.capture_state.payload()})
            return
        if self.path == "/state" and self.server.capture_state.database_state is not None:
            self._json(200, self.server.capture_state.database_state())
            return
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        state = self.server.capture_state
        try:
            if self.path == "/reset":
                state.delivery_gate.set()
                state.clear()
                if state.reset_fixture is None:
                    raise RuntimeError("Fixture reset is unavailable.")
                state.reset_fixture()
            elif self.path == "/smtp/hold":
                state.delivery_gate.clear()
            elif self.path == "/smtp/release":
                state.delivery_gate.set()
            elif self.path.startswith("/database/"):
                if state.database_action is None:
                    raise RuntimeError("Database controls are unavailable.")
                state.database_action(self.path.removeprefix("/database/"))
            else:
                self.send_error(404)
                return
        except Exception as exc:
            self._json(500, {"detail": str(exc)})
            return
        self._json(200, {"ok": True})

    def _json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _ControlServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], state: CaptureState):
        self.capture_state = state
        super().__init__(address, _ControlHandler)


def _configure_environment(
    temp_root: Path,
    runtime_database_url: str,
    *,
    app_port: int,
    smtp_port: int,
    control_port: int,
) -> None:
    configure_isolated_environment(temp_root, runtime_database_url, smtp_port)
    os.environ.update(
        {
            "ALBUM_HAVEN_BOOTSTRAP_USERNAME": "Rendref",
            "ALBUM_HAVEN_BOOTSTRAP_EMAIL": "rendref@example.test",
            "ALBUM_HAVEN_PUBLIC_BASE_URL": f"https://127.0.0.1:{app_port}",
            "ALBUM_HAVEN_AUTH_HMAC_SECRET": "phase7-e2e-hmac-secret-0123456789abcdef0123456789abcdef",
            "ALBUM_HAVEN_AUTH_HMAC_KEY_VERSION": "1",
            "ALBUM_HAVEN_WELCOME_EMAIL_ENABLED": "true",
            "ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED": "true",
            "ALBUM_HAVEN_SMTP_HOST": "127.0.0.1",
            "ALBUM_HAVEN_SMTP_PORT": str(smtp_port),
            "ALBUM_HAVEN_SMTP_SECURITY": "plaintext",
            "ALBUM_HAVEN_SMTP_ALLOW_PLAINTEXT_LOOPBACK": "true",
            "ALBUM_HAVEN_SMTP_FROM_ADDRESS": "album-haven@example.test",
            "ALBUM_HAVEN_SMTP_FROM_NAME": "Album Haven E2E",
            "ALBUM_HAVEN_HIBP_RANGE_URL_TEMPLATE": (
                f"http://127.0.0.1:{control_port}/range/{{}}"
            ),
        }
    )


def _bootstrap_owner(runtime_database_url: str) -> None:
    from config import build_auth_config
    from music_app.services.auth_bootstrap_postgres import PostgresAuthBootstrapService
    from music_app.services.auth_passwords import hash_password

    config = build_auth_config()
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = runtime_database_url
    credential = hash_password(
        OWNER_PASSWORD,
        username="Rendref",
        email="rendref@example.test",
        breached_checker=lambda _password: False,
        argon2=config["argon2"],
        policy_version=config["argon2_policy_version"],
    )
    PostgresAuthBootstrapService(config).reconcile_owner(
        encoded_hash=credential.encoded_hash,
        hash_policy_version=credential.policy_version,
    )


def _database_action(setup_database_url: str, action: str) -> None:
    import psycopg

    statements = {
        "disable-owner": """
            update app.accounts set is_active = false, disabled_at = now(),
              disabled_reason = 'e2e_control' where username_normalized = 'rendref'
        """,
        "revoke-owner-sessions": """
            update app.account_sessions set revoked_at = now(),
              revocation_reason = 'e2e_control'
            where account_id = (select id from app.accounts where username_normalized = 'rendref')
              and revoked_at is null
        """,
        "expire-owner-sessions": """
            update app.account_sessions set idle_expires_at = now() - interval '1 second'
            where account_id = (select id from app.accounts where username_normalized = 'rendref')
              and revoked_at is null
        """,
    }
    statement = statements.get(action)
    if statement is None:
        raise ValueError("Unknown database control action.")
    with psycopg.connect(setup_database_url) as connection:
        connection.execute(statement)


def _database_state(setup_database_url: str) -> dict[str, object]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(setup_database_url, row_factory=dict_row) as connection:
        owner = connection.execute(
            """
            select account.id, account.is_active, library.id as library_id,
                   library.owner_account_id,
                   count(session.id) filter (where session.revoked_at is null
                     and session.idle_expires_at > now()
                     and session.absolute_expires_at > now()) as active_sessions
            from app.accounts account
            join app.bootstrap_owners owner on owner.account_id = account.id
            join library.libraries library on library.owner_account_id = account.id
            left join app.account_sessions session on session.account_id = account.id
            where owner.owner_key = 'local-bootstrap-owner'
            group by account.id, library.id
            """
        ).fetchone()
        accounts = connection.execute(
            """
            select id, username_display, contact_email, is_active
            from app.accounts order by id
            """
        ).fetchall()
        throttles = connection.execute(
            """
            select bucket_kind, failure_count, blocked_until is not null as blocked
            from app.auth_throttles order by bucket_kind
            """
        ).fetchall()
        preauth = connection.execute(
            """
            select purpose, consumed_at is not null as consumed
            from app.auth_preflight_tokens order by id
            """
        ).fetchall()
        reset_tokens = connection.execute(
            """
            select purpose, consumed_at is not null as consumed,
                   revoked_at is not null as revoked
            from app.password_reset_tokens order by id
            """
        ).fetchall()
        outbox = connection.execute(
            """
            select message_category, delivery_status, attempt_count
            from app.mail_outbox order by id
            """
        ).fetchall()
    return {
        "owner": dict(owner or {}),
        "accounts": [dict(row) for row in accounts],
        "throttles": [dict(row) for row in throttles],
        "preauth": [dict(row) for row in preauth],
        "reset_tokens": [dict(row) for row in reset_tokens],
        "outbox": [dict(row) for row in outbox],
    }


def _start_thread(server: Any, name: str) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, name=name, daemon=True)
    thread.start()
    return thread


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--smtp-port", type=int, required=True)
    parser.add_argument("--control-port", type=int, required=True)
    parser.add_argument("--worker-port", type=int)
    args = parser.parse_args()

    setup_database_url, runtime_database_url = resolve_isolated_database_urls()
    temp_root = Path(tempfile.mkdtemp(prefix="album-haven-phase7-e2e-"))
    database_lock = IsolatedDatabaseOwnershipLock()
    state = CaptureState()
    smtp_server = _SMTPServer(("127.0.0.1", args.smtp_port), state)
    control_server = _ControlServer(("127.0.0.1", args.control_port), state)
    started_servers: list[Any] = []
    application_servers: list[tuple[Any, threading.Thread]] = []
    original_failure: BaseException | None = None
    try:
        database_lock.acquire()
        _configure_environment(
            temp_root,
            runtime_database_url,
            app_port=args.port,
            smtp_port=args.smtp_port,
            control_port=args.control_port,
        )
        (temp_root / "media").mkdir(parents=True, exist_ok=True)
        prepare_isolated_database(setup_database_url, runtime_database_url)
        _bootstrap_owner(runtime_database_url)

        def reset_fixture() -> None:
            reset_application_tables(setup_database_url)
            seed_bootstrap_owner_and_library(setup_database_url)
            _bootstrap_owner(runtime_database_url)

        state.reset_fixture = reset_fixture
        state.database_action = lambda action: _database_action(
            setup_database_url, action
        )
        state.database_state = lambda: _database_state(setup_database_url)
        _start_thread(smtp_server, "album-haven-phase7-smtp")
        started_servers.append(smtp_server)
        _start_thread(control_server, "album-haven-phase7-control")
        started_servers.append(control_server)

        from music_app import create_asgi_app

        app = create_asgi_app()
        import uvicorn

        if args.worker_port is not None:
            worker_app = create_asgi_app()
            worker_server = uvicorn.Server(
                uvicorn.Config(
                    worker_app,
                    host="127.0.0.1",
                    port=args.worker_port,
                    log_level="warning",
                )
            )
            worker_thread = threading.Thread(
                target=worker_server.run,
                name="album-haven-phase7-secondary-worker",
                daemon=True,
            )
            worker_thread.start()
            application_servers.append((worker_server, worker_thread))
        print(
            f"Phase 7 production E2E app listening on http://127.0.0.1:{args.port}; "
            f"SMTP capture control on http://127.0.0.1:{args.control_port}"
            + (
                f"; secondary worker on http://127.0.0.1:{args.worker_port}"
                if args.worker_port is not None
                else ""
            ),
            flush=True,
        )
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    except BaseException as exc:
        original_failure = exc
        raise
    finally:
        for server, thread in reversed(application_servers):
            server.should_exit = True
            thread.join(timeout=10)
        for server in reversed(started_servers):
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                if original_failure is not None:
                    pass
        try:
            reset_application_tables(setup_database_url)
        finally:
            database_lock.release()
            shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
