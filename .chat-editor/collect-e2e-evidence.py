"""Read existing CI evidence; never execute tests or change the application branch."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

REPO = 'idanilovqa/AlbumHaven'
RUN = 35389965541
HEAD = 'ea256e48e5b72e1617f01c9954beec3b432e7da2'
BASE = '3e34e1f57716bdfcd2dcea7959bc1213af7e13c6'
JOBS = [105745899541, 105745899779, 105745899651, 105745899686, 105745899673, 105745899766, 105745899798, 105745899841, 105745899853]
OUT = Path('.chat-editor/e2e-run189')
OUT.mkdir(parents=True, exist_ok=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)
def request(path):
    req = urllib.request.Request('https://api.github.com/repos/' + REPO + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with opener.open(req, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers['Location']
        parsed = urllib.parse.urlparse(location)
        assert parsed.scheme == 'https' and (parsed.hostname.endswith('.blob.core.windows.net') or parsed.hostname.endswith('.actions.githubusercontent.com')), 'Unexpected download host'
        with urllib.request.urlopen(location, timeout=120) as response:
            return response.read()

run = json.loads(request('/actions/runs/' + str(RUN)))
assert run['head_sha'] == HEAD and run['status'] == 'completed'
metadata = []
for job_id in JOBS:
    job = json.loads(request('/actions/jobs/' + str(job_id)))
    assert job['run_id'] == RUN and job['head_sha'] == HEAD and job['status'] == 'completed'
    raw = request('/actions/jobs/' + str(job_id) + '/logs')
    text = raw.decode('utf-8', errors='replace')
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)
    text = re.sub(r'(?m)^\d{4}-\d\d-\d\dT\S+Z ', '', text)
    path = OUT / (str(job_id) + '.log')
    path.write_text(text, encoding='utf-8')
    record = {key: job.get(key) for key in ('id', 'name', 'status', 'conclusion', 'head_sha', 'started_at', 'completed_at', 'html_url', 'steps')}
    record.update({'log_file': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'lines': len(text.splitlines())})
    metadata.append(record)
    print(job['name'], job['conclusion'], record['lines'])
(OUT / 'manifest.json').write_text(json.dumps({'run_id': RUN, 'head_sha': HEAD, 'jobs': metadata}, indent=2), encoding='utf-8')
paths = subprocess.check_output(['git', 'diff', '--name-only', BASE, HEAD], text=True).splitlines()
text_paths = [path for path in paths if not path.endswith('.png')]
patch = subprocess.check_output(['git', 'diff', '--no-ext-diff', '--binary', BASE, HEAD, '--', *text_paths])
(OUT / 'previous-js-repair.patch').write_bytes(patch)
print('Exact previous repair delta:', len(patch), hashlib.sha256(patch).hexdigest())
