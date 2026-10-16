'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,admit,source,plain,ready,ordinary,mainUrl,A,ARTIST}=require('./search-native-fixtures/actual-runtime.cjs');

for(const query of [':loved','love:loved',':obsessed','love:obsessed',':loved :obsessed','-love:obsessed'])test(`actual global input preserves ${query} for server grammar`,async t=>{
  const h=fixture(t);await h.mount();h.input.value=query;h.dispatch(h.input,'input');h.dispatch(h.form,'submit');
  assert.equal(h.requests.length,1,'global form dispatches existing foreground owner once');
  const request=new URL(h.requests[0].url,h.location);assert.equal(request.searchParams.get('q'),query);assert.equal(request.pathname,'/view-data');
  h.reply(0,ready({query}));await h.invocations.at(-1).outcome;assert.equal(h.runtime().snapshot().status,'ready');
  assert.equal(h.requests.length,1,'no substitute parser or automatic fallback query');
});

test('clear after private Search synchronously retires source and never rehydrates private rows from browse caches',async t=>{
  const h=fixture(t);await h.mount();const before=await admit(h,ready({presentation:'tracks'})),lease=source(h,before);
  const oldRows=[...h.host.querySelectorAll('.album-track-table__row')];const index=h.requests.length;
  const clear=h.form.querySelector('[data-search-clear]');assert.ok(clear&&!clear.hidden);h.click(clear);h.dispatch(h.form,'submit');
  assert.equal(h.runtime().isCurrent(before),false);assert.equal(lease.snapshot(),null);
  assert.ok(oldRows.every(node=>!node.isConnected||node.closest('[hidden],[inert]')));
  assert.equal(h.runtime().snapshot().actionable,false);
  if(h.requests.length>index){const request=new URL(h.requests[index].url,h.location);assert.equal(request.searchParams.get('q'),null);
    assert.equal([...request.searchParams.keys()].some(key=>key.startsWith('search_')),false);h.reply(index,ordinary());await h.invocations.at(-1).outcome;}
  assert.notEqual(h.state.view.private_search,true);
  assert.equal(h.host.querySelectorAll('.album-track-table__row').length,0);
});

test('recent-query activation goes through native commit and starts a new read, never cached private admission',async t=>{
  const h=fixture(t);await h.mount();await admit(h);h.c.recordRecentSearchQuery(':obsessed');h.c.openRecentSearchPopover();
  const option=[...h.document.querySelectorAll('[data-recent-search-index]')].find(node=>node.textContent===':obsessed');assert.ok(option,'actual recent-search renderer produced option');
  const previous=h.runtime().snapshot();h.c.handleGalleryBootstrapSearchClick({target:option,preventDefault(){}});
  assert.equal(h.runtime().isCurrent(previous),false);assert.equal(h.requests.length,2);assert.equal(new URL(h.requests[1].url,h.location).searchParams.get('q'),':obsessed');
  h.reply(1,ready({query:':obsessed'}));await h.invocations.at(-1).outcome;assert.equal(h.runtime().snapshot().status,'ready');
});

for(const all of [false,true])test(`${all?'all-artists':'selected Artist'} presentation survives actual URL/parser/history round trip without raw authority`,async t=>{
  const h=fixture(t),payload=ready({presentation:'tracks',all,patch:{response_note:'PRIVATE-RESPONSE-NOTE'}});
  payload.sidebar.artists.push({artist:'Sidebar-only private name',artist_display:'Sidebar-only display'});payload.sidebar.returned_count++;
  const snapshot=await admit(h,payload,{push:true});assert.equal(snapshot.presentation,'tracks');
  const location=new URL(h.location.href);assert.equal(location.searchParams.get('search_presentation'),'tracks');assert.equal(location.searchParams.get('q'),':loved');
  assert.equal(location.searchParams.get(all?'all_artists':'artist'),all?'1':ARTIST);
  const parsed=h.c.parseBrowserUrlState(location.href),rebuilt=new URL(h.c.buildApiUrl(parsed),h.location);
  assert.equal(rebuilt.searchParams.get('search_presentation'),'tracks');assert.equal(rebuilt.searchParams.get('q'),':loved');
  const history=JSON.stringify({entries:h.entries,storage:h.storageCalls});
  for(const secret of [A,'inventory-track:9:101','inventory-album:9:11','sealed-results-A','sealed-sidebar-A','PRIVATE-RESPONSE-NOTE','Sidebar-only private name','Sidebar-only display'])assert.equal(history.includes(secret),false,`${secret} cannot be history/cache authority`);
  for(const key of ['tracks','artist_groups','artists_sidebar','sourceIdentity','native_binding','native_origin','receipt'])assert.equal(Object.hasOwn(h.history.state||{},key),false,key);
});

test('Back then Forward retire in capture phase and both obtain fresh own-love reads',async t=>{
  const h=fixture(t);await h.mount();const first=await admit(h,ready({presentation:'tracks'}),{push:true}),lease=source(h,first);
  await admit(h,ready({query:':obsessed'}),{push:true});const second=h.runtime().snapshot();
  let seenBeforeOrdinaryHandler=false;h.c.addEventListener('popstate',()=>{seenBeforeOrdinaryHandler=!h.runtime().isCurrent(second);},false);
  const before=h.requests.length;h.history.back();assert.equal(seenBeforeOrdinaryHandler,true);assert.equal(h.runtime().isCurrent(second),false);assert.equal(lease.snapshot(),null);
  assert.equal(h.requests.length,before+1);const back=new URL(h.requests[before].url,h.location);assert.equal(back.searchParams.get('q'),':loved');assert.equal(back.searchParams.get('search_presentation'),'tracks');
  assert.equal(h.runtime().snapshot().actionable,false,'history cannot grant rows before new response');h.reply(before,ready({presentation:'tracks'}));await h.invocations.at(-1).outcome;
  const backSnapshot=h.runtime().snapshot();assert.notEqual(backSnapshot.sourceIdentity,first.sourceIdentity);
  h.history.forward();assert.equal(h.runtime().isCurrent(backSnapshot),false);assert.equal(h.requests.length,before+2);
  h.reply(before+1,ready({query:':obsessed'}));await h.invocations.at(-1).outcome;assert.equal(h.runtime().snapshot().presentation,'albums');
});

test('same-URL local projection cannot recover retired source or Sidebar authority',async t=>{
  const h=fixture(t),snapshot=await admit(h,ready({presentation:'tracks'})),lease=source(h,snapshot),projection=plain(h.state.view);
  h.runtime().retire('navigation');h.c.applyViewPayload(projection);assert.equal(lease.snapshot(),null);
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.runtime().snapshot().result,null);
  assert.equal(h.sidebar.querySelectorAll('[data-sidebar-artist]').length,0);
});

for(const presentation of ['albums','tracks'])test(`cold private ${presentation} shell hydrates through unchanged bootstrap-init and foreground owner`,async t=>{
  const payload=ready({presentation}),endpoint=mainUrl(payload),initial={...ordinary(':loved'),selected_artist:ARTIST,search_presentation:presentation,
    artists_sidebar:[],artist_count:0,initial_view_partial:true};
  const bootstrap={partialView:true,startupPreview:{mode:'empty_shell',isPartial:true,renderStrategy:'client',renderedGalleryMarkup:false},
    startupHydration:{required:true,trigger:'after_runtime_boot',endpoint,tier:'full',followupEndpoint:'',embeddedViewPatch:null}};
  const h=fixture(t,{url:'https://albumhaven.test/'+endpoint.replace('/view-data',''),initial,bootstrap});await h.mount();
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.host.querySelectorAll('.album-card,.album-track-table__row').length,0);
  h.boot();await h.flush();assert.equal(h.requests.length,1);assert.equal(h.requests[0].options.headers['X-AlbumHaven-Context'],A);
  const request=new URL(h.requests[0].url,h.location);assert.equal(request.searchParams.get('search_presentation'),presentation);
  assert.equal(h.invocations[0].args[2].startupRefresh,true);assert.equal(h.invocations[0].args[2].startupHydrationTier,'full');
  h.reply(0,payload);await h.invocations[0].outcome;assert.equal(h.runtime().snapshot().status,'ready');
});

for(const suffix of ['search_presentation=invalid','search_presentation=albums&search_presentation=tracks','q=%3Aloved&q=%3Aobsessed'])test(`cold hydration preserves raw invalid/multivalue input (${suffix}) for server rejection`,async t=>{
  const endpoint='/view-data?surface=albums&'+(suffix.startsWith('q=')?'': 'q=%3Aloved&')+suffix;
  const h=fixture(t,{url:'https://albumhaven.test/'+endpoint.replace('/view-data',''),initial:{...ordinary(':loved'),artists_sidebar:[],artist_count:0,
    search_presentation:new URL(endpoint,'https://albumhaven.test').searchParams.get('search_presentation')||'albums',initial_view_partial:true},
    bootstrap:{partialView:true,startupHydration:{required:true,trigger:'after_runtime_boot',endpoint,tier:'full',followupEndpoint:'',embeddedViewPatch:null}}});
  h.boot();await h.flush();assert.equal(h.requests.length,1);const sent=new URL(h.requests[0].url,h.location),expected=new URL(endpoint,h.location);
  for(const key of ['q','search_presentation'])assert.deepEqual(sent.searchParams.getAll(key),expected.searchParams.getAll(key));
  h.reply(0,{ok:false,error_code:'invalid_private_search_request',error:'Invalid search parameters.'},400);await h.invocations[0].outcome;
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.requests.length,1,'no normalized ordinary fallback');
});

test('private Search lifetime and admission work while the real Home runtime is hidden',async t=>{
  const h=fixture(t);assert.equal(h.c.AlbumHavenHomeRuntime.snapshot().visible,false);const snapshot=await admit(h);
  assert.equal(h.runtime().isCurrent(snapshot),true);assert.equal(h.c.AlbumHavenHomeRuntime.snapshot().visible,false);
  h.change('library');await h.flush();assert.equal(h.runtime().isCurrent(snapshot),false);
});

for(const query of ['@maya','@maya :tracks listened:all'])test(`unsupported listener expression ${query} reaches server unchanged and stays inactive`,async t=>{
  const h=fixture(t);await h.mount();const work=h.submit(query);assert.equal(h.requests.length,1);
  assert.equal(new URL(h.requests[0].url,h.location).searchParams.get('q'),query);
  h.reply(0,{ok:false,error_code:'unsupported_private_search_combination',error:'This search combination is not supported.'},400);await work;
  assert.equal(h.requests.length,1);assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.runtime().snapshot().result,null);
  assert.equal(h.host.querySelectorAll('[data-listener],[data-listener-help]').length,0);
});
