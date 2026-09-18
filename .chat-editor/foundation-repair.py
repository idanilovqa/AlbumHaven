from pathlib import Path

def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text(encoding='utf-8')
    if new in s:
        return
    if s.count(old)!=count: raise RuntimeError(f"{path}: expected {count} anchors, got {s.count(old)}")
    p.write_text(s.replace(old,new),encoding='utf-8',newline='\n')

replace('tests/e2e/poms/searchToolbar.js',"    this.control = this.form.locator('.search-field-control');","    this.control = page.locator(this.formSelector + ' .search-field-control');")
replace('tests/e2e/actions/trackModalActions.js',"""    const coverPlaceholderVisible = await this.trackModal.coverPlaceholder.isVisible()
      && await this.trackModal.coverPlaceholder.getAttribute('data-album-artbox-state') === 'empty';""","""    const coverPlaceholderVisible = (
      await this.trackModal.coverPlaceholder.isVisible()
      && await this.trackModal.coverPlaceholder.getAttribute('data-album-artbox-state') === 'empty'
    ) || await this.trackModal.missingArtbox.isVisible();""")
replace('music_app/services/listen_history.py',"""    return _listen_history_adapter(config).load_pending_entries(limit=limit, eligible=eligible)""","""    adapter = _listen_history_adapter(config)
    if eligible is None:
        return adapter.load_pending_entries(limit=limit)
    return adapter.load_pending_entries(limit=limit, eligible=eligible)""")

for path in ('tests/py/test_api_read_asgi_routes.py','tests/py/test_api_wave_a_asgi_routes.py','tests/py/test_api_wave_b_asgi_routes.py'):
    p=Path(path); s=p.read_text(encoding='utf-8')
    marker='from tests.py.asgi_testing import create_test_asgi_app\n'
    if marker in s and 'from tests.py.asgi_testing import configure_test_bootstrap_actor\n' not in s:
        s=s.replace(marker, marker+'from tests.py.asgi_testing import configure_test_bootstrap_actor\n',1)
    old='''def _make_asgi_app():
    from music_app import create_asgi_app

    return create_asgi_app()
'''
    new='''def _make_asgi_app():
    from music_app import create_asgi_app

    asgi_app = create_asgi_app()
    configure_test_bootstrap_actor(asgi_app)
    return asgi_app
'''
    if old in s: s=s.replace(old,new,1)
    p.write_text(s,encoding='utf-8',newline='\n')

replace('tests/py/test_api_read_asgi_routes.py','        request = SimpleNamespace(app=asgi_app, state=SimpleNamespace())','        request = SimpleNamespace(app=asgi_app, state=SimpleNamespace(), cookies={})')
replace('tests/py/test_api_read_asgi_routes.py','''        "load_loops",
        lambda config: [{"id": "loop-1", "name": "Intro loop"}],''','''        "load_loops",
        lambda config, **_scope: [{"id": "loop-1", "name": "Intro loop"}],''')
replace('tests/py/test_api_read_asgi_routes.py','''        "load_log_history_snapshot",
        lambda config: {''','''        "load_log_history_snapshot",
        lambda config, **_scope: {''',2)
replace('tests/py/test_api_read_asgi_routes.py','    def fake_load_loops(config):','    def fake_load_loops(config, **_scope):')
replace('tests/py/test_api_read_asgi_routes.py','    def fake_load_log_history_snapshot(config):','    def fake_load_log_history_snapshot(config, **_scope):')
replace('tests/py/test_api_read_asgi_routes.py','''    revision_epoch, revision_counter = payload["log_history_revision"].rsplit(":", 1)
    assert revision_epoch
    assert revision_counter == "0"''','''    assert payload["log_history_revision"] == ""''')

replace('tests/py/test_log_history_route_scope.py','from tests.py.asgi_testing import run_asgi_request','from tests.py.asgi_testing import configure_test_bootstrap_actor, run_asgi_request')
replace('tests/py/test_log_history_route_scope.py','''    calls=[]; app=FastAPI()
    async def forbidden_handler():''','''    calls=[]; app=FastAPI(); configure_test_bootstrap_actor(app)
    async def forbidden_handler():''')
replace('tests/py/test_log_history_route_scope.py','    app=FastAPI();app.include_router(routes.router);requested=[]','    app=FastAPI(); configure_test_bootstrap_actor(app); app.include_router(routes.router);requested=[]')
