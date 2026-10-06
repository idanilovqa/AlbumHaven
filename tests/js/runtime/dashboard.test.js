const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNativeHomeRuntime, requireOwner, buttonNamed, readRepo,
} = require('./native-home-harness.cjs');

function albumWidget(env, root, key) {
  const element = env.document.createElement('section');
  element.setAttribute('data-native-detail-owner', key);
  const headerHolder = env.document.createElement('div');
  headerHolder.innerHTML = env.context.buildAlbumDetailsHeaderHtml({
    artist: 'Native artist', album: `Native ${key}`, titleId: `${key}-title`, subtitleId: `${key}-subtitle`,
    actionsHtml: env.context.ButtonComponent.renderActionButton({ ariaLabel: `Native ${key} action`, icon: 'more' }),
  });
  const header = headerHolder.firstElementChild;
  const body = env.document.createElement('div');
  body.innerHTML = env.context.buildMissingAlbumDetailsHtml({ albumKey: key, canRemove: false });
  element.append(header, body); root.appendChild(element);
  return { key, element, header, body };
}
function mountDashboard(count = 2) {
  const env = createNativeHomeRuntime({ dashboard: true });
  const owner = requireOwner(env, 'Dashboard');
  const root = env.document.createElement('main');
  env.document.body.appendChild(root);
  const widgets = Array.from({ length: count }, (_, index) => albumWidget(env, root, `album-${index}`));
  const intents = [];
  const dashboard = owner.mount(root, { widgets, onSizeIntent: (...args) => intents.push(args) });
  return { ...env, root, widgets, intents, dashboard };
}
function sizeButton(widget, expanded = false) {
  return buttonNamed(widget.header, expanded ? /widget size/i : /full size/i);
}

// Owned presentation seam, not a route API or a geometry assertion. The same
// attributes are required below as selectors in the component-owned stylesheet.
function assertComposition(env, expandedKey = null) {
  const sole = env.widgets.length === 1;
  assert.equal(env.root.getAttribute('data-dashboard'), 'true', 'one explicit Dashboard owner');
  assert.equal(env.root.getAttribute('data-dashboard-layout'), sole ? 'single' : expandedKey === null ? 'ordinary' : 'expanded');
  assert.equal(env.root.getAttribute('data-dashboard-expanded-key'), expandedKey, 'controlled expanded owner is exact');
  for (const widget of env.widgets) {
    const expected = sole ? 'fill' : expandedKey === null ? 'ordinary' : widget.key === expandedKey ? 'expanded' : 'suppressed';
    assert.equal(widget.element.getAttribute('data-dashboard-widget-state'), expected, `${widget.key}: CSS presentation state`);
  }
}
test('native fixture preserves real Button markup, bubbling and strict unsupported-operation errors', () => {
  const env = createNativeHomeRuntime();
  const root = env.document.createElement('div'); env.document.body.appendChild(root);
  root.innerHTML = env.context.ButtonComponent.renderActionButton({ ariaLabel: 'Play <safe>', icon: 'play', attributes: { 'data-fixture-ref': 'album:a&b' } });
  const button = root.firstElementChild, icon = button.querySelector('path');
  assert.equal(button.getAttribute('aria-label'), 'Play <safe>');
  assert.equal(button.getAttribute('data-fixture-ref'), 'album:a&b');
  assert.equal(icon.closest('button') === button, true, 'nested native glyph resolves its control');
  const attributeStart = env.attributeMutations.length;
  button.dataset.fixtureProof = 'set'; button.removeAttribute('data-fixture-proof');
  assert.deepEqual(env.attributeMutations.slice(attributeStart).map(change => [change.node === button, change.type, change.name, change.value ?? null]),
    [[true, 'set', 'data-fixture-proof', 'set'], [true, 'remove', 'data-fixture-proof', null]], 'attribute observation preserves actual node ownership');
  const calls = [];
  root.addEventListener('click', event => { calls.push('root'); event.stopPropagation(); });
  env.document.body.addEventListener('click', () => calls.push('outer'));
  env.click(icon); assert.deepEqual(calls, ['root']);
  const empty = env.document.createElement('div');
  assert.throws(() => empty.querySelector(':unsupported'), /Unsupported fixture selector/);
  assert.throws(() => { empty.innerHTML = '<section><span></section>'; }, /Unbalanced fixture HTML/);
});

// This is a DOM ownership model: no native browser layout/geometry, keyboard
// default action, accessibility tree or painted acceptance is claimed here.
test('Dashboard keeps supplied native header/body owners and adds native accessible sizing controls', () => {
  const env = mountDashboard();
  for (const widget of env.widgets) {
    assert.equal(widget.element.parentNode === env.root, true, `${widget.key}: widget parent remains root`);
    assert.equal(widget.header.parentNode === widget.element, true, `${widget.key}: native header parent remains stable`);
    assert.equal(widget.body.parentNode === widget.element, true, `${widget.key}: native body parent remains stable`);
    const button = sizeButton(widget);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.classList.contains('action-button'), true, 'native ActionButton owns sizing');
    assert.equal(button.classList.contains('ui-button'), true);
    assert.equal(Boolean(button.getAttribute('aria-label')), true);
    assert.equal(widget.header.querySelectorAll('.album-details-header__primary').length, 1, 'native header content remains');
    assert.equal(widget.body.querySelectorAll('[data-close-track-modal]').length, 1, 'native body content remains');
  }
  assert.deepEqual(env.forbiddenCalls, []);
});

test('Dashboard size actions are controlled intents and distinct from native detail actions', () => {
  const env = mountDashboard();
  const widget = env.widgets[0];
  assertComposition(env);
  let nativeCalls = 0;
  const nativeAction = buttonNamed(widget.header, /native album-0 action/i);
  nativeAction.addEventListener('click', () => { nativeCalls += 1; });
  env.click(nativeAction);
  assert.equal(nativeCalls, 1); assert.deepEqual(env.intents, []);
  const beforeIntent = env.root.innerHTML;
  env.click(sizeButton(widget));
  assert.deepEqual(env.intents, [['album-0', 'album-0']]);
  assert.equal(env.root.innerHTML, beforeIntent, 'intent alone cannot change controlled sizing');
  assertComposition(env);
  env.dashboard.update({ expandedKey: 'album-0' });
  assertComposition(env, 'album-0');
  env.click(sizeButton(widget, true));
  assert.deepEqual(env.intents, [['album-0', 'album-0'], ['album-0', null]]);
  assert.equal(Boolean(sizeButton(widget, true)), true, 'return intent also waits for caller update');
  env.dashboard.update({ expandedKey: null });
  assertComposition(env);
  assert.equal(Boolean(sizeButton(widget)), true);
});

test('Dashboard expand/return never reparents or replaces native bodies and leaves both scroll axes alone', () => {
  const env = mountDashboard();
  const parentPins = env.widgets.map(widget => ({ element: widget.element.parentNode, header: widget.header.parentNode, body: widget.body.parentNode }));
  const bodyHtml = env.widgets.map(widget => widget.body.innerHTML);
  const nativeNodes = env.widgets.map(widget => widget.body.querySelector('[data-close-track-modal]'));
  env.widgets.forEach((widget, index) => { widget.body.scrollTop = 110 + index; widget.body.scrollLeft = 27 + index; });
  const foreground = env.document.createElement('button');
  env.document.body.appendChild(foreground); env.document.activeElement = foreground;
  const firstMutation = env.mutations.length;
  assertComposition(env);
  for (const expandedKey of ['album-0', 'album-1', null, 'album-0', null]) {
    env.dashboard.update({ expandedKey });
    assertComposition(env, expandedKey);
    env.widgets.forEach((widget, index) => {
      assert.equal(widget.element.parentNode === parentPins[index].element, true, `${widget.key}: stable widget parent`);
      assert.equal(widget.header.parentNode === parentPins[index].header, true, `${widget.key}: stable header parent`);
      assert.equal(widget.body.parentNode === parentPins[index].body, true, `${widget.key}: stable body parent`);
      assert.equal(widget.body.querySelector('[data-close-track-modal]') === nativeNodes[index], true, `${widget.key}: native instance retained`);
      assert.equal(widget.body.innerHTML, bodyHtml[index]);
      assert.equal(widget.body.scrollTop, 110 + index); assert.equal(widget.body.scrollLeft, 27 + index);
    });
    assert.equal(env.document.activeElement === foreground, true, 'foreground owner stays untouched in the model');
  }
  const protectedNodes = new Set(env.widgets.flatMap(widget => [widget.element, widget.header, widget.body]));
  assert.equal(env.mutations.slice(firstMutation).filter(change => protectedNodes.has(change.node)).length, 0, 'no temporary reparent-out-and-back workaround');
  assert.deepEqual(env.forbiddenCalls, [], 'no focus, scroll manager, history, transport or scheduler ownership');
});

test('Dashboard with a sole Recent widget fills composition without a redundant sizing action', () => {
  const env = createNativeHomeRuntime({ dashboard: true, home: true });
  const Dashboard = requireOwner(env, 'Dashboard'), HomeRecent = requireOwner(env, 'HomeRecent');
  const root = env.document.createElement('main'), element = env.document.createElement('section');
  env.document.body.appendChild(root); root.appendChild(element);
  const recent = HomeRecent.mount(element, { onSelectAlbum() {}, onOpenAlbum() {}, onPlayAlbum() {}, onRetry() {} });
  const dashboard = Dashboard.mount(root, { widgets: [{ key: 'recent', ...recent }], onSizeIntent() { assert.fail('sole widget cannot request sizing'); } });
  recent.update({ status: 'ready', payload: { recent_local_albums: [], recent_not_local_albums: [] }, selectedAlbumRef: null });
  assert.equal(buttonNamed(recent.header, /full size|widget size/i, false) === null, true, 'sole Recent has no redundant sizing control');
  assertComposition({ root, widgets: [{ key: 'recent', ...recent }] });
  assert.equal(recent.element.parentNode === root, true);
  dashboard.update({ expandedKey: null });
  assert.equal(buttonNamed(recent.header, /full size|widget size/i, false) === null, true, 'sole Recent has no redundant sizing control');
  assertComposition({ root, widgets: [{ key: 'recent', ...recent }] });
  dashboard.dispose(); recent.dispose();
});

test('HomeRecent refresh preserves Dashboard controls and one-way ownership without nesting another Dashboard', () => {
  const env = createNativeHomeRuntime({ dashboard: true, home: true });
  const Dashboard = requireOwner(env, 'Dashboard'), HomeRecent = requireOwner(env, 'HomeRecent');
  const root = env.document.createElement('main'), element = env.document.createElement('section');
  env.document.body.appendChild(root); root.appendChild(element);
  const callbacks = { onSelectAlbum() { assert.fail('size cannot select a row'); }, onOpenAlbum() { assert.fail('size cannot open album'); }, onPlayAlbum() { assert.fail('size cannot play'); }, onRetry() {} };
  const ownerWritesStart = env.attributeMutations.length;
  const recent = HomeRecent.mount(element, callbacks), detail = albumWidget(env, root, 'native-detail');
  assert.equal(env.attributeMutations.slice(ownerWritesStart).some(change => change.name === 'data-dashboard'), false, 'HomeRecent mount creates no Dashboard owner, even temporarily');
  const intents = [], widgets = [{ key: 'recent', ...recent }, detail];
  const dashboard = Dashboard.mount(root, { widgets, onSizeIntent: (...args) => intents.push(args) });
  assertComposition({ root, widgets });
  const control = sizeButton(recent), header = recent.header, body = recent.body;
  const protectedRoots = [element, header, body], parents = protectedRoots.map(node => node.parentNode);
  const firstMutation = env.mutations.length;
  for (const status of ['loading', 'ready', 'error', 'denied', 'ready']) {
    recent.update({ status, payload: { recent_local_albums: [], recent_not_local_albums: [] }, selectedAlbumRef: null });
    assert.equal(recent.header === header, true); assert.equal(recent.body === body, true);
    protectedRoots.forEach((node, index) => assert.equal(node.parentNode === parents[index], true, `${status}: shell root ${index} parent remains stable`));
    assert.equal(sizeButton(recent) === control, true, `${status} cannot rebuild Dashboard's action`);
    assert.equal(root.querySelectorAll('[data-dashboard]').length, 0, `${status}: no nested Dashboard owner`);
    assertComposition({ root, widgets });
  }
  assert.equal(env.mutations.slice(firstMutation).some(change => protectedRoots.includes(change.node)), false, 'status updates never temporarily reparent Home roots');
  env.click(control); assert.deepEqual(intents, [['recent', 'recent']]);
  assert.equal(root.children.length, 2, 'only the two supplied widgets are root children');
  // Check retirement while the application-owned Dashboard is still alive.
  recent.dispose();
  assert.equal(env.attributeMutations.slice(ownerWritesStart).some(change => change.name === 'data-dashboard' && change.node !== root), false, 'Home mount/update/dispose never establishes another Dashboard owner');
  assertComposition({ root, widgets });
  dashboard.dispose();
});

test('Dashboard rejects invalid descriptors and expanded keys before mutating native ownership', () => {
  const env = createNativeHomeRuntime({ dashboard: true });
  const Dashboard = requireOwner(env, 'Dashboard');
  const root = env.document.createElement('main'); env.document.body.appendChild(root);
  const widget = albumWidget(env, root, 'native');
  for (const widgets of [[widget, { ...widget }], [{ ...widget, key: '' }], [{ ...widget, body: env.document.createElement('div') }]]) {
    const before = root.innerHTML;
    assert.throws(() => Dashboard.mount(root, { widgets, onSizeIntent() {} }), { name: 'TypeError' });
    assert.equal(root.innerHTML, before, 'invalid descriptor must not partially modify supplied widgets');
  }
  assert.throws(() => Dashboard.mount(root, { widgets: [widget] }), { name: 'TypeError' }, 'controlled callback is required');
  const dashboard = Dashboard.mount(root, { widgets: [widget], onSizeIntent() {} });
  const before = root.innerHTML;
  assert.throws(() => dashboard.update({ expandedKey: 'unknown-widget' }), { name: 'TypeError' });
  assert.equal(root.innerHTML, before, 'unknown expansion does not blank composition');
});

test('Dashboard dispose restores its own presentation and leaves native actions, attributes and listeners intact', () => {
  const env = createNativeHomeRuntime({ dashboard: true });
  const Dashboard = requireOwner(env, 'Dashboard');
  const root = env.document.createElement('main'); env.document.body.appendChild(root);
  root.className = 'caller-root'; root.setAttribute('aria-label', 'Caller dashboard');
  const widgets = [albumWidget(env, root, 'one'), albumWidget(env, root, 'two')];
  widgets[1].element.hidden = true; widgets[1].element.setAttribute('aria-hidden', 'true');
  let callerEvents = 0;
  const native = buttonNamed(widgets[0].header, /native one action/i);
  const caller = () => { callerEvents += 1; }; native.addEventListener('click', caller);
  const original = root.innerHTML, rootAttributes = root.attributePairs();
  const intents = [];
  const dashboard = Dashboard.mount(root, { widgets, onSizeIntent: (...args) => intents.push(args) });
  const owned = env.listeners().filter(entry => entry.callback !== caller);
  const retired = sizeButton(widgets[0]);
  dashboard.update({ expandedKey: 'one' });
  dashboard.dispose(); dashboard.dispose();
  assert.equal(root.innerHTML, original, 'only Dashboard-owned controls/attributes are restored');
  assert.deepEqual(root.attributePairs(), rootAttributes, 'caller root attributes survive');
  for (const entry of owned) entry.callback.call(entry.target, env.event('click', retired));
  dashboard.update({ expandedKey: 'two' });
  assert.equal(root.innerHTML, original, 'disposed Dashboard is inert');
  assert.deepEqual(intents, []);
  assert.equal(env.listeners().filter(entry => entry.callback !== caller).length, 0);
  env.click(native); assert.equal(callerEvents, 1);
  assert.equal(native.parentNode === widgets[0].header.querySelector('.album-details-header__actions'), true, 'native action retains its owner');
  assert.deepEqual(env.forbiddenCalls, []);
});

test('native runtime declares Dashboard and HomeRecent after their owners and loads the component stylesheet', () => {
  const builder = readRepo('scripts/build-runtime-bundle.cjs');
  const declared = [...builder.matchAll(/^  '(js\/runtime\/[^']+)',$/gm)].map(match => match[1]);
  for (const added of ['js/runtime/dashboard.js', 'js/runtime/home-recent.js']) assert.equal(declared.filter(value => value === added).length, 1, `${added}: one declaration`);
  for (const dependency of ['alert-components', 'album-artbox', 'gallery-main-components', 'gallery-card-component']) {
    assert.equal(declared.includes(`js/runtime/${dependency}.js`), true, `${dependency} is declared`);
    assert.equal(declared.indexOf('js/runtime/home-recent.js') > declared.indexOf(`js/runtime/${dependency}.js`), true, `Recent follows ${dependency}`);
  }
  assert.equal(declared.indexOf('js/runtime/dashboard.js') < declared.indexOf('js/runtime/gallery-refresh-and-status.js'), true, 'Dashboard precedes eventual route consumer');
  const template = readRepo('music_app/templates/index.html');
  const stylesheetLines = template.split(/(?<=\n)/).filter(line => line.includes('css/runtime/dashboard.css'));
  assert.equal(stylesheetLines.length, 1, 'one stylesheet reference');
  assert.match(stylesheetLines[0], /^\s*<link\b[^>]*\brel=["']stylesheet["'][^>]*>\s*$/);
  const css = readRepo('music_app/static/css/runtime/dashboard.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const declarations = selector => rules.filter(([, selectors]) => selectors.split(',').some(value => value.trim().replaceAll("'", '"') === selector)).map(([, , body]) => body).join(' ');
  assert.match(declarations('[data-dashboard]'), /\bdisplay\s*:\s*grid\s*;/, 'Dashboard owns an actual grid composition');
  assert.match(declarations('[data-dashboard-widget-state="suppressed"]'), /\bdisplay\s*:\s*none\s*;/, 'expanded composition removes only suppressed widgets from layout');
  for (const state of ['expanded', 'fill']) {
    const body = declarations(`[data-dashboard-widget-state="${state}"]`);
    assert.match(body, /\bgrid-column\s*:\s*1\s*\/\s*-1\s*;/, `${state} spans the composition width`);
    assert.match(body, /\bgrid-row\s*:\s*1\s*\/\s*-1\s*;/, `${state} spans the composition height`);
  }
});
