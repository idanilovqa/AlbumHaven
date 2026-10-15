const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:native,driver,action,actions,targets}=require('./playlist-header-migration-fixture.cjs');
let mountHeader,mountPage,model,creation,draft,dialogState;
test.before(async()=>{
 const headers=await import('../../../music_app/static/js/playlists/native-headers.mjs');
 mountHeader=headers.mountPlaylistHeader;
 ({mountPlaylistsView:mountPage}=await import('../../../music_app/static/js/playlists/native-app.mjs'));
 model=await import('../../../music_app/static/js/playlists/model.mjs');
 creation=await import('../../../music_app/static/js/playlists/creation.mjs');
 draft=await import('../../../music_app/static/js/playlists/draft.mjs');
 dialogState=await import('../../../music_app/static/js/playlists/dialog-state.mjs');
});

const allActions=['add','missing','top','export','share','copy','settings','filters','save','discard'];
const propsFor=(runtime,patch={})=>({runtime,detail:{title:'Saved playlist'},draft:{title:'Draft playlist'},busy:false,filtersOpen:false,actions:{add:true,missing:true,top:true,export:true,copy:true,save:true},onAction(){},...patch});
function header(h){assert.equal(h.host.querySelectorAll('[data-shared-header]').length,1);return h.host.querySelector('[data-shared-header]');}
test('Playlist header delegates every original action once with visible X final priority',t=>{
 const h=native(t),view=driver(t,h,mountHeader,propsFor(h.runtime)),root=header(h),nodes=new Map(allActions.map(key=>[key,action(root,key)]));
 assert.deepEqual(actions(root.querySelector('.home-header__primary-actions')),allActions.slice(0,-1));
 assert.deepEqual(actions(root.querySelector('.home-header__final-action')),['discard']);
 assert.deepEqual(actions(root.querySelector('.home-header__leading')),[]);assert.deepEqual(actions(root.querySelector('.home-header__outside')),[]);
 assert.ok(action(root,'discard').querySelector('svg.ui-icon--close'));assert.deepEqual(actions(root),allActions);
 view.render(propsFor(h.runtime,{draft:{title:'New title'},busy:true,filtersOpen:true}));
 assert.equal(header(h),root);for(const key of allActions)assert.equal(action(root,key),nodes.get(key));
});
test('Playlist identity preserves saved and empty-draft fallback semantics and escapes user text',t=>{
 const h=native(t),view=driver(t,h,mountHeader);
 for(const [detail,draft,expected]of [[{title:'Saved'},{title:'Draft <safe>'},'Draft <safe>'],[{title:'Saved'},{title:''},'Saved'],[{title:''},{title:''},'Playlists'],[{title:'Saved'},null,'Saved'],[null,null,'Playlists']]){
 view.render(propsFor(h.runtime,{detail,draft}));assert.equal(header(h).querySelector('.gallery-bar__title').textContent,expected);assert.equal(header(h).querySelector('safe'),null);}
});
test('shared consumer preserves exact existing disabled, copy and share projections',t=>{
 const h=native(t),view=driver(t,h,mountHeader);
 for(const overrides of [{actions:{}},{actions:{share:false}},{actions:{share:null}},{actions:{share:'false',copy:true}},{detail:null,draft:null},{busy:true},{actions:{add:true,missing:true,top:true,export:true,save:true,copy:false}}]){
 const props=propsFor(h.runtime,overrides);view.render(props);const root=header(h),present=allActions.filter(key=>key!=='copy'||props.actions.copy);assert.deepEqual(actions(root),present);
 for(const key of present){const denied=['add','missing','top','export','save'].includes(key)?!props.actions[key]:key==='share'?!props.detail||props.actions.share===false:['settings','filters'].includes(key)?!props.detail:key==='discard'?!props.draft:false;assert.equal(action(root,key).disabled,Boolean(props.busy||denied),key);}
 assert.equal(action(root,'missing').getAttribute('title'),!props.actions.missing?'Missing-track playlist creation is not available for this source yet.':'Inspect missing tracks');}
});
test('Filters keeps its expansion state and native disclosure target inside the shared action owner',t=>{
 const h=native(t),view=driver(t,h,mountHeader);for(const filtersOpen of [false,true]){view.render(propsFor(h.runtime,{filtersOpen}));const filter=action(header(h),'filters');assert.equal(filter.getAttribute('aria-expanded'),String(filtersOpen));assert.equal(filter.getAttribute('aria-controls'),'playlists-filters');}
});
test('native Button retains each actual button node, dispatches nested icons once, and rejects busy actions',t=>{
 const h=native(t),calls=[],later=[],view=driver(t,h,mountHeader,propsFor(h.runtime,{onAction:key=>calls.push(key)})),nodes=new Map(allActions.map(key=>[key,action(h.host,key)]));
 for(const button of nodes.values()){assert.equal(button.tagName,'BUTTON');assert.ok(button.querySelector('svg'));h.click(button.querySelector('svg'));}assert.deepEqual(calls,allActions);
 view.render(propsFor(h.runtime,{busy:true,filtersOpen:true,onAction:key=>later.push(key)}));for(const [key,button]of nodes){assert.equal(action(h.host,key),button);assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-disabled'),'true');h.click(button.querySelector('svg'));}assert.deepEqual(later,[]);assert.deepEqual(calls,allActions);
 view.render(propsFor(h.runtime,{onAction:key=>later.push(key)}));for(const [key,button]of nodes){assert.equal(action(h.host,key),button);assert.equal(button.disabled,false);h.click(button.querySelector('svg'));}assert.deepEqual(later,allActions);assert.deepEqual(calls,allActions);
});

function focusFixture(t,which='share'){
 const h=native(t),view=driver(t,h,mountHeader,propsFor(h.runtime));
 const create=h.document.createElement('button');create.setAttribute('data-playlists-create','1');h.host.append(create);
 const root=h.host,opener=action(root,which),capsule=opener.closest('[data-header-action-capsule]'),tools=root.querySelector('[data-header-tools]');tools.parentNode.hidden=false;
 h.document.activeElement=h.document.body;return {...h,root,opener,capsule,tools,create};
}
test('dialog focus target prefers the available original opener and falls back to Tools for concealed actions', t => {
  assert.equal(typeof dialogState.playlistDialogFocusTarget, 'function', 'PRODUCT_NOT_IMPLEMENTED: shared Playlist focus target');
  for (const conceal of ['inert', 'hidden', 'aria-hidden']) {
    const h = focusFixture(t);
    assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'share'), h.opener);
    h.capsule.setAttribute(conceal, conceal === 'aria-hidden' ? 'true' : '');
    assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'share'), h.tools, conceal);
    assert.equal(dialogState.restorePlaylistDialogFocus(h.root, 'share', h.document), true);
    assert.equal(h.document.activeElement, h.tools);
    h.capsule.removeAttribute(conceal);
    assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'share'), h.opener);
  }
});

test('focus fallback is bounded by create ownership, unavailable targets and an unrelated active focus', t => {
  assert.equal(typeof dialogState.playlistDialogFocusTarget, 'function');
  const h = focusFixture(t), other = h.document.createElement('button'); h.document.body.append(other); t.after(() => other.remove());
  h.capsule.setAttribute('inert', '');
  other.focus(); assert.equal(dialogState.restorePlaylistDialogFocus(h.root, 'share', h.document), false);
  assert.equal(h.document.activeElement, other, 'restoration never steals focus from a connected current destination');
  assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'create'), h.create);
  h.create.disabled = true; assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'create'), null, 'Create never borrows detail Tools');
  for (const attr of ['disabled', 'aria-disabled', 'hidden', 'inert', 'aria-hidden']) {
    h.tools.setAttribute(attr, attr.startsWith('aria-') ? 'true' : '');
    assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'share'), null, attr);
    h.tools.removeAttribute(attr);
  }
  h.tools.remove(); assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'share'), null);
  h.root.remove(); assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'create'), null);
});


const {pageFixture:nativePage}=require('./playlist-header-migration-fixture.cjs');
const payload = (id = 'one') => ({playlist_sidebar: {items: [{playlist_id: id, title: id, allowed_actions: {can_open: true}}]},
  playlist_detail: {playlist_id: id, title: id, description: '', revision: '1', items_complete: true,
    active_sort: {key: 'playlist_position', direction: 'asc'}, allowed_actions: {can_open: true, can_edit: true}, track_rows: []}});
test('filter close resolves the current compact Tools target after normal close but never a retired source', async t => {
  for (const retirement of ['scope', 'detail', 'disposed']) {
    const controller = model.createPlaylistController();
    t.after(() => controller.dispose()); controller.setScope('playlist-header:actor:library');
    assert.equal(controller.accept(payload(), 'one'), true);
    const h = nativePage(t,mountPage,controller), surface = await h.open(); assert.ok(surface);
    assert.equal(surface.options.returnFocus(), h.opener);
    h.collapse(); assert.equal(surface.options.returnFocus(), h.tools);
    await surface.owner.close(null,{restoreFocus:false});
    assert.equal(surface.options.returnFocus(), h.tools, 'native form asks for return target after the owning close callback');
    if (retirement === 'scope') controller.setScope('playlist-header:other:library');
    if (retirement === 'detail') controller.accept(payload(), 'one');
    if (retirement === 'disposed') controller.dispose();
    assert.equal(surface.options.returnFocus(), null, retirement);
  }
});

for (const replacement of ['providers', 'controller']) test(`pending filter focus return retires on ${replacement} replacement and ABA`, async t => {
    const originalProviders = {}, nextProviders = {};
    const first = model.createPlaylistController(), second = model.createPlaylistController();
    for (const controller of [first, second]) {
      t.after(() => controller.dispose()); controller.setScope('playlist-header:actor:library');
      assert.equal(controller.accept(payload(), 'one'), true);
    }
    const h = nativePage(t,mountPage,first,{integrationProviders:originalProviders}), render=h.render;
    const surface=await h.open(); assert.ok(surface);
    h.collapse(); await surface.owner.close(null,{restoreFocus:false});
    assert.equal(surface.options.returnFocus(), h.tools, 'ordinary native close retains its current return target');
    const snapshot = first.getSnapshot();
    render(replacement === 'controller' ? second : first, replacement === 'providers' ? nextProviders : originalProviders);
    assert.equal(first.getSnapshot(), snapshot, 'replacement does not mutate or retire the original controller source');
    assert.equal(surface.options.returnFocus(), null, `${replacement} replacement retires pending focus return`);
    render(first, originalProviders);
    assert.equal(surface.options.returnFocus(), null, `${replacement} ABA cannot revive a retired focus callback`);
});

test('a newer filter opening permanently retires an older pending focus return within the same source',async t=>{
 const controller=model.createPlaylistController();t.after(()=>controller.dispose());controller.setScope('playlist-header:actor:library');assert.equal(controller.accept(payload(),'one'),true);
 const h=nativePage(t,mountPage,controller,{integrationProviders:{}}),original=await h.open();h.collapse();await original.owner.close(null,{restoreFocus:false});assert.equal(original.options.returnFocus(),h.tools);
 assert.equal(h.modal.hidden,true);const current=await h.open();h.collapse();assert.notEqual(current.owner,original.owner);assert.equal(current.options.returnFocus(),h.tools);assert.equal(original.options.returnFocus(),null);
 await current.owner.close(null,{restoreFocus:false});assert.equal(current.options.returnFocus(),h.tools);assert.equal(original.options.returnFocus(),null);
});
