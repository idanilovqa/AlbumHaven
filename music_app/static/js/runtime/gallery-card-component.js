function buildGalleryCardHtml(config = {}) {
  const trackCount = Math.max(0, Number(config.trackCount || 0));
  const trackLabel = `${trackCount} track${trackCount === 1 ? '' : 's'}`;
  const lengthHtml = config.lengthDisplay
    ? `<div class="album-length">${escapeHtml(config.lengthDisplay)}</div>`
    : '<div class="album-length"></div>';
  const yearHtml = config.year
    ? `<div class="album-year">${escapeHtml(config.year)}</div>`
    : '<div class="album-year"></div>';
  const openAttributes = `data-open-tracklist="1" data-album-key="${escapeHtml(config.albumKey || '')}" data-album-version-key="${escapeHtml(config.albumVersionKey || '')}" data-album="${escapeHtml(config.albumFallback || '')}"`;
  return `
    <section class="album-card" data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">
      <button class="album-card__artbox-trigger album-open-trigger cover" type="button" ${openAttributes} aria-label="${escapeHtml(config.openLabel || `Open ${config.title || 'album'} tracklist`)}">
        ${String(config.artboxHtml || '')}
      </button>
      <div class="album-body">
        <h3 class="album-title"><button class="album-open-trigger album-title-button" type="button" ${openAttributes}>${escapeHtml(config.title || '')}</button></h3>
        <div class="album-meta-row">
          <div class="album-subtitle">${escapeHtml(config.artist || '')}</div>
          ${yearHtml}
        </div>
        ${String(config.ratingHtml || '')}
        <div class="chip-row">
          <span class="track-count">${trackLabel}</span>
          ${lengthHtml}
        </div>
      </div>
    </section>
  `;
}
