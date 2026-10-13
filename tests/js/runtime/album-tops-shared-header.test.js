const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const root = path.resolve(process.env.ALBUMHAVEN_FRONTEND_ROOT || path.join(__dirname, '../../..'));
const local = createRequire(path.join(root, 'package.json'));
const React = local('react');
const {renderToStaticMarkup} = local('react-dom/server');
const {buildSync} = local('esbuild');
const {createNativeHomeRuntime, buttonNamed} = local('./tests/js/runtime/native-home-harness.cjs');
const code = buildSync({entryPoints: [path.join(root, 'music_app/static/js/album-tops/app.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const TOP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BROWSE = 'library.browse.read', CREATE = 'library.album_tops.create';
const slots = ['children', 'identity', 'leading', 'actions', 'outsideActions', 'finalAction'];
function elements(node) {
  if (!React.isValidElement(node)) return [];
  const found = [node];
  for (const key of slots) React.Children.forEach(node.props[key], child => {found.push(...elements(child));});
  return found;
}
const named = (tree, name) => elements(tree).filter(node => node.type?.name === name);
const buttons = tree => named(tree, 'Button');
const button = (tree, label) => buttons(tree).find(node => node.props.children === label);
const labels = tree => buttons(tree).map(node => node.props.children);
function fixture(t, {selected = true, grants = {}, editDraft = false} = {}) {
  let state = {scopeKey: 'shared-header:actor:library', selectedTopRef: selected ? TOP : null,
    directory: {status: 'ready', data: {tops: [], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}}},
    detail: {status: selected ? 'ready' : 'idle', data: selected ? {top_ref: TOP, title: 'Top <safe>', description: 'Subtitle', revision: '7', items: [],
      ...(editDraft ? {edit_draft: {title: 'Top <safe>', description: 'Subtitle', items: []}} : {}),
      allowed_actions: {[BROWSE]: true, can_edit: true, can_view_sharing: true, can_copy: true, can_delete: true, ...grants}} : null}, mutation: {status: 'idle'}};
  const native = createNativeHomeRuntime(), calls = {opens: [], mutations: [], confirms: []};
  const runtime = {buttonHtml: value => native.context.ButtonComponent.renderButton(value),
    actionHtml: value => native.context.ButtonComponent.renderActionButton(value),
    alertHtml: value => native.context.buildOnPageAlertHtml(value),
    galleryCardHtml: value => native.context.buildGalleryCardHtml(value), artboxHtml: value => native.context.buildAlbumArtboxHtml(value),
    confirm: async (...args) => {calls.confirms.push(args); return true;}};
  const controller = {getSnapshot: () => state, mutate: async (...args) => {calls.mutations.push(args); return true;},
    open() {}, load() {}, canRetryMutation: () => false};
  // Existing component-test hook contract: real view handlers and effects, no
  // replacement application controller, React reconciliation or geometry claim.
  const store = []; let cursor = 0, pending = [];
  const effect = (callback, deps) => {const index = cursor++, old = store[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) pending.push(() => {
      old?.cleanup?.(); store[index] = {deps, cleanup: callback()};
    });};
  const hooks = {...React, useRef(value) {return store[cursor++] ||= {current: value};},
    useState(initial) {const slot = store[cursor++] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slot.value, next => {slot.value = typeof next === 'function' ? next(slot.value) : next;}];},
    useEffect: effect, useLayoutEffect: effect};
  const loaded = {exports: {}};
  vm.runInNewContext(code, {module: loaded, exports: loaded.exports, console, AbortController,
    require: name => name === 'react' ? hooks : local(name)});
  t.after(() => {for (const slot of store) slot?.cleanup?.();});
  const props = () => ({runtime, controller, state, onOpen: ref => calls.opens.push(ref)});
  return {native, calls, runtime, controller, state: () => state, replace: next => {state = next;},
    render() {cursor = 0; pending = []; const tree = loaded.exports.AlbumTopsView(props()); for (const run of pending) run(); return tree;},
    markup(tree) {const host = native.document.createElement('div'); host.innerHTML = renderToStaticMarkup(tree); return host;}};
}
function shared(tree) {
  const headers = named(tree, 'SharedHeader');
  assert.equal(headers.length, 1, 'PRODUCT_NOT_IMPLEMENTED: Album Tops must use exactly one existing SharedHeader owner');
  assert.equal(elements(tree).filter(node => node.type === 'header').length, 0, 'no bespoke header wrapper competes with SharedHeader');
  return headers[0];
}

test('directory delegates its one Create action to the shared Tools capsule', t => {
  const h = fixture(t, {selected: false}), tree = h.render(), header = shared(tree);
  assert.deepEqual(labels(header.props.actions), ['Create Album Top']);
  assert.deepEqual(labels(header.props.leading), []);
  assert.deepEqual(labels(header.props.outsideActions), []);
  assert.deepEqual(labels(header.props.finalAction), []);
  const host = h.markup(tree), actual = host.querySelector('[data-shared-header]');
  assert.ok(actual); assert.equal(host.querySelectorAll('header').length, 1);
  assert.equal(actual.getAttribute('aria-label'), 'Album Tops header');
  assert.equal(actual.getAttribute('tabindex'), '-1');
  assert.ok(buttonNamed(actual.querySelector('[data-header-action-capsule]'), /^Create Album Top$/));
  assert.equal(actual.querySelectorAll('[data-header-tools]').length, 1);
});

test('detail delegates original ordered actions once and Back remains leading', t => {
  const h = fixture(t), tree = h.render(), header = shared(tree);
  assert.deepEqual(labels(header.props.leading), ['Back']);
  assert.deepEqual(labels(header.props.actions), ['Edit Album Top', 'Share', 'Save a copy', 'Delete Album Top']);
  assert.deepEqual(labels(header.props.outsideActions), []);
  assert.deepEqual(labels(header.props.finalAction), []);
  assert.deepEqual(labels(tree), ['Back', 'Edit Album Top', 'Share', 'Save a copy', 'Delete Album Top']);
  const host = h.markup(tree), capsule = host.querySelector('[data-header-action-capsule]');
  for (const label of ['Edit Album Top', 'Share', 'Save a copy', 'Delete Album Top']) {
    assert.equal([...host.querySelectorAll('button')].filter(node => node.getAttribute('aria-label') === label).length, 1);
    assert.ok(buttonNamed(capsule, new RegExp(`^${label}$`)));
  }
  assert.equal(buttonNamed(capsule, /^Back$/, false), null);
  assert.match(host.innerHTML, /Top &lt;safe&gt;/);
});

test('shared capsule retains strict current action projections and busy state', t => {
  for (const grants of [{can_edit: false, can_view_sharing: false, can_copy: false, can_delete: false},
    {can_edit: 'true', can_view_sharing: 1, can_copy: 'true', can_delete: 1}]) {
    const h = fixture(t, {grants}); assert.deepEqual(labels(shared(h.render()).props.actions), []);
  }
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'idle', refreshing: true}]) {
    const h = fixture(t); h.replace({...h.state(), mutation});
    for (const action of buttons(shared(h.render()).props.actions)) assert.equal(action.props.disabled, true);
  }
  const h = fixture(t); h.replace({...h.state(), detail: {status: 'denied', data: null}});
  assert.deepEqual(labels(shared(h.render()).props.actions), []);
});

test('retired capsule handlers cannot act on another detail object or revoked grants', async t => {
  for (const kind of ['replacement', 'revoked']) for (const label of ['Edit Album Top', 'Share', 'Save a copy', 'Delete Album Top']) {
    const h = fixture(t), tree = h.render(); shared(tree); const callback = button(tree, label).props.onClick;
    const old = h.state(), data = {...old.detail.data, ...(kind === 'revoked' ? {allowed_actions: {[BROWSE]: true}} : {})};
    h.replace({...old, detail: {...old.detail, data}}); await callback();
    assert.deepEqual(h.calls.mutations, []); assert.deepEqual(h.calls.confirms, []);
    const next = h.render(); assert.equal(named(next, 'ShareAlbumTop').length, 0);
    assert.equal(named(next, 'TopFields').length, 0); assert.equal(named(next, 'AlbumTopBuilder').length, 0);
  }
});

test('Delete keeps the confirmation-time snapshot guard after shared delegation', async t => {
  const h = fixture(t), tree = h.render(); shared(tree);
  let resolve; h.runtime.confirm = () => new Promise(yes => {resolve = yes;});
  const pending = button(tree, 'Delete Album Top').props.onClick();
  h.replace({...h.state(), mutation: {status: 'idle'}}); resolve(true); await pending;
  assert.deepEqual(h.calls.mutations, []);
});

test('inline draft header reuses SharedHeader with the exact field/action nodes and guarded Back', async t => {
  const h = fixture(t, {editDraft: true}); let tree = h.render(); shared(tree);
  button(tree, 'Edit Album Top').props.onClick(); tree = h.render();
  const inline = named(tree, 'InlineAlbumTopEdit')[0]; assert.ok(inline);
  const fields = React.createElement('input', {name: 'title', defaultValue: 'Draft'});
  const actions = React.createElement(React.Fragment, null, React.createElement('button', null, 'Save'), React.createElement('button', null, 'Cancel'));
  const cancels = []; let allow = false;
  const edit = {fields, actions, busy: false, cancel: async options => {cancels.push(options); return allow;}};
  const header = shared(inline.props.renderHeader(edit));
  assert.ok(elements(header.props.identity).includes(fields) || elements(header.props.children).includes(fields), 'draft field keeps its exact React node');
  assert.equal(header.props.actions, actions, 'Save/Cancel remain owned by InlineAlbumTopEdit');
  assert.deepEqual(labels(header), ['Back'], 'normal Top actions disappear while inline editing');
  await button(header.props.leading, 'Back').props.onClick(); assert.deepEqual(h.calls.opens, []);
  allow = true; await button(header.props.leading, 'Back').props.onClick(); assert.deepEqual(h.calls.opens, [null]);
  assert.equal(cancels.length, 2); assert.equal(cancels[0].restoreFocus, false); assert.equal(cancels[1].restoreFocus, false);
  assert.equal(button(shared(inline.props.renderHeader({...edit, busy: true})).props.leading, 'Back').props.disabled, true);
});

// Use the native harness's DOM for visibility ancestry and connectivity. Rect
// availability is supplied explicitly; this is focus-target policy, not layout
// measurement or a browser-focus acceptance claim.
function focusHost(h, {compact = false, toolsHidden = false, editDisabled = false} = {}) {
  const host = h.native.document.createElement('header');
  host.setAttribute('tabindex', '-1');
  host.innerHTML = `<span ${toolsHidden ? 'hidden' : ''}><button data-header-tools="true" aria-label="Tools">Tools</button></span><span ${compact ? 'inert="" aria-hidden="true"' : ''}><button aria-label="Edit Album Top" ${editDisabled ? 'disabled' : ''}>Edit Album Top</button></span>`;
  h.native.document.body.appendChild(host);
  const focused = [];
  for (const node of [host, ...host.querySelectorAll('button')]) {
    node.getClientRects = () => node.closest('[hidden],[inert],[aria-hidden="true"]') ? [] : [{}];
    node.focus = () => focused.push(node);
  }
  return {host, focused, edit: host.querySelector('[aria-label="Edit Album Top"]'), tools: host.querySelector('[data-header-tools]')};
}
function attachHeader(header, host) {
  assert.ok(header.props.headerRef, 'Top exposes its actual shared DOM header to existing focus owner');
  if (typeof header.props.headerRef === 'function') header.props.headerRef(host);
  else header.props.headerRef.current = host;
}

test('inline return selects visible Edit then shared Tools then focusable header', t => {
  for (const [options, target] of [[{}, 'edit'], [{compact: true}, 'tools'], [{compact: true, toolsHidden: true}, 'host'], [{editDisabled: true, toolsHidden: true}, 'host']]) {
    const h = fixture(t, {editDraft: true}), dom = focusHost(h, options);
    let tree = h.render(); attachHeader(shared(tree), dom.host);
    button(tree, 'Edit Album Top').props.onClick(); tree = h.render();
    const inline = named(tree, 'InlineAlbumTopEdit')[0]; assert.ok(inline);
    inline.props.onClose({restoreFocus: true}); h.render();
    assert.equal(dom.focused.at(-1), dom[target], JSON.stringify(options));
  }
});

test('dialog focus return rejects a connected opener hidden by compact layout', t => {
  for (const kind of ['Edit Album Top', 'Share']) for (const compact of [false, true]) {
    const h = fixture(t), dom = focusHost(h, {compact});
    const tree = h.render(); attachHeader(shared(tree), dom.host);
    button(tree, kind).props.onClick({target: dom.edit});
    const next = h.render();
    const dialog = kind === 'Share' ? named(next, 'ShareAlbumTop')[0] :
      named(next, 'TopFields')[0] || named(next, 'AlbumTopBuilder')[0];
    assert.ok(dialog, kind);
    assert.equal(dialog.props.returnFocus(), compact ? dom.tools : dom.edit);
  }
});

test('SharedHeader external object/callback refs compose with its internal root and clear on unmount', () => {
  const sharedCode = buildSync({entryPoints: [path.join(root, 'music_app/static/js/home-friends/shared-header.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  for (const kind of ['object', 'callback', 'absent']) {
    const refs = [], seen = [], object = {current: null}, dom = {nodeType: 1};
    const hooks = {...React, useRef(value) {const ref = {current: value}; refs.push(ref); return ref;},
      useState(initial) {return [initial, () => {}];}, useCallback: callback => callback,
      useLayoutEffect() {}, useEffect() {}};
    const loaded = {exports: {}};
    vm.runInNewContext(sharedCode, {module: loaded, exports: loaded.exports, require: name => name === 'react' ? hooks : local(name)});
    const headerRef = kind === 'object' ? object : kind === 'callback' ? node => seen.push(node) : undefined;
    const tree = loaded.exports.SharedHeader({runtime: {}, id: 'bounded-ref-test', headerRef, tabIndex: -1, ariaLabel: 'Album Tops header'});
    assert.equal(tree.type, 'header'); assert.equal(tree.props.tabIndex, -1); assert.equal(tree.props['aria-label'], 'Album Tops header');
    const commit = value => typeof tree.props.ref === 'function' ? tree.props.ref(value) : (tree.props.ref.current = value);
    commit(dom); assert.equal(refs[0].current, dom, 'internal measurement owner retains its actual root');
    if (kind === 'object') assert.equal(object.current, dom);
    if (kind === 'callback') assert.deepEqual(seen, [dom]);
    commit(null); assert.equal(refs[0].current, null);
    if (kind === 'object') assert.equal(object.current, null);
    if (kind === 'callback') assert.deepEqual(seen, [dom, null]);
  }
});

test('SharedHeader preserves React 19 callback-ref cleanup and replacement lifetimes', () => {
  const sharedCode = buildSync({entryPoints: [path.join(root, 'music_app/static/js/home-friends/shared-header.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const refs = [], events = []; let cursor = 0;
  const hooks = {...React, useRef(value) {return refs[cursor++] ||= {current: value};},
    useState(initial) {return [initial, () => {}];}, useCallback: callback => callback, useLayoutEffect() {}, useEffect() {}};
  const loaded = {exports: {}};
  vm.runInNewContext(sharedCode, {module: loaded, exports: loaded.exports, require: name => name === 'react' ? hooks : local(name)});
  const render = headerRef => {cursor = 0; return loaded.exports.SharedHeader({runtime: {}, id: 'ref-replacement', headerRef});};
  const first = {nodeType: 1, id: 'first'}, next = {nodeType: 1, id: 'next'};
  const callback = node => {events.push(['attach', node]); return () => events.push(['cleanup', node]);};
  const old = render(callback);
  assert.equal(typeof old.props.ref, 'function', 'external ref must compose with shared internal ref');
  const dispose = old.props.ref(first);
  assert.equal(typeof dispose, 'function', 'React19 returned callback cleanup must not be discarded');
  assert.equal(refs[0].current, first);
  dispose();
  assert.equal(refs[0].current, null); assert.deepEqual(events, [['attach', first], ['cleanup', first]]);
  const replacement = {current: null}, replacementTree = render(replacement);
  const disposeReplacement = replacementTree.props.ref(next);
  assert.equal(replacement.current, next); assert.equal(refs[0].current, next);
  if (typeof disposeReplacement === 'function') disposeReplacement(); else replacementTree.props.ref(null);
  assert.equal(replacement.current, null); assert.equal(refs[0].current, null);
  assert.deepEqual(events, [['attach', first], ['cleanup', first]], 'retired callback receives no duplicate null/cleanup');
});
