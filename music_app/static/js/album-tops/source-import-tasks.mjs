import {createSourceImportController} from './source-import-controller.mjs';

const uuid = value => typeof value === 'string' && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const sameFeedReceipt = (captured, current) => Boolean(current && current.job_ref === captured.job_ref
  && current.request_key === captured.request_key && current.top_ref === captured.top_ref);
const labels = {queued: 'Waiting to process', running: 'Processing source', completed: 'Ready for review',
  failed: 'Source processing failed', canceled: 'Import canceled'};
const operations = {submit: ['Submitting source', 'Submission result unknown'],
  finalize: ['Saving Album Top', 'Save result unknown'], cancel: ['Canceling import', 'Cancellation result unknown'],
  read: ['Loading import', 'Action needs retry'], process: ['Processing source', 'Action needs retry']};

export function createSourceImportTasks({runtime, notifications, providers, onOpen, onDenied, key = () => crypto.randomUUID()}) {
  let disposed = false, owner = null, configured = providers, transition = 0;
  const listeners = new Set();
  const unavailable = () => Object.freeze({scopeKey: null, retainedCount: 0, capacity: 32, canCreate: false});
  let snapshot = unavailable();
  function current(token) {
    const shell = runtime.snapshot();
    return !disposed && owner === token && shell.authenticated === true && shell.scopeKey === token.scopeKey
      && (typeof runtime.acceptsPrivateScope !== 'function' || runtime.acceptsPrivateScope(token.scopeKey));
  }
  function publish() {
    const token = owner;
    snapshot = token && current(token) ? Object.freeze({scopeKey: token.scopeKey, retainedCount: token.entries.size,
      capacity: 32, canCreate: !token.denied && token.entries.size < 32}) : unavailable();
    const value = snapshot;
    for (const listener of [...listeners]) {if (snapshot !== value || disposed) break; listener();}
  }
  function remove(token, entry) {
    if (!token.entries.delete(entry.controller)) return;
    entry.unsubscribe(); entry.controller.dispose();
  }
  function retire() {
    const token = owner; owner = null;
    if (!token) return;
    token.request?.abort();
    for (const entry of [...token.entries.values()]) remove(token, entry);
    token.source?.dispose();
  }
  function collect(token) {
    for (const entry of [...token.entries.values()]) {
      if (entry.attached || entry.leases.size) continue;
      const state = entry.controller.getSnapshot();
      if (['loading', 'uncertain'].includes(state.status)) continue;
      const job = state.job, saved = state.result?.top_ref ?? job?.top_ref ?? null;
      const evidence = job && token.feed.get(job.job_ref);
      if (!job && (state.status === 'idle' || state.status === 'error' && state.error?.responseRejected === true)
          || evidence && evidence.request_key === job.request_key
            && (BigInt(evidence.revision) > BigInt(job.revision) && (!saved || evidence.top_ref === saved)
              || BigInt(evidence.revision) === BigInt(job.revision) && evidence.status === job.status
                && evidence.top_ref === saved)) remove(token, entry);
    }
  }
  function find(token, ref) {
    const requestKey = token.feed.get(ref)?.request_key;
    return [...token.entries.values()].find(entry => entry.ref === ref || entry.controller.getSnapshot().job?.job_ref === ref
      || requestKey && entry.key === requestKey);
  }
  function render(token) {
    if (!current(token) || !token.source) return;
    const records = new Map();
    for (const job of token.feed.values()) records.set(job.job_ref, {job_ref: job.job_ref, top_ref: job.top_ref,
      request_key: job.request_key, title: job.title, createdAt: job.created_at, byline: job.top_ref ? 'Album Top created' : labels[job.status],
      controller: find(token, job.job_ref)?.controller ?? null});
    for (const entry of token.entries.values()) {
      const state = entry.controller.getSnapshot(), job = state.job;
      if (token.feedStatus === 'error' && !['loading', 'uncertain'].includes(state.status)) continue;
      let byline = state.status === 'error' ? 'Action needs retry' : ['loading', 'uncertain'].includes(state.status)
        ? operations[state.operation]?.[state.status === 'uncertain' ? 1 : 0] : null;
      if (job) {
        const top_ref = state.result?.top_ref ?? job.top_ref;
        records.set(job.job_ref, {job_ref: job.job_ref, top_ref, request_key: job.request_key, title: job.title,
          createdAt: job.created_at, byline: byline || (top_ref ? 'Album Top created' : labels[job.status]), controller: entry.controller});
      } else if (entry.key && state.operation === 'submit' && ['loading', 'uncertain'].includes(state.status)) {
        records.set('pending:' + entry.key, {job_ref: null, top_ref: null, request_key: entry.key,
          title: 'Album Top import', createdAt: entry.createdAt, byline, controller: entry.controller});
      }
    }
    token.records = records;
    const rows = [...records].map(([id, row]) => ({id, title: row.title, createdAt: row.createdAt,
      typeLabel: 'Album Top import', read: token.read.has(id), byline: row.byline, statusLabel: row.byline}));
    token.source.replace(rows, {status: token.denied ? 'denied' : token.feedStatus === 'error' ? 'error'
      : rows.length ? 'ready' : token.feedStatus === 'loading' ? 'loading' : 'empty'});
  }
  async function refresh(token = owner) {
    if (!token || !current(token)) return;
    if (token.loading) {token.queued = true; return;}
    token.loading = true;
    const request = new AbortController(); token.request = request;
    try {
      const feed = new Map(), cursors = new Set(); let cursor = null, pages = 0;
      do {
        const page = await token.providers.listSourceImports({scopeKey: token.scopeKey, cursor, signal: request.signal});
        if (!current(token) || request.signal.aborted) return;
        for (const job of page.jobs) {if (feed.has(job.job_ref)) throw new Error('Duplicate import job.'); feed.set(job.job_ref, job);}
        cursor = page.next_cursor; pages++;
        if (cursor && (pages >= 100 || cursors.has(cursor))) throw new Error('Import feed is too large or repeats a cursor.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      // Successful authority publication retires an old activation permanently,
      // even if a later feed repeats its original receipt before the read settles.
      const activation = token.activeOpen;
      if (activation?.feed && !sameFeedReceipt(activation.feed, feed.get(activation.feed.job_ref))) activation.feedRetired = true;
      token.feed = feed; token.feedStatus = 'ready'; token.denied = false;
      collect(token); render(token); publish();
    } catch (error) {
      if (!current(token) || request.signal.aborted) return;
      token.feed.clear(); token.feedStatus = 'error';
      if ([401, 403].includes(error?.status)) {
        token.denied = true; token.queued = false;
        for (const entry of [...token.entries.values()]) remove(token, entry);
        render(token); publish();
        if (current(token)) onDenied?.(token.scopeKey, error);
      } else {render(token); publish();}
    } finally {
      if (current(token)) {token.loading = false; token.request = null;
        if (token.queued) {token.queued = false; void refresh(token);}}
    }
  }
  function open(token, id) {
    const row = token.records.get(id);
    if (!current(token) || token.denied || !row || token.opening?.id === id) return false;
    const feed = row.job_ref ? token.feed.get(row.job_ref) : null;
    const activation = {id, row, feed, feedRetired: false, bound: null}; token.activeOpen = token.opening = activation;
    const valid = () => {
      const now = token.records.get(id), currentFeed = feed && token.feed.get(row.job_ref);
      // Retained controllers may truthfully show an older in-flight state.
      // That projection cannot hide a changed authoritative job receipt.
      if (activation.feedRetired || feed && !sameFeedReceipt(feed, currentFeed)) return false;
      if (!current(token) || token.denied || token.activeOpen !== activation || !now
          || now.job_ref !== row.job_ref || now.top_ref !== row.top_ref || now.request_key !== row.request_key) return false;
      const controller = row.controller || activation.bound?.controller;
      if (!controller) return now.controller === null;
      const entry = token.entries.get(controller), state = controller.getSnapshot();
      return Boolean(entry && now.controller === controller && state.status !== 'retired'
        && (row.controller || entry === activation.bound && entry.feedRequestKey === row.request_key)
        && (!state.job || state.job.job_ref === row.job_ref && state.job.request_key === row.request_key));
    };
    Promise.resolve().then(() => valid() ? onOpen({job_ref: row.job_ref, top_ref: row.top_ref, controller: row.controller}, valid) : false)
      .then(result => {if (result !== false && valid()) {token.read.add(id); render(token);}})
      .catch(() => {}).finally(() => {if (token.opening === activation) token.opening = null;});
    return true;
  }
  function bindOpen(token, entry, ref, activation) {
    if (!activation || token.activeOpen !== activation || activation.row.controller || activation.bound
        || activation.row.job_ref !== ref || entry.feedRequestKey !== activation.row.request_key) return;
    activation.bound = entry;
  }
  function sync(force = false) {
    const shell = runtime.snapshot();
    if (disposed || shell.authenticated !== true || typeof shell.scopeKey !== 'string' || !shell.scopeKey
        || typeof runtime.acceptsPrivateScope === 'function' && !runtime.acceptsPrivateScope(shell.scopeKey)) {
      const generation = ++transition;
      retire(); if (transition === generation) publish(); return;
    }
    if (!force && owner?.scopeKey === shell.scopeKey) return;
    const generation = ++transition;
    retire();
    if (disposed || transition !== generation) return;
    const token = {scopeKey: shell.scopeKey, providers: configured, entries: new Map(), feed: new Map(), records: new Map(),
      usedKeys: new Set(), read: new Set(), denied: false, loading: false, queued: false, feedStatus: 'loading'};
    owner = token;
    token.source = notifications.registerSource({name: 'album-top-source-imports', label: 'Album Top imports', scopeKey: token.scopeKey,
      isCurrent: () => current(token), onOpen: id => open(token, id), onShow: () => token.source ? refresh(token) : undefined});
    if (!current(token)) {token.source.dispose(); return;}
    publish(); if (current(token)) void refresh(token);
  }
  function allocate(token, requestKey, ref = null, activation = null) {
    const entry = {key: requestKey, ref, feedRequestKey: ref ? token.feed.get(ref)?.request_key : null,
      attached: true, leases: new Set(), createdAt: new Date().toISOString(), unsubscribe: () => {}, previous: 'idle'};
    const controller = createSourceImportController({providers: token.providers, scopeKey: token.scopeKey,
      isCurrent: () => current(token) && !token.denied && token.entries.has(controller),
      key: () => {if (!requestKey) throw new TypeError('A resumed import cannot submit a new source.'); return requestKey;}});
    entry.controller = controller; token.entries.set(controller, entry);
    bindOpen(token, entry, ref, activation);
    entry.unsubscribe = controller.subscribe(() => {
      if (!current(token) || !token.entries.has(controller)) return;
      const state = controller.getSnapshot(), settled = entry.previous === 'loading' && state.status !== 'loading';
      entry.previous = state.status;
      collect(token); render(token); publish();
      if (settled && current(token)) void refresh(token);
    });
    publish();
    return current(token) && token.entries.has(controller) ? entry : null;
  }
  const unsubscribe = runtime.subscribe(() => sync()); sync();
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener);},
    create() {
      sync(); const token = owner;
      if (!token || !current(token) || token.denied || token.entries.size >= 32) return null;
      let requestKey;
      try {requestKey = key();} catch {return null;}
      if (!current(token) || token.denied || token.entries.size >= 32 || !uuid(requestKey) || token.usedKeys.has(requestKey)) return null;
      token.usedKeys.add(requestKey); return allocate(token, requestKey)?.controller ?? null;
    },
    async resume(ref) {
      if (!uuid(ref)) return null;
      sync(); const token = owner;
      if (!token || !current(token) || token.denied) return null;
      const activation = token.activeOpen;
      const retained = find(token, ref);
      if (retained) {retained.attached = true; bindOpen(token, retained, ref, activation); return retained.controller;}
      if (token.entries.size >= 32) return null;
      const entry = allocate(token, null, ref, activation);
      if (!entry) return null;
      await entry.controller.open(ref);
      return current(token) && token.entries.has(entry.controller) ? entry.controller : null;
    },
    retain(controller) {
      const token = owner, entry = token?.entries.get(controller);
      if (!entry || !current(token) || token.denied || controller.getSnapshot().status === 'retired') return null;
      const identity = {}; entry.leases.add(identity);
      return Object.freeze({release() {
        if (!entry.leases.delete(identity) || !current(token) || token.entries.get(controller) !== entry) return;
        collect(token); render(token); publish();
      }});
    },
    release(controller) {
      const token = owner, entry = token?.entries.get(controller);
      if (!entry || !current(token)) return;
      entry.attached = false; collect(token); render(token); publish();
    },
    refresh: () => refresh(),
    configure(next) {if (disposed) return; configured = next; sync(true);},
    dispose() {if (disposed) return; disposed = true; transition++; unsubscribe(); listeners.clear(); retire(); snapshot = unavailable();},
  });
}
