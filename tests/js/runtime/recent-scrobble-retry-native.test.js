'use strict';
// UNRUN: actual native row/panel, bridge, model and provider owners.
// Existing fixture uses the real private transport with synthetic response stamps.
const test=require('node:test');
const assert=require('node:assert/strict');
const {setup}=require('./recent-scrobble-delivery-fixture.cjs');
const {load,fixture,deferred,settle}=require('./home-friends-native-app-fixture.cjs');
const ROW='activity_'+'c'.repeat(64), SNAP='b'.repeat(43);
const dto=(state='not_sent',next_step='retry_check')=>({state,next_step,show_status:true});
const row=(patch={})=>({id:ROW,kind:'listen',title:'Song',source_readable:true,availability:'local',scrobble_delivery:dto(),...patch});
test('only explicit eligible-looking own rows get a real native send button, still requiring current owner',async t=>{
  const h=fixture(t), {recentScrobbleRetryHtml:render}=await load('recent-scrobble-delivery.mjs');
  const runtime={...h.runtime,canRetryRecentScrobble:()=>true,retryRecentScrobble:()=>{}};
  const context={account_ref:null,kind:'listens'};
  const host=h.document.createElement('div');host.innerHTML=render(runtime,row(),context);
  const button=host.querySelector('[data-recent-scrobble-retry]');assert.ok(button);
  assert.equal(button.tagName,'BUTTON');assert.equal(button.getAttribute('aria-label'),'Send this play to Last.fm');
  for(const [state,step] of [['accepted','none'],['unknown','none'],['delivery_unconfirmed','check_delivery'],
    ['reauthentication_required','reauthenticate'],['retry_exhausted','review_failure'],['rejected','review_failure'],['not_sent','check_connection'],['not_sent','none']])
    assert.equal(render(runtime,row({scrobble_delivery:dto(state,step)}),context),'');
  for(const change of [{account_ref:'friend'},{kind:'tracks'},{kind:'foobar'}])assert.equal(render(runtime,row(),{...context,...change}),'');
  assert.equal(render(runtime,row({source_readable:false}),context),'');
  assert.equal(render({...runtime,canRetryRecentScrobble:()=>false},row(),context),'');
});
async function wired(t) {
  const native=setup(), ui=fixture(t), {createHomeBackendProviders}=await load('backend-providers.mjs');
  native.window.AlbumHavenCapabilities={allows:action=>action==='integration.lastfm.scrobbles.submit'};
  const {createHomeFriendsController}=await load('model.mjs'), {mountActivityPanel}=await load('activity.mjs');
  const h={native,ui,calls:[],pending:deferred(),snapshot:SNAP,rows:[row()]};
  native.context.fetch=async(path,config)=>{
    h.calls.push({path,config});
    if(config.method==='POST')return h.pending.promise;
    return {ok:true,status:200,json:async()=>({status:'ready',data:{snapshot_ref:h.snapshot,rows:h.rows,next_cursor:null}})};
  };
  const providers=createHomeBackendProviders(native.window.AlbumHavenPrivateUITransport,{runtime:native.bridge});
  const read=native.bridge.configureActivityProvider(providers);
  const controller=createHomeFriendsController({providers:{readActivity:read}});
  controller.setScope(native.bridge.snapshot().scopeKey);
  await controller.loadActivity({kind:'listens',period:'all'});
  const context={scopeKey:controller.getSnapshot().scopeKey,account_ref:null,kind:'listens',period:'all'};
  const runtime={...ui.runtime,canRetryRecentScrobble:native.bridge.canRetryRecentScrobble,retryRecentScrobble:native.bridge.retryRecentScrobble};
  const panel=ui.own(mountActivityPanel(ui.host,runtime,{...context,value:controller.getSnapshot().activity}));
  const unsubscribe=controller.subscribe(()=>panel.update({...context,value:controller.getSnapshot().activity}));
  // Same ownership callback installed by index-native. Entry lifecycle itself
  // still requires a separately admitted full native bootstrap test.
  const release=native.bridge.subscribeRecentScrobbleRefresh(scope=>{if(scope===controller.getSnapshot().scopeKey)void controller.refreshOwnListenActivity();});
  t.after(()=>{release();unsubscribe();controller.dispose();providers.dispose();});
  return Object.assign(h,{providers,controller,context,panel,runtime});
}
test('real native click uses the stored snapshot once and refreshes with an initial read after outcome',async t=>{
  const h=await wired(t), button=h.ui.host.querySelector('[data-recent-scrobble-retry]');assert.ok(button);
  // Observe the actual post-command refresh, including error/denial outcomes.
  // A fixed microtask count is not a completion boundary for two transport chains.
  const refreshed=deferred();let sawLoading=false,lastStatus=h.controller.getSnapshot().activity.status;
  const release=h.controller.subscribe(()=>{
    const activity=h.controller.getSnapshot().activity;lastStatus=activity.status;
    if(activity.status==='loading')sawLoading=true;
    else refreshed.resolve(activity);
  });
  const timeout=setTimeout(()=>refreshed.reject(new Error(`Post-command history refresh did not complete; last status: ${lastStatus}`)),5000);
  try {
  button.dispatchEvent(new h.ui.c.Event('click',{bubbles:true}));
  button.dispatchEvent(new h.ui.c.Event('click',{bubbles:true}));
  assert.equal(h.calls.filter(x=>x.config.method==='POST').length,1);assert.equal(button.disabled,true);
  const post=h.calls.find(x=>x.config.method==='POST');
  assert.deepEqual(JSON.parse(post.config.body),{origin:{audience:'own',subject_ref:null,kind:'listens',period:'all',snapshot_ref:SNAP},row_ref:ROW});
  h.snapshot='d'.repeat(43);h.rows=[row({scrobble_delivery:dto('accepted','none')})];
  h.pending.resolve({ok:true,status:200,json:async()=>({status:'ready',refresh_required:true,data:{attempted:true,result:'attempted'}})});
  const activity=await refreshed.promise;
  assert.equal(activity.status,'ready','actual post-command history refresh must succeed');
  assert.equal(sawLoading,true,'actual refresh must publish its loading transition');
  assert.equal(h.controller.getSnapshot().activity.data.rows[0].scrobble_delivery.state,'accepted');
  assert.equal(h.ui.host.querySelector('[data-recent-scrobble-retry]'),null);
  const refresh=h.calls.at(-1);assert.match(refresh.path,/^\/home\/activity\?/);
  assert.doesNotMatch(refresh.path,/snapshot_ref|cursor|page=/);
  } finally {clearTimeout(timeout);release();}
});
test('network failure still refreshes; no optimistic not_sent and no second POST',async t=>{
  const h=await wired(t), value=h.controller.getSnapshot().activity.data.rows[0];
  const pending=h.native.bridge.retryRecentScrobble(value,h.context), rejected=assert.rejects(pending);
  h.snapshot='e'.repeat(43);h.rows=[row({scrobble_delivery:dto('delivery_unconfirmed','check_delivery')})];
  h.pending.reject(new TypeError('network'));await rejected;await settle();await settle();
  assert.equal(h.calls.filter(x=>x.config.method==='POST').length,1);
  assert.equal(h.controller.getSnapshot().activity.data.rows[0].scrobble_delivery.state,'delivery_unconfirmed');
  assert.equal(h.ui.host.querySelector('[data-recent-scrobble-retry]'),null);
});
test('fabricated DOM row cannot confer admission; stale bridge context has no send authority',async t=>{
  const h=await wired(t);
  assert.equal(h.native.bridge.canRetryRecentScrobble(row({id:'activity_'+'f'.repeat(64)}),h.context),false);
  h.native.shell.dataset.nativeLibraryId='library:other';h.native.bridge.sync();
  assert.equal(h.native.bridge.canRetryRecentScrobble(row(),h.context),false);
  await assert.rejects(h.native.bridge.retryRecentScrobble(row(),h.context));
  assert.equal(h.calls.filter(x=>x.config.method==='POST').length,0);
});
test('current capability removal blocks an otherwise eligible snapshot before transport',async t=>{
  const h=await wired(t);
  h.native.window.AlbumHavenCapabilities={allows:()=>false};
  assert.equal(h.native.bridge.canRetryRecentScrobble(row(),h.context),false);
  await assert.rejects(h.native.bridge.retryRecentScrobble(row(),h.context));
  assert.equal(h.calls.filter(x=>x.config.method==='POST').length,0);
});
test('old request settlement cannot refresh or paint a different private scope',async t=>{
  const h=await wired(t), value=h.controller.getSnapshot().activity.data.rows[0];
  const request=h.native.bridge.retryRecentScrobble(value,h.context), rejected=assert.rejects(request);
  const reads=h.calls.length;
  h.native.shell.dataset.privateUiContext='f'.repeat(64);h.native.bridge.sync();
  h.pending.resolve({ok:true,status:200,json:async()=>({status:'ready',refresh_required:true,data:{attempted:true,result:'attempted'}})});
  await rejected;await settle();
  assert.equal(h.calls.length,reads);
  assert.equal(h.native.bridge.canRetryRecentScrobble(value,h.context),false);
});
test('replacement native panel cannot resend while pending and receives the fresh snapshot',async t=>{
  const h=await wired(t), {mountActivityPanel}=await load('activity.mjs');
  const pending=h.native.bridge.retryRecentScrobble(row(),h.context);
  h.panel.dispose();
  const replacement=h.ui.own(mountActivityPanel(h.ui.host,h.runtime,{...h.context,value:h.controller.getSnapshot().activity}));
  const release=h.controller.subscribe(()=>replacement.update({...h.context,value:h.controller.getSnapshot().activity}));t.after(release);
  assert.equal(h.ui.host.querySelector('[data-recent-scrobble-retry]'),null);
  h.snapshot='g'.repeat(43);h.rows=[row({scrobble_delivery:dto('accepted','none')})];
  h.pending.resolve({ok:true,status:200,json:async()=>({status:'ready',refresh_required:true,data:{attempted:true,result:'attempted'}})});
  await pending;await settle();await settle();
  assert.equal(h.calls.filter(x=>x.config.method==='POST').length,1);
  assert.equal(h.ui.host.querySelector('[data-recent-scrobble-delivery]').getAttribute('data-recent-scrobble-delivery'),'accepted');
});
