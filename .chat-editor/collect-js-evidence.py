"""Inspection-only transport for a network-isolated repair workspace."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

SHA = '3e34e1f57716bdfcd2dcea7959bc1213af7e13c6'
JOBS = {'portable': 105717713614, 'components': 105717713542, 'windows': 105717713502}
root = Path('.chat-editor')
root.mkdir(exist_ok=True)
sections = []
for name, job_id in JOBS.items():
    url = f'https://api.github.com/repos/idanilovqa/AlbumHaven/actions/jobs/{job_id}'
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request) as response:
        job = json.load(response)
    assert job['head_sha'] == SHA and job['status'] == 'completed', job
    request = urllib.request.Request(url + '/logs', headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN']})
    with urllib.request.urlopen(request) as response:
        raw = response.read().decode('utf-8')
    lines = [re.sub(r'^\d{4}-\d\d-\d\dT\S+\s?', '', re.sub(r'\x1b\[[0-9;]*m', '', line)) for line in raw.splitlines()]
    wanted = set()
    if name == 'components':
        starts = [i for i, line in enumerate(lines) if re.match(r'\s+\d+\) tests[\\/]', line)]
        if starts:
            start = starts[0]
            end = next((i + 1 for i in range(start, len(lines)) if re.match(r'\s+\d+ passed', lines[i])), len(lines))
            wanted.update(range(start, end))
    else:
        for i, line in enumerate(lines):
            if re.match(r'\s*not ok\s', line):
                start = max(0, i - 1)
                end = i + 1
                while end < len(lines) and lines[end].strip() != '...':
                    end += 1
                wanted.update(range(start, min(len(lines), end + 1)))
            if re.match(r'# (tests|pass|fail|cancelled|skipped|duration_ms) ', line):
                wanted.add(i)
    sections.append(f'## {name} job {job_id}; status={job["conclusion"]}; head={SHA}; run={job["run_id"]}\n')
    sections.extend(f'{i + 1:05d}: {lines[i]}\n' for i in sorted(wanted))
root.joinpath('js-evidence.txt').write_text(''.join(sections), encoding='utf-8')
# Only already tracked repository sources, never runner credentials or local data.
tracked = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', SHA], text=True).splitlines()
extensions = {'.js', '.cjs', '.mjs', '.json', '.css', '.html', '.py', '.sql', '.ps1', '.sh', '.yml', '.yaml', '.toml', '.ini', '.md', '.txt', '.svg'}
selected = [p for p in tracked if Path(p).suffix in extensions and not p.startswith(('docs/design-mockups/', 'docs/history/'))]
archive = subprocess.check_output(['git', 'archive', '--format=tar', SHA, '--', *selected])
packed = gzip.compress(archive, mtime=0)
encoded = base64.b64encode(packed).decode('ascii')
parts = []
for index, start in enumerate(range(0, len(encoded), 750000)):
    path = root / f'js-source-{index:03d}.b64'
    path.write_text(encoded[start:start + 750000] + '\n', encoding='ascii')
    parts.append(str(path))
manifest = {'source_head': SHA, 'source_files': selected, 'parts': parts, 'archive_sha256': hashlib.sha256(packed).hexdigest(), 'compressed_bytes': len(packed)}
root.joinpath('js-source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'failure_excerpt_lines': len(sections), 'source_files': len(selected), 'parts': len(parts), 'compressed_bytes': len(packed)}))
