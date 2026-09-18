from pathlib import Path
p=Path('tests/py/test_app_factory.py')
s=p.read_text(encoding='utf-8')
old='''def _stub_relation_projection_startup(monkeypatch):
    from tests.py.runtime_testing import stub_targeted_reconciliation_repository

    stub_targeted_reconciliation_repository(monkeypatch)
    from music_app.services import state
'''
new='''def _stub_relation_projection_startup(monkeypatch):
    from music_app.services import (
        exception_overrides,
        library_roots,
        scan_cache_persistence,
        state,
    )

    class _TargetedRepositoryStub:
        backend = "postgres"
'''
if s.count(old)!=1: raise RuntimeError(f'fixture anchor count={s.count(old)}')
p.write_text(s.replace(old,new),encoding='utf-8',newline='\n')
