"""Interactively provision the retained Rendref owner credential."""

from __future__ import annotations

import getpass
import os
from pathlib import Path
import sys
import warnings
from collections.abc import Callable, Mapping, Sequence
from typing import Any, TextIO


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    getpass_fn: Callable[..., str] | None = None,
    config_builder: Callable[[Mapping[str, str]], dict[str, Any]] | None = None,
    breached_checker: Callable[[str], bool] | None = None,
    password_hasher: Callable[..., Any] | None = None,
    bootstrap_service_factory: Callable[[Mapping[str, object]], Any] | None = None,
) -> int:
    """Provision once without accepting password material from process inputs."""

    arguments = tuple(sys.argv[1:] if argv is None else argv)
    input_stream = sys.stdin if stdin is None else stdin
    output_stream = sys.stdout if stdout is None else stdout
    error_stream = sys.stderr if stderr is None else stderr
    environment = os.environ if environ is None else environ

    if arguments:
        print("This command accepts no command-line arguments.", file=error_stream)
        return 2

    if config_builder is None:
        from config import build_auth_config

        config_builder = build_auth_config
    try:
        config = config_builder(environment)
        if not config.get("ALBUM_HAVEN_APP_DATABASE_URL"):
            config["ALBUM_HAVEN_APP_DATABASE_URL"] = str(
                environment.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
            ).strip()
    except Exception:
        print("Bootstrap configuration is invalid.", file=error_stream)
        return 2

    if not callable(getattr(input_stream, "isatty", None)) or not input_stream.isatty():
        print("Bootstrap password entry requires an interactive TTY.", file=error_stream)
        return 2

    password_reader = getpass.getpass if getpass_fn is None else getpass_fn
    password = ""
    confirmation = ""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = password_reader(
                "Initial password for Rendref: ", stream=error_stream
            )
            confirmation = password_reader(
                "Confirm initial password: ", stream=error_stream
            )
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        password = ""
        confirmation = ""
        print("Bootstrap password entry was cancelled.", file=error_stream)
        return 2
    if password != confirmation:
        print("Bootstrap password confirmation did not match.", file=error_stream)
        return 2

    if breached_checker is None:
        from music_app.services.auth_breached_passwords import (
            HibpRangePasswordChecker,
        )

        breached_checker = HibpRangePasswordChecker()
    if password_hasher is None:
        from music_app.services.auth_passwords import hash_password

        password_hasher = hash_password

    try:
        credential = password_hasher(
            password,
            username=str(config["bootstrap_username_display"]),
            email=str(config["bootstrap_email_normalized"]),
            breached_checker=breached_checker,
            argon2=config["argon2"],
            policy_version=int(config["argon2_policy_version"]),
        )
    except Exception:
        print("Bootstrap password was not accepted.", file=error_stream)
        return 2
    finally:
        password = ""
        confirmation = ""

    if bootstrap_service_factory is None:
        from music_app.services.auth_bootstrap_postgres import (
            PostgresAuthBootstrapService,
        )

        bootstrap_service_factory = PostgresAuthBootstrapService
    try:
        service = bootstrap_service_factory(config)
        result = service.reconcile_owner(
            encoded_hash=credential.encoded_hash,
            hash_policy_version=credential.policy_version,
        )
    except Exception:
        print("Rendref bootstrap provisioning failed.", file=error_stream)
        return 1

    if not result.credential_created:
        print(
            "Rendref already provisioned; supplied password was not installed; "
            f"account {result.account_id}, library {result.library_id}.",
            file=output_stream,
        )
        return 3
    print(
        f"Rendref provisioned; account {result.account_id}, "
        f"library {result.library_id}.",
        file=output_stream,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
