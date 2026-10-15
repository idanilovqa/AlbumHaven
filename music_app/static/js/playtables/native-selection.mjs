import {bindPlaytableSelection,EMPTY_PLAYTABLE_SELECTION} from './selection.mjs';
import {createTrackPreferences} from '../home-friends/track-preference-ui.mjs';
import {paintTrackLoveCell} from '../home-friends/track-preference.mjs';
import {mountButton} from '../home-friends/native-controls.mjs';
import {mountTrackTablePresentation,mountTrackTableColumnsAction} from './native-track-table-presentation.mjs';
/** A native private source owns all queue authority. Fallback facts only highlight. */
export function createPlaytableSource(initial) {
  let options = initial, native = null, active = true, accepted = false;
  let exposed = [], revision = initial.revision, updates = 0;
  const identity = {runtime: initial.runtime, factory: initial.runtime.createPlaytableSource,
    instance: initial.instance, context: initial.context, enabled: initial.enabled};
  const current = () => active && options.runtime === identity.runtime
    && options.runtime.createPlaytableSource === identity.factory
    && options.instance === identity.instance && options.context === identity.context
    && options.enabled === identity.enabled && options.enabled !== false && options.isCurrent();
  function dispose() {
    if (!active) return;
    active = false;
    accepted = false;
    updates++;
    const previous = native;
    native = null;
    exposed = [];
    previous?.dispose?.();
  }
  const sourceAdapter = {
    snapshot: () => !current() || !accepted ? null : native ? native.snapshot()
      : {scopeKey: options.context.scopeKey, instance: options.instance, revision, rows: exposed},
    subscribe: listener => native?.subscribe(listener) || (() => {}),
    canQueue: keys => current() && accepted && native?.canQueue?.(keys) === true,
    captureQueue: (keys, settings) => current() && accepted ? native?.captureQueue?.(keys, settings) || null : null,
    resolveRows: keys => current() && accepted ? native?.resolveRows(keys) || null : null,
    retainNavigation: keys => current() && accepted ? native?.retainNavigation?.(keys) || null : null,
    updateRows(rows, nextRevision) {
      if (!current()) return false;
      const token = ++updates, owner = native;
      revision = nextRevision;
      if (owner) {
        const result = owner.updateRows(rows, nextRevision) === true;
        if (!active || updates !== token || native !== owner || !current()) return false;
        accepted = result;
      } else {
        const facts = rows.map(options.rowFacts);
        if (!active || updates !== token || !current()) return false;
        exposed = facts;
        accepted = true;
      }
      return accepted;
    },
    dispose
  };
  try {
    if (options.enabled !== false && typeof options.runtime.createPlaytableSource === 'function') {
      native = options.runtime.createPlaytableSource({rows: options.sourceRows, context: options.context,
        instance: options.instance, revision, isCurrent: current});
    }
    sourceAdapter.updateRows(options.rows, revision);
    return {
      sourceAdapter,
      actionsAvailable: options.enabled !== false && typeof options.runtime.createPlaytableSource === 'function'
        && typeof options.runtime.openPlaylistAction === 'function',
      update(next) {
        if (!active) return;
        options = next;
        sourceAdapter.updateRows(next.rows, next.revision);
      },
      dispose
    };
  } catch (error) {
    try {dispose();} catch {}
    throw error;
  }
}
export function mountPlaytableSelection(host, initialOptions) {
  if (!host?.ownerDocument) throw new TypeError('Playtable selection needs a host.');
  let options = initialOptions, disposed = false, constructing = true;
  let owner = null, unsubscribe = null, presentation = null, columns = null, love = null;
  let preferenceRuntime = null, preferenceOverride = null, safeSource = null, cleanupError = null;
  const acquired = [];
  const acquire = value => {if (constructing) acquired.push(() => value.dispose()); return value;};
  try {
    const ownsHost = !options.actionsHost;
    const actionsHost = options.actionsHost || host.ownerDocument.createElement('div');
    if (ownsHost) host.before(actionsHost);
    acquired.push(() => {actionsHost.replaceChildren(); if (ownsHost) actionsHost.remove();});
    actionsHost.className = 'album-track-table__selection-actions';
    const status = host.ownerDocument.createElement('span');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    const addHost = host.ownerDocument.createElement('span'), createHost = host.ownerDocument.createElement('span');
    const columnsHost = host.ownerDocument.createElement('span');
    actionsHost.replaceChildren(status, addHost, createHost, columnsHost);
    const buttons = host.ownerDocument.defaultView?.ButtonComponent;
    const runtime = options.runtime || (buttons ? {buttonHtml: value => buttons.renderButton(value)} : null);
    const add = runtime ? acquire(mountButton(addHost, runtime, {label: 'Add to playlist'})) : null;
    const create = runtime ? acquire(mountButton(createHost, runtime, {label: 'Create new playlist'})) : null;

    function refresh() {
      if (disposed) return;
      const snapshot = owner?.getSnapshot() || EMPTY_PLAYTABLE_SELECTION, count = snapshot.selectedCount;
      status.textContent = `${count} ${count === 1 ? 'row' : 'rows'} selected${snapshot.droppedCount > 0 ? ` · ${snapshot.droppedCount} no longer visible or selectable` : ''}`;
      const disabled = options.actionsAvailable === false || !count || typeof options.onPlaylistAction !== 'function';
      add?.update({label: 'Add to playlist', size: 'small', disabled,
        onClick: event => owner?.openSelection(event.target.closest('button'))});
      if (disposed) return;
      create?.update({label: 'Create new playlist', size: 'small', disabled,
        onClick: event => owner?.openSelection(event.target.closest('button'), {mode: 'create'})});
      if (!disposed) options.onSelectionChange?.(snapshot);
    }
    function connect() {
      if (options.enabled !== false) {
        const adapter = options.sourceAdapter;
        safeSource = {...adapter};
        for (const key of ['snapshot', 'canQueue', 'captureQueue', 'resolveRows', 'retainNavigation']) {
          if (typeof adapter[key] === 'function') safeSource[key] = (...args) => adapter[key](...args);
        }
        safeSource.subscribe = listener => {
          const stop = adapter.subscribe?.(listener);
          return () => {try {stop?.();} catch (error) {cleanupError ||= error;}};
        };
        owner = acquire(bindPlaytableSelection(host, {...options, sourceAdapter: safeSource}));
        for (const key of options.initialSelectedRowKeys || []) owner.select(key, {toggle: true});
        unsubscribe = owner.subscribe(refresh);
        if (constructing) acquired.push(unsubscribe);
      }
      refresh();
    }
    function present() {
      columns?.dispose(); presentation?.dispose(); columns = null; presentation = null;
      if (runtime && options.tablePresentation) {
        presentation = acquire(mountTrackTablePresentation(host, {runtime, ...options.tablePresentation}));
        columns = acquire(mountTrackTableColumnsAction(columnsHost, runtime, presentation));
      }
    }
    function preferenceOptions() {
      const preference = options.trackPreferences;
      if (!preferenceRuntime || preferenceOverride !== preference.runtime) {
        preferenceOverride = preference.runtime; preferenceRuntime = {...runtime, ...preference.runtime};
      }
      return {runtime: preferenceRuntime, source: options.sourceAdapter, rows: preference.rows,
        context: preference.context, isCurrent: () => Boolean(options.sourceAdapter.snapshot()), onError: options.onError};
    }
    function paint() {
      if (disposed || !love || !options.trackPreferences) return;
      const native = {...runtime, ...options.trackPreferences.runtime};
      const rows = new Map(options.trackPreferences.rows.map(row => [row.rowKey, row]));
      for (const element of host.querySelectorAll('[data-cdt-row-key]')) {
        const row = rows.get(element.getAttribute('data-cdt-row-key'));
        if (row) paintTrackLoveCell(element.querySelector('[data-track-love-cell]'), native, row, love.get(row));
      }
    }
    function preferenceEvent(event) {
      const button = event.target.closest?.('[data-track-love]');
      if (!button || !host.contains(button) || !love) return;
      event.stopPropagation();
      if (event.type !== 'click') return;
      event.preventDefault();
      if (button.disabled || event.detail > 1) return;
      const key = button.closest('[data-cdt-row-key]')?.getAttribute('data-cdt-row-key');
      const row = options.trackPreferences?.rows.find(row => row.rowKey === key);
      if (row) love.cycle(row);
    }
    function preferences() {
      if (options.trackPreferences && ['escapeHtml', 'actionHtml', 'iconHtml'].every(key => typeof runtime?.[key] === 'function')) {
        if (!love) love = acquire(createTrackPreferences(preferenceOptions(), paint));
        else love.update(preferenceOptions());
        paint();
      } else {love?.dispose(); love = null;}
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      let firstError = cleanupError;
      const release = action => {
        try {action();} catch (error) {firstError ||= cleanupError || error;}
        firstError ||= cleanupError;
      };
      release(() => unsubscribe?.());
      release(() => owner?.dispose());
      release(() => love?.dispose());
      for (const type of ['click', 'dblclick', 'pointerdown']) release(() => host.removeEventListener(type, preferenceEvent, true));
      release(() => columns?.dispose()); release(() => presentation?.dispose());
      release(() => add?.dispose()); release(() => create?.dispose());
      release(() => actionsHost.replaceChildren());
      if (ownsHost) release(() => actionsHost.remove());
      acquired.length = 0;
      if (firstError || cleanupError) throw firstError || cleanupError;
    }
    for (const type of ['click', 'dblclick', 'pointerdown']) {
      host.addEventListener(type, preferenceEvent, true);
      acquired.push(() => host.removeEventListener(type, preferenceEvent, true));
    }
    connect(); present(); preferences(); constructing = false; acquired.length = 0;
    return {
      getSnapshot: () => owner?.getSnapshot() || EMPTY_PLAYTABLE_SELECTION,
      openSelection: (anchor, value) => owner?.openSelection(anchor, value) || false,
      select: (key, value) => owner?.select(key, value),
      update(next) {
        if (disposed) return;
        const merged = {...options, ...next};
        const replaced = merged.sourceAdapter !== options.sourceAdapter || merged.enabled !== options.enabled;
        options = merged;
        if (replaced) {unsubscribe?.(); owner?.dispose(); owner = null; connect();}
        else {owner?.update({...options, sourceAdapter: safeSource}); if (disposed) return; refresh();}
        if (disposed) return;
        if (presentation && options.tablePresentation) presentation.update({runtime, ...options.tablePresentation});
        else present();
        if (!disposed) preferences();
      },
      dispose
    };
  } catch (error) {
    disposed = true;
    for (const cleanup of acquired.splice(0).reverse()) {try {cleanup();} catch {}}
    throw error;
  }
}
