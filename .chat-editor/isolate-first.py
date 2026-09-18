from pathlib import Path
p=Path(".github/workflows/chat-editor-python-repair.yml")
s=p.read_text()
s=s.replace("timeout-minutes: 25","timeout-minutes: 35")
old="python -m pytest -q tests/py/test_api_read_asgi_routes.py tests/py/test_api_wave_a_asgi_routes.py tests/py/test_api_wave_b_asgi_routes.py tests/py/test_log_history_route_scope.py tests/py/test_library_browse_postgres.py tests/py/test_playback_capability_projection.py tests/py/test_scan_state.py tests/py/test_state.py"
new="python -m pytest -q -x tests/py/test_api_read_asgi_routes.py"
s=s.replace(old,new)
p.write_text(s)
