"""Read existing CI evidence without modifying the repository or running tests."""
import json
import re
import subprocess

REPO = 'idanilovqa/AlbumHaven'
RUN = 35301542166


def clean(text):
    text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'^\d{4}-\d\d-\d\dT\S+\s?', '', text, flags=re.M)
    text = text.replace('%0A', '\n').replace('%0D', '')
    text = re.sub(r'postgres(?:ql)?://[^\s\"<>]+', '[database URL]', text)
    text = re.sub(r'(?i)((?:session_key|api_key|api_secret|password|token)\s*[=:]\s*)[^\s,}]+', r'\1[redacted]', text)
    return ''.join(c for c in text if c in '\n\r\t' or ord(c) >= 32)


def api(path):
    result = subprocess.run(['gh', 'api', '--allow-escape-sequences', f'repos/{REPO}/{path}'],
                            capture_output=True, text=True)
    if result.returncode:
        print('EVIDENCE READ ERROR:', clean(result.stderr)[:800], flush=True)
        return None
    return result.stdout


jobs = json.loads(api(f'actions/runs/{RUN}/jobs?per_page=100'))['jobs']
print(f'=== RUN {RUN} JOB INVENTORY ===')
for job in jobs:
    print(job['id'], job['name'], job['status'], job['conclusion'])
for job in jobs:
    if job['conclusion'] != 'failure':
        continue
    print(f"\n=== FAILURES {job['id']} {job['name']} ===", flush=True)
    content = api(f"actions/jobs/{job['id']}/logs")
    if content is None:
        continue
    lines = clean(content).splitlines()
    if 'JavaScript' in job['name']:
        for i, line in enumerate(lines):
            if not re.match(r'\s*not ok \d+', line):
                continue
            block = []
            for entry in lines[i + 1:]:
                if entry.strip() == '...':
                    break
                block.append(entry)
            print(line)
            for entry in block:
                if re.search(r'location:|failureType:|code:|name:|at .*tests[\\/]', entry):
                    print(entry[:450])
            start = next((n for n, x in enumerate(block) if 'error:' in x), None)
            if start is not None:
                for entry in block[start:start + 12]:
                    if entry.strip() in ('actual:', 'input:') or 'Input:' in entry:
                        break
                    print(entry[:450])
    elif job['name'] == 'Python Tests':
        for line in lines:
            if re.match(r'(FAILED|ERROR) tests[/\\]', line) or re.search(r'=+ .*failed.*passed', line):
                print(line[:650])
    else:
        seen = set()
        for i, line in enumerate(lines):
            if re.match(r'\s*\d+\) ', line) or '[FAIL]' in line:
                key = re.sub(r'\d+\)', ')', line).strip()
                if key in seen:
                    continue
                seen.add(key)
                print('\n'.join(lines[i:i + 22])[:1900])
                if len(seen) >= 26:
                    print('Additional errors retained in original job log.')
                    break
        for line in lines:
            if re.match(r'\s*\d+ (?:failed|passed)(?:\s|$)', line):
                print(line)
