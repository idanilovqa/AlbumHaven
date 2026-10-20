'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('./scoped-preview-fixtures/preview.cjs');
for(const mode of ['cards','list','covers'])test(`native ${mode} reaches exact Card and whole Gallery geometry`,async t=>{
 const h=await P.setup(t,{props:{displayMode:mode,information:'full'}}),before=h.draft.getSnapshot();
 assert.equal(h.calls.galleries[0].options.readSnapshot().displayMode,mode);
 for(const [props]of h.calls.cards)assert.equal(props.displayMode,mode);
 assert.deepEqual(h.keys(),[P.F.A,P.F.B,P.F.C]);assert.deepEqual(h.selected(),h.keys());
 assert.equal(h.host.querySelectorAll('.family-artist-header').length,3);
 assert.equal(h.host.querySelectorAll('.gallery-card-info').length,mode==='covers'?0:3);
 if(mode==='covers')assert.equal(h.host.querySelectorAll('.gallery-card__focus-title').length,3);
 assert.equal(h.draft.getSnapshot(),before);assert.deepEqual(h.calls.preferences,[]);
});
for(const mode of [undefined,null,'rows','full','',0])test(`explicit invalid preview displayMode ${String(mode)} is atomic`,async t=>{
 const h=await P.setup(t),before=h.host.innerHTML,rows=h.rows(),snapshot=h.draft.getSnapshot();
 assert.throws(()=>h.preview.update(h.props({displayMode:mode})),TypeError);
 assert.equal(h.host.innerHTML,before);assert.deepEqual(h.rows(),rows);assert.equal(h.draft.getSnapshot(),snapshot);
 assert.throws(()=>h.mount(h.host,h.runtime,h.props({displayMode:mode})),TypeError);
 assert.equal(h.host.innerHTML,before);assert.equal(h.update({displayMode:'list'}),true);
});
test('complete-prop omission returns cards while preserving minimal legacy default',async t=>{
 const h=await P.setup(t,{props:{displayMode:'list',information:'full'}});assert.equal(h.update(),true);
 assert.equal(h.calls.galleries[0].options.readSnapshot().displayMode,'cards');assert.equal(h.calls.cards.at(-1)[0].artist,'');
});
test('view transitions retain row/Move/Remove identity and focused control with usable native owner',async t=>{
 const h=await P.setup(t),rows=h.rows(),moves=rows.map(r=>r.querySelector('[data-album-draft-move]')),removes=rows.map(r=>r.querySelector('[data-album-draft-remove]'));
 moves[1].focus();for(const mode of ['list','covers','cards']){assert.equal(h.update({displayMode:mode,information:'full'}),true);assert.deepEqual(h.rows(),rows);assert.deepEqual(h.rows().map(r=>r.querySelector('[data-album-draft-move]')),moves);assert.deepEqual(h.rows().map(r=>r.querySelector('[data-album-draft-remove]')),removes);assert.equal(h.document.activeElement,moves[1]);}
 h.click(removes[1]);h.update({displayMode:'list',information:'full'});assert.deepEqual(h.selected(),[P.F.A,P.F.C]);assert.deepEqual(h.keys(),[P.F.A,P.F.C]);assert.equal(h.calls.galleries.length,1);
});
