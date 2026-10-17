const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./playlist-header-migration-fixture.cjs');
let mountRetryOriginalRequest;
test.before(async()=>({mountRetryOriginalRequest}=await import('../../../music_app/static/js/playlists/native-mutation-status.mjs')));
test('original-request retry requires native confirmation and current source afterward',async t=>{
  for(const allowed of [false,true]){
    const h=fixture(t);let retries=0,current=true;
    h.runtime.confirmRetryOriginal=async scope=>{assert.equal(scope,'scope');if(allowed)current=false;return allowed;};
    const owner=mountRetryOriginalRequest(h.host,h.runtime,{available:true,scopeKey:'scope',current:()=>current,retry:()=>{retries++;}});
    t.after(()=>owner.dispose());h.click(h.host.querySelector('button'));await h.settle();assert.equal(retries,0);
  }
});
test('duplicate activation opens one confirmation and dispatches one explicit retry',async t=>{
  const h=fixture(t);let resolve,confirms=0,retries=0;
  h.runtime.confirmRetryOriginal=()=>{confirms++;return new Promise(done=>{resolve=done;});};
  const owner=mountRetryOriginalRequest(h.host,h.runtime,{available:true,scopeKey:'scope',current:()=>true,retry:async()=>{retries++;return true;}});
  t.after(()=>owner.dispose());const button=h.host.querySelector('button');h.click(button);h.click(button);
  assert.equal(confirms,1);resolve(true);await h.settle();assert.equal(retries,1);
});
