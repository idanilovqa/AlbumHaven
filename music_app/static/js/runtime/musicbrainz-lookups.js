// The owner's manual MusicBrainz lookups (Delivery 2, S5). The album menu and Problematic
// Files queue or search one artist or album; each batch is one "MusicBrainz lookup" card in
// the notification drawer (the cover-lookup card component), and opening it shows the
// results popup.
const MUSICBRAINZ_LOOKUP_REFRESH_MS = { running: 10000, queued: 60000, idle: 300000 };
const musicBrainzLookups = { batches: [], queuedCount: 0, signature: '', loadedAt: 0, promise: null };

function canRequestMusicBrainzLookups() {
  return state.status?.allowed_actions?.['catalogue.enrichment.request'] === true;
}

function getMusicBrainzLookupBatches() {
  return musicBrainzLookups.batches;
}

// Piggybacks on the status poll: soon while a batch runs, every minute while lookups wait.
function refreshMusicBrainzLookupNotifications({ force = false } = {}) {
  if (!canRequestMusicBrainzLookups()) return Promise.resolve(false);
  if (musicBrainzLookups.promise) return musicBrainzLookups.promise;
  const interval = musicBrainzLookups.batches.some((batch) => !batch.finished_at)
    ? MUSICBRAINZ_LOOKUP_REFRESH_MS.running
    : musicBrainzLookups.queuedCount ? MUSICBRAINZ_LOOKUP_REFRESH_MS.queued : MUSICBRAINZ_LOOKUP_REFRESH_MS.idle;
  if (!force && Date.now() - musicBrainzLookups.loadedAt < interval) return Promise.resolve(false);
  musicBrainzLookups.promise = fetch('/api/musicbrainz/lookups', { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return false;
      const batches = Array.isArray(payload.batches) ? payload.batches : [];
      musicBrainzLookups.queuedCount = Array.isArray(payload.queued) ? payload.queued.length : 0;
      const signature = JSON.stringify(batches);
      if (signature === musicBrainzLookups.signature) return false;
      musicBrainzLookups.signature = signature;
      musicBrainzLookups.batches = batches;
      if (typeof renderCoverLookupDrawer === 'function') renderCoverLookupDrawer();
      return true;
    })
    .catch(() => false)
    .finally(() => {
      musicBrainzLookups.loadedAt = Date.now();
      musicBrainzLookups.promise = null;
    });
  return musicBrainzLookups.promise;
}

async function requestMusicBrainzLookup({ targetKind, mode, albumKey = '', localArtistId = null }) {
  const target = albumKey ? { album_key: String(albumKey) } : { local_artist_id: Number(localArtistId) };
  try {
    const response = await fetch('/api/musicbrainz/lookups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ target_kind: targetKind, mode, ...target }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.detail || 'MusicBrainz lookup failed. Try again shortly.');
    const subject = targetKind === 'artist' ? 'artist' : 'album';
    showToast(mode === 'search'
      ? `Searching MusicBrainz for the ${subject}. The result appears in notifications.`
      : `MusicBrainz lookup for the ${subject} queued. It starts within an hour, or with the next MusicBrainz sync.`,
    'info', 3200);
    void refreshMusicBrainzLookupNotifications({ force: true });
    return payload;
  } catch (error) {
    showToast(error?.message || 'MusicBrainz lookup failed. Try again shortly.', 'error', 3200);
    return null;
  }
}

// Album menu (F): the queue items always; "Search …" only for what has no MBID yet, once
// the server says so. The menu is the shared album-card menu.
function buildAlbumMenuMusicBrainzItems() {
  if (!canRequestMusicBrainzLookups()) return [];
  return [
    '<div class="account-menu-separator" role="separator"></div>',
    '<button type="button" class="album-card-context-menu-item" data-album-card-action="musicbrainz-queue-artist">Queue MusicBrainz lookup for the artist</button>',
    '<button type="button" class="album-card-context-menu-item" data-album-card-action="musicbrainz-queue-album">Queue MusicBrainz lookup for the album</button>',
  ];
}

async function appendAlbumMenuMusicBrainzSearchItems(menu, albumKey) {
  if (!canRequestMusicBrainzLookups() || !albumKey) return;
  try {
    const response = await fetch(`/api/musicbrainz/lookups/target?album_key=${encodeURIComponent(albumKey)}`,
      { headers: { Accept: 'application/json' } });
    const target = response.ok ? (await response.json())?.target : null;
    if (!target || menu.hidden || menu.dataset.albumKey !== albumKey) return;
    const items = [
      target.artist_has_mbid ? '' : '<button type="button" class="album-card-context-menu-item" data-album-card-action="musicbrainz-search-artist">Search MusicBrainz for the artist</button>',
      target.album_has_mbid ? '' : '<button type="button" class="album-card-context-menu-item" data-album-card-action="musicbrainz-search-album">Search MusicBrainz for the album</button>',
    ].join('');
    if (items) menu.insertAdjacentHTML('beforeend', items);
  } catch {
    // Without the status the menu keeps its queue items.
  }
}

const ALBUM_MENU_MUSICBRAINZ_ACTIONS = {
  'musicbrainz-queue-artist': ['artist', 'queue'],
  'musicbrainz-queue-album': ['album', 'queue'],
  'musicbrainz-search-artist': ['artist', 'search'],
  'musicbrainz-search-album': ['album', 'search'],
};

function runAlbumMenuMusicBrainzAction(action, album) {
  const request = ALBUM_MENU_MUSICBRAINZ_ACTIONS[action];
  if (!request) return false;
  if (album?.key) void requestMusicBrainzLookup({ targetKind: request[0], mode: request[1], albumKey: album.key });
  return true;
}

// Notification card (H1): the shared card; its kind is its title.
function buildMusicBrainzLookupCardHtml(batch) {
  const total = Math.max(0, Number(batch.total || 0));
  const matched = Math.max(0, Number(batch.matched || 0));
  const notMatched = Math.max(0, Number(batch.not_matched || 0));
  const running = !batch.finished_at;
  const single = total === 1;
  const noun = Number(batch.albums) === total ? 'releases ' : Number(batch.artists) === total ? 'artists ' : '';
  const byline = single
    ? [batch.single_title, batch.single_target_kind === 'album' ? batch.single_artist_name : 'Artist'].filter(Boolean).join(' · ')
    : `${matched} ${noun}matched, ${notMatched} not matched`;
  const singleMissed = single && batch.single_outcome === 'not_matched';
  const statusLabel = running
    ? `Looking up${single ? '' : ` ${matched + notMatched} of ${total}`}`
    : single ? (singleMissed ? (batch.single_problem_label || 'Not matched') : 'MBID found') : `${total} looked up`;
  const stateClass = running ? 'is-running' : singleMissed ? 'is-failed' : 'is-completed';
  const elapsed = formatCoverLookupTaskElapsedLabel({
    status: running ? 'running' : 'completed', created_at: batch.started_at, finished_at: batch.finished_at,
  });
  return buildNotificationTaskCardHtml({
    kind: 'musicbrainz',
    stateClass,
    openAttributes: `data-open-musicbrainz-lookup-batch="${escapeHtml(batch.batch_id)}"`,
    openLabel: `Open ${NOTIFICATION_CARD_TITLES.musicbrainz} results: ${byline}`,
    coverHtml: '<span class="cover-lookup-task-cover is-placeholder" aria-hidden="true"></span>',
    byline,
    statusLabel,
    elapsedHtml: elapsed ? `<span class="cover-lookup-task-elapsed ${running ? 'is-active' : stateClass}">${escapeHtml(elapsed)}</span>` : '',
    actionsHtml: running ? '' : ButtonComponent.renderActionButton({
      icon: 'delete', semantic: 'destructive', ariaLabel: 'Delete notification', title: 'Delete notification',
      className: 'cover-lookup-task-clear', attributes: { 'data-dismiss-musicbrainz-lookup-batch': String(batch.batch_id) },
    }),
    progress: running ? Math.round(((matched + notMatched) / Math.max(1, total)) * 100) : 100,
  });
}

async function dismissMusicBrainzLookupBatch(batchId) {
  const previous = musicBrainzLookups.batches;
  musicBrainzLookups.batches = previous.filter((batch) => String(batch.batch_id) !== String(batchId));
  renderCoverLookupDrawer({ preserveInteraction: false });
  try {
    const response = await fetch(`/api/musicbrainz/lookups/batches/${encodeURIComponent(batchId)}/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
    });
    if (!response.ok) throw new Error('Failed to delete notification.');
    musicBrainzLookups.signature = '';
  } catch (error) {
    musicBrainzLookups.batches = previous;
    renderCoverLookupDrawer({ preserveInteraction: false });
    showToast(error.message, 'error', 2800);
  }
}

// Results popup (H2): the app's modal header and close button; rows are navigation-tree
// items, as in Problematic Files.
function buildMusicBrainzLookupResultRowHtml(item) {
  const isAlbum = item.target_kind === 'album';
  const title = (isAlbum ? item.album_title : item.artist_name) || 'Unknown';
  const loadedAlbum = isAlbum && typeof getIndexedAlbum === 'function' ? getIndexedAlbum(item.album_key) : null;
  const artworkLabel = isAlbum ? `Artwork for ${title}` : `Artist ${title}`;
  const artworkHtml = loadedAlbum
    ? buildUtilityAlbumArtbox(loadedAlbum, { label: artworkLabel })
    : buildAlbumArtboxHtml({ state: 'missing', label: artworkLabel });
  const mbid = String(item.result_mbid || '');
  const result = item.outcome === 'matched'
    ? `<span class="musicbrainz-lookup-result-mbid">${mbid ? `MBID ${escapeHtml(`${mbid.slice(0, 8)}…${mbid.slice(-4)}`)}` : 'MBID per album'}</span>`
    : item.outcome === 'not_matched'
      ? buildAlertLabelHtml({ severity: 'warning', message: item.problem_label || 'Not matched' })
      : '<span class="musicbrainz-lookup-result-mbid">Looking up…</span>';
  const attributes = item.outcome === 'matched' && mbid
    ? { 'data-open-musicbrainz-url': `https://musicbrainz.org/${item.result_entity || 'artist'}/${mbid}` }
    : item.outcome === 'not_matched'
      ? { 'data-open-musicbrainz-lookup-problem': String(item.problem_occurrence_id || '') }
      : {};
  return window.NavigationTree.renderItem({
    variant: 'wide', action: true, key: String(item.request_id), label: title,
    subtitle: isAlbum ? item.artist_name || '' : 'Artist', year: isAlbum && item.year ? String(item.year) : '',
    artworkHtml, artworkLabel, count: null, attributes,
    className: 'musicbrainz-lookup-result', trailingHtml: `<span class="musicbrainz-lookup-result-detail">${result}</span>`,
  });
}

function renderMusicBrainzLookupResults(batch) {
  const modal = document.getElementById('musicbrainz-lookup-results-modal');
  if (!modal) return;
  const matched = Number(batch.matched || 0);
  const notMatched = Number(batch.not_matched || 0);
  modal.querySelector('#musicbrainz-lookup-results-summary').textContent = [
    `${matched} matched, ${notMatched} not matched.`,
    notMatched ? 'Not matched items are in Problematic Files.' : '',
    batch.finished_at ? '' : 'Still looking up…',
  ].filter(Boolean).join(' ');
  modal.querySelector('#musicbrainz-lookup-results-list').innerHTML = (batch.items || [])
    .map(buildMusicBrainzLookupResultRowHtml).join('');
}

async function openMusicBrainzLookupResults(batchId) {
  const modal = document.getElementById('musicbrainz-lookup-results-modal');
  if (!modal) return;
  try {
    const response = await fetch(`/api/musicbrainz/lookups/batches/${encodeURIComponent(batchId)}`,
      { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.batch) throw new Error(payload?.detail || 'Lookup results are unavailable.');
    renderMusicBrainzLookupResults(payload.batch);
    bindOverlayPointerOrigin(modal);
    modal.hidden = false;
    document.body.classList.add('modal-open');
    modal.querySelector('[data-close-musicbrainz-lookup-results]')?.focus?.();
  } catch (error) {
    showToast(error.message, 'error', 2800);
  }
}

function closeMusicBrainzLookupResults() {
  const modal = document.getElementById('musicbrainz-lookup-results-modal');
  if (!modal || modal.hidden) return false;
  modal.hidden = true;
  const otherModalOpen = ['track-modal', 'utility-modal', 'image-lightbox']
    .some((id) => document.getElementById(id)?.hidden === false);
  if (!otherModalOpen) document.body.classList.remove('modal-open');
  return true;
}

function openProblematicFilesFromMusicBrainzLookup(occurrenceId = '') {
  closeMusicBrainzLookupResults();
  state.coverLookup.drawerOpen = false;
  renderCoverLookupDrawer();
  if (occurrenceId) {
    void openMusicBrainzArtistProblem(occurrenceId);
    return;
  }
  setUtilityActiveTab('problematic-files');
  openUtilityModal({ resetSearch: true, resetSelection: false, forceLoad: true });
}

function handleMusicBrainzLookupEvent(event) {
  const target = event.target;
  if (event.type === 'keydown') {
    if (event.key === 'Escape' && closeMusicBrainzLookupResults()) {
      event.preventDefault();
      return true;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return false;
  } else if (event.type !== 'click') {
    return false;
  }
  const albumLookup = target?.closest?.('[data-musicbrainz-lookup-album]');
  if (albumLookup && event.type === 'click') {
    event.preventDefault();
    void requestMusicBrainzLookup({
      targetKind: 'album', mode: albumLookup.dataset.musicbrainzLookup,
      albumKey: albumLookup.dataset.musicbrainzLookupAlbum,
    });
    return true;
  }
  const dismiss = target?.closest?.('[data-dismiss-musicbrainz-lookup-batch]');
  if (dismiss && event.type === 'click') {
    event.preventDefault();
    event.stopPropagation();
    void dismissMusicBrainzLookupBatch(dismiss.getAttribute('data-dismiss-musicbrainz-lookup-batch'));
    return true;
  }
  const open = target?.closest?.('[data-open-musicbrainz-lookup-batch]');
  if (open) {
    event.preventDefault();
    void openMusicBrainzLookupResults(open.getAttribute('data-open-musicbrainz-lookup-batch'));
    return true;
  }
  if (event.type !== 'click') return false;
  const modal = document.getElementById('musicbrainz-lookup-results-modal');
  if (target?.closest?.('[data-close-musicbrainz-lookup-results]')
      || (modal && typeof overlayClickStartedOnOverlay === 'function' && overlayClickStartedOnOverlay(modal, event))) {
    event.preventDefault();
    closeMusicBrainzLookupResults();
    return true;
  }
  const problem = target?.closest?.('[data-open-musicbrainz-lookup-problem]');
  if (problem || target?.closest?.('[data-open-problematic-files-from-lookup]')) {
    event.preventDefault();
    openProblematicFilesFromMusicBrainzLookup(problem?.getAttribute('data-open-musicbrainz-lookup-problem') || '');
    return true;
  }
  return false;
}
