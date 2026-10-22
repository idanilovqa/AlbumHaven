const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readRepo}=require('./native-home-harness.cjs');
const {fixture}=require('./playlist-native-review-fixture.cjs');
const {installNativeSearch}=require('./native-search-harness.cjs');
function appFixture(h=fixture()){const template=h.document.createElement('script');template.id='navigation-tree-item-template';template.textContent=readRepo('music_app/templates/components/navigation-tree-item.html');h.document.body.append(template);vm.runInContext(readRepo('music_app/static/js/navigation-tree.js'),h.context);h.runtime.navigationItemHtml=h.context.NavigationTree.renderItem;h.runtime.searchHtml=installNativeSearch(h).render;return h;}
test('ready populated native playlist directory suppresses empty status after status owner updates',async()=>{
 const {mountPlaylistDirectory}=await import('../../../music_app/static/js/playlists/native-app.mjs'),h=appFixture();const state={selectedPlaylistId:'p',resource:{status:'ready',data:{items:[{playlist_id:'p',title:'Populated',allowed_actions:{can_open:true}}]}},mutation:{status:'idle'}};
 const owner=mountPlaylistDirectory(h.host,h.runtime,{state,onSelect(){},onCreate(){},canCreate:false});assert.equal([...h.host.querySelectorAll('[role="status"]')].filter(node=>h.visible(node)&&node.textContent.includes('No Playlists yet.')).length,0);owner.update({state,onSelect(){},onCreate(){},canCreate:false});assert.equal([...h.host.querySelectorAll('[role="status"]')].filter(node=>h.visible(node)&&node.textContent.includes('No Playlists yet.')).length,0);owner.dispose();
});
test('native Choice focus-triggered provider retirement halts app render before any replacement table acquisition',async()=>{
 const {mountPlaylistsView}=await import('../../../music_app/static/js/playlists/native-app.mjs'),{defaultFilters}=await import('../../../music_app/static/js/playlists/model.mjs'),h=appFixture(),subscriptions=new Set(),preferences=new Set();
 const rows=[{row_key:'one',playlist_item_id:'one',source_readable:true,title:'One',availability:'local',duration_seconds:20}],detail={playlist_id:'p',title:'P',description:'',track_rows:rows,items_complete:true,author_order:true,allowed_actions:{}};
 const providers={};let state={scopeKey:'s',selectedPlaylistId:'p',resource:{status:'ready',data:{detail,items:[],allowed_actions:{}}},mutation:{status:'idle'},drafts:{},filters:{p:defaultFilters}},view,retireOnFocus=false,tableRenders=0,retiredAt=null;
 const controller={getSnapshot:()=>state,getLifecycleVersion:()=>1,subscribe(fn){subscriptions.add(fn);return()=>subscriptions.delete(fn);},available:()=>false,canRetryMutation:()=>false,filter(patch){state={...state,filters:{p:{...state.filters.p,...patch}}};view.update(props());},edit(){},load(){},reorder(){}};
 h.runtime.subscribeTrackPreferences=fn=>{preferences.add(fn);return()=>preferences.delete(fn);};const tableHtml=h.runtime.tableHtml;h.runtime.tableHtml=value=>{tableRenders++;return tableHtml(value);};
 const focus=h.context.Element.prototype.focus;h.context.Element.prototype.focus=function(){focus.call(this);this.dispatchEvent(new h.context.Event('focusin'));};
 const retire=()=>{if(retireOnFocus){retireOnFocus=false;retiredAt=tableRenders;view.dispose();}};h.document.addEventListener('focusin',retire);
 h.runtime.openChoice=(trigger,config)=>({isOpen:true,close(options={}){if(options.restoreFocus!==false)trigger.focus();},config});
 const baselineListeners=h.listeners().length;const props=()=>({controller,state,integrationProviders:providers,onSelect(){},onPrepareDraft(){}});view=mountPlaylistsView(h.host,h.runtime,props());h.click(h.host.querySelector('[data-playlists-action="filters"]'));
 const love=h.host.querySelector('button[aria-label="Love: Any love"]');assert.ok(love);h.click(love);retireOnFocus=true;
 state={...state,filters:{p:{...defaultFilters,love:'loved'}}};view.update(props());
 assert.notEqual(retiredAt,null,'native menu close focus triggered provider/view retirement');assert.equal(tableRenders,retiredAt,'retired pass acquired no replacement table');assert.equal(h.host.childNodes.length,0);assert.equal(preferences.size,0);assert.equal(subscriptions.size,0);assert.equal(h.listeners().length,baselineListeners,'retirement leaves no detached native control listeners');view.dispose();h.document.removeEventListener('focusin',retire);
});

function appState(defaultFilters) {
  const detail = {
    playlist_id: 'p', title: 'P', description: '', track_rows: [],
    items_complete: true, author_order: true, allowed_actions: {}
  };
  return {
    scopeKey: 's', selectedPlaylistId: 'p',
    resource: {status: 'ready', data: {detail, items: [], allowed_actions: {}}},
    mutation: {status: 'idle'}, drafts: {}, filters: {p: defaultFilters}
  };
}
function controllerFor(getState, subscriptions) {
  return {
    getSnapshot: getState, getLifecycleVersion: () => 1,
    subscribe(fn) {subscriptions.add(fn); return () => subscriptions.delete(fn);},
    available: () => false, canRetryMutation: () => false,
    filter() {}, edit() {}, load() {}, reorder() {}
  };
}
function trackHeaderResources(h) {
  const observers = new Set(), frames = new Map(), globalListeners = [];
  let next = 0;
  const observer = class {
    observe() {observers.add(this);}
    disconnect() {observers.delete(this);}
  };
  h.context.ResizeObserver = observer;
  h.context.MutationObserver = observer;
  h.context.requestAnimationFrame = fn => {frames.set(++next, fn); return next;};
  h.context.cancelAnimationFrame = id => frames.delete(id);
  h.context.addEventListener = (type, fn) => globalListeners.push({type, fn});
  h.context.removeEventListener = (type, fn) => {
    const index = globalListeners.findIndex(item => item.type === type && item.fn === fn);
    if (index >= 0) globalListeners.splice(index, 1);
  };
  return () => {
    assert.equal(observers.size, 0, 'native header observers released');
    assert.equal(frames.size, 0, 'native header frames cancelled');
    assert.equal(globalListeners.length, 0, 'native window listeners released');
  };
}
for (const phase of ['directory', 'initial-render']) {
  test(`app constructor unwinds header and subscriptions on ${phase} failure`, async () => {
    const {mountPlaylistsView} = await import('../../../music_app/static/js/playlists/native-app.mjs');
    const {defaultFilters} = await import('../../../music_app/static/js/playlists/model.mjs');
    const h = appFixture(), checkHeader = trackHeaderResources(h);
    const baseline = h.listeners().length, subscriptions = new Set(), preferences = new Set();
    const state = appState(defaultFilters), controller = controllerFor(() => state, subscriptions);
    h.runtime.subscribeTrackPreferences = fn => {preferences.add(fn); return () => preferences.delete(fn);};
    if (phase === 'directory') {
      h.runtime.navigationItemHtml = () => {throw new Error('directory renderer failed');};
    } else {
      controller.available = () => {throw new Error('initial-render provider failed');};
    }
    assert.throws(() => mountPlaylistsView(h.host, h.runtime, {
      state, controller, integrationProviders: {}, onSelect() {}
    }), /failed/);
    assert.equal(h.host.childNodes.length, 0);
    assert.equal(h.listeners().length, baseline);
    assert.equal(subscriptions.size, 0);
    assert.equal(preferences.size, 0);
    checkHeader();
  });
}
for (const action of ['filters', 'settings']) {
  test(`same-opening update during native ${action} initial focus remounts a live owner`, async () => {
    const {nativeDialogFixture} = require('./playlist-native-dialog-fixture.cjs');
    const {mountPlaylistsView} = await import('../../../music_app/static/js/playlists/native-app.mjs');
    const {defaultFilters} = await import('../../../music_app/static/js/playlists/model.mjs');
    const h = appFixture(nativeDialogFixture()), checkHeader = trackHeaderResources(h);
    h.context.innerWidth = 500;
    const subscriptions = new Set(), preferences = new Set(), state = appState(defaultFilters);
    const controller = controllerFor(() => state, subscriptions), providers = {};
    h.runtime.subscribeTrackPreferences = fn => {preferences.add(fn); return () => preferences.delete(fn);};
    let view, armed = false, updates = 0;
    const props = () => ({state, controller, integrationProviders: providers, onSelect() {}});
    const focus = h.context.Element.prototype.focus;
    h.context.Element.prototype.focus = function () {
      focus.call(this);
      if (armed && this.closest('#app-form-content')) {
        armed = false;
        updates++;
        view.update(props());
      }
    };
    const baseline = h.listeners().length;
    view = mountPlaylistsView(h.host, h.runtime, props());
    const preferenceOwners = new Set(preferences);
    assert.equal(preferenceOwners.size, 2, 'app and selected table each own one preference subscription');
    armed = true;
    h.click(h.host.querySelector(`[data-playlists-action="${action}"]`));
    assert.equal(updates, 1, 'production form initial focus reentered the existing view');
    const content = h.document.getElementById('app-form-content');
    const expected = action === 'filters' ? '#playlists-filters' : '.playlists__form';
    assert.ok(content.querySelector(expected), 'same opening has a replacement live owner');
    assert.equal(subscriptions.size, 1, 'only the current filter source subscription remains');
    assert.deepEqual(preferences, preferenceOwners, 'modal reentry preserves exactly the pre-opening preference owners');
    view.update(props());
    assert.ok(content.querySelector(expected), 'later refresh retains the live owner');
    assert.deepEqual(preferences, preferenceOwners, 'ordinary refresh neither replaces nor duplicates preference owners');
    view.dispose();
    await h.settle();
    assert.equal(subscriptions.size, 0);
    assert.equal(preferences.size, 0);
    assert.equal(h.listeners().length, baseline);
    assert.equal(h.host.childNodes.length, 0);
    checkHeader();
  });
}

test('playlist metadata interpolates saved and unsaved draft visibility as user text', async () => {
  const {mountPlaylistsView} = await import('../../../music_app/static/js/playlists/native-app.mjs');
  const {defaultFilters} = await import('../../../music_app/static/js/playlists/model.mjs');
  const h = appFixture(), subscriptions = new Set(), providers = {};
  let state = appState(defaultFilters);
  state.resource.data.detail.visibility = 'private';
  const controller = controllerFor(() => state, subscriptions);
  const props = () => ({state, controller, integrationProviders: providers, onSelect() {}});
  const view = mountPlaylistsView(h.host, h.runtime, props());
  const metadataText = () => h.host.querySelector('.playlists__metadata').textContent;
  assert.match(metadataText(), /Saved playlist · private/);
  assert.doesNotMatch(metadataText(), /detail\.visibility|\$\s*\{/);
  state = {
    ...state,
    resource: {...state.resource, data: {...state.resource.data, detail: {
      ...state.resource.data.detail, visibility: 'server_shared'
    }}},
    drafts: {p: {title: 'Edited title', description: '', item_order: []}}
  };
  view.update(props());
  assert.match(metadataText(), /Unsaved draft · kept while switching playlists in this session\. · server_shared/);
  assert.doesNotMatch(metadataText(), /detail\.visibility|\$\s*\{/);
  view.dispose();
  assert.equal(subscriptions.size, 0);
});
