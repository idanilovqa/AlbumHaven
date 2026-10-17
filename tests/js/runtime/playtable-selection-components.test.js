const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture: nativeFixture} = require('./home-friends-native-app-fixture.cjs');
const repo = path.resolve(__dirname, '../../..');
const load = () => import('../../../music_app/static/js/playtables/native-selection.mjs');
async function fixture(t, keys = ['a', 'b']) {
  const native = nativeFixture(t), host = native.host;
  host.innerHTML = keys.map(key => `<div data-cdt-row-key="${key}" tabindex="0">${key.toUpperCase()}</div>`).join('');
  let value = {scopeKey:'owned',instance:{},rows:keys.map(rowKey => ({rowKey,readable:true,selectable:true}))};
  const listeners = new Set(), actions = [];
  const adapter = {snapshot:()=>value,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  const {mountPlaytableSelection} = await load();
  const mount = native.own(mountPlaytableSelection(host,{sourceAdapter:adapter,tableKey:'test',runtime:native.runtime,
    onPlaylistAction:(packet,lifetime)=>actions.push({packet,lifetime})}));
  const actionHost = host.parentElement.querySelector('.album-track-table__selection-actions');
  assert.ok(actionHost);
  return {host,doc:native.document,mount,adapter,actions,listeners,actionHost,native,
    click(key){native.click(host.querySelector(`[data-cdt-row-key="${key}"]`));},
    patch(patch){value={...value,...patch};for(const listener of [...listeners])listener();}};
}
test('native mount creates a React action sibling and retains table nodes through selection and refresh', async t => {
  const value = await fixture(t), before = value.host.querySelector('[data-cdt-row-key="a"]');
  assert.equal(value.actionHost.parentElement,value.host.parentElement);assert.notEqual(value.actionHost,value.host);
  value.click('a');assert.match(value.actionHost.querySelector('[role="status"]').textContent,/1 row selected/);
  assert.equal(value.mount.getSnapshot().selectedCount,1);assert.equal(value.host.querySelector('[data-cdt-row-key="a"]'),before);
  value.mount.update();assert.equal(value.host.querySelector('[data-cdt-row-key="a"]'),before);
  assert.equal(value.mount.openSelection(before),true);assert.equal(value.actions.length,1);
});
test('React replacement adapter retires previous receipts and disposal releases roots and listeners', async t => {
  const value=await fixture(t);value.click('a');value.mount.openSelection(value.host);const previous=value.actions[0].lifetime;
  const next={snapshot:()=>({scopeKey:'new',instance:'new-instance',rows:[{rowKey:'a',readable:true,selectable:true}]}),subscribe:()=>()=>{}};
  value.mount.update({sourceAdapter:next});assert.equal(previous.isCurrent(),false);assert.equal(value.listeners.size,0);
  assert.equal(value.mount.getSnapshot().selectedCount,0);value.click('a');assert.equal(value.mount.getSnapshot().scopeKey,'new');
  value.mount.dispose();assert.equal(value.host.listeners.length,0);assert.equal(value.actionHost.isConnected,false);
});
test('selected-count affordance consumes native Button with disabled and filtered-count states', async t => {
  const value=await fixture(t,['a','b','c']),add=value.native.named('Add to playlist',value.actionHost);
  assert.ok(add);assert.equal(add.disabled,true);assert.equal(add.textContent,'Add to playlist');
  for(const key of ['a','b','c'])value.mount.select(key,{toggle:true});
  value.patch({rows:[{rowKey:'a',readable:true,selectable:true},{rowKey:'b',readable:false,selectable:false},{rowKey:'c',readable:false,selectable:false}]});
  assert.equal(value.mount.getSnapshot().selectedCount,1);assert.equal(value.mount.getSnapshot().droppedCount,2);
  assert.equal(add.disabled,false);assert.equal(value.native.named('Add to playlist',value.actionHost),add);
  const status=value.actionHost.querySelector('[role="status"]');assert.match(status.textContent,/1 row selected/);
  assert.match(status.textContent,/2 no longer visible or selectable/);assert.equal(status.getAttribute('aria-live'),'polite');
  assert.match(fs.readFileSync(path.join(repo,'music_app/static/css/runtime/album-track-table.css'),'utf8'),/selection-actions[^{}]*\{[^}]*flex-wrap: wrap/);
});
test('consumer source construction is inert until commit and effect replay replaces disposed native adapters', async () => {
  const {createPlaytableSource}=await load();let created=0,retired=0,updated=0;
  const instance={},context={scopeKey:'owned'},rows=[{id:'a'}];
  const runtime={openPlaylistAction(){},createPlaytableSource(){created++;let disposed=false;return{
    snapshot:()=>disposed?null:{scopeKey:'owned',instance},subscribe:()=>()=>{},
    updateRows(){assert.equal(disposed,false);updated++;return true;},resolveRows:()=>null,
    dispose(){assert.equal(disposed,false);disposed=true;retired++;}};}};
  const options={runtime,sourceRows:rows,rows,context,instance,revision:rows,isCurrent:()=>true,rowFacts:row=>({rowKey:row.id,readable:true})};
  assert.equal(created,0,'plain inputs are inert before explicit native acquisition');
  const first=createPlaytableSource(options);
  try{assert.equal(created,1);assert.equal(updated,1);assert.equal(first.sourceAdapter.snapshot().instance,instance);}finally{first.dispose();}
  assert.equal(retired,1);assert.equal(first.sourceAdapter.snapshot(),null);
  const second=createPlaytableSource(options);
  try{assert.equal(created,2);assert.equal(updated,2);assert.equal(second.sourceAdapter.snapshot().instance,instance);
    first.update(options);assert.equal(updated,2);assert.equal(first.sourceAdapter.snapshot(),null);
  }finally{second.dispose();}
  assert.equal(retired,2);
});
