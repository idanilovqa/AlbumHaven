'use strict';
// Additive actual-owner settlement regressions. The accepted 97-case overlay,
// its platform fixture, all previous tests and all product sources are unchanged.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const ROOT=path.resolve(process.env.ALBUM_TOP_TEST_ROOT||path.join(__dirname,'../..'));
const J=require(path.join(ROOT,'tests/js/runtime/album-tops-joined-share-fixtures/joined.cjs'));
const N=require(path.join(ROOT,'tests/js/runtime/album-tops-native-fixtures/actual-native-runtime.cjs'));
const {fixture,load,deferred,observe,button,click}=require('./album-top-image-regression-fixture.cjs');
const page=h=>h.owner('getActiveAppFormPage')();
const work=h=>[h.accesses.length,h.captureKeys.length,h.fontLoads.length,h.preparations.length,h.bitmaps.length,h.encodes.length,h.imageDecodes.length,h.canvases.length,h.urlEvents.length,h.downloads.length,h.reads.length,h.watches.length];
const unchanged=(h,before)=>assert.deepEqual(work(h),before,'unconfirmed native cleanup grants no source/resource/raster/preview work');
function nativeCloseTiming(h){
  const original=h.context.retireMobileAppFormPage,calls=[];let next=null;
  assert.equal(typeof original,'function');
  h.context.retireMobileAppFormPage=function(...args){
    const controlled=next;next=null;
    const result=original.apply(this,args);calls.push({args,result,controlled});
    // Complete actual owner runs with unchanged arguments and effects. Delay
    // only completion; the actual native form still computes currentness and
    // invokes onAfterClose. Neither hidden DOM nor this gate proves closure.
    return controlled?Promise.resolve(result).then(value=>controlled.promise.then(()=>value)):result;
  };
  h.trackCleanup(()=>{h.context.retireMobileAppFormPage=original;next?.resolve();for(const row of calls)row.controlled?.resolve();});
  return {calls,hold(){assert.equal(next,null);next=deferred();return next;}};
}
function faultAfterActualMount(h){
  const original=h.context.openReactFormDialog,acquired=[];let armed=true;
  assert.equal(typeof original,'function');
  h.context.openReactFormDialog=function(options,...rest){
    if(!armed||options.pageId!=='album-top-image')return original.call(this,options,...rest);
    return original.call(this,{...options,onMount(host,nativeClose){
      const result=options.onMount?.call(this,host,nativeClose);
      const owner=page(h);assert.equal(owner?.pageId,'album-top-image');assert.equal(typeof nativeClose,'function');
      acquired.push({host,nativeClose,owner,result});armed=false;
      // Fault after the entire original mount, not a synthetic no-owner throw.
      // Actual showAppFormDialog catches it and performs its own real cleanup.
      throw new Error('PRIVATE_NATIVE_POST_MOUNT_FAILURE');
    }},...rest);
  };
  h.trackCleanup(()=>{h.context.openReactFormDialog=original;});
  return {acquired};
}
function recordActualCoordinator(h){
  const issued=[];
  const coordinator=Object.freeze({
    open(...args){const handle=h.coordinator.open.apply(h.coordinator,args);issued.push({args,handle});return handle;},
    read(...args){return h.coordinator.read.apply(h.coordinator,args);},
    dispose(...args){return h.coordinator.dispose.apply(h.coordinator,args);},
  });
  return {coordinator,issued};
}
async function shareFixture(t,{app=false}={}){
  const h=await fixture(t,{joined:true}),recording=recordActualCoordinator(h),notices=[];
  assert.equal(h.runtime.imageExport.coordinator(()=>h.coordinator),h.coordinator);
  let share,view,unsubscribe;
  if(app){
    view=await N.connectedView(h,h.joinedData,h.controller,{imageExportCoordinator:recording.coordinator});
    h.trackCleanup(()=>view.dispose());await h.pump();click(button(h.host,/^Share$/i));
  }else{
    const {openShareAlbumTop}=await load('sharing.mjs');
    share=openShareAlbumTop({runtime:h.runtime,controller:h.controller,providers:h.providers,
      imageExportCoordinator:recording.coordinator,state:h.controller.getSnapshot(),fallbackHost:h.host,
      returnFocus:()=>h.host,onClose:outcome=>notices.push(outcome)});
    unsubscribe=h.controller.subscribe(()=>share.update({state:h.controller.getSnapshot()}));
    h.trackCleanup(()=>{unsubscribe();share.dispose();});
  }
  await h.pump();assert.equal(page(h)?.pageId,'share-album-top');
  const nodes=J.joined(h),trigger=button(h.content(),/^Export image$/i);
  let restoredFocus=0;const originalFocus=trigger.focus;trigger.focus=function(...args){restoredFocus++;return originalFocus.apply(this,args);};
  return {...h,...recording,share,view,nodes,trigger,notices,get restoredFocus(){return restoredFocus;}};
}
async function retireShare(h,loss){
  if(loss==='share-dispose')h.share.dispose();
  if(loss==='view-dispose')h.view.dispose();
  if(loss==='source-detail')await h.controller.open(h.controller.getSnapshot().selectedTopRef);
  if(loss==='source-scope'){h.shell.dataset.nativeAccountId='8';h.runtime.sync();h.share.update({state:h.controller.getSnapshot()});}
  await h.pump();
}
function assertNoResurrection(h){
  assert.equal(h.nodes.grid.isConnected,false,'retired joined private subtree remains detached');
  assert.notEqual(page(h)?.pageId,'share-album-top');assert.equal(h.restoredFocus,0,'retired trigger is never refocused');
  assert.equal(h.joinedData.count('execute'),0);assert.ok(h.notices.length<=1,'logical Share notification remains at most once');
}
function freshOpen(h){
  const host=h.document.createElement('section');h.host.append(host);h.trackCleanup(()=>host.remove());
  // Never-registered connected host is a legitimate standalone consumer, not a
  // retry through a retired Share capability tombstone.
  const handle=h.coordinator.open({controller:h.controller,providers:h.providers,attribution:'Synthetic curator',
    fallbackHost:host,returnFocus:()=>host,onClose(){}});
  h.trackCleanup(()=>handle.close());return handle;
}

for(const loss of ['share-dispose','view-dispose','source-detail','source-scope'])test(`${loss} while actual Share close is pending eventually settles owed handle and terminal without resurrection`,async t=>{
  const h=await shareFixture(t,{app:loss==='view-dispose'}),timing=nativeCloseTiming(h),gate=timing.hold(),before=work(h);
  click(h.trigger);await h.pump();assert.equal(h.issued.length,1);assert.equal(timing.calls.length,1);
  const old=observe(h.issued[0].handle.closed);unchanged(h,before);assert.equal(old.state,'pending');
  await retireShare(h,loss);const terminal=observe(h.coordinator.dispose());await h.pump();
  assert.equal(old.state,'pending');assert.equal(terminal.state,'pending');unchanged(h,before);assertNoResurrection(h);
  gate.resolve();await h.pump();
  assert.equal(old.state,'resolved','real completion must not be lost when logical authority retires');
  assert.equal(terminal.state,'resolved','known native cleanup is not permanent quarantine');unchanged(h,before);assertNoResurrection(h);
  h.issued[0].handle.close();h.share?.dispose();await h.pump();assertNoResurrection(h);
});

for(const loss of ['share-dispose','source-detail'])test(`${loss} preserves pending lane then admits a fresh standalone successor only after actual Share settlement`,async t=>{
  const h=await shareFixture(t),timing=nativeCloseTiming(h),gate=timing.hold();click(h.trigger);await h.pump();
  const old=observe(h.issued[0].handle.closed);await retireShare(h,loss);const before=work(h),next=freshOpen(h);
  await h.pump();assert.equal(old.state,'pending');unchanged(h,before);assertNoResurrection(h);
  gate.resolve();await h.pump();assert.equal(old.state,'resolved');assert.ok(h.accesses.length>before[0]);assert.ok(h.preview());
  assert.equal(page(h)?.pageId,'album-top-image');assertNoResurrection(h);
  const closed=observe(next.closed);next.close();await h.pump();assert.equal(closed.state,'resolved');
  const terminal=observe(h.coordinator.dispose());await h.pump();assert.equal(terminal.state,'resolved');assertNoResurrection(h);
});

for(const first of ['native','preparation'])test(`owned post-mount opening error waits ${first}-first cleanup and preparation barriers before terminal success`,async t=>{
  const h=await fixture(t,{holdFontReady:true}),timing=nativeCloseTiming(h),gate=timing.hold(),fault=faultAfterActualMount(h),outcomes=[];
  const handle=h.open({onClose:value=>outcomes.push(value)}),closed=observe(handle.closed);await h.pump();
  assert.equal(fault.acquired.length,1);assert.equal(timing.calls.length,1);assert.equal(closed.state,'pending');assert.equal(outcomes.length,0);
  const terminal=observe(h.coordinator.dispose()),before=work(h);await h.pump();assert.equal(terminal.state,'pending');
  if(first==='native')gate.resolve();else h.fontReady.resolve(h.fonts);
  await h.pump();assert.equal(closed.state,'pending');assert.equal(terminal.state,'pending');unchanged(h,before);
  if(first==='native')h.fontReady.resolve(h.fonts);else gate.resolve();
  await h.pump();assert.equal(closed.state,'resolved');assert.equal(terminal.state,'resolved');assert.equal(outcomes.length,1);
  assert.equal(outcomes[0].current,false,'opening failure never restores source/UI authority');assert.equal(Object.isFrozen(outcomes[0]),true);
  assert.equal(h.preview(),null);assert.equal(h.text().includes('PRIVATE_NATIVE_POST_MOUNT_FAILURE'),false);
});

test('owned opening failure cannot admit successor preparation before actual close confirmation',async t=>{
  const h=await fixture(t,{holdFontReady:true}),timing=nativeCloseTiming(h),gate=timing.hold(),fault=faultAfterActualMount(h);
  const first=h.open(),closed=observe(first.closed);await h.pump();assert.equal(fault.acquired.length,1);
  h.fontReady.resolve(h.fonts);await h.pump();assert.equal(closed.state,'pending');
  const before=work(h),next=h.open();await h.pump();unchanged(h,before);assert.equal(closed.state,'pending');
  gate.resolve();await h.pump();assert.equal(closed.state,'resolved');assert.ok(h.accesses.length>before[0]);assert.ok(h.preview());
  const nextClosed=observe(next.closed);next.close();await h.pump();assert.equal(nextClosed.state,'resolved');
});

test('owned opening error with unknown close never fabricates success from dispose, hidden DOM, elapsed time or later open',async t=>{
  const h=await fixture(t,{holdFontReady:true}),timing=nativeCloseTiming(h),gate=timing.hold(),fault=faultAfterActualMount(h);
  const first=h.open(),closed=observe(first.closed);await h.pump();assert.equal(fault.acquired.length,1);assert.equal(h.modal().hidden,true);
  h.fontReady.resolve(h.fonts);await h.pump();const before=work(h);first.close();first.dispose();h.open();
  const terminal=observe(h.coordinator.dispose());h.advance(120000);await h.pump();
  assert.equal(closed.state,'pending');assert.equal(terminal.state,'pending');unchanged(h,before);
  assert.equal(h.preview(),null);assert.equal(h.text().includes('PRIVATE_NATIVE_POST_MOUNT_FAILURE'),false);
  // gate is deliberately still pending through every assertion. Teardown only
  // releases the platform hold after assertions, without claiming confirmed
  // closure for an unknown operation or granting authority to the old owner.
  const token=fault.acquired[0].owner.token,owned=timing.calls.filter(row=>row.args[0]===token);
  assert.equal(owned.length,1,'the originally acquired failed owner retires exactly once');
  assert.equal(owned[0].controlled,gate,'its exact physical completion remains held');
  const held=observe(gate.promise);await h.pump();assert.equal(held.state,'pending');
  // A separately opened waiting shell may retire its own different token. Its
  // legitimate cleanup neither settles this owner nor admits preparation.
});

test('actual one-form admission rejection proves no designer owner and leaves the competing owner untouched',async t=>{
  const h=await fixture(t),timing=nativeCloseTiming(h),nativeNotices=[];
  const competitor=h.runtime.openForm({title:'Existing real native owner',pageId:'settlement-competitor',onMount(host){host.textContent='Existing owner';},onClose(...args){nativeNotices.push(args);}});
  h.trackCleanup(()=>competitor.close(null,{force:true,restoreFocus:false}));const active=page(h),before=work(h),outcomes=[];
  const handle=h.open({onClose:value=>outcomes.push(value)}),closed=observe(handle.closed);await h.pump();
  assert.equal(page(h),active);assert.equal(timing.calls.length,0);assert.equal(nativeNotices.length,0);unchanged(h,before);
  assert.equal(closed.state,'resolved','genuine pre-admission refusal does not invent native cleanup debt');assert.equal(outcomes.length,1);assert.equal(outcomes[0].current,false);
  const terminal=observe(h.coordinator.dispose());await h.pump();assert.equal(terminal.state,'resolved');assert.equal(page(h),active);
  await competitor.close(null,{force:true,restoreFocus:false});await h.pump();assert.equal(nativeNotices.length,1);
});

function exactSettlement(outcome,status,current,restoreFocusRequested){
  assert.equal(Object.isFrozen(outcome),true);assert.deepEqual(Object.keys(outcome).sort(),['current','restoreFocusRequested','status']);
  assert.equal(outcome.status,status);assert.equal(outcome.current,current);assert.equal(outcome.restoreFocusRequested,restoreFocusRequested);
}
async function nativeModule(){return load('../home-friends/native-dialog.mjs');}

for(const disposed of [false,true])for(const current of [true,false])test(`optional physical observer reports exact one-shot actual closure after ${disposed?'disposed':'live'} wrapper (${current?'current':'retired scope'})`,async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),trace=[],physical=[],logical=[],timing=nativeCloseTiming(h),gate=timing.hold();
  const dialog=openNativeDialog(h.runtime,{title:'Observer contract',pageId:'native-settlement-contract'},
    {mount(host){host.textContent='Owned subtree';return{dispose(){trace.push('child-disposed');}};},
      onClose(value){logical.push(value);trace.push('logical-close');},onNativeSettlement(value){physical.push(value);trace.push('physical');}});
  assert.deepEqual(Object.keys(dialog).sort(),['close','closed','dispose','element','failed','update'],'optional observer does not change default handle API');
  dialog.close({force:true,restoreFocus:true,returnToParent:false});await h.pump();assert.equal(physical.length,0);assert.equal(logical.length,0);
  if(disposed)dialog.dispose();if(!current){h.shell.dataset.nativeAccountId='8';h.runtime.sync();}
  await h.pump();assert.equal(physical.length,0,'logical disposal is not physical evidence');
  gate.resolve();await h.pump();assert.equal(physical.length,1);exactSettlement(physical[0],'closed',current,true);
  assert.equal(logical.length,disposed?0:1,'legacy logical onClose suppression after dispose is preserved');
  assert.deepEqual(trace,disposed?['child-disposed','physical']:['child-disposed','logical-close','physical']);
  dialog.close();dialog.dispose();await h.pump();assert.equal(physical.length,1);assert.equal(timing.calls.length,1);
});

test('default native consumer without physical observer keeps existing logical disposal semantics',async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),timing=nativeCloseTiming(h),gate=timing.hold();let children=0,logical=0;
  const dialog=openNativeDialog(h.runtime,{title:'Legacy unchanged consumer',pageId:'legacy-settlement-control'},
    {mount(){return{dispose(){children++;}};},onClose(){logical++;}});
  dialog.close({force:true,restoreFocus:false,returnToParent:false});dialog.dispose();await h.pump();assert.equal(children,1);assert.equal(logical,0);
  gate.resolve();await h.pump();assert.equal(children,1);assert.equal(logical,0);assert.equal(dialog.closed,true);assert.equal(dialog.failed,false);
});

for(const failed of [false,true])test(`synchronous native close during opening is classified before one-shot physical observer (${failed?'mount throws':'normal close'})`,async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),trace=[],physical=[];let dialog;
  dialog=openNativeDialog(h.runtime,{title:'Opening settlement order',pageId:'synchronous-settlement'},
    {mount(host,close){trace.push('mount');host.textContent='Owned';if(failed)throw new Error('PRIVATE_MOUNT_FAILURE');
        close({force:true,restoreFocus:false,returnToParent:false});trace.push('mount-return');return{dispose(){trace.push('child-disposed');}};},
      onError(error){assert.equal(error.message,'PRIVATE_MOUNT_FAILURE');trace.push('opening-error');},
      onClose(){trace.push('logical-close');},
      onNativeSettlement(value){physical.push(value);trace.push('physical');throw new Error('PRIVATE_OBSERVER_FAILURE');}});
  await h.pump();assert.equal(physical.length,1);exactSettlement(physical[0],'closed',true,false);
  assert.equal(dialog.failed,failed);assert.equal(trace.at(-1),'physical');
  assert.equal(trace.includes('opening-error'),failed);assert.equal(trace.includes('logical-close'),!failed);
  assert.ok(trace.indexOf(failed?'opening-error':'logical-close')<trace.indexOf('physical'),'classification/ordinary callback precedes physical observer');
  dialog.close();dialog.dispose();await h.pump();assert.equal(physical.length,1,'observer throw/reentry cannot retry notification');
});

test('throwing ordinary callback cannot suppress committed physical event or alter its once-only delivery',async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),timing=nativeCloseTiming(h),gate=timing.hold(),trace=[],physical=[];
  const dialog=openNativeDialog(h.runtime,{title:'Observer finally ordering',pageId:'physical-finally'},
    {mount(){return{dispose(){trace.push('child-disposed');}};},onClose(){trace.push('logical-close');throw new Error('PRIVATE_LOGICAL_CLOSE_FAILURE');},
      onNativeSettlement(value){physical.push(value);trace.push('physical');dialog.dispose();throw new Error('PRIVATE_OBSERVER_FAILURE');}});
  const completion=observe(Promise.resolve(dialog.close({force:true,restoreFocus:false,returnToParent:false})));
  await h.pump();assert.equal(physical.length,0);gate.resolve();await h.pump();
  assert.equal(completion.state,'rejected','legacy logical callback error is not swallowed or replaced by observer failure');
  assert.equal(completion.error.message,'PRIVATE_LOGICAL_CLOSE_FAILURE');assert.equal(physical.length,1);exactSettlement(physical[0],'closed',true,false);
  assert.deepEqual(trace,['child-disposed','logical-close','physical']);dialog.dispose();dialog.close();await h.pump();assert.equal(physical.length,1);
});

test('actual pre-admission signal is classified before exact not-acquired observer and cannot be forged by initial options',async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),trace=[],physical=[];
  const competitor=h.runtime.openForm({title:'Admission owner',pageId:'admission-control',onMount(){}});
  h.trackCleanup(()=>competitor.close(null,{force:true,restoreFocus:false}));const active=page(h);let supplied=0;
  const dialog=openNativeDialog(h.runtime,{title:'Rejected observer',pageId:'admission-rejected',onAdmissionRejected(){supplied++;assert.fail('caller must not provide physical settlement evidence');}},
    {fallbackHost:h.host,onError(){trace.push('error');},onClose(){trace.push('logical');},
      onNativeSettlement(value){physical.push(value);trace.push('physical');}});
  await h.pump();assert.equal(dialog.failed,true);assert.equal(supplied,0);assert.deepEqual(trace,['error','physical']);
  assert.equal(physical.length,1);exactSettlement(physical[0],'not-acquired',false,false);assert.equal(page(h),active);
  dialog.close();dialog.dispose();await h.pump();assert.equal(physical.length,1);assert.equal(page(h),active);
});

test('actual native admission rejection callback is isolated and does not change its guard or original error',async t=>{
  const h=await fixture(t),competitor=h.runtime.openForm({title:'Guard owner',pageId:'guard-owner',onMount(){}});
  h.trackCleanup(()=>competitor.close(null,{force:true,restoreFocus:false}));const active=page(h);let calls=0,mounts=0,error;
  try{h.runtime.openForm({title:'Rejected',pageId:'guard-rejected',onAdmissionRejected(){calls++;throw new Error('PRIVATE_ADMISSION_OBSERVER_FAILURE');},onMount(){mounts++;}});}catch(value){error=value;}
  assert.ok(error);assert.equal(error.message,'The form dialog is unavailable.');assert.equal(calls,1);assert.equal(mounts,0);assert.equal(page(h),active);
});

test('availability predicate exception is unknown, not a native pre-admission rejection',async t=>{
  const h=await fixture(t);let rejected=0,mounted=0;const failure=new Error('PRIVATE_AVAILABILITY_FAILURE');
  assert.throws(()=>h.owner('openReactFormDialog')({title:'Unknown availability',pageId:'availability-unknown',
    onAdmissionRejected(){rejected++;},onMount(){mounted++;}},()=>{throw failure;}),error=>error===failure);
  assert.equal(rejected,0);assert.equal(mounted,0);assert.equal(page(h),null);
});

function faultActualAvailability(h){
  const original=h.context.openReactFormDialog,checks=[];
  h.context.openReactFormDialog=function(options,isAvailable,...rest){
    return original.call(this,options,function(...args){
      const value=isAvailable.apply(this,args);checks.push(value);
      // Delegate the original predicate, then fail its actual guard evaluation.
      // This is not a guard refusal and cannot manufacture onAdmissionRejected.
      throw new Error('PRIVATE_AVAILABILITY_FAILURE');
    },...rest);
  };
  h.trackCleanup(()=>{h.context.openReactFormDialog=original;});return {checks};
}

test('helper does not infer not-acquired from an actual availability exception before onMount',async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),fault=faultActualAvailability(h),physical=[],errors=[];let mounts=0;
  const dialog=openNativeDialog(h.runtime,{title:'Unknown ownership',pageId:'unknown-before-mount'},
    {mount(){mounts++;},onError(error){errors.push(error);},onNativeSettlement(value){physical.push(value);}});
  await h.pump();assert.equal(fault.checks.length,1);assert.equal(mounts,0);assert.equal(errors.length,1);assert.equal(dialog.failed,true);
  dialog.close();dialog.dispose();h.advance(120000);await h.pump();assert.equal(physical.length,0,'no callback or absent owner handle proves safe non-acquisition');
});

test('actual pre-mount availability exception leaves coordinator native barrier unknown, unlike explicit refusal',async t=>{
  const h=await fixture(t),fault=faultActualAvailability(h),before=work(h),outcomes=[];
  const first=h.open({onClose:value=>outcomes.push(value)}),closed=observe(first.closed);await h.pump();
  assert.equal(fault.checks.length,1);assert.equal(closed.state,'pending');assert.equal(outcomes.length,0);unchanged(h,before);
  first.close();first.dispose();h.open();const terminal=observe(h.coordinator.dispose());h.advance(120000);await h.pump();
  assert.equal(closed.state,'pending');assert.equal(terminal.state,'pending');unchanged(h,before);assert.equal(h.preview(),null);
  assert.equal(h.text().includes('PRIVATE_AVAILABILITY_FAILURE'),false);
});

test('synchronous acquired close still emits physical evidence after legacy onError throws, preserving its error',async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),trace=[],physical=[];
  const legacyError=new Error('PRIVATE_LEGACY_ERROR_CALLBACK');
  assert.throws(()=>openNativeDialog(h.runtime,{title:'Opening callback throws',pageId:'opening-callback-throw'},
    {mount(){trace.push('mount');throw new Error('PRIVATE_MOUNT_FAILURE');},
      onError(){trace.push('error');throw legacyError;},onNativeSettlement(value){physical.push(value);trace.push('physical');throw new Error('PRIVATE_PHYSICAL_OBSERVER');}}),error=>error===legacyError);
  await h.pump();assert.equal(physical.length,1);exactSettlement(physical[0],'closed',true,false);assert.deepEqual(trace,['mount','error','physical']);
});

test('helper-owned rejected cleanup is consumed but never reported as physical settlement',async t=>{
  const h=await fixture(t),{openNativeDialog}=await nativeModule(),timing=nativeCloseTiming(h),gate=timing.hold(),physical=[],errors=[];
  const dialog=openNativeDialog(h.runtime,{title:'Rejected acquired cleanup',pageId:'helper-rejected-close'},
    {mount(){assert.equal(page(h)?.pageId,'helper-rejected-close');throw new Error('PRIVATE_OWNED_MOUNT_FAILURE');},
      onError(error){errors.push(error);},onNativeSettlement(value){physical.push(value);}});
  // Unlike the coordinator post-original-mount fault, this throw happens inside
  // the helper mount callback. Its retireNative starts and receives the FIRST
  // actual close Promise. The outer native catch sees only already-finishing
  // false. Product must consume its own rejection, not synthesize a close.
  await h.pump();assert.equal(dialog.failed,true);assert.equal(timing.calls.length,1);assert.equal(errors.length,1);assert.equal(physical.length,0);
  gate.reject(new Error('PRIVATE_OWNED_CLOSE_REJECTION'));await h.pump();
  dialog.close();dialog.dispose();h.advance(120000);await h.pump();assert.equal(physical.length,0);assert.equal(errors.length,1);
  // No process rejection handler or Promise wrapper masks product failures.
  // The test runner itself must report any unconsumed native close rejection.
});
