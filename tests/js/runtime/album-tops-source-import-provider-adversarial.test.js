'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createSourceImportProviders;
test.before(async () => {({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));});
const id = n => `a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const JOB=id(1), OTHER=id(2), REQUEST=id(3), TIME='2026-10-19T12:00:00+00:00';
const source=()=>({request_key:REQUEST,title:'Private source',description:'',kind:'text',filename:null,content:'1. Artist - Album'});
const summary=(patch={})=>({job_ref:JOB,request_key:REQUEST,status:'completed',revision:'2',title:'Private source',kind:'text',created_at:TIME,updated_at:TIME,phase:'review_evidence',error:null,top_ref:null,...patch});
const detail=(patch={})=>({...summary(),source:source(),review:{parser_version:2,state:'review_required',rows:[{row_ref:'1',candidate_line:1,raw_text:'1. Artist - Album',explicit_rank:1,catalog_ref:null,match_state:'unresolved'}],issues:[],ordered_row_refs:['1']},...patch});
for(const [method,suffix,post] of [['readSourceImport','',false],['processSourceImport','/process',true],['cancelSourceImport','/cancel',true]])for(const replyOriginal of [true,false]) {
  test(`${method} retains admitted job identity when options change: original reply ${replyOriginal}`,async()=>{
    let resolve;const deferred=new Promise(r=>{resolve=r;});const calls=[];
    const providers=createSourceImportProviders({request:(...args)=>{calls.push(args);return deferred;}});
    const options={job_ref:JOB,scopeKey:'account/session/library',signal:new AbortController().signal,isCurrent:()=>true};
    const pending=providers[method](options);
    assert.equal(calls.length,1);assert.equal(calls[0][0],`/album-tops/source-imports/${JOB}${suffix}`);
    assert.equal(calls[0][1],options);assert.deepEqual(calls[0][2],post?{}:undefined);
    options.job_ref=OTHER;
    resolve(detail({job_ref:replyOriginal?JOB:OTHER}));
    if(replyOriginal)assert.equal((await pending).job_ref,JOB);else await assert.rejects(pending);
    assert.equal(calls.length,1);
  });
}
for(const patch of [{status:'failed',error:'unknown_error'},{status:'failed',error:'x'.repeat(10000)},{status:'failed',error:null},{status:'queued',error:'source_processing_failed'}])for(const kind of ['summary','detail']) {
  test(`${kind} rejects invalid stored error invariant ${JSON.stringify(patch).slice(0,90)}`,async()=>{
    const providers=createSourceImportProviders({request:async()=>kind==='summary'?{jobs:[summary({...patch,phase:'source_processing'})],next_cursor:null}:detail({...patch,phase:'source_processing',review:null})});
    const options={job_ref:JOB,scopeKey:'account/session/library',signal:new AbortController().signal,isCurrent:()=>true};
    await assert.rejects(async()=>kind==='summary'?providers.listSourceImports(options):providers.readSourceImport(options));
  });
}
for(const kind of ['summary','detail'])test(`${kind} admits legitimate failed processing evidence`,async()=>{
  const patch={status:'failed',phase:'source_processing',error:'source_processing_failed'};
  const providers=createSourceImportProviders({request:async()=>kind==='summary'?{jobs:[summary(patch)],next_cursor:null}:detail({...patch,review:null})});
  const options={job_ref:JOB,scopeKey:'account/session/library',signal:new AbortController().signal,isCurrent:()=>true};
  const result=kind==='summary'?(await providers.listSourceImports(options)).jobs[0]:await providers.readSourceImport(options);
  assert.equal(result.status,'failed');assert.equal(result.error,'source_processing_failed');assert.equal(result.phase,'source_processing');
  if(kind==='detail'){assert.equal(result.review,null);assert.equal(result.source.content,source().content);}
});
