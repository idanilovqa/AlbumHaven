import base64

import pytest

from music_app.services.auth_invitation_csrf import (
    issue_invitation_csrf,
    matches_invitation_csrf,
)


CONFIG = {
    "hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7}
}
TRANSACTION = base64.urlsafe_b64encode(bytes([0x22]) * 32).decode("ascii").rstrip("=")
OTHER_TRANSACTION = base64.urlsafe_b64encode(bytes([0x33]) * 32).decode("ascii").rstrip("=")
WRONG_CSRF = base64.urlsafe_b64encode(bytes([0x44]) * 32).decode("ascii").rstrip("=")


def test_invitation_csrf_is_deterministic_transaction_bound_and_constant_time_checked():
    csrf = issue_invitation_csrf(TRANSACTION, CONFIG)

    assert len(csrf) == 43
    assert csrf != issue_invitation_csrf(OTHER_TRANSACTION, CONFIG)
    assert matches_invitation_csrf(TRANSACTION, csrf, CONFIG) is True
    assert matches_invitation_csrf(TRANSACTION, WRONG_CSRF, CONFIG) is False
    assert matches_invitation_csrf(None, csrf, CONFIG) is False


@pytest.mark.parametrize(
    "config",
    [None, {}, {"hmac": {}}, {"hmac": {"secret": "secret", "key_version": "7"}}],
)
def test_invitation_csrf_rejects_missing_or_malformed_policy(config):
    with pytest.raises(ValueError, match="Invitation CSRF policy is invalid"):
        issue_invitation_csrf(TRANSACTION, config)
