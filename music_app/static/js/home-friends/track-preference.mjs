const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const tiers = Object.freeze(['off', 'loved', 'obsessed']);
const labels = Object.freeze({off: 'Not loved', loved: 'Loved', obsessed: 'Obsessed'});
const actions = Object.freeze({off: 'Love', loved: 'Mark Obsessed', obsessed: 'Remove love'});
const contextKeys = ['scopeKey', 'playlist_id', 'account_ref', 'kind', 'period'];
const pendingFocus = new WeakMap();
const contextOf = value => Object.fromEntries(contextKeys.map(key => [key, value?.[key]]));
const sameContext = (left, right) => contextKeys.every(key => left?.[key] === right?.[key]);
const readable = row => row !== null && typeof row === 'object' && !Array.isArray(row)
  && row.source_readable !== false && !(own(row.allowed_actions, 'can_read') && row.allowed_actions.can_read === false);

export function normalizeTrackPreference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !own(value, 'identity') || typeof value.identity !== 'string' || !value.identity
    || !own(value, 'love_tier') || !tiers.includes(value.love_tier)) return null;
  return Object.freeze({identity: value.identity, love_tier: value.love_tier,
    rating: own(value, 'rating') && Number.isInteger(value.rating) && value.rating >= 1 && value.rating <= 5 ? value.rating : null,
    allowed_actions: Object.freeze({can_set_love_tier: own(value.allowed_actions, 'can_set_love_tier') && value.allowed_actions.can_set_love_tier === true})});
}

export function readTrackPreference(runtime, row, context) {
  if (!readable(row) || typeof runtime?.trackPreference !== 'function') return null;
  try {return normalizeTrackPreference(runtime.trackPreference(row, context));} catch {return null;}
}

/** Transient command state only. The native boundary owns authority and saved
 * preferences; acknowledgement never creates a React persistence cache. */
export function createTrackPreferenceController({getView, onChange = () => {}, onError = () => {}}) {
  const pending = new Map();
  let generation = 0;
  const read = row => {
    const view = getView();
    if (!view || !view.rows?.includes(row) || view.isCurrent?.() === false) return null;
    const preference = readTrackPreference(view.runtime, row, view.context);
    return preference ? {view, preference} : null;
  };
  const matching = operation => {
    if (operation.generation !== generation) return null;
    const current = read(operation.row);
    if (!current) return null;
    return current.view.source === operation.source && current.view.runtime === operation.runtime
      && sameContext(current.view.context, operation.context)
      && current.view.runtime.trackPreference === operation.reader && current.view.runtime.setTrackLove === operation.setter
      && current.preference.identity === operation.identity ? current : null;
  };
  const owns = operation => !operation.controller.signal.aborted && pending.get(operation.identity) === operation
    && matching(operation)?.preference.allowed_actions.can_set_love_tier === true;
  const cancel = () => {
    generation++;
    for (const operation of pending.values()) {operation.permissionLost = false; operation.controller.abort();}
    pending.clear();
  };
  return {
    get(row) {
      const current = read(row), operation = current && pending.get(current.preference.identity);
      return {preference: current?.preference || null, pending: Boolean(operation && owns(operation)),
        editable: Boolean(current?.preference.allowed_actions.can_set_love_tier && typeof current.view.runtime.setTrackLove === 'function')};
    },
    sync() {
      let changed = false;
      for (const [identity, operation] of pending) if (!owns(operation)) {
        operation.permissionLost = matching(operation)?.preference.allowed_actions.can_set_love_tier === false;
        operation.controller.abort(); pending.delete(identity); changed = true;
      }
      if (changed) onChange();
    },
    cancel,
    async cycle(row) {
      const current = read(row), runtime = current?.view.runtime;
      if (!current?.preference.allowed_actions.can_set_love_tier || typeof runtime.setTrackLove !== 'function'
        || pending.has(current.preference.identity)) return false;
      const operation = {row, runtime, generation, source: current.view.source, context: contextOf(current.view.context),
        identity: current.preference.identity, reader: runtime.trackPreference, setter: runtime.setTrackLove,
        controller: new AbortController(), love_tier: tiers[(tiers.indexOf(current.preference.love_tier) + 1) % tiers.length]};
      pending.set(operation.identity, operation); onChange();
      try {
        // Recheck after the event turn so a simultaneous source/provider change
        // cannot submit a write through a retired native row.
        await Promise.resolve();
        if (!owns(operation)) return false;
        const acknowledgement = normalizeTrackPreference(await operation.setter.call(runtime, {row,
          context: operation.context, love_tier: operation.love_tier, signal: operation.controller.signal}));
        if (!owns(operation)) return false;
        if (!acknowledgement || acknowledgement.identity !== operation.identity || acknowledgement.love_tier !== operation.love_tier
          || !acknowledgement.allowed_actions.can_set_love_tier) {
          throw new Error('Invalid track preference acknowledgement.');
        }
        return true;
      } catch (error) {
        const denied = error?.status === 401 || error?.status === 403;
        if (error?.name !== 'AbortError' && (owns(operation) || denied && operation.permissionLost && matching(operation))) {
          onError(denied ? 'You no longer have permission to change Love for this track.'
            : 'The Love change was not confirmed. Check the current value before trying again.');
        }
        return false;
      } finally {
        if (pending.get(operation.identity) === operation) {pending.delete(operation.identity); onChange();}
      }
    },
  };
}

export function trackLoveHtml(runtime, row, state = {}) {
  const escape = runtime.escapeHtml, preference = readable(row) ? normalizeTrackPreference(state.preference) : null;
  const supplied = own(row, 'love_tier') && tiers.includes(row.love_tier) ? row.love_tier
    : own(row, 'track_preference') && own(row.track_preference, 'love_tier') ? row.track_preference.love_tier : null;
  const tier = preference?.love_tier ?? (readable(row) && tiers.includes(supplied) ? supplied : null);
  const label = tier === null ? 'Love unavailable' : labels[tier];
  const editable = preference?.allowed_actions.can_set_love_tier === true && state.editable !== false && typeof runtime.setTrackLove === 'function';
  const content = editable ? runtime.actionHtml({icon: `love-${tier}`, presentation: 'bare', className: 'album-track-table__love',
    disabled: state.pending === true, ariaLabel: `${state.pending ? 'Saving Love for' : actions[tier] + ':'} ${row.title || 'track'}`,
    title: state.pending ? `${label} · Saving…` : `${label} · ${actions[tier]}`,
    attributes: {'data-track-love': '1', 'data-love-tier': tier, 'aria-pressed': String(tier !== 'off'), 'aria-busy': String(state.pending === true)}})
    : `<span class="album-track-table__love" data-love-tier="${tier || 'unknown'}" role="img" aria-label="${escape(label)}" title="${escape(label)} · Love editing is unavailable.">${tier === null ? '–' : typeof runtime.iconHtml === 'function' ? runtime.iconHtml(`love-${tier}`, {className: 'ui-icon--love'}) : escape(label)}</span>`;
  return `<span data-track-love-cell="1">${content}</span>`;
}

/** Preserve the native ActionButton, and recover its row's focus after pending
 * disables it or an acknowledged sort rebuilds the row. */
export function paintTrackLoveCell(cell, runtime, row, state) {
  if (!cell) return;
  const holder = cell.ownerDocument.createElement('span'); holder.innerHTML = trackLoveHtml(runtime, row, state);
  const next = holder.firstElementChild.firstElementChild;
  let current = cell.firstElementChild;
  const document = cell.ownerDocument;
  if (state?.pending && current?.tagName === 'BUTTON' && document.activeElement === current) pendingFocus.set(row, state.preference?.identity);
  if (!current || current.tagName !== next.tagName) {cell.replaceChildren(next); current = next;}
  else {
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
  }
  if (!state?.pending) {
    const restore = pendingFocus.get(row); pendingFocus.delete(row);
    const active = document.activeElement;
    if (restore && restore === state?.preference?.identity && current.tagName === 'BUTTON' && !current.disabled && current.isConnected
      && (!active || active === document.body || !active.isConnected)) current.focus({preventScroll: true});
  }
}
