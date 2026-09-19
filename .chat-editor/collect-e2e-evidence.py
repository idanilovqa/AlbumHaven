"""Archive completed CI evidence only; never run tests or edit the PR branch."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = 'idanilovqa/AlbumHaven'
RUN = 35408558207
HEAD = '4e4d93dfcb3fb11bc43e2fd2c2e4381cd7d91091'
JOBS = [105803412142, 105803412324, 105803412244, 105803412178, 105803412242, 105803412226, 105803412190, 105803412187, 105803412223]
OUT = Path('.chat-editor/e2e-run192')
OUT.mkdir(parents=True, exist_ok=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)
def request(path):
    req = urllib.request.Request('https://api.github.com/repos/' + REPO + path, headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
        'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with opener.open(req, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers['Location']
        parsed = urllib.parse.urlparse(location)
        host = parsed.hostname or ''
        assert parsed.scheme == 'https' and (host.endswith('.blob.core.windows.net') or host.endswith('.actions.githubusercontent.com'))
        with urllib.request.urlopen(location, timeout=120) as response:
            return response.read()

run = json.loads(request('/actions/runs/' + str(RUN)))
assert run['head_sha'] == HEAD
metadata = []
for job_id in JOBS:
    job = json.loads(request('/actions/jobs/' + str(job_id)))
    assert job['run_id'] == RUN and job['head_sha'] == HEAD
    record = {key: job.get(key) for key in ('id', 'name', 'status', 'conclusion', 'head_sha', 'started_at', 'completed_at', 'html_url')}
    if job['status'] == 'completed':
        text = request('/actions/jobs/' + str(job_id) + '/logs').decode('utf-8', errors='replace')
        text = re.sub(r'\x1b\[[0-9;]*m', '', text)
        text = re.sub(r'(?m)^\d{4}-\d\d-\d\dT\S+Z ', '', text)
        path = OUT / (str(job_id) + '.log')
        path.write_text(text, encoding='utf-8')
        record.update({'log_file': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'lines': len(text.splitlines())})
    metadata.append(record)
    print(job['name'], job['status'], job.get('conclusion'))
(OUT / 'manifest.json').write_text(json.dumps({'run_id': RUN, 'head_sha': HEAD, 'run_status': run['status'], 'jobs': metadata}, indent=2), encoding='utf-8')

# Export only the computed-color evaluation from the failed Admin trace.
# Network records, credentials, DOM snapshots and private assets are not copied.
artifact_id = 10573273764
archive = request('/actions/artifacts/' + str(artifact_id) + '/zip')
assert hashlib.sha256(archive).hexdigest() == 'ab8f509efc8e268e25820e2bcacff68d0ece82067fee16e6b1e875a2ded60f42'
colors = []
with zipfile.ZipFile(io.BytesIO(archive)) as outer:
    for name in outer.namelist():
        if not name.endswith('/trace.zip'):
            continue
        with zipfile.ZipFile(io.BytesIO(outer.read(name))) as trace:
            for member in trace.namelist():
                if not member.endswith('.trace'):
                    continue
                selected = set()
                for line in trace.read(member).decode().splitlines():
                    event = json.loads(line)
                    expression = str(event.get('params', {}).get('expression', ''))
                    if event.get('type') == 'before' and 'backgroundColor' in expression and 'color-mix' in expression:
                        selected.add(event['callId'])
                    if event.get('type') == 'after' and event.get('callId') in selected:
                        colors.append({'call_id': event['callId'], 'result': event.get('result')})
(OUT / 'admin-hover-color-evidence.json').write_text(json.dumps({'artifact_id': artifact_id, 'evaluations': colors}, indent=2))
