from types import SimpleNamespace

from starlette.requests import Request

from music_app.services.policy_asgi import request_origin_ref_for_request


def test_request_origin_distinguishes_accounts_on_the_same_network():
    request = Request({
        "type": "http", "client": ("127.0.0.1", 1234),
        "app": SimpleNamespace(state=SimpleNamespace(auth_policy_config={
            "hmac": {"secret": "s" * 48, "key_version": 1},
        })),
    })
    request.state.current_actor = SimpleNamespace(account_id=11)
    first = request_origin_ref_for_request(request)
    assert request_origin_ref_for_request(request) == first
    request.state.current_actor = SimpleNamespace(account_id=12)
    second = request_origin_ref_for_request(request)
    request.state.current_actor = SimpleNamespace(account_id=None)
    public = request_origin_ref_for_request(request)
    assert len({first, second, public}) == 3
