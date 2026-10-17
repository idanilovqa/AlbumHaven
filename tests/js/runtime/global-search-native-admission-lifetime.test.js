'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,admit,source,foreground,plain,deferred,ready,pending,firstWitness,child,track,ordinary,mainUrl,A,B}=require('./search-native-fixtures/actual-runtime.cjs');

// These are connected candidate contracts, not historical acceptance claims.
// Actual candidate production fetch/read/apply/runtime and native source owners
// are composed for later authorized execution; no substitute owner is supplied.
test('immediate foreground start receives exact caller options after old source and pixels retire',async t=>{
  const h=fixture(t);await h.mount();const before=await admit(h,ready({presentation:'tracks'})),lease=source(h,before);
  const oldContent=h.host.querySelector('[data-search-results-content]');const starts=[];
  const options={onStart(info,origin){starts.push({info,origin});assert.equal(origin,options);assert.equal(info.requestId,h.state.ui.activeViewRequestId);
    assert.equal(h.runtime().isCurrent(before),false);assert.equal(lease.snapshot(),null);
    assert.ok(!oldContent.isConnected||oldContent.hidden&&oldContent.inert,'old pixels fenced before callback');return true;}};
  const payload=ready({query:':obsessed'}),work=h.read(mainUrl(payload),options);
  assert.equal(starts.length,1);assert.equal(h.requests.length,2);assert.equal(h.requests[1].options.headers['X-AlbumHaven-Context'],A);
  h.reply(1,payload);assert.equal((await work).value,true);
});

test('actual app-form deferral does not start or retire until approved, then preserves original options identity',async t=>{
  const h=fixture(t);await h.mount();const snapshot=await admit(h);const decision=deferred(),starts=[];
  const form=h.c.openReactFormDialog({title:'Unsaved form',pageId:'search-fixture-form',beforeDismiss:()=>decision.promise});
  assert.ok(h.c.getActiveAppFormPage());const options={onStart(info,origin){starts.push({info,origin});return true;}};
  const payload=ready({query:':obsessed'}),work=h.read(mainUrl(payload),options,true);await h.flush();
  assert.equal(starts.length,0);assert.equal(h.requests.length,1);assert.equal(h.runtime().isCurrent(snapshot),true);
  decision.resolve(true);await h.flush();assert.equal(starts.length,1);assert.equal(starts[0].origin,options);
  assert.equal(h.requests.length,2);h.reply(1,payload);assert.equal((await work).value,true);await form.promise;
});

test('actual app-form refusal preserves current view, source and options callback without loading publication',async t=>{
  const h=fixture(t);await h.mount();const snapshot=await admit(h,ready({presentation:'tracks'})),lease=source(h,snapshot),view=h.state.view;
  const form=h.c.openReactFormDialog({title:'Keep form',pageId:'search-fixture-refuse',beforeDismiss:()=>false});let starts=0;
  const result=await h.read(mainUrl(ready({query:':obsessed'})),{onStart(){starts++;}},true);
  assert.equal(result.value,false);assert.equal(starts,0);assert.equal(h.requests.length,1);assert.equal(h.state.view,view);
  assert.equal(h.runtime().snapshot(),snapshot);assert.ok(lease.snapshot());form.close(null,{force:true});await form.promise;
});

test('queued and deduplicated dispatches cannot announce start; queued replay retains exact options',async t=>{
  const h=fixture(t),starts=[],one=ready(),two=ready({query:':obsessed'});
  const first=h.read(mainUrl(one));const options={interruptCurrent:false,onStart(info,origin){starts.push({info,origin});return true;}};
  assert.equal((await h.read(mainUrl(two),options)).value,false);assert.equal(starts.length,0);assert.equal(h.requests.length,1);
  let duplicateStarts=0;assert.equal((await h.read(mainUrl(one),{onStart(){duplicateStarts++;}})).value,false);assert.equal(duplicateStarts,0);
  h.reply(0,one);await first;await h.flush();assert.equal(starts.length,1);assert.equal(starts[0].origin,options);
  assert.equal(h.requests.length,2);h.reply(1,two);await h.invocations.at(-1).outcome;
});

test('actual retained-draft option cloning preserves the caller object at onStart',async t=>{
  const h=fixture(t),navigation=h.c.AlbumHavenSettingsNavigation.instance;
  const unregister=navigation.setPlaylistDraftOwner({token:'search-test-draft',scopeKey:'test-draft-scope',isCurrent:()=>true,confirmLeave:()=>false,discard(){}});
  assert.equal(typeof unregister,'function');t.after(unregister);let origin,options={onStart(_info,value){origin=value;return true;}};
  const work=navigation.retainPlaylistDraftNavigation('search-test-draft',()=>h.read(mainUrl(ready()),options,true));
  assert.equal(origin,options,'internal retainedPlaylistDraft clone cannot become callback origin');assert.equal(h.requests.length,1);
  h.reply(0,ready());await work;
});

test('onStart reentry claims a genuine successor; outer dispatch never fetches or clears its busy slot',async t=>{
  const h=fixture(t),next=ready({query:':obsessed'});let successor;
  const result=await h.read(mainUrl(ready()),{onStart(){successor=h.read(mainUrl(next));return true;}});
  assert.equal(result.value,false);assert.equal(h.requests.length,1);assert.equal(new URL(h.requests[0].url,h.location).searchParams.get('q'),':obsessed');
  assert.equal(h.state.busy,true);h.reply(0,next);assert.equal((await successor).value,true);
});

test('false start callback produces no HTTP, admitted owner or loading publication',async t=>{
  const h=fixture(t);let origin;const options={onStart(_info,value){origin=value;return false;}};
  const result=await h.read(mainUrl(),options);assert.equal(origin,options);assert.equal(result.value,false);assert.equal(h.requests.length,0);
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.state.busy,false);
});

for(const seam of ['fetch','json','apply-permission'])test(`context transition at ${seam} prevents own-love admission`,async t=>{
  const h=fixture(t);await h.mount();const payload=ready();let switched=false;
  const options=seam==='apply-permission'?{shouldApplyResponse(){if(!switched){switched=true;h.change('library');}return true;}}:{};
  const work=h.read(mainUrl(payload),options);
  if(seam==='json'){const body=h.requests[0].holdJson();await h.requests[0].jsonStarted;h.change('library');body.resolve(payload);}
  else{if(seam==='fetch')h.change('library');h.reply(0,payload);}
  await work;await h.flush();assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.host.querySelectorAll('.album-card').length,0);
  assert.notEqual(h.state.view.context_ref,A,'rejected response cannot install raw private authority');
});

for(const attribute of ['nativeAccountId','nativeLibraryId','privateUiContext'])test(`same-turn ${attribute} A-B-A is observed before a late response can admit`,async t=>{
  const h=fixture(t),work=h.read(mainUrl());const original=h.shell.dataset[attribute];
  h.shell.dataset[attribute]=attribute==='privateUiContext'?B:'99';h.shell.dataset[attribute]=original;
  h.reply(0,ready());await work;await h.flush();assert.equal(h.runtime().snapshot().actionable,false);
  assert.equal(h.runtime().snapshot().result,null,'equal final DOM values do not restore the old request lease');
});

test('publication observer starts a real successor, preventing outer success/history/finally writes',async t=>{
  const h=fixture(t);await h.mount();let successor=null;const stop=h.runtime().subscribe(()=>{
    if(!successor&&h.runtime().snapshot().status==='ready')successor=h.read(mainUrl(ready({query:':obsessed'})),{},true);
  });t.after(stop);
  const old=h.read(mainUrl(),{},true);h.reply(0,ready());const result=await old;assert.ok(successor);assert.equal(result.value,false);
  assert.equal(h.state.busy,true);assert.equal(h.historyCalls.filter(x=>new URL(x.url).searchParams.get('q')===':loved').length,0);
  h.reply(1,ready({query:':obsessed'}));await successor;
});

test('source disposal observer cannot revive old rows or clear a reentrant new request',async t=>{
  const h=fixture(t);await h.mount();const oldSnapshot=await admit(h,ready({presentation:'tracks'})),lease=source(h,oldSnapshot),oldContent=h.host.querySelector('[data-search-results-content]');
  let successor=null;const stop=lease.subscribe(()=>{if(!successor&&lease.snapshot()===null){assert.ok(!oldContent.isConnected||oldContent.hidden&&oldContent.inert,'retirement conceals old pixels before disposal observers');successor=h.read(mainUrl(ready({query:':obsessed'})));}});t.after(()=>stop?.());
  const outside=h.read(mainUrl(ready({query:'love:loved'})));await h.flush();assert.ok(successor,'genuine source disposal observer ran');
  assert.equal(lease.snapshot(),null);assert.equal(h.runtime().isCurrent(oldSnapshot),false);assert.equal(h.state.busy,true);
  assert.equal(h.requests.filter(x=>new URL(x.url,h.location).searchParams.get('q')==='love:loved').length,0,'superseded outer start never fetched');
  h.reply(1,ready({query:':obsessed'}));await successor;await outside;
});

for(const status of [401,403,409])test(`old ${status} catch/finally cannot revoke, redirect, or unlock the current successor`,async t=>{
  const h=fixture(t),old=h.read(mainUrl()),next=h.read(mainUrl(ready({query:':obsessed'}))),current=foreground(h);
  h.reply(0,{ok:false,error_code:status===409?'stale_context':'private_search_forbidden'},status);await old;
  assert.deepEqual(foreground(h),current);assert.deepEqual(h.redirects,[]);
  h.reply(1,ready({query:':obsessed'}));assert.equal((await next).value,true);
});

for(const [name,mutate] of [
  ['listener envelope',x=>{x.contract_version='listener-history-v1';x.tracks=[{row_id:'opaque-listener-row',listener:{display_name:'Listener'},native_origin:{receipt:'opaque'}}];}],
  ['context mismatch',x=>{x.context_ref=B;}],['query mismatch',x=>{x.query=':obsessed';}],['foreign criteria',x=>{x.criteria.subject='friend';}],
  ['wrong presentation',x=>{x.presentation='album_detail';}],['duplicate inventory row',x=>{x.tracks=[track(),track()];x.page.returned_count=2;}],
  ['unreadable parent',x=>{x.tracks[0].parent_album.allowed_actions.can_read=false;}],['opaque parent identifier',x=>{x.tracks[0].parent_album.album_ref='listener-album:opaque';}],
  ['invalid count',x=>{x.page.returned_count=99;}],['unbounded page',x=>{x.page.limit=101;}],['cursor without continuation',x=>{x.page.has_more=false;}],
  ['ordinary response',()=>ordinary(':loved')],
])test(`strict actual request and runtime reject ${name}`,async t=>{
  const h=fixture(t),payload=ready({presentation:'tracks'}),work=h.read(mainUrl(payload));const replacement=mutate(payload);h.reply(0,replacement||payload);await work;
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.runtime().snapshot().result,null);
});

for(const presentation of ['albums','tracks'])test(`ready pending_page ${presentation} stays nonactionable and continues a bounded first-witness read`,async t=>{
  const h=fixture(t);await h.mount();const payload=firstWitness(presentation),snapshot=await admit(h,payload);
  assert.equal(snapshot.status,'pending');assert.equal(snapshot.actionable,false);assert.equal(snapshot.sourceIdentity,null);
  assert.deepEqual(plain(snapshot.result.albums),[]);assert.deepEqual(plain(snapshot.result.tracks),[]);assert.equal(h.requests.length,1,'no autofill');
  assert.equal(h.runtime().createPlaytableSource({rows:[],context:{scopeKey:snapshot.scopeKey,resultId:snapshot.resultId},instance:snapshot.sourceIdentity,revision:snapshot.sourceIdentity,isCurrent:()=>true}),null);
  assert.equal(h.runtime().continueResults(snapshot),true);assert.equal(h.requests.length,2);
  const url=new URL(h.requests[1].url,h.location);assert.equal(url.searchParams.get('search_sidebar_cursor'),'sealed-sidebar-first');assert.equal(url.searchParams.get('search_sidebar_only'),null);
  h.reply(1,ready({presentation}));await h.invocations.at(-1).outcome;assert.equal(h.runtime().snapshot().status,'ready');
});

for(const payload of [firstWitness('tracks',{tracks:[track()]}),firstWitness('albums',{artist_groups:[{artist:'Witness Artist',albums:[{album_ref:'inventory-album:9:11'}]}]}),
  pending(ready(),{tracks:[track()]})])test('pending wire rows cannot create display or native source authority',async t=>{
  const h=fixture(t),work=h.read(mainUrl(payload));h.reply(0,payload);await work;assert.equal(h.runtime().snapshot().result,null);assert.equal(h.runtime().snapshot().actionable,false);
});

test('selected reproof pending differs from first witness and resumes the result cursor without source authority',async t=>{
  const h=fixture(t),payload=pending(ready()),snapshot=await admit(h,payload);assert.equal(snapshot.sourceIdentity,null);assert.equal(snapshot.actionable,false);
  assert.equal(h.runtime().continueResults(snapshot),true);const request=new URL(h.requests[1].url,h.location);
  assert.equal(request.searchParams.get('search_cursor'),'sealed-results-pending');assert.equal(request.searchParams.get('omit_sidebar'),'1');
  h.reply(1,ready({patch:{sidebar:null}}));await h.invocations.at(-1).outcome;
});

test('independent Sidebar progress keeps exact main source and ignores old child finally during successor child reentry',async t=>{
  const h=fixture(t),payload=ready({presentation:'tracks'}),snapshot=await admit(h,payload),lease=source(h,snapshot),before=foreground(h);
  assert.equal(h.runtime().continueSidebar(snapshot),true);assert.equal(h.runtime().continueSidebar(snapshot),false);assert.deepEqual(foreground(h),before);
  let childTwo=false;const stop=h.runtime().subscribe(()=>{const now=h.runtime().snapshot();if(!childTwo&&now.sidebar?.status==='ready'&&h.requests.length===2){childTwo=true;assert.equal(h.runtime().continueSidebar(now),true);}});t.after(stop);
  h.reply(1,child(payload));await h.flush();assert.equal(childTwo,true);assert.equal(h.requests.length,3);
  assert.equal(h.runtime().snapshot().sidebar.status,'loading');assert.equal(h.runtime().continueSidebar(h.runtime().snapshot()),false,'old finally cannot unlock new child');
  assert.equal(h.runtime().snapshot().sourceIdentity,snapshot.sourceIdentity);assert.ok(lease.snapshot());assert.deepEqual(foreground(h),before);
  h.reply(2,child(payload,{names:['Final Artist'],cursor:null}));await h.flush();assert.equal(h.runtime().snapshot().sidebar.hasMore,false);
});

test('replacement retires Sidebar parent; equal native Sidebar markup cannot keep old node authority',async t=>{
  const h=fixture(t),payload=ready(),old=await admit(h,payload);
  // Admission schedules the real Sidebar renderer for the next browser frame.
  // Advance that frame before inspecting its nodes; no renderer is substituted.
  h.flushFrames();assert.equal(h.runtime().snapshot(),old,'painting preserves the admitted parent');
  const node=h.sidebar.querySelector('[data-sidebar-artist]');assert.ok(node);
  assert.equal(h.runtime().sidebarNodeIsCurrent(node),true);assert.equal(h.runtime().continueSidebar(old),true);
  const next=h.read(mainUrl(ready({query:':obsessed'})));h.reply(2,ready({query:':obsessed'}));await next;
  assert.equal(h.runtime().sidebarNodeIsCurrent(node),false);h.reply(1,child(payload,{names:['Retired secret Artist']}));await h.flush();
  assert.equal(h.sidebar.textContent.includes('Retired secret Artist'),false);assert.equal(h.runtime().snapshot().status,'ready');
});

for(const [name,mutate] of [
  ['cross-library track',x=>{x.tracks[0].inventory_track_ref='inventory-track:10:101';}],
  ['cross-library parent',x=>{x.tracks[0].parent_album.album_ref='inventory-album:10:11';}],
  ['cross-library album',x=>{x.presentation='albums';x.tracks=[];x.artist_groups=[{artist:'Witness Artist',albums:[{album_ref:'inventory-album:10:11',name:'Foreign',matches_search:true,allowed_actions:{can_read:true}}]}];x.page.returned_count=1;}],
  ['invalid Sidebar Artist',x=>{x.sidebar.artists=[{artist:null,artist_display:'Unbound'}];}],
  ['invalid Sidebar count',x=>{x.sidebar.returned_count=25;}],
  ['unknown love tier',x=>{x.criteria.love.include=['super-loved'];}],
  ['duplicate love tier',x=>{x.criteria.love.include=['loved','loved'];}],
  ['empty criteria',x=>{x.criteria.love.include=[];x.criteria.love.exclude=[];}],
  ['unknown name scope',x=>{x.criteria.name_scopes=['artists','albums','tracks','listeners'];}],
  ['history subject field',x=>{x.criteria.listener={account_ref:'other'};}],
])test(`malformed ${name} is rejected before finite native projection reaches apply`,async t=>{
  const h=fixture(t),payload=ready({presentation:'tracks'});mutate(payload);const before=h.applications.length,view=h.state.view;
  const work=h.read(mainUrl(payload));h.reply(0,payload);await work;assert.equal(h.applications.length,before,'pre-apply validation must reject raw malformed rows');
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.runtime().snapshot().result,null);assert.notEqual(h.state.view.private_search,true);
  assert.equal([...h.sidebar.querySelectorAll('[data-sidebar-artist]')].some(node=>node.textContent.includes('Unbound')),false);
});

test('ordinary unbound request cannot adopt a valid own-love envelope with matching raw query',async t=>{
  const h=fixture(t),query='ordinary text',work=h.read('/view-data?surface=albums&q=ordinary%20text');
  h.reply(0,ready({query}));await work;assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.applications.length,0);
});

test('private raw expression cannot accept an ordinary success response or broaden via fallback',async t=>{
  const h=fixture(t),work=h.read('/view-data?surface=albums&q=%3Aloved');h.reply(0,ordinary(':loved'));await work;
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.applications.length,0);assert.equal(h.requests.length,1);
});

test('selected Sidebar pending progress keeps ready main rows and source, and resumes only its explicit child cursor',async t=>{
  const h=fixture(t),payload=ready({presentation:'tracks'}),snapshot=await admit(h,payload),lease=source(h,snapshot),before=foreground(h);
  assert.equal(h.runtime().continueSidebar(snapshot),true);h.reply(1,child(payload,{names:[],cursor:'sealed-sidebar-pending-child',patch:{status:'pending',selection_pending:true}}));await h.flush();
  const now=h.runtime().snapshot();assert.equal(now.status,'ready');assert.equal(now.sidebar.status,'pending');assert.equal(now.sourceIdentity,snapshot.sourceIdentity);
  assert.equal(now.result,snapshot.result);assert.ok(lease.snapshot());assert.deepEqual(foreground(h),before);assert.equal(h.requests.length,2,'pending child does not autofill');
  assert.equal(h.runtime().continueSidebar(now),true);assert.equal(new URL(h.requests[2].url,h.location).searchParams.get('search_sidebar_cursor'),'sealed-sidebar-pending-child');
  h.reply(2,child(payload,{names:['Finished Artist'],cursor:null}));await h.flush();assert.equal(h.runtime().snapshot().sidebar.status,'ready');
});

test('actual assigned-view consumer reentry cannot leave an admitted outer view or success behind',async t=>{
  const h=fixture(t);await h.mount();const sync=h.c.syncHomeFriendsRuntime;let successor=null;
  h.c.syncHomeFriendsRuntime=function(...args){const result=sync.apply(this,args);if(h.state.view.private_search===true&&!successor){successor=h.read(mainUrl(ready({query:':obsessed'})));}return result;};
  const old=h.read(mainUrl(),{},true);h.reply(0,ready());const result=await old;assert.ok(successor,'real apply invoked existing native consumer');
  assert.equal(result.value,false);assert.equal(h.state.busy,true);assert.equal(h.runtime().snapshot().actionable,false);
  h.reply(1,ready({query:':obsessed'}));await successor;assert.equal(h.runtime().snapshot().status,'ready');assert.equal(h.state.view.query,':obsessed');
});

test('missing native owner fails closed before private apply instead of admitting detached navigation state',async t=>{
  const h=fixture(t,{holdRuntime:true}),work=h.read(mainUrl());h.reply(0,ready());await work;
  assert.equal(h.applications.length,0);assert.notEqual(h.state.view.private_search,true);assert.equal(h.sidebar.querySelectorAll('[data-sidebar-artist]').length,0);
});

test('reentrant abort successor owns dispatch and survives predecessor response/finally after outer interruption refuses',async t=>{
  const h=fixture(t),old=h.read(mainUrl());let successor=null,outerStarted=false;
  h.requests[0].options.signal.addEventListener('abort',()=>{successor=h.read(mainUrl(ready({query:'love:loved'})));},{once:true});
  const outer=h.read(mainUrl(ready({query:':obsessed'})),{onStart(){outerStarted=true;}});
  assert.ok(successor);assert.equal((await outer).value,false);assert.equal(outerStarted,false);assert.equal(h.requests.length,2);
  assert.equal(new URL(h.requests[1].url,h.location).searchParams.get('q'),'love:loved');const before=foreground(h);
  h.reply(0,{ok:false,error_code:'private_search_forbidden'},403);await old;assert.deepEqual(foreground(h),before,'old finally cannot release reentrant successor');
  h.reply(1,ready({query:'love:loved'}));assert.equal((await successor).value,true);
});
