'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {id,SCOPE,recipe,capture,receipt,deferred,plain}=require('./library-mix-fixtures.cjs');
const {nativeMixFixture}=require('./library-mix-react-fixture.cjs');
let normalizeArtistMixScope,captureArtistMixScope,createLibraryMixController;
test.before(async()=>{
 ({normalizeArtistMixScope,captureArtistMixScope}=await import('../../../music_app/static/js/playlists/library-mix-recipe.mjs'));
 ({createLibraryMixController}=await import('../../../music_app/static/js/playlists/library-mix.mjs'));
});
const scope=()=>({kind:'selected_artists',artist_ids:['7'],memberships:[{artist_id:'7',basis:'primary_credit'}],
 album_order:['20','10'],categories:['main_library'],album_types:['studio','ep']});
function result(options=recipe(),patch={}){
 return capture({source_protocol:'artist_popular_selection_v1',library_mix:{version:2,source:'artist_selection',
  provider:'lastfm',metric:'overall_scrobbles',...options,scope:scope()},...patch});
}
function fixture(t,overrides={}){
 let current=true;const calls={begin:[],regenerate:[],save:[]};
 const providers={beginArtistMix:async options=>{calls.begin.push(options);return result(options.recipe);},
  regenerateArtistMix:async options=>{calls.regenerate.push(options);return result(options.recipe,{source:{kind:'library',ref:id(4),revision:id(5)}});},
  createPlaylistFromSelection:async options=>{calls.save.push(options);return receipt(options.request_key);},...overrides};
 const controller=createLibraryMixController({providers,scopeKey:SCOPE,isCurrent:()=>current,artistScope:scope(),requestKey:()=>id(90)});
 t.after(()=>controller.dispose());return {controller,calls,retire(){current=false;}};
}

test('Artist IDs and bounded filters are canonical, immutable and never inferred from labels',()=>{
 const value=normalizeArtistMixScope(scope());assert.deepEqual(plain(value),scope());assert.ok(Object.isFrozen(value.memberships[0]));
 for(const bad of [7,'07','Artist/path','9223372036854775808',null]){
  const input=scope();input.artist_ids=[bad];input.memberships[0].artist_id=bad;assert.equal(normalizeArtistMixScope(input),null);
 }
 for(const field of ['categories','album_types']){
  assert.equal(normalizeArtistMixScope({...scope(),[field]:['unknown']}),null);
  assert.deepEqual(normalizeArtistMixScope({...scope(),[field]:[]})[field],[]);
 }
 const identity={kind:'selected_artists',artist_ids:['7'],memberships:[{artist_id:'7',basis:'primary_credit'}],album_order:['20','10']};
 const groups=[{artist:'Display alias',popular_selection_scope:identity}];
 assert.deepEqual(plain(captureArtistMixScope(groups,[{popular_album_id:'10'},{popular_album_id:'20'}],scope())),{...scope(),album_order:['10','20']});
 assert.equal(captureArtistMixScope(groups,[{album_id:10,key:'10',name:'10'}],scope()),null);
 assert.equal(captureArtistMixScope([],[],scope()),null);
});

test('scoped capture uses its own source protocol and retains crowd order with no write or playback',async t=>{
 const h=fixture(t),c=h.controller;assert.equal(await c.prepare(recipe()),true);
 assert.deepEqual(plain(h.calls.begin[0].artistScope),scope());assert.equal(h.calls.save.length,0);
 assert.equal(c.source().source_protocol,'artist_popular_selection_v1');
 assert.deepEqual(c.source().entry_refs,[id(11),id(12),id(13)]);
 assert.deepEqual(c.source().detail.track_rows.map(row=>row.popularity_count),[999,998,997]);
 assert.deepEqual(c.source().detail.track_rows.map(row=>row.play_count),[7,0,null]);
});

test('quota changes regenerate only the captured receipt and retain original scope',async t=>{
 const h=fixture(t),c=h.controller;await c.prepare(recipe());const old=c.source();
 assert.equal(await c.prepare(recipe({songs_per_group:5,auto_update:true})),true);
 assert.equal(h.calls.begin.length,1);assert.equal(h.calls.regenerate.length,1);
 assert.deepEqual(h.calls.regenerate[0].source,old.source);
 assert.equal(Object.hasOwn(h.calls.regenerate[0],'artistScope'),false);
 assert.equal(c.source().source.ref,id(4));assert.deepEqual(plain(c.source().artistScope),scope());
 assert.equal(h.calls.save.length,0);
});

test('failed metadata regeneration retains fixed captured list; successful retry clears its warning',async t=>{
 let fail=true;const h=fixture(t,{regenerateArtistMix:async options=>{if(fail)throw Object.assign(new Error('offline'),{status:503});return result(options.recipe);}});
 await h.controller.prepare(recipe());const original=h.controller.source();
 assert.equal(await h.controller.prepare(recipe({songs_per_group:4})),false);
 assert.equal(h.controller.source(),original);assert.equal(h.controller.getSnapshot().selectionError,true);
 fail=false;assert.equal(await h.controller.prepare(recipe({songs_per_group:4})),true);
 assert.equal(h.controller.getSnapshot().selectionError,false);
});

test('scope loss retires a delayed capture and cannot publish or save its rows',async t=>{
 const pending=deferred(),h=fixture(t,{beginArtistMix:()=>pending.promise});
 const attempt=h.controller.prepare(recipe());h.retire();h.controller.dispose();pending.resolve(result());
 assert.equal(await attempt,false);assert.equal(h.controller.source(),null);assert.equal(h.calls.save.length,0);
});

test('foreign scope, whole-library protocol and unacknowledged options cannot become scoped preview',async t=>{
 for(const patch of [{source_protocol:'library_mix_selection_v1'},
  {library_mix:{...result().data.library_mix,scope:{...scope(),artist_ids:['8'],memberships:[{artist_id:'8',basis:'primary_credit'}]}}},
  {library_mix:{...result().data.library_mix,songs_per_group:9}}]){
  const h=fixture(t,{beginArtistMix:async()=>result(recipe(),patch)});
  assert.equal(await h.controller.prepare(recipe()),false);assert.equal(h.controller.source(),null);assert.equal(h.calls.save.length,0);
 }
});

test('native scoped page gives non-listening viewers Save and editable shared quota controls',async t=>{
 const env=await nativeMixFixture(t),h=fixture(t,{beginArtistMix:async()=>result(recipe(),{
  allowed_actions:{can_read:true,can_use_for_playlist:true,can_play:false},
  entries:result().data.entries.map(row=>({...row,allowed_actions:{can_read:true,can_select:true,can_play:false}}))})});
 await h.controller.prepare(recipe());
 const mounted=env.mount('page',{controller:h.controller,runtime:env.mixRuntime(h.controller)});
 t.after(()=>mounted.unmount());
 assert.equal(env.named('Play',mounted.host).disabled,true);
 assert.equal(env.named('Save as playlist',mounted.host).disabled,false);
 const input=mounted.host.querySelector('[aria-label="Songs per group"]');assert.equal(input.value,'3');
 input.value='4';await env.flush(()=>input.dispatchEvent(new env.c.Event('input',{bubbles:true})));
 assert.equal(env.named('Save as playlist',mounted.host).disabled,true);
 assert.equal(env.named('Update selection',mounted.host).disabled,false);
 await env.click(env.named('Update selection',mounted.host));await env.settle();
 assert.equal(h.calls.regenerate.length,1);assert.equal(h.calls.regenerate[0].recipe.songs_per_group,4);
 assert.equal(env.named('Save as playlist',mounted.host).disabled,false);
 assert.equal(h.calls.save.length,0);
 mounted.unmount();h.controller.dispose();
 assert.equal(mounted.host.querySelector('[aria-label="Songs per group"]'),null);
});

test('retained filter intent agrees with the actual Gallery classification and provenance owner',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const context=vm.createContext({window:{innerWidth:1000}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/gallery-main-state.js'),'utf8')+
  '\nthis.classify=classifyGalleryReleaseType;this.sources=resolveGalleryAlbumSources;',context);
 for(const [album,sources,type] of [
  [{root_provenance:{primary_category:'main_library',categories:['hoard']}},['hoard'],'studio'],
  [{root_provenance:{categories:[' HOARD ']}},['hoard'],'studio'],
  [{root_provenance:{categories:['unknown']}},['main_library'],'studio'],
  [{library_root_category:'new_arrivals'},['new_arrivals'],'studio'],
  [{releaseType:'compilations'},['main_library'],'compilation'],
  [{release_type:'live'},['main_library'],'studio'],
  [{is_compilation:true},['main_library'],'compilation'],
 ]){assert.deepEqual(plain(context.sources(album)),sources);assert.equal(context.classify(album),type);}
});

test('actual native queue routes Artist receipts separately and rejects whole-library acknowledgement',async()=>{
 const {nativeFixture}=require('./library-mix-native-fixture.cjs');const h=nativeFixture();let wrong=false;
 h.c.fetch=async(url,options)=>{
  assert.equal(url,'/playlists/creation-source/artist-popular/native-queue');
  h.calls.requests.push({url,options});
  return h.reply(JSON.parse(options.body),{mutate:reply=>{
   reply.data.source_protocol=wrong?'library_mix_selection_v1':'artist_popular_selection_v1';return reply;
  }});
 };
 const input={sourceRef:id(1),sourceRevision:id(2),entryRefs:[id(11),id(12)],startingEntryRef:id(11),sourceProtocol:'artist_popular_selection_v1'};
 const result=await h.c.readLibraryMixNativeQueue(input);
 assert.deepEqual(plain(result.tracks.map(row=>row.playlist_item_id)),input.entryRefs);
 assert.equal(h.calls.starts.length,0);assert.equal(h.calls.requests.length,1);
 wrong=true;await assert.rejects(h.c.readLibraryMixNativeQueue(input),/not acknowledged/);
 assert.equal(h.calls.starts.length,0);assert.equal(h.calls.requests.length,2);
 await assert.rejects(h.c.readLibraryMixNativeQueue({...input,sourceProtocol:'unknown'}),/protocol/);
 assert.equal(h.calls.requests.length,2);
});

test('actual native entry captures Artist intent and opens the shared setup with visible default quota',async t=>{
 const env=await nativeMixFixture(t),calls=[];
 await env.boot({beginArtistMix:async options=>{calls.push(options);return result(options.recipe,{scopeKey:options.scopeKey});}});
 const identity=scope();delete identity.categories;delete identity.album_types;
 const input={groups:[{popular_selection_scope:identity}],albums:[{popular_album_id:'20'},{popular_album_id:'10'}],filters:scope()};
 assert.equal(env.c.AlbumHavenPlaylistUI.openArtistPopular({...input,albums:[{key:'20'}]}),false);
 assert.equal(calls.length,0);
 assert.equal(env.c.AlbumHavenPlaylistUI.openArtistPopular(input),true);await env.settle();
 const count=env.c.document.querySelector('[aria-label="Songs per group"]');
 assert.ok(count);assert.equal(count.value,'3');assert.ok(env.named('Create mix'));
 // No capture, Save or playback occurs merely by opening the shared setup.
 assert.equal(calls.length,0);assert.equal(env.calls.starts.length,0);
 await env.click(env.named('Cancel'));await env.settle();
 assert.equal(env.c.document.querySelector('[aria-label="Songs per group"]'),null);
 assert.equal(calls.length,0);assert.equal(env.calls.starts.length,0);
});

test('actual provider sends scoped wire bodies, removes private diagnostics and rejects stale source ownership',async t=>{
 const {createPlaylistBackendProviders}=await import('../../../music_app/static/js/playlists/backend-providers.mjs');
 let context='context-a',invalidate;const calls=[];
 const providers=createPlaylistBackendProviders({runtime:{snapshot:()=>({scopeKey:SCOPE})},transport:{
  context:()=>context,subscribe:fn=>{invalidate=fn;return()=>{};},
  request:async(url,options)=>{calls.push({url,options});return result(options.body.recipe,{diagnostics:[{inventory_track_ref:'inventory-track:5:9'}]});},
 }});t.after(()=>providers.dispose());
 const first=await providers.beginArtistMix({scopeKey:SCOPE,artistScope:scope(),recipe:recipe()});
 assert.equal(calls[0].url,'/playlists/creation-source/artist-popular');
 assert.deepEqual(calls[0].options.body,{scope:scope(),recipe:recipe()});
 assert.equal(Object.hasOwn(first.data,'diagnostics'),false);assert.equal(Object.hasOwn(first.data,'actor_scope'),false);
 await providers.regenerateArtistMix({scopeKey:SCOPE,source:first.data.source,recipe:recipe({songs_per_group:4})});
 assert.equal(calls[1].url,'/playlists/creation-source/artist-popular/regenerate');
 assert.deepEqual(calls[1].options.body,{source_ref:id(1),source_revision:id(2),recipe:recipe({songs_per_group:4})});
 context='context-b';invalidate();
 await assert.rejects(providers.regenerateArtistMix({scopeKey:SCOPE,source:first.data.source,recipe:recipe()}),/unavailable/);
 assert.equal(calls.length,2);
});

test('delayed failed regeneration restores exact source while retaining live metadata edits',async t=>{
 const env=await nativeMixFixture(t),pending=deferred(),h=fixture(t,{regenerateArtistMix:()=>pending.promise});
 t.after(()=>pending.resolve(result()));await h.controller.prepare(recipe());const original=h.controller.source();
 const page=env.mount('page',{controller:h.controller,runtime:env.mixRuntime(h.controller),onClose(){},onSaved(){}});
 const count=page.host.querySelector('[aria-label="Songs per group"]');count.value='4';
 env.flush(()=>count.dispatchEvent(new env.c.Event('input',{bubbles:true})));env.click(env.named('Update selection',page.host));await env.settle();
 assert.equal(h.controller.source(),null);assert.equal(env.named('Play',page.host).disabled,true);
 for(const [label,value] of [['Playlist title','Edited while waiting'],['Playlist description','Keep this description']]){
  const input=page.host.querySelector(`[aria-label="${label}"]`);assert.ok(input);assert.equal(input.disabled,false);
  input.value=value;env.flush(()=>input.dispatchEvent(new env.c.Event('input',{bubbles:true})));
 }
 env.choose('Playback order','shuffle');await env.settle();
 pending.reject(Object.assign(new Error('offline'),{status:503}));await env.settle();
 assert.equal(h.controller.source(),original);assert.deepEqual(h.controller.source().entry_refs,original.entry_refs);
 assert.equal(h.controller.getSnapshot().title,'Edited while waiting');assert.equal(h.controller.getSnapshot().description,'Keep this description');
 assert.equal(h.controller.getSnapshot().playbackOrder,'shuffle');assert.equal(h.controller.getSnapshot().selectionError,true);
 assert.equal(page.host.querySelector('[aria-label="Playlist title"]').value,'Edited while waiting');
 assert.equal(page.host.querySelector('[aria-label="Playlist description"]').value,'Keep this description');
 assert.ok(env.named('Playback order: Shuffle',page.host));assert.equal(h.calls.save.length,0);assert.equal(env.calls.starts.length,0);
});

for(const departure of ['close','navigation'])test(`actual native ${departure} retires delayed Artist regeneration`,async t=>{
 const env=await nativeMixFixture(t),pending=deferred(),captures=[],regenerations=[],returns=[];
 t.after(()=>pending.resolve(result()));env.installNavigation();env.c.history.go=delta=>{returns.push(delta);};
 env.state.view={context_ref:'a'.repeat(64),surface:{active:'albums'}};env.runtime.sync();
 env.runtime.confirmDraft=async()=>true;
 await env.boot({readPlaylists:async()=>({playlist_sidebar:{items:[]},playlist_index:{playlists:[]}}),
  beginArtistMix:async options=>{captures.push(options);return result(options.recipe,{scopeKey:options.scopeKey});},
  regenerateArtistMix:options=>{regenerations.push(options);return pending.promise;}});
 const identity=scope();delete identity.categories;delete identity.album_types;
 assert.equal(env.c.AlbumHavenPlaylistUI.openArtistPopular({groups:[{popular_selection_scope:identity}],
  albums:[{popular_album_id:'20'},{popular_album_id:'10'}],filters:scope()}),true);
 await env.settle();env.click(env.named('Create mix'));await env.settle();assert.equal(captures.length,1);
 const count=env.host.querySelector('[aria-label="Songs per group"]');count.value='4';
 env.flush(()=>count.dispatchEvent(new env.c.Event('input',{bubbles:true})));env.click(env.named('Update selection'));await env.settle();
 assert.equal(regenerations.length,1);assert.equal(regenerations[0].signal.aborted,false);
 if(departure==='close'){env.click(env.named('Close mix'));await env.settle();assert.equal(returns.length,1);}
 else{
  const navigation=env.c.AlbumHavenSettingsNavigation.instance;
  assert.equal(await navigation.deferPlaylistDraftNavigation(()=>{navigation.writeLibraryHistory('/?artist=Other',{}, {mode:'push'});return true;}),true);
  await env.settle();assert.equal(env.c.location.search,'?artist=Other');
 }
 assert.equal(regenerations[0].signal.aborted,true);
 pending.resolve(result(regenerations[0].recipe,{scopeKey:regenerations[0].scopeKey,source:{kind:'library',ref:id(4),revision:id(5)}}));await env.settle();
 assert.equal(env.host.querySelector('main[aria-label="Temporary Library Mix"]'),null);
 assert.equal(env.c.history.state.playlistDraft,undefined);assert.equal(env.calls.starts.length,0);
});

test('Artist regeneration fences Play and retires a queue response from the preceding source',async t=>{
 const env=await nativeMixFixture(t),regeneration=deferred(),queue=deferred(),h={calls:{save:[]}};
 const scopeKey=env.runtime.snapshot().scopeKey;let page=null;
 t.after(async()=>{
  try {try {page?.unmount();} finally {h.controller?.dispose();}}
  finally {regeneration.resolve(result(recipe(),{scopeKey}));queue.resolve(null);await env.settle();}
 });
 h.controller=env.api.createLibraryMixController({scopeKey,artistScope:scope(),isCurrent:()=>true,providers:{
  beginArtistMix:async options=>result(options.recipe,{scopeKey}),regenerateArtistMix:()=>regeneration.promise,
  createPlaylistFromSelection:async options=>{h.calls.save.push(options);return receipt(options.request_key,{scopeKey});},
 }});
 await h.controller.prepare(recipe());
 assert.equal(h.controller.getSnapshot().scopeKey,env.runtime.snapshot().scopeKey);
 page=env.mount('page',{controller:h.controller,runtime:env.mixRuntime(h.controller),onClose(){},onSaved(){}});
 env.c.fetch=async(url,options)=>{assert.equal(url,'/playlists/creation-source/artist-popular/native-queue');env.calls.requests.push({url,options});return queue.promise;};
 env.click(env.named('Play',page.host));await env.settle();assert.equal(env.calls.requests.length,1);
 const attempt=h.controller.prepare(recipe({songs_per_group:4}));await env.settle();
 assert.equal(env.named('Play',page.host).disabled,true);assert.equal(env.calls.starts.length,0);
 const oldBody=JSON.parse(env.calls.requests[0].options.body);
 queue.resolve(env.reply(oldBody,{mutate:reply=>{reply.data.source_protocol='artist_popular_selection_v1';return reply;}}));await env.settle();
 assert.equal(env.calls.starts.length,0,'retired source cannot start playback');
 regeneration.resolve(result(recipe({songs_per_group:4}),{scopeKey,source:{kind:'library',ref:id(4),revision:id(5)}}));assert.equal(await attempt,true);await env.settle();
 env.c.fetch=async(url,options)=>{env.calls.requests.push({url,options});return env.reply(JSON.parse(options.body),{mutate:reply=>{reply.data.source_protocol='artist_popular_selection_v1';return reply;}});};
 env.click(env.named('Play',page.host));await env.settle();
 assert.equal(env.calls.requests.length,2);assert.equal(JSON.parse(env.calls.requests[1].options.body).source_ref,id(4));
 assert.equal(env.calls.starts.length,1);assert.equal(h.calls.save.length,0);
});

test('actual Gallery action hands filtered explicit family scope to native Artist setup',async t=>{
 const env=await nativeMixFixture(t),calls=[];
 env.state.view={context_ref:'a'.repeat(64),surface:{active:'albums'},selected_artist:'Primary'};env.runtime.sync();
 await env.boot({beginArtistMix:async options=>{calls.push(options);return result(options.recipe,{scopeKey:options.scopeKey,
  library_mix:{version:2,source:'artist_selection',provider:'lastfm',metric:'overall_scrobbles',...options.recipe,scope:options.artistScope}});}});
 env.load('runtime/gallery-main-state.js');env.load('runtime/gallery-main-components.js');env.load('runtime/gallery-main-interactions.js');
 const member=(name,id,albums)=>({artist:name,popular_selection_scope:{kind:'selected_artists',artist_ids:[id],
  memberships:[{artist_id:id,basis:'family_credit'}],album_order:albums.map(a=>a.popular_album_id)},albums});
 const album=(id,category,compilation=false)=>({popular_album_id:id,title:id,root_provenance:{categories:[category]},is_compilation:compilation});
 const primary=member('Primary','7',[album('10','hoard')]);
 const selected=member('Chosen family','8',[album('20','hoard'),album('21','main_library'),album('22','hoard',true)]);
 const excluded=member('Other family','9',[album('30','hoard')]);
 Object.assign(env.state.view,{primary_artist_groups:[primary],family_artist_groups:[selected,excluded],related_artists:['Chosen family','Other family']});
 env.state.gallery={mainState:{sources:{main_library:false,new_arrivals:false,hoard:true},albumTypes:['studio'],view:'cards',familyArtists:['Chosen family'],familySelectionExplicit:true}};
 const bar=env.add('artist-popular-gallery');bar.innerHTML=env.c.buildGalleryBarHtml({contextKind:'family',primaryArtist:'Primary'});
 const action=bar.querySelector('[data-gallery-bar-action="popular-tracks"]');assert.ok(action);action.hidden=false;
 const handler=event=>env.c.handleGalleryMainClick(event);bar.addEventListener('click',handler);t.after(()=>bar.removeEventListener('click',handler));
 env.click(action);await env.settle();assert.equal(calls.length,0);assert.ok(env.named('Create mix'));
 env.click(env.named('Create mix'));await env.settle();assert.equal(calls.length,1);
 assert.deepEqual(plain(calls[0].artistScope),{kind:'selected_artists',artist_ids:['8'],memberships:[{artist_id:'8',basis:'family_credit'}],
  album_order:['20'],categories:['hoard'],album_types:['studio']});assert.equal(env.calls.starts.length,0);
});

for(const order of ['module-first','gallery-first'])test(`deep-linked Artist Popular trigger becomes actionable with ${order} readiness`,async t=>{
 const env=await nativeMixFixture(t),calls=[];
 const identity={kind:'selected_artists',artist_ids:['7'],memberships:[{artist_id:'7',basis:'primary_credit'}],album_order:['20']};
 const group={artist:'Primary',popular_selection_scope:identity,albums:[{popular_album_id:'20',title:'Album'}]};
 env.state.view={context_ref:'a'.repeat(64),surface:{active:'albums'},selected_artist:'Primary',primary_artist_groups:[group],family_artist_groups:[]};
 env.state.gallery={};env.c.location.href='https://albumhaven.test/?artist=Primary';env.runtime.sync();
 env.load('runtime/gallery-main-state.js');env.load('runtime/gallery-main-components.js');env.load('runtime/gallery-main-interactions.js');env.load('unfolding-action-button.js');
 const boot=()=>env.boot({beginArtistMix:async options=>{calls.push(options);return result(options.recipe,{scopeKey:options.scopeKey});}});
 if(order==='module-first')await boot();
 const bar=env.add('gallery-readiness');bar.innerHTML=env.c.buildGalleryBarHtml({contextKind:'artist',artist:'Primary'});
 const action=bar.querySelector('[data-gallery-bar-action="popular-tracks"]');assert.equal(action.hidden,true);
 env.c.updateGalleryMainControls();await env.settle();
 assert.equal(action.hidden,false);assert.equal(action.disabled,order==='gallery-first');
 if(order==='gallery-first'){await boot();await env.settle();}
 assert.equal(action.hidden,false);assert.equal(action.disabled,false);
 const handler=event=>env.c.handleGalleryMainClick(event);bar.addEventListener('click',handler);t.after(()=>bar.removeEventListener('click',handler));
 env.click(action);await env.settle();assert.ok(env.named('Create mix'));assert.equal(calls.length,0);
 env.click(env.named('Cancel'));await env.settle();
 // A retained enabled DOM action still rereads current selection at activation.
 env.state.view.selected_artist='';
 env.click(action);await env.settle();assert.equal(env.form.hidden,true);assert.equal(calls.length,0);
 env.c.updateGalleryMainControls();assert.equal(action.hidden,true);assert.equal(action.disabled,true);
 env.state.view.selected_artist='Primary';group.popular_selection_scope=null;
 env.c.updateGalleryMainControls();assert.equal(action.hidden,false);assert.equal(action.disabled,true);
 action.dispatchEvent(new env.c.MouseEvent('click',{bubbles:true}));await env.settle();assert.equal(env.form.hidden,true);
 group.popular_selection_scope={...identity,artist_ids:['bad']};env.c.updateGalleryMainControls();assert.equal(action.disabled,true);
 group.popular_selection_scope=identity;env.c.updateGalleryMainControls();assert.equal(action.disabled,false);
 bar.remove();action.dispatchEvent(new env.c.MouseEvent('click',{bubbles:true}));await env.settle();
 assert.equal(env.form.hidden,true);assert.equal(calls.length,0);assert.equal(env.calls.starts.length,0);
});

test('late native readiness observes current non-Artist context instead of an earlier Gallery selection',async t=>{
 const env=await nativeMixFixture(t);env.state.view={context_ref:'a'.repeat(64),surface:{active:'albums'},selected_artist:'Earlier',primary_artist_groups:[],family_artist_groups:[]};
 env.state.gallery={};env.runtime.sync();
 env.load('runtime/gallery-main-state.js');env.load('runtime/gallery-main-components.js');env.load('runtime/gallery-main-interactions.js');env.load('unfolding-action-button.js');
 const bar=env.add('gallery-stale-readiness');bar.innerHTML=env.c.buildGalleryBarHtml({contextKind:'artist',artist:'Earlier'});
 env.c.updateGalleryMainControls();const action=bar.querySelector('[data-gallery-bar-action="popular-tracks"]');assert.equal(action.disabled,true);
 env.state.view.selected_artist='';await env.boot({});await env.settle();
 assert.equal(action.hidden,true);assert.equal(action.disabled,true);assert.equal(env.form.hidden,true);assert.equal(env.calls.starts.length,0);
});
