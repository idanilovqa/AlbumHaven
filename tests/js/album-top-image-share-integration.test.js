'use strict';
// Real Share + real coordinator + real native form/Choice/Publication owners.
// Browser primitives and approved source access are controlled by the additive
// fixture. Native close timing instrumentation delegates the complete original
// owner and delays only its returned completion, never its admission/cleanup.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const ROOT=path.resolve(process.env.ALBUM_TOP_TEST_ROOT||path.join(__dirname,'../..'));
const J=require(path.join(ROOT,'tests/js/runtime/album-tops-joined-share-fixtures/joined.cjs'));
const N=require(path.join(ROOT,'tests/js/runtime/album-tops-native-fixtures/actual-native-runtime.cjs'));
const {fixture,load,settle,deferred,visible,button,click}=require('./album-top-image-regression-fixture.cjs');
const page=env=>env.owner('getActiveAppFormPage')();
const sourceWork=env=>[env.accesses.length,env.captureKeys.length,env.fontLoads.length,env.preparations.length,env.bitmaps.length,env.encodes.length,env.imageDecodes.length];
const noWork=(env,before=[0,0,0,0,0,0,0])=>assert.deepEqual(sourceWork(env),before,'unsettled native closure cannot admit image work');
function nativeCloseTiming(env){
  const original=env.context.retireMobileAppFormPage,calls=[];assert.equal(typeof original,'function');let next=null;
  env.context.retireMobileAppFormPage=function(...args){
    const controlled=next;next=null;const result=original.apply(this,args);
    calls.push({args,result,controlled});
    // The actual form computes currentness after this Promise, so a scope/view
    // change cannot be hidden by a synthetic success value. No native callback,
    // active form, source identity, history state or policy is fabricated.
    return controlled?Promise.resolve(result).then(value=>controlled.promise.then(()=>value)):result;
  };
  env.trackCleanup(()=>{env.context.retireMobileAppFormPage=original;next?.resolve();for(const row of calls)row.controlled?.resolve();});
  return {calls,hold(){assert.equal(next,null);return next=deferred();}};
}
async function joined(t,config={}){
  const env=await fixture(t,{joined:true,...config}),closes=[];
  const retained=env.runtime.imageExport.coordinator(()=>env.coordinator);assert.equal(retained,env.coordinator);
  const {openShareAlbumTop}=await load('sharing.mjs');
  const opener=env.document.createElement('button');opener.type='button';opener.textContent='Synthetic Share opener';env.host.append(opener);opener.focus();
  const share=openShareAlbumTop({runtime:env.runtime,controller:env.controller,providers:env.providers,imageExportCoordinator:retained,
    state:env.controller.getSnapshot(),fallbackHost:env.host,returnFocus:()=>opener,onClose:outcome=>closes.push(outcome)});
  const unsubscribe=env.controller.subscribe(()=>share.update({state:env.controller.getSnapshot()}));
  env.trackCleanup(()=>{unsubscribe();share.dispose();opener.remove();});await env.pump();assert.equal(share.failed,false);assert.equal(page(env)?.pageId,'share-album-top');
  const nodes=J.joined(env),exportButton=button(env.content(),/^Export image$/i);
  const visibility=J.button(nodes.people,'Album Top visibility: Private');assert.ok(visibility);J.selectChoice(visibility,'server_shared');await env.pump();
  assert.equal(J.choiceValue(visibility),'server_shared','unsaved native visibility draft established');
  assert.equal(env.joinedData.count('execute'),0);
  return {...env,share,closes,opener,nodes,exportButton,visibility};
}
function assertRestored(h){
  assert.equal(page(h)?.pageId,'share-album-top');const after=J.joined(h);
  assert.equal(after.grid,h.nodes.grid);assert.equal(after.publicPane,h.nodes.publicPane);assert.equal(after.people,h.nodes.people);
  assert.equal(button(h.content(),/^Export image$/i),h.exportButton);assert.equal(J.choiceValue(h.visibility),'server_shared');
  assert.equal(h.document.activeElement,h.exportButton,'confirmed return restores retained native trigger focus');
  assert.equal(h.closes.length,0,'shell suspension/restoration does not close logical Share');assert.equal(h.joinedData.count('execute'),0);
  assert.equal(h.runtime.imageExport.coordinator(()=>{assert.fail('runtime coordinator recreated');}),h.coordinator);
}

test('actual Share/native handoff defers designer admission until actual onAfterClose and preserves logical joined owner',async t=>{
  const h=await joined(t),timing=nativeCloseTiming(h),gate=timing.hold();h.exportButton.focus();click(h.exportButton);await h.pump();
  assert.equal(timing.calls.length,1);assert.equal(timing.calls[0].args[1].restoreFocus,false);assert.equal(timing.calls[0].args[1].returnToParent,false);
  noWork(h);assert.equal(h.closes.length,0);assert.equal(h.nodes.grid.children.length,2,'retained joined subtree not disposed');assert.notEqual(page(h)?.pageId,'album-top-image');
  gate.resolve();await h.pump();assert.equal(page(h)?.pageId,'album-top-image');assert.ok(h.preview(),'actual coordinator reaches accepted preview');assert.ok(h.accesses.length>0);
  assert.equal(h.closes.length,0);assert.equal(h.joinedData.count('execute'),0);assert.equal(visible(h.nodes.grid),false,'Share is not a simultaneous visible nested form');
  const active=page(h);assert.throws(()=>h.runtime.openForm({title:'Unrelated competing form',pageId:'unrelated-form',onMount(){assert.fail('nested native form admitted');}}));assert.equal(page(h),active,'existing native one-form admission unchanged');
  click(button(h.content(),/^Cancel$/i));await h.pump();assertRestored(h);
});

for(const closeKind of ['Cancel','X','Escape'])for(const firstSettlement of ['native','preparation'])test(`actual ${closeKind} restores the same Share only after ${firstSettlement}-first dual closure barriers`,async t=>{
  const h=await joined(t,{autoPrepare:false});click(h.exportButton);await h.pump();assert.equal(page(h)?.pageId,'album-top-image');
  assert.equal(h.preparations.length,1);const pending=h.preparations[0],timing=nativeCloseTiming(h),nativeGate=timing.hold();
  if(closeKind==='Cancel')click(button(h.content(),/^Cancel$/i));
  if(closeKind==='X')click(h.document.getElementById('app-form-close'));
  if(closeKind==='Escape'){const target=h.modal().contains(h.document.activeElement)?h.document.activeElement:h.modal();target.dispatchEvent(new h.context.Event('keydown',{key:'Escape',bubbles:true}));}
  await h.pump();assert.notEqual(page(h)?.pageId,'share-album-top');assert.equal(h.closes.length,0);
  if(firstSettlement==='native')nativeGate.resolve();else pending.gate.resolve(pending.value());
  await h.pump();assert.notEqual(page(h)?.pageId,'share-album-top','one closure signal cannot authorize restoration');assert.equal(h.closes.length,0);
  if(firstSettlement==='native')pending.gate.resolve(pending.value());else nativeGate.resolve();
  await h.pump();assert.equal(pending.released,1);assertRestored(h);
});

for(const loss of ['parent-dispose','scope','view','detail'])test(`${loss} while leaving Share prevents late native closure from opening designer or resurrecting Share`,async t=>{
  const h=await joined(t),timing=nativeCloseTiming(h),gate=timing.hold();click(h.exportButton);await h.pump();noWork(h);
  if(loss==='parent-dispose')h.share.dispose();
  if(loss==='scope'){h.shell.dataset.nativeAccountId='8';h.runtime.sync();}
  if(loss==='view'){const state=h.owner('state');state.view={...state.view};h.runtime.sync();h.share.update({state:h.controller.getSnapshot()});}
  if(loss==='detail'){await h.controller.open(h.controller.getSnapshot().selectedTopRef);h.share.update({state:h.controller.getSnapshot()});}
  gate.resolve();await h.pump();noWork(h);assert.notEqual(page(h)?.pageId,'album-top-image');assert.notEqual(page(h)?.pageId,'share-album-top');
  assert.equal(h.nodes.grid.isConnected,false);assert.ok(h.closes.length<=1,'normal app close cannot notify twice');
});

test('parent disposal while designer cleanup is pending consumes late preparation without restoring retained Share',async t=>{
  const h=await joined(t,{autoPrepare:false});click(h.exportButton);await h.pump();const pending=h.preparations[0];assert.ok(pending);
  click(button(h.content(),/^Cancel$/i));await h.pump();assert.notEqual(page(h)?.pageId,'share-album-top');h.share.dispose();
  const before=sourceWork(h);pending.gate.resolve(pending.value());await h.pump();noWork(h,before);
  assert.equal(pending.released,1);assert.equal(h.nodes.grid.isConnected,false);assert.notEqual(page(h)?.pageId,'share-album-top');assert.ok(h.closes.length<=1);
});

test('a competing actual native form cannot be closed or replaced by delayed Share restoration',async t=>{
  const h=await joined(t,{autoPrepare:false});click(h.exportButton);await h.pump();const pending=h.preparations[0];click(button(h.content(),/^Cancel$/i));await h.pump();
  assert.equal(page(h),null);let competitorCloses=0;
  const competitor=h.runtime.openForm({title:'Competing native owner',pageId:'competing-image-regression',onMount(host){const note=h.document.createElement('p');note.textContent='Competing owner';host.append(note);},onClose(){competitorCloses++;}});
  h.trackCleanup(()=>competitor.close(null,{force:true,restoreFocus:false}));const owner=page(h);assert.ok(owner);
  pending.gate.resolve(pending.value());await h.pump();assert.equal(page(h),owner);assert.equal(competitorCloses,0);assert.equal(h.nodes.grid.isConnected,false);
  assert.equal(h.closes.length,1,'failed restoration retires logical Share once');assert.equal(h.joinedData.count('execute'),0);
});

test('native close rejection does not fabricate Share handoff completion or allow a later coordinator lane',async t=>{
  const h=await joined(t),timing=nativeCloseTiming(h),gate=timing.hold();click(h.exportButton);await h.pump();noWork(h);
  gate.reject(new Error('PRIVATE_NATIVE_CLOSE_FAILURE'));await h.pump();noWork(h);assert.notEqual(page(h)?.pageId,'album-top-image');
  h.share.dispose();const before=sourceWork(h);h.open();await h.pump();noWork(h,before);assert.equal(h.preview(),null);
  let settled=false;h.coordinator.dispose().then(()=>{settled=true;});await h.pump();assert.equal(settled,false);assert.equal(h.text().includes('PRIVATE_NATIVE_CLOSE_FAILURE'),false);
});

test('real app, real Share, real runtime-retained coordinator and real form owner compose without a recording coordinator',async t=>{
  const h=await fixture(t,{joined:true}),coordinator=h.runtime.imageExport.coordinator(()=>h.coordinator);
  const view=await N.connectedView(h,h.joinedData,h.controller,{imageExportCoordinator:coordinator});h.trackCleanup(()=>view.dispose());await h.pump();
  click(button(h.host,/^Share$/i));await h.pump();const old=J.joined(h),trigger=button(h.content(),/^Export image$/i);click(trigger);await h.pump();
  assert.equal(page(h)?.pageId,'album-top-image');assert.ok(h.preview());assert.equal(h.joinedData.count('execute'),0);
  click(button(h.content(),/^Cancel$/i));await h.pump();const restored=J.joined(h);assert.equal(restored.grid,old.grid);assert.equal(restored.people,old.people);
  assert.equal(button(h.content(),/^Export image$/i),trigger);assert.equal(h.document.activeElement,trigger);
  view.dispose();await h.pump();assert.equal(page(h),null);assert.equal(h.runtime.imageExport.coordinator(()=>{assert.fail('view disposed runtime coordinator');}),coordinator);
});

for(const current of [true,false])test(`native designer close reports exact frozen outcome only at confirmed settlement (${current?'current':'scope retired'})`,async t=>{
  const h=await fixture(t,{holdFontReady:true}),outcomes=[],handle=h.open({onClose:outcome=>outcomes.push(outcome)});await h.pump();
  const timing=nativeCloseTiming(h),gate=timing.hold();handle.close();let closed=false;handle.closed.then(()=>{closed=true;});await h.pump();
  assert.equal(outcomes.length,0,'requesting close or disposing mounted child is not native closure evidence');assert.equal(closed,false);
  if(!current){h.shell.dataset.nativeAccountId='8';h.runtime.sync();}
  gate.resolve();await h.pump();assert.equal(outcomes.length,1);const outcome=outcomes[0];
  assert.equal(Object.isFrozen(outcome),true);assert.deepEqual(Object.keys(outcome).sort(),['current','restoreFocusRequested']);
  assert.equal(outcome.current,current);assert.equal(outcome.restoreFocusRequested,true);assert.equal(closed,false,'preparation remains owed after native callback');
  h.fontReady.resolve(h.fonts);await h.pump();assert.equal(closed,true);handle.close();assert.equal(outcomes.length,1);
});
