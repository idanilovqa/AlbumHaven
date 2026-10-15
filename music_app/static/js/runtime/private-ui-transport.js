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
  const query = (path, values) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) params.set(key, String(value));
    return `${path}?${params}`;
  };
  return Object.freeze({context, accept, request, query, invalidate,
    dispose() {if (disposed) return; disposed = true; observer?.disconnect(); invalidate(); listeners.clear();},
    generation: () => {sync(); return generation;}, subscribe(listener) {if (disposed) throw abort(); listeners.add(listener); return () => listeners.delete(listener);}});
}
const PrivateUITransport = createPrivateUITransport();
window.AlbumHavenPrivateUITransport = PrivateUITransport;
window.createAlbumHavenPrivateUITransport = createPrivateUITransport;
