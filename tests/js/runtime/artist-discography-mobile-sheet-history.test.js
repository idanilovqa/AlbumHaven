'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {fixture,mounted,opened,opener,fullAlbum,artistView,group,ARTIST,drain,read}=require('./artist-host-fixtures/artist-sheet-runtime.cjs');
const {plain,sheet,fields,identity,assertSame,assertSheet,returned,parentPayload,operateToggle}=require('./artist-sheet-contract-helpers.cjs');

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
