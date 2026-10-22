'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,F}=require('./scoped-preview-fixtures/preview.cjs');
test('third currentness observation inside actual Gallery admission preserves queued same-owner successor',async t=>{
 const h=await setup(t),snapshot=h.draft.getSnapshot();let observations=0,entered=false;
 const isCurrent=()=>{observations++;if(observations===3){entered=true;h.preview.update(h.props({information:'full',disabled:true,blocked:true,isCurrent:()=>true}));}return true;};
 h.preview.update(h.props({information:'minimal',disabled:false,blocked:false,isCurrent}));assert.equal(entered,true);assert.equal(h.draft.getSnapshot(),snapshot);assert.deepEqual(h.calls.cards.slice(-3).map(([props])=>props.artist),['First','Second','First']);assert.match(h.row(F.A).querySelector('.gallery-card-info').textContent,/First/);
 for(const node of h.host.querySelectorAll('[data-album-draft-move], [data-album-draft-remove]'))assert.equal(node.disabled,true);h.click(h.row(F.A).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.selected(),[F.A,F.B,F.C]);
 assert.equal(h.preview.update(h.props({information:'minimal',disabled:false,blocked:false})),true);assert.doesNotMatch(h.row(F.A).querySelector('.gallery-card-info').textContent,/First/);const remove=h.row(F.A).querySelector('[data-album-draft-remove]');assert.equal(remove.disabled,false);h.click(remove);assert.deepEqual(h.selected(),[F.B,F.C]);assert.equal(h.preview.update(h.props()),true);assert.deepEqual(h.keys(),[F.B,F.C]);
});
