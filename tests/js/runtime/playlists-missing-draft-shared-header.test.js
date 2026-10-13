const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {pathToFileURL} = require('node:url');

const repo = path.resolve(process.env.ALBUMHAVEN_FRONTEND_ROOT || path.join(__dirname, '../../..'));
const local = createRequire(path.join(repo, 'package.json'));
const React = local('react');
const {renderToStaticMarkup} = local('react-dom/server');
const {buildSync} = local('esbuild');
const {createNativeHomeRuntime} = local('./tests/js/runtime/native-home-harness.cjs');
const built = buildSync({stdin: {contents: `export {MissingPlaylistDraftHeader, MissingPlaylistDraftPage} from './music_app/static/js/playlists/draft.jsx';
  export {Button} from './music_app/static/js/home-friends/components.jsx';`, resolveDir: repo, loader: 'jsx'},
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const slotsToVisit = ['children', 'identity', 'leading', 'actions', 'outsideActions', 'finalAction'];
// Array.from keeps results in the host realm. Walking the actual elements,
// rather than React.Children.toArray, preserves their original list keys.
const elements = node => Array.isArray(node) ? Array.from(node).flatMap(elements) : React.isValidElement(node)
  ? [node, ...slotsToVisit.flatMap(slot => elements(node.props[slot]))] : [];
const named = (tree, name) => elements(tree).filter(node => node.type?.name === name);
const buttons = tree => named(tree, 'Button');
const actionOf = node => node.props.attributes?.['data-playlists-draft-action'];
const actionsOf = tree => buttons(tree).map(actionOf);
const byAction = (tree, action) => buttons(tree).find(node => actionOf(node) === action);
let creation, draft, dialogState;
test.before(async () => {
  creation = await import(pathToFileURL(path.join(repo, 'music_app/static/js/playlists/creation.mjs')).href);
  draft = await import(pathToFileURL(path.join(repo, 'music_app/static/js/playlists/draft.mjs')).href);
  dialogState = await import(pathToFileURL(path.join(repo, 'music_app/static/js/playlists/dialog-state.mjs')).href);
});

function native() {
  const env = createNativeHomeRuntime();
  return {...env, runtime: {actionHtml: value => env.context.ButtonComponent.renderActionButton(value),
    buttonHtml: value => env.context.ButtonComponent.renderButton(value),
    galleryBarHtml: value => env.context.buildGalleryBarHtml(value), alertHtml: () => '', downloadText() {}}};
}

// This drives real component functions, hooks and controller lifetimes. It does
// not emulate React reconciliation, SharedHeader geometry, browser focus or CSS.
function driver(t, env, name, {host = null, effects = true, htmlHost = false} = {}) {
  const slots = []; let cursor = 0, pending = [], initialized = false, disposed = false;
  const changed = (old, deps) => !old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const effect = (callback, deps) => {const index = cursor++, old = slots[index];
    if (changed(old, deps)) pending.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: callback()};});};
  const hooks = {...React, useId: () => 'draft-header-test',
    useRef(value) {return slots[cursor++] ||= {current: value};},
    useState(value) {const slot = slots[cursor++] ||= {value: typeof value === 'function' ? value() : value};
      return [slot.value, next => {slot.value = typeof next === 'function' ? next(slot.value) : next;}];},
    useMemo(factory, deps) {const index = cursor++; if (changed(slots[index], deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useEffect: effect, useLayoutEffect: effect};
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, console, AbortController, TextEncoder,
    document: env.document, require: name => name === 'react' ? hooks : local(name)});
  const dispose = () => {if (disposed) return; disposed = true; for (const slot of slots) slot?.cleanup?.();};
  t.after(dispose);
  return {dispose, render(props) {
    assert.equal(disposed, false, 'fixture must not render an unmounted page');
    cursor = 0; pending = []; const tree = loaded.exports[name](props);
    if (host) {
      tree.props.ref.current = host;
      if (htmlHost && !initialized) host.innerHTML = tree.props.dangerouslySetInnerHTML.__html;
      initialized = true;
    }
    if (effects) for (const run of pending) run();
    return tree;
  }};
}

const allActions = ['top', 'export', 'filters', 'save', 'close'];
const labels = {top: 'Create Album Top', export: 'Export TXT', filters: 'Filters', save: 'Save', close: 'Close playlist preview'};
const icons = {top: 'create-top', export: 'export-text', filters: 'filters', save: 'save', close: 'close'};
const propsFor = (runtime, patch = {}) => ({runtime, title: 'Missing originals', filtersId: 'missing-one-filters',
  filtersOpen: false, busy: false, actions: {top: true, export: true, filters: true, save: true, close: true}, onAction() {}, ...patch});
function header(tree) {
  const owners = named(tree, 'SharedHeader');
  assert.equal(owners.length, 1, 'PRODUCT_NOT_IMPLEMENTED: MissingPlaylistDraftHeader delegates to the existing SharedHeader');
  assert.equal(elements(tree).some(node => node.props.dangerouslySetInnerHTML), false, 'consumer does not replace native action subtrees');
  return owners[0];
}

test('missing draft reuses SharedHeader with original actions once and Close as its final action', t => {
  const env = native(), view = driver(t, env, 'MissingPlaylistDraftHeader', {effects: false});
  const tree = view.render(propsFor(env.runtime)), owner = header(tree);
  assert.deepEqual(actionsOf(owner.props.actions), ['top', 'export', 'filters', 'save']);
  assert.deepEqual(actionsOf(owner.props.finalAction), ['close']);
  assert.deepEqual(actionsOf(owner.props.leading), []);
  assert.deepEqual(actionsOf(owner.props.outsideActions), []);
  assert.deepEqual(actionsOf(tree), allActions);
  assert.equal(owner.props.runtime, env.runtime);
  assert.match(owner.props.className, /\bplaylists__header\b/);
  const next = header(view.render(propsFor(env.runtime, {title: 'Edited title', busy: true, filtersOpen: true})));
  for (const action of allActions) {
    const current = byAction(owner, action), updated = byAction(next, action);
    assert.equal(current.props.children, labels[action]); assert.equal(current.props.icon, icons[action]);
    assert.equal(updated.type, current.type); assert.equal(updated.key, current.key);
    if (action !== 'close') assert.ok(current.key, `${action} has stable list identity`);
  }
});

test('missing draft title preserves its exact fallback and renders user text safely', t => {
  const env = native(), view = driver(t, env, 'MissingPlaylistDraftHeader', {effects: false});
  for (const [title, expected] of [['Draft <safe>', 'Draft &lt;safe&gt;'], ['', 'Missing tracks'],
    [null, 'Missing tracks'], [undefined, 'Missing tracks'], ['  ', '  ']]) {
    const owner = header(view.render(propsFor(env.runtime, {title})));
    const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, owner.props.identity, owner.props.children));
    assert.ok(markup.includes(expected)); assert.doesNotMatch(markup, /<safe>/);
  }
});

test('header disclosure identity is stable per filter surface and distinct between draft instances', t => {
  const env = native(), first = driver(t, env, 'MissingPlaylistDraftHeader', {effects: false});
  const second = driver(t, env, 'MissingPlaylistDraftHeader', {effects: false});
  const one = header(first.render(propsFor(env.runtime))), two = header(second.render(propsFor(env.runtime, {filtersId: 'missing-two-filters'})));
  assert.equal(typeof one.props.id, 'string'); assert.ok(one.props.id.length > 0);
  assert.notEqual(one.props.id, two.props.id, 'independent drafts cannot share a Tools panel identity');
  for (const filtersOpen of [true, false]) {
    const owner = header(first.render(propsFor(env.runtime, {filtersOpen, title: 'Changed'})));
    assert.equal(owner.props.id, one.props.id);
    const attributes = byAction(owner, 'filters').props.attributes;
    assert.equal(attributes['aria-expanded'], String(filtersOpen));
    assert.equal(attributes['aria-controls'], 'missing-one-filters');
    assert.equal(byAction(two, 'filters').props.attributes['aria-controls'], 'missing-two-filters');
  }
});

test('draft header preserves every existing availability gate, busy gate, label and Top explanation', t => {
  const env = native(), view = driver(t, env, 'MissingPlaylistDraftHeader', {effects: false});
  const cases = [{}, ...allActions.map(action => ({[action]: true})),
    {top: null, export: false, filters: undefined, save: 0, close: ''},
    {top: 'false', export: 1, filters: true, save: true, close: true}];
  for (const actions of cases) for (const busy of [false, true]) {
    const owner = header(view.render(propsFor(env.runtime, {actions, busy})));
    assert.deepEqual(actionsOf(owner), allActions);
    for (const action of allActions) {
      const button = byAction(owner, action);
      assert.equal(Boolean(button.props.disabled), Boolean(busy || !actions[action]), action);
      assert.equal(button.props.title || button.props.children, action === 'top' && !actions.top
        ? 'Album Top creation is unavailable for these source albums.' : labels[action]);
      assert.equal(button.props.attributes['data-playlists-draft-action'], action);
      assert.equal(button.props.attributes['data-playlists-action'], undefined);
    }
  }
});

test('native draft buttons keep their actual nodes and route nested icons once through current callbacks', t => {
  const env = native(), view = driver(t, env, 'MissingPlaylistDraftHeader', {effects: false}), firstCalls = [], latestCalls = [];
  const owner = header(view.render(propsFor(env.runtime, {onAction: action => firstCalls.push(action)})));
  const mounted = new Map();
  for (const action of allActions) {
    const host = env.document.createElement('span'); env.document.body.append(host); t.after(() => host.remove());
    const nativeButton = driver(t, env, 'Button', {host, htmlHost: true});
    const rendered = nativeButton.render(byAction(owner, action).props), button = host.firstElementChild;
    assert.equal(button.tagName, 'BUTTON'); assert.ok(button.querySelector('svg'));
    rendered.props.onClick(env.event('click', button.querySelector('svg')));
    mounted.set(action, {host, nativeButton, button});
  }
  assert.deepEqual(firstCalls, allActions);
  for (const busy of [true, false]) {
    const next = header(view.render(propsFor(env.runtime, {busy, filtersOpen: true, onAction: action => latestCalls.push(action)})));
    for (const action of allActions) {
      const {host, nativeButton, button} = mounted.get(action), rendered = nativeButton.render(byAction(next, action).props);
      assert.equal(host.firstElementChild, button, `${action} updates preserve its native button`);
      assert.equal(button.disabled, busy); assert.equal(button.getAttribute('aria-disabled'), busy ? 'true' : null);
      assert.equal(button.getAttribute('aria-label'), labels[action]);
      if (action === 'filters') {
        assert.equal(button.getAttribute('aria-expanded'), 'true');
        assert.equal(button.getAttribute('aria-controls'), 'missing-one-filters');
      }
      rendered.props.onClick(env.event('click', button.querySelector('svg')));
    }
    assert.deepEqual(latestCalls, busy ? [] : allActions);
  }
  assert.deepEqual(firstCalls, allActions, 'retired callbacks are not retained by the native action owner');
  const denied = header(view.render(propsFor(env.runtime, {actions: {}, onAction: action => latestCalls.push(action)})));
  for (const action of allActions) {
    const {host, nativeButton, button} = mounted.get(action), rendered = nativeButton.render(byAction(denied, action).props);
    assert.equal(host.firstElementChild, button); assert.equal(button.disabled, true);
    rendered.props.onClick(env.event('click', button.querySelector('svg')));
  }
  assert.deepEqual(latestCalls, allActions);
});

function focusFixture(t) {
  const env = native(), root = env.document.createElement('main');
  root.innerHTML = `<header data-shared-header="playlists"><button data-header-tools="true">Saved Tools</button>
      <button data-playlists-action="filters">Saved filters</button></header>
    <header data-shared-header="other-draft"><button data-header-tools="true">Other draft Tools</button>
      <button data-playlists-draft-action="export">Other export</button></header>
    <header data-shared-header="current-draft"><span><button data-header-tools="true">Current Tools</button></span>
      <div data-header-action-capsule="true"><button data-playlists-draft-action="filters">Draft filters</button></div></header>`;
  env.document.body.append(root); t.after(() => root.remove());
  return {...env, root, owner: root.querySelector('[data-shared-header="current-draft"]'),
    opener: root.querySelector('[data-playlists-draft-action="filters"]'),
    capsule: root.querySelector('[data-header-action-capsule]'),
    tools: root.querySelector('[data-shared-header="current-draft"] [data-header-tools]'),
    saved: root.querySelector('[data-playlists-action="filters"]'),
    savedTools: root.querySelector('[data-shared-header="playlists"] [data-header-tools]')};
}
const draftTarget = (root, action = 'filters') => dialogState.playlistDialogFocusTarget(root, action, {draft: true});

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
function pageFixture(t) {
  const h = focusFixture(t), controller = session(t), view = driver(t, h, 'MissingPlaylistDraftPage', {host: h.root});
  const render = (current = controller) => view.render({runtime: h.runtime, controller: current, state: current.getSnapshot(), onClose() {}});
  const open = async (current = controller) => {
    await named(render(current), 'MissingPlaylistDraftHeader')[0].props.onAction('filters');
    const surface = named(render(current), 'PlaylistFilterSurface')[0];
    assert.ok(surface, 'real draft controller opens a filter session'); return surface;
  };
  return {...h, controller, view, render, open};
}

test('real draft filter return follows current visibility and survives normal close and ordinary value edits', async t => {
  const h = pageFixture(t), surface = await h.open();
  assert.equal(surface.props.returnFocus(), h.opener);
  h.capsule.setAttribute('inert', ''); assert.equal(surface.props.returnFocus(), h.tools);
  const source = h.controller.getSnapshot().sourceResource.data;
  assert.equal(h.controller.setQuery('Original'), true); assert.equal(h.controller.edit({title: 'Edited draft'}), true);
  h.render(); assert.equal(h.controller.getSnapshot().sourceResource.data, source);
  assert.equal(surface.props.returnFocus(), h.tools, 'ordinary draft edits preserve the readable source lifetime');
  surface.props.onClose(); assert.equal(named(h.render(), 'PlaylistFilterSurface').length, 0);
  assert.equal(surface.props.returnFocus(), h.tools, 'native close requests its return target after the close callback');
  h.capsule.removeAttribute('inert'); assert.equal(surface.props.returnFocus(), h.opener);
});

for (const retirement of ['scope', 'source-revision', 'source-refresh', 'providers', 'disposed', 'unmounted']) {
  test(`retained draft filter return is revoked by ${retirement} after normal close`, async t => {
    const h = pageFixture(t), surface = await h.open();
    h.capsule.setAttribute('inert', ''); surface.props.onClose();
    assert.equal(surface.props.returnFocus(), h.tools);
    if (retirement === 'scope') h.controller.setContext({...context(), scopeKey: 'draft-header:other'});
    if (retirement === 'source-revision') {
      const changed = context(); changed.source.revision = 'revision:two'; h.controller.setContext(changed);
      assert.equal(await h.controller.refresh(), true);
    }
    if (retirement === 'source-refresh') assert.equal(await h.controller.refresh(), true);
    if (retirement === 'providers') h.controller.configure({readPlaylistCreationSource: async request => response(request)});
    if (retirement === 'disposed') h.controller.dispose();
    if (retirement === 'unmounted') h.view.dispose();
    assert.equal(surface.props.returnFocus(), null, 'a retired source cannot focus still-connected old page controls');
  });
}

test('controller replacement and ABA permanently retire an old draft filter return without mutating its source', async t => {
  const h = pageFixture(t), other = session(t), surface = await h.open();
  h.capsule.setAttribute('inert', ''); surface.props.onClose();
  assert.equal(surface.props.returnFocus(), h.tools);
  const original = h.controller.getSnapshot();
  h.render(other); assert.equal(h.controller.getSnapshot(), original);
  assert.equal(surface.props.returnFocus(), null);
  h.render(h.controller); assert.equal(h.controller.getSnapshot(), original);
  assert.equal(surface.props.returnFocus(), null, 'returning to the first controller cannot revive an old opening');
});

test('a new draft filter opening retires the old return and rejects a late old close', async t => {
  const h = pageFixture(t), old = await h.open();
  h.capsule.setAttribute('inert', ''); old.props.onClose();
  assert.equal(old.props.returnFocus(), h.tools);
  const next = await h.open(); assert.notEqual(next.key, old.key);
  assert.equal(old.props.returnFocus(), null, 'previous opening cannot steal the new opening\'s focus');
  assert.equal(next.props.returnFocus(), h.tools);
  old.props.onClose(); assert.equal(named(h.render(), 'PlaylistFilterSurface')[0].key, next.key);
  next.props.onClose(); assert.equal(next.props.returnFocus(), h.tools);
});
