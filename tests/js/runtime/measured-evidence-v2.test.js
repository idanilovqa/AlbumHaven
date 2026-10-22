'use strict';
// Pure owner only: no app, browser, audio, transport or persistence harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const owner = path.join(root, 'music_app/static/js/telemetry/measured-evidence.mjs');
const modulePromise = import(pathToFileURL(owner).href);
const vectors = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/measured_evidence_v2_vectors.json'), 'utf8'));
const cases = Object.fromEntries(vectors.positives.map(item => [item.name, item]));
const copy = value => JSON.parse(JSON.stringify(value));
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function mutate(envelope, changes) {
  const value = copy(envelope);
  for (const change of changes) {
    let target = value;
    for (const key of change.path.slice(0, -1)) target = target[key];
    const key = change.path.at(-1);
    if (change.op === 'delete') delete target[key];
    else target[key] = copy(change.value);
  }
  return value;
}
function compare(m, state, body, observed, binding = vectors.binding) {
  return m.compareCheckpointV2(state, body, binding, observed,
    state ? hash(m.checkpointDigestInputV2(state.latest)) : null);
}
function accepted(m, name) {
  const item = cases[name], previous = item.previous ? accepted(m, item.previous) : null;
  return compare(m, previous, item.envelope, item.observed_ranges).state;
}
function nextEmpty(m, state) {
  return { ...copy(state.latest), checkpoint_sequence: state.latest.checkpoint_sequence + 1,
    previous_digest: hash(m.checkpointDigestInputV2(state.latest)), epochs: [], slices: [], terminal: null };
}
function rejected(action, code = null) {
  assert.throws(action, error => error instanceof Error && (!code || error.message === code));
}
function assertFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const item of Object.values(value)) assertFrozen(item);
}

for (const item of vectors.positives) test(`design golden ${item.name}: bytes, reduction, replay, isolation`, async () => {
  const m = await modulePromise, original = copy(item.envelope);
  // Copy the trusted state to ensure compare does not freeze caller objects.
  const previous = item.previous ? copy(accepted(m, item.previous)) : null, before = copy(previous);
  const result = compare(m, previous, original, item.observed_ranges);
  assert.equal(result.kind, 'accept'); assertFrozen(result);
  assert.equal(m.canonicalCheckpointV2(original), item.canonical);
  assert.equal(result.digestInput, 'AlbumHaven:rendered-position-slices-v2\n' + item.canonical);
  assert.equal(hash(result.digestInput), item.digest);
  assert.deepEqual(m.parseCheckpointV2(item.canonical), original);
  assert.deepEqual(result.state.latest, original);
  for (const [key, expected] of Object.entries(item.expected_cursor)) assert.equal(result.state[key], expected);
  assert.deepEqual(previous, before);
  const replay = compare(m, result.state, original, item.observed_ranges);
  assert.deepEqual(replay, { kind: 'replay', digestInput: result.digestInput, state: null });
  original.cumulative.histogram[0][1] = 999;
  assert.deepEqual(result.state.latest, item.envelope);
  if (previous) {
    assert.equal(Object.isFrozen(previous), false);
    assert.equal(Object.isFrozen(previous.epochs[0]), false);
    previous.epochs[0].wall_origin_us = 123;
    assert.deepEqual(result.state.epochs[0], before.epochs[0]);
  }
});
for (const item of vectors.negative_mutations) test(`design rejection ${item.name}`, async () => {
  const m = await modulePromise, base = cases[item.base], body = mutate(base.envelope, item.changes);
  const parent = item.previous === 'inherit' ? base.previous : item.previous;
  const previous = parent ? accepted(m, parent) : null;
  rejected(() => item.stage === 'normalize' ? m.normalizeCheckpointV2(body) :
    compare(m, previous, body, base.observed_ranges), item.code);
});

test('exact occurrence mapping, unsafe conversion, calendar uncertainty', async () => {
  const m = await modulePromise;
  for (const item of vectors.mapping) assert.deepEqual(m.occurrenceBoundaryV2(item.epoch, item.tick, item.rate), item.expected);
  const epoch = copy(vectors.mapping[0].epoch);
  rejected(() => m.occurrenceBoundaryV2(epoch, Number.MAX_SAFE_INTEGER, 48000));
  epoch.audio_origin_tick = 1; rejected(() => m.occurrenceBoundaryV2(epoch, 0, 48000));
  epoch.audio_origin_tick = 0; epoch.wall_origin_us = 0;
  assert.deepEqual(m.occurrenceBoundaryV2(epoch, 0, 48000), { wall_us: 0, uncertainty_us: 21 });
  // Interval [-21,21] crosses the calendar boundary: no exact bucket assertion.
});

test('strict duplicate keys, lexical numbers, malformed JSON and exact raw byte cap', async () => {
  const m = await modulePromise, body = cases.one_second.canonical;
  const bad = [body.slice(0,-1) + ',"version":"rendered-position-slices-v2"}',
    body.replace('"quality":"app_clock_estimate"', '"quality":"app_clock_estimate","qual\\u0069ty":"unknown"'),
    ...['48000.0','48e3','NaN','Infinity','9007199254740992'].map(n => body.replace('"sample_rate":48000', '"sample_rate":' + n)),
    body.replace('"checkpoint_sequence":0','"checkpoint_sequence":-0'),
    body + 'x', body.slice(0,-1), '{"x":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}', '\u00e9'];
  for (const raw of bad) rejected(() => m.parseCheckpointV2(raw));
  const padded = body + ' '.repeat(262144-body.length);
  assert.deepEqual(m.parseCheckpointV2(padded), cases.one_second.envelope);
  rejected(() => m.parseCheckpointV2(padded + ' '));
  const decoded = copy(cases.one_second.envelope); decoded.checkpoint_sequence = -0;
  rejected(() => m.normalizeCheckpointV2(decoded));
});

test('binding and durable source containment cannot use histogram overlap', async () => {
  const m = await modulePromise, item = cases.one_second;
  for (const key of ['decoder_instance_id','process_epoch','device_id','session_id']) {
    const binding = {...vectors.binding, [key]:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
    rejected(() => compare(m,null,item.envelope,item.observed_ranges,binding),'identity_changed');
  }
  rejected(() => compare(m,null,item.envelope,item.observed_ranges,{...vectors.binding,sample_rate:44100}),'identity_changed');
  for (const observed of [[],[[0,1]],[[0,20000],[20001,48000]],[[0,20000],[20000,48000]],[[2,1]]])
    rejected(() => compare(m,null,item.envelope,observed));
});

test('stale, conflict, finalized successor, repeated loss and retired epoch', async () => {
  const m = await modulePromise; let state = accepted(m,'collection_limited');
  const stale = compare(m,state,cases.one_second.envelope,[[0,48000]]);
  assert.equal(stale.kind,'stale'); assert.equal(stale.state,null);
  const changed = copy(state.latest); changed.terminal='client_stopped';
  rejected(() => compare(m,state,changed,[[0,48000]]),'sequence_conflict');
  rejected(() => compare(m,state,nextEmpty(m,state),[[0,48000]]),'already_finalized');
  state=accepted(m,'occurrence_loss'); let body=nextEmpty(m,state);
  rejected(() => compare(m,state,body,[[0,48000]]),'unchanged_checkpoint');
  body.cumulative.occurrence_complete=true; rejected(() => compare(m,state,body,[[0,48000]]));
  state=accepted(m,'unknown_to_known'); body=nextEmpty(m,state);
  const item=copy(cases.unknown.envelope.slices[0]);
  Object.assign(item,{slice_id:2,first_consumption_frame:2,render_start_tick:2,render_end_tick:3,runs:[[2,1,2]]});
  body.slices=[item]; Object.assign(body.cumulative,{rendered_frames:3,max_observed_frame:3,histogram:[[0,3]],coverage_intervals:[[0,3]]});
  rejected(() => compare(m,state,body,[[0,3]]),'retired_epoch');
});

test('finite shape limits exactly at and above boundaries', async () => {
  const m=await modulePromise,base=copy(cases.one_frame_tick_one.envelope);
  // Normalization only. Duplicate shapes here are intentionally not accepted history.
  for(const [key,limit,item] of [['slices',128,base.slices[0]],['epochs',16,base.epochs[0]]]) {
    const body=copy(base); body[key]=Array.from({length:limit},()=>copy(item));
    m.normalizeCheckpointV2(body); body[key].push(copy(item)); rejected(()=>m.normalizeCheckpointV2(body));
  }
  let body=copy(base),item=body.slices[0];
  Object.assign(item,{frames:256,render_start_tick:0,render_end_tick:256,runs:Array.from({length:256},(_,i)=>[0,1,i])});
  m.normalizeCheckpointV2(body);
  item.runs.push([0,1,256]); item.frames=257; item.render_end_tick=257; rejected(()=>m.normalizeCheckpointV2(body));
  item.runs.pop(); item.frames=256; item.render_end_tick=256;
  body.slices=Array.from({length:8},()=>copy(item)); m.normalizeCheckpointV2(body);
  body.slices.push(copy(base.slices[0])); rejected(()=>m.normalizeCheckpointV2(body));
  for(const [field,max] of [['checkpoint_sequence',719],['slice_id',7199],['epoch_id',63]]) {
    body=copy(base);
    if(field==='checkpoint_sequence') Object.assign(body,{checkpoint_sequence:max,previous_digest:'0'.repeat(64)});
    else if(field==='slice_id') body.slices[0][field]=max;
    else body.epochs[0][field]=max;
    m.normalizeCheckpointV2(body);
  }
  body=copy(base);
  Object.assign(body.cumulative,{rendered_frames:2048,max_observed_frame:98304000,histogram:Array.from({length:2048},(_,i)=>[i,1]),coverage_intervals:[]});
  m.normalizeCheckpointV2(body); body.cumulative.histogram.push([2048,1]); rejected(()=>m.normalizeCheckpointV2(body));
  body=copy(base);
  Object.assign(body.cumulative,{rendered_frames:4096,max_observed_frame:8191,histogram:[[0,4096]],coverage_intervals:Array.from({length:4096},(_,i)=>[2*i,2*i+1])});
  m.normalizeCheckpointV2(body); body.cumulative.coverage_intervals.push([8192,8193]); rejected(()=>m.normalizeCheckpointV2(body));
});

test('coverage cap retains exact prior union then can merge, but never recover completeness', async () => {
  const m=await modulePromise; let state=null;
  // Closed-form disjoint one-frame scenario, not a reference reducer:
  // n frames at even positions have n intervals [2i,2i+1), bin-0 weight n.
  for(let batch=0;batch<16;batch++) {
    const count=(batch+1)*256,body=state===null?copy(cases.one_second.envelope):nextEmpty(m,state);
    const item=copy(cases.one_second.envelope.slices[0]);
    Object.assign(item,{slice_id:batch,first_consumption_frame:batch*256,frames:256,render_start_tick:batch*256,render_end_tick:count,
      runs:Array.from({length:256},(_,j)=>{const i=batch*256+j;return [2*i,1,i];})});
    body.slices=[item];
    Object.assign(body.cumulative,{rendered_frames:count,max_observed_frame:2*count-1,histogram:[[0,count]],
      coverage_intervals:Array.from({length:count},(_,i)=>[2*i,2*i+1])});
    const result=compare(m,state,body,[[0,8193]]); assert.equal(result.kind,'accept'); state=result.state;
  }
  const old=copy(state); let body=nextEmpty(m,state); const item=copy(cases.one_second.envelope.slices[0]);
  Object.assign(item,{slice_id:16,first_consumption_frame:4096,frames:1,render_start_tick:4096,render_end_tick:4097,runs:[[8192,1,4096]]});
  body.slices=[item]; Object.assign(body.cumulative,{rendered_frames:4097,max_observed_frame:8193,histogram:[[0,4097]],coverage_complete:false});
  const result=compare(m,state,body,[[0,8193]]); assert.equal(result.kind,'accept'); assert.deepEqual(state,old);
  assert.deepEqual(result.state.latest.cumulative.coverage_intervals,old.latest.cumulative.coverage_intervals);
  state=result.state; body=nextEmpty(m,state);
  Object.assign(item,{slice_id:17,first_consumption_frame:4097,frames:8193,render_start_tick:4097,render_end_tick:12290,runs:[[0,8193,4097]]});
  body.slices=[item]; Object.assign(body.cumulative,{rendered_frames:12290,histogram:[[0,12290]],coverage_intervals:[[0,8193]]});
  assert.equal(compare(m,state,body,[[0,8193]]).kind,'accept');
  body.cumulative.coverage_complete=true; rejected(()=>compare(m,state,body,[[0,8193]]));
});

test('v1 prefix and version remain separate',async()=>{
  const m=await modulePromise;
  // Git may check text out as CRLF; compare the committed LF text prefix.
  // Do not normalize wire/canonical JSON or any other source whitespace.
  const sourceLF = Buffer.from(fs.readFileSync(owner, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  assert.equal(createHash('sha256').update(sourceLF.subarray(0,9655)).digest('hex'),
    'ead31489540f18e68ded792a8df6fcffac079a7a5ca86ff0afdd147e179d89b3');
  assert.equal(m.VERSION,'rendered-position-histogram-v1');
  assert.equal(m.V2_VERSION,'rendered-position-slices-v2');
  assert.notEqual(m.VERSION,m.V2_VERSION);
});

test('accepted maximum slices, newly used epochs, lifetime epochs and total runs',async()=>{
  const m=await modulePromise;let state=null;
  // 16 epochs * 8 one-frame slices, four packets: a closed-form [0,512) union.
  for(let batch=0;batch<4;batch++) {
    const body=state===null?copy(cases.one_second.envelope):nextEmpty(m,state);
    body.epochs=Array.from({length:16},(_,i)=>({...copy(cases.one_second.envelope.epochs[0]),epoch_id:batch*16+i}));
    body.slices=Array.from({length:128},(_,offset)=>{
      const index=batch*128+offset,item=copy(cases.one_frame_tick_one.envelope.slices[0]);
      return Object.assign(item,{slice_id:index,epoch_id:batch*16+Math.floor(offset/8),first_consumption_frame:index,
        render_start_tick:offset%8,render_end_tick:offset%8+1,runs:[[index,1,offset%8]]});
    });
    const total=(batch+1)*128;
    Object.assign(body.cumulative,{rendered_frames:total,max_observed_frame:total,histogram:[[0,total]],coverage_intervals:[[0,total]]});
    const result=compare(m,state,body,[[0,512]]);assert.equal(result.kind,'accept');state=result.state;
  }
  assert.equal(state.epochs.length,64);
  let body=nextEmpty(m,state);body.epochs=[{...state.epochs.at(-1),epoch_id:64}];
  rejected(()=>compare(m,state,body,[[0,512]]));
  body=copy(cases.one_second.envelope);
  body.slices=Array.from({length:8},(_,index)=>Object.assign(copy(cases.one_second.envelope.slices[0]),{
    slice_id:index,first_consumption_frame:index*256,frames:256,render_start_tick:index*256,render_end_tick:(index+1)*256,
    runs:Array.from({length:256},(_,j)=>{const i=index*256+j;return [i,1,i];})}));
  Object.assign(body.cumulative,{rendered_frames:2048,max_observed_frame:2048,histogram:[[0,2048]],coverage_intervals:[[0,2048]]});
  assert.equal(compare(m,null,body,[[0,2048]]).kind,'accept');
});

test('canonical size cap and trusted-state corruption',async()=>{
  const m=await modulePromise,body=copy(cases.maximum_safe_source_end.envelope);
  Object.assign(body.cumulative,{rendered_frames:4096,histogram:[...Array.from({length:1398},(_,i)=>[i,2]),[1398,1300]],
    coverage_intervals:Array.from({length:4096},(_,i)=>[9007199254732800+2*i,9007199254732801+2*i])});
  body.slices=Array.from({length:128},()=>{
    const origin=9007199254740000;
    return Object.assign(copy(cases.one_second.envelope.slices[0]),{slice_id:7199,first_consumption_frame:9007199254730000,frames:16,render_start_tick:origin,render_end_tick:origin+16,
      runs:Array.from({length:16},(_,i)=>[9007199254740990,1,origin+i])});
  });
  assert.ok(JSON.stringify(body).length>262144);
  rejected(()=>m.normalizeCheckpointV2(body),'checkpoint_body_limit');
  for(const [field,value] of [['last_slice_id',1],['last_epoch_id',1],['last_render_end_tick',47999]]) {
    const state=copy(accepted(m,'one_second'));state[field]=value;
    rejected(()=>compare(m,state,cases.one_second.envelope,[[0,48000]]),'invalid_state');
  }
});
