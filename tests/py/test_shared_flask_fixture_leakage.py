from __future__ import annotations

import pytest


def test_shared_conftest_does_not_leak_flask_app_or_client_fixtures(request):
    with pytest.raises(pytest.FixtureLookupError):
        request.getfixturevalue("app")

    with pytest.raises(pytest.FixtureLookupError):
        request.getfixturevalue("client")
