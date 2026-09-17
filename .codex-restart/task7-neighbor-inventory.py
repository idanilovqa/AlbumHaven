import os, json, subprocess, sys
from pathlib import Path
session = json.loads(Path('.codex-restart/task5-database-session.json').read_text())
for line in Path(session['envPath']).read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        os.environ[key] = value
os.environ['ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL'] = os.environ.get('DATABASE_APP_URL') or os.environ['ALBUM_HAVEN_APP_DATABASE_URL']
groups = {
    'task7-neighbor-inventory': [
        'test_lastfm_settings.py', 'test_lastfm_provider_protocol.py',
        'test_lastfm_sync_bridge.py', 'test_lastfm_retry.py', 'test_listen_history.py',
        'test_library_roots.py', 'test_library_roots_postgres.py', 'test_library_settings.py',
        'test_log_history_retry_persistence.py', 'test_lastfm_sync_state.py',
    ],
    'task8-review-post0066': [
        'test_appearance_waveform_history.py', 'test_appearance_preferences_postgres.py',
        'test_appearance_palettes.py', 'test_account_appearance_asgi.py',
        'test_compact_player_appearance.py', 'test_settings_loop_style_preferences.py',
        'test_settings_loop_style_postgres.py', 'test_settings_loop_style_routes.py',
    ],
}
failed = False
for name, files in groups.items():
    print(name + ' started', flush=True)
    result = subprocess.run([sys.executable, '-m', 'pytest', '-q', *['tests/py/' + file for file in files]], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    Path('.codex-restart/' + name + '.log').write_text(result.stdout)
    print(result.stdout[-16000:], flush=True)
    failed = failed or bool(result.returncode)
sys.exit(int(failed))
