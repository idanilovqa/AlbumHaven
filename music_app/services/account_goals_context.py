"""Opaque account/session continuity for the dedicated authenticated Goals UI.

The marker is not a credential or authorization proof. Routes must independently
resolve the live browser session and enforce account-self policy and CSRF. A new
account, session or signing key retires the previous marker. Library selection
has no bearing on account-owned Goals and is deliberately excluded.
"""
from collections.abc import Mapping
import json

from music_app.services.auth_tokens import keyed_bucket_digest


ACCOUNT_GOALS_CONTEXT_SCOPE = "account-goals-v1"


class AccountGoalsContextError(ValueError):
    status_code = 503
    code = "account_goals_context_unavailable"

    def __init__(self):
        super().__init__("Account Goals context is unavailable.")


def account_goals_context_ref(request):
    """Sign server-authenticated account/session identity, never client input."""
    actor = getattr(request.state, "current_actor", None)
    if actor is None or not actor.is_authenticated:
        return None
    scope = [actor.account_id, actor.session_id]
    if any(type(value) is not int or value <= 0 for value in scope):
        raise AccountGoalsContextError()
    config = getattr(request.app.state, "auth_policy_config", None)
    signing = config.get("hmac") if isinstance(config, Mapping) else None
    secret = signing.get("secret") if isinstance(signing, Mapping) else None
    version = signing.get("key_version", 1) if isinstance(signing, Mapping) else None
    try:
        encoded_secret = secret.encode("utf-8") if isinstance(secret, str) else b""
    except UnicodeError:
        raise AccountGoalsContextError() from None
    if len(encoded_secret) < 32 or type(version) is not int or version < 1:
        raise AccountGoalsContextError()
    return keyed_bucket_digest(secret=encoded_secret, key_version=version,
        domain="account-goals-context-v1", normalized_value=json.dumps(scope, separators=(",", ":")),
    ).digest.hex()
