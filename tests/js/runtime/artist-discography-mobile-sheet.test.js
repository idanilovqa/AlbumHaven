'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {fixture,mounted,opened,opener,fullAlbum,artistView,group,ARTIST,drain,read}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
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

test('real pointer Discography open captures exact live origin without prior keyboard focus and pushes once',async t=>{
  const h=await mounted(t),before=identity(h),source=opener(h),calls=h.historyCalls.length;
  assert.notEqual(h.document.activeElement,source.button);assert.equal(h.context.openTrackModalForButton(source.button),true);await drain();h.frame();
  assertSheet(h);assertSame(h,before,{table:false});
  assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,1);
  const lease=h.context.getTrackModalArtistSheetOrigin();assert.ok(Object.isFrozen(lease));assert.equal(lease.isParentCurrent(),false);
  assert.equal(lease.isRetainedCurrent(sheet(h)),true);assert.equal(lease.readScroll(),h.scroll);assert.equal(lease.readHeader(),h.header);
  const receipt=lease.captureReturn();assert.equal(receipt.token.albumKey,source.button.getAttribute('data-album-key'));
  assert.equal(receipt.token.versionKey,source.button.getAttribute('data-album-version-key'));assert.equal(receipt.token.trigger,'tracklist');
  assert.ok(h.overlay.querySelector('.album-track-table'),'actual album table rendered');
  assert.ok(h.overlay.querySelector('.album-track-table__selection-actions'),'actual native playtable owner mounted');
  assert.equal(typeof h.owner('NativePlaytables')?.mount,'function');
});
test('sheet expansion, metadata refresh and layout composition retain one album/table/player and global Back',async t=>{
  const h=await opened(t),before=identity(h),back=h.document.getElementById('mobile-back-button'),backParent=back.parentElement;
  const calls=h.historyCalls.length,requests=h.requests.length;h.send(h.toggle,'click',{detail:0});h.frame();
  h.context.syncMobileAlbumComposition(h.context.getCurrentTrackModalAlbum());h.context.syncMobilePageShell();await drain();h.frame();
  assertSheet(h);assertSame(h,before);assert.equal(back.parentElement,backParent);assert.equal(h.overlay.contains(back),false);
  assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,0);assert.equal(h.requests.length,requests);
  const label=h.document.getElementById(h.panel.getAttribute('aria-labelledby'));assert.ok(label&&!label.closest('[hidden]'));
  assert.equal(h.overlay.querySelectorAll('#'+label.id).length,1);
});
for(const surface of ['gallery','home','player','search','family','outside-host','fallback-markup'])test(`${surface} opener cannot manufacture Discography provenance`,async t=>{
  const h=await mounted(t),source=opener(h),button=h.document.createElement('button');button.setAttribute('data-album-key',source.indexed.key);
  button.setAttribute('data-album-version-key',h.context.getAlbumCardVersionKey(source.indexed));button.setAttribute('data-open-tracklist','1');
  if(surface==='fallback-markup')button.setAttribute('data-album',JSON.stringify(source.indexed));
  const parent=surface==='family'?h.section('family').panel:surface==='player'?h.player:h.main;parent.append(button);
  assert.equal(h.runtime().captureAlbumSheetOrigin(button,source.indexed),null);h.context.openTrackModalForButton(button);await drain();h.frame();
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.notEqual(sheet(h)?.presentation,'artist-discography-sheet');
  assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);assert.equal(h.overlay.classList.contains('is-mobile-page'),true);
});
test('stale detached opener and wrong same-key edition fail independent indexed membership',async t=>{
  const h=await mounted(t),source=opener(h);assert.equal(h.runtime().captureAlbumSheetOrigin(source.button,{...source.indexed,edition:'Different edition',path:'/other'}),null);
  source.button.remove();assert.equal(h.runtime().captureAlbumSheetOrigin(source.button,source.indexed),null);
});
test('ordinary same-key external open clears sheet origin rather than inheriting marker',async t=>{
  const h=await opened(t),old=h.context.getTrackModalArtistSheetOrigin(),album=h.context.getCurrentTrackModalAlbum();
  h.context.openTrackModal(album);await drain();h.frame();assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);
  assert.equal(old.isRetainedCurrent(sheet(h)),false);assert.notEqual(sheet(h)?.presentation,'artist-discography-sheet');
});
test('explicit album-page restriction cannot be overcome by a valid live Discography lease',async t=>{
  const h=await mounted(t),source=opener(h),lease=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed),calls=h.historyCalls.length;
  assert.equal(h.context.openTrackModal(source.indexed,{artistSheetOrigin:lease,presentationRestrictions:{can_open_album_page:false}}),false);
  assert.equal(h.mobileState().pages.length,0);assert.equal(h.historyCalls.length,calls);assert.equal(h.overlay.hidden,true);
});
test('actual history serialization contains only finite whitelist fields and no live authority',async t=>{
  const h=await opened(t),page=sheet(h),live=h.context.getTrackModalArtistSheetOrigin();
  Object.assign(page,{callback:()=>{},node:h.opener.button,scope:'secret-scope',sessionId:live.sessionId,payload:h.state.view,lease:live});
  h.context.writeMobilePageHistory('replace');const saved=h.history.state.mobilePages[0];
  assert.deepEqual(Object.keys(saved).sort(),fields);assert.equal(saved.presentation,'artist-discography-sheet');
  assert.deepEqual(saved.parentScrollPosition,{scrollTop:page.parentScrollPosition.scrollTop,scrollLeft:page.parentScrollPosition.scrollLeft});
  const json=JSON.stringify(saved);for(const forbidden of ['secret-scope','callback','sessionId','payload','lease','node'])assert.equal(json.includes('"'+forbidden+'"'),false);
  assert.equal(h.context.isMobileArtistSheet(saved),true,'serialization has no authority apart from the separately retained live lease');
  live.release();assert.equal(h.context.isMobileArtistSheet(saved),false);
});
for(const [name,patch] of [
  ['wrong kind',{kind:'form'}],['missing marker',{presentation:undefined}],['wrong enum',{presentation:'sheet'}],
  ['empty artist',{artistRef:''}],['trimmed artist',{artistRef:' Canonical Artist'}],['control artist',{artistRef:'A\nB'}],
  ['oversize artist',{artistRef:'x'.repeat(513)}],['empty key',{albumKey:''}],['source-page token',{sourcePageToken:'unrelated'}],
  ['foreign route',{parentViewUrl:'https://evil.test/?artist=A'}],['noncanonical relative route',{parentViewUrl:'/?artist=A'}],
  ['child route',{parentViewUrl:'https://albumhaven.test/?mobile_page=album'}],['fragment',{parentViewUrl:'https://albumhaven.test/?artist=A#x'}],
  ['negative position',{parentPosition:-1}],['unsafe position',{parentPosition:Number.MAX_SAFE_INTEGER+1}],['missing position',{parentPosition:undefined}],
  ['nonfinite scroll',{parentScrollPosition:{scrollTop:Infinity,scrollLeft:0}}],['negative scroll',{parentScrollPosition:{scrollTop:0,scrollLeft:-1}}],
  ['missing axis',{parentScrollPosition:{scrollTop:0}}],['missing scroll',{parentScrollPosition:undefined}],
])test(`history normalizer rejects ${name}`,t=>{
  const h=fixture(t),valid={kind:'album',albumKey:'artist-album-1',title:'A',subtitle:'',coverSrc:'',presentation:'artist-discography-sheet',artistRef:ARTIST,
    parentViewUrl:'https://albumhaven.test/?artist=Canonical+Artist',parentPosition:1,parentScrollPosition:{scrollTop:347.25,scrollLeft:19}};
  assert.equal(h.context.normalizeArtistSheetDescriptor({...valid,...patch}),null);
});
test('presentation/ref changes defeat common-prefix equality even for identical album key',async t=>{
  const h=await opened(t),old=h.context.getTrackModalArtistSheetOrigin(),saved=plain(h.history.state);
  delete saved.mobilePages[0].presentation;delete saved.mobilePages[0].artistRef;h.history.replaceState(saved,'',h.location.href);
  h.context.handleMobilePagePopState();await drain();h.frame();assert.equal(old.isRetainedCurrent(saved.mobilePages[0]),false);
  assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);
});
test('fresh reload marker waits for actual parent response before admission and current indexed album resolution',async t=>{
  const source=await opened(t),saved=plain(source.history.state),url=source.location.href;
  const h=fixture(t,{url});await h.entry();h.history.replaceState(saved,'',url);
  const start=h.requests.length,calls=h.historyCalls.length;h.context.handleMobilePagePopState();await drain();
  assert.equal(h.requests.length,start+1);const pendingParent=h.runtime().snapshot();assert.equal(pendingParent.status,'inactive');assert.notEqual(pendingParent.mounted,true);assert.equal(h.overlay.hidden,true);
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.requests[start].settled,false);
  assert.equal(h.historyCalls.slice(calls).some(row=>row.mode==='replace'&&!row.value.mobilePages?.length),false,'pending replay is not prematurely rewritten');
  h.reply(start,artistView({artist_groups:[group(ARTIST,[fullAlbum(1)])],primary_artist_groups:[group(ARTIST,[fullAlbum(1)])]}));
  await h.invocations.at(-1).outcome;await drain();h.frame();assertSheet(h);
  assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,0,'replay adds no entry');
  assert.equal(h.context.getCurrentTrackModalAlbum().preview_only === true,false);
});
test('fresh replay navigation-away cancels pending admission and stale response cannot reopen sheet',async t=>{
  const source=await opened(t),saved=plain(source.history.state),h=fixture(t,{url:source.location.href});await h.entry();h.history.replaceState(saved,'',source.location.href);
  const start=h.requests.length;h.context.handleMobilePagePopState();await drain();const pending=h.mobileState().sheetRestore;assert.ok(pending);
  h.history.pushState({albumHavenNavigationPosition:900,mobilePages:[]},'','/?surface=albums&artist=Other');h.context.handleMobilePagePopState();
  h.reply(start,artistView());await drain();h.frame();assert.equal(pending.controller.signal.aborted,true);assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.overlay.hidden,true);
});
test('reload history title/key grants no album access when actual parent response lacks membership',async t=>{
  const source=await opened(t),saved=plain(source.history.state),h=fixture(t,{url:source.location.href});await h.entry();h.history.replaceState(saved,'',source.location.href);
  const start=h.requests.length;h.context.handleMobilePagePopState();await drain();
  h.reply(start,artistView({artist_groups:[],primary_artist_groups:[],album_count:0}));await drain();h.frame();
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);
  assert.equal(h.mobileState().pages.some(page=>page.presentation==='artist-discography-sheet'),false);
});
test('900 to 901 to 900 transfers original live album/table without fetch or history and releases locks',async t=>{
  const h=await opened(t),before=identity(h),calls=h.historyCalls.length,requests=h.requests.length;
  for(const width of [900,901,900]){h.context.innerWidth=width;h.document.documentElement.clientWidth=width;
    h.context.syncMobilePageShell();h.context.syncMobileAlbumComposition(h.context.getCurrentTrackModalAlbum());await drain();h.frame();
    assertSame(h,before);assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),width<=900);
    assert.equal(h.player.inert,width<=900);assert.equal(h.panel.getAttribute('role'),'dialog');}
  assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,0);assert.equal(h.requests.length,requests);
});
test('nested cover lookup page suspends sheet and Back restores same instance and expanded snap',async t=>{
  const h=await opened(t);h.send(h.toggle,'click',{detail:0});h.frame();const before=identity(h),origin=h.context.getTrackModalArtistSheetOrigin();
  assert.equal(h.context.presentMobileCoverLookupPage(h.context.getCurrentTrackModalAlbum()),true);await drain();h.frame();
  assert.equal(h.main.classList.contains('has-mobile-page'),true);assert.equal(h.overlay.hidden,true);assert.equal(h.player.inert,false);
  h.holdHistory();h.context.closeCoverLookupModal();assert.equal(h.pendingHistory().length,1);h.settleHistory();await drain();h.frame();
  assertSheet(h);assertSame(h,before);assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);assert.equal(h.overlay.getAttribute('data-sheet-state'),'expanded');
});
test('passive nested Back does not publish a transient parent state to reentrant native subscribers',async t=>{
  const h=await opened(t),runtime=h.runtime(),lease=h.grid._artistPageLease,session=runtime.snapshot().sessionId;
  const origin=h.context.getTrackModalArtistSheetOrigin();h.send(h.toggle,'click',{detail:0});h.frame();
  h.context.presentMobileCoverLookupPage(h.context.getCurrentTrackModalAlbum());await drain();h.frame();
  const before=identity(h),requests=h.requests.length,calls=h.historyCalls.length,focus=h.focusAttempts.length,observations=[];
  const stop=runtime.subscribe(()=>{
    const historyLength=h.history.state.mobilePages.length,liveLength=h.mobileState().pages.length;
    // This is a real subscriber reentering the actual snapshot API. The passive
    // listener must not notify at the mismatched pre-cleanup history midpoint.
    const snapshot=runtime.snapshot();observations.push({historyLength,liveLength,session:snapshot.sessionId,
      actionable:snapshot.actionable,retained:snapshot.retained,lease:h.grid._artistPageLease});
  });t.after(stop);
  h.holdHistory();h.context.closeCoverLookupModal();assert.equal(h.pendingHistory().length,1);
  assert.equal(h.mobileState().pages.length,2);assert.equal(h.requests.length,requests);
  h.settleHistory();await drain();h.frame();
  assert.equal(observations.some(row=>row.historyLength!==row.liveLength),false,'no transient lineage notification permits snapshot reentry');
  for(const row of observations){assert.equal(row.session,session);assert.equal(row.actionable,false);assert.equal(row.retained,true);assert.ok(row.lease===lease);}
  const settled=runtime.snapshot();assert.equal(settled.sessionId,session);assert.equal(settled.retained,true);assert.equal(settled.actionable,false);
  assert.ok(h.grid._artistPageLease===lease);assert.ok(h.context.getTrackModalArtistSheetOrigin()===origin);
  assert.equal(h.requests.length,requests);assert.equal(h.historyCalls.length,calls);
  assert.equal(h.focusAttempts.slice(focus).some(row=>row.node.closest('#artist-page-root')),false,'nested Back never focuses the inactive parent');
  assertSheet(h);assertSame(h,before);assert.equal(h.overlay.getAttribute('data-sheet-state'),'expanded');
});
test('dirty nested form veto retains exact sheet and later accepted return releases only child ownership',async t=>{
  const h=await opened(t);h.send(h.toggle,'click',{detail:0});h.frame();const before=identity(h),origin=h.context.getTrackModalArtistSheetOrigin();let permit=false;
  const form=h.openForm({beforeDismiss:()=>permit});assert.equal(await form.dismiss('back'),false);await drain();
  assert.equal(h.mobileState().pages.at(-1).kind,'form');assertSame(h,before);assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);
  permit=true;h.holdHistory();const close=form.dismiss('back');await drain();assert.equal(h.pendingHistory().length,1);h.settleHistory();assert.equal(await close,true);
  await drain();h.frame();assertSheet(h);assertSame(h,before);assert.equal(h.overlay.getAttribute('data-sheet-state'),'expanded');
});
test('real version picker and promise confirmation acquire reversible relative layers above sheet',async t=>{
  const h=await opened(t),before=identity(h);h.context.openVersionPickerModal(h.context.getCurrentTrackModalAlbum());await drain();h.frame();
  const picker=h.document.getElementById('version-picker-modal');assert.equal(Number(picker.style.zIndex),4551);assert.equal(h.overlay.inert,true);
  const confirmation=h.context.showAppConfirmDialog({title:'Confirm test',message:'A bounded fixture confirmation'}),confirm=h.document.getElementById('app-confirm-modal');
  assert.equal(Number(confirm.style.zIndex),4552);assert.equal(picker.inert,true);h.send(h.document.getElementById('app-confirm-cancel'),'click',{detail:0});
  assert.equal(await confirmation,false);assert.equal(picker.inert,false);assert.equal(h.overlay.inert,true);
  h.context.closeVersionPickerModal();await drain();h.frame();assert.equal(h.overlay.inert,false);assert.equal(picker.style.zIndex,'');assertSame(h,before);
});
for(const loss of ['actor','library','context','runtime'])test(`${loss} retirement invalidates old live origin and all queued presentation authority`,async t=>{
  const h=await opened(t),origin=h.context.getTrackModalArtistSheetOrigin(),page=plain(sheet(h)),frames=[...h.frames.values()];
  if(loss==='runtime'){
    const realm=vm.createContext({...h.context,window:h.context,state:h.state,virtualGrid:h.grid,mobilePageState:h.mobileState()});
    vm.runInContext(read('music_app/static/js/runtime/artist-page-bridge.js'),realm,{filename:'music_app/static/js/runtime/artist-page-bridge.js'});
  }else h.change(loss,'retired');
  await drain();for(const frame of frames)frame(0);h.context.updateTrackModalArtistSheet();h.frame();
  assert.equal(origin.isParentCurrent(),false);assert.equal(origin.isRetainedCurrent(page),false);assert.equal(origin.captureReturn(),null);
  assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);assert.equal(h.player.inert,false);
});

test('real hydration close-before-resolve does not reopen or resurrect retired sheet generation',async t=>{
  const preview=fullAlbum(1,{preview_only:true,tracks:[],track_count:1});
  const h=await mounted(t,{view:artistView({artist_groups:[group(ARTIST,[preview])],primary_artist_groups:[group(ARTIST,[preview])]})});
  const source=opener(h),start=h.requests.length;h.context.openTrackModalForButton(source.button);await drain();assertSheet(h);
  const details=h.requests.slice(start).find(row=>/album-details/.test(row.url));assert.ok(details,'actual album hydration request pending');
  h.holdHistory();h.context.closeTrackModal();h.settleHistory();await drain();
  const generation=h.owner('artistSheetGeneration');details.resolve({ok:true,album:fullAlbum(1)});await drain();h.frame();
  assert.equal(h.overlay.hidden,true);assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.owner('artistSheetGeneration'),generation);
});

test('committed return hydrates real parent before viewport-preserving opener focus, after all restoration RAFs',async t=>{
  const h=await mounted(t);h.scrollTo(347.25);h.scroll.scrollLeft=19;const source=opener(h);h.opener=source;
  h.context.openTrackModalForButton(source.button);await drain();h.frame();const saved=plain(sheet(h).parentScrollPosition);
  assert.deepEqual(saved,{scrollTop:347.25,scrollLeft:19});const result=await returned(h);
  assert.equal(h.scroll.scrollTop,347.25);assert.equal(h.scroll.scrollLeft,19);
  const calls=h.focusLog.slice(result.focusIndex);assert.ok(calls.length,'fresh admitted parent receives focus');
  assert.ok(calls.every(row=>row.options?.preventScroll===true));
  const exact=calls.find(row=>row.node===source.button);
  assert.ok(exact,'currently materialized exact opener remains focus target');assert.equal(exact.versionKeyAtCall,source.button.getAttribute('data-album-version-key'));
  assert.equal(result.origin.isParentCurrent(),false,'retired origin is not reused for fresh return authority');
});
for(const condition of ['partial','offscreen','unmaterialized','missing-version','collapsed-section','collapsed-discography'])
  test(`preserveViewport true ${condition} never scrolls, materializes, opens disclosure or selects another edition`,async t=>{
    const h=await mounted(t),source=opener(h),origin=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed),receipt=origin.captureReturn(),lease=h.grid._artistPageLease;
    h.scrollTo(347.25);h.scroll.scrollLeft=19;const section=h.grid.sections.find(row=>row.sectionKey===receipt.token.sectionKey);
    const record=lease.mounted.get(h.grid.getRenderedSectionKey(section));assert.ok(record);
    if(condition==='partial')h.setRect(source.button,{x:20,y:65,width:120,height:30});
    if(condition==='offscreen')h.setRect(source.button,{x:20,y:900,width:120,height:44});
    if(condition==='unmaterialized')source.button.remove();
    if(condition==='missing-version')source.button.setAttribute('data-album-version-key','another-edition');
    if(condition==='collapsed-section'){h.click(record.toggle);await drain();h.frame();}
    if(condition==='collapsed-discography'){h.click(h.section('discography').toggle);await drain();h.frame();}
    // Invoke the existing owned absolute-scroll implementation, including its
    // real queued stabilization frames, before asking the actual grid to focus.
    h.grid.restoreOwnedAbsoluteScrollPosition({scrollTop:347.25,scrollLeft:19});for(let i=0;i<3;i++)h.frame();
    const top=h.scroll.scrollTop,left=h.scroll.scrollLeft,generation=h.grid._renderGeneration,choices=[...lease.choices],collapsed=lease.collapsed,checkpoint=h.focusLog.length;
    const focused=lease.api.restoreFocus(receipt.token,{preserveViewport:true});for(let i=0;i<3;i++)h.frame();
    assert.equal(focused,true);assert.equal(h.scroll.scrollTop,top);assert.equal(h.scroll.scrollLeft,left);assert.equal(top,347.25);assert.equal(left,19);
    assert.equal(h.grid._renderGeneration,generation);assert.deepEqual([...lease.choices],choices);assert.equal(lease.collapsed,collapsed);
    const calls=h.focusLog.slice(checkpoint);assert.equal(calls.length,1);assert.equal(calls[0].options.preventScroll,true);
    assert.equal(calls[0].node===source.button,condition==='partial');
    if(condition!=='partial')assert.ok(calls[0].node===record.toggle||calls[0].node===h.section('discography').toggle);
  });
test('reentrant navigation from geometry read blocks focus and leaves restored viewport untouched',async t=>{
  const h=await mounted(t),source=opener(h),origin=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed),receipt=origin.captureReturn(),lease=h.grid._artistPageLease;
  h.grid.restoreOwnedAbsoluteScrollPosition({scrollTop:347.25,scrollLeft:19});for(let i=0;i<3;i++)h.frame();
  const get=source.button.getBoundingClientRect.bind(source.button);let once=true;
  source.button.getBoundingClientRect=()=>{const box=get();if(once){once=false;h.change('actor','8');}return box;};
  const checkpoint=h.focusLog.length;assert.equal(lease.api.restoreFocus(receipt.token,{preserveViewport:true}),false);h.frame();
  assert.equal(h.focusLog.length,checkpoint);assert.equal(h.scroll.scrollTop,347.25);assert.equal(h.scroll.scrollLeft,19);
});
test('new foreground form during actual parent hydration cancels delayed sheet return focus',async t=>{
  const h=await opened(t),start=h.requests.length,checkpoint=h.focusLog.length;h.holdHistory();h.context.closeTrackModal();h.settleHistory();await drain();
  assert.equal(h.requests.length,start+1);h.openForm();h.reply(start,artistView());await drain();for(let i=0;i<5;i++)h.frame();
  assert.equal(h.focusLog.slice(checkpoint).some(row=>row.node===h.opener.button),false);assert.equal(h.mobileState().pages.at(-1).kind,'form');
});

test('served CSS/markup and registration preserve one presenter with scoped player/layer and reduced-motion rules',()=>{
  const css=read('music_app/static/css/runtime/bottom-sheet.css'),player=read('music_app/static/css/runtime/shell-persistent-player.css');
  assert.match(css,/\.track-modal\.is-artist-discography-sheet\s*\{[^}]*z-index:\s*4550/);
  assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);assert.match(css,/touch-action:\s*none/);
  assert.match(player,/is-artist-discography-sheet/);assert.match(read('music_app/templates/partials/primary-modals.html'),/id='track-modal-sheet-toggle'/);
  const build=read('scripts/build-runtime-bundle.cjs');assert.equal((build.match(/['"]js\/runtime\/bottom-sheet\.js['"]/g)||[]).length,1);
  assert.ok(build.indexOf("'js/runtime/bottom-sheet.js'")<build.indexOf("'js/runtime/mobile-navigation.js'"));
});

test('same-key distinct editions retain exact section/version identity rather than resolving the first matching key',async t=>{
  const first=fullAlbum(1,{edition:'Original',path:'/library/original'}),second=fullAlbum(1,{edition:'Deluxe',path:'/library/deluxe'});
  const h=await mounted(t,{view:artistView({artist_groups:[group(ARTIST,[first,second])],primary_artist_groups:[group(ARTIST,[first,second])]})});
  const buttons=[...h.nodes.container.querySelectorAll('[data-open-tracklist="1"]')].filter(node=>!node.classList.contains('cover'));
  const keyA=h.context.getAlbumCardVersionKey(first),keyB=h.context.getAlbumCardVersionKey(second);assert.notEqual(keyA,keyB);
  const a=buttons.find(node=>node.getAttribute('data-album-version-key')===keyA),b=buttons.find(node=>node.getAttribute('data-album-version-key')===keyB);assert.ok(a&&b);
  const lease=h.runtime().captureAlbumSheetOrigin(a,first);assert.ok(lease);assert.equal(h.runtime().captureAlbumSheetOrigin(a,second),null);
  const firstReceipt=plain(lease.captureReturn());
  h.context.openTrackModal(first,{artistSheetOrigin:lease});await drain();h.frame();const root=plain(sheet(h));
  h.context.openTrackModal(second,{releaseSet:{releases:[first,second],selectedIndex:1}});await drain();h.frame();
  assertSheet(h);const next=h.context.getTrackModalArtistSheetOrigin();assert.notEqual(next,lease);
  assert.deepEqual(plain(next.captureReturn().token),firstReceipt.token,'edition changes preserve the exact original opener focus receipt');
  assert.equal(next.captureReturn().token.versionKey,keyA);assert.equal(next.captureReturn().token.sectionKey,firstReceipt.token.sectionKey);
  assert.equal(next.isRetainedCurrent(sheet(h)),true,'successor membership remains admitted for the selected edition');
  assert.equal(sheet(h).parentPosition,root.parentPosition);assert.equal(sheet(h).parentViewUrl,root.parentViewUrl);
  assert.equal(h.context.getAlbumCardVersionKey(h.context.getCurrentTrackModalAlbum()),keyB);operateToggle(h);
  assert.equal(lease.isRetainedCurrent(sheet(h)),false);
});
test('late A hydration cannot inherit successor B live lease or replace B album content',async t=>{
  const a=fullAlbum(1,{preview_only:true,tracks:[],track_count:1}),b=fullAlbum(2);
  const h=await mounted(t,{view:artistView({artist_groups:[group(ARTIST,[a,b])],primary_artist_groups:[group(ARTIST,[a,b])]})});
  const buttons=[...h.nodes.container.querySelectorAll('[data-open-tracklist="1"]')].filter(node=>!node.classList.contains('cover'));
  const aButton=buttons.find(node=>node.getAttribute('data-album-key')===a.key),bButton=buttons.find(node=>node.getAttribute('data-album-key')===b.key);assert.ok(aButton&&bButton);
  const bOrigin=h.runtime().captureAlbumSheetOrigin(bButton,b);assert.ok(bOrigin);
  const start=h.requests.length;h.context.openTrackModalForButton(aButton);await drain();
  const details=h.requests.slice(start).find(row=>/album-details/.test(row.url));assert.ok(details);
  h.context.openTrackModal(b,{artistSheetOrigin:bOrigin});await drain();h.frame();const before=identity(h),generation=h.owner('artistSheetGeneration');
  details.resolve({ok:true,album:fullAlbum(1)});await drain();h.frame();
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),bOrigin);assert.equal(h.context.getCurrentTrackModalAlbum().key,b.key);
  assert.equal(h.owner('artistSheetGeneration'),generation);assertSame(h,before);assertSheet(h);
});
for(const mode of ['false','throw'])test(`failed ${mode} browser history write releases presentation hold and grants no retained authority`,async t=>{
  const h=await mounted(t),source=opener(h),lease=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed);
  const parent={session:h.runtime().snapshot().sessionId,lease:h.grid._artistPageLease,history:JSON.stringify(h.history.state),href:h.location.href,
    calls:h.historyCalls.length,requests:h.requests.length,focus:h.focusAttempts.length,container:h.overlay.parentNode,next:h.overlay.nextSibling};
  assert.equal(h.mobileState().pages.length,0);assert.equal(h.mobileState().originals.size,0);assert.equal(h.overlay.hidden,true);
  const push=h.history.pushState,navigation=h.context.AlbumHavenSettingsNavigation.instance,publish=navigation.pushLibraryHistory;
  // Native pushState succeeds with a void return. Exercise explicit refusal
  // at the publication API that mobile navigation actually checks.
  if(mode==='false')navigation.pushLibraryHistory=()=>false;
  else h.history.pushState=()=>{throw new Error('test browser write rejection');};
  try {if(mode==='throw')assert.throws(()=>h.context.openTrackModal(source.indexed,{artistSheetOrigin:lease}),/test browser write rejection/);
    else h.context.openTrackModal(source.indexed,{artistSheetOrigin:lease});}
  finally {h.history.pushState=push;navigation.pushLibraryHistory=publish;}
  assert.equal(h.mobileState().presentationTransition,null,'actual R4 try/finally releases its temporary hold');
  assert.equal(lease.isRetainedCurrent(sheet(h)),false,'uncommitted child is not admitted by its marker');
  await drain();for(let i=0;i<5;i++){h.frame();await drain();}
  assert.equal(h.mobileState().pages.length,0,'the exact unpublished first root is rolled back');assert.equal(h.mobileState().originals.size,0);
  assert.equal(h.overlay.hidden,true);assert.ok(h.overlay.parentNode===parent.container);assert.ok(h.overlay.nextSibling===parent.next);
  assert.equal(h.overlay.classList.contains('is-mobile-page'),false);assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.mobileState().presentationTransition,null);
  const settled=h.runtime().snapshot();assert.equal(settled.sessionId,parent.session);assert.equal(settled.mounted,true);assert.equal(settled.actionable,true);
  assert.ok(h.grid._artistPageLease===parent.lease);assert.equal(parent.lease.active,true);assert.equal(parent.lease.suspended,false);
  assert.equal(JSON.stringify(h.history.state),parent.history);assert.equal(h.location.href,parent.href);assert.equal(h.historyCalls.length,parent.calls);
  assert.equal(h.requests.length,parent.requests,'rollback does not hydrate an already admitted parent');
  assert.equal(h.focusAttempts.length,parent.focus,'failed publication never schedules return focus');
});
for(const mode of ['false','throw'])test(`failed ${mode} first root push cannot roll back across an actual foreign history publication`,async t=>{
  const h=await mounted(t),source=opener(h),origin=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed);
  const push=h.history.pushState,navigation=h.context.AlbumHavenSettingsNavigation.instance,publish=navigation.pushLibraryHistory;
  const requests=h.requests.length,focus=h.focusAttempts.length;let foreign;
  const rejectPublication=function(){
    h.history.pushState=push;navigation.pushLibraryHistory=publish;
    const draft=sheet(h),original=h.mobileState().originals.get('album');assert.ok(draft&&original);
    // A real browser write changes history without borrowing any product
    // descriptor, lease or navigation owner for the foreign destination.
    push.call(h.history,{albumHavenNavigationPosition:900,mobilePages:[],foreignPublication:'retained'},'',
      new URL('/?surface=albums&artist=Foreign',h.location).href);
    foreign={history:JSON.stringify(h.history.state),href:h.location.href,calls:h.historyCalls.length,draft,original};
    if(mode==='throw')throw new Error('old root failed after foreign history publication');return false;
  };
  if(mode==='false')navigation.pushLibraryHistory=rejectPublication;else h.history.pushState=rejectPublication;
  try {if(mode==='throw')assert.throws(()=>h.context.openTrackModal(source.indexed,{artistSheetOrigin:origin}),/old root failed after foreign history publication/);
    else assert.equal(h.context.openTrackModal(source.indexed,{artistSheetOrigin:origin}),false);}
  finally {h.history.pushState=push;navigation.pushLibraryHistory=publish;}
  assert.ok(foreign);await drain();for(let i=0;i<5;i++){h.frame();await drain();}
  assert.equal(JSON.stringify(h.history.state),foreign.history);assert.equal(h.location.href,foreign.href);assert.equal(h.historyCalls.length,foreign.calls);
  assert.equal(h.mobileState().pages.length,1);assert.ok(sheet(h)===foreign.draft,'obsolete rollback does not pop a draft after losing exact history ownership');
  assert.equal(h.mobileState().originals.size,1);assert.ok(h.mobileState().originals.get('album')===foreign.original);
  assert.equal(foreign.original.placeholder.isConnected,true,'obsolete rollback does not consume another history transaction\'s original surface');
  assert.equal(h.mobileState().presentationTransition,null);assert.equal(origin.isRetainedCurrent(foreign.draft),false);
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.requests.length,requests);assert.equal(h.focusAttempts.length,focus);
});
test('reentrant successor navigation during history publication cannot leave an obsolete Artist hold',async t=>{
  const h=await mounted(t),source=opener(h),old=h.runtime(),push=h.history.pushState;let once=true;
  h.history.pushState=(...args)=>{const result=push.apply(h.history,args);if(once){once=false;h.change('actor','8');}return result;};
  try {h.context.openTrackModalForButton(source.button);}finally{h.history.pushState=push;}
  await drain();h.frame();assert.equal(h.mobileState().presentationTransition,null);assert.equal(old.snapshot().status,'inactive');
  assert.equal(h.context.getTrackModalArtistSheetOrigin()?.isRetainedCurrent(sheet(h))===true,false);
  assert.equal(h.overlay.classList.contains('is-artist-discography-sheet'),false);
});
for(const mode of ['false','throw'])test(`failed ${mode} old history write cannot invalidate a reentrant successor sheet`,async t=>{
  const first=fullAlbum(1),second=fullAlbum(2),h=await mounted(t,{view:artistView({artist_groups:[group(ARTIST,[first,second])],primary_artist_groups:[group(ARTIST,[first,second])]})});
  const source=opener(h),secondButton=[...h.nodes.container.querySelectorAll('[data-open-tracklist="1"]')].find(node=>
    !node.classList.contains('cover')&&node.getAttribute('data-album-key')===second.key);assert.ok(secondButton);
  const old=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed),next=h.runtime().captureAlbumSheetOrigin(secondButton,second);
  assert.ok(old&&next);const push=h.history.pushState,requests=h.requests.length;let successor;
  h.history.pushState=function(){
    h.history.pushState=push;
    h.context.openTrackModal(second,{artistSheetOrigin:next});
    successor={generation:h.owner('artistSheetGeneration'),history:JSON.stringify(h.history.state),href:h.location.href,
      page:sheet(h),album:h.context.getCurrentTrackModalAlbum(),calls:h.historyCalls.length};
    if(mode==='throw')throw new Error('old browser write rejected after successor');return false;
  };
  try {if(mode==='throw')assert.throws(()=>h.context.openTrackModal(source.indexed,{artistSheetOrigin:old}),/old browser write rejected after successor/);
    else assert.equal(h.context.openTrackModal(source.indexed,{artistSheetOrigin:old}),false);}
  finally {h.history.pushState=push;}
  assert.ok(successor);await drain();h.frame();
  assert.equal(h.owner('artistSheetGeneration'),successor.generation);assert.equal(JSON.stringify(h.history.state),successor.history);assert.equal(h.location.href,successor.href);
  assert.ok(sheet(h)===successor.page);assert.ok(h.context.getCurrentTrackModalAlbum()===successor.album);assert.equal(successor.album.key,second.key);
  assert.ok(h.context.getTrackModalArtistSheetOrigin()===next);assert.equal(next.isRetainedCurrent(sheet(h)),true);assert.equal(old.isRetainedCurrent(sheet(h)),false);
  assert.equal(h.mobileState().presentationTransition,null);assert.equal(h.historyCalls.length,successor.calls);assert.equal(h.requests.length,requests);assertSheet(h);
});
test('direct untraversable close uses replace and real parent hydration before restoring viewport',async t=>{
  const h=await opened(t),saved=plain(h.history.state),start=h.requests.length,calls=h.historyCalls.length;delete saved.albumHavenNavigationPosition;
  h.history.replaceState(saved,'',h.location.href);h.context.closeTrackModal();await drain();
  assert.equal(h.pendingHistory().length,0);assert.equal(h.overlay.hidden,true);
  assert.ok(h.historyCalls.slice(calls).some(row=>row.mode==='replace'&&row.value.mobilePages.length===0));
  assert.equal(h.requests.length,start+1);h.reply(start,artistView());await drain();for(let i=0;i<5;i++)h.frame();
  assert.equal(h.mobileState().pages.length,0);assert.equal(h.player.inert,false);
});
test('retained Forward replay preserves original cover trigger receipt without serializing it',async t=>{
  const h=await mounted(t),source=opener(h,'cover');h.opener=source;h.context.openTrackModalForButton(source.button);await drain();h.frame();
  const token=plain(h.context.getTrackModalArtistSheetOrigin().captureReturn().token),saved=plain(h.history.state),href=h.location.href;
  await returned(h);const start=h.requests.length,parentLease=h.grid._artistPageLease,parentSession=h.runtime().snapshot().sessionId,calls=h.historyCalls.length;
  assert.equal(parentSession,token.sessionId);assert.ok(parentLease?.active);h.history.forward();await drain();
  assert.equal(h.requests.length,start,'retained current parent replay must not fetch');
  h.frame();assertSheet(h);const replay=h.context.getTrackModalArtistSheetOrigin().captureReturn().token;
  assert.equal(replay.trigger,'cover');assert.equal(replay.versionKey,token.versionKey);assert.equal(replay.sectionKey,token.sectionKey);
  assert.equal(h.runtime().snapshot().sessionId,parentSession);assert.ok(h.grid._artistPageLease===parentLease);
  assert.equal(h.historyCalls.length,calls);assert.equal(h.location.href,href);assert.deepEqual(plain(h.history.state),saved);
  assert.deepEqual(Object.keys(saved.mobilePages[0]).sort(),fields);
});
for(const drift of ['href','hash','history-chain','history-position','runtime-owner','session','actor','library','context'])
  test(`Forward ${drift} drift requires fresh parent admission instead of old receipt authority`,async t=>{
    const h=await mounted(t),source=opener(h,'cover');h.opener=source;
    h.context.openTrackModalForButton(source.button);await drain();h.frame();
    const oldRuntime=h.runtime(),oldOrigin=h.context.getTrackModalArtistSheetOrigin(),oldReceipt=oldOrigin.captureReturn();
    const child=h.entries.at(-1),boundHref=child.url,boundHistory=JSON.stringify(child.state.mobilePages);
    assert.equal(oldReceipt.token.trigger,'cover');assert.ok(h.owner('mobileArtistSheetFocus').size>0,'actual committed opening remembers bounded focus metadata');await returned(h);
    assert.equal(h.runtime().snapshot().sessionId,oldReceipt.sessionId);assert.equal(h.runtime().snapshot().actionable,true);
    // The saved entry is the fixture's browser-history boundary. It originated
    // from the actual opening and serializer; no product receipt/map is forged.
    if(drift==='href'){const url=new URL(child.url);url.searchParams.set('forward_binding','changed');child.url=url.href;}
    else if(drift==='hash'){const url=new URL(child.url);url.hash='changed-forward-binding';child.url=url.href;}
    else if(drift==='history-chain')child.state.mobilePages.push({kind:'cover-lookup',albumKey:oldReceipt.token.albumKey,
      title:'Cover Art Look Up',subtitle:'',coverSrc:'',parentPosition:child.state.albumHavenNavigationPosition,
      parentScrollPosition:null,parentViewUrl:child.state.mobilePages[0].parentViewUrl});
    else if(drift==='history-position')child.state.albumHavenNavigationPosition+=100;
    else if(drift==='runtime-owner'){
      const realm=vm.createContext({...h.context,window:h.context,state:h.state,virtualGrid:h.grid,mobilePageState:h.mobileState()});
      vm.runInContext(read('music_app/static/js/runtime/artist-page-bridge.js'),realm,{filename:'music_app/static/js/runtime/artist-page-bridge.js'});
      assert.notEqual(h.runtime(),oldRuntime);
    }else if(drift==='session'){
      const actor=h.shell.dataset.nativeAccountId;h.change('actor',actor==='8'?'9':'8');
      // Attribute observers retire the actual owner at the browser microtask
      // boundary. Let that boundary occur before restoring the original actor.
      await drain();assert.equal(oldRuntime.snapshot().status,'inactive');
      assert.equal(h.owner('mobileArtistSheetFocus').size,0,'retired session clears its remembered history bindings before a new admission');
      h.change('actor',actor);await drain();
      await h.admit(parentPayload(),{push:false});assert.notEqual(h.runtime().snapshot().sessionId,oldReceipt.sessionId);
    }else h.change(drift);
    // Actor/library identity changes are observed asynchronously; context
    // changes may additionally notify through the synchronous transport owner.
    await drain();
    if(['runtime-owner','session','actor','library','context'].includes(drift))
      assert.equal(h.owner('mobileArtistSheetFocus').size,0,'retired runtime/session/scope retains no remembered history bindings');
    if(drift==='href'||drift==='hash')assert.notEqual(child.url,boundHref);
    if(drift==='history-chain')assert.notEqual(JSON.stringify(child.state.mobilePages),boundHistory);
    const index=h.requests.length;h.history.forward();await drain();
    assert.equal(h.requests.length,index+1,'a mismatched saved entry or owner must request its real parent');
    const pending=h.mobileState().sheetRestore,invocation=h.invocations.at(-1);assert.ok(pending);assert.equal(pending.admission.hasParent(),false);
    assert.equal(h.requests[index].settled,false);assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.overlay.hidden,true);
    assert.equal(h.mobileState().pages.length,0);assert.equal(oldOrigin.isRetainedCurrent(child.state.mobilePages[0]),false);
    assert.equal(h.runtime().snapshot().actionable,false,'saved history has no admitted parent actionability');
    h.reply(index,parentPayload());const result=await invocation.outcome;assert.equal(result.error,undefined);assert.equal(result.value,true);
    assert.equal(await pending.promise,true);await drain();h.frame();
    const admitted=h.context.getTrackModalArtistSheetOrigin();assert.ok(admitted);assert.equal(admitted.isRetainedCurrent(sheet(h)),true);
    assert.equal(admitted.captureReturn().token.trigger,'tracklist','fresh response admission cannot inherit the rejected cover focus receipt');
    assert.equal(h.mobileState().sheetRestore,null);assert.equal(h.runtime().snapshot().retained,true);
  });
for(const operation of ['pending','replaced'])test(`Forward while a ${operation} foreground read owns the parent requires its own fresh admission`,async t=>{
  const h=await mounted(t),source=opener(h,'cover');h.opener=source;
  h.context.openTrackModalForButton(source.button);await drain();h.frame();
  const receipt=h.context.getTrackModalArtistSheetOrigin().captureReturn();assert.equal(receipt.token.trigger,'cover');
  await returned(h);const obsolete=[];
  for(let i=0;i<(operation==='replaced'?2:1);i++){
    const work=h.read(receipt.parentViewUrl,{restartIfSameUrl:true,preserveScroll:true},false);
    const controller=h.state.ui.activeViewRequestController,request=h.requests.find(row=>row.options.signal===controller.signal);
    assert.ok(controller&&request);assert.equal(request.settled,false);
    if(obsolete.length)assert.notEqual(controller,obsolete.at(-1).controller);
    obsolete.push({work,controller,request});
  }
  const foreground=h.state.ui.activeViewRequestController;assert.equal(h.state.busy,true);
  h.history.forward();await drain();
  const pending=h.mobileState().sheetRestore,controller=h.state.ui.activeViewRequestController,invocation=h.invocations.at(-1);
  assert.ok(pending&&controller);assert.notEqual(controller,foreground);assert.equal(pending.admission.hasParent(),false);
  const request=h.requests.find(row=>row.options.signal===controller.signal);assert.ok(request);assert.equal(request.settled,false);
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(h.mobileState().pages.length,0);assert.equal(h.overlay.hidden,true);
  assert.equal(h.owner('mobileArtistSheetFocus').size,0,'interrupted parent admission cannot retain the old history binding');
  // Settle each real obsolete transport rather than assuming a global fetch
  // count or allowing a previously in-flight response to become this replay.
  for(const old of obsolete){assert.equal(old.controller.signal.aborted,true);old.request.resolve(parentPayload());
    const result=await old.work;assert.equal(result.error,undefined);assert.equal(result.value,false);}
  await drain();assert.ok(h.state.ui.activeViewRequestController===controller);assert.ok(h.mobileState().sheetRestore===pending);
  assert.equal(h.context.getTrackModalArtistSheetOrigin(),null);assert.equal(pending.admission.hasParent(),false);
  request.resolve(parentPayload());const result=await invocation.outcome;assert.equal(result.error,undefined);assert.equal(result.value,true);
  assert.equal(await pending.promise,true);await drain();h.frame();assertSheet(h);
  assert.equal(h.context.getTrackModalArtistSheetOrigin().captureReturn().token.trigger,'tracklist');
  assert.equal(h.mobileState().sheetRestore,null);
});
test('actual client classifier preserves sheet-width tag-editor restrictions without profile stubs',async t=>{
  const h=await opened(t),editor=h.document.getElementById('tag-editor-modal');
  assert.equal(h.context.AlbumHavenClientLayout.classifyProfile({viewportWidth:390,userAgent:'desktop',platform:'Linux'}),'mobile');
  for(const width of [320,390,900]){h.context.innerWidth=width;assert.equal(h.context.isMobileClient(),true);
    assert.equal(h.context.openTagEditor(h.context.getCurrentTrackModalAlbum(),{tracksMode:'all'}),false);
    assert.equal(editor.hidden,true);assert.equal(h.overlay.inert,false);assert.equal(editor.style.zIndex,'');}
  h.context.innerWidth=1200;h.context.navigator.userAgent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
  assert.equal(h.context.isMobileClient(),true);assert.equal(h.context.openTagEditor(h.context.getCurrentTrackModalAlbum(),{tracksMode:'all'}),false);
  assert.equal(editor.hidden,true);
});
test('actual lightbox retains independent history and horizontal gesture while sheet remains suspended underneath',async t=>{
  const h=await opened(t),before=identity(h),origin=h.context.getTrackModalArtistSheetOrigin(),calls=h.historyCalls.length;
  h.context.openImageLightbox('/cover?album_key=artist-album-1','Cover',{sourceAlbumKey:'artist-album-1'});await drain();h.frame();
  const lightbox=h.document.getElementById('image-lightbox');assert.equal(lightbox.hidden,false);assert.equal(h.context.getTopmostOpenModal(),lightbox);
  assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,1);assert.equal(h.history.state.imageLightbox,true);
  const position=h.history.state.albumHavenNavigationPosition;h.touch(lightbox,'touchstart',[[200,300]]);
  const move=h.touch(lightbox,'touchmove',[[100,305]]);assert.equal(move.defaultPrevented,false,'existing lightbox swipe keeps native passive movement');
  h.touch(lightbox,'touchcancel',[]);h.touch(lightbox,'touchend',[],{changedTouches:[{clientX:100,clientY:305}]});
  assert.equal(h.history.state.albumHavenNavigationPosition,position);assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);assertSame(h,before);
  const escape=h.send(h.document,'keydown',{key:'Escape'});assert.equal(escape.defaultPrevented,true);await drain();h.frame();
  assert.equal(lightbox.hidden,true);assert.equal(h.overlay.hidden,false);assertSheet(h);assertSame(h,before);
});
test('tag-editor and its confirm source retain real mobile guard and parent-relative lease calls',()=>{
  // Positive tag UI cannot coexist with <=900 sheet under the actual classifier.
  // This is explicitly source inspection, not simulated reachable UI acceptance.
  const source=read('music_app/static/js/runtime/tag-editor-and-optimistic-updates.js');
  assert.match(source,/function openTagEditor\([^]*?isMobileClient\(\)\) return false;/);
  for(const name of ['tagEditorSheetLayer','tagConfirmSheetLayer'])assert.match(source,new RegExp(name+' = window\\.AlbumHavenBottomSheet\\?\\.acquireChildLayer'));
});

test('actual sheet drag frames never render the retained grid/album or invoke a new request or history entry',async t=>{
  const h=await opened(t),before=identity(h),generation=h.grid._renderGeneration,requests=h.requests.length,calls=h.historyCalls.length;
  const mutations=h.mutations.length;h.pointer(h.handle,'pointerdown',100,200);
  for(let y=210;y<=250;y+=2){h.advance(20);h.pointer(h.context,'pointermove',100,y);h.frame();}
  h.pointer(h.context,'pointercancel',100,250);h.frame();
  assertSame(h,before);assert.equal(h.grid._renderGeneration,generation);assert.equal(h.requests.length,requests);assert.equal(h.historyCalls.length,calls);
  assert.equal(h.mutations.slice(mutations).some(row=>h.nodes.container.contains(row.parent)||before.albumList.contains(row.parent)),false);
});
test('repeat same live album presentation refreshes metadata without adding history or replacing owners',async t=>{
  const h=await opened(t),before=identity(h),calls=h.historyCalls.length,origin=h.context.getTrackModalArtistSheetOrigin();
  for(let i=0;i<4;i++)assert.equal(h.context.presentMobileAlbumPage(h.context.getCurrentTrackModalAlbum()),true);
  await drain();h.frame();assertSheet(h);assertSame(h,before);assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);
  assert.equal(h.historyCalls.slice(calls).filter(row=>row.mode==='push').length,0);
});

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
function assertEligibleFocus(h,start,node){const rows=h.focusAttempts.slice(start).filter(row=>row.node===node);assert.ok(rows.length,'actual child close attempted saved opener focus');for(const row of rows){assert.equal(row.connected,true);assert.equal(row.blocked,null);assert.equal(row.displayBlocked,false);assert.equal(row.accepted,true);assert.equal(row.foregroundEligible,true);}assert.equal(h.document.activeElement,node);}
for(const child of ['lightbox','confirmation'])test(`actual ${child} close resumes sheet synchronously before saved-opener focus`,async t=>{
  const h=await opened(t),button=liveToggle(h);button.focus();let confirmation;
  if(child==='lightbox')h.context.openImageLightbox('/cover?album_key=artist-album-1','Cover',{sourceAlbumKey:'artist-album-1'});else confirmation=h.context.showAppConfirmDialog({title:'Question',message:'Confirm'});
  await drain();h.frame();assert.equal(h.overlay.getAttribute('data-sheet-state'),'suspended');assert.equal(h.panel.inert,true);
  if(child==='lightbox'){assert.equal(h.context.getTopmostOpenModal(),h.document.getElementById('image-lightbox'));assert.equal(h.overlay.inert,false);}else assert.equal(h.overlay.inert,true);
  const checkpoint=h.focusAttempts.length;
  if(child==='lightbox'){h.context.closeImageLightbox();h.context.handleImageLightboxPopState();}else h.send(h.document.getElementById('app-confirm-cancel'),'click',{detail:0});
  // Deliberately before drain()/RAF: observer-based recovery is too late.
  assertEligibleFocus(h,checkpoint,button);assert.equal(h.panel.inert,false);assert.equal(h.overlay.inert,false);if(confirmation)assert.equal(await confirmation,false);
});
test('remaining picker retains foreground while confirmation returns focus without unlocking sheet',async t=>{
  const h=await opened(t);h.context.openVersionPickerModal(h.context.getCurrentTrackModalAlbum());await drain();h.frame();const picker=h.document.getElementById('version-picker-modal'),button=picker.querySelector('button');button.focus();
  const confirmation=h.context.showAppConfirmDialog({title:'Nested',message:'Question'});await drain();h.frame();const checkpoint=h.focusAttempts.length;h.send(h.document.getElementById('app-confirm-cancel'),'click',{detail:0});assertEligibleFocus(h,checkpoint,button);assert.equal(h.overlay.inert,true);assert.equal(await confirmation,false);
});
test('native focus boundary refuses hidden and inert nodes without changing focused element',async t=>{
  const h=await opened(t),button=liveToggle(h);button.focus();const before=h.document.activeElement;h.playerButton.focus();const row=h.focusAttempts.at(-1);assert.equal(row.accepted,false);assert.ok(row.blocked);assert.equal(h.document.activeElement,before);
  const hidden=h.document.createElement('button');hidden.hidden=true;h.document.body.append(hidden);hidden.focus();assert.equal(h.focusAttempts.at(-1).accepted,false);assert.equal(h.document.activeElement,before);
});

test('newer lightbox prevents closing older confirmation from stealing sheet focus',async t=>{
  const h=await opened(t),button=liveToggle(h);button.focus();const confirmation=h.context.showAppConfirmDialog({title:'Older',message:'Question'});await drain();h.frame();
  h.context.openImageLightbox('/cover?album_key=artist-album-1','Newer',{sourceAlbumKey:'artist-album-1'});await drain();h.frame();const active=h.document.activeElement,checkpoint=h.focusAttempts.length;
  h.send(h.document.getElementById('app-confirm-cancel'),'click',{detail:0});assert.equal(await confirmation,false);
  assert.equal(h.focusAttempts.slice(checkpoint).some(row=>row.node===button&&row.accepted),false);assert.equal(h.document.activeElement,active);assert.equal(h.overlay.inert,false);assert.equal(h.panel.inert,true);assert.equal(h.overlay.getAttribute('data-sheet-state'),'suspended');assert.equal(h.context.getTopmostOpenModal(),h.document.getElementById('image-lightbox'));
});
test('actual full-page form return restores saved sheet focus only after child navigation settlement',async t=>{
  const h=await opened(t),button=liveToggle(h);button.focus();const form=h.openForm();await drain();h.frame();assert.equal(h.overlay.hidden,true);
  const checkpoint=h.focusAttempts.length;h.holdHistory();const closed=form.dismiss('back');await drain();assert.equal(h.focusAttempts.slice(checkpoint).some(row=>row.node===button),false);
  h.settleHistory();assert.equal(await closed,true);assertEligibleFocus(h,checkpoint,button);assert.equal(h.overlay.hidden,false);assert.equal(h.overlay.inert,false);
});
test('reentrant form opened during old form close retains foreground without stale saved-sheet focus',async t=>{
  const h=await opened(t),button=liveToggle(h);button.focus();let newer,newerToken;const closeCalls=[];
  const form=h.openForm({onClose:(...args)=>{closeCalls.push(args);newer=h.openForm({title:'Successor',pageId:'successor'});newerToken=h.owner('activeAppFormDialog').token;}});await drain();h.frame();const checkpoint=h.focusAttempts.length;
  h.holdHistory();const closed=form.dismiss('back');await drain();h.settleHistory();await closed;await drain();assert.ok(newer);assert.equal(closeCalls.length,1);assert.equal(closeCalls[0].length,2);assert.equal(h.mobileState().pages.at(-1).formToken,newerToken);assert.equal(h.owner('activeAppFormDialog').token,newerToken);
  assert.equal(h.mobileState().pages.at(-1).kind,'form');assert.equal(h.mobileState().pages.at(-1).title,'Successor');assert.equal(h.focusAttempts.slice(checkpoint).some(row=>row.node===button&&row.accepted),false);
});
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
for(const condition of ['missing-edition','response-rematerialized-edition','collapsed-subsection'])test(`navigation-owned hydrated return ${condition} restores captured axes and exact eligible focus`,async t=>{
  const h=await mounted(t),source=opener(h);h.opener=source;
  const oldLease=h.grid._artistPageLease,origin=h.runtime().captureAlbumSheetOrigin(source.button,source.indexed),token=origin.captureReturn().token;
  let before=currentReturnRecord(h,token);const oldRecord=before.record;
  if(condition==='collapsed-subsection'){
    // Capture from a genuine live opener first. The real release disclosure can
    // collapse while this parent is actionable; the still-current memory-only
    // origin remains valid by admitted membership, not by DOM visibility.
    h.click(before.record.toggle);await drain();h.frame();before=currentReturnRecord(h,token);
    assert.equal(before.lease.choices.get(token.sectionKey),true);assert.equal(before.record.toggle.getAttribute('aria-expanded'),'false');
    assert.equal(origin.isParentCurrent(),true);
  }
  // Establish non-row-aligned/nonzero input before opening and before return.
  // The descriptor must capture this input before the child is presented.
  h.scrollTo(347.25);h.scroll.scrollLeft=19;
  assert.equal(h.scroll.scrollTop,347.25);assert.equal(h.scroll.scrollLeft,19);
  const openRequests=h.requests.length;
  if(condition==='collapsed-subsection')h.context.openTrackModal(source.indexed,{artistSheetOrigin:origin});
  else assert.equal(h.context.openTrackModalForButton(source.button),true);
  await drain();h.frame();
  if(condition==='collapsed-subsection'){
    assertSheet(h);assert.equal(h.overlay.hidden,false);assert.equal(h.requests.length,openRequests,'fully hydrated captured-origin open makes no new request');
    assert.equal(h.context.getTrackModalArtistSheetOrigin(),origin);
    assert.equal(h.context.getCurrentTrackModalAlbum().key,token.albumKey);assert.equal(h.context.getAlbumCardVersionKey(h.context.getCurrentTrackModalAlbum()),token.versionKey);
    assert.equal(origin.isRetainedCurrent(sheet(h)),true);assert.equal(sheet(h).albumKey,token.albumKey);
  }
  const descriptor=plain(sheet(h));assert.deepEqual(descriptor.parentScrollPosition,{scrollTop:347.25,scrollLeft:19});
  const replacement=condition==='missing-edition'?fullAlbum(1,{edition:'Replacement edition',path:'/library/replacement'})
    :condition==='response-rematerialized-edition'?fullAlbum(1,{total_duration_display:'03:00',tracks:[...fullAlbum(1).tracks,{path:'/library/1/02.flac',name:'Track two',title:'Track two',track_number:2,duration:90}]})
    :fullAlbum(1);
  if(condition==='response-rematerialized-edition'){
    assert.equal(h.context.getAlbumCardVersionKey(replacement),token.versionKey);
    assert.notEqual(h.context.getAlbumCardRenderKey(replacement),h.context.getAlbumCardRenderKey(source.indexed),'actual response changes card contents without changing edition');
    assert.equal(source.button.isConnected,true);
  }
  // Model changed browser scroll before return begins, so a missing navigation
  // restoration cannot pass merely because the initial axes never moved.
  h.scrollTo(833.5);h.scroll.scrollLeft=41;assert.notEqual(h.scroll.scrollTop,descriptor.parentScrollPosition.scrollTop);assert.notEqual(h.scroll.scrollLeft,descriptor.parentScrollPosition.scrollLeft);
  // No test scroll writes or restoration calls occur after close begins.
  const index=h.requests.length;h.holdHistory();h.context.closeTrackModal();h.settleHistory();await drain();assert.equal(h.requests.length,index+1);
  const invocation=h.invocations.at(-1);assert.equal(new URL(invocation.args[0],h.location).href,descriptor.parentViewUrl);
  h.reply(index,artistView({artist_groups:[group(ARTIST,[replacement])],primary_artist_groups:[group(ARTIST,[replacement])]}));
  const result=await invocation.outcome;assert.equal(result.error,undefined);assert.equal(result.value,true);await drain();
  // Query only the real post-response mounted owner before navigation's two
  // focus RAFs. Layout rectangles are platform input, not scroll repair.
  assert.equal(h.runtime().snapshot().actionable,true);assert.ok(h.mobileState().sheetReturn);
  const current=currentReturnRecord(h,token);assert.equal(current.lease,oldLease);assert.equal(current.record,oldRecord);
  const exact=exactReturnButton(current.record,token),fallback=current.record.toggle;
  if(condition==='missing-edition'){assert.equal(exact,undefined);assert.equal(current.section.group.albums.some(album=>h.context.getAlbumCardVersionKey(album)===token.versionKey),false);}
  if(condition==='response-rematerialized-edition'){
    assert.equal(source.button.isConnected,false,'real changed HTTP response unmounted the original opener');
    assert.ok(exact);assert.notEqual(exact,source.button);assert.equal(exact.isConnected,true);
    assert.equal(current.record.element.contains(exact),true);h.setRect(exact,{x:20,y:200,width:120,height:44});
  }
  if(condition==='collapsed-subsection'){assert.equal(current.lease.choices.get(token.sectionKey),true);assert.equal(current.record.toggle.getAttribute('aria-expanded'),'false');}
  h.setRect(fallback,{x:20,y:140,width:250,height:44});
  const checkpoint=h.focusAttempts.length,choices=[...current.lease.choices];
  for(let i=0;i<5;i++){h.frame();await drain();}
  assert.equal(h.scroll.scrollTop,descriptor.parentScrollPosition.scrollTop);assert.equal(h.scroll.scrollLeft,descriptor.parentScrollPosition.scrollLeft);assert.equal(h.mobileState().sheetReturn,null);
  const final=currentReturnRecord(h,token);assert.equal(final.lease,current.lease);assert.equal(final.record,current.record);assert.deepEqual([...final.lease.choices],choices);
  if(condition==='collapsed-subsection'){assert.equal(final.lease.choices.get(token.sectionKey),true);assert.equal(final.record.toggle.getAttribute('aria-expanded'),'false');}
  const expected=condition==='response-rematerialized-edition'?exact:fallback,calls=h.focusAttempts.slice(checkpoint).filter(row=>row.node.closest('#artist-page-root'));
  assert.equal(calls.length,1,'one actual owned return focus, no fallback-only pass for an eligible edition');
  const row=calls[0];assert.equal(row.node,expected);assert.equal(row.lease,final.lease);assert.equal(row.record,final.record);assert.equal(row.sectionKey,token.sectionKey);
  assert.equal(row.connected,true);assert.equal(row.disabled,false);assert.equal(row.blocked,null);assert.equal(row.displayBlocked,false);
  assert.equal(row.accepted,true);assert.equal(row.foregroundEligible,true);assert.equal(row.options?.preventScroll,true);assert.ok(row.clientRects>0);
  assert.equal(row.intersectsViewport,true);assert.ok(row.bounds.bottom>row.viewport.top&&row.bounds.top<row.viewport.bottom&&row.bounds.right>row.viewport.left&&row.bounds.left<row.viewport.right);
  if(condition==='response-rematerialized-edition'){assert.equal(row.albumKey,token.albumKey);assert.equal(row.versionKey,token.versionKey);assert.equal(row.trigger,token.trigger);}
  assert.equal(h.document.activeElement,expected);
});
for(const existing of [false,true])test(`responsive desktop disposal restores ${existing?'original':'absent'} canonical geometry declarations`,async t=>{
  const h=await mounted(t);if(existing){h.panel.style.setProperty('top','12.125px','important');h.panel.style.height='333.75px';h.panel.style.setProperty('transform','translate3d(0, 4.125px, 0)','important');}
  const properties=['top','height','transform'],before=properties.map(key=>[key,h.panel.style.getPropertyValue(key),h.panel.style.getPropertyPriority(key)]);
  const source=opener(h);h.context.openTrackModalForButton(source.button);await drain();h.viewport({height:799.1234567});h.frame();operateToggle(h);
  h.context.innerWidth=901;h.document.documentElement.clientWidth=901;h.context.syncMobilePageShell();await drain();h.frame();
  assert.deepEqual(properties.map(key=>[key,h.panel.style.getPropertyValue(key),h.panel.style.getPropertyPriority(key)]),before);
});

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
