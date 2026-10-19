'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const load = () => import('../../../music_app/static/js/playlists/filter-preferences.mjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject};};
const settle = async () => {for(let i=0;i<30;i++)await Promise.resolve();};
async function fixture(options={}) {
  const api=await load(), reads=[], writes=[], restored=[], statuses=[], timers=new Map();
  let serial=10, timer=0, revision='1', filters=null, remainingMs=null;
  const providers={readFilterPreferences:async input=>{reads.push(input);if(options.read)return options.read(input);
    return {playlist_ref:input.playlist_id,revision,filters,remainingMs};},
    saveFilterPreferences:async input=>{writes.push(input);if(options.write)return options.write(input);
      revision=String(Number(revision)+1);filters=input.filters;return {revision,changed:true};}};
  const memory=api.createPlaylistFilterMemory({providers:()=>providers,key:()=>id(++serial),
    onRestore:value=>{restored.push(value);options.restore?.(value);},onStatus:value=>{statuses.push(value);options.status?.(value);},
    schedule:(fn,ms)=>{timers.set(++timer,{fn,ms});return timer;},cancel:id=>timers.delete(id)});
  return {...api,memory,reads,writes,restored,statuses,timers,
    server(value,time=null){filters=value;remainingMs=time;},setRevision(value){revision=value;}};
}

test('read restores exact defaults; explicit change and Reset serialize without local-clock authority',async()=>{
  const h=await fixture();h.memory.open('actor/library',id(1));await settle();
  assert.deepEqual(h.restored.at(-1),h.DEFAULT_SAVED_FILTERS);
  const next={...h.DEFAULT_SAVED_FILTERS,query:'Track'};h.memory.change(next);await settle();
  assert.equal(h.writes.length,1);assert.deepEqual(h.writes[0].filters,next);
  h.memory.change(h.DEFAULT_SAVED_FILTERS);await settle();
  assert.equal(h.writes.length,2);assert.equal(h.writes[1].filters,null);
  assert.equal(h.writes[1].revision,'2');assert.equal(h.statuses.at(-1),'saved');h.memory.dispose();
});

test('late initial read cannot replace a more recent explicit applied filter',async()=>{
  const gate=deferred();let first=true;
  const h=await fixture({read:async input=>{if(first){first=false;return gate.promise;}
    return {playlist_ref:input.playlist_id,revision:'2',filters:{...h.DEFAULT_SAVED_FILTERS,query:'new'},remainingMs:null};}});
  h.memory.open('scope',id(1));h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'new'});
  gate.resolve({playlist_ref:id(1),revision:'1',filters:null,remainingMs:null});await settle();
  assert.equal(h.writes.length,1);assert.equal(h.restored.some(value=>value.query===''),false);
  assert.equal(h.restored.at(-1).query,'new');h.memory.dispose();
});

test('uncertain write retains original key and Reset follows its recovery',async()=>{
  let fail=true;
  const h=await fixture({write:async input=>{if(fail){fail=false;throw Error('network');}return {revision:'2',changed:true};}});
  h.memory.open('scope',id(1));await settle();h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'first'});await settle();
  assert.equal(h.statuses.at(-1),'unsaved');const original=h.writes[0];
  h.memory.change(h.DEFAULT_SAVED_FILTERS);await settle();
  assert.equal(h.writes[1].request_key,original.request_key);assert.deepEqual(h.writes[1].filters,original.filters);
  assert.equal(h.writes[2].filters,null);assert.notEqual(h.writes[2].request_key,original.request_key);
  h.memory.dispose();
});

test('revision conflict waits for explicit Retry before reread and new operation',async()=>{
  let conflict=true;
  const h=await fixture({write:async()=>{if(conflict){conflict=false;throw Object.assign(Error('conflict'),{status:409,code:'revision_conflict',responseRejected:true});}return {revision:'8',changed:true};}});
  h.memory.open('scope',id(1));await settle();h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'mine'});await settle();
  assert.equal(h.writes.length,1);assert.equal(h.statuses.at(-1),'unsaved');
  h.setRevision('7');h.memory.retry();await settle();
  assert.equal(h.writes[1].revision,'7');assert.notEqual(h.writes[1].request_key,h.writes[0].request_key);h.memory.dispose();
});

test('server-derived expiry timer rereads and never performs a renewing write',async()=>{
  const h=await fixture();h.server({...h.DEFAULT_SAVED_FILTERS,query:'saved'},4000);
  h.memory.open('scope',id(1));await settle();const pending=[...h.timers.values()][0];
  assert.equal(pending.ms,4000);h.server(null);pending.fn();await settle();
  assert.equal(h.reads.length,2);assert.equal(h.writes.length,0);assert.equal(h.restored.at(-1).query,'');h.memory.dispose();
});

test('resource switch, scope reset and disposal retire delayed restorations',async()=>{
  for(const retire of ['switch','reset','dispose']){
    const gate=deferred();const h=await fixture({read:()=>gate.promise});h.memory.open('old',id(1));
    if(retire==='switch')h.memory.open('new',id(2));else h.memory[retire]();
    gate.resolve({playlist_ref:id(1),revision:'1',filters:null,remainingMs:null});await settle();
    // Provider projections are independently identity checked; this owner must
    // still suppress every retired invocation even if a provider ignores abort.
    assert.equal(h.reads[0].signal.aborted,true);
    if(retire!=='switch')assert.equal(h.restored.length,0);
    h.memory.dispose();
  }
});

test('reopening a resource while its aborted request settles restarts one live read',async()=>{
  const gate=deferred();let first=true;
  const h=await fixture({read:async input=>{if(first){first=false;return gate.promise;}
    return {playlist_ref:input.playlist_id,revision:'1',filters:null,remainingMs:null};}});
  h.memory.open('scope',id(1));h.memory.suspend();h.memory.open('scope',id(1));
  gate.resolve({playlist_ref:id(1),revision:'1',filters:null,remainingMs:null});await settle();
  assert.equal(h.reads.length,2);assert.equal(h.restored.length,1);h.memory.dispose();
});

test('reentrant restore can stage a new explicit change without losing it',async()=>{
  let h,changed=false;h=await fixture({restore:()=>{if(!changed){changed=true;h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'reentrant'});}}});
  h.memory.open('scope',id(1));await settle();assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].filters.query,'reentrant');h.memory.dispose();
});

test('strict projection validates server interval, identity, normalized Unicode and scalar limits',async()=>{
  const a=await load(),value={playlist_ref:id(1),revision:'1',filters:null,expires_at:null,server_time:'2026-10-19T00:00:00+00:00'};
  assert.equal(a.filterProjection(value,id(1)).remainingMs,null);
  for(const patch of [{revision:'1\n'},{revision:'9223372036854775808'},{playlist_ref:id(1)+'\n'},
    {server_time:'2026-02-30T00:00:00Z'},{server_time:'2026-10-19T00:00:00Z\n'},
    {filters:{...a.DEFAULT_SAVED_FILTERS,query:'x'},expires_at:'2026-10-27T00:00:00Z'}])assert.throws(()=>a.filterProjection({...value,...patch},id(1)));
  for(const patch of [{query:'😀'.repeat(101)},{style:'😀'.repeat(51)},{query:'\ud800'},{style:'\ufeffRock'},
    {minDuration:Infinity},{frequencyMode:'exclude'}])assert.throws(()=>a.savedFilters({...a.DEFAULT_SAVED_FILTERS,...patch}));
  assert.equal(a.savedFilters({...a.DEFAULT_SAVED_FILTERS,style:'\u0085Rock\u0085'}).style,'\u0085Rock\u0085');
  assert.equal(a.filterRef('abcdef00-0000-4000-8000-000000000001'),true);
  assert.equal(a.filterRef('ABCDEF00-0000-4000-8000-000000000001'),false);
});

test('saved-status reentrant edit is sent before the running owner becomes idle',async()=>{
  let h,changed=false;h=await fixture({status:value=>{if(value==='saved'&&!changed){changed=true;
    h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'from saved callback'});}}});
  h.memory.open('scope',id(1));await settle();
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].filters.query,'from saved callback');h.memory.dispose();
});

test('invalid newer intent survives an older acknowledgement and read until corrected',async()=>{
  const gate=deferred();let first=true;
  const h=await fixture({write:async()=>{if(first){first=false;await gate.promise;}return {revision:'2'};}});
  h.memory.open('scope',id(1));await settle();h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'older'});await settle();
  const count=h.restored.length;h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'\ud800'});
  gate.resolve();await settle();assert.equal(h.restored.length,count);assert.equal(h.statuses.at(-1),'unsaved');
  h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'corrected'});await settle();
  assert.equal(h.writes.length,2);assert.equal(h.writes[1].filters.query,'corrected');h.memory.dispose();
});

test('invalid edit reentrant from restore never publishes a false saved status',async()=>{
  let h,changed=false;h=await fixture({restore:()=>{if(!changed){changed=true;
    h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'\ud800'});}}});
  try{
    h.memory.open('scope',id(1));await settle();
    assert.equal(h.writes.length,0);assert.equal(h.statuses.includes('saved'),false);
    assert.equal(h.statuses.at(-1),'unsaved');assert.equal(h.restored.length,1);
    h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'corrected'});await settle();
    assert.equal(h.writes.length,1);assert.equal(h.statuses.at(-1),'saved');
    assert.equal(h.restored.at(-1).query,'corrected');
  }finally{h.memory.dispose();}
});

test('deferred invalid staging invokes no callbacks until explicit post-publication retry',async()=>{
  const h=await fixture();
  try{
    h.memory.open('scope',id(1));await settle();
    const reads=h.reads.length,statuses=h.statuses.length,restores=h.restored.length;
    h.memory.change({...h.DEFAULT_SAVED_FILTERS,query:'\ud800'},{defer:true});
    assert.equal(h.reads.length,reads);assert.equal(h.statuses.length,statuses);
    assert.equal(h.restored.length,restores);assert.equal(h.writes.length,0);
    h.memory.retry();await settle();
    assert.equal(h.statuses.at(-1),'unsaved');assert.equal(h.restored.length,restores);
    assert.equal(h.writes.length,0);
  }finally{h.memory.dispose();}
});
