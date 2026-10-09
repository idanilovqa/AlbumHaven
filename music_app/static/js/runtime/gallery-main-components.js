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

const LIBRARY_SOURCE_MARKERS = Object.freeze({
  hoard: Object.freeze({
    label: 'Hoard',
    drawing: '<path d="M5 22v-7A10 10 0 0 1 15 5h18a10 10 0 0 1 10 10v7H5Zm1 0v19h36V22M5 18h38M13 6v12m22-12v12M13 23v17m22-17v17M8 41v3m32-3v3"/><rect x="19" y="21" width="10" height="13" rx="2"/><path d="M21 21v-3a3 3 0 0 1 6 0v3M24 26v3"/><path d="M9 12h.1M39 12h.1M9 28h.1M39 28h.1M9 35h.1M39 35h.1"/>',
  }),
  new_arrivals: Object.freeze({
    label: 'New Arrivals',
    drawing: '<path d="M17 14a9 9 0 0 1 8-4h11a9 9 0 0 1 9 9v15H27V19a9 9 0 0 0-9-9M27 34h-9M30 34v12m3-12v12M34 15V2h7v4h-7"/><circle cx="16" cy="26" r="11"/><circle cx="16" cy="26" r="3"/><path d="M17 18a8 8 0 0 1 7 7M17 21a5 5 0 0 1 4 4M8 33l-6 5q8 3 16-1"/><path d="m8 5 1.2 3.8L13 10l-3.8 1.2L8 15l-1.2-3.8L3 10l3.8-1.2Z" fill="currentColor" stroke="none"/>',
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
  return normalizeLibrarySourceCategories(categories)
    .filter((category) => LIBRARY_SOURCE_MARKERS[category])
    .map((category) => {
      const marker = LIBRARY_SOURCE_MARKERS[category];
      return `<span class="album-details-source-marker album-details-source-marker--${category}" role="img" aria-label="${marker.label}" title="${marker.label}">${buildLibrarySourceGlyphHtml(category)}</span>`;
    })
    .join('');
}

function buildAlbumSourceMarkersHtml(categories = []) {
  const items = buildAlbumSourceMarkerItemsHtml(categories);
  return items ? `<div class="album-details-source-markers">${items}</div>` : '';
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
  const isSearch = Boolean(String(config.query ?? (typeof state !== 'undefined' ? state.view?.query : '') ?? '').trim());
  const isSingleArtist = config.contextKind === 'single-artist';
  const isArtist = config.contextKind === 'artist' || isSingleArtist;
  const isFamily = config.contextKind === 'family';
  const title = isArtist ? config.artist : (isFamily ? `${config.primaryArtist} family` : 'Gallery');
  const summary = isArtist
    ? galleryMainPlural(config.albumCount, 'album')
    : `${galleryMainPlural(config.artistCount, 'artist')} · ${galleryMainPlural(config.albumCount, 'album')}`;
  const info = isArtist && !isSearch ? `<button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(config.artist || '')}" aria-label="Information about ${escapeHtml(config.artist || '')}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button>` : '';
  return `<div class="gallery-bar__context"><div class="gallery-bar__title"><span data-gallery-context-name>${escapeHtml(title)}</span>${info}<span class="gallery-bar__artist-divider gallery-divider__line" data-gallery-context-artist-divider hidden></span><span class="gallery-bar__artist-total" data-gallery-context-inline-total hidden></span></div><span class="gallery-bar__summary" data-gallery-context-summary>${escapeHtml(summary)}</span></div>
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

function buildGalleryEmptySelectionHtml() {
  return '<div class="gallery-empty-selection" data-gallery-empty-selection role="status">Select at least one artist in Artist Family.</div>';
}

function buildArtistInfoOverlayHtml(config = {}) {
  const image = config.imageUrl ? `<img class="artist-info-overlay__image" src="${escapeHtml(config.imageUrl)}" alt="">` : '<div class="artist-info-overlay__image artist-info-overlay__image--empty" aria-hidden="true">♪</div>';
  const readMore = config.readMoreUrl ? `<a href="${escapeHtml(config.readMoreUrl)}">Read more</a>` : '<button type="button" data-artist-info-read-more>Read more</button>';
  const wikipedia = config.wikipediaUrl ? `<a href="${escapeHtml(config.wikipediaUrl)}" rel="noreferrer">Wikipedia</a>` : '';
  return `<aside class="artist-info-overlay" data-artist-info-overlay role="dialog" aria-label="Information about ${escapeHtml(config.artist || '')}" hidden><header>${image}<div><span>Artist</span><h2>${escapeHtml(config.artist || '')}</h2></div></header><div class="artist-info-overlay__body gallery-scrollbar"><p>${escapeHtml(config.summary || '')}</p><div class="artist-info-overlay__links">${readMore}${wikipedia}</div></div></aside>`;
}

function buildGalleryDividerHtml(config = {}) {
  return `<div class="gallery-divider"><span>${escapeHtml(config.label || 'Family')}</span><span class="gallery-divider__line"></span><span>${escapeHtml(galleryMainPlural(config.albumCount, 'album'))}</span></div>`;
}

function buildFamilyArtistHeaderHtml(config = {}) {
  const info = `<button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(config.infoArtist || config.artist || '')}" aria-label="Information about ${escapeHtml(config.infoArtist || config.artist || '')}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button>`;
  return `<div class="family-artist-header" data-scroll-artist="${escapeHtml(config.artist || '')}" data-gallery-album-count="${Math.max(0, Number(config.albumCount || 0))}"><h2 class="artist-name">${escapeHtml(config.artist || '')}</h2>${info}<span class="gallery-divider__line"></span><span>${escapeHtml(galleryMainPlural(config.albumCount, 'album'))}</span></div>`;
}

function buildGalleryRatingHtml(config = {}) {
  const maximum = Math.max(1, Number(config.maximum || 10));
  const value = Math.max(0, Math.min(maximum, Number(config.value || 0)));
  const points = Array.from({ length: maximum }, (_unused, index) => (index < value
    ? '<span class="star filled">&#9733;</span>'
    : '<span class="star">&#9734;</span>')).join('');
  return `<div class="rating-row" data-rating-value="${value}"><div class="stars" role="img" aria-label="${escapeHtml(config.label || `Rated ${value} out of ${maximum}`)}">${points}</div>${value ? `<div class="rating-text">${value}/${maximum}</div>` : ''}</div>`;
}

function buildGalleryCardInfoHtml(config = {}) {
  const count = Math.max(0, Number(config.trackCount || 0));
  const metadata = [config.artist, config.year].map(value => String(value ?? '').trim()).filter(Boolean).join(' · ');
  const statusHtml = `${String(config.sourceActionsHtml || '')}${String(config.ratingHtml || '')}`;
  const title = config.openAttributes
    ? `<button class="album-open-trigger album-title-button" type="button" ${config.openAttributes}><span data-gallery-metadata-text>${escapeHtml(config.title || '')}</span></button>`
    : escapeHtml(config.title || '');
  return `<div class="album-body gallery-card-info"><h3 class="album-title">${title}</h3><div class="album-meta-row"><div class="album-subtitle"><span data-gallery-metadata-text>${escapeHtml(metadata)}</span></div></div>${statusHtml ? `<div class="gallery-card__status-group">${statusHtml}</div>` : ''}<div class="chip-row"><span class="track-count">${count} track${count === 1 ? '' : 's'}</span><span class="album-length">${escapeHtml(config.lengthDisplay || '')}</span></div></div>`;
}
