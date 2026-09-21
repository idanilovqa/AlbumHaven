"""Launch this Settings checkout with the owner's existing real-library config."""
import os
from pathlib import Path
import runpy
import sys

from dotenv import load_dotenv

root = Path(__file__).resolve().parents[1]
os.chdir(root)
sys.path.insert(0, str(root))
for name in list(os.environ):
    if name.startswith(('ALBUM_HAVEN_E2E_', 'ALBUM_HAVEN_FAKE_E2E_', 'PLAYWRIGHT_')):
        os.environ.pop(name)
for name in ('ALBUM_HAVEN_FIXTURE_ROOT', 'ALBUM_HAVEN_FIXTURE_PROFILE', 'ALBUM_HAVEN_MEDIA_ROOT'):
    os.environ.pop(name, None)
load_dotenv(r'C:\Repositories\album-haven-app\.env', override=True)
os.environ['MUSIC_APP_PORT'] = '5002'
os.environ['ALBUM_HAVEN_PUBLIC_BASE_URL'] = 'https://localhost:5002'
sys.argv = ['start_https.py', *sys.argv[1:]]
runpy.run_path(str(root / 'start_https.py'), run_name='__main__')
