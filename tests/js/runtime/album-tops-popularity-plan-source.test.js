// Whole additive source-authored suite. No runtime was executed during authorship.
const test = require('node:test');
const assert = require('node:assert/strict');
let createTopQueuePlan, createTopPlaybackSource;
test.before(async () => {
  ({createTopQueuePlan} = await import('../../../music_app/static/js/album-tops/queue-plan.mjs'));
  ({createTopPlaybackSource} = await import('../../../music_app/static/js/album-tops/playback-source.mjs'));
});
const blocks = () => [{id: 'a', tracks: ['a1','a2','a3','a4','a5']}, {id: 'b', tracks: ['b1','b2','b3']}];
const popularity = () => [{id:'a2',count:0},{id:'a3',count:8},{id:'a4',count:8},{id:'b2',count:9007199254740991}];
const expected = ['a3','a4','a2','a1','a5','b2','b1','b3'];
const next = (plan, options) => {const id=plan.candidate(options); assert.notEqual(id,null); assert.equal(plan.commit(id),true); return id;};
test('popular mode retains every occurrence and album block, with known zero ahead of stable unknowns', () => {
  const plan=createTopQueuePlan(blocks(),{mode:'popular_songs',popularity:popularity()});
  assert.deepEqual(plan.snapshot().order,expected);
  assert.equal(new Set(plan.snapshot().order).size,8);
  assert.deepEqual(plan.snapshot().order.map(id=>plan.albumFor(id)),['a','a','a','a','a','b','b','b']);
  assert.equal(plan.snapshot().visitedEnd,-1);
});
test('all unknown popular mode preserves complete original order without random sampling', () => {
  const plan=createTopQueuePlan(blocks(),{mode:'popular_songs',random:()=>assert.fail('Popularity must not randomize')});
  assert.deepEqual(plan.snapshot().order,blocks().flatMap(b=>b.tracks));
});
test('captured popularity is detached from later metadata edits and only mode changes reorder unvisited tracks', () => {
  const facts=popularity(), input=blocks(), plan=createTopQueuePlan(input,{popularity:facts});
  facts[0].count=999; facts.push({id:'a1',count:999999}); input[0].tracks.reverse();
  assert.equal(plan.configure({mode:'popular_songs'}),true);
  // configure preserves the initial current occurrence under the existing mode-edit contract.
  assert.deepEqual(plan.snapshot().order,['a1','a3','a4','a2','a5','b2','b1','b3']);
  const snapshot=plan.snapshot(); assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.order));
});
test('popular mode edit preserves the complete furthest visited prefix after Previous', () => {
  const plan=createTopQueuePlan(blocks(),{popularity:popularity()});
  plan.commit('a1'); next(plan); next(plan); next(plan); next(plan); next(plan);
  const prefix=plan.snapshot().order.slice(0,6); next(plan,{direction:-1}); next(plan,{direction:-1});
  assert.equal(plan.snapshot().currentId,'a4');
  assert.equal(plan.configure({mode:'popular_songs'}),true);
  assert.deepEqual(plan.snapshot().order.slice(0,6),prefix);
  assert.equal(plan.snapshot().currentId,'a4'); assert.equal(plan.snapshot().visitedEnd,5);
  assert.deepEqual(plan.snapshot().order.slice(6),['b2','b3']);
});
test('partial album mode change ranks only its remaining suffix and Stop still fences automatic album crossing', () => {
  const plan=createTopQueuePlan(blocks(),{popularity:popularity(),stopAfterAlbum:true}); plan.commit('a1');
  assert.equal(plan.configure({mode:'popular_songs'}),true);
  assert.deepEqual(plan.snapshot().order,['a1','a3','a4','a2','a5','b2','b1','b3']);
  for(const id of ['a3','a4','a2','a5']) assert.equal(next(plan),id);
  assert.equal(plan.candidate(),null); assert.equal(plan.candidate({automatic:false}),'b2');
  assert.equal(next(plan,{automatic:false}),'b2'); assert.equal(plan.snapshot().stopAfterAlbum,true);
});
test('rejected high-ranked occurrence is skipped without dropping its album or changing captured ranking', () => {
  const plan=createTopQueuePlan(blocks(),{mode:'popular_songs',popularity:popularity()});
  const snapshot=plan.snapshot(); assert.equal(plan.reject('a3',snapshot),true);
  assert.equal(plan.candidate(),'a4'); assert.deepEqual(plan.snapshot().order,expected);
  assert.equal(plan.snapshot().visitedEnd,-1); assert.equal(plan.commit('a4'),true);
  assert.equal(plan.snapshot().currentId,'a4'); assert.deepEqual(plan.snapshot().unavailableIds,['a3']);
});
for(const [name,value] of [
  ['non-array',{}],['sparse',Array(1)],['null row',[null]],['unknown occurrence',[{id:'other',count:1}]],
  ['duplicate',[{id:'a1',count:1},{id:'a1',count:2}]],['negative',[{id:'a1',count:-1}]],
  ['fraction',[{id:'a1',count:0.5}]],['boolean',[{id:'a1',count:true}]],['string',[{id:'a1',count:'2'}]],
  ['unsafe',[{id:'a1',count:9007199254740992}]],['NaN',[{id:'a1',count:NaN}]],['infinite',[{id:'a1',count:Infinity}]],
]) test('plan rejects malformed popularity '+name,()=>assert.throws(()=>createTopQueuePlan(blocks(),{popularity:value}),TypeError));
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const TOP=uuid(1), ITEM=uuid(2), CATALOG=uuid(3), SCOPE=JSON.stringify(['1','2','a'.repeat(64),4]);
const fact=count=>({provider:'lastfm',metric:'overall_scrobbles',count,observed_at:'2001-01-01T00:00:00Z'});
function sourceFixture() {
  const tuple=id=>({revision:'7',item_ref:ITEM,catalog_ref:CATALOG,inventory_album_ref:'inventory-album:2:11',inventory_track_ref:'inventory-track:2:'+id,canonical_track_ref:'recording-'+id});
  const tracks=[101,102,103].map((id,i)=>({queue_item_ref:ITEM+':'+id,source:tuple(id),popularity:i===0?null:fact(i===1?9:0)}));
  for(const track of tracks) Object.defineProperty(track,'native_target',{get(){assert.fail('Captured target is not authority');}});
  const capture={top_ref:TOP,revision:'7',albums:[{item_ref:ITEM,catalog_ref:CATALOG,inventory_album_ref:'inventory-album:2:11',album_ref:'Album',tracks}],unavailable_items:[]};
  const calls=[]; let live=true;
  const source=createTopPlaybackSource({capture,scopeKey:SCOPE,mode:'popular_songs',isCurrent:()=>live,
    providers:{async resolveNativePlayback(payload,options){calls.push({payload,options}); const id=payload.source.inventory_track_ref.split(':').at(-1); return {top_ref:TOP,source:{...payload.source},native_target:{path:'/fresh/'+id,track_ref:'/fresh/'+id,title:'Fresh',artist:null,album_title:'Album',duration_seconds:null,inventory_track_ref:payload.source.inventory_track_ref}};}}});
  return {source,capture,calls,tuple,retire(){live=false;}};
}
test('source copies popularity into its captured plan while fresh resolution retains the exact six-field authority tuple',async()=>{
  const f=sourceFixture(), expected=f.tuple(102); f.capture.albums[0].tracks[1].popularity.count=0;
  f.capture.albums[0].tracks[2].popularity.count=999; f.capture.albums[0].tracks.reverse();
  assert.deepEqual(f.source.snapshot().order,[102,103,101].map(id=>ITEM+':'+id));
  const receipt=await f.source.prepare(); assert.deepEqual(f.calls[0].payload,{top_ref:TOP,source:expected});
  assert.equal(Object.keys(f.calls[0].payload.source).length,6); assert.equal(receipt.payload.path,'/fresh/102');
  assert.equal(Object.hasOwn(receipt.payload,'popularity'),false); assert.equal(f.source.commit(receipt,receipt.payload),true);
});
test('popularity cannot authorize a retired source or turn an uncommitted receipt into history',async()=>{
  const f=sourceFixture(), before=f.source.snapshot(), receipt=await f.source.prepare();
  assert.equal(f.source.snapshot(),before); assert.equal(f.source.commit(receipt,{...receipt.payload}),false);
  f.retire(); assert.equal(f.source.isReceiptCurrent(receipt),false); assert.equal(f.source.commit(receipt,receipt.payload),false);
  assert.equal(f.source.snapshot(),before); assert.equal(f.source.hasBinding(receipt.payload),true);
});
