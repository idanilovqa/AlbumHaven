"""Read existing PR job logs; never mutate the repository or run tests."""
import json
import re
import subprocess

REPO = 'idanilovqa/AlbumHaven'
RUN = 35301542166


def api(path):
    return subprocess.run(['gh', 'api', f'repos/{REPO}/{path}'], check=True,
                          capture_output=True, text=True).stdout


def clean(text):
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)
    text = re.sub(r'^\d{4}-\d\d-\d\dT\S+\s?', '', text, flags=re.M)
    text = text.replace('%0A', '\n').replace('%0D', '')
    text = re.sub(r'postgres(?:ql)?://[^\s\"<>]+', '[database URL]', text)
    text = re.sub(r'(?:[A-Za-z]:[\\/]|/home/runner/)[^\n\r\'\"]*?(?=(?:tests|music_app|scripts)[\\/])', '[checkout]/', text)
    text = re.sub(r'(?i)((?:session_key|api_key|api_secret|password|token)\s*[=:]\s*)[^\s,}]+', r'\1[redacted]', text)
    return text


jobs = json.loads(api(f'actions/runs/{RUN}/jobs?per_page=100'))['jobs']
print(f'=== RUN {RUN} COMPLETE JOB INVENTORY ===')
for job in jobs:
    print(job['id'], job['name'], job['status'], job['conclusion'])
for job in jobs:
    if job['conclusion'] != 'failure':
        continue
    print(f"\n=== FAILURES {job['id']} {job['name']} ===", flush=True)
    lines = clean(api(f"actions/jobs/{job['id']}/logs")).splitlines()
    if 'JavaScript' in job['name']:
        for i, line in enumerate(lines):
            if not re.match(r'\s*not ok \d+', line):
                continue
            block = []
            for next_line in lines[i + 1:]:
                if next_line.strip() == '...':
                    break
                block.append(next_line)
            print(line)
            for entry in block:
                if re.search(r'location:|failureType:|code:|name:|at .*tests[\\/]', entry):
                    print(entry[:450])
            error_start = next((n for n, x in enumerate(block) if 'error:' in x), None)
            if error_start is not None:
                for entry in block[error_start:error_start + 12]:
                    if entry.strip() in ('actual:', 'input:') or 'Input:' in entry:
                        break
                    print(entry[:450])
    elif job['name'] == 'Python Tests':
        for line in lines:
            if re.match(r'(FAILED|ERROR) tests[/\\]', line) or re.search(r'=+ .*failed.*passed', line):
                print(line[:650])
    else:
        seen = set()
        count = 0
        for i, line in enumerate(lines):
            if re.match(r'\s*\d+\) ', line) or '[FAIL]' in line or '::error' in line:
                key = re.sub(r'\d+\)', ')', line).strip()
                if key in seen:
                    continue
                seen.add(key)
                excerpt = '\n'.join(lines[i:i + 22])
                print(excerpt[:1900])
                count += 1
                if count >= 26:
                    print('Additional errors remain in the original job log.')
                    break
        for line in lines:
            if re.match(r'\s*\d+ (?:failed|passed)(?:\s|$)', line):
                print(line)
