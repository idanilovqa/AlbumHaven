'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {entryEnvironment,nativeShell,playlistPayload,load,drain} = require('./native-entry-fixtures/actual-native-runtime.cjs');
let sequence = 0;
const boot = () => import(`${pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/home-friends/index-native.mjs')).href}?ownership-test=${++sequence}`);
const destinations = async ({scopeKey}) => ({status:'empty',data:{scopeKey,destinations:[],allowed_actions:{}}});
function selection(scopeKey) {
  const abort = new AbortController(), instance = {}, listeners = new Set();
  let disposals = 0;
  const lifetime = {signal:abort.signal,isCurrent:()=>!abort.signal.aborted,
    dispose(){disposals++;abort.abort();},
    subscribeInvalidation(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  return {packet:{scopeKey,row_keys:['row:one'],origin:{tableKey:'ownership-test',target:'selection'}}, lifetime,
    source:{snapshot:()=>({scopeKey,instance,revision:'one',rows:[{rowKey:'row:one',readable:true,selectable:true}]}),
      resolveRows:()=>[{rowKey:'row:one',track_ref:'track:one'}],subscribe:()=>()=>{}},
    disposals:()=>disposals, invalidations:()=>listeners.size};
}
async function entry(t,{playlistVisible=false,homeVisible=false}={}) {
  const env=entryEnvironment(t), home=nativeShell(env,{visible:homeVisible}), native=nativeShell(env,{
    visible:playlistVisible,playlistId:'one',payload:playlistPayload('one')});
  env.add('home-friends-root');
  const playlistHost=env.add('playlists-root');
  Object.assign(native.runtime,{canOpenPlaytableForm:()=>true,configurePlaybackPreferences(){},playtableFormRuntime:()=>env.runtime});
  env.context.AlbumHavenHomeRuntime=home.runtime;
  env.context.AlbumHavenPlaylistRuntime=native.runtime;
  await boot();await drain();
  t.after(()=>{home.change({visible:false,authenticated:false,scopeKey:null});native.change({visible:false,authenticated:false,scopeKey:null});});
  return {...env,home,native,playlistHost,ui:env.context.AlbumHavenPlaylistUI,actions:env.context.AlbumHavenPlaytableUI};
}
function attempt(callback) {try{return {value:callback()};}catch(error){return {error};}}
function open(h,selected) {return h.actions.open(selected.packet,selected.lifetime,selected.source,h.add(`anchor-${++sequence}`));}

// These wrap platform/native seams but always delegate successful acquisition
// to the real assembled entry, controller, renderer and native dialog owner.
test('Global playlist configuration preserves nested newest provider from playback preference retirement',async t=>{
  const h=await entry(t,{playlistVisible:true});let obsoleteReads=0,newReads=0,reenter=true;
  const newest={readPlaylists:async request=>{newReads++;return playlistPayload(request.playlist_id,{title:'Newest global provider'});}};
  h.native.runtime.configurePlaybackPreferences=()=>{if(reenter){reenter=false;h.ui.configureProviders(newest);}};
  h.ui.configureProviders({readPlaylists:async request=>{obsoleteReads++;return playlistPayload(request.playlist_id,{title:'Obsolete global provider'});}});
  await drain();
  assert.equal(reenter,false);assert.equal(obsoleteReads,0,'superseded global configuration never reaches root reads');
  assert.equal(newReads,1);assert.match(h.playlistHost.textContent,/Newest global provider/);
  assert.doesNotMatch(h.playlistHost.textContent,/Obsolete global provider/);
});

test('Global playlist configuration preserves nested newest provider from actual action lifetime retirement',async t=>{
  const h=await entry(t,{playlistVisible:true}), selected=selection(h.native.runtime.snapshot().scopeKey);
  let obsoleteReads=0,newReads=0;
  h.ui.configureProviders({readPlaylistDestinations:destinations});
  assert.equal(open(h,selected),true);await drain();
  const dispose=selected.lifetime.dispose;
  selected.lifetime.dispose=()=>{dispose();h.ui.configureProviders({readPlaylists:async request=>{newReads++;return playlistPayload(request.playlist_id,{title:'Lifetime newest'});}});};
  h.ui.configureProviders({readPlaylists:async request=>{obsoleteReads++;return playlistPayload(request.playlist_id,{title:'Lifetime obsolete'});}});
  await drain();
  assert.equal(selected.disposals(),1);assert.equal(obsoleteReads,0);assert.equal(newReads,1);
  assert.match(h.playlistHost.textContent,/Lifetime newest/);assert.doesNotMatch(h.playlistHost.textContent,/Lifetime obsolete/);
  assert.equal(h.modal().hidden,true);
});

for (const seam of ['retainPlaytablePresentation','playtableFormRuntime','openForm']) {
  test(`Action ${seam} failure retires its ownership and permits actual native reopen`,async t=>{
    const h=await entry(t,{homeVisible:true});h.ui.configureProviders({readPlaylistDestinations:destinations});
    let retained=0,released=0;
    h.home.runtime.retainPlaytablePresentation=()=>{retained++;return()=>{released++;};};
    const target=seam==='retainPlaytablePresentation'?h.home.runtime:seam==='playtableFormRuntime'?h.native.runtime:h.runtime;
    const actual=target[seam], failure=new Error(`injected ${seam}`), baseline=new Set(h.document.body.childNodes);
    target[seam]=()=>{throw failure;};
    const first=selection(h.native.runtime.snapshot().scopeKey), result=attempt(()=>open(h,first));
    if(seam==='openForm') {
      assert.equal(result.error,undefined,'native openForm failure retains the intentional shared-dialog fallback');
      assert.equal(result.value,true,'fallback remains an owned action until Close');
      await drain();assert.equal(first.disposals(),0);assert.equal(released,0);
      assert.match(h.document.body.textContent,/This dialog is not available right now/);
      h.click(h.button(h.document.body,'Close'));
    } else assert.equal(result.error,failure,'preserve the acquisition error');
    await drain();
    assert.equal(first.disposals(),1,'failed acquisition retires external lifetime exactly once');
    assert.equal(first.invalidations(),0,'controller invalidation subscription retired');
    assert.equal(released,retained,'every acquired presentation is released');
    assert.equal(h.modal().hidden,true);
    assert.ok(h.document.body.childNodes.filter(node=>!baseline.has(node)).every(node=>node.id.startsWith('anchor-')),'no orphan action host');
    target[seam]=actual;
    const second=selection(h.native.runtime.snapshot().scopeKey);
    assert.equal(open(h,second),true,'failed owner does not block later opening');await drain();
    assert.equal(h.modal().hidden,false);
    h.ui.configureProviders({readPlaylistDestinations:destinations});await drain();
    assert.equal(second.disposals(),1);assert.equal(second.invalidations(),0);assert.equal(released,retained);assert.equal(h.modal().hidden,true);
  });
}

test('Action reentry during native openForm retires the view returned after its owner and allows reopen',async t=>{
  const h=await entry(t,{homeVisible:true});h.ui.configureProviders({readPlaylistDestinations:destinations});
  let retained=0,released=0,once=true,lateNativeCloses=0;
  h.home.runtime.retainPlaytablePresentation=()=>{retained++;return()=>{released++;};};
  const actual=h.runtime.openForm, baseline=new Set(h.document.body.childNodes);
  h.runtime.openForm=options=>{
    const native=actual({...options,onMount(node,close){
      return options.onMount(node,(...args)=>{lateNativeCloses++;return close(...args);});
    }});
    if(once){once=false;h.ui.configureProviders({readPlaylistDestinations:destinations});}
    return native;
  };
  const first=selection(h.native.runtime.snapshot().scopeKey);
  assert.equal(open(h,first),false);await drain();
  assert.equal(first.disposals(),1);assert.equal(first.invalidations(),0);assert.equal(released,1);
  assert.equal(lateNativeCloses,1,'late view is disposed through the actual dialog owner and native close callback');
  assert.equal(h.modal().hidden,true);
  assert.ok(h.document.body.childNodes.filter(node=>!baseline.has(node)).every(node=>node.id.startsWith('anchor-')));
  const second=selection(h.native.runtime.snapshot().scopeKey);assert.equal(open(h,second),true);await drain();
  assert.equal(h.modal().hidden,false);h.ui.configureProviders({});await drain();
  assert.equal(second.disposals(),1);assert.equal(released,retained);assert.equal(h.modal().hidden,true);
});

test('Playlist root initial real native render throw rolls back shell and registry subscriptions before retry',async t=>{
  const h=entryEnvironment(t),native=nativeShell(h,{visible:true,playlistId:'one',payload:playlistPayload('one')});
  const {mountPlaylists}=await load('playlists/native.mjs');
  let registrations=0,releases=0,immediateEmissions=0;
  const subscribe=native.runtime.subscribe;
  native.runtime.subscribe=fn=>{const release=subscribe(fn);immediateEmissions++;fn();return release;};
  native.runtime.subscribeNotificationRegistry=()=>{registrations++;return()=>{releases++;};};
  const actual=native.runtime.buttonHtml,failure=new Error('initial native button render');let throws=0;
  native.runtime.buttonHtml=()=>{throws++;throw failure;};
  assert.throws(()=>mountPlaylists({host:h.host,runtime:native.runtime}),error=>error===failure);
  await drain();assert.ok(immediateEmissions>0,'shell subscription emits before returning its disposer');
  assert.ok(throws>0,'failure occurred inside actual native renderer');
  assert.equal(native.listeners.size,0,'all shell subscriptions rolled back');assert.equal(releases,registrations);
  assert.equal(h.host.childNodes.length,0,'partial initial native view removed');
  native.runtime.buttonHtml=actual;
  const owner=mountPlaylists({host:h.host,runtime:native.runtime});t.after(()=>owner.dispose());await drain();
  assert.ok(h.host.querySelector('[aria-label="Playlist title"]'),'fresh root mounts successfully');
  owner.dispose();await drain();assert.equal(native.listeners.size,0);assert.equal(releases,registrations);assert.equal(h.host.childNodes.length,0);
});

test('Action throwing lifetime cleanup cannot skip presentation release, native view disposal or fresh opening',async t=>{
  const h=await entry(t,{homeVisible:true});h.ui.configureProviders({readPlaylistDestinations:destinations});
  let releases=0;h.home.runtime.retainPlaytablePresentation=()=>()=>{releases++;};
  const selected=selection(h.native.runtime.snapshot().scopeKey),dispose=selected.lifetime.dispose,failure=new Error('lifetime cleanup');
  selected.lifetime.dispose=()=>{dispose();throw failure;};
  const baseline=new Set(h.document.body.childNodes);assert.equal(open(h,selected),true);await drain();
  const result=attempt(()=>h.ui.configureProviders({readPlaylistDestinations:destinations}));
  if(result.error) assert.equal(result.error,failure);
  await drain();assert.equal(selected.disposals(),1);assert.equal(releases,1);assert.equal(selected.invalidations(),0);
  assert.equal(h.modal().hidden,true);
  assert.ok(h.document.body.childNodes.filter(node=>!baseline.has(node)).every(node=>node.id.startsWith('anchor-')));
  const next=selection(h.native.runtime.snapshot().scopeKey);assert.equal(open(h,next),true);await drain();
  h.ui.configureProviders({});await drain();assert.equal(next.disposals(),1);assert.equal(releases,2);
});

test('Playlist root throwing registry cleanup still releases independent subscriptions and view',async t=>{
  const h=entryEnvironment(t),native=nativeShell(h,{visible:true,playlistId:'one',payload:playlistPayload('one')});
  const {mountPlaylists}=await load('playlists/native.mjs');
  let releases=0;const failure=new Error('registry cleanup');
  native.runtime.subscribeNotificationRegistry=()=>()=>{releases++;throw failure;};
  const owner=mountPlaylists({host:h.host,runtime:native.runtime});await drain();
  assert.ok(native.listeners.size>0);assert.ok(h.host.childNodes.length>0);
  const result=attempt(()=>owner.dispose());if(result.error) assert.equal(result.error,failure);
  await drain();assert.equal(releases,1);assert.equal(native.listeners.size,0);assert.equal(h.host.childNodes.length,0);
  assert.doesNotThrow(()=>owner.dispose());assert.equal(releases,1,'throwing disposer not retried');
});
