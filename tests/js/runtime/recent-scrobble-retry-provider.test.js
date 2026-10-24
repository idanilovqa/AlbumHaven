'use strict';
// Authored only: UNRUN. Real backend owner; explicit transport double.
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, deferred} = require('./home-friends-native-app-fixture.cjs');
const REF = 'a'.repeat(64), SNAP = 'b'.repeat(43), ROW = 'activity_'+'c'.repeat(64);
const options = {scopeKey:'own:1',account_ref:null,kind:'listens',period:'all',snapshot_ref:SNAP,rowId:ROW};
const ready = snapshot_ref => ({status:'ready',context_ref:REF,data:{snapshot_ref,rows:[],next_cursor:null}});
const receipt = {status:'ready',context_ref:REF,refresh_required:true,data:{attempted:true,result:'attempted'}};
async function fixture(t) {
  const {createHomeBackendProviders} = await load('backend-providers.mjs');
  let listener, ref=REF;
  const h={calls:[],reads:[],pending:deferred(),read:async()=>ready(SNAP),invalidations:0};
  const transport={context:()=>ref, subscribe(fn){listener=fn;return()=>{listener=null;};},
    invalidate(){h.invalidations++;listener?.();},query:(path,query)=>path+'?'+new URLSearchParams(query),
    request(path,config){if(config.method==='POST'){h.calls.push({path,config});return h.pending.promise;}
      h.reads.push({path,config});return h.read();}};
  h.provider=createHomeBackendProviders(transport,{runtime:{snapshot:()=>({scopeKey:options.scopeKey})}});
  h.change=value=>{ref=value;listener?.();};
  t.after(()=>h.provider.dispose());
  await h.provider.readActivity(options);
  return h;
}
test('exact retry route has a closed locator and no flags, timestamp or optimistic delivery result',async t=>{
  const h=await fixture(t), run=h.provider.retryActivityScrobble;
  const result=run(options);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].path,'/home/activity/scrobbles/retry');
  assert.equal(h.calls[0].config.expected,REF);
  assert.equal(h.calls[0].config.method,'POST');
  assert.equal(h.calls[0].config.isCurrent(),true);
  assert.deepEqual(h.calls[0].config.body,{origin:{audience:'own',subject_ref:null,kind:'listens',period:'all',snapshot_ref:SNAP},row_ref:ROW});
  h.pending.resolve({...receipt,data:{...receipt.data,state:'accepted',secret:'not for UI'}});
  assert.deepEqual(await result,{refresh_required:true});
  assert.equal(h.provider.canRetryActivityScrobble(options),false);
  await h.provider.readActivity(options);
  assert.equal(h.provider.canRetryActivityScrobble(options),false,'same snapshot cannot be reused');
  h.read=async()=>ready('d'.repeat(43));await h.provider.readActivity(options);
  assert.equal(h.provider.canRetryActivityScrobble({...options,snapshot_ref:'d'.repeat(43)}),true);
});
test('duplicate clicks and reads while pending cannot dispatch or publish old history',async t=>{
  const h=await fixture(t), first=h.provider.retryActivityScrobble(options);
  await assert.rejects(h.provider.retryActivityScrobble(options));
  await assert.rejects(h.provider.readActivity(options));
  assert.equal(h.calls.length,1);assert.equal(h.reads.length,1);
  h.pending.resolve(receipt);await first;
});
test('only a current own-listen history snapshot and exact opaque row grammar are admitted',async t=>{
  const h=await fixture(t);
  for(const change of [{account_ref:'friend'},{kind:'tracks'},{kind:'foobar'},{snapshot_ref:'x'.repeat(43)},
    {rowId:ROW+'\n'},{rowId:1},{rowId:'activity_'+'A'.repeat(64)},{snapshot_ref:SNAP+'\n'}]){
    assert.equal(h.provider.canRetryActivityScrobble({...options,...change}),false);
    await assert.rejects(h.provider.retryActivityScrobble({...options,...change}));
  }
  assert.equal(h.calls.length,0);
});
test('late pre-command history cannot overwrite or erase the post-command snapshot',async t=>{
  const h=await fixture(t), stale=deferred();h.read=()=>stale.promise;
  const old=h.provider.readActivity(options);const rejected=assert.rejects(old);
  const command=h.provider.retryActivityScrobble(options);h.pending.resolve(receipt);await command;
  const fresh='e'.repeat(43);h.read=async()=>ready(fresh);await h.provider.readActivity(options);
  stale.resolve(ready(SNAP));await rejected;
  assert.equal(h.provider.canRetryActivityScrobble({...options,snapshot_ref:fresh}),true);
});
for(const failure of [Object.assign(new Error('denied'),{status:403}),Object.assign(new Error('expired'),{status:401}),
  Object.assign(new Error('changed'),{status:409,code:'stale_context'}),new TypeError('network')]){
  test('failed dispatch is never retried: '+failure.message,async t=>{
    const h=await fixture(t), result=h.provider.retryActivityScrobble(options);
    const rejected=assert.rejects(result);h.pending.reject(failure);await rejected;
    assert.equal(h.calls.length,1);
    assert.equal(h.invalidations,failure instanceof TypeError?0:1);
    assert.equal(h.provider.canRetryActivityScrobble(options),false);
  });
}
test('context ABA and disposal reject late receipts without applying old results',async t=>{
  const h=await fixture(t), result=h.provider.retryActivityScrobble(options), rejected=assert.rejects(result);
  h.change('f'.repeat(64));h.change(REF);await assert.rejects(h.provider.readActivity(options));
  assert.equal(h.calls[0].config.isCurrent(),false);
  h.pending.resolve(receipt);await rejected;
  h.provider.dispose();assert.equal(h.provider.canRetryActivityScrobble(options),false);
});
for(const data of [null,{attempted:1,result:'attempted'},{attempted:false,result:'attempted'},
  {attempted:true,result:'claim_changed'},{attempted:false,result:'resend_again'}]){
  test('malformed command receipt requires refresh without retry: '+JSON.stringify(data),async t=>{
    const h=await fixture(t), result=h.provider.retryActivityScrobble(options), rejected=assert.rejects(result);
    h.pending.resolve({...receipt,data});await rejected;assert.equal(h.calls.length,1);
  });
}
