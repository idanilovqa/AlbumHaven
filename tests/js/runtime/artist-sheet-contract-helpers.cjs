'use strict';
const assert=require('node:assert/strict');
const {fixture,mounted,opened,opener,fullAlbum,artistView,group,ARTIST,drain,read}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
// Pure test helpers extracted unchanged; no runtime owner or teardown replacement.
const plain=value=>JSON.parse(JSON.stringify(value));
const sheet=h=>h.mobileState().pages.find(page=>page.kind==='album');
const fields=['albumKey','artistRef','coverSrc','kind','parentPosition','parentScrollPosition','parentViewUrl','presentation','subtitle','title'].sort();
function identity(h) {return {host:h.host,header:h.header,headerText:h.header.textContent,grid:h.grid,viewport:h.nodes.viewport,
  panel:h.panel,albumList:h.document.getElementById('track-modal-list'),table:h.overlay.querySelector('.album-track-table'),
  actions:h.overlay.querySelector('.album-track-table__selection-actions'),player:h.player,playerState:h.state.player,
  discography:h.section('discography').panel,session:h.runtime().snapshot().sessionId};}
function assertSame(h,before,{table=true}={}) {
  assert.equal(h.host,before.host);assert.equal(h.header,before.header);assert.equal(h.header.textContent,before.headerText);
  assert.equal(h.grid,before.grid);assert.equal(h.nodes.viewport,before.viewport);assert.equal(h.panel,before.panel);
  assert.equal(h.document.getElementById('track-modal-list'),before.albumList);assert.equal(h.player,before.player);assert.equal(h.state.player,before.playerState);
  assert.equal(h.section('discography').panel,before.discography);assert.equal(h.runtime().snapshot().sessionId,before.session);
  if(table){assert.equal(h.overlay.querySelector('.album-track-table'),before.table);assert.equal(h.overlay.querySelector('.album-track-table__selection-actions'),before.actions);}
}
function assertSheet(h) {
  assert.equal(sheet(h)?.presentation,'artist-discography-sheet');assert.equal(sheet(h).artistRef,ARTIST);
  assert.equal(h.overlay.parentElement,h.document.body);assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),true);
  assert.equal(h.overlay.classList.contains('is-mobile-page'),false);assert.equal(h.main.classList.contains('has-mobile-page'),false);
  assert.equal(h.document.getElementById('mobile-page-header').hidden,true);assert.equal(h.document.getElementById('mobile-page-outlet').hidden,true);
  assert.equal(h.main.hidden,false);assert.equal(h.host.hidden,false);assert.equal(h.host.inert,true);
  assert.equal(h.panel.getAttribute('role'),'dialog');assert.equal(h.panel.getAttribute('aria-modal'),'true');
  assert.equal(h.document.querySelectorAll('#track-modal').length,1);assert.equal(h.document.querySelectorAll('#albums-viewport').length,1);
}
async function returned(h,{reply=artistView({artist_groups:[group(ARTIST,[fullAlbum(1)])],primary_artist_groups:[group(ARTIST,[fullAlbum(1)])]})}={}) {
  const requestIndex=h.requests.length,invocationIndex=h.invocations.length,focusIndex=h.focusLog.length;
  const descriptor=plain(sheet(h)),origin=h.context.getTrackModalArtistSheetOrigin();h.holdHistory();h.context.closeTrackModal();
  assert.equal(h.overlay.hidden,false,'close intent retains live album before accepted traversal');assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);
  assert.equal(h.pendingHistory().length,1);h.settleHistory();await drain();
  assert.equal(h.requests.length,requestIndex+1,'return is a real Gallery response request');assert.equal(h.invocations.length,invocationIndex+1);
  const request=h.requests[requestIndex],invocation=h.invocations[invocationIndex];assert.equal(request.settled,false);
  assert.equal(new URL(invocation.args[0],h.location).href,descriptor.parentViewUrl);assert.equal(invocation.args[1],false);
  assert.equal(h.focusLog.slice(focusIndex).some(row=>row.node===h.opener?.button),false,'no opener focus before actual hydration');
  h.reply(requestIndex,reply);const outcome=await invocation.outcome;assert.equal(outcome.error,undefined);await drain();
  // Drain actual scheduled parent-scroll stabilization and navigation focus RAFs,
  // including the second frame. Never replace either restoration implementation.
  for(let i=0;i<5;i++){h.frame();await drain();}
  return {descriptor,origin,focusIndex};
}

// R2: transparent browser/callback observations; no fabricated admission receipt.
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const parentPayload=()=>artistView({artist_groups:[group(ARTIST,[fullAlbum(1)])],primary_artist_groups:[group(ARTIST,[fullAlbum(1)])]});
function dismissDrag(h){h.pointer(h.handle,'pointerdown',100,200);h.advance(1000);h.pointer(h.context,'pointermove',100,400);h.frame();h.pointer(h.context,'pointerup',100,400);h.frame();}
function repeatDismissInputs(h){dismissDrag(h);h.send(h.toggle,'click',{detail:0});h.send(h.overlay,'click',{detail:1});h.context.closeTrackModal();}
function liveToggle(h){const node=h.document.getElementById('track-modal-sheet-toggle');assert.equal(node,h.toggle);assert.equal(node.isConnected,true);assert.equal(node.disabled,false);return node;}
function operateToggle(h){const toggle=liveToggle(h),expanded=toggle.getAttribute('aria-expanded')==='true';h.send(toggle,'click',{detail:0});h.frame();assert.equal(toggle.getAttribute('aria-expanded'),String(!expanded));assert.equal(h.overlay.getAttribute('data-sheet-state'),expanded?'resting':'expanded');}
function observeReplay(h,boundary=()=>{}) {
  const original=h.context.fetchAndRender,events=[];
  h.context.fetchAndRender=function(...callArgs){
    const options=callArgs[2]||{};
    if(!options.onStart||!options.onSettled)return original.apply(this,callArgs);
    const wrapped={...options};
    for(const [name,phase] of [['onStart','start'],['shouldApplyResponse','apply'],['onSettled','settled']]) {
      if(typeof options[name]!=='function')continue;
      wrapped[name]=function(...args){
        const row={phase,args,receipt:phase==='apply'?undefined:plain(args[0]),id:h.state.ui.activeViewRequestId,
          controller:h.state.ui.activeViewRequestController,busy:h.state.busy};events.push(row);
        // Observation failures are recorded, never allowed to suppress the real
        // callback in Gallery's intentionally swallowed observer boundary.
        if(phase==='settled')try {boundary(row);} catch(error) {row.observationError=error;}
        try {row.result=options[name].apply(this,args);return row.result;}
        catch(error){row.callbackError=error;throw error;}
      };
    }
    const forwarded=[...callArgs];forwarded[2]=wrapped;return original.apply(this,forwarded);
  };return events;
}
function assertReplayObservations(events){for(const row of events){if(row.observationError)throw row.observationError;if(row.callbackError)throw row.callbackError;}}
async function freshReplay(t,boundary){const source=await opened(t),saved=plain(source.history.state),h=fixture(t,{url:source.location.href});await h.entry();h.history.replaceState(saved,'',source.location.href);
  const events=observeReplay(h,boundary?row=>boundary(h,row):undefined),index=h.requests.length;t.after(()=>assertReplayObservations(events));h.context.handleMobilePagePopState();await drain();
  assert.equal(h.requests.length,index+1);const start=events.find(row=>row.phase==='start');assert.ok(start);assert.equal(start.receipt.requestId,start.id);assert.equal(start.controller,h.state.ui.activeViewRequestController);assert.equal(start.result,true);
  return {h,index,events,start,pending:h.mobileState().sheetRestore};}
function successorReceipt(h){const snapshot=h.runtime().snapshot();return {session:snapshot.sessionId,entry:snapshot.entryKey,controller:h.state.ui.activeViewRequestController,id:h.state.ui.activeViewRequestId,history:JSON.stringify(h.history.state),href:h.location.href};}
function assertSuccessor(h,before){assert.deepEqual(successorReceipt(h),before);}

function currentReturnRecord(h,token){
  const lease=h.grid._artistPageLease,section=h.grid.sections.find(row=>row.sectionKey===token.sectionKey);
  assert.ok(lease?.active);assert.equal(lease.suspended,false);assert.equal(h.grid.artistPagePresentationPaused(),false);
  assert.ok(section,'saved release subsection exists in current response');
  const record=lease.mounted.get(h.grid.getRenderedSectionKey(section));assert.ok(record);assert.equal(record.element.isConnected,true);
  assert.equal(record.toggle.isConnected,true);return {lease,section,record};
}
function exactReturnButton(record,token){return [...record.element.querySelectorAll('[data-album-key]')].find(node=>
  node.getAttribute('data-album-key')===token.albumKey&&node.getAttribute('data-album-version-key')===token.versionKey
  &&(token.trigger==='cover'?node.classList.contains('cover'):node.classList.contains('album-title-button')&&!node.classList.contains('cover')&&node.getAttribute('data-open-tracklist')==='1'));}

module.exports={plain,sheet,fields,identity,assertSame,assertSheet,returned,deferred,parentPayload,dismissDrag,repeatDismissInputs,liveToggle,operateToggle,observeReplay,assertReplayObservations,freshReplay,successorReceipt,assertSuccessor,currentReturnRecord,exactReturnButton};
