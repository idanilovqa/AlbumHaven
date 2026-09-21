import json,os,subprocess,sys
from pathlib import Path
session=json.loads(Path('.codex-restart/task9-repair-databases.json').read_text(encoding='utf-8-sig'))
for line in Path(session['envPath']).read_text(encoding='utf-8-sig').splitlines():
 if '=' in line:
  key,value=line.split('=',1);os.environ[key]=value
os.environ.pop('PGPASSWORD',None)
python=Path(r'C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe')
os.environ['PATH']=str(python.parent)+os.pathsep+os.environ['PATH']
os.environ['PLAYWRIGHT_PYTHON']=str(python)
os.environ['PLAYWRIGHT_CHROME_EXECUTABLE']=r'C:\Users\Rendref\.cache\album-haven\chrome-for-testing-151.0.7922.138\chrome.exe'
os.environ['ALBUM_HAVEN_APPROVED_COVER_ROOT']=r'C:\Repositories\album-haven-test-data-gallery-refactor\dist\profiles\utility-problematic-files\media\covers\approved'
log=Path(sys.argv[1])
with log.open('w',encoding='utf-8') as output:
 child=subprocess.Popen([str(python),'-m','pytest',*sys.argv[2:]],stdout=output,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
 Path('.codex-restart/task9-repair-pytest-active.json').write_text(json.dumps({'runner':os.getpid(),'child':child.pid,'log':str(log)}))
 code=child.wait()
print(log.read_text(encoding='utf-8')[-4500:])
sys.exit(code)
