const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
const controls = () => import('../../../music_app/static/js/home-friends/native-controls.mjs');
const dialogs = () => import('../../../music_app/static/js/home-friends/native-dialog.mjs');
function fixture() {
  const env = withDomPlatform(createNativeHomeRuntime()), {context, document} = env;
  // This additive fixture supplies focus; the protected native harness is intact.
  context.Element.prototype.focus = function () {document.activeElement = this;};
  const host = document.createElement('section'); document.body.append(host);
  const buttons = context.ButtonComponent;
  return {...env, host, runtime: {buttonHtml: buttons.renderButton, actionHtml: buttons.renderActionButton,
    alertHtml: env.owner('buildOnPageAlertHtml'), iconHtml: buttons.renderIconSvg}};
}

test('native button keeps the focused node and invokes only current enabled callback', async () => {
  const {mountButton} = await controls(), {host, runtime, click, document, context} = fixture();
  const called = [], owner = mountButton(host, runtime, {label: 'Save', onClick: () => called.push('old')});
  const button = host.firstElementChild; button.focus();
  owner.update({label: 'Save changes', selected: true, onClick: () => called.push('new')});
  assert.equal(host.firstElementChild, button); assert.equal(document.activeElement, button);
  click(button); assert.deepEqual(called, ['new']); assert.equal(button.getAttribute('aria-pressed'), 'true');
  owner.update({label: 'Save', disabled: true, onClick: () => called.push('disabled')});
  button.dispatchEvent(new context.Event('click')); assert.deepEqual(called, ['new']);
  assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-disabled'), 'true');
  owner.dispose(); owner.dispose(); button.dispatchEvent(new context.Event('click')); assert.deepEqual(called, ['new']);
});

test('native tabs delegate keyboard selection and preserve keyed focus through update', async () => {
  const {mountTabs} = await controls(), env = fixture(), {host, runtime, context, document} = env;
  vm.runInContext(readRepo('music_app/static/js/runtime/in-page-tabs.js'), context);
  runtime.tabsHtml = env.owner('buildInPageTabsHtml'); runtime.mountTabs = env.owner('mountInPageTabs');
  const values = [], props = {id: 'native-tabs', label: 'Source', items: [['a', 'A'], ['b', 'B']], value: 'a', onChange: key => values.push(key)};
  const owner = mountTabs(host, runtime, props), a = host.querySelector('[data-in-page-tab="a"]');
  a.focus(); a.dispatchEvent(new context.Event('keydown', {key: 'ArrowRight'}));
  assert.deepEqual(values, ['b']); assert.equal(document.activeElement.dataset.inPageTab, 'b');
  owner.update({...props, value: 'b'}); assert.equal(document.activeElement.dataset.inPageTab, 'b');
  owner.dispose(); assert.equal(host.childNodes.length, 0);
});

test('choice retires changed permission menus and stale callbacks cannot activate', async () => {
  const {mountChoice} = await controls(), env = fixture(), calls = [], opens = [], closes = [];
  env.runtime.openChoice = (trigger, config) => {opens.push(config); return {isOpen: true, close: options => closes.push(options)};};
  const props = {label: 'View', value: 'cards', options: [['cards', 'Cards'], ['list', 'List']], onChange: value => calls.push(value)};
  const owner = mountChoice(env.host, env.runtime, props), button = env.host.querySelector('button');
  env.click(button); assert.equal(opens.length, 1);
  owner.update({...props, disabled: true}); assert.equal(env.host.querySelector('button'), button);
  opens[0].onSelect('list'); assert.deepEqual(calls, []); assert.deepEqual(closes, [{restoreFocus: false}]);
  owner.dispose(); opens[0].onSelect('cards'); assert.deepEqual(calls, []);
});

test('choice callback-only update preserves the open native menu and uses latest callback', async () => {
  const {mountChoice} = await controls(), env = fixture(), calls = []; let select, closed = 0;
  env.runtime.openChoice = (_trigger, config) => {select = config.onSelect; return {isOpen: true, close: () => closed++};};
  const props = {label: 'View', value: 'cards', options: [['cards', 'Cards'], ['list', 'List']], onChange: () => calls.push('old')};
  const owner = mountChoice(env.host, env.runtime, props); env.click(env.host.querySelector('button'));
  owner.update({...props, onChange: value => calls.push(value)}); select('list');
  assert.equal(closed, 0); assert.deepEqual(calls, ['list']); owner.dispose(); assert.equal(closed, 1);
});

test('status retires retry activation when loading replaces an error', async () => {
  const {mountStatus} = await controls(), env = fixture(); let retries = 0;
  const owner = mountStatus(env.host, env.runtime, {value: {status: 'error'}, label: 'albums', retry: () => retries++});
  const button = env.host.querySelector('button'); env.click(button); assert.equal(retries, 1);
  owner.update({value: {status: 'loading'}, label: 'albums'}); env.click(button); assert.equal(retries, 1);
  assert.equal(env.host.getAttribute('aria-busy'), 'true'); owner.dispose();
});

test('dialog delegates presentation and dismiss gates without remounting content', async () => {
  const {openNativeDialog} = await dialogs(), env = fixture(), presentations = [], gates = []; let native, mounted = 0, childDisposed = 0, result;
  const runtime = {openForm(options) {native = options; options.onMount(env.host); return {
    updatePresentation: value => presentations.push(value), setDismissDisabled: value => gates.push(value),
    close(_host, options) {native.onClose(env.host, options);},
  };}};
  const owner = openNativeDialog(runtime, {title: 'Edit', pageId: 'editor'}, {mount() {mounted++; return {dispose() {childDisposed++;}};}, onClose: value => {result = value;}});
  owner.update({title: 'Save', pageId: 'editor', dismissDisabled: true});
  assert.equal(mounted, 1); assert.deepEqual(presentations, [{title: 'Save', pageId: 'editor'}]); assert.deepEqual(gates, [true]);
  owner.close({restoreFocus: false}); assert.equal(childDisposed, 1); assert.equal(result.restoreFocusRequested, false);
  owner.dispose(); assert.equal(childDisposed, 1);
});

test('dialog disposal suppresses close callback and tears native owner down before children', async () => {
  const {openNativeDialog} = await dialogs(), env = fixture(), events = []; let native;
  const runtime = {openForm(options) {native = options; options.onMount(env.host); return {close(_host, options) {events.push(['native', options]); native.onClose(env.host, options);}};}};
  const owner = openNativeDialog(runtime, {title: 'Edit'}, {mount: () => ({dispose: () => events.push(['child'])}), onClose: () => events.push(['callback'])});
  owner.dispose(); owner.dispose();
  assert.deepEqual(events, [['native', {force: true, restoreFocus: false, returnToParent: false}], ['child']]);
});

test('shared header retains independent ordered slots and removes global lifecycle listeners', async () => {
  const {mountSharedHeader} = await import('../../../music_app/static/js/home-friends/shared-header.mjs');
  const env = fixture(), {document, context, host, runtime} = env, frames = new Map(), events = []; let frame = 0, disconnected = 0;
  const win = {innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({display: 'block', columnGap: '8'}),
    requestAnimationFrame: callback => {frames.set(++frame, callback); return frame;}, cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, callback, capture = false) => events.push({name, callback, capture}), removeEventListener: (name, callback, capture = false) => {const index = events.findIndex(entry => entry.name === name && entry.callback === callback && entry.capture === capture); if (index >= 0) events.splice(index, 1);},
    MutationObserver: class {observe() {} disconnect() {disconnected++;}}, ResizeObserver: class {observe() {} disconnect() {disconnected++;}}};
  document.defaultView = win;
  const owner = mountSharedHeader(host, runtime, {id: 'top-header', ariaLabel: 'Top'});
  const action = document.createElement('button'), final = document.createElement('button'); action.textContent = 'Save'; final.textContent = 'Cancel';
  owner.slots.actions.append(action); owner.slots.finalAction.append(final);
  owner.update({id: 'top-header', ariaLabel: 'Top edited'});
  assert.equal(owner.slots.actions.firstElementChild, action); assert.equal(owner.slots.finalAction.firstElementChild, final);
  assert.ok(owner.element.querySelectorAll('button').indexOf(action) < owner.element.querySelectorAll('button').indexOf(final));
  owner.slots.actions.replaceChildren(); assert.equal(owner.slots.finalAction.firstElementChild, final);
  owner.dispose(); assert.equal(events.length, 0); assert.equal(disconnected, 2); assert.equal(frames.size, 0);
  assert.equal(document.listeners.filter(entry => ['pointerdown', 'keydown'].includes(entry.type)).length, 0);
});

test('dialog closes synchronously during mount and disposes the subsequently returned child once', async () => {
  const {openNativeDialog} = await dialogs(), env = fixture(), events = []; let native;
  const nativeClose = (_value, options) => {events.push('native-close'); native.onClose(env.host, options);};
  const runtime = {openForm(options) {native = options; options.onMount(env.host, nativeClose); return {close: nativeClose};}};
  const owner = openNativeDialog(runtime, {title: 'Edit'}, {mount(_host, close) {close({restoreFocus: false}); events.push('factory-return'); return {dispose: () => events.push('dispose-child')};}, onClose: () => events.push('closed')});
  assert.deepEqual(events, ['native-close', 'factory-return', 'dispose-child', 'closed']);
  assert.equal(owner.closed, true); assert.equal(owner.element, null); owner.dispose(); assert.equal(events.filter(value => value === 'dispose-child').length, 1);
});

test('native retirement during factory construction disposes its late returned child', async () => {
  const {openNativeDialog} = await dialogs(), env = fixture(); let native, count = 0;
  const runtime = {openForm(options) {native = options; options.onMount(env.host, () => {}); return {close() {}};}};
  const owner = openNativeDialog(runtime, {title: 'Edit'}, {mount() {native.onClose(env.host, {current: false}); return {dispose() {count++;}};}});
  assert.equal(count, 1); assert.equal(owner.closed, true); owner.dispose(); assert.equal(count, 1);
});

test('dialog mount throw retires native owner and renders fallback only in supplied host', async () => {
  const {openNativeDialog} = await dialogs(), env = fixture(), events = []; let native;
  const nativeClose = (_value, options) => {events.push(options); native.onClose(env.host, options);};
  const runtime = {...env.runtime, openForm(options) {native = options; options.onMount(env.host, nativeClose); return {close: nativeClose};}};
  let error, closes = 0;
  const owner = openNativeDialog(runtime, {title: 'Edit'}, {mount() {throw new Error('mount failed');}, fallbackHost: env.host, onError: value => {error = value;}, onClose: () => closes++});
  assert.equal(owner.failed, true); assert.equal(owner.element, null); assert.match(error.message, /mount failed/);
  assert.deepEqual(events, [{force: true, restoreFocus: false, returnToParent: false}]); assert.match(env.host.textContent, /not available/);
  env.click(env.host.querySelector('button')); assert.equal(closes, 1); assert.equal(env.host.childNodes.length, 0); owner.dispose();
});

test('null native owner reports explicit failed outcome and supports safe update and close', async () => {
  const {openNativeDialog} = await dialogs(); let error, closes = 0;
  const owner = openNativeDialog({openForm: () => null}, {title: 'Edit'}, {onError: value => {error = value;}, onClose: () => closes++});
  assert.equal(owner.failed, true); assert.equal(owner.element, null); assert.ok(error);
  owner.update({title: 'Changed'}); owner.close(); owner.close(); owner.dispose(); assert.equal(closes, 1);
});

for (const action of ['dispose', 'update']) test(`choice releases owner returned after synchronous open focus ${action}`, async () => {
  const {mountChoice} = await controls(), env = fixture(); let owner, closes = 0;
  const props = {label: 'View', value: 'cards', options: [['cards', 'Cards'], ['list', 'List']]};
  env.runtime.openChoice = () => {
    if (action === 'dispose') owner.dispose(); else owner.update({...props, disabled: true});
    return {close(options) {assert.equal(options.restoreFocus, false); closes++;}};
  };
  owner = mountChoice(env.host, env.runtime, props); env.click(env.host.querySelector('button'));
  assert.equal(closes, 1);
  if (action === 'dispose') assert.equal(env.host.childNodes.length, 0); else assert.equal(env.host.querySelector('button').disabled, true);
  owner.dispose(); assert.equal(closes, 1);
});

for (const action of ['dispose', 'update']) test(`choice close focus ${action} cannot be overwritten by stale outer update`, async () => {
  const {mountChoice} = await controls(), env = fixture(); let owner;
  const props = {label: 'View', value: 'cards', options: [['cards', 'Cards'], ['list', 'List']]};
  env.runtime.openChoice = () => ({close(options) {
    if (options.restoreFocus) {if (action === 'dispose') owner.dispose(); else owner.update({...props, disabled: true, value: 'cards'});}
  }});
  owner = mountChoice(env.host, env.runtime, props); env.click(env.host.querySelector('button'));
  owner.update({...props, value: 'list'});
  if (action === 'dispose') assert.equal(env.host.childNodes.length, 0);
  else {assert.equal(env.host.querySelector('button').disabled, true); assert.match(env.host.querySelector('button').getAttribute('aria-label'), /Cards/);}
  owner.dispose();
});

test('recent owner installs region semantics and suppresses late intent failures and retired actions', async () => {
  const {mountRecentAlbums} = await controls(), env = fixture(); let callbacks, reject, intents = 0, errors = 0, disposed = 0; const updates = [];
  env.runtime.mountRecent = (_host, next) => {callbacks = next; return {update: value => updates.push(value), dispose: () => disposed++};};
  env.runtime.albumIntent = () => {intents++; return new Promise((_resolve, fail) => {reject = fail;});};
  const owner = mountRecentAlbums(env.host, env.runtime, {value: {status: 'empty'}, onError: () => errors++});
  assert.equal(env.host.getAttribute('aria-label'), 'Recent albums'); assert.equal(updates[0].status, 'ready');
  const pending = callbacks.onPlayAlbum('a'); owner.dispose(); reject(new Error('late')); await pending;
  await callbacks.onPlayAlbum('b'); assert.equal(errors, 0); assert.equal(intents, 1); assert.equal(disposed, 1);
});

function measuredHeaderFixture() {
  const env = fixture(), {document, context} = env, frames = new Map(), listeners = [], observers = []; let frame = 0;
  const win = {innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({display: 'block', columnGap: '8'}),
    requestAnimationFrame(callback) {frames.set(++frame, callback); return frame;}, cancelAnimationFrame: id => frames.delete(id),
    addEventListener(type, callback, capture = false) {listeners.push({type, callback, capture});},
    removeEventListener(type, callback, capture = false) {const index = listeners.findIndex(entry => entry.type === type && entry.callback === callback && entry.capture === capture); if (index >= 0) listeners.splice(index, 1);},
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.retired = true;}},
    ResizeObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.retired = true;}}};
  document.defaultView = win; document.documentElement.clientWidth = 1000;
  context.Element.prototype.focus = function () {document.activeElement = this; this.dispatchEvent(new context.Event('focusin'));};
  const geometry = (owner, width) => {
    for (const node of [document.body, ...document.querySelectorAll('*')]) {
      node.scrollWidth = 0; node.scrollHeight = 0; node.offsetHeight = 0; node.clientHeight = 0;
      env.setRect(node, {width: 0, height: 0});
    }
    env.setRect(owner.element, {x: 10, y: 50, width, height: 40});
    env.setRect(owner.slots.identity, {width: 100, height: 20});
    for (const button of owner.element.querySelectorAll('button')) env.setRect(button, {width: 80, height: 34});
    env.setRect(owner.element.querySelector('.home-header__tools'), {width: 34, height: 34});
    owner.refresh();
  };
  const flush = () => {for (const [id, callback] of [...frames]) {frames.delete(id); callback();}};
  return {...env, listeners, observers, frames, geometry, flush};
}

test('measured header moves focus before concealment and restores inline focus without replacing children', async () => {
  const {mountSharedHeader} = await import('../../../music_app/static/js/home-friends/shared-header.mjs'), env = measuredHeaderFixture();
  const owner = mountSharedHeader(env.host, env.runtime, {id: 'measured'}), action = env.document.createElement('button'); action.textContent = 'Save'; owner.slots.actions.append(action);
  env.geometry(owner, 500); env.flush(); action.focus();
  const tools = owner.element.querySelector('[data-header-tools]'); let concealedDuringFocus;
  tools.addEventListener('focusin', () => {concealedDuringFocus = action.closest('[inert]') !== null;});
  env.geometry(owner, 150); env.flush();
  assert.equal(owner.element.getAttribute('data-header-compact'), 'true'); assert.equal(env.document.activeElement, tools);
  assert.equal(concealedDuringFocus, false); assert.ok(action.closest('[inert]'));
  env.geometry(owner, 500); env.flush(); assert.equal(env.document.activeElement, action); assert.equal(action.closest('[inert]'), null);
  assert.equal(owner.slots.actions.firstElementChild, action); owner.dispose();
  assert.equal(env.listeners.length, 0); assert.ok(env.observers.every(observer => observer.retired)); assert.equal(env.frames.size, 0);
});

test('measured header focus reentry disposal prevents resumed layout mutations and clears owners', async () => {
  const {mountSharedHeader} = await import('../../../music_app/static/js/home-friends/shared-header.mjs'), env = measuredHeaderFixture();
  const owner = mountSharedHeader(env.host, env.runtime, {id: 'focus-retire'}), action = env.document.createElement('button'); owner.slots.actions.append(action);
  env.geometry(owner, 500); env.flush(); action.focus();
  owner.element.querySelector('[data-header-tools]').addEventListener('focusin', () => owner.dispose());
  env.geometry(owner, 150); env.flush();
  assert.equal(env.host.childNodes.length, 0); assert.equal(env.listeners.length, 0); assert.equal(env.frames.size, 0);
});

test('measured header keeps child-menu Escape and dismisses its own capsule on outside pointer', async () => {
  const {mountSharedHeader} = await import('../../../music_app/static/js/home-friends/shared-header.mjs'), env = measuredHeaderFixture();
  const owner = mountSharedHeader(env.host, env.runtime, {id: 'menus'}), action = env.document.createElement('button'); owner.slots.actions.append(action);
  env.geometry(owner, 150); env.flush(); env.click(owner.element.querySelector('[data-header-tools]')); env.flush();
  assert.equal(owner.element.getAttribute('data-header-open'), 'true');
  action.setAttribute('aria-expanded', 'true'); const menu = env.document.createElement('div'); menu.setAttribute('role', 'menu'); env.document.body.append(menu);
  menu.dispatchEvent(new env.context.Event('keydown', {key: 'Escape'})); assert.equal(owner.element.getAttribute('data-header-open'), 'true');
  action.setAttribute('aria-expanded', 'false'); env.document.body.dispatchEvent(new env.context.Event('pointerdown'));
  assert.equal(owner.element.getAttribute('data-header-open'), 'false'); owner.dispose(); menu.remove();
});

test('disclosure delegates focus-before-collapse to canonical native owner and retains consumer panel', async () => {
  const {mountIntrinsicDisclosure} = await controls(), env = fixture();
  vm.runInContext(readRepo('music_app/static/js/runtime/intrinsic-disclosure.js'), env.context);
  env.runtime.createIntrinsicDisclosure = env.owner('createIntrinsicDisclosure');
  const props = {id: 'artist', memberKey: 'albums', label: 'Albums', count: 2, collapsed: false};
  const owner = mountIntrinsicDisclosure(env.host, env.runtime, props), input = env.document.createElement('input');
  owner.slots.panel.append(input); input.focus(); owner.update({...props, collapsed: true});
  assert.equal(owner.slots.panel.hidden, true); assert.equal(owner.slots.panel.inert, true);
  assert.equal(env.document.activeElement, env.host.querySelector('button')); assert.equal(owner.slots.panel.firstElementChild, input);
  owner.update({...props, enabled: false}); assert.equal(owner.slots.panel.hidden, false); assert.equal(env.host.querySelector('button').disabled, true);
  owner.dispose(); assert.equal(env.host.childNodes.length, 0);
});

test('native tabs retain panel association and move disabled focused tab to enabled selection', async () => {
  const {mountTabs} = await controls(), env = fixture();
  vm.runInContext(readRepo('music_app/static/js/runtime/in-page-tabs.js'), env.context);
  env.runtime.tabsHtml = env.owner('buildInPageTabsHtml'); env.runtime.mountTabs = env.owner('mountInPageTabs');
  const a = env.document.createElement('section'), b = env.document.createElement('section'); a.id = 'panel-a'; b.id = 'panel-b'; env.document.body.append(a, b);
  const props = {id: 'panels', label: 'Panels', items: [['a', 'A', {panelId: 'panel-a'}], ['b', 'B', {panelId: 'panel-b'}]], value: 'a'};
  const owner = mountTabs(env.host, env.runtime, props), second = env.host.querySelector('[data-in-page-tab="b"]');
  env.click(second); second.focus(); assert.equal(a.hidden, true); assert.equal(b.hidden, false);
  owner.update({...props, items: [['a', 'A', {panelId: 'panel-a'}], ['b', 'B', {disabled: true, panelId: 'panel-b'}]]});
  assert.equal(env.document.activeElement.dataset.inPageTab, 'a'); assert.equal(env.host.querySelector('[data-in-page-tab="b"]').disabled, true); owner.dispose();
});

test('status denied and ready transitions remove stale content; badge updates metric without replacing icon', async () => {
  const {mountStatus} = await controls(), {mountListensBadge} = await import('../../../music_app/static/js/home-friends/shared-header.mjs'), env = fixture();
  const status = mountStatus(env.host, env.runtime, {value: {status: 'denied'}, label: 'albums'}); assert.match(env.host.textContent, /don't have access/);
  status.update({value: {status: 'ready'}, label: 'albums'}); assert.equal(env.host.hidden, true); assert.equal(env.host.textContent, ''); status.dispose();
  const badge = mountListensBadge(env.host, env.runtime, {total: 1, range: 'Last week'}), icon = env.host.firstElementChild;
  badge.update({total: 2, range: 'Last month'}); assert.equal(env.host.firstElementChild, icon); assert.equal(env.host.getAttribute('aria-label'), 'Listens: 2'); badge.dispose();
});

// Execute the whole production helper unchanged. Only the mobile history boundary
// is controllable; its deferred completion models onAfterClose after open throws.
function nativeDialogFixture({delayed = false} = {}) {
  const env = fixture(), {document, context} = env, events = [];
  const modal = document.createElement('div'); modal.id = 'app-form-modal'; modal.hidden = true;
  const panel = document.createElement('div'); panel.className = 'confirm-modal-dialog'; modal.append(panel);
  for (const name of ['title', 'content', 'error', 'close']) {
    const node = document.createElement(name === 'close' ? 'button' : 'div'); node.id = `app-form-${name}`; panel.append(node);
  }
  const footer = document.createElement('div'); footer.className = 'confirm-modal-actions'; panel.append(footer);
  for (const name of ['cancel', 'submit']) {const node = document.createElement('button'); node.id = `app-form-${name}`; footer.append(node);}
  document.body.append(modal);
  let settle, retirements = 0, closeAttempts = 0;
  const navigation = new Promise(resolve => {settle = resolve;});
  if (delayed) {
    context.presentMobileAppFormPage = () => {};
    context.retireMobileAppFormPage = () => {retirements++; return navigation;};
  }
  vm.runInContext(readRepo('music_app/static/js/runtime/browser-dialog-helpers.js'), context);
  const openForm = env.owner('openReactFormDialog');
  env.runtime.openForm = options => openForm({...options,
    onMount(host, close) {options.onMount(host, (value, next) => {closeAttempts++; return close(value, next);});},
    onClose(host, next) {events.push('native-after-close'); options.onClose(host, next);},
  });
  return {...env, modal, events, get closeAttempts() {return closeAttempts;}, get retirements() {return retirements;},
    async settle() {settle(true); await navigation; await Promise.resolve(); await Promise.resolve();}};
}

for (const delayed of [false, true]) test(`actual native mount failure preserves fallback across ${delayed ? 'delayed mobile' : 'desktop'} cleanup`, async () => {
  const {openNativeDialog} = await dialogs(), env = nativeDialogFixture({delayed}), failure = new Error('consumer mount failed');
  let errors = 0, closes = 0;
  const owner = openNativeDialog(env.runtime, {title: 'Edit', pageId: 'editor'}, {
    mount() {throw failure;}, fallbackHost: env.host,
    onError(error) {errors++; assert.equal(error, failure); env.events.push('error');},
    onClose() {closes++; env.events.push('consumer-close'); env.host.remove();},
  });
  assert.equal(owner.failed, true); assert.equal(owner.closed, false); assert.equal(owner.element, null);
  assert.equal(errors, 1); assert.equal(closes, 0); assert.equal(env.closeAttempts, 1);
  assert.equal(env.modal.hidden, true); assert.equal(env.document.getElementById('app-form-content').childNodes.length, 0);
  assert.equal(env.host.isConnected, true); assert.match(env.host.textContent, /not available/);
  assert.deepEqual(env.events, delayed ? ['error'] : ['native-after-close', 'error']);
  await env.settle();
  assert.equal(closes, 0); assert.equal(errors, 1); assert.equal(env.host.isConnected, true);
  assert.equal(env.retirements, delayed ? 1 : 0);
  const button = env.host.querySelector('button'); env.click(button); env.click(button);
  assert.equal(closes, 1); assert.equal(owner.closed, true); assert.equal(owner.failed, true);
  assert.equal(env.host.childNodes.length, 0); assert.equal(env.host.isConnected, false);
  owner.dispose(); owner.dispose(); assert.equal(env.closeAttempts, 1); assert.equal(closes, 1);
});

for (const delayed of [false, true]) test(`actual native onError can close once before ${delayed ? 'late' : 'completed'} cleanup`, async () => {
  const {openNativeDialog} = await dialogs(), env = nativeDialogFixture({delayed}); let closes = 0, errors = 0;
  const owner = openNativeDialog(env.runtime, {title: 'Edit', pageId: 'editor'}, {
    mount() {throw new Error('failed');}, fallbackHost: env.host,
    onError(_error, close) {errors++; close({restoreFocus: false}); close();},
    onClose(result) {closes++; assert.equal(result.restoreFocusRequested, false);},
  });
  assert.equal(owner.failed, true); assert.equal(owner.closed, true); assert.equal(env.host.childNodes.length, 0);
  owner.dispose(); await env.settle(); owner.close();
  assert.equal(errors, 1); assert.equal(closes, 1); assert.equal(env.closeAttempts, 1);
});

test('actual native synchronous successful mount close is delivered after factory return with one child teardown', async () => {
  const {openNativeDialog} = await dialogs(), env = nativeDialogFixture(); let children = 0, closes = 0;
  const owner = openNativeDialog(env.runtime, {title: 'Edit'}, {
    mount(_host, close) {close({restoreFocus: false}); env.events.push('factory-return'); return {dispose() {children++; env.events.push('child-dispose');}};},
    onClose() {closes++; env.events.push('consumer-close');}, onError() {assert.fail('successful close is not failure');},
  });
  assert.deepEqual(env.events, ['native-after-close', 'factory-return', 'child-dispose', 'consumer-close']);
  assert.equal(owner.closed, true); assert.equal(owner.failed, false); assert.equal(owner.element, null);
  owner.close(); owner.dispose(); assert.equal(children, 1); assert.equal(closes, 1); assert.equal(env.closeAttempts, 1);
});

test('actual native cleanup followed by wrapper throw is failure, never premature consumer close', async () => {
  const {openNativeDialog} = await dialogs(), env = nativeDialogFixture(), nativeOpen = env.runtime.openForm;
  const failure = new Error('open wrapper failed'); let childDisposals = 0, errors = 0, closes = 0;
  env.runtime.openForm = options => {const opened = nativeOpen(options); opened.close(null, {force: true, restoreFocus: false}); throw failure;};
  const owner = openNativeDialog(env.runtime, {title: 'Edit'}, {
    mount: () => ({dispose() {childDisposals++;}}), fallbackHost: env.host,
    onError(error) {assert.equal(error, failure); errors++;}, onClose() {closes++; env.host.remove();},
  });
  assert.equal(owner.failed, true); assert.equal(owner.closed, false); assert.equal(childDisposals, 1);
  assert.equal(errors, 1); assert.equal(closes, 0); assert.equal(env.host.isConnected, true);
  owner.dispose(); assert.equal(env.host.childNodes.length, 0); assert.equal(childDisposals, 1); assert.equal(closes, 0);
});

test('actual native failure without fallbackHost uses only explicit onError and adds no body fallback', async () => {
  const {openNativeDialog} = await dialogs(), env = nativeDialogFixture(), bodyChildren = [...env.document.body.children]; let errors = 0;
  const owner = openNativeDialog(env.runtime, {title: 'Edit'}, {
    mount() {throw new Error('failed');}, onError() {errors++;},
  });
  assert.equal(owner.failed, true); assert.equal(errors, 1); assert.deepEqual([...env.document.body.children], bodyChildren);
  assert.equal(env.host.childNodes.length, 0); owner.dispose();
});

test('consumer successful-close exception is not reclassified as opening failure', async () => {
  const {openNativeDialog} = await dialogs(), env = nativeDialogFixture(), failure = new Error('consumer close failed'); let errors = 0, children = 0;
  assert.throws(() => openNativeDialog(env.runtime, {title: 'Edit'}, {
    mount(_host, close) {close({restoreFocus: false}); return {dispose() {children++;}};},
    onClose() {throw failure;}, onError() {errors++;}, fallbackHost: env.host,
  }), error => error === failure);
  assert.equal(errors, 0); assert.equal(children, 1); assert.equal(env.host.childNodes.length, 0);
});
