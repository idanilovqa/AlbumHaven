// MusicBrainz data corrections and Settings → Edits Queue (Delivery 2, S4). Problematic Files
// shows an album's "Data Correction Needed" label with each proposed change, and "Add to
// queue" keeps it for Bulk Correction. Display only: nothing here writes tags. Bulk
// Correction and "Apply changes" arrive with PR 53.
const MUSICBRAINZ_DATA_CORRECTION_LABEL = 'Data Correction Needed';
const EDITS_QUEUE_TABS = { 'data-correction': 'Data Correction', 'musicbrainz-lookup': 'MusicBrainz Look Up' };
const editsQueue = { tab: 'data-correction', corrections: null, settings: null, lookups: null, queueStartsAt: null,
  loading: null, failed: false, busy: false };

// Until the owner decides, albums listed only for a correction show when the "Data
// Correction Needed" filter is chosen; true shows them by default.
const MUSICBRAINZ_CORRECTION_ROWS_SHOWN_BY_DEFAULT = false;

function isMusicBrainzCorrectionProblem(item) {
  return item?.entity_kind === 'musicbrainz_correction';
}

function musicBrainzCorrectionRowsWanted(selectedFilters = state.utility.selectedProblemFilters || []) {
  const normalize = typeof normalizeProblemFilterReason === 'function' ? normalizeProblemFilterReason : (reason) => reason;
  return MUSICBRAINZ_CORRECTION_ROWS_SHOWN_BY_DEFAULT
    || selectedFilters.some((reason) => normalize(reason) === normalize(MUSICBRAINZ_DATA_CORRECTION_LABEL));
}

function isMusicBrainzCorrectionRowShown(item, selectedFilters = state.utility.selectedProblemFilters || []) {
  return !isMusicBrainzCorrectionProblem(item) || musicBrainzCorrectionRowsWanted(selectedFilters);
}

// Albums listed only for a correction are not in the Problematic Files response; they come
// in pages from /api/musicbrainz/corrections/albums once they are wanted, the next page as
// the list scrolls near its end. A reloaded list (without them) starts again from page 1.
const MUSICBRAINZ_CORRECTION_PAGE_SIZE = 100;
const MUSICBRAINZ_CORRECTION_PAGE_AHEAD = 20;
const musicBrainzCorrectionPages = { keys: new Set(), nextOffset: 0, loading: null };

function syncMusicBrainzCorrectionRows() {
  const pages = musicBrainzCorrectionPages;
  const items = state.utility.problematicFiles || [];
  if (pages.keys.size && !pages.loading && !items.some((item) => pages.keys.has(item?.key))) {
    pages.keys = new Set();
    pages.nextOffset = 0;
  }
  if (pages.nextOffset === 0 && !pages.keys.size) void loadNextMusicBrainzCorrectionPage();
}

function loadMoreMusicBrainzCorrectionRows(renderedEnd, count) {
  if (renderedEnd >= count - MUSICBRAINZ_CORRECTION_PAGE_AHEAD) void loadNextMusicBrainzCorrectionPage();
}

function loadNextMusicBrainzCorrectionPage() {
  const pages = musicBrainzCorrectionPages;
  if (pages.loading || pages.nextOffset === null || !musicBrainzCorrectionRowsWanted()
      || !(Number(state.utility.musicBrainzCorrectionAlbumCount) > 0)) {
    return pages.loading || Promise.resolve(false);
  }
  const offset = pages.nextOffset;
  pages.loading = fetch(`/api/musicbrainz/corrections/albums?offset=${offset}&limit=${MUSICBRAINZ_CORRECTION_PAGE_SIZE}`,
    { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.items)) return false;
      const items = state.utility.problematicFiles || [];
      // An album already listed keeps its own row, labelled.
      const listed = new Set(items.map((item) => item?.musicbrainz_correction?.album_key || '').filter(Boolean));
      const rows = payload.items.filter((row) => !listed.has(row.musicbrainz_correction?.album_key));
      rows.forEach((row) => pages.keys.add(row.key));
      pages.nextOffset = payload.next_offset ?? null;
      state.utility.problematicFiles = [...items, ...rows];
      return true;
    })
    .catch(() => false)
    .finally(() => {
      pages.loading = null;
      if (state.utility.activeTab === 'problematic-files') renderProblematicFiles({ preserveProblematicTree: true });
    });
  return pages.loading;
}

function canReviewMusicBrainzCorrections() {
  return window.AlbumHavenCapabilities?.allows?.('library.metadata_matches.review') === true;
}

// The mockups' sentence: "MusicBrainz credits this album to Alan Parsons, not The Alan Parsons
// Project." names the files' artist only when one name contains the other.
function describeMusicBrainzCorrection(corrections) {
  const albumArtist = corrections.find((item) => item.field === 'album_artist');
  const title = corrections.find((item) => item.field === 'album');
  const trackTitles = corrections.filter((item) => item.field === 'title').length;
  const related = (left, right) => left.toLowerCase().includes(right.toLowerCase());
  return [
    albumArtist ? `MusicBrainz credits this album to ${albumArtist.proposed}${
      related(albumArtist.current, albumArtist.proposed) || related(albumArtist.proposed, albumArtist.current)
        ? `, not ${albumArtist.current}` : ''}.` : '',
    title ? `MusicBrainz titles this album “${title.proposed}”.` : '',
    trackTitles ? `${trackTitles} track title${trackTitles === 1 ? ' differs' : 's differ'} from MusicBrainz.` : '',
    !albumArtist && !title && !trackTitles ? 'MusicBrainz credits some tracks to other artists.' : '',
    'Add it to Settings → Edits Queue; your files stay unchanged until you run Bulk Correction there.',
  ].filter(Boolean).join(' ');
}

function buildMusicBrainzCorrectionTableHtml(corrections) {
  return buildUtilityCompactTable({
    id: 'musicbrainz-data-correction',
    ariaLabel: 'Suggested correction',
    columns: 'minmax(140px,.8fr) minmax(160px,1fr) minmax(160px,1fr)',
    columnsConfig: [
      { key: 'tag', label: 'Tag' }, { key: 'now', label: 'In your files' }, { key: 'mb', label: 'MusicBrainz' },
    ],
    headers: 'visible', density: 'compact', overflow: 'local', mobile: 'stack', frame: 'outline', selection: 'none',
    rows: corrections.map((item, index) => ({
      key: `${item.field}-${index}`,
      cells: {
        tag: escapeHtml(item.label),
        now: escapeHtml(item.current),
        mb: buildAlertLabelHtml({ severity: 'info', message: item.proposed }),
      },
    })),
  });
}

// The label, explanation, table and "Add to queue" (G: owner 2026-11-15). A listed album
// shows them beneath its detected problems.
function buildMusicBrainzCorrectionHtml(album, { heading = false } = {}) {
  const correction = album.musicbrainz_correction;
  const corrections = Array.isArray(correction?.corrections) ? correction.corrections : [];
  if (!corrections.length) return '';
  const queued = Boolean(correction.queued_at);
  const action = canReviewMusicBrainzCorrections() ? ButtonComponent.renderButton({
    label: queued ? 'In the queue' : 'Add to queue', variant: 'primary', disabled: queued || editsQueue.busy,
    attributes: { 'data-queue-musicbrainz-correction': correction.album_key },
  }) : '';
  return `<div class="utility-album-problem-labels">${buildAlertLabelHtml({ severity: 'warning', message: MUSICBRAINZ_DATA_CORRECTION_LABEL })}</div>
    ${heading ? '<h4 class="utility-detail-section-title">Detected problems</h4>' : ''}
    <p class="utility-detail-meta">${escapeHtml(describeMusicBrainzCorrection(corrections))}</p>
    <div class="utility-detected-table">${buildMusicBrainzCorrectionTableHtml(corrections)}</div>
    ${action ? `<div class="utility-detected-actions">${action}</div>` : ''}`;
}

// An album listed only because it needs a correction: the row's facts, then its correction,
// compared when it is opened.
function buildMusicBrainzCorrectionProblemDetail(item) {
  if (item.musicbrainz_correction_failed) {
    return buildOnPageAlertHtml({ severity: 'error', title: 'Album details unavailable', message: 'Unable to load this data correction.' });
  }
  if (!Array.isArray(item.musicbrainz_correction?.corrections)) {
    return '<div class="utility-empty-state">Loading the data correction…</div>';
  }
  const title = String(item.name || 'Unknown Album');
  const fileTypes = Array.isArray(item.file_types) && item.file_types.length ? item.file_types.join(', ') : 'Unknown';
  return `<div class="utility-detail-header">
      <div class="utility-detail-cover">${buildUtilityAlbumArtbox(item, { label: `Album cover for ${title}` })}</div>
      <div class="utility-detail-summary">
        <h3 class="utility-detail-title">${escapeHtml(title)}</h3>
        <div class="utility-detail-meta">${escapeHtml(item.album_artist || 'Unknown Artist')}</div>
        <div class="utility-detail-meta">Year: ${escapeHtml(item.year ?? 'Unknown')}</div>
        <div class="utility-detail-meta">Tracks: ${escapeHtml(item.track_count ?? 0)}</div>
        <div class="utility-detail-meta">File types: ${escapeHtml(fileTypes)}</div>
      </div>
    </div>
    ${buildMusicBrainzCorrectionHtml(item, { heading: true })}`;
}

async function loadMusicBrainzCorrectionDetail(item) {
  if (!isMusicBrainzCorrectionProblem(item) || item.musicbrainz_correction_loading) return;
  item.musicbrainz_correction_loading = true;
  try {
    const response = await fetch(`/api/musicbrainz/corrections?album_key=${encodeURIComponent(item.musicbrainz_correction.album_key)}`,
      { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.correction) throw new Error('unavailable');
    const { track_count: trackCount, file_types: fileTypes, ...correction } = payload.correction;
    Object.assign(item, { musicbrainz_correction: correction, track_count: trackCount, file_types: fileTypes,
      musicbrainz_correction_failed: false });
  } catch {
    item.musicbrainz_correction_failed = true;
  } finally {
    item.musicbrainz_correction_loading = false;
  }
  if (state.utility.activeTab === 'problematic-files') renderProblematicFiles({ preserveProblematicTree: true });
}

async function queueMusicBrainzCorrection(albumKey) {
  if (editsQueue.busy || !albumKey) return false;
  editsQueue.busy = true;
  try {
    const response = await fetch('/api/musicbrainz/corrections/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ album_key: albumKey }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.detail || 'The correction could not be added. Try again shortly.');
    (state.utility.problematicFiles || []).forEach((item) => {
      if (item?.musicbrainz_correction?.album_key === albumKey) item.musicbrainz_correction.queued_at = payload.queued_at;
    });
    editsQueue.corrections = null;
    showToast('Correction added to Settings → Edits Queue.', 'info', 3200);
    return true;
  } catch (error) {
    showToast(error?.message || 'The correction could not be added. Try again shortly.', 'error', 3200);
    return false;
  } finally {
    editsQueue.busy = false;
    if (state.utility.activeTab === 'problematic-files') renderProblematicFiles({ preserveProblematicTree: true });
  }
}

// Edits Queue rows: "Album artist and 12 track artists: Christian Vander → Magma" (E1).
function summarizeMusicBrainzCorrections(corrections) {
  const titles = corrections.filter((item) => item.field === 'title');
  const changes = new Map();
  corrections.filter((item) => item.field !== 'title').forEach((item) => {
    const change = `${item.current} → ${item.proposed}`;
    const name = item.field === 'artist'
      ? `${item.tracks.length} track artist${item.tracks.length === 1 ? '' : 's'}`
      : item.field === 'album' ? 'Album title' : 'Album artist';
    changes.set(change, [...(changes.get(change) || []), name]);
  });
  const parts = [...changes].map(([change, names]) => `${names.join(' and ')}: ${change}`);
  if (titles.length === 1) parts.push(`Track title: ${titles[0].current} → ${titles[0].proposed}`);
  else if (titles.length) parts.push(`${titles.length} track titles`);
  return parts.join('; ');
}

function formatEditsQueueTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? `today ${time}` : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// The album-versions list (E1/E2): cover, name and one line, then open and remove.
function buildEditsQueueEntryHtml({ kind, id, title, subtitle, album = null }) {
  // Responses name covers by reference (cover_ref), never by path.
  const cover = album?.cover_ref
    ? buildUtilityAlbumArtbox(album, { label: `Artwork for ${title}` })
    : '<span class="version-picker-option-cover-placeholder">No cover</span>';
  const entry = { 'data-edits-queue-kind': kind, 'data-edits-queue-id': String(id) };
  return `<div class="version-picker-option" data-open-edits-queue-entry="1" ${Object.entries(entry)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ')}>
    <span class="version-picker-option-cover">${cover}</span>
    <span class="version-picker-option-meta">
      <span class="version-picker-option-name">${escapeHtml(title)}</span>
      <span class="version-picker-option-subtitle">${escapeHtml(subtitle)}</span>
    </span>
    <span class="version-picker-option-actions">
      ${ButtonComponent.renderActionButton({ ariaLabel: `Open ${title}`, title: 'Open', icon: 'external',
    presentation: 'bare', attributes: { ...entry, 'data-open-edits-queue-entry': '1' } })}
      ${ButtonComponent.renderActionButton({ ariaLabel: `Remove ${title} from the queue`, title: 'Remove from queue',
    icon: 'delete', semantic: 'destructive', disabled: editsQueue.busy,
    attributes: { ...entry, 'data-remove-edits-queue-entry': '1' } })}
    </span>
  </div>`;
}

function buildEditsQueueCorrectionsHtml() {
  const items = editsQueue.corrections || [];
  const settings = editsQueue.settings || {};
  const nextRun = settings.auto_submit_bulks ? formatEditsQueueTime(settings.next_run_at) : '';
  const intro = items.length
    ? `${items.length} approved correction${items.length === 1 ? ' is' : 's are'} waiting. Bulk Correction writes them to your files through Edit Tags. Open an entry to see the album; remove it to drop the correction.`
    : 'No corrections are waiting. Add one from an album labelled Data Correction Needed in Problematic Files.';
  return `<p class="utility-detail-meta">${escapeHtml(intro)}</p>
    <div class="utility-detected-actions edits-queue-controls">
      <div class="edits-queue-auto-submit">
        ${buildGallerySwitchHtml({ id: 'edits-queue-auto-submit', label: 'Auto submit bulks',
    checked: settings.auto_submit_bulks === true, disabled: editsQueue.busy || !canReviewMusicBrainzCorrections() })}
        <span class="utility-detail-meta">${escapeHtml(settings.auto_submit_bulks
    ? `Runs every hour${nextRun ? `. Next run: ${nextRun}` : ''}.` : 'Off: Bulk Correction runs only when you click it.')}</span>
      </div>
      <span title="Bulk Correction arrives soon.">${ButtonComponent.renderButton({
    label: 'Bulk Correction', variant: 'primary', disabled: true, title: 'Bulk Correction arrives soon.' })}</span>
    </div>
    <div class="version-picker-list">${items.map((item) => buildEditsQueueEntryHtml({
    kind: 'correction', id: item.entry_id, title: item.album_title || 'Unknown Album', album: item,
    subtitle: `${[item.artist_name, item.year].filter(Boolean).join(' · ')} — ${summarizeMusicBrainzCorrections(item.corrections || [])}`,
  })).join('')}</div>`;
}

function buildEditsQueueLookupsHtml() {
  const items = editsQueue.lookups || [];
  const startsAt = formatEditsQueueTime(editsQueue.queueStartsAt);
  const intro = items.length
    ? 'Queued look ups start together an hour after the oldest was added. When you run Library → MusicBrainz sync, they go first.'
    : 'No MusicBrainz look ups are waiting. Queue one from an album’s menu or from Problematic Files.';
  return `<p class="utility-detail-meta">${escapeHtml(intro)}</p>
    <div class="version-picker-list">${items.map((item) => {
    const album = item.target_kind === 'album';
    const facts = album ? ['Release', item.artist_name, item.year] : ['Artist'];
    const when = [`queued ${formatEditsQueueTime(item.requested_at)}`, startsAt ? `starts by itself at ${startsAt}` : '']
      .filter(Boolean).join(', ');
    const cover = album && typeof getIndexedAlbum === 'function' ? getIndexedAlbum(item.album_key) : null;
    return buildEditsQueueEntryHtml({
      kind: 'lookup', id: item.request_id, title: (album ? item.album_title : item.artist_name) || 'Unknown',
      album: cover, subtitle: `${facts.filter(Boolean).join(' · ')} — ${when}`,
    });
  }).join('')}</div>`;
}

function buildEditsQueueHtml() {
  const tabs = `<div class="in-page-tabs" role="tablist" aria-label="Edits Queue">${Object.entries(EDITS_QUEUE_TABS)
    .map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === editsQueue.tab}" data-edits-queue-tab="${key}">${escapeHtml(label)}</button>`)
    .join('')}</div>`;
  let body;
  if (editsQueue.failed) {
    body = buildOnPageAlertHtml({ severity: 'error', title: 'Edits Queue unavailable', message: 'Unable to load the Edits Queue. Try again shortly.' });
  } else if (!editsQueue.corrections || !editsQueue.lookups) {
    body = '<div class="utility-empty-state">Loading the Edits Queue…</div>';
  } else {
    body = editsQueue.tab === 'data-correction' ? buildEditsQueueCorrectionsHtml() : buildEditsQueueLookupsHtml();
  }
  return `<div class="edits-queue">${tabs}<div class="edits-queue-body">${body}</div></div>`;
}

function renderUtilityEditsQueue() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.detail) return;
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Edits Queue';
  if (els.list) els.list.innerHTML = '';
  els.detail.innerHTML = buildEditsQueueHtml();
}

async function loadUtilityEditsQueue(force = false) {
  if (editsQueue.loading) return editsQueue.loading;
  if (!force && editsQueue.corrections && editsQueue.lookups) {
    renderUtilityEditsQueue();
    return null;
  }
  renderUtilityEditsQueue();
  const read = (url) => fetch(url, { headers: { Accept: 'application/json' } }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.detail || 'Unavailable');
    return payload;
  });
  editsQueue.loading = Promise.all([read('/api/musicbrainz/corrections/queue'), read('/api/musicbrainz/lookups')])
    .then(([queue, lookups]) => {
      editsQueue.corrections = Array.isArray(queue.items) ? queue.items : [];
      editsQueue.settings = queue.settings || {};
      editsQueue.lookups = Array.isArray(lookups.queued) ? lookups.queued : [];
      editsQueue.queueStartsAt = lookups.queue_starts_at || null;
      editsQueue.failed = false;
    })
    .catch(() => { editsQueue.failed = true; })
    .finally(() => {
      editsQueue.loading = null;
      if (state.utility.activeTab === 'edits-queue') renderUtilityEditsQueue();
    });
  return editsQueue.loading;
}

async function sendEditsQueueChange(url, options, failure) {
  editsQueue.busy = true;
  renderUtilityEditsQueue();
  try {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.detail || failure);
    return payload;
  } catch (error) {
    showToast(error?.message || failure, 'error', 3200);
    return null;
  } finally {
    editsQueue.busy = false;
  }
}

async function setEditsQueueAutoSubmit(on) {
  const payload = await sendEditsQueueChange('/api/musicbrainz/corrections/settings',
    { method: 'PUT', body: JSON.stringify({ auto_submit_bulks: on }) }, 'Auto submit bulks could not be saved.');
  if (payload?.settings) editsQueue.settings = payload.settings;
  renderUtilityEditsQueue();
}

async function removeEditsQueueEntry(kind, id) {
  const url = kind === 'lookup' ? `/api/musicbrainz/lookups/${encodeURIComponent(id)}`
    : `/api/musicbrainz/corrections/queue/${encodeURIComponent(id)}`;
  const albumKey = kind === 'correction'
    ? (editsQueue.corrections || []).find((entry) => String(entry.entry_id) === String(id))?.album_key : null;
  const removed = await sendEditsQueueChange(url, { method: 'DELETE' }, 'The entry could not be removed.');
  if (removed && kind === 'lookup' && typeof refreshMusicBrainzLookupNotifications === 'function') {
    void refreshMusicBrainzLookupNotifications({ force: true });
  }
  if (removed && albumKey) {
    // Problematic Files offers "Add to queue" again.
    (state.utility.problematicFiles || []).forEach((item) => {
      if (item?.musicbrainz_correction?.album_key === albumKey) item.musicbrainz_correction.queued_at = null;
    });
  }
  await loadUtilityEditsQueue(true);
}

// Open: an album in album details; an artist at its Problematic Files entry.
function openEditsQueueEntry(kind, id) {
  if (kind === 'correction') {
    const item = (editsQueue.corrections || []).find((entry) => String(entry.entry_id) === String(id));
    if (item) openTrackModal({ key: item.album_key, name: item.album_title, album_artist: item.artist_name, year: item.year, preview_only: true, tracks: [] });
    return;
  }
  const item = (editsQueue.lookups || []).find((entry) => String(entry.request_id) === String(id));
  if (!item) return;
  if (item.target_kind === 'album') {
    openTrackModal({ key: item.album_key, name: item.album_title, album_artist: item.artist_name, year: item.year, preview_only: true, tracks: [] });
  } else if (typeof openMusicBrainzArtistProblem === 'function') {
    void openMusicBrainzArtistProblem(`musicbrainz-artist:${item.local_artist_id}`);
  }
}

function handleMusicBrainzCorrectionEvent(event) {
  const target = event.target;
  const queue = target?.closest?.('[data-queue-musicbrainz-correction]');
  if (queue) {
    event.preventDefault();
    void queueMusicBrainzCorrection(queue.getAttribute('data-queue-musicbrainz-correction'));
    return true;
  }
  if (!target?.closest?.('.edits-queue')) return false;
  const tab = target.closest('[data-edits-queue-tab]');
  if (tab) {
    event.preventDefault();
    editsQueue.tab = tab.getAttribute('data-edits-queue-tab');
    renderUtilityEditsQueue();
    return true;
  }
  const autoSubmit = target.closest('#edits-queue-auto-submit');
  if (autoSubmit) {
    event.preventDefault();
    if (!autoSubmit.disabled) void setEditsQueueAutoSubmit(autoSubmit.getAttribute('aria-checked') !== 'true');
    return true;
  }
  const entry = target.closest('[data-remove-edits-queue-entry], [data-open-edits-queue-entry]');
  if (!entry) return false;
  event.preventDefault();
  const kind = entry.getAttribute('data-edits-queue-kind');
  const id = entry.getAttribute('data-edits-queue-id');
  if (entry.hasAttribute('data-remove-edits-queue-entry')) {
    if (!entry.disabled) void removeEditsQueueEntry(kind, id);
  } else {
    openEditsQueueEntry(kind, id);
  }
  return true;
}
