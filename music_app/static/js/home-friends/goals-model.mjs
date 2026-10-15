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
  const {command, goalRef, total} = pending;
  if (!exactKeys(value, ['ok', 'action', 'request_key', 'changed', 'reason', 'goal_ref', 'revision', 'period', 'cycle_id'])
    || value.ok !== true || value.action !== 'reset' || value.request_key !== command.request_key
    || value.period !== command.period || value.goal_ref !== goalRef || !revision(value.revision)
    || !(value.goal_ref === null || uuid(value.goal_ref)) || typeof value.changed !== 'boolean') malformed();
  if (value.changed) {
    if (total === 0 || !uuid(command.expected_cycle_id) || !uuid(value.cycle_id)
      || value.cycle_id === command.expected_cycle_id || value.reason !== ''
      || BigInt(value.revision) !== BigInt(command.revision) + 1n) malformed();
  } else if (total !== 0 || value.reason !== 'empty_period' || value.revision !== command.revision
    || value.cycle_id !== command.expected_cycle_id) malformed();
  return Object.freeze({revision: value.revision, cycle_id: value.cycle_id});
}

// This owner remembers a single exact Reset intent until its outcome is known.
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
  function uncertain() {
    publish({status: snapshot.data ? 'ready' : 'unavailable', mutation: 'uncertain',
      error: failure('uncertain', 'The Reset outcome is unknown. Retry checks its saved result first.')});
  }
  async function read(task, acknowledged = false) {
    publish({status: 'loading', data: null, mutation: acknowledged ? 'refreshing' : 'idle', error: null});
    try {
      if (!task.current()) return snapshot;
      const data = await provider.read(task.options);
      if (!task.current()) return snapshot;
      if (acknowledged) {
        const receipt = pending.receipt;
        if (data.goal_ref !== pending.goalRef || BigInt(data.revision) < BigInt(receipt.revision)
          || (data.revision === receipt.revision
            && (data.periods[pending.command.period].cycle?.cycle_id ?? null) !== receipt.cycle_id)) {
          throw new Error('Goals refresh is older than the saved Reset.');
        }
        pending = null;
      }
      publish({status: 'ready', data, mutation: 'idle', error: null});
    } catch (error) {
      if (!task.current()) return snapshot;
      if (denied(error)) clearDenied();
      else publish({status: 'unavailable', data: null, mutation: 'idle',
        error: acknowledged
          ? failure('acknowledged-refresh', 'Reset was saved, but Goals could not be refreshed. Retry refreshes only.')
          : failure('read', 'Goals could not be loaded. Try again.')});
    }
    return snapshot;
  }
  async function write(task, intent) {
    publish({mutation: 'submitting', error: null});
    try {
      if (!task.current() || pending !== intent) return snapshot;
      const receipt = await provider.reset(intent.command, task.options);
      if (!task.current() || pending !== intent) return snapshot;
      intent.receipt = acceptReceipt(receipt, intent);
      intent.acknowledged = true;
      return await read(task, true);
    } catch (error) {
      if (!task.current() || pending !== intent) return snapshot;
      if (denied(error)) clearDenied();
      else if (rejected(error)) {
        // A rejection is definitive for this command. Fresh state is required
        // before another explicitly requested Reset can obtain a new key.
        pending = null;
        publish({status: 'unavailable', data: null, mutation: 'conflict',
          error: failure('conflict', 'Reset was rejected. Reload Goals before trying again.')});
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
  function reset(expected) {
    if (disposed || pending || snapshot.status !== 'ready' || snapshot.mutation !== 'idle'
      || snapshot.data?.allowed_actions.can_reset !== true) return Promise.resolve(snapshot);
    const data = snapshot.data, period = snapshot.period, selected = data.periods[period];
    const cycle = selected.cycle?.cycle_id ?? null;
    if (expected !== undefined && (!object(expected) || expected.period !== period
      || expected.revision !== data.revision || expected.cycle_id !== cycle)) return Promise.resolve(snapshot);
    let command;
    try {
      const key = requestKey();
      if (!uuid(key) || issuedKeys.has(key) || !revision(data.revision)
        || typeof timezone !== 'string' || !timezone || !(cycle === null || uuid(cycle))) throw new Error();
      // Only validate the selected zone. Calendar boundaries remain server-owned.
      new Intl.DateTimeFormat('en', {timeZone: timezone});
      command = Object.freeze({revision: data.revision, period, timezone_name: timezone,
        expected_cycle_id: cycle, request_key: key});
      issuedKeys.add(key);
    } catch {
      publish({error: failure('invalid-command', 'Reset could not be prepared. Reload Goals and try again.')});
      return Promise.resolve(snapshot);
    }
    pending = {command, goalRef: data.goal_ref, total: selected.total, acknowledged: false};
    return write(begin(), pending);
  }
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
    load, selectPeriod, reset, retry,
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
