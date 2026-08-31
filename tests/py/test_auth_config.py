from __future__ import annotations

from importlib import import_module, util
import os
from pathlib import Path
import subprocess
import sys

import pytest


AUTH_MODULE = "music_app.services.auth_config"
MAIL_MODULE = "music_app.services.mail_config"


def test_auth_and_mail_configuration_contracts_are_present():
    try:
        auth_config = import_module(AUTH_MODULE)
        mail_config = import_module(MAIL_MODULE)
    except ModuleNotFoundError as exc:
        pytest.fail(f"Phase 7 configuration contract is not implemented: {exc}")

    assert callable(auth_config.build_auth_config)
    assert callable(mail_config.build_mail_config)
    assert callable(mail_config.build_public_url)


def test_root_config_exposes_lazy_auth_and_mail_builders_without_auth_env():
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("ALBUM_HAVEN_BOOTSTRAP_")
        and key != "ALBUM_HAVEN_PUBLIC_BASE_URL"
        and not key.startswith("ALBUM_HAVEN_SMTP_")
    }
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import config; "
                "assert callable(config.build_auth_config); "
                "assert callable(config.build_mail_config)"
            ),
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


@pytest.fixture
def contracts():
    if util.find_spec(AUTH_MODULE) is None or util.find_spec(MAIL_MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(AUTH_MODULE), import_module(MAIL_MODULE)


def _auth_env(**overrides: str) -> dict[str, str]:
    env = {
        "ALBUM_HAVEN_BOOTSTRAP_USERNAME": "Rendref",
        "ALBUM_HAVEN_BOOTSTRAP_EMAIL": "Rendref@Example.COM",
        "ALBUM_HAVEN_PUBLIC_BASE_URL": "https://music.example.test/haven",
    }
    env.update(overrides)
    return env


def _mail_env(**overrides: str) -> dict[str, str]:
    env = {
        "ALBUM_HAVEN_PUBLIC_BASE_URL": "https://music.example.test/haven",
        "ALBUM_HAVEN_SMTP_HOST": "smtp.example.test",
        "ALBUM_HAVEN_SMTP_PORT": "587",
        "ALBUM_HAVEN_SMTP_SECURITY": "starttls",
        "ALBUM_HAVEN_SMTP_FROM_ADDRESS": "album-haven@example.test",
        "ALBUM_HAVEN_SMTP_FROM_NAME": "Album Haven",
    }
    env.update(overrides)
    return env


def test_auth_defaults_normalize_bootstrap_identity_and_lock_security_policy(contracts):
    auth_config, _ = contracts

    config = auth_config.build_auth_config(_auth_env())

    assert config["bootstrap_username_display"] == "Rendref"
    assert config["bootstrap_username_normalized"] == "rendref"
    assert config["bootstrap_email_normalized"] == "Rendref@example.com"
    assert config["argon2"] == {
        "memory_cost": 65_536,
        "time_cost": 3,
        "parallelism": 1,
        "salt_len": 16,
        "hash_len": 32,
    }
    assert config["password"] == {
        "min_codepoints": 15,
        "max_codepoints": 256,
        "max_utf8_bytes": 1_024,
    }
    assert config["session"] == {
        "idle_seconds": 12 * 60 * 60,
        "absolute_seconds": 7 * 24 * 60 * 60,
        "activity_write_seconds": 5 * 60,
    }
    assert config["reset_token_seconds"] == 30 * 60
    assert config["audit_retention_seconds"] == 90 * 24 * 60 * 60


@pytest.mark.parametrize(
    "username",
    [
        "rendref",
        "RendRef",
        "Rendref2",
        "Ren dref",
        "Re",
        "R" * 65,
        "Rend@ref",
    ],
)
def test_auth_config_requires_the_fixed_visible_rendref_bootstrap_username(
    contracts, username
):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_BOOTSTRAP_USERNAME"):
        auth_config.build_auth_config(
            _auth_env(ALBUM_HAVEN_BOOTSTRAP_USERNAME=username)
        )


def test_auth_config_rejects_a_padded_bootstrap_username(contracts):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_BOOTSTRAP_USERNAME"):
        auth_config.build_auth_config(
            _auth_env(ALBUM_HAVEN_BOOTSTRAP_USERNAME=" Rendref ")
        )


def test_auth_config_idna_normalizes_the_bootstrap_email_domain(contracts):
    auth_config, _ = contracts

    config = auth_config.build_auth_config(
        _auth_env(ALBUM_HAVEN_BOOTSTRAP_EMAIL="Rendref@B\u00dcCHER.Example")
    )

    assert config["bootstrap_email_normalized"] == (
        "Rendref@xn--bcher-kva.example"
    )


@pytest.mark.parametrize(
    "email",
    [
        "Rendref@-example.test",
        "Rendref@example-.test",
        "Rendref@example..test",
        "Rendref@example_test",
        "Rendref@\x00example.test",
    ],
)
def test_auth_config_rejects_invalid_bootstrap_email_domains(contracts, email):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_BOOTSTRAP_EMAIL"):
        auth_config.build_auth_config(_auth_env(ALBUM_HAVEN_BOOTSTRAP_EMAIL=email))


def test_auth_defaults_lock_throttle_contracts(contracts):
    auth_config, _ = contracts

    throttles = auth_config.build_auth_config(_auth_env())["throttles"]

    assert throttles == {
        "login_account": {"limit": 5, "window_seconds": 15 * 60},
        "login_source": {"limit": 20, "window_seconds": 15 * 60},
        "login_cooldown_seconds": 15 * 60,
        "reset_account": {"limit": 5, "window_seconds": 60 * 60},
        "reset_source": {"limit": 20, "window_seconds": 60 * 60},
        "welcome_account": {"limit": 5, "window_seconds": 24 * 60 * 60},
    }


def test_auth_cookie_defaults_are_host_only_secure_and_http_only(contracts):
    auth_config, _ = contracts

    cookie = auth_config.build_auth_config(_auth_env())["cookie"]

    assert cookie == {
        "name": "__Host-album_haven_session",
        "secure": True,
        "http_only": True,
        "same_site": "Lax",
        "path": "/",
        "domain": None,
    }


@pytest.mark.parametrize(
    ("env_key", "value"),
    [
        ("ALBUM_HAVEN_ARGON2_MEMORY_COST", "65535"),
        ("ALBUM_HAVEN_ARGON2_TIME_COST", "2"),
        ("ALBUM_HAVEN_ARGON2_PARALLELISM", "0"),
        ("ALBUM_HAVEN_ARGON2_SALT_LEN", "15"),
        ("ALBUM_HAVEN_ARGON2_HASH_LEN", "31"),
        ("ALBUM_HAVEN_PASSWORD_MIN_CODEPOINTS", "14"),
        ("ALBUM_HAVEN_PASSWORD_MAX_CODEPOINTS", "257"),
        ("ALBUM_HAVEN_PASSWORD_MAX_UTF8_BYTES", "1025"),
        ("ALBUM_HAVEN_SESSION_IDLE_SECONDS", str(13 * 60 * 60)),
        ("ALBUM_HAVEN_SESSION_ABSOLUTE_SECONDS", str(8 * 24 * 60 * 60)),
        ("ALBUM_HAVEN_SESSION_ACTIVITY_WRITE_SECONDS", str(4 * 60)),
        ("ALBUM_HAVEN_RESET_TOKEN_SECONDS", str(31 * 60)),
        ("ALBUM_HAVEN_AUTH_AUDIT_RETENTION_DAYS", "89"),
    ],
)
def test_auth_config_rejects_values_weaker_than_the_locked_policy(
    contracts, env_key, value
):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match=env_key):
        auth_config.build_auth_config(_auth_env(**{env_key: value}))


@pytest.mark.parametrize(
    "trusted_origins",
    [
        "http://music.example.test",
        "https://user@music.example.test",
        "https://music.example.test/path",
        "https://music.example.test?query=yes",
        "https://music.example.test/#fragment",
        "https://music.example.test,not-a-url",
    ],
)
def test_auth_config_rejects_untrusted_origin_shapes(contracts, trusted_origins):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_TRUSTED_ORIGINS"):
        auth_config.build_auth_config(
            _auth_env(ALBUM_HAVEN_TRUSTED_ORIGINS=trusted_origins)
        )


def test_auth_config_accepts_distinct_https_trusted_origins(contracts):
    auth_config, _ = contracts

    config = auth_config.build_auth_config(
        _auth_env(
            ALBUM_HAVEN_TRUSTED_ORIGINS=(
                "https://music.example.test,https://admin.example.test:8443"
            )
        )
    )

    assert config["trusted_origins"] == (
        "https://music.example.test",
        "https://admin.example.test:8443",
    )


@pytest.mark.parametrize(
    "trusted_origin",
    [
        "https://music example.test",
        "https://music.example.test /",
        "https://-music.example.test",
        "https://music..example.test",
        "https://music_example.test",
        "https://music.example.test\x00.evil",
    ],
)
def test_auth_config_rejects_malformed_trusted_origin_hosts(
    contracts, trusted_origin
):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_TRUSTED_ORIGINS"):
        auth_config.build_auth_config(
            _auth_env(ALBUM_HAVEN_TRUSTED_ORIGINS=trusted_origin)
        )


@pytest.mark.parametrize(
    "base_url",
    [
        "http://music.example.test",
        "https://user:secret@music.example.test",
        "https://music.example.test/haven?token=secret",
        "https://music.example.test/haven#fragment",
    ],
)
def test_public_base_url_rejects_insecure_or_secret_bearing_urls(contracts, base_url):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_PUBLIC_BASE_URL"):
        auth_config.build_auth_config(_auth_env(ALBUM_HAVEN_PUBLIC_BASE_URL=base_url))


@pytest.mark.parametrize(
    "base_url",
    [
        "https://music example.test/haven",
        "https://music.example.test /haven",
        "https://-music.example.test/haven",
        "https://music..example.test/haven",
        "https://music_example.test/haven",
        "https://music.example.test\x00.evil/haven",
    ],
)
def test_public_base_url_rejects_malformed_hosts(contracts, base_url):
    auth_config, _ = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_PUBLIC_BASE_URL"):
        auth_config.build_auth_config(_auth_env(ALBUM_HAVEN_PUBLIC_BASE_URL=base_url))


def test_public_url_builder_preserves_the_configured_path_prefix(contracts):
    _, mail_config = contracts

    assert (
        mail_config.build_public_url(
            "https://music.example.test/haven/", "/account/reset"
        )
        == "https://music.example.test/haven/account/reset"
    )


@pytest.mark.parametrize("security", ["tls", "starttls"])
def test_mail_config_accepts_encrypted_smtp_with_optional_credentials(
    contracts, security
):
    _, mail_config = contracts
    env = _mail_env(
        ALBUM_HAVEN_SMTP_SECURITY=security,
        ALBUM_HAVEN_SMTP_USERNAME="smtp-user",
        ALBUM_HAVEN_SMTP_PASSWORD="smtp-secret",
        ALBUM_HAVEN_SMTP_CONNECT_TIMEOUT_SECONDS="5",
        ALBUM_HAVEN_SMTP_COMMAND_TIMEOUT_SECONDS="10",
    )

    config = mail_config.build_mail_config(env)

    assert config["host"] == "smtp.example.test"
    assert config["port"] == 587
    assert config["security"] == security
    assert config["username"] == "smtp-user"
    assert config["password"] == "smtp-secret"
    assert config["sender_address"] == "album-haven@example.test"
    assert config["sender_name"] == "Album Haven"
    assert config["connect_timeout_seconds"] == 5
    assert config["command_timeout_seconds"] == 10


@pytest.mark.parametrize(
    "host",
    [
        "smtp example.test",
        "-smtp.example.test",
        "smtp..example.test",
        "smtp_example.test",
        "https://smtp.example.test",
        "smtp.example.test/path",
        "smtp.example.test\x00.evil",
    ],
)
def test_mail_config_rejects_malformed_smtp_hosts(contracts, host):
    _, mail_config = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_SMTP_HOST"):
        mail_config.build_mail_config(_mail_env(ALBUM_HAVEN_SMTP_HOST=host))


@pytest.mark.parametrize(
    "sender_address",
    [
        "not-an-email-address",
        "sender @example.test",
        "sender@example..test",
        "sender@example_test",
        "sender@-example.test",
    ],
)
def test_mail_config_rejects_invalid_sender_addresses(contracts, sender_address):
    _, mail_config = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_SMTP_FROM_ADDRESS"):
        mail_config.build_mail_config(
            _mail_env(ALBUM_HAVEN_SMTP_FROM_ADDRESS=sender_address)
        )


def test_mail_config_rejects_smtp_ports_above_65535(contracts):
    _, mail_config = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_SMTP_PORT"):
        mail_config.build_mail_config(_mail_env(ALBUM_HAVEN_SMTP_PORT="65536"))


@pytest.mark.parametrize(
    "overrides",
    [
        {"ALBUM_HAVEN_SMTP_USERNAME": "smtp-user"},
        {"ALBUM_HAVEN_SMTP_PASSWORD": "smtp-secret"},
    ],
)
def test_mail_config_requires_paired_smtp_credentials(contracts, overrides):
    _, mail_config = contracts

    with pytest.raises(ValueError, match="ALBUM_HAVEN_SMTP_(USERNAME|PASSWORD)"):
        mail_config.build_mail_config(_mail_env(**overrides))


def test_mail_config_preserves_credential_whitespace_but_rejects_line_breaks(
    contracts,
):
    _, mail_config = contracts
    username = "  smtp-user  "
    password = "  smtp-secret  "

    config = mail_config.build_mail_config(
        _mail_env(
            ALBUM_HAVEN_SMTP_USERNAME=username,
            ALBUM_HAVEN_SMTP_PASSWORD=password,
        )
    )

    assert config["username"] == username
    assert config["password"] == password

    for env_key in (
        "ALBUM_HAVEN_SMTP_USERNAME",
        "ALBUM_HAVEN_SMTP_PASSWORD",
    ):
        credentials = {
            "ALBUM_HAVEN_SMTP_USERNAME": "smtp-user",
            "ALBUM_HAVEN_SMTP_PASSWORD": "smtp-secret",
        }
        credentials[env_key] = "secret\r\ninjection"
        with pytest.raises(ValueError, match=env_key):
            mail_config.build_mail_config(_mail_env(**credentials))


def test_mail_config_allows_plaintext_only_for_an_explicit_loopback_fake(contracts):
    _, mail_config = contracts

    config = mail_config.build_mail_config(
        _mail_env(
            ALBUM_HAVEN_SMTP_HOST="127.0.0.1",
            ALBUM_HAVEN_SMTP_SECURITY="plaintext",
            ALBUM_HAVEN_SMTP_ALLOW_PLAINTEXT_LOOPBACK="true",
        )
    )

    assert config["security"] == "plaintext"


@pytest.mark.parametrize("host", ["smtp.example.test", "192.0.2.10"])
def test_mail_config_rejects_plaintext_for_non_loopback_hosts(contracts, host):
    _, mail_config = contracts

    with pytest.raises(ValueError, match="plaintext"):
        mail_config.build_mail_config(
            _mail_env(
                ALBUM_HAVEN_SMTP_HOST=host,
                ALBUM_HAVEN_SMTP_SECURITY="plaintext",
                ALBUM_HAVEN_SMTP_ALLOW_PLAINTEXT_LOOPBACK="true",
            )
        )


@pytest.mark.parametrize(
    ("env_key", "value"),
    [
        ("ALBUM_HAVEN_SMTP_HOST", "smtp.example.test\r\nX-Header: secret"),
        ("ALBUM_HAVEN_SMTP_FROM_ADDRESS", "sender@example.test\nBcc: victim@example.test"),
        ("ALBUM_HAVEN_SMTP_FROM_NAME", "Album Haven\r\nBcc: victim@example.test"),
    ],
)
def test_mail_config_rejects_crlf_in_mail_fields(contracts, env_key, value):
    _, mail_config = contracts

    with pytest.raises(ValueError, match=env_key):
        mail_config.build_mail_config(_mail_env(**{env_key: value}))


@pytest.mark.parametrize(
    "missing_key",
    [
        "ALBUM_HAVEN_PUBLIC_BASE_URL",
        "ALBUM_HAVEN_SMTP_HOST",
        "ALBUM_HAVEN_SMTP_FROM_ADDRESS",
    ],
)
def test_enabled_delivery_requires_complete_public_smtp_configuration(
    contracts, missing_key
):
    _, mail_config = contracts
    env = _mail_env(
        ALBUM_HAVEN_WELCOME_EMAIL_ENABLED="true",
        ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED="true",
    )
    env.pop(missing_key)

    with pytest.raises(ValueError, match=missing_key):
        mail_config.build_mail_config(env)


def test_smtp_secrets_are_absent_from_config_repr_and_validation_errors(contracts):
    _, mail_config = contracts
    secret = "top-secret-smtp-password"
    config = mail_config.build_mail_config(
        _mail_env(
            ALBUM_HAVEN_SMTP_USERNAME="smtp-user",
            ALBUM_HAVEN_SMTP_PASSWORD=secret,
        )
    )

    assert secret not in repr(config)

    with pytest.raises(ValueError) as exc_info:
        mail_config.build_mail_config(
            _mail_env(
                ALBUM_HAVEN_SMTP_PASSWORD=secret,
                ALBUM_HAVEN_SMTP_PORT="not-a-port",
            )
        )
    assert secret not in str(exc_info.value)
