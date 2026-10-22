'use strict';
// Independently authored against TEST-CONTRACT.md before product implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createSourceImportProviders;
test.before(async () => {({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));});
const id = n => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOB = id(1), REQUEST = id(2), TOP = id(3), ALBUM = id(4), OTHER = id(5), ACQUISITION = id(6);
const TIME = '2026-10-19T12:00:00+00:00';
const command = (patch = {}) => ({request_key: REQUEST, title: 'Imported Top', description: 'Private evidence',
  kind: 'text', filename: null, content: '1. Artist - Album', ...patch});
const row = (ref = '1', patch = {}) => ({row_ref: ref, candidate_line: Number(ref), raw_text: `${ref}. Artist - Album`,
  explicit_rank: Number(ref), catalog_ref: null, match_state: 'unresolved', ...patch});
const review = (patch = {}) => ({parser_version: 2, state: 'review_required', rows: [row()], issues: [], ordered_row_refs: ['1'], ...patch});
const job = (patch = {}) => ({job_ref: JOB, request_key: REQUEST, status: 'completed', revision: '2', title: 'Imported Top', kind: 'text',
  created_at: TIME, updated_at: TIME, phase: 'review_evidence', error: null, top_ref: null, source: command(), review: review(), ...patch});
const local = album_ref => ({kind: 'local_catalog', album_ref});
const finalCommand = (rows = [{row_ref: '1', selection: local(ALBUM)}], patch = {}) => ({request_key: JOB,
  title: 'Imported Top', description: '', source_review: {job_ref: JOB, revision: '2', rows}, ...patch});
const report = (row_ref = '1', patch = {}) => ({row_ref, position: Number(row_ref), original_explicit_rank: Number(row_ref),
  catalog_ref: ALBUM, outcome: 'matched', retained_row_ref: null, ...patch});
const receipt = (patch = {}) => ({action: 'create', request_key: JOB, top_ref: TOP, revision: '1', source_job_ref: JOB,
  source_locked: true, source_derived: true, source_report: [report()], ...patch});
function fixture(reply) {
  const calls = [], options = {scopeKey: 'account/session/library', signal: new AbortController().signal, isCurrent: () => true};
  const providers = createSourceImportProviders({request: async (...args) => {
    calls.push(args); return typeof reply === 'function' ? reply(...args) : reply;
  }});
  return {providers, options, calls};
}

for(const count of [2,3])for(let hole=0;hole<count;hole++)test(`finalization rejects sparse ${count}-row vector hole ${hole} before transport`,async()=>{
  const rows=Array.from({length:count},(_,n)=>({row_ref:String(n+1),selection:local(id(100+n))}));
  delete rows[hole];assert.equal(rows.length,count);assert.equal(Object.hasOwn(rows,hole),false);
  const h=fixture(receipt()),command=finalCommand(rows);
  await assert.rejects(async()=>h.providers.finalizeSourceImport({...h.options,command}));
  assert.equal(h.calls.length,0,'no malformed null occurrence may reach the write boundary');
  assert.equal(Object.hasOwn(rows,hole),false,'validation does not repair caller evidence');
});
