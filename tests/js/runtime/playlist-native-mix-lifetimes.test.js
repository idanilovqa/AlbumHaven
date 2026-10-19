const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./playlist-native-review-fixture.cjs');
const load=()=>import('../../../music_app/static/js/playlists/native-library-mix.mjs');
function pageProps(overrides={}){
 const listeners=new Set();let edits=0,subscriptions=0;
 const state={scopeKey:'s',resource:{status:'ready',data:null},mutation:{status:'idle'},title:'Mix',description:'',playbackOrder:'regular',coverage:{},recipe:{auto_update:true}};
 const controller={getSnapshot:()=>state,pendingSave:()=>false,canSave:()=>false,edit(){edits++;},setOrder(){},subscribe(fn){subscriptions++;listeners.add(fn);return()=>listeners.delete(fn);},...overrides};
 return {controller,onClose(){},onSaved(){},listeners,get edits(){return edits;},get subscriptions(){return subscriptions;}};
}
const savedProps=id=>({scopeKey:'s',detail:{playlist_id:id,library_mix:{playback_order:'regular'},allowed_actions:{can_play:true},track_rows:[{playlist_item_id:`${id}-one`,row_key:'one'}]}});
const publication=id=>({status:'ready',data:{scopeKey:'s',playlist_id:id,library_mix_order:'regular'}});
for(const failure of ['later control','subscribed renderer','table renderer'])test(`F4 page construction retires actual owners after ${failure} failure`,async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),baseline=h.listeners().length,props=pageProps();
 if(failure==='later control'){
  const original=h.runtime.actionHtml;
  h.runtime.actionHtml=value=>{if(value.label==='Close mix'){const trigger=h.host.querySelector('.ui-choice__trigger');h.click(trigger);throw new Error('injected failure');}return original(value);};
 }else if(failure==='subscribed renderer'){
  props.controller.getSnapshot=()=>({scopeKey:'s',resource:{status:'error'},mutation:{status:'idle'},coverage:{}});
  const alert=h.runtime.alertHtml,subscribe=props.controller.subscribe;let armed=false;
  props.controller.subscribe=fn=>{const stop=subscribe(fn);armed=true;return stop;};
  h.runtime.alertHtml=value=>{if(armed)throw new Error('injected failure');return alert(value);};
 }else{
  const detail=savedProps('mix').detail;detail.track_rows=[];
  props.controller.getSnapshot=()=>({scopeKey:'s',selectedPlaylistId:'mix',resource:{status:'ready',data:{detail}},mutation:{status:'idle'},coverage:{},drafts:{},filters:{}});
  h.runtime.tableHtml=()=>{throw new Error('injected failure');};
 }
 assert.throws(()=>mountLibraryMixPage(h.host,h.runtime,props),/injected failure/);
 assert.equal(h.host.childNodes.length,0);assert.equal(props.listeners.size,0);assert.equal(h.listeners().length,baseline);
 for(const menu of h.menus)assert.equal(menu.isOpen,false);
});
test('F4 disposed page removes retained input listeners and cannot subscribe a replacement controller',async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),props=pageProps(),next=pageProps(),baseline=h.listeners().length;
 const owner=mountLibraryMixPage(h.host,h.runtime,props),title=h.host.querySelector('input'),description=h.host.querySelector('textarea');
 owner.dispose();title.value='Detached title';description.value='Detached description';
 title.dispatchEvent(new h.context.Event('input',{bubbles:true}));description.dispatchEvent(new h.context.Event('input',{bubbles:true}));
 owner.update(next);owner.dispose();assert.equal(props.edits,0);assert.equal(next.edits,0);assert.equal(next.subscriptions,0);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
for(const failure of ['later choice','initial subscription','initial read'])test(`F4 saved-order constructor cleans actual controls after ${failure} failure`,async()=>{
 const {mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length;let stops=0;
 if(failure==='later choice')h.runtime.buttonHtml=()=>{throw new Error('injected failure');};
 else if(failure==='initial subscription')h.runtime.subscribePlayback=()=>{throw new Error('injected failure');};
 else{h.runtime.subscribePlayback=()=>()=>{stops++;};h.runtime.readPlayback=()=>{throw new Error('injected failure');};}
 assert.throws(()=>mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('one')),/injected failure/);
 assert.equal(stops,failure==='initial read'?1:0);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
for(const replacement of [false,true])test(`F4 synchronous saved-order publication safely ${replacement?'replaces':'retires'} owner before subscription returns`,async()=>{
 const {mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length,stops=[],reads=[],signals=[],callbacks=[];
 h.runtime.subscribePlayback=({playlist_id,onChange})=>{callbacks.push(onChange);if(playlist_id!=='initial')onChange(publication(playlist_id));return()=>stops.push(playlist_id);};
 h.runtime.readPlayback=({playlist_id,signal})=>{reads.push(playlist_id);signals.push(signal);return new Promise(()=>{});};
 const owner=mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('initial'));let once=true;
 h.runtime.canTrackIntent=()=>{if(once){once=false;if(replacement)owner.update(savedProps('replacement'));else owner.dispose();}return true;};
 owner.update(savedProps('outer'));
 assert.ok(stops.includes('initial'));assert.ok(stops.includes('outer'));assert.equal(reads.includes('outer'),false);
 if(replacement){assert.deepEqual(reads,['initial','replacement']);assert.equal(signals[1].aborted,false);}else assert.deepEqual(reads,['initial']);
 const before=reads.length;callbacks[1](publication('outer'));assert.equal(reads.length,before);
 owner.dispose();assert.equal(stops.filter(id=>id==='outer').length,1);assert.ok(signals.every(signal=>signal.aborted));assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
for(const kind of ['page','saved'])test(`F4 ${kind} throwing unsubscribe retains first error after releasing all siblings`,async()=>{
 const {mountLibraryMixPage,mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length,error=new Error('unsubscribe failed');let stops=0;
 const stop=()=>{stops++;throw error;};let owner;
 if(kind==='page')owner=mountLibraryMixPage(h.host,h.runtime,pageProps({subscribe:()=>stop}));
 else{h.runtime.subscribePlayback=()=>stop;owner=mountSavedLibraryMixOrder(h.host,h.runtime,savedProps('one'));}
 const trigger=h.host.querySelector('.ui-choice__trigger');if(!trigger.disabled)h.click(trigger);
 assert.throws(()=>owner.dispose(),value=>value===error);assert.equal(stops,1);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
 for(const menu of h.menus)assert.equal(menu.isOpen,false);assert.doesNotThrow(()=>owner.dispose());
});
test('F4 page construction keeps original renderer error when subscription cleanup also throws',async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),baseline=h.listeners().length,original=new Error('render failed');
 let armed=false;const alert=h.runtime.alertHtml;
 const props=pageProps({subscribe:()=>{armed=true;return()=>{throw new Error('cleanup failed');};},getSnapshot:()=>({resource:{status:'error'},mutation:{status:'idle'},coverage:{}})});
 h.runtime.alertHtml=value=>{if(armed)throw original;return alert(value);};
 assert.throws(()=>mountLibraryMixPage(h.host,h.runtime,props),error=>error===original);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});
test('F4 page synchronous replacement subscription releases returned disposer after render retires page',async()=>{
 const {mountLibraryMixPage}=await load(),h=fixture(),baseline=h.listeners().length,first=pageProps();let stops=0,armed=false;
 const owner=mountLibraryMixPage(h.host,h.runtime,first),action=h.runtime.actionHtml;
 h.runtime.actionHtml=value=>{if(armed&&value.label==='Play'){armed=false;owner.dispose();}return action(value);};
 const next=pageProps({subscribe(fn){armed=true;fn();return()=>{stops++;};}});
 owner.update(next);assert.equal(stops,1);assert.equal(first.listeners.size,0);assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});

const {nativeMixFixture}=require('./library-mix-react-fixture.cjs');
const {id,capture,receipt,deferred}=require('./library-mix-fixtures.cjs');
const lovedDescriptor=()=>({version:1,root_artist_id:'7',scope_mode:'family'});
function lovedCapture(scopeKey,patch={}){
 const value=capture({scopeKey,source_protocol:'artist_loved_selection_v1',artist_loved:{...lovedDescriptor(),source:'artist_loved',auto_update:true,playback_order:'regular'},...patch});
 delete value.data.library_mix;delete value.data.coverage;return value;
}
async function lovedMounted(t,overrides={}){
 const env=await nativeMixFixture(t);env.installNavigation();
 env.state.view={context_ref:'a'.repeat(64),surface:{active:'albums'}};env.runtime.sync();
 const calls={capture:[],save:[],returns:[]};env.c.history.go=delta=>calls.returns.push(delta);
 const providers={readPlaylists:async()=>({playlist_sidebar:{items:[]},playlist_index:{playlists:[]}}),
  beginArtistLoved:async options=>{calls.capture.push(options);return lovedCapture(options.scopeKey);},
  createPlaylistFromSelection:async options=>{calls.save.push(options);return receipt(options.request_key,{scopeKey:options.scopeKey,creation_outcome:'existing'});},...overrides};
 await env.boot(providers);
 const descriptor=lovedDescriptor(),api=env.c.AlbumHavenPlaylistUI;
 const launchContext={descriptor,runtime:env.c.AlbumHavenPlaylistRuntime,
  responseStamp:env.c.AlbumHavenPrivateUITransport.context(),transportGeneration:env.c.AlbumHavenPrivateUITransport.generation(),
  providerGeneration:api.artistLovedProviderGeneration(),isCurrent:()=>true};
 const input={descriptor,launchContext};
 return {...env,input,providers,lovedCalls:calls,open:()=>api.openArtistLoved(input)};
}
test('Loved opens one loading page directly, captures once and consumes only one automatic-play gesture',async t=>{
 const pending=deferred();let options;
 const h=await lovedMounted(t,{beginArtistLoved:input=>{options=input;return pending.promise;}});
 t.after(()=>pending.resolve(lovedCapture(options?.scopeKey)));
 h.c.fetch=async(url,input)=>{h.calls.requests.push({url,...input});assert.equal(url,'/playlists/creation-source/artist-loved/native-queue');
  return h.reply(JSON.parse(input.body),{mutate:value=>{value.data.source_protocol='artist_loved_selection_v1';return value;}});};
 assert.equal(h.c.AlbumHavenPlaylistUI.canOpenArtistLoved(h.input),true);assert.equal(options,undefined);
 assert.equal(h.open(),true);assert.equal(h.open(),false);await h.settle();
 assert.ok(h.host.querySelector('main[aria-label="Temporary Library Mix"]'));
 assert.equal(h.form.hidden,true);assert.equal(h.named('Create mix'),undefined);assert.equal(h.named('Play').disabled,true);
 assert.equal(h.calls.starts.length,0);assert.ok(options.signal);
 pending.resolve(lovedCapture(options.scopeKey));await h.settle();
 assert.equal(h.calls.starts.length,1);assert.equal(h.calls.requests.length,1);
 assert.match(h.host.textContent,/Loved and Obsessed · updates automatically after saving/);
 assert.equal(h.host.querySelector('[aria-label="Songs per group"]'),null);
 assert.doesNotMatch(h.host.textContent,/Last\.fm|Update selection|selection basis/);
 h.runtime.sync();await h.settle();assert.equal(h.calls.starts.length,1);
});
test('Loved empty page permits Save but consumes gesture without queue publication and retains existing notice',async t=>{
 const h=await lovedMounted(t,{beginArtistLoved:async options=>lovedCapture(options.scopeKey,{entries:[]})});
 h.c.fetchAndRender=async()=>false;
 assert.equal(h.open(),true);await h.settle();
 assert.match(h.host.textContent,/No loved or obsessed tracks yet/);assert.equal(h.named('Play').disabled,true);
 assert.equal(h.named('Save as playlist').disabled,false);assert.equal(h.calls.requests.length,0);assert.equal(h.calls.starts.length,0);
 h.click(h.named('Save as playlist'));await h.settle();
 assert.equal(h.lovedCalls.save.length,1);assert.deepEqual(h.lovedCalls.save[0].entry_refs,[]);
 assert.match(h.host.textContent,/You already saved this playlist\./);
 assert.ok(h.named('Open saved playlist'));assert.equal(h.named('Save as playlist').disabled,true);
 h.click(h.named('Open saved playlist'));await h.settle();assert.equal(h.lovedCalls.save.length,1);
});
// Admission is downstream of authenticated response validation. Keep destination
// mismatches structurally valid so they exercise identity admission, not context
// invalidation or malformed projection. The actual bridge/transport remain live.
function savedLovedDestination(h,playlistId){
 return {context_ref:h.c.AlbumHavenPrivateUITransport.context(),surface:{active:'playlists'},
  playlist_sidebar:{active_playlist_id:playlistId,items:[{playlist_id:playlistId,title:'Saved loved',allowed_actions:{can_open:true}}]},
  playlist_detail:{playlist_id:playlistId,title:'Saved loved',track_rows:[],allowed_actions:{can_open:true}}};
}
test('Loved failed destination admission retains acknowledged ID and Open retries navigation only',async t=>{
 const h=await lovedMounted(t,{beginArtistLoved:async options=>lovedCapture(options.scopeKey,{entries:[]})}),navigations=[],admissions=[];
 h.c.fetchAndRender=async(url,_push,options)=>{
  navigations.push(url);const witness={before:h.c.AlbumHavenPrivateUITransport.generation()};admissions.push(witness);
  try{witness.accepted=options.shouldApplyResponse(savedLovedDestination(h,id(99)));}
  catch(error){witness.error=error;}
  witness.after=h.c.AlbumHavenPrivateUITransport.generation();return false;
 };
 assert.equal(h.open(),true);await h.settle();const token=h.runtime.snapshot().draftToken,generation=h.c.AlbumHavenPrivateUITransport.generation();assert.ok(token);
 h.click(h.named('Save as playlist'));await h.settle();
 assert.equal(h.runtime.snapshot().retainedDraftToken,token);assert.equal(h.lovedCalls.save.length,1);
 assert.equal(navigations.length,1);assert.ok(navigations[0].includes(id(80)));
 assert.equal(admissions.length,1);assert.equal(admissions[0].error,undefined);assert.equal(admissions[0].accepted,false);
 assert.equal(admissions[0].before,generation);assert.equal(admissions[0].after,generation);
 h.click(h.named('Open saved playlist'));await h.settle();
 assert.equal(navigations.length,2);assert.equal(navigations[1],navigations[0]);assert.equal(h.lovedCalls.save.length,1);
 assert.equal(h.runtime.snapshot().retainedDraftToken,token);
 assert.equal(h.c.AlbumHavenPrivateUITransport.generation(),generation);
 assert.equal(admissions.length,2);assert.equal(admissions[1].error,undefined);assert.equal(admissions[1].accepted,false);
 assert.equal(admissions[1].before,generation);assert.equal(admissions[1].after,generation);
});
test('Loved failed fetch retains draft and acknowledged destination for navigation-only retry',async t=>{
 const captures=[];
 const h=await lovedMounted(t,{beginArtistLoved:async options=>{captures.push(options);return lovedCapture(options.scopeKey,{entries:[]});}}),navigations=[];
 h.c.fetchAndRender=async url=>{navigations.push(url);return false;};
 assert.equal(h.open(),true);await h.settle();
 const token=h.runtime.snapshot().draftToken,generation=h.c.AlbumHavenPrivateUITransport.generation();assert.ok(token);
 h.click(h.named('Save as playlist'));await h.settle();
 assert.equal(h.runtime.snapshot().retainedDraftToken,token);assert.equal(h.lovedCalls.save.length,1);
 assert.ok(navigations[0].includes(id(80)));assert.equal(navigations.length,1);
 h.click(h.named('Open saved playlist'));await h.settle();
 assert.equal(navigations.length,2);assert.equal(navigations[1],navigations[0]);assert.equal(h.lovedCalls.save.length,1);
 assert.equal(h.runtime.snapshot().retainedDraftToken,token);assert.equal(h.c.AlbumHavenPrivateUITransport.generation(),generation);
 assert.equal(captures.length,1);assert.equal(h.calls.requests.length,0);assert.equal(h.calls.starts.length,0);
});
for(const contextFailure of ['missing','stale'])test(`Loved ${contextFailure} destination context retires retained owner through actual transport`,async t=>{
 const captures=[];
 const h=await lovedMounted(t,{beginArtistLoved:async options=>{captures.push(options);return lovedCapture(options.scopeKey,{entries:[]});}});let lateAdmission,payload,navigations=0;const admission={};
 h.c.fetchAndRender=async(_url,_push,options)=>{
  navigations++;lateAdmission=options.shouldApplyResponse;payload=savedLovedDestination(h,id(80));
  if(contextFailure==='missing')delete payload.context_ref;
  else payload.context_ref='b'.repeat(64);
  try{admission.accepted=options.shouldApplyResponse(payload);}
  catch(error){admission.error=error;}
  return false;
 };
 assert.equal(h.open(),true);await h.settle();
 const token=h.runtime.snapshot().draftToken,generation=h.c.AlbumHavenPrivateUITransport.generation();assert.ok(token);
 h.click(h.named('Save as playlist'));await h.settle();
 assert.equal(navigations,1);assert.equal(h.lovedCalls.save.length,1);
 assert.equal(admission.error,undefined);assert.equal(admission.accepted,false);
 assert.equal(h.c.AlbumHavenPrivateUITransport.generation(),generation+1);
 assert.throws(()=>h.c.AlbumHavenPrivateUITransport.context(),error=>error.code==='stale_context');
 assert.equal(h.runtime.snapshot().retainedDraftToken,null);assert.equal(h.runtime.snapshot().draftToken,null);
 assert.equal(h.c.history.state.playlistDraft,undefined);assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'),null);
 assert.equal(lateAdmission(payload),false);h.runtime.sync();await h.settle();
 assert.equal(h.runtime.snapshot().retainedDraftToken,null);assert.equal(h.c.AlbumHavenPrivateUITransport.generation(),generation+1);
 assert.equal(captures.length,1);assert.equal(h.lovedCalls.save.length,1);
 assert.equal(h.calls.requests.length,0);assert.equal(h.calls.starts.length,0);
});
test('Loved matching admitted destination releases owner only after navigation succeeds',async t=>{
 const captures=[];
 const h=await lovedMounted(t,{beginArtistLoved:async options=>{captures.push(options);return lovedCapture(options.scopeKey,{entries:[]});}}),wait=deferred();let entered=0,token;const admission={};
 t.after(()=>wait.resolve(false));
 h.c.fetchAndRender=async(url,_push,options)=>{
  entered++;if(await wait.promise!==true)return false;
  const payload=savedLovedDestination(h,id(80));
  try{admission.accepted=options.shouldApplyResponse(payload);admission.retainedToken=h.runtime.snapshot().retainedDraftToken;}
  catch(error){admission.error=error;return false;}
  if(admission.accepted!==true)return false;
  // This bounded navigation adapter commits only the admitted response through
  // actual Settings history; it does not claim to execute gallery fetching.
  h.state.view=payload;
  h.c.AlbumHavenSettingsNavigation.instance.writeLibraryHistory(`/?${new URL(url,h.c.location.href).searchParams}`,
   {...h.c.history.state},{mode:'push'});
  return true;
 };
 assert.equal(h.open(),true);await h.settle();token=h.runtime.snapshot().draftToken;assert.ok(token);
 const generation=h.c.AlbumHavenPrivateUITransport.generation();
 h.click(h.named('Save as playlist'));await h.settle();
 assert.equal(entered,1);assert.equal(h.lovedCalls.save.length,1);assert.equal(h.runtime.snapshot().retainedDraftToken,token);
 wait.resolve(true);await h.settle();
 assert.equal(admission.error,undefined);assert.equal(admission.accepted,true);assert.equal(admission.retainedToken,token);
 const saved=h.runtime.snapshot();assert.equal(saved.retainedDraftToken,null);assert.equal(saved.draftToken,null);
 assert.equal(saved.playlistId,id(80));assert.equal(saved.payload.playlist_detail.playlist_id,id(80));
 assert.equal(h.c.history.state.playlistDraft,undefined);assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'),null);
 assert.equal(h.c.AlbumHavenPrivateUITransport.generation(),generation);assert.equal(h.lovedCalls.save.length,1);
 assert.equal(captures.length,1);assert.equal(h.calls.requests.length,0);assert.equal(h.calls.starts.length,0);
});
for(const departure of ['close','new-entry','provider','actor','library'])test(`Loved loading capture permanently retires after ${departure}`,async t=>{
 const wait=deferred();let input;
 const h=await lovedMounted(t,{beginArtistLoved:options=>{input=options;return wait.promise;}});
 t.after(()=>wait.resolve(lovedCapture(input?.scopeKey)));
 assert.equal(h.open(),true);await h.settle();
 if(departure==='close'){h.click(h.named('Close mix'));await h.settle();assert.equal(h.lovedCalls.returns.length,1);}
 else if(departure==='provider')h.c.AlbumHavenPlaylistUI.configureProviders({});
 else if(departure==='new-entry'){
  const navigation=h.c.AlbumHavenSettingsNavigation.instance;
  assert.equal(await navigation.deferPlaylistDraftNavigation(()=>{navigation.writeLibraryHistory('/?artist=Other',{}, {mode:'push'});return true;}),true);
 }else{
  const key=departure==='actor'?'nativeAccountId':'nativeLibraryId',before=h.shell.dataset[key];
  h.shell.dataset[key]='99';h.runtime.sync();h.shell.dataset[key]=before;h.runtime.sync();
 }
 await h.settle();assert.equal(input.signal.aborted,true);wait.resolve(lovedCapture(input.scopeKey));await h.settle();
 assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'),null);assert.equal(h.calls.starts.length,0);
});
test('Loved newer player selection while capture waits suppresses delayed automatic start',async t=>{
 const wait=deferred();let input;
 const h=await lovedMounted(t,{beginArtistLoved:options=>{input=options;return wait.promise;}});
 t.after(()=>wait.resolve(lovedCapture(input?.scopeKey)));
 assert.equal(h.open(),true);h.c.playerTrackSelectionToken++;const newer={owner:'newer-user-play'};h.state.player.playbackQueue=newer;
 wait.resolve(lovedCapture(input.scopeKey));await h.settle();
 assert.equal(h.calls.requests.length,0);assert.equal(h.calls.starts.length,0);assert.equal(h.state.player.playbackQueue,newer);
 h.runtime.sync();await h.settle();assert.equal(h.calls.requests.length,0);
});
test('Loved transfer revalidates synchronous lease callbacks before capture and cannot retire replacement mount',async t=>{
 const h=await lovedMounted(t);let checks=0;
 h.input.launchContext.isCurrent=()=>{if(++checks===3)h.c.AlbumHavenPlaylistUI.configureProviders({});return true;};
 assert.equal(h.open(),false);await h.settle();
 assert.equal(h.lovedCalls.capture.length,0);assert.equal(h.runtime.snapshot().retainedDraftToken,null);
 assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'),null);
});
test('Loved saved order uses the existing order owner without a fake Popular recipe',async()=>{
 const {mountSavedLibraryMixOrder}=await load(),h=fixture(),baseline=h.listeners().length;
 const detail={playlist_id:'loved',playlist_kind:'artist_loved',artist_loved:{playback_order:'unplayed_first'},
  allowed_actions:{can_play:true},track_rows:[]};
 h.runtime.readPlayback=async()=>({status:'ready',data:{scopeKey:'s',playlist_id:'loved',library_mix_order:'unplayed_first'}});
 const owner=mountSavedLibraryMixOrder(h.host,h.runtime,{scopeKey:'s',detail});await h.settle();
 assert.ok(h.host.querySelector('.ui-choice__trigger'));assert.match(h.host.textContent,/Unplayed/);
 owner.dispose();assert.equal(h.listeners().length,baseline);assert.equal(h.host.childNodes.length,0);
});

test('actual saved Loved page reports current, retained and missing-root states without Popular claims',async t=>{
 const h=await nativeMixFixture(t),scopeKey=h.runtime.snapshot().scopeKey;
 const controller=h.api.createPlaylistController({});controller.setScope(scopeKey);
 for(const refresh_status of ['current','unavailable','too_large','last_computed','owner_refresh_required']){
  const artist_loved={...lovedDescriptor(),source:'artist_loved',auto_update:true,playback_order:'regular',
   last_evaluated_at:'2026-10-18T00:00:00Z',root_state:'present',refresh_status};
  const detail={playlist_id:id(80),revision:'1',playlist_kind:'artist_loved',artist_loved,title:'Saved loved',track_rows:[],items_complete:true,
   allowed_actions:{can_open:true,can_edit:true,can_share:true,can_add:false,can_reorder:false}};
  assert.equal(controller.accept({playlist_sidebar:{items:[{playlist_id:id(80),title:'Saved loved',allowed_actions:{can_open:true}}]},playlist_detail:detail},id(80)),true);
  const mounted=h.mount('saved',{controller,providers:{}});await h.settle();
  assert.match(mounted.host.textContent,/updates automatically when the owner opens this playlist/);
  assert.match(mounted.host.textContent,/Generated membership is locked/);
  const metadata=mounted.host.querySelector('.playlists__metadata');assert.ok(metadata);
  assert.match(metadata.textContent,/Loved and Obsessed/);
  assert.doesNotMatch(metadata.textContent,/Last\.fm|Popularity/);
  const popularity=mounted.host.querySelector('[role="columnheader"][data-cdt-column="popularity_count"]');
  assert.ok(popularity,'generic playtable metric column remains present');
  assert.equal(popularity.querySelector('.compact-data-table__sort-label').textContent,'Popularity',
   'generic playtable metric heading remains independent of Loved recipe/status claims');
  if(refresh_status==='current')assert.match(mounted.host.textContent,/Selection evaluated for this read/);
  else{assert.doesNotMatch(mounted.host.textContent,/Selection evaluated for this read/);assert.match(mounted.host.textContent,/last computed selection/);}
  mounted.unmount();
 }
 const payload={playlist_sidebar:{items:[]},playlist_detail:{playlist_id:id(80),revision:'1',title:'Missing root',playlist_kind:'artist_loved',
  artist_loved:{...lovedDescriptor(),source:'artist_loved',auto_update:true,playback_order:'regular',last_evaluated_at:'2026-10-18T00:00:00Z',root_state:'root_missing',refresh_status:'current'},track_rows:[],allowed_actions:{can_open:true}}};
 controller.accept(payload,id(80));const mounted=h.mount('saved',{controller,providers:{}});await h.settle();
 assert.match(mounted.host.textContent,/original artist no longer exists/);assert.match(mounted.host.textContent,/retains its original artist identity/);
 mounted.unmount();
});

test('actual saved notification renders through bridge and expires via real scheduler',async t=>{
 const h=await nativeMixFixture(t);
 const owner=h.runtime.notifyPlaytableCreation();assert.ok(owner);await h.settle();
 assert.match(h.toastLayer.textContent,/Playlist saved\. Open it from Playlists when access is available\./);
 assert.equal(h.toastLayer.querySelectorAll('.toast').length,1);
 h.advanceTimers(3999);assert.equal(h.toastLayer.querySelectorAll('.toast').length,1);
 h.advanceTimers(1);h.advanceTimers(260);await h.settle();
 assert.equal(h.toastLayer.childNodes.length,0);owner.dispose();
});
