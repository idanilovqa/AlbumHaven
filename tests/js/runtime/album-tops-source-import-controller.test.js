'use strict';
// Contract-first tests: no provider/controller implementation read by author.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createSourceImportController;
test.before(async () => {({createSourceImportController} = await F.load('album-tops/source-import-controller.mjs'));});
const id = n => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOB = id(1), REQUEST = id(2), TOP = id(3), ALBUM = id(4), OTHER = id(5), ACQUISITION = id(6);
const INPUT = {title: 'Imported Top', description: 'Private evidence', kind: 'text', filename: null, content: '2. B\n1. A'};
const row = ref => ({row_ref: ref, candidate_line: Number(ref), raw_text: `${ref}. Album`, explicit_rank: Number(ref), catalog_ref: null, match_state: 'unresolved'});
const review = (ordered = ['2','1']) => ({parser_version: 2, state: 'review_required', rows: [row('1'),row('2')], issues: [], ordered_row_refs: ordered});
const job = (patch = {}) => ({job_ref: JOB, request_key: REQUEST, status: 'completed', revision: '2', title: INPUT.title, kind: INPUT.kind,
  created_at: '2026-10-19T12:00:00Z', updated_at: '2026-10-19T12:00:00Z', phase: 'review_evidence', error: null, top_ref: null,
  source: {request_key: REQUEST, ...INPUT}, review: review(), ...patch});
const receipt = () => ({action: 'create', request_key: JOB, top_ref: TOP, revision: '1', source_job_ref: JOB,
  source_locked: true, source_derived: true, source_report: [
    {row_ref: '2', position: 1, original_explicit_rank: 2, catalog_ref: ALBUM, outcome: 'matched', retained_row_ref: null},
    {row_ref: '1', position: 2, original_explicit_rank: 1, catalog_ref: null, outcome: 'unresolved', retained_row_ref: null}]});
const local = album_ref => ({kind: 'local_catalog', album_ref});
const gate = () => {let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes; reject=no;}); return {promise,resolve,reject};};
const drain = async () => {for(let n=0;n<12;n++) await Promise.resolve();};
const operations = ['submitSourceImport','readSourceImport','processSourceImport','cancelSourceImport','finalizeSourceImport'];
function fixture(t) {
  const calls = [], replies = new Map(), live = {current: true}, keyCalls = [];
  const providers = Object.fromEntries(operations.map(name => [name, async options => {
    const captured = {name, options, command: options.command && structuredClone(options.command), job_ref: options.job_ref}; calls.push(captured);
    const queue = replies.get(name) || []; assert.ok(queue.length, `unexpected ${name} request`);
    const reply = queue.shift(); return typeof reply === 'function' ? reply(options) : reply;
  }]));
  const controller = createSourceImportController({providers, scopeKey:'account/session/library', isCurrent:()=>live.current,
    key:()=>{keyCalls.push(REQUEST);return REQUEST;}});
  t.after(()=>controller.dispose());
  return {controller,calls,live,keyCalls,reply(name,value){if(!replies.has(name))replies.set(name,[]);replies.get(name).push(value);}};
}
async function opened(t, value = job()) {
  const h=fixture(t);h.reply('readSourceImport',value);assert.equal(await h.controller.open(value.job_ref),true);return h;
}
const writeCalls = h => h.calls.filter(c=>c.name==='finalizeSourceImport');

test('intake submits then explicitly processes and finalizes a complete locked-order review',async t=>{
  const h=fixture(t), c=h.controller;
  assert.equal(c.getSnapshot().status,'idle');assert.equal(c.getSnapshot().job,null);
  h.reply('submitSourceImport',job({status:'queued',phase:'source_processing',revision:'1',review:null}));
  assert.equal(await c.submit({...INPUT}),true);assert.deepEqual(h.calls.map(x=>x.name),['submitSourceImport']);
  assert.deepEqual(h.calls[0].command,{request_key:REQUEST,...INPUT});assert.equal(writeCalls(h).length,0);
  h.reply('processSourceImport',job());assert.equal(await c.process(),true);
  assert.deepEqual(c.getSnapshot().rows,[{row_ref:'2',selection:null},{row_ref:'1',selection:null}]);assert.equal(c.getSnapshot().orderConfirmed,true);
  assert.equal(c.reorder(['1','2']),false,'known ranks cannot be overridden');
  assert.equal(await c.finalize(),false,'visiting review cannot infer a match');assert.equal(writeCalls(h).length,0);
  assert.equal(c.select('2',local(ALBUM)),true);h.reply('finalizeSourceImport',receipt());
  assert.equal(await c.finalize(),true);
  assert.deepEqual(writeCalls(h)[0].command,{request_key:JOB,title:INPUT.title,description:INPUT.description,
    source_review:{job_ref:JOB,revision:'2',rows:[{row_ref:'2',selection:local(ALBUM)},{row_ref:'1',selection:null}]}});
  assert.equal(c.getSnapshot().result.top_ref,TOP);
  assert.equal(await c.finalize(),true);assert.equal(writeCalls(h).length,1,'acknowledged finalize never writes twice');
  assert.equal(c.select('1',local(OTHER)),false);assert.equal(h.keyCalls.length,1);
});

test('ambiguous source order requires a complete permutation and explicit confirmation',async t=>{
  const h=await opened(t,job({review:review(null)})),c=h.controller;
  assert.deepEqual(c.getSnapshot().rows.map(x=>x.row_ref),['1','2']);assert.equal(c.getSnapshot().orderConfirmed,false);
  c.select('1',local(ALBUM));assert.equal(await c.finalize(),false);assert.equal(writeCalls(h).length,0);
  for(const bad of [[],['1'],['1','1'],['1','3'],['1','2','3']])assert.equal(c.reorder(bad),false);
  assert.equal(c.reorder(['2','1']),true);assert.equal(c.getSnapshot().orderConfirmed,false);
  assert.equal(c.confirmOrder(),true);assert.equal(c.getSnapshot().orderConfirmed,true);
  assert.equal(c.reorder(['1','2']),true);assert.equal(c.getSnapshot().orderConfirmed,false,'each explicit reorder needs renewed confirmation');
  assert.deepEqual(c.getSnapshot().job.review.rows.map(x=>x.row_ref),['1','2'],'immutable evidence is not reordered');
});

test('selection is explicit, typed and detached, preserving duplicate canonical choices',async t=>{
  const h=await opened(t),c=h.controller,input=local(ALBUM);
  for(const [ref,value]of [['3',input],['1',{kind:'local_catalog',album_ref:'bad'}],['1',{kind:'local_catalog',album_ref:ALBUM,path:'/private'}],
    ['1',{kind:'remote_acquisition',acquisition_ref:ACQUISITION,evidence_version:'B'.repeat(64)}]])assert.equal(c.select(ref,value),false);
  assert.equal(c.select('1',input),true);input.album_ref=OTHER;
  assert.equal(c.select('2',local(ALBUM)),true);
  assert.deepEqual(c.getSnapshot().rows,[{row_ref:'2',selection:local(ALBUM)},{row_ref:'1',selection:local(ALBUM)}]);
  assert.equal(Object.isFrozen(c.getSnapshot()),true);assert.equal(Object.isFrozen(c.getSnapshot().rows),true);
  assert.equal(Object.isFrozen(c.getSnapshot().rows[0].selection),true);
  assert.equal(c.select('1',null),true);assert.equal(c.getSnapshot().rows[1].selection,null);
});

test('uncertain submit retains exact original evidence and key for explicit retry',async t=>{
  const h=fixture(t),c=h.controller,input={...INPUT};h.reply('submitSourceImport',()=>{throw new Error('lost response');});
  assert.equal(await c.submit(input),false);input.content='changed by caller';
  assert.equal(c.getSnapshot().status,'uncertain');assert.equal(await c.cancel(),false);
  assert.equal(h.calls.length,1);h.reply('submitSourceImport',job({status:'queued',phase:'source_processing',review:null}));
  assert.equal(await c.retry(),true);assert.deepEqual(h.calls[1].command,h.calls[0].command);
  assert.equal(h.calls[1].command.content,INPUT.content);assert.equal(h.keyCalls.length,1);
  assert.equal(c.getSnapshot().error,null);assert.notEqual(c.getSnapshot().status,'uncertain');
});

test('uncertain finalization freezes complete reviewed command until exact retry',async t=>{
  const h=await opened(t),c=h.controller;c.select('2',local(ALBUM));
  h.reply('finalizeSourceImport',()=>{throw new Error('reply lost');});assert.equal(await c.finalize(),false);
  assert.equal(c.getSnapshot().status,'uncertain');assert.equal(c.select('1',local(OTHER)),false);
  assert.equal(c.reorder(['1','2']),false);assert.equal(await c.cancel(),false);
  h.reply('finalizeSourceImport',receipt());assert.equal(await c.retry(),true);
  assert.deepEqual(writeCalls(h)[1].command,writeCalls(h)[0].command);assert.equal(writeCalls(h).length,2);assert.equal(c.getSnapshot().error,null);
});

test('definitively rejected finalization permits review edits and does not auto-retry',async t=>{
  const h=await opened(t),c=h.controller;c.select('2',local(ALBUM));
  const failure=Object.assign(new Error('review conflict'),{responseRejected:true,status:409});
  h.reply('finalizeSourceImport',()=>{throw failure;});assert.equal(await c.finalize(),false);
  assert.equal(c.getSnapshot().status,'error');assert.equal(c.getSnapshot().error,failure);
  assert.equal(c.select('1',local(OTHER)),true);assert.equal(writeCalls(h).length,1);
});

test('duplicate pending submit makes one provider request and blocks review mutation',async t=>{
  const h=fixture(t),c=h.controller,pending=gate();h.reply('submitSourceImport',pending.promise);
  const first=c.submit({...INPUT}),second=c.submit({...INPUT});await drain();
  assert.equal(h.calls.length,1);assert.equal(c.select('1',local(ALBUM)),false);assert.equal(c.confirmOrder(),false);
  pending.resolve(job({status:'queued',phase:'source_processing',review:null}));assert.equal(await first,true);await second;
  assert.equal(h.calls.length,1);
});

test('cancel supersedes deferred process, aborts its signal and rejects late completion',async t=>{
  const h=await opened(t,job({status:'queued',phase:'source_processing',review:null})),c=h.controller,pending=gate();
  h.reply('processSourceImport',pending.promise);const work=c.process();await drain();
  const processing=h.calls.at(-1);assert.equal(processing.options.signal.aborted,false);
  h.reply('cancelSourceImport',job({status:'canceled',phase:'source_processing',review:null}));
  assert.equal(await c.cancel(),true);assert.equal(processing.options.signal.aborted,true);
  pending.resolve(job());assert.equal(await work,false);
  assert.equal(c.getSnapshot().job.status,'canceled');assert.equal(c.getSnapshot().job.source.content,INPUT.content);
  assert.equal(await c.process(),false);assert.equal(await c.finalize(),false);assert.equal(c.select('1',local(ALBUM)),false);
  assert.deepEqual(h.calls.map(x=>x.name),['readSourceImport','processSourceImport','cancelSourceImport']);
});

for(const action of ['submit','open','process','cancel','finalize'])for(const retirement of ['scope','dispose'])test(`${retirement} fences ${action} acknowledgement and later actions`,async t=>{
  const h=['submit','open'].includes(action)?fixture(t):await opened(t),c=h.controller,pending=gate();
  if(action==='finalize')c.select('2',local(ALBUM));
  const method={submit:'submitSourceImport',open:'readSourceImport',process:'processSourceImport',cancel:'cancelSourceImport',finalize:'finalizeSourceImport'}[action];
  h.reply(method,pending.promise);
  const request=action==='submit'?c.submit({...INPUT}):action==='open'?c.open(JOB):c[action]();await drain();
  const captured=h.calls.at(-1);assert.equal(captured.name,method);
  if(retirement==='dispose'){c.dispose();assert.equal(captured.options.signal.aborted,true);}else h.live.current=false;
  pending.resolve(action==='finalize'?receipt():job());assert.equal(await request,false);
  assert.equal(c.getSnapshot().result,null);const count=h.calls.length;
  assert.equal(await c.retry(),false);assert.equal(await c.finalize(),false);assert.equal(h.calls.length,count);
  if(retirement==='dispose'){
    assert.equal(c.getSnapshot().status,'retired');assert.equal(c.getSnapshot().job,null);assert.deepEqual(c.getSnapshot().rows,[]);
  }
});

for(const action of ['process','finalize'])test(`duplicate pending ${action} does not dispatch another request`,async t=>{
  const h=await opened(t),c=h.controller,pending=gate();if(action==='finalize')c.select('2',local(ALBUM));
  const method=action==='process'?'processSourceImport':'finalizeSourceImport';h.reply(method,pending.promise);
  const first=c[action](),second=c[action]();await drain();assert.equal(h.calls.filter(x=>x.name===method).length,1);
  pending.resolve(action==='finalize'?receipt():job());assert.equal(await first,true);await second;
  assert.equal(h.calls.filter(x=>x.name===method).length,1);
});

test('loading subscriber disposal prevents old-intent network dispatch',async t=>{
  const h=fixture(t),c=h.controller;let notices=0;
  c.subscribe(()=>{notices++;if(c.getSnapshot().status==='loading')c.dispose();});
  assert.equal(await c.submit({...INPUT}),false);assert.equal(h.calls.length,0);assert.ok(notices>0);
  assert.equal(c.getSnapshot().status,'retired');assert.equal(c.getSnapshot().job,null);
});

test('acknowledgement subscriber may open a successor without old result overwriting it',async t=>{
  const h=fixture(t),c=h.controller,pending=gate();let successor=null,started=false;
  h.reply('readSourceImport',job());h.reply('readSourceImport',pending.promise);
  c.subscribe(()=>{if(!started&&c.getSnapshot().job?.job_ref===JOB&&c.getSnapshot().status==='ready'){
    started=true;successor=c.open(OTHER);
  }});
  await c.open(JOB);await drain();assert.equal(started,true);assert.equal(h.calls.length,2);
  pending.resolve(job({job_ref:OTHER}));assert.equal(await successor,true);
  assert.equal(c.getSnapshot().job.job_ref,OTHER);assert.equal(writeCalls(h).length,0);
});

test('failed initial read and failed process retry exact identities without write or new key',async t=>{
  const h=fixture(t),c=h.controller;
  h.reply('readSourceImport',()=>{throw new Error('read failure');});assert.equal(await c.open(JOB),false);
  assert.equal(c.getSnapshot().status,'error');h.reply('readSourceImport',job());assert.equal(await c.retry(),true);
  assert.equal(h.calls[0].job_ref,JOB);assert.equal(h.calls[1].job_ref,JOB);
  h.reply('processSourceImport',()=>{throw new Error('worker response failure');});assert.equal(await c.process(),false);
  h.reply('processSourceImport',job());assert.equal(await c.retry(),true);
  assert.deepEqual(h.calls.slice(2).map(x=>[x.name,x.job_ref]),[['processSourceImport',JOB],['processSourceImport',JOB]]);
  assert.equal(h.keyCalls.length,0);assert.equal(writeCalls(h).length,0);
});

test('uncertain cancel retries exact job and preserves evidence until acknowledgement',async t=>{
  const h=await opened(t),c=h.controller;
  h.reply('cancelSourceImport',()=>{throw new Error('cancel response lost');});assert.equal(await c.cancel(),false);
  assert.equal(c.getSnapshot().status,'uncertain');assert.equal(c.getSnapshot().job.source.content,INPUT.content);
  assert.equal(c.select('2',local(ALBUM)),false);
  h.reply('cancelSourceImport',job({status:'canceled',phase:'source_processing'}));assert.equal(await c.retry(),true);
  assert.deepEqual(h.calls.slice(1).map(x=>[x.name,x.job_ref]),[['cancelSourceImport',JOB],['cancelSourceImport',JOB]]);
  assert.equal(c.getSnapshot().job.status,'canceled');assert.equal(writeCalls(h).length,0);
});

for(const kind of ['canceled','saved'])test(`resuming ${kind} job cannot silently create or process`,async t=>{
  const value=kind==='saved'?job({top_ref:TOP,phase:'top_created'}):job({status:'canceled',phase:'source_processing'});
  const h=await opened(t,value),c=h.controller;
  assert.equal(c.getSnapshot().job.job_ref,JOB);assert.equal(c.getSnapshot().job.source.content,INPUT.content);
  assert.equal(c.select('2',local(ALBUM)),false);await c.finalize();assert.equal(await c.process(),false);
  assert.equal(h.calls.length,1);assert.equal(writeCalls(h).length,0);
  if(kind==='saved')assert.equal(c.getSnapshot().job.top_ref,TOP,'saved Top remains available for explicit caller Open');
});

test('disposing clears evidence, listeners and retained review while pending read settles inertly',async t=>{
  const h=await opened(t),c=h.controller,pending=gate();let notifications=0;c.subscribe(()=>notifications++);
  h.reply('readSourceImport',pending.promise);const request=c.open(JOB);await drain();c.dispose();
  const count=notifications;pending.resolve(job());assert.equal(await request,false);assert.equal(notifications,count);
  assert.equal(c.getSnapshot().job,null);assert.deepEqual(c.getSnapshot().rows,[]);assert.equal(c.getSnapshot().result,null);
});

test('cancel supersedes pending refresh read of the acknowledged job',async t=>{
  const h=await opened(t),c=h.controller,pending=gate();h.reply('readSourceImport',pending.promise);
  const refresh=c.open(JOB);await drain();const read=h.calls.at(-1);
  h.reply('cancelSourceImport',job({status:'canceled',phase:'source_processing'}));assert.equal(await c.cancel(),true);
  assert.equal(read.options.signal.aborted,true);pending.resolve(job());assert.equal(await refresh,false);
  assert.equal(c.getSnapshot().job.status,'canceled');assert.equal(writeCalls(h).length,0);
});

test('admitted job and review are detached from mutable provider payloads',async t=>{
  const wire=job(),h=await opened(t,wire),snapshot=h.controller.getSnapshot();
  assert.equal(Object.isFrozen(snapshot.job),true);assert.equal(Object.isFrozen(snapshot.job.source),true);
  assert.equal(Object.isFrozen(snapshot.job.review.rows),true);assert.equal(Object.isFrozen(snapshot.job.review.rows[0]),true);
  wire.source.content='mutated';wire.review.rows[0].raw_text='mutated';wire.review.ordered_row_refs.reverse();
  assert.equal(snapshot.job.source.content,INPUT.content);assert.equal(snapshot.job.review.rows[0].raw_text,'1. Album');
  assert.deepEqual(snapshot.rows.map(x=>x.row_ref),['2','1']);assert.deepEqual(snapshot.job.review.ordered_row_refs,['2','1']);
});
