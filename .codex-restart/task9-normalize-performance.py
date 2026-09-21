"""Normalize retained initial performance evidence without modifying test outcomes."""
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
entries=[]
for profile in ('playback','library','problems','scan'):
 path=ROOT/'.codex-restart'/f'task9-performance-{profile}.log'
 if not path.exists(): continue
 raw=path.read_bytes(); text=raw.decode('utf-16' if raw.startswith(b'\xff\xfe') else 'utf-8',errors='replace')
 chunks=re.split(r'^=== Performance target: ([\w-]+) ===\s*$',text,flags=re.M)
 for i in range(1,len(chunks),2):
  target,body=chunks[i:i+2]
  finals=[]
  for match in re.finditer(r'\[album-haven-playwright-result\]\s*(\{[^\r\n]+\})',body):
   try:
    value=json.loads(match.group(1))
    if value.get('phase')=='run-final': finals.append(value)
   except json.JSONDecodeError: pass
  counts=finals[-1] if finals else None
  policy_path=ROOT/'test-results/playwright-performance-targets'/target/'policy-result.json'
  policy=json.loads(policy_path.read_text()) if policy_path.exists() else None
  cases=[]
  for status,title in re.findall(r'^  \[([✓x])\] (.+)$',body,re.M):
   title=re.sub(r'\[playwright-performance-reporter\].*$','',title).strip()
   title=re.sub(r' \([\d.]+(?:ms|s|m)\)$','',title)
   item={'title':title,'status':'passed' if status=='✓' else 'failed'}
   if item not in cases: cases.append(item)
  errors=[]
  for match in re.finditer(r'^\s+\d+\) \[.*?\] › (.+?)\r?\n(.*?)(?=^\s+\d+\) \[|^=== Playwright Summary ===|\Z)',body,re.M|re.S):
   block=match.group(2)
   diagnostic=re.search(r'^\s+(?:Error:|Test timeout|TimeoutError:).+(?:\r?\n.*){0,12}',block,re.M)
   contexts=re.findall(r'Error Context: (.+)',block)
   errors.append({'case':match.group(1),'diagnostic':diagnostic.group(0).strip() if diagnostic else None,'errorContexts':contexts})
  entries.append({'target':target,'profile':profile,'counts':counts,'cases':cases,'errors':errors,'policy':policy,'log':str(path),'artifactRoot':str(ROOT/'test-results/playwright-performance-targets'/target)})
completed=[e for e in entries if e['counts']]
result={'targetsStarted':len(entries),'targetsCompleted':len(completed),'caseTotals':{k:sum(e['counts'].get(k,0) for e in completed) for k in ('total','completed','failed','skipped','errors')},'targets':entries}
result['caseTotals']['passed']=result['caseTotals']['completed']-result['caseTotals']['failed']-result['caseTotals']['skipped']
(ROOT/'.codex-restart/task9-performance-inventory.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='targets'}))
