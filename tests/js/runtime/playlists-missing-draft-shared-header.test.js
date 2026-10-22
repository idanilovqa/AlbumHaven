const test=require('node:test'),assert=require('node:assert/strict');
const {fixture:native,driver,action,actions,targets}=require('./playlist-header-migration-fixture.cjs');
let mountHeader,mountPage,model,creation,draft,dialogState;
test.before(async()=>{
 const headers=await import('../../../music_app/static/js/playlists/native-headers.mjs');
 mountHeader=headers.mountMissingPlaylistDraftHeader;
 ({mountMissingPlaylistDraftPage:mountPage}=await import('../../../music_app/static/js/playlists/native-draft.mjs'));
 model=await import('../../../music_app/static/js/playlists/model.mjs');
 creation=await import('../../../music_app/static/js/playlists/creation.mjs');
 draft=await import('../../../music_app/static/js/playlists/draft.mjs');
 dialogState=await import('../../../music_app/static/js/playlists/dialog-state.mjs');
});

const allActions=['top','export','filters','save','close'];
const labels={top:'Create Album Top',export:'Export TXT',filters:'Filters',save:'Save',close:'Close playlist preview'};
const icons={top:'create-top',export:'export-text',filters:'filters',save:'save',close:'close'};
const propsFor=(runtime,patch={})=>({runtime,title:'Missing originals',filtersId:'missing-one-filters',filtersOpen:false,busy:false,actions:{top:true,export:true,filters:true,save:true,close:true},onAction(){},...patch});
const byAction=(host,key)=>action(host,key,true),actionsOf=host=>actions(host,true);
function header(h){assert.equal(h.host.querySelectorAll('[data-shared-header]').length,1);return h.host.querySelector('[data-shared-header]');}
test('missing draft reuses SharedHeader with original actions once and Close as its final action',t=>{
 const h=native(t),view=driver(t,h,mountHeader,propsFor(h.runtime)),root=header(h),nodes=new Map(allActions.map(key=>[key,byAction(root,key)]));
 assert.deepEqual(actionsOf(root.querySelector('.home-header__primary-actions')),['top','export','filters','save']);assert.deepEqual(actionsOf(root.querySelector('.home-header__final-action')),['close']);assert.deepEqual(actionsOf(root.querySelector('.home-header__leading')),[]);assert.deepEqual(actionsOf(root.querySelector('.home-header__outside')),[]);assert.deepEqual(actionsOf(root),allActions);assert.match(root.className,/\bplaylists__header\b/);
 view.render(propsFor(h.runtime,{title:'Edited title',busy:true,filtersOpen:true}));assert.equal(header(h),root);for(const [key,button]of nodes){assert.equal(button.getAttribute('aria-label'),labels[key]);assert.ok(button.querySelector(`svg.ui-icon--${icons[key]}`));assert.equal(byAction(root,key),button);}
});
test('missing draft title preserves its exact fallback and renders user text safely',t=>{
 const h=native(t),view=driver(t,h,mountHeader);for(const [title,expected]of [['Draft <safe>','Draft <safe>'],['','Missing tracks'],[null,'Missing tracks'],[undefined,'Missing tracks'],['  ','  ']]){view.render(propsFor(h.runtime,{title}));const node=header(h).querySelector('.gallery-bar__title');assert.equal(node.textContent,expected);assert.equal(node.querySelector('safe'),null);}
});
test('header disclosure identity is stable per filter surface and distinct between draft instances',t=>{
 const h=native(t),k=native(t),first=driver(t,h,mountHeader,propsFor(h.runtime)),second=driver(t,k,mountHeader,propsFor(k.runtime,{filtersId:'missing-two-filters'})),one=header(h),two=header(k),id=one.getAttribute('data-shared-header');assert.equal(typeof id,'string');assert.ok(id.length);assert.notEqual(id,two.getAttribute('data-shared-header'));
 for(const filtersOpen of [true,false]){first.render(propsFor(h.runtime,{filtersOpen,title:'Changed'}));assert.equal(one.getAttribute('data-shared-header'),id);assert.equal(byAction(one,'filters').getAttribute('aria-expanded'),String(filtersOpen));assert.equal(byAction(one,'filters').getAttribute('aria-controls'),'missing-one-filters');assert.equal(byAction(two,'filters').getAttribute('aria-controls'),'missing-two-filters');}
});
test('draft header preserves every existing availability gate, busy gate, label and Top explanation',t=>{
 const h=native(t),view=driver(t,h,mountHeader),cases=[{},...allActions.map(key=>({[key]:true})),{top:null,export:false,filters:undefined,save:0,close:''},{top:'false',export:1,filters:true,save:true,close:true}];
 for(const actions of cases)for(const busy of [false,true]){view.render(propsFor(h.runtime,{actions,busy}));const root=header(h);assert.deepEqual(actionsOf(root),allActions);for(const key of allActions){const button=byAction(root,key);assert.equal(button.disabled,Boolean(busy||!actions[key]),key);assert.equal(button.getAttribute('title')||button.textContent,key==='top'&&!actions.top?'Album Top creation is unavailable for these source albums.':labels[key]);assert.equal(button.getAttribute('data-playlists-draft-action'),key);assert.equal(button.hasAttribute('data-playlists-action'),false);}}
});
test('native draft buttons keep their actual nodes and route nested icons once through current callbacks',t=>{
 const h=native(t),firstCalls=[],latestCalls=[],view=driver(t,h,mountHeader,propsFor(h.runtime,{onAction:key=>firstCalls.push(key)})),nodes=new Map(allActions.map(key=>[key,byAction(h.host,key)]));for(const button of nodes.values()){assert.equal(button.tagName,'BUTTON');assert.ok(button.querySelector('svg'));h.click(button.querySelector('svg'));}assert.deepEqual(firstCalls,allActions);
 for(const busy of [true,false]){view.render(propsFor(h.runtime,{busy,filtersOpen:true,onAction:key=>latestCalls.push(key)}));for(const [key,button]of nodes){assert.equal(byAction(h.host,key),button);assert.equal(button.disabled,busy);assert.equal(button.getAttribute('aria-disabled'),busy?'true':null);assert.equal(button.getAttribute('aria-label'),labels[key]);if(key==='filters'){assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(button.getAttribute('aria-controls'),'missing-one-filters');}h.click(button.querySelector('svg'));}assert.deepEqual(latestCalls,busy?[]:allActions);}
 assert.deepEqual(firstCalls,allActions);view.render(propsFor(h.runtime,{actions:{},onAction:key=>latestCalls.push(key)}));for(const [key,button]of nodes){assert.equal(byAction(h.host,key),button);assert.equal(button.disabled,true);h.click(button.querySelector('svg'));}assert.deepEqual(latestCalls,allActions);
});

function focusFixture(t){
 const h=native(t),savedHost=h.document.createElement('div'),otherHost=h.document.createElement('div'),currentHost=h.document.createElement('div');h.host.append(savedHost,otherHost,currentHost);
 // All three competing headers use the actual delivered consumer and shared owners.
 const saved=mountSavedHeader(savedHost,h.runtime,{detail:{title:'Saved'},actions:{},onAction(){}}),other=mountHeader(otherHost,h.runtime,propsFor(h.runtime,{filtersId:'other-draft'})),current=mountHeader(currentHost,h.runtime,propsFor(h.runtime,{filtersId:'current-draft'}));
 t.after(()=>{current.dispose();other.dispose();saved.dispose();});
 const owner=current.element,opener=byAction(owner,'filters'),tools=owner.querySelector('[data-header-tools]'),savedTools=saved.element.querySelector('[data-header-tools]');tools.parentNode.hidden=false;savedTools.parentNode.hidden=false;
 // Remove only the competing draft's filter action: its earlier export remains an unrelated owner.
 for(const key of allActions){if(key!=='export')byAction(other.element,key).remove();if(key!=='filters')byAction(current.element,key).remove();}
 return {...h,root:h.host,owner,opener,capsule:owner.querySelector('[data-header-action-capsule]'),tools,saved:action(saved.element,'filters'),savedTools};
}
let mountSavedHeader;test.before(async()=>({mountPlaylistHeader:mountSavedHeader}=await import('../../../music_app/static/js/playlists/native-headers.mjs')));
const draftTarget=(root,action='filters')=>dialogState.playlistDialogFocusTarget(root,action,{draft:true});
test('explicit draft focus prefers its own action and falls back only to that action\'s nearest SharedHeader Tools', t => {
  for (const conceal of ['inert', 'hidden', 'aria-hidden']) {
    const h = focusFixture(t);
    assert.equal(draftTarget(h.root), h.opener, 'draft option must not select the saved playlist action');
    h.capsule.setAttribute(conceal, conceal === 'aria-hidden' ? 'true' : '');
    assert.equal(draftTarget(h.root), h.tools, `${conceal}: unrelated earlier Tools cannot receive draft focus`);
    h.capsule.removeAttribute(conceal); assert.equal(draftTarget(h.root), h.opener);
    h.opener.disabled = true; assert.equal(draftTarget(h.root), h.tools);
  }
});

test('draft focus does not invent a fallback when its action or its owned usable Tools is absent', t => {
  const h = focusFixture(t);
  assert.equal(draftTarget(h.root, 'save'), null, 'a missing action cannot borrow any header\'s Tools');
  assert.equal(draftTarget(h.root, 'create'), null, 'draft mode cannot borrow saved creation controls');
  h.capsule.setAttribute('inert', '');
  for (const attr of ['disabled', 'aria-disabled', 'hidden', 'inert', 'aria-hidden']) {
    h.tools.setAttribute(attr, attr.startsWith('aria-') ? 'true' : '');
    assert.equal(draftTarget(h.root), null, `${attr}: never use another draft or saved header`);
    h.tools.removeAttribute(attr);
  }
  h.tools.remove(); assert.equal(draftTarget(h.root), null);
  h.opener.remove(); assert.equal(draftTarget(h.root), null);
  h.root.remove(); assert.equal(draftTarget(h.root), null);
});

test('draft fallback is bounded to the current owner and rejects concealed owners and detached controls', t => {
  const h = focusFixture(t);
  h.capsule.setAttribute('inert', ''); h.owner.setAttribute('hidden', '');
  assert.equal(draftTarget(h.root), null); h.owner.removeAttribute('hidden');
  assert.equal(draftTarget(h.root), h.tools);
  h.owner.remove(); assert.equal(draftTarget(h.root), null);
  assert.equal(draftTarget(h.owner), null, 'detached owner cannot receive focus');
  h.root.append(h.opener); h.opener.setAttribute('hidden', '');
  assert.equal(draftTarget(h.root), null, 'an unowned action cannot borrow an unrelated header');
});

test('omitting the draft option preserves saved-playlist and Create focus behavior', t => {
  const h = focusFixture(t), create = h.document.createElement('button');
  create.setAttribute('data-playlists-create', '1'); h.root.append(create);
  assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'filters'), h.saved);
  assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'filters', {draft: false}), h.saved);
  h.saved.setAttribute('hidden', '');
  assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'filters'), h.savedTools);
  assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'create'), create);
  create.disabled = true; assert.equal(dialogState.playlistDialogFocusTarget(h.root, 'create'), null);
});

const context = () => ({scopeKey: 'draft-header:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
  source: {kind: 'playlist', ref: 'draft-header:source', revision: 'revision:one',
    allowed_actions: {can_read: true, can_use_for_playlist: true}}});
const entry = entry_ref => ({entry_ref, canonical_track_ref: null, title: `Original ${entry_ref}`, artist: 'Artist',
  album_title: 'Album', availability: 'missing', metadata_state: 'unknown', allowed_actions: {can_read: true, can_select: true},
  parent_album: {state: 'known', album_ref: 'draft-header:album', title: 'Album',
    allowed_actions: {can_read: true, can_create_album_top: true, can_view_details: true}}});
const response = subject => ({status: 'ready', data: {scopeKey: subject.scopeKey, mode: 'missing', source: subject.source,
  allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true,
  entries: [entry('one'), entry('two')], retained_parent_albums: []}});
function session(t) {
  const subject = context(), sourceResource = creation.normalizeCreationResult(response(subject), subject);
  const prepared = creation.prepareMissingDraft({...subject, sourceResource, title: 'Missing originals', description: '',
    selectedKeys: sourceResource.data.entries.map(row => row.row_key), mutation: {status: 'idle'}}, {draftToken: 'draft-header-token'});
  assert.ok(prepared, 'real source projection prepares a missing-playlist draft');
  const controller = draft.createMissingPlaylistDraftController({prepared,
    providers: {readPlaylistCreationSource: async request => response(request)}});
  t.after(() => controller.dispose()); return controller;
}
const {pageFixture:nativePage}=require('./playlist-header-migration-fixture.cjs');
function pageFixture(t){return nativePage(t,mountPage,session(t),{draft:true});}
test('real draft filter return follows current visibility and survives normal close and ordinary value edits', async t => {
  const h = pageFixture(t), surface = await h.open();
  assert.equal(surface.options.returnFocus(), h.opener);
  h.collapse(); assert.equal(surface.options.returnFocus(), h.tools);
  const source = h.controller.getSnapshot().sourceResource.data;
  assert.equal(h.controller.setQuery('Original'), true); assert.equal(h.controller.edit({title: 'Edited draft'}), true);
  h.render(); assert.equal(h.controller.getSnapshot().sourceResource.data, source);
  assert.equal(surface.options.returnFocus(), h.tools, 'ordinary draft edits preserve the readable source lifetime');
  await surface.owner.close(null,{restoreFocus:false}); h.render(); assert.equal(h.modal.hidden, true);
  assert.equal(surface.options.returnFocus(), h.tools, 'native close requests its return target after the close callback');
  h.expand(); assert.equal(surface.options.returnFocus(), h.opener);
});

for (const retirement of ['scope', 'source-revision', 'source-refresh', 'providers', 'disposed', 'unmounted']) {
  test(`retained draft filter return is revoked by ${retirement} after normal close`, async t => {
    const h = pageFixture(t), surface = await h.open();
    h.collapse(); await surface.owner.close(null,{restoreFocus:false});
    assert.equal(surface.options.returnFocus(), h.tools);
    if (retirement === 'scope') h.controller.setContext({...context(), scopeKey: 'draft-header:other'});
    if (retirement === 'source-revision') {
      const changed = context(); changed.source.revision = 'revision:two'; h.controller.setContext(changed);
      assert.equal(await h.controller.refresh(), true);
    }
    if (retirement === 'source-refresh') assert.equal(await h.controller.refresh(), true);
    if (retirement === 'providers') h.controller.configure({readPlaylistCreationSource: async request => response(request)});
    if (retirement === 'disposed') h.controller.dispose();
    if (retirement === 'unmounted') h.view.dispose();
    assert.equal(surface.options.returnFocus(), null, 'a retired source cannot focus still-connected old page controls');
  });
}

test('controller replacement and ABA permanently retire an old draft filter return without mutating its source', async t => {
  const h = pageFixture(t), other = session(t), surface = await h.open();
  h.collapse(); await surface.owner.close(null,{restoreFocus:false});
  assert.equal(surface.options.returnFocus(), h.tools);
  const original = h.controller.getSnapshot();
  h.render(other); assert.equal(h.controller.getSnapshot(), original);
  assert.equal(surface.options.returnFocus(), null);
  h.render(h.controller); assert.equal(h.controller.getSnapshot(), original);
  assert.equal(surface.options.returnFocus(), null, 'returning to the first controller cannot revive an old opening');
});

test('a new draft filter opening retires the old return and rejects a late old close', async t => {
  const h = pageFixture(t), old = await h.open();
  h.collapse(); await old.owner.close(null,{restoreFocus:false});
  assert.equal(old.options.returnFocus(), h.tools);
  const next = await h.open(); h.collapse(); assert.notEqual(next.owner, old.owner);
  assert.equal(old.options.returnFocus(), null, 'previous opening cannot steal the new opening\'s focus');
  assert.equal(next.options.returnFocus(), h.tools);
  await old.owner.close(null,{restoreFocus:false}); h.render(); assert.equal(h.forms.at(-1).owner, next.owner); assert.equal(h.modal.hidden, false);
  await next.owner.close(null,{restoreFocus:false}); assert.equal(next.options.returnFocus(), h.tools);
});
