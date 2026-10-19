'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {actionFixture,listenerReady,listenerTrack,submitListener,listenerUrl,bindingReply,ready,ordinary,A,B,ROW,ROW2,TOKEN,CURSOR,
  assertListenerPrivate}=require('./search-native-fixtures/listener-search.cjs');
for(const [query,include,exclude]of [['@maya',[],[]],['@maya :tracks listened:all',[],[]],['@maya :loved',['loved'],[]],
  ['@maya :obsessed',['obsessed'],[]],['@maya :loved :obsessed',['loved','obsessed'],[]],['@maya -love:obsessed',[],['obsessed']],
  ['  @maya   love:loved  ',['loved'],[]]])test(`global listener form admits exact server query ${JSON.stringify(query)}`,async t=>{
  const h=await actionFixture(t),payload=listenerReady({query,include,exclude}),snapshot=await submitListener(h,payload);
  assert.equal(snapshot.result.kind,'listener');assert.equal(snapshot.presentation,'tracks');assert.equal(snapshot.result.tracks.length,2);
  assert.equal(h.applications.length,1);assert.equal(h.requests.length,2);assert.equal(h.host.querySelectorAll('[data-cdt-row-key]').length,2);
  assert.equal(h.state.view.private_search,true);assertListenerPrivate(h);
});
const malformed=[
  ['raw history',p=>{p.contract_version='listener-history-v1';}],['own Love version',p=>{p.contract_version='own-love-v1';}],
  ['foreign context',p=>{p.context_ref=B;}],['query rewrite',p=>{p.query='@MAYA';}],['wrong presentation',p=>{p.presentation='albums';}],
  ['pending envelope',p=>{p.status='pending';}],['missing private marker',p=>{delete p.private_search;}],
  ['listener mismatch',p=>{p.listener.username='other';}],['noncanonical Love',p=>{p.criteria.love.include=['obsessed','loved'];}],
  ['duplicate Love',p=>{p.criteria.love.include=['loved','loved'];}],['unknown Love',p=>{p.criteria.love.include=['favorite'];}],
  ['wrong history period',p=>{p.criteria.history.period='week';}],['wrong predicate domain',p=>{p.criteria.predicate_domain='albums';}],
  ['wrong subject kind',p=>{p.criteria.subject.kind='self';}],['extra criterion',p=>{p.criteria.origin={source:'activity'};}],
  ['inventory row',p=>{p.tracks[0].id='inventory-track:9:101';}],['duplicate row',p=>{p.tracks[1].id=ROW;}],
  ['unsafe count',p=>{p.tracks[0].listen_count=Number.MAX_SAFE_INTEGER+1;}],['negative count',p=>{p.tracks[0].listen_count=-1;}],
  ['invalid duration',p=>{p.tracks[0].duration_seconds=-1;}],['unknown availability',p=>{p.tracks[0].availability='remote';}],
  ['unreadable row',p=>{p.tracks[0].source_readable=false;}],['row private injection',p=>{p.tracks[0].path='/private/file';}],
  ['missing token',p=>{delete p.native.result_token;}],['long token',p=>{p.native.result_token='x'.repeat(4097);}],
  ['wrong returned count',p=>{p.page.returned_count=1;}],['wrong limit',p=>{p.page.limit=50;}],
  ['too few examined',p=>{p.page.candidates_examined=1;}],['unbounded examined',p=>{p.page.candidates_examined=101;}],
  ['unsafe total',p=>{p.page.total_matches=Number.MAX_SAFE_INTEGER+1;}],['missing continuation',p=>{p.page.has_more=true;}],
  ['extra envelope grant',p=>{p.allowed_actions={can_play:true};}],['private native origin',p=>{p.native.snapshot_ref='borrowed';}]
];
for(const [name,mutate]of malformed)test(`foreground rejects listener ${name} before apply, bindings or pixels`,async t=>{
  const h=await actionFixture(t),p=listenerReady();mutate(p);const work=h.submit('@maya');h.reply(0,p);await work;await h.flush();
  assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.runtime().snapshot().result,null);
  assert.equal(h.requests.length,1);assert.equal(h.host.querySelectorAll('[data-cdt-row-key]').length,0);
  assert.equal(h.applications.length,0);assertListenerPrivate(h);
});
for(const substitute of [()=>ordinary('@maya'),()=>ready(),()=>({status:'ready',contract_version:'listener-history-v1',context_ref:A})])
  test('Listener foreground cannot fall back to a foreign ready dialect',async t=>{
    const h=await actionFixture(t),work=h.submit('@maya');h.reply(0,substitute());await work;
    assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.requests.length,1);assert.equal(h.applications.length,0);
  });
for(const suffix of ['q=%40maya&q=%40maya','q=%40maya&search_presentation=tracks&search_presentation=tracks',
  'q=%40maya&surface=albums&surface=albums','q=%40maya&search_page_size=100&search_page_size=100',
  'q=%40maya&search_cursor=x&search_cursor=x','q=%40maya&search_presentation=albums','q=%40maya&artist=Other',
  'q=%40maya&search_page_size=0','q=%40maya&search_page_size=101','q=%40maya&search_page_size=1.5'])
  test(`raw request is not repaired before listener match: ${suffix}`,async t=>{
    const h=await actionFixture(t),work=h.read('/view-data?'+suffix);assert.equal(h.requests.length,1);
    assert.equal(new URL(h.requests[0].url,h.location).search,new URL('/view-data?'+suffix,h.location).search);
    h.reply(0,listenerReady());await work;assert.equal(h.runtime().snapshot().result,null);assert.equal(h.requests.length,1);
  });
test('explicit bounded page size and absent Tracks default both match exact request intent',async t=>{
  const h=await actionFixture(t),p=listenerReady({tracks:[listenerTrack()]});p.page.limit=1;
  const work=h.read('/view-data?q=%40maya&search_page_size=1');h.reply(0,p);assert.equal((await work).value,true);await h.flush();
  h.reply(1,bindingReply(h,1));await h.flush();assert.equal(h.runtime().snapshot().result.tracks.length,1);
});
test('continuation cannot repeat its incoming cursor',async t=>{
  const h=await actionFixture(t),p=listenerReady();p.page.has_more=true;p.page.next_cursor=CURSOR;
  const work=h.read(listenerUrl(p,{search_cursor:CURSOR}));h.reply(0,p);await work;
  assert.equal(h.runtime().snapshot().result,null);assert.equal(h.requests.length,1);
});
for(const phase of ['http','json'])test(`same-turn context A to B to A rejects held ${phase} response`,async t=>{
  const h=await actionFixture(t),work=h.submit('@maya');const body=phase==='json'?h.requests[0].holdJson():null;
  if(body)await h.requests[0].jsonStarted;h.shell.dataset.privateUiContext=B;h.shell.dataset.privateUiContext=A;
  if(body)body.resolve(listenerReady());else h.reply(0,listenerReady());await work;await h.flush();
  assert.equal(h.runtime().snapshot().result,null);assert.equal(h.applications.length,0);assert.equal(h.requests.length,1);
});
for(const status of [401,403,409,503])test(`Listener HTTP ${status} is a failure, never ready empty or fallback`,async t=>{
  const h=await actionFixture(t),work=h.submit('@maya');h.reply(0,{error:'private_search_unavailable'},status);await work;await h.flush();
  assert.equal(h.runtime().snapshot().result,null);assert.equal(h.runtime().snapshot().actionable,false);assert.equal(h.requests.length,1);
  assert.doesNotMatch(h.host.textContent,/No matching tracks/);
});

for(const seam of ['context','schema'])test(`final response callback reentry at ${seam} cannot bypass bounded foreground validation`,async t=>{
  const h=await actionFixture(t),payload=listenerReady();let entered=false;
  const work=h.read(listenerUrl(payload),{shouldApplyResponse(){if(!entered){entered=true;
    if(seam==='context'){h.shell.dataset.privateUiContext=B;h.shell.dataset.privateUiContext=A;}
    else payload.tracks[0].path='/private/injected-after-first-check';}return true;}});
  h.reply(0,payload);await work;await h.flush();assert.equal(entered,true);assert.equal(h.runtime().snapshot().result,null);
  assert.equal(h.applications.length,0);assert.equal(h.requests.length,1);assertListenerPrivate(h,['/private/injected-after-first-check']);
});
