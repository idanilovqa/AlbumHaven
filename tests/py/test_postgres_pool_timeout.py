"""Pool acquisition contracts only; no connection or PostgreSQL readiness claim."""
import inspect

import pytest
from psycopg_pool import ConnectionPool, PoolTimeout

from music_app.services import postgres_connections as connections


@pytest.fixture
def pools(monkeypatch):
    isolated = {}
    monkeypatch.setattr(connections, '_pools', isolated)

    def unexpected_pool(**kwargs):
        raise AssertionError('These acquisition tests must not create a real pool')

    monkeypatch.setattr(connections, 'ConnectionPool', unexpected_pool)
    return isolated


class Acquisition:
    def __init__(self, failure=None):
        self.calls = []
        self.result = object()
        self.failure = failure

    def connection(self, **kwargs):
        self.calls.append(kwargs)
        if self.failure is not None:
            raise self.failure
        return self.result


@pytest.mark.parametrize('timeout,expected', [
    (None, {}), (1.0, {'timeout': 1.0}), (0.05, {'timeout': 0.05}),
])
def test_optional_timeout_is_forwarded_exactly(pools, timeout, expected):
    pool = Acquisition()
    pools[('synthetic:no-connect', 'default')] = pool
    assert connections.pooled_connection('synthetic:no-connect', timeout=timeout) is pool.result
    assert pool.calls == [expected]


def test_omitted_timeout_preserves_default_acquisition(pools):
    pool = Acquisition()
    pools[('synthetic:no-connect', 'default')] = pool
    assert connections.pooled_connection('synthetic:no-connect') is pool.result
    assert pool.calls == [{}]


def test_workload_selection_is_preserved_with_timeout(pools):
    default, browse = Acquisition(), Acquisition()
    pools.update({('synthetic:no-connect', 'default'): default,
                  ('synthetic:no-connect', 'browse'): browse})
    assert connections.pooled_connection('synthetic:no-connect', workload=' browse ', timeout=0.05) is browse.result
    assert browse.calls == [{'timeout': 0.05}]
    assert default.calls == []


def test_pool_timeout_propagates_same_failure_without_retry(pools):
    failure = PoolTimeout('synthetic pool exhausted')
    pool = Acquisition(failure)
    pools[('synthetic:no-connect', 'default')] = pool
    with pytest.raises(PoolTimeout) as caught:
        connections.pooled_connection('synthetic:no-connect', timeout=0.05)
    assert caught.value is failure
    assert pool.calls == [{'timeout': 0.05}]


def test_installed_pool_accepts_optional_timeout_keyword():
    inspect.signature(ConnectionPool.connection).bind(object(), timeout=0.05)
