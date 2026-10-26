'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.join(__dirname, '../../../music_app/static/js/album-tops');
const modules = Promise.all(['backend-providers.mjs','playback-source.mjs'].map(name => import(pathToFileURL(path.join(root,name)))));
const top = '11111111-1111-4111-8111-111111111111';
const item = '22222222-2222-4222-8222-222222222222';
const catalog = '33333333-3333-4333-8333-333333333333';
const ref = '44444444-4444-4444-8444-444444444444';
const context = 'a'.repeat(64), scopeKey = JSON.stringify(['41','7',context,1]);
const selection = () => ({version:'local-edition-selection-v1',selection_ref:ref,membership_revision:'b'.repeat(64)});
function capture(withSelection=true) {
  const source = {revision:'3',item_ref:item,catalog_ref:catalog,inventory_album_ref:'inventory-album:7:501',
    inventory_track_ref:'inventory-track:7:701',canonical_track_ref:'canonical-701'};
  return {top_ref:top,revision:'3',unavailable_items:[],albums:[{item_ref:item,catalog_ref:catalog,
    inventory_album_ref:'inventory-album:7:501',album_ref:'album-501',
    ...(withSelection?{listening_selection:selection()}:{}),tracks:[{queue_item_ref:item+':701',source,
      native_target:{inventory_track_ref:'inventory-track:7:701',path:'/synthetic/701.flac',track_ref:'/synthetic/701.flac',
        title:'Track',artist:'Artist',album_title:'Album',duration_seconds:99}}]}]};
}
async function provider(data) {
  const [{createAlbumTopBackendProviders}] = await modules;
  return createAlbumTopBackendProviders({acceptsScope:key=>key===scopeKey,
    transport:{context:()=>context,generation:()=>1,request:async()=>({status:'ready',context_ref:context,data})}});
}
const options = () => ({scopeKey,isCurrent:()=>true});

test('selection descriptor survives genuine native queue provider validation',async()=>{
  const p=await provider(capture());
  const result=await p.captureNativeQueue({top_ref:top,revision:'3'},options());
  assert.deepEqual(result.albums[0].listening_selection,selection());
  assert.ok(Object.isFrozen(result.albums[0].listening_selection));
  assert.equal(Object.hasOwn(result.albums[0].tracks[0].source,'selection_ref'),false);
});

test('missing optional selection preserves old exact queue album shape',async()=>{
  const p=await provider(capture(false));
  const result=await p.captureNativeQueue({top_ref:top,revision:'3'},options());
  assert.equal(Object.hasOwn(result.albums[0],'listening_selection'),false);
});

for(const [name,change] of [
  ['unknown version',{version:'proof'}],['zero reference',{selection_ref:'00000000-0000-0000-0000-000000000000'}],
  ['missing digest',{membership_revision:null}],['uppercase digest',{membership_revision:'B'.repeat(64)}],
  ['client manifest',{members:[]}],
]) test('native queue rejects invalid listening descriptor: '+name,async()=>{
  const data=capture();Object.assign(data.albums[0].listening_selection,change);
  const p=await provider(data);
  await assert.rejects(p.captureNativeQueue({top_ref:top,revision:'3'},options()),{status:502});
});

test('fresh playback payload carries frozen selection without changing six-key source authority',async()=>{
  const [, {createTopPlaybackSource}]=await modules;
  const data=capture(), calls=[];
  const source=createTopPlaybackSource({capture:data,scopeKey,isCurrent:()=>true,providers:{
    resolveNativePlayback:async command=>{calls.push(command);return {top_ref:top,source:command.source,
      native_target:data.albums[0].tracks[0].native_target};},
  }});
  // Mutating transport data after capture cannot change the retained selection.
  data.albums[0].listening_selection.selection_ref=top;
  const receipt=await source.prepare();
  assert.deepEqual(receipt.payload.listeningSelection,selection());
  assert.ok(Object.isFrozen(receipt.payload.listeningSelection));
  assert.equal(Object.keys(calls[0].source).length,6);
  assert.equal(source.aliasBinding(receipt.payload,{...receipt.payload,coverPath:'/synthetic/cover'}),true);
  assert.equal(source.aliasBinding(receipt.payload,{...receipt.payload,listeningSelection:selection()}),false);
  source.dispose();assert.equal(source.isReceiptCurrent(receipt),false);
});

test('legacy playback payload does not manufacture a selection or full listen',async()=>{
  const [, {createTopPlaybackSource}]=await modules;
  const data=capture(false);
  const source=createTopPlaybackSource({capture:data,scopeKey,isCurrent:()=>true,providers:{
    resolveNativePlayback:async command=>({top_ref:top,source:command.source,native_target:data.albums[0].tracks[0].native_target}),
  }});
  const receipt=await source.prepare();
  assert.equal(Object.hasOwn(receipt.payload,'listeningSelection'),false);
  assert.equal(Object.hasOwn(receipt.payload,'full_listens'),false);
  source.dispose();
});
