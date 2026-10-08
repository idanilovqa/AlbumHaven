const HomeRecent = (() => {
  const granted = (row, action) => Object.prototype.hasOwnProperty.call(row.allowed_actions || {}, action)
    && row.allowed_actions[action] === true;
  function localIdentity(row) {
    return row.row_kind === 'local_album' && row.local_match_state === 'matched_local'
      && typeof row.album_ref === 'string' && row.album_ref.trim() !== '';
  }
  const canOpen = row => localIdentity(row) && granted(row, 'can_open_album');
  const canSelect = (row, mode) => localIdentity(row)
    && (mode === 'details' ? granted(row, 'can_view_details') : canOpen(row));

  function artworkUrl(row) {
    for (const value of [row.remote_cover_thumbnail_url, row.remote_cover_url]) {
      if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
      try {
        const url = new URL(value);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return value;
      } catch (_error) { /* Invalid supplied artwork falls back to the native empty state. */ }
    }
    return '';
  }

  function listeningSummary(row) {
    const facts = [];
    const count = (value, label) => {
      if (Number.isInteger(value) && value >= 0) facts.push(`${value} ${label}${value === 1 ? '' : 's'}`);
    };
    count(row.listen_event_count, 'listen event');
    count(row.listened_track_count, 'listened track');
    if (Number.isInteger(row.album_track_count) && row.album_track_count >= 0) {
      facts.push(`${row.album_track_count} total track${row.album_track_count === 1 ? '' : 's'}`);
    }
    if (typeof row.listened_duration_seconds === 'number' && Number.isFinite(row.listened_duration_seconds) && row.listened_duration_seconds >= 0) {
      facts.push(`${formatDurationCompact(row.listened_duration_seconds)} listened`);
    }
    const timestamp = row.last_listened_at;
    const time = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))
      ? `<time datetime="${escapeHtml(timestamp)}">${escapeHtml(new Date(timestamp).toLocaleString())}</time>` : '';
    return `<div class="chip-row">${facts.map(fact => `<span>${escapeHtml(fact)}</span>`).join('')}${time ? `<span>Last listened ${time}</span>` : ''}</div>`;
  }

  function cardHtml(entry, displayMode, selectionMode) {
    const { row, key, local, uniqueRef } = entry;
    const open = local && uniqueRef && canOpen(row);
    const select = local && uniqueRef && canSelect(row, selectionMode);
    const url = !local && row.row_kind === 'external_album' ? artworkUrl(row) : '';
    const label = `${typeof row.name === 'string' ? row.name : 'Album'} artwork`;
    return buildGalleryCardHtml({
      identity: key,
      title: typeof row.name === 'string' ? row.name : '',
      artist: typeof row.album_artist === 'string' ? row.album_artist : '',
      interaction: select || open ? 'controlled' : 'none',
      actionRef: select || open ? row.album_ref : '',
      actions: { select, open, play: open && granted(row, 'can_play_album') },
      artboxHtml: buildAlbumArtboxHtml({
        state: url ? 'ready' : 'empty', label,
        coverHtml: url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : '',
      }),
      listeningSummaryHtml: listeningSummary(row), displayMode,
    });
  }

  function mount(element, options = {}) {
    if (!(element instanceof Element)) throw new TypeError('HomeRecent requires a widget element.');
    const { onSelectAlbum, onOpenAlbum, onPlayAlbum, onRetry } = options;
    if (![onSelectAlbum, onOpenAlbum, onPlayAlbum, onRetry].every(callback => typeof callback === 'function')) {
      throw new TypeError('HomeRecent requires select, open, play and retry callbacks.');
    }
    const document = element.ownerDocument;
    const header = document.createElement('header');
    header.className = 'gallery-bar home-recent__header';
    header.innerHTML = buildGalleryBarHtml({ contextKind: 'recent', title: 'Recent' });
    const body = document.createElement('div');
    body.className = 'home-recent__body gallery-scrollbar';
    const statusElement = document.createElement('div');
    statusElement.className = 'home-recent__status';
    const localRows = document.createElement('div');
    localRows.className = 'home-recent__rows';
    const external = document.createElement('section');
    external.className = 'home-recent__external';
    const externalTitle = document.createElement('h3');
    externalTitle.textContent = 'Not local listens';
    const externalRows = document.createElement('div');
    externalRows.className = 'home-recent__rows';
    external.append(externalTitle, externalRows);
    body.append(statusElement, localRows, external);
    element.classList.add('home-recent');
    element.append(header, body);

    let disposed = false, status = 'loading', selectionMode = 'native';
    let current = new Map();
    const callbacks = { select: onSelectAlbum, open: onOpenAlbum, play: onPlayAlbum };

    function showStatus(nextStatus) {
      current.clear();
      localRows.replaceChildren();
      externalRows.replaceChildren();
      localRows.hidden = true;
      external.hidden = true;
      externalTitle.textContent = '';
      const messages = {
        loading: 'Loading recent listens…',
        empty: 'No recent listens.',
        error: 'Recent listens could not be loaded.',
        denied: 'Recent listens are unavailable.',
        unavailable: 'Recent listens are not available on this server yet.',
      };
      statusElement.hidden = false;
      statusElement.innerHTML = buildOnPageAlertHtml({
        severity: nextStatus === 'error' ? 'error' : 'info',
        role: nextStatus === 'error' ? 'alert' : 'status',
        message: messages[nextStatus],
        actionsHtml: nextStatus === 'error' ? ButtonComponent.renderButton({
          label: 'Retry', attributes: { 'data-home-recent-retry': 'true' },
        }) : '',
      });
    }

    function update({ status: requestedStatus, payload, selectedAlbumRef = null, displayMode = 'cards', selectionMode: requestedSelectionMode = 'native' } = {}) {
      if (disposed) return;
      // A consumer with a custom detail reader selects only explicitly readable
      // detail targets. This mode does not authorize native Open or Play.
      selectionMode = requestedSelectionMode === 'details' ? 'details' : 'native';
      status = ['loading', 'ready', 'error', 'denied', 'unavailable'].includes(requestedStatus) ? requestedStatus : 'error';
      const local = payload?.recent_local_albums, notLocal = payload?.recent_not_local_albums;
      if (status === 'ready' && (!Array.isArray(local) || !Array.isArray(notLocal)
        || ![...local, ...notLocal].every(row => row && typeof row === 'object' && !Array.isArray(row)))) status = 'error';
      if (status !== 'ready') { showStatus(status); return; }
      if (!local.length && !notLocal.length) { showStatus('empty'); return; }

      displayMode = ['list', 'cards', 'covers'].includes(displayMode) ? displayMode : 'cards';
      localRows.dataset.homeDisplay = displayMode; externalRows.dataset.homeDisplay = displayMode;
      const previous = current;
      current = new Map();
      const refCounts = new Map();
      for (const row of local) refCounts.set(row.album_ref, (refCounts.get(row.album_ref) || 0) + 1);
      function renderRows(rows, container, isLocal) {
        const occurrences = new Map();
        rows.forEach((row, index) => {
          const identity = isLocal
            ? (typeof row.album_ref === 'string' && row.album_ref.trim() ? row.album_ref : `missing:${index}`)
            : JSON.stringify([row.name, row.album_artist]);
          const occurrence = occurrences.get(identity) || 0;
          occurrences.set(identity, occurrence + 1);
          const key = JSON.stringify([isLocal ? 'local' : 'external', identity, occurrence]);
          const entry = { row, key, local: isLocal, uniqueRef: refCounts.get(row.album_ref) === 1 };
          const html = cardHtml(entry, displayMode, selectionMode), old = previous.get(key);
          let card = old?.element;
          if (!card || old.html !== html) {
            const holder = document.createElement('div');
            holder.innerHTML = html;
            const rendered = holder.firstElementChild;
            if (card) {
              card.innerHTML = rendered.innerHTML;
              card.setAttribute('data-gallery-card-interaction', rendered.getAttribute('data-gallery-card-interaction'));
              card.setAttribute('data-gallery-display', rendered.getAttribute('data-gallery-display'));
            } else card = rendered;
          }
          const select = card.querySelector('[data-gallery-card-intent="select"]');
          if (select) select.setAttribute('aria-pressed', row.album_ref === selectedAlbumRef ? 'true' : 'false');
          if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
          current.set(key, { ...entry, element: card, html });
        });
      }
      renderRows(local, localRows, true);
      renderRows(notLocal, externalRows, false);
      for (const [key, entry] of previous) if (!current.has(key)) entry.element.remove();
      statusElement.replaceChildren();
      statusElement.hidden = true;
      localRows.hidden = local.length === 0;
      external.hidden = notLocal.length === 0;
      externalTitle.textContent = notLocal.length ? 'Not local listens' : '';
    }

    function onClick(event) {
      if (disposed) return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const retry = target?.closest('[data-home-recent-retry]');
      if (retry && statusElement.contains(retry)) {
        event.preventDefault(); event.stopPropagation();
        if (status === 'error') onRetry();
        return;
      }
      const control = target?.closest('[data-gallery-card-intent]');
      if (!control || !body.contains(control)) return;
      event.preventDefault(); event.stopPropagation();
      if (status !== 'ready') return;
      const card = control.closest('.album-card');
      const entry = card && current.get(card.getAttribute('data-gallery-card-key'));
      const intent = control.getAttribute('data-gallery-card-intent');
      const ref = control.getAttribute('data-gallery-card-ref');
      if (!entry || entry.element !== card || !entry.local || !entry.uniqueRef || control.disabled
        || ref !== entry.row.album_ref || !Object.prototype.hasOwnProperty.call(callbacks, intent)) return;
      if (intent === 'select' ? !canSelect(entry.row, selectionMode) : !canOpen(entry.row)) return;
      if (intent === 'play' && !granted(entry.row, 'can_play_album')) return;
      callbacks[intent](ref);
    }
    body.addEventListener('click', onClick);
    showStatus('loading');
    return {
      element, header, body, update,
      dispose() {
        if (disposed) return;
        disposed = true;
        current.clear();
        body.removeEventListener('click', onClick);
      },
    };
  }
  return { mount };
})();
