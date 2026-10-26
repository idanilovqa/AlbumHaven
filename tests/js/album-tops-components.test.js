const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./runtime/native-home-harness.cjs');
const {load, TOP} = require('./runtime/album-tops-native-fixtures/actual-native-runtime.cjs');
const {loadOwners, nativeRuntime, viewOwner, sessionOwner, button, click, plain, deferred, settle} = require('./runtime/album-tops-sharing-harness.cjs');
test.before(loadOwners);
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BROWSE = 'library.browse.read', CREATE = 'library.album_tops.create', MANAGE = 'library.album_tops.manage';
const top = patch => ({top_ref: TOP, title: 'Top <title>', description: 'A private subtitle', revision: '7',
  allowed_actions: {[BROWSE]: true, [MANAGE]: true, can_read: true, can_edit: true,
    can_rename: true, can_delete: true}, items: [], ...patch});
function initialState({selected = false, status = 'ready', grants = {[BROWSE]: true, [CREATE]: true, can_create: true}, detail = top()} = {}) {
  return {scopeKey: 'top-components:actor:library', selectedTopRef: selected ? TOP : null,
    directory: {status: selected ? 'ready' : status, data: {tops: [top()], allowed_actions: grants}},
    detail: {status: selected ? status : 'idle', data: selected ? detail : null}, mutation: {status: 'idle'}};
}
function componentRuntime(t, inline) {
  const env = nativeRuntime(t, {inlineNavigation: inline});
  // The genuine Top bridge reads the current library from the served track
  // owner; retain its authenticated shell/private-context authority checks.
  if (inline) {
    const tracks = env.owner('TrackActionsRuntime'), shell = env.document.getElementById('app-shell');
    assert.equal(typeof tracks.scope, 'function');
    assert.equal(tracks.scope().actor, shell.dataset.nativeAccountId);
    assert.equal(tracks.scope().library, shell.dataset.nativeLibraryId);
  }
  return env;
}
// Preserve the original authored presentation-controller boundary. Mounted
// session cases below instead own the actual index and real model/providers.
function fixture(t, state = initialState(), configure) {
  const inline = Boolean(state.selectedTopRef);
  const env = componentRuntime(t, inline), listeners = new Set();
  if (inline) state = {...state, scopeKey: env.runtime.snapshot().scopeKey};
  else {
    const nativeSnapshot = env.runtime.snapshot;
    env.runtime.snapshot = () => ({...nativeSnapshot(), scopeKey: state.scopeKey, topRef: state.selectedTopRef});
  }
  Object.assign(env.calls, {mutations: [], opens: [], loads: 0, saved: []});
  const controller = {getSnapshot: () => state,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    async mutate(...args) {env.calls.mutations.push(args); return false;}, retryMutation: async () => false,
    canRetryMutation: () => state.mutation.status === 'uncertain',
    load() {env.calls.loads++;}, open(ref) {env.calls.opens.push(ref);}};
  const props = () => ({controller, state, onOpen: ref => env.calls.opens.push(ref), onFormSaved: receipt => env.calls.saved.push(receipt)});
  configure?.(env);
  const owner = viewOwner(env, props());
  return {...env, controller, owner,
    replace(next) {state = next; for (const fn of [...listeners]) fn(); owner.update(props());},
    render() {owner.update(props()); return {host: env.host, html: env.host.innerHTML};},
    form: () => inline ? env.host.querySelector('form.album-top-inline-edit') : env.content().querySelector('form'),
    field: name => (inline ? env.host : env.content()).querySelector(`[name="${name}"]`),
    beforeDismiss: () => env.calls.owners.at(-1).options.beforeDismiss(),
  };
}
function editor(t, {selected = false, configure} = {}) {
  const env = fixture(t, initialState({selected}), configure);
  const opener = button(env.host, selected ? 'Edit Album Top' : 'Create Album Top');
  assert.ok(opener); opener.focus(); click(opener);
  assert.ok(env.form(), 'actual native action opened the real editor');
  if (selected) {assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 0);}
  return {...env, opener};
}
const submit = async env => {const form = env.form(); assert.ok(form); form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit')); await settle();};
const absentForm = env => assert.equal(env.form(), null);

test('directory composes native gallery controls and escaped server cards without unsupported actions', t => {
  const env = fixture(t), {html, host} = env.render();
  assert.ok(host.querySelector('.gallery-bar'));
  assert.equal(button(host, /^Create Album Top$/).disabled, false);
  assert.ok(button(host, /^Create Album Top$/).classList.contains('action-button'));
  assert.match(html, /Top &lt;title&gt;/); assert.equal(host.querySelectorAll('.album-card').length, 1);
  assert.ok(host.querySelector('[data-gallery-card-intent="open"]'));
  assert.equal(host.querySelector('[data-gallery-card-intent="play"]'), null);
  for (const label of [/Share/, /Progress/, /Listen/, /Delete/, /Edit/]) assert.equal(button(host, label), undefined);
  assert.deepEqual(env.native.forbiddenCalls, []);
});
test('empty, denied and failed directories render truthful native status and error retry', t => {
  for (const [status, text] of [['empty', /No Album Tops yet/], ['denied', /don't have access/], ['error', /could not be loaded/]]) {
    const state = initialState({status});
    state.directory.data = status === 'empty' ? {tops: [], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}} : null;
    const env = fixture(t, state), {host} = env.render();
    assert.match(host.textContent, text); assert.equal(host.querySelectorAll('.album-card').length, 0);
    assert.equal(Boolean(button(host, /^Retry$/)), status === 'error');
    assert.equal(Boolean(button(host, /^Create Album Top$/)), status === 'empty');
    if (status === 'error') {click(button(host, /^Retry$/)); assert.equal(env.calls.loads, 1);}
  }
});
test('create and manage controls require their own explicit server action projections', t => {
  for (const allowed_actions of [{}, {[BROWSE]: true, [CREATE]: 'true', can_create: true},
    {[CREATE]: true, can_create: true}, {[BROWSE]: true, [CREATE]: true},
    Object.create({[BROWSE]: true, [CREATE]: true, can_create: true})]) {
    const {host} = fixture(t, initialState({grants: allowed_actions})).render();
    assert.equal(button(host, /^Create Album Top$/), undefined);
  }
  for (const allowed_actions of [{[BROWSE]: true}, {[BROWSE]: true, [MANAGE]: true},
    {[BROWSE]: true, can_edit: 1, can_delete: 'true'}, {can_edit: true, can_delete: true},
    Object.create({[BROWSE]: true, can_edit: true, can_delete: true})]) {
    const {host} = fixture(t, initialState({selected: true, detail: top({allowed_actions})})).render();
    assert.equal(button(host, /^Edit Album Top$/), undefined); assert.equal(button(host, /^Delete Album Top$/), undefined);
  }
});
test('Top detail uses opaque item cards without inventing media, sharing or progress controls', t => {
  const state = initialState({selected: true, detail: top({items: [{item_ref: ITEM, title: 'Album <name>', artist: 'Artist', year: 2001}]})});
  const env = fixture(t, state), {html, host} = env.render();
  assert.match(html, /Album &lt;name&gt;/); assert.equal(host.querySelectorAll('.album-card').length, 1);
  assert.equal(host.querySelector('[data-gallery-card-intent]'), null);
  assert.ok(button(host, /^Edit Album Top$/)); assert.ok(button(host, /^Delete Album Top$/));
  click(button(host, 'Back')); assert.deepEqual(env.calls.opens, [null]);
});
test('pending, uncertain and acknowledged-refreshing writes visibly disable native management actions', t => {
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'ready', refreshing: true}]) {
    const state = initialState({selected: true}); state.mutation = mutation;
    const {host} = fixture(t, state).render();
    for (const label of [/^Edit Album Top$/, /^Delete Album Top$/]) {
      const control = button(host, label); assert.equal(control.disabled, true); assert.equal(control.getAttribute('aria-disabled'), 'true');
    }
  }
});
test('Create submits authored fields through the controller and preserves an unconfirmed draft', async t => {
  const env = editor(t);
  assert.equal(button(env.form(), 'Create Album Top').disabled, true);
  env.input(env.field('top-name'), 'New Top'); env.input(env.field('top-subtitle'), 'Typed subtitle');
  assert.equal(button(env.form(), 'Create Album Top').disabled, false); await submit(env);
  assert.deepEqual(plain(env.calls.mutations), [['create', {title: 'New Top', description: 'Typed subtitle', album_refs: []}]]);
  assert.equal(env.calls.closes.length, 0); assert.equal(env.field('top-name').value, 'New Top');
});
test('same-Top revision replacement preserves typed edits but blocks stale submission', async t => {
  const env = editor(t, {selected: true}); env.input(env.field('top-name'), 'My draft');
  const state = env.controller.getSnapshot();
  env.replace({...state, detail: {...state.detail, data: {...state.detail.data, revision: '8', title: 'Changed by server'}}});
  assert.equal(env.field('top-name').value, 'My draft'); assert.equal(button(env.form(), 'Save').disabled, true);
  await submit(env); assert.equal(env.calls.mutations.length, 0); assert.match(env.form().textContent, /draft is preserved/);
});
test('editor busy, uncertain and acknowledged-refreshing states block fields, submission, and native dismissal', async t => {
  const env = editor(t, {selected: true});
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'ready', refreshing: true}]) {
    env.replace({...env.controller.getSnapshot(), mutation});
    assert.equal(env.field('top-name').disabled, true); assert.equal(env.field('top-subtitle').disabled, true);
    assert.equal(button(env.form(), 'Cancel').disabled, true); assert.equal(button(env.form(), 'Save').disabled, true);
    assert.equal(await env.runtime.deferDraftNavigation(() => assert.fail('Busy inline editor allowed departure')), false);
    assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 0); await submit(env);
  }
  assert.equal(env.calls.mutations.length, 0);
});
test('dirty Cancel uses the shared native confirmation and clean dismissal needs no prompt', async t => {
  const env = editor(t); assert.equal(env.beforeDismiss(), true);
  env.input(env.field('top-name'), 'Unsaved'); assert.equal(await env.beforeDismiss(), false);
  assert.equal(env.calls.confirms.length, 1); assert.equal(env.calls.confirms[0][1].title, 'Discard Album Top changes');
  assert.equal(env.calls.confirms[0][1].danger, true); assert.equal(env.field('top-name').value, 'Unsaved');
});
test('native delete confirmation cannot apply to a refreshed or revoked controller snapshot', async t => {
  for (const changed of [false, true]) {
    const pending = deferred(), env = fixture(t, initialState({selected: true}), env => {env.runtime.confirm = () => pending.promise;});
    click(button(env.host, 'Delete Album Top')); assert.equal(env.calls.mutations.length, 0);
    if (changed) env.replace({...env.controller.getSnapshot(), mutation: {status: 'denied'}});
    pending.resolve(true); await settle(); assert.deepEqual(plain(env.calls.mutations), changed ? [] : [['delete']]);
  }
});
test('write denial immediately removes a retained editor and cannot resurrect its private draft', t => {
  const env = editor(t, {selected: true}); env.input(env.field('top-name'), 'Private retained draft');
  const previous = env.controller.getSnapshot();
  env.replace({...previous, directory: {status: 'denied', data: null}, detail: {status: 'denied', data: null}, mutation: {status: 'denied'}});
  absentForm(env); assert.doesNotMatch(env.document.body.textContent, /Private retained draft/);
  env.replace(previous); absentForm(env);
});
// Actual native form/history owners with only browser history and geometry
// supplied by the platform fixture. No native close or pop owner is emulated.
function nativeFormHistory(env) {
  const {context, document} = env;
  const proto = context.Element.prototype;
  proto.before = function (node) {this.parentNode.insertBefore(node, this);};
  proto.replaceWith = function (node) {this.before(node); this.remove();};
  document.createComment = () => document.createElement('fixture-placeholder');
  // Load the entire canonical module without a browser document so its pure
  // history sanitizer is available without acquiring another navigation owner.
  const settings = {window: {}};
  vm.runInNewContext(readRepo('music_app/static/js/settings-navigation.js'), settings);
  const shell = document.createElement('div'); shell.id = 'app-shell';
  shell.setAttribute('data-native-account-id', '41'); shell.setAttribute('data-native-library-id', '73'); document.body.append(shell);
  const outlet = document.createElement('div'); outlet.id = 'mobile-page-outlet'; document.body.append(outlet);
  const entries = [{state: {albumHavenNavigationPosition: 0}, url: `https://music.test/?surface=album_tops&top_ref=${TOP}`}];
  let position = 0, queued = null;
  context.innerWidth = 390; context.location = new URL(entries[0].url);
  context.history = {get state() {return entries[position].state;},
    pushState(state, _title, url) {entries.splice(position + 1); entries.push({state, url: String(url)}); position++; context.location.href = String(url);},
    replaceState(state, _title, url) {entries[position] = {state, url: String(url)}; context.location.href = String(url);},
    go(delta) {assert.equal(queued, null); queued = delta;},
  };
  context.AlbumHavenSettingsNavigation = {sanitizeHistorySnapshot: settings.window.AlbumHavenSettingsNavigation.sanitizeHistorySnapshot, instance: {pushLibraryHistory(url, state) {
    context.history.pushState({...state, albumHavenNavigationPosition: position + 1}, '', url);
  }}};
  Object.assign(context, {state: {view: {surface: {active: 'album_tops'}}, utility: {}},
    buildUrl: () => `/?surface=album_tops&top_ref=${TOP}`,
    closeArtistsDrawer() {}, closeGalleryMainSurface() {}, bindOverlayPointerOrigin() {}, overlayClickStartedOnOverlay: () => false,
    handleGalleryBootstrapPopState() {assert.fail('the unchanged native Top parent must be retained');},
  });
  vm.runInContext(readRepo('music_app/static/js/runtime/mobile-navigation.js'), context, {filename: 'mobile-navigation.js'});
  context.syncMobilePageShell = () => {};
  env.own({dispose() {
    // Retire the already-mounted consumer first (reverse ownership stack), then
    // let the real native supersession guard reject any unfinished return.
    if (queued !== null) {env.owner('cancelSupersededMobileFormReturn')(); queued = null;}
    for (const [id, callback] of [...env.frames]) {env.frames.delete(id); callback();}
  }});
  const nativeOptions = [], open = env.runtime.openForm;
  env.runtime.openForm = options => open({...options, retainParentView: () => true,
    onClose(...args) {nativeOptions.push(args[1]); options.onClose(...args);}});
  return {entries, nativeOptions, get position() {return position;}, get queued() {return queued;},
    finishReturn() {assert.equal(queued, -1); position += queued; queued = null; context.location.href = entries[position].url;
      assert.equal(env.owner('handleMobilePagePopState')(), true);},
  };
}
test('acknowledged Create form awaits the actual native mobile parent traversal before reporting its receipt', async t => {
  let history;
  const env = editor(t, {selected: false, configure: env => {history = nativeFormHistory(env);}});
  assert.equal(history.position, 1); assert.equal(env.context.location.searchParams.get('mobile_page'), 'form');
  const receipt = {action: 'create', top_ref: TOP, revision: '8', request_key: ITEM};
  env.controller.mutate = async (...args) => {env.calls.mutations.push(args); return true;};
  env.input(env.field('top-name'), 'Saved title'); await submit(env);
  assert.equal(history.queued, null, 'a mutation return value is not a native close acknowledgement');
  env.replace({...env.controller.getSnapshot(), mutation: {status: 'ready', refreshing: true,
    action: 'create', command: {request_key: ITEM}, data: receipt}});
  assert.equal(history.queued, -1); assert.equal(env.modal().hidden, true);
  assert.equal(history.nativeOptions.length, 0); assert.deepEqual(env.calls.saved, []);
  // Native modal detaches its content while parent history is pending. Its
  // completion callback, rather than a React TopFields node, retains receipt ownership.
  assert.equal(env.calls.owners.length, 1); assert.equal(env.calls.closes.length, 1);
  env.replace({...env.controller.getSnapshot(), mutation: {...env.controller.getSnapshot().mutation, refreshing: false}});
  assert.equal(history.queued, -1, 'the ready-to-refreshed transition must not queue a second parent return');
  assert.equal(env.calls.closes.length, 1);
  history.finishReturn(); await settle(); assert.equal(history.position, 0);
  assert.equal(env.context.location.searchParams.get('top_ref'), TOP); assert.deepEqual(plain(env.calls.saved), [receipt]);
  assert.deepEqual(plain(history.nativeOptions), [{restoreFocus: true, returnToParent: true, current: true}]);
  assert.equal(env.document.activeElement, env.opener); absentForm(env);
});
test('acknowledged Create returns native focus to the current header after its launcher unmounts', async t => {
  let history;
  const env = editor(t, {selected: false, configure: env => {history = nativeFormHistory(env);}});
  const options = env.calls.owners.at(-1).options;
  assert.equal(options.returnFocus(), env.opener, 'the actual launcher is preferred while connected');
  const header = env.host.querySelector('[data-shared-header]');
  assert.equal(header.getAttribute('tabindex'), '-1'); assert.equal(header.getAttribute('aria-label'), 'Album Tops header');
  const previous = env.controller.getSnapshot(), action = 'create';
  const receipt = {action, top_ref: TOP, revision: '8', request_key: ITEM};
  env.replace({...previous, selectedTopRef: TOP, detail: {status: 'loading', data: null},
    mutation: {status: 'ready', refreshing: true, action, command: {request_key: ITEM}, data: receipt}});
  assert.equal(button(env.host, 'Create Album Top'), undefined);
  // The current shared header retains hidden controls instead of deleting them.
  // Remove the actual old launcher to preserve the explicit disconnected case.
  env.opener.remove(); env.document.body.focus(); assert.equal(env.opener.isConnected, false);
  const tools = env.host.querySelector('[data-header-tools]');
  const focusTarget = tools && !tools.closest('[hidden],[inert],[aria-hidden="true"]') && !tools.disabled && tools.getClientRects().length ? tools : header;
  assert.equal(options.returnFocus(), focusTarget);
  assert.equal(history.queued, -1); assert.equal(env.document.activeElement, env.document.body);
  assert.deepEqual(env.calls.saved, []); history.finishReturn(); await settle();
  assert.equal(env.document.activeElement, focusTarget); assert.deepEqual(plain(env.calls.saved), [receipt]); absentForm(env);
});

test('clean native Cancel restores the connected launcher and scope-unmount cleanup never steals focus', async t => {
  for (const closeKind of ['cancel', 'scope-unmount']) {
    let history;
    const env = editor(t, {selected: false, configure: env => {history = nativeFormHistory(env);}});
    if (closeKind === 'cancel') {
      click(button(env.form(), 'Cancel')); await settle(); assert.equal(history.queued, -1);
      history.finishReturn(); await settle(); assert.equal(env.document.activeElement, env.opener); absentForm(env);
    } else {
      env.document.getElementById('app-shell').setAttribute('data-native-account-id', '42'); env.document.body.focus();
      env.owner.dispose(); await settle();
      assert.equal(history.queued, null, "unmount cannot traverse the replacement actor's history");
      assert.equal(env.document.activeElement, env.document.body);
      assert.equal(env.native.owner('getActiveAppFormPage')(), null); assert.equal(env.modal().hidden, true);
    }
    assert.deepEqual(env.calls.saved, []);
  }
});
// Delay/refuse only the external acknowledgement boundary. All dialog/form
// construction still uses the canonical native owner, including failure cleanup.
function holdNativeClose(env, closing) {
  const open = env.runtime.openForm;
  env.own({dispose() {closing.resolve(false);}});
  env.runtime.openForm = options => open({...options, onMount(host, close) {
    options.onMount(host, (value, closeOptions) => closeOptions?.returnToParent === false
      ? close(value, closeOptions) : closing.promise);
  }});
}
test('failed native close preserves the confirmed receipt and shows a shared alert without reporting form completion', async t => {
  for (const failure of ['false', 'reject']) {
    const closing = deferred(), env = editor(t, {selected: false, configure: env => holdNativeClose(env, closing)});
    env.replace({...env.controller.getSnapshot(), mutation: {status: 'ready', refreshing: false,
      action: 'create', command: {request_key: ITEM}, data: {action: 'create', top_ref: TOP, request_key: ITEM, revision: '8'}}});
    if (failure === 'false') closing.resolve(false); else closing.reject(new Error('Native return failed'));
    await settle(); assert.deepEqual(env.calls.saved, []);
    assert.match(env.form().textContent, /could not return to its parent/); assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
  }
});

test('Create modal retains busy field, submission and dismissal protection independently of inline Edit', async t => {
  const env = editor(t);
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'ready', refreshing: true}]) {
    env.replace({...env.controller.getSnapshot(), mutation});
    assert.equal(env.field('top-name').disabled, true); assert.equal(env.field('top-subtitle').disabled, true);
    assert.equal(button(env.form(), 'Cancel').disabled, true); assert.equal(button(env.form(), 'Create Album Top').disabled, true);
    assert.equal(env.beforeDismiss(), false); assert.equal(env.calls.owners.at(-1).dismissDisabled, true);
    await submit(env);
  }
  assert.equal(env.calls.mutations.length, 0);
});

test('inline Edit acknowledges the exact save and refresh before restoring current header focus without a modal receipt', async t => {
  const env = editor(t, {selected: true}), form = env.form();
  const history = structuredClone(env.context.history.state), url = env.context.location.href;
  assert.equal(env.opener.isConnected, false, 'inline header replaces the original launcher');
  env.input(env.field('top-name'), 'Saved inline title'); await submit(env);
  assert.deepEqual(plain(env.calls.mutations), [['save', {title: 'Saved inline title', description: 'A private subtitle'}]]);
  const command = {top_ref: TOP, revision: '7', request_key: ITEM};
  const receipt = {action: 'save', top_ref: TOP, revision: '8', request_key: ITEM};
  env.document.body.focus();
  const before = env.controller.getSnapshot();
  env.replace({...before, detail: {status: 'loading', data: before.detail.data},
    mutation: {status: 'ready', refreshing: true, action: 'save', command, data: receipt}});
  assert.equal(env.form(), form); assert.equal(button(form, 'Save').disabled, true);
  assert.equal(env.document.activeElement, env.document.body); assert.deepEqual(env.calls.saved, []);
  assert.equal(env.opens.length, 0); assert.equal(env.calls.closes.length, 0);
  env.replace({...before, detail: {status: 'ready', data: {...before.detail.data, title: 'Saved inline title', revision: '8'}},
    mutation: {status: 'ready', refreshing: false, action: 'save', command, data: receipt}});
  await settle(); absentForm(env);
  assert.equal(env.document.activeElement, button(env.host, 'Edit Album Top'));
  assert.equal(env.document.activeElement.isConnected, true); assert.notEqual(env.document.activeElement, env.opener);
  assert.deepEqual(env.calls.saved, []); assert.equal(env.opens.length, 0); assert.equal(env.calls.closes.length, 0);
  assert.deepEqual(env.context.history.state, history); assert.equal(env.context.location.href, url);
  form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit'));
  assert.equal(env.calls.mutations.length, 1, 'retired inline form cannot replay the acknowledged save');
  assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('Saved editor retained a departure lease')), false);
});

for (const closeKind of ['cancel', 'scope-unmount']) test(`inline Edit ${closeKind} retires its real navigation lease without stealing replacement focus`, async t => {
  const env = editor(t, {selected: true}), form = env.form();
  const history = structuredClone(env.context.history.state), url = env.context.location.href;
  if (closeKind === 'cancel') {
    click(button(form, 'Cancel')); await settle(); absentForm(env);
    assert.equal(env.document.activeElement, button(env.host, 'Edit Album Top'));
  } else {
    env.document.getElementById('app-shell').dataset.nativeAccountId = 'replacement-actor';
    env.document.body.focus(); env.runtime.sync(); env.owner.dispose(); await settle(); absentForm(env);
    assert.equal(env.document.activeElement, env.document.body);
  }
  assert.equal(form.isConnected, false); assert.equal(env.modal().hidden, true);
  assert.equal(env.opens.length, 0); assert.equal(env.calls.closes.length, 0); assert.deepEqual(env.calls.saved, []);
  assert.deepEqual(env.context.history.state, history); assert.equal(env.context.location.href, url);
  assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('Retired editor retained a departure lease')), false);
});

test('inline Edit keeps the draft on real declined departure and discards only after accepted native confirmation', async t => {
  const env = editor(t, {selected: true}), form = env.form(); let arrivals = 0;
  env.input(env.field('top-name'), 'Private unsaved title');
  const leave = () => {arrivals++; return true;};
  const declined = env.runtime.deferDraftNavigation(leave); await settle();
  assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
  click(env.document.getElementById('app-confirm-cancel')); assert.equal(await declined, false);
  assert.equal(env.form(), form); assert.equal(env.field('top-name').value, 'Private unsaved title'); assert.equal(arrivals, 0);
  const accepted = env.runtime.deferDraftNavigation(leave); await settle();
  click(env.document.getElementById('app-confirm-accept')); assert.equal(await accepted, true); await settle();
  absentForm(env); assert.equal(arrivals, 1); assert.equal(env.calls.mutations.length, 0); assert.deepEqual(env.calls.saved, []);
  assert.doesNotMatch(env.document.body.textContent, /Private unsaved title/);
  assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('Discarded editor retained a lease')), false);
});

test('inline Edit cannot submit when its actual navigation protection failed and recovers only after explicit reopen', async t => {
  let history, url;
  const env = editor(t, {selected: true, configure: env => {
    history = structuredClone(env.context.history.state); url = env.context.location.href;
    env.context.history.replaceState({...history, albumHavenNavigationPosition: '1'}, '', url);
  }});
  const blocked = env.form();
  assert.match(blocked.textContent, /navigation protection could not be started.*Cancel and reopen this Top/);
  assert.equal(env.field('top-name').disabled, true); assert.equal(button(blocked, 'Save').disabled, true);
  await submit(env); assert.equal(env.calls.mutations.length, 0);
  assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('Unavailable guard allowed departure')), false);
  click(button(blocked, 'Cancel')); await settle(); absentForm(env);
  env.context.history.replaceState(history, '', url);
  click(button(env.host, 'Edit Album Top'));
  assert.notEqual(env.form(), blocked); assert.equal(env.field('top-name').disabled, false);
  env.input(env.field('top-name'), 'Recovered inline title'); await submit(env);
  assert.deepEqual(plain(env.calls.mutations), [['save', {title: 'Recovered inline title', description: 'A private subtitle'}]]);
  assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 0); assert.deepEqual(env.calls.saved, []);
});

function session(t, {selected = false, inline = false, providers, configure} = {}) {
  const env = componentRuntime(t, inline), listeners = new Set(), navigations = [];
  let shell = Object.freeze({scopeKey: 'mounted:actor:library', authenticated: true, inLibrary: true,
    active: true, visible: true, topRef: selected ? TOP : null, sidebarMode: 'album_tops', viewVersion: 1});
  if (inline) {
    const subscribe = env.runtime.subscribe;
    env.runtime.subscribe = fn => {listeners.add(fn); const release = subscribe(fn); return () => {listeners.delete(fn); release();};};
  } else Object.assign(env.runtime, {snapshot: () => shell,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    acceptsPrivateScope: scope => shell.authenticated && shell.inLibrary && shell.scopeKey === scope});
  env.runtime.navigate = value => {navigations.push(value); return Promise.resolve(true);};
  configure?.(env);
  const mounted = sessionOwner(env, {providers});
  return {...env, mounted, listeners, navigations,
    replaceShell(patch) {
      if (!inline) {shell = Object.freeze({...shell, ...patch}); for (const fn of [...listeners]) fn(); return;}
      const nativeShell = env.document.getElementById('app-shell');
      if (Object.hasOwn(patch, 'inLibrary')) nativeShell.hidden = !patch.inLibrary;
      if (Object.hasOwn(patch, 'authenticated') && !patch.authenticated) nativeShell.dataset.nativeAccountId = '';
      if (Object.hasOwn(patch, 'active') || Object.hasOwn(patch, 'topRef')) {
        env.context.state.view = {...env.context.state.view,
          ...(Object.hasOwn(patch, 'active') ? {surface: {active: patch.active ? 'album_tops' : 'albums'}} : {}),
          ...(Object.hasOwn(patch, 'topRef') ? {top_ref: patch.topRef} : {})};
      }
      env.runtime.sync();
    },
    form: () => inline ? env.host.querySelector('form.album-top-inline-edit') : env.content().querySelector('form'),
    field: name => (inline ? env.host : env.content()).querySelector(`[name="${name}"]`),
  };
}
test('native hiding retains an uncertain operation while scope replacement clears it and mount cleanup retires providers', async t => {
  const calls = {list: 0, read: 0, write: [], disposed: 0};
  const env = session(t, {selected: true, inline: true, providers: {
    list() {calls.list++; return {tops: [top()], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}};},
    read() {calls.read++; return top();},
    execute(action, command) {calls.write.push(plain(command)); if (calls.write.length === 1) throw new TypeError('Connection lost after submission');
      return {action, top_ref: TOP, request_key: command.request_key, revision: '8'};},
    dispose() {calls.disposed++;},
  }});
  await settle(); assert.ok(env.host.querySelector('.album-tops'));
  click(button(env.host, 'Edit Album Top')); env.input(env.field('top-name'), 'Draft after uncertain save'); await submit(env);
  const original = plain(calls.write[0]); assert.ok(original.request_key);
  assert.ok(button(env.document.body, 'Retry original request'), 'uncertain request exposes guarded recovery');
  assert.equal(button(env.form(), 'Save').disabled, true);
  const beforeReads = [calls.list, calls.read];
  env.replaceShell({active: false, visible: false, topRef: null, sidebarMode: 'albums', viewVersion: 2});
  assert.equal(env.host.querySelector('.album-tops'), null);
  env.replaceShell({inLibrary: false}); assert.deepEqual([calls.list, calls.read], beforeReads);
  assert.equal(env.mounted.refresh(), undefined); assert.deepEqual(calls.write, [original]);
  env.replaceShell({inLibrary: true, active: true, visible: true, topRef: TOP, sidebarMode: 'album_tops', viewVersion: 3});
  await settle(); const retry = button(env.host, 'Retry original request'); assert.ok(retry);
  env.runtime.confirmRetryOriginal = async () => true; click(retry); await settle();
  assert.deepEqual(calls.write, [original, original]);
  assert.equal(button(env.host, 'Retry original request'), undefined, 'acknowledgement ends uncertain recovery');
  assert.deepEqual(env.navigations, [], 'save must not create a navigation entry');
  env.replaceShell({scopeKey: 'mounted:other-actor:library', authenticated: false});
  assert.equal(env.host.querySelector('.album-tops'), null); absentForm(env);
  assert.doesNotMatch(env.host.textContent, /Draft after uncertain save|Top <title>|A private subtitle/);
  click(retry); await settle(); assert.equal(calls.write.length, 2, 'retired recovery cannot replay into a new scope');
  env.mounted.dispose(); env.mounted.dispose(); assert.equal(calls.disposed, 1); assert.equal(env.listeners.size, 0);

  // Exact private-field invariants remain directly testable on the public model
  // factory, separately from the mounted index that intentionally hides it.
  const {createAlbumTopController} = await load('album-tops/model.mjs');
  const commands = [];
  const model = createAlbumTopController({requestKey: () => ITEM, providers: {
    list: () => ({tops: [top()], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}}),
    read: () => top(), execute(action, command) {commands.push(plain(command));
      if (commands.length === 1) throw new TypeError('Connection lost after submission');
      return {action, top_ref: TOP, request_key: command.request_key, revision: '8'};},
  }});
  t.after(() => model.dispose());
  model.setScope('mounted:actor:library'); await model.load(); await model.open(TOP);
  await model.mutate('save', {title: 'Draft after uncertain save'});
  const pending = plain(model.getSnapshot().mutation.command);
  assert.equal(model.getSnapshot().mutation.status, 'uncertain');
  await model.open(null); await model.open(TOP);
  assert.equal(model.getSnapshot().mutation.status, 'uncertain');
  assert.deepEqual(plain(model.getSnapshot().mutation.command), pending);
  await model.retryMutation(); assert.deepEqual(commands, [pending, pending]);
  assert.equal(model.getSnapshot().mutation.status, 'ready');
  model.setScope(null);
  assert.equal(model.getSnapshot().scopeKey, null); assert.equal(model.getSnapshot().directory.data, null);
  assert.equal(model.getSnapshot().detail.data, null); assert.equal(model.getSnapshot().mutation.command, null);
});
function deferredNativeClose(env) {
  const closing = deferred(), entered = deferred(), open = env.runtime.openForm; let complete;
  env.own({dispose() {closing.resolve(false);}});
  env.runtime.openForm = options => open({...options, onMount(host, close) {
    options.onMount(host, (value, closeOptions) => {
      if (closeOptions?.returnToParent === false) return close(value, closeOptions);
      assert.equal(complete, undefined, 'one acknowledged native close request');
      complete = () => close(value, closeOptions); entered.resolve(); return closing.promise;
    });
  }});
  return {entered, async finish() {assert.ok(complete); closing.resolve(await complete()); await settle();}};
}
async function acknowledgementMount(t, action) {
  const list = deferred(), read = deferred(), entered = deferred(); let refreshing = false, boundary;
  const writes = [], receipts = [];
  const env = session(t, {selected: action === 'delete', configure: env => {
    env.runtime.confirm = async () => true; boundary = deferredNativeClose(env);
  }, providers: {
    list() {if (refreshing) {entered.resolve(); return list.promise;} return {tops: [top()], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}};},
    read() {return refreshing ? read.promise : top();},
    execute(kind, command) {writes.push({kind, command: plain(command)}); refreshing = true;
      const receipt = {action: kind, request_key: command.request_key, top_ref: TOP, revision: '8'}; receipts.push(receipt); return receipt;},
  }});
  await settle(); assert.ok(env.host.querySelector('.album-tops'));
  let retiredForm;
  if (action === 'create') {
    click(button(env.host, 'Create Album Top')); env.input(env.field('top-name'), 'Created Top'); retiredForm = env.form();
    retiredForm.dispatchEvent(new retiredForm.ownerDocument.defaultView.Event('submit'));
  } else click(button(env.host, 'Delete Album Top'));
  await entered.promise; await settle();
  return {...env, list, read, writes, receipts, boundary, retiredForm,
    finishReads() {list.resolve({tops: action === 'delete' ? [] : [top()], allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}}); read.resolve(top());},
  };
}
test('create navigation waits for both matching native close and refreshed acknowledgement in either completion order', async t => {
  for (const order of ['native-close-first', 'refresh-first']) {
    const h = await acknowledgementMount(t, 'create'); await h.boundary.entered.promise;
    assert.ok(h.form(), 'actual native form remains owned while its close acknowledgement is delayed');
    assert.equal(h.form().getAttribute('aria-busy'), 'true'); assert.equal(h.navigations.length, 0);
    // Public UI cannot inject fabricated onFormSaved receipts. Keep the current
    // real receipt at the provider boundary, and reject stale duplicate submission.
    h.retiredForm.dispatchEvent(new h.retiredForm.ownerDocument.defaultView.Event('submit')); await settle();
    assert.equal(h.writes.length, 1); assert.equal(h.navigations.length, 0);
    assert.equal(h.receipts[0].request_key, h.writes[0].command.request_key);
    assert.equal(h.receipts[0].action, 'create'); assert.equal(h.receipts[0].top_ref, TOP); assert.equal(h.receipts[0].revision, '8');
    if (order === 'native-close-first') {
      await h.boundary.finish(); assert.equal(h.navigations.length, 0, 'closing cannot outrun authoritative refresh');
      h.finishReads(); await settle();
    } else {
      h.finishReads(); await settle(); assert.ok(h.form());
      assert.equal(h.navigations.length, 0, 'refresh cannot bypass the delayed native close'); await h.boundary.finish();
    }
    assert.equal(h.navigations.length, 1); assert.equal(h.navigations[0].top_ref, TOP); assert.equal(h.navigations[0].isCurrent(), true);
    // Repeated real shell notifications preserve one receipt-owned navigation.
    // Exact private getSnapshot clone injection has no public equivalent.
    h.replaceShell({}); h.replaceShell({}); await settle();
    assert.equal(h.navigations.length, 1); assert.equal(h.navigations[0].isCurrent(), true);
    h.retiredForm.dispatchEvent(new h.retiredForm.ownerDocument.defaultView.Event('submit')); await settle(); assert.equal(h.writes.length, 1);
  }
});
test('a stale native form close cannot navigate a new library entry after creation', async t => {
  const h = await acknowledgementMount(t, 'create'); await h.boundary.entered.promise;
  h.replaceShell({viewVersion: 2, topRef: ITEM});
  await h.boundary.finish(); h.finishReads(); await settle(); assert.equal(h.navigations.length, 0);
  h.retiredForm.dispatchEvent(new h.retiredForm.ownerDocument.defaultView.Event('submit')); await settle(); assert.equal(h.writes.length, 1);
});
test('delete navigation needs the completed authoritative refresh but no form receipt', async t => {
  const h = await acknowledgementMount(t, 'delete');
  assert.equal(h.navigations.length, 0); assert.equal(h.calls.owners.length, 0, 'Delete does not acquire a form receipt');
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].kind, 'delete');
  h.finishReads(); await settle(); h.replaceShell({}); h.replaceShell({});
  assert.equal(h.navigations.length, 1); assert.equal(h.navigations[0].top_ref, null);
  assert.equal(h.navigations[0].isCurrent(), true);
});
