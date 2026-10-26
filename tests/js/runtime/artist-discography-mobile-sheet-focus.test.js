'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {fixture,mounted,opened,opener,fullAlbum,artistView,group,ARTIST,drain,read}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
const {plain,sheet,assertSheet,liveToggle,operateToggle,currentReturnRecord,exactReturnButton}=require('./artist-sheet-contract-helpers.cjs');

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
