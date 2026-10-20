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

for(const count of [2,3])for(let hole=0;hole<count;hole++)test(`sparse ${count}-row permutation with hole ${hole} preserves exact review snapshot`,async t=>{
  const refs=Array.from({length:count},(_,n)=>String(n+1));
  const h=await opened(t,job({review:{...review(null),rows:refs.map(row)}})),c=h.controller;
  const before=c.getSnapshot(),copy=structuredClone(before),sparse=[...refs];delete sparse[hole];
  assert.equal(sparse.length,count);assert.equal(Object.hasOwn(sparse,hole),false);
  assert.equal(c.reorder(sparse),false);
  assert.equal(c.getSnapshot(),before,'rejected permutation cannot publish or replace current review');
  assert.deepEqual(c.getSnapshot(),copy,'every source row, selection and confirmation stays intact');
  assert.equal(h.calls.length,1);assert.equal(writeCalls(h).length,0);
  assert.equal(c.reorder([...refs].reverse()),true,'dense complete permutation remains usable after rejection');
  assert.deepEqual(c.getSnapshot().rows.map(x=>x.row_ref),[...refs].reverse());
});
