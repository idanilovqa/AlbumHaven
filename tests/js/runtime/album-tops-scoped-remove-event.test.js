'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('./scoped-preview-fixtures/preview.cjs');
for(const reenter of [false,true])test('Remove owns its actual bubbling event before currentness and preserves usable native Gallery '+reenter,async t=>{
 const h=await P.setup(t),gallery=h.calls.galleries[0].owner,remove=h.row(P.F.A).querySelector('[data-album-draft-remove]');
 let bubbled=0,observed=false,event=null,armed=false;
 const listener=()=>{bubbled++;};h.host.addEventListener('click',listener);t.after(()=>h.host.removeEventListener('click',listener));
 h.preview.update(h.props({isCurrent:()=>{if(armed){armed=false;observed=true;assert.equal(event.stopped,true,'owned event is stopped before callback-capable currentness');if(reenter)h.preview.update(h.props({information:'full'}));}return true;}}));
 event=new h.context.Event('click',{bubbles:true});armed=true;remove.dispatchEvent(event);
 assert.equal(observed,true);assert.equal(bubbled,0);assert.equal(h.calls.galleries.length,1);assert.equal(h.calls.galleries[0].owner,gallery);
 assert.deepEqual(h.selected(),reenter?[P.F.A,P.F.B,P.F.C]:[P.F.B,P.F.C]);
 assert.equal(h.preview.update(h.props()),true);assert.deepEqual(h.keys(),h.selected());
 h.click(h.row(P.F.B).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.selected(),reenter?[P.F.A,P.F.C]:[P.F.C]);
 assert.equal(h.preview.update(h.props()),true);assert.deepEqual(h.keys(),h.selected());assert.equal(bubbled,0);assert.equal(h.calls.galleries[0].owner,gallery);
});
