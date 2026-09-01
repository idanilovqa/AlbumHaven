from __future__ import annotations

import getpass
import io
from importlib import import_module, util
from pathlib import Path
from types import SimpleNamespace

import pytest


MODULE = "scripts.break_glass_auth_owner"
PASSWORD = "a sufficiently private emergency owner passphrase"
ENCODED_HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$ZGlnaWVzdA"


def test_break_glass_owner_script_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 operator entry point: scripts/break_glass_auth_owner.py"
    )


@pytest.fixture
def break_glass_script():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
    return import_module(MODULE)


class GuardedInput:
    def __init__(self, *, tty: bool = True):
        self.tty = tty

    def isatty(self):
        return self.tty

    def read(self, *_args, **_kwargs):
        raise AssertionError("break-glass recovery must never read a password from stdin")

    def readline(self, *_args, **_kwargs):
        raise AssertionError("break-glass recovery must never read a password from stdin")


def _dependencies(*, passwords=(PASSWORD, PASSWORD)):
    events = []
    prompts = []
    output = io.StringIO()
    errors = io.StringIO()
    supplied = iter(passwords)
    environment = {
        "ALBUM_HAVEN_BOOTSTRAP_USERNAME": "Rendref",
        "ALBUM_HAVEN_BOOTSTRAP_EMAIL": "Rendref+owner@example.test",
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "ALBUM_HAVEN_BREAK_GLASS_PASSWORD": "must-not-be-read-from-env",
    }
    config = {
        "bootstrap_username_display": "Rendref",
        "bootstrap_email_normalized": "Rendref+owner@example.test",
        "argon2": {
            "memory_cost": 65_536,
            "time_cost": 3,
            "parallelism": 1,
            "salt_len": 16,
            "hash_len": 32,
        },
        "argon2_policy_version": 7,
        "ALBUM_HAVEN_APP_DATABASE_URL": environment["ALBUM_HAVEN_APP_DATABASE_URL"],
    }

    def getpass_fn(prompt, *, stream=None):
        prompts.append((prompt, stream))
        events.append("getpass")
        return next(supplied)

    def config_builder(received):
        events.append("config")
        assert received is environment
        return config

    def breached_checker(raw):
        events.append("breach")
        assert raw == PASSWORD
        return False

    def password_hasher(raw, **kwargs):
        assert raw == PASSWORD
        assert kwargs["username"] == "Rendref"
        assert kwargs["email"] == "Rendref+owner@example.test"
        assert kwargs["breached_checker"] is breached_checker
        assert kwargs["argon2"] is config["argon2"]
        assert kwargs["breached_checker"](raw) is False
        events.append("hash")
        return SimpleNamespace(encoded_hash=ENCODED_HASH, policy_version=7)

    class Service:
        def reset_owner(self, **kwargs):
            events.append("reset")
            assert kwargs["encoded_hash"] == ENCODED_HASH
            assert kwargs["hash_policy_version"] == 7
            assert isinstance(kwargs["request_ref"], str)
            assert kwargs["request_ref"]
            return SimpleNamespace(
                account_id=41,
                credential_version=8,
                revoked_sessions=3,
                revoked_reset_tokens=2,
            )

    def service_factory(received):
        events.append("service")
        assert received is config
        return Service()

    return SimpleNamespace(
        events=events,
        prompts=prompts,
        stdout=output,
        stderr=errors,
        environment=environment,
        config_builder=config_builder,
        getpass_fn=getpass_fn,
        breached_checker=breached_checker,
        password_hasher=password_hasher,
        service_factory=service_factory,
    )


def _main(module, dependencies, *, argv=(), stdin=None):
    return module.main(
        list(argv),
        environ=dependencies.environment,
        stdin=stdin or GuardedInput(),
        stdout=dependencies.stdout,
        stderr=dependencies.stderr,
        getpass_fn=dependencies.getpass_fn,
        config_builder=dependencies.config_builder,
        breached_checker=dependencies.breached_checker,
        password_hasher=dependencies.password_hasher,
        break_glass_service_factory=dependencies.service_factory,
    )


def test_break_glass_reads_twice_and_hashes_before_database(break_glass_script):
    dependencies = _dependencies()

    assert _main(break_glass_script, dependencies) == 0

    assert dependencies.events == [
        "config",
        "getpass",
        "getpass",
        "breach",
        "hash",
        "service",
        "reset",
    ]
    assert len(dependencies.prompts) == 2
    assert all(stream is dependencies.stderr for _, stream in dependencies.prompts)


def test_break_glass_rejects_all_argv_before_config_or_password_access(
    break_glass_script,
):
    dependencies = _dependencies()

    assert _main(break_glass_script, dependencies, argv=("--password", PASSWORD)) != 0

    assert dependencies.events == []
    combined = dependencies.stdout.getvalue() + dependencies.stderr.getvalue()
    assert PASSWORD not in combined


@pytest.mark.parametrize("tty", [False, None])
def test_break_glass_requires_a_real_input_tty_before_prompting(
    break_glass_script, tty
):
    dependencies = _dependencies()

    assert _main(
        break_glass_script,
        dependencies,
        stdin=GuardedInput(tty=bool(tty)),
    ) != 0

    assert "getpass" not in dependencies.events
    assert "TTY" in dependencies.stderr.getvalue()


def test_break_glass_ignores_password_environment_and_never_reads_stdin(
    break_glass_script,
):
    dependencies = _dependencies()

    assert _main(break_glass_script, dependencies, stdin=GuardedInput()) == 0

    assert dependencies.environment["ALBUM_HAVEN_BREAK_GLASS_PASSWORD"] != PASSWORD
    assert dependencies.events.count("getpass") == 2


def test_break_glass_confirmation_mismatch_fails_before_screen_hash_or_database(
    break_glass_script,
):
    dependencies = _dependencies(passwords=(PASSWORD, PASSWORD + "!"))

    assert _main(break_glass_script, dependencies) != 0

    assert dependencies.events == ["config", "getpass", "getpass"]
    combined = dependencies.stdout.getvalue() + dependencies.stderr.getvalue()
    assert PASSWORD not in combined


def test_break_glass_getpass_echo_fallback_fails_closed(break_glass_script):
    dependencies = _dependencies()

    def unsafe_fallback(_prompt, *, stream=None):
        import warnings

        warnings.warn("echo fallback", getpass.GetPassWarning)
        return PASSWORD

    dependencies.getpass_fn = unsafe_fallback

    assert _main(break_glass_script, dependencies) != 0
    assert "hash" not in dependencies.events
    assert "reset" not in dependencies.events


def test_break_glass_failures_are_generic_and_secret_free(break_glass_script):
    dependencies = _dependencies()

    def fail_hash(raw, **_kwargs):
        raise ValueError(f"rejected {raw}")

    dependencies.password_hasher = fail_hash

    assert _main(break_glass_script, dependencies) != 0
    combined = dependencies.stdout.getvalue() + dependencies.stderr.getvalue()
    assert PASSWORD not in combined
    assert ENCODED_HASH not in combined
    assert "reset" not in dependencies.events


def test_break_glass_success_output_is_non_secret(break_glass_script):
    dependencies = _dependencies()

    assert _main(break_glass_script, dependencies) == 0

    rendered = dependencies.stdout.getvalue()
    assert "account 41" in rendered
    assert "3 sessions" in rendered
    assert "2 reset tokens" in rendered
    for secret in (PASSWORD, ENCODED_HASH, "Rendref+owner@example.test"):
        assert secret not in rendered
    assert dependencies.stderr.getvalue() == ""


def test_break_glass_main_guard_has_no_password_flags_or_environment_reads():
    source = Path(__file__).resolve().parents[2] / "scripts" / "break_glass_auth_owner.py"
    if not source.exists():
        pytest.skip("presence test covers the RED contract")
    text = source.read_text(encoding="utf-8")
    assert "ALBUM_HAVEN_BREAK_GLASS_PASSWORD" not in text
    assert "argparse" not in text
