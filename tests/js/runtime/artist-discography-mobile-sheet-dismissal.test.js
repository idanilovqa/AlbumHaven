'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {fixture,mounted,opened,opener,fullAlbum,artistView,group,ARTIST,drain,read}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
const {plain,sheet,identity,assertSame,assertSheet,returned,deferred,parentPayload,dismissDrag,repeatDismissInputs,liveToggle,operateToggle,observeReplay,assertReplayObservations,freshReplay,successorReceipt,assertSuccessor}=require('./artist-sheet-contract-helpers.cjs');

test('held actual dismissal traverses once while repeated drag toggle backdrop and Close retain pending sheet',async t=>{
  const h=await opened(t),before=identity(h);h.holdHistory();dismissDrag(h);assert.equal(h.overlay.getAttribute('data-sheet-state'),'awaiting-dismissal');
  const pending=h.mobileState().sheetDismissal;assert.ok(pending);repeatDismissInputs(h);assert.equal(h.pendingHistory().length,1);assert.equal(h.mobileState().sheetDismissal,pending);assertSame(h,before);
  h.settleHistory();await drain();assert.equal(await pending.promise,true);assert.equal(h.overlay.hidden,true);assert.equal(h.mobileState().sheetDismissal,null);
});
test('pending album dismissal through actual dirty child waits for veto then restores retained snap and input',async t=>{
  const h=await opened(t);operateToggle(h);const before=identity(h),origin=h.context.getTrackModalArtistSheetOrigin(),presenter=h.owner('artistSheetPresenter');
  let decision=deferred(),decisions=0;const form=h.openForm({beforeDismiss:()=>{decisions++;return decision.promise;}});await drain();h.frame();
  h.holdHistory();const pending=h.context.requestMobileArtistSheetDismissal();assert.equal(h.context.requestMobileArtistSheetDismissal(),pending);assert.equal(h.pendingHistory().length,1);
  h.settleHistory();await drain();assert.equal(decisions,1);assert.equal(h.overlay.hidden,true);assertSame(h,before);
  const calls=h.historyCalls.length;repeatDismissInputs(h);assert.equal(h.context.requestMobileArtistSheetDismissal(),pending);
  const childPending=form.dismiss('back');assert.equal(form.dismiss('escape'),childPending);await drain();
  assert.equal(decisions,1);assert.equal(h.pendingHistory().length,0);assert.equal(h.historyCalls.length,calls);
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);assert.equal(h.owner('artistSheetPresenter'),presenter);
  decision.resolve(false);assert.equal(await pending,false);assert.equal(await childPending,false);await drain();h.frame();
  assert.equal(h.mobileState().pages.at(-1).kind,'form');assert.equal(h.mobileState().sheetDismissal,null);assertSame(h,before);
  // Dismiss only the child through its real owner, then exercise the retained
  // sheet. The veto must not reset the old expanded snap or install a presenter.
  decision=deferred();h.holdHistory();const childClose=form.dismiss('back');await drain();decision.resolve(true);await drain();
  assert.equal(h.pendingHistory().length,1);h.settleHistory();assert.equal(await childClose,true);await drain();h.frame();
  assertSheet(h);assertSame(h,before);assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);assert.equal(h.owner('artistSheetPresenter'),presenter);
  assert.equal(h.overlay.getAttribute('data-sheet-state'),'expanded');operateToggle(h);operateToggle(h);
  decision=deferred();h.openForm({beforeDismiss:()=>{decisions++;return decision.promise;}});await drain();h.frame();
  h.holdHistory();const accepted=h.context.requestMobileArtistSheetDismissal();h.settleHistory();await drain();assert.equal(decisions,3);decision.resolve(true);assert.equal(await accepted,true);await drain();assert.equal(h.overlay.hidden,true);assert.equal(h.mobileState().pages.length,0);
});
test('actual history go throw clears dismissal latch and a later gesture can retry',async t=>{
  const h=await opened(t),before=identity(h),go=h.history.go;h.history.go=()=>{throw new Error('browser traversal denied');};
  assert.throws(()=>h.context.requestMobileArtistSheetDismissal(),/browser traversal denied/);h.history.go=go;
  assert.equal(h.mobileState().sheetDismissal,null);assertSame(h,before);h.holdHistory();dismissDrag(h);assert.equal(h.pendingHistory().length,1);assert.equal(h.overlay.getAttribute('data-sheet-state'),'awaiting-dismissal');
});
test('successor presentation survives settlement of obsolete held dismissal',async t=>{
  const h=await opened(t);h.holdHistory();dismissDrag(h);const old=h.mobileState().sheetDismissal;
  h.context.openTrackModal(fullAlbum(2));await drain();h.frame();const next=h.context.getCurrentTrackModalAlbum();assert.equal(next.key,fullAlbum(2).key);
  await old.promise;await drain();assert.equal(h.context.getCurrentTrackModalAlbum(),next);assert.equal(h.overlay.hidden,false);assert.notEqual(h.mobileState().sheetDismissal,old);
});
test('exact replay success remains admitted through controller release snapshot and genuine onSettled',async t=>{
  let boundaryCount=0;const {h,index,events,start}=await freshReplay(t,(h,row)=>{boundaryCount++;row.snapshot=h.runtime().snapshot();const admission=h.mobileState().sheetRestore.admission;row.preSettlementResolution=admission.resolve();row.preSettlementHasParent=admission.hasParent();row.originBeforeSettlement=h.context.getTrackModalArtistSheetOrigin();});
  h.reply(index,parentPayload());await h.invocations.at(-1).outcome;await drain();h.frame();assertReplayObservations(events);assert.equal(boundaryCount,1);const boundary=events.find(row=>row.phase==='settled');assert.equal(boundary.controller,null);assert.equal(boundary.busy,false);assert.equal(boundary.id,start.id);assert.equal(boundary.snapshot.mounted,true);assert.equal(boundary.preSettlementResolution,null);assert.equal(boundary.preSettlementHasParent,false);assert.equal(boundary.originBeforeSettlement,null);assertSheet(h);
  assert.equal(events.find(row=>row.phase==='apply').result,true);const terminal=events.find(row=>row.phase==='settled');assert.equal(terminal.receipt.requestId,start.id);assert.equal(terminal.receipt.applied,true);
});
for(const scope of ['actor','library','context'])test(`pending replay ${scope} scope retirement rejects old response without touching successor`,async t=>{
  const {h,index,pending,events,start}=await freshReplay(t),oldInvocation=h.invocations.at(-1);h.change(scope,'new-read-scope');const work=h.read(sheet(h)?.parentViewUrl||pending.descriptor.parentViewUrl,{restartIfSameUrl:true},false);const nextIndex=h.requests.length-1,before=successorReceipt(h);
  h.reply(index,parentPayload());const oldResult=await oldInvocation.outcome;assert.equal(oldResult.value,false);assert.equal(oldResult.error,undefined);assert.equal(await pending.promise,false);await drain();assertReplayObservations(events);assert.equal(events.filter(row=>row.phase==='settled').length,0,'obsolete request must not receive Gallery onSettled');assert.equal(pending.controller.signal.aborted,true);assert.equal(h.mobileState().sheetRestore,null);assertSuccessor(h,before);assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);
  h.reply(nextIndex,parentPayload());await work;await drain();assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);
});
test('same-route successor with unchanged history owns exact request controller and entry after old replay completion',async t=>{
  const {h,index,pending,start,events}=await freshReplay(t),oldInvocation=h.invocations.at(-1),history=JSON.stringify(h.history.state);const work=h.read(pending.descriptor.parentViewUrl,{restartIfSameUrl:true,preserveScroll:true},false),nextIndex=h.requests.length-1;
  assert.notEqual(h.state.ui.activeViewRequestController,start.controller);assert.equal(JSON.stringify(h.history.state),history);const before=successorReceipt(h);
  h.reply(index,parentPayload());const oldResult=await oldInvocation.outcome;assert.equal(oldResult.value,false);assert.equal(oldResult.error,undefined);assert.equal(await pending.promise,false);await drain();assertReplayObservations(events);assert.equal(events.filter(row=>row.phase==='settled').length,0,'obsolete request must not receive Gallery onSettled');assert.equal(pending.controller.signal.aborted,true);assert.equal(h.mobileState().sheetRestore,null);assertSuccessor(h,before);assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);
  h.reply(nextIndex,parentPayload());await work;await drain();h.frame();assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);
});
for(const outcome of ['failed','aborted','successful-unapplied'])test(`real replay ${outcome} terminal never grants sheet authority`,async t=>{
  const {h,index,events,start,pending}=await freshReplay(t),invocation=h.invocations.at(-1);let successor,work,nextIndex;
  if(outcome==='failed')h.reply(index,{error:'Unavailable'},500);
  else if(outcome==='aborted'){h.state.ui.activeViewRequestController.abort();h.requests[index].reject(Object.assign(new Error('cancelled transport'),{name:'AbortError'}));}
  else {
    // A real newer request retires the old request. The old transport still
    // resolves successfully; Gallery itself returns false without applying it.
    work=h.read(pending.descriptor.parentViewUrl,{restartIfSameUrl:true},false);nextIndex=h.requests.length-1;successor=successorReceipt(h);
    h.reply(index,parentPayload(),200);
  }
  const result=await invocation.outcome;if(outcome==='failed')assert.ok(result.error);else {assert.equal(result.error,undefined);assert.equal(result.value,false);}
  assert.equal(await pending.promise,false);await drain();h.frame();assertReplayObservations(events);
  const terminal=events.filter(row=>row.phase==='settled');
  if(outcome==='failed'){assert.equal(terminal.length,1);assert.equal(terminal[0].receipt.requestId,start.id);assert.equal(terminal[0].receipt.applied,false);assert.ok(terminal[0].receipt.error);assert.equal(terminal[0].args[0].error,result.error);}
  else assert.equal(terminal.length,0,'aborted or superseded work cannot receive Gallery onSettled');
  if(outcome==='successful-unapplied')assertSuccessor(h,successor);
  assert.equal(pending.controller.signal.aborted,true);assert.equal(h.mobileState().sheetRestore,null);
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);
  if(work){h.reply(nextIndex,parentPayload());await work;await drain();assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);}
});
for(const action of ['snapshot','cancel','reenter','same-route','abort','actor','library','context'])test(`terminal controller-release ${action} boundary does not transfer old replay authority`,async t=>{
  let successor,work,nextIndex;const {h,index,events,start,pending}=await freshReplay(t,(h,row)=>{
    row.snapshot=h.runtime().snapshot();if(action==='snapshot')return;
    if(action==='cancel'){h.history.pushState({albumHavenNavigationPosition:999,mobilePages:[]},'','/?artist=Other');h.context.handleMobilePagePopState();}
    else if(action==='abort')start.controller.abort();
    else if(['actor','library','context'].includes(action))h.change(action,'terminal-new-scope');
    else {work=h.read(action==='same-route'?pending.descriptor.parentViewUrl:'https://albumhaven.test/?artist=Other',{restartIfSameUrl:true},false);nextIndex=h.requests.length-1;}
    successor=successorReceipt(h);
  });const invocation=h.invocations.at(-1);h.reply(index,parentPayload());await invocation.outcome;await drain();h.frame();assertReplayObservations(events);const terminal=events.find(row=>row.phase==='settled');assert.equal(terminal.controller,null);assert.equal(terminal.snapshot.mounted,true);
  if(action==='snapshot'){assert.equal(await pending.promise,true);assertSheet(h);}else {assert.equal(await pending.promise,false);assertSuccessor(h,successor);assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);if(work){h.reply(nextIndex,artistView());await work;}}
});
test('ordered album and cover child replay waits for exact parent settlement before restoring nested chain',async t=>{
  const source=await opened(t);source.context.presentMobileCoverLookupPage(source.context.getCurrentTrackModalAlbum());await drain();const saved=plain(source.history.state),h=fixture(t,{url:source.location.href});await h.entry();
  // A reload preserves the actual browser stack, not just its final marker.
  // Back from cover must have the genuine preceding album entry available.
  source.entries.forEach((entry,index)=>h.history[index===0?'replaceState':'pushState'](plain(entry.state),'',entry.url));
  assert.deepEqual(plain(h.history.state),saved);assert.equal(h.location.href,source.location.href);
  const events=observeReplay(h),index=h.requests.length;h.context.handleMobilePagePopState();await drain();assert.equal(h.mobileState().pages.length,0);assert.equal(h.overlay.hidden,true);
  h.reply(index,parentPayload());await drain();h.frame();assertReplayObservations(events);assert.equal(events.find(row=>row.phase==='settled').receipt.applied,true);
  assert.deepEqual(Array.from(h.mobileState().pages,row=>row.kind),saved.mobilePages.map(row=>row.kind));assert.equal(h.mobileState().pages[0].presentation,'artist-discography-sheet');assert.equal(h.overlay.hidden,true);
  h.holdHistory();h.context.closeCoverLookupModal();h.settleHistory();await drain();h.frame();assertSheet(h);
});

test('live connected toggle survives actual header replacement layouts widths and close reopen',async t=>{
  const h=await opened(t),list=h.document.getElementById('track-modal-list'),player=h.player,calls=h.historyCalls.length;
  for(const layout of ['classic_bar','stacked_bar','editorial_canvas']){h.document.documentElement.setAttribute('data-album-details-layout',layout);h.context.renderTrackModalRelease(h.context.getCurrentTrackModalAlbum());h.context.syncMobileAlbumComposition(h.context.getCurrentTrackModalAlbum());await drain();h.frame();
    operateToggle(h);assert.equal(h.document.getElementById('track-modal-list'),list);assert.equal(h.overlay.querySelectorAll('.album-track-table').length,1);assert.equal(h.overlay.querySelectorAll('.album-track-table__selection-actions').length,1);assert.equal(h.player,player);}
  for(const width of [900,901,900]){h.context.innerWidth=width;h.document.documentElement.clientWidth=width;h.context.syncMobilePageShell();h.context.syncMobileAlbumComposition(h.context.getCurrentTrackModalAlbum());await drain();h.frame();assert.equal(h.document.getElementById('track-modal-sheet-toggle'),h.toggle);assert.equal(h.toggle.isConnected,true);if(width<=900)operateToggle(h);}
  assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,0);await returned(h);const button=opener(h);h.context.openTrackModalForButton(button.button);await drain();h.frame();operateToggle(h);assert.equal(h.player,player);
});
test('successful preview hydration leaves the actual rendered toggle connected and actionable',async t=>{
  const preview=fullAlbum(1,{preview_only:true,tracks:[],track_count:1}),h=await mounted(t,{view:artistView({artist_groups:[group(ARTIST,[preview])],primary_artist_groups:[group(ARTIST,[preview])]})});
  const source=opener(h),start=h.requests.length;h.context.openTrackModalForButton(source.button);await drain();liveToggle(h);const details=h.requests.slice(start).find(row=>/album-details/.test(row.url));assert.ok(details);const calls=h.historyCalls.length;
  details.resolve({ok:true,album:fullAlbum(1)});await drain();h.frame();operateToggle(h);assert.ok(h.overlay.querySelector('.album-details-header__identity'));assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,0);
});
test('served sheet CSS suppresses both initial and renderer identity selectors structurally',()=>{
  const css=read('music_app/static/css/runtime/bottom-sheet.css'),template=read('music_app/templates/partials/primary-modals.html'),renderer=read('music_app/static/js/runtime/album-details-components.js');
  assert.match(css,/\.is-artist-discography-sheet[^{}]*\.track-modal-title-wrap[^{}]*[,{}]/);assert.match(css,/\.is-artist-discography-sheet[^{}]*\.album-details-header__identity[^{}]*\{[^}]*display:\s*none/);
  assert.match(template,/track-modal-title-wrap/);assert.match(renderer,/album-details-header__identity/);
  // This checks served selectors and actual renderer vocabulary, not computed visibility.
});
