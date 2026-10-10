"""Opaque authenticated identity continuity for private native UI readers."""
from collections.abc import Mapping
import json

from music_app.services.auth_tokens import keyed_bucket_digest


class PrivateUIContextError(ValueError):
    status_code = 503
    code = "private_ui_context_unavailable"

    def __init__(self):
        super().__init__("Private interface context is unavailable.")


def private_ui_context_ref(request):
    """Bind shell and response identity. This digest grants no authority."""
    actor = getattr(request.state, "current_actor", None)
    if actor is None or not actor.is_authenticated:
        return None
    scope = [actor.account_id, actor.session_id, actor.current_library_id]
    if any(type(value) is not int or value <= 0 for value in scope):
        raise PrivateUIContextError()
    config = getattr(request.app.state, "auth_policy_config", None)
    signing = config.get("hmac") if isinstance(config, Mapping) else None
    secret = signing.get("secret") if isinstance(signing, Mapping) else None
    version = signing.get("key_version", 1) if isinstance(signing, Mapping) else None
    try:
        encoded_secret = secret.encode("utf-8") if isinstance(secret, str) else b""
    except UnicodeError:
        raise PrivateUIContextError() from None
    if len(encoded_secret) < 32 or type(version) is not int or version < 1:
        raise PrivateUIContextError()
    return keyed_bucket_digest(secret=encoded_secret, key_version=version,
        domain="private-ui-context", normalized_value=json.dumps(scope, separators=(",", ":")),
    ).digest.hex()
