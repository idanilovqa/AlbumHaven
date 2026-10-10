const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, buttonNamed} = require('./runtime/native-home-harness.cjs');

let createAlbumTopController, createAlbumTopBackendProviders, AlbumTopsView, componentBundle;
test.before(async () => {
  ({createAlbumTopController} = await import('../../music_app/static/js/album-tops/model.mjs'));
  ({createAlbumTopBackendProviders} = await import('../../music_app/static/js/album-tops/backend-providers.mjs'));
  componentBundle = buildSync({entryPoints: [path.resolve(__dirname, '../../music_app/static/js/album-tops/app.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const loaded = new Module(`${__filename}.fixture.cjs`, module);
  loaded.filename = `${__filename}.fixture.cjs`; loaded.paths = module.paths;
  loaded._compile(componentBundle, loaded.filename); ({AlbumTopsView} = loaded.exports);
});

// Synthetic wire replies exercise the actual private provider, controller and
// native SSR components. They prove neither backend authorization nor browser
// reconciliation, painted geometry, native focus or manual acceptance.
const BROWSE = 'library.browse.read', CREATE = 'library.album_tops.create';
const MANAGE = 'library.album_tops.manage', ITEMS = 'library.album_tops.items.manage';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), ALBUM = id(2), ITEM = id(3), CREATED = id(4);
const SCOPE = 'top-action-projection:actor:library', CONTEXT = 'a'.repeat(64);
const actions = ['can_read', 'can_edit', 'can_rename', 'can_add', 'can_remove', 'can_reorder',
  'can_delete', 'can_share', 'can_view_sharing', 'can_request_edit', 'can_copy'];
const mutations = [
  ['save', 'can_edit', {title: 'Changed', description: 'Authored subtitle'}],
  ['delete', 'can_delete', {}], ['add', 'can_add', {album_refs: [ALBUM]}],
  ['remove', 'can_remove', {item_refs: [ITEM]}], ['reorder', 'can_reorder', {item_order: [ITEM]}],
];
const readableCases = [['owner', 'private'], ['owner', 'server_shared'],
  ['editor', 'private'], ['editor', 'server_shared'], ['viewer', 'server_shared']];
const grants = role => ({[BROWSE]: true, ...(role === 'viewer' ? {} : {[MANAGE]: true, [ITEMS]: true}),
  can_read: true, can_edit: role !== 'viewer', can_rename: role !== 'viewer',
  can_add: role !== 'viewer', can_remove: role !== 'viewer', can_reorder: role !== 'viewer',
  can_delete: role === 'owner', can_share: role === 'owner', can_view_sharing: true,
  can_request_edit: role === 'viewer', can_copy: true});
const resource = (role = 'owner', visibility = 'private', patch = {}) => ({
  top_ref: TOP, title: 'Projected Top', description: 'Server subtitle', revision: '7', visibility,
  allowed_actions: grants(role), items: [], ...patch,
});
const directory = (top = resource(), allowed_actions = {[BROWSE]: true, [CREATE]: true, can_create: true}) =>
  ({tops: [top], allowed_actions, next_cursor: null});
const envelope = data => ({status: 'ready', context_ref: CONTEXT, data});
const denied = status => Object.assign(new Error('Authority revoked'), {status});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
function fixture(t, {top = resource(), list, read, write} = {}) {
  const calls = {reads: [], writes: [], keys: []};
  let currentTop = top;
  const providers = createAlbumTopBackendProviders({acceptsScope: scope => scope === SCOPE,
    transport: {context: () => CONTEXT, async request(route, options) {
      if (options.method === 'POST') {
        const action = route === '/album-tops' ? 'create' : route.split('/').at(-1);
        calls.writes.push({action, route, body: options.body});
        if (write) return write(action, options.body);
        return envelope({top_ref: action === 'create' ? CREATED : TOP, revision: '8', action,
          request_key: options.body.request_key});
      }
      calls.reads.push({route, options});
      if (route.startsWith('/album-tops?')) return list ? list() : envelope(directory(currentTop));
      return read ? read(route) : envelope({...currentTop, top_ref: route.split('/').at(-1)});
    }}});
  const controller = createAlbumTopController({providers, requestKey() {
    const key = id(100 + calls.keys.length); calls.keys.push(key); return key;
  }});
  controller.setScope(SCOPE);
  t.after(() => {controller.dispose(); providers.dispose();});
  return {controller, calls, providers, replace(top) {currentTop = top;},
    async open() {await controller.load(); await controller.open(TOP);},
  };
}
function nativeRuntime() {
  const native = createNativeHomeRuntime(), runtime = {
    buttonHtml: value => native.context.ButtonComponent.renderButton(value),
    actionHtml: value => native.context.ButtonComponent.renderActionButton(value),
    alertHtml: value => native.context.buildOnPageAlertHtml(value),
    galleryCardHtml: value => native.context.buildGalleryCardHtml(value),
    artboxHtml: value => native.context.buildAlbumArtboxHtml(value),
    confirmRetryOriginal: async () => false,
  };
  return {native, runtime};
}
function nativeView(controller) {
  const {native, runtime} = nativeRuntime(), host = native.document.createElement('div');
  host.innerHTML = renderToStaticMarkup(React.createElement(AlbumTopsView,
    {runtime, controller, state: controller.getSnapshot(), onOpen: () => {}}));
  assert.deepEqual(native.forbiddenCalls, []);
  return host;
}
const hasButton = (host, label) => Boolean(buttonNamed(host, new RegExp(`^${label}$`), false));
const assertNoManagement = controller => {
  const host = nativeView(controller);
  assert.equal(hasButton(host, 'Edit Album Top'), false);
  assert.equal(hasButton(host, 'Delete Album Top'), false);
};

test('private and server-shared resources preserve each exact server action, including false', async t => {
  for (const [role, visibility] of readableCases) {
    const top = resource(role, visibility, {owner_account_id: 999, role: 'owner', local_path: '/private/collection'});
    top.allowed_actions['library.media.read'] = true;
    top.allowed_actions['library.files.write'] = true;
    top.allowed_actions.can_invent = true;
    const h = fixture(t, {top}); await h.open();
    const state = h.controller.getSnapshot();
    assert.equal(state.detail.status, 'ready', `${role}: ${visibility}`);
    for (const projection of [state.directory.data.tops[0], state.detail.data]) {
      assert.equal(projection.visibility, visibility);
      for (const action of actions) assert.equal(projection.allowed_actions[action], grants(role)[action], action);
      assert.doesNotMatch(JSON.stringify(projection), /owner_account_id|local_path|"role"|library\.media|library\.files|can_invent/);
    }
  }
});

test('native management controls distinguish Owner, Editor and source Viewer from server projections', async t => {
  for (const [role, visibility] of readableCases) {
    const h = fixture(t, {top: resource(role, visibility)}); await h.open();
    const host = nativeView(h.controller);
    assert.equal(hasButton(host, 'Edit Album Top'), role !== 'viewer', `${role}: edit`);
    assert.equal(hasButton(host, 'Delete Album Top'), role === 'owner', `${role}: delete`);
    if (role !== 'viewer') assert.equal(buttonNamed(host, /^Edit Album Top$/).disabled, false);
    if (role === 'owner') assert.equal(buttonNamed(host, /^Delete Album Top$/).disabled, false);
    // This bounded slice has no Share or playback UI. Server sharing authority
    // is preserved above without inventing a new client control or media grant.
    assert.equal(hasButton(host, 'Share'), false);
  }
});

test('Editor can rename and change membership/order but cannot delete, while source Viewer cannot edit', async t => {
  for (const role of ['owner', 'editor', 'viewer']) for (const [action, permission, data] of mutations) {
    const h = fixture(t, {top: resource(role, 'server_shared')}); await h.open();
    const accepted = await h.controller.mutate(action, data), allowed = grants(role)[permission];
    assert.equal(accepted, allowed, `${role}: ${action}`);
    assert.equal(h.calls.writes.length, allowed ? 1 : 0, `${role}: ${action}`);
    assert.equal(h.calls.keys.length, allowed ? 1 : 0);
    if (allowed) {
      assert.deepEqual(h.calls.writes[0].body, {...data, revision: '7', request_key: id(100)});
      assert.equal(h.calls.writes[0].route, `/album-tops/${TOP}/${action}`);
    }
  }
});

test('coarse management, other actions and role/media hints cannot replace an absent or malformed exact grant', async t => {
  for (const [action, permission, data] of mutations) {
    for (const invalid of [undefined, false, 'true', 1, null, [], new Boolean(true)]) {
      const allowed_actions = {...grants('owner'), [permission]: invalid};
      if (invalid === undefined) delete allowed_actions[permission];
      const h = fixture(t, {top: resource('owner', 'private', {allowed_actions, role: 'owner',
        is_owner: true, can_manage: true, can_play: true})});
      await h.open(); await h.controller.mutate(action, data);
      assert.equal(h.calls.writes.length, 0, `${action}: ${String(invalid)}`);
      assert.equal(h.calls.keys.length, 0);
      if (action === 'save' || action === 'delete') {
        assert.equal(hasButton(nativeView(h.controller), action === 'save' ? 'Edit Album Top' : 'Delete Album Top'), false);
      }
    }
  }
});

test('per-action resource grants are sufficient without inferred coarse management or media capabilities', async t => {
  for (const [action, permission, data] of mutations) {
    const h = fixture(t, {top: resource('owner', 'private', {allowed_actions: {[BROWSE]: true, [permission]: true}})});
    await h.open();
    if (action === 'save' || action === 'delete') {
      const host = nativeView(h.controller);
      assert.equal(hasButton(host, 'Edit Album Top'), action === 'save');
      assert.equal(hasButton(host, 'Delete Album Top'), action === 'delete');
    }
    assert.equal(await h.controller.mutate(action, data), true, action);
    assert.equal(h.calls.writes.length, 1);
  }
});

test('current resource Browse is required even when every mutation projection is true', async t => {
  for (const invalid of [undefined, false, 'true', 1]) {
    const allowed_actions = {...grants('owner'), [BROWSE]: invalid};
    const h = fixture(t, {top: resource('owner', 'private', {allowed_actions})}); await h.open();
    assertNoManagement(h.controller);
    for (const [action, , data] of mutations) await h.controller.mutate(action, data);
    assert.equal(h.calls.writes.length, 0); assert.equal(h.calls.keys.length, 0);
  }
});

test('create requires directory Browse, explicit Create capability and its own Boolean projection', async t => {
  for (const [allowed_actions, allowed] of [
    [{[BROWSE]: true, [CREATE]: true, can_create: true}, true],
    [{[BROWSE]: true, can_create: true}, false], [{[CREATE]: true, can_create: true}, false],
    [{[BROWSE]: true, [CREATE]: 'true', can_create: true}, false],
    ...[undefined, false, 'true', 1, null].map(can_create => [{[BROWSE]: true, [CREATE]: true, can_create}, false]),
    [Object.assign(Object.create({can_create: true}), {[BROWSE]: true, [CREATE]: true}), false],
  ]) {
    const h = fixture(t, {top: resource('viewer', 'server_shared'),
      list: () => envelope(directory(resource('viewer', 'server_shared'), allowed_actions))});
    await h.controller.load();
    assert.equal(hasButton(nativeView(h.controller), 'Create Album Top'), allowed);
    assert.equal(await h.controller.mutate('create', {title: 'My new Top', description: '', album_refs: []}), allowed);
    assert.equal(h.calls.writes.length, allowed ? 1 : 0);
    assert.equal(h.calls.keys.length, allowed ? 1 : 0);
  }
});

test('public metadata or a reply without the matching private context cannot enter the private Top surface', async t => {
  for (const reply of [envelope(resource('owner', 'public')),
    {status: 'ready', data: resource('owner', 'private')},
    {status: 'ready', context_ref: 'b'.repeat(64), data: resource('owner', 'private')}]) {
    const h = fixture(t, {read: () => reply}); await h.open();
    assert.equal(h.controller.getSnapshot().detail.status, 'error');
    assert.equal(h.controller.getSnapshot().detail.data, null); assertNoManagement(h.controller);
    for (const [action, , data] of mutations) await h.controller.mutate(action, data);
    assert.equal(h.calls.writes.length, 0);
  }
});

test('a delayed Editor read cannot restore action authority after a newer source-Viewer projection', async t => {
  const old = deferred(); let read = 0;
  const h = fixture(t, {read: () => ++read === 1 ? old.promise : envelope(resource('viewer', 'server_shared'))});
  await h.controller.load(); const opening = h.controller.open(TOP);
  await h.controller.open(TOP); old.resolve(envelope(resource('editor', 'server_shared'))); await opening;
  assert.equal(h.controller.getSnapshot().detail.status, 'ready'); assertNoManagement(h.controller);
  for (const [action, , data] of mutations) await h.controller.mutate(action, data);
  assert.equal(h.calls.writes.length, 0);
});

test('current read 401/403 clears native actions and a delayed older read cannot restore them', async t => {
  for (const status of [401, 403]) for (const boundary of ['detail', 'directory']) {
    const old = deferred(); let stale = false, revoke = false;
    const h = fixture(t, {
      list: () => {if (revoke && boundary === 'directory') throw denied(status); return envelope(directory());},
      read: () => {if (revoke) throw denied(status); return stale ? old.promise : envelope(resource());},
    });
    await h.open(); stale = true; const opening = h.controller.open(TOP); revoke = true;
    await (boundary === 'detail' ? h.controller.open(TOP) : h.controller.load());
    old.resolve(envelope(resource())); await opening;
    assert.equal(h.controller.getSnapshot().detail.status, 'denied');
    assert.equal(h.controller.getSnapshot().detail.data, null); assertNoManagement(h.controller);
    for (const [action, , data] of mutations) await h.controller.mutate(action, data);
    assert.equal(h.calls.writes.length, 0); assert.equal(h.calls.keys.length, 0);
  }
});

test('an uncertain operation retains its exact key while current denial or revocation blocks replay', async t => {
  for (const revoked of ['flag', 401, 403]) {
    let afterWrite = false;
    const h = fixture(t, {
      read: () => {
        if (afterWrite && typeof revoked === 'number') throw denied(revoked);
        return envelope(resource(afterWrite ? 'viewer' : 'editor', 'server_shared'));
      },
      write: () => {afterWrite = true; throw new TypeError('Connection lost');},
    });
    await h.open(); await h.controller.mutate('save', {title: 'Uncertain original'});
    const original = structuredClone(h.controller.getSnapshot().mutation.command);
    assert.equal(h.controller.getSnapshot().mutation.status, 'uncertain');
    assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), true);
    await h.controller.open(TOP); assertNoManagement(h.controller);
    assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), false);
    assert.equal(await h.controller.retryMutation(), false);
    await h.controller.mutate('delete');
    assert.equal(h.calls.writes.length, 1); assert.equal(h.calls.keys.length, 1);
    assert.deepEqual(h.controller.getSnapshot().mutation.command, original);
    assert.equal(h.controller.getSnapshot().mutation.status, 'uncertain');
  }
});

test('reauthorizing the same resource re-enables only the retained original operation and key', async t => {
  let mode = 'allowed', attempts = 0;
  const h = fixture(t, {
    read: () => {if (mode === 'denied') throw denied(403); return envelope(resource('editor', 'server_shared', {revision: '9'}));},
    write: (action, body) => {
      if (++attempts === 1) throw new TypeError('Response lost');
      return envelope({top_ref: TOP, revision: '10', action, request_key: body.request_key});
    },
  });
  await h.open(); await h.controller.mutate('save', {title: 'Original authored value'});
  const original = structuredClone(h.calls.writes[0].body);
  mode = 'denied'; await h.controller.open(TOP);
  assert.equal(await h.controller.retryMutation(), false); assert.equal(h.calls.writes.length, 1);
  mode = 'allowed'; await h.controller.open(TOP);
  assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), true);
  await h.controller.mutate('save', {title: 'Must not replace unresolved work'});
  assert.equal(h.calls.writes.length, 1);
  assert.equal(await h.controller.retryMutation(), true);
  assert.deepEqual(h.calls.writes.map(write => write.body), [original, original]);
  assert.equal(h.calls.keys.length, 1);
  assert.equal(h.controller.getSnapshot().mutation.status, 'ready');
});

test('uncertain delete still resolves its original receipt after a 404 read of the deleted resource', async t => {
  let deleted = false, attempts = 0;
  const h = fixture(t, {
    read: () => {if (deleted) throw denied(404); return envelope(resource());},
    write: (action, body) => {
      deleted = true;
      if (++attempts === 1) throw new TypeError('Delete acknowledgement lost');
      return envelope({top_ref: TOP, revision: '8', action, request_key: body.request_key});
    },
  });
  await h.open(); await h.controller.mutate('delete');
  const original = structuredClone(h.calls.writes[0].body);
  await h.controller.open(TOP);
  assert.equal(h.controller.getSnapshot().detail.status, 'error'); assertNoManagement(h.controller);
  assert.equal(await h.controller.retryMutation(), true);
  assert.deepEqual(h.calls.writes.map(write => write.body), [original, original]);
  assert.equal(h.calls.keys.length, 1);
  assert.equal(h.controller.getSnapshot().mutation.status, 'ready');
  assert.equal(h.controller.getSnapshot().selectedTopRef, TOP, 'receipt must not override subsequent navigation');
});

test('unrelated navigation and temporary read failures do not become evidence to reject an uncertain retry', async t => {
  for (const boundary of ['directory-navigation', 'other-resource', 'network-error', 'loading']) {
    const pending = deferred(); let mode = 'initial', attempts = 0;
    const h = fixture(t, {
      read: route => {
        if (route.endsWith(CREATED)) return envelope(resource('viewer', 'server_shared', {top_ref: CREATED}));
        if (mode === 'network-error') throw new TypeError('Read failed');
        if (mode === 'loading') return pending.promise;
        return envelope(resource('editor', 'server_shared'));
      },
      write: (action, body) => {
        if (++attempts === 1) throw new TypeError('Write response lost');
        return envelope({top_ref: TOP, revision: '8', action, request_key: body.request_key});
      },
    });
    await h.open(); await h.controller.mutate('save', {title: 'Retry this exact change'});
    const original = structuredClone(h.calls.writes[0].body);
    let reading;
    if (boundary === 'directory-navigation') await h.controller.open(null);
    else if (boundary === 'other-resource') await h.controller.open(CREATED);
    else {mode = boundary; reading = h.controller.open(TOP); if (boundary !== 'loading') await reading;}
    assert.equal(await h.controller.retryMutation(), true, boundary);
    if (reading && boundary === 'loading') {pending.resolve(envelope(resource('editor', 'server_shared'))); await reading;}
    assert.deepEqual(h.calls.writes.map(write => write.body), [original, original]);
    assert.equal(h.calls.keys.length, 1);
  }
});

test('scope replacement retires a blocked uncertain operation instead of replaying another actor’s key', async t => {
  let revoke = false;
  const h = fixture(t, {read: () => {if (revoke) throw denied(403); return envelope(resource());},
    write: () => {throw new TypeError('Response lost');}});
  await h.open(); await h.controller.mutate('save', {title: 'Private original'});
  revoke = true; await h.controller.open(TOP);
  assert.equal(h.controller.getSnapshot().mutation.status, 'uncertain');
  h.controller.setScope('top-action-projection:other-actor:library');
  assert.equal(await h.controller.retryMutation(), false);
  assert.equal(h.controller.getSnapshot().mutation.command, null);
  assert.equal(h.controller.getSnapshot().detail.data, null);
  assert.equal(h.calls.writes.length, 1);
});

const elements = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(node => node.type?.name === name);
const button = (tree, label) => elements(tree).find(node => node.type?.name === 'Button' && node.props.children === label);
const input = (tree, name) => elements(tree).find(node => node.type === 'input' && node.props.name === name);
// Match the existing Top hook-lifecycle fixture: separate component lifetimes,
// actual component handlers/effects, without claiming React DOM reconciliation.
function componentDriver(t) {
  const fibers = new Map(); let current;
  const effect = (callback, deps) => {
    const fiber = current, index = fiber.cursor++, old = fiber.slots[index];
    if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps[at]))) {
      fiber.effects.push(() => {old?.cleanup?.(); fiber.slots[index] = {deps, cleanup: callback()};});
    }
  };
  const hooks = {...React,
    useState(value) {
      const fiber = current, index = fiber.cursor++;
      const slot = fiber.slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slot.value, next => {slot.value = typeof next === 'function' ? next(slot.value) : next;}];
    },
    useRef(value) {return current.slots[current.cursor++] ||= {current: value};},
    useEffect: effect, useLayoutEffect: effect,
  };
  const module = {exports: {}};
  vm.runInNewContext(componentBundle, {module, exports: module.exports, console, require(name) {
    if (name === 'react') return hooks;
    if (name === 'react-dom') return {createPortal: children => children};
    assert.fail(`Unexpected component dependency: ${name}`);
  }});
  t.after(() => {for (const fiber of fibers.values()) for (const slot of fiber.slots) slot?.cleanup?.();});
  return {View: module.exports.AlbumTopsView, render(key, Component, props) {
    const fiber = fibers.get(key) || {slots: []}; fibers.set(key, fiber);
    fiber.cursor = 0; fiber.effects = []; current = fiber;
    let tree;
    try {tree = Component(props);} finally {current = null;}
    for (const run of fiber.effects) run();
    return tree;
  }};
}

test('same-revision Editor revocation disables the retained draft and stale submit callback without discarding text', async t => {
  for (const permission of ['can_edit', BROWSE]) {
    const h = fixture(t, {top: resource('editor', 'server_shared')}); await h.open();
    let attempted = 0;
    const mutate = h.controller.mutate;
    h.controller.mutate = (...args) => {attempted++; return mutate(...args);};
    const driver = componentDriver(t), {runtime} = nativeRuntime(); runtime.confirm = async () => false;
    const view = () => driver.render('view', driver.View,
      {runtime, controller: h.controller, state: h.controller.getSnapshot(), onOpen: () => {}});
    button(view(), 'Edit Album Top').props.onClick();
    const form = () => {
      const fields = component(view(), 'TopFields'); assert.ok(fields, 'the draft remains mounted');
      return driver.render('fields', fields.type, fields.props).props.children(() => false);
    };
    input(form(), 'top-name').props.onChange({target: {value: 'My unsaved title'}});
    input(form(), 'top-subtitle').props.onChange({target: {value: 'My unsaved subtitle'}});
    const prior = form(); assert.equal(button(prior, 'Save').props.disabled, false);
    h.replace(resource('editor', 'server_shared', {allowed_actions: {...grants('editor'), [permission]: false}}));
    await h.controller.open(TOP);
    await prior.props.onSubmit({preventDefault() {}});
    assert.equal(attempted, 0, 'the component rechecks authority before asking the controller to write');
    assert.equal(h.calls.writes.length, 0, 'a retained callback must not submit with stale authority');
    const revoked = form();
    assert.equal(input(revoked, 'top-name').props.value, 'My unsaved title');
    assert.equal(input(revoked, 'top-subtitle').props.value, 'My unsaved subtitle');
    assert.equal(input(revoked, 'top-name').props.disabled, true);
    assert.equal(input(revoked, 'top-subtitle').props.disabled, true);
    assert.equal(button(revoked, 'Save').props.disabled, true);
    assert.equal(button(revoked, 'Cancel').props.disabled, false);
    await revoked.props.onSubmit({preventDefault() {}}); assert.equal(h.calls.writes.length, 0);
    assert.equal(attempted, 0);
    h.replace(resource('editor', 'server_shared')); await h.controller.open(TOP);
    const restored = form(); assert.equal(input(restored, 'top-name').props.value, 'My unsaved title');
    assert.equal(button(restored, 'Save').props.disabled, false);
  }
});

test('an older pending directory grant cannot erase newer same-resource retry revocation', async t => {
  const oldList = deferred(); let mode = 'initial';
  const h = fixture(t, {
    list: () => mode === 'pending-list' ? oldList.promise : envelope(directory(resource('editor', 'server_shared'))),
    read: () => envelope(resource(mode === 'revoked' ? 'viewer' : 'editor', 'server_shared')),
    write: () => {throw new TypeError('Write response lost');},
  });
  await h.open(); await h.controller.mutate('save', {title: 'Uncertain change'});
  const original = structuredClone(h.controller.getSnapshot().mutation.command);
  mode = 'pending-list'; const listing = h.controller.load();
  mode = 'revoked'; await h.controller.open(TOP);
  assert.equal(h.controller.canRetryMutation(), false);
  oldList.resolve(envelope(directory(resource('editor', 'server_shared')))); await listing;
  assert.equal(h.controller.canRetryMutation(), false);
  assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), false);
  await h.controller.retryMutation();
  assert.equal(h.calls.writes.length, 1);
  assert.deepEqual(h.controller.getSnapshot().mutation.command, original);
});

test('authoritative directory denial blocks uncertain Create until its exact projection is restored', async t => {
  let canCreate = true, attempts = 0;
  const h = fixture(t, {
    list: () => envelope(directory(resource(), {[BROWSE]: true, [CREATE]: true, can_create: canCreate})),
    write: (action, body) => {
      if (++attempts === 1) throw new TypeError('Create acknowledgement lost');
      return envelope({top_ref: CREATED, revision: '1', action, request_key: body.request_key});
    },
  });
  await h.controller.load();
  await h.controller.mutate('create', {title: 'Private new Top', description: '', album_refs: []});
  const original = structuredClone(h.calls.writes[0].body);
  canCreate = false; await h.controller.load();
  assert.equal(h.controller.canRetryMutation(), false);
  assert.equal(hasButton(nativeView(h.controller), 'Create Album Top'), false);
  assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), false);
  assert.equal(await h.controller.retryMutation(), false); assert.equal(h.calls.writes.length, 1);
  canCreate = true; await h.controller.load();
  assert.equal(h.controller.canRetryMutation(), true);
  assert.equal(await h.controller.retryMutation(), true);
  assert.deepEqual(h.calls.writes.map(write => write.body), [original, original]);
  assert.equal(h.calls.keys.length, 1);
});

test('newer unknown directory evidence cannot outvote a still-current detail denial during uncertain recovery', async t => {
  for (const projection of ['absent-resource', 'missing-actions', 'malformed-actions']) {
    const detailReply = deferred(), directoryReply = deferred(); let mode = 'initial', attempts = 0;
    const h = fixture(t, {
      list: () => mode === 'overlap' ? directoryReply.promise : envelope(directory(resource('editor', 'server_shared'))),
      read: () => mode === 'overlap' ? detailReply.promise
        : envelope(resource('editor', 'server_shared', {revision: mode === 'reauthorized' ? '9' : '7'})),
      write: (action, body) => {
        if (++attempts === 1) throw new TypeError('Save acknowledgement lost');
        return envelope({top_ref: TOP, revision: '10', action, request_key: body.request_key});
      },
    });
    await h.open(); await h.controller.mutate('save', {title: 'Preserve this original save'});
    const originalBody = structuredClone(h.calls.writes[0].body);
    const originalCommand = structuredClone(h.controller.getSnapshot().mutation.command);
    assert.equal(h.controller.canRetryMutation(), true);
    mode = 'overlap';
    const reading = h.controller.open(TOP); // The still-current detail read starts first.
    const listing = h.controller.load(); // A newer directory read has no action evidence.
    const unknown = directory(resource('editor', 'server_shared', {allowed_actions:
      projection === 'missing-actions' ? {} : {[BROWSE]: true, can_edit: 'true'}}));
    if (projection === 'absent-resource') unknown.tops = [];
    directoryReply.resolve(envelope(unknown)); await listing;
    assert.equal(h.controller.getSnapshot().detail.status, 'loading');
    detailReply.reject(denied(403)); await reading;
    assert.equal(h.controller.getSnapshot().detail.status, 'denied', projection);
    assert.equal(h.controller.getSnapshot().detail.data, null);
    assert.equal(h.controller.canRetryMutation(), false, `${projection}: consumed denial blocks replay`);
    assertNoManagement(h.controller);
    assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), false);
    assert.equal(await h.controller.retryMutation(), false);
    assert.equal(h.calls.writes.length, 1); assert.equal(h.calls.keys.length, 1);
    assert.deepEqual(h.controller.getSnapshot().mutation.command, originalCommand);
    assert.equal(h.controller.getSnapshot().mutation.status, 'uncertain');
    mode = 'reauthorized'; await h.controller.open(TOP);
    assert.equal(h.controller.getSnapshot().detail.data.revision, '9');
    assert.equal(h.controller.canRetryMutation(), true);
    assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), true);
    assert.equal(await h.controller.retryMutation(), true);
    assert.deepEqual(h.calls.writes.map(write => write.body), [originalBody, originalBody]);
    assert.equal(h.calls.keys.length, 1, 'reauthorization must not replace the original operation');
    assert.equal(h.controller.getSnapshot().mutation.status, 'ready');
  }
});

test('consumed source denial blocks overlapping grants until a newly started read reauthorizes the exact operation', async t => {
  for (const order of ['allow-before-denial', 'allow-after-denial']) for (const denial of [403, 'explicit-false']) {
    const detailReply = deferred(), directoryReply = deferred(); let mode = 'initial', attempts = 0;
    const h = fixture(t, {
      list: () => mode === 'overlap' ? directoryReply.promise : envelope(directory(resource('editor', 'server_shared'))),
      read: () => mode === 'overlap' ? detailReply.promise
        : envelope(resource('editor', 'server_shared', {revision: mode === 'reauthorized' ? '9' : '7'})),
      write: (action, body) => {
        if (++attempts === 1) throw new TypeError('Save acknowledgement lost');
        return envelope({top_ref: TOP, revision: '10', action, request_key: body.request_key});
      },
    });
    await h.open(); await h.controller.mutate('save', {title: 'Original operation across denial'});
    const originalBody = structuredClone(h.calls.writes[0].body);
    const originalCommand = structuredClone(h.controller.getSnapshot().mutation.command);
    mode = 'overlap';
    const reading = h.controller.open(TOP);
    const listing = h.controller.load(); // Both requests began before denial was observed.
    const allowDirectory = async () => {
      directoryReply.resolve(envelope(directory(resource('editor', 'server_shared')))); await listing;
      assert.equal(h.controller.getSnapshot().directory.data.tops[0].allowed_actions.can_edit, true);
    };
    if (order === 'allow-before-denial') {
      await allowDirectory(); assert.equal(h.controller.canRetryMutation(), true);
    }
    if (denial === 403) detailReply.reject(denied(403));
    else detailReply.resolve(envelope(resource('viewer', 'server_shared')));
    await reading;
    assert.equal(h.controller.getSnapshot().detail.status, denial === 403 ? 'denied' : 'ready');
    assertNoManagement(h.controller);
    assert.equal(h.controller.canRetryMutation(), false, `${order}/${denial}: the accepted denial must block`);
    if (order === 'allow-after-denial') await allowDirectory();
    assert.equal(h.controller.canRetryMutation(), false, `${order}/${denial}: pre-denial grant cannot recover`);
    assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), false);
    assert.equal(await h.controller.retryMutation(), false);
    assert.equal(h.calls.writes.length, 1); assert.equal(h.calls.keys.length, 1);
    assert.deepEqual(h.controller.getSnapshot().mutation.command, originalCommand);
    assert.equal(h.controller.getSnapshot().mutation.status, 'uncertain');
    mode = 'reauthorized'; await h.controller.open(TOP);
    assert.equal(h.controller.getSnapshot().detail.data.revision, '9');
    assert.equal(h.controller.canRetryMutation(), true);
    assert.equal(hasButton(nativeView(h.controller), 'Retry original request'), true);
    assert.equal(await h.controller.retryMutation(), true);
    assert.deepEqual(h.calls.writes.map(write => write.body), [originalBody, originalBody]);
    assert.equal(h.calls.keys.length, 1);
    assert.equal(h.controller.getSnapshot().mutation.status, 'ready');
  }
});
