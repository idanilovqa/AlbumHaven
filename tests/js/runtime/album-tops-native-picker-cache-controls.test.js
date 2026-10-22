'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, drain, nativeEnvironment} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {F, dataset} = require('./album-tops-membership-fixtures/full5000.cjs');
const N = 24, ZERO = {galleryCardHtml: 0, artboxHtml: 0, rowButtonHtml: 0};
const delta = (after, before) => Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));

async function fixture() {
  const env = nativeEnvironment(), data = dataset(N), original = structuredClone(data.data);
  const initial = F.state({editing: true, data: data.data}), controller = F.controllerFixture(initial);
  const searches = [], providers = {async searchAlbums(request) {searches.push({q: request.q}); return {albums: [], next_cursor: null};}};
  const {createAlbumTopDraft} = await load('album-tops/draft.mjs');
  const {mountAlbumPicker} = await load('album-tops/builder.mjs');
  const draft = createAlbumTopDraft({controller: controller.controller, providers});
  const initialItems = draft.getSnapshot().items;
  const counts = {...ZERO}, runtime = {...env.runtime,
    galleryCardHtml(config) {counts.galleryCardHtml++; return env.runtime.galleryCardHtml(config);},
    artboxHtml(config) {counts.artboxHtml++; return env.runtime.artboxHtml(config);},
    buttonHtml(config) {
      if (Object.hasOwn(config.attributes || {}, 'data-album-draft-move') || Object.hasOwn(config.attributes || {}, 'data-album-draft-remove')) counts.rowButtonHtml++;
      return env.runtime.buttonHtml(config);
    },
  };
  const props = () => {const value = draft.getSnapshot(); return {draft, value, disabled: value.busy || value.stale || value.denied};};
  let picker, unsubscribe = () => {};
  try {
    picker = mountAlbumPicker(env.host, runtime, props());
    unsubscribe = draft.subscribe(() => picker.update(props()));
  } catch (error) {picker?.dispose(); draft.dispose(); throw error;}
  const rows = () => [...env.host.querySelectorAll('[data-album-draft-key]')];
  const remember = () => new Map(rows().map(row => [row.getAttribute('data-album-draft-key'), {
    row, card: row.firstElementChild, cardMarkup: row.firstElementChild.firstElementChild,
    move: row.querySelector('[data-album-draft-move]'), remove: row.querySelector('[data-album-draft-remove]'),
  }]));
  function retained(before, expected) {
    assert.deepEqual(rows().map(row => row.getAttribute('data-album-draft-key')), expected.map(row => row.album_ref));
    for (const row of rows()) {
      const ref = row.getAttribute('data-album-draft-key'), old = before.get(ref); assert.ok(old);
      assert.equal(row, old.row, 'physical selected row is retained');
      assert.equal(row.firstElementChild, old.card, 'card host is retained');
      assert.equal(row.firstElementChild.firstElementChild, old.cardMarkup, 'canonical card DOM is retained');
      assert.equal(row.querySelector('[data-album-draft-move]'), old.move, 'native reorder handle is retained');
      assert.equal(row.querySelector('[data-album-draft-remove]'), old.remove, 'native remove control is retained');
      assert.equal(draft.getSnapshot().items.find(item => item.album_ref === ref), initialItems.find(item => item.album_ref === ref), 'draft row object is retained');
    }
  }
  function unchanged() {assert.deepEqual(initial.detail.data, original); assert.deepEqual(data.data, original); assert.deepEqual(controller.calls, []);}
  return {...env, data, draft, counts, searches, initialItems, rows, remember, retained, unchanged, runtime,
    replace:controller.replace, initial, present:value=>picker.update({draft,value,disabled:value.busy||value.stale||value.denied}),
    dispose() {unsubscribe(); picker.dispose(); draft.dispose(); assert.equal(controller.listeners.size, 0, 'draft controller subscription retired'); env.assertClean();}};
}

test('native picker invalidates changed metadata and control labels under the same selected row key', async () => {
  const h = await fixture();
  try {
    const nodes=h.remember(), first=nodes.get(h.data.expected[0].album_ref), before={...h.counts};
    const value=h.draft.getSnapshot(), changed={...value.items[0],title:'Updated edition',artist:'Updated artist',year:2026,local_album_id:999};
    h.present({...value,items:[changed,...value.items.slice(1)]});
    assert.match(first.card.textContent,/Updated edition/); assert.match(first.card.textContent,/Updated artist/); assert.match(first.card.textContent,/2026/);
    assert.equal(first.move.getAttribute('aria-label'),'Reorder Updated edition'); assert.equal(first.remove.getAttribute('aria-label'),'Remove Updated edition');
    assert.equal(h.rows()[0],first.row); assert.equal(first.row.querySelector('[data-album-draft-remove]'),first.remove);
    assert.deepEqual(delta(h.counts,before),{galleryCardHtml:1,artboxHtml:1,rowButtonHtml:2});
    const stable={...h.counts};h.present({...value,items:[{...changed},...value.items.slice(1)]});assert.deepEqual(delta(h.counts,stable),ZERO);
    const restore={...h.counts};h.present(value);assert.match(first.card.textContent,/Retained 1/);assert.equal(first.remove.getAttribute('aria-label'),'Remove Retained 1');
    assert.deepEqual(delta(h.counts,restore),{galleryCardHtml:1,artboxHtml:1,rowButtonHtml:2});h.unchanged();
  } finally {h.dispose();}
});

for(const reason of ['busy','denied'])test(`native picker cached controls reflect ${reason}, block edits and recover`,async()=>{
  const h=await fixture();
  try {
    const nodes=h.remember(),first=nodes.get(h.data.expected[0].album_ref),before={...h.counts};
    h.replace(reason==='busy'?{...h.initial,mutation:{...h.initial.mutation,status:'loading'}}:
      {...h.initial,detail:{...h.initial.detail,data:{...h.initial.detail.data,allowed_actions:{...h.initial.detail.data.allowed_actions,can_edit:false}}}});
    const blocked=h.draft.getSnapshot();assert.equal(blocked[reason],true);
    assert.equal(first.remove.disabled,true);assert.equal(first.move.disabled,true);assert.equal(first.remove.getAttribute('aria-disabled'),'true');
    assert.equal(h.host.querySelector('input[type="search"]').disabled,true);
    assert.deepEqual(delta(h.counts,before),{galleryCardHtml:0,artboxHtml:0,rowButtonHtml:N*2});
    h.click(first.remove);first.move.dispatchEvent(new h.context.Event('keydown',{key:'End'}));
    assert.equal(h.draft.getSnapshot(),blocked);h.retained(nodes,h.data.expected);h.unchanged();
    const recover={...h.counts};h.replace(h.initial);
    assert.equal(first.remove.disabled,false);assert.equal(first.move.disabled,false);assert.equal(first.remove.getAttribute('aria-disabled'),null);
    assert.equal(h.host.querySelector('input[type="search"]').disabled,false);h.retained(nodes,h.data.expected);
    assert.deepEqual(delta(h.counts,recover),{galleryCardHtml:0,artboxHtml:0,rowButtonHtml:N*2});
    first.remove.focus();h.click(first.remove);assert.deepEqual(h.draft.getSnapshot().items,h.data.expected.slice(1));h.unchanged();
  } finally {h.dispose();}
});

for(const renderer of ['galleryCardHtml','artboxHtml','buttonHtml'])test(`native picker invalidates cached output after ${renderer} replacement`,async()=>{
  const h=await fixture();
  try {
    const nodes=h.remember(),before={...h.counts},previous=h.runtime[renderer];let replacementCalls=0;
    h.runtime[renderer]=config=>{replacementCalls++;return previous(config).replace(/^(\s*<[\w-]+)/,`$1 data-picker-replacement="${renderer}"`);};
    h.present(h.draft.getSnapshot());
    assert.ok(replacementCalls>0);
    assert.deepEqual(delta(h.counts,before),renderer==='buttonHtml'?{galleryCardHtml:0,artboxHtml:0,rowButtonHtml:N*2}:{galleryCardHtml:N,artboxHtml:N,rowButtonHtml:0});
    for(const row of h.rows()) {
      assert.equal(row,nodes.get(row.getAttribute('data-album-draft-key')).row);
      assert.ok(row.querySelector(`[data-picker-replacement="${renderer}"]`));
      if(renderer==='buttonHtml')assert.equal(row.querySelector('[data-album-draft-remove]'),nodes.get(row.getAttribute('data-album-draft-key')).remove);
    }
    const stable={...h.counts};h.present(h.draft.getSnapshot());assert.deepEqual(delta(h.counts,stable),ZERO);h.unchanged();
  } finally {h.dispose();}
});

test('native picker uses the latest search row for selection when cached visible metadata is unchanged',async()=>{
  const env=nativeEnvironment(),initial=F.state(),controller=F.controllerFixture(initial),admissions=[];
  const old={local_album_id:13,title:'Same edition',artist:'Same artist',year:2002,edition_marker:'old'};
  const current={...old,edition_marker:'current'},providers={async searchAlbums(){return{albums:[current],next_cursor:null};},async admitAlbum(local){admissions.push(local);return{album_ref:F.C};}};
  const {createAlbumTopDraft}=await load('album-tops/draft.mjs'),{mountAlbumPicker}=await load('album-tops/builder.mjs');
  const draft=createAlbumTopDraft({controller:controller.controller,providers});let picker,unsubscribe=()=>{};
  // Transparent call observation: preserve the real admission/domain behavior.
  const selectedArguments=[],realSelect=draft.select;
  draft.select=function(...args){selectedArguments.push(args[0]);return realSelect.apply(this,args);};
  try {
    await draft.setQuery('same');const value=draft.getSnapshot();
    picker=mountAlbumPicker(env.host,env.runtime,{draft,value:{...value,search:{...value.search,items:[old]}},disabled:false});
    const select=env.host.querySelector('[data-gallery-card-intent="select"]');assert.ok(select);
    picker.update({draft,value:{...value,search:{...value.search,items:[current]}},disabled:false});
    assert.equal(env.host.querySelector('[data-gallery-card-intent="select"]'),select);
    unsubscribe=draft.subscribe(()=>{const next=draft.getSnapshot();picker.update({draft,value:next,disabled:next.busy||next.stale||next.denied});});
    env.click(select);assert.equal(selectedArguments.length,1);assert.equal(selectedArguments[0],current,'picker passes the latest row object to the real draft');await drain();assert.deepEqual(admissions,[13]);assert.equal(draft.getSnapshot().items[0].edition_marker,'current');assert.deepEqual(controller.calls,[]);
  } finally {unsubscribe();picker?.dispose();draft.dispose();env.assertClean();}
});
