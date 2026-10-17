'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,load,plain}=require('./home-friends-native-app-fixture.cjs');
const {homeFixture,assertOwnQueue,queuedSource}=require('./widget-native-home-fixture.cjs');
test('actual Queue panel controlled synchronization does not echo its previous selection as a user action',async t=>{
  const env=fixture(t),{mountQueuePanel}=await load('queue.mjs'),queue=queuedSource(),calls=[];
  const props=ids=>({api:queue.api,value:queue.api.getSnapshot(),scopeKey:'account/library',selectedIds:ids,onSelect:ids=>calls.push(plain(ids))});
  const owner=env.own(mountQueuePanel(env.host,env.runtime,props([])));
  const row=()=>env.host.querySelector('[data-queue-row="queue:one"]');
  for(const ids of [['queue:one'],[],['queue:one']]){
    owner.update(props(ids));assert.deepEqual(calls,[],'controlled selection updates are not user intents');
    assert.equal(row().getAttribute('aria-selected'),ids.length?'true':null);
  }
  const e=new env.context.Event('click',{bubbles:true});e.detail=1;e.ctrlKey=true;row().dispatchEvent(e);
  assert.deepEqual(calls,[[]],'an actual user toggle still publishes once');
  owner.update(props([]));assert.deepEqual(calls,[[]]);assert.equal(row().getAttribute('aria-selected'),null);
  const retired=row();owner.dispose();const before=calls.length;retired.dispatchEvent(new env.context.Event('click'));assert.equal(calls.length,before);assert.equal(queue.listeners.size,0);
});
test('actual Home Queue selection survives controlled detail publication and same-owner updates',async t=>{
  const h=await homeFixture(t);h.section('queue');h.selectQueue('queue:one');await h.settle();
  assert.deepEqual(plain(h.queueSnapshot().selectedIds),['queue:one']);assert.equal(h.queueSnapshot().album.ref,'queue:album');assert.equal(h.queueSnapshot().artist.ref,'queue:artist');
  assert.deepEqual(plain(h.selection('queue')),['queue:one']);assert.equal(h.page.querySelector('[data-queue-row]').getAttribute('aria-selected'),'true');
  h.render();await h.settle();assert.deepEqual(plain(h.queueSnapshot().selectedIds),['queue:one']);
  h.selectQueue('queue:one');await h.settle();assert.deepEqual(plain(h.queueSnapshot().selectedIds),[]);assert.deepEqual(plain(h.selection('queue')),[]);
  h.dispose();assert.equal(h.queue.listeners.size,0);
});
test('actual Home does not mount a Friend Period owner without a selected friend',async t=>{
  const h=await homeFixture(t);h.section('queue');assertOwnQueue(h.page);
  assert.equal(h.page.querySelectorAll('button').some(node=>(node.getAttribute('aria-label')||node.textContent).startsWith('Period:')),false);
  const friend={account_ref:'friend:one',display_name:'Friend',allowed_actions:{can_view_activity:true}};
  h.state={...h.state,selectedFriendRef:'friend:one',friends:{status:'ready',data:{...h.state.friends.data,friends:[friend]}}};
  h.shell={...h.shell,section:'friends',friendRef:'friend:one'};h.render();
  assert.equal(h.nodes.get('friends').querySelectorAll('button').filter(node=>(node.getAttribute('aria-label')||node.textContent).startsWith('Period:')).length,1);
  h.state={...h.state,selectedFriendRef:null};h.shell={...h.shell,section:'recent',friendRef:null};h.render();assertOwnQueue(h.page);
});
