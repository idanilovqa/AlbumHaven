'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,F}=require('./scoped-preview-fixtures/preview.cjs');
function blocked(h){for(const button of h.host.querySelectorAll('[data-album-draft-move], [data-album-draft-remove]'))assert.equal(button.disabled,true);h.click(h.row(F.A).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.selected(),[F.A,F.B,F.C]);}
test('same-owner currentness reentry keeps the newer complete information and disabled props',async t=>{
 const h=await setup(t),snapshot=h.draft.getSnapshot();let armed=true;
 const isCurrent=()=>{if(armed){armed=false;h.preview.update(h.props({information:'full',disabled:true,blocked:true,isCurrent:()=>true}));}return true;};
 h.preview.update(h.props({information:'minimal',disabled:false,blocked:false,isCurrent}));assert.equal(armed,false);assert.equal(h.draft.getSnapshot(),snapshot);assert.deepEqual(h.calls.cards.slice(-3).map(([props])=>props.artist),['First','Second','First']);assert.match(h.row(F.A).querySelector('.gallery-card-info').textContent,/First/);blocked(h);
});
test('same-owner actual renderer reentry drains the queued latest update after retiring outer repaint',async t=>{
 const h=await setup(t),snapshot=h.draft.getSnapshot(),actual=h.runtime.galleryCardHtml;let armed=true;
 h.runtime.galleryCardHtml=function(...args){const html=actual(...args);if(armed){armed=false;h.preview.update(h.props({information:'minimal',disabled:true,blocked:true}));}return html;};
 h.preview.update(h.props({information:'full',disabled:false,blocked:false}));assert.equal(armed,false);assert.equal(h.draft.getSnapshot(),snapshot);assert.deepEqual(h.calls.cards.slice(-3).map(([props])=>props.artist),['','','']);assert.doesNotMatch(h.row(F.A).querySelector('.gallery-card-info').textContent,/First/);blocked(h);
 assert.equal(h.preview.update(h.props({information:'full',disabled:false,blocked:false})),true);assert.match(h.row(F.A).querySelector('.gallery-card-info').textContent,/First/);const remove=h.row(F.A).querySelector('[data-album-draft-remove]');assert.equal(remove.disabled,false);h.click(remove);assert.deepEqual(h.selected(),[F.B,F.C]);assert.equal(h.preview.update(h.props()),true);assert.deepEqual(h.keys(),[F.B,F.C]);
});
