import {GOAL_PERIODS, normalizeBonusSettings, normalizeBonusValues} from './goals-provider.mjs';

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
const bonusAction = action => ['bonus_settings', 'bonus_draw', 'transition'].includes(action);
const settingsValues = value => normalizeBonusValues(Object.fromEntries(
  ['enabled', 'source_mode', 'selected_top_refs', 'preferred_top_refs', 'album_mode', 'unfinished_policy'].map(key => [key, value[key]])));
const sameValues = (left, right) => JSON.stringify(settingsValues(left)) === JSON.stringify(settingsValues(right));
function acceptBonusReceipt(value, pending) {
  const {action, command, goalRef} = pending;
  if (action === 'bonus_settings') {
    if (!exactKeys(value, ['ok', 'action', 'request_key', 'changed', 'settings']) || value.ok !== true
      || value.action !== action || value.request_key !== command.request_key || typeof value.changed !== 'boolean') malformed();
    const settings = normalizeBonusSettings(value.settings);
    if (!sameValues(settings, command) || value.changed !== !sameValues(pending.settings, command)
      || BigInt(settings.settings_revision) !== BigInt(command.settings_revision) + (value.changed ? 1n : 0n)) malformed();
    return Object.freeze({settings, changed: value.changed});
  }
  const keys = ['ok', 'action', 'request_key', 'changed', 'reason', 'goal_ref', 'revision', 'period', 'cycle_id'];
  if (action === 'bonus_draw') keys.push('catalog_ref');
  else keys.push('previous_cycle_id', 'settings_revision', 'retained_count', 'bonus_carried',
    ...(command.period === 'week' ? ['manual_count', 'manual_slots_available', 'bonus_slot_available'] : []));
  const period = action === 'bonus_draw' ? 'week' : command.period;
  if (!exactKeys(value, keys) || value.ok !== true || value.action !== action || value.request_key !== command.request_key
    || value.period !== period || typeof value.changed !== 'boolean' || !revision(value.revision)
    || !(value.goal_ref === null || uuid(value.goal_ref)) || (goalRef !== null && value.goal_ref !== goalRef)
    || BigInt(value.revision) !== BigInt(command.revision) + (value.changed ? 1n : 0n)) malformed();
  if (action === 'bonus_draw') {
    if (value.changed) {
      if (!uuid(value.goal_ref) || !uuid(value.catalog_ref) || pending.allMembers.includes(value.catalog_ref)
        || !uuid(value.cycle_id) || value.reason !== ''
        || (command.expected_cycle_id !== null && value.cycle_id !== command.expected_cycle_id)
        || (command.expected_cycle_id === null && pending.existingCycles.includes(value.cycle_id))) malformed();
    } else if (value.reason !== 'no_eligible_source' || value.catalog_ref !== null
      || value.goal_ref !== goalRef || value.cycle_id !== command.expected_cycle_id) malformed();
  } else {
    if (!value.changed || value.reason !== '' || value.goal_ref !== goalRef || !uuid(value.cycle_id)
      || pending.existingCycles.includes(value.cycle_id) || value.previous_cycle_id !== command.expected_cycle_id
      || value.settings_revision !== command.settings_revision || !Number.isSafeInteger(value.retained_count)
      || value.retained_count < 0 || value.retained_count > pending.unfinishedCount || typeof value.bonus_carried !== 'boolean') malformed();
    if ((period === 'year' || pending.settings.unfinished_policy === 'carry')
      && value.retained_count !== pending.unfinishedCount) malformed();
    if (period !== 'week' && value.bonus_carried) malformed();
    if (period === 'week') {
      const expectedCarry = pending.bonus?.bonus?.present === true
        && pending.selected.manual_completed_at[pending.bonus.bonus.catalog_ref] === null
        && pending.settings.unfinished_policy === 'carry';
      if (value.bonus_carried !== expectedCarry || !Number.isSafeInteger(value.manual_count)
        || value.manual_count < 0 || value.manual_count > 5
        || value.manual_count + Number(value.bonus_carried) !== value.retained_count
        || value.manual_slots_available !== 5 - value.manual_count || value.bonus_slot_available !== !value.bonus_carried) malformed();
    }
  }
  return Object.freeze({...value});
}

function bonusCoherent(data, bonus) {
  const week = data.periods.week;
  return bonus.cycle_id === (week.cycle?.cycle_id ?? null)
    && (bonus.bonus === null || bonus.bonus.present === week.album_refs.includes(bonus.bonus.catalog_ref))
    && bonus.manual_count === week.total - Number(bonus.bonus?.present === true);
}

function acceptReceipt(value, pending) {
  if (pending.action === 'attention_ack') {
    const event = pending.command.event;
    if (!exactKeys(value, ['ok', 'action', 'request_key', 'event', 'changed']) || value.ok !== true
      || value.action !== 'attention_ack' || value.request_key !== pending.command.request_key
      || typeof value.changed !== 'boolean' || !exactKeys(value.event, ['kind', 'goal_ref', 'cycle_id'])
      || Object.keys(event).some(key => value.event[key] !== event[key])) malformed();
    return Object.freeze({...value, event: Object.freeze({...value.event})});
  }
  if (bonusAction(pending.action)) return acceptBonusReceipt(value, pending);
  const {action, command, goalRef, total, expectedChanged} = pending;
  const keys = ['ok', 'action', 'request_key', 'changed', 'reason', 'goal_ref', 'revision', 'period', 'cycle_id'];
  if (action !== 'reset') keys.push('catalog_ref');
  if (!exactKeys(value, keys) || value.ok !== true || value.action !== action
    || value.request_key !== command.request_key || value.period !== command.period
    || (action !== 'add' && value.goal_ref !== goalRef) || !revision(value.revision)
    || !(value.goal_ref === null || uuid(value.goal_ref)) || typeof value.changed !== 'boolean') malformed();
  if (action === 'add') {
    if (!uuid(value.goal_ref) || (goalRef !== null && value.goal_ref !== goalRef)
      || !uuid(value.catalog_ref) || !uuid(value.cycle_id)
      || (pending.selectedCycle !== null && value.cycle_id !== pending.selectedCycle)
      || (pending.selectedCycle === null && pending.existingCycles.includes(value.cycle_id))
      || value.reason !== (value.changed ? '' : 'already_added')
      || BigInt(value.revision) !== BigInt(command.revision) + (value.changed ? 1n : 0n)
      || (!value.changed && (goalRef === null || !pending.members.includes(value.catalog_ref)))) malformed();
  } else if (action === 'reset') {
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
  return Object.freeze({revision: value.revision, cycle_id: value.cycle_id, goal_ref: value.goal_ref,
    ...(action === 'add' ? {catalog_ref: value.catalog_ref, changed: value.changed} : {})});
}

function receiptMatchesRead(data, intent, settings, bonus) {
  const {receipt, command, action} = intent;
  if (action === 'bonus_settings') return settings && BigInt(settings.settings_revision) >= BigInt(receipt.settings.settings_revision)
    && (settings.settings_revision !== receipt.settings.settings_revision || sameValues(settings, receipt.settings));
  if (['bonus_draw', 'transition'].includes(action)
      && (!settings || BigInt(settings.settings_revision) < BigInt(command.settings_revision))) return false;
  if (data.goal_ref !== receipt.goal_ref || BigInt(data.revision) < BigInt(receipt.revision)) return false;
  if (data.revision !== receipt.revision) return true; // A newer authorized mutation may supersede this result.
  const selected = data.periods[action === 'bonus_draw' ? 'week' : command.period];
  if ((selected.cycle?.cycle_id ?? null) !== receipt.cycle_id) return false;
  if (action === 'bonus_draw') return !receipt.changed ? bonus?.bonus === null : selected.album_refs.includes(receipt.catalog_ref)
    && bonus?.bonus?.catalog_ref === receipt.catalog_ref && bonus.bonus.present;
  if (action === 'transition') {
    const retained = intent.unfinishedRefs.filter(ref => selected.album_refs.includes(ref));
    const validOrder = retained.length === selected.album_refs.length
      && retained.every((ref, index) => ref === selected.album_refs[index]);
    const allCarried = command.period === 'year' || intent.settings.unfinished_policy === 'carry';
    return selected.total === receipt.retained_count && selected.completed === 0 && validOrder
      && (!allCarried || selected.album_refs.length === intent.unfinishedRefs.length)
      && (command.period !== 'week' || bonus.manual_count === receipt.manual_count
        && (bonus.bonus?.present === true) === receipt.bonus_carried
        && (!receipt.bonus_carried || bonus.bonus.catalog_ref === intent.bonus.bonus.catalog_ref));
  }
  if (action === 'add') return (receipt.changed ? GOAL_PERIODS.slice(GOAL_PERIODS.indexOf(command.period)) : [command.period])
    .every(period => data.periods[period].album_refs.includes(receipt.catalog_ref));
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
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, canDrawBonus = () => false}) {
  let disposed = false, epoch = 0, sequence = 0, active = null, pending = null;
  let bonusRequested = false;
  let attentionSequence = 0, attentionActive = null, visitGeneration = 0;
  let visits = new WeakMap();
  let snapshot = Object.freeze({status: 'idle', data: null, period: 'week', mutation: 'idle', error: null,
    bonusStatus: 'idle', settings: null, bonus: null, outcome: null,
    attentionStatus: 'idle', attention: null, attentionError: null});
  const listeners = new Set(), issuedKeys = new Set(), usedEvidence = new WeakSet();

  function publish(patch) {
    if (disposed) return;
    snapshot = Object.freeze({...snapshot, ...patch});
    for (const listener of [...listeners]) {
      // An observer cannot turn an acknowledged write into an uncertain one.
      try {listener(snapshot);} catch {}
    }
  }
  function retire() {
    retireAttention();
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
    visitGeneration++;
    visits = new WeakMap();
    retire();
    publish({attentionStatus: 'idle', attention: null, attentionError: null, status: 'denied', data: null, mutation: 'idle', settings: null, bonus: null, bonusStatus: 'idle', outcome: null,
      error: failure('denied', 'Goals are not available for this account.')});
  }
  const actionLabel = intent => ({add: 'Add', reset: 'Reset', completion: 'Completion', remove: 'Removal',
    bonus_settings: 'Bonus settings', bonus_draw: 'Bonus draw', transition: 'Next period', attention_ack: 'Visit acknowledgment'})[intent?.action] || 'Goal change';
  function uncertain() {
    publish({status: snapshot.data ? 'ready' : 'unavailable', mutation: 'uncertain',
      error: failure('uncertain', `The ${actionLabel(pending)} outcome is unknown. Retry checks its saved result first.`)});
  }
  async function read(task, acknowledged = false) {
    publish({status: 'loading', data: null, mutation: acknowledged ? 'refreshing' : 'idle', error: null,
      attentionStatus: 'idle', attention: null, attentionError: null,
      ...(!acknowledged ? {outcome: null} : {}),
      ...(bonusRequested ? {bonusStatus: 'loading', settings: null, bonus: null} : {})});
    try {
      if (!task.current()) return snapshot;
      let data = await provider.read(task.options), settings = null, bonus = null;
      if (bonusRequested) {
        let coherent = false;
        for (let attempt = 0; attempt < 2 && !coherent; attempt++) {
          if (!task.current()) return snapshot;
          settings = await provider.readBonusSettings(task.options);
          if (!task.current()) return snapshot;
          bonus = await provider.readCurrentBonus(task.options);
          if (!task.current()) return snapshot;
          const checked = await provider.read(task.options);
          coherent = checked.goal_ref === data.goal_ref && checked.revision === data.revision && bonusCoherent(checked, bonus);
          data = checked;
        }
        if (!coherent) throw new Error('Goals changed while bonus state was read.');
      }
      if (!task.current()) return snapshot;
      let outcome = null;
      if (acknowledged) {
        if (!receiptMatchesRead(data, pending, settings, bonus)) throw new Error('Goals refresh does not include the saved change.');
        if (bonusAction(pending.action)) outcome = Object.freeze({action: pending.action,
          changed: pending.receipt.changed, reason: pending.receipt.reason || ''});
        pending = null;
      }
      publish({status: 'ready', data, mutation: 'idle', error: null, outcome,
        ...(bonusRequested ? {bonusStatus: 'ready', settings, bonus} : {})});
    } catch (error) {
      if (!task.current()) return snapshot;
      if (denied(error)) clearDenied();
      else publish({status: 'unavailable', data: null, mutation: 'idle',
        ...(bonusRequested ? {bonusStatus: 'unavailable', settings: null, bonus: null} : {}),
        error: acknowledged
          ? failure('acknowledged-refresh', `${actionLabel(pending)} was saved, but Goals could not be refreshed. Retry refreshes only.`)
          : failure('read', 'Goals could not be loaded. Try again.')});
    }
    return snapshot;
  }
  function retireAttention() {
    attentionSequence++; attentionActive?.abort(); attentionActive = null;
  }
  function attentionCoherent() {
    const {data, attention} = snapshot;
    return snapshot.status === 'ready' && snapshot.attentionStatus === 'ready' && data && attention
      && data.goal_ref === attention.goal_ref && data.revision === attention.revision
      && GOAL_PERIODS.every(name => {
        const left = data.periods[name], right = attention.periods[name];
        return (left.cycle?.cycle_id ?? null) === right.cycle_id
          && left.total === right.total && left.completed === right.completed;
      });
  }
  function validVisit(token) {
    const record = visits.get(token);
    const matches = () => !disposed && record && record.epoch === epoch && record.generation === visitGeneration
      && snapshot.period === record.period && snapshot.data === record.data && snapshot.attention === record.attention
      && attentionCoherent();
    if (!matches()) return false;
    let visible = false;
    try {visible = record.isCurrent() === true;} catch {}
    return visible && matches(); // Caller callbacks may synchronously replace every captured identity.
  }
  function createVisit({isCurrent} = {}) {
    if (disposed || pending || snapshot.mutation !== 'idle' || typeof isCurrent !== 'function' || !attentionCoherent()) return null;
    const token = Object.freeze({}), record = {epoch, generation: ++visitGeneration, period: snapshot.period,
      data: snapshot.data, attention: snapshot.attention, isCurrent};
    visits.set(token, record);
    return validVisit(token) ? token : null;
  }
  async function loadAttention() {
    if (disposed || pending || snapshot.mutation !== 'idle' || snapshot.status === 'loading') return snapshot;
    retireAttention();
    const controller = new AbortController(), ownerEpoch = epoch, ownerSequence = attentionSequence;
    attentionActive = controller;
    const current = () => !disposed && epoch === ownerEpoch && attentionSequence === ownerSequence && !controller.signal.aborted;
    publish({attentionStatus: 'loading', attention: null, attentionError: null});
    try {
      if (!current() || pending) return snapshot;
      const attention = await provider.readAttention({signal: controller.signal, isCurrent: current});
      if (!current() || pending) return snapshot;
      publish({attentionStatus: 'ready', attention, attentionError: null});
    } catch (error) {
      if (!current()) return snapshot;
      if (denied(error)) clearDenied();
      else publish({attentionStatus: 'unavailable', attention: null,
        attentionError: failure('attention-read', 'Goal attention could not be loaded. Try again.')});
    }
    return snapshot;
  }
  async function readAcknowledgedAttention(task) {
    const intent = pending;
    publish({mutation: 'refreshing', error: null, attentionStatus: 'loading', attention: null, attentionError: null});
    try {
      if (!task.current() || pending !== intent) return snapshot;
      const attention = await provider.readAttention(task.options);
      if (!task.current() || pending !== intent) return snapshot;
      const event = intent.command.event;
      if (attention.goal_ref !== event.goal_ref || BigInt(attention.revision) < BigInt(intent.attentionRevision)
        || (attention.periods.week.cycle_id === event.cycle_id ? !attention.weekly_acknowledged
          : BigInt(attention.revision) <= BigInt(intent.attentionRevision))) {
        throw new Error('Attention refresh does not include the saved acknowledgment.');
      }
      pending = null; visitGeneration++;
      publish({mutation: 'idle', error: null, attentionStatus: 'ready', attention, attentionError: null});
    } catch (error) {
      if (!task.current() || pending !== intent) return snapshot;
      if (denied(error)) clearDenied();
      else publish({mutation: 'idle', attentionStatus: 'unavailable', attention: null,
        error: failure('acknowledged-refresh', 'The visit was acknowledged, but attention could not be refreshed. Retry refreshes only.')});
    }
    return snapshot;
  }
  const readAcknowledged = task => pending?.action === 'attention_ack' ? readAcknowledgedAttention(task) : read(task, true);
  function acknowledgeVisit(token) {
    if (disposed || pending || snapshot.mutation !== 'idle' || !validVisit(token)) return Promise.resolve(snapshot);
    const attention = snapshot.attention;
    if (!attention.weekly_event || attention.weekly_acknowledged || snapshot.data.allowed_actions.can_add !== true) return Promise.resolve(snapshot);
    let command;
    try {
      const key = requestKey();
      if (!uuid(key) || issuedKeys.has(key)) throw new Error();
      command = Object.freeze({action: 'attention_ack', request_key: key, event: attention.weekly_event});
      issuedKeys.add(key);
    } catch {
      if (validVisit(token)) publish({attentionError: failure('invalid-command', 'The visit acknowledgment could not be prepared.')});
      return Promise.resolve(snapshot);
    }
    if (pending || snapshot.mutation !== 'idle' || snapshot.attention !== attention || !validVisit(token)
      || pending || snapshot.mutation !== 'idle' || snapshot.attention !== attention) return Promise.resolve(snapshot);
    pending = {action: 'attention_ack', command, token, attentionRevision: attention.revision, acknowledged: false};
    return write(begin(), pending);
  }
  function dismissAttentionAcknowledgment(token) {
    if (disposed || pending?.action !== 'attention_ack' || pending.token !== token
      || ['submitting', 'recovering', 'refreshing'].includes(snapshot.mutation)) return false;
    // Explicitly retire local recovery, never claim to undo an append-only server
    // acknowledgment. A late exact-cycle ack cannot change Goals or settings.
    pending = null; retire(); visitGeneration++;
    publish({mutation: 'idle', error: null, attentionStatus: 'idle', attention: null, attentionError: null});
    return true;
  }

  async function write(task, intent) {
    if (!task.current() || pending !== intent) return snapshot;
    if (intent.action !== 'attention_ack') visitGeneration++;
    publish({mutation: 'submitting', error: null, outcome: null,
      ...(intent.action !== 'attention_ack' ? {attentionStatus: 'idle', attention: null, attentionError: null} : {})});
    try {
      if (!task.current() || pending !== intent) return snapshot;
      if (intent.action === 'attention_ack' && !validVisit(intent.token)) {
        if (task.current() && pending === intent) publish({mutation: 'uncertain',
          error: failure('visit-unavailable', 'The original visit is no longer current. Retry checks its saved result, or dismiss this acknowledgment.')});
        return snapshot;
      }
      if (!task.current() || pending !== intent) return snapshot;
      if (intent.action === 'bonus_draw' && !sourceAvailable()) {
        if (task.current() && pending === intent) publish({mutation: 'uncertain',
          error: failure('source-unavailable', 'Album Top sources are unavailable. Retry checks the saved outcome before continuing this same draw.')});
        return snapshot;
      }
      if (!task.current() || pending !== intent) return snapshot;
      const receipt = await provider[intent.action](intent.command, task.options);
      if (!task.current() || pending !== intent) return snapshot;
      intent.receipt = acceptReceipt(receipt, intent);
      intent.acknowledged = true;
      return await readAcknowledged(task);
    } catch (error) {
      if (!task.current() || pending !== intent) return snapshot;
      if (intent.action === 'bonus_draw' && error?.responseRejected === true
        && error.status === 403 && error.code === 'source_context_unavailable') {
        // This definitive source rejection is not account authority. Verify
        // retained account state before showing it again; a real account403
        // during that read still follows clearDenied(). Never auto-redraw.
        pending = null;
        await read(task);
        if (task.current() && snapshot.status === 'ready') publish({error: failure('source-unavailable',
          'Album Top sources are unavailable. Saved Goals and settings are kept. Refresh sources before another draw.')});
      } else if (denied(error)) clearDenied();
      else if (intent.action === 'attention_ack' && rejected(error)) {
        pending = null; visitGeneration++;
        publish({mutation: 'idle', attentionStatus: 'unavailable', attention: null,
          error: null, attentionError: failure('attention-conflict', 'The visit changed. Reload attention before acknowledging it.')});
      } else if (rejected(error)) {
        // A rejection is definitive for this command. Fresh state is required
        // before another explicitly requested mutation can obtain a new key.
        const label = actionLabel(intent);
        const message = intent.action === 'add' && error.code === 'weekly_capacity'
          ? 'The weekly goal is full. Reload Goals and choose another period or remove a weekly album.'
          : intent.action === 'add' && error.code === 'evidence_unavailable'
            ? 'This album preview has expired or is unavailable. Reload Goals, select the album again and review a new preview.'
            : `${label} was rejected. Reload Goals before trying again.`;
        pending = null;
        publish({status: 'unavailable', data: null, mutation: 'conflict',
          error: failure('conflict', message)});
      } else uncertain();
    }
    return snapshot;
  }
  function load() {
    if (disposed || pending) return Promise.resolve(snapshot);
    return read(begin());
  }
  function loadBonus() {
    if (disposed || pending) return Promise.resolve(snapshot);
    bonusRequested = true;
    return read(begin());
  }
  function selectPeriod(period) {
    if (!disposed && snapshot.mutation === 'idle' && GOAL_PERIODS.includes(period)
      && period !== snapshot.period) {visitGeneration++; publish({period});}
    return snapshot;
  }
  function ready(action) {
    const capability = {add: 'can_add', reset: 'can_reset', completion: 'can_complete', remove: 'can_remove',
      bonus_settings: 'can_add', bonus_draw: 'can_add', transition: 'can_reset'}[action];
    return !disposed && !pending && snapshot.status === 'ready' && snapshot.mutation === 'idle'
      && snapshot.data?.allowed_actions[capability] === true;
  }
  function startIntent(action, data, period, selected, fields = {}, evidence = null) {
    let command;
    try {
      const key = requestKey(), cycle = selected.cycle?.cycle_id ?? null;
      if (!uuid(key) || issuedKeys.has(key) || !revision(data.revision)
        || !(cycle === null || uuid(cycle))) throw new Error();
      let calendar = {};
      if (action === 'reset' || action === 'add') {
        if (typeof timezone !== 'string' || !timezone) throw new Error();
        // Only validate the selected zone. Calendar boundaries remain server-owned.
        new Intl.DateTimeFormat('en', {timeZone: timezone});
        calendar = {timezone_name: timezone};
      }
      command = Object.freeze({revision: data.revision, period, ...calendar,
        ...(action === 'add' ? {} : {expected_cycle_id: cycle}), request_key: key, ...fields});
      issuedKeys.add(key);
    } catch {
      if (!disposed && snapshot.data === data && snapshot.period === period) {
        publish({error: failure('invalid-command', `${actionLabel({action})} could not be prepared. Reload Goals and try again.`)});
      }
      return Promise.resolve(snapshot);
    }
    // Even key creation can reenter application code. Never dispatch against a
    // different captured owner, revision, period or capability after that seam.
    if (!ready(action) || snapshot.data !== data || snapshot.period !== period
      || (action === 'add' && (!provider.isEvidenceCurrent(evidence) || usedEvidence.has(evidence)))) return Promise.resolve(snapshot);
    if (action === 'add') usedEvidence.add(evidence);
    const expectedChanged = action === 'remove' || (action === 'completion' && (command.completed
      ? GOAL_PERIODS.some(name => data.periods[name].album_refs.includes(command.catalog_ref)
        && data.periods[name].manual_completed_at[command.catalog_ref] === null)
      : selected.manual_completed_at[command.catalog_ref] !== null));
    pending = {action, command, goalRef: data.goal_ref, total: selected.total, expectedChanged, acknowledged: false,
      ...(action === 'add' ? {selectedCycle: selected.cycle?.cycle_id ?? null, members: selected.album_refs,
        existingCycles: GOAL_PERIODS.map(name => data.periods[name].cycle?.cycle_id).filter(Boolean)} : {})};
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
  function add(evidence, expected) {
    if (!ready('add') || !object(expected) || !object(evidence) || usedEvidence.has(evidence)
      || !provider.isEvidenceCurrent(evidence)) return Promise.resolve(snapshot);
    const data = snapshot.data, period = snapshot.period;
    if (!ready('add') || expected.data !== data || expected.period !== period || expected.revision !== data.revision) return Promise.resolve(snapshot);
    return startIntent('add', data, period, data.periods[period],
      {evidence_ref: evidence.evidence_ref, evidence_version: evidence.evidence_version}, evidence);
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
  const sourceAvailable = () => {try {return canDrawBonus() === true;} catch {return false;}};
  function bonusReady(action, expected) {
    return ready(action) && snapshot.bonusStatus === 'ready' && object(expected)
      && expected.data === snapshot.data && expected.settings === snapshot.settings && expected.bonus === snapshot.bonus
      && expected.period === snapshot.period;
  }
  function startBonusIntent(action, expected, values) {
    if (!bonusReady(action, expected)) return Promise.resolve(snapshot);
    const {data, settings, bonus, period: selectedPeriod} = snapshot;
    const period = action === 'bonus_draw' ? 'week' : selectedPeriod;
    const selected = data.periods[period];
    if (action === 'bonus_draw' && (!sourceAvailable() || !settings.enabled || bonus.bonus !== null)) return Promise.resolve(snapshot);
    if (action === 'transition' && !uuid(selected.cycle?.cycle_id)) return Promise.resolve(snapshot);
    let command;
    try {
      const key = requestKey();
      if (!uuid(key) || issuedKeys.has(key)) throw new Error();
      if (action === 'bonus_settings') command = Object.freeze({request_key: key,
        settings_revision: settings.settings_revision, ...normalizeBonusValues(values)});
      else {
        if (typeof timezone !== 'string' || !timezone) throw new Error();
        new Intl.DateTimeFormat('en', {timeZone: timezone});
        command = Object.freeze({request_key: key, revision: data.revision,
          settings_revision: settings.settings_revision, expected_cycle_id: selected.cycle?.cycle_id ?? null,
          timezone_name: timezone, ...(action === 'transition' ? {period} : {})});
      }
      issuedKeys.add(key);
    } catch {
      if (bonusReady(action, expected)) publish({error: failure('invalid-command', 'The change could not be prepared. Reload Goals and try again.')});
      return Promise.resolve(snapshot);
    }
    // Key generation and source-context checks can reenter application code.
    if (!bonusReady(action, expected) || action === 'bonus_draw' && !sourceAvailable()
      || !bonusReady(action, expected)) return Promise.resolve(snapshot);
    pending = {action, command, goalRef: data.goal_ref, settings, bonus, selected,
      unfinishedCount: selected.total - selected.completed, acknowledged: false,
      unfinishedRefs: selected.album_refs.filter(ref => selected.manual_completed_at[ref] === null),
      allMembers: data.albums.map(row => row.catalog_ref),
      existingCycles: GOAL_PERIODS.map(name => data.periods[name].cycle?.cycle_id).filter(Boolean)};
    return write(begin(), pending);
  }
  const saveBonusSettings = (values, expected) => startBonusIntent('bonus_settings', expected, values);
  const drawBonus = expected => startBonusIntent('bonus_draw', expected);
  const transition = expected => startBonusIntent('transition', expected);
  async function retry() {
    if (disposed || ['submitting', 'recovering', 'refreshing'].includes(snapshot.mutation)) return snapshot;
    if (!pending) return load();
    const task = begin(), intent = pending;
    if (intent.acknowledged) return readAcknowledged(task);
    publish({mutation: 'recovering', error: null});
    try {
      if (!task.current() || pending !== intent) return snapshot;
      const result = await provider.operation(intent.command.request_key, task.options);
      if (!task.current() || pending !== intent) return snapshot;
      if (exactKeys(result, ['status', 'receipt']) && result.status === 'committed') {
        intent.receipt = acceptReceipt(result.receipt, intent);
        intent.acknowledged = true;
        return await readAcknowledged(task);
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
    visitGeneration++;
    visits = new WeakMap();
    retire();
    pending = null;
    publish({attentionStatus: 'idle', attention: null, attentionError: null, status: 'unavailable', data: null, period: 'week', mutation: 'idle', settings: null, bonus: null, bonusStatus: 'idle', outcome: null,
      error: failure('context', 'Your session changed. Reload Goals to continue.')});
  });
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadAttention, createVisit, acknowledgeVisit, dismissAttentionAcknowledgment,
    load, loadBonus, selectPeriod, reset, setCompletion, remove, add, retry, saveBonusSettings, drawBonus, transition,
    admissionFailed(error) {if (!disposed && denied(error)) clearDenied(); return snapshot;},
    dispose() {
      if (disposed) return;
      disposed = true;
      visits = new WeakMap();
      epoch++;
      retire();
      pending = null;
      snapshot = Object.freeze({status: 'idle', data: null, period: 'week', mutation: 'idle', error: null,
        settings: null, bonus: null, bonusStatus: 'idle', outcome: null,
        attentionStatus: 'idle', attention: null, attentionError: null});
      unsubscribe?.();
      listeners.clear();
      issuedKeys.clear();
    },
  });
}
