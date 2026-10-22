const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/private-ui-transport.js'), 'utf8');
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const REF = '10000000-0000-4000-8000-000000000001';
const PREPARATIONS = '/album-top-catalog/remote-preparations';
const ACQUISITIONS = '/album-top-catalog/remote-acquisitions';
const SEARCH = '/album-top-catalog/remote-search';
const ROUTES = [
  [PREPARATIONS, 'POST'], [PREPARATIONS, 'GET'],
  [PREPARATIONS + '/maintain', 'POST'], [PREPARATIONS + '/' + REF + '/close', 'POST'],
  [SEARCH, 'POST'], [ACQUISITIONS, 'POST'],
];
const envelope = (data = {}, context = A) => ({status: 'ready', context_ref: context,
  data: {context_ref: context, ...data}});
const response = (status, payload) => ({status, ok: status >= 200 && status < 300, json: async () => payload});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function setup({accountGoals = false} = {}) {
  const shell = {dataset: {privateUiContext: A, accountGoalsContext: A}}, calls = [];
  let respond = async () => response(200, envelope());
  const window = {};
  vm.runInNewContext(source, {window, document: {getElementById: () => shell}, URLSearchParams,
    fetch: async (...args) => {calls.push(args); return respond(...args);}});
  const api = accountGoals ? window.createAlbumHavenPrivateUITransport({root: shell, accountGoals: true})
    : window.AlbumHavenPrivateUITransport;
  return {api, shell, calls, setResponse: fn => {respond = fn;},
    setContext(value) {shell.dataset[accountGoals ? 'accountGoalsContext' : 'privateUiContext'] = value; return api.generation();}};
}
const remote = (env, options = {}) => env.api.requestAlbumTopRemote(ACQUISITIONS, {method: 'POST', body: {}, ...options});
const rejected = (status, code) => error => error.status === status && error.code === code && error.responseRejected === true;
const aborted = error => error.name === 'AbortError' && error.responseRejected !== true;
const unacknowledged = error => error.status === 502 && error.responseRejected !== true;
function capacity() {
  return {legacy_initialized: true, legacy_inspected: 0, counts_complete: true,
    actor_pending_count: 0, actor_pending_bytes: 0, actor_reservations: 0, physical_parents: 0,
    actor_pending_slots_available: 512, actor_pending_bytes_available: 8388608,
    actor_reservation_slots_available: 2, physical_parent_slots_available: 32,
    attempt_slots_remaining: null, pending_slots_available: null, pending_bytes_available: null,
    reservation_slots_available: null, worst_case_new_acquisitions: 2};
}
const STATE_RESPONSES = [
  [202, {version: 2, state: 'in_flight', preparation_ref: REF, request_key: REF,
    destination: {kind: 'create', draft_ref: REF}, retry_after_seconds: 1}],
  [409, {version: 2, state: 'maintenance_required', resource: 'legacy_initialization',
    error: 'remote_preparation_maintenance_required', capacity: capacity()}],
  [429, {version: 2, state: 'limit', resource: 'parents', error: 'remote_acquisition_limit', capacity: capacity()}],
  [503, {version: 2, state: 'failed', preparation_ref: REF, request_key: REF,
    destination: {kind: 'create', draft_ref: REF}, error: 'provider_unavailable'}],
];

test('remote seam dispatches only the six explicit C2 route/method combinations', async () => {
  for (const [route, method] of ROUTES) {
    const env = setup(), payload = envelope();
    env.setResponse(async () => response(200, payload));
    const options = {method, expected: A, expectedGeneration: 0, isCurrent: () => true};
    if (method === 'POST') options.body = {marker: 'unchanged'};
    assert.equal(await env.api.requestAlbumTopRemote(route, options), payload);
    assert.equal(env.calls.length, 1);
    const [calledPath, sent] = env.calls[0];
    assert.equal(calledPath, route); assert.equal(sent.method, method);
    assert.equal(sent.credentials, 'same-origin'); assert.equal(sent.cache, 'no-store');
    assert.equal(sent.headers.Accept, 'application/json');
    assert.equal(sent.headers['X-AlbumHaven-Context'], A);
    assert.equal(sent.headers['X-AlbumHaven-Account-Context'], undefined);
    assert.equal(sent.body, method === 'POST' ? '{"marker":"unchanged"}' : undefined);
    assert.equal(sent.headers['Content-Type'], method === 'POST' ? 'application/json' : undefined);
  }
});

test('remote capability cannot be widened by path aliases, query, fragment, method or another scope', async () => {
  const invalid = [
    ['/album-tops', 'POST'], ['/home/activity', 'GET'], [PREPARATIONS + '/', 'POST'],
    [PREPARATIONS + '?', 'POST'], [PREPARATIONS + '?cursor=1', 'GET'], [ACQUISITIONS + '#x', 'POST'],
    ['https://example.test' + ACQUISITIONS, 'POST'], ['/' + ACQUISITIONS, 'POST'],
    [ACQUISITIONS + '/extra', 'POST'], [ACQUISITIONS.replace('remote', '%72emote'), 'POST'],
    [ACQUISITIONS + '\n', 'POST'], [ACQUISITIONS.replace('/remote', '/x/../remote'), 'POST'],
    [PREPARATIONS + '/maintain', 'GET'], [ACQUISITIONS, 'GET'], [SEARCH, 'HEAD'],
    [SEARCH, 'post'], [PREPARATIONS, 'DELETE'], [PREPARATIONS + '/not-a-uuid/close', 'POST'],
    [PREPARATIONS + '/' + REF.toUpperCase().replace('1000', 'ABCD') + '/close', 'POST'],
    [PREPARATIONS + '/' + REF + '/close?confirm=1', 'POST'],
    [PREPARATIONS + '/' + REF + '/close\n', 'POST'], [PREPARATIONS + '/' + REF + '/close\r', 'POST'],
  ];
  for (const [route, method] of invalid) {
    const env = setup();
    await assert.rejects(env.api.requestAlbumTopRemote(route, {method}), error => error.status === 400);
    assert.equal(env.calls.length, 0);
  }
  const account = setup({accountGoals: true});
  await assert.rejects(account.api.requestAlbumTopRemote(PREPARATIONS), error => error.status === 400);
  assert.equal(account.calls.length, 0); assert.equal(account.api.context(), A);
});

test('C2 acquisition state/status pairs are data only with explicit remote opt-in', async () => {
  for (const [status, data] of STATE_RESPONSES) {
    const env = setup(), payload = envelope(data);
    env.setResponse(async () => response(status, payload));
    assert.equal(await remote(env), payload);
    assert.equal(env.api.generation(), 0); assert.equal(env.api.context(), A);
  }
  for (const error of ['invalid_provider_metadata', 'provider_identity_changed']) {
    const env = setup(), payload = envelope({version: 2, state: 'failed', error});
    env.setResponse(async () => response(503, payload));
    assert.equal(await remote(env), payload);
  }
});

test('begin admits maintenance and capacity refusal but never attempt-only statuses', async () => {
  for (const [status, data] of STATE_RESPONSES) {
    const env = setup(), payload = envelope(data);
    env.setResponse(async () => response(status, payload));
    const pending = env.api.requestAlbumTopRemote(PREPARATIONS, {method: 'POST', body: {}});
    if (status === 409 || status === 429) assert.equal(await pending, payload);
    else await assert.rejects(pending, status === 202 ? unacknowledged : rejected(status, data.error));
  }
});

test('search, status, maintain and close never admit acquisition error status envelopes', async () => {
  for (const [route, method] of ROUTES.filter(([route, method]) => route !== ACQUISITIONS && !(route === PREPARATIONS && method === 'POST'))) {
    for (const [status, data] of STATE_RESPONSES) {
      const env = setup(); env.setResponse(async () => response(status, envelope(data)));
      await assert.rejects(env.api.requestAlbumTopRemote(route, {method}), status === 202 ? unacknowledged : rejected(status, data.error));
    }
  }
});

test('mismatched state/status, missing version and unknown refusal codes cannot become admitted data', async () => {
  const cases = [
    [409, {version: 2, state: 'limit', error: 'remote_acquisition_limit'}],
    [429, {version: 2, state: 'maintenance_required', error: 'remote_preparation_maintenance_required'}],
    [503, {version: 2, state: 'failed', error: 'provider_cancelled'}],
    [503, {version: 2, state: 'in_flight', error: 'remote_acquisition_unavailable'}],
    [409, {state: 'maintenance_required', error: 'remote_preparation_maintenance_required'}],
    [409, {version: 2, state: 'maintenance_required', error: 'other_refusal'}],
    [429, {version: 2, state: 'limit', error: 'other_limit'}],
  ];
  for (const [status, data] of cases) {
    const env = setup(); env.setResponse(async () => response(status, envelope(data)));
    await assert.rejects(remote(env), rejected(status, data.error));
    assert.equal(env.api.generation(), 0);
  }
  for (const [, data] of STATE_RESPONSES) {
    const env = setup(); env.setResponse(async () => response(200, envelope(data)));
    await assert.rejects(remote(env), unacknowledged);
  }
  for (const data of [{version: 1, state: 'in_flight'}, {version: 2, state: 'pending'}]) {
    const env = setup(); env.setResponse(async () => response(202, envelope(data)));
    await assert.rejects(remote(env), unacknowledged);
  }
});

test('every admitted status requires exact outer and inner context and retirement survives listener failure', async () => {
  for (const [status, data] of [[200, {}], ...STATE_RESPONSES]) {
    for (const part of ['outer', 'inner']) {
      for (const wrong of [undefined, B]) {
        const env = setup(), payload = envelope(data); let retired = 0;
        env.api.subscribe(() => {throw new Error('subscriber failure');});
        env.api.subscribe(() => retired++);
        if (part === 'outer') payload.context_ref = wrong; else payload.data.context_ref = wrong;
        env.setResponse(async () => response(status, payload));
        await assert.rejects(remote(env), error => error.status === 409 && error.code === 'stale_context' && error.name !== 'AbortError');
        assert.equal(retired, 1); assert.equal(env.api.generation(), 1);
        assert.throws(() => env.api.context(), error => error.code === 'stale_context');
      }
    }
  }
});

test('malformed success envelopes remain unacknowledged and do not invent observed rejection', async () => {
  for (const payload of [null, [], {}, {status: 'ready', context_ref: A, data: null},
    {status: 'ready', context_ref: A, data: []}, {status: 'pending', context_ref: A, data: {context_ref: A}}]) {
    const env = setup(); env.setResponse(async () => response(200, payload));
    await assert.rejects(remote(env), unacknowledged);
    assert.equal(env.api.generation(), 0);
  }
});

test('ordinary observed remote refusals retain exact HTTP status, structured error precedence and rejection provenance', async () => {
  const cases = [
    [400, {ok: false, error: 'invalid_command'}, 'invalid_command'],
    [409, {ok: false, error: 'remote_preparation_unavailable'}, 'remote_preparation_unavailable'],
    [409, {ok: false, error: 'remote_acquisition_version_required'}, 'remote_acquisition_version_required'],
    [413, {error: 'command_too_large'}, 'command_too_large'],
    [429, {error: 'rate_limited'}, 'rate_limited'],
    [503, {error: 'provider_cancelled'}, 'provider_cancelled'],
    [503, {error: 'fallback', error_code: 'specific'}, 'specific'],
    [503, {error: 'fallback', error_code: ''}, 'fallback'],
    [503, envelope({error_code: 'nested_specific', error: 'nested_fallback'}), 'nested_specific'],
    [500, {status: 'failed'}, undefined],
  ];
  for (const [status, payload, code] of cases) {
    const env = setup(); env.setResponse(async () => response(status, payload));
    await assert.rejects(remote(env), rejected(status, code));
    assert.equal(env.api.generation(), 0);
  }
});

test('observed stale_context rejection retires exactly once and preserves its original error', async () => {
  const env = setup(); let notifications = 0;
  env.api.subscribe(() => notifications++);
  env.setResponse(async () => response(409, {error: 'stale_context'}));
  await assert.rejects(remote(env), rejected(409, 'stale_context'));
  assert.equal(notifications, 1); assert.equal(env.api.generation(), 1);
  assert.throws(() => env.api.context(), error => error.code === 'stale_context');
});

test('transport and decoder failures remain the original unknown error when the invocation is live', async () => {
  for (const stage of ['fetch', 'json']) {
    const env = setup(), unknown = new TypeError(stage + ' unavailable');
    env.setResponse(stage === 'fetch' ? async () => {throw unknown;}
      : async () => ({status: 503, ok: false, json: async () => {throw unknown;}}));
    await assert.rejects(remote(env), error => error === unknown && error.responseRejected === undefined && error.status === undefined);
    assert.equal(env.api.generation(), 0); assert.equal(env.calls.length, 1);
  }
});

test('missing context, stale expected generation, aborted signal and retired form prevent remote dispatch', async () => {
  const checks = [
    env => {env.shell.dataset.privateUiContext = ''; return {};},
    env => {env.shell.dataset.privateUiContext = A + '\n'; return {};},
    () => ({expectedGeneration: 1}), () => ({expectedGeneration: -1}),
    () => ({expectedGeneration: NaN}), () => ({expectedGeneration: '0'}),
    () => ({expected: B}), () => ({isCurrent: () => false}),
    () => ({isCurrent: true}), () => ({isCurrent: () => {throw new Error('retired');}}),
    () => {const controller = new AbortController(); controller.abort(); return {signal: controller.signal};},
  ];
  for (const options of checks) {
    const env = setup();
    await assert.rejects(remote(env, options(env)));
    assert.equal(env.calls.length, 0);
  }
});

test('serialization and lifetime callbacks are fenced for synchronous reentry', async () => {
  for (const trigger of ['signal', 'context', 'dispose', 'callback']) {
    const env = setup(), controller = new AbortController();
    const body = {toJSON() {
      if (trigger === 'signal') controller.abort();
      if (trigger === 'context') env.setContext(B);
      if (trigger === 'dispose') env.api.dispose();
      return {value: 'do not send'};
    }};
    const options = {body, signal: controller.signal};
    if (trigger === 'callback') options.isCurrent = () => {env.setContext(B); return true;};
    await assert.rejects(remote(env, options), aborted);
    assert.equal(env.calls.length, 0);
  }
});

test('current and generation checks bracket both fetch and JSON awaits without retries', async () => {
  for (const stage of ['fetch', 'json']) {
    for (const action of ['supersede', 'abort', 'context', 'dispose']) {
      const env = setup(), gate = deferred(), entered = deferred(), controller = new AbortController();
      let live = true;
      env.setResponse(async () => {
        if (stage === 'fetch') {entered.resolve(); return gate.promise;}
        return {status: 200, ok: true, json: async () => {entered.resolve(); return gate.promise;}};
      });
      const pending = remote(env, {isCurrent: () => live, signal: controller.signal});
      const rejection = assert.rejects(pending, aborted);
      await entered.promise;
      if (action === 'supersede') live = false;
      if (action === 'abort') controller.abort();
      if (action === 'context') env.setContext(B);
      if (action === 'dispose') env.api.dispose();
      gate.resolve(stage === 'fetch' ? response(200, envelope()) : envelope());
      await rejection; assert.equal(env.calls.length, 1);
    }
  }
});

test('rejected fetch and decoder awaits also fence stale invocations', async () => {
  for (const stage of ['fetch', 'json']) {
    const env = setup(), gate = deferred(), entered = deferred(); let live = true;
    env.setResponse(async () => {
      if (stage === 'fetch') {entered.resolve(); return gate.promise;}
      return {status: 200, ok: true, json: async () => {entered.resolve(); return gate.promise;}};
    });
    const rejection = assert.rejects(remote(env, {isCurrent: () => live}), aborted);
    await entered.promise; live = false; gate.reject(new TypeError('unknown I/O failure'));
    await rejection; assert.equal(env.calls.length, 1);
  }
});

test('401 and 403 retire on consumed status before body decoding, even when the old request is superseded and aborted', async () => {
  for (const status of [401, 403]) {
    const env = setup(), gate = deferred(), entered = deferred(), controller = new AbortController();
    let oldLive = true, notifications = 0, decoded = 0;
    env.api.subscribe(() => {throw new Error('observer must not hide denial');});
    env.api.subscribe(() => notifications++);
    env.setResponse(async () => {entered.resolve(); return gate.promise;});
    const denial = assert.rejects(remote(env, {signal: controller.signal, isCurrent: () => oldLive}), rejected(status, 'forbidden'));
    await entered.promise;
    oldLive = false; controller.abort();
    env.setResponse(async () => response(200, envelope({newer: true})));
    assert.equal((await remote(env)).data.newer, true);
    gate.resolve({status, ok: false, json: async () => {decoded++; throw new SyntaxError('HTML sign-in body');}});
    await denial;
    assert.equal(decoded, 0); assert.equal(notifications, 1); assert.equal(env.api.generation(), 1);
    assert.throws(() => env.api.context(), error => error.code === 'stale_context');
  }
});

test('consumed denial retires an in-progress newer request in the same context generation', async () => {
  const env = setup(), oldGate = deferred(), newGate = deferred(); let calls = 0, oldLive = true;
  env.setResponse(async () => ++calls === 1 ? oldGate.promise : newGate.promise);
  const denial = assert.rejects(remote(env, {isCurrent: () => oldLive}), rejected(403, 'forbidden'));
  oldLive = false;
  const newer = assert.rejects(remote(env), aborted);
  oldGate.resolve({status: 403, ok: false, json: async () => {throw new Error('not decoded');}});
  await denial; newGate.resolve(response(200, envelope())); await newer;
  assert.equal(env.api.generation(), 1); assert.equal(env.calls.length, 2);
});

test('old actor and ABA generation denial cannot poison the later session', async () => {
  for (const laterContext of [B, A]) {
    for (const status of [401, 403]) {
      const env = setup(), gate = deferred(), entered = deferred();
      env.setResponse(async () => {entered.resolve(); return gate.promise;});
      const retired = assert.rejects(remote(env, {expected: A, expectedGeneration: 0}), aborted);
      await entered.promise;
      env.setContext(B); if (laterContext === A) env.setContext(A);
      const generation = env.api.generation();
      gate.resolve({status, ok: false, json: async () => {throw new Error('not decoded');}});
      await retired;
      assert.equal(env.api.generation(), generation); assert.equal(env.api.context(), laterContext);
      env.setResponse(async () => response(200, envelope({}, laterContext)));
      await remote(env, {expected: laterContext, expectedGeneration: generation});
    }
  }
});

test('ABA before dispatch or during a success body cannot revive an earlier generation', async () => {
  const before = setup(); before.setContext(B); before.setContext(A);
  await assert.rejects(remote(before, {expected: A, expectedGeneration: 0}), aborted);
  assert.equal(before.calls.length, 0);
  const env = setup(), gate = deferred(), entered = deferred();
  env.setResponse(async () => ({status: 200, ok: true, json: async () => {entered.resolve(); return gate.promise;}}));
  const retired = assert.rejects(remote(env, {expected: A, expectedGeneration: 0}), aborted);
  await entered.promise; env.setContext(B); env.setContext(A); gate.resolve(envelope());
  await retired; assert.equal(env.api.context(), A); assert.equal(env.api.generation(), 2);
});

test('denial retirement callbacks may establish a new context without poisoning it', async () => {
  const env = setup(); let notifications = 0;
  env.api.subscribe(() => {notifications++; if (env.shell.dataset.privateUiContext === A) env.setContext(B);});
  env.setResponse(async () => ({status: 401, ok: false, json: async () => {throw new Error('not decoded');}}));
  await assert.rejects(remote(env), rejected(401, 'forbidden'));
  assert.equal(env.api.context(), B); assert.equal(env.api.generation(), 2); assert.equal(notifications, 2);
  env.setResponse(async () => response(200, envelope({}, B)));
  await remote(env, {expected: B, expectedGeneration: 2});
});

test('ordinary and account-goals transports retain request bytes, headers and existing response rules', async () => {
  for (const accountGoals of [false, true]) {
    const env = setup({accountGoals}), controller = new AbortController();
    const payload = {context_ref: A, ...(accountGoals ? {context_scope: 'account-goals-v1'} : {}), value: 7};
    env.setResponse(async () => response(200, payload));
    assert.equal(await env.api.request('/ordinary?x=1', {method: 'POST', signal: controller.signal,
      body: {text: 'é', keep: null, omit: undefined}}), payload);
    const [url, options] = env.calls[0];
    assert.equal(url, '/ordinary?x=1'); assert.equal(options.method, 'POST');
    assert.equal(options.signal, controller.signal); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store'); assert.equal(options.body, '{"text":"é","keep":null}');
    assert.equal(JSON.stringify(options.headers), JSON.stringify({Accept: 'application/json',
      [accountGoals ? 'X-AlbumHaven-Account-Context' : 'X-AlbumHaven-Context']: A, 'Content-Type': 'application/json'}));
  }
  for (const [status, data] of STATE_RESPONSES.filter(([status]) => status !== 202)) {
    const env = setup(); env.setResponse(async () => response(status, envelope(data)));
    await assert.rejects(env.api.request(ACQUISITIONS, {method: 'POST', body: {}}), rejected(status, undefined));
    assert.equal(env.api.generation(), 0);
  }
  const ordinary = setup(), payload = {context_ref: A, legacy: true};
  ordinary.setResponse(async () => response(202, payload));
  assert.equal(await ordinary.api.request('/ordinary'), payload);
});

test('ordinary unguarded rejected fetch still preserves its original rejection after context change', async () => {
  const env = setup(), gate = deferred(), unknown = new TypeError('legacy disconnect');
  env.setResponse(async () => gate.promise);
  const pending = assert.rejects(env.api.request('/ordinary'), error => error === unknown);
  env.setContext(B); gate.reject(unknown); await pending;
});

test('ordinary authentication failure keeps existing behavior while account-goals retires before decoding', async () => {
  const ordinary = setup();
  ordinary.setResponse(async () => response(403, {error: 'specific_forbidden'}));
  await assert.rejects(ordinary.api.request('/ordinary'), rejected(403, 'specific_forbidden'));
  assert.equal(ordinary.api.context(), A); assert.equal(ordinary.api.generation(), 0);
  const account = setup({accountGoals: true}); let decoded = 0;
  account.setResponse(async () => ({status: 403, ok: false, json: async () => {decoded++; throw new Error('not decoded');}}));
  await assert.rejects(account.api.request('/account/goals'), rejected(403, 'forbidden'));
  assert.equal(decoded, 0); assert.equal(account.api.generation(), 1);
});
