function buildGalleryCardHtml(config = {}) {
  const displayMode = String(config.displayMode || 'cards') === 'covers' ? 'covers' : 'cards';
  const releaseYear = displayMode === 'covers' ? String(config.year ?? '').trim() : '';
  const openAttributes = `data-open-tracklist="1" data-album-key="${escapeHtml(config.albumKey || '')}" data-album-version-key="${escapeHtml(config.albumVersionKey || '')}" data-album="${escapeHtml(config.albumFallback || '')}"`;
  return `
    <section class="album-card" data-gallery-display="${displayMode}"${releaseYear ? ` data-gallery-release-year="${escapeHtml(releaseYear)}"` : ''} data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">
      <button class="album-card__artbox-trigger album-open-trigger cover" type="button" ${openAttributes} aria-label="${escapeHtml(config.openLabel || `Open ${config.title || 'album'} tracklist`)}">
        ${String(config.artboxHtml || '')}
        ${releaseYear ? '<span class="gallery-card__year-frame" aria-hidden="true"></span>' : ''}
      </button>
      ${releaseYear ? `<span class="gallery-card__hover-year" aria-hidden="true">${escapeHtml(releaseYear)}</span>` : ''}
      ${displayMode === 'covers'
        ? `<span class="gallery-card__focus-title">${escapeHtml(config.title || '')}</span>`
        : buildGalleryCardInfoHtml({ ...config, openAttributes })}
    </section>
  `;
}
