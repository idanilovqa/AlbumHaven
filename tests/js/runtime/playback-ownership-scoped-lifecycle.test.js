'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {world,fixture,track,start,frame,displayMessages}=require('./search-native-fixtures/ownership-platform.cjs');
const KEY='albumhaven.playbackOwnership.v1';
const plain=value=>JSON.parse(JSON.stringify(value));
const leaseKeys=['tab_id','status','reason','updated_at_ms','expires_at_ms','claim_revision'].sort();
function assertIdentityOnly(w){
  for(const row of [...w.writes.filter(x=>x.key===KEY&&x.op==='set').map(x=>({value:JSON.parse(x.value)})),
    ...w.messages.filter(x=>x.channel===KEY).map(x=>({value:x.data}))]){
    assert.deepEqual(Object.keys(row.value).sort(),leaseKeys);assert.doesNotMatch(JSON.stringify(row.value),/\/library\/|%2Flibrary|coverPath|privateUiContext|Title |Artist |Album /i);
  }
  for(const row of w.writes.filter(x=>x.key===KEY))assert.equal(row.kind,'local','ownership never writes session cache');
}
function inject(h,record){h.world.local.set(KEY,JSON.stringify(record));const e=new h.c.Event('storage');Object.assign(e,{key:KEY,newValue:JSON.stringify(record)});h.c.dispatchEvent(e);}
function foreign(w,patch={}){return {tab_id:'independent-foreign-tab',status:'playing',reason:'manual_start',claim_revision:9,updated_at_ms:w.now(),expires_at_ms:w.now()+15000,...patch};}
function shellChange(h,key,value){
  h.shell.dataset[key]=value;
  const name=key==='nativeAccountId'?'data-native-account-id':key==='nativeLibraryId'?'data-native-library-id':'data-private-ui-context';
  for(const observer of h.observers)if(!observer.retired&&observer.targets.some(row=>row.target===h.shell||row.options.subtree))observer.callback([{type:'attributes',target:h.shell,attributeName:name}]);
  h.c.AlbumHavenPrivateUITransport.generation();
}
async function rendered(h,payload=track()){
  const x=await start(h,payload);assert.equal(await x.work,true);assert.ok(x.role);frame(h,x.role);await h.flush();h.world.flush();return x;
}
test('reservation is minimal; only actual first-frame admits same-scope text; different scope remains globally locked',async t=>{
  const w=world(),a=await fixture(t,w),b=await fixture(t,w),c=await fixture(t,w);shellChange(c,'privateUiContext','b'.repeat(64));
  const x=await start(a);assert.equal(await x.work,true);w.flush();
  assert.equal(displayMessages(w).length,0,'returned role and optimistic UI are not render evidence');assertIdentityOnly(w);
  assert.equal(b.c.isPlaybackLockedByAnotherTab(),true);assert.equal(b.c.getMirroredPlaybackTrack(),null);
  frame(a,x.role,{generation:x.role.generation+1});await a.flush();assert.equal(displayMessages(w).length,0);
  frame(a,x.role);await a.flush();w.flush();
  assert.deepEqual(plain(b.c.getMirroredPlaybackTrack()),{title:'Title A',artist:'Artist A',album:'Album A'});
  assert.equal(c.c.isPlaybackLockedByAnotherTab(),true);assert.equal(c.c.getMirroredPlaybackTrack(),null);
  assert.equal(await c.c.playTrackFromPayload(track('C')),false,'scope partition never bypasses global arbitration');
  assert.equal(c.platform.contexts.length,0);assertIdentityOnly(w);
  for(const m of displayMessages(w)){assert.deepEqual(Object.keys(m.data).sort(),['protocol','tab_id','claim_revision','sequence','issued_at_ms','expires_at_ms','display'].sort());assert.deepEqual(Object.keys(m.data.display).sort(),['album','artist','title']);}
});
test('no BroadcastChannel retains generic lock and creates no synthetic playable track',async t=>{
  const w=world(),a=await fixture(t,w),b=await fixture(t,w,{broadcast:false});await rendered(a);w.flush();
  assert.equal(b.c.isPlaybackLockedByAnotherTab(),true);assert.equal(b.c.getMirroredPlaybackTrack(),null);assert.equal(b.state.player.current,null);assert.equal(b.platform.contexts.length,0);
});
for(const key of ['nativeAccountId','nativeLibraryId','privateUiContext'])test(`${key} retirement clears display and A-B-A rejects held A closure`,async t=>{
  const w=world(),a=await fixture(t,w),b=await fixture(t,w);await rendered(a);
  const old=w.channels.find(x=>x.tab===b.platform&&x.name.includes('playbackDisplay')),callback=old.listeners[0],packet=clonePacket(displayMessages(w).at(-1).data);
  const previous=b.shell.dataset[key];shellChange(b,key,key==='privateUiContext'?'c'.repeat(64):'changed-owner');
  assert.equal(old.closed,true);assert.equal(b.c.getMirroredPlaybackTrack(),null);shellChange(b,key,previous);
  callback({data:{...packet,sequence:packet.sequence+100}});assert.equal(b.c.getMirroredPlaybackTrack(),null,'stale closure rejected despite equal restored scope text');
  if(key!=='privateUiContext'){shellChange(b,'privateUiContext','d'.repeat(64));shellChange(b,'privateUiContext','a'.repeat(64));callback({data:{...packet,sequence:packet.sequence+101}});assert.equal(b.c.getMirroredPlaybackTrack(),null);}
  w.advance(5000);await a.flush();w.flush();assert.ok(b.c.getMirroredPlaybackTrack(),'new current channel can accept fresh heartbeat');
});
function clonePacket(packet){return structuredClone(packet);}
test('heartbeat increments sequence; replay/storage renewal cannot prolong text; stale timeout preserves renewed display',async t=>{
  const w=world(),a=await fixture(t,w),b=await fixture(t,w);await rendered(a);const first=clonePacket(displayMessages(w).at(-1).data);
  w.advance(5000);await a.flush();w.flush();const second=displayMessages(w).at(-1).data;
  assert.ok(second.sequence>first.sequence);assert.equal(second.expires_at_ms,w.now()+15000);assertIdentityOnly(w);
  const receiver=w.channels.find(x=>x.tab===b.platform&&!x.closed&&x.name.includes('playbackDisplay'));
  receiver.listeners[0]({data:first});assert.deepEqual(plain(b.c.getMirroredPlaybackTrack()),second.display);
  a.platform.dispose();w.advance(10000);w.flush();assert.ok(b.c.getMirroredPlaybackTrack(),'old first-packet expiry cannot clear renewed text');
  const renewed={...JSON.parse(w.local.get(KEY)),updated_at_ms:w.now(),expires_at_ms:w.now()+15000};inject(b,renewed);
  w.advance(5000);w.flush();assert.equal(b.c.getMirroredPlaybackTrack(),null,'storage lease renewal alone cannot renew expired text');assert.equal(b.c.isPlaybackLockedByAnotherTab(),true);
});
test('pending start expires without optimistic renewal; delayed completion cannot own or publish',async t=>{
  const w=world(),h=await fixture(t,w);h.platform.holds.module=true;const x=await start(h);assert.equal(x.role,null);assert.ok(w.local.has(KEY));
  w.advance(15000);await h.flush();assert.equal(h.c.getActivePlaybackOwnershipHandle(),null);assert.equal(w.local.has(KEY),false);assert.equal(displayMessages(w).length,0);
  h.platform.contexts[0].module.resolve();await h.flush();await x.work;assert.equal(displayMessages(w).length,0);assert.equal(h.engine().roles.current,null);assert.equal(h.platform.contexts[0].closeCount,1);
});
for(const bad of [null,{tab_id:'x'},foreign({now:()=>1000000},{expires_at_ms:1000000}),{tab_id:'x',status:'playing',reason:'manual_start',updated_at_ms:NaN,expires_at_ms:1000010}])test('invalid/expired legacy storage removed on real startup',async t=>{
  const w=world();w.local.set(KEY,JSON.stringify(bad));const h=await fixture(t,w);assert.equal(w.local.has(KEY),false);assert.equal(h.c.isPlaybackLockedByAnotherTab(),false);
});
test('legacy live track is minimized, never displayed, and old messages remain lock-only',async t=>{
  const w=world(),legacy={...foreign(w),track:track()};delete legacy.claim_revision;w.local.set(KEY,JSON.stringify(legacy));const h=await fixture(t,w);
  const stored=JSON.parse(w.local.get(KEY));assert.deepEqual(Object.keys(stored).sort(),leaseKeys);assert.equal(stored.claim_revision,0);assert.equal(h.c.isPlaybackLockedByAnotherTab(),true);assert.equal(h.c.getMirroredPlaybackTrack(),null);
  const channel=w.channels.find(x=>x.tab===h.platform&&x.name===KEY);channel.listeners[0]({data:legacy});assert.equal(h.c.getMirroredPlaybackTrack(),null);assert.equal(h.platform.images.length,0);assertIdentityOnly(w);
});
test('exact old claim release never removes a successor or writes track tombstones',async t=>{
  const w=world(),h=await fixture(t,w);const old=h.c.claimPlaybackOwnership(track());assert.ok(old);const next=foreign(w);inject(h,next);
  const before=w.local.get(KEY);assert.equal(h.c.releasePlaybackOwnership('stopped',old),false);assert.equal(w.local.get(KEY),before);assert.equal(h.c.isPlaybackLockedByAnotherTab(),true);assertIdentityOnly(w);
});
for(const patch of [{sequence:0},{sequence:1.5},{issued_at_ms:Infinity},{expires_at_ms:Infinity},{display:{title:'x',artist:'y',album:'z',path:'/library/leak'}},{display:{title:{nested:'x'},artist:'y',album:'z'}}])test(`malformed transient packet rejected: ${JSON.stringify(patch)}`,async t=>{
  const w=world(),a=await fixture(t,w),b=await fixture(t,w);await rendered(a);const message=clonePacket(displayMessages(w).at(-1).data),before=plain(b.c.getMirroredPlaybackTrack());
  const receiver=w.channels.find(x=>x.tab===b.platform&&!x.closed&&x.name.includes('playbackDisplay'));
  receiver.listeners[0]({data:{...message,sequence:message.sequence+1,...patch}});assert.deepEqual(plain(b.c.getMirroredPlaybackTrack()),before);
});
module.exports={shellChange,foreign,inject,rendered};
test('rendered-role resume renews ownership without fabricated second first-frame',async t=>{
  const w=world(),h=await fixture(t,w);const x=await rendered(h);const count=displayMessages(w).length;
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(),true);assert.equal(w.local.has(KEY),false);assert.equal(h.engine().roles.current,x.role);
  assert.equal(h.c.togglePlayerPlayback(),true);await h.flush();assert.ok(displayMessages(w).length>count);assert.equal(h.engine().roles.current,x.role);assert.equal(h.c.getPlayerPlaybackSnapshot().paused,false);
});
test('resume before rendered evidence remains generic until actual first-frame',async t=>{
  const h=await fixture(t),x=await start(h);assert.equal(await x.work,true);assert.equal(await h.c.pausePlayerPlaybackForHandoff(),true);
  assert.equal(h.c.togglePlayerPlayback(),true);await h.flush();assert.equal(displayMessages(h.world).length,0);frame(h,x.role);await h.flush();assert.equal(displayMessages(h.world).length,1);
});
test('late rejected resume cannot clear successor role/lease/display',async t=>{
  const h=await fixture(t);await rendered(h);await h.c.pausePlayerPlaybackForHandoff();h.platform.holds.resume=true;h.c.togglePlayerPlayback();await h.flush();
  const oldContext=h.engine().context,oldResume=oldContext.resumeGate;h.platform.holds.resume=false;
  const next=await start(h,track('B'));assert.equal(await next.work,true);frame(h,next.role);await h.flush();const lease=h.world.local.get(KEY),display=clonePacket(displayMessages(h.world).at(-1).data);
  oldResume.reject(new Error('old resume rejected'));await h.flush();assert.equal(h.world.local.get(KEY),lease);assert.equal(h.engine().roles.current,next.role);assert.deepEqual(displayMessages(h.world).at(-1).data,display);
});
test('current actual continuity boundary changes display only to the promoted native queue track',async t=>{
  const h=await fixture(t),a=track('A'),b=track('B');const x=await start(h,a);assert.equal(await x.work,true);
  h.c.setAlbumPlaybackQueue({key:'local-test-album',name:'Local test album',tracks:[a,b]},a.path);frame(h,x.role);await h.flush();
  h.platform.nodes.at(-1).emit({type:'consumed',generation:x.role.generation,streamId:x.role.streamId,role:'current',frames:0,bufferedFrames:48000});
  await h.c.scheduleStreamingContinuity(b);const next=h.engine().roles.continuity;assert.ok(next,'real continuity owner allocated next role');const count=displayMessages(h.world).length;
  h.platform.nodes.at(-1).emit({type:'boundary',generation:x.role.generation,outgoingStreamId:x.role.streamId,incomingStreamId:next.streamId+100,renderedFrame:48000});await h.flush();assert.equal(displayMessages(h.world).length,count);
  h.platform.nodes.at(-1).emit({type:'boundary',generation:x.role.generation,outgoingStreamId:x.role.streamId,incomingStreamId:next.streamId,renderedFrame:48000});await h.flush();
  assert.equal(h.engine().roles.current,next);assert.equal(h.state.player.current.path,b.path);assert.equal(displayMessages(h.world).at(-1).data.display.title,b.title);
});
test('legacy minimization reread cannot overwrite a reentrant successor',async t=>{
  const h=await fixture(t),w=h.world,legacy={...foreign(w),track:track('Legacy')},successor=foreign(w,{tab_id:'successor-at-reread',claim_revision:88});delete legacy.claim_revision;
  const broad=JSON.stringify(legacy),safe=JSON.stringify(successor);w.local.set(KEY,broad);let reads=0;
  h.platform.storageHook=({op,key,map})=>{if(op==='get'&&key===KEY&&++reads===2)map.set(KEY,safe);};
  h.c.dispatchEvent(Object.assign(new h.c.Event('storage'),{key:KEY,newValue:broad}));h.platform.storageHook=null;
  assert.equal(w.local.get(KEY),safe);assert.equal(h.c.isPlaybackLockedByAnotherTab(),true);assert.equal(h.c.getMirroredPlaybackTrack(),null);assertIdentityOnly(w);
});
test('same-tab-looking old storage is never adopted as local authority',async t=>{
  const h=await fixture(t),w=h.world,id=h.ownershipTabWitness().tabId;
  inject(h,foreign(w,{tab_id:id,claim_revision:0,track:track('Old')}));assert.equal(h.c.getActivePlaybackOwnershipHandle(),null);assert.equal(h.c.isPlaybackLockedByAnotherTab(),true);assert.equal(h.c.getMirroredPlaybackTrack(),null);
  assert.equal(h.c.claimPlaybackOwnership(track('New')),false);assertIdentityOnly(w);
});
test('same-millisecond higher display sequence is accepted; equal sequence and unknown claim are rejected',async t=>{
  const w=world(),a=await fixture(t,w),b=await fixture(t,w);await rendered(a);const first=clonePacket(displayMessages(w).at(-1).data);
  const channel=w.channels.find(x=>x.tab===b.platform&&!x.closed&&x.name.includes('playbackDisplay')),send=data=>channel.listeners[0]({data});
  const second={...first,sequence:first.sequence+1,display:{title:'Second same millisecond',artist:'Artist',album:'Album'}};send(second);assert.equal(b.c.getMirroredPlaybackTrack().title,second.display.title);
  send({...second,display:{title:'Replay',artist:'Artist',album:'Album'}});assert.equal(b.c.getMirroredPlaybackTrack().title,second.display.title);
  send({...second,sequence:second.sequence+1,claim_revision:second.claim_revision+1,display:{title:'Wrong claim',artist:'Artist',album:'Album'}});assert.equal(b.c.getMirroredPlaybackTrack().title,second.display.title);
  send({...second,sequence:second.sequence+1,issued_at_ms:w.now()+1,display:{title:'Future',artist:'Artist',album:'Album'}});assert.equal(b.c.getMirroredPlaybackTrack().title,second.display.title);
});
for(const invalid of ['missing-path','aborted','stale-caller','denied-media'])test(`${invalid} rejects before claim and native start`,async t=>{
  const h=await fixture(t,world(),{media:invalid!=='denied-media'}),controller=new AbortController();if(invalid==='aborted')controller.abort();
  const payload=invalid==='missing-path'?{title:'Not a native track'}:track();const result=await h.c.playTrackFromPayload(payload,{signal:controller.signal,isCurrent:()=>invalid!=='stale-caller'});
  assert.equal(result,false);assert.equal(h.world.local.has(KEY),false);assert.equal(h.platform.contexts.length,0);assert.equal(displayMessages(h.world).length,0);
});
test('native prepare failure releases only its reservation and never publishes display',async t=>{
  const h=await fixture(t);h.platform.holds.module=true;const x=await start(h),outcome=Promise.resolve(x.work).then(value=>({value}),error=>({error}));
  h.platform.contexts[0].module.reject(new Error('bounded module failure'));await outcome;await h.flush();assert.equal(h.world.local.has(KEY),false);assert.equal(h.c.getActivePlaybackOwnershipHandle(),null);assert.equal(displayMessages(h.world).length,0);
});
test('aborted pending selection completion cannot release newer B claim',async t=>{
  const h=await fixture(t),controller=new AbortController();h.platform.holds.module=true;const a=await start(h,track('A'),{signal:controller.signal});const oldContext=h.platform.contexts[0];
  controller.abort();const b=await start(h,track('B'));const lease=h.world.local.get(KEY);h.platform.holds.module=false;oldContext.module.resolve();await h.flush();
  for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();assert.equal(await a.work,false);assert.equal(await b.work,true);assert.equal(h.world.local.get(KEY),lease);assert.equal(h.engine().roles.current.track.path,track('B').path);
  frame(h,h.engine().roles.current);await h.flush();assert.equal(displayMessages(h.world).at(-1).data.display.title,'Title B');
});
