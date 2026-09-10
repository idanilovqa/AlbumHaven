from music_app.services.auth_reset_csrf import issue_reset_csrf, matches_reset_csrf


CONFIG = {
    "hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7}
}
RESET = "c" * 43


def test_reset_csrf_is_deterministic_transaction_bound_and_constant_time_checked():
    csrf = issue_reset_csrf(RESET, CONFIG)

    assert len(csrf) == 43
    assert csrf != issue_reset_csrf("s" * 43, CONFIG)
    assert matches_reset_csrf(RESET, csrf, CONFIG) is True
    assert matches_reset_csrf(RESET, "x" * 43, CONFIG) is False
    assert matches_reset_csrf(None, csrf, CONFIG) is False
