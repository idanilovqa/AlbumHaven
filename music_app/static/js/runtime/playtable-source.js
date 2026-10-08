/* Private source bindings for the shared React playtable owner. Media and write
   refs never enter its public snapshot, action packet, DOM keys or history. */
function createPrivatePlaytableSource({scopeKey, rows, instance, revision, isCurrent, resolveRow,
  creationSource = () => null, subscribe, navigationCurrent = isCurrent, resolveNavigationRow = resolveRow, retainNavigationSource} = {}) {
  const nativeScope = TrackActionsRuntime.scope(), baseline = new Set(rows || []), listeners = new Set();
  let visibleRows = Array.from(rows || []), viewRevision = revision, retired = false;
  const keyFor = row => row?.row_key ?? row?.rowKey ?? row?.id;
  const readable = row => row?.source_readable !== false && row?.readable !== false
    && !(Object.hasOwn(row?.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read !== true);
  const notify = () => {for (const listener of [...listeners]) listener();};
  const active = () => {
    if (retired) return false;
    try {
      if (nativeScope.token === TrackActionsRuntime.scope().token
        && typeof isCurrent === 'function' && isCurrent() === true) return true;
    } catch { /* A retired native owner cannot revive through an old callback. */ }
    retired = true; notify(); return false;
  };
  const snapshot = () => active() ? {scopeKey, instance, revision: viewRevision, rows: visibleRows.map(row => ({
    rowKey: keyFor(row), sectionKey: row.sectionKey, readable: readable(row), selectable: readable(row) && row.selectable !== false,
  }))} : null;
  const check = () => {active(); notify();};
  let unsubscribe = null;
  return Object.freeze({snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe && !retired && typeof subscribe === 'function') unsubscribe = subscribe(check);
      return () => {listeners.delete(listener); if (!listeners.size) {unsubscribe?.(); unsubscribe = null;}};
    },
    updateRows(next, nextRevision) {
      if (!active() || !Array.isArray(next) || next.some(row => !baseline.has(row))) return false;
      if (viewRevision === nextRevision && visibleRows.length === next.length && next.every((row, index) => row === visibleRows[index])) return true;
      visibleRows = [...next]; viewRevision = nextRevision; notify(); return true;
    },
    resolveRows(keys) {
      if (!active() || !Array.isArray(keys) || new Set(keys).size !== keys.length) return null;
      const found = keys.map(key => visibleRows.filter(row => keyFor(row) === key));
      if (found.some(matches => matches.length !== 1 || !readable(matches[0]) || matches[0].selectable === false)) return null;
      const resolved = found.map(([row]) => {
        const source = resolveRow(row);
        if (!source || source.source_readable === false || Object.hasOwn(source.allowed_actions || {}, 'can_read') && source.allowed_actions.can_read !== true) return null;
        return {rowKey: keyFor(row), track_ref: source.track_ref,
          ...(Object.hasOwn(source, 'canonical_track_ref') ? {canonical_track_ref: source.canonical_track_ref} : {}),
          ...(Object.hasOwn(source, 'entry_ref') ? {entry_ref: source.entry_ref} : {})};
      });
      if (!active() || resolved.some(row => !row)) return null;
      return {rows: resolved, playlist_creation_source: creationSource(found.map(([row]) => row))};
    },
    retainNavigation(keys) {
      if (!active() || !Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length) return null;
      const selected = keys.map(key => visibleRows.filter(row => keyFor(row) === key));
      if (selected.some(matches => matches.length !== 1 || !readable(matches[0]))) return null;
      const capturedRevision = viewRevision, selectedRows = selected.map(([row]) => row);
      const transferredCurrent = typeof retainNavigationSource === 'function' ? retainNavigationSource() : navigationCurrent;
      if (typeof transferredCurrent !== 'function') return null;
      const mapping = () => JSON.stringify(selectedRows.map(row => {
        const source = resolveNavigationRow(row);
        if (!source || source.source_readable === false || Object.hasOwn(source.allowed_actions || {}, 'can_read') && source.allowed_actions.can_read !== true) throw new Error('Source unavailable');
        return [source.track_ref, source.canonical_track_ref, source.entry_ref];
      }));
      let before;
      try {if (!transferredCurrent()) return null; before = mapping();} catch {return null;}
      let released = false;
      return Object.freeze({isCurrent() {
        if (released) return false;
        try {
          if (nativeScope.token === TrackActionsRuntime.scope().token && capturedRevision === viewRevision && transferredCurrent()
            && before === mapping()) return true;
        } catch { /* Fail closed when the transferred private source is gone. */ }
        released = true; return false;
      }, dispose() {released = true;}});
    },
    dispose() {if (retired) {unsubscribe?.(); listeners.clear(); return;} retired = true; unsubscribe?.(); notify(); listeners.clear();},
  });
}

const NativePlaytables = (() => {
  const owners = new Map();
  let serial = 0;
  function retire(key) {
    const owner = owners.get(key);
    if (!owner) return;
    const sourceView = state.view;
    owners.delete(key); owner.source.dispose(); owner.mount?.dispose(); owner.observer?.disconnect();
    window.removeEventListener('popstate', owner.check);
    if (typeof loadNextRootGalleryPage === 'function' && typeof scheduleBrowserAnimationFrame === 'function') {
      scheduleBrowserAnimationFrame(() => {if (state.view === sourceView) void loadNextRootGalleryPage();});
    }
  }
  function prepare(key, sourceIdentity, groups, privateRows, isCurrent, retainNavigationSource) {
    retire(key);
    const scopeKey = window.AlbumHavenPlaylistRuntime?.snapshot().scopeKey;
    const scope = TrackActionsRuntime.scope(), sourceView = state.view, identity = {}, rows = [], mapping = new Map();
    let offset = 0;
    for (const [sectionIndex, group] of groups.entries()) {
      group.sectionKey ||= `section-${sectionIndex + 1}`;
      for (const track of group.tracks) {
        const source = privateRows[offset++], rowKey = `native-playtable-${++serial}`;
        const readable = Boolean(source) && source.source_readable !== false
          && !(Object.hasOwn(source.allowed_actions || {}, 'can_read') && source.allowed_actions.can_read !== true);
        track.rowKey = rowKey; track.readable = readable; track.selectable = readable && source.selectable !== false;
        track.canPlay = readable && source?.availability !== 'missing'
          && !(Object.hasOwn(source.playback_state || {}, 'can_start_here') && source.playback_state.can_start_here !== true);
        track.availability = source?.availability;
        const row = {rowKey, sectionKey: group.sectionKey, readable, selectable: track.selectable};
        rows.push(row); mapping.set(row, source);
      }
    }
    const owner = {identity, sourceIdentity, mount: null, host: null};
    owners.set(key, owner);
    owner.source = createPrivatePlaytableSource({scopeKey, rows, instance: identity, revision: identity,
      isCurrent: () => owners.get(key) === owner && state.view === sourceView && TrackActionsRuntime.scope().token === scope.token && isCurrent(),
      resolveRow: row => mapping.get(row), creationSource: () => sourceView?.playlist_creation_source || null,
      ...(retainNavigationSource ? {retainNavigationSource} : {})});
    owner.check = () => {owner.mount?.update();};
    return owner;
  }
  function mount(key, host) {
    const owner = owners.get(key), ui = window.AlbumHavenPlaytableUI;
    if (owner && host) owner.host = host;
    if (!owner || !host || !ui?.mount || !owner.source.snapshot()) return false;
    owner.mount?.dispose(); owner.observer?.disconnect(); owner.host = host;
    owner.mount = ui.mount(host, {sourceAdapter: owner.source, tableKey: key,
      onPlay(rowKey, event, options) {
        if (!owner.source.snapshot()) return;
        const rows = [...host.querySelectorAll('[data-cdt-row-key]')].filter(row => row.getAttribute('data-cdt-row-key') === rowKey);
        if (rows.length === 1 && rows[0].dataset.trackPlaying === 'true' && options?.restart !== true) return;
        const button = rows.length === 1 && rows[0].querySelector('.play-track-button');
        if (button && !button.disabled) activateSharedTrackButton(button, {restart: options?.restart === true, focusTimeline: event?.isTrusted !== false});
      },
      onPlaylistAction: (packet, lifetime, anchor) => ui.open(packet, lifetime, owner.source, anchor),
      onError: () => showToast('The selected-track action is unavailable.', 'error', 3200),
    });
    if (typeof MutationObserver === 'function') {
      owner.observer = new MutationObserver(owner.check);
      const shell = document.getElementById('app-shell');
      if (shell) owner.observer.observe(shell, {attributes: true, attributeFilter: ['hidden', 'data-native-account-id', 'data-native-library-id']});
    }
    window.addEventListener('popstate', owner.check); return true;
  }
  window.addEventListener('albumhaven:playtable-ui-ready', () => {
    for (const [key, owner] of owners) if (owner.host) mount(key, owner.host);
  });
  return {prepare, mount, retire,
    hasActiveSource: () => [...owners.values()].some(owner => owner.source.snapshot() !== null)};
})();
