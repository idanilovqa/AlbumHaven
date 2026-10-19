'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,world,track,start,frame,displayMessages}=require('./search-native-fixtures/ownership-platform.cjs');
const KEY='albumhaven.playbackOwnership.v1';
function takeover(h){const w=h.world,value={tab_id:'independent-successor',claim_revision:100,status:'playing',reason:'manual_start',updated_at_ms:w.now(),expires_at_ms:w.now()+15000};h.c.localStorage.setItem(KEY,JSON.stringify(value));h.c.dispatchEvent(Object.assign(new h.c.Event('storage'),{key:KEY,newValue:JSON.stringify(value)}));return h.world.local.get(KEY);}
async function rendered(h){const x=await start(h);assert.equal(await x.work,true);frame(h,x.role);await h.flush();return x;}
function sideEffects(h){return {controls:h.platform.sockets.reduce((n,s)=>n+s.sent.length,0),messages:h.platform.nodes.reduce((n,s)=>n+s.sent.length,0),requests:h.requests.length,opens:h.opens.length,streams:h.streams.length};}
function saved(payload=track('Restored'),paused=false){return {track:payload,playbackQueue:null,currentTime:12,paused,loop:{active:false,start:0,end:90}};}
test('held local image callbacks cannot restore art after foreign lock; real full/compact native actions are inert',async t=>{
  const h=await fixture(t);await rendered(h);const images=h.platform.images.slice();assert.ok(images.length>0,'real setCurrentPlayerTrack created cover probe');
  const callbacks=images.map(image=>({load:image.onload,error:image.onerror})),beforeCoverEpoch=h.state.player.coverLoadId;takeover(h);await h.flush();
  assert.ok(h.state.player.coverLoadId>beforeCoverEpoch);const full=h.c.getPlayerElements(),compact=h.c.compactPlayerElements();
  for(const callback of callbacks){callback.load?.();callback.error?.();}
  assert.equal(full.coverButton.style.backgroundImage,'');assert.equal(compact.cover.style.backgroundImage,'');assert.equal(full.title.textContent,'Playing in another tab');assert.equal(compact.titleText.textContent,'Playing in another tab');
  const before=sideEffects(h),probes=h.platform.images.length,currentTrack=h.state.player.current;
  assert.ok(h.requests.some(request=>new URL(request.url,h.location).pathname==='/playback/waveform'&&new URL(request.url,h.location).searchParams.get('path')===track().path),'valid local selection still probes its waveform');
  for(const element of [full.albumLink,full.coverButton,compact.albumLink]){assert.ok(element);h.dispatch(element,'click');}
  for(const type of ['click','dblclick','keydown'])h.dispatch(compact.cover,type,{detail:type==='click'?1:2,key:'ArrowUp'});
  h.c.setCurrentPlayerTrack(track('Stale'));h.c.updatePlayerUi();assert.equal(h.state.player.current,currentTrack,'foreign-lock setter cannot publish stale selection');assert.equal(h.platform.images.length,probes,'locked setters cannot launch probes');
  assert.deepEqual(sideEffects(h),before);assert.equal(full.coverButton.style.backgroundImage,'');assert.equal(compact.cover.style.backgroundImage,'');
});
for(const thin of [false,true])test(`${thin?'thin':'ordinary'} drag acquired locally is discarded after takeover before pointerup`,async t=>{
  const h=await fixture(t);await rendered(h);const els=h.c.getPlayerElements();h.c.innerWidth=thin?390:1200;
  if(thin){els.player.setAttribute('data-player-seekbar-presentation','thin');h.dispatch(els.player,'pointerdown',{pointerId:7,clientX:0,clientY:110,isPrimary:true});h.dispatch(h.document,'pointermove',{pointerId:7,clientX:80,clientY:110});}
  else h.dispatch(els.timeline.parentElement,'pointerdown',{pointerId:7,clientX:80,clientY:110});
  assert.equal(h.state.player.timelineDragging,true,'real gesture admitted before takeover');takeover(h);await h.flush();const before=sideEffects(h);
  h.dispatch(h.document,'pointermove',{pointerId:7,clientX:150,clientY:110});h.dispatch(h.document,'pointerup',{pointerId:7,clientX:180,clientY:110});
  assert.equal(h.state.player.timelineDragging,false);assert.equal(h.state.player.timelineDragPreviewSeconds,null);assert.equal(h.pointerCaptures.size,0);assert.deepEqual(sideEffects(h),before);
});
test('real input, key and programmatic seek/play/next/previous/loop boundaries reject foreign ownership before effects',async t=>{
  const h=await fixture(t);await rendered(h);takeover(h);await h.flush();const full=h.c.getPlayerElements(),compact=h.c.compactPlayerElements(),before=sideEffects(h);
  full.timeline.value='42';h.dispatch(full.timeline,'input');h.dispatch(full.timeline,'keydown',{key:'ArrowRight'});h.dispatch(h.document,'keydown',{key:'ArrowRight',target:full.timeline});
  h.c.setPlayerPlaybackHead(42);h.c.setLoopPlaybackHead(42);h.c.togglePlayerPlayback();
  for(const el of [compact.previous,compact.next,compact.play,full.play]){assert.ok(el);h.dispatch(el,'click');}
  h.c.setLoopActive(true);await h.flush();assert.deepEqual(sideEffects(h),before);assert.equal(h.state.player.loopActive,false);
});
for(const retirement of ['manual','scope','unload'])test(`delayed pageshow restore is retired by ${retirement}; late pageshow cannot start or overwrite successor`,async t=>{
  const h=await fixture(t,world(),{savedPlayerState:saved(),readyState:'loading'});
  await h.flush();assert.ok(h.owner('playerRestoreAttempt')?.pageshow,'real restore is waiting on pageshow');assert.equal(h.platform.contexts.length,0,'no lease or engine while pageshow is pending');assert.equal(h.world.local.has(KEY),false);
  if(retirement==='manual'){const next=await start(h,track('Manual'));assert.equal(await next.work,true);}
  if(retirement==='scope'){h.change('context','b'.repeat(64));h.c.capturePlaybackOwnershipScope();}
  if(retirement==='unload')h.c.persistPlayerStateForUnload('pagehide');
  assert.equal(h.owner('playerRestoreAttempt'),null,'retired restore callback interest is detached');
  const contexts=h.platform.contexts.length,current=h.state.player.current?.path,lease=h.world.local.get(KEY);
  h.c.dispatchEvent(new h.c.Event('pageshow'));await h.flush();
  assert.equal(h.platform.contexts.length,contexts);assert.equal(h.state.player.current?.path,current);assert.equal(h.world.local.get(KEY),lease);assert.equal(displayMessages(h.world).length,0);
});
test('saved paused restore has cancellable engine preparation but no ownership or display authority',async t=>{
  const h=await fixture(t,world(),{savedPlayerState:saved(track('Paused'),true),readyState:'complete'});
  await h.flush();for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();await h.flush();
  assert.equal(h.world.local.has(KEY),false);assert.equal(displayMessages(h.world).length,0);assert.equal(h.c.getPlayerPlaybackSnapshot().paused,true);assert.ok(h.c.captureStreamingPlaybackAttempt());
  assert.equal(h.state.player.current.path,track('Paused').path,'unclaimed paused restore may publish its legitimate local track');
  assert.ok(h.requests.some(request=>new URL(request.url,h.location).pathname==='/playback/waveform'&&new URL(request.url,h.location).searchParams.get('path')===track('Paused').path),'unclaimed paused restore retains native waveform preparation');
  const persisted=JSON.parse(h.c.localStorage.getItem('albumhaven.playerState.v1'));assert.deepEqual(Object.keys(persisted).sort(),['track','playbackQueue','currentTime','paused','loop'].sort());
});
test('suspended restore late resume cannot overwrite manual successor or publish old text',async t=>{
  const h=await fixture(t,world(),{savedPlayerState:saved(),readyState:'complete',holds:{resume:true}});
  assert.ok(h.owner('playerRestoreAttempt')?.pageshow);h.c.dispatchEvent(new h.c.Event('pageshow'));await h.flush();for(const socket of h.platform.sockets)if(socket.readyState===0)socket.open();
  h.world.advance(750);await h.flush();assert.equal(displayMessages(h.world).length,0);const old=h.platform.contexts[0];assert.ok(old.resumeGate);
  h.platform.holds.resume=false;const next=await start(h,track('Manual'));assert.equal(await next.work,true);old.state='running';old.resumeGate.resolve();await h.flush();
  assert.equal(h.state.player.current.path,track('Manual').path);assert.equal(h.engine().roles.current.track.path,track('Manual').path);
  for(const message of displayMessages(h.world))assert.notEqual(message.data.display.title,'Title Restored');
});
