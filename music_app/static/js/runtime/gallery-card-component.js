function buildGalleryCardHtml(config = {}) {
  const displayMode = String(config.displayMode || 'cards') === 'covers' ? 'covers' : 'cards';
  const openAttributes = `data-open-tracklist="1" data-album-key="${escapeHtml(config.albumKey || '')}" data-album-version-key="${escapeHtml(config.albumVersionKey || '')}" data-album="${escapeHtml(config.albumFallback || '')}"`;
  return `
    <section class="album-card" data-gallery-display="${displayMode}" data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">
      <button class="album-card__artbox-trigger album-open-trigger cover" type="button" ${openAttributes} aria-label="${escapeHtml(config.openLabel || `Open ${config.title || 'album'} tracklist`)}">
        ${String(config.artboxHtml || '')}
      </button>
      ${displayMode === 'covers'
        ? `<span class="gallery-card__focus-title">${escapeHtml(config.title || '')}</span>`
        : buildGalleryCardInfoHtml({ ...config, openAttributes })}
    </section>
  `;
}
