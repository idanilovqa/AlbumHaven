'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const H=require('./scoped-preview-fixtures/preview.cjs'),R=require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
const {setup,F,key,tick}=H;
for(const direction of ['End','Home'])test('actual collection keyboard reorder preserves precise Selected order and contiguous native separators '+direction,async t=>{
 const h=await setup(t),{mountCollectionReorder}=await F.load('playlists/reorder.mjs'),source=Object.freeze({draft:h.draft}),announcements=[];
 const snapshot=()=>{const value=h.draft.getSnapshot();return {scopeKey:value.scopeKey,draftKey:'new-album-top',source,selectedRowKey:null,itemsComplete:true,canEdit:true,canReorder:true,unfiltered:true,defaultOrder:true,busy:value.busy,rows:value.items.map(row=>({...row,row_key:key(row)}))};};
 const reorder=h.own(mountCollectionReorder(h.host,{snapshot,collectionKey:v=>v.draftKey,itemKey:key,rowSelector:'[data-album-draft-key]',handleSelector:'[data-album-draft-move]',rowKeyAttribute:'data-album-draft-key',layout:'grid',onAnnounce:value=>announcements.push(value),onReorder:ids=>h.draft.reorder(ids)}));
 const off=h.draft.subscribe(()=>{h.update();reorder.update();});h.own({dispose:off});
 const id=direction==='End'?F.A:F.C,handle=h.row(id).querySelector('[data-album-draft-move]');handle.focus();handle.dispatchEvent(new h.context.Event('keydown',{key:direction,bubbles:true}));
 const expected=direction==='End'?[F.B,F.C,F.A]:[F.C,F.A,F.B];assert.deepEqual(h.selected(),expected);assert.deepEqual(h.keys(),expected);assert.equal(h.document.activeElement,handle);assert.equal(announcements.length,1);
 const headers=[...h.host.querySelectorAll('.family-artist-header')];assert.equal(headers.length,2);assert.deepEqual(headers.map(node=>Number(node.getAttribute('data-gallery-album-count'))),direction==='End'?[1,2]:[2,1]);
});
for(const artist of [null,17,{toString(){throw new Error('Display object must not be coerced');}}])test('defensive returned-snapshot label seam renders Unknown without object coercion '+typeof artist,async t=>{
 const h=await setup(t,{noMount:true});
 // Defensive component seam only: actual draft never admits these malformed display labels.
 const original=h.draft.getSnapshot(),value={...original,items:original.items.map((row,index)=>index?row:{...row,artist})};
 const facade={...h.draft,getSnapshot:()=>value};h.own(h.mount(h.host,h.runtime,{draft:facade,value,isCurrent:()=>true}));assert.equal(h.calls.separators[0][0].artist,'Unknown artist');assert.deepEqual(h.keys(),[F.A,F.B,F.C]);assert.equal(h.draft.getSnapshot(),original);
});
test('late native frame callbacks cannot measure or remove successor preview ownership',async t=>{
 const h=await setup(t),callbacks=[...h.frames.values()],next=h.own(h.mount(h.host,h.runtime,h.props())),nodes=h.rows();h.preview.dispose();for(const callback of callbacks)callback(0);assert.deepEqual(h.rows(),nodes);assert.equal(next.update(h.props()),true);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);
});
test('exact provider replacement retires actual draft and stale Remove even with unchanged scope string',async t=>{
 const h=await setup(t),remove=h.row(F.A).querySelector('[data-album-draft-remove]');h.api.providers.listScopedAlbums=async()=>({albums:[],next_cursor:null});h.draft.refresh();assert.equal(h.update(),false);h.click(remove);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);assert.equal(h.rows().length,0);
});
async function remote(t){
 const h=await setup(t,{noMount:true}),{createAlbumTopDraft}=await F.load('album-tops/draft.mjs'),api=R.service();api.providers.listScopedAlbums=async()=>({albums:[F.album(11,{artist:'Local artist'})],next_cursor:null});
 api.control.acquireRemoteAlbum=async body=>({...api.acquisition(body),artist_scope_preview:{artist_scope:F.clone(body.artist_scope),evidence_version:R.VERSION,main_artist_match:true}});
 const draft=createAlbumTopDraft({controller:h.controller,providers:api.providers,artistScope:{root_artist_id:'3',mode:'artist'}});h.own({dispose:()=>draft.dispose()});await tick();assert.equal(draft.setRemoteTitle('Remote album'),true);await draft.searchRemote();await draft.selectRemote(draft.getSnapshot().remote.search.candidates[0]);
 const row=draft.getSnapshot().items.find(value=>value.source_kind==='remote_summary');assert.ok(row);const props=information=>({draft,value:draft.getSnapshot(),information,isCurrent:()=>true});const preview=h.own(h.mount(h.host,h.runtime,props('minimal')));return {...h,remoteDraft:draft,remoteRow:row,remoteApi:api,remoteProps:props,remotePreview:preview};
}
test('genuine acquired remote row keeps tracks-unavailable note outside native metadata and no media actions',async t=>{
 const h=await remote(t),row=h.row(key(h.remoteRow)),note=/tracks unavailable/i;assert.match(row.textContent,note);for(const info of row.querySelectorAll('.gallery-card-info'))assert.doesNotMatch(info.textContent,note);assert.equal(row.querySelectorAll('[data-gallery-card-intent]').length,0);
 const props=h.calls.cards.at(-1)[0];assert.equal(props.listeningSummaryHtml,'');assert.equal(props.artist,'');assert.equal(h.remoteApi.count('acquireRemoteAlbum'),1);assert.equal(h.remoteApi.count('execute'),0);
});
test('remote full information shows admitted Artist and never fabricates rating artwork or track totals',async t=>{
 const h=await remote(t),before=h.remoteDraft.getSnapshot();h.remotePreview.update(h.remoteProps('full'));const row=h.row(key(h.remoteRow));assert.match(row.textContent,/Remote artist/);assert.match(row.textContent,/tracks unavailable/i);assert.equal(row.querySelectorAll('[data-rating-value]').length,0);assert.equal(row.querySelectorAll('img').length,0);assert.equal(h.remoteDraft.getSnapshot(),before);assert.equal(h.remoteApi.count('acquireRemoteAlbum'),1);
});
test('remote Remove uses selection key and preserves acquisition evidence outside explicit Selected',async t=>{
 const h=await remote(t),id=key(h.remoteRow),source=F.clone(h.remoteRow.source);assert.ok(id);h.click(h.row(id).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.remoteDraft.getSnapshot().items.map(key),[F.A]);h.remoteDraft.resetArtistFilters();h.remotePreview.update(h.remoteProps('minimal'));assert.deepEqual(h.keys(),[F.A]);assert.deepEqual(h.remoteRow.source,source);assert.equal(h.remoteApi.count('acquireRemoteAlbum'),1);assert.equal(h.remoteApi.count('execute'),0);
});
