const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = require('node:module');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, buttonNamed} = require('./runtime/native-home-harness.cjs');

const source = path.resolve(__dirname, '../../music_app/static/js/album-tops/app.jsx');
const bundle = buildSync({entryPoints: [source], bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const loaded = new Module(`${__filename}.fixture.cjs`, module);
loaded.filename = `${__filename}.fixture.cjs`; loaded.paths = module.paths;
loaded._compile(bundle, loaded.filename);
const {AlbumTopsView} = loaded.exports;
const TOP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BROWSE = 'library.browse.read', CREATE = 'library.album_tops.create', MANAGE = 'library.album_tops.manage';
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const elements = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(node => node.type?.name === name);
const button = (tree, label) => elements(tree).find(node => node.type?.name === 'Button' && node.props.children === label);
const input = (tree, name) => elements(tree).find(node => node.type === 'input' && node.props.name === name);
const top = patch => ({top_ref: TOP, title: 'Top <title>', description: 'A private subtitle', revision: '7',
  allowed_actions: {[BROWSE]: true, [MANAGE]: true, can_read: true, can_edit: true,
    can_rename: true, can_delete: true}, items: [], ...patch});
function initialState({selected = false, status = 'ready', grants = {[BROWSE]: true, [CREATE]: true, can_create: true}, detail = top()} = {}) {
  return {scopeKey: 'top-components:actor:library', selectedTopRef: selected ? TOP : null,
    directory: {status: selected ? 'ready' : status, data: {tops: [top()], allowed_actions: grants}},
    detail: {status: selected ? status : 'idle', data: selected ? detail : null}, mutation: {status: 'idle'}};
}
function fixture(state = initialState()) {
  const native = createNativeHomeRuntime(), calls = {mutations: [], opens: [], loads: 0, confirms: [], owners: [], closes: [], saved: []};
  const runtime = {
    buttonHtml: value => native.context.ButtonComponent.renderButton(value),
    actionHtml: value => native.context.ButtonComponent.renderActionButton(value),
    alertHtml: value => native.context.buildOnPageAlertHtml(value),
    galleryCardHtml: value => native.context.buildGalleryCardHtml(value),
    artboxHtml: value => native.context.buildAlbumArtboxHtml(value),
    confirm(message, options) {calls.confirms.push({message, options}); return Promise.resolve(false);},
    confirmRetryOriginal: async () => false,
    openForm(options) {
      const owner = {options, dismissDisabled: options.dismissDisabled,
        setDismissDisabled(value) {this.dismissDisabled = value;},
        close(_value, closeOptions) {calls.closes.push(closeOptions); options.onClose(null, closeOptions); return true;}};
      calls.owners.push(owner); options.onMount({id: 'native-dialog-host'}); return owner;
    },
  };
  const controller = {getSnapshot: () => state,
    async mutate(...args) {calls.mutations.push(args); return false;}, retryMutation: async () => false,
    canRetryMutation: () => state.mutation.status === 'uncertain',
    load() {calls.loads++;}, open(ref) {calls.opens.push(ref);}};
  const props = () => ({runtime, controller, state, onOpen: ref => calls.opens.push(ref), onFormSaved: receipt => calls.saved.push(receipt)});
  return {native, runtime, controller, calls, props, replace(next) {state = next;},
    render() {
      const html = renderToStaticMarkup(React.createElement(AlbumTopsView, props()));
      const host = native.document.createElement('div'); host.innerHTML = html;
      return {html, host};
    }};
}

// As in the existing playlist component tests, this drives actual component
// handlers/effects with separate hook lifetimes. It is not React reconciliation,
// browser event propagation, native focus, geometry, or E2E acceptance proof.
function hookDriver(code = bundle, {mount = false} = {}) {
  const fibers = new Map(); let current, rootTree;
  const changed = (old, deps) => !old || !deps || !old.deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  function effect(callback, deps) {
    const fiber = current, index = fiber.cursor++, old = fiber.slots[index];
    if (changed(old, deps)) fiber.pending.push(() => {old?.cleanup?.(); fiber.slots[index] = {deps, cleanup: callback()};});
  }
  const hooks = {...React,
    useRef(value) {const fiber = current, index = fiber.cursor++; return fiber.slots[index] ||= {current: value};},
    useState(value) {
      const fiber = current, index = fiber.cursor++;
      const slot = fiber.slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slot.value, next => {if (!fiber.disposed) slot.value = typeof next === 'function' ? next(slot.value) : next;}];
    },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore(subscribe, getSnapshot) {
      effect(() => subscribe(() => {}), [subscribe, getSnapshot]);
      return getSnapshot();
    },
  };
  const module = {exports: {}};
  vm.runInNewContext(code, {module, exports: module.exports, console, AbortController,
    crypto: {randomUUID: require('node:crypto').randomUUID},
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react-dom') return {createPortal: (children, host) => mount
        ? React.createElement('native-portal', {host}, children) : {children, host}};
      if (name === 'react-dom/client') return {createRoot: () => ({render(tree) {rootTree = tree;}, unmount() {driver.dispose();}})};
      assert.fail(`Unexpected Album Top component dependency: ${name}`);
    }});
  const driver = {View: module.exports.AlbumTopsView, mount: module.exports.mountAlbumTops,
    renderMounted() {return driver.render('session', rootTree.type, rootTree.props);},
    render(name, Component, props) {
      const fiber = fibers.get(name) || {slots: [], disposed: false}; fibers.set(name, fiber);
      assert.equal(fiber.disposed, false);
      fiber.cursor = 0; fiber.pending = []; current = fiber;
      let tree;
      try {tree = Component(props);} finally {current = null;}
      for (const run of fiber.pending) run();
      return tree;
    },
    dispose() {for (const fiber of [...fibers.values()].reverse()) {
      if (fiber.disposed) continue;
      fiber.disposed = true; for (const slot of fiber.slots) slot?.cleanup?.();
    }},
  };
  return driver;
}
function editor(t, {selected = false, native = null} = {}) {
  const env = fixture(initialState({selected})), driver = hookDriver();
  t.after(() => driver.dispose());
  const renderView = () => {
    const tree = driver.render('view', driver.View, env.props());
    if (native) {
      // Commit the actual component's host ref into the bounded DOM fixture.
      // Button removal below remains explicit; this is not React reconciliation.
      const header = elements(tree).find(node => node.type === 'header');
      header.props.ref.current = native.header;
      native.header.setAttribute('tabindex', String(header.props.tabIndex));
      native.header.setAttribute('aria-label', header.props['aria-label']);
    }
    return tree;
  };
  button(renderView(), selected ? 'Edit Album Top' : 'Create Album Top').props.onClick(native ? {target: native.opener} : undefined);
  const renderFields = () => {
    const fields = component(renderView(), 'TopFields');
    assert.ok(fields, 'the current native action opened the editor');
    return driver.render('fields', fields.type, fields.props);
  };
  const renderForm = () => {
    const dialog = renderFields();
    driver.render('dialog', dialog.type, dialog.props);
    return driver.render('dialog', dialog.type, dialog.props).children;
  };
  return {...env, driver, renderView, renderFields, renderForm};
}

test('directory composes native gallery controls and escaped server cards without unsupported actions', () => {
  const env = fixture(), {html, host} = env.render();
  assert.ok(host.querySelector('.gallery-bar'));
  assert.equal(buttonNamed(host, /^Create Album Top$/).disabled, false);
  assert.ok(buttonNamed(host, /^Create Album Top$/).classList.contains('action-button'));
  assert.match(html, /Top &lt;title&gt;/);
  assert.equal(host.querySelectorAll('.album-card').length, 1);
  assert.ok(host.querySelector('[data-gallery-card-intent="open"]'));
  assert.equal(host.querySelector('[data-gallery-card-intent="play"]'), null);
  for (const label of [/Share/, /Progress/, /Listen/, /Delete/, /Edit/]) assert.equal(buttonNamed(host, label, false), null);
  assert.deepEqual(env.native.forbiddenCalls, []);
});

test('empty, denied and failed directories render truthful native status and error retry', () => {
  for (const [status, text] of [['empty', /No Album Tops yet/], ['denied', /don't have access/], ['error', /could not be loaded/]]) {
    const state = initialState({status});
    state.directory.data = status === 'empty' ? {tops: [], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}} : null;
    const env = fixture(state), {host} = env.render();
    assert.match(host.textContent, text);
    assert.equal(host.querySelectorAll('.album-card').length, 0);
    assert.equal(Boolean(buttonNamed(host, /^Retry$/, false)), status === 'error');
    assert.equal(Boolean(buttonNamed(host, /^Create Album Top$/, false)), status === 'empty');
    if (status === 'error') {
      const driver = hookDriver();
      const statusNode = component(driver.render('view', driver.View, env.props()), 'Status');
      statusNode.props.retry(); assert.equal(env.calls.loads, 1); driver.dispose();
    }
  }
});

test('create and manage controls require their own explicit server action projections', () => {
  for (const allowed_actions of [{}, {[BROWSE]: true, [CREATE]: 'true', can_create: true},
    {[CREATE]: true, can_create: true}, {[BROWSE]: true, [CREATE]: true},
    Object.create({[BROWSE]: true, [CREATE]: true, can_create: true})]) {
    const {host} = fixture(initialState({grants: allowed_actions})).render();
    assert.equal(buttonNamed(host, /^Create Album Top$/, false), null);
  }
  for (const allowed_actions of [{[BROWSE]: true}, {[BROWSE]: true, [MANAGE]: true},
    {[BROWSE]: true, can_edit: 1, can_delete: 'true'}, {can_edit: true, can_delete: true},
    Object.create({[BROWSE]: true, can_edit: true, can_delete: true})]) {
    const {host} = fixture(initialState({selected: true, detail: top({allowed_actions})})).render();
    assert.equal(buttonNamed(host, /^Edit Album Top$/, false), null);
    assert.equal(buttonNamed(host, /^Delete Album Top$/, false), null);
  }
});

test('Top detail uses opaque item cards without inventing media, sharing or progress controls', () => {
  const state = initialState({selected: true, detail: top({items: [{item_ref: ITEM, title: 'Album <name>', artist: 'Artist', year: 2001}]})});
  const env = fixture(state), {html, host} = env.render();
  assert.match(html, /Album &lt;name&gt;/);
  assert.equal(host.querySelectorAll('.album-card').length, 1);
  assert.equal(host.querySelector('[data-gallery-card-intent]'), null);
  assert.ok(buttonNamed(host, /^Edit Album Top$/));
  assert.ok(buttonNamed(host, /^Delete Album Top$/));
  const driver = hookDriver(), tree = driver.render('view', driver.View, env.props());
  button(tree, 'Back').props.onClick(); assert.deepEqual(env.calls.opens, [null]); driver.dispose();
});

test('pending, uncertain and acknowledged-refreshing writes visibly disable native management actions', () => {
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'ready', refreshing: true}]) {
    const state = initialState({selected: true}); state.mutation = mutation;
    const env = fixture(state), {host} = env.render();
    for (const label of [/^Edit Album Top$/, /^Delete Album Top$/]) {
      const control = buttonNamed(host, label);
      assert.equal(control.disabled, true);
      assert.equal(control.getAttribute('aria-disabled'), 'true');
    }
  }
});

test('Create submits authored fields through the controller and preserves an unconfirmed draft', async t => {
  const env = editor(t);
  let form = env.renderForm();
  assert.equal(button(form, 'Create Album Top').props.disabled, true);
  input(form, 'top-name').props.onChange({target: {value: 'New Top'}});
  input(form, 'top-subtitle').props.onChange({target: {value: 'Typed subtitle'}});
  form = env.renderForm();
  assert.equal(button(form, 'Create Album Top').props.disabled, false);
  await form.props.onSubmit({preventDefault() {}});
  assert.deepEqual(plain(env.calls.mutations), [['create', {title: 'New Top', description: 'Typed subtitle', album_refs: []}]]);
  assert.equal(env.calls.closes.length, 0);
  assert.equal(input(env.renderForm(), 'top-name').props.value, 'New Top');
});

test('same-Top revision replacement preserves typed edits but blocks stale submission', async t => {
  const env = editor(t, {selected: true});
  input(env.renderForm(), 'top-name').props.onChange({target: {value: 'My draft'}});
  const state = env.controller.getSnapshot();
  env.replace({...state, detail: {...state.detail, data: {...state.detail.data, revision: '8', title: 'Changed by server'}}});
  const form = env.renderForm();
  assert.equal(input(form, 'top-name').props.value, 'My draft');
  assert.equal(button(form, 'Save').props.disabled, true);
  await form.props.onSubmit({preventDefault() {}});
  assert.equal(env.calls.mutations.length, 0);
  assert.ok(elements(form).some(node => node.type?.name === 'NativeHtml' && /draft is preserved/.test(node.props.html)));
});

test('editor busy, uncertain and acknowledged-refreshing states block fields, submission, and native dismissal', async t => {
  const env = editor(t, {selected: true});
  env.renderForm();
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'ready', refreshing: true}]) {
    env.replace({...env.controller.getSnapshot(), mutation});
    const form = env.renderForm(), dialog = env.renderFields();
    assert.equal(input(form, 'top-name').props.disabled, true);
    assert.equal(input(form, 'top-subtitle').props.disabled, true);
    assert.equal(button(form, 'Cancel').props.disabled, true);
    assert.equal(button(form, 'Save').props.disabled, true);
    assert.equal(dialog.props.beforeDismiss(), false);
    assert.equal(env.calls.owners.at(-1).dismissDisabled, true);
    await form.props.onSubmit({preventDefault() {}});
  }
  assert.equal(env.calls.mutations.length, 0);
});

test('dirty Cancel uses the shared native confirmation and clean dismissal needs no prompt', async t => {
  const env = editor(t);
  assert.equal(env.renderFields().props.beforeDismiss(), true);
  input(env.renderForm(), 'top-name').props.onChange({target: {value: 'Unsaved'}});
  assert.equal(await env.renderFields().props.beforeDismiss(), false);
  assert.equal(env.calls.confirms.length, 1);
  assert.equal(env.calls.confirms[0].options.title, 'Discard Album Top changes');
  assert.equal(env.calls.confirms[0].options.danger, true);
  assert.equal(input(env.renderForm(), 'top-name').props.value, 'Unsaved');
});

test('native delete confirmation cannot apply to a refreshed or revoked controller snapshot', async () => {
  for (const changed of [false, true]) {
    const env = fixture(initialState({selected: true})), driver = hookDriver(), pending = deferred();
    env.runtime.confirm = () => pending.promise;
    const tree = driver.render('view', driver.View, env.props());
    const deleting = button(tree, 'Delete Album Top').props.onClick();
    assert.equal(env.calls.mutations.length, 0);
    if (changed) env.replace({...env.controller.getSnapshot(), mutation: {status: 'denied'}});
    pending.resolve(true); await deleting;
    assert.deepEqual(plain(env.calls.mutations), changed ? [] : [['delete']]);
    driver.dispose();
  }
});

test('write denial immediately removes a retained editor and cannot resurrect its private draft', t => {
  const env = editor(t, {selected: true});
  input(env.renderForm(), 'top-name').props.onChange({target: {value: 'Private retained draft'}});
  const previous = env.controller.getSnapshot();
  env.replace({...previous, directory: {status: 'denied', data: null}, detail: {status: 'denied', data: null}, mutation: {status: 'denied'}});
  assert.equal(component(env.renderView(), 'TopFields'), undefined);
  env.replace(previous);
  assert.equal(component(env.renderView(), 'TopFields'), undefined, 'restored read authority never revives an old dialog');
});

function nativeFormHistory() {
  const env = createNativeHomeRuntime(), {context, document} = env;
  const proto = document.createElement('div').constructor.prototype;
  proto.before = function (node) {this.parentNode.insertBefore(node, this);};
  proto.replaceWith = function (node) {this.before(node); this.remove();};
  proto.focus = function () {document.activeElement = this;};
  document.createComment = () => document.createElement('fixture-placeholder');
  document.body.innerHTML = '<div id="app-shell" data-native-account-id="41" data-native-library-id="73"></div>'
    + '<header id="top-header"><button id="opener">Edit Album Top</button></header><div id="mobile-page-outlet"></div>'
    + '<div id="app-form-modal"><div role="dialog" aria-modal="true">'
    + ['title', 'content', 'error', 'cancel', 'submit'].map(name => `<div id="app-form-${name}"></div>`).join('') + '</div></div>';
  const opener = document.getElementById('opener'); opener.focus();
  const entries = [{state: {albumHavenNavigationPosition: 0}, url: `https://music.test/?surface=album_tops&top_ref=${TOP}`}];
  let position = 0, queued = null;
  context.window.innerWidth = 390;
  context.window.location = new URL(entries[0].url);
  context.window.addEventListener = () => {};
  context.window.removeEventListener = () => {};
  context.window.history = {
    get state() {return entries[position].state;},
    pushState(state, _title, url) {entries.splice(position + 1); entries.push({state, url: String(url)}); position++; context.window.location.href = String(url);},
    replaceState(state, _title, url) {entries[position] = {state, url: String(url)}; context.window.location.href = String(url);},
    go(delta) {assert.equal(queued, null); queued = delta;},
  };
  context.window.AlbumHavenSettingsNavigation = {instance: {pushLibraryHistory(url, state) {
    context.window.history.pushState({...state, albumHavenNavigationPosition: position + 1}, '', url);
  }}};
  Object.assign(context, {state: {view: {surface: {active: 'album_tops'}}, utility: {}},
    buildUrl: () => `/?surface=album_tops&top_ref=${TOP}`, requestAnimationFrame: callback => callback(),
    closeArtistsDrawer() {}, closeGalleryMainSurface() {}, bindOverlayPointerOrigin() {},
    overlayClickStartedOnOverlay: () => false,
    handleGalleryBootstrapPopState() {assert.fail('the unchanged native Top parent must be retained');},
  });
  for (const file of ['browser-dialog-helpers.js', 'mobile-navigation.js']) vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../../music_app/static/js/runtime', file), 'utf8'), context, {filename: file});
  // This probe runs the real dialog/history owners. Responsive layout is tested
  // separately; the bounded native DOM fixture deliberately does not measure it.
  context.syncMobilePageShell = () => {};
  return {...env, entries, opener, header: document.getElementById('top-header'), get position() {return position;}, get queued() {return queued;},
    finishReturn() {
      assert.equal(queued, -1); position += queued; queued = null;
      context.window.location.href = entries[position].url;
      assert.equal(context.handleMobilePagePopState(), true);
    }};
}

test('acknowledged Top form awaits the actual native mobile parent traversal before reporting its receipt', async t => {
  const native = nativeFormHistory(), env = editor(t, {selected: true, native});
  const nativeOptions = [];
  env.runtime.openForm = options => native.context.openReactFormDialog({...options,
    retainParentView: () => true,
    onClose(...args) {nativeOptions.push(args[1]); options.onClose(...args);},
  });
  env.renderForm();
  assert.equal(native.position, 1);
  assert.equal(native.context.window.location.searchParams.get('mobile_page'), 'form');
  const receipt = {action: 'save', top_ref: TOP, revision: '8', request_key: ITEM};
  env.controller.mutate = async (...args) => {env.calls.mutations.push(args); return true;};
  await env.renderForm().props.onSubmit({preventDefault() {}});
  assert.equal(native.queued, null, 'a mutation return value is not a native close acknowledgement');
  env.replace({...env.controller.getSnapshot(), mutation: {status: 'ready', refreshing: true,
    action: 'save', command: {request_key: ITEM}, data: receipt}});
  env.renderFields();
  assert.equal(native.queued, -1);
  assert.equal(native.document.getElementById('app-form-modal').hidden, true);
  assert.equal(nativeOptions.length, 0);
  assert.deepEqual(env.calls.saved, []);
  assert.ok(component(env.renderView(), 'TopFields'), 'React must retain the form until the native owner completes');
  env.replace({...env.controller.getSnapshot(), mutation: {...env.controller.getSnapshot().mutation, refreshing: false}});
  env.renderFields();
  assert.equal(native.queued, -1, 'the ready-to-refreshed transition must not queue a second parent return');
  native.finishReturn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.position, 0);
  assert.equal(native.context.window.location.searchParams.get('top_ref'), TOP);
  assert.deepEqual(plain(env.calls.saved), [receipt]);
  assert.deepEqual(plain(nativeOptions), [{restoreFocus: true, returnToParent: true, current: true}]);
  assert.equal(native.document.activeElement, native.opener);
  assert.equal(component(env.renderView(), 'TopFields'), undefined);
});

test('acknowledged Create and Edit return native focus to the current header after their launcher unmounts', async t => {
  for (const selected of [false, true]) {
    const native = nativeFormHistory(), env = editor(t, {selected, native});
    let options;
    env.runtime.openForm = value => {
      options = value;
      return native.context.openReactFormDialog({...value, retainParentView: () => true});
    };
    env.renderForm();
    assert.equal(options.returnFocus(), native.opener, 'the actual launcher is preferred while connected');
    assert.equal(native.header.getAttribute('tabindex'), '-1');
    assert.equal(native.header.getAttribute('aria-label'), 'Album Tops header');
    const previous = env.controller.getSnapshot(), action = selected ? 'save' : 'create';
    const receipt = {action, top_ref: TOP, revision: '8', request_key: ITEM};
    env.replace({...previous, selectedTopRef: TOP, detail: {status: 'loading', data: null},
      mutation: {status: 'ready', refreshing: true, action, command: {request_key: ITEM}, data: receipt}});
    const refreshingView = env.renderView();
    assert.equal(button(refreshingView, selected ? 'Edit Album Top' : 'Create Album Top'), undefined);
    native.opener.remove(); // Commit the launcher removal from the refreshed component tree.
    native.document.body.focus();
    assert.equal(native.opener.isConnected, false);
    assert.equal(options.returnFocus(), native.header);
    env.renderFields();
    assert.equal(native.queued, -1);
    assert.equal(native.document.activeElement, native.document.body, 'native history completion still owns focus timing');
    assert.deepEqual(env.calls.saved, []);
    native.finishReturn();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(native.document.activeElement, native.header);
    assert.deepEqual(plain(env.calls.saved), [receipt]);
    assert.equal(component(env.renderView(), 'TopFields'), undefined);
  }
});

test('clean native Cancel restores the connected launcher and scope-unmount cleanup never steals focus', async t => {
  for (const closeKind of ['cancel', 'scope-unmount']) {
    const native = nativeFormHistory(), env = editor(t, {selected: true, native});
    env.runtime.openForm = options => native.context.openReactFormDialog({...options, retainParentView: () => true});
    const form = env.renderForm();
    if (closeKind === 'cancel') {
      const closing = button(form, 'Cancel').props.onClick();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(native.queued, -1);
      native.finishReturn();
      await closing;
      assert.equal(native.document.activeElement, native.opener);
      assert.equal(component(env.renderView(), 'TopFields'), undefined);
    } else {
      native.document.getElementById('app-shell').setAttribute('data-native-account-id', '42');
      native.document.body.focus();
      env.driver.dispose();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(native.queued, null, 'unmount cannot traverse the replacement actor\'s history');
      assert.equal(native.document.activeElement, native.document.body);
      assert.equal(native.context.getActiveAppFormPage(), null);
      assert.equal(native.document.getElementById('app-form-modal').hidden, true);
    }
    assert.deepEqual(env.calls.saved, []);
  }
});

test('failed native close preserves the confirmed receipt and shows a shared alert without reporting form completion', async t => {
  for (const failure of ['false', 'reject']) {
    const env = editor(t, {selected: true}), closing = deferred();
    env.runtime.openForm = options => {
      options.onMount({});
      return {close: () => closing.promise, setDismissDisabled() {}};
    };
    env.renderForm();
    env.replace({...env.controller.getSnapshot(), mutation: {status: 'ready', refreshing: false,
      action: 'save', command: {request_key: ITEM}, data: {action: 'save', top_ref: TOP, request_key: ITEM, revision: '8'}}});
    env.renderFields();
    if (failure === 'false') closing.resolve(false); else closing.reject(new Error('Native return failed'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.calls.saved, []);
    const form = env.renderForm();
    assert.ok(elements(form).some(node => node.type?.name === 'NativeHtml' && /could not return to its parent/.test(node.props.html)));
    assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
  }
});

test('native hiding retains an uncertain operation while scope replacement clears it and mount cleanup retires providers', async t => {
  const code = buildSync({entryPoints: [path.resolve(__dirname, '../../music_app/static/js/album-tops/index.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const driver = hookDriver(code, {mount: true}), env = fixture();
  const listeners = new Set(), calls = {list: 0, read: 0, write: [], disposed: 0};
  let shell = Object.freeze({scopeKey: 'mounted:actor:library', authenticated: true, inLibrary: true,
    active: true, visible: true, topRef: TOP, sidebarMode: 'album_tops', viewVersion: 1});
  const runtime = {...env.runtime, snapshot: () => shell,
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    acceptsPrivateScope: scope => shell.authenticated && shell.inLibrary && shell.scopeKey === scope,
    navigationItemHtml: () => '<a>Server Top</a>', navigate() {assert.fail('save must not create a navigation entry');}};
  const mounted = driver.mount({host: {}, sidebarHost: {}, runtime, providers: {
    list() {calls.list++; return {tops: [top()], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}};},
    read() {calls.read++; return top();},
    execute(action, command) {
      calls.write.push(plain(command));
      if (calls.write.length === 1) throw new TypeError('Connection lost after submission');
      return {action, top_ref: TOP, request_key: command.request_key, revision: '8'};
    },
    dispose() {calls.disposed++;},
  }});
  t.after(() => mounted.dispose());
  driver.renderMounted();
  await new Promise(resolve => setImmediate(resolve));
  const view = component(driver.renderMounted(), 'AlbumTopsView');
  assert.ok(view);
  const controller = view.props.controller;
  await controller.mutate('save', {title: 'Draft after uncertain save'});
  const original = plain(controller.getSnapshot().mutation.command);
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  const beforeReads = [calls.list, calls.read];
  shell = Object.freeze({...shell, active: false, visible: false, topRef: null, sidebarMode: 'albums', viewVersion: 2});
  assert.equal(component(driver.renderMounted(), 'AlbumTopsView'), undefined);
  shell = Object.freeze({...shell, inLibrary: false});
  driver.renderMounted();
  assert.deepEqual([calls.list, calls.read], beforeReads);
  assert.equal(mounted.refresh(), undefined);
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  assert.deepEqual(plain(controller.getSnapshot().mutation.command), original);
  shell = Object.freeze({...shell, inLibrary: true, active: true, visible: true, topRef: TOP, sidebarMode: 'album_tops', viewVersion: 3});
  driver.renderMounted();
  await new Promise(resolve => setImmediate(resolve));
  await controller.retryMutation();
  assert.deepEqual(calls.write, [original, original]);
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
  shell = Object.freeze({...shell, scopeKey: 'mounted:other-actor:library', authenticated: false});
  assert.equal(component(driver.renderMounted(), 'AlbumTopsView'), undefined);
  assert.equal(controller.getSnapshot().scopeKey, null);
  assert.equal(controller.getSnapshot().directory.data, null);
  assert.equal(controller.getSnapshot().detail.data, null);
  assert.equal(controller.getSnapshot().mutation.command, null);
  mounted.dispose(); mounted.dispose();
  assert.equal(calls.disposed, 1);
  assert.equal(listeners.size, 0);
});

async function acknowledgementMount(t, action) {
  const code = buildSync({entryPoints: [path.resolve(__dirname, '../../music_app/static/js/album-tops/index.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const driver = hookDriver(code, {mount: true}), env = fixture(), list = deferred(), read = deferred(), entered = deferred();
  let refreshing = false;
  let shell = {scopeKey: 'ack:actor:library', authenticated: true, inLibrary: true, active: true,
    visible: true, topRef: action === 'delete' ? TOP : null, sidebarMode: 'album_tops', viewVersion: 1};
  const navigations = [], listeners = new Set();
  const runtime = {...env.runtime, snapshot: () => shell,
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    acceptsPrivateScope: scope => scope === shell.scopeKey, navigationItemHtml: () => '<a>Server Top</a>',
    navigate(value) {navigations.push(value); return Promise.resolve(true);}};
  const mounted = driver.mount({host: {}, sidebarHost: {}, runtime, providers: {
    list() {if (refreshing) {entered.resolve(); return list.promise;} return {tops: [top()], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}};},
    read() {return refreshing ? read.promise : top();},
    execute(kind, command) {refreshing = true; return {action: kind, request_key: command.request_key, top_ref: TOP, revision: '8'};},
  }});
  t.after(() => mounted.dispose());
  driver.renderMounted(); await new Promise(resolve => setImmediate(resolve));
  const initial = component(driver.renderMounted(), 'AlbumTopsView');
  assert.ok(initial);
  const controller = initial.props.controller;
  const writing = controller.mutate(action, action === 'create' ? {title: 'Created Top', album_refs: []} : {});
  await entered.promise;
  return {driver, controller, writing, list, read, navigations,
    render: () => driver.renderMounted(), replaceShell(patch) {shell = {...shell, ...patch};},
    finishReads() {list.resolve({tops: action === 'delete' ? [] : [top()], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}}); read.resolve(top());},
  };
}

test('create navigation waits for both matching native close and refreshed acknowledgement in either completion order', async t => {
  for (const order of ['native-close-first', 'refresh-first']) {
    const h = await acknowledgementMount(t, 'create');
    const receipt = plain(h.controller.getSnapshot().mutation.data);
    const acknowledgedView = component(h.render(), 'AlbumTopsView');
    assert.ok(acknowledgedView, 'acknowledgement must not unmount the native form while selectedTopRef changes');
    assert.equal(h.controller.getSnapshot().mutation.refreshing, true);
    assert.equal(h.navigations.length, 0);
    for (const patch of [{request_key: ITEM}, {top_ref: ITEM}, {revision: '999'}, {action: 'save'}]) {
      acknowledgedView.props.onFormSaved({...receipt, ...patch}); h.render();
      assert.equal(h.navigations.length, 0);
    }
    if (order === 'native-close-first') {
      acknowledgedView.props.onFormSaved(receipt); h.render();
      assert.equal(h.navigations.length, 0, 'closing cannot outrun authoritative refresh');
      h.finishReads(); await h.writing; h.render();
    } else {
      h.finishReads(); await h.writing;
      const retainedView = component(h.render(), 'AlbumTopsView');
      assert.ok(retainedView);
      assert.equal(h.navigations.length, 0, 'refresh cannot bypass the delayed native close');
      retainedView.props.onFormSaved(receipt); h.render();
    }
    assert.equal(h.navigations.length, 1);
    assert.equal(h.navigations[0].top_ref, TOP);
    assert.equal(h.navigations[0].isCurrent(), true);
    // Exercise the store-observer contract against a replacement ready snapshot
    // containing the identical server receipt, without issuing another write.
    const snapshot = h.controller.getSnapshot();
    h.controller.getSnapshot = () => ({...snapshot, mutation: {...snapshot.mutation, data: {...snapshot.mutation.data}}});
    h.render(); h.render();
    assert.equal(h.navigations.length, 1);
    assert.equal(h.navigations[0].isCurrent(), true, 'receipt ownership is not object-identity ownership');
  }
});

test('a stale native form close cannot navigate a new library entry after creation', async t => {
  const h = await acknowledgementMount(t, 'create');
  const view = component(h.render(), 'AlbumTopsView'), receipt = plain(h.controller.getSnapshot().mutation.data);
  h.replaceShell({viewVersion: 2, topRef: ITEM});
  view.props.onFormSaved(receipt);
  h.finishReads(); await h.writing; h.render();
  assert.equal(h.navigations.length, 0);
});

test('delete navigation needs the completed authoritative refresh but no form receipt', async t => {
  const h = await acknowledgementMount(t, 'delete');
  h.render();
  assert.equal(h.controller.getSnapshot().mutation.refreshing, true);
  assert.equal(h.navigations.length, 0);
  h.finishReads(); await h.writing; h.render(); h.render();
  assert.equal(h.controller.getSnapshot().mutation.refreshing, false);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.navigations[0].top_ref, null);
});
