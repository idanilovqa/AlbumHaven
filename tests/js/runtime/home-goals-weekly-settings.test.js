'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, load, deferred, settle, plain} = require('./home-friends-native-app-fixture.cjs');
const ref = '11111111-1111-4111-8111-111111111111';

test('weekly defaults and count changes preserve 5+1, seven total and at-most caps', async () => {
  const m = await load('goals-weekly-settings-model.mjs'), initial = m.defaultWeeklySettings();
  assert.equal(initial.manual_count, 5); assert.equal(initial.suggestion_count, 1); assert.equal(initial.selection, 'random');
  assert.deepEqual(initial.sources, ['tops','playthroughs']);
  assert.strictEqual(m.changeWeeklyCount(initial, 'manual_count', 7), initial);
  const filtered = {...initial, filters: [{kind:'genre',value:'Rock',maximum:3},{kind:'year',value:2020,maximum:1}]};
  const next = m.changeWeeklyCount(filtered, 'manual_count', 2);
  assert.deepEqual(next.filters.map(row=>row.maximum),[2,1]);
  assert.equal(m.newWeeklyFilter(next, 'newer', [], 2025).maximum,2);
  assert.throws(()=>m.normalizeWeeklySettings({...initial,manual_count:7}));
  assert.throws(()=>m.normalizeWeeklySettings({...initial,manual_count:0,suggestion_count:0}));
  assert.throws(()=>m.normalizeWeeklySettings({...initial,filters:[{kind:'album_type',value:'Album',maximum:2}]}));
});
test('Older starts at existing Newer boundary and remains separately editable; duplicates rejected', async()=>{
  const m=await load('goals-weekly-settings-model.mjs');
  const state={...m.defaultWeeklySettings(),filters:[{kind:'newer',value:2025,maximum:3}]};
  const older=m.newWeeklyFilter(state,'older',[],2026); assert.equal(older.value,2025);
  const valid=m.normalizeWeeklySettings({...state,filters:[...state.filters,{...older,value:1990}]});
  assert.equal(valid.filters[0].value,2025);assert.equal(valid.filters[1].value,1990);
  assert.throws(()=>m.normalizeWeeklySettings({...state,filters:[state.filters[0],state.filters[0]]}));
});
test('preview accepts only actual bounded same-origin album DTOs, not remote media or duplicates', async()=>{
  const m=await load('goals-weekly-settings-model.mjs'), album={catalog_ref:ref,title:'One',artist_display:'Artist',release_year:2025,cover_url:'/api/cover/one',suggested:true};
  assert.equal(m.normalizeWeeklyPreview({albums:[album],summary:['Discovery: outside your usual genres.']}).albums.length,1);
  assert.throws(()=>m.normalizeWeeklyPreview({albums:[{...album,cover_url:'https://untrusted.test/pixel'}],summary:[]}));
  assert.throws(()=>m.normalizeWeeklyPreview({albums:[album,album],summary:[]}));
});
async function mounted(t, overrides={}, callbacks={}) {
  const h=fixture(t), m=await load('goals-weekly-settings-model.mjs'), {mountWeeklyGoalsSettings}=await load('goals-weekly-settings.mjs');
  const previews=[], saves=[], listeners=new Set(); let closed=0;
  const provider={subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async readWeeklySettings(){return {settings_revision:'1',settings:m.defaultWeeklySettings(),genres:['progressive rock','folk'],playthroughs:[{top_ref:ref,title:'Opeth'}]};},
    async previewWeeklySettings(command){previews.push(command);return {albums:[],summary:[]};},
    async saveWeeklySettings(command){saves.push(command);return {};},...overrides};
  h.c.crypto={randomUUID:()=>ref};
  const owner=h.own(mountWeeklyGoalsSettings(h.host,h.runtime,{provider,isCurrent:()=>true,onClose(){closed++;},...callbacks}));
  await settle();h.drain();
  return {...h,owner,previews,saves,listeners,provider,closed:()=>closed};
}
test('native weekly form uses only five filter choices and no placeholder option',async t=>{
  const h=await mounted(t);h.click(h.named('Add filter'));h.drain();
  const labels=h.document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]').filter(node=>!node.closest('[hidden]')).map(node=>node.textContent.trim());
  assert.deepEqual(labels,['Genre','Newer albums','Older albums','Decade','Year']);
  h.click(h.named('Cancel'));assert.equal(h.closed(),1);assert.equal(h.saves.length,0);
});
test('source pills remain label-only and save waits for acknowledgement',async t=>{
  const pending=deferred(),h=await mounted(t,{saveWeeklySettings:()=>pending.promise});
  const library=h.host.querySelectorAll('.ui-filter-pill').find(node=>node.textContent==='My library');
  const before=library.textContent;h.click(library);await settle();assert.equal(library.textContent,before);assert.equal(library.getAttribute('aria-pressed'),'true');
  h.click(h.named('Save'));await settle();assert.equal(h.closed(),0);assert.equal(h.named('Saving…').disabled,true);
  pending.resolve({});await settle();assert.equal(h.closed(),1);
});
test('newer preview replaces older results and disposed requests never render',async t=>{
  const pending=[];const h=await mounted(t,{previewWeeklySettings(){const wait=deferred();pending.push(wait);return wait.promise;}});
  const discovery=h.host.querySelectorAll('button').find(node=>node.textContent.includes('Explore outside'));h.click(discovery);await settle();
  assert.equal(pending.length,2);
  pending[1].resolve({albums:[{catalog_ref:ref,title:'Latest',artist_display:'Artist',release_year:2025,cover_url:null,suggested:true}],summary:[]});await settle();
  assert.match(h.host.textContent,/Latest/);
  pending[0].resolve({albums:[{catalog_ref:ref,title:'Stale',artist_display:'Artist',release_year:1970,cover_url:null,suggested:true}],summary:[]});await settle();
  assert.doesNotMatch(h.host.textContent,/Stale/);
  h.owner.dispose();assert.equal(h.host.textContent,'');assert.equal(h.listeners.size,0);
});
test('discovery switch retains focus and exposes missing taste metadata instead of claiming discovery',async t=>{
  const h=await mounted(t,{async previewWeeklySettings(){return {albums:[],summary:[],evidence_gaps:['listening_taste']};}});
  const button=h.host.querySelectorAll('button').find(node=>node.textContent.includes('Explore outside'));button.focus();h.click(button);await settle();
  assert.strictEqual(h.document.activeElement,button);assert.equal(button.getAttribute('aria-checked'),'true');
  assert.match(h.host.textContent,/Not available in this preview: outside-your-taste discovery/);
});
test('failed save retries identical operation key and never closes as success',async t=>{
  const commands=[];const h=await mounted(t,{async saveWeeklySettings(command){commands.push(plain(command));throw new Error('private diagnostic');}});
  h.click(h.named('Save'));await settle();assert.equal(h.closed(),0);assert.doesNotMatch(h.host.textContent,/private diagnostic/);
  h.click(h.named('Save'));await settle();assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);
});
test('superseded previews are aborted, even if provider ignores delivery fence',async t=>{
  const pending=[],signals=[];const h=await mounted(t,{previewWeeklySettings(_command,options){signals.push(options.signal);const wait=deferred();pending.push(wait);return wait.promise;}});
  const input=h.host.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='Your picks');
  input.value='6';input.dispatchEvent(new h.c.Event('change',{bubbles:true}));await settle();assert.equal(signals[0].aborted,true);
  h.owner.dispose();assert.equal(signals[1].aborted,true);
  pending.forEach(wait=>wait.resolve({albums:[],summary:[]}));await settle();assert.equal(h.host.textContent,'');
});

test('transport retirement clears private content before an asynchronous native close settles',async t=>{
  const h=await mounted(t);assert.match(h.host.textContent,/Opeth/);
  for(const notify of [...h.listeners])notify();
  assert.equal(h.host.textContent,'');assert.equal(h.closed(),1);
});

test('Add suggestions requires saved settings and is separate from preview and Save',async t=>{
  const revisions=[];const h=await mounted(t,{}, {onDraw:revision=>revisions.push(revision)});
  assert.deepEqual(revisions,[]);h.click(h.named('Add suggestions'));assert.deepEqual(revisions,['1']);
  const library=h.host.querySelectorAll('.ui-filter-pill').find(node=>node.textContent==='My library');h.click(library);await settle();
  assert.equal(h.named('Add suggestions').disabled,true);h.click(h.named('Add suggestions'));assert.deepEqual(revisions,['1']);
});

test('preview accepts real unlinked inventory identities without treating them as catalog refs',async()=>{
 const m=await load('goals-weekly-settings-model.mjs'),album={candidate_ref:'inventory-album:7:23',catalog_ref:null,title:'Unlinked',artist_display:'Artist',release_year:2025,cover_url:null,suggested:true};
 assert.equal(m.normalizeWeeklyPreview({albums:[album],summary:[]}).albums[0].catalog_ref,null);
 for(const candidate_ref of ['inventory-album:0:23','inventory-album:7:-1','/private/album','inventory-album:7:23/file'])assert.throws(()=>m.normalizeWeeklyPreview({albums:[{...album,candidate_ref}],summary:[]}));
 assert.throws(()=>m.normalizeWeeklyPreview({albums:[album,album],summary:[]}));
 assert.throws(()=>m.normalizeWeeklyPreview({albums:[{...album,catalog_ref:ref}],summary:[]}));
 assert.equal(m.normalizeWeeklyPreview({albums:[{...album,candidate_ref:ref,catalog_ref:ref}],summary:[]}).albums[0].candidate_ref,ref);
});
