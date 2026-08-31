from __future__ import annotations

import io
import getpass
from importlib import import_module, util
from pathlib import Path
from types import SimpleNamespace

import pytest


MODULE = "scripts.bootstrap_auth_owner"
PASSWORD = "a sufficiently private owner passphrase"
ENCODED_HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$ZGlnaWVzdA"


def test_bootstrap_owner_script_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 operator entry point: scripts/bootstrap_auth_owner.py"
    )


@pytest.fixture
def bootstrap_script():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
    return import_module(MODULE)


class GuardedInput:
    def __init__(self, *, tty=True):
        self.tty = tty

    def isatty(self):
        return self.tty

    def read(self, *_args, **_kwargs):
        raise AssertionError("bootstrap must never read a password from stdin")

    def readline(self, *_args, **_kwargs):
        raise AssertionError("bootstrap must never read a password from stdin")


def _dependencies(
    *, passwords=(PASSWORD, PASSWORD), credential_created=True, welcome_enabled=False
):
    events = []
    prompts = []
    output = io.StringIO()
    errors = io.StringIO()
    supplied = iter(passwords)
    environment = {
        "ALBUM_HAVEN_BOOTSTRAP_USERNAME": "Rendref",
        "ALBUM_HAVEN_BOOTSTRAP_EMAIL": "Rendref+owner@example.test",
        "ALBUM_HAVEN_PUBLIC_BASE_URL": "https://music.example.test",
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "ALBUM_HAVEN_BOOTSTRAP_PASSWORD": "must-not-be-read-from-env",
    }
    config = {
        "bootstrap_username_display": "Rendref",
        "bootstrap_email_normalized": "Rendref+owner@example.test",
        "argon2": {"memory_cost": 65536, "time_cost": 3, "parallelism": 1, "salt_len": 16, "hash_len": 32},
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

    def mail_config_builder(received):
        events.append("mail-config")
        assert received is environment
        return {
            "welcome_enabled": welcome_enabled,
            "public_base_url": "https://music.example.test",
        }

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
        def reconcile_owner(self, **kwargs):
            events.append("reconcile")
            assert kwargs == {"encoded_hash": ENCODED_HASH, "hash_policy_version": 7}
            return SimpleNamespace(
                account_id=41,
                library_id=73,
                credential_created=credential_created,
                welcome_queued=welcome_enabled,
                welcome_outbox_id=91 if welcome_enabled else None,
            )

    def service_factory(received):
        events.append("service")
        assert received is config
        return Service()

    def delivery_runner(outbox_id, *, config):
        events.append(("deliver-welcome", outbox_id))
        assert config["public_base_url"] == "https://music.example.test"
        return SimpleNamespace(delivered=True, reason="delivered")

    return SimpleNamespace(
        events=events,
        prompts=prompts,
        stdout=output,
        stderr=errors,
        environment=environment,
        config_builder=config_builder,
        mail_config_builder=mail_config_builder,
        getpass_fn=getpass_fn,
        breached_checker=breached_checker,
        password_hasher=password_hasher,
        service_factory=service_factory,
        delivery_runner=delivery_runner,
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
        mail_config_builder=dependencies.mail_config_builder,
        breached_checker=dependencies.breached_checker,
        password_hasher=dependencies.password_hasher,
        bootstrap_service_factory=dependencies.service_factory,
        welcome_delivery_runner=dependencies.delivery_runner,
    )


def test_bootstrap_validates_full_config_then_reads_twice_and_hashes_before_db(
    bootstrap_script,
):
    dependencies = _dependencies()

    assert _main(bootstrap_script, dependencies) == 0

    assert dependencies.events == [
        "config",
        "mail-config",
        "getpass",
        "getpass",
        "breach",
        "hash",
        "service",
        "reconcile",
    ]
    assert len(dependencies.prompts) == 2
    assert all(stream is dependencies.stderr for _, stream in dependencies.prompts)


def test_bootstrap_rejects_all_argv_before_config_or_password_access(bootstrap_script):
    dependencies = _dependencies()

    assert _main(bootstrap_script, dependencies, argv=("--password", PASSWORD)) != 0

    assert dependencies.events == []
    combined = dependencies.stdout.getvalue() + dependencies.stderr.getvalue()
    assert PASSWORD not in combined


@pytest.mark.parametrize("tty", [False, None])
def test_bootstrap_requires_a_real_input_tty_before_prompting(bootstrap_script, tty):
    dependencies = _dependencies()
    stdin = GuardedInput(tty=bool(tty))

    assert _main(bootstrap_script, dependencies, stdin=stdin) != 0

    assert "getpass" not in dependencies.events
    assert "TTY" in dependencies.stderr.getvalue()


def test_bootstrap_ignores_password_environment_and_never_reads_stdin(bootstrap_script):
    dependencies = _dependencies()

    assert _main(bootstrap_script, dependencies, stdin=GuardedInput()) == 0

    assert dependencies.environment["ALBUM_HAVEN_BOOTSTRAP_PASSWORD"] != PASSWORD
    assert dependencies.events.count("getpass") == 2


def test_password_confirmation_mismatch_fails_before_screen_hash_or_database(
    bootstrap_script,
):
    dependencies = _dependencies(passwords=(PASSWORD, PASSWORD + "!"))

    assert _main(bootstrap_script, dependencies) != 0

    assert dependencies.events == ["config", "mail-config", "getpass", "getpass"]
    combined = dependencies.stdout.getvalue() + dependencies.stderr.getvalue()
    assert PASSWORD not in combined


def test_getpass_echo_fallback_warning_fails_closed(bootstrap_script):
    dependencies = _dependencies()

    def unsafe_fallback(_prompt, *, stream=None):
        import warnings

        warnings.warn("echo fallback", getpass.GetPassWarning)
        return PASSWORD

    dependencies.getpass_fn = unsafe_fallback

    assert _main(bootstrap_script, dependencies) != 0
    assert "breach" not in dependencies.events
    assert "hash" not in dependencies.events
    assert "reconcile" not in dependencies.events
    assert PASSWORD not in dependencies.stderr.getvalue()


def test_config_or_password_screening_failure_is_generic_and_secret_free(
    bootstrap_script,
):
    dependencies = _dependencies()

    def fail_hash(raw, **_kwargs):
        raise ValueError(f"rejected {raw}")

    dependencies.password_hasher = fail_hash

    assert _main(bootstrap_script, dependencies) != 0
    combined = dependencies.stdout.getvalue() + dependencies.stderr.getvalue()
    assert PASSWORD not in combined
    assert ENCODED_HASH not in combined
    assert "reconcile" not in dependencies.events


@pytest.mark.parametrize(
    ("credential_created", "expected", "expected_code"),
    [(True, "provisioned", 0), (False, "supplied password was not installed", 3)],
)
def test_success_output_is_non_secret_and_distinguishes_idempotent_rerun(
    bootstrap_script, credential_created, expected, expected_code
):
    dependencies = _dependencies(credential_created=credential_created)

    assert _main(bootstrap_script, dependencies) == expected_code

    rendered = dependencies.stdout.getvalue().casefold()
    assert expected in rendered
    for secret in (PASSWORD, ENCODED_HASH, "Rendref+owner@example.test"):
        assert secret.casefold() not in rendered
    assert dependencies.stderr.getvalue() == ""


def test_script_main_guard_does_not_embed_password_flags_or_environment_reads():
    source = (Path(__file__).resolve().parents[2] / "scripts" / "bootstrap_auth_owner.py")
    if not source.exists():
        pytest.skip("presence test covers the RED contract")
    text = source.read_text(encoding="utf-8")
    assert "ALBUM_HAVEN_BOOTSTRAP_PASSWORD" not in text
    assert "argparse" not in text


def test_enabled_welcome_is_delivered_only_after_bootstrap_commit(bootstrap_script):
    dependencies = _dependencies(welcome_enabled=True)

    assert _main(bootstrap_script, dependencies) == 0

    assert dependencies.events[-2:] == ["reconcile", ("deliver-welcome", 91)]


def test_welcome_delivery_failure_never_rolls_back_bootstrap(bootstrap_script):
    dependencies = _dependencies(welcome_enabled=True)

    def broken_delivery(_outbox_id, *, config):
        dependencies.events.append("deliver-failed")
        raise RuntimeError("smtp-secret")

    dependencies.delivery_runner = broken_delivery

    assert _main(bootstrap_script, dependencies) == 0
    assert dependencies.events[-2:] == ["reconcile", "deliver-failed"]
    combined = dependencies.stdout.getvalue() + dependencies.stderr.getvalue()
    assert "smtp-secret" not in combined


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        ("failed", "was not delivered"),
        ("unknown", "outcome is unknown"),
    ],
)
def test_welcome_delivery_result_is_reported_without_changing_success(
    bootstrap_script, reason, expected
):
    dependencies = _dependencies(welcome_enabled=True)

    def delivery_result(_outbox_id, *, config):
        return SimpleNamespace(delivered=False, reason=reason)

    dependencies.delivery_runner = delivery_result

    assert _main(bootstrap_script, dependencies) == 0
    assert expected in dependencies.stderr.getvalue()
    assert PASSWORD not in dependencies.stderr.getvalue()
