function galleryMainPlural(count, singular) {
  const value = Math.max(0, Number(count || 0));
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

function buildGallerySwitchHtml(config = {}) {
  const checked = Boolean(config.checked);
  return `<button class="gallery-switch" id="${escapeHtml(config.id || '')}" type="button" role="switch" aria-checked="${checked ? 'true' : 'false'}"${config.disabled ? ' disabled' : ''}${config.source ? ` data-gallery-source="${escapeHtml(config.source)}"` : ''}>
    <span>${escapeHtml(config.label || '')}</span><span class="gallery-switch__track" aria-hidden="true"><span class="gallery-switch__knob"></span></span>
  </button>`;
}

function buildGalleryInfoGlyphHtml() {
  return '<span class="gallery-info-button__glyph" aria-hidden="true">i</span>';
}

// MusicBrainz stores ISO 3166-1 codes; show the full English country name.
const galleryCountryNames = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function galleryCountryName(country) {
  const value = String(country || '').trim();
  if (!/^[A-Za-z]{2}$/.test(value) || !galleryCountryNames) return value;
  try { return galleryCountryNames.of(value.toUpperCase()) || value; } catch { return value; }
}

// The first item is the highest-voted genre; the server projection is ranked.
// An artist matched under another name shows its MusicBrainz name. Display only: the
// tag changes only through an approved tag edit.
function galleryArtistDisplayName(artist, artistMusicBrainz = null) {
  const credited = String(artistMusicBrainz?.credited_as || '').trim();
  const canonical = String(artistMusicBrainz?.canonical_name || '').trim();
  return credited && canonical ? canonical : String(artist || '');
}

function buildGalleryArtistMetadataHtml(artistMusicBrainz = null) {
  const projection = artistMusicBrainz && typeof artistMusicBrainz === 'object'
    ? artistMusicBrainz
    : {};
  const genres = (Array.isArray(projection.genres) ? projection.genres : [])
    .map((genre) => String(genre || '').trim())
    .filter(Boolean)
    .slice(0, 1);
  const genreHtml = genres.map((genre) => (
    genre === 'Genre unavailable'
      ? '<span class="ui-metadata-pill ui-metadata-pill--genre ui-metadata-pill--genre-unavailable">Genre unavailable</span>'
      : `<span class="ui-metadata-pill ui-metadata-pill--genre">${escapeHtml(genre)}</span>`
  )).join('');
  return genreHtml;
}

function buildGalleryArtistSummaryHtml(albumCount, artistMusicBrainz = null) {
  const country = galleryCountryName(artistMusicBrainz?.country);
  const countryHtml = country
    ? `<span class="gallery-bar__artist-country"><span class="ui-metadata-pill ui-metadata-pill--country">${escapeHtml(country)}</span></span>`
    : '';
  return `${escapeHtml(galleryMainPlural(albumCount, 'album'))}${countryHtml}`;
}

const GALLERY_ARTIST_MUSICBRAINZ_REFRESH_MS = 30000;
const GALLERY_ARTIST_MUSICBRAINZ_IDLE_REFRESH_MS = 300000;
const galleryArtistMusicBrainzStatus = { byArtist: new Map(), signature: '[]', loadedAt: 0, promise: null };

function galleryArtistMusicBrainzStatusKey(artist) {
  return String(artist || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

// Owner-only repair status from the stored review projection; the shared,
// cached Gallery payload never carries it.
function getGalleryArtistMusicBrainzStatus(group = {}) {
  if (group?.artist_musicbrainz_problem || group?.artist_musicbrainz_state) {
    return { problem: group.artist_musicbrainz_problem || null, state: group.artist_musicbrainz_state || '' };
  }
  return galleryArtistMusicBrainzStatus.byArtist.get(galleryArtistMusicBrainzStatusKey(group?.artist)) || { problem: null, state: '' };
}

function refreshGalleryArtistMusicBrainzStatus({ force = false } = {}) {
  if (state.status?.allowed_actions?.['catalogue.enrichment.request'] !== true) {
    galleryArtistMusicBrainzStatus.byArtist.clear();
    galleryArtistMusicBrainzStatus.signature = '[]';
    return Promise.resolve(false);
  }
  if (galleryArtistMusicBrainzStatus.promise) return galleryArtistMusicBrainzStatus.promise;
  // Poll quickly only while a first lookup is pending; otherwise back off.
  const pending = [...galleryArtistMusicBrainzStatus.byArtist.values()].some((value) => value.state === 'pending');
  const interval = pending ? GALLERY_ARTIST_MUSICBRAINZ_REFRESH_MS : GALLERY_ARTIST_MUSICBRAINZ_IDLE_REFRESH_MS;
  if (!force && Date.now() - galleryArtistMusicBrainzStatus.loadedAt < interval) {
    return Promise.resolve(false);
  }
  galleryArtistMusicBrainzStatus.promise = fetch('/api/musicbrainz/artists/status', { headers: { Accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (!Array.isArray(payload?.artists)) return false;
      const next = new Map();
      for (const row of payload.artists) {
        // Keyed by the canonical Gallery artist, so alias-combined groups match.
        const key = galleryArtistMusicBrainzStatusKey(row?.gallery_artist || row?.local_artist_name);
        if (!key || next.get(key)?.problem) continue;
        if (row.unresolved_reason && row.problem_occurrence_id != null) {
          next.set(key, { problem: { occurrence_id: String(row.problem_occurrence_id), label: row.unresolved_reason }, state: '' });
        } else if (row.match_state === 'pending') {
          next.set(key, { problem: null, state: 'pending' });
        }
      }
      const signature = JSON.stringify([...next]);
      if (signature === galleryArtistMusicBrainzStatus.signature) return false;
      const previous = galleryArtistMusicBrainzStatus.byArtist;
      const changed = galleryArtistMusicBrainzStatus.loadedAt > 0
        ? new Set([...previous.keys(), ...next.keys()].filter((key) => (
          JSON.stringify(previous.get(key) || null) !== JSON.stringify(next.get(key) || null)
        )))
        : new Set();
      galleryArtistMusicBrainzStatus.signature = signature;
      galleryArtistMusicBrainzStatus.byArtist = next;
      if (typeof virtualGrid !== 'undefined') virtualGrid?.render?.(true);
      // A finished lookup, re-check or manual match changes the shared Gallery
      // projection (links, pills). Reload the view when it shows such an artist,
      // and only then: a library-wide sync changes many artists every poll.
      const shown = typeof getGalleryMainGroups === 'function' ? getGalleryMainGroups() : [];
      if (changed.size && typeof refreshCurrentViewAfterBackgroundCompletion === 'function'
          && shown.some((group) => changed.has(galleryArtistMusicBrainzStatusKey(group?.artist)))) {
        void refreshCurrentViewAfterBackgroundCompletion().catch(() => {});
      }
      return true;
    })
    .catch(() => false)
    .finally(() => {
      galleryArtistMusicBrainzStatus.loadedAt = Date.now();
      galleryArtistMusicBrainzStatus.promise = null;
    });
  return galleryArtistMusicBrainzStatus.promise;
}

function buildGalleryArtistStatusHtml(config = {}) {
  const problem = config.artistMusicBrainzProblem;
  if (problem?.occurrence_id && problem?.label) {
    return buildSmallAlertHtml({
      severity: 'warning',
      message: problem.label,
      interactive: true,
      attributes: {
        'data-open-musicbrainz-artist-problem': problem.occurrence_id,
        'aria-label': `Open ${problem.label} for ${config.artist || 'artist'}`,
      },
    });
  }
  if (String(config.artistMusicBrainzState || '').trim().toLowerCase() === 'pending') {
    return '<span class="artist-musicbrainz-pending" role="status" aria-label="Metadata pending">Metadata pending<span aria-hidden="true"><span data-pending-dot>.</span><span data-pending-dot>.</span><span data-pending-dot>.</span></span></span>';
  }
  return '';
}

const LIBRARY_SOURCE_MARKERS = Object.freeze({
  hoard: Object.freeze({
    label: 'Hoard',
    drawing: '<path d="M6 23v-7A10 10 0 0 1 16 6h16a10 10 0 0 1 10 10v7M6 23v18h36V23M6 23h15m6 0h15"/><rect x="21" y="19" width="6" height="11" rx="1"/>',
  }),
  new_arrivals: Object.freeze({
    label: 'New Arrivals',
    drawing: '<path d="M8 30V18A10 10 0 0 1 18 8h16a10 10 0 0 1 10 10v12H8ZM18 8a10 10 0 0 1 10 10v12M8 30 3 40h20l5-10M34 30v14M36 18V3h8v8h-8"/>',
  }),
});

function normalizeLibrarySourceCategories(categories = []) {
  const values = Array.isArray(categories) ? categories : [];
  const normalized = new Set(values.map((value) => {
    const category = String(value || '').trim().toLowerCase();
    return category === 'main_library' ? 'main' : category;
  }));
  return ['main', 'hoard', 'new_arrivals'].filter((category) => normalized.has(category));
}

function resolveAlbumSourceMarkerCategories(album = {}) {
  const provenance = Array.isArray(album?.root_provenance?.categories)
    ? album.root_provenance.categories
    : [];
  return normalizeLibrarySourceCategories(provenance.length
    ? provenance
    : [album?.library_root_category || album?.source || 'main_library']);
}

function buildLibrarySourceGlyphHtml(category) {
  const marker = LIBRARY_SOURCE_MARKERS[String(category || '')];
  return marker
    ? `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">${marker.drawing}</svg>`
    : '';
}

function buildAlbumSourceMarkerItemsHtml(categories = []) {
  // INT-040: on mobile the sources are colorful icon badges on the album art, never printed names.
  const presentation = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout() ? 'badge' : '';
  return normalizeLibrarySourceCategories(categories)
    .filter((category) => LIBRARY_SOURCE_MARKERS[category])
    .map((category) => {
      const marker = LIBRARY_SOURCE_MARKERS[category];
      return buildSmallAlertHtml({
        severity: 'info',
        tone: category,
        message: marker.label,
        iconHtml: buildLibrarySourceGlyphHtml(category),
        className: `album-details-source-marker album-details-source-marker--${category}`,
        focusable: true,
        presentation,
      });
    })
    .join('');
}

function buildAlbumCoverSourceMarkersHtml(album = {}) {
  const items = buildAlbumSourceMarkerItemsHtml(resolveAlbumSourceMarkerCategories(album));
  return items
    ? `<div class="album-details-source-markers album-details-cover-source-markers">${items}</div>`
    : '';
}

function buildFilterPillHtml(config = {}) {
  const label = String(config.label || '');
  const selected = Boolean(config.selected);
  const partClass = (part) => {
    const extra = String(config.partClasses?.[part] || '').trim();
    return `ui-filter-pill__${part}${extra ? ` ${escapeHtml(extra)}` : ''}`;
  };
  const dataAttributes = Object.entries(config.dataAttributes || {})
    .filter(([name]) => /^[a-z][a-z0-9-]*$/u.test(name))
    .map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`)
    .join('');
  const artwork = String(config.artworkHtml || '');
  const count = config.count === undefined || config.count === null
    ? '' : `<span class="${partClass('count')}">${escapeHtml(config.count)}</span>`;
  return `<button class="ui-filter-pill${config.className ? ` ${escapeHtml(config.className)}` : ''}${selected ? ' is-active' : ''}${config.modifierClassName ? ` ${escapeHtml(config.modifierClassName)}` : ''}" type="button" title="${escapeHtml(config.title || label)}" aria-label="${escapeHtml(config.ariaLabel || label)}" aria-pressed="${selected ? 'true' : 'false'}"${dataAttributes}${config.draggable === false ? ' draggable="false"' : ''}><span class="${partClass('marker')}" aria-hidden="true"></span>${artwork ? `<span class="${partClass('artwork')}" aria-hidden="true">${artwork}</span>` : ''}<span class="${partClass('label')}">${escapeHtml(label)}</span>${count}</button>`;
}

function buildGalleryBarHtml(config = {}) {
  const isSingleArtist = config.contextKind === 'single-artist';
  const isArtist = config.contextKind === 'artist' || isSingleArtist;
  const isFamily = config.contextKind === 'family';
  const title = isArtist
    ? galleryArtistDisplayName(config.artist, config.artist_musicbrainz)
    : (isFamily ? `${config.primaryArtist} family` : 'Gallery');
  const summary = isArtist
    ? galleryMainPlural(config.albumCount, 'album')
    : `${galleryMainPlural(config.artistCount, 'artist')} · ${galleryMainPlural(config.albumCount, 'album')}`;
  const info = isArtist ? `<button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(config.artist || '')}" aria-label="Information about ${escapeHtml(config.artist || '')}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button>` : '';
  const pills = isArtist ? buildGalleryArtistMetadataHtml(config.artist_musicbrainz) : '';
  const summaryHtml = isArtist ? buildGalleryArtistSummaryHtml(config.albumCount, config.artist_musicbrainz) : escapeHtml(summary);
  return `<div class="gallery-bar__context"><div class="gallery-bar__title"><span data-gallery-context-name>${escapeHtml(title)}</span>${info}<span class="gallery-bar__artist-metadata" data-gallery-context-metadata${isArtist ? '' : ' hidden'}>${pills}</span><span class="gallery-bar__artist-divider gallery-divider__line" data-gallery-context-artist-divider hidden></span><span class="gallery-bar__artist-total" data-gallery-context-inline-total hidden></span></div><span class="gallery-bar__summary" data-gallery-context-summary>${summaryHtml}</span></div>
    <div class="gallery-bar__actions">
      <button class="gallery-action-button" type="button" data-gallery-bar-action="artist-family" aria-label="Artist Family" aria-controls="artist-family-panel" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c.5-3.5 2.2-5.2 5-5.2s4.5 1.7 5 5.2M14 14.5c3.5-.8 5.8.8 6.5 4.5"/></svg></button>
      <div class="gallery-view-cluster unfolding-action-button" id="gallery-view-cluster-options" data-gallery-view-cluster><button class="gallery-view-choice action-button unfolding-action-button__action" type="button" tabindex="-1" data-gallery-view-choice="list" aria-label="Rows" title="Rows"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M9 3v7M9 14v7"/></svg></button><button class="gallery-view-choice action-button unfolding-action-button__action" type="button" tabindex="-1" data-gallery-view-choice="covers" aria-label="No info" title="No info"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m5 17 5-5 3 3 2-2 4 4"/></svg></button><button class="gallery-view-choice action-button unfolding-action-button__action is-active" type="button" data-gallery-bar-action="view" data-gallery-view-choice="cards" aria-label="Cards" title="Cards" aria-controls="gallery-view-cluster-options" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18M7 18h6"/></svg></button></div>
      <button class="gallery-action-button" type="button" data-gallery-bar-action="album-types" aria-label="Album types" aria-controls="gallery-album-types-menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 1.5-1.94l8-2A2 2 0 0 1 14 4v1"/><path d="M8 20H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"/><rect x="8" y="8" width="14" height="14" rx="2"/><path fill="currentColor" fill-rule="evenodd" stroke="none" d="M19 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-3 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0Z"/></svg></button>
    </div>`;
}

function buildArtistFamilyPanelHtml(config = {}) {
  const combineSwitch = buildGallerySwitchHtml({
    id: 'artist-family-combine-similar',
    label: 'Combine similar artists',
    checked: Boolean(config.combineSimilarArtists),
  }).replace('<button ', '<button data-toggle-combine-similar-artists="1" ');
  return `<aside class="artist-family-panel" data-artist-family-panel aria-label="${escapeHtml(config.title || 'Artist Family')}" aria-hidden="true" hidden><header><div class="artist-family-panel__heading"><div class="artist-family-panel__title-row"><h2 data-gallery-family-panel-title title="${escapeHtml(config.title || 'Artist Family')}">${escapeHtml(config.title || 'Artist Family')}</h2><span aria-hidden="true">•</span><span data-gallery-family-panel-total>${escapeHtml(config.albumTotal || '')}</span></div><p>Select or unselect an artist to update Gallery.</p></div></header><div class="artist-family-panel__combine-row">${combineSwitch}</div><div class="artist-family-panel__body gallery-scrollbar">${String(config.bodyHtml || '')}</div></aside>`;
}

function buildGalleryEmptySelectionHtml(message = 'Select at least one artist in Artist Family.') {
  return `<div class="gallery-empty-selection" data-gallery-empty-selection role="status">${escapeHtml(message)}</div>`;
}

function buildGalleryDividerHtml(config = {}) {
  return `<div class="gallery-divider"><span>${escapeHtml(config.label || 'Family')}</span><span class="gallery-divider__line"></span><span>${escapeHtml(galleryMainPlural(config.albumCount, 'album'))}</span></div>`;
}

function buildFamilyArtistHeaderHtml(config = {}) {
  const status = buildGalleryArtistStatusHtml(config);
  const info = `<button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(config.infoArtist || config.artist || '')}" aria-label="Information about ${escapeHtml(config.infoArtist || config.artist || '')}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button>`;
  return `<div class="family-artist-header" data-scroll-artist="${escapeHtml(config.artist || '')}" data-gallery-album-count="${Math.max(0, Number(config.albumCount || 0))}"><h2 class="artist-name">${escapeHtml(config.artist || '')}</h2>${info}<span class="artist-musicbrainz-status">${status}</span><span class="gallery-divider__line"></span><span>${escapeHtml(galleryMainPlural(config.albumCount, 'album'))}</span></div>`;
}

function buildGalleryRatingHtml(config = {}) {
  const maximum = Math.max(1, Number(config.maximum || 10));
  const value = Math.max(0, Math.min(maximum, Number(config.value || 0)));
  const points = Array.from({ length: maximum }, (_unused, index) => (index < value
    ? '<span class="star filled">&#9733;</span>'
    : '<span class="star">&#9734;</span>')).join('');
  const className = ['rating-row', config.className].filter(Boolean).join(' ');
  return `<div class="${escapeHtml(className)}" data-rating-value="${value}"><div class="stars" role="img" aria-label="${escapeHtml(config.label || `Rated ${value} out of ${maximum}`)}">${points}</div>${value ? `<div class="rating-text">${value}/${maximum}</div>` : ''}</div>`;
}

function buildGalleryCardInfoHtml(config = {}) {
  const count = Math.max(0, Number(config.trackCount || 0));
  const artist = String(config.artist ?? '').trim();
  const year = String(config.year ?? '').trim();
  const metadata = `${artist ? `<span class="gallery-card__artist"><span data-gallery-metadata-text>${escapeHtml(artist)}</span></span>` : ''}${year ? `<span class="gallery-card__year">${artist ? '· ' : ''}${escapeHtml(year)}</span>` : ''}`;
  const statusHtml = `${String(config.sourceActionsHtml || '')}${String(config.ratingHtml || '')}`;
  const title = config.openAttributes
    ? `<button class="album-open-trigger album-title-button" type="button" aria-label="${escapeHtml(config.title || '')}" ${config.openAttributes}><span data-gallery-metadata-text>${escapeHtml(config.title || '')}</span></button>`
    : escapeHtml(config.title || '');
  return `<div class="album-body gallery-card-info"><h3 class="album-title">${title}</h3><div class="album-meta-row"><div class="album-subtitle gallery-card__metadata">${metadata}</div></div>${statusHtml ? `<div class="gallery-card__status-group">${statusHtml}</div>` : ''}<div class="chip-row"><span class="track-count">${count} track${count === 1 ? '' : 's'}</span><span class="album-length">${escapeHtml(config.lengthDisplay || '')}</span></div></div>`;
}
