import React, { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  LOVED_PLAYLIST_ID, playlistController, playlistCatalog, playlistTrack,
  buildPlaylists, buildPlaylistRows, filterPlaylistRows, createQueue,
  advanceQueue, setQueueMode, queueOrigin, playlistSelection,
} from './playlist-model.mjs';
import { LOVE_BREAK_DURATION_MS, loveFeedback, refreshLoveControls } from './track-social.mjs';

const getNative = () => window.MockRealLayout;
export function usePlaylistSnapshot(controller = playlistController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

const PLAYLIST_EXIT_MS = LOVE_BREAK_DURATION_MS + 20;
function NativeMarkup({ html, owners, className = '', onClick, selectedTrackId, currentTrackId,
  getLove, hasRows = true, emptyMessage }) {
  const ref = useRef(), exits = useRef(new Map()), committedLove = useRef(new Map()), [exitCount, setExitCount] = useState(0);
  const focusTarget = (row, control) => control === 'love' ? row?.querySelector('[data-mock-track-love]')
    : control === 'play' ? row?.querySelector('.play-track-button') : row;
  const focusFallback = (rowId, order, control) => {
    const host = ref.current;
    if (!host?.isConnected) return;
    const index = order.indexOf(rowId), candidates = [...order.slice(index + 1), ...order.slice(0, index).reverse()];
    const survivors = [...host.querySelectorAll('[data-track-row-path]:not([data-mock-playlist-exiting])')];
    const row = candidates.map(id => survivors.find(value => value.dataset.trackRowPath === id)).find(Boolean) || survivors[0];
    (focusTarget(row, control) || row || host.closest('.mock-playlist-panel')?.querySelector('.mock-playlist-filters button,[data-mock-playlist-filters-trigger]'))?.focus({ preventScroll: true });
  };
  const clearExit = (id, remove = false) => {
    const entry = exits.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.row.removeEventListener('animationend', entry.onEnd);
    exits.current.delete(id);
    if (remove) {
      if (entry.row.contains(document.activeElement)) focusFallback(id, entry.order, entry.control);
      entry.row.remove();
    } else {
      delete entry.row.dataset.mockPlaylistExiting;
      entry.row.removeAttribute('aria-disabled');
      for (const [element, previous] of entry.tabStops) {
        if (previous === null) element.removeAttribute('tabindex');
        else element.setAttribute('tabindex', previous);
      }
      refreshLoveControls(entry.row, getLove);
    }
    setExitCount(exits.current.size);
  };
  useLayoutEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced = () => { if (motion.matches) for (const id of [...exits.current.keys()]) clearExit(id, true); };
    motion?.addEventListener?.('change', reduced);
    return () => {
      motion?.removeEventListener?.('change', reduced);
      for (const entry of exits.current.values()) {
        clearTimeout(entry.timer); entry.row.removeEventListener('animationend', entry.onEnd);
      }
      exits.current.clear();
      committedLove.current.clear();
    };
  }, []);
  useLayoutEffect(() => {
    const host = ref.current, active = host.contains(document.activeElement) ? document.activeElement : null;
    const rowId = active?.closest('[data-track-row-path]')?.dataset.trackRowPath;
    const control = active?.matches('[data-mock-track-love]') ? 'love' : active?.matches('.play-track-button') ? 'play' : 'row';
    const previousRows = [...host.querySelectorAll('[data-track-row-path]')], order = previousRows.map(row => row.dataset.trackRowPath);
    const nextHost = document.createElement('div'); nextHost.innerHTML = html;
    const wanted = new Set([...nextHost.querySelectorAll('[data-track-row-path]')].map(row => row.dataset.trackRowPath));
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const retained = [];
    for (const row of previousRows) {
      const id = row.dataset.trackRowPath, heart = row.querySelector('[data-mock-track-love]');
      if (wanted.has(id)) { if (exits.current.has(id)) clearExit(id); continue; }
      if (exits.current.has(id)) {
        if (reduced) clearExit(id, true);
        else retained.push(row);
        continue;
      }
      // Shared subscribers may already have repainted the DOM heart to none.
      // Compare against the last committed playlist presentation, not callback order.
      const previouslyLoved = ['loved', 'obsessed'].includes(committedLove.current.get(id));
      // The controller already removed the track. Only its actual native DOM row lingers.
      if (!getLove || reduced || getLove(id) !== 'none' || !previouslyLoved) continue;
      const entry = { row, order, control: rowId === id ? control : 'love', timer: null, onEnd: null,
        tabStops: [row, ...row.querySelectorAll('button,a,input,[tabindex]')].map(element => [element, element.getAttribute('tabindex')]) };
      row.dataset.mockPlaylistExiting = 'true'; row.setAttribute('aria-disabled', 'true');
      for (const [element] of entry.tabStops) element.setAttribute('tabindex', '-1');
      // Reuse the same stable-track paint lifetime as all other visible tables.
      // It may already be running from the shared click/subscription owner.
      if (heart) { loveFeedback.begin(id); refreshLoveControls(row, getLove); }
      const elapsed = loveFeedback.get(id)?.elapsed || 0;
      row.style.setProperty('--mock-playlist-exit-delay', `-${elapsed}ms`);
      entry.onEnd = event => { if (exits.current.get(id) === entry && event.target === row && event.animationName === 'mock-playlist-row-exit') clearExit(id, true); };
      row.addEventListener('animationend', entry.onEnd);
      entry.timer = setTimeout(() => { if (exits.current.get(id) === entry) clearExit(id, true); }, Math.max(0, PLAYLIST_EXIT_MS - elapsed) + 60);
      exits.current.set(id, entry); retained.push(row);
    }
    const body = nextHost.querySelector('.compact-data-table-body');
    for (const row of retained) {
      const index = order.indexOf(row.dataset.trackRowPath), nextId = order.slice(index + 1).find(id => wanted.has(id));
      const nextRow = [...(body?.children || [])].find(value => value.dataset.trackRowPath === nextId);
      if (body) body.insertBefore(row, nextRow || null);
      else clearExit(row.dataset.trackRowPath, true);
    }
    host.replaceChildren(...nextHost.childNodes);
    committedLove.current = new Map([...wanted].map(id => [id, getLove?.(id) || 'none']));
    if (emptyMessage !== undefined) host.hidden = !hasRows && !exits.current.size;
    setExitCount(exits.current.size);
    owners.activate(host);
    if (rowId) {
      const row = [...host.querySelectorAll('[data-track-row-path]')].find(value => value.dataset.trackRowPath === rowId);
      if (row) focusTarget(row, control)?.focus({ preventScroll: true });
      else focusFallback(rowId, order, control);
    }
  }, [html, owners, getLove, hasRows]);
  useLayoutEffect(() => {
    if (selectedTrackId === undefined && currentTrackId === undefined) return;
    for (const row of ref.current.querySelectorAll('[data-track-row-path]')) {
      const selected = row.dataset.trackRowPath === selectedTrackId;
      const current = row.dataset.trackRowPath === currentTrackId;
      row.classList.toggle('mock-selected-track', selected);
      row.setAttribute('aria-selected', String(selected));
      row.classList.toggle('mock-playlist-current', current);
      if (current) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
  }, [html, selectedTrackId, currentTrackId]);
  return emptyMessage === undefined ? <div ref={ref} className={className} onClick={onClick}/>
    : <div className={className} onClick={onClick}><div ref={ref} hidden={!hasRows && !exitCount}/><div className="mock-empty" role="status" hidden={hasRows || exitCount > 0}>{emptyMessage}</div></div>;
}

const extraIcons = {
  shuffle: 'M3 7h3c4 0 5 10 9 10h6m-4-4 4 4-4 4M3 17h3c1.5 0 2.7-1.5 3.8-3.6M13 9.4C14 7.8 15 7 17 7h4m-4-4 4 4-4 4',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3',
  repeatOne: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3M10 11l2-1v5m-2 0h4',
};
function NativeAction({ label, icon, active = false, disabled = false, bare = false, onClick }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host.firstElementChild) host.innerHTML = window.ButtonComponent.renderActionButton({
      ariaLabel: label, title: label, className: 'mock-playlist-action', presentation: bare ? 'bare' : 'outlined',
    });
    const button = host.querySelector('button');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.classList.toggle('action-button--bare', bare);
    button.setAttribute('aria-pressed', String(active));
    window.ButtonComponent.setDisabled(button, disabled);
    const slot = button.querySelector('.action-button__icon');
    if (slot.dataset.mockIcon !== icon) {
      slot.innerHTML = extraIcons[icon]
        ? `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${extraIcons[icon]}"/></svg>`
        : window.ButtonComponent.renderIconSvg(icon);
      slot.dataset.mockIcon = icon;
    }
    for (const svg of slot.querySelectorAll('svg')) {
      svg.setAttribute('fill', icon === 'play' || icon === 'pause' ? 'currentColor' : 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.7');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
  }, [label, icon, active, disabled, bare]);
  return <span ref={ref} className="mock-native-button" onClick={event => { if (!disabled && event.target.closest('button')) onClick?.(); }}/>;
}
function Choice({ label, value, options, owners, onChange }) {
  const ref = useRef();
  const choice = options.find(option => option.value === value) || options[0];
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host.firstElementChild) host.innerHTML = window.ButtonComponent.renderButton({
      label: choice.label, variant: 'secondary', size: 'small',
      className: 'mock-choice-trigger mock-choice-trigger--slim',
      ariaLabel: `${label}: ${choice.label}`, title: `${label}: ${choice.label}`,
      attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    }).replace('</button>', '<svg class="mock-choice-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>');
    const button = host.querySelector('button');
    const content = button.querySelector('.ui-button__content');
    if (content.textContent !== choice.label) content.textContent = choice.label;
    button.setAttribute('aria-label', `${label}: ${choice.label}`);
    button.title = `${label}: ${choice.label}`;
    // Native choiceDropdown retains this exact connected trigger for return focus.
  }, [label, choice.label]);
  return <label className="mock-playlist-filter"><span>{label}</span><span ref={ref} className="mock-native-choice" onClick={event => {
      const button = event.target.closest('button');
      if (button) owners.choiceDropdown(button, { formats: options, selected: value, label, onSelect: onChange });
    }}/></label>;
}

/** One shared filter composition, inline on desktop or in the native phone dialog. */
function ResponsivePlaylistFilters({ owners, children }) {
  const [phone, setPhone] = useState(() => window.matchMedia?.('(max-width: 900px)').matches ?? window.innerWidth <= 900);
  const [target, setTarget] = useState(null), triggerHost = useRef(), slot = useRef(), mounted = useRef(true);
  const closeOwned = () => { if (slot.current?.isConnected) owners.closeDialog(); };
  useLayoutEffect(() => {
    mounted.current = true;
    const media = window.matchMedia?.('(max-width: 900px)');
    const change = () => {
      const next = media?.matches ?? window.innerWidth <= 900;
      if (!next) closeOwned();
      setPhone(next);
    };
    if (media?.addEventListener) media.addEventListener('change', change);
    else window.addEventListener('resize', change);
    return () => {
      mounted.current = false;
      media?.removeEventListener?.('change', change); window.removeEventListener('resize', change);
      closeOwned();
    };
  }, [owners]);
  useLayoutEffect(() => {
    const host = triggerHost.current;
    if (!host) return;
    if (!host.firstElementChild) host.innerHTML = window.ButtonComponent.renderButton({
      label: 'Filters', variant: 'secondary', size: 'small', className: 'mock-choice-trigger mock-choice-trigger--slim',
      title: 'Open playlist filters', ariaLabel: 'Open playlist filters',
      attributes: { 'data-mock-playlist-filters-trigger': 'true', 'aria-haspopup': 'dialog', 'aria-controls': 'app-form-modal' },
    });
    host.querySelector('button').setAttribute('aria-expanded', String(Boolean(target)));
  }, [phone, target]);
  useLayoutEffect(() => {
    if (target?.isConnected) target.querySelector('button,input')?.focus({ preventScroll: true });
  }, [target]);
  const open = button => {
    if (slot.current || !phone) return;
    // The native dialog remembers this exact connected button for return focus.
    button.focus({ preventScroll: true });
    owners.dialog({ title: 'Playlist filters', mode: 'reading', anchor: null,
      contentHtml: '<div class="mock-playlist-filters-dialog" data-mock-playlist-filters-dialog></div>',
      onMount: content => {
        const next = content.querySelector('[data-mock-playlist-filters-dialog]');
        slot.current = next;
        content.closest('#app-form-modal')?.setAttribute('data-mock-playlist-filters', 'true');
        setTarget(next);
      },
      onClose: content => {
        content.closest('#app-form-modal')?.removeAttribute('data-mock-playlist-filters');
        slot.current = null;
        if (mounted.current) setTarget(null);
      },
    });
  };
  return phone ? <><div className="mock-playlist-filter-entry"><span ref={triggerHost} className="mock-native-button" onClick={event => {
    const button = event.target.closest('button'); if (button) open(button);
  }}/></div>{target && createPortal(children, target)}</> : children;
}

/** The native AlbumTrackTable owns the row, play button, duration and artbox. */
export function renderPlaylistTable({ rows, playlistId = LOVED_PLAYLIST_ID }, owners = getNative()) {
  const host = document.createElement('div');
  host.innerHTML = owners.playTable({ id: 'mock-playlist-' + playlistId.replace(/[^a-z0-9_-]/gi, '-'), rows,
    label: 'Loved and Obsessed tracks', artwork: true, loveColumn: true });
  for (const row of host.querySelectorAll('[data-track-row-path]')) {
    row.dataset.mockPlaylistTrack = row.dataset.trackRowPath;
    row.tabIndex = 0;
    const play = row.querySelector('.play-track-button');
    if (play) { play.setAttribute('aria-label', 'Preview track from this playlist'); play.title = 'Preview track; audio is unavailable'; }
  }
  const count = host.querySelector('[role="columnheader"][data-cdt-column="count"]');
  if (count) { count.textContent = 'Plays'; count.title = 'Your fictional all-time listens'; }
  return host.innerHTML;
}

/** Native flat NavigationTree items; this preview owns only the section disclosure state. */
export function renderPlaylistSidebar(snapshot, selectedPlaylistId = null, owners = getNative(), collapsed = {}) {
  const groups = buildPlaylists(snapshot), nativeOwners = owners.artistViewOwners;
  const renderItems = groups.autoplaylists.map(playlist => nativeOwners.renderNavigationItem({
    variant: 'wide', action: true, key: playlist.id, label: playlist.title,
    selected: playlist.id === selectedPlaylistId, count: playlist.count,
    artworkHtml: nativeOwners.renderArtbox(playlist.album, { label: `${playlist.album.name} artwork`, interactive: false }),
    attributes: { 'data-mock-playlist-open': playlist.id },
  })).join('');
  const section = (key, title, content) => {
    const closed = Boolean(collapsed[key]), holder = document.createElement('div');
    holder.innerHTML = nativeOwners.renderNavigationItem({ variant: 'panel', action: true,
      key: `playlist-section:${key}`, label: title, icon: '›', className: 'mock-playlist-section-toggle',
      attributes: { 'data-mock-playlist-section-toggle': key },
    });
    const button = holder.querySelector('button');
    button.id = `mock-playlist-section-${key}`;
    button.setAttribute('aria-expanded', String(!closed));
    button.setAttribute('aria-controls', `mock-playlist-section-${key}-content`);
    button.setAttribute('aria-label', `${closed ? 'Expand' : 'Collapse'} ${title}`);
    button.title = `${closed ? 'Expand' : 'Collapse'} ${title}`;
    // The same chevron character used by native utility disclosures; item
    // markup, focus paint and button keyboard behavior remain NavigationTree's.
    button.querySelector('.navigation-tree-icon')?.classList.add('mock-playlist-section-chevron');
    return `<section data-mock-playlist-section="${key}" aria-labelledby="${button.id}"><h3 class="mock-playlist-section-label">${holder.innerHTML}</h3><div id="mock-playlist-section-${key}-content"${closed ? ' hidden' : ''}>${content}</div></section>`;
  };
  return `<nav class="mock-playlist-sidebar" aria-label="Playlists">${section('autoplaylists', 'Autoplaylists', `<div class="navigation-tree mock-artist-tree">${renderItems}</div>${renderItems ? '' : '<p class="mock-playlist-sidebar-empty">Love a track to start an autoplaylist</p>'}`)}${section('manual', 'Manual', '<p class="mock-playlist-sidebar-empty">No manual playlists</p>')}</nav>`;
}
export function PlaylistSidebar({ controller = playlistController, selectedPlaylistId = null, native = getNative, onOpenPlaylist }) {
  const snapshot = usePlaylistSnapshot(controller), owners = typeof native === 'function' ? native() : native;
  const host = useRef(), [collapsed, setCollapsed] = useState({ autoplaylists: false, manual: false });
  const html = renderPlaylistSidebar(snapshot, selectedPlaylistId, owners, collapsed);
  useLayoutEffect(() => {
    const root = host.current, active = root.contains(document.activeElement) ? document.activeElement : null;
    const sectionKey = active?.dataset.mockPlaylistSectionToggle, playlistKey = active?.dataset.mockPlaylistOpen;
    root.innerHTML = html;
    owners.activate(root);
    const replacement = sectionKey ? [...root.querySelectorAll('[data-mock-playlist-section-toggle]')].find(button => button.dataset.mockPlaylistSectionToggle === sectionKey)
      : playlistKey ? [...root.querySelectorAll('[data-mock-playlist-open]')].find(button => button.dataset.mockPlaylistOpen === playlistKey)
        || root.querySelector('[data-mock-playlist-section-toggle="autoplaylists"]') : null;
    replacement?.focus({ preventScroll: true });
  }, [html, owners]);
  return <div ref={host} onKeyDown={event => {
    const button = event.target.closest('[data-mock-playlist-section-toggle]');
    if (!button || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    setCollapsed(previous => ({ ...previous, [button.dataset.mockPlaylistSectionToggle]: event.key === 'ArrowLeft' }));
  }} onClick={event => {
    const toggle = event.target.closest('[data-mock-playlist-section-toggle]');
    if (toggle) {
      event.preventDefault();
      const key = toggle.dataset.mockPlaylistSectionToggle;
      setCollapsed(previous => ({ ...previous, [key]: !previous[key] }));
      return;
    }
    const item = event.target.closest('[data-mock-playlist-open]');
    if (item) { event.preventDefault(); controller.visitPlaylist(item.dataset.mockPlaylistOpen); onOpenPlaylist?.(item.dataset.mockPlaylistOpen); }
  }}/>;
}

const loveOptions = [{ value: 'all', label: 'Loved + obsessed' }, { value: 'loved', label: 'Only loved' }, { value: 'obsessed', label: 'Only obsessed' }];
const lengthOptions = [{ value: 'all', label: 'Any length' }, { value: 'short', label: 'Under 3 min' }, { value: 'medium', label: '3–5 min' }, { value: 'long', label: 'Over 5 min' }, { value: 'epic', label: 'Over 8 min' }];
const lengthRanges = { all: [null, null], short: [null, 179], medium: [180, 300], long: [301, null], epic: [481, null] };
const addedOptions = [{ value: 'all', label: 'Any time' }, { value: '1', label: 'Last day' }, { value: '7', label: 'Last week' }, { value: '30', label: 'Last month' }, { value: '90', label: 'Last 3 months' }];
const frequencyOptions = [{ value: 'all', label: 'Any frequency' }, { value: 'frequent', label: 'Listen a lot (500+)' }, { value: 'barely', label: 'Barely (0–100)' }, { value: 'forgotten', label: 'Forgotten (90+ days)' }];
const modeOptions = [{ value: 'only', label: 'Show these' }, { value: 'exclude', label: 'Filter these out' }];

/** One central playlist view. The parent reveals modules after onSelectTrack. */
export function PlaylistPanel({ controller = playlistController, playlistId = LOVED_PLAYLIST_ID, native = getNative,
  selectedTrackId, revealTrackId = null, queue = null, actionsHost = null, onSelectTrack, onQueueChange }) {
  const snapshot = usePlaylistSnapshot(controller), owners = typeof native === 'function' ? native() : native;
  const host = useRef(), [localSelected, setLocalSelected] = useState(null);
  const selection = selectedTrackId === undefined ? localSelected : selectedTrackId;
  useLayoutEffect(() => { controller.visitPlaylist(playlistId); setLocalSelected(null); }, [controller, playlistId]);
  const filters = controller.getFilters(playlistId), modes = controller.getModes(playlistId);
  const rows = useMemo(() => buildPlaylistRows(snapshot, playlistId), [snapshot.preferences, playlistId]);
  const visible = useMemo(() => filterPlaylistRows(rows, filters, controller.now()), [rows, filters, controller]);
  const playback = queue?.source === 'playlist' && queue.playlistId === playlistId ? queue : null;
  const revealed = revealTrackId && playback?.currentTrackId === revealTrackId && !visible.some(row => row.id === revealTrackId)
    ? playlistTrack(revealTrackId) : null;
  const displayRows = useMemo(() => revealed
    ? [...visible, { ...revealed, love: controller.getLove(revealTrackId), missing: revealed.count === null }]
    : visible, [visible, revealed, revealTrackId, controller]);
  useLayoutEffect(()=>{const body=host.current?.querySelector('#mock-playlist-scroll');if(body){body.dataset.scrollReady='true';window.dispatchEvent(new window.Event('mock-playlist-ready'));}},[playlistId,displayRows]);
  // Selection, current-track paint and playback modes never replace the native rows.
  const tableHtml = useMemo(() => renderPlaylistTable({ rows: displayRows, playlistId }, owners), [displayRows, playlistId, owners]);
  useLayoutEffect(() => {
    if (!revealTrackId) return;
    const row = [...host.current.querySelectorAll('[data-track-row-path]')].find(value => value.dataset.trackRowPath === revealTrackId);
    row?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    row?.focus({ preventScroll: true });
  }, [revealTrackId, playlistId]);
  const notifyQueue = (next, reason, button = null) => onQueueChange?.(next, { ...queueOrigin(next), reason, button });
  const select = (trackId, play = false, button = null) => {
    const selected = playlistSelection(trackId, playlistId);
    if (!selected) return;
    setLocalSelected(trackId); controller.touchPlaylist(playlistId); onSelectTrack?.(selected);
    if (play) {
      // An artwork return can reveal a removed/filtered current row without altering its queued identity.
      const next = revealed?.id === trackId && playback ? { ...playback, ended: false, transition: 'select', reason: 'select' }
        : createQueue({ playlistId, trackIds: visible.map(row => row.id), currentTrackId: trackId, ...modes, seed: controller.now() });
      notifyQueue(next, 'select', button);
    }
  };
  const rowAction = (event, double = false) => {
    const row = event.target.closest('[data-mock-playlist-track]');
    if (row?.dataset.mockPlaylistExiting) { event.preventDefault(); event.stopPropagation(); return; }
    if (!row || event.target.closest('[data-mock-track-love]')) return;
    const button = event.target.closest('.play-track-button');
    if (!button && event.target.closest('button,a,input,select,textarea,[contenteditable="true"]')) return;
    event.preventDefault(); event.stopPropagation();
    if (double && button) return;
    select(row.dataset.mockPlaylistTrack, Boolean(button) || double, button || row.querySelector('.play-track-button'));
  };
  const updateModes = patch => {
    const next = controller.setModes(playlistId, patch);
    if (playback) notifyQueue(setQueueMode(playback, { ...next, seed: patch.shuffle === true ? controller.now() : playback.seed }), 'mode');
  };
  const update = patch => controller.setFilters(playlistId, patch);
  const lengthValue = Object.keys(lengthRanges).find(key => lengthRanges[key][0] === filters.minDuration && lengthRanges[key][1] === filters.maxDuration) || 'all';
  const styles = [...new Set(playlistCatalog.flatMap(row => row.styles))].sort();
  const repeatLabel = modes.repeat === 'one' ? 'Repeat one track' : modes.repeat === 'all' ? 'Repeat playlist' : 'Repeat off';
  const playbackControls = <div className="mock-playlist-actions mock-playback-controls" role="toolbar" aria-label="Playlist playback controls">
    <NativeAction bare label={modes.shuffle ? 'Shuffle on' : 'Shuffle off'} icon="shuffle" active={modes.shuffle} onClick={() => updateModes({ shuffle: !modes.shuffle })}/>
    <NativeAction bare label={`${repeatLabel}; change repeat mode`} icon={modes.repeat === 'one' ? 'repeatOne' : 'repeat'} active={modes.repeat !== 'off'} onClick={() => updateModes({ repeat: modes.repeat === 'off' ? 'all' : modes.repeat === 'all' ? 'one' : 'off' })}/>
    <NativeAction bare label="Preview next playlist track; audio unavailable" icon="next" disabled={!playback || playback.ended} onClick={() => notifyQueue(advanceQueue(playback, { reason: 'next' }), 'next')}/>
  </div>;
  return <section ref={host} className="mock-playlist-panel" data-mock-playlist-id={playlistId} aria-label="Loved and Obsessed playlist"
    onClickCapture={event => rowAction(event)} onDoubleClickCapture={event => rowAction(event, true)}
    onKeyDownCapture={event => {
      if (event.target.closest('[data-mock-playlist-exiting]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key !== 'Enter' || event.target.closest('button,a,input,select,textarea')) return;
      const row = event.target.closest('[data-mock-playlist-track]');
      if (row) { event.preventDefault(); event.stopPropagation(); select(row.dataset.mockPlaylistTrack, event.ctrlKey || event.metaKey, row.querySelector('.play-track-button')); }
    }}>
    {!actionsHost && <header className="mock-playlist-header"><div><h1>Loved and Obsessed</h1><p>{rows.length} {rows.length === 1 ? 'track' : 'tracks'}{visible.length !== rows.length ? ` · ${visible.length} shown` : ''}</p></div></header>}
    <ResponsivePlaylistFilters key={playlistId} owners={owners}>
    <div className="mock-playlist-filters" aria-label="Playlist filters">
      <Choice label="Love" value={filters.love} options={loveOptions} owners={owners} onChange={love => update({ love })}/>
      <Choice label="Style" value={filters.style} options={[{ value: '', label: 'Any style' }, ...styles.map(style => ({ value: style, label: style }))]} owners={owners} onChange={style => update({ style })}/>
      <Choice label="Length" value={lengthValue} options={lengthOptions} owners={owners} onChange={value => update({ minDuration: lengthRanges[value][0], maxDuration: lengthRanges[value][1] })}/>
      <Choice label="Added" value={filters.addedWithinDays === null ? 'all' : String(filters.addedWithinDays)} options={addedOptions} owners={owners} onChange={value => update({ addedWithinDays: value === 'all' ? null : Number(value) })}/>
      <label className="mock-playlist-filter mock-playlist-listen-range"><span>Listens</span><span><input type="number" inputMode="numeric" min="0" placeholder="Min" aria-label="Minimum personal listens" value={filters.minListens ?? ''} onChange={event => update({ minListens: event.target.value === '' ? null : Number(event.target.value) })}/><span aria-hidden="true">–</span><input type="number" inputMode="numeric" min="0" placeholder="Max" aria-label="Maximum personal listens" value={filters.maxListens ?? ''} onChange={event => update({ maxListens: event.target.value === '' ? null : Number(event.target.value) })}/></span></label>
      <Choice label="Listening" value={filters.frequency} options={frequencyOptions} owners={owners} onChange={frequency => update({ frequency })}/>
      {filters.frequency !== 'all' && <Choice label="Match" value={filters.frequencyMode} options={modeOptions} owners={owners} onChange={frequencyMode => update({ frequencyMode })}/>}
      <NativeAction label="Reset playlist filters" icon="close" onClick={() => controller.resetFilters(playlistId)}/>
    </div>
    <p className="mock-playlist-filter-note">Filters stay with this playlist for 7 days after your last visit. Unknown values remain visible.</p>
    </ResponsivePlaylistFilters>
    <div id="mock-playlist-scroll" className="mock-playlist-scroll-body">
      {revealed && <p className="mock-playlist-return-note" role="status">The current track is shown below for your return. It is outside the current playlist or filters.</p>}
      {playbackControls}
      <NativeMarkup html={tableHtml} owners={owners} className="mock-playlist-table-host" selectedTrackId={selection} currentTrackId={playback?.currentTrackId || null}
        getLove={controller.getLove} hasRows={displayRows.length > 0} emptyMessage={rows.length ? 'No tracks match these filters' : 'Love a track in any play table to add it here'}/>
    </div>
  </section>;
}
