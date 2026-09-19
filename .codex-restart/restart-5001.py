import os
import runpy
import sys
from dotenv import load_dotenv
sys.path.insert(0, os.getcwd())
load_dotenv(r'C:\Repositories\album-haven-app\.env', override=False)
os.environ['MUSIC_APP_PORT'] = '5001'
sys.argv = ['start_https.py']
runpy.run_path('start_https.py', run_name='__main__')
