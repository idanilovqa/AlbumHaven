import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '../home-friends/components.jsx';
import {bindPlaytableSelection, EMPTY_PLAYTABLE_SELECTION} from './selection.mjs';
import {TrackTableColumnsAction, useTrackTablePresentation} from './track-table-presentation.jsx';
import {useTrackPreferences} from '../home-friends/track-preference.jsx';
import {paintTrackLoveCell} from '../home-friends/track-preference.mjs';

/** Consumer bridge for a native private source. Without that factory, the
 * fallback exposes only caller-supplied public facts for highlight/inspection. */
export function usePlaytableSource({runtime, sourceRows, rows, context, instance, revision, isCurrent, rowFacts, enabled = true}) {
  const latest = useRef(null), factory = runtime.createPlaytableSource;
  latest.current = {runtime, instance, context, isCurrent, rowFacts, factory, enabled};
  const owner = useMemo(() => {
    const current = () => latest.current.runtime === runtime && latest.current.instance === instance
      && latest.current.context === context && latest.current.factory === factory && latest.current.enabled === true
      && latest.current.isCurrent();
    let native = null, exposed = [], view = revision, active = false, accepted = false;
    const dispose = () => {active = false; accepted = false; native?.dispose?.(); native = null; exposed = [];};
    const sourceAdapter = {
      snapshot: () => !active || !accepted ? null : native ? native.snapshot()
        : current() ? {scopeKey: context.scopeKey, instance, revision: view, rows: exposed} : null,
      subscribe: listener => native?.subscribe(listener) || (() => {}),
      canQueue: keys => active && accepted && native?.canQueue?.(keys) === true,
      captureQueue: (keys, options) => active && accepted ? native?.captureQueue?.(keys, options) || null : null,
      resolveRows: keys => active && accepted ? native?.resolveRows(keys) || null : null,
      retainNavigation: keys => active && accepted ? native?.retainNavigation?.(keys) || null : null,
      updateRows(next, nextRevision) {
        if (!active || !enabled) return false;
        if (native) {accepted = native.updateRows(next, nextRevision) === true; return accepted;}
        exposed = next.map(latest.current.rowFacts); view = nextRevision; accepted = true; return true;
      },
      dispose,
    };
    return {sourceAdapter,
      connect() {
        active = true;
        if (enabled && typeof factory === 'function') native = factory.call(runtime, {rows: sourceRows, context, instance, revision, isCurrent: current});
      },
      dispose,
    };
  }, [runtime, factory, instance, context, enabled]);
  const sourceAdapter = owner.sourceAdapter;
  // Native subscriptions start only after commit. Effect replay recreates the
  // native source instead of reusing a permanently disposed adapter.
  useLayoutEffect(() => {owner.connect(); return owner.dispose;}, [owner]);
  useLayoutEffect(() => {sourceAdapter.updateRows?.(rows, revision);}, [sourceAdapter, rows, revision]);
  return {sourceAdapter, actionsAvailable: enabled && typeof factory === 'function' && typeof runtime.openPlaylistAction === 'function'};
}

/** React owns lifetime and affordances; existing native tables retain markup,
 * playback and inspection. Consumers call ownerRef.current.update() after a
 * native table replacement, or let this layout effect refresh after rendering. */
export function usePlaytableSelection(hostRef, options) {
  const ownerRef = useRef(null), latest = useRef(options);
  latest.current = options;
  const [snapshot, setSnapshot] = useState(EMPTY_PLAYTABLE_SELECTION);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || options.enabled === false) {setSnapshot(EMPTY_PLAYTABLE_SELECTION); return undefined;}
    const owner = bindPlaytableSelection(host, latest.current);
    ownerRef.current = owner;
    for (const rowKey of latest.current.initialSelectedRowKeys || []) owner.select(rowKey, {toggle: true});
    const refresh = () => {
      const next = owner.getSnapshot(); setSnapshot(next);
      latest.current.onSelectionChange?.(next);
    };
    const unsubscribe = owner.subscribe(refresh); refresh();
    return () => {unsubscribe(); owner.dispose(); if (ownerRef.current === owner) ownerRef.current = null;};
  }, [hostRef, options.sourceAdapter, options.enabled]);
  useLayoutEffect(() => {ownerRef.current?.update(options);});
  return {snapshot, ownerRef};
}

export function PlaytableSelectionActions({runtime, snapshot, ownerRef, available = true, children}) {
  const count = snapshot.selectedCount;
  return <div className="album-track-table__selection-actions">
    <span role="status" aria-live="polite" aria-atomic="true">{count} {count === 1 ? 'row' : 'rows'} selected
      {snapshot.droppedCount > 0 ? ` · ${snapshot.droppedCount} no longer visible or selectable` : ''}</span>
    <Button runtime={runtime} disabled={!available || !count} size="small"
      onClick={event => ownerRef.current?.openSelection(event.target.closest('button'))}>Add to playlist</Button>
    <Button runtime={runtime} disabled={!available || !count} size="small"
      onClick={event => ownerRef.current?.openSelection(event.target.closest('button'), {mode: 'create'})}>Create new playlist</Button>
    {children}
  </div>;
}

function MountedColumns({hostRef, runtime, presentation}) {
  const columns = useTrackTablePresentation(hostRef, {runtime, ...presentation});
  return <TrackTableColumnsAction runtime={runtime} {...columns}/>;
}

function MountedPreferences({hostRef, options, runtime}) {
  const preference = options.trackPreferences;
  const source = options.sourceAdapter;
  const native = useMemo(() => ({...runtime, ...preference.runtime}), [runtime, preference.runtime]);
  const love = useTrackPreferences({runtime: native, source, rows: preference.rows, context: preference.context,
    isCurrent: () => Boolean(source.snapshot()), onError: options.onError});
  const latest = useRef(null);
  latest.current = {love, rows: preference.rows};
  useLayoutEffect(() => {
    const rows = new Map(preference.rows.map(row => [row.rowKey, row]));
    for (const element of hostRef.current.querySelectorAll('[data-cdt-row-key]')) {
      const row = rows.get(element.getAttribute('data-cdt-row-key'));
      if (row) paintTrackLoveCell(element.querySelector('[data-track-love-cell]'), native, row, love.get(row));
    }
  });
  useLayoutEffect(() => {
    const host = hostRef.current;
    const activate = event => {
      const button = event.target.closest?.('[data-track-love]');
      if (!button || !host.contains(button)) return;
      event.stopPropagation();
      if (event.type !== 'click') return;
      event.preventDefault();
      if (button.disabled || event.detail > 1) return;
      const key = button.closest('[data-cdt-row-key]')?.getAttribute('data-cdt-row-key');
      const row = latest.current.rows.find(row => row.rowKey === key);
      if (row) latest.current.love.cycle(row);
    };
    for (const type of ['click', 'dblclick', 'pointerdown']) host.addEventListener(type, activate, true);
    return () => {for (const type of ['click', 'dblclick', 'pointerdown']) host.removeEventListener(type, activate, true);};
  }, [hostRef, source]);
  return null;
}

function MountedSelection({host, options, bridge}) {
  const hostRef = useRef(host);
  const selection = usePlaytableSelection(hostRef, options);
  useLayoutEffect(() => {bridge.current = selection.ownerRef.current; return () => {bridge.current = null;};}, [options.sourceAdapter, selection.ownerRef, bridge]);
  const buttons = host.ownerDocument.defaultView?.ButtonComponent;
  const runtime = useMemo(() => options.runtime || (buttons ? {buttonHtml: value => buttons.renderButton(value)} : null), [options.runtime, buttons]);
  const canPaintLove = options.trackPreferences && ['escapeHtml', 'actionHtml', 'iconHtml'].every(key => typeof runtime?.[key] === 'function');
  return runtime ? <>
    <PlaytableSelectionActions {...selection} runtime={runtime} available={typeof options.onPlaylistAction === 'function'}>
      {options.tablePresentation ? <MountedColumns hostRef={hostRef} runtime={runtime} presentation={options.tablePresentation}/> : null}
    </PlaytableSelectionActions>
    {canPaintLove ? <MountedPreferences hostRef={hostRef} options={options} runtime={runtime}/> : null}
  </> : null;
}

/** Existing production React entry exposes this mount to native Album/Loose
 * Tracks. The sibling action host survives native table HTML replacement. */
export function mountPlaytableSelection(host, options) {
  if (!host?.ownerDocument) throw new TypeError('Playtable selection needs a host.');
  let disposed = false, current = options;
  const bridge = {current: null}, ownsHost = !options.actionsHost;
  const actionsHost = options.actionsHost || host.ownerDocument.createElement('div');
  if (ownsHost) host.before(actionsHost);
  const root = createRoot(actionsHost);
  const render = () => root.render(<MountedSelection host={host} options={current} bridge={bridge}/>);
  render();
  return {
    getSnapshot: () => bridge.current?.getSnapshot() || EMPTY_PLAYTABLE_SELECTION,
    openSelection: (anchor, options) => bridge.current?.openSelection(anchor, options) || false,
    update(next) {if (disposed) return;
      const replaced = next?.sourceAdapter && next.sourceAdapter !== current.sourceAdapter;
      current = {...current, ...next};
      if (replaced) {bridge.current?.dispose(); bridge.current = null;}
      else bridge.current?.update(current);
      render();
    },
    dispose() {if (disposed) return; disposed = true;
      // Retire callbacks immediately even if React schedules its cleanup later.
      bridge.current?.dispose(); root.unmount(); if (ownsHost) actionsHost.remove();
    },
  };
}
