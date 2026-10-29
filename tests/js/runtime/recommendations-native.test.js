'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../../..');
const model = () => import(path.join(ROOT,'music_app/static/js/recommendations/presentation.mjs'));
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const escape = value => String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const tick = () => new Promise(resolve=>setImmediate(resolve));

test('attributions retain distinct people, deduplicate identities, and never trust link text',async()=>{
 const p=await model();const value=[{display_name:' Eli ',account_ref:A},{display_name:'duplicate',account_ref:A},
 {display_name:'<script>"',account_ref:'javascript:bad'},{display_name:'Friend',account_ref:null},{display_name:' friend ',account_ref:null}];
 assert.equal(p.normalizeRecommenders(value).length,3);
 const html=p.recommenderListHtml(value,escape);assert.match(html,/home_profile=11111111/);assert.match(html,/&lt;script&gt;&quot;/);assert.doesNotMatch(html,/javascript:/);
 assert.equal(p.recommendationSummary([]),'');assert.equal(p.recommendationSummary(value),'Recommended by: a few');
 assert.equal(p.recommendationSummary([{display_name:'Eli',account_ref:A}]),'Recommended by: Eli');
 assert.equal(p.recommendationSummary(['a','b','c','d'].map(display_name=>({display_name}))), 'Recommended by: many');
});

test('recommendations accept only exact bounded inventory refs from one current private row',async()=>{
 const p=await model();assert.deepEqual(p.recommendationResource('track','inventory-track:1:2'),{kind:'track',resource_ref:'inventory-track:1:2'});
 for(const ref of ['inventory-album:1:2','/music/private.flac','inventory-track:0:1','inventory-track:1:9223372036854775808'])assert.equal(p.recommendationResource('track',ref),null);
 const packet={scopeKey:'s',row_keys:['x']},lifetime={isCurrent:()=>true},adapter={snapshot:()=>({scopeKey:'s'}),resolveRows:()=>({rows:[{track_ref:'inventory-track:1:2'}]})};
 assert.ok(p.singleRecommendedTrack(packet,lifetime,adapter));
 assert.equal(p.singleRecommendedTrack({...packet,row_keys:['x','y']},lifetime,adapter),null);
 assert.equal(p.singleRecommendedTrack(packet,{isCurrent:()=>false},adapter),null);
});

async function fixture({manual=false,post,friends,resource}={}) {
 const p=await model();const requests=[],buttons=[],events=[],fields={};let form,resolve,subscriber=null,context='a'.repeat(64),alive=true;
 const element=()=>({disabled:false,hidden:false,value:'',textContent:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},appendChild(node){buttons.push(node);},
 set innerHTML(value){this.firstElementChild=element();this.firstElementChild.markup=value;},get innerHTML(){return '';}});
 for(const key of ['[data-recommendation-selected]','[data-recommendation-load-status]','[data-recommendation-more]','[data-recommendation-friends]'])fields[key]=element();
 if(manual)fields['[data-recommender-name]']=element();
 const host={querySelector:key=>fields[key]||null,querySelectorAll:()=>[...buttons,...(fields['[data-recommender-name]']?[fields['[data-recommender-name]']]:[])]};
 const transport={context:()=>context,subscribe(fn){subscriber=fn;return()=>subscriber=null;},async request(url,options){requests.push({url,options});
  if(url.startsWith('/recommendations/friends'))return friends ? friends(url) : {friends:[{account_ref:A,display_name:'Eli'}],next_cursor:null};
  if(post)return post(url,options);return {ok:true};}};
 const c={console,AbortController,crypto:{randomUUID:()=>B},state:{view:{}},document:{createElement:element},
  window:{location:{href:'https://app.test/'},AlbumHavenPrivateUITransport:transport,AlbumHavenRecommendationPresentation:p,dispatchEvent:event=>events.push(event)},
  CustomEvent:class {constructor(type){this.type=type;}},ButtonComponent:{renderButton:props=>`<button>${escape(props.label)}</button>`},showToast:()=>{},
  showAppFormDialog(options){form=options;return new Promise(done=>{resolve=done;options.onMount(host,{setSubmitEnabled(value){form.enabled=value;},close(){options.onClose();done(null);}});});}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(ROOT,'music_app/static/js/runtime/recommendations.js'),'utf8'),c);
 const promise=c.window.AlbumHavenRecommendations.open({kind:'track',resource_ref:'inventory-track:1:2',...resource,manual,isCurrent:()=>alive});await tick();
 return {c,requests,buttons,fields,events,form,promise,setAlive:value=>alive=value,invalidate(){context='b'.repeat(64);subscriber?.();},close(){form.onClose();resolve(null);}};
}

test('friend selection is explicit and an uncertain retry preserves its request key and body',async()=>{
 let tries=0;const f=await fixture({post:()=>{if(++tries===1)throw new Error('lost reply');return {ok:true};}});
 assert.equal(f.requests.length,1);assert.equal(f.form.enabled,false);f.buttons[0].listeners.click();assert.equal(f.form.enabled,true);
 await assert.rejects(f.form.onSubmit(),/Retry sends the same request/);const first=f.requests[1].options.body;
 assert.equal(first.recipient_account_ref,A);assert.equal(first.request_key,B);
 await f.form.onSubmit();assert.strictEqual(f.requests[2].options.body,first);assert.equal(f.events.length,1);f.close();await f.promise;
});

test('manual names are plain explicit attributions and typing clears a selected account',async()=>{
 const f=await fixture({manual:true});f.buttons[0].listeners.click();const input=f.fields['[data-recommender-name]'];input.value='  My guitar teacher  ';input.listeners.input();
 await f.form.onSubmit();assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].options.body.recommender)),{name:'My guitar teacher'});f.close();await f.promise;
});

test('stale source or changed private context cannot submit or revive the dialog',async()=>{
 const f=await fixture();f.buttons[0].listeners.click();f.setAlive(false);await assert.rejects(f.form.onSubmit(),/source changed/);assert.equal(f.requests.length,1);
 f.invalidate();await f.promise;assert.equal(f.requests[0].options.signal.aborted,true);
});

test('playlist projection carries attribution only for readable rows',async()=>{
 const {normalizePlaylistPayload}=await import(path.join(ROOT,'music_app/static/js/playlists/model.mjs'));
 const payload={playlist_sidebar:{items:[{playlist_id:A,playlist_kind:'recommended_by'}]},playlist_detail:{playlist_id:A,playlist_kind:'recommended_by',track_rows:[
  {playlist_item_id:A,title:'Track',recommended_by:[{display_name:'Eli',account_ref:A}]},{playlist_item_id:B,source_readable:false,recommended_by:[{display_name:'Secret',account_ref:B}]}]}};
 const output=normalizePlaylistPayload(payload);assert.equal(output.detail.track_rows[0].recommended_by[0].display_name,'Eli');assert.equal(output.detail.track_rows[1].recommended_by,undefined);
});

test('catalog albums require an exact authorized Top witness and manual names are bounded',async()=>{
 const p=await model(),source={top_ref:A,item_ref:B,revision:'12'};
 assert.deepEqual(p.recommendationResource('album',`catalog-album:${A}`,source),{kind:'album',resource_ref:`catalog-album:${A}`,source});
 assert.equal(p.recommendationResource('album',`catalog-album:${A}`),null);
 assert.equal(p.recommendationResource('track',`catalog-album:${A}`,source),null);
 assert.equal(p.manualRecommenderName('  Teacher  '),'Teacher');
 for(const name of [' ','a'.repeat(101),'name\u202eevil','name\u0001'])assert.equal(p.manualRecommenderName(name),null);
});

test('friend picker follows cursors without duplicating earlier people',async()=>{
 const f=await fixture({friends:url=>url.includes('?') ? {friends:[{account_ref:A,display_name:'Eli'},{account_ref:B,display_name:'Sam'}],next_cursor:null} : {friends:[{account_ref:A,display_name:'Eli'}],next_cursor:'next/+='}});
 await f.fields['[data-recommendation-more]'].listeners.click();
 assert.equal(f.buttons.length,2);assert.equal(f.requests[1].url,'/recommendations/friends?cursor=next%2F%2B%3D');assert.equal(f.fields['[data-recommendation-more]'].hidden,true);
 f.close();await f.promise;
});

test('Top adapter preserves recommended metadata without inventing native authority',async()=>{
 const {createAlbumTopBackendProviders}=await import(path.join(ROOT,'music_app/static/js/album-tops/backend-providers.mjs'));
 const context='a'.repeat(64),raw={top_ref:A,title:'Recommended By',description:'',revision:'1',visibility:'private',top_kind:'recommended_by',allowed_actions:{},items:[{ref:B,catalog_ref:A,title:'Remote album',artist_display:'Artist',release_year:1974,source_kind:'recommendation_summary',native_album:null,recommended_by:[{display_name:'Eli',account_ref:B}]}]};
 const providers=createAlbumTopBackendProviders({transport:{context:()=>context,request:async()=>({status:'ready',context_ref:context,data:raw})},acceptsScope:()=>true});
 try {const detail=await providers.read(A,{scopeKey:'test'});assert.equal(detail.top_kind,'recommended_by');assert.equal(detail.items[0].source_kind,'recommendation_summary');assert.equal(detail.items[0].native_album,null);assert.equal(detail.items[0].recommended_by[0].account_ref,B);} finally {providers.dispose();}
});

test('saved songs require a canonical Playlist-item witness and a bounded string revision', async () => {
 const p = await model(), ref = `playlist-item:${B}`, source = {playlist_ref:A,revision:'9223372036854775807'};
 assert.deepEqual(p.recommendationResource('track',ref,source), {kind:'track',resource_ref:ref,source});
 for (const revision of ['0','01','-1','1.0',1,'9223372036854775808','99999999999999999999'])
  assert.equal(p.recommendationResource('track',ref,{...source,revision}),null);
 for (const value of [null,{}, {playlist_ref:'not-a-playlist',revision:'1'}]) assert.equal(p.recommendationResource('track',ref,value),null);
 assert.equal(p.recommendationResource('album',ref,source),null);
 assert.equal(p.recommendationResource('track',`playlist-item:${B}/extra`,source),null);
 const safe=p.recommendationResource('track',ref,{...source,metadata_occurrence_ref:A,title:'client-supplied'});
 assert.deepEqual(Object.keys(safe.source),['playlist_ref','revision']);
 assert.equal(p.sameRecommendationResource(safe,{...safe,source:{...source,revision:'1'}}),false);
 assert.equal(p.sameRecommendationResource(safe,{...safe,source:{...source,playlist_ref:B}}),false);
 assert.equal(p.sameRecommendationResource(safe,{...safe,resource_ref:`playlist-item:${A}`}),false);
 assert.equal(p.sameRecommendationResource(safe,{...safe,source:{...source}}),true);
});

test('the dedicated one-row resolver does not borrow inventory or queue resolution', async () => {
 const p=await model(), packet={scopeKey:'s',row_keys:['x']}, lifetime={isCurrent:()=>true};
 const resource={kind:'track',resource_ref:`playlist-item:${B}`,source:{playlist_ref:A,revision:'1'}};
 const instance={}, adapter={snapshot:()=>({scopeKey:'s',instance,revision:'v'}),
  resolveRows:()=>assert.fail('metadata recommendation must not enter the inventory resolver'),
  resolveRecommendationRows:()=>({rows:[resource]})};
 assert.deepEqual(p.singleRecommendedTrack(packet,lifetime,adapter),resource);
 adapter.resolveRecommendationRows=()=>null;
 assert.equal(p.singleRecommendedTrack(packet,lifetime,adapter),null,'no fallback on dedicated denial');
 adapter.resolveRecommendationRows=()=>({rows:[resource,resource]});
 assert.equal(p.singleRecommendedTrack(packet,lifetime,adapter),null);
 let revision='v'; adapter.snapshot=()=>({scopeKey:'s',instance,revision});
 adapter.resolveRecommendationRows=()=>{revision='changed';return {rows:[resource]};};
 assert.equal(p.singleRecommendedTrack(packet,lifetime,adapter),null,'reentrant view retirement fails closed');
});

async function contextFixture() {
 const p=await model(), {createPlaytableSelection}=await import(path.join(ROOT,'music_app/static/js/playtables/selection.mjs'));
 let current={scopeKey:'s',instance:{},revision:'view:1',rows:['x','y'].map(rowKey=>({rowKey,readable:true,selectable:true}))};
 let resource={kind:'track',resource_ref:`playlist-item:${B}`,source:{playlist_ref:A,revision:'1'}};
 const adapter={snapshot:()=>current,subscribe:()=>()=>{},resolveRecommendationRows:()=>({rows:[resource]}),canQueue:()=>false};
 const selection=createPlaytableSelection({sourceAdapter:adapter});selection.select('x');
 const action=selection.action(), opened=[]; let choices;
 const context={recommendationPresentation:p,window:{AlbumHavenPlaylistRuntime:{openChoice(anchor,value){choices=value;return {}; }},
  AlbumHavenRecommendations:{open(value){opened.push(value);return new Promise(()=>{});}}}};
 vm.createContext(context);
 const source=fs.readFileSync(path.join(ROOT,'music_app/static/js/home-friends/index-native.mjs'),'utf8');
 const start=source.indexOf('function openPlaytableContext('),end=source.indexOf('window.AlbumHavenPlaytableUI =',start);
 assert.ok(start>=0 && end>start);vm.runInContext(source.slice(start,end),context);
 assert.equal(context.openPlaytableContext(action.packet,action.lifetime,adapter,{}),true);
 return {selection,action,opened,get choices(){return choices;},changeWitness(patch){resource={...resource,source:{...resource.source,...patch}};},
  replaceView(patch){current={...current,...patch};selection.update();}};
}

test('the actual row menu offers both metadata actions but no queue for an unresolved song', async () => {
 const f=await contextFixture();
 assert.deepEqual(Array.from(f.choices.formats,x=>x.value),['new','add','recommend','recommend-manual']);
 assert.equal(f.choices.onSelect('recommend-manual'),true);
 assert.equal(f.opened[0].manual,true);assert.deepEqual(f.opened[0].source,{playlist_ref:A,revision:'1'});
 assert.equal(f.opened[0].isCurrent(),true);f.selection.dispose();assert.equal(f.opened[0].isCurrent(),false);
});
for (const phase of ['before-open','after-open']) for (const change of ['revision','playlist','selection','scope','instance','view']) {
 test(`metadata recommendation retires on ${change} ${phase}`,async()=>{
  const f=await contextFixture();
  if(phase==='after-open')assert.equal(f.choices.onSelect('recommend'),true);
  if(change==='revision')f.changeWitness({revision:'2'});
  if(change==='playlist')f.changeWitness({playlist_ref:B});
  if(change==='selection')f.selection.select('y',{toggle:true});
  if(change==='scope')f.replaceView({scopeKey:'new'});
  if(change==='instance')f.replaceView({instance:{}});
  if(change==='view')f.replaceView({revision:'view:2'});
  if(phase==='before-open'){assert.equal(f.choices.onSelect('recommend'),false);assert.equal(f.opened.length,0);}
  else assert.equal(f.opened[0].isCurrent(),false);
  f.selection.dispose();
 });
}

test('metadata friend/manual submit retains the full detached witness and uncertain replay body',async()=>{
 for(const manual of [false,true]) {
  let attempts=0;const source={playlist_ref:A,revision:'1'};
  const f=await fixture({manual,resource:{kind:'track',resource_ref:`playlist-item:${B}`,source},
   post:()=>{if(++attempts===1)throw new Error('lost reply');return {ok:true};}});
  source.revision='2';f.buttons[0].listeners.click();
  await assert.rejects(f.form.onSubmit(),/Retry sends the same request/);
  const body=f.requests[1].options.body;
  assert.deepEqual(body.source,{playlist_ref:A,revision:'1'});assert.equal(body.resource_ref,`playlist-item:${B}`);
  assert.equal(f.requests[1].url,manual?'/recommendations/manual':'/recommendations');
  await f.form.onSubmit();assert.strictEqual(f.requests[2].options.body,body);f.close();await f.promise;
 }
});

for(const change of ['route','view','session','source']) {
 test(`the metadata dialog cannot submit after ${change} retirement`,async()=>{
  const f=await fixture({resource:{kind:'track',resource_ref:`playlist-item:${B}`,source:{playlist_ref:A,revision:'1'}}});
  f.buttons[0].listeners.click();
  if(change==='route')f.c.window.location.href='https://app.test/?surface=home';
  if(change==='view')f.c.state.view={};
  if(change==='session')f.invalidate();
  if(change==='source')f.setAlive(false);
  await assert.rejects(f.form.onSubmit(),/source changed/);assert.equal(f.requests.length,1);
  f.c.window.AlbumHavenRecommendations.reconcile();await f.promise;
  assert.equal(f.requests[0].options.signal.aborted,true);
 });
}
