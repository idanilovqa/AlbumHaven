const fs=require('node:fs');
const log=fs.readFileSync('.codex-restart/task9-functional-component.stdout.log','utf8');
const cases=[...log.matchAll(/^\s*(ok|x|-)\s+\d+\s+(.+?):(\d+):(\d+)\s+›\s+(.+?)\s+\(([^()]*)\)\s*$/gm)].map(m=>({status:m[1]==='ok'?'passed':m[1]==='x'?'failed':'skipped',file:m[2].replaceAll('\\','/'),line:Number(m[3]),title:m[5],duration:m[6]}));
const blocks=[...log.matchAll(/^\s+\d+\) (.+?):(\d+):(\d+) › (.+?)\s*$/gm)];
for(let i=0;i<blocks.length;i++){const m=blocks[i];const b=log.slice(m.index,blocks[i+1]?.index??log.length);const c=cases.find(c=>c.file===m[1].replaceAll('\\','/')&&c.title===m[4].trim());if(c){c.error=b.split(/\r?\n/).slice(1).filter(Boolean).slice(0,28).join('\n');c.errorContext=b.match(/Error Context: (.+)/)?.[1]?.trim()??null;c.trace=b.match(/\s+(test-results\\.*?\\trace\.zip)\s*$/m)?.[1]?.trim()??null;}}
const summary={total:cases.length,passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,skipped:cases.filter(c=>c.status==='skipped').length};
fs.writeFileSync('.codex-restart/task9-component-inventory.json',JSON.stringify({summary,cases},null,2)+'\n');console.log(JSON.stringify(summary));