'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {actionFixture,listenerReady,listenerTrack,submitListener,bindingReply,ordinary,ready,admit,source,plain,ROW,TOKEN,CURSOR,
  assertListenerPrivate}=require('./search-native-fixtures/listener-search.cjs');
function generated(url,h,{cursor=null}={}){
  const value=new URL(url,h.location);assert.equal(value.searchParams.get('q'),'@maya');assert.equal(value.searchParams.get('surface'),'albums');
  assert.equal(value.searchParams.get('search_presentation'),'tracks');
  for(const key of value.searchParams.keys())assert.ok(['surface','q','search_presentation','search_page_size','search_cursor'].includes(key),key);
  assert.equal(value.searchParams.get('search_cursor'),cursor);return value;
}
for(const predecessor of ['own Love Albums','ordinary category'])test(`generated Listener transport drops ${predecessor} ambient selection`,async t=>{
  const h=await actionFixture(t);
  if(predecessor==='own Love Albums')await admit(h,ready({all:true}));
  else {const work=h.read('/view-data?surface=albums&artist=Other&category=archive&gallery_scope=all&layout=grid&filter=all');h.reply(0,{...ordinary(),selected_artist:'Other',visible_library_categories:['archive'],gallery_scope:'all',gallery_display_mode:'list',search_filters:{genre:['rock'],mood:[],style:[],duration:{min_seconds:20,max_seconds:null}}});await work;}
  const index=h.requests.length;await submitListener(h);generated(h.requests[index].url,h);generated(h.c.buildUrl(h.state.view),h);
  assert.equal(h.state.view.selected_artist,'');assert.equal(Boolean(h.state.view.all_artists_active),false);
  assert.deepEqual(plain(h.state.view.artists_sidebar),[]);assert.deepEqual(plain(h.state.view.artist_groups),[]);
  assert.equal(h.state.view.show_all_artists_sidebar_link,false);assertListenerPrivate(h);
});
test('real clear button and submit return canonical Home before any ordinary paint',async t=>{
  const h=await actionFixture(t),old=await submitListener(h),lease=source(h,old),nodes=[...h.host.querySelectorAll('[data-cdt-row-key]')];
  const index=h.requests.length,clear=h.form.querySelector('[data-search-clear]');assert.ok(clear&&!clear.hidden);h.click(clear);h.dispatch(h.form,'submit');
  assert.equal(h.runtime().isCurrent(old),false);assert.equal(lease.snapshot(),null);assert.equal(h.runtime().snapshot().actionable,false);
  assert.ok(nodes.every(node=>!node.isConnected||node.closest('[hidden],[inert]')));
  for(const request of h.requests.slice(index)){
    const url=new URL(request.url,h.location);assert.equal(url.searchParams.has('q'),false);
    assert.equal([...url.searchParams.keys()].some(key=>key.startsWith('search_')),false);
  }
  if(h.requests.length>index){h.reply(index,ordinary());await h.invocations.at(-1).outcome;}
  assert.notEqual(h.state.view.private_search,true);assert.equal(h.host.querySelectorAll('[data-cdt-row-key]').length,0);
  const root=new URL(h.c.buildUrl(h.state.view),h.location);assert.equal(root.searchParams.has('artist'),false);
  assertListenerPrivate(h);
});
for(const suffix of ['q=%40maya&q=%40other','q=%40maya&search_presentation=albums',
  'q=%40maya&search_presentation=tracks&search_presentation=albums','q=%40maya&all_artists=1',
  'q=%40maya&search_cursor=x&search_cursor=y'])test(`cold bootstrap preserves raw URL multiplicity: ${suffix}`,async t=>{
  const endpoint='/view-data?surface=albums&'+suffix;
  const h=await actionFixture(t,{url:'https://albumhaven.test/'+endpoint.replace('/view-data',''),
    initial:{...ordinary('@maya'),artists_sidebar:[],artist_count:0,initial_view_partial:true},
    bootstrap:{partialView:true,startupHydration:{required:true,trigger:'after_runtime_boot',endpoint,tier:'full',followupEndpoint:'',embeddedViewPatch:null}}});
  h.boot();await h.flush();assert.equal(h.requests.length,1);
  const sent=new URL(h.requests[0].url,h.location),expected=new URL(endpoint,h.location);
  for(const key of new Set(expected.searchParams.keys()))assert.deepEqual(sent.searchParams.getAll(key),expected.searchParams.getAll(key));
  h.reply(0,{ok:false,error_code:'invalid_private_search_request'},400);await h.invocations[0].outcome;
  assert.equal(h.requests.length,1);assert.equal(h.runtime().snapshot().result,null);
});
test('Back and Forward always request fresh results and never restore a private lease',async t=>{
  const h=await actionFixture(t);await submitListener(h);const first=h.runtime().snapshot();await submitListener(h,listenerReady({query:'@maya :loved',include:['loved']}));
  const second=h.runtime().snapshot(),index=h.requests.length;h.history.back();assert.equal(h.runtime().isCurrent(second),false);
  assert.equal(h.requests.length,index+1);assert.equal(h.runtime().snapshot().actionable,false);assert.equal(new URL(h.requests[index].url,h.location).searchParams.get('q'),'@maya');
  h.reply(index,listenerReady());await h.invocations.at(-1).outcome;await h.flush();h.reply(index+1,bindingReply(h,index+1));await h.flush();
  assert.notEqual(h.runtime().snapshot().sourceIdentity,first.sourceIdentity);h.history.forward();assert.equal(h.requests.length,index+3);
  assert.equal(new URL(h.requests[index+2].url,h.location).searchParams.get('q'),'@maya :loved');assert.equal(h.runtime().snapshot().actionable,false);
  h.reply(index+2,listenerReady({query:'@maya :loved',include:['loved']}));await h.invocations.at(-1).outcome;await h.flush();
  h.reply(index+3,bindingReply(h,index+3));await h.flush();assertListenerPrivate(h);
});
test('recent query activation requires fresh global commit and bindings',async t=>{
  const h=await actionFixture(t);const old=await submitListener(h);h.c.recordRecentSearchQuery('@maya :loved');h.c.openRecentSearchPopover();
  const option=[...h.document.querySelectorAll('[data-search-suggestion-index]')].find(node=>node.textContent==='@maya :loved');assert.ok(option);
  const index=h.requests.length;h.dispatch(option,'click');
  assert.equal(h.runtime().isCurrent(old),false);assert.equal(h.requests.length,index+1);assert.equal(h.runtime().snapshot().actionable,false);
  h.reply(index,listenerReady({query:'@maya :loved',include:['loved']}));await h.invocations.at(-1).outcome;await h.flush();
  assert.ok([...h.host.querySelectorAll('[data-search-track-play]')].every(node=>node.disabled));
  h.reply(index+1,bindingReply(h,index+1));await h.flush();assertListenerPrivate(h);
});
test('explicit Continue replaces sparse page; Restart omits old cursor and binds a new token',async t=>{
  const h=await actionFixture(t),p=listenerReady({tracks:[]});p.page={limit:100,returned_count:0,candidates_examined:100,has_more:true,next_cursor:CURSOR,total_matches:null};
  const old=await submitListener(h,p);assert.equal(h.requests.length,1);h.click(h.button(/^Continue$/));assert.equal(h.requests.length,2);
  generated(h.requests[1].url,h,{cursor:CURSOR});assert.equal(h.runtime().isCurrent(old),false);
  const next=listenerReady({patch:{native:{result_token:'sealed-listener-result-B'}}});h.reply(1,next);await h.invocations.at(-1).outcome;await h.flush();
  h.reply(2,bindingReply(h,2));await h.flush();const index=h.requests.length,work=h.runtime().restart(h.runtime().snapshot());
  generated(h.requests[index].url,h);h.reply(index,listenerReady());await work;await h.flush();
  assert.equal(JSON.parse(h.requests[index+1].options.body).result_token,TOKEN);assert.equal(h.requests.length,index+2);assertListenerPrivate(h,['sealed-listener-result-B']);
});
