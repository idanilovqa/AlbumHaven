function galleryMainPlural(count, singular) {
  const value = Math.max(0, Number(count || 0));
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

function buildGallerySwitchHtml(config = {}) {
  const checked = Boolean(config.checked);
  return `<button class="gallery-switch" id="${escapeHtml(config.id || '')}" type="button" role="switch" aria-checked="${checked ? 'true' : 'false'}"${config.source ? ` data-gallery-source="${escapeHtml(config.source)}"` : ''}>
    <span>${escapeHtml(config.label || '')}</span><span class="gallery-switch__track" aria-hidden="true"><span class="gallery-switch__knob"></span></span>
  </button>`;
}

function buildGalleryInfoGlyphHtml() {
  return '<span class="gallery-info-button__glyph" aria-hidden="true">i</span>';
}

function buildGalleryBarHtml(config = {}) {
  const isArtist = config.contextKind === 'artist';
  const isFamily = config.contextKind === 'family';
  const title = isArtist ? config.artist : (isFamily ? `${config.primaryArtist} family` : 'Gallery');
  const summary = isArtist
    ? galleryMainPlural(config.albumCount, 'album')
    : `${galleryMainPlural(config.artistCount, 'artist')} · ${galleryMainPlural(config.albumCount, 'album')}`;
  const info = isArtist ? `<button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(config.artist || '')}" aria-label="Information about ${escapeHtml(config.artist || '')}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button>` : '';
  return `<div class="gallery-bar__context"><div class="gallery-bar__title"><span data-gallery-context-name>${escapeHtml(title)}</span>${info}</div><span class="gallery-bar__summary" data-gallery-context-summary>${escapeHtml(summary)}</span></div>
    <div class="gallery-bar__actions">
      <button class="gallery-action-button" type="button" data-gallery-bar-action="artist-family" aria-label="Artist Family" aria-controls="artist-family-panel" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c.5-3.5 2.2-5.2 5-5.2s4.5 1.7 5 5.2M14 14.5c3.5-.8 5.8.8 6.5 4.5"/></svg></button>
      <div class="gallery-view-cluster unfolding-action-button" id="gallery-view-cluster-options" data-gallery-view-cluster><button class="gallery-view-choice action-button unfolding-action-button__action" type="button" tabindex="-1" data-gallery-view-choice="covers" aria-label="No info" title="No info"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m5 17 5-5 3 3 2-2 4 4"/></svg></button><button class="gallery-view-choice action-button unfolding-action-button__action is-active" type="button" data-gallery-bar-action="view" data-gallery-view-choice="cards" aria-label="Cards" title="Cards" aria-controls="gallery-view-cluster-options" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18M7 18h6"/></svg></button></div>
      <button class="gallery-action-button" type="button" data-gallery-bar-action="album-types" aria-label="Album types" aria-controls="gallery-album-types-menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1"/><path d="M14 6h7M14 10h7M4 17h17M4 21h12"/></svg></button>
    </div>`;
}

function buildArtistFamilyPanelHtml(config = {}) {
  const combineSwitch = buildGallerySwitchHtml({
    id: 'artist-family-combine-similar',
    label: 'Combine similar artists',
    checked: Boolean(config.combineSimilarArtists),
  }).replace('<button ', '<button data-toggle-combine-similar-artists="1" ');
  return `<aside class="artist-family-panel" data-artist-family-panel aria-label="${escapeHtml(config.title || 'Artist Family')}" aria-hidden="true" hidden><header><div class="artist-family-panel__heading"><h2>${escapeHtml(config.title || 'Artist Family')}</h2><p>Select or unselect an artist to update Gallery.</p></div><span data-gallery-family-panel-total>${escapeHtml(config.albumTotal || '')}</span></header><div class="artist-family-panel__combine-row">${combineSwitch}</div><div class="artist-family-panel__body gallery-scrollbar">${String(config.bodyHtml || '')}</div></aside>`;
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
  return `<div class="family-artist-header" data-scroll-artist="${escapeHtml(config.artist || '')}" data-gallery-album-count="${Math.max(0, Number(config.albumCount || 0))}"><h2 class="artist-name">${escapeHtml(config.artist || '')}</h2><button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(config.infoArtist || config.artist || '')}" aria-label="Information about ${escapeHtml(config.infoArtist || config.artist || '')}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button><span class="gallery-divider__line"></span><span>${escapeHtml(galleryMainPlural(config.albumCount, 'album'))}</span></div>`;
}

function buildGalleryRatingHtml(config = {}) {
  const maximum = Math.max(1, Number(config.maximum || 10));
  const value = Math.max(0, Math.min(maximum, Number(config.value || 0)));
  const points = Array.from({ length: maximum }, (_unused, index) => (index < value
    ? '<span class="star filled">&#9733;</span>'
    : '<span class="star">&#9734;</span>')).join('');
  return `<div class="rating-row"><div class="stars" role="img" aria-label="${escapeHtml(config.label || `Rated ${value} out of ${maximum}`)}">${points}</div>${value ? `<div class="rating-text">${value}/${maximum}</div>` : ''}</div>`;
}

function buildGalleryCardInfoHtml(config = {}) {
  const count = Math.max(0, Number(config.trackCount || 0));
  const metadata = [config.artist, config.year].map(value => String(value ?? '').trim()).filter(Boolean).join(' · ');
  const title = config.openAttributes
    ? `<button class="album-open-trigger album-title-button" type="button" ${config.openAttributes}>${escapeHtml(config.title || '')}</button>`
    : escapeHtml(config.title || '');
  return `<div class="album-body gallery-card-info"><h3 class="album-title">${title}</h3><div class="album-meta-row"><div class="album-subtitle">${escapeHtml(metadata)}</div></div>${String(config.ratingHtml || '')}<div class="chip-row"><span class="track-count">${count} track${count === 1 ? '' : 's'}</span><span class="album-length">${escapeHtml(config.lengthDisplay || '')}</span></div></div>`;
}
