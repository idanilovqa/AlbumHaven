import os
import runpy
import sys
from urllib.parse import urlsplit, urlunsplit
from dotenv import load_dotenv

sys.path.insert(0, os.getcwd())
load_dotenv(r'C:\Repositories\album-haven-app\.env', override=False)
os.environ['MUSIC_APP_PORT'] = '5001'

def on_app_port(value):
    parts = urlsplit(value)
    host = parts.hostname
    if not host:
        raise ValueError('A configured application URL must include a host.')
    host = f'[{host}]' if ':' in host else host
    return urlunsplit(parts._replace(netloc=f'{host}:5001'))

base_url = os.environ.get('ALBUM_HAVEN_PUBLIC_BASE_URL', '').strip()
if base_url:
    os.environ['ALBUM_HAVEN_PUBLIC_BASE_URL'] = on_app_port(base_url)
origins = os.environ.get('ALBUM_HAVEN_TRUSTED_ORIGINS', '').strip()
if origins:
    os.environ['ALBUM_HAVEN_TRUSTED_ORIGINS'] = ','.join(
        dict.fromkeys(on_app_port(origin.strip()) for origin in origins.split(',') if origin.strip())
    )

sys.argv = ['start_https.py']
runpy.run_path('start_https.py', run_name='__main__')
