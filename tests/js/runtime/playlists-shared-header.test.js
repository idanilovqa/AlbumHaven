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
const built = buildSync({stdin: {contents: `export {PlaylistHeader, PlaylistsView} from './music_app/static/js/playlists/app.jsx';
  export {Button} from './music_app/static/js/home-friends/components.jsx';`, resolveDir: repo, loader: 'jsx'},
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const slotsToVisit = ['children', 'identity', 'leading', 'actions', 'outsideActions', 'finalAction'];
const elements = node => Array.isArray(node) ? Array.from(node).flatMap(elements) : React.isValidElement(node)
  ? [node, ...slotsToVisit.flatMap(slot => elements(node.props[slot]))] : [];
const named = (tree, name) => elements(tree).filter(node => node.type?.name === name);
const buttons = tree => named(tree, 'Button');
const actionOf = node => node.props.attributes?.['data-playlists-action'];
const actionsOf = tree => buttons(tree).map(actionOf);
const byAction = (tree, action) => buttons(tree).find(node => actionOf(node) === action);
let model, dialogState;
test.before(async () => {
  model = await import(pathToFileURL(path.join(repo, 'music_app/static/js/playlists/model.mjs')).href);
  dialogState = await import(pathToFileURL(path.join(repo, 'music_app/static/js/playlists/dialog-state.mjs')).href);
});

function native() {
  const env = createNativeHomeRuntime();
  return {...env, runtime: {actionHtml: value => env.context.ButtonComponent.renderActionButton(value),
    buttonHtml: value => env.context.ButtonComponent.renderButton(value),
    galleryBarHtml: value => env.context.buildGalleryBarHtml(value), alertHtml: () => '', downloadText() {}}};
}

// Executes actual exported components and their hook lifetime. It does not
// emulate React reconciliation, SharedHeader measurement, browser focus or CSS.
function driver(t, env, name, {host = null, effects = true, htmlHost = false} = {}) {
  const slots = []; let cursor = 0, pending = [], initialized = false;
  const changed = (old, deps) => !old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const effect = (callback, deps) => {const index = cursor++, old = slots[index];
    if (changed(old, deps)) pending.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: callback()};});};
  const hooks = {...React,
    useRef(value) {return slots[cursor++] ||= {current: value};},
    useState(value) {const slot = slots[cursor++] ||= {value: typeof value === 'function' ? value() : value};
      return [slot.value, next => {slot.value = typeof next === 'function' ? next(slot.value) : next;}];},
    useMemo(factory, deps) {const index = cursor++; if (changed(slots[index], deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useSyncExternalStore(_subscribe, getSnapshot) {return getSnapshot();}, useEffect: effect, useLayoutEffect: effect};
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, console, AbortController, document: env.document,
    require: name => name === 'react' ? hooks : local(name)});
  t.after(() => {for (const slot of slots) slot?.cleanup?.();});
  return {render(props) {
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

const allActions = ['add', 'missing', 'top', 'export', 'share', 'copy', 'settings', 'filters', 'save', 'discard'];
const propsFor = (runtime, patch = {}) => ({runtime, detail: {title: 'Saved playlist'}, draft: {title: 'Draft playlist'},
  busy: false, filtersOpen: false, actions: {add: true, missing: true, top: true, export: true, copy: true, save: true},
  onAction() {}, ...patch});
function header(tree) {
  const owners = named(tree, 'SharedHeader');
  assert.equal(owners.length, 1, 'PRODUCT_NOT_IMPLEMENTED: PlaylistHeader delegates to the existing SharedHeader owner');
  assert.equal(elements(tree).some(node => node.props.dangerouslySetInnerHTML), false, 'consumer does not replace the native action subtree');
  return owners[0];
}

test('Playlist header delegates every original action once with visible X final priority', t => {
  const env = native(), view = driver(t, env, 'PlaylistHeader', {effects: false});
  const tree = view.render(propsFor(env.runtime)), owner = header(tree);
  assert.deepEqual(actionsOf(owner.props.actions), allActions.slice(0, -1));
  assert.deepEqual(actionsOf(owner.props.finalAction), ['discard']);
  assert.deepEqual(actionsOf(owner.props.leading), []);
  assert.deepEqual(actionsOf(owner.props.outsideActions), []);
  assert.equal(byAction(owner.props.finalAction, 'discard').props.icon, 'close');
  assert.deepEqual(actionsOf(tree), allActions);
  const next = header(view.render(propsFor(env.runtime, {draft: {title: 'New title'}, busy: true, filtersOpen: true})));
  for (const action of allActions.slice(0, -1)) {
    assert.ok(byAction(owner, action).key, `${action} has stable list identity`);
    assert.equal(byAction(next, action).key, byAction(owner, action).key);
    assert.equal(byAction(next, action).type, byAction(owner, action).type);
  }
});

test('Playlist identity preserves saved and empty-draft fallback semantics and escapes user text', t => {
  const env = native(), view = driver(t, env, 'PlaylistHeader', {effects: false});
  for (const [detail, draft, expected] of [
    [{title: 'Saved'}, {title: 'Draft <safe>'}, 'Draft &lt;safe&gt;'],
    [{title: 'Saved'}, {title: ''}, 'Saved'], [{title: ''}, {title: ''}, 'Playlists'],
    [{title: 'Saved'}, null, 'Saved'], [null, null, 'Playlists'],
  ]) {
    const owner = header(view.render(propsFor(env.runtime, {detail, draft})));
    const title = renderToStaticMarkup(React.createElement(React.Fragment, null, owner.props.identity, owner.props.children));
    assert.match(title, new RegExp(expected));
    assert.doesNotMatch(title, /<safe>/);
  }
});

test('shared consumer preserves exact existing disabled, copy and share projections', t => {
  const env = native(), view = driver(t, env, 'PlaylistHeader', {effects: false});
  for (const overrides of [
    {actions: {}}, {actions: {share: false}}, {actions: {share: null}}, {actions: {share: 'false', copy: true}},
    {detail: null, draft: null}, {busy: true},
    {actions: {add: true, missing: true, top: true, export: true, save: true, copy: false}},
  ]) {
    const props = propsFor(env.runtime, overrides), owner = header(view.render(props));
    const present = allActions.filter(action => action !== 'copy' || props.actions.copy);
    assert.deepEqual(actionsOf(owner), present);
    for (const action of present) {
      const denied = ['add', 'missing', 'top', 'export', 'save'].includes(action) ? !props.actions[action]
        : action === 'share' ? !props.detail || props.actions.share === false
        : ['settings', 'filters'].includes(action) ? !props.detail : action === 'discard' ? !props.draft : false;
      assert.equal(Boolean(byAction(owner, action).props.disabled), Boolean(props.busy || denied), action);
    }
    const missing = byAction(owner, 'missing');
    assert.equal(missing.props.title, !props.actions.missing
      ? 'Missing-track playlist creation is not available for this source yet.' : 'Inspect missing tracks');
  }
});

test('Filters keeps its expansion state and native disclosure target inside the shared action owner', t => {
  const env = native(), view = driver(t, env, 'PlaylistHeader', {effects: false});
  for (const filtersOpen of [false, true]) {
    const owner = header(view.render(propsFor(env.runtime, {filtersOpen})));
    const filter = byAction(owner.props.actions, 'filters');
    assert.equal(filter.props.attributes['aria-expanded'], String(filtersOpen));
    assert.equal(filter.props.attributes['aria-controls'], 'playlists-filters');
  }
});

test('native Button retains each actual button node, dispatches nested icons once, and rejects busy actions', t => {
  const env = native(), view = driver(t, env, 'PlaylistHeader', {effects: false}), calls = [], later = [];
  const owner = header(view.render(propsFor(env.runtime, {onAction: action => calls.push(action)})));
  const mounted = new Map();
  for (const action of allActions) {
    const host = env.document.createElement('span'); env.document.body.append(host); t.after(() => host.remove());
    const nativeButton = driver(t, env, 'Button', {host, htmlHost: true});
    let rendered = nativeButton.render(byAction(owner, action).props);
    const button = host.firstElementChild; assert.equal(button.tagName, 'BUTTON');
    const icon = button.querySelector('svg'); assert.ok(icon);
    rendered.props.onClick(env.event('click', icon)); mounted.set(action, {host, nativeButton, button});
  }
  assert.deepEqual(calls, allActions);
  const busy = header(view.render(propsFor(env.runtime, {busy: true, filtersOpen: true, onAction: action => later.push(action)})));
  for (const action of allActions) {
    const {host, nativeButton, button} = mounted.get(action), rendered = nativeButton.render(byAction(busy, action).props);
    assert.equal(host.firstElementChild, button, `${action} update preserves its native button`);
    assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-disabled'), 'true');
    rendered.props.onClick(env.event('click', button.querySelector('svg')));
  }
  assert.deepEqual(later, []); assert.deepEqual(calls, allActions);
  const latest = header(view.render(propsFor(env.runtime, {onAction: action => later.push(action)})));
  for (const action of allActions) {
    const {host, nativeButton, button} = mounted.get(action), rendered = nativeButton.render(byAction(latest, action).props);
    assert.equal(host.firstElementChild, button); assert.equal(button.disabled, false);
    rendered.props.onClick(env.event('click', button.querySelector('svg')));
  }
  assert.deepEqual(later, allActions); assert.deepEqual(calls, allActions, 'updates do not retain retired callback closures');
});

function focusFixture(t, action = 'share') {
  const env = native(), root = env.document.createElement('div');
  root.innerHTML = `<aside><button data-playlists-create="1">Create playlist</button></aside>
    <header data-shared-header="playlists"><span><button data-header-tools="true">Tools</button></span>
      <div data-header-action-capsule="true"><button data-playlists-action="${action}">${action}</button></div></header>`;
  env.document.body.append(root); t.after(() => root.remove());
  // This test owns the focus primitive only. No geometry or browser visibility
  // is synthesized; hidden/inert/aria-hidden are actual DOM ancestor attributes.
  env.context.Element.prototype.focus = function () {env.document.activeElement = this;};
  env.document.activeElement = env.document.body;
  return {...env, root, opener: root.querySelector('[data-playlists-action]'),
    capsule: root.querySelector('[data-header-action-capsule]'), tools: root.querySelector('[data-header-tools]'),
    create: root.querySelector('[data-playlists-create]')};
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

const payload = (id = 'one') => ({playlist_sidebar: {items: [{playlist_id: id, title: id, allowed_actions: {can_open: true}}]},
  playlist_detail: {playlist_id: id, title: id, description: '', revision: '1', items_complete: true,
    active_sort: {key: 'playlist_position', direction: 'asc'}, allowed_actions: {can_open: true, can_edit: true}, track_rows: []}});
test('filter close resolves the current compact Tools target after normal close but never a retired source', async t => {
  for (const retirement of ['scope', 'detail', 'disposed']) {
    const h = focusFixture(t, 'filters'), controller = model.createPlaylistController();
    t.after(() => controller.dispose()); controller.setScope('playlist-header:actor:library');
    assert.equal(controller.accept(payload(), 'one'), true);
    const view = driver(t, h, 'PlaylistsView', {host: h.root});
    const render = () => view.render({runtime: h.runtime, controller, state: controller.getSnapshot(), onSelect() {}});
    await named(render(), 'PlaylistHeader')[0].props.onAction('filters');
    const surface = named(render(), 'PlaylistFilterSurface')[0]; assert.ok(surface);
    assert.equal(surface.props.returnFocus(), h.opener);
    h.capsule.setAttribute('inert', ''); assert.equal(surface.props.returnFocus(), h.tools);
    surface.props.onClose();
    assert.equal(surface.props.returnFocus(), h.tools, 'native form asks for return target after the owning close callback');
    if (retirement === 'scope') controller.setScope('playlist-header:other:library');
    if (retirement === 'detail') controller.accept(payload(), 'one');
    if (retirement === 'disposed') controller.dispose();
    assert.equal(surface.props.returnFocus(), null, retirement);
  }
});

for (const replacement of ['providers', 'controller']) test(`pending filter focus return retires on ${replacement} replacement and ABA`, async t => {
    const h = focusFixture(t, 'filters'), originalProviders = {}, nextProviders = {};
    const first = model.createPlaylistController(), second = model.createPlaylistController();
    for (const controller of [first, second]) {
      t.after(() => controller.dispose()); controller.setScope('playlist-header:actor:library');
      assert.equal(controller.accept(payload(), 'one'), true);
    }
    const view = driver(t, h, 'PlaylistsView', {host: h.root});
    const render = (controller, integrationProviders) => view.render({runtime: h.runtime, controller,
      state: controller.getSnapshot(), integrationProviders, onSelect() {}});
    await named(render(first, originalProviders), 'PlaylistHeader')[0].props.onAction('filters');
    const surface = named(render(first, originalProviders), 'PlaylistFilterSurface')[0]; assert.ok(surface);
    h.capsule.setAttribute('inert', ''); surface.props.onClose();
    assert.equal(surface.props.returnFocus(), h.tools, 'ordinary native close retains its current return target');
    const snapshot = first.getSnapshot();
    render(replacement === 'controller' ? second : first, replacement === 'providers' ? nextProviders : originalProviders);
    assert.equal(first.getSnapshot(), snapshot, 'replacement does not mutate or retire the original controller source');
    assert.equal(surface.props.returnFocus(), null, `${replacement} replacement retires pending focus return`);
    render(first, originalProviders);
    assert.equal(surface.props.returnFocus(), null, `${replacement} ABA cannot revive a retired focus callback`);
});

test('a newer filter opening permanently retires an older pending focus return within the same source', async t => {
  const h = focusFixture(t, 'filters'), controller = model.createPlaylistController(), integrationProviders = {};
  t.after(() => controller.dispose()); controller.setScope('playlist-header:actor:library');
  assert.equal(controller.accept(payload(), 'one'), true);
  const view = driver(t, h, 'PlaylistsView', {host: h.root});
  const render = () => view.render({runtime: h.runtime, controller, state: controller.getSnapshot(), integrationProviders, onSelect() {}});
  await named(render(), 'PlaylistHeader')[0].props.onAction('filters');
  const original = named(render(), 'PlaylistFilterSurface')[0]; assert.ok(original);
  h.capsule.setAttribute('inert', ''); original.props.onClose();
  assert.equal(original.props.returnFocus(), h.tools, 'normal close keeps its own eligible return target');
  const closed = render(); assert.equal(named(closed, 'PlaylistFilterSurface').length, 0);
  await named(closed, 'PlaylistHeader')[0].props.onAction('filters');
  const current = named(render(), 'PlaylistFilterSurface')[0]; assert.ok(current);
  assert.notEqual(current.key, original.key, 'reopening creates a distinct filter lifetime');
  assert.equal(current.props.returnFocus(), h.tools);
  assert.equal(original.props.returnFocus(), null, 'a late native return cannot focus over the newer opening');
  current.props.onClose();
  assert.equal(current.props.returnFocus(), h.tools, 'the latest normal close remains eligible');
  assert.equal(original.props.returnFocus(), null, 'closing the newer opening does not revive its predecessor');
});
