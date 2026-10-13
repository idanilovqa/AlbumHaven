/* Shared authenticated transport. Context is continuity, never authorization. */
const PrivateUITransport = (() => {
  const stamp = () => document.getElementById('app-shell')?.dataset?.privateUiContext || '';
  const listeners = new Set();
  let current = stamp(), generation = 0, blocked = false;
  function sync() {
    const next = stamp();
    if (next === current) return;
    current = next; blocked = false; generation++;
    for (const listener of [...listeners]) listener();
  }
  const shell = document.getElementById('app-shell');
  if (shell && typeof MutationObserver === 'function') new MutationObserver(sync).observe(shell,
    {attributes: true, attributeFilter: ['data-private-ui-context']});
  const failure = (message, status, code) => Object.assign(new Error(message), {status, code});
  const abort = () => Object.assign(new Error('Private interface request was superseded.'), {name: 'AbortError'});
  function context() {
    sync();
    const value = stamp();
    if (blocked || !/^[a-f0-9]{64}$/.test(value)) throw failure('Reload to restore this session.', 409, 'stale_context');
    return value;
  }
  function accept(payload, expected = context()) {
    if (stamp() !== expected) throw abort();
    if (payload?.context_ref !== expected) {
      if (!blocked) {blocked = true; generation++; for (const listener of [...listeners]) listener();}
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
      if (signal?.aborted || stamp() !== expected) throw abort();
      if (!guarded) return;
      let current = false;
      try {current = typeof isCurrent === 'function' && isCurrent() === true;} catch { /* Retired caller. */ }
      // The caller itself can synchronously retire a signal or change context.
      if (!current || signal?.aborted || stamp() !== expected) throw abort();
    };
    assertCurrent();
    const options = {method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: {Accept: 'application/json', 'X-AlbumHaven-Context': expected,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})};
    if (guarded) assertCurrent();
    let response;
    try {response = await fetch(path, options);} catch (error) {
      if (guarded) assertCurrent();
      throw error;
    }
    assertCurrent();
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
  return Object.freeze({context, accept, request, query, generation: () => {sync(); return generation;}, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);}});
})();
window.AlbumHavenPrivateUITransport = PrivateUITransport;
