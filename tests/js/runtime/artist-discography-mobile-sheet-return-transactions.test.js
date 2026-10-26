'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {fixture,mounted,opened,opener,fullAlbum,artistView,group,ARTIST,drain,read}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
const {plain,sheet,parentPayload,currentReturnRecord}=require('./artist-sheet-contract-helpers.cjs');

async function retainedReturnWitness(t) {
  const h=await mounted(t),source=opener(h),origin=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed);
  const token=origin.captureReturn().token,{lease,record}=currentReturnRecord(h,token);
  h.scrollTo(347.25);h.scroll.scrollLeft=19;
  assert.equal(h.context.openTrackModalForButton(source.button),true);await drain();h.frame();
  h.scrollTo(833.5);h.scroll.scrollLeft=41;
  return {h,lease,record,token};
}
for(const route of ['back','fallback'])test(`accepted sheet ${route} holds cleanup reentry until saved axes precede retained disclosure resume`,async t=>{
  const {h,lease,record,token}=await retainedReturnWitness(t),observations=[];
  if(route==='fallback'){const saved=plain(h.history.state);delete saved.albumHavenNavigationPosition;h.history.replaceState(saved,'',h.location.href);}
  const close=h.context.closeTrackModal;
  h.context.closeTrackModal=function(...args){
    if(h.mobileState().cleaning){const snapshot=h.runtime().snapshot();observations.push({phase:'cleanup',snapshot,
      suspended:lease.suspended,record:lease.mounted.get(record.key),top:h.scroll.scrollTop,left:h.scroll.scrollLeft});}
    return close.apply(this,args);
  };
  const replace=h.history.replaceState;
  h.history.replaceState=function(...args){const result=replace.apply(this,args);
    if(route==='fallback'&&h.mobileState().presentationTransition){const snapshot=h.runtime().snapshot();observations.push({phase:'replace',snapshot,
      suspended:lease.suspended,record:lease.mounted.get(record.key),top:h.scroll.scrollTop,left:h.scroll.scrollLeft});}
    return result;
  };
  const request=h.requests.length;
  if(route==='back'){h.holdHistory();h.context.closeTrackModal();assert.equal(h.scroll.scrollTop,833.5);assert.equal(h.scroll.scrollLeft,41);h.settleHistory();}
  else h.context.closeTrackModal();
  await drain();assert.equal(h.requests.length,request+1);assert.equal(h.requests[request].settled,false);
  assert.ok(observations.some(row=>row.phase==='cleanup'));if(route==='fallback')assert.ok(observations.some(row=>row.phase==='replace'));
  for(const row of observations){assert.equal(row.snapshot.sessionId,token.sessionId);assert.equal(row.snapshot.actionable,false);assert.equal(row.snapshot.retained,true);
    assert.equal(row.suspended,true);assert.equal(row.record,record);assert.equal(row.top,833.5);assert.equal(row.left,41);}
  assert.equal(h.mobileState().presentationTransition,null);assert.equal(h.scroll.scrollTop,347.25);assert.equal(h.scroll.scrollLeft,19);
  assert.equal(h.grid._artistPageLease,lease);assert.equal(lease.mounted.get(record.key),record);
  const invocation=h.invocations.at(-1);h.reply(request,parentPayload());await invocation.outcome;await drain();
  for(let i=0;i<5;i++){h.frame();await drain();}
  assert.equal(h.grid._artistPageLease,lease);assert.equal(currentReturnRecord(h,token).record,record);
  assert.equal(h.scroll.scrollTop,347.25);assert.equal(h.scroll.scrollLeft,19);
  const settled=h.runtime().snapshot();assert.equal(settled.actionable,true);assert.equal(settled.mounted,true);assert.equal(settled.sessionId,token.sessionId);
});
test('dirty child veto does not acquire a parent-return transaction or restore displaced sheet axes',async t=>{
  const {h,record,lease}=await retainedReturnWitness(t);let decisions=0;
  h.openForm({beforeDismiss:()=>{decisions++;return false;}});await drain();h.frame();
  const requests=h.requests.length;h.holdHistory();const pending=h.context.requestMobileArtistSheetDismissal();h.settleHistory();await drain();
  assert.equal(await pending,false);assert.equal(decisions,1);assert.equal(h.requests.length,requests);
  assert.equal(h.mobileState().presentationTransition,null);assert.equal(h.scroll.scrollTop,833.5);assert.equal(h.scroll.scrollLeft,41);
  assert.equal(h.grid._artistPageLease,lease);assert.equal(lease.mounted.get(record.key),record);assert.equal(h.mobileState().pages.at(-1).kind,'form');
});
for(const change of ['foreign-history','hash-only','descriptor-axis','descriptor-string','scope','successor-form'])test(`sheet cleanup ${change} invalidates old return without restoring or fetching`,async t=>{
  const {h}=await retainedReturnWitness(t),close=h.context.closeTrackModal,descriptor=sheet(h);let once=true,successor;
  h.context.closeTrackModal=function(...args){const result=close.apply(this,args);
    if(once&&h.mobileState().cleaning){once=false;
      if(change==='foreign-history')h.history.pushState({albumHavenNavigationPosition:999,mobilePages:[]},'','/?artist=Foreign');
      else if(change==='hash-only')h.history.replaceState(h.history.state,'',h.location.href+'#foreign');
      else if(change==='descriptor-axis')descriptor.parentScrollPosition.scrollTop=12;
      else if(change==='descriptor-string')descriptor.parentScrollPosition.scrollTop='347.25';
      else if(change==='scope')h.change('actor','new-return-actor');
      else successor=h.openForm({title:'Successor',pageId:'return-successor'});
      h.runtime().snapshot();
    }return result;
  };
  const requests=h.requests.length;h.holdHistory();h.context.closeTrackModal();h.settleHistory();await drain();
  assert.equal(once,false);assert.equal(h.requests.length,requests);assert.equal(h.scroll.scrollTop,833.5);assert.equal(h.scroll.scrollLeft,41);
  assert.equal(h.mobileState().presentationTransition,null);
  if(change==='successor-form'){assert.ok(successor);assert.equal(h.mobileState().pages.at(-1).title,'Successor');}
  if(change==='foreign-history')assert.equal(h.location.search,'?artist=Foreign');
  if(change==='hash-only')assert.equal(h.location.hash,'#foreign');
});
for(const mode of ['false','throw'])test(`fallback sheet ${mode} history commit releases return hold without hydration or axis restoration`,async t=>{
  const {h}=await retainedReturnWitness(t),saved=plain(h.history.state);delete saved.albumHavenNavigationPosition;h.history.replaceState(saved,'',h.location.href);
  const requests=h.requests.length,replace=h.history.replaceState;h.history.replaceState=()=>{if(mode==='throw')throw new Error('return replace denied');return false;};
  try {if(mode==='throw')assert.throws(()=>h.context.closeTrackModal(),/return replace denied/);else h.context.closeTrackModal();}
  finally {h.history.replaceState=replace;}
  await drain();assert.equal(h.mobileState().presentationTransition,null);assert.equal(h.requests.length,requests);
  assert.equal(h.scroll.scrollTop,833.5);assert.equal(h.scroll.scrollLeft,41);
});
for(const route of ['back','fallback'])test(`unavailable ${route} return transaction settles dismissal without clearing actual in-flight child presentation`,async t=>{
  const {h}=await retainedReturnWitness(t),push=h.history.pushState;let once=true,pending,held,afterAttempt;
  h.holdHistory();
  h.history.pushState=function(...args){const result=push.apply(this,args);
    if(once&&h.mobileState().presentationTransition){once=false;held=h.mobileState().presentationTransition;
      if(route==='fallback'){const saved=plain(h.history.state);delete saved.albumHavenNavigationPosition;h.history.replaceState(saved,'',h.location.href);}
      pending=h.context.requestMobileArtistSheetDismissal();
      if(route==='back')h.settleHistory();
      afterAttempt=h.mobileState().presentationTransition;
    }return result;
  };
  const invocations=h.invocations.length;
  try {h.context.presentMobileCoverLookupPage(h.context.getCurrentTrackModalAlbum());}
  finally {h.history.pushState=push;}
  assert.equal(once,false);assert.ok(held);assert.equal(afterAttempt,held);assert.equal(await pending,false);
  assert.equal(h.mobileState().sheetDismissal,null);assert.equal(h.invocations.length,invocations);
  assert.equal(h.scroll.scrollTop,833.5);assert.equal(h.scroll.scrollLeft,41);
});
for(const route of ['back','fallback'])for(const interruption of ['foreign-history','throw'])test(`nested cover ${route} cleanup ${interruption} settles the captured root dismissal before album cleanup`,async t=>{
  const {h}=await retainedReturnWitness(t);h.context.presentMobileCoverLookupPage(h.context.getCurrentTrackModalAlbum());await drain();h.frame();
  if(route==='fallback'){const saved=plain(h.history.state);delete saved.albumHavenNavigationPosition;h.history.replaceState(saved,'',h.location.href);}
  const close=h.context.closeCoverLookupModal;let observed,once=true;
  h.context.closeCoverLookupModal=function(...args){const result=close.apply(this,args);
    if(once&&h.mobileState().cleaning){once=false;observed=h.mobileState().sheetDismissal;
      if(interruption==='throw')throw new Error('nested cleanup interrupted');
      h.history.pushState({albumHavenNavigationPosition:999,mobilePages:[]},'','/?artist=Foreign');
    }return result;
  };
  const invocations=h.invocations.length;
  if(route==='back'){
    h.holdHistory();h.context.requestMobileArtistSheetDismissal();
    if(interruption==='throw')assert.throws(()=>h.settleHistory(),/nested cleanup interrupted/);else h.settleHistory();
  }else if(interruption==='throw')assert.throws(()=>h.context.requestMobileArtistSheetDismissal(),/nested cleanup interrupted/);
  else h.context.requestMobileArtistSheetDismissal();
  assert.equal(once,false);assert.ok(observed);assert.equal(await observed.promise,false);
  assert.equal(h.mobileState().sheetDismissal,null);assert.equal(h.mobileState().presentationTransition,null);
  assert.equal(h.invocations.length,invocations);assert.equal(h.scroll.scrollTop,833.5);assert.equal(h.scroll.scrollLeft,41);
});
test('nested cover cleanup successor dismissal stays pending when the old return is cancelled',async t=>{
  const first=fullAlbum(1),second=fullAlbum(2),h=await mounted(t,{view:artistView({artist_groups:[group(ARTIST,[first,second])],primary_artist_groups:[group(ARTIST,[first,second])]})});
  const source=opener(h),secondButton=[...h.nodes.container.querySelectorAll('[data-open-tracklist="1"]')].find(node=>!node.classList.contains('cover')&&node.getAttribute('data-album-key')===second.key);
  assert.ok(secondButton);const secondOrigin=h.runtime().captureAlbumSheetOrigin(secondButton,second);assert.ok(secondOrigin);
  h.context.openTrackModalForButton(source.button);await drain();h.frame();h.context.presentMobileCoverLookupPage(h.context.getCurrentTrackModalAlbum());await drain();h.frame();
  const cleanup=h.context.cleanupMobilePage;let once=true,old,next,nextSettled=false;
  h.context.cleanupMobilePage=function(...args){const result=cleanup.apply(this,args);
    if(once&&args[0].kind==='cover-lookup'){once=false;old=h.mobileState().sheetDismissal;
      h.context.openTrackModal(second,{artistSheetOrigin:secondOrigin});h.holdHistory();
      h.context.requestMobileArtistSheetDismissal();next=h.mobileState().sheetDismissal;
      next.promise.then(()=>{nextSettled=true;});
    }return result;
  };
  h.holdHistory();h.context.requestMobileArtistSheetDismissal();h.settleHistory();await drain();
  assert.equal(once,false);assert.ok(old);assert.ok(next);assert.notEqual(next,old);assert.equal(await old.promise,false);
  assert.equal(h.mobileState().sheetDismissal,next);assert.equal(nextSettled,false);assert.equal(next.descriptor.albumKey,second.key);
  assert.equal(h.mobileState().pages.at(-1).albumKey,second.key);
});
