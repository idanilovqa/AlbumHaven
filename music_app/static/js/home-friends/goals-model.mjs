import {GOAL_PERIODS} from './goals-provider.mjs';

const MAX_REVISION = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const uuid = value => typeof value === 'string' && UUID.test(value) && value !== NIL_UUID;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && BigInt(value) <= MAX_REVISION;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const denied = error => error?.status === 401 || error?.status === 403;
const rejected = error => error?.responseRejected === true && Number.isInteger(error.status)
  && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
const failure = (kind, message) => Object.freeze({kind, message});
const malformed = () => {throw new Error('Invalid Goals operation receipt.');};

function acceptReceipt(value, pending) {
  const {action, command, goalRef, total, expectedChanged} = pending;
  const keys = ['ok', 'action', 'request_key', 'changed', 'reason', 'goal_ref', 'revision', 'period', 'cycle_id'];
  if (action !== 'reset') keys.push('catalog_ref');
  if (!exactKeys(value, keys) || value.ok !== true || value.action !== action
    || value.request_key !== command.request_key || value.period !== command.period
    || value.goal_ref !== goalRef || !revision(value.revision)
    || !(value.goal_ref === null || uuid(value.goal_ref)) || typeof value.changed !== 'boolean') malformed();
  if (action === 'reset') {
    if (value.changed) {
      if (total === 0 || !uuid(command.expected_cycle_id) || !uuid(value.cycle_id)
        || value.cycle_id === command.expected_cycle_id || value.reason !== ''
        || BigInt(value.revision) !== BigInt(command.revision) + 1n) malformed();
    } else if (total !== 0 || value.reason !== 'empty_period' || value.revision !== command.revision
      || value.cycle_id !== command.expected_cycle_id) malformed();
  } else {
    // These intents are admitted only for a member of this exact revision/cycle.
    // A nonmember Remove receipt cannot acknowledge this admitted command.
    if (value.catalog_ref !== command.catalog_ref || !uuid(value.catalog_ref)
      || !uuid(value.cycle_id) || value.cycle_id !== command.expected_cycle_id
      || value.changed !== expectedChanged || value.reason !== (value.changed ? '' : 'unchanged')
      || BigInt(value.revision) !== BigInt(command.revision) + (value.changed ? 1n : 0n)) malformed();
  }
  return Object.freeze({revision: value.revision, cycle_id: value.cycle_id});
}

function receiptMatchesRead(data, intent) {
  const {receipt, command, action} = intent;
  if (data.goal_ref !== intent.goalRef || BigInt(data.revision) < BigInt(receipt.revision)) return false;
  if (data.revision !== receipt.revision) return true; // A newer authorized mutation may supersede this result.
  const selected = data.periods[command.period];
  if ((selected.cycle?.cycle_id ?? null) !== receipt.cycle_id) return false;
  if (action === 'remove') return !selected.album_refs.includes(command.catalog_ref);
  if (action !== 'completion') return true;
  if (!selected.album_refs.includes(command.catalog_ref)) return false;
  if (!command.completed) return selected.manual_completed_at[command.catalog_ref] === null;
  return GOAL_PERIODS.every(period => !data.periods[period].album_refs.includes(command.catalog_ref)
    || data.periods[period].manual_completed_at[command.catalog_ref] !== null);
}

// This owner remembers a single exact mutation intent until its outcome is known.
// Neither UI continuity nor a failed refresh grants permission for a new write.
export function createGoalsController({provider, requestKey = () => globalThis.crypto.randomUUID(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone}) {
  let disposed = false, epoch = 0, sequence = 0, active = null, pending = null;
  let snapshot = Object.freeze({status: 'idle', data: null, period: 'week', mutation: 'idle', error: null});
  const listeners = new Set(), issuedKeys = new Set();

  function publish(patch) {
    if (disposed) return;
    snapshot = Object.freeze({...snapshot, ...patch});
    for (const listener of [...listeners]) {
      // An observer cannot turn an acknowledged write into an uncertain one.
      try {listener(snapshot);} catch {}
    }
  }
  function retire() {
    sequence++;
    active?.abort();
    active = null;
  }
  function begin() {
    retire();
    const controller = new AbortController(), ownerEpoch = epoch, ownerSequence = sequence;
    active = controller;
    const current = () => !disposed && epoch === ownerEpoch && sequence === ownerSequence
      && !controller.signal.aborted;
    return {current, options: {signal: controller.signal, isCurrent: current}};
  }
  function clearDenied() {
    pending = null;
    retire();
    publish({status: 'denied', data: null, mutation: 'idle',
      error: failure('denied', 'Goals are not available for this account.')});
  }
  const actionLabel = intent => ({reset: 'Reset', completion: 'Completion', remove: 'Removal'})[intent?.action] || 'Goal change';
  function uncertain() {
    publish({status: snapshot.data ? 'ready' : 'unavailable', mutation: 'uncertain',
      error: failure('uncertain', `The ${actionLabel(pending)} outcome is unknown. Retry checks its saved result first.`)});
  }
  async function read(task, acknowledged = false) {
    publish({status: 'loading', data: null, mutation: acknowledged ? 'refreshing' : 'idle', error: null});
    try {
      if (!task.current()) return snapshot;
      const data = await provider.read(task.options);
      if (!task.current()) return snapshot;
      if (acknowledged) {
        if (!receiptMatchesRead(data, pending)) throw new Error('Goals refresh does not include the saved change.');
        pending = null;
      }
      publish({status: 'ready', data, mutation: 'idle', error: null});
    } catch (error) {
      if (!task.current()) return snapshot;
      if (denied(error)) clearDenied();
      else publish({status: 'unavailable', data: null, mutation: 'idle',
        error: acknowledged
          ? failure('acknowledged-refresh', `${actionLabel(pending)} was saved, but Goals could not be refreshed. Retry refreshes only.`)
          : failure('read', 'Goals could not be loaded. Try again.')});
    }
    return snapshot;
  }
  async function write(task, intent) {
    publish({mutation: 'submitting', error: null});
    try {
      if (!task.current() || pending !== intent) return snapshot;
      const receipt = await provider[intent.action](intent.command, task.options);
      if (!task.current() || pending !== intent) return snapshot;
      intent.receipt = acceptReceipt(receipt, intent);
      intent.acknowledged = true;
      return await read(task, true);
    } catch (error) {
      if (!task.current() || pending !== intent) return snapshot;
      if (denied(error)) clearDenied();
      else if (rejected(error)) {
        // A rejection is definitive for this command. Fresh state is required
        // before another explicitly requested mutation can obtain a new key.
        const label = actionLabel(intent);
        pending = null;
        publish({status: 'unavailable', data: null, mutation: 'conflict',
          error: failure('conflict', `${label} was rejected. Reload Goals before trying again.`)});
      } else uncertain();
    }
    return snapshot;
  }
  function load() {
    if (disposed || pending) return Promise.resolve(snapshot);
    return read(begin());
  }
  function selectPeriod(period) {
    if (!disposed && snapshot.mutation === 'idle' && GOAL_PERIODS.includes(period)
      && period !== snapshot.period) publish({period});
    return snapshot;
  }
  function ready(action) {
    const capability = {reset: 'can_reset', completion: 'can_complete', remove: 'can_remove'}[action];
    return !disposed && !pending && snapshot.status === 'ready' && snapshot.mutation === 'idle'
      && snapshot.data?.allowed_actions[capability] === true;
  }
  function startIntent(action, data, period, selected, fields = {}) {
    let command;
    try {
      const key = requestKey(), cycle = selected.cycle?.cycle_id ?? null;
      if (!uuid(key) || issuedKeys.has(key) || !revision(data.revision)
        || !(cycle === null || uuid(cycle))) throw new Error();
      let calendar = {};
      if (action === 'reset') {
        if (typeof timezone !== 'string' || !timezone) throw new Error();
        // Only validate the selected zone. Calendar boundaries remain server-owned.
        new Intl.DateTimeFormat('en', {timeZone: timezone});
        calendar = {timezone_name: timezone};
      }
      command = Object.freeze({revision: data.revision, period, ...calendar,
        expected_cycle_id: cycle, request_key: key, ...fields});
      issuedKeys.add(key);
    } catch {
      if (!disposed && snapshot.data === data && snapshot.period === period) {
        publish({error: failure('invalid-command', `${actionLabel({action})} could not be prepared. Reload Goals and try again.`)});
      }
      return Promise.resolve(snapshot);
    }
    // Even key creation can reenter application code. Never dispatch against a
    // different captured owner, revision, period or capability after that seam.
    if (!ready(action) || snapshot.data !== data || snapshot.period !== period) return Promise.resolve(snapshot);
    const expectedChanged = action === 'remove' || (action === 'completion' && (command.completed
      ? GOAL_PERIODS.some(name => data.periods[name].album_refs.includes(command.catalog_ref)
        && data.periods[name].manual_completed_at[command.catalog_ref] === null)
      : selected.manual_completed_at[command.catalog_ref] !== null));
    pending = {action, command, goalRef: data.goal_ref, total: selected.total, expectedChanged, acknowledged: false};
    return write(begin(), pending);
  }
  function reset(expected) {
    if (!ready('reset')) return Promise.resolve(snapshot);
    const data = snapshot.data, period = snapshot.period, selected = data.periods[period];
    const cycle = selected.cycle?.cycle_id ?? null;
    if (expected !== undefined && (!object(expected) || expected.period !== period
      || expected.revision !== data.revision || expected.cycle_id !== cycle)) return Promise.resolve(snapshot);
    return startIntent('reset', data, period, selected);
  }
  function memberIntent(action, catalogRef, completed, expected) {
    if (!ready(action) || !uuid(catalogRef) || !object(expected)) return Promise.resolve(snapshot);
    const data = snapshot.data, period = snapshot.period, selected = data.periods[period];
    if (expected.data !== data || expected.period !== period || expected.revision !== data.revision
      || expected.cycle_id !== selected.cycle?.cycle_id || !uuid(selected.cycle?.cycle_id)
      || !selected.album_refs.includes(catalogRef)) return Promise.resolve(snapshot);
    if (action === 'completion' && typeof completed !== 'boolean') return Promise.resolve(snapshot);
    return startIntent(action, data, period, selected,
      {catalog_ref: catalogRef, ...(action === 'completion' ? {completed} : {})});
  }
  const setCompletion = (catalogRef, completed, expected) => memberIntent('completion', catalogRef, completed, expected);
  const remove = (catalogRef, expected) => memberIntent('remove', catalogRef, undefined, expected);
  async function retry() {
    if (disposed || ['submitting', 'recovering', 'refreshing'].includes(snapshot.mutation)) return snapshot;
    if (!pending) return load();
    const task = begin(), intent = pending;
    if (intent.acknowledged) return read(task, true);
    publish({mutation: 'recovering', error: null});
    try {
      if (!task.current() || pending !== intent) return snapshot;
      const result = await provider.operation(intent.command.request_key, task.options);
      if (!task.current() || pending !== intent) return snapshot;
      if (exactKeys(result, ['status', 'receipt']) && result.status === 'committed') {
        intent.receipt = acceptReceipt(result.receipt, intent);
        intent.acknowledged = true;
        return await read(task, true);
      }
      if (exactKeys(result, ['status']) && result.status === 'unknown') return await write(task, intent);
      malformed();
    } catch (error) {
      if (!task.current() || pending !== intent) return snapshot;
      if (denied(error)) clearDenied();
      else uncertain();
    }
    return snapshot;
  }
  const unsubscribe = provider.subscribe(() => {
    if (disposed) return;
    epoch++;
    retire();
    pending = null;
    publish({status: 'unavailable', data: null, period: 'week', mutation: 'idle',
      error: failure('context', 'Your session changed. Reload Goals to continue.')});
  });
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load, selectPeriod, reset, setCompletion, remove, retry,
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      retire();
      pending = null;
      snapshot = Object.freeze({status: 'idle', data: null, period: 'week', mutation: 'idle', error: null});
      unsubscribe?.();
      listeners.clear();
      issuedKeys.clear();
    },
  });
}
