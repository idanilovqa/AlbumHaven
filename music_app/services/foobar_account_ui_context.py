"""Opaque continuity for the authenticated, account-owned Foobar interface.

This marker is not a credential or authority. Every endpoint must resolve the
current session and enforce account-self policy and CSRF independently. Library
selection is deliberately excluded from this account-owned continuity marker.
"""
from collections.abc import Mapping
import json

from music_app.services.auth_tokens import keyed_bucket_digest


FOOBAR_ACCOUNT_CONTEXT_SCOPE = "account-foobar-v1"


class FoobarAccountUIContextError(ValueError):
    status_code = 503
    code = "foobar_account_context_unavailable"

    def __init__(self):
        super().__init__("Foobar account context is unavailable.")


def foobar_account_ui_context_ref(request):
    """Bind only server-authenticated account/session identity, not client IDs."""
    actor = getattr(request.state, "current_actor", None)
    if actor is None or not actor.is_authenticated:
        return None
    scope = [actor.account_id, actor.session_id]
    if any(type(value) is not int or not 1 <= value <= 9223372036854775807 for value in scope):
        raise FoobarAccountUIContextError()
    config = getattr(request.app.state, "auth_policy_config", None)
    signing = config.get("hmac") if isinstance(config, Mapping) else None
    secret = signing.get("secret") if isinstance(signing, Mapping) else None
    version = signing.get("key_version", 1) if isinstance(signing, Mapping) else None
    try:
        encoded_secret = secret.encode("utf-8") if isinstance(secret, str) else b""
    except UnicodeError:
        raise FoobarAccountUIContextError() from None
    if len(encoded_secret) < 32 or type(version) is not int or version < 1:
        raise FoobarAccountUIContextError()
    try:
        return keyed_bucket_digest(
            secret=encoded_secret, key_version=version,
            domain="account-foobar-context-v1",
            normalized_value=json.dumps(scope, separators=(",", ":")),
        ).digest.hex()
    except (ValueError, TypeError, OverflowError):
        raise FoobarAccountUIContextError() from None
