'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {entryEnvironment,load,drain} = require('./native-entry-fixtures/actual-native-runtime.cjs');
const vm=require('node:vm');
const {readRepo}=require('./native-home-harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const selected = host => host.querySelector('#home-recent-kinds [aria-selected="true"]').dataset.inPageTab;

// Actual controller, view, controls and native Recent renderer. Only platform
// viewport and externally supplied DTOs are controlled; no component surrogate.
async function viewFixture(t,{width=1200,presentation,section='recent',friend=null,activity}={}) {
  const h=entryEnvironment(t),saved=[],reads=[],contexts=[],mediaListeners=new Set(),queries=new Map();
  const media={matches:width<=900,addEventListener(_type,fn){mediaListeners.add(fn);},removeEventListener(_type,fn){mediaListeners.delete(fn);}};
  h.context.innerWidth=width;h.context.matchMedia=query=>{if(!queries.has(query)){const limit=Number(query.match(/max-width:\s*(\d+)px/)?.[1]||900);queries.set(query,{...media,matches:width<=limit,limit});}return queries.get(query);};
  vm.runInContext(readRepo('music_app/static/js/unfolding-action-button.js'),h.context);
  Object.assign(h.runtime,{viewChooserHtml:options=>h.context.UnfoldingActionButton.render(options),mountViewChooser:(node,options)=>h.context.UnfoldingActionButton.mount(node,options),viewIconHtml:value=>{const node=h.document.createElement('div');node.innerHTML=h.owner('buildGalleryBarHtml')({});return node.querySelector(`[data-gallery-view-choice="${value}"] svg`)?.outerHTML||'';}});
  const {createHomeFriendsController}=await load('home-friends/model.mjs');
  const {mountHomeFriendsView}=await load('home-friends/app.mjs');
  const controller=createHomeFriendsController({readRecent:()=>({recent_local_albums:[],recent_not_local_albums:[]}),providers:{
    readFriends:()=>({friends:friend?[friend]:[],requests:[],profile:null}),
    readActivity:request=>{reads.push(request);return {rows:request.kind==='albums'?[{id:'album:one',kind:'album',title:'Current album',artist:'Artist',listen_count:2}]:request.kind==='tracks'?[{id:'track:one',kind:'track',title:'Current track',availability:'local'}]:[],total_listens:0,range_label:'Supplied date range'};},
  }});
  controller.setScope('viewer/library');await controller.loadFriends();await controller.loadRecent();
  if(friend)controller.selectFriend(friend.account_ref);
  if(activity)await controller.loadActivity({kind:activity.kind,period:activity.period});
  const runtime={...h.runtime,savePresentation:value=>saved.push(plain(value)),trackPlayback:(_row,context)=>{contexts.push(context);return null;}};
  const shell={section,friendRef:friend?.account_ref||'',profileRef:'',presentation};
  let owner,closed=false;
  const props=()=>({runtime,controller,state:controller.getSnapshot(),shell});
  const unsubscribe=controller.subscribe(()=>owner?.update(props()));
  owner=mountHomeFriendsView(h.host,props());owner.update(props());await drain();
  const dispose=()=>{if(closed)return;closed=true;owner.dispose();unsubscribe();controller.dispose();assert.equal(mediaListeners.size,0);assert.equal(h.host.childNodes.length,0);};
  t.after(dispose);
  return {...h,saved,reads,contexts,controller,owner,dispose,
    resize(next){h.context.innerWidth=next;for(const query of queries.values())query.matches=next<=query.limit;for(const fn of [...mediaListeners])fn();},
    choose(kind){const button=h.host.querySelector(`#home-recent-kinds [data-in-page-tab="${kind}"]`);assert.ok(button);h.click(button);},
  };
}

test('fresh Home defaults to Tracks at phone widths and Albums on desktop',async t=>{
  for(const [width,expected] of [[320,'tracks'],[390,'tracks'],[900,'tracks'],[901,'albums'],[1440,'albums']]) {
    const h=await viewFixture(t,{width});assert.equal(selected(h.host),expected);assert.equal(h.saved.at(-1).kindExplicit,false);h.dispose();
  }
});
test('implicit defaults follow the viewport until a deliberate tab choice is saved',async t=>{
  const h=await viewFixture(t);assert.equal(selected(h.host),'albums');h.resize(390);assert.equal(selected(h.host),'tracks');
  h.choose('artists');assert.equal(h.saved.at(-1).kindExplicit,true);h.resize(1440);assert.equal(selected(h.host),'artists');
  const restored=await viewFixture(t,{width:320,presentation:h.saved.at(-1)});assert.equal(selected(restored.host),'artists');restored.dispose();h.dispose();
});
test('history preserves legacy explicit choices but re-evaluates saved automatic defaults',async t=>{
  for(const [presentation,width,expected,explicit] of [
    [{kind:'albums'},320,'albums',true],[{kind:'tracks',kindExplicit:true},1440,'tracks',true],
    [{kind:'albums',kindExplicit:false},320,'tracks',false],[{kind:'tracks',kindExplicit:false},1440,'albums',false],
    [{kind:'unknown',kindExplicit:true},390,'tracks',false],
  ]) {const h=await viewFixture(t,{presentation,width});assert.equal(selected(h.host),expected);assert.equal(h.saved.at(-1).kindExplicit,explicit);h.dispose();}
});
test('Home places native Recent and disabled News with Period above one content scroll owner',async t=>{
  const h=await viewFixture(t,{width:320}),widget=h.host.querySelector('[data-home-widget="recent"]');
  const header=widget.querySelector('header'),body=widget.querySelector('.home-friends__widget-body');assert.ok(header);assert.ok(body);
  const sections=header.querySelector('[aria-label="Home sections"]');assert.ok(sections);
  assert.deepEqual(sections.querySelectorAll('[data-in-page-tab]').map(node=>[node.dataset.inPageTab,node.textContent.trim(),node.disabled]),[['recent','Recent',false],['news','News',true],['queue','Queue',false]]);
  assert.equal(sections.querySelector('[aria-selected="true"]').dataset.inPageTab,'recent');
  assert.ok(header.querySelector('[aria-label="Period: Last week"]'));assert.ok(header.querySelector('#home-recent-kinds'));
  assert.equal(body.querySelector('[role="tablist"]'),null);assert.equal(h.host.querySelectorAll('[aria-label="Home sections"]').length,1);h.dispose();
});
test('a changed responsive default clears only the unrelated Recent scroll position',async t=>{
  const h=await viewFixture(t,{width:390,presentation:{kind:'albums',kindExplicit:false,scroll:{recent:440,friends:120,page:30}}});
  assert.deepEqual(h.saved.at(-1).scroll,{recent:0,friends:120,page:30});h.dispose();
});
test('Recent Albums ignores saved rows and no-info choices for every period',async t=>{
  for(const view of ['list','covers'])for(const period of ['week','month']) {
    const h=await viewFixture(t,{presentation:{kind:'albums',period,views:{albums:view}},activity:{account_ref:null,kind:'albums',period}});
    const recent=h.host.querySelector('[data-home-widget="recent"]');
    assert.equal(recent.querySelector('.home-friends__view-control'),null);assert.equal(h.saved.at(-1).views.albums,'cards');
    if(period==='week')assert.ok(recent.querySelector('.home-recent'));
    else {assert.ok(recent.querySelector('.home-activity'));assert.ok(recent.querySelector('[data-gallery-display="cards"]'),'month album result uses canonical cards');assert.equal(h.controller.getSnapshot().activityNavigation.query.account_ref,null);assert.equal(h.controller.getSnapshot().activityNavigation.query.period,period);}
    h.dispose();
  }
});
test('Home and Friends activity receive the complete current account and period query',async t=>{
  const friend={account_ref:'friend:one',display_name:'Friend',relationship:'accepted',allowed_actions:{can_view_activity:true}};
  for(const own of [true,false]) {
    const account_ref=own?null:friend.account_ref,period=own?'month':'six';
    const h=await viewFixture(t,{section:own?'recent':'friends',friend:own?null:friend,presentation:{kind:'tracks',period,friendKind:'tracks',friendPeriod:period},activity:{account_ref,kind:'tracks',period}});
    assert.ok(h.host.querySelector('.home-activity'));assert.equal(h.reads.at(-1).scopeKey,'viewer/library');assert.equal(h.reads.at(-1).account_ref,account_ref);assert.equal(h.reads.at(-1).period,period);assert.ok(h.contexts.length>0,'actual activity table requests playback projection with current context');assert.deepEqual(plain(h.contexts.at(-1)),{scopeKey:'viewer/library',account_ref,kind:'tracks',period});h.dispose();
  }
});
