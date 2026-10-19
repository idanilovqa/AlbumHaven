"""Optional per-observer pool wait leaves every existing caller unchanged."""
from music_app.services import postgres_connections as pools


def test_optional_pool_wait_is_forwarded_without_changing_shared_defaults(monkeypatch):
    calls = []
    class Pool:
        def __init__(self, **kwargs):
            calls.append(('construct', kwargs))
        def connection(self, **kwargs):
            calls.append(('connection', kwargs)); return object()
    monkeypatch.setattr(pools, '_pools', {})
    monkeypatch.setattr(pools, 'ConnectionPool', Pool)
    pools.pooled_connection('postgresql://synthetic.invalid/unopened')
    pools.pooled_connection('postgresql://synthetic.invalid/unopened', timeout=.250)
    assert calls[0][1]['timeout'] == 30 and calls[0][1]['kwargs']['connect_timeout'] == 15
    assert calls[1:] == [('connection', {}), ('connection', {'timeout': .250})]
