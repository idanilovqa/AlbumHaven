import json, os, subprocess, sys, time
from pathlib import Path
session = json.loads(Path('.codex-restart/task5-database-session.json').read_text())
for line in Path(session['envPath']).read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        os.environ[key] = value
os.environ['ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL'] = os.environ.get('DATABASE_APP_URL') or os.environ['ALBUM_HAVEN_APP_DATABASE_URL']
results = []
for name, command in [('js', ['npm', 'run', 'test:js:all']), ('python', ['npm', 'test'])]:
    log = Path('.codex-restart/task9-full-' + name + '.log')
    start = time.time()
    with log.open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(['cmd.exe', '/d', '/c', *command], stdout=stream, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        Path('.codex-restart/task9-unit-active.json').write_text(json.dumps({'runner_pid': os.getpid(), 'child_pid': process.pid, 'suite': name, 'started': start, 'log': str(log)}))
        print(name + ' started PID ' + str(process.pid), flush=True)
        code = process.wait()
    result = {'suite': name, 'exit_code': code, 'seconds': round(time.time()-start, 2), 'log': str(log)}
    results.append(result)
    Path('.codex-restart/task9-unit-results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(result), flush=True)
sys.exit(int(any(item['exit_code'] for item in results)))
