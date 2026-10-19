/* Shared authenticated transport. Context is continuity, never authorization. */
function createPrivateUITransport({root = null, accountGoals = false} = {}) {
  if (typeof accountGoals !== 'boolean') throw new TypeError('Invalid private transport scope.');
  const stamp = () => (root || document.getElementById('app-shell'))?.dataset?.[accountGoals ? 'accountGoalsContext' : 'privateUiContext'] || '';
  const listeners = new Set();
  let current = stamp(), generation = 0, blocked = false, disposed = false;
  function notify() {
    for (const listener of [...listeners]) {
      if (accountGoals) {try {listener();} catch { /* One consumer cannot prevent privacy retirement. */ }}
      else listener();
    }
  }
  function invalidate() {if (!blocked) {blocked = true; generation++; notify();}}
  function sync() {
    const next = stamp();
    if (disposed || next === current) return;
    if (accountGoals) {invalidate(); return;}
    current = next; blocked = false; generation++; notify();
  }
  const observedRoot = root || document.getElementById('app-shell');
  const observer = observedRoot && typeof MutationObserver === 'function' ? new MutationObserver(sync) : null;
  observer?.observe(observedRoot, {attributes: true, attributeFilter: [accountGoals ? 'data-account-goals-context' : 'data-private-ui-context']});
  const failure = (message, status, code) => Object.assign(new Error(message), {status, code});
  const abort = () => Object.assign(new Error('Private interface request was superseded.'), {name: 'AbortError'});
  function context() {
    sync();
    const value = stamp();
    if (disposed || blocked || !/^[a-f0-9]{64}$/.test(value)) throw failure('Reload to restore this session.', 409, 'stale_context');
    return value;
  }
  function accept(payload, expected = context()) {
    if (disposed || accountGoals && blocked || stamp() !== expected) throw abort();
    if (payload?.context_ref !== expected || accountGoals && payload?.context_scope !== 'account-goals-v1') {
      invalidate();
      throw failure('Reload to restore this session.', 409, 'stale_context');
    }
    return payload;
  }
  async function request(path, {method = 'GET', body, signal, expected = context(), isCurrent} = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20\x7f]/.test(path)) throw failure('Invalid private request.', 400);
    // Undefined is the ordinary legacy path, including rejected-await behavior.
    // Opted-in callers own their epoch; context equality cannot infer that epoch.
    const guarded = isCurrent !== undefined;
    const assertCurrent = () => {
      if (disposed || accountGoals && blocked || signal?.aborted || stamp() !== expected) throw abort();
      if (!guarded) return;
      let current = false;
      try {current = typeof isCurrent === 'function' && isCurrent() === true;} catch { /* Retired caller. */ }
      // The caller itself can synchronously retire a signal or change context.
      if (!current || disposed || accountGoals && blocked || signal?.aborted || stamp() !== expected) throw abort();
    };
    assertCurrent();
    const options = {method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: {Accept: 'application/json', [accountGoals ? 'X-AlbumHaven-Account-Context' : 'X-AlbumHaven-Context']: expected,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})};
    if (guarded) assertCurrent();
    let response;
    try {response = await fetch(path, options);} catch (error) {
      if (guarded) assertCurrent();
      throw error;
    }
    assertCurrent();
    if (accountGoals && [401, 403].includes(response.status)) {
      // A login/denial body may be HTML or fail to decode. Retire private owners
      // on the authenticated HTTP result before attempting any body work.
      const error = Object.assign(failure('The request could not be completed.', response.status, 'forbidden'), {responseRejected: true});
      invalidate(); throw error;
    }
    let payload;
    try {payload = await response.json();} catch (error) {
      if (guarded) assertCurrent();
      throw error;
    }
    assertCurrent();
    if (!response.ok) {
      const structuredCode = payload?.error_code;
      const code = typeof structuredCode === 'string' && structuredCode.length ? structuredCode : payload?.error;
      const error = Object.assign(failure('The request could not be completed.', response.status, code), {responseRejected: true});
      if (guarded) assertCurrent();
      if (accountGoals && ([401, 403].includes(response.status) || code === 'stale_context')) invalidate();
      throw error;
    }
    // Deliberately outside rejected-I/O catches: accept can revoke continuity,
    // retire this caller through generation listeners, and throw stale_context.
    // That current policy failure must remain its original 409, not AbortError.
    const accepted = accept(payload, expected);
    if (guarded) assertCurrent();
    return accepted;
  }
  // Remote preparation statuses are an explicit, closed transport capability.
  // The ordinary request function above intentionally keeps its legacy behavior.
  function remoteOperation(path, method) {
    if (accountGoals || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || /[\\\x00-\x20\x7f]/.test(path)) return null;
    if (path === '/album-top-catalog/remote-preparations') {
      if (method === 'POST') return 'begin';
      if (method === 'GET') return 'status';
    }
    if (method !== 'POST') return null;
    if (path === '/album-top-catalog/remote-preparations/maintain') return 'maintain';
    if (/^\/album-top-catalog\/remote-preparations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/close$/.test(path)) return 'close';
    if (path === '/album-top-catalog/remote-search') return 'search';
    if (path === '/album-top-catalog/remote-acquisitions') return 'acquire';
    return null;
  }
  async function requestAlbumTopRemote(path, {method = 'GET', body, signal,
    expected = context(), expectedGeneration, isCurrent} = {}) {
    const operation = remoteOperation(path, method);
    if (!operation) throw failure('Invalid Album Top remote request.', 400);
    sync();
    const requestGeneration = expectedGeneration === undefined ? generation : expectedGeneration;
    const sameGeneration = () => !disposed && !blocked && generation === requestGeneration
      && Number.isSafeInteger(requestGeneration) && requestGeneration >= 0
      && typeof expected === 'string' && expected.length === 64 && /^[a-f0-9]{64}$/.test(expected)
      && current === expected && stamp() === expected;
    const assertCurrent = () => {
      if (!sameGeneration() || signal?.aborted) throw abort();
      if (isCurrent === undefined) return;
      let live = false;
      try {live = typeof isCurrent === 'function' && isCurrent() === true;} catch { /* Retired caller. */ }
      if (!live || !sameGeneration() || signal?.aborted) throw abort();
    };
    const retire = () => {
      if (!sameGeneration()) return;
      // Retire this exact transport generation before notifying reentrant owners.
      // A throwing subscriber must neither hide denial nor skip other owners.
      blocked = true; generation++;
      for (const listener of [...listeners]) {
        try {listener();} catch { /* Privacy retirement is already committed. */ }
      }
    };
    assertCurrent();
    const options = {method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: {Accept: 'application/json', 'X-AlbumHaven-Context': expected,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})};
    // JSON serialization can synchronously dispose the caller or change actor.
    assertCurrent();
    let response;
    try {response = await fetch(path, options);} catch (error) {
      assertCurrent(); throw error;
    }
    const status = response.status;
    if (status === 401 || status === 403) {
      // Actual consumed denial belongs to the actor/context generation, even
      // when a newer form request superseded or physically aborted this one.
      if (!sameGeneration()) throw abort();
      const error = Object.assign(failure('The request could not be completed.', status, 'forbidden'), {responseRejected: true});
      retire(); throw error;
    }
    assertCurrent();
    let payload;
    try {payload = await response.json();} catch (error) {
      assertCurrent(); throw error;
    }
    assertCurrent();
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const ready = record(payload) && payload.status === 'ready' && record(payload.data);
    const data = ready ? payload.data : null;
    const capacityOperation = operation === 'begin' || operation === 'acquire';
    const stateResponse = data?.version === 2 && (
      operation === 'acquire' && status === 202 && data.state === 'in_flight'
      || capacityOperation && status === 409 && data.state === 'maintenance_required'
        && data.error === 'remote_preparation_maintenance_required'
      || capacityOperation && status === 429 && data.state === 'limit' && data.error === 'remote_acquisition_limit'
      || operation === 'acquire' && status === 503 && data.state === 'failed'
        && ['provider_unavailable', 'invalid_provider_metadata', 'provider_identity_changed'].includes(data.error));
    if (!response.ok && !stateResponse) {
      const structuredCode = payload?.error_code;
      const code = typeof structuredCode === 'string' && structuredCode.length ? structuredCode
        : payload?.error ?? (ready ? data.error_code ?? data.error : undefined);
      const error = Object.assign(failure('The request could not be completed.', status, code), {responseRejected: true});
      if (code === 'stale_context') retire();
      throw error;
    }
    const ordinaryReady = status === 200 && !['in_flight', 'maintenance_required', 'limit', 'failed'].includes(data?.state);
    if (!ready || !ordinaryReady && !stateResponse) throw failure('Album Top remote response was not acknowledged.', 502);
    if (payload.context_ref !== expected || data.context_ref !== expected) {
      retire(); throw failure('Reload to restore this session.', 409, 'stale_context');
    }
    // State/identity/capacity projection remains with the exact remote provider.
    assertCurrent();
    return payload;
  }
  const query = (path, values) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) params.set(key, String(value));
    return `${path}?${params}`;
  };
  return Object.freeze({context, accept, request, requestAlbumTopRemote, query, invalidate,
    dispose() {if (disposed) return; disposed = true; observer?.disconnect(); invalidate(); listeners.clear();},
    generation: () => {sync(); return generation;}, subscribe(listener) {if (disposed) throw abort(); listeners.add(listener); return () => listeners.delete(listener);}});
}
const PrivateUITransport = createPrivateUITransport();
window.AlbumHavenPrivateUITransport = PrivateUITransport;
window.createAlbumHavenPrivateUITransport = createPrivateUITransport;
