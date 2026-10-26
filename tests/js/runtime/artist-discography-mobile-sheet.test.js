'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {fixture,mounted,opened,opener,fullAlbum,artistView,group,ARTIST,drain,read}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
const {plain,sheet,fields,identity,assertSame,assertSheet,returned}=require('./artist-sheet-contract-helpers.cjs');

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
