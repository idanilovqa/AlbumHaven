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
  async function request(path, {method = 'GET', body, signal, expected = context()} = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20\x7f]/.test(path)) throw failure('Invalid private request.', 400);
    if (signal?.aborted || stamp() !== expected) throw abort();
    const response = await fetch(path, {method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: {Accept: 'application/json', 'X-AlbumHaven-Context': expected,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    if (signal?.aborted || stamp() !== expected) throw abort();
    const payload = await response.json();
    if (signal?.aborted || stamp() !== expected) throw abort();
    if (!response.ok) throw Object.assign(failure('The request could not be completed.', response.status, payload?.error), {responseRejected: true});
    return accept(payload, expected);
  }
  const query = (path, values) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) params.set(key, String(value));
    return `${path}?${params}`;
  };
  return Object.freeze({context, accept, request, query, generation: () => {sync(); return generation;}, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);}});
})();
window.AlbumHavenPrivateUITransport = PrivateUITransport;
