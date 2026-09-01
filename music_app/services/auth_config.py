"""Validated configuration for Album Haven's local authentication policy."""

from __future__ import annotations

from collections.abc import Mapping
import ipaddress
import re
from typing import Any
from urllib.parse import urlsplit


_ARGON2_DEFAULTS = {
    "memory_cost": 65_536,
    "time_cost": 3,
    "parallelism": 1,
    "salt_len": 16,
    "hash_len": 32,
}

_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_EMAIL_LOCAL = re.compile(r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$")


class _HmacConfig(dict[str, Any]):
    """Dictionary-compatible HMAC config whose representation omits its secret."""

    def __repr__(self) -> str:
        safe = dict(self)
        safe["secret"] = "<redacted>"
        return repr(safe)


class AuthConfig(dict[str, Any]):
    """Dictionary-compatible authentication configuration with safe repr output."""


def _reject_unsafe_text(value: str, key: str) -> None:
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError(f"{key} contains whitespace or control characters")


def normalize_host(value: str, key: str, *, dns_only: bool = False) -> str:
    """Return a canonical IP address or strict IDNA DNS name."""

    if not value:
        raise ValueError(f"{key} must contain a valid host")
    _reject_unsafe_text(value, key)
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        address = None
    if address is not None:
        if dns_only:
            raise ValueError(f"{key} must contain a valid email domain")
        return address.compressed.lower()

    if value.endswith(".") or len(value) > 253:
        raise ValueError(f"{key} must contain a valid DNS name")
    try:
        ascii_host = value.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise ValueError(f"{key} must contain a valid DNS name") from exc
    labels = ascii_host.split(".")
    if not labels or any(not _DNS_LABEL.fullmatch(label) for label in labels):
        raise ValueError(f"{key} must contain a valid DNS name")
    return ascii_host


def _integer(
    env: Mapping[str, str],
    key: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    raw = env.get(key)
    try:
        value = default if raw is None else int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be an integer") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"{key} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{key} must be at most {maximum}")
    return value


def _required(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise ValueError(f"{key} is required")
    return value


def _auth_hmac_config(env: Mapping[str, str]) -> _HmacConfig:
    key = "ALBUM_HAVEN_AUTH_HMAC_SECRET"
    secret = env.get(key)
    if secret is None or len(secret.encode("utf-8")) < 32:
        raise ValueError(f"{key} must contain at least 32 UTF-8 bytes")
    return _HmacConfig(
        secret=secret,
        key_version=_integer(
            env, "ALBUM_HAVEN_AUTH_HMAC_KEY_VERSION", 1, minimum=1
        ),
    )


def _trusted_proxies(env: Mapping[str, str]) -> tuple[str, ...]:
    key = "ALBUM_HAVEN_TRUSTED_PROXIES"
    raw = env.get(key)
    if raw is None or raw == "":
        return ()

    normalized: list[str] = []
    for raw_entry in raw.split(","):
        entry = raw_entry.strip()
        if not entry:
            raise ValueError(f"{key} must not contain empty entries")
        if "%" in entry:
            raise ValueError(f"{key} must not contain scoped IP addresses")
        try:
            if "/" in entry:
                value = ipaddress.ip_network(entry, strict=False).compressed
            else:
                value = ipaddress.ip_address(entry).compressed
        except ValueError as exc:
            raise ValueError(f"{key} must contain only IP addresses or CIDRs") from exc
        normalized.append(value)
    return tuple(normalized)


def _validated_https_url(value: str, key: str, *, origin_only: bool) -> str:
    _reject_unsafe_text(value, key)
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"{key} must be a valid HTTPS URL") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (origin_only and parsed.path not in ("", "/"))
    ):
        raise ValueError(f"{key} must be a credential-free HTTPS URL")
    try:
        host = normalize_host(parsed.hostname, key)
    except ValueError as exc:
        raise ValueError(f"{key} must be a valid HTTPS URL") from exc
    if ":" in host:
        host = f"[{host}]"
    authority = host if port is None else f"{host}:{port}"
    if origin_only:
        return f"https://{authority}"
    path = parsed.path.rstrip("/")
    return f"https://{authority}{path}"


def validate_public_base_url(value: str) -> str:
    """Validate and normalize the externally visible application base URL."""

    return _validated_https_url(
        value, "ALBUM_HAVEN_PUBLIC_BASE_URL", origin_only=False
    )


def _normalize_email(value: str, key: str) -> str:
    if value.count("@") != 1:
        raise ValueError(f"{key} must be a valid email address")
    _reject_unsafe_text(value, key)
    local, domain = value.rsplit("@", 1)
    if (
        not local
        or len(local) > 64
        or not _EMAIL_LOCAL.fullmatch(local)
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
    ):
        raise ValueError(f"{key} must be a valid email address")
    try:
        normalized_domain = normalize_host(domain, key, dns_only=True)
    except ValueError as exc:
        raise ValueError(f"{key} must be a valid email address") from exc
    return f"{local}@{normalized_domain}"


def normalize_email_address(value: str, key: str) -> str:
    """Normalize an unquoted mailbox address without changing its local part."""

    return _normalize_email(value, key)


def build_auth_config(env: Mapping[str, str]) -> dict[str, Any]:
    """Build the immutable policy values consumed by authentication services."""

    username = env.get("ALBUM_HAVEN_BOOTSTRAP_USERNAME")
    if not username:
        raise ValueError("ALBUM_HAVEN_BOOTSTRAP_USERNAME is required")
    if username != "Rendref":
        raise ValueError(
            "ALBUM_HAVEN_BOOTSTRAP_USERNAME must be the fixed visible username Rendref"
        )
    email = _normalize_email(
        _required(env, "ALBUM_HAVEN_BOOTSTRAP_EMAIL"),
        "ALBUM_HAVEN_BOOTSTRAP_EMAIL",
    )
    public_base_url = validate_public_base_url(
        _required(env, "ALBUM_HAVEN_PUBLIC_BASE_URL")
    )

    trusted_origins_raw = env.get("ALBUM_HAVEN_TRUSTED_ORIGINS", "").strip()
    if trusted_origins_raw:
        origins = tuple(
            _validated_https_url(
                item.strip(), "ALBUM_HAVEN_TRUSTED_ORIGINS", origin_only=True
            )
            for item in trusted_origins_raw.split(",")
        )
        if len(set(origins)) != len(origins):
            raise ValueError("ALBUM_HAVEN_TRUSTED_ORIGINS must contain distinct origins")
    else:
        parsed_base = urlsplit(public_base_url)
        origins = (f"{parsed_base.scheme}://{parsed_base.netloc}",)

    argon2 = {
        "memory_cost": _integer(
            env,
            "ALBUM_HAVEN_ARGON2_MEMORY_COST",
            _ARGON2_DEFAULTS["memory_cost"],
            minimum=_ARGON2_DEFAULTS["memory_cost"],
        ),
        "time_cost": _integer(
            env,
            "ALBUM_HAVEN_ARGON2_TIME_COST",
            _ARGON2_DEFAULTS["time_cost"],
            minimum=_ARGON2_DEFAULTS["time_cost"],
        ),
        "parallelism": _integer(
            env,
            "ALBUM_HAVEN_ARGON2_PARALLELISM",
            _ARGON2_DEFAULTS["parallelism"],
            minimum=_ARGON2_DEFAULTS["parallelism"],
        ),
        "salt_len": _integer(
            env,
            "ALBUM_HAVEN_ARGON2_SALT_LEN",
            _ARGON2_DEFAULTS["salt_len"],
            minimum=_ARGON2_DEFAULTS["salt_len"],
        ),
        "hash_len": _integer(
            env,
            "ALBUM_HAVEN_ARGON2_HASH_LEN",
            _ARGON2_DEFAULTS["hash_len"],
            minimum=_ARGON2_DEFAULTS["hash_len"],
        ),
    }

    password = {
        "min_codepoints": _integer(
            env, "ALBUM_HAVEN_PASSWORD_MIN_CODEPOINTS", 15, minimum=15
        ),
        "max_codepoints": _integer(
            env,
            "ALBUM_HAVEN_PASSWORD_MAX_CODEPOINTS",
            256,
            minimum=1,
            maximum=256,
        ),
        "max_utf8_bytes": _integer(
            env,
            "ALBUM_HAVEN_PASSWORD_MAX_UTF8_BYTES",
            1_024,
            minimum=1,
            maximum=1_024,
        ),
    }
    if password["max_codepoints"] < password["min_codepoints"]:
        raise ValueError(
            "ALBUM_HAVEN_PASSWORD_MAX_CODEPOINTS must be at least "
            "ALBUM_HAVEN_PASSWORD_MIN_CODEPOINTS"
        )
    if password["max_utf8_bytes"] < password["min_codepoints"]:
        raise ValueError(
            "ALBUM_HAVEN_PASSWORD_MAX_UTF8_BYTES must allow the configured "
            "minimum password length"
        )

    session = {
        "idle_seconds": _integer(
            env,
            "ALBUM_HAVEN_SESSION_IDLE_SECONDS",
            43_200,
            minimum=1,
            maximum=43_200,
        ),
        "absolute_seconds": _integer(
            env,
            "ALBUM_HAVEN_SESSION_ABSOLUTE_SECONDS",
            604_800,
            minimum=1,
            maximum=604_800,
        ),
        "activity_write_seconds": _integer(
            env,
            "ALBUM_HAVEN_SESSION_ACTIVITY_WRITE_SECONDS",
            300,
            minimum=300,
        ),
    }
    if session["idle_seconds"] > session["absolute_seconds"]:
        raise ValueError(
            "ALBUM_HAVEN_SESSION_IDLE_SECONDS must not exceed "
            "ALBUM_HAVEN_SESSION_ABSOLUTE_SECONDS"
        )
    if session["activity_write_seconds"] >= session["idle_seconds"]:
        raise ValueError(
            "ALBUM_HAVEN_SESSION_ACTIVITY_WRITE_SECONDS must be less than "
            "ALBUM_HAVEN_SESSION_IDLE_SECONDS"
        )

    reset_token_seconds = _integer(
        env,
        "ALBUM_HAVEN_RESET_TOKEN_SECONDS",
        1_800,
        minimum=1,
        maximum=1_800,
    )

    invitation_token_seconds = _integer(
        env,
        "ALBUM_HAVEN_INVITATION_TOKEN_SECONDS",
        259_200,
        minimum=3_600,
        maximum=604_800,
    )

    return AuthConfig({
        "bootstrap_username_display": username,
        "bootstrap_username_normalized": "rendref",
        "bootstrap_email_normalized": email,
        "public_base_url": public_base_url,
        "trusted_origins": origins,
        "trusted_proxies": _trusted_proxies(env),
        "hmac": _auth_hmac_config(env),
        "argon2": argon2,
        "argon2_policy_version": _integer(
            env, "ALBUM_HAVEN_ARGON2_POLICY_VERSION", 1, minimum=1
        ),
        "verification_semaphore": _integer(
            env,
            "ALBUM_HAVEN_AUTH_VERIFICATION_SEMAPHORE",
            2,
            minimum=1,
            maximum=2,
        ),
        "active_session_cap": _integer(
            env, "ALBUM_HAVEN_ACTIVE_SESSION_CAP", 10, minimum=1, maximum=10
        ),
        "password": password,
        "session": session,
        "reset_token_seconds": reset_token_seconds,
        "invitation_token_seconds": invitation_token_seconds,
        "audit_retention_seconds": _integer(
            env,
            "ALBUM_HAVEN_AUTH_AUDIT_RETENTION_DAYS",
            90,
            minimum=90,
        )
        * 86_400,
        "throttles": {
            "login_account": {
                "limit": _integer(
                    env, "ALBUM_HAVEN_LOGIN_ACCOUNT_LIMIT", 5, minimum=1, maximum=5
                ),
                "window_seconds": _integer(
                    env, "ALBUM_HAVEN_LOGIN_ACCOUNT_WINDOW_SECONDS", 900, minimum=900
                ),
            },
            "login_source": {
                "limit": _integer(
                    env, "ALBUM_HAVEN_LOGIN_SOURCE_LIMIT", 20, minimum=1, maximum=20
                ),
                "window_seconds": _integer(
                    env, "ALBUM_HAVEN_LOGIN_SOURCE_WINDOW_SECONDS", 900, minimum=900
                ),
            },
            "login_cooldown_seconds": _integer(
                env, "ALBUM_HAVEN_LOGIN_COOLDOWN_SECONDS", 900, minimum=900
            ),
            "reset_candidate": {
                "limit": _integer(
                    env, "ALBUM_HAVEN_RESET_CANDIDATE_LIMIT", 5, minimum=1, maximum=5
                ),
                "window_seconds": _integer(
                    env,
                    "ALBUM_HAVEN_RESET_CANDIDATE_WINDOW_SECONDS",
                    3_600,
                    minimum=3_600,
                ),
            },
            "reset_account": {
                "limit": _integer(
                    env, "ALBUM_HAVEN_RESET_ACCOUNT_LIMIT", 5, minimum=1, maximum=5
                ),
                "window_seconds": _integer(
                    env, "ALBUM_HAVEN_RESET_ACCOUNT_WINDOW_SECONDS", 3_600, minimum=3_600
                ),
            },
            "reset_source": {
                "limit": _integer(
                    env, "ALBUM_HAVEN_RESET_SOURCE_LIMIT", 20, minimum=1, maximum=20
                ),
                "window_seconds": _integer(
                    env, "ALBUM_HAVEN_RESET_SOURCE_WINDOW_SECONDS", 3_600, minimum=3_600
                ),
            },
            "welcome_account": {
                "limit": _integer(
                    env, "ALBUM_HAVEN_WELCOME_ACCOUNT_LIMIT", 5, minimum=1, maximum=5
                ),
                "window_seconds": _integer(
                    env,
                    "ALBUM_HAVEN_WELCOME_ACCOUNT_WINDOW_SECONDS",
                    86_400,
                    minimum=86_400,
                ),
            },
        },
        "cookie": {
            "name": "__Host-album_haven_session",
            "secure": True,
            "http_only": True,
            "same_site": "Lax",
            "path": "/",
            "domain": None,
        },
    })
