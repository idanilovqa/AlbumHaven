import {mountButton, mountTabs} from '../home-friends/native-controls.mjs';
import {bindTrackTablePresentation} from '../playtables/track-table-presentation.mjs';
import {createPlaytableSource, mountPlaytableSelection} from '../playtables/native-selection.mjs';

// Foreground Search owns admission. Native action authority stays in its private
// runtime; this consumer keeps only admitted rows and opaque selection keys.
let mounted = null;
const stalePublication = Symbol('stale Search publication');
const presentations = ['albums', 'tracks'];

export function mountSearchResults({host, runtime} = {}) {
  if (!host || !runtime) return null;
  const document = host.ownerDocument, window = document.defaultView;
  const currentPair = () => host.isConnected && document.getElementById('search-results-root') === host
    && window.AlbumHavenSearchRuntime === runtime;
  if (!currentPair() || mounted?.phase === 'disposing') return null;
  if (mounted?.host === host && mounted.runtime === runtime) return mounted.owner;
  mounted?.owner.dispose();
  if (mounted || !currentPair()) return null;

  const record = {host, runtime, owner: null, phase: 'live'};
  let session = null, unsubscribe = null, structure = null, rendering = false, queued = false;
  const live = () => mounted === record && record.phase === 'live' && currentPair();
  function publicationCurrent(snapshot, ready = false) {
    if (!live() || runtime.snapshot() !== snapshot || !live()) return false;
    if (ready && (snapshot.status !== 'ready' || snapshot.actionable !== true
      || runtime.isCurrent(snapshot) !== true)) return false;
    return live() && runtime.snapshot() === snapshot && live();
  }
  function contentCurrent(candidate, ready = false) {
    return session === candidate && candidate.live && publicationCurrent(candidate.snapshot, ready)
      && session === candidate && candidate.live;
  }
  function checked(candidate, work, ready = false) {
    if (!contentCurrent(candidate, ready)) throw stalePublication;
    const result = work();
    if (!contentCurrent(candidate, ready)) throw stalePublication;
    return result;
  }
  function checkedOwner(candidate, work, ready = false) {
    if (!contentCurrent(candidate, ready)) throw stalePublication;
    const result = work();
    if (!contentCurrent(candidate, ready)) {
      try {result?.dispose();} finally {throw stalePublication;}
    }
    return result;
  }
  function controlCurrent(candidate, ready = false) {
    return contentCurrent(candidate, ready) && candidate.root.parentElement === host
      && !candidate.root.hidden && !candidate.root.hasAttribute('inert') && !host.hidden;
  }
  function command(candidate, ready, work) {
    if (!controlCurrent(candidate, ready)) return false;
    return work(candidate.snapshot);
  }
  function release(candidate) {
    if (!candidate) return;
    candidate.live = false;
    candidate.root.hidden = true; candidate.root.setAttribute('inert', '');
    // Detach every owner before disposal callbacks can publish a successor.
    const owners = [candidate.selection, candidate.playtableSource, candidate.presentation, candidate.tabs, candidate.columnsButton,
      candidate.continueButton, candidate.retryButton, candidate.sidebarButton];
    candidate.selection = candidate.playtableSource = null;
    candidate.presentation = candidate.tabs = candidate.columnsButton = null;
    candidate.continueButton = candidate.retryButton = candidate.sidebarButton = null;
    candidate.root.removeEventListener('click', candidate.click);
    const stopPlayback = candidate.stopPlayback; candidate.stopPlayback = null;
    try {stopPlayback?.();} catch { /* Remaining exact owners must still retire. */ }
    for (const owner of owners) {
      try {owner?.dispose();} catch { /* Other native owners must still retire. */ }
    }
    candidate.root.remove();
  }
  function clearSession() {
    const previous = session; session = null;
    release(previous);
  }
  const owner = Object.freeze({dispose() {
    if (mounted !== record || record.phase !== 'live') return;
    record.phase = 'disposing'; queued = false;
    host.hidden = true;
    const previous = session, stop = unsubscribe; session = null; unsubscribe = null;
    if (previous) {previous.live = false; previous.root.hidden = true; previous.root.setAttribute('inert', '');}
    structure?.disconnect(); structure = null;
    try {
      try {stop?.();} finally {
        // Recheck after unsubscribe callbacks. Removing this host still retires
        // its runtime, while a replacement host/runtime keeps its own source.
        const currentHost = document.getElementById('search-results-root');
        if (window.AlbumHavenSearchRuntime === runtime && (!currentHost || currentHost === host)) runtime.retire('unmount');
      }
    } finally {
      release(previous);
      record.phase = 'disposed';
      if (mounted === record) mounted = null;
    }
  }});
  record.owner = owner; mounted = record;

  function nativeControls(candidate) {
    return {
      buttonHtml: config => checked(candidate, () => runtime.buttonHtml(config)),
      actionHtml: config => checked(candidate, () => runtime.actionHtml(config)),
      tabsHtml: config => checked(candidate, () => runtime.tabsHtml(config)),
      mountTabs(node) {
        if (!contentCurrent(candidate)) throw stalePublication;
        const tabs = runtime.mountTabs(node);
        if (!contentCurrent(candidate)) {tabs?.dispose(); throw stalePublication;}
        return tabs;
      },
    };
  }
  function element(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    parent?.append(node);
    return node;
  }
  function tabsOptions(candidate) {
    return {id: 'search-results-tabs', label: 'Search presentation', value: candidate.snapshot.presentation,
      items: presentations.map(key => [key, key === 'albums' ? 'Albums' : 'Tracks',
        {disabled: !candidate.ready, panelId: `search-results-${key}-panel`}]),
      onChange: value => command(candidate, true, snapshot => runtime.selectPresentation(snapshot, value))};
  }
  function createSession(snapshot, ready) {
    const root = element('div', 'search-results');
    root.setAttribute('data-search-results-content', ''); root.hidden = true;
    const next = {root, snapshot, ready, live: true, resultId: snapshot.resultId,
      source: snapshot.sourceIdentity, result: snapshot.result, mode: snapshot.presentation,
      galleryMode: null, choices: {}, tabs: null, presentation: null, columnsButton: null,
      continueButton: null, retryButton: null, sidebarButton: null, selection: null, playtableSource: null,
      stopPlayback: null, actionSequence: 0};
    session = next; next.native = nativeControls(next);
    next.tabsHost = element('div', 'search-results__tabs', root);
    for (const key of presentations) {
      const panel = element('div', 'search-results__panel', root);
      panel.id = `search-results-${key}-panel`; panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `search-results-tabs-${key}`);
      panel.hidden = key !== snapshot.presentation;
      if (!panel.hidden) next.panel = panel;
    }
    next.status = element('div', 'search-results__status', next.panel);
    next.actionStatus = element('div', 'search-results__status', next.panel); next.actionStatus.hidden = true;
    next.body = element('div', 'search-results__body', next.panel);
    next.actions = element('div', 'search-results__actions', next.panel);
    next.continueHost = element('span', '', next.actions);
    next.retryHost = element('span', '', next.actions);
    next.sidebar = element('div', 'search-results__sidebar-progress', root);
    next.sidebarStatus = element('div', 'search-results__status', next.sidebar);
    next.sidebarAction = element('span', '', next.sidebar);
    next.tabs = checkedOwner(next, () => mountTabs(next.tabsHost, next.native, tabsOptions(next)));
    if (ready && snapshot.result[snapshot.presentation].length) {
      if (snapshot.presentation === 'tracks') buildTracks(next);
      else paintAlbums(next);
    }
    if (!contentCurrent(next)) throw stalePublication;
    host.replaceChildren(root);
    if (!contentCurrent(next)) throw stalePublication;
    root.hidden = false; host.hidden = false;
    if (next.tableHost) connectTable(next);
    next.click = event => activate(next, event);
    root.addEventListener('click', next.click);
    if (next.tableHost) {
      const stop = runtime.subscribeTrackPlayback(() => paintTrackActions(next));
      if (!contentCurrent(next, true)) {stop?.(); throw stalePublication;}
      next.stopPlayback = stop;
      paintTrackActions(next);
    }
    return next;
  }
  function paintAlbums(candidate) {
    const snapshot = candidate.snapshot;
    const grants = snapshot.result.albums.map(album => checked(candidate, () => runtime.canOpenAlbum(snapshot, album), true));
    const signature = JSON.stringify([snapshot.galleryDisplayMode, grants]);
    if (candidate.galleryMode === signature) return;
    const html = snapshot.result.albums.map((album, index) => {
      const artboxHtml = checked(candidate, () => runtime.artboxHtml({state: 'empty', label: `${album.name} artwork`}), true);
      return checked(candidate, () => runtime.galleryCardHtml({interaction: 'controlled', identity: album.albumRef,
        actionRef: album.albumRef, actions: {select: grants[index], open: grants[index]},
        displayMode: snapshot.galleryDisplayMode, title: album.name, artist: album.artist, year: album.year,
        isSearchMatch: album.isSearchMatch === true, artboxHtml, listeningSummaryHtml: ''}), true);
    }).join('');
    if (!contentCurrent(candidate, true)) throw stalePublication;
    candidate.body.className = 'search-results__body search-results__albums';
    candidate.body.setAttribute('data-gallery-display', snapshot.galleryDisplayMode);
    candidate.body.innerHTML = html; candidate.galleryMode = signature;
  }
  function buildTracks(candidate) {
    const columns = checked(candidate, () => runtime.trackColumns(), true).flatMap(column => column.key === 'title'
      ? [column, {key: 'artist', label: 'Artist', width: 112, autoMinWidth: 641},
        {key: 'album', label: 'Album', width: 112, autoMinWidth: 641}] : [column]);
    const rows = candidate.snapshot.result.tracks.map((track, index) => {
      const seconds = track.durationSeconds;
      const duration = seconds === null ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      const native = checked(candidate, () => runtime.albumTrackRow({rowKey: track.rowKey, title: track.title,
        trackNumber: track.trackNumber, duration, readable: true, selectable: track.selectable, isSearchMatch: false}, index), true);
      const artbox = checked(candidate, () => runtime.artboxHtml({state: 'empty', label: `${track.title} artwork`}), true);
      const artist = checked(candidate, () => runtime.escapeHtml(track.artist), true);
      const album = checked(candidate, () => runtime.escapeHtml(track.album), true);
      const canOpen = checked(candidate, () => runtime.canOpenAlbum(candidate.snapshot, track), true);
      const play = checked(candidate, () => runtime.actionHtml({icon: 'play', ariaLabel: `Play ${track.title}`,
        presentation: 'bare', className: 'album-track-table__play', disabled: !runtime.canPlayTrack(candidate.snapshot, track),
        attributes: {'data-search-track-play': track.rowKey}}), true);
      const details = checked(candidate, () => runtime.actionHtml({icon: 'more', ariaLabel: `Open Album for ${track.title}`,
        presentation: 'bare', disabled: !canOpen, attributes: {'data-search-track-details': track.rowKey}}), true);
      // The native selection anatomy is retained, but private paths and native
      // media attributes never enter these rows. Each activation resolves anew.
      return {...native, cells: {
        number: {content: native.cells.number.content.replace('</span>', '</span>' + play)}, duration: native.cells.duration,
        title: {content: `<div class="home-detail__release">${artbox}${native.cells.title.content}</div>`},
        artist: {content: artist}, album: {content: `${album}${details}`},
      }};
    });
    const html = checked(candidate, () => runtime.tableHtml({id: 'search-tracks', ariaLabel: 'Search tracks',
      columnsConfig: columns,
      columns: columns.map(column => column.identity ? `minmax(${column.width}px,1fr)` : `${column.width}px`).join(' '),
      density: 'compact', frame: 'outline', overflow: 'local', mobile: 'preserve', selection: 'multiple', rows}), true);
    candidate.columns = columns;
    candidate.body.className = 'search-results__body search-results__tracks';
    const actions = element('div', 'search-results__table-actions', candidate.body);
    candidate.selectionHost = element('div', '', actions);
    candidate.columnsHost = element('span', 'compact-data-table__columns-action', actions);
    candidate.tableHost = element('div', 'album-track-table album-track-table--collection', candidate.body);
    candidate.tableHost.innerHTML = html;
  }
  function connectTable(candidate) {
    const snapshot = candidate.snapshot, rows = snapshot.result.tracks;
    const context = Object.freeze({scopeKey: snapshot.scopeKey, resultId: snapshot.resultId});
    candidate.playtableSource = checkedOwner(candidate, () => createPlaytableSource({runtime,
      sourceRows: rows, rows, context, instance: snapshot.sourceIdentity, revision: snapshot.sourceIdentity,
      enabled: true, isCurrent: () => controlCurrent(candidate, true),
      rowFacts: row => ({rowKey: row.rowKey, readable: true, selectable: row.selectable === true})}), true);
    const adapter = candidate.playtableSource.sourceAdapter;
    const rowFor = key => rows.find(row => row.rowKey === key);
    candidate.selection = checkedOwner(candidate, () => mountPlaytableSelection(candidate.tableHost, {
      runtime: candidate.native, sourceAdapter: adapter, tableKey: 'search-tracks', enabled: true,
      actionsHost: candidate.selectionHost, isViewCurrent: () => controlCurrent(candidate, true),
      actionsAvailable: candidate.playtableSource.actionsAvailable,
      onPlay: key => {const row = rowFor(key); if (row) runAction(candidate, () => runtime.playTrack(candidate.snapshot, row));},
      onInspect: key => {const row = rowFor(key); if (row) runAction(candidate, () => runtime.openAlbum(candidate.snapshot, row));},
      onContextAction: (packet, lifetime, anchor) => command(candidate, true,
        () => runtime.openPlaytableContext(packet, lifetime, adapter, anchor)),
      onPlaylistAction: (packet, lifetime, anchor, options) => command(candidate, true,
        () => runtime.openPlaylistAction(packet, lifetime, adapter, anchor, options)),
      onError: message => {if (controlCurrent(candidate, true)) paintAlert(candidate, candidate.actionStatus, String(message), true);},
    }), true);
    const openChoice = (anchor, options) => {
      if (!controlCurrent(candidate, true)) return null;
      const menu = runtime.openChoice(anchor, options);
      if (!controlCurrent(candidate, true)) {menu?.close?.({restoreFocus: false}); return null;}
      return menu;
    };
    candidate.tableSettings = () => ({source: candidate.source, columns: candidate.columns, choices: candidate.choices,
      openChoice, isCurrent: () => controlCurrent(candidate, true),
      onChoicesChange: choices => {
        if (!controlCurrent(candidate, true)) return;
        candidate.choices = choices;
        // Choices retain cells, focus and measured widths for this exact source.
        candidate.presentation?.update(candidate.tableSettings());
      }});
    const presentation = bindTrackTablePresentation(candidate.tableHost, candidate.tableSettings());
    if (!contentCurrent(candidate, true)) {presentation.dispose(); throw stalePublication;}
    candidate.presentation = presentation;
    candidate.columnsButton = checkedOwner(candidate, () => mountButton(candidate.columnsHost, candidate.native,
      {label: 'Track columns', icon: 'more', disabled: typeof runtime.openChoice !== 'function',
        attributes: {'data-track-table-columns': '', 'aria-haspopup': 'menu', 'aria-expanded': 'false'},
        onClick: event => command(candidate, true, () => candidate.presentation?.openColumns(event.target.closest('button')))}), true);
  }
  function runAction(candidate, work) {
    if (!controlCurrent(candidate, true)) return false;
    const sequence = ++candidate.actionSequence;
    paintAlert(candidate, candidate.actionStatus, '');
    const fail = error => {
      if (sequence === candidate.actionSequence && controlCurrent(candidate, true) && error?.name !== 'AbortError') {
        paintAlert(candidate, candidate.actionStatus, 'This Search action is unavailable. Try a fresh search.', true);
      }
    };
    try {Promise.resolve(work()).catch(fail);} catch (error) {fail(error);}
    return true;
  }
  function activate(candidate, event) {
    if (!controlCurrent(candidate, true) || event.defaultPrevented || !candidate.root.contains(event.target)) return;
    const button = event.target.closest?.('[data-search-track-play],[data-search-track-details],[data-gallery-card-intent]');
    if (!button || !candidate.root.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    if (button.disabled || event.detail > 1) return;
    const play = button.getAttribute('data-search-track-play'), details = button.getAttribute('data-search-track-details');
    if (play || details) {
      const row = candidate.snapshot.result.tracks.find(row => row.rowKey === (play || details));
      if (row) runAction(candidate, () => play ? runtime.playTrack(candidate.snapshot, row) : runtime.openAlbum(candidate.snapshot, row));
    } else if (['select', 'open'].includes(button.getAttribute('data-gallery-card-intent'))) {
      const album = candidate.snapshot.result.albums.find(row => row.albumRef === button.getAttribute('data-gallery-card-ref'));
      if (album) runAction(candidate, () => runtime.openAlbum(candidate.snapshot, album));
    }
  }
  function paintTrackActions(candidate) {
    if (!controlCurrent(candidate, true) || !candidate.tableHost) return;
    for (const row of candidate.snapshot.result.tracks) {
      if (!controlCurrent(candidate, true)) return;
      const element = [...candidate.tableHost.querySelectorAll('[data-cdt-row-key]')]
        .find(node => node.getAttribute('data-cdt-row-key') === row.rowKey);
      if (!element) continue;
      const playback = runtime.trackPlayback(candidate.snapshot, row);
      const canPlay = runtime.canPlayTrack(candidate.snapshot, row), canOpen = runtime.canOpenAlbum(candidate.snapshot, row);
      if (!controlCurrent(candidate, true)) return;
      element.classList.toggle('album-track-table__row--current', playback.isCurrent === true);
      element.classList.toggle('album-track-table__row--playing', playback.isPlaying === true);
      const button = element.querySelector('[data-search-track-play]'), details = element.querySelector('[data-search-track-details]');
      if (button) {
        button.disabled = !canPlay; button.setAttribute('aria-disabled', String(!canPlay));
        button.setAttribute('aria-label', `${playback.isPlaying ? 'Pause' : 'Play'} ${row.title}`);
        const icon = playback.isPlaying ? 'pause' : 'play';
        if (button.getAttribute('data-search-play-icon') !== icon) {
          button.innerHTML = checked(candidate, () => runtime.iconHtml(icon), true);
          button.setAttribute('data-search-play-icon', icon);
        }
      }
      if (details) {details.disabled = !canOpen; details.setAttribute('aria-disabled', String(!canOpen));}
    }
  }
  function paintAlert(candidate, target, message, error = false) {
    const html = message ? checked(candidate, () => runtime.alertHtml({severity: error ? 'error' : 'info',
      role: error ? 'alert' : 'status', message})) : '';
    if (target.innerHTML !== html) target.innerHTML = html;
    target.hidden = !message;
  }
  function button(candidate, key, target, options) {
    if (!options) {
      const previous = candidate[key]; candidate[key] = null;
      previous?.dispose();
      if (!contentCurrent(candidate)) throw stalePublication;
    } else if (candidate[key]) checked(candidate, () => candidate[key].update(options));
    else candidate[key] = checkedOwner(candidate, () => mountButton(target, candidate.native, options));
    target.hidden = !options;
  }
  function updateSession(candidate) {
    const snapshot = candidate.snapshot, pending = snapshot.status === 'pending', error = snapshot.status === 'error';
    checked(candidate, () => candidate.tabs.update(tabsOptions(candidate)));
    candidate.panel.setAttribute('aria-busy', String(snapshot.status === 'loading' || pending));
    const rows = candidate.ready ? snapshot.result[snapshot.presentation] : [];
    const message = pending ? 'Still checking…' : error ? snapshot.error || 'Search could not be loaded. Try again.'
      : !candidate.ready ? 'Loading search results…' : rows.length ? '' : `No matching ${snapshot.presentation}.`;
    paintAlert(candidate, candidate.status, message, error);
    if (candidate.ready && snapshot.presentation === 'albums' && rows.length) paintAlbums(candidate);
    if (candidate.ready && snapshot.presentation === 'tracks' && rows.length) paintTrackActions(candidate);
    const canContinue = (candidate.ready || pending) && snapshot.result?.page.hasMore === true;
    button(candidate, 'continueButton', candidate.continueHost, canContinue
      ? {label: 'Continue', onClick: () => command(candidate, false, value => runtime.continueResults(value))} : null);
    button(candidate, 'retryButton', candidate.retryHost, error
      ? {label: 'Retry', onClick: () => command(candidate, false, value => runtime.restart(value))} : null);
    candidate.actions.hidden = !canContinue && !error;

    // Sidebar progress owns a child request, never the foreground result slot.
    const sidebar = snapshot.sidebar, showSidebar = Boolean(candidate.ready && sidebar
      && (sidebar.hasMore || ['loading', 'pending', 'error'].includes(sidebar.status)));
    candidate.sidebar.hidden = !showSidebar;
    candidate.sidebar.setAttribute('aria-busy', String(showSidebar && sidebar.status === 'loading'));
    const sidebarMessage = !showSidebar ? '' : sidebar.status === 'loading' ? 'Loading more artists…'
      : sidebar.status === 'pending' ? 'Still checking artists…'
        : sidebar.status === 'error' ? sidebar.error || 'More artists could not be loaded. Try again.' : '';
    paintAlert(candidate, candidate.sidebarStatus, sidebarMessage, sidebar?.status === 'error');
    button(candidate, 'sidebarButton', candidate.sidebarAction, showSidebar && sidebar.hasMore
      ? {label: sidebar.status === 'error' ? 'Retry artists' : 'Continue artists', disabled: sidebar.status === 'loading',
        onClick: () => command(candidate, true, value => runtime.continueSidebar(value))} : null);
  }
  function reconcile() {
    if (record.phase !== 'live') return;
    queued = true;
    if (rendering) return;
    rendering = true;
    try {
      while (queued && record.phase === 'live') {
        queued = false;
        if (!live()) {owner.dispose(); break;}
        const snapshot = runtime.snapshot();
        if (!publicationCurrent(snapshot)) {queued = true; continue;}
        const ready = snapshot.status === 'ready' && snapshot.actionable === true && runtime.isCurrent(snapshot) === true;
        if (!publicationCurrent(snapshot)) {queued = true; continue;}
        if (!snapshot.visible || !presentations.includes(snapshot.presentation)
          || snapshot.status === 'ready' && !ready) {
          clearSession();
          if (publicationCurrent(snapshot)) host.hidden = true;
          continue;
        }
        const sameSource = session && session.resultId === snapshot.resultId && session.source === snapshot.sourceIdentity
          && session.result === snapshot.result && session.mode === snapshot.presentation && session.ready === ready;
        if (!sameSource) {
          clearSession();
          if (!publicationCurrent(snapshot)) {queued = true; continue;}
        }
        try {
          const next = session || createSession(snapshot, ready);
          next.snapshot = snapshot;
          updateSession(next);
          if (!contentCurrent(next)) throw stalePublication;
        } catch (error) {
          clearSession();
          if (error !== stalePublication) throw error;
          queued = true;
        }
      }
    } finally {rendering = false;}
  }

  try {
    const stop = runtime.subscribe(reconcile);
    if (!live()) {stop?.(); owner.dispose(); return null;}
    unsubscribe = stop;
    structure = new window.MutationObserver(() => {if (record.phase === 'live' && !currentPair()) owner.dispose();});
    structure.observe(document.documentElement, {childList: true, subtree: true});
    runtime.syncVisibility();
    reconcile();
    return record.phase === 'live' ? owner : null;
  } catch (error) {owner.dispose(); throw error;}
}
