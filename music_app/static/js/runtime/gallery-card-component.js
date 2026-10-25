function buildGalleryCardHtml(config = {}) {
  const displayMode = ['list', 'cards', 'covers'].includes(config.displayMode) ? config.displayMode : 'cards';
  const releaseYear = displayMode === 'covers' ? String(config.year ?? '').trim() : '';
  const openAttributes = `data-open-tracklist="1" data-album-key="${escapeHtml(config.albumKey || '')}" data-album-version-key="${escapeHtml(config.albumVersionKey || '')}" data-album="${escapeHtml(config.albumFallback || '')}"`;
  const sourceCategories = normalizeLibrarySourceCategories(config.sourceCategories);
  const sourceColors = { main: 'var(--gallery-artbox-hover-frame, #fff)', hoard: 'var(--library-source-hoard)', new_arrivals: 'var(--library-source-arrivals)' };
  const sourceGradient = sourceCategories.length
    ? `conic-gradient(${sourceCategories.map((category, index) => `${sourceColors[category]} ${index * 100 / sourceCategories.length}% ${(index + 1) * 100 / sourceCategories.length}%`).join(', ')})`
    : 'none';
  const sourceAction = (category, label, glyphHtml) => `<button class="ui-button ui-button--small gallery-source-action gallery-source-action--${category}" type="button" aria-label="${label}" ${openAttributes}>${glyphHtml}<span>${label}</span></button>`;
  const sourceActions = [
    sourceCategories.includes('hoard') ? sourceAction('hoard', 'Hoard', buildLibrarySourceGlyphHtml('hoard')) : '',
    sourceCategories.includes('new_arrivals') ? sourceAction('new_arrivals', 'New Arrivals', buildLibrarySourceGlyphHtml('new_arrivals')) : '',
  ].join('');
  const duplicateAction = config.hasDuplicateFiles
    ? sourceAction('duplicate', 'Duplicate files', '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M24 6 45 42H3Z"/><path d="M24 18v11m0 6v1"/></svg>')
    : '';
  return `
    <section class="album-card" data-library-sources="${sourceCategories.join(' ')}" style="--library-source-gradient:${sourceGradient}" data-gallery-display="${displayMode}"${releaseYear ? ` data-gallery-release-year="${escapeHtml(releaseYear)}"` : ''} data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">
      <button class="album-card__artbox-trigger album-open-trigger cover" type="button" ${openAttributes} aria-label="${escapeHtml(config.openLabel || `Open ${config.title || 'album'} tracklist`)}">
        ${String(config.artboxHtml || '')}
      </button>
      ${duplicateAction ? `<div class="gallery-card__source-overlay">${duplicateAction}</div>` : ''}
      ${sourceActions ? `<div class="gallery-card__source-actions gallery-card__source-actions--artwork">${sourceActions}</div>` : ''}
      ${releaseYear ? `<span class="gallery-card__hover-year" aria-hidden="true">${escapeHtml(releaseYear)}</span>` : ''}
      ${displayMode === 'covers'
        ? `<span class="gallery-card__focus-title">${escapeHtml(config.title || '')}</span>`
        : buildGalleryCardInfoHtml({
            ...config,
            openAttributes,
            sourceActionsHtml: sourceActions
            ? `<div class="gallery-card__source-actions gallery-card__source-actions--details">${sourceActions}</div>`
              : '',
          })}
    </section>
  `;
}

let galleryCardMetadataMotion = null;
function syncGalleryCardMetadataMotion(root) {
  const mobile = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  if (!mobile) { galleryCardMetadataMotion?.dispose(); galleryCardMetadataMotion = null; return; }
  if (!root?.querySelectorAll || typeof ResizeObserver !== 'function') return;
  if (!galleryCardMetadataMotion) {
    const rows = new Map();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, disposed = false;
    const refresh = () => {
      frame = 0;
      for (const [row, text] of rows) {
        if (!row.isConnected) { observer.unobserve(row); observer.unobserve(text); rows.delete(row); continue; }
        const motion = !reduced.matches ? resolveCompactPlayerMetadataRowMotion({ clientWidth: row.clientWidth, scrollWidth: text.scrollWidth }) : { overflowing: false, distance: 0, durationMs: 0 };
        row.classList.toggle('is-card-text-overflowing', motion.overflowing);
        row.style.setProperty('--card-text-distance', `${motion.distance}px`);
        row.style.setProperty('--card-text-duration', `${motion.durationMs}ms`);
      }
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(refresh); };
    const observer = new ResizeObserver(schedule);
    reduced.addEventListener('change', schedule);
    document.fonts?.ready.then(schedule);
    galleryCardMetadataMotion = {
      update(root) {
        root.querySelectorAll('.album-card [data-gallery-metadata-text]').forEach(text => {
          const row = text.parentElement, previous = rows.get(row);
          if (previous === text) return;
          if (previous) observer.unobserve(previous);
          rows.set(row, text); observer.observe(row); observer.observe(text);
        });
        schedule();
      },
      dispose() {
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect(); reduced.removeEventListener('change', schedule);
        for (const row of rows.keys()) row.classList.remove('is-card-text-overflowing');
        rows.clear();
      },
    };
  }
  galleryCardMetadataMotion.update(root);
}
