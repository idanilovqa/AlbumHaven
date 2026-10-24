import {mountButton} from '../home-friends/native-controls.mjs';

const REASONS = Object.freeze({invalid_count: 'The imported play count is invalid.', count_unavailable: 'No usable play count was supplied.',
  zero_count_with_boundaries: 'A zero count conflicts with supplied boundary dates.',
  boundary_order_conflict: 'The first boundary falls after the last boundary.',
  single_count_boundary_conflict: 'A single reported play has conflicting boundary dates.'});
const displayLabel = (value, fallback) => value.state === 'valid' ? value.text + (value.truncated ? '…' : '') : fallback;

// Account entry remains display-only. Home may supply a private Play adapter;
// no native target or inferred media authority enters this display owner.
export function mountFoobarHistoryPanel(host, runtime, initial) {
  if (!initial?.owner?.controller || typeof runtime?.buttonHtml !== 'function')
    throw new TypeError('Foobar history panel is unavailable.');
  const document = host.ownerDocument, owner = initial.owner, controller = owner.controller;
  host.replaceChildren();
  let props = initial, disposed = false, renderedSources = null, renderedPage = null, unsubscribe = null;
  const buttons = [], releases = [];
  const rowButtons = new Map();
  let nativeActions = null, releaseNative = null;
  const node = (parent, tag, className, value) => {
    const element = document.createElement(tag); if (className) element.className = className;
    if (value !== undefined) element.textContent = value; parent.append(element); return element;
  };
  host.classList.add('foobar-history'); host.setAttribute('role', 'region'); host.setAttribute('aria-label', 'Foobar Recent');
  const intro = node(host, 'div', 'foobar-history__intro');
  node(intro, 'h3', '', 'Foobar Recent');
  node(intro, 'p', '', 'Your account’s imported local Foobar history. Standard and enhanced counts are separate views, never added together.');
  node(intro, 'p', 'foobar-history__hint', 'All time. Dates are source boundary evidence, not measured listening events. Undated remainders remain aggregate records. Last.fm and Album Haven listening stay separate.');
  const nativeHint = node(intro, 'p', 'foobar-history__hint', 'Display only: imported rows do not grant queue, playlist, rating, love or native detail actions.');
  const controls = node(host, 'div', 'foobar-history__controls');
  const field = label => {
    const wrapper = node(controls, 'label', 'foobar-history__field'); node(wrapper, 'span', '', label);
    return node(wrapper, 'select', 'utility-search-input');
  };
  const sourceSelect = field('Account source'), familySelect = field('Count family'), modeSelect = field('View');
  const option = (select, value, label) => {const item = node(select, 'option', '', label); item.value = value; return item;};
  option(familySelect, 'standard', 'Standard play count'); option(familySelect, 'enhanced', 'Enhanced play count');
  option(familySelect,'local_entries','Enhanced SQLite local timestamp evidence');
  const groupedOption=option(modeSelect, 'grouped', 'Grouped records');
  const individualOption=option(modeSelect, 'individual', 'First boundary + undated aggregate');
  const sourceActions = node(host, 'div', 'foobar-history__actions');
  const sourceStatus = node(host, 'p', 'foobar-history__hint'); sourceStatus.setAttribute('role', 'status');
  const scope = node(host, 'p', 'foobar-history__scope');
  const status = node(host, 'p', 'foobar-history__status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const topActions = node(host, 'div', 'foobar-history__actions');
  const list = node(host, 'ol', 'foobar-history__rows'); list.setAttribute('aria-label', 'Imported source records');
  const pageStatus = node(host, 'p', 'foobar-history__hint'); pageStatus.setAttribute('role', 'status'); pageStatus.setAttribute('tabindex', '-1');
  const pageActions = node(host, 'div', 'foobar-history__actions');
  const current = () => {try {return !disposed && host.isConnected && props.isCurrent() === true;} catch {return false;}};
  const nativeNotice = node(host, 'p', 'foobar-history__hint'); nativeNotice.setAttribute('role', 'status');
  function paintNative() {
    if (disposed || !nativeActions) return;
    for (const [row, button] of rowButtons) {
      const state = nativeActions.state(row);
      button.update({label: state.canAttemptPlay ? 'Check and play matched track' : 'Check playback match',
        disabled: state.busy || !current() || controller.getSnapshot().status !== 'ready',
        onClick: () => {
          if (!current()) return;
          const latest = nativeActions.state(row);
          if (!latest.busy) void (latest.canAttemptPlay ? nativeActions.play(row) : nativeActions.check(row));
        }});
      nativeNotice.textContent = state.notice;
    }
  }
  const action = (parent, label, callback) => {
    const slot = node(parent, 'span');
    const owned = mountButton(slot, runtime, {label, onClick: () => {if (current()) callback();}});
    buttons.push(owned); return {update: disabled => owned.update({label, disabled, onClick: () => {if (current()) callback();}})};
  };
  const firstSources = action(sourceActions, 'Refresh source list', () => {void controller.loadSources();});
  const nextSources = action(sourceActions, 'More sources', () => {void controller.loadSources({next: true});});
  const refresh = action(pageActions, 'Refresh selected source', () => {void controller.loadHistory();});
  const newer = action(topActions, 'Load newer', () => navigate('newer'));
  const next = action(pageActions, 'Load older', () => navigate('next'));
  const start = action(topActions, 'Return to newest', () => navigate('start'));
  const on = (element, type, callback) => {element.addEventListener(type, callback); releases.push(() => element.removeEventListener(type, callback));};
  on(sourceSelect, 'change', () => {if (current()) {controller.selectSource(sourceSelect.value); render();}});
  on(familySelect, 'change', () => {if (current()) controller.setFamily(familySelect.value);});
  on(modeSelect, 'change', () => {if (current()) controller.setMode(modeSelect.value);});
  // Reuse the nearest native overflow owner, including a Home widget body
  // nested inside albums-scroll. Account-only pages fall back to the document.
  // A containing outer ID never overrides a nearer actual scroll surface.
  const window = document.defaultView;
  function findScroller() {
    for (let parent = host.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(window.getComputedStyle(parent).overflowY)) return parent;
    }
    return document.scrollingElement || document.documentElement;
  }
  const scroller = findScroller(), documentScroll = scroller === document.scrollingElement || scroller === document.documentElement;
  const scrollEvents = documentScroll ? window : scroller;
  let rowElements = new Map(), lastScroll = scroller.scrollTop, restoring = false;
  const rowKey = row => `${row.observation_ref}:${row.kind}`;
  const viewport = () => documentScroll ? {top: 0, bottom: window.innerHeight} : scroller.getBoundingClientRect();
  const visible = () => {
    const box = viewport();
    return [...rowElements].filter(([, element]) => {
      const rect = element.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom;
    });
  };
  function navigate(direction, automatic = false) {
    if (!current() || host.closest('[hidden],[inert]')) return;
    const requested = controller.getSnapshot();
    const focus = !automatic && host.contains(document.activeElement) ? document.activeElement : null;
    void controller.loadHistory({[direction]: true, canCommit: automatic ? pages => {
      if (!current() || host.closest('[hidden],[inert]')) return false;
      const keys = new Set(pages.flatMap(entry => entry.page.items.map(rowKey)));
      return visible().every(([key]) => keys.has(key));
    } : undefined}).then(() => {
      const state = controller.getSnapshot();
      if (!focus || !current() || state.selectedSource !== requested.selectedSource
        || state.family !== requested.family || state.mode !== requested.mode || state.status === 'retired') return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected && !active.disabled) return;
      const target = focus.isConnected && !focus.disabled ? focus : pageStatus;
      target.focus({preventScroll: true});
    });
  }
  // Trigger once per actual directional scroll, never an observer cascade or
  // post-render fill loop. Buttons remain the complete keyboard fallback.
  on(scrollEvents, 'scroll', () => {
    const position = scroller.scrollTop, delta = position - lastScroll; lastScroll = position;
    if (restoring || !delta || !current() || host.closest('[hidden],[inert]')) return;
    const state = controller.getSnapshot(); if (state.status !== 'ready') return;
    const box = viewport(), bounds = list.getBoundingClientRect();
    if (delta > 0 && state.hasOlder && bounds.bottom <= box.bottom + 320 && bounds.bottom >= box.top)
      navigate('next', true);
    else if (delta < 0 && state.hasNewer && bounds.top >= box.top - 320 && bounds.top <= box.bottom)
      navigate('newer', true);
  });
  function addBoundary(parent, label, value) {
    const term = node(parent, 'dt', '', label);
    const description = node(parent, 'dd');
    if (value.state !== 'valid') {
      description.textContent = value.state === 'absent' ? 'Not supplied' : value.state === 'empty' ? 'Empty source field' : 'Unavailable source field'; return;
    }
    node(description, 'span', '', value.label + (value.truncated ? '…' : ''));
    node(description, 'span', 'foobar-history__resolution', value.resolution === 'resolved'
      ? 'Source timestamp with an explicit timezone; UTC ordering resolved.' : 'Source timestamp; timezone or exact date unresolved.');
    term.title = 'Original imported boundary label, not a measured listening event';
  }
  function paintRows(page) {
    for (const button of rowButtons.values()) button.dispose(); rowButtons.clear();
    nativeNotice.textContent = '';
    list.replaceChildren(); rowElements.clear();
    if (!page) return;
    for (const row of page.items) {
      const value = row.projection, item = node(list, 'li', 'foobar-history__row');
      rowElements.set(rowKey(row), item);
      // Source identifiers are labels only. Do not give them native selection
      // attributes or expose a callback that could infer media authority.
      const heading = node(item, 'div', 'foobar-history__row-heading');
      if(row.enhanced){
        const raw=row.enhanced;
        node(heading,'h4','',raw.label+(raw.label_truncated?'…':''));
        node(heading,'span','foobar-history__kind',raw.entry?'Local timestamp evidence':'Imported source record');
        node(item,'p','foobar-history__hint',raw.label_kind==='source_filename'
          ?'Original filename label, not resolved library metadata.':'Source-key fallback label; track metadata is unavailable.');
        if(raw.entry){
          node(item,'p','',raw.entry.state==='resolved'?raw.entry.iso_utc:'Undated timestamp evidence');
          if(raw.entry.code)node(item,'p','foobar-history__diagnostic',{
            zero_or_unavailable:'The original timestamp is zero; its meaning is unknown.',
            sentinel_like:'The original timestamp resembles a sentinel and is not treated as a listening date.',
            outside_supported_calendar:'The original timestamp is outside the supported display calendar.',
          }[raw.entry.code]);
          node(item,'p','foobar-history__hint',`Original FILETIME ticks: ${raw.entry.raw_filetime_ticks}. Vector position ${raw.entry.ordinal + 1}; position is not a stable event ID.`);
        }else node(item,'p','',raw.local_vector_count===null?'No usable local timestamp vector is available.'
          :`${raw.local_vector_count} reported local timestamp entries. This is not a lifetime play count.`);
        node(item,'p','foobar-history__hint','This source may be incomplete or seeded. Equal timestamps at separate vector positions remain separate evidence. Cached Last.fm timestamps are excluded; no duration, session or full-album claim is made.');
        if (nativeActions) {
          const slot = node(item, 'span', 'foobar-history__actions');
          rowButtons.set(row, mountButton(slot, runtime, {label: 'Check playback match', disabled: true}));
        }
        continue;
      }
      node(heading, 'h4', '', displayLabel(value.title, 'Untitled source record'));
      const diagnostic = value.status !== 'ready' || value.total === '0';
      const kind = diagnostic ? value.status === 'needs_reconciliation' ? 'Needs reconciliation' : value.total === '0' ? 'No plays reported' : 'Count unavailable'
        : row.kind === 'first_boundary' ? 'First-play boundary' : row.kind === 'unknown_dates_bucket' ? 'Undated aggregate remainder' : 'Grouped source history';
      node(heading, 'span', 'foobar-history__kind', kind);
      if (!diagnostic && (row.kind === 'grouped_aggregate' && value.show_grouped_count
        || row.kind === 'unknown_dates_bucket' && value.show_remainder_count))
        node(heading, 'span', 'foobar-history__count', `${row.kind === 'grouped_aggregate' ? value.total : value.aggregate_remainder} reported plays`);
      node(item, 'p', '', `${displayLabel(value.artist, 'Unknown artist')} · ${displayLabel(value.album, 'Unknown album')}`);
      if (value.artist.truncated || value.title.truncated || value.album.truncated) node(item, 'p', 'foobar-history__hint', 'Long source metadata is shown as a bounded preview.');
      if (value.reason) node(item, 'p', 'foobar-history__diagnostic', REASONS[value.reason]);
      if (row.kind === 'unknown_dates_bucket' && !diagnostic && !value.show_remainder_count)
        node(item, 'p', 'foobar-history__hint', value.aggregate_remainder + ' reported play with unknown individual date.');
      if (row.kind === 'unknown_dates_bucket' && !diagnostic)
        node(item, 'p', 'foobar-history__hint', 'Individual dates for this remainder are unknown. The last-play boundary is only its source sorting anchor, not a timestamp for every play.');
      const evidence = node(item, 'dl', 'foobar-history__boundaries');
      addBoundary(evidence, 'First played (source)', value.first); addBoundary(evidence, row.kind === 'unknown_dates_bucket' ? 'Last-known listened time (source boundary)' : 'Last played (source)', value.last);
      if (value.timestamp_coverage === 'no_timestamps') node(item, 'p', 'foobar-history__hint', 'No usable timestamps were supplied for this count family.');
      if (nativeActions) {
        const slot = node(item, 'span', 'foobar-history__actions');
        rowButtons.set(row, mountButton(slot, runtime, {label: 'Check playback match', disabled: true}));
      }
    }
    paintNative();
  }
  function render() {
    if (disposed) return;
    const state = controller.getSnapshot(), retired = state.status === 'retired' || state.sourcesStatus === 'retired';
    host.setAttribute('aria-busy', String(state.status === 'loading' || state.sourcesStatus === 'loading'));
    if (renderedSources !== state.sources || sourceSelect.value !== (state.selectedSource?.source_ref || '')) {
      renderedSources = state.sources; sourceSelect.replaceChildren(); option(sourceSelect, '', 'Choose an existing source');
      const values = state.selectedSource && !state.sources.some(value => value.source_ref === state.selectedSource.source_ref)
        ? [state.selectedSource, ...state.sources] : state.sources;
      for (const source of values) option(sourceSelect, source.source_ref,
        `${source.is_default ? 'Default source · ' : ''}${source.source_ref} · ${source.observation_count} records`);
      sourceSelect.value = state.selectedSource?.source_ref || '';
    }
    sourceSelect.disabled = retired || !['ready', 'empty'].includes(state.sourcesStatus);
    familySelect.value = state.family; modeSelect.value = state.mode;
    groupedOption.textContent=state.family==='local_entries'?'Source records (not chronological)':'Grouped records';
    individualOption.textContent=state.family==='local_entries'?'Chronological local entries + undated tail':'First boundary + undated aggregate';
    familySelect.disabled = modeSelect.disabled = retired;
    firstSources.update(retired || state.sourcesStatus === 'loading');
    nextSources.update(retired || state.sourcesStatus === 'loading' || !state.sourceCursor);
    refresh.update(retired || !state.selectedSource || state.status === 'loading');
    next.update(retired || state.status !== 'ready' || !state.hasOlder);
    newer.update(retired || state.status !== 'ready' || !state.hasNewer);
    start.update(retired || state.status !== 'ready' || !state.hasNewer);
    sourceStatus.textContent = state.sourcesError || (retired ? 'Account source access is closed.' : state.sourcesStatus === 'loading' ? 'Loading your existing account sources…'
      : state.sourcesStatus === 'empty' ? 'No imported Foobar sources are available for this account. Reading history does not create a source.'
        : state.sourceCursor ? 'More account sources are available on the next source page.' : 'Choose one source explicitly. Sources are not combined.');
    scope.textContent = state.selectedSource
      ? `Source: ${state.selectedSource.source_ref} · ${state.family==='local_entries'?'Local timestamp evidence':state.family === 'standard' ? 'Standard counts' : 'Enhanced counts'} · All time`
      : 'No account source selected.';
    status.textContent = state.error || (state.status === 'loading' ? 'Loading this source’s history…'
      : state.status === 'empty' ? 'This selected source has no history records in this view.'
        : state.status === 'idle' ? 'Select an account source to read its history.' : '');
    status.setAttribute('role', ['unavailable', 'stale'].includes(state.status) ? 'alert' : 'status');
    if (renderedPage !== state.page) {
      // Capture at commit time, not request time: delayed reads must not undo
      // scrolling performed while the request was pending. Only retained row
      // keys and measured offsets are used; no virtual total-height spacer.
      const continuing = state.page && renderedPage && ['older', 'newer'].includes(state.direction);
      const keys = new Set(state.page?.items.map(rowKey) || []);
      const candidates = continuing ? [...rowElements].filter(([key]) => keys.has(key)) : [];
      const box = viewport();
      const anchor = candidates.find(([, element]) => element.getBoundingClientRect().bottom > box.top) || candidates.at(-1);
      const offset = anchor ? anchor[1].getBoundingClientRect().top - box.top : null;
      const focusedRow = [...rowElements].find(([, element]) => element.contains(document.activeElement))?.[0];
      renderedPage = state.page; paintRows(state.page);
      if (anchor && rowElements.has(anchor[0])) {
        restoring = true;
        scroller.scrollTop += rowElements.get(anchor[0]).getBoundingClientRect().top - viewport().top - offset;
        lastScroll = scroller.scrollTop; restoring = false;
      } else if (state.page && state.direction === 'start') {
        // Return-to-newest is deliberate navigation, not a new revision refresh.
        restoring = true;
        scroller.scrollTop += list.getBoundingClientRect().top - viewport().top;
        lastScroll = scroller.scrollTop; restoring = false;
      }
      if (focusedRow) {
        const target = rowElements.get(focusedRow)?.querySelector('button');
        (target && !target.disabled ? target : pageStatus).focus({preventScroll: true});
      }
    }
    paintNative();
    pageStatus.textContent = state.page
      ? `${state.page.items.length} records in the loaded window · Loaded pages ${state.firstPage + 1}–${state.lastPage + 1} · Source revision ${state.page.source_revision}${state.hasNewer ? ' · Newer records can be reloaded' : ''}${state.hasOlder ? ' · More older records available; total unknown' : ' · End confirmed by the source response'}` : '';
  }
  function dispose() {
    if (disposed) return; disposed = true; unsubscribe?.();
    releaseNative?.(); nativeActions?.dispose();
    for (const button of rowButtons.values()) {try {button.dispose();} catch {}} rowButtons.clear();
    for (const release of releases) {try {release();} catch {}}
    for (const button of buttons) {try {button.dispose();} catch {}}
    renderedSources = renderedPage = null; rowElements.clear(); host.replaceChildren();
  }
  try {
    // Optional acquisition cannot turn account-only history into a media shell.
    try {nativeActions = initial.createNativeActions?.({controller, isCurrent: current}) || null;} catch {nativeActions = null;}
    if (nativeActions) {
      nativeHint.textContent = 'Check for a permitted native match, then choose Check and play matched track. Actual file availability is checked on that click. No queue, playlist, rating, love or detail actions are granted.';
      releaseNative = nativeActions.subscribe(paintNative);
    }
    unsubscribe = controller.subscribe(render); render(); if (current()) void owner.initialize();
    return {element: host, update(nextProps) {
      if (disposed) return;
      if (nextProps.owner !== owner) throw new Error('Foobar account owner changed. Dispose and remount this panel.');
      props = nextProps; render();
    }, dispose};
  } catch (error) {dispose(); throw error;}
}
