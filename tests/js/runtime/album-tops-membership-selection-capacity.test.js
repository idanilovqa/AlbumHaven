const test=require('node:test'),assert=require('node:assert/strict');
const F=require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
test('at the existing5000 cap admission is blocked while remove/reorder/search stay live, and one removal permits one addition',async t=>{
  const {createAlbumTopDraft}=await F.load('album-tops/draft.mjs');
  const items=Array.from({length:5000},(_,index)=>({item_ref:F.id(10000+index),album_ref:F.id(20000+index),title:'Retained '+index,artist:'Artist',year:null}));
  const data=F.detail({items,edit_draft:{items:items.map(({item_ref,album_ref})=>({item_ref,album_ref})),publication_preview_required:false}}),original=F.clone(data);
  const c=F.controllerFixture(F.state({editing:true,data})),p=F.providerFixture({search:()=>({albums:[F.album(13)],next_cursor:null})});
  const draft=createAlbumTopDraft({controller:c.controller,providers:p.providers});t.after(()=>draft.dispose());
  await draft.setQuery('Found');assert.equal(p.calls.search.length,1);assert.equal(await draft.select(F.album(13)),false);assert.equal(p.calls.admit.length,0);
  const refs=items.map(row=>row.album_ref);[refs[0],refs[1]]=[refs[1],refs[0]];draft.reorder(refs);assert.equal(draft.getSnapshot().items[0].album_ref,refs[0]);
  draft.remove(items[0].album_ref);assert.equal(draft.getSnapshot().items.length,4999);await draft.select(F.album(13));
  assert.equal(p.calls.admit.length,1);assert.equal(draft.getSnapshot().items.length,5000);assert.equal(draft.getSnapshot().items.at(-1).album_ref,F.C);
  assert.equal(c.calls.length,0);assert.deepEqual(data,original);
});
