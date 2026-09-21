const fs=require('node:fs');
const path=require('node:path');
const log=fs.readFileSync('.codex-restart/task9-functional-all.stdout.log','utf8');
const contract=JSON.parse(fs.readFileSync('tests/ci/functional-shards.json','utf8'));
const rows=[]; let shard='';
for(const line of log.split(/\r?\n/)){
 const s=line.match(/^Running shard (\S+) on ports (\d+)\/(\d+)/); if(s) shard=s[1];
 const m=line.match(/^\s*(ok|x|-)\s+\d+\s+\[([^\]]+)\]\s+›\s+(.+?):(\d+):(\d+)\s+›\s+(.+?)\s+\(([^()]*)\)\s*$/);
 if(m) rows.push({shard,status:m[1]==='ok'?'passed':m[1]==='x'?'failed':'skipped',project:m[2],file:m[3].replaceAll('\\','/'),line:Number(m[4]),title:m[6],duration:m[7]});
}
const blocks=[...log.matchAll(/^\s+\d+\) \[([^\]]+)\] › (.+?):(\d+):(\d+) › (.+?)\s*$/gm)];
for(let i=0;i<blocks.length;i++){
 const m=blocks[i]; const block=log.slice(m.index,blocks[i+1]?.index??log.length);
 const row=rows.find(r=>r.file===m[2].replaceAll('\\','/')&&r.title===m[5].trim());
 if(!row)continue;
 row.error=block.split(/\r?\n/).slice(1).filter(Boolean).slice(0,28).join('\n');
 row.errorContext=block.match(/Error Context: (.+)/)?.[1]?.trim()??null;
 row.trace=block.match(/\s+(\.\.\\.*?\\trace\.zip)\s*$/m)?.[1]?.trim()??null;
}
const expected=contract.shards.flatMap(s=>s.invocations.flatMap(i=>i.cases.map(c=>({shard:s.name,...c}))));
const missing=expected.filter(e=>!rows.some(r=>r.title===e.case&&r.file===e.test));
const summary={total:rows.length,passed:rows.filter(r=>r.status==='passed').length,failed:rows.filter(r=>r.status==='failed').length,skipped:rows.filter(r=>r.status==='skipped').length,expected:expected.length,missing,byShard:Object.fromEntries(contract.shards.map(s=>[s.name,{total:rows.filter(r=>r.shard===s.name).length,passed:rows.filter(r=>r.shard===s.name&&r.status==='passed').length,failed:rows.filter(r=>r.shard===s.name&&r.status==='failed').length}]))};
fs.writeFileSync('.codex-restart/task9-functional-inventory.json',JSON.stringify({summary,artifacts:[...log.matchAll(/^Failure artifacts retained at: (.+)$/gm)].map(m=>m[1].trim()),cases:rows},null,2)+'\n');
console.log(JSON.stringify(summary));