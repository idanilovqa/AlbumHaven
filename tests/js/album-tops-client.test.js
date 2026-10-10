const test = require('node:test');
const assert = require('node:assert/strict');

let createAlbumTopController, createAlbumTopBackendProviders;
test.before(async () => {
  ({createAlbumTopController} = await import('../../music_app/static/js/album-tops/model.mjs'));
  ({createAlbumTopBackendProviders} = await import('../../music_app/static/js/album-tops/backend-providers.mjs'));
});

// These synthetic provider replies test client state and transport contracts only.
// Persistence, authority enforcement and idempotent acceptance need the real backend tests.
const BROWSE = 'library.browse.read';
const CREATE = 'library.album_tops.create';
const MANAGE = 'library.album_tops.manage';
const ITEMS = 'library.album_tops.items.manage';
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const FIRST = id(1), SECOND = id(2), CREATED = id(3), ALBUM = id(11), ITEM = id(21);
const SCOPE = 'top-client:actor:library';
const contextRef = 'a'.repeat(64);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const httpError = (status, message = 'Request failed') => Object.assign(new Error(message), {status});
const top = (top_ref = FIRST, patch = {}) => ({top_ref, title: `Top ${top_ref}`, description: '',
  revision: '7', visibility: 'private', allowed_actions: {[BROWSE]: true, [MANAGE]: true, [ITEMS]: true,
    can_read: true, can_edit: true, can_rename: true, can_delete: true,
    can_add: true, can_remove: true, can_reorder: true}, ...patch});
const directory = (patch = {}) => ({tops: [top()], next_cursor: null,
  allowed_actions: {[BROWSE]: true, [CREATE]: true, can_create: true}, ...patch});
const detail = (top_ref = FIRST, patch = {}) => ({...top(top_ref), items: [], ...patch});
const receipt = (action, command, patch = {}) => ({top_ref: command.top_ref || CREATED,
  revision: '8', action, request_key: command.request_key, ...patch});

function harness(t, overrides = {}) {
  const calls = {list: [], read: [], execute: [], keys: []};
  const providers = {
    list(options) {calls.list.push(options); return overrides.list ? overrides.list(options) : directory();},
    read(ref, options) {calls.read.push({ref, options}); return overrides.read ? overrides.read(ref, options) : detail(ref);},
    execute(action, command, options) {
      calls.execute.push({action, command, options});
      return overrides.execute ? overrides.execute(action, command, options) : receipt(action, command);
    },
  };
  const controller = createAlbumTopController({providers, requestKey() {
    const key = id(100 + calls.keys.length); calls.keys.push(key); return key;
  }});
  controller.setScope(SCOPE);
  t.after(() => controller.dispose());
  return {controller, calls};
}
async function opened(controller, ref = FIRST) {await controller.load(); await controller.open(ref);}
const clearPrivateState = state => {
  assert.equal(state.selectedTopRef, null);
  assert.equal(state.directory.data, null);
  assert.equal(state.detail.data, null);
  assert.equal(state.mutation.command, null);
};

test('empty server directory still permits creating an empty Top and opens only its acknowledged identity', async t => {
  const write = deferred();
  const {controller, calls} = harness(t, {list: () => directory({tops: []}), execute: () => write.promise});
  await controller.load();
  assert.equal(controller.getSnapshot().directory.status, 'empty');
  const saving = controller.mutate('create', {title: 'Empty Top', description: '', album_refs: []});
  assert.equal(controller.getSnapshot().selectedTopRef, null);
  assert.equal(calls.read.length, 0);
  assert.deepEqual(calls.execute[0].command, {title: 'Empty Top', description: '', album_refs: [], request_key: id(100)});
  assert.equal(calls.execute[0].options.scopeKey, SCOPE);
  assert.ok(calls.execute[0].options.signal instanceof AbortSignal);
  write.resolve(receipt('create', calls.execute[0].command)); await saving;
  assert.equal(controller.getSnapshot().selectedTopRef, CREATED);
  assert.equal(controller.getSnapshot().detail.data.top_ref, CREATED);
  assert.equal(calls.list.length, 2);
  assert.deepEqual(calls.read.map(call => call.ref), [CREATED]);
});

test('out-of-order directory and detail replies cannot repaint newer navigation', async t => {
  const lists = [deferred(), deferred()], reads = [deferred(), deferred()];
  let listIndex = 0, readIndex = 0;
  const {controller} = harness(t, {list: () => lists[listIndex++].promise, read: () => reads[readIndex++].promise});
  const oldList = controller.load(), newList = controller.load();
  lists[1].resolve(directory({tops: [top(SECOND)]})); await newList;
  lists[0].reject(httpError(403)); await oldList;
  assert.deepEqual(controller.getSnapshot().directory.data.tops.map(row => row.top_ref), [SECOND]);
  const oldRead = controller.open(FIRST), newRead = controller.open(SECOND);
  reads[1].resolve(detail(SECOND)); await newRead;
  reads[0].resolve(detail(FIRST)); await oldRead;
  assert.equal(controller.getSnapshot().selectedTopRef, SECOND);
  assert.equal(controller.getSnapshot().detail.data.top_ref, SECOND);
});

test('returning to the directory suppresses a late detail reply', async t => {
  const reading = deferred();
  const {controller} = harness(t, {read: () => reading.promise});
  await controller.load();
  const opening = controller.open(FIRST); await controller.open(null);
  reading.resolve(detail()); await opening;
  assert.equal(controller.getSnapshot().selectedTopRef, null);
  assert.equal(controller.getSnapshot().detail.data, null);
});

test('directory denial clears private detail authority and invalidates an already pending detail paint', async t => {
  let denied = false, pendingRead = null;
  const {controller, calls} = harness(t, {
    list: () => {if (denied) throw httpError(403); return directory();},
    read: ref => pendingRead ? pendingRead.promise : detail(ref),
  });
  await opened(controller);
  pendingRead = deferred(); const opening = controller.open(FIRST);
  denied = true; await controller.load();
  assert.equal(controller.getSnapshot().directory.status, 'denied');
  assert.equal(controller.getSnapshot().directory.data, null);
  assert.equal(controller.getSnapshot().detail.data, null);
  pendingRead.resolve(detail()); await opening;
  assert.equal(controller.getSnapshot().detail.data, null);
  await controller.mutate('save', {title: 'No longer authorized'});
  await controller.mutate('create', {title: 'No longer authorized', album_refs: []});
  assert.equal(calls.execute.length, 0);
});

test('detail denial discards earlier metadata and removes mutation authority', async t => {
  let denied = false;
  const {controller, calls} = harness(t, {read: ref => {if (denied) throw httpError(403); return detail(ref);}});
  await opened(controller); denied = true; await controller.open(FIRST);
  assert.equal(controller.getSnapshot().detail.status, 'denied');
  assert.equal(controller.getSnapshot().detail.data, null);
  await controller.mutate('remove', {item_refs: [ITEM]});
  assert.equal(calls.execute.length, 0);
});

test('each mutation needs its exact own boolean action grant and Browse on the current resource', async t => {
  const cases = [
    ['create', CREATE, {title: 'Create', description: '', album_refs: []}],
    ['save', 'can_edit', {title: 'Rename'}], ['delete', 'can_delete', {}],
    ['add', 'can_add', {album_refs: [ALBUM]}], ['remove', 'can_remove', {item_refs: [ITEM]}],
    ['reorder', 'can_reorder', {item_order: [ITEM]}],
  ];
  for (const [action, permission, data] of cases) {
    const deniedGrants = [{[BROWSE]: true}, {[BROWSE]: true, [permission]: 'true'},
      {[permission]: true}, Object.create({[BROWSE]: true, [permission]: true})];
    for (const allowed_actions of deniedGrants) {
      const {controller, calls} = harness(t, {
        list: () => directory(action === 'create' ? {allowed_actions: Object.assign(allowed_actions, {can_create: true})} : {}),
        read: ref => detail(ref, action === 'create' ? {} : {allowed_actions}),
      });
      await opened(controller); await controller.mutate(action, data);
      assert.equal(calls.execute.length, 0, `${action} must reject absent, inherited or non-boolean authority`);
      assert.equal(calls.keys.length, 0);
    }
  }
});

test('fresh authority revocation is honored rather than an earlier directory or detail grant', async t => {
  let revoked = false;
  const {controller, calls} = harness(t, {
    list: () => directory({allowed_actions: {[BROWSE]: true, [CREATE]: !revoked, can_create: !revoked}}),
    read: ref => detail(ref, {allowed_actions: {[BROWSE]: true, [MANAGE]: !revoked, [ITEMS]: !revoked,
      can_read: true, can_edit: !revoked, can_rename: !revoked, can_delete: !revoked,
      can_add: !revoked, can_remove: !revoked, can_reorder: !revoked}}),
  });
  await opened(controller); revoked = true; await opened(controller);
  for (const action of ['create', 'save', 'delete', 'add', 'remove', 'reorder', 'invented']) await controller.mutate(action, {});
  assert.equal(calls.execute.length, 0);
});

test('busy repeated clicks issue one write and one key; commands use the selected server revision', async t => {
  const write = deferred();
  const {controller, calls} = harness(t, {execute: () => write.promise});
  await opened(controller);
  const saving = controller.mutate('save', {title: 'Changed', revision: '999', top_ref: SECOND, request_key: id(999)});
  await controller.mutate('save', {title: 'Repeated'}); await controller.retryMutation();
  assert.equal(calls.execute.length, 1); assert.equal(calls.keys.length, 1);
  assert.deepEqual(calls.execute[0].command, {title: 'Changed', revision: '7', top_ref: FIRST, request_key: id(100)});
  write.resolve(receipt('save', calls.execute[0].command)); await saving;
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
  assert.equal(calls.list.length, 2); assert.equal(calls.read.length, 2);
});

test('uncertain failure retains an isolated exact command and key through an intervening newer detail read', async t => {
  let attempts = 0, currentRevision = '7';
  const {controller, calls} = harness(t, {
    read: ref => detail(ref, {revision: currentRevision}),
    execute: (action, command) => {if (++attempts === 1) throw new TypeError('Connection lost'); return receipt(action, command);},
  });
  await opened(controller);
  const input = {album_refs: [ALBUM]}; await controller.mutate('add', input);
  const original = structuredClone(calls.execute[0].command);
  assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
  input.album_refs.push(id(12));
  calls.execute[0].command.album_refs.push(id(13));
  currentRevision = '9'; await controller.open(FIRST);
  await controller.mutate('save', {title: 'Must wait for the unresolved write'});
  assert.equal(calls.execute.length, 1);
  await controller.retryMutation();
  assert.equal(calls.execute.length, 2); assert.equal(calls.keys.length, 1);
  assert.deepEqual(calls.execute[1].command, original);
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
});

test('server failures retain uncertainty while a definitive revision conflict never silently rebases or retries', async t => {
  for (const status of [500, 503, 409, 422]) {
    const {controller, calls} = harness(t, {execute: () => {throw httpError(status, 'stale_revision');}});
    await opened(controller); await controller.mutate('save', {title: 'Authored change'});
    assert.equal(calls.execute.length, 1);
    assert.ok(controller.getSnapshot().mutation.error);
    if (status >= 500) {
      assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
      await controller.mutate('delete'); assert.equal(calls.execute.length, 1);
    } else {
      assert.equal(controller.getSnapshot().mutation.status, 'error');
      await controller.retryMutation(); assert.equal(calls.execute.length, 1);
      await controller.mutate('save', {title: 'Explicit second attempt'});
      assert.equal(calls.execute.length, 2);
      assert.equal(calls.execute[1].command.revision, '7');
      assert.notEqual(calls.execute[0].command.request_key, calls.execute[1].command.request_key);
    }
  }
});

test('acknowledgement survives a follow-up read failure and never offers a duplicate write retry', async t => {
  let acknowledged = false;
  const {controller, calls} = harness(t, {
    read: ref => {if (acknowledged) throw httpError(503); return detail(ref);},
    execute: (action, command) => {acknowledged = true; return receipt(action, command);},
  });
  await opened(controller); await controller.mutate('save', {title: 'Changed'});
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
  assert.equal(controller.getSnapshot().detail.status, 'error');
  await controller.retryMutation(); assert.equal(calls.execute.length, 1);
});

test('write acknowledgements do not override a newer Top or directory navigation', async t => {
  for (const destination of [SECOND, null]) {
    const write = deferred();
    const {controller, calls} = harness(t, {execute: () => write.promise});
    await opened(controller);
    const saving = controller.mutate('save', {title: 'Changed'});
    await controller.open(destination);
    write.resolve(receipt('save', calls.execute[0].command)); await saving;
    assert.equal(controller.getSnapshot().selectedTopRef, destination);
    assert.equal(controller.getSnapshot().detail.data?.top_ref || null, destination);
    assert.equal(calls.read.filter(call => call.ref === FIRST).length, 1);
  }
});

test('acknowledged delete returns to the directory without rereading the deleted Top', async t => {
  const {controller, calls} = harness(t);
  await opened(controller); await controller.mutate('delete');
  assert.equal(controller.getSnapshot().selectedTopRef, null);
  assert.equal(controller.getSnapshot().detail.data, null);
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
  assert.equal(calls.list.length, 2); assert.equal(calls.read.length, 1);
  assert.deepEqual(calls.execute[0].command, {top_ref: FIRST, revision: '7', request_key: id(100)});
});

test('scope replacement aborts reads and writes and discards late acknowledgements without refresh', async t => {
  let waiting = false;
  const list = deferred(), read = deferred(), write = deferred();
  const {controller, calls} = harness(t, {
    list: () => waiting ? list.promise : directory(),
    read: ref => waiting ? read.promise : detail(ref), execute: () => write.promise,
  });
  await opened(controller); waiting = true;
  const saving = controller.mutate('save', {title: 'Old actor'});
  const loading = controller.load(), opening = controller.open(SECOND);
  controller.setScope('top-client:other-actor:library');
  assert.equal(calls.list.at(-1).signal.aborted, true);
  assert.equal(calls.read.at(-1).options.signal.aborted, true);
  assert.equal(calls.execute[0].options.signal.aborted, true);
  clearPrivateState(controller.getSnapshot());
  write.resolve(receipt('save', calls.execute[0].command)); list.resolve(directory()); read.resolve(detail(SECOND));
  await Promise.all([saving, loading, opening]);
  assert.equal(controller.getSnapshot().scopeKey, 'top-client:other-actor:library');
  clearPrivateState(controller.getSnapshot());
  assert.equal(calls.list.length, 2); assert.equal(calls.read.length, 2);
  await controller.retryMutation(); assert.equal(calls.execute.length, 1);
});

test('scope removal and disposal erase private facts, abort pending work and prevent revival', async t => {
  for (const dispose of [false, true]) {
    const write = deferred();
    const {controller, calls} = harness(t, {execute: () => write.promise});
    await opened(controller); const saving = controller.mutate('delete');
    if (dispose) controller.dispose(); else controller.setScope(null);
    clearPrivateState(controller.getSnapshot());
    assert.equal(controller.getSnapshot().scopeKey, null);
    assert.equal(calls.execute[0].options.signal.aborted, true);
    write.resolve(receipt('delete', calls.execute[0].command)); await saving;
    await controller.load(); await controller.open(FIRST); await controller.retryMutation();
    assert.equal(calls.list.length, 1); assert.equal(calls.read.length, 1); assert.equal(calls.execute.length, 1);
    if (dispose) {controller.setScope(SCOPE); assert.equal(controller.getSnapshot().scopeKey, null);}
  }
});

test('subscriptions observe current snapshots and unsubscribe or disposal stops notifications', async t => {
  const {controller} = harness(t); const snapshots = [];
  const unsubscribe = controller.subscribe(() => snapshots.push(controller.getSnapshot()));
  await controller.load(); assert.ok(snapshots.length >= 2);
  assert.equal(snapshots.at(-1), controller.getSnapshot());
  unsubscribe(); const count = snapshots.length;
  await controller.open(FIRST); assert.equal(snapshots.length, count);
  controller.subscribe(() => snapshots.push(controller.getSnapshot())); controller.dispose();
  const afterDispose = snapshots.length; await controller.load(); assert.equal(snapshots.length, afterDispose);
});

function backend(t, handler, options = {}) {
  const calls = []; let liveContext = contextRef, liveScope = SCOPE;
  const transport = {
    context: () => liveContext,
    request(path, requestOptions) {calls.push({path, options: requestOptions}); return handler(path, requestOptions, calls.length);},
  };
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: scope => scope === liveScope});
  t.after(() => providers.dispose());
  return {providers, calls, options: {scopeKey: SCOPE, signal: new AbortController().signal, ...options},
    changeContext: () => {liveContext = 'b'.repeat(64);}, changeScope: () => {liveScope = 'other';}};
}
const envelope = data => ({status: 'ready', data, context_ref: contextRef});

test('backend adapter maps production item columns and drops non-allowlisted private fields', async t => {
  const raw = detail(FIRST, {path: '/private/top', items: [{ref: ITEM, catalog_ref: ALBUM,
    title: 'Catalog title', artist_display: 'Catalog artist', release_year: 2001,
    original_position: 3, curator_position: 1, local_path: '/private/music', private_rating: 5}]});
  const {providers, calls, options} = backend(t, () => envelope(raw));
  const result = await providers.read(FIRST, options);
  assert.equal(result.top_ref, FIRST);
  assert.deepEqual(result.items, [{item_ref: ITEM, album_ref: ALBUM, title: 'Catalog title', artist: 'Catalog artist',
    year: 2001, original_position: 3, position: 1}]);
  assert.doesNotMatch(JSON.stringify(result), /private\/|local_path|private_rating|"path"/);
  assert.equal(calls[0].path, `/album-tops/${FIRST}`);
  assert.equal(calls[0].options.expected, contextRef);
  assert.equal(calls[0].options.signal, options.signal);
});

test('backend adapter collects every directory page without duplicating identities', async t => {
  const {providers, calls, options} = backend(t, (_path, _options, index) => envelope(directory(index === 1
    ? {tops: [top(FIRST)], next_cursor: 'page:two/+'} : {tops: [top(SECOND)]})));
  const result = await providers.list(options);
  assert.deepEqual(result.tops.map(row => row.top_ref), [FIRST, SECOND]);
  assert.equal(result.next_cursor, null);
  assert.deepEqual(calls.map(call => call.path), ['/album-tops?limit=100', '/album-tops?limit=100&cursor=page%3Atwo%2F%2B']);
  const duplicate = backend(t, (_path, _options, index) => envelope(directory({next_cursor: index === 1 ? 'again' : null})));
  await assert.rejects(duplicate.providers.list(duplicate.options));
});

test('backend adapter rejects repeated pagination cursors including cycles with empty pages', async t => {
  for (const cursors of [['same', 'same'], ['first', 'second', 'first']]) {
    const {providers, calls, options} = backend(t, (_path, _options, index) => {
      if (index > cursors.length) throw new Error('Unexpected request beyond repeated cursor');
      return envelope(directory({tops: [], next_cursor: cursors[index - 1]}));
    });
    await assert.rejects(providers.list(options));
    assert.equal(calls.length, cursors.length, 'a repeated cursor must stop before another request');
  }
});

test('backend adapter binds requests to the exact live scope and context before and after transport', async t => {
  for (const change of ['changeContext', 'changeScope']) {
    const response = deferred(); const fixture = backend(t, () => response.promise);
    const reading = fixture.providers.read(FIRST, fixture.options);
    fixture[change](); response.resolve(envelope(detail()));
    await assert.rejects(reading);
  }
  const fixture = backend(t, () => envelope(directory())); fixture.changeScope();
  await assert.rejects(fixture.providers.list(fixture.options)); assert.equal(fixture.calls.length, 0);
  const aborted = new AbortController(); aborted.abort();
  const cancelled = backend(t, () => envelope(directory()), {signal: aborted.signal});
  await assert.rejects(cancelled.providers.list(cancelled.options)); assert.equal(cancelled.calls.length, 0);
});

test('backend adapter sends the exact replay body with top identity only in the route', async t => {
  const command = {top_ref: FIRST, revision: '7', request_key: id(101), album_refs: [ALBUM]};
  const {providers, calls, options} = backend(t, () => envelope(receipt('add', command)));
  await providers.execute('add', command, options); await providers.execute('add', command, options);
  assert.equal(calls[0].path, `/album-tops/${FIRST}/add`);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.body, {revision: '7', request_key: id(101), album_refs: [ALBUM]});
  assert.deepEqual(calls[1].options.body, calls[0].options.body);
  assert.equal(command.top_ref, FIRST);
});

test('malformed or mismatched write acknowledgement remains uncertain and blocks a new key', async t => {
  const badResponses = [
    () => null,
    () => ({status: 'ready', data: null, context_ref: contextRef}),
    command => envelope(receipt('save', command, {request_key: id(999)})),
    command => envelope(receipt('save', command, {top_ref: SECOND})),
    command => envelope(receipt('save', command, {action: 'delete'})),
    command => ({...envelope(receipt('save', command)), context_ref: 'c'.repeat(64)}),
  ];
  for (const badResponse of badResponses) {
    let writes = 0;
    const fixture = backend(t, (path, options) => {
      if (options.method === 'POST') {writes++; return badResponse({...options.body, top_ref: FIRST});}
      return envelope(path.startsWith('/album-tops?') ? directory() : detail());
    });
    const controller = createAlbumTopController({providers: fixture.providers, requestKey: () => id(100)});
    t.after(() => controller.dispose()); controller.setScope(SCOPE); await opened(controller);
    await controller.mutate('save', {title: 'Changed'});
    assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
    assert.equal(controller.getSnapshot().mutation.command.request_key, id(100));
    await controller.mutate('delete'); assert.equal(writes, 1);
  }
});

test('write authentication and permission denials retire all Top authority and invalidate outstanding reads', async t => {
  for (const status of [401, 403]) {
    const write = deferred(), list = deferred(), read = deferred();
    let pendingReads = false;
    const {controller, calls} = harness(t, {
      list: () => pendingReads ? list.promise : directory(),
      read: ref => pendingReads ? read.promise : detail(ref),
      execute: () => write.promise,
    });
    await opened(controller);
    const saving = controller.mutate('save', {title: 'Must not survive denied authority'});
    pendingReads = true;
    const loading = controller.load(), opening = controller.open(FIRST);
    const listSignal = calls.list.at(-1).signal, readSignal = calls.read.at(-1).options.signal;
    write.reject(httpError(status)); await saving;
    assert.equal(controller.getSnapshot().mutation.status, 'denied');
    assert.equal(controller.getSnapshot().directory.status, 'denied');
    assert.equal(controller.getSnapshot().detail.status, 'denied');
    assert.equal(controller.getSnapshot().directory.data, null);
    assert.equal(controller.getSnapshot().detail.data, null);
    assert.equal(listSignal.aborted, true);
    assert.equal(readSignal.aborted, true);
    list.resolve(directory()); read.resolve(detail());
    await loading; await opening;
    assert.equal(controller.getSnapshot().directory.data, null);
    assert.equal(controller.getSnapshot().detail.data, null);
    await controller.mutate('create', {title: 'Denied create', album_refs: []});
    await controller.mutate('save', {title: 'Denied save'});
    await controller.retryMutation();
    assert.equal(calls.execute.length, 1);
    assert.equal(calls.keys.length, 1);
  }
});

test('a confirmed write remains busy through both deferred authoritative refreshes without allowing another operation', async t => {
  const list = deferred(), read = deferred(), refreshEntered = deferred();
  let refreshing = false;
  const {controller, calls} = harness(t, {
    list: () => refreshing ? list.promise : directory(),
    read: ref => {if (refreshing) {refreshEntered.resolve(); return read.promise;} return detail(ref);},
    execute: (action, command) => {refreshing = true; return receipt(action, command);},
  });
  await opened(controller);
  const saving = controller.mutate('save', {title: 'Confirmed once'});
  await refreshEntered.promise;
  const acknowledged = controller.getSnapshot().mutation;
  assert.equal(acknowledged.status, 'ready');
  assert.equal(acknowledged.refreshing, true);
  assert.equal(acknowledged.data.request_key, calls.execute[0].command.request_key);
  await controller.mutate('delete'); await controller.retryMutation();
  assert.equal(calls.execute.length, 1);
  list.resolve(directory()); await Promise.resolve();
  assert.equal(controller.getSnapshot().mutation.refreshing, true);
  read.resolve(detail(FIRST, {revision: '8'})); await saving;
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
  assert.equal(controller.getSnapshot().mutation.refreshing, false);
  assert.deepEqual(controller.getSnapshot().mutation.data, acknowledged.data);
  assert.equal(controller.getSnapshot().detail.data.revision, '8');
});
