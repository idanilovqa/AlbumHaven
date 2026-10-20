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

test('cancel abort reentry admits only one cancellation and leaves late process inert',async t=>{
  const h=await opened(t),c=h.controller,processing=gate(),canceling=gate();let nested=null;
  h.reply('processSourceImport',processing.promise);h.reply('cancelSourceImport',canceling.promise);
  const old=c.process();await drain();const active=h.calls.at(-1);
  assert.equal(active.name,'processSourceImport');
  active.options.signal.addEventListener('abort',()=>{nested=c.cancel();},{once:true});
  const outer=c.cancel();await drain();assert.ok(nested,'abort listener actually entered cancel');
  assert.equal(h.calls.filter(x=>x.name==='cancelSourceImport').length,1);
  const admitted=h.calls.find(x=>x.name==='cancelSourceImport');assert.equal(admitted.options.signal.aborted,false);
  canceling.resolve(job({status:'canceled'}));
  const results=await Promise.all([outer,nested]);assert.equal(results.filter(x=>x===true).length,1);
  assert.equal(c.getSnapshot().status,'ready');assert.equal(c.getSnapshot().job.status,'canceled');
  processing.resolve(job());assert.equal(await old,false);
  assert.equal(c.getSnapshot().job.status,'canceled');assert.equal(h.calls.length,3);
});

test('ready subscriber successor makes superseded acknowledgement return false',async t=>{
  const h=fixture(t),c=h.controller,first=gate(),next=gate();let successor=null,started=false;
  h.reply('readSourceImport',first.promise);h.reply('readSourceImport',next.promise);
  c.subscribe(()=>{if(!started&&c.getSnapshot().status==='ready'&&c.getSnapshot().job?.job_ref===JOB){
    started=true;successor=c.open(OTHER);
  }});
  const old=c.open(JOB);await drain();first.resolve(job());
  assert.equal(await old,false,'ready publication can synchronously retire the acknowledged intent');
  assert.equal(started,true);assert.equal(h.calls.length,2);
  assert.equal(c.getSnapshot().status,'loading');
  next.resolve(job({job_ref:OTHER}));assert.equal(await successor,true);
  assert.equal(c.getSnapshot().job.job_ref,OTHER);assert.equal(h.calls.length,2);assert.equal(writeCalls(h).length,0);
});
