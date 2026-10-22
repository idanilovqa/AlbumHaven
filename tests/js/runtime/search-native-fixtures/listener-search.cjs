'use strict';
// Explicit server wire witnesses. No product parser, projection, admission,
// renderer or native action is copied or replaced. The inherited fixtures load
// candidate owners and mock only HTTP, geometry and unavailable audio output.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const actual = require('./actual-runtime.cjs');
const actions = require('./native-actions.cjs');
const queue = require('./queue-actions.cjs');
const {createTabProvenancePlatform,requireTabWitness,requireDeviceWitness}=require('./ownership-tab-provenance.cjs');
function withTabProvenance(options,create){
  const provenance=createTabProvenancePlatform(),previous=options.beforeRuntimePlatform;
  return create({...options,beforeRuntimePlatform(platform){previous?.(platform);provenance.install(platform);}} ,provenance);
}
// These complete synchronous component owners are served by the appearance
// partial before bootstrap/native entry. Keep shared fixtures unchanged; defer
// their optional entry call until this additive composition is complete.
function installTemplateComponents(h) {
  assert.equal(typeof h.c.ButtonComponent?.renderButton,'function');
  for(const relative of ['music_app/static/js/editor-page.js','music_app/static/js/unfolding-action-button.js']) {
    assert.equal(h.loaded.includes(relative),false,'component loaded exactly once');
    vm.runInContext(actual.read(relative),h.c,{filename:relative});h.loaded.push(relative);
  }
  assert.equal(typeof h.c.EditorPage?.mountFooter,'function');
  assert.equal(typeof h.c.UnfoldingActionButton?.mount,'function');
  return h;
}
function fixture(t,options={}) {return withTabProvenance(options,(next,provenance)=>{const h=installTemplateComponents(actual.fixture(t,next));h.ownershipTabWitness=provenance.capture;h.playbackDeviceWitness=provenance.captureDevice;return h;});}
async function actionFixture(t,{entry=false,...options}={}) {
  const h=await withTabProvenance(options,async(next,provenance)=>{const result=installTemplateComponents(await actions.actionFixture(t,{...next,entry:false}));result.ownershipTabWitness=provenance.capture;result.playbackDeviceWitness=provenance.captureDevice;return result;});
  if(entry)await h.entry();return h;
}
async function queueFixture(t,{entry=false,...options}={}) {
  const h=await withTabProvenance(options,async(next,provenance)=>{const result=installTemplateComponents(await queue.queueFixture(t,{...next,entry:false}));result.ownershipTabWitness=provenance.capture;result.playbackDeviceWitness=provenance.captureDevice;return result;});
  if(entry)await h.entry();return h;
}
const ROW = 'activity_' + 'a'.repeat(64), ROW2 = 'activity_' + 'b'.repeat(64);
const TOKEN = 'sealed-listener-result-A', CURSOR = 'sealed-listener-cursor-A';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const ALBUM_ID = 'album_' + 'c'.repeat(64), ARTIST_ID = 'artist_' + 'd'.repeat(64);
const coverage = () => ({requested_start:null,requested_end:'2026-10-18T00:00:00+00:00',timezone:'UTC',
  observed_start:'2026-10-01T00:00:00+00:00',observed_end:'2026-10-17T00:00:00+00:00',source_families:['local'],
  complete_for_available_snapshot:true,complete_for_requested_period:false,
  label:'Available stored meaningful listens; complete historical coverage is not known.'});
const listenerTrack = (id=ROW, patch={}) => ({id,kind:'track',title:id===ROW?'First listened track':'Second listened track',
  artist:'Historical Artist',album_title:'Historical Album',listen_count:3,last_listened_at:'2026-10-17T00:00:00+00:00',
  duration_seconds:90,source_label:'Local',availability:'local',source_readable:true,...patch});
function listenerReady({query='@maya',tracks=[listenerTrack(),listenerTrack(ROW2)],include=[],exclude=[],patch={}}={}) {
  return {status:'ready',private_search:true,contract_version:'listener-search-v1',context_ref:actual.A,query,
    criteria:{subject:{kind:'username',username:'maya'},predicate_domain:'tracks',history:{period:'all'},love:{include,exclude}},
    presentation:'tracks',listener:{account_ref:ACCOUNT,username:'maya',display_name:'Maya'},tracks,
    page:{limit:100,returned_count:tracks.length,candidates_examined:tracks.length,has_more:false,next_cursor:null,total_matches:tracks.length},
    history:{expires_at:'2099-10-18T00:00:00+00:00',total_tracks:230,total_listens:900,period_label:'All time',range_label:'Available history',coverage:coverage()},
    native:{result_token:TOKEN},...patch};
}
const listenerUrl = (payload=listenerReady(), extra={}) => '/view-data?' + new URLSearchParams({surface:'albums',q:payload.query,search_presentation:'tracks',...extra});
function post(h,index,path,keys) {
  const request=h.requests[index]; assert.ok(request,`actual listener request ${index}`);
  const url=new URL(request.url,h.location);assert.equal(url.pathname,path);assert.equal(url.search,'');
  assert.equal(request.options.method,'POST');assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.cache,'no-store');
  assert.equal(request.options.headers.get('X-AlbumHaven-Context'),actual.A);
  assert.equal(request.options.headers.get('X-Album-Haven-CSRF'),'synthetic-search-action-csrf');
  const body=JSON.parse(request.options.body);assert.deepEqual(Object.keys(body).sort(),keys.slice().sort());return body;
}
const bindingCommand=(h,index)=>post(h,index,'/search/listener-native-bindings',['result_token','row_refs']);
function singleCommand(h,index) {
  const raw=JSON.parse(h.requests[index].options.body);
  return post(h,index,'/search/listener-native-target',raw.intent==='details'?['result_token','row_ref','intent','target_kind']:['result_token','row_ref','intent']);
}
const listenerBatchCommand=(h,index)=>post(h,index,'/search/listener-native-targets',['result_token','row_refs','intent']);
const inventory = row => row===ROW?'inventory-track:9:101':row===ROW2?'inventory-track:9:102':`inventory-track:9:${1000+parseInt(row.slice(-8),16)}`;
function binding(row, {enabled=true, play=enabled, playlist=enabled, album=enabled, artist=enabled,
  inventoryTrackRef=enabled?inventory(row):null, artworkUrl=null}={}) {
  return {row_ref:row,allowed_actions:{can_resolve_native_play:play,can_resolve_native_details:album||artist,can_select_for_playlist:playlist},
    inventory_track_ref:inventoryTrackRef,artwork_url:artworkUrl,
    ...(album?{album_target:{kind:'album',row_ref:row,identity_ref:ALBUM_ID,allowed_actions:{can_view_details:true}}}:{}),
    ...(artist?{artist_target:{kind:'artist',row_ref:row,identity_ref:ARTIST_ID,allowed_actions:{can_view_details:true}}}:{})};
}
function bindingReply(h,index,{disabled=[],rows={},mutate}={}) {
  const command=bindingCommand(h,index), reply={status:'ready',contract_version:'listener-search-native-bindings-v1',context_ref:actual.A,
    result_token:command.result_token,data:{bindings:command.row_refs.map(row=>binding(row,{enabled:!disabled.includes(row),...rows[row]}))}};
  mutate?.(reply);return reply;
}
function listenerNativeReply(h,index,{mutate, targetPatch={}}={}) {
  const command=singleCommand(h,index), native_target=command.intent==='metadata'?queue.metadataTarget(inventory(command.row_ref),targetPatch)
    :command.intent==='play'?queue.playTarget(inventory(command.row_ref),targetPatch)
    :command.target_kind==='artist'?{artist_ref:'native-artist',title:'Native Artist',allowed_actions:{can_view_details:true},...targetPatch}
    :{album_ref:'native-album-eleven',title:'Native Album',artist:'Native Artist',allowed_actions:{can_view_details:true,can_play_album:true},...targetPatch};
  const reply={status:'ready',contract_version:'listener-search-native-v1',context_ref:actual.A,result_token:command.result_token,
    data:{row_ref:command.row_ref,intent:command.intent,native_target}};mutate?.(reply);return reply;
}
function listenerBatchReply(h,index,{unavailable=[],mutate,targetPatch={}}={}) {
  const command=listenerBatchCommand(h,index),reply={status:'ready',contract_version:'listener-search-native-batch-v1',context_ref:actual.A,
    result_token:command.result_token,data:{intent:command.intent,items:command.row_refs.map(row_ref=>({row_ref,
      status:unavailable.includes(row_ref)?'unavailable':'ready',native_target:unavailable.includes(row_ref)?null:
        (command.intent==='metadata'?queue.metadataTarget:queue.playTarget)(inventory(row_ref),targetPatch)}))}};
  mutate?.(reply);return reply;
}
// Always cross the actual global form -> request matcher -> foreground apply.
// Bindings are real child requests; never call runtime.accept directly.
async function submitListener(h,payload=listenerReady(),{bindings=true,bindingOptions={},resumedWaveform=false}={}) {
  const waveform=resumedWaveform?{path:h.state.player.current?.path,generation:h.state.player.streaming?.generation}:null;
  if(waveform){assert.ok(waveform.path);assert.ok(waveform.generation>0);}
  const index=h.requests.length;h.input.value=payload.query;h.dispatch(h.input,'input');h.dispatch(h.form,'submit');
  assert.equal(h.requests.length,index+1);assert.equal(new URL(h.requests[index].url,h.location).searchParams.get('q'),payload.query);
  h.reply(index,payload);const result=await h.invocations.at(-1).outcome;assert.equal(result.error,undefined,result.error?.stack);
  assert.equal(result.value,true);await h.flush();assert.equal(h.runtime().snapshot().status,'ready');
  const children=h.requests.slice(index+1).map((request,offset)=>({request,index:index+1+offset}));
  let bindingChildren=children;
  if(waveform){
    // Foreground search cancels then resumes the already-playing waveform once.
    // Prove that exact independent request instead of relaxing Search's bound.
    assert.equal(h.state.player.current?.path,waveform.path);assert.equal(h.state.player.streaming?.generation,waveform.generation);
    const peaks=children.filter(({request})=>new URL(request.url,h.location).pathname==='/playback/waveform');
    assert.equal(peaks.length,1,'exactly one existing-player waveform resume');
    const request=peaks[0].request,url=new URL(request.url,h.location);
    assert.deepEqual([...url.searchParams],[['path',waveform.path],['bins','720']]);
    assert.equal(request.options.method??'GET','GET');assert.ok(request.options.signal);assert.equal(request.options.signal.aborted,false);
    bindingChildren=children.filter(child=>child!==peaks[0]);
  }
  if(payload.tracks.length){assert.equal(bindingChildren.length,1,'one bounded binding child, no automatic next page');
    const bindingIndex=bindingChildren[0].index;
    assert.deepEqual(bindingCommand(h,bindingIndex),{result_token:payload.native.result_token,row_refs:payload.tracks.map(row=>row.id)});
    if(bindings){h.reply(bindingIndex,bindingReply(h,bindingIndex,bindingOptions));await h.flush();}}
  else assert.equal(bindingChildren.length,0,'empty page needs no binding child');
  return h.runtime().snapshot();
}
async function finishListenerDetails(h,index,{targetPatch={}}={}) {
  assert.equal(singleCommand(h,index).target_kind,'album');h.reply(index,listenerNativeReply(h,index,{targetPatch}));await h.flush();
  assert.equal(h.requests.length,index+2,'real ResourceSelection reauthorizes independently');
  assert.deepEqual(singleCommand(h,index+1),singleCommand(h,index));h.reply(index+1,listenerNativeReply(h,index+1,{targetPatch}));await h.flush();
  assert.equal(h.requests[index+2].url,'/album-details?album_key=native-album-eleven');
  h.reply(index+2,{ok:true,album:actions.fullAlbum()});await h.flush();
}
// The existing native player persists its actor-authorized current track. This
// opt-in is explicit at each successful Play caller and is independently checked
// against the observed streaming handoff, never inferred from storage contents.
function assertListenerPrivate(h,extra=[],{actorNative=null,ownershipTab=null,playbackDevice=null}={}) {
  const forbiddenKeys=new Set(['subject','subject_taste','subject_account','subject_id','account_ref',
    'inventory_track_ref','inventory_album_ref','inventory_artist_ref','identity_ref','album_ref','artist_ref',
    'parent_album_ref','parent_artist_ref','native_target','snapshot_ref','result_token','row_ref']);
  const universal=[ROW,ROW2,TOKEN,CURSOR,ACCOUNT,ALBUM_ID,ARTIST_ID,
    'inventory-track:','inventory-album:','inventory-artist:','native-album-eleven','native-artist',
    'canonical-album-','canonical-artist-','album_ref','artist_ref',
    'canonical-track-','snapshot_ref','native_target','result_token','row_ref',
    'account_ref','inventory_track_ref','identity_ref','"subject"','subject_taste','subject_account','subject_id'];
  const pathSecrets=['/library/','/track?path=',...(actorNative?[actorNative.path,actorNative.src]:[])];
  function decoded(value) {try{return decodeURIComponent(value);}catch{return value;}}
  function excludes(value,secrets,label) {
    for(const candidate of [value,decoded(value)])for(const secret of secrets)
      assert.equal(candidate.includes(secret),false,`${label} excludes ${secret}`);
    assert.doesNotMatch(decoded(value),/(?:activity_|album_|artist_)[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,
      `${label} excludes receipt/account/identity values`);
  }
  const projections=[['Search DOM',h.host.innerHTML],['Search snapshot',JSON.stringify(h.runtime().snapshot())],
    ['view state',JSON.stringify(h.state.view)],['history',JSON.stringify(h.historyCalls)],
    ['public Queue',JSON.stringify(h.queue?.getSnapshot()||{})]];
  for(const [label,value]of projections)excludes(value,[...universal,...pathSecrets,...extra],label);
  if(actorNative){
    assert.deepEqual(Object.keys(actorNative).sort(),['inventoryTrackRef','path','src'],'actor-native expectation has exact fields');
    assert.equal(typeof actorNative.path,'string');assert.ok(actorNative.path.startsWith('/library/'));
    assert.equal(actorNative.src,`/track?path=${encodeURIComponent(actorNative.path)}`,'actor-native expected src is bound to expected path');
    const observed=h.streams?.at(-1)?.[0];assert.ok(observed,'actor-native allowance requires observed native streaming handoff');
    assert.equal(observed.inventory_track_ref,actorNative.inventoryTrackRef,'native handoff inventory is independently expected');
    assert.equal(observed.path,actorNative.path,'native handoff path is independently expected');
    assert.equal(observed.src,actorNative.src,'native handoff src is independently expected');
  }
  let playerWrites=0;
  for(const [index,write]of h.storageCalls.entries()){
    const label=`storage[${index}] ${write.key}`;
    excludes(write.key,universal,`${label} key`);
    if(write.key==='album-haven-playback-device-id'&&playbackDevice){
      excludes(write.key,[...pathSecrets,...extra],`${label} key`);
      assert.equal(write.value,requireDeviceWitness(playbackDevice),`${label} exact independently generated device ID`);
      for(const candidate of [write.value,decoded(write.value)])for(const secret of [...universal,...pathSecrets,...extra])
        assert.equal(candidate.includes(secret),false,`${label} device ID excludes ${secret}`);
      // Only this exact primitive at this exact key has a UUID-shape exemption.
      // Its value came from local entropy, never from persisted/read response data.
      continue;
    }
    let ownershipValue=null;
    if(write.key==='albumhaven.playbackOwnership.v1'&&ownershipTab){
      const expectedTab=requireTabWitness(ownershipTab),value=JSON.parse(write.value);
      assert.ok(value&&!Array.isArray(value)&&typeof value==='object',`${label} ownership object`);
      assert.deepEqual(Object.keys(value).sort(),['tab_id','status','reason','updated_at_ms','expires_at_ms','claim_revision'].sort(),`${label} exact ownership schema`);
      assert.equal(value.tab_id,expectedTab,`${label} exact independently generated top-level tab_id`);
      // Production JSON.stringify is canonical for this parsed object. Reject
      // duplicate keys and escaped spellings before removing this one value.
      assert.equal(JSON.stringify(value),write.value,`${label} canonical ownership JSON without duplicate or escaped copies`);
      assert.equal(value.status,'playing',`${label} identity lease status`);
      assert.equal(typeof value.reason,'string');
      assert.ok(Number.isSafeInteger(value.claim_revision)&&value.claim_revision>0,`${label} claim revision`);
      assert.ok(Number.isFinite(value.updated_at_ms)&&Number.isFinite(value.expires_at_ms));
      assert.ok(value.expires_at_ms>value.updated_at_ms&&value.expires_at_ms-value.updated_at_ms<=15000);
      // Run all private/path/caller checks on the exempt value first; only its
      // UUID shape is waived, never its contents or provenance.
      for(const candidate of [value.tab_id,decoded(value.tab_id)])for(const secret of [...universal,...pathSecrets,...extra])
        assert.equal(candidate.includes(secret),false,`${label} tab_id excludes ${secret}`);
      ownershipValue={...value,tab_id:''};
    }
    const strictRaw=ownershipValue?JSON.stringify(ownershipValue):write.value;
    excludes(strictRaw,universal,label); // Every other byte/field stays strict.
    function inspectUniversal(node,fields=[]){
      if(node&&typeof node==='object'){
        for(const [key,child]of Object.entries(node)){
          const field=fields.concat(key).join('.');
          assert.equal(forbiddenKeys.has(key),false,`${label} ${field} excludes private structural key`);
          excludes(key,universal,`${label} ${field} key`);
          inspectUniversal(child,fields.concat(key));
        }
      }else if(typeof node==='string')excludes(node,universal,`${label} ${fields.join('.')}`);
    }
    // Every JSON storage value receives structural checks, including ordinary
    // keys. Non-JSON values already received the strict raw-string check.
    let stored;try{stored=JSON.parse(write.value);}catch{}
    inspectUniversal(ownershipValue||stored);
    excludes(write.key,[...pathSecrets,...extra],`${label} key`);
    if(!actorNative||write.key!=='albumhaven.playerState.v1'){
      excludes(strictRaw,[...pathSecrets,...extra],label);
      function inspectStrict(node,fields=[]){
        if(node&&typeof node==='object'){
          for(const [key,child]of Object.entries(node)){
            const field=fields.concat(key).join('.');
            excludes(key,[...pathSecrets,...extra],`${label} ${field} key`);
            inspectStrict(child,fields.concat(key));
          }
        }else if(typeof node==='string')excludes(node,[...pathSecrets,...extra],`${label} ${fields.join('.')}`);
      }
      // JSON Unicode escapes must not hide paths or caller-only secrets in
      // ordinary storage, or even this player key when there is no opt-in.
      inspectStrict(ownershipValue||stored);continue;
    }
    playerWrites++;
    const value=JSON.parse(write.value);
    assert.ok(value&&value.track&&typeof value.track==='object'&&!Array.isArray(value.track),`${label} track object`);
    assert.equal(value.track.path,actorNative.path,`${label} track.path matches independent native handoff`);
    assert.equal(value.track.src,actorNative.src,`${label} track.src matches independent native handoff`);
    assert.equal(value.playbackQueue,null,`${label} explicit Queue persistence remains null`);
    function inspect(node,fields=[]){
      if(node&&typeof node==='object'){
        for(const [key,child]of Object.entries(node)){
          excludes(key,[...pathSecrets,...extra],`${label} ${fields.concat(key).join('.')} key`);
          inspect(child,fields.concat(key));
        }
      }else if(typeof node==='string'){
        const field=fields.join('.');
        if(fields.length===2&&fields[0]==='track'&&['path','src'].includes(fields[1])){
          assert.equal(node,actorNative[fields[1]],`${label} ${field} exact allowance`);
          // Caller extras may include the expected path. Only that exact value
          // is allowed here; every universal secret was already checked above.
          excludes(node,extra.filter(secret=>secret!==actorNative.path&&secret!==actorNative.src),`${label} ${field}`);
        }else excludes(node,[...pathSecrets,...extra],`${label} ${field}`);
      }
    }
    inspect(value);
  }
  if(actorNative)assert.ok(playerWrites>0,'storage: expected existing native player persistence was observed');
}
async function beginListenerQueue(h,snapshot=h.runtime().snapshot(),options={}) {
  return queue.beginQueue(h,snapshot,options);
}
async function settleListenerQueue(h,request,{metadata={},play={}}={}) {
  assert.equal(listenerBatchCommand(h,request.start).intent,'metadata');h.reply(request.start,listenerBatchReply(h,request.start,metadata));await h.flush();
  assert.equal(listenerBatchCommand(h,request.start+1).intent,'play');h.reply(request.start+1,listenerBatchReply(h,request.start+1,play));
  const result=await request.work;await h.flush();return result;
}
module.exports={...actual,...actions,...queue,fixture,actionFixture,queueFixture,ROW,ROW2,TOKEN,CURSOR,ACCOUNT,ALBUM_ID,ARTIST_ID,listenerTrack,listenerReady,listenerUrl,
  bindingCommand,bindingReply,singleCommand,listenerNativeReply,listenerBatchCommand,listenerBatchReply,submitListener,finishListenerDetails,
  assertListenerPrivate,beginListenerQueue,settleListenerQueue};
