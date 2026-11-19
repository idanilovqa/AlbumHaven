// MusicBrainz data corrections and Settings → Edits Queue (Delivery 2, S4; owner 2026-11-16,
// "Data Correction flow"). Problematic Files shows an album's "Data Correction Needed" label and
// its changes. Trivial ones apply to the display automatically ("Applied automatically", Undo per
// album); the rest wait for approval. Display only: nothing here writes tags (Bulk Correction, PR 53).
const MUSICBRAINZ_DATA_CORRECTION_LABEL = 'Data Correction Needed';
const EDITS_QUEUE_TABS = { 'data-correction': 'Data Correction', 'musicbrainz-lookup': 'MusicBrainz Look Up' };
const editsQueue = { tab: 'data-correction', section: 'applied', kinds: null, pages: {}, openKind: null,
  settings: null, lookups: null, queueStartsAt: null, loading: null, failed: false, lookupsFailed: false, busy: false };

// Owner 2026-11-16: albums listed only for a correction show only under the "Data Correction
// Needed" filter; true shows them by default.
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
// Paging waits for the complete Problematic Files list: its first bounded page is replaced
// moments later, and rows appended to it would be dropped and fetched again.
const MUSICBRAINZ_CORRECTION_PAGE_SIZE = 100;
const MUSICBRAINZ_CORRECTION_PAGE_AHEAD = 20;
const musicBrainzCorrectionPages = { keys: new Set(), nextOffset: 0, loading: null };

function syncMusicBrainzCorrectionRows() {
  if (state.utility.problematicFilesComplete !== true) return;
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
  if (pages.loading || pages.nextOffset === null || state.utility.problematicFilesComplete !== true
      || !musicBrainzCorrectionRowsWanted() || !(Number(state.utility.musicBrainzCorrectionAlbumCount) > 0)) {
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

// Owner 2026-11-16, "Data Correction flow": the kinds, how they are named, and which are
// approved per album only (artist changes, and albums sent to review whole).
const MUSICBRAINZ_CORRECTION_KINDS = Object.freeze({
  case: 'Case only', spacing: 'Spacing only', case_spacing: 'Case and spacing', punctuation: 'Punctuation and symbols',
  accents: 'Accents', small_edit: 'Small edit (2 letters or fewer)', edition_suffix: 'Edition or version suffix',
  track_title: 'Track title: substantial change', album_title: 'Album title: substantial change',
  track_artist_renamed: 'Track artist: a different name', track_artist_joined: 'Track artist: featured or joined credit',
  album_artist_renamed: 'Album artist: a different name', album_artist_joined: 'Album artist: featured or joined credit',
  whole_album: 'Whole albums to review',
});
const MUSICBRAINZ_PER_ALBUM_ONLY = new Set(['track_artist_renamed', 'track_artist_joined', 'album_artist_renamed',
  'album_artist_joined', 'whole_album']);
const MUSICBRAINZ_ROW_STATES = Object.freeze({
  applied: 'Applied', undone: 'Undone', pending: 'Waiting for approval', skipped: 'Skipped' });

function describeMusicBrainzCorrection(correction) {
  const auto = Number(correction.auto_count || 0);
  const review = Number(correction.review_count || 0);
  if (correction.review_whole) {
    return 'Many titles differ from MusicBrainz, so nothing was applied automatically: review the whole album in Settings → Edits Queue.';
  }
  return [
    auto ? `${auto} change${auto === 1 ? ' was' : 's were'} applied automatically (display only; your files are unchanged).` : '',
    review ? `${review} change${review === 1 ? ' waits' : 's wait'} for your approval in Settings → Edits Queue.` : '',
  ].filter(Boolean).join(' ');
}

function buildMusicBrainzCorrectionTableHtml(rows, id = 'musicbrainz-data-correction') {
  return buildUtilityCompactTable({
    id,
    ariaLabel: 'Data correction',
    columns: 'minmax(140px,.8fr) minmax(160px,1fr) minmax(160px,1fr) minmax(110px,.6fr)',
    columnsConfig: [
      { key: 'tag', label: 'Tag' }, { key: 'now', label: 'In your files' }, { key: 'mb', label: 'MusicBrainz' },
      { key: 'state', label: 'Status' },
    ],
    headers: 'visible', density: 'compact', overflow: 'local', mobile: 'stack', frame: 'outline', selection: 'none',
    rows: rows.map((row, index) => ({
      key: `${row.field}-${row.disc_number}-${row.track_number}-${index}`,
      cells: {
        tag: escapeHtml(row.label),
        now: escapeHtml(row.current_value),
        mb: buildAlertLabelHtml({ severity: 'info', message: row.proposed_value }),
        state: escapeHtml(MUSICBRAINZ_ROW_STATES[row.state] || ''),
      },
    })),
  });
}

// The label, what happened, and the rows. Problematic Files has no action of its own: changes
// apply automatically or wait in Settings → Edits Queue (no "Add to queue").
function buildMusicBrainzCorrectionHtml(album, { heading = false } = {}) {
  const correction = album.musicbrainz_correction;
  const rows = Array.isArray(correction?.corrections) ? correction.corrections : [];
  if (!rows.length) return '';
  const summary = { ...correction, auto_count: rows.filter((row) => row.mode === 'auto').length,
    review_count: rows.filter((row) => row.mode === 'review').length };
  return `<div class="utility-album-problem-labels">${buildAlertLabelHtml({ severity: 'warning', message: MUSICBRAINZ_DATA_CORRECTION_LABEL })}</div>
    ${heading ? '<h4 class="utility-detail-section-title">Detected problems</h4>' : ''}
    <p class="utility-detail-meta">${escapeHtml(describeMusicBrainzCorrection(summary))}</p>
    <div class="utility-detected-table">${buildMusicBrainzCorrectionTableHtml(rows)}</div>`;
}

// An album listed only because it needs a correction: the row's facts, then its stored rows,
// loaded when it is opened.
function buildMusicBrainzCorrectionProblemDetail(item) {
  if (item.musicbrainz_correction_failed) {
    return buildOnPageAlertHtml({ severity: 'error', title: 'Album details unavailable', message: 'Unable to load this data correction.' });
  }
  if (!Array.isArray(item.musicbrainz_correction?.corrections)) {
    return '<div class="utility-empty-state">Loading the data correction…</div>';
  }
  const title = String(item.name || 'Unknown Album');
  return `<div class="utility-detail-header">
      <div class="utility-detail-cover">${buildUtilityAlbumArtbox(item, { label: `Album cover for ${title}` })}</div>
      <div class="utility-detail-summary">
        <h3 class="utility-detail-title">${escapeHtml(title)}</h3>
        <div class="utility-detail-meta">${escapeHtml(item.album_artist || 'Unknown Artist')}</div>
        <div class="utility-detail-meta">Year: ${escapeHtml(item.year ?? 'Unknown')}</div>
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
    Object.assign(item, { musicbrainz_correction: { ...item.musicbrainz_correction, ...payload.correction },
      musicbrainz_correction_failed: false });
  } catch {
    item.musicbrainz_correction_failed = true;
  } finally {
    item.musicbrainz_correction_loading = false;
  }
  if (state.utility.activeTab === 'problematic-files') renderProblematicFiles({ preserveProblematicTree: true });
}

function formatEditsQueueTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? `today ${time}` : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// The album-versions list (E1/E2): cover, name and one line, then the entry's own actions.
function buildEditsQueueEntryHtml({ title, subtitle, album = null, attributes = {}, actionsHtml = '', bodyHtml = '' }) {
  // Responses name covers by reference (cover_ref), never by path.
  const cover = album?.cover_ref
    ? buildUtilityAlbumArtbox(album, { label: `Artwork for ${title}` })
    : '<span class="version-picker-option-cover-placeholder">No cover</span>';
  return `<div class="version-picker-option edits-queue-entry" ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ')}>
    <span class="version-picker-option-cover">${cover}</span>
    <span class="version-picker-option-meta">
      <span class="version-picker-option-name">${escapeHtml(title)}</span>
      <span class="version-picker-option-subtitle">${escapeHtml(subtitle)}</span>
      ${bodyHtml}
    </span>
    <span class="version-picker-option-actions">${actionsHtml}</span>
  </div>`;
}

function buildEditsQueueAlbumHtml(album, section, kind) {
  const busy = editsQueue.busy || !canReviewMusicBrainzCorrections();
  const button = (action, label, variant = 'secondary') => ButtonComponent.renderButton({
    label, variant, size: 'small', disabled: busy,
    attributes: { 'data-edits-queue-album-action': action, 'data-edits-queue-album': album.album_key } });
  const applied = album.rows.some((row) => row.state === 'applied');
  const actions = section === 'applied'
    ? (applied ? button('undo', 'Undo') : '')
    : `${button('approve', 'Approve', 'primary')}${button('skip', 'Skip')}`;
  return buildEditsQueueEntryHtml({
    title: album.album_title || 'Unknown Album', album,
    subtitle: [album.artist_name, album.year].filter(Boolean).join(' · '),
    attributes: { 'data-edits-queue-album-row': album.album_key },
    actionsHtml: actions,
    bodyHtml: buildMusicBrainzCorrectionTableHtml(album.rows, `edits-queue-${section}-${kind}-${album.album_key}`),
  });
}

function buildEditsQueueKindHtml(section, group) {
  const open = editsQueue.openKind === group.kind;
  const page = editsQueue.pages[`${section}:${group.kind}`];
  const approveKind = section === 'review' && !MUSICBRAINZ_PER_ALBUM_ONLY.has(group.kind) && canReviewMusicBrainzCorrections()
    ? ButtonComponent.renderButton({ label: 'Approve kind', variant: 'primary', size: 'small', disabled: editsQueue.busy,
      attributes: { 'data-edits-queue-approve-kind': group.kind } }) : '';
  const albums = open && page
    ? `<div class="version-picker-list">${page.albums.map((album) => buildEditsQueueAlbumHtml(album, section, group.kind)).join('')}</div>
      ${page.nextOffset !== null ? ButtonComponent.renderButton({ label: 'Show more', disabled: editsQueue.busy,
    attributes: { 'data-edits-queue-more': group.kind } }) : ''}`
    : open ? '<div class="utility-empty-state">Loading…</div>' : '';
  return `<section class="edits-queue-kind" data-edits-queue-kind-group="${escapeHtml(group.kind)}">
    <div class="edits-queue-kind-heading">
      ${ButtonComponent.renderButton({ label: `${MUSICBRAINZ_CORRECTION_KINDS[group.kind] || group.kind} · ${group.albums} album${group.albums === 1 ? '' : 's'}, ${group.rows} change${group.rows === 1 ? '' : 's'}`,
    quiet: true, attributes: { 'data-edits-queue-open-kind': group.kind, 'aria-expanded': String(open) } })}
      ${approveKind}
    </div>
    ${albums}
  </section>`;
}

function buildEditsQueueCorrectionsHtml() {
  const settings = editsQueue.settings || {};
  const nextRun = settings.auto_submit_bulks ? formatEditsQueueTime(settings.next_run_at) : '';
  const section = editsQueue.section;
  const groups = editsQueue.kinds || [];
  const sections = `<div class="in-page-tabs edits-queue-sections" role="tablist" aria-label="Data Correction">${[
    ['applied', 'Applied automatically'], ['review', 'Waiting for approval']]
    .map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === section}" data-edits-queue-section="${key}">${label}</button>`).join('')}</div>`;
  const intro = section === 'applied'
    ? 'Trivial changes (case, spacing, punctuation, accents, small typos) are shown in place of your tags automatically. Your files are unchanged until Bulk Correction writes them. Undo an album to show its tags again.'
    : 'These changes wait for you. Approve a whole kind, or approve or skip album by album; artist changes are approved per album only.';
  return `${sections}<p class="utility-detail-meta">${escapeHtml(intro)}</p>
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
    ${groups.length ? groups.map((group) => buildEditsQueueKindHtml(section, group)).join('')
    : `<div class="utility-empty-state">${section === 'applied' ? 'Nothing has been applied automatically.' : 'Nothing is waiting for approval.'}</div>`}`;
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
    const title = (album ? item.album_title : item.artist_name) || 'Unknown';
    const entry = { 'data-edits-queue-lookup': String(item.request_id) };
    return buildEditsQueueEntryHtml({
      title, album: cover, subtitle: `${facts.filter(Boolean).join(' · ')} — ${when}`,
      attributes: { ...entry, 'data-open-edits-queue-lookup': '1' },
      actionsHtml: `${ButtonComponent.renderActionButton({ ariaLabel: `Open ${title}`, title: 'Open', icon: 'external',
        presentation: 'bare', attributes: { ...entry, 'data-open-edits-queue-lookup': '1' } })}
        ${ButtonComponent.renderActionButton({ ariaLabel: `Remove ${title} from the queue`, title: 'Remove from queue',
        icon: 'delete', semantic: 'destructive', disabled: editsQueue.busy,
        attributes: { ...entry, 'data-remove-edits-queue-lookup': '1' } })}`,
    });
  }).join('')}</div>`;
}

function buildEditsQueueHtml() {
  const tabs = `<div class="in-page-tabs" role="tablist" aria-label="Edits Queue">${Object.entries(EDITS_QUEUE_TABS)
    .map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === editsQueue.tab}" data-edits-queue-tab="${key}">${escapeHtml(label)}</button>`)
    .join('')}</div>`;
  // Each tab stands alone: MusicBrainz look ups need the enrichment service, data corrections do not.
  const corrections = editsQueue.tab === 'data-correction';
  let body;
  if (corrections ? editsQueue.failed : editsQueue.lookupsFailed) {
    body = buildOnPageAlertHtml({ severity: 'error', title: 'Edits Queue unavailable', message: 'Unable to load the Edits Queue. Try again shortly.' });
  } else if (!(corrections ? editsQueue.kinds : editsQueue.lookups)) {
    body = '<div class="utility-empty-state">Loading the Edits Queue…</div>';
  } else {
    body = corrections ? buildEditsQueueCorrectionsHtml() : buildEditsQueueLookupsHtml();
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

const readEditsQueueJson = (url) => fetch(url, { headers: { Accept: 'application/json' } }).then(async (response) => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.detail || 'Unavailable');
  return payload;
});

async function loadUtilityEditsQueue(force = false) {
  if (editsQueue.loading) return editsQueue.loading;
  if (!force && editsQueue.kinds && editsQueue.lookups) {
    renderUtilityEditsQueue();
    return null;
  }
  renderUtilityEditsQueue();
  editsQueue.loading = Promise.allSettled([
    readEditsQueueJson(`/api/musicbrainz/corrections/edits?section=${editsQueue.section}`),
    readEditsQueueJson('/api/musicbrainz/lookups'),
  ])
    .then(([queue, lookups]) => {
      editsQueue.failed = queue.status === 'rejected';
      if (!editsQueue.failed) {
        editsQueue.kinds = Array.isArray(queue.value.kinds) ? queue.value.kinds : [];
        editsQueue.settings = queue.value.settings || {};
        editsQueue.pages = {};
      }
      editsQueue.lookupsFailed = lookups.status === 'rejected';
      if (!editsQueue.lookupsFailed) {
        editsQueue.lookups = Array.isArray(lookups.value.queued) ? lookups.value.queued : [];
        editsQueue.queueStartsAt = lookups.value.queue_starts_at || null;
      }
    })
    .finally(() => {
      editsQueue.loading = null;
      if (state.utility.activeTab === 'edits-queue') renderUtilityEditsQueue();
    });
  const loading = editsQueue.loading;
  await loading;
  if (editsQueue.openKind && editsQueue.kinds?.some((group) => group.kind === editsQueue.openKind)) {
    await loadEditsQueueKindPage(editsQueue.openKind);
  }
  return loading;
}

const EDITS_QUEUE_PAGE_SIZE = 50;

async function loadEditsQueueKindPage(kind, { more = false } = {}) {
  const key = `${editsQueue.section}:${kind}`;
  const previous = more ? editsQueue.pages[key] : null;
  const offset = previous?.nextOffset ?? 0;
  try {
    const payload = await readEditsQueueJson(`/api/musicbrainz/corrections/edits/${encodeURIComponent(kind)}?section=${editsQueue.section}&offset=${offset}&limit=${EDITS_QUEUE_PAGE_SIZE}`);
    editsQueue.pages[key] = { albums: [...(previous?.albums || []), ...(payload.albums || [])],
      nextOffset: payload.next_offset ?? null };
  } catch (error) {
    showToast(error?.message || 'Unable to load these changes.', 'error', 3200);
  }
  if (state.utility.activeTab === 'edits-queue') renderUtilityEditsQueue();
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

// Undo, approve or skip one album; approve a whole kind (never artist kinds). Remembered.
async function decideEditsQueueAlbum(action, albumKey) {
  const done = await sendEditsQueueChange(`/api/musicbrainz/corrections/albums/${action}`,
    { method: 'POST', body: JSON.stringify({ album_key: albumKey }) }, 'The change could not be saved.');
  if (done) showToast({ undo: 'Undone: the tags show again.', approve: 'Approved.', skip: 'Skipped.' }[action], 'info', 2400);
  await loadUtilityEditsQueue(true);
}

async function approveEditsQueueKind(kind) {
  if (MUSICBRAINZ_PER_ALBUM_ONLY.has(kind)) return;
  const done = await sendEditsQueueChange(`/api/musicbrainz/corrections/kinds/${encodeURIComponent(kind)}/approve`,
    { method: 'POST', body: '{}' }, 'The kind could not be approved.');
  if (done) showToast(`Approved ${done.decided} change${done.decided === 1 ? '' : 's'}.`, 'info', 2400);
  await loadUtilityEditsQueue(true);
}

async function removeEditsQueueLookup(id) {
  const removed = await sendEditsQueueChange(`/api/musicbrainz/lookups/${encodeURIComponent(id)}`,
    { method: 'DELETE' }, 'The entry could not be removed.');
  if (removed && typeof refreshMusicBrainzLookupNotifications === 'function') {
    void refreshMusicBrainzLookupNotifications({ force: true });
  }
  await loadUtilityEditsQueue(true);
}

// Open: an album in album details; an artist at its Problematic Files entry.
function openEditsQueueLookup(id) {
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
  if (!target?.closest?.('.edits-queue')) return false;
  const control = (selector) => target.closest(selector);
  const actions = [
    ['[data-edits-queue-tab]', (node) => { editsQueue.tab = node.getAttribute('data-edits-queue-tab'); renderUtilityEditsQueue(); }],
    ['[data-edits-queue-section]', (node) => {
      editsQueue.section = node.getAttribute('data-edits-queue-section');
      editsQueue.openKind = null;
      void loadUtilityEditsQueue(true);
    }],
    ['#edits-queue-auto-submit', (node) => { if (!node.disabled) void setEditsQueueAutoSubmit(node.getAttribute('aria-checked') !== 'true'); }],
    ['[data-edits-queue-open-kind]', (node) => {
      const kind = node.getAttribute('data-edits-queue-open-kind');
      editsQueue.openKind = editsQueue.openKind === kind ? null : kind;
      renderUtilityEditsQueue();
      if (editsQueue.openKind) void loadEditsQueueKindPage(kind);
    }],
    ['[data-edits-queue-more]', (node) => { void loadEditsQueueKindPage(node.getAttribute('data-edits-queue-more'), { more: true }); }],
    ['[data-edits-queue-approve-kind]', (node) => { void approveEditsQueueKind(node.getAttribute('data-edits-queue-approve-kind')); }],
    ['[data-edits-queue-album-action]', (node) => {
      void decideEditsQueueAlbum(node.getAttribute('data-edits-queue-album-action'), node.getAttribute('data-edits-queue-album'));
    }],
    ['[data-remove-edits-queue-lookup]', (node) => { if (!node.disabled) void removeEditsQueueLookup(node.getAttribute('data-edits-queue-lookup')); }],
    ['[data-open-edits-queue-lookup]', (node) => openEditsQueueLookup(node.getAttribute('data-edits-queue-lookup'))],
  ];
  for (const [selector, run] of actions) {
    const node = control(selector);
    if (node) {
      event.preventDefault();
      run(node);
      return true;
    }
  }
  return false;
}
