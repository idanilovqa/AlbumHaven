import {sourceImportCommand, sourceImportSelection} from './source-import-provider.mjs';

function immutable(value) {
  if (value === null || typeof value !== 'object' || value instanceof Error) return value;
  return Object.freeze(Array.isArray(value) ? value.map(immutable)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
}
const empty = status => immutable({status, operation: null, job: null, rows: [], orderConfirmed: false, result: null, error: null});
const methods = {submit: 'submitSourceImport', read: 'readSourceImport', process: 'processSourceImport',
  cancel: 'cancelSourceImport', finalize: 'finalizeSourceImport'};
const writes = new Set(['submit', 'cancel', 'finalize']);

export function createSourceImportController({providers, scopeKey, isCurrent, key = () => crypto.randomUUID()}) {
  let snapshot = empty('idle'), retired = false, pending = null, retryIntent = null, submitted = false, generation = 0;
  let admitting = false, requestKey, keyAllocated = false;
  const listeners = new Set();
  function dispose() {
    if (retired) return;
    retired = true; pending?.abort.abort(); pending = null; retryIntent = null;
    listeners.clear(); snapshot = empty('retired');
  }
  function live() {
    if (!retired && !isCurrent()) dispose();
    return !retired;
  }
  function canSubmit() {
    return live() && !admitting && !pending && !submitted && !snapshot.job && snapshot.status !== 'uncertain';
  }
  function publish(patch) {
    if (!live()) return;
    snapshot = immutable({...snapshot, ...patch});
    const current = snapshot;
    for (const listener of [...listeners]) {
      if (!live() || snapshot !== current) break;
      listener();
    }
  }
  function editable() {
    return live() && !pending && snapshot.status !== 'uncertain' && !snapshot.result
      && snapshot.job?.status === 'completed' && !snapshot.job.top_ref;
  }
  function edit(patch) {
    // A revised review supersedes a definitively rejected finalization command.
    retryIntent = null; publish({...patch, status: 'ready', operation: null, error: null});
    return live();
  }
  async function run(intent, superseded = null) {
    if (!live() || pending !== superseded) return false;
    const version = ++generation;
    const token = {intent, abort: new AbortController()};
    pending = token; retryIntent = intent;
    // Reserve the successor before invoking synchronous abort listeners.
    superseded?.abort.abort();
    if (!live() || pending !== token) return false;
    publish({status: 'loading', operation: intent.operation, error: null});
    if (!live() || pending !== token) return false;
    try {
      const result = await providers[methods[intent.operation]]({...intent.options, scopeKey, signal: token.abort.signal});
      if (!live() || pending !== token) return false;
      pending = null; retryIntent = null;
      if (intent.operation === 'finalize') {
        publish({status: 'ready', operation: null, result: immutable(result), error: null});
      } else {
        const job = immutable(result), order = job.review?.ordered_row_refs;
        const refs = order ?? job.review?.rows.map(row => row.row_ref) ?? [];
        publish({status: 'ready', operation: null, job, rows: refs.map(row_ref => ({row_ref, selection: null})),
          orderConfirmed: order != null, result: null, error: null});
      }
      return live() && generation === version;
    } catch (error) {
      if (!live() || pending !== token) return false;
      pending = null;
      publish({status: writes.has(intent.operation) && error?.responseRejected !== true ? 'uncertain' : 'error',
        operation: intent.operation, error});
      return false;
    }
  }
  const intent = (operation, options) => immutable({operation, options});
  return Object.freeze({
    getSnapshot() {live(); return snapshot;},
    getSubmittedSource() {
      if (!live() || snapshot.job || snapshot.result || snapshot.operation !== 'submit'
          || retryIntent?.operation !== 'submit') return null;
      const {title, description, kind, filename, content} = retryIntent.options.command;
      return Object.freeze({title, description, kind, filename, content});
    },
    subscribe(listener) {
      if (!live() || typeof listener !== 'function') return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    },
    async submit(input) {
      if (!canSubmit()) return false;
      admitting = true;
      const version = generation;
      let command, rejected = false;
      try {
        if (!keyAllocated) {requestKey = key(); keyAllocated = true;}
        command = sourceImportCommand({...input, request_key: requestKey});
      } catch {rejected = true;}
      admitting = false;
      if (!live() || generation !== version || pending || submitted || snapshot.job || snapshot.status === 'uncertain') return false;
      if (rejected) {
        retryIntent = null;
        publish({status: 'error', operation: 'submit', error: Object.assign(new Error('Source input is invalid.'),
          {status: 400, responseRejected: true})});
        live(); // A publication callback may retire this scope without another listener.
        return false;
      }
      submitted = true;
      return run(intent('submit', {command}));
    },
    async open(job_ref) {
      if (!live() || pending || snapshot.status === 'uncertain') return false;
      if (snapshot.job?.job_ref !== job_ref) snapshot = empty('idle');
      return run(intent('read', {job_ref}));
    },
    async process() {
      if (!live() || pending || snapshot.status === 'uncertain' || !snapshot.job
          || snapshot.job.top_ref || snapshot.result || snapshot.job.status === 'canceled') return false;
      return run(intent('process', {job_ref: snapshot.job.job_ref}));
    },
    async cancel() {
      if (!live() || snapshot.status === 'uncertain' || !snapshot.job || snapshot.job.top_ref
          || snapshot.result || snapshot.job.status === 'canceled'
          || pending && !['read', 'process'].includes(pending.intent.operation)) return false;
      const job_ref = snapshot.job.job_ref;
      return run(intent('cancel', {job_ref}), pending);
    },
    async retry() {
      if (!live() || pending || !retryIntent || !['error', 'uncertain'].includes(snapshot.status)) return false;
      return run(retryIntent);
    },
    select(row_ref, selection) {
      if (!editable() || !snapshot.rows.some(row => row.row_ref === row_ref)) return false;
      let chosen;
      try {chosen = sourceImportSelection(selection);} catch {return false;}
      return edit({rows: snapshot.rows.map(row => row.row_ref === row_ref ? {row_ref, selection: chosen} : row)});
    },
    reorder(refs) {
      if (!editable() || snapshot.job.review.ordered_row_refs !== null || !Array.isArray(refs)
          || refs.length !== snapshot.rows.length || new Set(refs).size !== refs.length) return false;
      const rows = new Map(snapshot.rows.map(row => [row.row_ref, row]));
      const complete = Array.from(refs);
      if (!complete.every(ref => rows.has(ref))) return false;
      return edit({rows: complete.map(ref => rows.get(ref)), orderConfirmed: false});
    },
    confirmOrder() {
      if (!editable()) return false;
      return edit({orderConfirmed: true});
    },
    async finalize() {
      if (!live()) return false;
      if (snapshot.result) return true;
      if (!editable() || !snapshot.orderConfirmed || !snapshot.rows.some(row => row.selection !== null)) return false;
      const job = snapshot.job;
      return run(intent('finalize', {command: {request_key: job.job_ref, title: job.source.title,
        description: job.source.description, source_review: {job_ref: job.job_ref, revision: job.revision, rows: snapshot.rows}}}));
    },
    canSubmit,
    dispose,
  });
}
