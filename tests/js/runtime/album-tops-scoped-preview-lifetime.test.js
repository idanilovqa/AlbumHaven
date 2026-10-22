'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,F}=require('./scoped-preview-fixtures/preview.cjs');
for(const [name,patch]of [['information',{information:'all'}],['disabled',{disabled:1}],['blocked',{blocked:null}],['currentness',{isCurrent:null}],['draft',{draft:{}}]])test('malformed update is atomic '+name,async t=>{
 const h=await setup(t),nodes=h.rows(),move=h.row(F.A).querySelector('[data-album-draft-move]');move.focus();assert.throws(()=>h.update(patch),TypeError);assert.deepEqual(h.rows(),nodes);assert.equal(h.document.activeElement,move);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);assert.equal(h.update(),true);
});
for(const mode of ['duplicate','missing'])test('malformed key vector rejects before native reconciliation '+mode,async t=>{
 const h=await setup(t),before=h.rows(),value=h.draft.getSnapshot(),items=value.items.map(row=>({...row}));
 if(mode==='duplicate')items[1]={...items[1],album_ref:items[0].album_ref};else {delete items[0].album_ref;delete items[0].selection_key;}
 assert.throws(()=>h.update({value:{...value,items}}),TypeError);assert.deepEqual(h.rows(),before);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);
});
for(const flags of [{disabled:true},{blocked:true},{disabled:true,blocked:false}])test('explicit action block prevents exact draft mutation '+JSON.stringify(flags),async t=>{
 const h=await setup(t,{props:flags});for(const node of h.host.querySelectorAll('[data-album-draft-move], [data-album-draft-remove]'))assert.equal(node.disabled,true);
 h.click(h.row(F.A).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.selected(),[F.A,F.B,F.C]);
});
for(const reason of ['busy','denied'])test('actual controller '+reason+' retires action authority before any previously captured click',async t=>{
 const h=await setup(t),remove=h.row(F.A).querySelector('[data-album-draft-remove]'),state=h.controller.getSnapshot();
 h.replace(reason==='busy'?{...state,mutation:{status:'loading'}}:{...state,directory:{status:'denied',data:null}});h.update();h.click(remove);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);
 for(const node of h.host.querySelectorAll('[data-album-draft-remove]'))assert.equal(node.disabled,true);
});
test('stale exact snapshot retires only this preview and cannot mutate latest Selected',async t=>{
 const h=await setup(t),old=h.draft.getSnapshot(),remove=h.row(F.A).querySelector('[data-album-draft-remove]');h.draft.edit({title:'Changed'});assert.notEqual(h.draft.getSnapshot(),old);assert.equal(h.update({value:old}),false);h.click(remove);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);assert.equal(h.rows().length,0);
});
test('non-Selected transition retires preview then a fresh mount reads actual current selection',async t=>{
 const h=await setup(t);h.draft.setTab('all');assert.equal(h.update(),false);assert.equal(h.rows().length,0);h.draft.remove(F.B);h.draft.setTab('selected');const next=h.own(h.mount(h.host,h.runtime,h.props()));assert.equal(next.update(h.props()),true);assert.deepEqual(h.keys(),[F.A,F.C]);
});
test('actual scope replacement prevents old rows and callbacks from surviving',async t=>{
 const h=await setup(t),remove=h.row(F.A).querySelector('[data-album-draft-remove]');h.replace({...h.controller.getSnapshot(),scopeKey:'other'});assert.equal(h.update(),false);h.click(remove);assert.equal(h.rows().length,0);assert.equal(h.calls.galleries[0].options.isCurrent(),false);
});
test('stale constructor preserves existing current lease and host children',async t=>{
 const h=await setup(t),nodes=h.rows();const stale=h.own(h.mount(h.host,h.runtime,h.props({isCurrent:()=>false})));assert.deepEqual(h.rows(),nodes);assert.equal(stale.update(h.props()),false);stale.dispose();assert.deepEqual(h.rows(),nodes);assert.equal(h.update(),true);
});
test('malformed replacement preserves original lease and working remove action',async t=>{
 const h=await setup(t),nodes=h.rows();assert.throws(()=>h.mount(h.host,h.runtime,h.props({information:'bad'})),TypeError);assert.deepEqual(h.rows(),nodes);h.click(h.row(F.A).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.selected(),[F.B,F.C]);
});
test('valid replacement owns host while stale dispose update and detached click remain inert',async t=>{
 const h=await setup(t),old=h.preview,remove=h.row(F.A).querySelector('[data-album-draft-remove]');const next=h.own(h.mount(h.host,h.runtime,h.props())),nodes=h.rows();old.dispose();assert.equal(old.update(h.props()),false);h.click(remove);assert.deepEqual(h.rows(),nodes);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);assert.equal(next.update(h.props()),true);
});
test('dispose cancels actual native resources without disposing caller draft',async t=>{
 const h=await setup(t),remove=h.row(F.A).querySelector('[data-album-draft-remove]');h.preview.dispose();h.preview.dispose();h.click(remove);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);assert.equal(h.draft.edit({title:'Still owned by caller'}),true);assert.equal(h.rows().length,0);assert.equal(h.frames.size,0);assert.equal(h.observers.every(owner=>owner.retired),true);
});
test('currentness callback changing actual draft cannot publish or act on its earlier snapshot',async t=>{
 const h=await setup(t),before=h.draft.getSnapshot();let once=true;const isCurrent=()=>{if(once){once=false;h.draft.edit({title:'Reentrant newer snapshot'});}return true;};assert.equal(h.preview.update(h.props({value:before,isCurrent})),false);assert.equal(h.rows().length,0);assert.deepEqual(h.selected(),[F.A,F.B,F.C]);
});
test('actual card renderer reentry replacing the host cannot be torn down by old update cleanup',async t=>{
 const h=await setup(t),actual=h.runtime.galleryCardHtml;let next=null,armed=true;
 h.runtime.galleryCardHtml=function(...args){const html=actual(...args);if(armed){armed=false;next=h.own(h.mount(h.host,h.runtime,h.props({information:'minimal'})));}return html;};
 h.preview.update(h.props({information:'full'}));assert.ok(next);const nodes=h.rows();assert.equal(nodes.length,3);h.preview.dispose();assert.deepEqual(h.rows(),nodes);assert.equal(next.update(h.props()),true);h.click(h.row(F.B).querySelector('[data-album-draft-remove]'));assert.deepEqual(h.selected(),[F.A,F.C]);
});
