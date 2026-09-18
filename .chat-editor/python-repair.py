from pathlib import Path

def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text(encoding="utf-8")
    if new in s: return
    if s.count(old) != count: raise RuntimeError(f"{path}: expected {count} anchors, got {s.count(old)}")
    p.write_text(s.replace(old,new,count), encoding="utf-8", newline="\n")

# ASGI route tests now cross the real authenticated boundary.
for path in ("tests/py/test_api_read_asgi_routes.py","tests/py/test_api_wave_a_asgi_routes.py","tests/py/test_api_wave_b_asgi_routes.py"):
    p=Path(path); s=p.read_text(encoding="utf-8")
    marker="from tests.py.asgi_testing import create_test_asgi_app\n"
    helper="from tests.py.asgi_testing import configure_test_bootstrap_actor\n"
    if helper not in s:
        s=s.replace(marker, marker+helper, 1)
    old="def _make_asgi_app():\n    from music_app import create_asgi_app\n\n    return create_asgi_app()\n"
    new="def _make_asgi_app():\n    from music_app import create_asgi_app\n\n    asgi_app = create_asgi_app()\n    configure_test_bootstrap_actor(asgi_app)\n    return asgi_app\n"
    if old in s: s=s.replace(old,new,1)
    p.write_text(s,encoding="utf-8",newline="\n")

replace("tests/py/test_api_read_asgi_routes.py","request = SimpleNamespace(app=asgi_app, state=SimpleNamespace())","request = SimpleNamespace(app=asgi_app, state=SimpleNamespace(), cookies={})")
replace("tests/py/test_api_read_asgi_routes.py",'lambda config: [{"id": "loop-1", "name": "Intro loop"}]','lambda config, **_scope: [{"id": "loop-1", "name": "Intro loop"}]')
replace("tests/py/test_api_read_asgi_routes.py",'lambda config: {\n            "items": [{"id": "entry-1", "message": "Refresh started"}],','lambda config, **_scope: {\n            "items": [{"id": "entry-1", "message": "Refresh started"}],')
replace("tests/py/test_api_read_asgi_routes.py","def fake_load_loops(config):","def fake_load_loops(config, **_scope):")
replace("tests/py/test_api_read_asgi_routes.py","def fake_load_log_history_snapshot(config):","def fake_load_log_history_snapshot(config, **_scope):")
replace("tests/py/test_api_read_asgi_routes.py",'lambda _config: {"items": [], "revision": "test-process:0"}','lambda _config, **_scope: {"items": [], "revision": "test-process:0"}')
replace("tests/py/test_api_read_asgi_routes.py",'    revision_epoch, revision_counter = payload["log_history_revision"].rsplit(":", 1)\n    assert revision_epoch\n    assert revision_counter == "0"','    assert payload["log_history_revision"] == ""')

# Builder unit tests now provide request.state used by the scoped production builder.
p=Path("tests/py/test_api_wave_a_asgi_routes.py"); s=p.read_text(encoding="utf-8")
s=s.replace("SimpleNamespace(app=asgi_app)","SimpleNamespace(app=asgi_app, state=SimpleNamespace())")
p.write_text(s,encoding="utf-8",newline="\n")

# Last.fm and history seams gained explicit account/library scope.
replace("tests/py/test_api_wave_b_asgi_routes.py","return lambda: load_log_history(app.config)","return lambda: load_log_history(app.config, scope=SimpleNamespace(account_id=1, library_id=1))")
p=Path("tests/py/test_api_wave_b_asgi_routes.py"); s=p.read_text(encoding="utf-8")
s=s.replace('lambda _config: {\n            "key": "lastfm",','lambda _config, **_scope: {\n            "key": "lastfm",')
s=s.replace('lambda _config: {"listen_history_count": 0, "pending_scrobble_count": 0}','lambda _config, **_scope: {"listen_history_count": 0, "pending_scrobble_count": 0}')
s=s.replace("def fake_run_in_threadpool(function, *args):","def fake_run_in_threadpool(function, *args, **kwargs):")
s=s.replace("return function(*args)","return function(*args, **kwargs)")
s=s.replace("def fake_save_lastfm_user_timezone(_config, timezone_name):","def fake_save_lastfm_user_timezone(_config, timezone_name, **_scope):")
s=s.replace('def fake_authenticate(config, username, password, user_timezone=""):', 'def fake_authenticate(config, username, password, user_timezone="", **_scope):')
p.write_text(s,encoding="utf-8",newline="\n")

# Boundary-only FastAPI fixtures need the same production bootstrap actor used by route tests.
p=Path("tests/py/test_log_history_route_scope.py"); s=p.read_text(encoding="utf-8")
s=s.replace("from tests.py.asgi_testing import run_asgi_request","from tests.py.asgi_testing import configure_test_bootstrap_actor, run_asgi_request")
s=s.replace("calls=[]; app=FastAPI()","calls=[]; app=FastAPI(); configure_test_bootstrap_actor(app)")
s=s.replace("app=FastAPI();app.include_router(routes.router);requested=[]","app=FastAPI(); configure_test_bootstrap_actor(app); app.include_router(routes.router);requested=[]")
p.write_text(s,encoding="utf-8",newline="\n")

# Execute the parameterized production SQL with its nullable album filter.
replace("tests/py/test_isolated_postgres_live.py","connection.execute(_missing_albums_sql()).fetchall()",'connection.execute(_missing_albums_sql(), {"album_key": None}).fetchall()')

# This snapshot test intentionally exercises the real missing-album loader, unlike the suite default stub.
p=Path("tests/py/test_library_browse_postgres.py"); s=p.read_text(encoding="utf-8")
old="def test_postgres_root_sidebar_reads_one_repeatable_read_snapshot_and_rolls_it_back(monkeypatch):"
new="def test_postgres_root_sidebar_reads_one_repeatable_read_snapshot_and_rolls_it_back(\n    monkeypatch, default_empty_missing_album_projection,\n):"
if old in s: s=s.replace(old,new,1)
anchor='''    repository = PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=connect,
        album_ratings_service=SnapshotAlbumRatingsService(),
    )
'''
extra=anchor+'''    monkeypatch.setattr(
        repository,
        "_load_missing_album_rows",
        lambda **kwargs: default_empty_missing_album_projection(repository, **kwargs),
    )
'''
if extra not in s:
    if anchor not in s: raise RuntimeError("snapshot repository anchor missing")
    s=s.replace(anchor,extra,1)
p.write_text(s,encoding="utf-8",newline="\n")

# Template projection fixture now supplies the runtime asset state used by the production response helper.
replace("tests/py/test_playback_capability_projection.py","app=SimpleNamespace(state=SimpleNamespace(config={}, library_state={}, cold_scan_handoff_lock=Lock(), auth_policy_config=None)),","app=SimpleNamespace(state=SimpleNamespace(config={}, library_state={}, cold_scan_handoff_lock=Lock(), auth_policy_config=None, runtime_asset_version='test-assets')),")

# Structured history now explicitly records scope; unattributed scanner events encode that in their IDs.
replace("tests/py/test_scan_state.py",'        "scan_outcome": "failed",\n    }]','        "scan_outcome": "failed",\n        "history_scope": None,\n    }]')
replace("tests/py/test_state.py",'        "id": "library-hydration-file-errors-omitted:9",','        "id": "library-hydration-file-errors-omitted:unattributed:9",\n        "history_scope": None,')
replace("tests/py/test_state.py",'        "id": "library-file-errors-omitted:14",','        "id": "library-file-errors-omitted:unattributed:14",\n        "history_scope": None,')
